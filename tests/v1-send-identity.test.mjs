import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,parseOne} from './helpers/v1-journey.mjs';
import {openDevice} from '../lib/v1/device.mjs';
import {createJobOperations,problemForError,problemText} from '../lib/v1/cli.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

// One send is one job on every surface. The app page always names its send with a draft id. The command line,
// MCP and HTTP may not, so a send without one is named by what it asks for. A retry, a lost answer or an offline
// host must lead back to that same job until it has finished, and every uncertain answer names the job to follow.

async function setup(t){
  const f=await fixture(t);await f.provisionFromHome('owner');
  const circle=parseOne(await f.cli(['circle','create',f.origin,'--name','Friends','--json']));
  const home=await f.home('owner'),device=await openDevice({home});
  const client=device.client.bind(device);
  device.client=async (...args)=>{const c=await client(...args);c.fetchPresence=async()=>({devices:[]});return c;};
  return {f,circle,device,ops:createJobOperations({home,device}),
    input:{circle:circle.id,noSource:true,result:{kind:'message'},prompt:'Summarise the release notes'}};
}
// The host takes nothing: the connection drops before an answer, so the sender cannot know.
const hostOffline=f=>{f.override=async({req,res,route})=>{if(req.method==='POST'&&route==='/jobs'){res.destroy();return true;}return false;};};
const hostBack=f=>{f.override=null;};

test('an offline host: the answer names the saved job, and a later retry follows it instead of sending a copy',async t=>{
  const {f,ops,input}=await setup(t);
  hostOffline(f);
  const error=await ops.submit(input).then(()=>assert.fail('expected the send to be uncertain'),e=>e);
  assert.equal(error.outcome,'unknown');
  assert.match(error.jobDigest??'',/^sha256:[0-9a-f]{64}$/,'an uncertain send names the job it will become');
  assert.equal(f.jobs.size,0);
  hostBack(f);
  // The app delivers saved sends on its own once the host answers.
  await ops.recoverPending();
  assert.deepEqual([...f.jobs.keys()],[error.jobDigest],'the saved send is the job it named');
  // The person (or an agent) retries as if nothing arrived.
  const retry=await ops.submit(input);
  assert.equal(retry.jobDigest,error.jobDigest,'a retry follows the same job');
  assert.equal(retry.replayed,true);
  assert.equal(f.jobs.size,1,'no duplicate work');
});

test('a lost answer: retrying the same unnamed send follows the unfinished job; after it finishes, the same ask is new work',async t=>{
  const {f,ops,input}=await setup(t);
  const first=await ops.submit(input);  // accepted, but the caller (an agent whose tool call timed out) never saw it
  const retry=await ops.submit(input);
  assert.equal(retry.jobDigest,first.jobDigest,'a retry while the job is unfinished follows it');
  assert.equal(retry.replayed,true);
  assert.equal(f.jobs.size,1,'no duplicate work');
  await f.complete(first.jobDigest);
  const again=await ops.submit(input);
  assert.notEqual(again.jobDigest,first.jobDigest,'a finished job does not swallow a deliberate new request');
  assert.equal(f.jobs.size,2);
});

test('a named send keeps its own identity: a new draft id is a new job even with the same words',async t=>{
  const {f,ops,input}=await setup(t);
  const first=await ops.submit({...input,draftId:'send-identity-0001'});
  const second=await ops.submit({...input,draftId:'send-identity-0002'});
  assert.notEqual(second.jobDigest,first.jobDigest);
  assert.equal(f.jobs.size,2);
});

test('an unconfirmed earlier job is followed, not duplicated, when its state cannot be read',async t=>{
  const {f,ops,input}=await setup(t);
  const first=await ops.submit(input);
  f.override=async({req,res,route})=>{if(req.method==='GET'&&route.startsWith('/jobs/')){res.destroy();return true;}return false;};
  const retry=await ops.submit(input);
  assert.equal(retry.jobDigest,first.jobDigest);
  assert.equal(f.jobs.size,1);
});

