import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOpsClient, runOp, problemOf, opError} from '../lib/v1/ops/execute.mjs';

async function client(t, fetch, extra={}) {
  const home=await mkdtemp(join(tmpdir(),'faravan-ops-trust-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'v1'));
  await writeFile(join(home,'v1','app.json'),JSON.stringify({pid:process.pid,port:12345,token:'test-only'}));
  return createOpsClient({home,autostart:false,fetch,...extra});
}
const answer=(body,status=200)=>new Response(JSON.stringify(body),{status});
const approvedCircle = circle => ({...circle,enrollment:{state:'approved'},rosterMembershipVerified:true});

for(const id of ['jobs.submit','jobs.send_and_wait'])test('an older app keeps confirmation for '+id,async t=>{
  const seen=[];
  const c=await client(t,async url=>{
    const path=new URL(url).pathname;seen.push(path);
    return path==='/api/circles'?answer([approvedCircle({id:'friends',name:'Friends',origin:'https://example.test'})]):answer({code:'not_found'},404);
  });
  await assert.rejects(c.call(id,{circle:'friends',prompt:'Fix it',noSource:true,result:{kind:'message'}}),{code:'confirmation_required'});
  assert.equal(seen.includes('/api/jobs'),false);
  assert.ok(seen.includes('/api/ops/'+id));
});

test('strict clients validate successful app responses',async t=>{
  const c=await client(t,async()=>answer({enabled:'yes'}),{strict:true});
  await assert.rejects(c.call('lending.get'),{code:'invalid_request'});
});

test('a keyed legacy write fails closed before the unprotected REST route',async t=>{
  const seen=[];
  const c=await client(t,async url=>{seen.push(new URL(url).pathname);return answer({code:'not_found'},404);});
  await assert.rejects(c.call('device.rename',{name:'Test'},{idempotencyKey:'retry-safe'}),{code:'idempotency_unsupported'});
  assert.deepEqual(seen,['/api/ops/device.rename','/api/ops']);
});

test('local coded errors cannot leak paths, secrets or arbitrary details',()=>{
  const problem=problemOf(Object.assign(new Error('failed /home/private token=test-secret'),{code:'spawn_failed',warning:{token:'test-secret'}}));
  assert.deepEqual(problem,{code:'spawn_failed',message:'spawn failed'});
});

test('human safety is enforced before the operation handler',async()=>{
  // The registry handler currently also refuses uninstall; executor must keep this invariant independently.
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  const op=opById('uninstall.run'),handler=op.handler;let called=false;
  try {op.handler=()=>{called=true;return {};};await assert.rejects(runOp(op.id,{},{}),{code:'human_only'});assert.equal(called,false);}
  finally {op.handler=handler;}
});

test('a frozen-audience send cannot downgrade through a legacy local app',async t=>{
  const seen=[];
  const c=await client(t,async url=>{
    const path=new URL(url).pathname;seen.push(path);
    if(path==='/api/circles')return answer([approvedCircle({id:'c1',name:'Friends',origin:'https://example.test'})]);
    return path.startsWith('/api/ops')?answer({code:'not_found'},404):answer({jobDigest:'sha256:'+'a'.repeat(64)});
  });
  await assert.rejects(c.call('jobs.submit',{circle:'Friends',prompt:'x',files:[{path:'a.txt',base64:'eA=='}],freeze_audience:true},{confirmed:true}),{code:'app_too_old'});
  assert.equal(seen.includes('/api/jobs'),false);
});

test('response body cannot replace the HTTP failure status',async()=>{
  const {appRequest}=await import('../lib/v1/ops/execute.mjs');
  await assert.rejects(appRequest({origin:'http://127.0.0.1:12345',token:'test'},'POST','/api/ops/device.rename',{
    fetchImpl:async()=>answer({code:'not_found',status:404,message:'Synthetic failure'},500),body:{name:'x'}}),{code:'not_found',status:500});
});

test('invalid retry keys never silently turn into unkeyed writes',async t=>{
  for(const key of ['', 'has space', 'x'.repeat(256), 42]) {
    let calls=0;
    const c=await client(t,async()=>{calls++;return answer({name:'Test'});});
    await assert.rejects(c.call('device.rename',{name:'Test'},{idempotencyKey:key}),{code:'invalid_request'});
    assert.equal(calls,0);
  }
});

test('trusted schema and usage errors keep their repair instructions',async()=>{
  const {validate}=await import('../lib/v1/ops/schema.mjs');
  const {parseOpArgs}=await import('../lib/v1/ops/cli.mjs');const {opById}=await import('../lib/v1/ops/registry.mjs');
  assert.throws(()=>validate({type:'object',properties:{},required:['name']},{}),e=>{assert.match(problemOf(e).message,/name.*required/);return true;});
  await assert.rejects(parseOpArgs(opById('device.rename'),['--bogus']),e=>{assert.match(problemOf(e).message,/Unknown option.*bogus/);return true;});
});

test('a keyed composed send cannot fall through to an old app',async t=>{
  const seen=[];
  const c=await client(t,async url=>{
    const path=new URL(url).pathname;seen.push(path);
    if(path==='/api/circles')return answer([approvedCircle({id:'c1',name:'Friends',origin:'https://example.test'})]);
    if(path.startsWith('/api/ops'))return answer({code:'not_found'},404);
    if(path==='/api/jobs')return answer({jobDigest:'sha256:'+'a'.repeat(64)});
    return answer({code:'stopped'},500);
  });
  await assert.rejects(c.call('jobs.send_and_wait',{circle:'Friends',prompt:'x',files:[{path:'a.txt',base64:'eA=='}],timeout_seconds:0},
    {confirmed:true,idempotencyKey:'composed-retry-key'}),{code:'idempotency_unsupported'});
  assert.equal(seen.includes('/api/jobs'),false);
});

test('declined CLI consent retains its effect and bound recipient for a safe retry',async()=>{
  const {Readable}=await import('node:stream');const {runOpsCommand}=await import('../lib/v1/ops/cli.mjs');
  let output='';const circles=[approvedCircle({id:'c1',name:'Friends',origin:'https://example.test',selected:true})];
  const exit=await runOpsCommand(['ops','call','jobs.submit','--input',JSON.stringify({prompt:'hi',files:[{path:'a.txt',base64:'YQ=='}]}),'--json'],{
    stdin:Readable.from([]),stdout:{write:s=>{output+=s;}},stderr:{write:()=>{}},
    client:{call:async id=>{if(id==='jobs.submit')throw opError('confirmation_required',428);assert.equal(id,'circles.list');return circles;}}});
  assert.equal(exit,6);const error=JSON.parse(output);
  assert.match(error.effect,/Friends/);assert.match(error.message,/--yes/);
  assert.deepEqual(error.confirmation_input,{circle:'c1',expected_circle_id:'c1',expected_default_circle:'c1'});
});

test('recipient changes retain safe repair copy without trusting arbitrary exceptions',async()=>{
  const {resolveJobRecipient}=await import('../lib/v1/job-recipient.mjs');
  try {resolveJobRecipient({circle:'old',expected_circle_id:'old'},[approvedCircle({id:'new',name:'New circle',origin:'https://example.test'})]);assert.fail('expected refusal');}
  catch(error){const problem=problemOf(error);assert.equal(problem.code,'circle_changed');assert.match(problem.message,/Review the send again.*New circle/);}
});

test('MCP source refusals retain the explicit root repair instruction',async()=>{
  const {checkMcpSource}=await import('../lib/v1/mcp.mjs');
  assert.throws(()=>checkMcpSource(tmpdir(),['/not-a-shared-test-root']),error=>{
    assert.match(problemOf(error).message,/--root <folder>.*FARAVAN_MCP_ROOTS/);return true;
  });
});


test('only known cessation-refusal reason codes cross the error-detail boundary',async t=>{
  for(const detail of ['process_present','unknown_reason','/private/path token=private-secret',{token:'private-secret'},null]) {
    const c=await client(t,async()=>answer({code:'cessation_unverified',detail},409));
    await assert.rejects(c.call('lending.stop_job',{attemptId:'dead'},{confirmed:true}),error=>{
      const problem=problemOf(error);
      assert.equal(problem.code,'cessation_unverified');
      if(detail==='process_present')assert.equal(problem.detail,detail);else assert.equal('detail' in problem,false);
      return true;
    });
  }
  assert.equal(problemOf(opError('some_other_error',409,'Refused',{detail:'process_present'})).detail,undefined);
  assert.equal(problemOf(Object.assign(Error('private-secret'),{code:'cessation_unverified',detail:'process_present'})).detail,undefined);
});

test('private hosting launch approvals are per app, one-shot, and operation-bounded', async () => {
  const {createHostingLaunchApprovals}=await import('../lib/v1/loopback-security.mjs');
  let clock=10;
  const approvals=createHostingLaunchApprovals({now:()=>clock});
  const anotherApp=createHostingLaunchApprovals({now:()=>clock});
  const tuple={providerId:'fixture',usage:'attached',consentFactsDigest:'consent-v1:'+'a'.repeat(64)};
  await assert.rejects(approvals.withHostingLaunchApproval({...tuple,usage:'unknown'},()=>assert.fail()),TypeError);
  let unused;
  await approvals.withHostingLaunchApproval(tuple,id=>{
    assert.equal(anotherApp.consume(id),null);
    assert.deepEqual(approvals.consume(id),tuple);
    assert.equal(approvals.consume(id),null);
  });
  await assert.rejects(approvals.withHostingLaunchApproval(tuple,id=>{unused=id;throw new Error('fixture refused');}),/fixture refused/);
  assert.equal(approvals.consume(unused),null);
  await approvals.withHostingLaunchApproval(tuple,id=>{
    clock+=60000;
    assert.equal(approvals.consume(id),null);
  });
  await approvals.withHostingLaunchApproval(tuple,id=>{
    approvals.close();
    assert.equal(approvals.consume(id),null);
  });
  await assert.rejects(approvals.withHostingLaunchApproval(tuple,()=>assert.fail()),/closed/);
});

test('only confirmed top-level local browser hosting.start gets the private launch callback',async()=>{
  const {Readable,Writable}=await import('node:stream');
  const {createOpsHttp}=await import('../lib/v1/ops/http.mjs');
  const {createHostingLaunchApprovals}=await import('../lib/v1/loopback-security.mjs');
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  const start=opById('hosting.start'),read=opById('hosting.get');
  const originalStart=start.handler,originalRead=read.handler,seen=[];
  const approvals=createHostingLaunchApprovals();
  const ops=createOpsHttp({hostingLaunchApprovals:approvals});
  const call=async(parts,{method='POST',headers={},input={},principal={}}={})=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]),{method,headers:{'content-type':'application/json',...headers}});
    let status,body='';
    const res=new Writable({write(chunk,_encoding,done){body+=chunk.toString();done();}});
    res.writeHead=n=>{status=n;};
    assert.equal(await ops(req,res,['api','ops',...parts],principal),true);
    return {status,body:JSON.parse(body)};
  };
  try {
    read.handler=ctx=>{seen.push(ctx.withHostingLaunchApproval);return {};};
    start.handler=async ctx=>{seen.push(ctx.withHostingLaunchApproval);await ctx.call('hosting.get',{});return {status:'synthetic'};};
    const yes={'faravan-confirm':'yes'},input={tunnel:'lan'};
    assert.equal((await call(['hosting.start'],{headers:yes,input,principal:{localBrowserOwner:true}})).status,200);
    assert.equal(typeof seen[0],'function');
    assert.equal(seen[1],undefined,'nested calls do not inherit the callback');
    assert.throws(()=>seen[0]({},()=>assert.fail('retired handler grants nothing')));
    for(const principal of [{},{native:true}]){
      assert.equal((await call(['hosting.start'],{headers:yes,input,principal})).status,200);
      assert.deepEqual(seen.slice(-2),[undefined,undefined]);
    }
    const count=seen.length;
    assert.equal((await call(['hosting.start'],{input,principal:{localBrowserOwner:true}})).status,428);
    assert.equal((await call(['hosting.start'],{method:'GET',principal:{localBrowserOwner:true}})).status,200);
    assert.equal(seen.length,count);
    assert.equal((await call(['hosting.get'],{headers:yes,principal:{localBrowserOwner:true}})).status,200);
    assert.equal(seen.at(-1),undefined);

    const tuple={providerId:'fixture',usage:'attached',consentFactsDigest:'consent-v1:'+'a'.repeat(64)};
    const endpoint=['hosting-launch','consume'];
    await approvals.withHostingLaunchApproval(tuple,async id=>{
      assert.equal((await call(endpoint,{input:{id},principal:{localBrowserOwner:true}})).status,404);
      assert.equal((await call(endpoint,{method:'GET',input:{id},principal:{native:true}})).status,404);
      assert.deepEqual(await call(endpoint,{input:{id},principal:{native:true}}),{status:200,body:tuple});
      assert.equal((await call(endpoint,{input:{id},principal:{native:true}})).status,404);
    });
  } finally {start.handler=originalStart;read.handler=originalRead;approvals.close();}
});
