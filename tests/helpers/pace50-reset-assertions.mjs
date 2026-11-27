import assert from 'node:assert/strict';
import {windowResetSettlementEvent} from '../../lib/v1/lender-pace50.mjs';

export const exposure = attempt => attempt.resources.map(r => r.held_micro + r.unrepresented_micro);

// Mirror settleOrClose's reset event, one boundary at a time, so a short reset cannot hide weekly release.
export async function settleOwnResets(adapter, id, {reading} = {}) {
  const row = () => adapter.state().attempts.find(a => a.id === id);
  assert.notEqual(row().hold_closed, true);
  const resets = [...new Set(row().resources.filter(r => r.held_micro + r.unrepresented_micro > 0).map(r => r.resets_at))].sort((a,b) => a-b);
  for (const reset of resets) {
    const before = adapter.state(), attempt = row();
    const at=Math.max(reset,before.updated_at);
    const ids = attempt.resources.filter(r => r.resets_at <= at && r.held_micro + r.unrepresented_micro > 0).map(r => r.id);
    if(!ids.length)continue;
    const event = windowResetSettlementEvent({attempt,resourceIds:ids,at:reset,clockAt:reset,
      updatedAt:before.updated_at,reading});
    if (before.updated_at < reset) {
      const earlyEvent=windowResetSettlementEvent({attempt,resourceIds:ids,at:reset-1,clockAt:reset-1,
        updatedAt:before.updated_at,reading});
      const early = await adapter.transition(earlyEvent, {expectedRevision:before.revision});
      assert.equal(early.applied,false);
      assert.equal(early.reason,'window_not_reset');
      assert.deepEqual(adapter.state(),before,'before its own reset every ledger remains unchanged');
    }
    const out = await adapter.transition(event,{expectedRevision:before.revision});
    assert.equal(out.applied,true,out.reason);
    for (const r of row().resources) {
      const old = attempt.resources.find(x => x.id === r.id);
      assert.equal(r.held_micro+r.unrepresented_micro, ids.includes(r.id) ? 0 : old.held_micro+old.unrepresented_micro,
        `${r.id}: only its own reset removes exposure`);
    }
    if (row().resources.some(r => r.held_micro+r.unrepresented_micro > 0)) assert.notEqual(row().hold_closed,true);
  }
  assert.equal(row().hold_closed,true);
  assert.ok(exposure(row()).every(n => n === 0));
}

// A normal quote reports held reservations; if they exhaust capacity, excluding this attempt must restore admission.
export async function assertAdmissionCounts(adapter, id, request) {
  const state=adapter.state();
  const normal=await adapter.preview({request});
  if (normal.admitted) {
    for (const r of state.attempts.find(a=>a.id===id).resources) {
      const quoted=normal.windows.find(w=>w.id===r.id);
      assert.ok(quoted,`${r.id}: the admission quote includes the reserved resource`);
      assert.equal(quoted.held_micro,state.attempts.flatMap(a=>a.resources).filter(x=>x.id===r.id&&x.instance===r.instance&&x.resets_at===r.resets_at).reduce((n,x)=>n+x.held_micro,0));
      const scope=state.attempts.flatMap(a=>a.resources).filter(x=>x.id===r.id&&x.instance===r.instance&&x.epoch===r.epoch&&x.anchor_at===r.anchor_at&&x.resets_at===r.resets_at);
      const used=normal.inputs.windows.find(w=>w.id===r.id).usedMicro;
      assert.equal(quoted.slack_micro,100_000_000-used-scope.reduce((n,x)=>n+x.held_micro+x.unrepresented_micro,0),
        'admission subtracts held and unrepresented exposure from physical headroom');
      assert.ok(quoted.held_micro>0,'the reservation reduces admission headroom');
    }
  } else {
    assert.ok(['owner_reserve','native_attempt_in_flight','budget_too_small'].includes(normal.reason),normal.reason);
    const without=await adapter.preview({request,replacingAttemptId:id});
    assert.equal(without.admitted,true,'removing only the held attempt restores capacity');
  }
  assert.deepEqual(adapter.state(),state,'admission accounting never changes the held state');
}
