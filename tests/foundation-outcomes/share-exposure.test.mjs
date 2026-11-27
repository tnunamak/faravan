import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLending } from '../../lib/v1/lending-decision.mjs';

const MICRO = 1000000;
function input(accountId = 'account-sentinel') {
  // Mirrors the observed positive fixture in foundation-lending/contracts:
  // one supported weekly window, one hour to reset, no restrictive runtime.
  // A 60-second reset cannot cover the facade's 60s wall + 10s stop horizon.
  const nowMs = 1000000000;
  return {
    schemaVersion: 1, nowMs,
    account: { id: accountId, providerId: 'provider-sentinel', enabled: true, authState: 'signed_in' },
    usage: { schemaVersion: 1, accountId, state: 'ready', jobReadings: [], ageMs: 0,
      lastAttemptAtMs: nowMs, limitResetAtMs: null, nextReadAtMs: nowMs + 120000,
      reading: { schemaVersion: 1, accountId, observationId: 'observation-sentinel', sequence: 1,
        observedAtMs: nowMs, receivedAtMs: nowMs, postingUncertaintyMs: null,
        coverage: { kind: 'unknown' }, windows: [
        { id: 'seven_day', instance: 'week-sentinel', capacityMicro: 100 * MICRO,
          usedLoMicro: 0, usedHiMicro: 0, resetsAtMs: nowMs + 3600000, maxOwnerRateMicroPerMs: 0 }
      ] } },
    policy: { schemaVersion: 1, revision: 1, enabled: true, strategy: 'fixed_share',
      strategyParams: { fixedSharePct: 20, keepPct: 0, perJobPct: 100 },
      protectionPosition: 'keep_more_for_me' },
    eligibility: { enabledNow: true, reason: 'enabled', evaluatedAtMs: nowMs,
      settingsRevision: 1, nextChangeAtMs: null },
    job: { id: 'job-sentinel', attemptId: 'attempt-sentinel',
      selection: { providerId: 'provider-sentinel', accountId, modelId: 'model-sentinel', effortId: null } },
    runtime: { canStart: true, nextAction: null },
    ledger: { schemaVersion: 1, accountId, revision: 0, resources: [], attempts: [] },
    history: { schemaVersion: 1, accountId, rows: [] }
  };
}
function row(reserved, consumed = 0, extra = {}) {
  return { id: 'seven_day', instance: 'week-sentinel', unit: 'window_micro_points',
    reserved: reserved * MICRO, consumed: consumed * MICRO, unrepresented: 0, ...extra };
}
function quote(i) {
  const before = structuredClone(i);
  const decision = decideLending(i);
  assert.deepEqual(i, before, 'decision must not mutate saved policy, history, usage or ledger');
  return decision;
}
function positive(i) {
  const decision = quote(i);
  assert.equal(decision.kind, 'lend', JSON.stringify(decision));
  assert.equal(decision.mode, 'observed');
  assert.equal(decision.amount.unit, 'window_micro_points');
  assert.equal(decision.amount.byResource.length, 1);
  const coordinate = decision.amount.byResource[0];
  assert.equal(coordinate.id, 'seven_day');
  assert.equal(coordinate.instance, 'week-sentinel');
  assert.ok(coordinate.amount > 0);
  return coordinate.amount;
}

test('positive unreserved control precedes fully held fixed-share regression', () => {
  const control = input();
  assert.ok(positive(control) <= 20 * MICRO);
  const held = input();
  held.ledger.resources = [row(20)];
  const decision = quote(held);
  // Original facade passes lentMicro=0 here, so its 20-point share ceiling
  // remains available even though 20 is already held. This must fail pre-fix.
  assert.equal(decision.kind, 'wait', JSON.stringify(decision));
  assert.equal(decision.strategy, 'fixed_share');
  assert.equal(decision.nextAction.id, 'wait_for_spare');
  assert.equal(decision.nextEvaluationAtMs, held.usage.nextReadAtMs);
  assert.equal(typeof decision.reason, 'string');
});

test('partial held plus spent exposure leaves only the residual share', () => {
  assert.ok(positive(input()) > 0);
  const partial = input();
  partial.ledger.resources = [row(4, 3), row(5, 2)];
  // 20 - (4 + 3 + 5 + 2) = 6; aggregate reservation remains counted once.
  assert.ok(positive(partial) <= 6 * MICRO);
  const full = input();
  full.ledger.resources = [row(12, 8)];
  assert.equal(quote(full).kind, 'wait');
});

test('another instance, resource or unit cannot consume this weekly share', () => {
  const control = positive(input());
  for (const extra of [
    { instance: 'previous-week' },
    { id: 'five_hour' },
    { unit: 'native' }
  ]) {
    const other = input();
    other.ledger.resources = [row(100, 100, extra)];
    assert.equal(positive(other), control);
  }
});

test('ledger account boundary rejects mixing, independent accounts stay positive', () => {
  const first = input('account-A');
  first.ledger.resources = [row(20)];
  assert.equal(quote(first).kind, 'wait');
  const second = input('account-B');
  assert.ok(positive(second) > 0);
  const before = structuredClone(second);
  second.ledger = structuredClone(first.ledger);
  assert.throws(() => decideLending(second), /invalid_decision_input/);
  // No invented per-resource account field: the contract scopes the ledger.
  assert.deepEqual(first.ledger.resources, [row(20)]);
  assert.deepEqual(before.ledger.resources, []);
});

test('automatic positive observed fixture ignores consumed metadata, not held capacity', () => {
  const automatic = input();
  automatic.policy.strategy = 'automatic';
  automatic.policy.strategyParams = {};
  automatic.usage.reading.observedAtMs -= 1500000;
  automatic.usage.ageMs = 1500000;
  automatic.usage.reading.windows[0].usedLoMicro = 20 * MICRO;
  automatic.usage.reading.windows[0].usedHiMicro = 20 * MICRO;
  automatic.ledger.resources = [row(5, 30, { unrepresented: 30 * MICRO })];
  const before = structuredClone(automatic);
  const control = decideLending(automatic);
  assert.equal(control.kind, 'lend', JSON.stringify(control));
  assert.ok(control.amount.byResource[0].amount > 0);
  assert.ok(control.amount.byResource[0].amount <= 45 * MICRO);
  assert.equal(control.readingAgeMs, 1500000);
  assert.deepEqual(automatic, before);
  // consumed is reporting/share metadata, already represented in used/debt;
  // adding it again must not subtract from automatic aggregate capacity.
  automatic.ledger.resources[0].consumed = 60 * MICRO;
  assert.deepEqual(quote(automatic), control);
});
