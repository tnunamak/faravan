import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,parseOne} from './helpers/v1-journey.mjs';
import {openDevice} from '../lib/v1/device.mjs';
import {createJobOperations,statusMessage,problemForError} from '../lib/v1/cli.mjs';

async function setup(t){
  const f=await fixture(t);await f.provisionFromHome('owner');
  const circle=parseOne(await f.cli(['circle','create',f.origin,'--name','Friends','--json']));
  const home=await f.home('owner'),device=await openDevice({home});
  let devices=[];const client=device.client.bind(device);
  device.client=async (...args)=>{const c=await client(...args);c.fetchPresence=async()=>({devices});return c;};
  return {f,circle,device,ops:createJobOperations({home,device}),setDevices:value=>{devices=value;},
    input:{circle:circle.id,git:'https://github.com/example/app.git@'+'a'.repeat(40),prompt:'Fix sum',harness:'claude-code'}};
}
const lender=(adapter,extra={})=>({device:'other',online:true,source:'heartbeat',intent:{state:'ready'},agents:[{adapter,readiness:'ready'}],...extra});

test('submit explains absent agent before sending and send-anyway keeps the queued reason',async t=>{
  const {f,ops,input,setDevices}=await setup(t);setDevices([lender('codex')]);
  let refusal;
  await assert.rejects(ops.submit(input),error=>{refusal=error;return error.code==='agent_unavailable';});
  assert.equal(f.jobs.size,0);assert.equal(refusal.message,'No computer in the circle “Friends” lends Claude Code right now');
  assert.deepEqual(problemForError(refusal).action,{label:'Send anyway',input:{send_anyway:true}});
  const sent=await ops.submit({...input,send_anyway:true});
  const status=await ops.get({circle:input.circle,digest:sent.jobDigest});
  assert.equal(status.waiting_reason,'agent_unavailable');assert.equal(status.waiting_message,refusal.message);
  assert.match(statusMessage(status),/No computer in the circle “Friends” lends Claude Code right now/);
  assert.equal((await ops.list({circle:input.circle}))[0].waiting_reason,'agent_unavailable');
  setDevices([lender('claude-code-api-key')]);
  const ready=await ops.get({circle:input.circle,digest:sent.jobDigest});assert.equal(ready.waiting_reason,undefined);
  await ops.submit({...input,prompt:'Another favor'});assert.equal(f.jobs.size,2,'either Claude adapter can take the alias');
});

test('old presence with unknown capabilities stays cautious; an agent this computer lends satisfies its own job',async t=>{
  const {f,ops,input,setDevices,device}=await setup(t);
  setDevices([{device:'old',online:true,intent:{state:'on'}}]);await ops.submit(input);assert.equal(f.jobs.size,1);
  setDevices([lender('codex',{source:'poll',agents:[]})]);await ops.submit({...input,prompt:'Legacy poll'});
  // One computer that lends Claude Code in its own circle runs its own job, so the send is not refused.
  setDevices([lender('claude-code-subscription',{device:device.keyId})]);
  await ops.submit({...input,prompt:'Own job'});assert.equal(f.jobs.size,3);
  setDevices([lender('claude-code-subscription',{device:device.keyId,intent:{state:'off'}})]);
  await assert.rejects(ops.submit({...input,prompt:'New favor'}),{code:'agent_unavailable'});
  setDevices([lender('claude-code-subscription',{online:false})]);
  await assert.rejects(ops.submit({...input,prompt:'New favor'}),{code:'agent_unavailable'});
});

test('availability refusal creates no draft intent and a completed draft replays despite later absence',async t=>{
  const {f,ops,input,setDevices}=await setup(t);const request={...input,draftId:'agent-draft-0001'};
  await assert.rejects(ops.submit(request),{code:'agent_unavailable'});
  setDevices([lender('claude-code-subscription')]);const sent=await ops.submit(request);
  setDevices([]);const replay=await ops.submit(request);
  assert.equal(replay.jobDigest,sent.jobDigest);assert.equal(replay.replayed,true);assert.equal(f.jobs.size,1);
});

test('local HTTP refusal includes send-anyway retry and the waiting job keeps the reason',async t=>{
  const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const original=owner.app.device.client.bind(owner.app.device);
  owner.app.device.client=async (...args)=>{const c=await original(...args);c.fetchPresence=async()=>({devices:[lender('codex')]});return c;};
  const input={circle:circle.id,git:{url:'https://github.com/example/app.git',commit:'a'.repeat(40)},prompt:'Fix sum',harness:'claude-code'};
  const refusal=await api(owner.app,'/api/jobs',{method:'POST',body:input,status:409});
  assert.equal(refusal.code,'agent_unavailable');assert.equal(refusal.action.label,'Send anyway');
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{...input,...refusal.action.input}});
  const status=await api(owner.app,'/api/jobs/'+encodeURIComponent(sent.jobDigest)+'?circle='+circle.id);
  assert.equal(status.waiting_reason,'agent_unavailable');assert.equal(status.waiting_message,refusal.message);
});

