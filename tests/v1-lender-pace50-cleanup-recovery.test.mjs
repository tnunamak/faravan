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

test('cleanup proof and attempt identity survive restart until a covering meter and reset settle unknown usage',
  {timeout: 30000}, async (t) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'cleanup-recovery-'));
    const clock = {at: NOW};
    const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: MICRO, short: MICRO},
      override: ({base}) => ({...base, resources: base.resources.filter(resource => resource.kind === 'weekly')})});
    const meterReads = [];
    const observe = source.observe.bind(source);
    source.observe = async args => {
      const reading = await observe(args);
      meterReads.push({provider: args.provider, now: args.now, reading});
      return reading;
    };
    const open = () => createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK,
      source, pendingRecords: () => []});
    let pace = open();
    t.after(async () => {
      await pace.adapter.close();
      fs.rmSync(directory, {recursive: true, force: true});
    });

    const attemptId = 'cleanup-proof-attempt';
    const grant = await pace.candidate.reserve({attemptId, jobId: 'cleanup-proof-job', provider: 'claude', model: HAIKU,
      job, automatic: true, ownerAbsent: true});
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await pace.candidate.started(attemptId, {ok: true});
    const reserved = pace.adapter.state().attempts.find(attempt => attempt.id === attemptId).resources[0].held_micro;
    assert.ok(reserved > 0);

    pace.candidate.recordCleanup(attemptId, {removed: true});
    const finished = await pace.candidate.finish({attemptId, provider: 'claude', model: HAIKU,
      execution: {stdout: '', lending_meter: {final: false, cost_usd: 0}}});
    assert.equal(finished.cessation.reason, 'usage_unknown');
    const beforeRestart = pace.adapter.state().attempts.find(attempt => attempt.id === attemptId);
    assert.equal(beforeRestart.usage_unknown, 'claude');
    assert.equal(beforeRestart.cleanup_proven, true, 'finish persists cleanup before the lender can remove its journal entry');
    assert.equal(beforeRestart.resources[0].held_micro, reserved);
    await pace.adapter.close();

    clock.at = NOW + 60_000;
    source.state.used.weekly += MICRO;
    pace = open();
    let recovered = pace.adapter.state().attempts.find(attempt => attempt.id === attemptId);
    assert.equal(recovered.id, attemptId, 'recovery uses the original attempt identity');
    assert.equal(recovered.usage_unknown, 'claude', 'the provider needed to read the meter survives restart');
    await pace.candidate.probeHeld();
    assert.ok(meterReads.some(({provider, now, reading}) => provider === 'claude' && now === clock.at &&
      reading.resources.find(resource => resource.kind === 'weekly')?.used_micro === source.state.used.weekly),
    'recovery reads the covering aggregate for the original provider and attempt');
    recovered = pace.adapter.state().attempts.find(attempt => attempt.id === attemptId);
    assert.notEqual(recovered.hold_closed, true, 'the covering meter alone does not close the hold, so unknown use is not zero');
    assert.ok(recovered.resources[0].held_micro > 0, 'unsettled exposure remains held before reset');

    clock.at = WEEK_RESET + 1_000;
    await pace.candidate.probeHeld();
    const settled = pace.adapter.state().attempts.find(attempt => attempt.id === attemptId);
    assert.equal(settled.cleanup_proven, true, 'the attempt-bound cleanup proof is restored from durable state');
    assert.ok(pace.adapter.state().event_ids.some(eventId => eventId.startsWith(`${attemptId}:cleanup-proven:`)),
      'the cleanup proof event retains the same attempt identity');
    assert.equal(settled.process_state, 'ceased', 'the reset settles the held exposure after cleanup proof recovery');
    assert.equal(settled.resources[0].held_micro, 0);
    assert.equal(settled.resources[0].spent_micro, reserved, 'the unknown amount is charged in full at reset');
  });
