import './helpers/no-browser.mjs';
import {tempDir} from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {realKappaSource} from './helpers/kappa-real-source.mjs';

const T=Date.UTC(2026,9,29), MODEL={claude:'claude-haiku-5-5',codex:'gpt-6-sol'};
async function fixture(t,{io,strategy='automatic'}={}) {
 const clock={at:T,start:T}, scene=realKappaSource(clock), directory=tempDir('kappa-r3-runtime-');
 const first=await scene.source.observe({provider:'claude'});
 const open=()=>createLendingRuntime({directory,now:()=>clock.at,settings:()=>({intent:'on',limits:{lendingPolicy:{}}}),
  pace50:{postingLagBoundMs:120000,source:scene.source,account:'synthetic-account',account_week_id:first.account_week_id,
   contextFor:provider=>({consent:true,ownerAbsent:true,plan:provider==='codex'?'pro':'max20',strategy,strategyParams:{fixedSharePct:50,keepPct:30}}),...(io?{io}:{})}});
 const runtime=open();t.after(()=>runtime.close().catch(()=>{}));
 const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(T+3600000).toISOString()};
 const reserve=async(provider,id)=>{
  runtime.candidate.registry.bind(id,{stop:()=>{}});
  const out=await runtime.candidate.reserve({attemptId:id,jobId:id,provider,model:MODEL[provider],ownerAbsent:true,job});
  assert.equal(out.ok,true,JSON.stringify(out));await runtime.candidate.started(id,{ok:true});
 };
 const settle=async(provider,id)=>{
  await runtime.candidate.recordCleanup(id,{removed:true});
  const attempt=runtime.pace50.state().attempts.find(a=>a.id===id);
  const usage=await runtime.pace50.deliver({type:'usage',burn_id:id,event_id:`${id}:usage`,at:clock.at,attempt_id:id,
   resources:attempt.resources.map(r=>({id:r.id,instance:r.instance,amount_micro:3e6}))});
  assert.equal(usage.applied,true,JSON.stringify(usage));
  clock.at+=120000;
  const observed=await scene.source.observe({provider});
  const event={at:clock.at,attempt_id:id,account:'synthetic-account',account_week_id:attempt.account_week_id,
   epoch:attempt.epoch,complete:true,compatible:true,refresh_succeeded:true,observed_at:clock.at,
   resources:observed.resources};
  let out=await runtime.pace50.deliver({...event,type:'usage_covered',event_id:`${id}:final-charge`});
  assert.equal(out.applied,true,JSON.stringify(out));
  scene.used[provider]+=1;clock.at++;
  const covering=await scene.source.observe({provider});
  out=await runtime.pace50.deliver({...event,type:'usage_represented',event_id:`${id}:represented`,at:clock.at,
   observed_at:clock.at,resources:covering.resources});
  assert.equal(out.applied,true,JSON.stringify(out));
  assert.equal(runtime.pace50.state().attempts.find(a=>a.id===id).hold_closed,true);
 };
 return {...scene,clock,directory,runtime,open,reserve,settle};
}

for(const strategy of ['automatic','fixed_share'])test(`production source and ${strategy} runtime clear Claude then Codex feedback through independent provider receipts`,async t=>{
 const f=await fixture(t,{strategy});
 await f.reserve('claude','claude-job');f.used.claude=3;
 await f.runtime.candidate.recheck({attemptId:'claude-job',usd:10});await f.settle('claude','claude-job');
 await f.runtime.candidate.refreshObservation({provider:'claude',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false,'Claude coverage clears the first surprise');
 f.clock.at+=1000;
 await f.reserve('codex','codex-job');f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'codex-job',usd:10});await f.settle('codex','codex-job');
 await f.runtime.candidate.refreshObservation({provider:'claude',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'Claude cannot certify the pending Codex resources');
 await f.runtime.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 const feedback=f.runtime.pace50.state().rate_feedback;
 assert.equal(feedback.blocked,false,'separate per-provider receipts must not permanently freeze the shared runtime');
 assert.equal(feedback.rates.length,4,'covered rate memory must survive independently of pending coverage');
 for(const provider of ['claude','codex']) {
  const observation=await f.runtime.candidate.observe({provider,now:f.clock.at});
  assert.ok(observation.resources.every(r=>r.kappa_micro===300000));
 }
 await f.reserve('codex','codex-after-coverage');
 assert.equal(f.runtime.pace50.state().attempts.at(-1).resources[0].held_micro,3e6,'both strategies can lend again at the remembered rate');
 console.log('scratch',f.directory);
});

