import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { opById, needsConfirmation } from '../lib/v1/ops/registry.mjs';
import { check } from '../lib/v1/ops/schema.mjs';
import { runOp, createOpsClient, opError } from '../lib/v1/ops/execute.mjs';
import { runOpsCommand } from '../lib/v1/ops/cli.mjs';
import { createOpsHttp } from '../lib/v1/ops/http.mjs';
import { opTool, selectTools } from '../lib/v1/mcp.mjs';
import { runV1Command, createJobOperations } from '../lib/v1/cli.mjs';
import { resolveJobRecipient } from '../lib/v1/job-recipient.mjs';

const input = {circle:'Friends', prompt:'Fix it', files:[{path:'a.txt', base64:'eA=='}]};
const digest = 'sha256:' + 'a'.repeat(64);
const approvedCircle = circle => ({...circle,enrollment:{state:'approved'},rosterMembershipVerified:true});

for (const id of ['jobs.submit', 'jobs.send_and_wait']) {

  test(id + ' validates requested effort with no dollar default and retains send consent', async () => {
    const schema=opById(id).input;
    for(const effort of ['none','minimal','low','medium','high','xhigh','max'])
      assert.equal(check(schema,{...input,budget_v1:{effort}}),null);
    for(const budget_v1 of [null,{effort:null},{effort:'ultra'},{max_list_usd:0},{max_list_usd:1.5},{max_list_usd:100001},{effort:'high',extra:true}])
      assert.ok(check(schema,{...input,budget_v1}));
    await assert.rejects(runOp(id,{...input,budget_v1:{effort:'high'}},{
      rest:async(method,path)=>path==='/api/circles'?[approvedCircle({id:'Friends',name:'Friends',origin:'https://example.test'})]:assert.fail('unconfirmed effort dispatched'),
    }),{code:'confirmation_required'});
  });

  test(id + ' refuses an unconfirmed send before doing any work', async () => {
    const op = opById(id);
    assert.equal(needsConfirmation(op, input), true);
    assert.equal(opTool(op).inputSchema.properties.confirm.type, 'boolean');
    const unexpected = () => assert.fail('unconfirmed send dispatched work');
    await assert.rejects(runOp(id, input, {rest:async(method,path)=>path==='/api/circles'?[approvedCircle({id:'Friends',name:'Friends',origin:'https://example.test'})]:unexpected(), call:unexpected}), error => {
      assert.equal(error.code, 'confirmation_required');
      assert.match(error.effect, /1 file.*prompt.*Friends.*lenders/i);
      return true;
    });
    const client = createOpsClient({home:'/does-not-exist', autostart:false, fetch:unexpected});
    await assert.rejects(client.call(id, input), {code:'app_not_running'}, 'the app now decides whether confirmation is required');
  });

  test(id + ' declares exactly one source, including explicit no project', () => {
    const schema = opById(id).input;
    assert.ok(check(schema, {circle:'Friends',prompt:'x'}));
    assert.ok(check(schema, {...input, repo:{path:'/repo'}}));
    assert.ok(check(schema, {...input, files:[]}));
    assert.ok(check(schema, {...input, zip:{base64:'UEs='}}));
    for (const source of [{files:input.files}, {noSource:true,result:{kind:'message'}}, {zip:{name:'source.zip',base64:'UEs='}}, {repo:{path:'/repo'}}, {git:{url:'https://example.test/r.git', commit:'a'.repeat(40)}}])
      assert.equal(check(schema, {circle:'Friends', prompt:'x', ...source}), null);
    assert.equal(check(schema, {prompt:'x', files:input.files}), null, 'a default can be resolved before consent');
  });

  test(id + ' CLI asks only after the app requires confirmation', async () => {
    const calls = [], output = [];
    const options = {stdout:{write:s => output.push(s)}, stderr:{write:() => {}}, stdin:{isTTY:false},
      client:{call:async (...args) => { if(args[0]==='circles.list')return [approvedCircle({id:'Friends',name:'Friends',origin:'https://example.test'})];if(args[2]?.confirmed!==true)throw opError('confirmation_required',428,'Confirm this send.',{effect:'Send this job to Friends.'});calls.push(args); return {jobDigest:digest}; }}};
    const args = ['ops', 'call', id, '--json', '--input', JSON.stringify(input)];
    assert.equal(await runOpsCommand(args, options), 6);
    assert.equal(JSON.parse(output.join('')).code, 'confirmation_required');
    assert.equal(calls.length, 0);
    assert.equal(await runOpsCommand([...args, '--yes'], options), 0);
    assert.equal(calls[0][2].confirmed, true);
    output.length = 0;
    assert.equal(await runOpsCommand(['ops','call',id,'--json','--circle','Friends','--prompt','x'],options), 2);
    assert.equal(JSON.parse(output.join('')).code, 'invalid_request', 'missing source is refused before rendering its effect');
  });
}

test('read-only MCP never offers result extraction', () => {
  assert.equal(selectTools({readOnly:true}).some(t => t.name === 'read_result'), false);
});

