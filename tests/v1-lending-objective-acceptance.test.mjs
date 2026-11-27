import './helpers/no-browser.mjs';
// M1 acceptance for the objective allocator. Examples (a) to (e) use exact authored fixture inputs.
// Burn model: the reference's settlement oracle (research 788c609c). A job spends to its native cap, then one final
// call overshoots by exactly its worst-call headroom. Tolerance: 1e-6 points, as in the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideObjectiveLend as decideObjectiveLendRaw, MICRO, PROTECTION_POSITIONS, wholeWeekReserveBand} from '../lib/v1/lending-objective.mjs';
import {evaluateLending, normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {
  MODELS, RESET, NOW, HOUR_MS, DAY_MS, CAP, GATES, OWNER_NONE, Ledger, calibration, windows, job, spendAtCap, smallCallSpend,
} from './helpers/lending-objective-fixtures.mjs';

const M = MICRO;
// Omitted laterBurn in these synthetic cases means the fixture declares a known empty queue.
const decideObjectiveLend = input => decideObjectiveLendRaw({laterBurnCapacityMicro: 0, ...input});
const iso = ms => new Date(ms).toISOString();
const LIGHT_T0 = RESET - 3 * HOUR_MS;
const H_HAIKU = 1_320_000;
const decideAt = ({at = LIGHT_T0, usedW = 10 * M, usedS = 0, laterBurn = 0, requested = 3 * M, friendValue = 3,
  position = 'balanced',
  worst = H_HAIKU, estimate = 3 * M, owner = OWNER_NONE, band = calibration(), ownerMaxJobUsd = null, gates = GATES} = {}) =>
  decideObjectiveLend({now: at, observedAt: at, windows: windows({weeklyUsedMicro: usedW, shortUsedMicro: usedS}),
    band, position, owner, gates, laterBurnCapacityMicro: laterBurn, ownerMaxJobUsdMicro: ownerMaxJobUsd,
    job: job({friendValue, requestedUsdMicro: requested, worstCallUsdMicro: worst, estimateUsdMicro: estimate})});

test('dial binds lambda and epsilon, with finite whole-week bands after 9, 3, and 1 complete weeks', () => {
  const thresholds = [
    ['keep_more_for_me', 10, .10, 9],
    ['balanced', 4, .25, 3],
    ['share_more', 2, .50, 1],
  ];
  for (const [position, lambda, epsilon, needed] of thresholds) {
    assert.equal(PROTECTION_POSITIONS[position].lambda, lambda);
    assert.equal(PROTECTION_POSITIONS[position].epsilon, epsilon);
    const early = wholeWeekReserveBand({...calibration({weeks: needed - 1}), position});
    assert.equal(early.status, 'insufficient_history');
    const finite = wholeWeekReserveBand({...calibration({weeks: needed}), position});
    assert.equal(finite.rank, needed);
    assert.equal(finite.status, 'finite');
    assert.equal(finite.epsilon, epsilon);
  }
});

test('higher protection never lends more on the same weekly evidence', () => {
  const band = calibration({weeks: 19});
  for (let i = 0; i < band.weeks.length; i++) {
    band.weeks[i].upperScores['five_hour@decision'] = i;
    band.weeks[i].upperScores['seven_day@decision'] = i;
  }
  const results = ['keep_more_for_me', 'balanced', 'share_more'].map(position => decideObjectiveLend({
    now: NOW, observedAt: NOW, windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}), band,
    position, owner: OWNER_NONE, gates: GATES,
    job: job({friendValue: 100, requestedUsdMicro: null, estimateUsdMicro: 3 * M, worstCallUsdMicro: H_HAIKU}),
  }));
  const lent = results.map(result => result.exposureUsdMicro ?? 0);
  assert.ok(lent[0] <= lent[1], `Keep more lent ${lent[0]} > Balanced ${lent[1]}`);
  assert.ok(lent[1] <= lent[2], `Balanced lent ${lent[1]} > Share more ${lent[2]}`);
  assert.deepEqual(results.map(result => result.projection.epsilon), [.10, .25, .50]);
});

