import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {NATIVE_SETTLEMENT_DELAY_MS} from '../lib/v1/lending-policy.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// A run that reports no usage holds its exposure. The provider meter reconciles it. A whole-point movement the attempt owns is
// attributed, and the attempt closes once its sandbox is proven gone. Anything else stays held. At a window's reset, with cleanup
// proven, the attempt settles in full as charged. No reading ever counts the hold as zero. Synthetic trusted evidence only.
//
// The admitted quote holds one whole point per window at this rate. A short window the owner opened is admissible, and a short
// window lending opened is not (the candidate offers no quiet opening), so the owner-origin short window is the configuration here.
const HAIKU = 'claude-haiku-5-5';
const SHORT_RESET = NOW + SYNTHETIC_RESET.short;
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};
const POINT = MICRO;

function setup(t, {short = true} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'reconcile-held-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: POINT / 5, short: POINT / 5},
    override: ({base}) => ({...base, resources: base.resources.filter((r) => short || r.kind !== 'short')})});
  const pace = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {pace, source, clock};
}

const attemptOf = (f) => f.pace.adapter.state().attempts.find((a) => a.id === 'attempt-1');
const resource = (f, id) => attemptOf(f).resources.find((r) => r.id === id);
const initialOf = (f) => Object.fromEntries(attemptOf(f).resources.map((r) => [r.id, r.initial_micro]));
// Moves the meter the way the attempt's own use would, on both windows, by the given amount in micro-points.
const burnOnMeter = (f, micro) => { f.source.state.used.weekly += micro; f.source.state.used.short += micro; };

// One lend that starts and reports nothing: no stream usage and no guard reading. Owner absence is recorded before admission
// unless the test says otherwise.
async function lend(f, {ownerAbsentBefore = true, execution = {stdout: '', lending_meter: null}} = {}) {
  if (ownerAbsentBefore) {
    await f.pace.adapter.transition({type: 'owner_absent', event_id: 'owner-absent-1', at: NOW, confirmed: true}, {expectedRevision: 0});
  }
  const grant = await f.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await f.pace.candidate.started('attempt-1', {ok: true});
  const finished = await f.pace.candidate.finish({attemptId: 'attempt-1', provider: 'claude', model: HAIKU,
    execution});
  if (execution.lending_meter === null) assert.equal(finished.cessation.reason, 'usage_unknown');
}

test('a run with no usage reading stays held, and neither a sub-point movement nor a clean sandbox counts it as zero', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false});
  await lend(f);
  const initial = initialOf(f);
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  // Half a point on each window: below the meter's resolution, so it is not evidence of a burn.
  burnOnMeter(f, POINT / 2);
  await f.pace.candidate.probeHeld();
  const after = attemptOf(f);
  assert.notEqual(after.hold_closed, true, 'the exposure is not closed on a sub-point movement');
  for (const r of after.resources) {
    assert.equal(r.spent_micro, 0, `${r.id}: nothing is charged as spent`);
    assert.equal(r.released_micro, 0, `${r.id}: nothing is released`);
    assert.equal(r.held_micro, initial[r.id], `${r.id}: the whole hold stays held`);
  }
});

test('a whole-point movement is recorded but cannot release the remaining unknown exposure', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false});
  await lend(f);
  const initial = initialOf(f);
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();
  const after = attemptOf(f);
  assert.equal(after.process_state, 'ceased', 'cleanup proves the process is gone');
  assert.equal(after.hold_closed, false, 'a partial rise does not cover the full held envelope');
  for (const r of after.resources) {
    assert.equal(r.spent_micro, POINT, `${r.id}: the meter's whole-point movement is the burn`);
    assert.equal(r.held_micro, initial[r.id] - POINT, `${r.id}: the rest stays held`);
    assert.equal(r.unrepresented_micro, POINT, `${r.id}: the shown burn stays unresolved without interval coverage`);
    assert.equal(r.held_micro + r.unrepresented_micro, initial[r.id], `${r.id}: the full exposure stays in admission accounting`);
    assert.equal(r.released_micro, 0, `${r.id}: no unresolved exposure is released`);
  }
});

