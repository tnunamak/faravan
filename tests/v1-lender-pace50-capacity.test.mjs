import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// An unclosed run holds its exposure, and that exposure counts against the window's remaining capacity. It does not freeze the
// account. A later admission is granted only what is left after every hold, and a hold that leaves nothing refuses. A run that
// reported no usage is held until the provider meter settles it, and that flag must survive a restart. Synthetic evidence only.
const HAIKU = 'claude-haiku-5-5';
const POINT = MICRO;
const job = {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}},
  expires_at: new Date(NOW + 7 * 86400e3).toISOString()};

// The synthetic objective fixture requests $10: its per-window conversions reserve 0.5 weekly points and 2 short-window points.
function setup(t, {short = true, kappaWeekly = POINT / 20, weeklyUsed = 20 * POINT} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'capacity-held-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, used: {weekly: weeklyUsed, short: short ? 40 * POINT : 0},
    kappa: {weekly: kappaWeekly, short: POINT / 5},
    override: ({base}) => ({...base, resources: base.resources.filter((r) => short || r.kind !== 'short')})});
  const f = {clock, source, directory, open: () => createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT,
    account_week_id: WEEK, source})};
  f.pace = f.open();
  t.after(async () => {
    await f.pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return f;
}

const attempt = (f, id = 'attempt-1') => f.pace.adapter.state().attempts.find((a) => a.id === id);
const reserve = (f, id, model = HAIKU) => f.pace.candidate.reserve({attemptId: id, jobId: `job-${id}`, provider: 'claude',
  model, job, automatic: true, ownerAbsent: true});

// The first run: owner absent before admission, then a run that reports nothing, so its exposure is held.
async function unreportedRun(f, id = 'attempt-1') {
  if (id === 'attempt-1') {
    await f.pace.adapter.transition({type: 'owner_absent', event_id: 'owner-absent-1', at: NOW, confirmed: true}, {expectedRevision: 0});
  }
  const grant = await reserve(f, id);
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await f.pace.candidate.started(id, {ok: true});
  const finished = await f.pace.candidate.finish({attemptId: id, provider: 'claude', model: HAIKU,
    execution: {stdout: '', lending_meter: null}});
  assert.equal(finished.cessation.reason, 'usage_unknown');
}

test('an unclosed run that reported no usage does not freeze lending: a second run is admitted within what is left', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await unreportedRun(f);
  const second = await reserve(f, 'attempt-2');
  assert.equal(second.ok, true, `the account is not frozen by the held run: ${JSON.stringify(second)}`);
});

test('each held run reserves the objective request in each resource conversion', {timeout: 30000}, async (t) => {
  const f = setup(t);
  await unreportedRun(f);
  assert.equal((await reserve(f, 'attempt-2')).ok, true);
  for (const id of ['attempt-1', 'attempt-2']) {
    const resources = attempt(f, id).resources;
    assert.equal(resources.find((r) => r.id === 'five_hour').initial_micro, 2 * POINT,
      `${id}: the $10 request reserves 2 points at the synthetic short-window conversion`);
    assert.equal(resources.find((r) => r.id === 'seven_day').initial_micro, POINT / 2,
      `${id}: the same request reserves 0.5 point at the synthetic weekly conversion`);
  }
});

test('the objective holds when existing exposure consumes all remaining weekly capacity', {timeout: 30000}, async (t) => {
  // The first $10 request uses the 0.5 points of spare in the weekly window. The reading is 98.5, not 99.5, because the declared
  // whole-point unit takes one point off the spare (100 - 98.5 - 1 = 0.5). The next request has no spare under the objective rule.
  const f = setup(t, {weeklyUsed: 98.5 * POINT});
  await unreportedRun(f);
  const second = await reserve(f, 'attempt-2');
  assert.equal(second.ok, false, 'the 100-point weekly window has no uncommitted spare');
  assert.equal(attempt(f, 'attempt-2'), undefined, 'the objective hold reserved nothing');
});

test('the held run settles from the meter after a restart, because its unreported flag is durable', {timeout: 30000}, async (t) => {
  const f = setup(t, {short: false, kappaWeekly: POINT / 5});
  await unreportedRun(f);
  const file = join(f.directory, 'lending-pace50-state.json');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')).attempts.find((a) => a.id === 'attempt-1');
  assert.equal(persisted.usage_unknown, 'claude', 'the unreported flag and its provider are in the durable state');
  // Restart: the process holds no memory of the run. The lender's recovery proves the sandbox gone again.
  await f.pace.adapter.close();
  f.pace = f.open();
  f.pace.candidate.recordCleanup('attempt-1', {removed: true});
  f.clock.at = NOW + 60000;
  f.source.state.used.weekly += POINT;
  await f.pace.candidate.probeHeld();
  const after = attempt(f);
  assert.equal(after.process_state, 'ceased', 'attribution is still possible after the restart');
  assert.equal(after.resources[0].spent_micro, POINT, 'the meter\'s movement is the burn');
});
