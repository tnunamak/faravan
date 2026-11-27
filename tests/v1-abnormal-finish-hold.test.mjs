import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// An abnormal run whose total usage is not known (a nonfinal guard reading, or a streamed run with no terminal result) must keep its full
// reservation. A partial burn that is charged while the balance is released would under-charge the owner. Only a trustworthy complete final
// accounting, or the conservative window reset, may settle such a hold. usage_unknown is the durable record of that uncertainty, and it
// holds exposure only: it does not block admission.

const NOW = Date.parse('2026-10-23T06:40:00Z');
const ACCOUNT = 'synthetic-account';
const WEEK = 'synthetic-week-1';
const HAIKU = 'claude-haiku-5-5';
// 200,000 micro-points per USD on both windows. A $10 request converts to two points per window.
const KAPPA = {weekly: 200000, short: 200000};
const MOVEMENT_MICRO = 800000;
const JOB = {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 10}};
// A streamed Claude run with usage on each assistant message and no terminal result event.
const STREAM_WITHOUT_RESULT = [{type: 'system', subtype: 'init', model: HAIKU},
  {type: 'assistant', message: {id: 'msg-1', model: HAIKU, usage: {input_tokens: 1000, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, output_tokens: 500}}}].map((line) => JSON.stringify(line)).join('\n');

// The synthetic source with one addition: after the run, the test sets the provider's aggregate reading, per window, to the baseline plus
// the movement the scenario names. Until then the reading is the synthetic source's own.
function sourceWithAggregate() {
  const synthetic = createSyntheticPace50Source({start: NOW, kappa: KAPPA});
  const aggregate = {used: null};
  return {
    aggregate,
    history: synthetic.history,
    objectiveInputFor: (args) => synthetic.objectiveInputFor(args),
    async observe(args) {
      const observation = await synthetic.observe(args);
      if (!aggregate.used) return observation;
      return {...observation, resources: observation.resources.map((r) => ({...r, used_micro: aggregate.used.get(r.id)}))};
    },
    convertUsage: (args) => synthetic.convertUsage(args),
  };
}

async function admittedRun(t, execution) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'abnormal-finish-'));
  const source = sourceWithAggregate();
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source});
  // One hook, closing the adapter before its directory is removed.
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const reserved = await pace.candidate.reserve({attemptId: 'attempt-abnormal', jobId: 'job-abnormal', provider: 'claude', model: HAIKU,
    job: JOB, automatic: true, ownerAbsent: true});
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await pace.candidate.started('attempt-abnormal', {ok: true});
  pace.candidate.recordCleanup('attempt-abnormal', {removed: true});
  const attempt = () => pace.adapter.state().attempts.find((a) => a.id === 'attempt-abnormal');
  const reservedMicro = attempt().resources.map((r) => r.held_micro);
  assert.ok(reservedMicro.every((held) => held > 0), 'the run holds its exposure before it finishes');
  const out = await pace.candidate.finish({attemptId: 'attempt-abnormal', provider: 'claude', model: HAIKU, execution});
  // The fresh aggregate observation: the baseline plus the movement, read by the probe after the run.
  source.aggregate.used = new Map(attempt().resources.map((r) => [r.id, r.baseline_used_micro + MOVEMENT_MICRO]));
  await pace.candidate.probeHeld();
  return {out, attempt: attempt(), reservedMicro};
}

function assertFullHoldKept({out, attempt, reservedMicro}) {
  const released = attempt.resources.reduce((sum, r) => sum + r.released_micro, 0);
  assert.equal(released, 0, `released ${released} micro-points of a hold whose usage is unknown`);
  assert.deepEqual(attempt.resources.map((r) => r.held_micro), reservedMicro, 'the full reservation stays held');
  assert.ok(attempt.usage_unknown !== null, 'the uncertainty is durable');
  assert.equal(attempt.hold_closed, false, 'process cessation did not settle exposure with unknown usage');
  assert.ok(attempt.resources.every(r => r.held_micro > 0), 'the open hold still covers every resource');
  assert.ok(attempt.resources.every((r) => r.burns.length === 0), 'no partial burn was charged');
  assert.equal(out.cessation.applied, false, 'the finish did not send cessation');
}

test('a nonfinal guard reading at an abnormal finish keeps the full hold, and a later aggregate does not release the balance', async (t) => {
  const result = await admittedRun(t, {lending_meter: {final: false, cost_usd: 1}});
  assertFullHoldKept(result);
});

test('a streamed run with assistant usage and no result event keeps the full hold, and a later aggregate does not release the balance', async (t) => {
  const result = await admittedRun(t, {stdout: STREAM_WITHOUT_RESULT});
  assertFullHoldKept(result);
});