test('the uncertain-send message names the job and who acts, and never asks for another send',()=>{
  const digest='sha256:'+'c'.repeat(64);
  const problem=problemForError({code:'network_error',outcome:'unknown',operationKey:'k-0001',jobDigest:digest});
  assert.equal(problem.jobDigest,digest);
  const text=problemText(problem);
  assert.doesNotMatch(text,/try again/i,'a send that may have arrived is never sent again');
  assert.match(text,/saved/i);
  assert.match(text,/host/i,'says who must act: the circle\'s host must answer');
  assert.ok(text.includes('faravan jobs wait '+'c'.repeat(8)),'names the one command that follows the same job');
  assert.doesNotMatch(text,/Operation key/,'the job id, not an internal key, is what a person follows');
});

test('the operation route the command line, MCP and HTTP share: the uncertain answer names the job, and retries follow it',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const send=status=>api(owner.app,'/api/ops/jobs.submit',{method:'POST',headers:{'faravan-confirm':'yes'},status,
    body:{circle:circle.id,noSource:true,result:{kind:'message'},prompt:'Summarise the release notes'}});
  const previous=f.override;
  f.override=async context=>{if(context.req.method==='POST'&&context.route==='/jobs'){context.res.destroy();return true;}return previous(context);};
  const lost=await send(503);
  assert.equal(lost.outcome,'unknown');
  assert.match(lost.jobDigest??'',/^sha256:[0-9a-f]{64}$/);
  assert.match(lost.message,/Do not send it again/);
  f.override=previous;
  const sent=await send(200);
  assert.equal(sent.jobDigest,lost.jobDigest,'the retry delivers the saved job');
  const again=await send(200);
  assert.deepEqual([again.jobDigest,again.replayed],[lost.jobDigest,true],'a retry whose answer was lost follows the same job');
  assert.equal(f.jobs.size,1,'no duplicate work');
});

// A frozen-audience send saved before the fingerprint included the audience flag sits under the old slot. Its
// host job may still be queued after the intent is marked complete; the same ask must follow that job.
test('an upgraded frozen-audience send that finished locally still follows its unfinished job',{timeout:120000},async t=>{
  const {f,device,ops,circle,input}=await setup(t);
  const frozenInput={...input,freeze_audience:true};
  const frozen=await ops.submit(frozenInput);
  const store=device.intentStore(circle.id);
  const [frozenSlot,current]=(await store.entries()).find(([,value])=>value.jobDigest===frozen.jobDigest)??[];
  assert.ok(frozenSlot,'the frozen send is saved under its own slot');
  // Recreate the pre-upgrade record: the same intent, stored at the slot that ignored the audience flag, marked complete.
  const legacy=await ops.submit({...input});  // the unfrozen send lands in that legacy slot
  const [legacySlot]=(await store.entries()).find(([,value])=>value.jobDigest===legacy.jobDigest);
  await store.set(legacySlot,{...current,state:'complete'});
  await store.delete(frozenSlot);
  const retry=await ops.submit(frozenInput);
  assert.equal(retry.jobDigest,frozen.jobDigest,'the upgraded frozen send follows its unfinished job, not a copy');
  assert.equal(retry.replayed,true);
  assert.equal(f.jobs.size,2,'one frozen job and the unfrozen one; no duplicate');
});

test('a cancelled job whose compute has not stopped still counts as running: the same ask follows it',async t=>{
  const {f,ops,input}=await setup(t);
  const first=await ops.submit(input);
  // The host has accepted a cancellation, but the attempt still runs (the review's "Stopping" state).
  Object.assign(f.jobs.get(first.jobDigest),{state:'cancelled',current_attempt:{attempt_id:'0f8fad5b-d9cb-469f-a165-000000000001',job_digest:first.jobDigest,generation:1,holder:'sha256:'+'b'.repeat(64),state:'active',
    claimed_at:'2026-11-05T10:00:00Z',execution_started_at:'2026-11-05T10:00:01Z',lease_expires_at:'2026-11-05T10:02:00Z',reason:null,compute_stopped:false,stopped_at:null}});
  const retry=await ops.submit(input);
  assert.equal(retry.jobDigest,first.jobDigest,'a retry while the attempt still runs follows the same job');
  assert.equal(retry.replayed,true);
  assert.equal(f.jobs.size,1,'no duplicate work');
  // Once the compute has stopped, the cancelled job has finished and the same ask is new work.
  f.jobs.get(first.jobDigest).current_attempt.compute_stopped=true;
  const again=await ops.submit(input);
  assert.notEqual(again.jobDigest,first.jobDigest);
  assert.equal(f.jobs.size,2);
});
