import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createPace50Candidate} from '../../lib/v1/lender-pace50.mjs';
import {settlementEligibility} from '../../lib/v1/lending-policy.mjs';

// Call after the app releases its store lock. Run the real held sweep with an injected clock;
// a coordinator result and a zero-use report never manufacture cessation evidence here.
export async function settleDurableAtBound({home,source,postingLagBoundMs}) {
 const directory=join(home,'v1');
 const saved=JSON.parse(fs.readFileSync(join(directory,'lending-pace50-state.json'),'utf8'));
 const bounds=saved.attempts.flatMap(attempt=>attempt.resources.filter(r=>r.held_micro+r.unrepresented_micro>0)
  .map(resource=>settlementEligibility(attempt,resource,{state:saved,at:saved.updated_at}).nextEligibleAt));
 assert.ok(bounds.every(bound=>bound!==null),'every retained resource needs verified cessation before its test clock advances');
 const at=Math.max(saved.updated_at,...bounds.map(Number));
 const pace=createPace50Candidate({directory,source,postingLagBoundMs,account:saved.account,account_week_id:saved.account_week_id,now:()=>at,
  nativeGuard:{setTimer:()=>0,clearTimer:()=>{}},effectOverrides:{arm_cessation_deadline:async()=>()=>{}}});
 try {
  for(let pass=0;pass<=saved.attempts.length;pass++)await pace.candidate.probeHeld();
  const state=pace.adapter.state();
  assert.ok(state.attempts.every(row=>row.resources.every(r=>r.held_micro+r.unrepresented_micro===0)),'the deadline releases every retained resource');
  return state;
 } finally {await pace.candidate.cancelObservations();await pace.adapter.close();}
}

export async function settleAdapterAtBound(adapter,setClock) {
 const saved=adapter.state();
 const bounds=saved.attempts.flatMap(attempt=>attempt.resources.filter(r=>r.held_micro+r.unrepresented_micro>0||attempt.pending_late_exposure)
  .map(resource=>settlementEligibility(attempt,resource,{state:saved,at:saved.updated_at}).nextEligibleAt));
 assert.ok(bounds.every(bound=>bound!==null),'a test cannot advance to a deadline without durable cessation');
 const at=Math.max(saved.updated_at??0,...bounds.map(Number));
 await setClock(at);
 for(const attempt of adapter.state().attempts){
  const resource_ids=attempt.resources.filter(r=>r.held_micro+r.unrepresented_micro>0||attempt.pending_late_exposure).map(r=>r.id);
  if(!resource_ids.length)continue;
  const out=await adapter.transition({type:'window_reset_settled',event_id:`${attempt.id}:fixture-bound:${adapter.state().revision}`,
   at,attempt_id:attempt.id,resource_ids,authoritative_cessation:true},{expectedRevision:adapter.state().revision});
  assert.equal(out.applied,true,out.reason);
 }
 return adapter.state();
}

export async function settlePaceAtBound(pace,setClock) {
 const saved=pace.adapter.state();
 const bounds=saved.attempts.flatMap(attempt=>attempt.resources.filter(r=>r.held_micro+r.unrepresented_micro>0||attempt.pending_late_exposure)
  .map(resource=>settlementEligibility(attempt,resource,{state:saved,at:saved.updated_at}).nextEligibleAt));
 assert.ok(bounds.every(bound=>bound!==null),'every retained resource needs durable cessation');
 await setClock(Math.max(saved.updated_at,...bounds.map(Number)));
 for(let pass=0;pass<=saved.attempts.length;pass++)await pace.candidate.probeHeld();
 assert.ok(pace.adapter.state().attempts.every(row=>row.resources.every(r=>r.held_micro+r.unrepresented_micro===0)),
  'the held sweep closes every resource at its durable bound');
 return pace.adapter.state();
}

// Synthetic identity fixtures: VM cleanup is already durable, posting lag is supplied as zero,
// and a later owner rise represents the reporting quantum. This drives public accounting events.
export async function coverStoppedFixture(adapter,id,at,used={}) {
 const attempt=adapter.state().attempts.find(a=>a.id===id);
 assert.equal(attempt.cleanup_proven,true);
 const resources=attempt.resources.map(r=>({id:r.id,instance:r.instance,anchor_at:r.anchor_at,resets_at:r.resets_at,
  used_micro:used[r.id]??r.baseline_used_micro}));
 const evidence={attempt_id:id,at,observed_at:at,account:attempt.account,account_week_id:attempt.account_week_id,
  epoch:attempt.epoch,complete:true,compatible:true,refresh_succeeded:true,resources};
 let out=await adapter.deliver({...evidence,type:'usage_covered',event_id:`${id}:fixture-final`});
 assert.equal(out.applied,true,out.reason);
 const state=adapter.state();
 const covering=resources.map(r=>({...r,used_micro:r.used_micro+state.attempts.flatMap(a=>a.resources.filter(other=>
  other.id===r.id&&other.instance===r.instance&&other.anchor_at===r.anchor_at&&other.resets_at===r.resets_at))
  .reduce((sum,other)=>sum+other.unrepresented_micro,0)}));
 out=await adapter.deliver({...evidence,resources:covering,type:'usage_represented',event_id:`${id}:fixture-represented`});
 assert.equal(out.applied,true,out.reason);
 assert.equal(adapter.state().attempts.find(a=>a.id===id).hold_closed,true);
}
