import {priceListUsd} from './lending-meter.mjs';
const WEEK = 7 * 24 * 3600_000;
const time = x => typeof x === 'number' ? x : Date.parse(x);
// A provider meter shows whole points. One shown point of rise can hide up to one more real point,
// so each rise counts one extra point. That makes the measured rate an upper bound, never an estimate below it.
export const METER_RESOLUTION_POINTS = 1;
export const MEASURED_LABEL = 'measured from your usage';
// A measurement stands for 8 weeks after the newest use it was made from, the same reach as the spans it reads. After that
// the window returns to native-window mode until it is measured again: a plan's allowance can change without any sign in the logs. A new meter
// reading alone never renews it.
export const MEASUREMENT_MAX_AGE_MS = 8 * WEEK;
// A meter at 100% stops counting while use goes on, so cost keeps rising with no points: that rate is too low.
const FULL_METER_POINTS = 100;
const finitePositive = x => Number.isFinite(x) && x > 0;

// Only meters whose scope is known are measured. The all-model meters count every model's use; a per-model meter
// counts only its family's use. Any other meter (Claude's app or overage meters, a separate Codex bucket such as
// `codex:codex:<bucket>:<minutes>`, a meter added later) counts a subset that all-model cost would price too low.
export const FAMILY = {'claude:seven_day_opus':'opus', 'claude:seven_day_sonnet':'sonnet'};
export const measurable = resource => resource === 'claude:five_hour' || resource === 'claude:seven_day' ||
  Object.hasOwn(FAMILY, resource) || /^codex:codex:\d+$/.test(resource ?? '');

export function measureKappa({account, resource, usage = [], meterPeriods = [], currentWindows = [],
  previous = null, attribution = null, now = Date.now()} = {}) {
  const since = attribution?.since;
  if (!Number.isFinite(now) || !attribution || typeof attribution.account_sha256_16 !== 'string' || !Number.isFinite(since) ||
      !measurable(resource)) return null;
  const family = FAMILY[resource];
  // Only use known to be paid by this plan counts: cost paid another way (an API key, say) moved no meter point, and counting
  // it would make the rate too low. A Codex event also names the account its session was signed in to.
  const rows = usage.filter(r => r.account === account && r.attributed_account === attribution.account_sha256_16 &&
    r.funding === 'subscription' &&
    (r.provider !== 'codex' || r.creator_account_sha256_16 === attribution.account_sha256_16) &&
    time(r.at) >= since && (!family || String(r.model ?? '').toLowerCase().includes(family)));
  const priced = rows.map(r => ({at:time(r.at), ...priceListUsd(r.model, r.tokens)}));
  const cost = (start, end) => priced.filter(r => r.at >= start && r.at < end && r.priced && Number.isFinite(r.usd))
    .reduce((n, r) => n + r.usd, 0);
  const seen = new Set(), spans = [];
  for (const p of meterPeriods) {
    const start = time(p.start_at), end = time(p.end_at), key = `${start}/${end}`;
    if (p.account !== account || p.resource !== resource || seen.has(key) || start < since ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < now - 8 * WEEK || end > now || end <= start ||
        !Number.isFinite(p.meter_points) || !(p.meter_points >= 3) || !(p.end_points < FULL_METER_POINTS)) continue;
    seen.add(key);
    const usd = cost(start, end);
    if (finitePositive(usd)) spans.push({usd, points:p.meter_points + METER_RESOLUTION_POINTS, end});
  }
  const binding = {account_sha256_16:attribution.account_sha256_16, since};
  const measured = (rate, method, evidenceEnd) => finitePositive(rate) && Number.isSafeInteger(Math.ceil(rate * 1e6)) ? {
    account, resource, upper_micro:Math.ceil(rate * 1e6), lower_micro:null, binding,
    evidence_end_at:evidenceEnd, expires_at:evidenceEnd + MEASUREMENT_MAX_AGE_MS,
    provenance:{method, label:MEASURED_LABEL, source:'local meter / local list-price USD',
      resolution_points:METER_RESOLUTION_POINTS, spans:spans.length}} : null;
  // The highest span rate, not an average. Its age is that span's own.
  if (spans.length >= 4) {
    const top = spans.reduce((best, s) => s.points / s.usd > best.points / best.usd ? s : best);
    return measured(top.points / top.usd, 'max-span/8-weeks', top.end);
  }
  for (const p of currentWindows) {
    const observed = time(p.observed_at);
    if (p.account !== account || p.resource !== resource || !Number.isFinite(observed) || observed > now ||
        !Number.isFinite(p.meter_points) || !(p.meter_points > 0) || !(p.meter_points < FULL_METER_POINTS)) continue;
    // Points shown in this window may include use before `since`; that only raises the rate. Cost never does.
    const start = Math.max(time(p.start_at), since);
    const windowRows = priced.filter(r => r.at >= start && r.at < observed + 1 && r.priced && Number.isFinite(r.usd));
    const usd = windowRows.reduce((n, r) => n + r.usd, 0);
    if (finitePositive(usd)) return measured((p.meter_points + METER_RESOLUTION_POINTS) / usd, 'current-window',
      windowRows.reduce((newest, r) => Math.max(newest, r.at), -Infinity));
  }
  // Keep an earlier measurement only for the same account, window and attribution period, and only until it expires.
  if (previous?.account === account && previous?.resource === resource && Number.isSafeInteger(previous.upper_micro) &&
      previous.upper_micro > 0 && previous.binding?.account_sha256_16 === binding.account_sha256_16 &&
      previous.binding?.since === since && previous.expires_at > now) return previous;
  return null;
}

import savedCalibration from './lending-kappa-calibration.json' with {type:'json'};
export function certifiedKappa({provider, plan, window, model} = {}) {
  const row = savedCalibration.entries.find(entry => entry.provider === provider && entry.plan === plan &&
    entry.window === window && entry.model === model);
  if (!row || !Number.isSafeInteger(row.upperMicro) || row.upperMicro <= 0 ||
      !calibrationText(row.provenance?.method) || !calibrationText(row.provenance?.boundReport) ||
      !calibrationText(row.provenance?.acceptedBy)) return null;
  return {upper_micro: row.upperMicro, lower_micro: null, provenance: structuredClone(row.provenance)};
}

const calibrationText=value=>typeof value==='string'&&value.trim().length>0;
