import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, DAY_MS, HOUR_MS, MICRO, NOW, WEEK, controls, evidence, request} from './helpers/pace50-fixtures.mjs';

// The earlier weekly per-job point cap is deleted. Keep this test focused
// on the durable fact that actually settled spend survives a restart; total
// dollar caps are owned by the objective request and are tested at that boundary.
const WEEK_RESET = NOW + 42 * HOUR_MS;
const SHORT_RESET = NOW + 1.25 * HOUR_MS;

test('a settled chunk keeps its reconciled spend after a durable runtime restart', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-jobcap-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const clock = {at: NOW};
  const objectiveFixture = createSyntheticPace50Source({start: NOW});
  const provider = {weekly: 20 * MICRO, short: 40 * MICRO};
  const backend = {log: [], running: new Set()};
  const effects = {
    arm_cessation_deadline: async (effect) => {
      backend.log.push(['arm', effect.attempt_id, effect.resource_id]);
      return () => backend.log.push(['disarm', effect.attempt_id, effect.resource_id]);
    },
    launch_chunk: async (effect) => {
      backend.log.push(['launch', effect.attempt_id, effect.effect_id]);
      backend.running.add(effect.attempt_id);
    },
    open_short_window: async () => { throw new Error('no quiet opening in this test'); },
    cancel_pending_attempt: async (effect) => {
      backend.log.push(['cancel', effect.attempt_id, effect.effect_id]);
      backend.running.delete(effect.attempt_id);
    },
    request_cessation: async (effect) => {
      backend.log.push(['cessation', effect.attempt_id, effect.effect_id]);
      backend.running.delete(effect.attempt_id);
    },
    request_fresh_complete_reconciliation: async (effect) => { backend.log.push(['reconcile', effect.attempt_id]); },
  };
  const candidate = () => ({
    account: ACCOUNT,
    account_week_id: WEEK,
    buildInput: async ({now, state, request}) => {
      const input = {
      now, account: ACCOUNT, account_week_id: WEEK, epoch: 'epoch-1', weekly_resource_id: 'weekly',
      windows: [
        {id: 'weekly', kind: 'weekly', instance: 'weekly-1', account: ACCOUNT, epoch: 'epoch-1', state: 'open',
          anchor_at: WEEK_RESET - 7 * DAY_MS, resets_at: WEEK_RESET, duration_ms: 7 * DAY_MS, observed_at: now,
          used_micro: provider.weekly, kappa_micro: 50000},
        {id: 'short', kind: 'short', instance: 'short-1', account: ACCOUNT, epoch: 'epoch-1', state: 'open', origin: 'owner',
          anchor_at: SHORT_RESET - 5 * HOUR_MS, resets_at: SHORT_RESET, duration_ms: 5 * HOUR_MS, observed_at: now,
          used_micro: provider.short, kappa_micro: 200000},
      ],
      controls: controls({consent: true}),
      evidence: evidence(['weekly', 'short']),
      };
      input.objective = objectiveFixture.objectiveInputFor({state, request, now, input});
      return input;
    },
    effects,
  });
  const open = () => createLendingRuntime({directory, settings: () => ({intent: 'off', limits: {lendingPolicy: normalizeLendingPolicy()}}),
    backend: {}, presence: () => false, lastActiveAt: () => null, selfKey: () => null, now: () => clock.at, pace50: candidate()});
  const tick = (ms = 60000) => { clock.at += ms; return clock.at; };

  let runtime = open();
  let pace = runtime.pace50;
  let rev = 0;
  const applied = async (type, fields) => {
    const out = await pace.transition({type, event_id: `${type}-${clock.at}`, at: clock.at, ...fields}, {expectedRevision: rev});
    assert.equal(out.applied, true, `${type}: ${JSON.stringify(out)}`);
    rev = out.revision;
    return out;
  };
  const admitted = async (attemptId, patch = {}) => {
    const out = await pace.admit({expectedRevision: rev, request: request({attempt_id: attemptId, ...patch})});
    if (out.admitted) rev = out.revision;
    return out;
  };
  const ledger = (id) => pace.state().attempts.find((a) => a.id === id).resources;

  // Chunk 1 runs. A fresh aggregate reading records no interval coverage, while cleanup proves the process is gone.
  let out = await admitted('attempt-1', {job_id: 'job-1'});
  assert.equal(out.admitted, true, 'complete synthetic objective evidence admits the useful chunk');
  tick();
  await applied('launch_result', {attempt_id: 'attempt-1', result: 'started'});
  tick();
  await applied('usage', {attempt_id: 'attempt-1', burn_id: 'burn-1',
    resources: [{id: 'weekly', instance: 'weekly-1', amount_micro: 100000}, {id: 'short', instance: 'short-1', amount_micro: 100000}]});
  provider.weekly += 100000;
  provider.short += 100000;
  tick();
  const reconciled = ledger('attempt-1').map((r) => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at,
    resets_at: r.resets_at, used_micro: r.id === 'weekly' ? provider.weekly : provider.short}));
  const unresolved = await pace.transition({type: 'reconcile_burn', event_id: 'aggregate-only', at: clock.at,
    attempt_id: 'attempt-1', burn_id: 'burn-1', account: ACCOUNT, epoch: 'epoch-1', complete: true,
    compatible: true, refresh_succeeded: true, attribution_confirmed: true, observed_at: clock.at, resources: reconciled},
  {expectedRevision: rev});
  assert.equal(unresolved.applied, false);
  assert.equal(unresolved.reason, 'usage_coverage_unavailable');
  backend.running.delete('attempt-1');
  tick();
  const cleanup = await pace.transition({type: 'cleanup_proven', event_id: `attempt-1:cleanup-proven:${clock.at}`,
    at: clock.at, attempt_id: 'attempt-1', cleanup_removed: true}, {expectedRevision: rev});
  assert.equal(cleanup.applied, true, JSON.stringify(cleanup));
  rev = cleanup.revision;
  assert.equal(pace.state().attempts[0].process_state, 'ceased', 'the first chunk is proven gone');
  assert.equal(ledger('attempt-1').find((r) => r.id === 'weekly').spent_micro, 100000, 'the reconciled weekly spend is recorded');
  assert.equal(pace.state().attempts[0].hold_closed, false, 'aggregate movement does not close the exposure');
  assert.ok(ledger('attempt-1').every(r => r.held_micro + r.unrepresented_micro === r.initial_micro && r.released_micro === 0));
  await runtime.close();

  // Restart and prove the reconciled amount remains in the same durable attempt.
  runtime = open();
  pace = runtime.pace50;
  rev = pace.state().revision;
  const reopened = pace.state().attempts.find((attempt) => attempt.id === 'attempt-1');
  assert.equal(reopened.process_state, 'ceased', 'the settled state survives the restart');
  assert.equal(reopened.resources.find((r) => r.id === 'weekly').spent_micro, 100000,
    'the reconciled spend survives the restart');
  assert.equal(reopened.hold_closed, false, 'the unresolved exposure survives the restart');
  assert.ok(reopened.resources.every(r => r.held_micro + r.unrepresented_micro === r.initial_micro && r.released_micro === 0));
  await runtime.close();
});
