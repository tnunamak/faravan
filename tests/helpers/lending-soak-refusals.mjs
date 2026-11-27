import assert from 'node:assert/strict';
import {RESET_JITTER_MS as J} from '../../lib/v1/quota-registry.mjs';

// Independent of settlementEligibility. This fixture has no carried descendants,
// measured posting-finality bound, reset proof or durable no-dispatch stamp.
function requiredUntil(attempt,resource) {
  assert.ok(!attempt.lineage_parent_id&&!attempt.id.includes(':carry:'),'extend the refusal oracle for carried fixtures');
  const receipts=attempt.late_ack_events.filter(event=>Number.isSafeInteger(event.cessation_at)).map(event=>event.cessation_at);
  if(attempt.cleanup_proven===true&&Number.isSafeInteger(attempt.cleanup_proof_persisted_at))receipts.push(attempt.cleanup_proof_persisted_at);
  assert.ok(receipts.length>0,`${attempt.id} must have a recorded cessation to justify a finite wait`);
  const C=Math.max(...receipts);
  assert.ok(attempt.late_ack_events.every(event=>event.at<=C),`${attempt.id} has liveness after cessation`);
  const warm=!resource.cold_open&&!resource.cold_provenance&&!attempt.late_ack_events.length&&C<resource.resets_at-J;
  return warm?resource.resets_at:Math.max(resource.resets_at,C+resource.duration_ms);
}

const providerOf=id=>id.startsWith('codex:')?'codex':['five_hour','seven_day'].includes(id)?'claude':null;

export function createRefusalAudit() {
  const reasons=new Map();
  // Per named hold: how many refused quotes named it, and the last such quote's
  // time and bound. Quotes arrive in simulated-time order, so the last is the latest.
  const holds=new Map();
  let previous=null;
  const bucket=reason=>{
    if(!reasons.has(reason))reasons.set(reason,{offers:0,eligibleOffers:0,reservations:0,refusedMs:0,holdIds:new Set()});
    return reasons.get(reason);
  };
  return {
    record({kind,id,at,eligible,out,provider,state}) {
      if(kind==='offer'){
        if(previous?.eligible&&!previous.allowed)bucket(previous.reason).refusedMs+=at-previous.at;
        previous={at,eligible,allowed:out.admitted===true,reason:out.reason};
      }
      if(out.admitted===true)return;
      assert.ok(['native_attempt_in_flight','cross_window_exposure_unreconciled','resource_reset_margin'].includes(out.reason),
        `${id}: unexpected refusal ${out.reason}`);
      const windows=out.inputs?.windows??[];
      if(out.reason!=='resource_reset_margin')assert.ok(windows.length>0,`${id}: refusal must expose its assessed window geometry`);
      const blockers=state.attempts.flatMap(attempt=>attempt.resources.filter(resource=>{
        if(resource.held_micro+resource.unrepresented_micro===0&&!attempt.pending_late_exposure)return false;
        if(providerOf(resource.id)!==null&&providerOf(resource.id)!==provider)return false;
        const same=windows.some(w=>w.id===resource.id&&w.anchorAt===resource.anchor_at&&w.resetsAt===resource.resets_at);
        return out.reason==='cross_window_exposure_unreconciled'?!same:
          out.reason==='native_attempt_in_flight'?same&&resource.conversion==='native_window':true;
      }).map(resource=>({attempt,resource})));
      assert.ok(blockers.length>0,`${id}: ${out.reason} must name an open required hold`);
      const counted=bucket(out.reason);
      if(kind==='offer'){counted.offers++;if(eligible)counted.eligibleOffers++;}else counted.reservations++;
      for(const {attempt,resource} of blockers){
        const B=requiredUntil(attempt,resource);
        assert.ok(attempt.process_state!=='ceased'||attempt.hold_closed===false,
          `${id}: blocking hold ${attempt.id}/${resource.id} is open`);
        assert.ok(at<B,`${id}: ${out.reason} blocked by overdue hold ${attempt.id}/${resource.id}, at=${at}, B=${B}`);
        counted.holdIds.add(attempt.id);
        const key=`${attempt.id}/${resource.id}`,row=holds.get(key)??{refusals:0,lastAt:null,lastB:null};
        holds.set(key,{refusals:row.refusals+1,lastAt:at,lastB:B});
      }
    },
    report() {
      return Object.fromEntries([...reasons].sort(([a],[b])=>a.localeCompare(b))
        .map(([reason,row])=>[reason,{...row,holdIds:[...row.holdIds].sort()}]));
    },
    holdSummary() {
      return Object.fromEntries([...holds].sort(([a],[b])=>a.localeCompare(b)));
    },
  };
}
