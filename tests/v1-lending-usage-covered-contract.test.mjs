import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../lib/v1/lending-policy.mjs';
import {ordinaryInput,request,ACCOUNT,WEEK,NOW,MICRO} from './helpers/pace50-fixtures.mjs';

function fixture() {
 const input=ordinaryInput({now:NOW});input.state=policy.createEstimatedPace50State({account:ACCOUNT,account_week_id:WEEK});
 input.request=request({provider:'claude',model:'claude-sonnet-5-5'});
 input.objective.job.requestedUsdMicro=input.request.requested_usd_micro;
 const quote=policy.evaluateEstimatedPace50(input);assert.equal(quote.admitted,true,quote.reason);
 let state=quote.proposed_state;
 for(const event of [{type:'launch_result',event_id:'start',result:'started'},
  {type:'cleanup_proven',event_id:'attempt-1:cleanup-proven:vm',cleanup_removed:true}]) {
  const out=policy.transitionEstimatedPace50State(state,{...event,at:NOW,attempt_id:'attempt-1'});
  assert.equal(out.applied,true,out.reason);state=out.state;
 }
 const attempt=state.attempts[0];
 const event={type:'usage_covered',event_id:'covered',attempt_id:attempt.id,at:NOW+120000,observed_at:NOW+120000,
  account:ACCOUNT,account_week_id:WEEK,epoch:attempt.epoch,complete:true,compatible:true,refresh_succeeded:true,
  resources:attempt.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,used_micro:r.baseline_used_micro+MICRO}))};
 return {state,attempt,event};
}

test('usage coverage is off without a measured posting bound',()=>{
 const {state,attempt,event}=fixture();
 const out=policy.transitionEstimatedPace50State(state,event);
 assert.equal(out.applied,false);
 assert.deepEqual(out.state.attempts[0].resources,attempt.resources);
});

test('measured usage coverage charges whole growth plus a step and conserves the reservation',()=>{
 const {state,attempt,event}=fixture();
 const out=policy.transitionEstimatedPace50State(state,event,{postingLagBoundMs:120000});
 assert.equal(out.applied,true,out.reason);
 for(const r of out.state.attempts[0].resources){
  const before=attempt.resources.find(old=>old.id===r.id);
  assert.equal(r.spent_micro,2*MICRO);
  assert.equal(r.unrepresented_micro,MICRO);
  assert.equal(r.held_micro,0);
  assert.equal(r.released_micro,Math.max(0,before.held_micro-2*MICRO));
  assert.equal(r.initial_micro,r.spent_micro+r.settled_micro+r.held_micro+r.released_micro);
 }
});

for(const [name,mutate] of [
 ['before posting finality',f=>{f.event.observed_at--;}],
 ['regressed meter',f=>{f.event.resources[0].used_micro=f.attempt.resources[0].baseline_used_micro-1;}],
 ['wrong scope',f=>{f.event.resources[0].instance='another-instance';}],
 ['cold source',f=>{f.attempt.resources[0].cold_open=true;}],
 ['rewritten scope',f=>{f.event.scope_rewritten=true;}],
])test(`usage coverage retains ${name}`,()=>{
 const f=fixture();mutate(f);
 const r=f.attempt.resources[0];
 const decision=policy.settlementEligibility(f.attempt,r,{state:f.state,evidence:f.event,at:f.event.at,postingLagBoundMs:120000});
 assert.equal(decision.reason,'retain');
});

test('a later final-scope reading represents the retained step without charging finished work again',()=>{
 const {state,event}=fixture();
 let out=policy.transitionEstimatedPace50State(state,event,{postingLagBoundMs:120000});assert.equal(out.applied,true);
 const before=out.state.attempts[0];
 const later={...event,type:'usage_represented',event_id:'later-representation',at:event.at+1000,observed_at:event.at+1000,
  resources:event.resources.map(r=>({...r,used_micro:r.used_micro+MICRO}))};
 out=policy.transitionEstimatedPace50State(out.state,later,{postingLagBoundMs:120000});assert.equal(out.applied,true,out.reason);
 for(const r of out.state.attempts[0].resources){
  assert.equal(r.spent_micro,before.resources.find(old=>old.id===r.id).spent_micro);
  assert.equal(r.unrepresented_micro,0);
 }
});