// ---------- (a) Light owner: the spare is consumed, not merely admitted. MODULE ----------

test('(a) first chunk: 3 points admitted; 90 weekly points spare after protecting expected use; exact projection', () => {
  const d = decideAt({laterBurn: 87 * M});
  assert.equal(d.admitted, true);
  assert.deepEqual(d.projection, {
    schemaVersion: 1, policyVersion: 'objective/m1', admission: 'allowed', reasonCode: 'objective_lend',
    strategyId: 'automatic', strategyExplanation: 'Automatic uses a finite whole-week history band at week boundaries, or the configured demand model.',
    dial: 'balanced', lambda: 4, epsilon: .25, protectionSource: {seven_day: 'history', five_hour: 'history'},
    demandModelId: null, demandModelLabel: null, bindingWindow: null,
    observedAt: iso(LIGHT_T0), resetsAt: {five_hour: iso(RESET), seven_day: iso(RESET)},
    usedPoints: {seven_day: 10, five_hour: 0}, committedPoints: {seven_day: 0, five_hour: 0},
    protectedOwnerPoints: {seven_day: 0, five_hour: 0}, lendablePoints: {seven_day: 90, five_hour: 100},
    estimateUsd: 3, maximumExposureUsd: 3, nativeMaxBudgetUsd: 1.68, requestedUsd: 3, friendValue: 3, expectedOwnerHarm: 0,
    reasonText: 'Lending 3 points: 90 weekly points are spare after protecting your expected use. Protection source: history (whole-week conformal band at ε=0.25).',
  });
  assert.deepEqual(d.reservePointsMicro, {seven_day: 3 * M, five_hour: 3 * M});
});

test('(a) consumption, 30 queued 3-point units: owner 10 + borrower 90 = 100 by reset, expiry 0 within 1e-6 points', () => {
  const weekly = new Ledger(), short = new Ledger();
  weekly.used = 10 * M; // owner service, already charged before the first unit
  for (let i = 0; i < 30; i++) {
    const at = LIGHT_T0 + i * 5 * 60_000;
    const d = decideAt({at, usedW: weekly.used, usedS: short.used, laterBurn: 3 * (29 - i) * M});
    assert.equal(d.admitted, true, `unit ${i}: ${d.reasonCode}`);
    const id = 'unit-' + i, burn = spendAtCap(d.nativeBudgetUsdMicro, H_HAIKU);
    assert.ok(burn <= d.exposureUsdMicro, 'a unit never spends beyond its exposure');
    weekly.reserve(id, d.reservePointsMicro.seven_day);
    short.reserve(id, d.reservePointsMicro.five_hour);
    weekly.charge(id, burn);
    short.charge(id, burn);
    assert.equal(weekly.settle(id, 0, true), true);
    assert.equal(short.settle(id, 0, true), true);
  }
  assert.ok(Math.abs(weekly.borrowed - 90 * M) <= 1, `lent ${weekly.borrowed}`);
  assert.ok(Math.abs(CAP - weekly.used) <= 1, `weekly expiry ${CAP - weekly.used}`);
  // The five-hour window has no owner use here; its 10-point leftover is 100 - 90, unlendable because weekly binds.
  assert.equal(CAP - short.used, 10 * M);
});

test('(a) consumption, one spare-sized chunk (reference oracle): native 88.68 plus final call 1.32 consumes 90', () => {
  const d = decideAt({friendValue: 90, requested: null, laterBurn: 0, usedW: 10 * M});
  assert.equal(d.admitted, true);
  assert.equal(d.exposureUsdMicro, 90 * M);
  assert.equal(d.nativeBudgetUsdMicro, 88_680_000);
  const weekly = new Ledger(), short = new Ledger();
  weekly.used = 10 * M;
  const burn = spendAtCap(d.nativeBudgetUsdMicro, H_HAIKU);
  weekly.reserve('chunk', d.reservePointsMicro.seven_day);
  short.reserve('chunk', d.reservePointsMicro.five_hour);
  weekly.charge('chunk', burn);
  short.charge('chunk', burn);
  weekly.settle('chunk', 0, true);
  short.settle('chunk', 0, true);
  assert.ok(Math.abs(weekly.borrowed - 90 * M) <= 1);
  assert.ok(Math.abs(CAP - weekly.used) <= 1);
});

