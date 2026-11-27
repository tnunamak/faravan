import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {settleOwnResets} from './helpers/pace50-reset-assertions.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {realKappaSource} from './helpers/kappa-real-source.mjs';

const T=Date.UTC(2026,9,29), MODEL={claude:'claude-haiku-5-5',codex:'gpt-6-sol'};
async function fixture(t,{io,strategy='automatic'}={}) {
 const clock={at:T,start:T}, scene=realKappaSource(clock), directory=fs.mkdtempSync(join(tmpdir(),'kappa-feedback-'));
 const first=await scene.source.observe({provider:'claude'});
 const opened=[];
 const open=()=>{const value=createLendingRuntime({directory,now:()=>clock.at,settings:()=>({intent:'on',limits:{lendingPolicy:{}}}),
  pace50:{source:scene.source,account:'synthetic-account',account_week_id:first.account_week_id,
   contextFor:provider=>({consent:true,ownerAbsent:true,plan:provider==='codex'?'pro':'max20',strategy,strategyParams:{fixedSharePct:50,keepPct:30}}),...(io?{io}:{})}});opened.push(value);return value;};
 const runtime=open();t.after(async()=>{
  await Promise.allSettled(opened.map(value=>value.close()));
  fs.rmSync(directory,{recursive:true,force:true});
 });
 const job={budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(T+3600000).toISOString()};
 const reserve=async(provider,id)=>{
  runtime.candidate.registry.bind(id,{stop:()=>{}});
  const out=await runtime.candidate.reserve({attemptId:id,jobId:id,provider,model:MODEL[provider],ownerAbsent:true,job:{...job,expires_at:new Date(clock.at+3600000).toISOString()}});
  assert.equal(out.ok,true,JSON.stringify(out));await runtime.candidate.started(id,{ok:true});
 };
 const settle=async(provider,id)=>{
  const attempt=runtime.pace50.state().attempts.find(a=>a.id===id), observed=await scene.source.observe({provider});
  await runtime.candidate.recordCleanup(id,{removed:true});
  for(const event of [
   {type:'usage',burn_id:id,resources:attempt.resources.map(r=>({id:r.id,instance:r.instance,amount_micro:3e6}))},
   {type:'reconcile_burn',burn_id:id,account:'synthetic-account',epoch:attempt.epoch,complete:true,compatible:true,
     refresh_succeeded:true,attribution_confirmed:true,observed_at:clock.at,resources:observed.resources},
   {type:'cessation_proven',authoritative_cessation:true,usage_reconciled:true},
  ]) {
   if(event.type==='reconcile_burn')event.resources=event.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.used_micro}));
   const before=runtime.pace50.state();
   const out=await runtime.pace50.deliver({...event,event_id:`${id}:${event.type}`,at:clock.at,attempt_id:id});
   if(event.type==='usage')assert.equal(out.applied,true,JSON.stringify(out));
   else {
    assert.equal(out.applied,false,JSON.stringify(out));
    assert.deepEqual(runtime.pace50.state(),before,'a refused aggregate release leaves the full ledger unchanged');
    assert.equal(out.reason,event.type==='reconcile_burn'?'usage_coverage_unavailable':'cessation_unreconciled');
   }
  }
  const held=runtime.pace50.state().attempts.find(a=>a.id===id);
  assert.equal(held.hold_closed,false,'aggregate receipts cannot prove complete provider posting');
  assert.ok(held.resources.every(r=>r.released_micro===0&&r.held_micro+r.unrepresented_micro===r.initial_micro));
 };
 const reset=async ids=>{
  for(const id of ids){
   await settleOwnResets(runtime.pace50,id);
   const row=runtime.pace50.state().attempts.find(a=>a.id===id);
   clock.at=Math.max(clock.at,...row.resources.map(r=>r.resets_at))+1;
   assert.ok(row.resources.every(r=>r.released_micro===0&&r.spent_micro+r.settled_micro===r.initial_micro));
  }
 };
 return {...scene,clock,directory,runtime,open,reserve,settle,reset};
}

