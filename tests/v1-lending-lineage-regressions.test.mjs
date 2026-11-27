import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State, settlementEligibility} from '../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {ordinaryInput, request, weekly, short, ACCOUNT, WEEK} from './helpers/pace50-fixtures.mjs';

function apply(state,type,at,extra={}) {
 const out=transitionEstimatedPace50State(state,{type,at,event_id:`${type}:${state.revision}`,attempt_id:'root',...extra});
 assert.equal(out.applied,true,`${type}: ${out.reason}`);
 return out.state;
}
function reserved(cold=false) {
 const native={conversion:'native_window',kappa_micro:null,used_micro:0};
 const windows=[weekly(1000,{...native,id:'seven_day',anchor_at:0,resets_at:604800000}),
  short(1000,{...native,id:'five_hour',anchor_at:0,resets_at:18000000,...(cold?{cold_open:true,origin:'cold'}:{})})];
 const input=ordinaryInput({now:1000,windows});input.weekly_resource_id='seven_day';
 input.state=createEstimatedPace50State({account:ACCOUNT,account_week_id:WEEK});
 input.request=request({attempt_id:'root',job_id:'root',provider:'claude',model:'claude-sonnet-5-5'});
 input.objective.job.requestedUsdMicro=input.request.requested_usd_micro;
 const out=evaluateEstimatedPace50(input);assert.equal(out.admitted,true,out.reason);
 return apply(out.proposed_state,'launch_result',1001,{result:'started'});
}
function carried(cold=false) {
 let state=reserved(cold);
 state=apply(state,'late_ack',18000000);
 state=apply(state,'late_start_carried',18000000,{observed_at:18000000,epoch:'epoch-1',account_week_id:WEEK,
  carries:[{from_id:'five_hour',from_instance:'short-1',resource:{id:'five_hour',kind:'short',instance:'child-window',epoch:'epoch-1',
   anchor_at:18000000,resets_at:36000000,duration_ms:18000000,kappa_micro:null,used_micro:0}}]});
 return state;
}
const childOf=state=>state.attempts.find(a=>a.id.includes(':carry:'));
async function runtime(t,state,at,resources=[],options={}) {
 const directory=fs.mkdtempSync(join(tmpdir(),'lineage-regression-'));
 fs.writeFileSync(join(directory,'lending-pace50-state.json'),JSON.stringify(state));
 const clock={at};
 const source={observe:async()=>({refresh_succeeded:true,complete:true,observed_at:clock.at,epoch:'epoch-1',account_week_id:WEEK,
  identity:{verified:true,account_id:ACCOUNT},funding:{subscription_only:'proven'},weekly_resource_id:'seven_day',resources}),stop_bound_ms:0};
 const open=()=>createPace50Candidate({directory,now:()=>clock.at,account:ACCOUNT,account_week_id:WEEK,source,...options,
  pendingRecords:()=>[],nativeGuard:{setTimer:()=>0,clearTimer:()=>{}},effectOverrides:{arm_cessation_deadline:async()=>()=>{}}});
 let pace=open();
 t.after(async()=>{await pace.adapter.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {get pace(){return pace;},clock,async reopen(){await pace.adapter.close();pace=open();}};
}

test('descendant liveness at 35999000 invalidates root cessation at 18001000',()=>{
 let state=carried();
 state=apply(state,'cleanup_proven',18001000,{event_id:'root:cleanup-proven:one',cleanup_removed:true});
 const child=childOf(state);
 state=apply(state,'late_ack',35999000,{attempt_id:child.id});
 const current=childOf(state),r=current.resources[0];
 assert.equal(r.resets_at,36000000);assert.equal(r.duration_ms,18000000);
 assert.deepEqual(settlementEligibility(current,r,{state,at:36000000}),{reason:'retain',nextEligibleAt:null});
});

test('real held sweep closes a late child at 72000000 after root cessation 36001000',async t=>{
 let state=carried(),child=childOf(state);
 state=apply(state,'late_ack',35999000,{attempt_id:child.id});
 state=apply(state,'cleanup_proven',36001000,{event_id:'root:cleanup-proven:two',cleanup_removed:true});
 const f=await runtime(t,state,72000000);
 assert.equal(settlementEligibility(childOf(state),child.resources[0],{state,at:72000000}).nextEligibleAt,54001000n);
 await f.pace.candidate.probeHeld();
 assert.equal(childOf(f.pace.adapter.state()).resources[0].unrepresented_micro,0);
 await f.reopen();await f.pace.candidate.probeHeld();
 assert.equal(childOf(f.pace.adapter.state()).hold_closed,true);
});

test('a cold source carries its provenance into the 36000000 successor',()=>{
 // A cold-open window carries only with a verified reading taken after the cleanup proof (coldWindowResetProven).
 let state=reserved(true);
 state=apply(state,'late_ack',18000000);
 state=apply(state,'cleanup_proven',18000000,{event_id:'root:cleanup-proven:cold',cleanup_removed:true});
 const at=18000000+120000;
 const child={id:'five_hour',kind:'short',instance:'child-window',epoch:'epoch-1',
  anchor_at:18000000,resets_at:36000000,duration_ms:18000000,kappa_micro:null,used_micro:0};
 const reading={identity:{verified:true,account_id:ACCOUNT},complete:true,refresh_succeeded:true,observed_at:at,
  account_week_id:WEEK,epoch:'epoch-1',resources:[{...child,state:'not_open'}]};
 state=apply(state,'late_start_carried',at,{observed_at:at,epoch:'epoch-1',account_week_id:WEEK,reading,
  carries:[{from_id:'five_hour',from_instance:'short-1',resource:child}]});
 assert.equal(childOf(state).resources[0].cold_open,true);
});

test('late launch after full settlement protects the current window exactly once through restart',async t=>{
 let state=reserved();
 state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:three',cleanup_removed:true});
 state=apply(state,'window_reset_settled',604800000,{authoritative_cessation:true,resource_ids:['five_hour','seven_day']});
 assert.ok(state.attempts[0].resources.every(r=>r.released_micro===0&&r.held_micro===0));
 const current=state.attempts[0].resources.map(r=>({...r,instance:`current:${r.id}`,anchor_at:604800000,
  resets_at:604800000+r.duration_ms,used_micro:0,kappa_micro:null}));
 const f=await runtime(t,state,604801000,current);
 await f.pace.candidate.started('root',{ok:true});
 await f.pace.candidate.probeHeld();
 const liability=()=>f.pace.adapter.state().attempts.flatMap(a=>a.resources).filter(r=>r.instance.startsWith('current:'));
 assert.equal(liability().length,2);
 for(const r of liability())assert.equal(r.held_micro+r.unrepresented_micro,r.initial_micro);
 const before=liability().map(r=>({...r}));
 await f.reopen();await f.pace.candidate.started('root',{ok:true});await f.pace.candidate.probeHeld();
 assert.deepEqual(liability(),before);
});

for(const originalFirst of [true,false])test(`two short resets settle in either order (original first=${originalFirst})`,async()=>{
 let state=carried(),child=childOf(state);
 state=apply(state,'late_start_carried',36000000,{attempt_id:child.id,observed_at:36000000,epoch:'epoch-1',account_week_id:WEEK,
  carries:[{from_id:'five_hour',from_instance:'child-window',resource:{id:'five_hour',kind:'short',instance:'third-window',epoch:'epoch-1',anchor_at:36000000,resets_at:54000000,duration_ms:18000000,kappa_micro:null,used_micro:0}}]});
 state=apply(state,'cleanup_proven',36001000,{event_id:'root:cleanup-proven:after-two',cleanup_removed:true});
 const rows=originalFirst?[...state.attempts]:[...state.attempts].reverse();
 for(const row of rows)for(const r of row.resources){
  if(state.attempts.find(a=>a.id===row.id).hold_closed===true)continue;
  const bound=settlementEligibility(state.attempts.find(a=>a.id===row.id),r,{state,at:604800001}).nextEligibleAt;
  state=apply(state,'window_reset_settled',Math.max(state.updated_at,Number(bound)),{attempt_id:row.id,authoritative_cessation:true,resource_ids:[r.id]});
 }
 assert.ok(state.attempts.every(a=>a.hold_closed===true&&!a.late_ack_unresolved&&a.resources.every(r=>r.held_micro+r.unrepresented_micro===0)));
});

test('a later descendant acknowledgement permits fresh original cleanup and retains its maximum',()=>{
 let state=carried();state=apply(state,'cleanup_proven',18001000,{event_id:'root:cleanup-proven:old',cleanup_removed:true});
 const child=childOf(state);
 state=apply(state,'late_ack',35999000,{attempt_id:child.id});
 state=apply(state,'cleanup_proven',36001000,{event_id:'root:cleanup-proven:fresh',cleanup_removed:true});
 assert.equal(settlementEligibility(childOf(state),child.resources[0],{state,at:54001000}).reason,'deadline_reached');
 assert.equal(childOf(state).resources[0].unrepresented_micro,child.resources[0].initial_micro);
});

test('a same-week carry rejects mismatched account identity',()=>{
 let state=reserved();state=apply(state,'late_ack',18000000);
 const event={type:'late_start_carried',event_id:'foreign-carry',attempt_id:'root',at:18000000,observed_at:18000000,
  account:'another-account',identity_verified:true,epoch:'epoch-1',account_week_id:WEEK,
  carries:[{from_id:'five_hour',from_instance:'short-1',resource:{id:'five_hour',kind:'short',instance:'child-window',epoch:'epoch-1',anchor_at:18000000,resets_at:36000000,duration_ms:18000000,kappa_micro:null,used_micro:0}}]};
 const out=transitionEstimatedPace50State(state,event);assert.equal(out.applied,false);assert.deepEqual(out.state,state);
});

test('the real sweep closes every zero-source marker after two short resets and VM destruction',async t=>{
 let state=carried(),child=childOf(state);
 state=apply(state,'late_start_carried',36000000,{attempt_id:child.id,observed_at:36000000,epoch:'epoch-1',account_week_id:WEEK,
  carries:[{from_id:'five_hour',from_instance:'child-window',resource:{id:'five_hour',kind:'short',instance:'third-window',epoch:'epoch-1',anchor_at:36000000,resets_at:54000000,duration_ms:18000000,kappa_micro:null,used_micro:0}}]});
 state=apply(state,'cleanup_proven',36001000,{event_id:'root:cleanup-proven:all',cleanup_removed:true});
 const f=await runtime(t,state,36001000+604800000);await f.pace.candidate.probeHeld();
 assert.ok(f.pace.adapter.state().attempts.every(a=>a.hold_closed===true&&!a.late_ack_unresolved));
 await f.reopen();await f.pace.candidate.probeHeld();
 assert.ok(f.pace.adapter.state().attempts.every(a=>a.hold_closed===true));
});

test('a pending late generation with no reading closes at its verified cessation bound',async t=>{
 let state=reserved();state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:first',cleanup_removed:true});
 state=apply(state,'window_reset_settled',604800000,{authoritative_cessation:true,resource_ids:['five_hour','seven_day']});
 state=apply(state,'late_ack',604801000);
 assert.ok(state.attempts[0].pending_late_exposure);
 state=apply(state,'cleanup_proven',604802000,{event_id:'root:cleanup-proven:late',cleanup_removed:true});
 const bound=604802000+604800000;
 const f=await runtime(t,state,bound);await f.pace.candidate.probeHeld();
 assert.equal(f.pace.adapter.state().attempts[0].pending_late_exposure,undefined);
 assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
 await f.reopen();assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
});

test('later lineage receipts invalidate an authoritative bound even in the same clock millisecond',()=>{
 let state=carried();state=apply(state,'late_ack',18001000,{authoritative_cessation:true});
 const child=childOf(state);state=apply(state,'late_ack',18001000,{attempt_id:child.id});
 assert.equal(settlementEligibility(childOf(state),child.resources[0],{state,at:36000000}).nextEligibleAt,null);
 state=apply(state,'cessation_proven',18001000,{authoritative_cessation:true,usage_reconciled:false});
 assert.equal(settlementEligibility(childOf(state),child.resources[0],{state,at:36000000}).reason,'retain');
 assert.equal(settlementEligibility(childOf(state),child.resources[0],{state,at:18001000+child.resources[0].duration_ms}).reason,'deadline_reached');
});

test('native held-sweep closure still publishes the final calibration sample once',async t=>{
 let state=reserved();
 state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:calibration',cleanup_removed:true});
 const resources=state.attempts[0].resources.map(r=>({...r,used_micro:1000000})),receipts=[];
 const f=await runtime(t,state,122000,resources,{postingLagBoundMs:120000,onCalibration:samples=>receipts.push(samples)});
 Object.assign(f.pace.candidate.registry.entry('root'),{provider:'claude',nativeSettle:{usage:'positive',usdMicro:1000000,model:'claude-sonnet-5-5'}});
 await f.pace.candidate.probeHeld();
 assert.equal(receipts.length,0,'retained exposure is not a completed calibration interval');
 f.clock.at++;for(const r of resources)r.used_micro=3000000;
 await f.pace.candidate.probeHeld();
 assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
 assert.equal(receipts.length,1);
 assert.equal(receipts[0].length,2);
 await f.pace.candidate.probeHeld();
 assert.equal(receipts.length,1,'a closed interval cannot be published twice');
});

test('a successor payload cannot reduce the computed maximum and repeated receipts cannot duplicate it',()=>{
 let state=reserved();
 state=apply(state,'late_ack',18000000);
 const from=state.attempts[0].resources.find(r=>r.kind==='short'),maximum=from.initial_micro;
 const carry={type:'late_start_carried',event_id:'undersized-payload',attempt_id:'root',at:18000000,observed_at:18000000,
  epoch:'epoch-1',account_week_id:WEEK,carries:[{from_id:from.id,from_instance:from.instance,
   resource:{id:from.id,kind:'short',instance:'computed-successor',epoch:'epoch-1',anchor_at:18000000,
    resets_at:36000000,duration_ms:18000000,used_micro:0,kappa_micro:null,initial_micro:1,held_micro:1}}]};
 let out=transitionEstimatedPace50State(state,carry);assert.equal(out.applied,true,out.reason);state=out.state;
 assert.equal(childOf(state).resources[0].initial_micro,maximum);
 assert.equal(childOf(state).resources[0].unrepresented_micro,maximum);
 const before=structuredClone(childOf(state).resources);
 out=transitionEstimatedPace50State(state,carry);assert.equal(out.applied,false);assert.equal(out.reason,'duplicate_event');
 state=apply(state,'late_ack',18000001);
 out=transitionEstimatedPace50State(state,{...carry,event_id:'repeat-after-new-receipt',at:18000001,observed_at:18000001});
 assert.equal(out.applied,false);
 assert.equal(out.state.attempts.filter(a=>a.id.includes(':carry:')).length,1);
 assert.deepEqual(childOf(out.state).resources,before);
 assert.equal(settlementEligibility(childOf(out.state),before[0],{state:out.state,at:36000000}).reason,'retain');
});

test('late start after full settlement stops blocking admission at max(R, C+D) without a current-resource reading',async t=>{
 let state=reserved();
 state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:initial',cleanup_removed:true});
 state=apply(state,'window_reset_settled',604800000,{authoritative_cessation:true,resource_ids:['five_hour','seven_day']});
 // The source answers, but never with a current-resource roster, so no generation can be installed.
 const f=await runtime(t,state,604801000,[]);
 await f.pace.candidate.started('root',{ok:true});
 const root=()=>f.pace.adapter.state().attempts.find(a=>a.id==='root');
 assert.ok(root().pending_late_exposure,'the late start queues pending exposure');
 const C=604802000;
 const proof=await f.pace.adapter.transition({type:'cleanup_proven',event_id:'root:cleanup-proven:after-late',attempt_id:'root',at:C,cleanup_removed:true},
  {expectedRevision:f.pace.adapter.state().revision});
 assert.equal(proof.applied,true,proof.reason);
 // Every window the run could have used began at or after the 604800000 reset: R = 604800000 + D.
 const R=Math.max(...root().resources.map(r=>604800000+r.duration_ms));
 const B=Math.max(R,C+Math.max(...root().resources.map(r=>r.duration_ms)));
 assert.equal(B,1209602000);
 const floor=root().resources.map(r=>r.spent_micro+r.settled_micro);
 const admit=at=>{
  const input=ordinaryInput({now:at,windows:[weekly(at,{id:'seven_day',instance:'after-week',anchor_at:at,resets_at:at+604800000,conversion:'native_window',kappa_micro:null,used_micro:0}),
   short(at,{id:'five_hour',instance:'after-short',anchor_at:at,resets_at:at+18000000,conversion:'native_window',kappa_micro:null,used_micro:0})]});
  input.weekly_resource_id='seven_day';input.state=f.pace.adapter.state();
  input.request=request({attempt_id:`after-${at}`,job_id:`after-${at}`,provider:'claude',model:'claude-sonnet-5-5',expires_at:at+3600000});
  input.objective.job.requestedUsdMicro=input.request.requested_usd_micro;
  return evaluateEstimatedPace50(input);
 };
 f.clock.at=B-1;await f.pace.candidate.probeHeld();
 assert.ok(root().pending_late_exposure,'pending exposure stays before B');
 assert.equal(admit(B-1).reason,'cross_window_exposure_unreconciled');
 const partial=await f.pace.adapter.transition({type:'window_reset_settled',event_id:'root:partial',attempt_id:'root',at:B-1,
  resource_ids:['five_hour'],authoritative_cessation:true},{expectedRevision:f.pace.adapter.state().revision});
 assert.equal(partial.reason,'settlement_not_eligible','one reached resource does not end pending exposure');
 for(const r of root().resources)assert.deepEqual(settlementEligibility(root(),r,{state:f.pace.adapter.state(),at:B}).reason,'deadline_reached');
 f.clock.at=B;await f.pace.candidate.probeHeld();
 f.clock.at=B+1;await f.pace.candidate.probeHeld();
 assert.equal(root().pending_late_exposure,undefined,'pending exposure ends at B');
 assert.equal(root().hold_closed,true);
 root().resources.forEach((r,i)=>{
  assert.equal(r.held_micro+r.unrepresented_micro,0);
  assert.ok(r.spent_micro+r.settled_micro>=floor[i],'closing never lowers the charged floor');
  assert.equal(r.spent_micro+r.settled_micro,r.initial_micro,'the run is charged its full maximum');
 });
 const next=admit(B+1);
 assert.notEqual(next.reason,'cross_window_exposure_unreconciled');
 assert.equal(next.admitted,true,next.reason);
});

test('pending deadline charges a previously refunded source and cannot become an empty generation',async t=>{
 let state=reserved();
 state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:refund',cleanup_removed:true});
 let out=transitionEstimatedPace50State(state,{type:'usage_covered',event_id:'original-refund',at:122000,observed_at:122000,
  attempt_id:'root',account:ACCOUNT,account_week_id:WEEK,epoch:'epoch-1',complete:true,compatible:true,refresh_succeeded:true,
  resources:state.attempts[0].resources.map(r=>({...r,used_micro:0}))},{postingLagBoundMs:120000});
 assert.equal(out.applied,true,out.reason);state=out.state;
 state=apply(state,'window_reset_settled',604800000,{authoritative_cessation:true,resource_ids:['five_hour','seven_day']});
 assert.ok(state.attempts[0].resources.every(r=>r.released_micro>0));
 const f=await runtime(t,state,604801000,[]);await f.pace.candidate.started('root',{ok:true});
 const C=604802000,B=C+604800000;
 await f.pace.adapter.deliver({type:'cleanup_proven',event_id:'root:cleanup-proven:new-refunded-run',at:C,attempt_id:'root',cleanup_removed:true});
 out=transitionEstimatedPace50State(f.pace.adapter.state(),{type:'late_exposure_carried',event_id:'empty-at-deadline',at:B,
  observed_at:B,attempt_id:'root',account:ACCOUNT,account_week_id:WEEK,epoch:'epoch-1',complete:true,refresh_succeeded:true,
  identity_verified:true,resources:[]});
 assert.equal(out.applied,false,'an empty carry cannot discard the pending maximum');
 f.clock.at=B;await f.pace.candidate.probeHeld();
 const stopped=f.pace.adapter.state().attempts[0];
 assert.equal(stopped.pending_late_exposure,undefined);assert.equal(stopped.hold_closed,true);
 assert.ok(stopped.resources.every(r=>r.spent_micro+r.settled_micro===r.initial_micro&&r.released_micro===0));
 await f.reopen();assert.deepEqual(f.pace.adapter.state().attempts[0],stopped);
});

for(const repeat of [false,true])test(`stale cessation on the late-ack path retains protection and history through restart (repeat=${repeat})`,async t=>{
 let state=reserved();
 state=apply(state,'cleanup_proven',2000,{event_id:'root:cleanup-proven:old-history',cleanup_removed:true});
 state=apply(state,'window_reset_settled',604800000,{authoritative_cessation:true,resource_ids:['five_hour','seven_day']});
 const f=await runtime(t,state,604801000,[]);await f.pace.candidate.started('root',{ok:true});
 const before=structuredClone(f.pace.adapter.state().attempts[0]),C=604802000;
 const event={type:'cessation_proven',event_id:'stale-proof',attempt_id:'root',at:C,observed_at:C-180000,
  authoritative_cessation:true,usage_reconciled:true,complete:true,compatible:true,refresh_succeeded:true,
  resources:before.resources.map(r=>({...r,used_micro:r.baseline_used_micro}))};
 // A stale reading (older than 60 s) cannot back a usage_reconciled claim on the late-ack path: refused, nothing changes.
 let out=await f.pace.adapter.deliver(event);
 assert.equal(out.applied,false);assert.equal(out.reason,'late_ack_reconciliation_incomplete');
 assert.deepEqual(f.pace.adapter.state().attempts[0],before);
 // The physical cessation alone is recorded: it bounds the hold and reconciles nothing.
 out=await f.pace.adapter.deliver({type:'cessation_proven',event_id:'stale-proof-bare',attempt_id:'root',at:C,authoritative_cessation:true});
 assert.equal(out.applied,true,out.reason);
 const stopped=()=>f.pace.adapter.state().attempts[0];
 assert.equal(stopped().late_ack_unresolved,true,'recording cessation cannot erase the late acknowledgement');
 assert.equal(stopped().hold_closed,false,'pending protection must remain reachable by the held sweep');
 assert.equal(stopped().cleanup_proof_persisted_at,null,'cessation does not manufacture cleanup proof');
 assert.deepEqual(stopped().resources,before.resources,'stale usage evidence releases no money');
 assert.ok(stopped().late_ack_events.every(e=>e.resolved_by===null&&e.cessation_at===C));
 // The charge-kernel support ends by the latest possible charge plus the resource's own window duration.
 const B=Math.max(...stopped().resources.map(r=>Math.max(r.resets_at,C+r.duration_ms)));
 assert.ok(stopped().resources.every(r=>r.duration_ms===r.resets_at-r.anchor_at));
 await f.reopen();f.clock.at=B-1;await f.pace.candidate.probeHeld();
 assert.deepEqual(stopped().resources,before.resources);assert.equal(stopped().late_ack_unresolved,true);
 if(repeat){
  out=await f.pace.adapter.deliver({...event,event_id:'fresh-repeat',at:B-1,observed_at:B-1});
  assert.equal(out.applied,false,'a fresh reading that does not match the ledger cannot discharge the held exposure');
  assert.equal(out.reason,'late_ack_reconciliation_mismatch');
  assert.equal(stopped().late_ack_unresolved,true,'a fresh reading cannot launder late-ack history');
  assert.deepEqual(stopped().late_ack_events.map(e=>e.event_id),before.late_ack_events.map(e=>e.event_id));
  assert.ok(stopped().late_ack_events.every(e=>e.cessation_at===C&&e.resolved_by===null),'the first verified cessation remains the bound');
  assert.deepEqual(stopped().resources,before.resources);
 }
 f.clock.at=B;await f.pace.candidate.probeHeld();
 assert.equal(stopped().pending_late_exposure,undefined);assert.equal(stopped().hold_closed,true);
 assert.ok(stopped().resources.every(r=>r.held_micro+r.unrepresented_micro===0));
 assert.deepEqual(stopped().late_ack_events.map(e=>e.event_id),before.late_ack_events.map(e=>e.event_id),'settlement keeps the audit trail');
 await f.reopen();assert.equal(stopped().hold_closed,true);
});


test('warm late-ack history retains stale cessation through R until C plus duration',async t=>{
 let state=reserved();state=apply(state,'late_ack',2000);
 const C=17939999;
 state=apply(state,'cleanup_proven',C,{event_id:'root:cleanup-proven:warm-late',cleanup_removed:true});
 const initial=structuredClone(state.attempts[0]);
 const f=await runtime(t,state,C),resource=initial.resources.find(r=>r.kind==='short');
 assert.ok(C<resource.resets_at-60000);
 const B=Math.max(resource.resets_at,C+resource.duration_ms);
 assert.ok(B>resource.resets_at);
 const proof={type:'cessation_proven',event_id:'warm-stale',attempt_id:'root',at:C,observed_at:C-180000,
  authoritative_cessation:true,usage_reconciled:true,complete:true,compatible:true,refresh_succeeded:true,
  resources:initial.resources.map(r=>({...r,used_micro:r.baseline_used_micro}))};
 const stale=await f.pace.adapter.deliver(proof);
 assert.equal(stale.applied,false);assert.equal(stale.reason,'late_ack_reconciliation_incomplete');
 assert.equal((await f.pace.adapter.deliver({type:'cessation_proven',event_id:'warm-stale-bare',attempt_id:'root',at:C,
  authoritative_cessation:true})).applied,true);
 await f.reopen();
 for(const at of [resource.resets_at,B-1]){
  f.clock.at=at;await f.pace.candidate.probeHeld();
  assert.deepEqual(f.pace.adapter.state().attempts[0].resources,initial.resources,'stale readings cannot release before the late-ack bound');
  assert.equal(f.pace.adapter.state().attempts[0].late_ack_unresolved,true);
 }
 f.clock.at=B;await f.pace.candidate.probeHeld();
 assert.equal(f.pace.adapter.state().attempts[0].resources.find(r=>r.id===resource.id).held_micro,0);
 assert.ok(f.pace.adapter.state().attempts[0].late_ack_events.some(e=>e.event_id===initial.late_ack_events[0].event_id));
 await f.reopen();
 const remaining=f.pace.adapter.state().attempts[0].resources.find(r=>r.kind==='weekly');
 f.clock.at=Math.max(remaining.resets_at,C+remaining.duration_ms);await f.pace.candidate.probeHeld();
 assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
});