for(const point of ['before-rename','after-rename'])test(`feedback persistence fault ${point} leaves old or whole new state, never a partial update`,async t=>{
 let armed=false;
 const f=await fixture(t,{io:{renameSync:(from,to)=>{
  if(armed&&point==='before-rename')throw new Error('injected feedback write failure before rename');
  fs.renameSync(from,to);
  if(armed&&point==='after-rename')throw new Error('injected feedback write failure after rename');
 }}});
 await f.reserve('claude','write-job');const before=f.runtime.pace50.state();
 f.used.claude=3;armed=true;
 await assert.rejects(f.runtime.candidate.recheck({attemptId:'write-job',usd:10}),/persist_failed|reopen|poisoned/i);
 armed=false;await f.runtime.close().catch(()=>{});
 const reopened=f.open();t.after(()=>reopened.close());
 const state=reopened.pace50.state();
 if(point==='before-rename')assert.deepEqual(state,before);
 else {
  assert.equal(state.rate_feedback.blocked,true);
  assert.ok(state.attempts[0].resources.every(r=>r.held_micro===3e6&&r.kappa_micro===300000));
  assert.equal(state.revision,before.revision+1);
 }
 console.log('scratch',f.directory);
});

test('legacy mixed-provider feedback drains resource coverage independently and survives a partial-coverage restart',async t=>{
 const f=await fixture(t);
 await f.reserve('claude','legacy-claude');await f.reserve('codex','legacy-codex');
 f.used.claude=3;f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'legacy-claude',usd:10});
 await f.runtime.candidate.recheck({attemptId:'legacy-codex',usd:10});
 await f.settle('claude','legacy-claude');await f.settle('codex','legacy-codex');
 await f.runtime.close();
 // Fixture for an on-disk round-2 state: rate memory and freeze exist, but there is no pending-coverage field.
 const file=join(f.directory,'lending-pace50-state.json'),legacy=JSON.parse(fs.readFileSync(file,'utf8'));
 delete legacy.rate_feedback.pending;fs.writeFileSync(file,JSON.stringify(legacy));
 const reopened=f.open();t.after(()=>reopened.close());
 await reopened.candidate.refreshObservation({provider:'claude',now:f.clock.at});
 assert.equal(reopened.pace50.state().rate_feedback.blocked,true);
 assert.equal(reopened.pace50.state().rate_feedback.pending?.length,2,'only Codex resources remain after a Claude receipt');
 await reopened.close();
 const again=f.open();t.after(()=>again.close());
 assert.equal(again.pace50.state().rate_feedback.pending.length,2,'partial coverage is itself durable');
 await again.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 assert.equal(again.pace50.state().rate_feedback.blocked,false);
 assert.equal(again.pace50.state().rate_feedback.pending.length,0);
 assert.equal(again.pace50.state().rate_feedback.rates.length,4,'independent coverage never erases observed rate memory');
 console.log('scratch',f.directory);
});

test('concurrent provider receipts at one timestamp both clear their own pending coverage',async t=>{
 const f=await fixture(t);
 await f.reserve('claude','parallel-claude');await f.reserve('codex','parallel-codex');
 f.used.claude=3;f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'parallel-claude',usd:10});
 await f.runtime.candidate.recheck({attemptId:'parallel-codex',usd:10});
 await f.settle('claude','parallel-claude');await f.settle('codex','parallel-codex');
 await Promise.all(['claude','codex'].map(provider=>f.runtime.candidate.refreshObservation({provider,now:f.clock.at})));
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false);
 assert.equal(f.runtime.pace50.state().rate_feedback.rates.length,4);
 console.log('scratch',f.directory);
});

for (const lostScope of ['plan', 'model']) test(`F1: covered feedback cannot restore a missing current ${lostScope} conversion`, async t => {
 const f=await fixture(t);
 await f.reserve('codex','bound-before-switch'); f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'bound-before-switch',usd:10});
 await f.settle('codex','bound-before-switch');
 await f.runtime.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false);
 assert.equal(f.runtime.pace50.state().rate_feedback.rates.length,2);
 // The production source rejects the new plan/model measurement. Preserve every
 // resource coordinate so only the absence of a current conversion distinguishes it.
 const observe=f.source.observe.bind(f.source);
 f.source.observe=async args => {
  const value=await observe(args);
  return args.provider==='codex' ? {...value,
   ...(lostScope==='plan' ? {account_plan:{plan:'plus',source:'provider'}} : {}),
   resources:value.resources.map(r=>({...r,kappa_micro:null,kappa_rejection_code:'binding_mismatch'}))} : value;
 };
 await f.runtime.close();
 const reopened=f.open(); t.after(()=>reopened.close());
 const observed=await reopened.candidate.refreshObservation({provider:'codex',model:MODEL.codex,now:f.clock.at});
 assert.ok(observed.resources.every(r=>r.kappa_micro===null),'old durable rates must not authorize the new scope');
 const before=reopened.pace50.state();
 const out=await reopened.candidate.reserve({attemptId:'must-not-reserve',jobId:'must-not-reserve',
  provider:'codex',model:MODEL.codex,ownerAbsent:true,catalog:{revision:'test'},
  job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(T+3600000).toISOString()}});
 assert.equal(out.ok,false);
 assert.equal(out.policyReason,'conversion_unknown');
 assert.deepEqual(reopened.pace50.state(),before,'refusal must not persist a reservation');
});