test('authoritative cessation records a stopped tree without refunding unreconciled protection',()=>{
 const {state}=fixture();
 const attempt=state.attempts[0];
 attempt.cleanup_proven=false;attempt.cleanup_proof_persisted_at=null;
 attempt.process_state='running';attempt.cessation_proven=false;
 const before=structuredClone(attempt.resources);
 const out=policy.transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'authoritative-without-usage',
  at:NOW+1000,attempt_id:attempt.id,authoritative_cessation:true,usage_reconciled:false});
 assert.equal(out.applied,true,out.reason);
 const stopped=out.state.attempts[0];
 assert.equal(stopped.process_state,'ceased');
 assert.equal(stopped.cessation_proven,true);
 assert.equal(stopped.hold_closed,false);
 assert.equal(stopped.cleanup_proven,false);
 assert.equal(stopped.cleanup_proof_persisted_at,null);
 assert.deepEqual(stopped.resources,before);
 assert.equal(policy.durableCessationBound(stopped,{state:out.state}),NOW+1000);
});

test('an old fully charged ledger still receives the additive floor on its first final reading',()=>{
 const {state,attempt,event}=fixture();
 for(const r of attempt.resources){
  r.spent_micro=r.held_micro;r.held_micro=0;r.unrepresented_micro=r.spent_micro;
  r.burns=[{id:'old-unrepresented',at:NOW,amount_micro:r.spent_micro,represented:false}];
 }
 const out=policy.transitionEstimatedPace50State(state,{...event,type:'native_meter_settled'}, {postingLagBoundMs:120000});
 assert.equal(out.applied,true,out.reason);
 for(const r of out.state.attempts[0].resources){
  assert.equal(r.spent_micro,Math.max(attempt.resources.find(old=>old.id===r.id).spent_micro,2*MICRO));
  assert.equal(r.usage_covered_at,event.observed_at);
  assert.equal(r.unrepresented_micro,MICRO,'a final converted reading retains its reporting step');
 }
});

test('overlapping whole-delta charges cannot represent more than the shared meter shows',()=>{
 const {state,event}=fixture();
 const second=structuredClone(state.attempts[0]);second.id='second';
 state.attempts.push(second);state.event_ids.push('second:cleanup-proven:vm');state.revision++;
 let out=policy.transitionEstimatedPace50State(state,event,{postingLagBoundMs:120000});assert.equal(out.applied,true);
 out=policy.transitionEstimatedPace50State(out.state,{...event,event_id:'second-covered',attempt_id:'second'}, {postingLagBoundMs:120000});
 assert.equal(out.applied,true,out.reason);
 for(const resource of state.attempts[0].resources){
  const rows=out.state.attempts.flatMap(a=>a.resources.filter(r=>r.id===resource.id));
  assert.ok(rows.every(r=>r.spent_micro===2*MICRO),'every overlapping attempt pays the whole delta plus a step');
  assert.equal(rows.reduce((sum,r)=>sum+r.spent_micro-r.unrepresented_micro,0),MICRO,
   'the shared one-point rise represents at most one point of the conservative charges');
 }
});

test('verified VM cleanup can follow an authoritative cessation while its financial hold remains open',()=>{
 const {state}=fixture();const attempt=state.attempts[0];
 attempt.cleanup_proven=false;attempt.cleanup_proof_persisted_at=null;attempt.process_state='running';attempt.cessation_proven=false;
 let out=policy.transitionEstimatedPace50State(state,{type:'cessation_proven',event_id:'stopped-first',at:NOW+1,
  attempt_id:attempt.id,authoritative_cessation:true});assert.equal(out.applied,true);
 const before=structuredClone(out.state.attempts[0].resources);
 out=policy.transitionEstimatedPace50State(out.state,{type:'cleanup_proven',event_id:`${attempt.id}:cleanup-proven:later-vm`,
  at:NOW+2,attempt_id:attempt.id,cleanup_removed:true});
 assert.equal(out.applied,true,out.reason);
 assert.equal(out.state.attempts[0].cleanup_proof_persisted_at,NOW+2);
 assert.deepEqual(out.state.attempts[0].resources,before);
});