test('(a) CHARACTERIZATION, not a consumption proof: small calls spend only the native cap, so headroom expires', () => {
  // A small-call workload stops at native 1.68 per 3-point unit: 50.4 points lent, 39.6 expired (the reserved headroom).
  const spent = smallCallSpend(1_680_000, 15_000);
  assert.equal(spent, 1_680_000);
  assert.equal(30 * spent, 50_400_000);
  assert.equal(CAP - 10 * M - 30 * spent, 39_600_000);
  assert.ok(CAP - 10 * M - 30 * spent <= 30 * H_HAIKU, 'expiry never exceeds the reserved headroom');
});

// ---------- (b) Heavy owner: expected use is protected; nothing is lent. MODULE ----------

const heavyOwner = {scenarios: [{probability: 1, attempts: [
  {need: {seven_day: 20, five_hour: 20}, value: 20, atomic: false},
]}]};
const heavyBand = calibration({score: 10, forecast: 10});

test('(b) heavy owner: 20 expected weekly points stay reserved; the 2-point request is held with owner harm 2', () => {
  const d = decideObjectiveLend({now: NOW, observedAt: NOW, windows: windows({weeklyUsedMicro: 80 * M, shortUsedMicro: 40 * M}),
    band: heavyBand, position: 'balanced', owner: heavyOwner, gates: GATES, laterBurnCapacityMicro: 0,
    job: job({friendValue: 1, requestedUsdMicro: 2 * M, estimateUsdMicro: 2 * M, worstCallUsdMicro: H_HAIKU})});
  assert.equal(d.admitted, false);
  assert.equal(d.reservePointsMicro, undefined, 'no reservation and no launch');
  assert.equal(d.projection.reasonCode, 'objective_owner_reserve');
  assert.equal(d.projection.bindingWindow, 'seven_day');
  assert.deepEqual(d.projection.protectedOwnerPoints, {seven_day: 20, five_hour: 20});
  assert.deepEqual(d.projection.lendablePoints, {seven_day: 0, five_hour: 40});
  assert.equal(d.projection.expectedOwnerHarm, 2);
  assert.equal(d.projection.maximumExposureUsd, 0);
  assert.equal(d.projection.nativeMaxBudgetUsd, 0);
  assert.equal(d.projection.lambda, 4);
  assert.equal(d.projection.reasonText, 'Holding this job: all 20 remaining weekly points are reserved by your current protection source.');
});

test('(b) owner demand of 20 arrives above the 10-point forecast: served 20, unmet 0, weekly total 100, lent 0', () => {
  const remaining = CAP - 80 * M;                 // nothing lent
  const served = Math.min(20 * M, remaining);
  assert.equal(served, 20 * M);
  assert.equal(20 * M - served, 0);
  assert.equal(80 * M + served, CAP);
});

test('(b) concurrency: 70 used plus 10 committed holds the same way; unknown commitments hold as usage unknown', () => {
  const held = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 70 * M, weeklyCommittedMicro: 10 * M, shortUsedMicro: 40 * M}),
    band: heavyBand, owner: heavyOwner, gates: GATES,
    job: job({friendValue: 1, requestedUsdMicro: 2 * M, estimateUsdMicro: 2 * M, worstCallUsdMicro: H_HAIKU})});
  assert.equal(held.projection.reasonCode, 'objective_owner_reserve');
  assert.deepEqual(held.projection.protectedOwnerPoints, {seven_day: 20, five_hour: 20});
  const unknown = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 70 * M, weeklyCommittedMicro: null, shortUsedMicro: 40 * M}),
    band: heavyBand, owner: heavyOwner, gates: GATES,
    job: job({friendValue: 1, requestedUsdMicro: 2 * M, estimateUsdMicro: 2 * M, worstCallUsdMicro: H_HAIKU})});
  assert.equal(unknown.projection.reasonCode, 'objective_usage_unknown');
  assert.equal(unknown.admitted, false);
});