test('one draft cannot create a second job after its source or prompt changes',async t=>{
  const {f,ops,input,setDevices}=await setup(t);setDevices([lender('claude-code-subscription')]);
  const request={...input,draftId:'immutable-draft-0001'};await ops.submit(request);
  await assert.rejects(ops.submit({...request,prompt:'Changed favor',send_anyway:true}),{code:'draft_changed'});
  await assert.rejects(ops.submit({...request,git:'https://github.com/example/app.git@'+'b'.repeat(40),send_anyway:true}),{code:'draft_changed'});
  assert.equal(f.jobs.size,1);
});

test('an uncertain accepted send retains its original key and refuses changed content',async t=>{
  const {f,ops,input,setDevices,device}=await setup(t);setDevices([lender('claude-code-subscription')]);
  const original=device.client.bind(device);let lose=true;const keys=[];
  device.client=async (...args)=>{const c=await original(...args),submit=c.submitJob.bind(c);c.submitJob=async (job,options)=>{
    keys.push(options.idempotencyKey);const sent=await submit(job,options);
    if(lose){lose=false;throw Object.assign(new Error('network_error'),{code:'network_error'});}return sent;
  };return c;};
  const request={...input,draftId:'uncertain-draft-0001'};
  await assert.rejects(ops.submit(request),{code:'network_error'});assert.equal(f.jobs.size,1);
  await assert.rejects(ops.submit({...request,prompt:'Changed after lost response',send_anyway:true}),{code:'draft_changed'});
  const sent=await ops.submit({...request,send_anyway:true});assert.equal(f.jobs.size,1);
  assert.equal(sent.jobDigest,[...f.jobs.keys()][0]);assert.equal(keys.length,2);assert.equal(keys[1],keys[0]);
});

test('an advertised matching agent whose readiness is unknown does not prove absence',async t=>{
  const {ops,input,setDevices}=await setup(t);
  setDevices([lender('claude-code-subscription',{source:'heartbeat',agents:[{adapter:'claude-code-subscription',readiness:'unknown'}]})]);
  const sent=await ops.submit(input);
  assert.equal((await ops.get({circle:input.circle,digest:sent.jobDigest})).waiting_reason,undefined);
  setDevices([lender('codex')]);
  await assert.rejects(ops.submit({...input,prompt:'No matching advertised agent'}),{code:'agent_unavailable'});
});

test('an older content-keyed draft is recovered instead of allowing a second send',async t=>{
  const {f,ops,input,setDevices,device}=await setup(t);setDevices([lender('claude-code-subscription')]);
  const request={...input,draftId:'legacy-draft-0001'},sent=await ops.submit(request);
  const store=device.intentStore(input.circle),slot='submit:draft:'+request.draftId;
  const intent=await store.get(slot),olderSlot=slot+':'+intent.draftFingerprint;
  const {draftFingerprint,...older}=intent;
  await store.set(olderSlot,older);await store.delete(slot);
  await store.set('job:'+sent.jobDigest,{jobDigest:sent.jobDigest,circle:input.circle,slot:olderSlot});
  const replay=await ops.submit({...request,send_anyway:true});assert.equal(replay.jobDigest,sent.jobDigest);
  await assert.rejects(ops.submit({...request,prompt:'Changed legacy draft',send_anyway:true}),{code:'draft_changed'});
  assert.equal(f.jobs.size,1);
});

test('only a heartbeat with known provenance can prove an advertised agent absent',async t=>{
  const {ops,input,setDevices}=await setup(t);
  for(const source of [undefined,null,'unrecognized']) {
    setDevices([lender('codex',{source,agents:[]})]);
    const sent=await ops.submit({...input,prompt:'Unknown provenance '+String(source)});
    assert.equal((await ops.get({circle:input.circle,digest:sent.jobDigest})).waiting_reason,undefined);
  }
});

test('real heartbeat, presence, send refusal and either Claude adapter share the protocol states',async t=>{
  const {appFixture,api}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t),{owner,lender:borrower,circle}=await f.realConnect();
  const client=await owner.app.device.client(circle.id);
  const heartbeat={boot:'availability-test-001',seq:0,intent:{state:'ready',reason:null,until:null},
    execution:{state:'idle',stops_by:null},blockers:[],capabilities:[],
    agents:[{adapter:'codex',readiness:'ready',models:[],per_job_max_minutes:20}]};
  await client.heartbeat(heartbeat);
  const input={circle:circle.id,git:{url:'https://github.com/example/app.git',commit:'a'.repeat(40)},prompt:'Fix sum',harness:'claude-code'};
  const refusal=await api(borrower.app,'/api/jobs',{method:'POST',body:input,status:409});
  assert.equal(refusal.code,'agent_unavailable');
  await client.heartbeat({...heartbeat,seq:1,agents:[{...heartbeat.agents[0],adapter:'claude-code-api-key'}]});
  const sent=await api(borrower.app,'/api/jobs',{method:'POST',body:input});
  const {JOB_DEFAULTS}=await import('../lib/v1/cli.mjs');
  const claim=await client.claimNext({harnesses:['claude-code-api-key'],models:[],capabilities:['filtered_git_v1'],egress:['internet'],
    enforced_limits:Object.keys(JOB_DEFAULTS.limits),max_limits:{...JOB_DEFAULTS.limits}},{waitSeconds:0});
  assert.equal(claim.job_digest,sent.jobDigest);
  assert.deepEqual(claim.job.payload.requirements.harness,['claude-code-subscription','claude-code-api-key']);
});
