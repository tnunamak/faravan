import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// The provider meter is one aggregate per window instance. Two live runs on the same window are two burns in one meter. A reading
// cannot show which run's exposure it covers. A fresh aggregate rise leaves the burn unresolved until a reset settles it.
const HAIKU = 'claude-haiku-5-5';
const job = {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'shared-aggregate-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, used: {weekly: 48.5 * MICRO, short: 40 * MICRO}});
  const pace = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const attempt = (id) => pace.adapter.state().attempts.find((a) => a.id === id);
  return {pace, source, clock, attempt};
}

test('a later aggregate reading leaves two overlapping burns unresolved without interval coverage', {timeout: 30000}, async (t) => {
  const f = setup(t);
  for (const id of ['a', 'b']) {
    const grant = await f.pace.candidate.reserve({attemptId: id, jobId: id, provider: 'claude', model: HAIKU, job,
      automatic: true, ownerAbsent: true});
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await f.pace.candidate.started(id, {ok: true});
  }
  for (const id of ['a', 'b']) {
    f.clock.at += 1000;
    f.pace.candidate.recordCleanup(id, {removed: true});
    await f.pace.candidate.finish({attemptId: id, provider: 'claude', model: HAIKU, execution: {stdout: '', lending_meter: {cost_usd: 4, final: true}}});
  }
  const pending = () => ['a', 'b'].map((id) => f.attempt(id).resources.find((r) => r.id === 'seven_day').unrepresented_micro);
  assert.deepEqual(pending(), [0.2 * MICRO, 0.2 * MICRO], 'both burns are pending: the meter has not shown them yet');
  // The provider catches up with both runs. The aggregate is now the baseline plus both burns.
  f.source.state.used.weekly += 0.4 * MICRO;
  f.source.state.used.short += 1.6 * MICRO;
  f.clock.at += 60000;
  await f.pace.candidate.probeHeld();
  assert.deepEqual(pending(), [0.2 * MICRO, 0.2 * MICRO], 'the aggregate rise cannot represent either run');
  assert.deepEqual(['a', 'b'].map((id) => f.attempt(id).hold_closed), [false, false]);
  assert.deepEqual(['a', 'b'].map((id) => f.attempt(id).resources.find((r) => r.id === 'seven_day').released_micro),
    [0, 0], 'neither unresolved exposure is released');
});