for(const id of ['jobs.submit','jobs.send_and_wait','jobs.apply'])test('CLI lets the app authorize '+id+' without --yes',async()=>{
  const calls=[],output=[];
  const value=id==='jobs.apply'?{digest,circle:'Friends'}:input;
  const code=await runOpsCommand(['ops','call',id,'--input',JSON.stringify(value),'--json'],{
    stdin:{isTTY:false},stdout:{write:s=>output.push(s)},stderr:{write:()=>{}},client:{call:async(name,body,opts)=>{
      if(name==='circles.list')return [approvedCircle({id:'Friends',name:'Friends',origin:'https://example.test'})];
      calls.push({name,body,opts});return {jobDigest:digest};
    }}});
  assert.equal(code,0);assert.equal(calls.length,1);assert.equal(calls[0].opts.confirmed,false);assert.equal(output.length,1);
});

// Exercise the real ops HTTP adapter and its nested REST calls without starting an app or sandbox.
async function httpFixture(t, onRest = async () => {}) {
  const calls = [];
  const state = {circles:[approvedCircle({id:'friends-id',name:'Friends',origin:'https://example.test',selected:true})]};
  let origin;
  const ops = createOpsHttp({home:'/unused', token:'fixture', origin:() => origin});
  const server = createServer(async (req, res) => {
    if (await ops(req, res, req.url.split('/').filter(Boolean))) return;
    calls.push(req.url);
    await onRest();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/circles' ? state.circles : req.url === '/api/jobs' ? {jobDigest:digest} :
      req.url.startsWith('/api/jobs/') ? {state:'failed', status:'Failed', job_digest:digest} : {url:'fixture-link'}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const call = (id, body, headers = {}) => fetch(origin + '/api/ops/' + id, {
    method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
  return {call, calls, state};
}

test('HTTP names and binds a default before consent, refusing a changed default at dispatch', async t => {
  const {call,calls,state}=await httpFixture(t);
  const {circle,...implicit}=input;
  const first=await call('jobs.submit',implicit), required=await first.json();
  assert.equal(first.status,428); assert.match(required.effect,/Friends/);
  assert.deepEqual(required.confirmation_input,{circle:'friends-id',expected_circle_id:'friends-id',expected_default_circle:'friends-id'});
  state.circles=[{...state.circles[0],selected:false},approvedCircle({id:'work-id',name:'Work',origin:'https://work.example',selected:true})];
  const refused=await call('jobs.submit',{...implicit,...required.confirmation_input},{'faravan-confirm':'yes'});
  assert.equal(refused.status,409); assert.equal((await refused.json()).code,'circle_changed');
  assert.equal(calls.filter(p=>p==='/api/jobs').length,0);
  const fresh=await (await call('jobs.submit',implicit)).json();
  assert.match(fresh.effect,/Work/);
  const accepted=await call('jobs.submit',{...implicit,...fresh.confirmation_input},{'faravan-confirm':'yes'});
  assert.equal(accepted.status,200); await accepted.json();
  assert.equal(calls.filter(p=>p==='/api/jobs').length,1);
});

test('unavailable or ambiguous defaults list valid circle names; the actual submit checks its binding', async () => {
  const circles=[{id:'friends',name:'Friends',origin:'https://friends.example'},{id:'work',name:'Work',origin:'https://work.example'}];
  assert.throws(()=>resolveJobRecipient({},circles),error=>error.code==='circle_required'&&/Friends.*Work/.test(error.message));
  assert.throws(()=>resolveJobRecipient({},[]),{code:'circle_required'});
  const device={listCircles:async()=>circles,selectCircle:()=>circles[1],client:()=>assert.fail('changed default reached the network')};
  const ops=createJobOperations({device,home:'/unused'});
  await assert.rejects(ops.submit({circle:'friends',expected_default_circle:'friends',git:'https://example.test/app.git@'+'a'.repeat(40),prompt:'Fix it'}),{code:'circle_changed'});
});

test('HTTP job sends need a confirm header, including composed send-and-wait', async t => {
  const {call, calls} = await httpFixture(t);
  for (const id of ['jobs.submit', 'jobs.send_and_wait']) {
    const before = calls.filter(p=>p!=='/api/circles').length;
    const refused = await call(id, input);
    assert.equal(refused.status, 428); assert.equal((await refused.json()).code, 'confirmation_required');
    assert.equal(calls.filter(p=>p!=='/api/circles').length, before);
    const sent = await call(id, input, {'faravan-confirm':'yes'});
    assert.equal(sent.status, 200); assert.equal((await sent.json()).jobDigest, digest);
    assert.equal(calls.filter(p => p === '/api/jobs').length, id === 'jobs.submit' ? 1 : 2);
  }
});

test('a keyed send can confirm the same refused input without reusing its key for another job',async t=>{
  const {call,calls}=await httpFixture(t);
  const headers={'idempotency-key':'send-consent'};
  const first=await call('jobs.submit',input,headers);assert.equal(first.status,428);await first.json();
  const confirmed=await call('jobs.submit',input,{...headers,'faravan-confirm':'yes'});
  assert.equal(confirmed.status,200);await confirmed.json();
  const changed=await call('jobs.submit',{...input,prompt:'Different job'},{...headers,'faravan-confirm':'yes'});
  assert.equal(changed.status,409);assert.equal((await changed.json()).code,'idempotency_key_reused');
  const replay=await call('jobs.submit',input,{...headers,'faravan-confirm':'yes'});
  assert.equal(replay.status,200);await replay.json();
  assert.equal(calls.filter(path=>path==='/api/jobs').length,1);
});

test('HTTP retains unexpired answers at capacity and refuses new keys without a side effect', async t => {
  const {call, calls} = await httpFixture(t);
  for (let i = 0; i < 500; i++) {
    const response = await call('app.open_link', {}, {'idempotency-key':'key-' + i});
    assert.equal(response.status, 200); await response.json();
  }
  assert.equal(calls.length, 500);
  const overflow = await call('app.open_link', {}, {'idempotency-key':'overflow'});
  assert.equal(overflow.status, 503); assert.equal((await overflow.json()).code, 'idempotency_busy');
  assert.equal(calls.length, 500);
  const replay = await call('app.open_link', {}, {'idempotency-key':'key-0'});
  assert.equal(replay.headers.get('idempotent-replayed'), 'true'); await replay.json();
  assert.equal(calls.length, 500);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 24 * 3600 * 1000 + 1);
  const expired = await call('app.open_link', {}, {'idempotency-key':'after-expiry'});
  assert.equal(expired.status, 200); await expired.json();
  assert.equal(calls.length, 501, 'expired answers release capacity');
});

test('in-flight keys survive a wall-clock jump beyond the retention window', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const {call, calls} = await httpFixture(t, async () => { began(); await held; });
  const first = call('app.open_link', {}, {'idempotency-key':'in-flight'});
  await started;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 24 * 3600 * 1000 + 1);
  const again = call('app.open_link', {}, {'idempotency-key':'in-flight'});
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  await (await first).json();
  const replay = await again; await replay.json();
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(calls.length, 1);
});

test('legacy terminal sends show their effect and accept y/N; nonterminal sends require --yes', async t => {
  const repo = await mkdtemp(join(homedir(), '.tmp', 'faravan-send-consent-'));
  t.after(() => rm(repo, {recursive:true,force:true}));
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'a.txt'), 'source');
  execFileSync('git', ['-C', repo, 'add', 'a.txt']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Source']);
  const circle = approvedCircle({id:'friends-id', name:'Friends', origin:'https://example.test'});
  for (const command of [['job','submit','--source',repo,'--prompt','Fix it'], ['run','Fix it','--detach','--include-uncommitted']]) {
    for (const answer of ['y', 'yes', 'n', '', null, '--yes']) {
      const stdin = new PassThrough(); stdin.isTTY = answer !== null && answer !== '--yes';
      const output = [], effects = [], calls = [];
      const options = {cwd:repo, stdin, stdout:{write:s => output.push(s)}, stderr:{write:s => {
        effects.push(s); if (s.includes('[y/N]')) setImmediate(() => stdin.write(answer + '\n'));
      }}, device:{selectCircle:async () => circle, listCircles:async () => [circle]},
      operations:{submit:async args => { calls.push(args); return {jobDigest:digest}; }}};
      const code = await runV1Command([...command, '--json', ...(answer === '--yes' ? ['--yes'] : [])], options);
      const accepted = ['y','yes','--yes'].includes(answer);
      assert.equal(code, accepted ? 0 : 6, command[0] + ' answer ' + answer + ': ' + output.join(''));
      assert.equal(calls.length, accepted ? 1 : 0);
      if (stdin.isTTY) {
        assert.match(effects.join(''), /Friends.*lenders.*\[y\/N\]/s);
        assert.ok(effects.join('').includes(repo));
        if (command[0] === 'run') assert.doesNotMatch(effects.join(''), /uncommitted/, 'a clean tree sends only committed files');
      }
      if (accepted && stdin.isTTY) assert.equal(calls[0].circle, circle.id, 'the confirmed circle is bound to the send');
      stdin.end();
    }
  }
  for (const command of [['job','submit','--source',repo,'--prompt','Fix it'], ['run','Fix it','--detach']]) {
    let selected='friends';
    const circles=[approvedCircle({id:'friends',name:'Friends',origin:'https://friends.example'}),approvedCircle({id:'work',name:'Work',origin:'https://work.example'})];
    const stdin=new PassThrough();stdin.isTTY=true;
    const output=[],writes=[];
    const code=await runV1Command([...command,'--json'],{cwd:repo,stdin,stdout:{write:s=>output.push(s)},
      stderr:{write:s=>{if(s.includes('[y/N]')){assert.match(s,/Friends/);selected='work';setImmediate(()=>stdin.write('y\n'));}}},
      device:{selectCircle:async id=>circles.find(c=>c.id===(id??selected)),listCircles:async()=>circles},
      operations:{submit:async args=>writes.push(args)}});
    assert.equal(code,4);assert.equal(JSON.parse(output.join('')).code,'circle_changed');
    assert.deepEqual(writes,[]);stdin.end();
  }
});