for(const strategy of ['automatic','fixed_share'])test(`production source and ${strategy} runtime clear Claude then Codex feedback through independent provider receipts`,async t=>{
 const f=await fixture(t,{strategy});
 await f.reserve('claude','claude-job');f.used.claude=3;
 await f.runtime.candidate.recheck({attemptId:'claude-job',usd:10});await f.settle('claude','claude-job');await f.reset(['claude-job']);
 await f.runtime.candidate.refreshObservation({provider:'claude',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false,'Claude coverage clears the first surprise');
 f.clock.at+=1000;
 await f.reserve('codex','codex-job');f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'codex-job',usd:10});await f.settle('codex','codex-job');await f.reset(['codex-job']);
 await f.runtime.candidate.refreshObservation({provider:'claude',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'Claude cannot certify the pending Codex resources');
 await f.runtime.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 const feedback=f.runtime.pace50.state().rate_feedback;
 assert.equal(feedback.blocked,false,'separate per-provider receipts must not permanently freeze the shared runtime');
 assert.equal(feedback.rates.length,4,'covered rate memory must survive independently of pending coverage');
 for(const provider of ['claude','codex']) {
  const observation=await f.runtime.candidate.observe({provider,now:f.clock.at});
  assert.ok(observation.resources.every(r=>r.kappa_micro===100000));
 }
 await f.reserve('codex','codex-after-coverage');
 assert.equal(f.runtime.pace50.state().attempts.at(-1).resources[0].held_micro,1e6,'new windows use their current measurement while old rate memory stays scoped');
});

for (const provider of ['claude','codex']) test(`omitted ${provider} feedback blocks only its own provider`, async t => {
 const f=await fixture(t);
 await f.reserve(provider,'omitted-row'); f.used[provider]=3;
 await f.runtime.candidate.recheck({attemptId:'omitted-row',usd:10});
 await f.settle(provider,'omitted-row');
 const pending=f.runtime.pace50.state().rate_feedback.pending;
 const observe=f.source.observe.bind(f.source);
 f.source.observe=async args=>{
  const value=await observe(args);
  return args.provider===provider ? {...value,resources:value.resources.filter(r=>!pending.some(p=>p.id===r.id))} : value;
 };
 await f.runtime.candidate.refreshObservation({provider,now:f.clock.at});
 assert.deepEqual(f.runtime.pace50.state().rate_feedback.pending,pending,'omission alone never clears feedback');
 const other=provider==='claude'?'codex':'claude';
 await f.reserve(other,'other-provider');
 const out=await f.runtime.candidate.reserve({attemptId:'same-provider',jobId:'same-provider',
  provider,model:MODEL[provider],ownerAbsent:true,job:{budget_v1:{max_list_usd:10},
   requirements:{limits:{wall_seconds:60}},expires_at:new Date(T+3600000).toISOString()}});
 assert.equal(out.ok,false);
 assert.equal(out.policyReason,'meter_coverage_required');
});

for (const proof of ['stale','partial','unverified','other-account','unsupported'])
 test(`${proof} retirement claim cannot clear an omitted feedback row`,async t=>{
 const f=await fixture(t);
 await f.reserve('claude','omitted-row');f.used.claude=3;
 await f.runtime.candidate.recheck({attemptId:'omitted-row',usd:10});
 await f.settle('claude','omitted-row');
 const before=f.runtime.pace50.state();
 // The source has no retirement proof contract. Extra claims cannot authorize release.
 const out=await f.runtime.pace50.deliver({type:'meter_feedback_covered',event_id:'omission-claim',
  at:f.clock.at,observed_at:proof==='stale'?f.clock.at-60001:f.clock.at,
  account:proof==='other-account'?'another-account':before.account,
  complete:proof!=='partial',refresh_succeeded:proof!=='unverified',resources:[],
  retired_resource_ids:before.rate_feedback.pending.map(r=>r.id)});
 assert.equal(out.applied,false);
 assert.deepEqual(f.runtime.pace50.state(),before);
});

test('coverage of one row retains unrelated feedback and outstanding liability',async t=>{
 const f=await fixture(t);
 await f.reserve('claude','affected');f.used.claude=3;
 await f.runtime.candidate.recheck({attemptId:'affected',usd:10});
 const reading=await f.source.observe({provider:'claude'});
 const receipt=resources=>({type:'meter_feedback_covered',event_id:`coverage:${resources.length}:${f.runtime.pace50.state().revision}`,
  at:f.clock.at,observed_at:f.clock.at,account:'synthetic-account',complete:true,refresh_succeeded:true,
  resources:resources.map(r=>({...r,epoch:reading.epoch}))});
 const held=await f.runtime.pace50.deliver(receipt(reading.resources));
 assert.equal(held.applied,false);
 assert.equal(held.reason,'meter_liability_unreconciled');
 await f.settle('claude','affected');await f.reset(['affected']);
 const pending=f.runtime.pace50.state().rate_feedback.pending;
 const out=await f.runtime.pace50.deliver(receipt(reading.resources.slice(0,1)));
 assert.equal(out.applied,true);
 assert.deepEqual(f.runtime.pace50.state().rate_feedback.pending,pending.filter(r=>r.id!==reading.resources[0].id));
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true);
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
});

