import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// A late start is a run that began after its window's closure deadline, and its usage is unreported. It may have run in the window
// that covers the start, which is a new window instance. That window carries the run's maximum exposure as unrepresented usage,
// until that window resets. Aggregate growth alone does not prove that it covers the late start. No admission is refused for the
// late start: the carried exposure lowers what is left instead.
const HAIKU = 'claude-haiku-5-5';
const HOUR = 3600000;
const SHORT_RESET = NOW + SYNTHETIC_RESET.short;
const NEXT_SHORT_RESET = SHORT_RESET + 5 * HOUR;
const job = {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}},
  expires_at: new Date(NOW + 7 * 86400e3).toISOString()};

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'late-carry-'));
  const clock = {at: NOW};
  const covering = {usedMicro: 17.5 * MICRO};
  // After the first short window ends, the window that covers the late start is a new instance.
  // The objective uses that window's current meter plus the carried held exposure.
  const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: MICRO / 20, short: MICRO / 5}, used: {weekly: 20 * MICRO, short: 0},
    override: ({base, now}) => ({...base, resources: base.resources.map((r) => (r.kind === 'short' && now >= SHORT_RESET
      ? {...r, instance: 'synthetic-short-2', anchor_at: SHORT_RESET, resets_at: NEXT_SHORT_RESET, used_micro: covering.usedMicro}
      : r))})});
  const pace = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source});
  const f = {...pace, clock, source, directory, covering};
  t.after(async () => {
    await f.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return f;
}

const reserve = (f, id) => f.candidate.reserve({attemptId: id, jobId: id, provider: 'claude', model: HAIKU, job,
  automatic: true, ownerAbsent: true});
const attempt = (f, id) => f.adapter.state().attempts.find((a) => a.id === id);
// The exposure carried into the covering window is a separate record, named for the run it came from.
const carried = (f, id) => f.adapter.state().attempts.find((a) => a.id.startsWith(`${id}:carry:`));

// The first run is admitted before the first short window ends. Its start is three hours into the next window, and it reports nothing.
async function lateRun(f) {
  assert.equal((await reserve(f, 'a')).ok, true);
  f.clock.at = SHORT_RESET + 3 * HOUR;
  await f.candidate.started('a', {ok: true});
  assert.equal(attempt(f, 'a').late_ack_unresolved, true, 'the start is late');
  await f.candidate.finish({attemptId: 'a', provider: 'claude', model: HAIKU, execution: {stdout: '', lending_meter: null}});
  await f.candidate.recordCleanup('a',{removed:true});
}

test('late-start exposure is committed against the covering window before the objective request is reserved', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await lateRun(f);
  const maximum = attempt(f, 'a').resources.find((r) => r.id === 'five_hour').initial_micro;
  const carry = carried(f, 'a').resources.find((r) => r.kind === 'short');
  assert.equal(carry.unrepresented_micro, maximum, 'the covering window carries the full unresolved exposure');
  const next = await reserve(f, 'b');
  assert.equal(next.ok, true, `the late start does not refuse admission: ${JSON.stringify(next)}`);
  const newWindow = attempt(f, 'b').resources.find((r) => r.id === 'five_hour');
  assert.equal(newWindow.initial_micro, 2 * MICRO, 'the current $10 request is sized by the objective rule');
  assert.ok(newWindow.baseline_used_micro + carry.unrepresented_micro + newWindow.initial_micro <= 100 * MICRO,
    'meter usage, carried exposure and the new objective reservation stay within physical window capacity');
});

test('a covering aggregate rise does not clear the late start\'s carried exposure', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await lateRun(f);
  const maximum = attempt(f, 'a').resources.find((r) => r.id === 'five_hour').initial_micro;
  assert.equal(carried(f, 'a').resources[0].unrepresented_micro, maximum, 'the maximum is carried as unrepresented usage');
  // The window's aggregate rises by the maximum, but it has no interval coverage for this run.
  f.covering.usedMicro += maximum;
  f.clock.at += 120000;
  await f.candidate.probeHeld();
  f.covering.usedMicro+=MICRO;f.clock.at++;
  await f.candidate.probeHeld();
  const after = carried(f, 'a');
  assert.notEqual(after.hold_closed, true, 'aggregate growth does not close the carried exposure');
  assert.equal(after.resources[0].unrepresented_micro, maximum, 'the full late exposure stays unrepresented');
  assert.equal(after.resources[0].released_micro, 0, 'no exposure is released without interval coverage or reset');
});

test('the carried exposure settles as spent when its window resets, once the sandbox is proven gone', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await lateRun(f);
  const owner=attempt(f,'a'),resource=carried(f,'a').resources[0];
  f.clock.at=Math.max(NEXT_SHORT_RESET,owner.cleanup_proof_persisted_at+resource.duration_ms)+1000;
  await f.candidate.probeHeld();
  const after = carried(f, 'a');
  assert.equal(after.process_state, 'ceased', 'the covering window\'s reset closes the carried exposure');
  const maximum = attempt(f, 'a').resources.find((r) => r.id === 'five_hour').initial_micro;
  assert.equal(after.resources[0].spent_micro, maximum, 'the maximum is charged as spent');
  assert.equal(after.resources[0].unrepresented_micro, 0);
  assert.equal(after.resources[0].held_micro, 0);
});