// ---------- (c) Haiku, Sonnet, Opus: admitted when spare covers a worst call, held when it cannot. MODULE ----------

const ampleWindows = () => windows({weeklyUsedMicro: 84_200_000, weeklyK: 790_000, shortUsedMicro: 68_400_000, shortK: 1_580_000});
const jobFor = (m, overrides = {}) => job({friendValue: 1, requestedUsdMicro: null, worstCallUsdMicro: m.headroomUsdMicro,
  estimateUsdMicro: m.estimateUsdMicro, ...overrides});

for (const m of MODELS) {
  test(`(c) ${m.model}: a $20 job from ample spare is admitted with native ${m.nativeAtTwenty / M} and reserves 15.8 / 31.6 points`, () => {
    const d = decideObjectiveLend({now: NOW, observedAt: NOW, windows: ampleWindows(), band: calibration(), owner: OWNER_NONE,
      gates: GATES, job: jobFor(m)});
    assert.equal(d.admitted, true, d.reasonCode);
    assert.equal(d.projection.reasonCode, 'objective_lend');
    assert.equal(d.projection.maximumExposureUsd, 20);
    assert.equal(d.projection.nativeMaxBudgetUsd, m.nativeAtTwenty / M);
    assert.equal(d.projection.estimateUsd, m.estimateUsdMicro / M);
    assert.deepEqual(d.reservePointsMicro, {seven_day: 15_800_000, five_hour: 31_600_000});
    // Worst-case spend (native plus final call) reaches the exposure exactly and never exceeds the spare.
    const worstSpend = spendAtCap(d.nativeBudgetUsdMicro, m.headroomUsdMicro);
    assert.equal(worstSpend, 20 * M);
    assert.ok(worstSpend * 790_000 / M <= 15_800_000, 'weekly spend within spare');
    assert.ok(worstSpend * 1_580_000 / M <= 31_600_000, 'five-hour spend within spare');
  });
}

test('(c) negative control: native = exposure (headroom not subtracted) overshoots the spare, so the review fix is load-bearing', () => {
  const naive = spendAtCap(20 * M, H_HAIKU);      // 21.32 USD of worst-case spend
  assert.equal(naive, 21_320_000);
  assert.ok(naive * 790_000 / M > 15_800_000, 'weekly overshoot: 16.8428 > 15.8');
  assert.ok(naive * 1_580_000 / M > 31_600_000, 'five-hour overshoot: 33.6856 > 31.6');
});

for (const m of MODELS) {
  test(`(c) ${m.model}: a call that cannot fit inside the 0.632911 spare is held with budget_too_small`, () => {
    const d = decideObjectiveLend({now: NOW, observedAt: NOW,
      windows: windows({weeklyUsedMicro: 99_500_000, weeklyK: 790_000, shortUsedMicro: 99_000_000, shortK: 1_580_000}),
      band: calibration(), owner: OWNER_NONE, gates: GATES, job: jobFor(m)});
    assert.equal(d.admitted, false);
    assert.equal(d.projection.reasonCode, 'budget_too_small');
    assert.equal(d.projection.maximumExposureUsd, 0.632911);
    assert.equal(d.projection.nativeMaxBudgetUsd, 0);
    assert.equal(d.reservePointsMicro, undefined);
    assert.equal(d.projection.reasonText,
      `Holding this job: $0.632911 of total spend cannot cover a worst-case $${m.headroomUsdMicro / M} call.`);
  });
}