test('a partial meter rise after cleanup does not release the rest of unknown converted use', {timeout: 30000}, async t => {
  const f = setup(t, {short: false});
  await lend(f);
  const initial = initialOf(f).seven_day;
  assert.ok(initial > POINT, 'the held exposure spans more than one meter step');
  await f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + NATIVE_SETTLEMENT_DELAY_MS;
  assert.ok(f.clock.at >= attemptOf(f).cleanup_proof_persisted_at + NATIVE_SETTLEMENT_DELAY_MS);
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();

  const after = resource(f, 'seven_day');
  assert.ok(after.held_micro > 0 || after.unrepresented_micro >= initial,
    'the one-point rise is not proof that it covers the full unknown job usage');
  assert.equal(attemptOf(f).hold_closed, false);
  assert.equal(after.held_micro + after.unrepresented_micro, initial,
    'the partial rise does not reduce the original exposure');
  assert.equal(after.released_micro, 0);
});

test('a tiny positive job report and a delayed meter rise do not bound converted exposure', {timeout: 30000}, async t => {
  const f = setup(t, {short: false});
  await lend(f, {execution:{stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.0000004})}});
  const initial = initialOf(f).seven_day;
  await f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + NATIVE_SETTLEMENT_DELAY_MS;
  assert.ok(f.clock.at >= attemptOf(f).cleanup_proof_persisted_at + NATIVE_SETTLEMENT_DELAY_MS);
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();

  const attempt = attemptOf(f), after = resource(f, 'seven_day');
  assert.equal(attempt.hold_closed, false, 'the small final total cannot bound the whole job');
  assert.ok(after.spent_micro > 0, 'the delayed meter rise may be recorded as spend');
  assert.ok(after.held_micro > 0, 'the residual envelope stays held');
  assert.equal(after.released_micro, 0, 'the remainder is not released');
  assert.equal(after.initial_micro, after.spent_micro + after.settled_micro + after.held_micro + after.released_micro,
    'accounting conserves the original envelope');
  assert.equal(after.held_micro + after.unrepresented_micro, initial,
    'reported cost and a one-point rise do not reduce unresolved exposure');
});

test('control: the same movement stays held when no owner absence was recorded before admission', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false});
  await lend(f, {ownerAbsentBefore: false});
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();
  assert.notEqual(attemptOf(f).hold_closed, true, 'an unrecorded owner absence attributes nothing');
  assert.equal(resource(f, 'seven_day').spent_micro, 0);
  assert.ok(resource(f, 'seven_day').held_micro > 0);
});

test('control: a short window the owner opened is never attributed to the attempt, even with the owner absent', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await lend(f);
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();
  assert.notEqual(attemptOf(f).hold_closed, true, 'the owner\'s short window is not this attempt\'s burn');
  assert.equal(resource(f, 'five_hour').spent_micro, 0);
  assert.equal(resource(f, 'seven_day').spent_micro, 0, 'the attempt is attributed whole or not at all');
});

test('a movement above the hold is not attributed: other use moved the window past the reservation', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false});
  await lend(f);
  const hold = resource(f, 'seven_day').held_micro;
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  f.source.state.used.weekly += hold + POINT;
  await f.pace.candidate.probeHeld();
  assert.notEqual(attemptOf(f).hold_closed, true);
  assert.equal(resource(f, 'seven_day').spent_micro, 0, 'the overrun is not charged to the hold');
  assert.equal(resource(f, 'seven_day').held_micro, hold, 'the hold stays as reserved');
});

