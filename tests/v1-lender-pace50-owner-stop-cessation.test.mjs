import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, HOUR_MS, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const HAIKU = 'claude-haiku-5-5';
const WEEK_RESET = NOW + 42 * HOUR_MS;
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + HOUR_MS).toISOString()};

// An owner Stop is durable intent. Once the sandbox removal is proven, the process has ceased, and that record must
// survive restart whether or not the provider's usage has settled. The hold is settled separately, exactly once.
test('an owner stop records durable cessation before its hold settles, and the hold settles exactly once',
  {timeout: 30000}, async (t) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'owner-stop-cessation-'));
    const clock = {at: NOW};
    const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: MICRO, short: MICRO},
      override: ({base}) => ({...base, resources: base.resources.filter(resource => resource.kind === 'weekly')})});
    const open = () => createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK,
      source, pendingRecords: () => []});
    let pace = open();
    t.after(async () => {
      await pace.adapter.close();
      fs.rmSync(directory, {recursive: true, force: true});
    });

    const attemptId = 'owner-stop-attempt';
    const attempt = () => pace.adapter.state().attempts.find(row => row.id === attemptId);
    const grant = await pace.candidate.reserve({attemptId, jobId: 'owner-stop-job', provider: 'claude', model: HAIKU,
      job, automatic: true, ownerAbsent: true});
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await pace.candidate.started(attemptId, {ok: true});
    const held = attempt().resources[0].held_micro;
    assert.ok(held > 0);

    const stop = await pace.candidate.ownerStop({attemptId, event_id: `${attemptId}:owner-stop`, at: clock.at});
    assert.equal(stop.applied, true, stop.reason);
    await pace.candidate.recordCleanup(attemptId, {removed: true});

    // The cessation record is written with the sandbox proof. Usage has not settled, so the hold is still open.
    assert.equal(attempt().process_state, 'ceased', 'the durable record says the process ceased');
    assert.equal(attempt().cessation_proven, true);
    assert.equal(attempt().cleanup_proven, true);
    assert.equal(attempt().resources[0].held_micro, held, 'the hold waits for settlement');

    const finished = await pace.candidate.finish({attemptId, provider: 'claude', model: HAIKU,
      execution: {stdout: '', lending_meter: {final: false, cost_usd: 0}}});
    assert.equal(finished.cessation.reason, 'usage_unknown');
    assert.equal(attempt().usage_unknown, 'claude', 'the unknown usage is recorded durably after the stop');
    await pace.adapter.close();

    clock.at = NOW + 60_000;
    pace = open();
    assert.equal(attempt().process_state, 'ceased', 'the cessation record survives restart');
    assert.equal(attempt().cessation_proven, true);
    assert.equal(attempt().resources[0].held_micro, held, 'the unsettled hold survives restart');

    clock.at = WEEK_RESET + 1_000;
    await pace.candidate.probeHeld();
    const settled = attempt();
    assert.equal(settled.resources[0].held_micro, 0, 'the reset settles the hold');
    assert.equal(settled.resources[0].spent_micro, held, 'the unknown usage is charged once, in full');
    const revision = pace.adapter.state().revision;
    await pace.candidate.probeHeld();
    assert.equal(pace.adapter.state().revision, revision, 'a second probe does not settle the hold again');
    assert.equal(attempt().resources[0].spent_micro, held);
  });

// The owner's Stop is durable intent, and it must also dispatch the effect that stops the attempt. A crash or a failed route call
// after the durable write would otherwise leave cessation undispatched. Each attempt needs its own store, so the effects are checked alone.
const stopEffectsRig = (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'owner-stop-effects-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: MICRO, short: MICRO},
    override: ({base}) => ({...base, resources: base.resources.filter(resource => resource.kind === 'weekly')})});
  const pace = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source,
    pendingRecords: () => []});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {pace, clock};
};

test('an owner stop on a started attempt dispatches the cessation that stops its run', {timeout: 30000}, async (t) => {
  const {pace, clock} = stopEffectsRig(t);
  const attemptId = 'stop-live-attempt';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'stop-live-job', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started(attemptId, {ok: true});
  const stop = await pace.candidate.ownerStop({attemptId, event_id: `${attemptId}:owner-stop`, at: clock.at});
  assert.equal(stop.applied, true, JSON.stringify(stop));
  assert.ok(stop.effects.some(effect => effect.type === 'request_cessation' && effect.attempt_id === attemptId),
    `the stop dispatches request_cessation: ${JSON.stringify(stop.effects)}`);
});

test('an owner stop on an unstarted attempt dispatches the cancel that stops it', {timeout: 30000}, async (t) => {
  const {pace, clock} = stopEffectsRig(t);
  const attemptId = 'stop-unstarted-attempt';
  const grant = await pace.candidate.reserve({attemptId, jobId: 'stop-unstarted-job', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const stop = await pace.candidate.ownerStop({attemptId, event_id: `${attemptId}:owner-stop`, at: clock.at});
  assert.equal(stop.applied, true, JSON.stringify(stop));
  assert.ok(stop.effects.some(effect => effect.type === 'cancel_pending_attempt' && effect.attempt_id === attemptId),
    `the stop dispatches cancel_pending_attempt: ${JSON.stringify(stop.effects)}`);
});