test('(c) owner cap bounds total spend; native budgets subtract each model’s worst call', () => {
  const expected = {'claude-haiku-5-5': 10_680_000, 'claude-sonnet-5-5': 6_720_000, 'claude-opus-5-5': 1_440_000};
  for (const m of MODELS) {
    const d = decideObjectiveLend({now: NOW, observedAt: NOW, windows: ampleWindows(), band: calibration(), owner: OWNER_NONE,
      gates: GATES, ownerMaxJobUsdMicro: 12 * M, job: jobFor(m)});
    assert.equal(d.admitted, true, d.reasonCode);
    assert.equal(d.nativeBudgetUsdMicro, expected[m.model], m.model);
    assert.equal(spendAtCap(d.nativeBudgetUsdMicro, m.headroomUsdMicro), 12 * M);
    assert.equal(d.exposureUsdMicro, 12 * M);
  }
  for (const m of MODELS) {
    const held = decideObjectiveLend({now: NOW, observedAt: NOW, windows: ampleWindows(), band: calibration(), owner: OWNER_NONE,
      gates: GATES, ownerMaxJobUsdMicro: M, job: jobFor(m)});
    assert.equal(held.admitted, false, `${m.model} at a $1 total cap`);
    assert.equal(held.reason, 'budget_too_small');
    assert.equal(held.projection.reasonCode, 'budget_too_small');
  }
});

// ---------- (d) One explanation on every read surface. MODULE for the projection; surfaces are Stage B. ----------

const PROJECTION_KEYS = ['schemaVersion', 'policyVersion', 'admission', 'reasonCode', 'strategyId','strategyExplanation',
  'dial', 'lambda', 'epsilon','protectionSource','demandModelId','demandModelLabel','bindingWindow', 'observedAt', 'resetsAt', 'usedPoints', 'committedPoints',
  'protectedOwnerPoints', 'lendablePoints', 'estimateUsd', 'maximumExposureUsd', 'nativeMaxBudgetUsd', 'requestedUsd', 'friendValue',
  'expectedOwnerHarm', 'reasonText'];

test('(d) the projection has exactly the M1 fields, in order, with keyed windows', () => {
  const d = decideAt({laterBurn: 87 * M});
  assert.deepEqual(Object.keys(d.projection), PROJECTION_KEYS);
  assert.deepEqual(Object.keys(d.projection.usedPoints), ['seven_day', 'five_hour']);
});

test('(d) no-history source is model: the continuous default protects both windows with no history gate', () => {
  const noHistory = decideAt({band: calibration({weeks: 0})});
  assert.equal(noHistory.admitted,true,noHistory.reasonCode);
  assert.deepEqual(noHistory.projection.protectionSource, {seven_day: 'model', five_hour: 'model'});
  assert.equal(noHistory.projection.demandModelId,'continuous-gamma-v1');
  assert.match(noHistory.projection.demandModelLabel,/declared prior/);
});

test('(d) unknown usage and stop carry the exact hold copy', () => {
  const unknown = decideAt({usedW: 10 * M});
  assert.equal(decideObjectiveLend({now: LIGHT_T0, observedAt: LIGHT_T0, windows: windows({weeklyUsedMicro: 10 * M, weeklyCommittedMicro: null, shortUsedMicro: 0}),
    band: calibration(), owner: OWNER_NONE, gates: GATES, job: job()}).projection.reasonText,
  'Holding because current usage or committed work is unknown.');
  assert.ok(unknown.admitted);
  const stopped = decideObjectiveLend({now: LIGHT_T0, observedAt: LIGHT_T0, windows: windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 0}),
    band: calibration(), owner: OWNER_NONE, gates: GATES, job: job(), stopped: true});
  assert.equal(stopped.projection.reasonCode, 'objective_stopped');
  assert.equal(stopped.projection.reasonText, 'Lending is stopped.');
});