test('legacy mixed-provider feedback drains resource coverage independently and survives a partial-coverage restart',async t=>{
 const f=await fixture(t);
 await f.reserve('claude','legacy-claude');await f.reserve('codex','legacy-codex');
 f.used.claude=3;f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'legacy-claude',usd:10});
 await f.runtime.candidate.recheck({attemptId:'legacy-codex',usd:10});
 await f.settle('claude','legacy-claude');await f.settle('codex','legacy-codex');await f.reset(['legacy-claude','legacy-codex']);
 await f.runtime.close();
 // Legacy state has durable rate memory and a freeze, but no pending-coverage field.
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
});

test('concurrent provider receipts at one timestamp both clear their own pending coverage',async t=>{
 const f=await fixture(t);
 await f.reserve('claude','parallel-claude');await f.reserve('codex','parallel-codex');
 f.used.claude=3;f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'parallel-claude',usd:10});
 await f.runtime.candidate.recheck({attemptId:'parallel-codex',usd:10});
 await f.settle('claude','parallel-claude');await f.settle('codex','parallel-codex');await f.reset(['parallel-claude','parallel-codex']);
 await Promise.all(['claude','codex'].map(provider=>f.runtime.candidate.refreshObservation({provider,now:f.clock.at})));
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false);
 assert.equal(f.runtime.pace50.state().rate_feedback.rates.length,4);
});

for (const lostScope of ['plan', 'model']) test(`F1: covered feedback cannot restore a missing current ${lostScope} conversion`, async t => {
 const f=await fixture(t);
 await f.reserve('codex','bound-before-switch'); f.used.codex=3;
 await f.runtime.candidate.recheck({attemptId:'bound-before-switch',usd:10});
 await f.settle('codex','bound-before-switch');
 await f.runtime.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,true,'unresolved liability still blocks coverage');
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
 const pending=await f.runtime.candidate.observe({provider:'codex',model:MODEL.codex,now:f.clock.at});
 assert.ok(pending.resources.every(r=>r.kappa_micro===null),'current-scope rate memory cannot restore a rejected conversion');
 await f.reset(['bound-before-switch']);
 await f.runtime.candidate.refreshObservation({provider:'codex',now:f.clock.at});
 assert.equal(f.runtime.pace50.state().rate_feedback.blocked,false);
 await f.runtime.close();
 const reopened=f.open(); t.after(()=>reopened.close());
 const observed=await reopened.candidate.refreshObservation({provider:'codex',model:MODEL.codex,now:f.clock.at});
 assert.ok(observed.resources.every(r=>r.kappa_micro===null),'old durable rates must not authorize the new scope');
 const before=reopened.pace50.state();
 const out=await reopened.candidate.reserve({attemptId:'must-not-reserve',jobId:'must-not-reserve',
  provider:'codex',model:MODEL.codex,ownerAbsent:true,catalog:{revision:'test'},
  job:{budget_v1:{max_list_usd:10},requirements:{limits:{wall_seconds:60}},expires_at:new Date(f.clock.at+3600000).toISOString()}});
 assert.equal(out.ok,false);
 assert.equal(out.policyReason,'conversion_unknown');
 assert.deepEqual(reopened.pace50.state(),before,'refusal must not persist a reservation');
});

test('F3: runtime reading retains closed rejection recovery beside the default estimate',async t=>{
 const f=await fixture(t);
 const observe=f.source.observe.bind(f.source);
 f.source.observe=async args=>{
  const value=await observe(args);
  return {...value,resources:value.resources.map(r=>({...r,
   kappa_provenance:{label:'default estimate'},kappa_rejection_code:'binding_mismatch'}))};
 };
 const reading=await f.runtime.readings('codex',{forceRefresh:true});
 assert.ok(reading.windows.every(w=>w.conversionLabel.includes('default estimate')));
 assert.ok(reading.windows.every(w=>w.conversionLabel.includes('Refresh allowance')));
 assert.ok(reading.windows.every(w=>!w.conversionLabel.includes('2222333344445555')));
});
