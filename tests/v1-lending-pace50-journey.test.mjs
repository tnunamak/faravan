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

// Synthetic journey through the opt-in runtime seam. The provider readings, the process
// observations and the authoritative events are all invented. Nothing touches a provider.
const WEEK_RESET = NOW + 42 * HOUR_MS;
const SHORT_RESET = NOW + 1.25 * HOUR_MS;

test('an opted-in objective journey: consent, a useful chunk, reconciliation, owner return, pause and durable Stop', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-journey-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const clock = {at: NOW};
  const knobs = {consent: true, friendValue: 100};
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
    open_short_window: async () => { throw new Error('no quiet opening in this journey'); },
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
      controls: controls({consent: knobs.consent}),
      evidence: evidence(['weekly', 'short']),
      };
      input.objective = objectiveFixture.objectiveInputFor({state, request, now, input});
      input.objective.job.friendValue = knobs.friendValue;
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
  const proofOf = (attemptId) => {
    assert.equal(backend.running.has(attemptId), false, `${attemptId}: the backend still reports a process`);
    // These synthetic chunks record no usage, so their proof attests zero use explicitly; a started chunk with no burn needs that.
    return {authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true, attempt_id: attemptId};
  };

  // 1. Initial consent: no consent, no admission, and no provider effect.
  knobs.consent = false;
  let out = await admitted('attempt-1');
  assert.equal(out.reason, 'controls');
  knobs.consent = true;

  // 2. A zero-value chunk loses to the no-lend action under the objective rule.
  knobs.friendValue = 0;
  out = await admitted('attempt-1');
  assert.equal(out.reason, 'no_value');
  assert.deepEqual(backend.log, []);
  knobs.friendValue = 100;

  // 3. The objective admits a useful resumable chunk.
  tick();
  out = await admitted('attempt-1');
  assert.equal(out.admitted, true);
  assert.equal(out.effects.find((e) => e.type === 'launch_chunk').status, 'dispatched');
  await applied('launch_result', {attempt_id: 'attempt-1', result: 'started'});

  // 4. The chunk runs; aggregate growth cannot cover its burn, while cleanup proves the process is gone.
  tick();
  const burn = {attempt_id: 'attempt-1', burn_id: 'burn-1',
    resources: [{id: 'weekly', instance: 'weekly-1', amount_micro: 100000}, {id: 'short', instance: 'short-1', amount_micro: 100000}]};
  await applied('usage', burn);
  provider.weekly += 100000;
  provider.short += 100000;
  tick();
  const ledger = (id) => pace.state().attempts.find((a) => a.id === id).resources;
  const reconciled = ledger('attempt-1').map((r) => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at,
    resets_at: r.resets_at, used_micro: r.id === 'weekly' ? provider.weekly : provider.short}));
  const unresolved = await pace.transition({type: 'reconcile_burn', event_id: 'aggregate-only', at: clock.at,
    attempt_id: 'attempt-1', burn_id: 'burn-1', account: ACCOUNT, epoch: 'epoch-1', complete: true,
    compatible: true, refresh_succeeded: true, attribution_confirmed: true, observed_at: clock.at, resources: reconciled},
  {expectedRevision: rev});
  assert.equal(unresolved.applied, false);
  assert.equal(unresolved.reason, 'usage_coverage_unavailable');
  backend.running.delete('attempt-1');
  await applied('cleanup_proven', {event_id: `attempt-1:cleanup-proven:${clock.at}`, attempt_id: 'attempt-1', cleanup_removed: true});
  assert.equal(pace.state().attempts[0].process_state, 'ceased');
  assert.equal(pace.state().attempts[0].hold_closed, false, 'the aggregate cannot close the held exposure');
  assert.ok(ledger('attempt-1').every((r) => r.held_micro + r.unrepresented_micro === r.initial_micro && r.released_micro === 0));
  assert.equal(pace.state().attempts[0].resources[0].spent_micro, 100000 + 0, 'the spent weekly point is kept');

  // 5. A second chunk of the same job runs, then owner return stops it and blocks admission.
  tick();
  out = await admitted('attempt-2');
  assert.equal(out.admitted, true);
  await applied('launch_result', {attempt_id: 'attempt-2', result: 'started'});
  tick();
  await applied('owner_return', {});
  assert.ok(backend.log.some((e) => e[0] === 'cessation' && e[1] === 'attempt-2'), 'owner return requests cessation');
  tick();
  out = await admitted('attempt-3');
  assert.equal(out.reason, 'adapter_frozen', 'owner return freezes admission at once');
  backend.running.delete('attempt-2');
  await applied('cleanup_proven', {event_id: `attempt-2:cleanup-proven:${clock.at}`, attempt_id: 'attempt-2', cleanup_removed: true});
  assert.equal(pace.state().attempts.find(a => a.id === 'attempt-2').hold_closed, false,
    'cleanup stops the process but a started attempt with no usage proof stays held');
  tick();
  await applied('owner_absent', {confirmed: true});

  // 6. Pause freezes new work; On resumes it. Nothing is admitted while paused.
  tick();
  await applied('pause', {});
  out = await admitted('attempt-3');
  assert.equal(out.reason, 'adapter_frozen', 'pause freezes new chunks at once');
  tick();
  await applied('on', {});

  // 7. Durable Stop across a restart: the Stop is persisted, the cessation is requested, and the
  //    process exits before the coordinator sees the proof.
  tick();
  out = await admitted('attempt-3');
  assert.equal(out.admitted, true);
  await applied('launch_result', {attempt_id: 'attempt-3', result: 'started'});
  tick();
  await applied('stop', {});
  assert.ok(backend.log.some((e) => e[0] === 'cessation' && e[1] === 'attempt-3'));
  await runtime.close();

  // 8. Restart: Stop stays durable, recovery re-sends the cessation with the same effect id, and
  //    no launch is repeated.
  const launchesBefore = backend.log.filter((e) => e[0] === 'launch').length;
  runtime = open();
  pace = runtime.pace50;
  assert.equal(pace.state().mode, 'off');
  assert.equal(pace.state().revision, rev, 'the restarted store holds the same revision');
  const retried = await pace.recover();
  assert.equal(retried.effects[0].type, 'request_cessation');
  assert.equal(retried.effects[0].status, 'dispatched');
  assert.equal(retried.effects[0].effect_id, 'recover:request_cessation:attempt-3');
  assert.equal(backend.log.filter((e) => e[0] === 'launch').length, launchesBefore, 'recovery never launches');

  // 9. Fresh readiness after restart: Stop still refuses, even after the proof, until an explicit On.
  tick();
  out = await admitted('attempt-4');
  assert.equal(out.reason, 'stopped', 'a restarted store with Stop durable refuses new work');
  backend.running.delete('attempt-3');
  await applied('cleanup_proven', {event_id: `attempt-3:cleanup-proven:${clock.at}`, attempt_id: 'attempt-3', cleanup_removed: true});
  const unsupportedZero = await pace.transition({type: 'cessation_proven', event_id: 'attempt-3:zero-report', at: clock.at,
    ...proofOf('attempt-3')}, {expectedRevision: rev});
  assert.equal(unsupportedZero.applied, false);
  assert.equal(unsupportedZero.reason, 'usage_uncovered');
  assert.notEqual(pace.state().attempts.find(a => a.id === 'attempt-3').hold_closed, true);
  tick();
  out = await admitted('attempt-4');
  assert.equal(out.reason, 'stopped', 'the proof of cessation does not re-enable lending');
  tick();
  await applied('on', {});
  tick();
  out = await admitted('attempt-4');
  assert.equal(out.admitted, true, 'explicit On with fresh readings is ready');
  assert.equal(out.effects.find((e) => e.type === 'launch_chunk').status, 'dispatched');
  await runtime.close();
});
