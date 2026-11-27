import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
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

function setup(t,{short=true,postingLagBoundMs=120000}={}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'reconcile-held-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: POINT / 5, short: POINT / 5},
    override: ({base}) => ({...base, resources: base.resources.filter((r) => short || r.kind !== 'short')})});
  const pace = createPace50Candidate({postingLagBoundMs,directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source});
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
async function lend(f, {ownerAbsentBefore = true} = {}) {
  if (ownerAbsentBefore) {
    await f.pace.adapter.transition({type: 'owner_absent', event_id: 'owner-absent-1', at: NOW, confirmed: true}, {expectedRevision: 0});
  }
  const grant = await f.pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await f.pace.candidate.started('attempt-1', {ok: true});
  const finished = await f.pace.candidate.finish({attemptId: 'attempt-1', provider: 'claude', model: HAIKU,
    execution: {stdout: '', lending_meter: null}});
  assert.equal(finished.cessation.reason, 'usage_unknown');
}

test('a whole-point movement the owner-absent attempt owns is attributed, and the attempt closes once its sandbox is proven gone', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false});
  await lend(f);
  const initial = initialOf(f);
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at=NOW+120000;
  burnOnMeter(f, POINT);
  await f.pace.candidate.probeHeld();
  burnOnMeter(f,POINT);f.clock.at++;await f.pace.candidate.probeHeld();
  const after=attemptOf(f);
  assert.equal(after.process_state, 'ceased', 'the attributed attempt closes');
  for (const r of after.resources) {
    assert.equal(r.spent_micro,2*POINT,`${r.id}: whole growth plus one reporting quantum is charged`);
    assert.equal(r.held_micro, 0, `${r.id}: no hold remains`);
    assert.equal(r.unrepresented_micro, 0, `${r.id}: the burn is represented`);
    assert.equal(r.released_micro, Math.max(0,initial[r.id]-2*POINT), `${r.id}: the unused hold is released only after the burn is proven`);
  }
});
