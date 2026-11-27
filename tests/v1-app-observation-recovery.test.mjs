import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {appFixture,api,waitFor,boundedFetch} from './helpers/offers-jobs-fixture.mjs';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';

const input=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt:'Observation recovery fixture',harness:'codex',send_anyway:true});

async function setup(t,mode,{second=false}={}) {
  const f=await appFixture(t),{owner,lender,circle,realRequests}=await f.realConnect();
  const other=second?await api(lender.app,'/api/circles',{method:'POST',body:{origin:'http://127.0.0.1:23456',name:'Other',publish:false}}):null;
  await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:input(circle)});
  const client=await lender.app.device.client(circle.id),ownerClient=await owner.app.device.client(circle.id);
  const requirements=(await ownerClient.getJob(jobDigest)).job.payload.requirements;
  const {attempt}=await client.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1'],
    egress:['internet','provider-only'],enforced_limits:Object.keys(requirements.limits),max_limits:requirements.limits},{waitSeconds:0});
  await client.startAttempt(attempt);await client.release(attempt,'synthetic interruption');
  const observedAt=new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),idempotencyKey=randomUUID();
  await lender.app.close();
  const settingsFile=join(lender.home,'v1','app-settings.json'),counterFile=join(lender.home,'v1','app-counters.json');
  const settings=JSON.parse(await readFile(settingsFile,'utf8'));
  Object.assign(settings,{activeCircle:circle.id,enabled:false,intent:mode==='off'?'off':'on',paused:mode==='paused',pause_until:null});
  await writeFile(settingsFile,JSON.stringify(settings));
  const row={day:new Date().toISOString().slice(0,10),jobs:1,milliseconds:120000,pending:null,
    observationPending:[{attempt,observedAt,idempotencyKey}]};
  const root={...row,circle:circle.id,accounts:{'codex:0':row}};
  if(second)delete root.observationPending;
  await writeFile(counterFile,JSON.stringify(root));
  return {f,circle,other,attempt,observedAt,realRequests,counterFile,settingsFile};
}

for(const mode of ['off','paused'])test('restart while '+mode+' drains observation without new execution',{timeout:60000},async t=>{
  const x=await setup(t,mode),offset=x.realRequests.length;
  const restarted=await x.f.start('lender',{adapters:[]});
  await waitFor(async()=>{
    const saved=JSON.parse(await readFile(x.counterFile,'utf8'));
    return saved.accounts?.['codex:0']?.observationPending?.length===0;
  },'observation journal drained',8000);
  const stored=JSON.parse(await readFile(x.settingsFile,'utf8'));
  assert.equal(stored.intent,mode==='off'?'off':'paused');assert.equal(stored.paused,mode==='paused');
  assert.equal(stored.enabled,false);
  const routes=x.realRequests.slice(offset).map(row=>row.route);
  assert.ok(routes.some(route=>route.endsWith('/observed-start')));
  assert.equal(routes.some(route=>/\/(claim|claim-next|start|renew)$/.test(route)),false);
  assert.equal(restarted.backend.calls.some(([kind])=>kind==='run'||kind==='admit'),false);
});

test('observation recovery preserves the scheduled end of a timed pause',{timeout:60000},async t=>{
  const x=await setup(t,'paused');
  const settings=JSON.parse(await readFile(x.settingsFile,'utf8'));
  settings.pause_until=Date.now()+5000;
  settings.paused=false;
  await writeFile(x.settingsFile,JSON.stringify(settings));
  const restarted=await x.f.start('lender');
  await waitFor(async()=>JSON.parse(await readFile(x.counterFile,'utf8')).accounts?.['codex:0']?.observationPending?.length===0,
    'observation journal drained',8000);
  await waitFor(async()=>{
    const saved=JSON.parse(await readFile(x.settingsFile,'utf8'));
    return saved.pause_until===null&&saved.paused===false&&saved.enabled===true;
  },'timed pause resumed',12000).catch(async error=>{
    const {intent,paused,pause_until,enabled}=JSON.parse(await readFile(x.settingsFile,'utf8'));
    const status=await api(restarted.app,'/api/status');
    t.diagnostic(`settings=${JSON.stringify({intent,paused,pause_until,enabled})} status=${JSON.stringify({state:status.state,reason:status.reason})}`);
    throw error;
  });
});

test('observation recovery retries an offline coordinator while lending is off',{timeout:60000},async t=>{
  const x=await setup(t,'off');let unavailable=true,failed=0;
  const fetch=async(url,options)=>{
    if(unavailable&&String(url).endsWith('/observed-start')){failed++;return new Response(JSON.stringify({code:'unavailable'}),
      {status:503,headers:{'content-type':'application/problem+json'}});}
    return boundedFetch(url,options);
  };
  await x.f.start('lender',{fetch,adapters:[]});
  await waitFor(()=>failed>0,'offline observation attempt');
  const before=JSON.parse(await readFile(x.counterFile,'utf8'));
  assert.equal(before.accounts['codex:0'].observationPending.length,1);
  unavailable=false;
  await waitFor(async()=>JSON.parse(await readFile(x.counterFile,'utf8')).accounts?.['codex:0']?.observationPending?.length===0,
    'observation retried after coordinator returns',8000);
  const settings=JSON.parse(await readFile(x.settingsFile,'utf8'));
  assert.equal(settings.intent,'off');assert.equal(settings.enabled,false);
});