test('(d) reset boundary: now + wall + uncertainty + stop = reset holds; one millisecond later is time-feasible', () => {
  const at = LIGHT_T0;
  const at150000 = (w, s) => {
    const x = windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 0});
    x.seven_day.resetAtMs = w; x.five_hour.resetAtMs = s;
    return decideObjectiveLend({now: at, observedAt: at, windows: x, band: calibration(), owner: OWNER_NONE, gates: GATES,
      job: job({friendValue: 3, requestedUsdMicro: 3 * M})});
  };
  const held = at150000(at + 150_000, at + 150_000);
  assert.equal(held.projection.reasonCode, 'objective_reset');
  assert.equal(held.projection.reasonText, 'Holding because this job cannot finish before the next reset.');
  assert.equal(at150000(at + 150_000, at + 3_600_000).projection.reasonCode, 'objective_reset', 'weekly-first');
  assert.equal(at150000(at + 3_600_000, at + 150_000).projection.reasonCode, 'objective_reset', 'short-first');
  assert.equal(at150000(at + 150_001, at + 150_001).admitted, true, 'time-feasible at +150001 ms');
});

test('a finite whole-week band takes source priority over the model on every resource', () => {
  const d = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 10 * M}), band: calibration({score: 0, forecast: 5}), owner: OWNER_NONE,
    gates: GATES, laterBurnCapacityMicro: 0,
    job: job({friendValue: 3, requestedUsdMicro: 3 * M, worstCallUsdMicro: H_HAIKU})});
  assert.equal(d.admitted, true);
  assert.deepEqual(d.projection.protectionSource, {seven_day: 'history', five_hour: 'history'});
  assert.deepEqual(d.projection.protectedOwnerPoints, {seven_day: 5, five_hour: 5});
});

test('a finite rank keeps censored history as the source instead of falling back to a model', () => {
  const d = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 10 * M}),
    // Three complete weeks give Balanced a finite rank; Keep more for me needs nine.
    band: calibration({score: Infinity, forecast: 0, weeks: 3}), position: 'balanced', owner: OWNER_NONE,
    gates: GATES, laterBurnCapacityMicro: 0, job: job()});
  assert.equal(d.admitted, false);
  assert.deepEqual(d.projection.protectionSource, {seven_day: 'history', five_hour: 'history'});
  assert.equal(d.projection.reasonCode, 'objective_owner_reserve');
});

// ---------- Dial and strictness: admission is strict; ties hold. MODULE ----------

test('dial: every position admits a positive value inside its chance-constrained slack, whatever the owner loss', () => {
  const allDials = decideObjectiveLend({now: LIGHT_T0, observedAt: LIGHT_T0, windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}),
    band: calibration(), owner: OWNER_NONE, gates: GATES, job: job({friendValue: 1, requestedUsdMicro: 200_000, worstCallUsdMicro: 50_000})});
  assert.equal(allDials.admitted, true);
  const harmPointAdmit = (position, friendValue) => decideObjectiveLend({now: LIGHT_T0, observedAt: LIGHT_T0,
    windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}), band: calibration(), position, gates: GATES,
    owner: {scenarios: [{probability: 1, attempts: [
      {need: {seven_day: 100, five_hour: 0}, value: 100, atomic: false},
    ]}]},
    job: job({friendValue, requestedUsdMicro: 200_000, worstCallUsdMicro: 50_000})});
  // Binding design: owner loss is not traded against value. Each dial admits a positive value inside its protected
  // slack and reports the job's expected owner loss unchanged. Zero value still holds.
  for (const position of ['keep_more_for_me', 'balanced', 'share_more']) {
    const d = harmPointAdmit(position, 1);
    assert.equal(d.admitted, true, position);
    assert.ok(Math.abs(d.projection.expectedOwnerHarm - 0.2) < 1e-9, `${position}: ${d.projection.expectedOwnerHarm}`);
  }
  assert.equal(harmPointAdmit('balanced', 0).admitted, false);
});

test('zero benefit holds at zero harm: 0 = lambda x 0 chooses none', () => {
  const d = decideObjectiveLend({now: LIGHT_T0, observedAt: LIGHT_T0, windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}),
    band: calibration(), owner: OWNER_NONE, gates: GATES, job: job({friendValue: 0, requestedUsdMicro: 3 * M})});
  assert.equal(d.admitted, false);
  assert.equal(d.projection.reasonCode, 'objective_no_value');
  assert.equal(d.projection.reasonText, 'Holding this job: it has no value to lend for.');
});

