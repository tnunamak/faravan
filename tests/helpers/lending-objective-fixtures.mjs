// Synthetic fixtures for the M1 objective tests. Every number here is authored, not measured.
// Ported from the reviewed reference (research capacity-pooling/lending-default-comparison-2026-10-23/model.mjs @ 788c609c):
// the Ledger class and the settlement model. The burn model is the reference's: a job spends to its native
// cap, then one bounded final call overshoots by exactly its worst-call headroom.
export const MICRO = 1_000_000;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const RESET = Date.UTC(2026, 9, 26);
export const NOW = RESET - HOUR_MS;
export const CAP = 100 * MICRO;
export const GATES = Object.freeze({consent: true, limits: true, funding: true, stopping: true});
export const OWNER_NONE = Object.freeze({scenarios: [{probability: 1, attempts: [
  {need: {seven_day: 0, five_hour: 0}, value: 0, atomic: false},
]}]});
// Catalog worst single-call headroom per Claude family model, USD micro-units. Synthetic review witnesses.
export const MODELS = Object.freeze([
  {model: 'claude-haiku-5-5', headroomUsdMicro: 1_320_000, estimateUsdMicro: 15_000, nativeAtTwenty: 18_680_000},
  {model: 'claude-sonnet-5-5', headroomUsdMicro: 5_280_000, estimateUsdMicro: 300_000, nativeAtTwenty: 14_720_000},
  {model: 'claude-opus-5-5', headroomUsdMicro: 10_560_000, estimateUsdMicro: 600_000, nativeAtTwenty: 9_440_000},
]);

// Calibration: 19 complete, compatible weeks before the current week; one residual per week over the whole domain.
export function calibration({score = 0, forecast = 0, weeks = 19} = {}) {
  const domain = ['five_hour@decision', 'seven_day@decision'];
  return {
    weekStart: RESET - 7 * DAY_MS, epoch: 'm1-frozen-epoch/1', procedure: 'm1-frozen-procedure/1', domain,
    weeks: Array.from({length: weeks}, (_, i) => ({
      id: 'calibration-' + i, end: RESET - (weeks - i) * 7 * DAY_MS, epoch: 'm1-frozen-epoch/1',
      procedure: 'm1-frozen-procedure/1', complete: true,
      upperScores: {'five_hour@decision': score, 'seven_day@decision': score},
    })),
    forecasts: [
      {id: 'five_hour', domain: 'five_hour@decision', prediction: forecast, scale: 1},
      {id: 'seven_day', domain: 'seven_day@decision', prediction: forecast, scale: 1},
    ],
  };
}

// Window readings in micro-units. k is points per USD in micro-units (1.58 points per USD = 1_580_000).
export function windows({weeklyUsedMicro, shortUsedMicro, weeklyCommittedMicro = 0, shortCommittedMicro = 0,
  weeklyK = MICRO, shortK = MICRO, resetAtMs = RESET, known = true} = {}) {
  const w = (usedMicro, committedMicro, pointsPerUsdMicro) =>
    ({known, fresh: true, compatible: true, usedMicro, committedMicro, pointsPerUsdMicro,
      pointsPerUsdLowerMicro: pointsPerUsdMicro, resetAtMs});
  return {seven_day: {...w(weeklyUsedMicro, weeklyCommittedMicro, weeklyK), kind: 'weekly'},
    five_hour: {...w(shortUsedMicro, shortCommittedMicro, shortK), kind: 'short'}};
}

export function job(overrides = {}) {
  return {
    id: 'job', friendValue: 3, wallMs: 60_000, uncertaintyMs: 30_000, stopMs: 60_000,
    estimateUsdMicro: 3 * MICRO, worstCallUsdMicro: 1_320_000, requestedUsdMicro: 3 * MICRO, ...overrides,
  };
}

// Spend-to-cap model (reference settlement oracle): a job spends up to its native cap, then one final call
// overshoots by its worst-call headroom. Total = native + headroom, the bound the reservation holds.
export function spendAtCap(nativeMicro, headroomMicro) {
  return nativeMicro + headroomMicro;
}

// Small realistic calls, for characterization only: the guard starts a call while spend < native, so spend
// stops at native plus at most one call. Under this model the headroom reserved for the worst call stays unspent.
export function smallCallSpend(nativeMicro, callMicro) {
  let spent = 0;
  while (spent < nativeMicro) spent += callMicro;
  return spent;
}

// Reference Ledger, micro-unit port. Holds are reserved before a job, charged as it burns, and released on settle.
export class Ledger {
  constructor() { this.used = 0; this.borrowed = 0; this.held = 0; this.holds = new Map(); this.closed = new Set(); }
  reserve(id, amount) {
    if (this.holds.has(id) || this.closed.has(id)) throw new Error('duplicate_hold');
    if (!Number.isSafeInteger(amount) || amount < 0 || this.used + this.held + amount > CAP) throw new Error('capacity');
    this.holds.set(id, amount);
    this.held += amount;
  }
  charge(id, burn) {
    const held = this.holds.get(id);
    if (held === undefined || !Number.isSafeInteger(burn) || burn < 0 || burn > held) throw new Error('bad_charge');
    this.holds.set(id, held - burn);
    this.held -= burn;
    this.used += burn;
    this.borrowed += burn;
  }
  settle(id, burn, ceased = true) {
    if (this.closed.has(id)) return false;
    const held = this.holds.get(id);
    if (held === undefined || !Number.isSafeInteger(burn) || burn < 0 || burn > held) throw new Error('bad_receipt');
    if (!ceased) return false; // Unknown cessation cannot refund.
    this.held -= held;
    this.used += burn;
    this.borrowed += burn;
    this.holds.delete(id);
    this.closed.add(id);
    return true;
  }
  reset() {
    if (this.held) throw new Error('unresolved_reset');
    const expired = CAP - this.used;
    this.used = 0;
    this.borrowed = 0;
    return expired;
  }
}