test('circle switch refuses an observation-only journal',{timeout:60000},async t=>{
  const x=await setup(t,'off',{second:true});
  const fetch=async(url,options)=>String(url).endsWith('/observed-start')
    ?new Response(JSON.stringify({code:'unavailable'}),{status:503,headers:{'content-type':'application/problem+json'}})
    :boundedFetch(url,options);
  const restarted=await x.f.start('lender',{fetch});
  const rejected=await api(restarted.app,'/api/lending/circle',{method:'POST',body:{circle:x.other.id},status:409});
  assert.equal(rejected.code,'lending_recovery_required');
});

test('a rejected observation is retained without blocking later delivery or a circle switch',{timeout:60000},async t=>{
  const x=await setup(t,'off',{second:true});
  const saved=JSON.parse(await readFile(x.counterFile,'utf8'));
  const first=saved.accounts['codex:0'].observationPending[0],second={...first,idempotencyKey:randomUUID()};
  saved.accounts['codex:0'].observationPending.push(second);
  await writeFile(x.counterFile,JSON.stringify(saved));
  const sent=[];
  const fetch=async(url,options)=>{
    if(String(url).endsWith('/observed-start')){
      const key=options.headers['Idempotency-Key'];sent.push(key);
      if(key===first.idempotencyKey)return new Response(JSON.stringify({code:'forbidden'}),
        {status:403,headers:{'content-type':'application/problem+json'}});
    }
    return boundedFetch(url,options);
  };
  const restarted=await x.f.start('lender',{fetch,adapters:[]});
  await waitFor(async()=>{
    const rows=JSON.parse(await readFile(x.counterFile,'utf8')).accounts?.['codex:0']?.observationPending;
    return rows?.length===1&&rows[0].disposition==='rejected';
  },'first rejection retained and second delivered',8000);
  assert.deepEqual(sent,[first.idempotencyKey,second.idempotencyKey]);
  const retained=JSON.parse(await readFile(x.counterFile,'utf8')).accounts['codex:0'].observationPending[0];
  assert.equal(retained.rejection.code,'forbidden');assert.equal(retained.rejection.circle,x.circle.id);
  await api(restarted.app,'/api/lending/circle',{method:'POST',body:{circle:x.other.id}});
  const after=JSON.parse(await readFile(x.counterFile,'utf8')).accounts['codex:0'].observationPending[0];
  assert.deepEqual(after,retained);
  await restarted.app.close();await x.f.start('lender',{fetch,adapters:[]});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.deepEqual(sent,[first.idempotencyKey,second.idempotencyKey],'rejected evidence is not resent after restart');
});

for(const where of ['root','account'])test('restart while off with only an open sandbox watch ('+where+') sends its stopped report once the sandbox is gone',{timeout:60000},async t=>{
  const x=await setup(t,'off');
  const home='/watched-home';
  const entry={owner_scope:'f'.repeat(64),sbx_home:home,attemptId:x.attempt.attempt_id,jobId:'job-watched',reservedMs:60000,prepare_contract:'create-only',attempt:x.attempt};
  const row={day:new Date().toISOString().slice(0,10),jobs:0,milliseconds:0,pending:null,watchedStops:[entry]};
  await writeFile(x.counterFile,JSON.stringify({circle:x.circle.id,...(where==='root'?row:{accounts:{'codex:0':row}})}));
  const backend=Object.assign(syntheticBackend(x.f.root),{sandboxOwnership:()=>({owner_scope:entry.owner_scope,sbx_home:home}),
    reconcilePending:async pending=>({removed:true,attemptId:pending.attemptId,sbx_home:home,scratch_removed:true})});
  const offset=x.realRequests.length;
  await x.f.start('lender',{adapters:[],backend});
  await waitFor(async()=>x.realRequests.slice(offset).some(row=>row.route.endsWith('/stopped')),'the stopped report is sent',8000);
  await waitFor(async()=>{
    const saved=JSON.parse(await readFile(x.counterFile,'utf8'));
    return [saved,...Object.values(saved.accounts??{})].every(row=>!row.watchedStops?.length&&!row.stoppedPending);
  },'the obligation is cleared',8000);
  assert.equal(x.realRequests.slice(offset).filter(row=>row.route.endsWith('/stopped')).length,1);
  assert.equal(JSON.parse(await readFile(x.settingsFile,'utf8')).enabled,false);
});