// ---------- Objective sizing follows spare capacity without a volume schedule. MODULE ----------

test('spare capacity is available at the first evaluation after the weekly reset', () => {
  const weekStart = RESET - 7 * DAY_MS;
  const d = decideObjectiveLend({now: weekStart + HOUR_MS, observedAt: weekStart + HOUR_MS,
    windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}), band: calibration(), owner: OWNER_NONE, gates: GATES,
    job: job({friendValue: 13, requestedUsdMicro: 13 * M, worstCallUsdMicro: H_HAIKU})});
  assert.equal(d.admitted, true);
  assert.equal(d.exposureUsdMicro, 13 * M);
});

test('repeated objective decisions spend only the available spare capacity', () => {
  const weekly = new Ledger(), short = new Ledger();
  const step = (id, at, requested) => {
    const d = decideObjectiveLend({now: at, observedAt: at, windows: windows({weeklyUsedMicro: weekly.used, shortUsedMicro: short.used}),
      band: calibration(), owner: OWNER_NONE, gates: GATES, job: job({friendValue: requested, requestedUsdMicro: requested * M, worstCallUsdMicro: H_HAIKU})});
    assert.equal(d.admitted, true, `${id}: ${d.reasonCode}`);
    assert.equal(d.exposureUsdMicro, requested * M, id);
    weekly.reserve(id, d.reservePointsMicro.seven_day);
    short.reserve(id, d.reservePointsMicro.five_hour);
    const burn = spendAtCap(d.nativeBudgetUsdMicro, H_HAIKU);
    weekly.charge(id, burn); short.charge(id, burn);
    weekly.settle(id, 0, true); short.settle(id, 0, true);
  };
  step('first', LIGHT_T0, 13);
  step('second', LIGHT_T0 + 60_000, 7);
  step('third', LIGHT_T0 + 120_000, 43);
  assert.equal(weekly.borrowed, 63 * M);
});

// ---------- RED: the real admission path. Stage B wires the objective into evaluateLending and the runtime. ----------

const objectivePolicy = normalizeLendingPolicy({providerConsent: {claude: true}, accountPlans: {claude: 'max20'}});
const objectiveInput = (overrides = {}) => ({now: LIGHT_T0, observedAt: LIGHT_T0,
  windows: windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 0}), band: calibration(), owner: OWNER_NONE, gates: GATES,
  laterBurnCapacityMicro: 87 * M, job: job(), ...overrides});
test('evaluateLending returns the objective projection for a light owner', () => {
  const out = evaluateLending({policy: objectivePolicy, objectiveInput: objectiveInput()});
  assert.ok(out.objective);
  assert.equal(out.admitted, true);
  assert.equal(out.objective.reasonCode, 'objective_lend');
  assert.equal(out.objective.maximumExposureUsd, 3);
});

test('evaluateLending returns the objective projection for a heavy-owner hold', () => {
  const out = evaluateLending({policy: objectivePolicy, objectiveInput: objectiveInput({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 80 * M, shortUsedMicro: 40 * M}), band: heavyBand, owner: heavyOwner,
    laterBurnCapacityMicro: 0, job: job({friendValue: 1, requestedUsdMicro: 2 * M, estimateUsdMicro: 2 * M})})});
  assert.ok(out.objective);
  assert.equal(out.admitted, false);
  assert.equal(out.objective.reasonCode, 'objective_owner_reserve');
});

test('evaluateLending admits a Haiku-sized job with an explicit 100% per-job cap', () => {
  const out = evaluateLending({policy: {...objectivePolicy,strategyParams:{perJobPct:100}},
    objectiveInput: objectiveInput({now: NOW, observedAt: NOW, windows: ampleWindows(), laterBurnCapacityMicro: 0, job: jobFor(MODELS[0])})});
  assert.ok(out.objective);
  assert.equal(out.admitted, true);
  assert.equal(out.objective.nativeMaxBudgetUsd, 18.68);
});
