import './helpers/no-browser.mjs';
import {PROVIDER_PERCENT_UNCERTAINTY_MICRO} from '../lib/v1/quota-registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {HAIKU, fixture, attemptJob} from './helpers/objective-durable-fixture.mjs';
import {MICRO} from './helpers/pace50-fixtures.mjs';

// Measured posting-lag bound (120 s). A chunk's hold closes only when a meter reading taken after its cessation plus the bound
// covers it; the whole-point step that has not yet shown on the meter stays as unrepresented spend.
test('(a) several durable chunks each settle once, with unique burn records, and a repeated finish changes nothing', {timeout: 60000}, async t => {
  const f = fixture(t, {used: {weekly: 9 * MICRO, short: 0}, kappa: {weekly: MICRO, short: MICRO}, postingLagBoundMs: 120000,
    profile: {friendValue: 3, estimateUsdMicro: 3 * MICRO}});
  const chunks = 3;
  for (let index = 0; index < chunks; index++) {
    const id = String(index), args = attemptJob(id, f.clock.at, {requestedUsd: 3});
    const quote = await f.candidate.preview({attemptId: args.attemptId, jobId: args.jobId, job: args.job,
      provider: 'claude', model: HAIKU, ownerAbsent: true});
    assert.equal(quote.admitted, true, `chunk ${id}: ${quote.reason}`);
    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, true, grant.policyReason);
    await f.candidate.started(args.attemptId, {ok: true}); f.clock.at++;
    f.source.state.used.weekly += 3 * MICRO; f.source.state.used.short += 3 * MICRO;
    await f.candidate.recordCleanup(args.attemptId, {removed: true});
    const execution = {stdout: '', lending_meter: {model: HAIKU, cost_usd: 3, final: true}};
    const settled = await f.candidate.finish({attemptId: args.attemptId, provider: 'claude', model: HAIKU, execution});
    assert.equal(settled.metered.units_micro, 3 * MICRO);
    assert.equal(settled.cessation.applied, false, 'the hold stays open until the measured bound has passed');
    // The remaining step of the whole-point meter posts, and a reading past the bound covers the chunk.
    f.source.state.used.weekly += PROVIDER_PERCENT_UNCERTAINTY_MICRO;
    f.source.state.used.short += PROVIDER_PERCENT_UNCERTAINTY_MICRO;
    f.clock.at += 121_000;
    await f.candidate.probeHeld();
    const attempt = f.adapter.state().attempts.find(row => row.id === args.attemptId);
    assert.equal(attempt.process_state, 'ceased');
    assert.ok(attempt.resources.every(r => r.held_micro === 0), 'the covered chunk holds nothing');
    for (const r of attempt.resources) {
      assert.equal(r.burns.reduce((sum, b) => sum + b.amount_micro, 0), r.spent_micro);
      assert.equal(new Set(r.burns.map(b => b.id)).size, r.burns.length, 'burn ids are unique');
      assert.equal(r.initial_micro, r.spent_micro + r.settled_micro + r.released_micro);
      assert.ok(r.unrepresented_micro <= r.spent_micro);
    }
    const before = structuredClone(f.adapter.state().attempts.find(a => a.id === args.attemptId));
    await f.candidate.finish({attemptId: args.attemptId, provider: 'claude', model: HAIKU, execution});
    assert.deepEqual(f.adapter.state().attempts.find(a => a.id === args.attemptId), before, 'a repeated finish changes nothing');
    f.clock.at += 1000;
  }
  const attempts = f.adapter.state().attempts;
  assert.equal(attempts.length, chunks);
  for (const resource of ['seven_day', 'five_hour']) {
    const burnIds = attempts.flatMap(a => a.resources.filter(r => r.id === resource).flatMap(r => r.burns.map(b => b.id)));
    assert.equal(new Set(burnIds).size, burnIds.length, `${resource} burn ids are unique across chunks`);
  }
  assert.ok(attempts.every(a => a.resources.every(r => r.held_micro === 0)));
});