test('a short-window reset spends but does not release the still-open weekly exposure', {timeout: 30000}, async (t) => {
  // The short instance settles. The open weekly hold moves to spend, but remains unrepresented until that window resets.
  const f = setup(t);
  await lend(f);
  const initial = initialOf(f);
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = SHORT_RESET + 1000;
  await f.pace.candidate.probeHeld();
  const short = attemptOf(f).resources.find((r) => r.id === 'five_hour');
  assert.equal(short.spent_micro, initial.five_hour, 'the reset window is charged in full, as spent');
  assert.equal(short.held_micro, 0, 'the reset window holds nothing');
  assert.ok(short.burns.every((b) => b.represented), 'every burn on the reset window is represented');
  const weekly = attemptOf(f).resources.find((r) => r.id === 'seven_day');
  assert.equal(weekly.spent_micro, initial.seven_day, 'window_reset_settled charges the open weekly hold as spend');
  assert.equal(weekly.held_micro, 0, 'the weekly amount is no longer in held_micro');
  assert.equal(weekly.unrepresented_micro, initial.seven_day, 'the same weekly exposure stays unrepresented');
  assert.equal(weekly.released_micro, 0, 'the short reset releases none of the weekly envelope');
  assert.equal(weekly.held_micro + weekly.unrepresented_micro, initial.seven_day,
    'the original weekly exposure remains in admission accounting');
  assert.notEqual(attemptOf(f).hold_closed, true, 'the attempt stays open while its open window carries uncertainty');
  f.clock.at = NOW + SYNTHETIC_RESET.weekly + 1000;
  await f.pace.candidate.probeHeld();
  const after = attemptOf(f);
  assert.equal(after.process_state, 'ceased', 'the weekly reset closes the attempt');
  for (const r of after.resources) {
    assert.equal(r.spent_micro, initial[r.id], `${r.id}: the whole hold is charged, as spent`);
    assert.equal(r.settled_micro, 0, `${r.id}: no recovery record backs a settlement`);
    assert.ok(r.burns.every((b) => b.represented), `${r.id}: every burn is represented`);
    assert.equal(r.held_micro, 0, `${r.id}: no hold remains`);
    assert.equal(r.unrepresented_micro, 0, `${r.id}: nothing stays unrepresented`);
    assert.equal(r.released_micro, 0, `${r.id}: nothing is released as zero`);
  }
});
test('without the sandbox cleanup proof, nothing settles at the window reset', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await lend(f);
  const initial = initialOf(f);
  f.clock.at = SHORT_RESET + 1000;
  await f.pace.candidate.probeHeld();
  const after = attemptOf(f);
  assert.notEqual(after.hold_closed, true, 'an unproven sandbox is not closed');
  for (const r of after.resources) {
    assert.equal(r.spent_micro, 0, `${r.id}: nothing is charged without the cleanup proof`);
    assert.equal(r.held_micro, initial[r.id], `${r.id}: the hold stays`);
  }
});

for(const started of [false,true])test(`legacy cleanup charges the full native hold (started=${started})`,async t=>{
  const f=setup(t,{short:false});
  await f.pace.adapter.transition({type:'owner_absent',event_id:'legacy-owner-absent',at:NOW,confirmed:true},{expectedRevision:0});
  const grant=await f.pace.candidate.reserve({attemptId:'attempt-1',jobId:'job-1',provider:'claude',model:HAIKU,job,automatic:true,ownerAbsent:true});
  assert.equal(grant.ok,true,JSON.stringify(grant));
  if(started)await f.pace.candidate.started('attempt-1',{ok:true});
  await f.pace.candidate.recordCleanup('attempt-1',{removed:true});
  const out=await f.pace.candidate.settle('attempt-1',{provider:'claude',model:HAIKU,execution:{stdout:'',lending_meter:{used_units:0}},fullCharge:true});
  assert.equal(out.applied,true,JSON.stringify(out));
  for(const resource of attemptOf(f).resources){assert.equal(resource.spent_micro+resource.settled_micro,resource.initial_micro);assert.equal(resource.held_micro,0);assert.equal(resource.released_micro,0);}
  await f.pace.candidate.probeHeld();
  for(const resource of attemptOf(f).resources)assert.equal(resource.released_micro,0,'a later meter must not discount a legacy full charge');
});
