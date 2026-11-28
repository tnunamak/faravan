import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {RUN_REQUEST_CAPABILITY} from '../lib/v1/versions.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
import {makeTelemetry,settle} from './helpers/telemetry-harness.mjs';

// Each lender failure site that had no diagnostic now reports one: one injected fault, one onDiagnostic call
// (TELEMETRY.md section 2.3 "Lender sites"). Synthetic fixtures only; no sandbox, provider or model.
function launch(f,{approve=async()=>true}={}) {
  const controller=new AbortController(),diagnostics=[];
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve,
    onDiagnostic:entry=>diagnostics.push(entry),onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal),settled=running.catch(error=>error);
  f.stop=async()=>{controller.abort();await settled;};
  return {lender,diagnostics,running,settled};
}
const offers=f=>{
  f.client.capabilities=async()=>({capabilities:['offers_v1',RUN_REQUEST_CAPABILITY]});
  f.client.listOffers=async function*(){};
};
const coded=(code,extra={})=>Object.assign(new Error('synthetic '+code),{code,...extra});
const only=(diagnostics,code)=>diagnostics.filter(d=>d.code===code);
const sawReason=(f,reason)=>f.events.some(e=>e.reason===reason);

// The raw cause stays in the local diagnostic log; the app strips it before telemetry (v1-app-diagnostic-telemetry),
// and the telemetry catalog drops it again if it ever arrives.
test('lender failure diagnostics keep raw error text local and telemetry never sends it', {timeout:60000}, async t => {
  const canary = '/home/alice/private-repo alice@example.test Fix the secret prompt';
  const f = await lenderFixture(t, {runError: Object.assign(new Error(canary), {code:'sandbox_start_failed'})});
  const {diagnostics} = launch(f);
  await until(() => f.count('/fail') === 1, 'failed job');
  await f.stop();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, canary, 'the local diagnostic keeps the cause');
  assert.ok(!JSON.stringify({...diagnostics[0], message: undefined}).includes(canary), 'only the message field carries raw text');
  const h = makeTelemetry();
  try {
    h.tel.observe('lender-failure', diagnostics[0]);
    await settle(h);
    assert.ok(h.transport.requests.length > 0);
    assert.doesNotMatch(JSON.stringify(h.transport.requests), /alice|private-repo|secret prompt/);
  } finally { h.cleanup(); }
});

test('a stop whose sandbox removal is unproven reports cessation_unverified beside the stop cause',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  f.backend.destroy=async()=>({removed:false});
  const {lender,diagnostics}=launch(f);
  await until(()=>f.calls.some(([kind])=>kind==='run'),'running');
  await lender.stopCurrentJob(lender.getState().current);
  await until(()=>sawReason(f,'cleanup_pending'),'unverified');
  await f.stop();
  const [entry]=only(diagnostics,'cessation_unverified');
  assert.equal(only(diagnostics,'cessation_unverified').length,1);
  assert.equal(entry.phase,'run');assert.equal(entry.job,f.jobDigest);assert.match(entry.ref,/^[A-Z2-7]{6}$/);
  assert.ok(diagnostics.some(d=>d.code!=='cessation_unverified'),'the abort cause keeps its own entry');
});

test('an abort whose sandbox removal is unproven reports cessation_unverified once',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true});
  f.backend.destroy=async()=>({removed:false});
  const {diagnostics}=launch(f);
  await until(()=>f.calls.some(([kind])=>kind==='run'),'running');
  await f.stop();
  assert.equal(only(diagnostics,'cessation_unverified').length,1);
  assert.equal(only(diagnostics,'cessation_unverified')[0].phase,'run');
});

test('a failed offer list reports offers_failed once per fault',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{offers:true});offers(f);
  let faults=0;
  f.client.listOffers=async function*(){if(faults++===0)throw new Error('synthetic list failure');};
  const {diagnostics}=launch(f);
  await until(()=>sawReason(f,'circle_unreachable'),'list failure surfaced');
  f.clock.advance(5000);await until(()=>faults>1,'list read again');
  await f.stop();
  assert.equal(diagnostics.length,1);
  assert.deepEqual([diagnostics[0].code,diagnostics[0].phase,diagnostics[0].job],['offers_failed','before_claim',null]);
});

test('a claim the lender gives up on reports claim_failed; a retried claim reports nothing',{timeout:60000},async t=>{
  const refused=await lenderFixture(t);
  refused.client.claimNext=async()=>{throw new Error('synthetic claim failure');};
  const first=launch(refused);
  await until(()=>sawReason(refused,'circle_unreachable'),'claim refused');
  await refused.stop();
  assert.equal(first.diagnostics.length,1);
  assert.deepEqual([first.diagnostics[0].code,first.diagnostics[0].phase],['claim_failed','before_claim']);

  const retried=await lenderFixture(t),original=retried.client.claimNext.bind(retried.client);let attempts=0;
  retried.client.claimNext=async(...args)=>{if(attempts++===0)throw coded('network_error');return original(...args);};
  const second=launch(retried);
  await until(()=>retried.events.some(e=>e.status==='accepting'),'claim retried');
  retried.clock.advance(1000);await until(()=>attempts>1,'claim sent again');
  await retried.stop();
  assert.equal(only(second.diagnostics,'claim_failed').length+only(second.diagnostics,'network_error').length,0);
});

test('a lender loop failure reports lender_failed once',{timeout:60000},async t=>{
  const f=await lenderFixture(t);
  const {diagnostics,settled}=launch(f);
  Object.defineProperty(f.policy,'enabled',{enumerable:true,get(){throw new Error('synthetic loop failure');}});
  assert.match((await settled).message,/synthetic loop failure/);
  assert.equal(diagnostics.length,1);
  assert.deepEqual([diagnostics[0].code,diagnostics[0].phase],['lender_failed','before_claim']);
});

test('a completion rejected during recovery reports completion_rejected; from the attempt catch it is reported once',{timeout:60000},async t=>{
  const recovery=await lenderFixture(t);
  recovery.override=({route,req})=>{if(route.endsWith('/complete')){req.socket.destroy();return true;}return false;};
  const interrupted=launch(recovery);
  await until(()=>sawReason(recovery,'circle_unreachable'),'completion saved for retry');
  await recovery.stop();
  assert.ok(recovery.saved().resultPending);
  recovery.override=({route,res})=>{if(route.endsWith('/complete')){recovery.problem(res,'definitive_rejection',409);return true;}return false;};
  const restarted=launch(recovery);
  await until(()=>recovery.saved().resultPending===null,'rejection settled');
  await recovery.stop();
  assert.equal(restarted.diagnostics.length,1);
  assert.deepEqual([restarted.diagnostics[0].code,restarted.diagnostics[0].phase],['definitive_rejection','result']);
  assert.equal(only(interrupted.diagnostics,'definitive_rejection').length,0);

  const live=await lenderFixture(t);
  live.override=({route,res})=>{if(route.endsWith('/complete')){live.problem(res,'definitive_rejection',409);return true;}return false;};
  const direct=launch(live);
  await until(()=>live.saved()?.lastResultOutcome?.code==='definitive_rejection','rejection settled');
  await live.stop();
  assert.equal(only(direct.diagnostics,'definitive_rejection').length,1,'the attempt catch already reported it');
  assert.equal(direct.diagnostics.length,1);
});
