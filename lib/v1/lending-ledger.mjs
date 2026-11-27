import {durableJson} from '../durable-write.mjs';
/**
 * The lender's durable lending ledger (LENDING-POLICY-DESIGN.md D2, D3, D4, D9, D0; data model §3).
 * One local JSON file, rewritten atomically (tmp + fsync + rename) under a crash-safe process lock.
 * Never leaves the machine; holds no credential and no account identifier. One lent account per provider (D0),
 * so the account id is the provider id: 'claude' | 'codex'.
 *
 *   const ledger = createLendingLedger({ file, now });
 *   ledger.recordReadings(account, readings)            readings from lending-meter parsers
 *   ledger.snapshotForDisplay(account, { plan, model }) -> local display only; cached parsing, fresh time projection
 *   ledger.snapshot(account, { plan, model })           -> { windows: [policy window contract], same_account, history, ... }
 *   ledger.reserve({ account, job_digest, attempt_id, budget_units, unit, model, plan, requester, max_requester_pct, ttl_ms, admit })
 *                                                       -> { ok, reason?, reservation?, windows }   atomic check-and-hold
 *   ledger.reconcile(reservation_id, { started, metered, started_at, ended_at, stop_reason, owner_active })
 *                                                       -> { entries }   hold -> attributed ledger entries;
 *                                                          started:false releases the hold with no charge
 *   ledger.requesterUsage({ circle, keyId }, { account, since }) -> per-window lent_pts and charged_pts (D11, D14)
 *   ledger.entries(filter)                              -> raw local records; lent_lower_pts is the proven borrower-burn lower bound
 *                                                          represented_at identifies the aggregate observation that proves inclusion
 *   ledger.recover({ liveAttemptIds })                  -> { recovered }  crash recovery for orphaned holds
 *   ledger.reconcileAttempt(attempt_id, { started, metered?, ... })
 *                                                       -> { entries, released?, already? }  settle a hold by attempt
 *                                                          once its cessation is proven (pending sandbox recovery)
 *   ledger.recordSameAccount(account, { at, guest, host }) -> 'yes' | 'no' | 'unknown'
 *   ledger.calibration(account, window_id, { plan })    -> κ per family, bins, r2, prior source
 *
 * Policy window contract (lib/v1/lending-policy.mjs): {window_id, window_minutes, used_pct, owner_used_pct, resets_at, observed_at,
 * state, kappa, lent_pct, reserved_pct, lent_last_hour_pct, history, max_rate_pct_per_hour}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProcessLockSync } from './lock.mjs';
import { modelFamily } from './lending-meter.mjs';
import { accountIdOfKey, isAccountKey, providerOfKey } from './lending-account-key.mjs';

const HOUR = 3600000, WEEK = 7 * 24 * HOUR, BIN = 6 * HOUR, KEEP = 10 * WEEK;
const SAME_RESET_MS = 60000, MAX_SERIES = 6000, FRESH_PROBE_MS = 15 * 60000;
const ACCOUNTS = ['claude', 'codex'];
// A ledger id is a provider, or an added account's key (`provider:<id>`), which has its own series and pricing from its provider.
const knownAccount = id => ACCOUNTS.includes(id) || (typeof id === 'string' && isAccountKey(id) && accountIdOfKey(id) !== null && ACCOUNTS.includes(providerOfKey(id)));
const providerOf = id => isAccountKey(id) ? providerOfKey(id) : id;
// D11: the requester is charged when the job ran to its end, budget or time cap; refunded when the failure was the
// lender's (owner stop, provider limit, crash, sandbox failure, lease loss = 'error'). Lent points always count.
export const CHARGED_STOP_REASONS = Object.freeze(['done', 'budget', 'time']);
const requesterOf = r => r && typeof r.circle === 'string' && typeof r.keyId === 'string'
  ? { circle: r.circle.slice(0, 200), keyId: r.keyId.slice(0, 200) } : null;

/**
 * κ priors in window points per priced unit (D3). Unknown plans have none, so the engine says "calibrating".
 * Weekly: Claude Max 20x $20/pt, Max 5x $7/pt (low $/pt protects the owner); Codex Pro 300 credits/pt for GPT-6
 * (measured), 500 for GPT-5 (low end of the measured 500-565).
 * Five-hour and model-scoped Claude windows have no published prior: they assume a week is worth only 5 five-hour
 * blocks, and a scoped week fills twice as fast. Both are guesses chosen to over-estimate each job's share.
 */
export const KAPPA_PRIORS = Object.freeze({
  claude: { max20: { seven_day: 1 / 20 }, max5: { seven_day: 1 / 7 } },
  codex: { pro: { 'codex:10080': { 'gpt-6': 1 / 300, 'gpt-5': 1 / 500 } } },
});
export function kappaPrior(account, plan, windowId, family) {
  const byPlan = KAPPA_PRIORS[account]?.[plan];
  if (!byPlan) return null;
  if (account === 'claude') {
    const week = byPlan.seven_day;
    if (windowId === 'seven_day') return { kappa: week, source: 'prior_' + plan };
    if (windowId === 'five_hour') return { kappa: week * 5, source: 'guess_' + plan + '_5_blocks_per_week' };
    if (/^seven_day_/.test(windowId)) return { kappa: week * 2, source: 'guess_' + plan + '_scoped_week' };
    return null;
  }
  const k = byPlan[windowId]?.[family];
  return Number.isFinite(k) ? { kappa: k, source: 'prior_' + plan + '_' + family } : null;
}

const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_RESET_MS;
const finite = v => Number.isFinite(v);
const empty = () => ({ schema_version: 1, accounts: {}, holds: [], entries: [], reserve_requests: [] });
const accountState = () => ({ series: {}, signal: null, plan: null, plan_since: 0, same_account: { state: 'unknown', observations: [] } });

function validReading(r) {
  return r && typeof r.window_id === 'string' && /^[a-z0-9_:.-]{1,60}$/.test(r.window_id) && finite(r.window_minutes) && r.window_minutes > 0 &&
    finite(r.used_pct) && r.used_pct >= 0 && r.used_pct <= 100 && finite(r.observed_at) && ['open', 'not_open', 'unknown'].includes(r.state) &&
    (r.resets_at === null || finite(r.resets_at));
}

// --- pure helpers (exported for tests and the parent) ---------------------------------------------------------

/** Non-negative least squares, weighted, by projected coordinate descent. rows: [{y, x:{family:units}, w}]. */
export function fitKappa(rows, families) {
  const k = Object.fromEntries(families.map(f => [f, 0]));
  if (!rows.length) return { kappa: k, r2: null };
  for (let iter = 0; iter < 500; iter++) {
    let moved = 0;
    for (const f of families) {
      let num = 0, den = 0;
      for (const r of rows) {
        const xf = r.x[f] ?? 0;
        if (!xf) continue;
        const others = families.reduce((s, g) => g === f ? s : s + k[g] * (r.x[g] ?? 0), 0);
        num += r.w * xf * (r.y - others); den += r.w * xf * xf;
      }
      const next = den > 0 ? Math.max(0, num / den) : 0;
      moved = Math.max(moved, Math.abs(next - k[f]));
      k[f] = next;
    }
    if (moved < 1e-12) break;
  }
  const sw = rows.reduce((s, r) => s + r.w, 0), mean = rows.reduce((s, r) => s + r.w * r.y, 0) / sw;
  const ssTot = rows.reduce((s, r) => s + r.w * (r.y - mean) ** 2, 0);
  const ssRes = rows.reduce((s, r) => s + r.w * (r.y - families.reduce((p, f) => p + k[f] * (r.x[f] ?? 0), 0)) ** 2, 0);
  return { kappa: k, r2: ssTot > 0 ? 1 - ssRes / ssTot : null };
}

/**
 * D0 same-account check over observations {at, guest:[reading], host:[reading]}.
 * 'no' when any observation's weekly (or five-hour) reset differs by more than 60 s, or use differs by more than 2.
 * 'yes' needs two matching observations at least an hour apart whose use moved, by the same amount within 2 points.
 */
export function sameAccountCheck(observations) {
  const weekly = rs => rs?.find(r => r.window_id === 'seven_day' || r.window_id === 'codex:10080');
  const short = rs => rs?.find(r => r.window_id === 'five_hour' || r.window_id === 'codex:300');
  const matched = [];
  for (const o of observations) {
    const g = weekly(o.guest), h = weekly(o.host);
    if (!g || !h || !finite(g.resets_at) || !finite(h.resets_at)) continue;
    if (!sameReset(g.resets_at, h.resets_at) || Math.abs(g.used_pct - h.used_pct) > 2) return 'no';
    const gs = short(o.guest), hs = short(o.host);
    if (gs && hs && finite(gs.resets_at) && finite(hs.resets_at) && !sameReset(gs.resets_at, hs.resets_at)) return 'no';
    matched.push({ at: o.at, g: g.used_pct, h: h.used_pct, reset: g.resets_at });
  }
  for (let i = 0; i < matched.length; i++) for (let j = i + 1; j < matched.length; j++) {
    const a = matched[i], b = matched[j];
    if (Math.abs(b.at - a.at) < HOUR || !sameReset(a.reset, b.reset)) continue;
    const dg = b.g - a.g, dh = b.h - a.h;
    if (Math.abs(dg) >= 1 && Math.abs(dh) >= 1 && Math.abs(dg - dh) <= 2) return 'yes';
  }
  return 'unknown';
}

// --- the ledger ------------------------------------------------------------------------------------------------

export function createLendingLedger({ file, now = Date.now, lockWaitMs = 2000 } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('createLendingLedger needs an absolute file');
  const lockPath = file + '.lock';

  let displayFile = null;
  function displayData() {
    // Writers publish complete generations with durableJson (fsync + rename).
    // A display may see either generation; it never participates in check-and-hold.
    let stat;
    try { stat = fs.statSync(file, {bigint: true}); }
    catch (error) { if (error.code !== 'ENOENT') throw error; displayFile = null; return empty(); }
    const generation = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (displayFile?.generation !== generation) displayFile = {generation, data: load()};
    return displayFile.data;
  }

  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    let data;
    try { data = JSON.parse(text); } catch { throw Object.assign(new Error('Lending ledger is unreadable'), { code: 'ledger_corrupt' }); }
    if (data?.schema_version !== 1 || typeof data.accounts !== 'object' || !Array.isArray(data.holds) || !Array.isArray(data.entries))
      throw Object.assign(new Error('Lending ledger has an unknown format'), { code: 'ledger_corrupt' });
    // Older files did not retain the full admission payload. Preserve all known
    // keys conservatively before entries can be pruned; never invent a binding.
    if (!Object.hasOwn(data, 'reserve_requests')) data.reserve_requests = [];
    if (!Array.isArray(data.reserve_requests) || data.reserve_requests.some(r => !r ||
      typeof r.account !== 'string' || typeof r.attempt_id !== 'string' ||
      !(r.payload === null || typeof r.payload === 'string')))
      throw Object.assign(new Error('Lending ledger has an unknown format'), { code: 'ledger_corrupt' });
    // Also cover partially upgraded files with missing markers for known keys.
    const key = r => JSON.stringify([r.account, r.attempt_id]);
    const known = new Set(data.reserve_requests.map(key));
    for (const row of [...data.holds, ...data.entries]) {
      if (known.has(key(row))) continue;
      data.reserve_requests.push({ account: row.account, attempt_id: row.attempt_id, payload: null });
      known.add(key(row));
    }
    return data;
  }
  function save(data) {
    durableJson(file,data);
  }
  // Every operation is synchronous under the lock, so a check and its hold cannot interleave with another admission,
  // in this process or another one. Read-only calls (write=false) do not save, so their lock skips the directory fsync.
  function locked(fn, write = true) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = performance.now() + lockWaitMs;
    let release;
    for (;;) {
      try { release = acquireProcessLockSync(lockPath, { durable: write }); break; } catch (error) {
        if (error.code !== 'lock_busy' || performance.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const data = load();
      const out = fn(data);
      if (write) save(data);
      return out;
    } finally { release(); }
  }
  const account = (data, id) => {
    if (!knownAccount(id)) throw new TypeError('unknown lending account');
    return data.accounts[id] ??= accountState();
  };
  function prune(data, t) {
    data.entries = data.entries.filter(e => e.ended_at > t - KEEP);
    for (const a of Object.values(data.accounts)) for (const [id, s] of Object.entries(a.series)) {
      a.series[id] = s.filter(r => r.observed_at > t - KEEP).slice(-MAX_SERIES);
    }
  }

  function recordReadingsIn(data, id, readings, signal) {
    const a = account(data, id);
    let added = 0;
    for (const r of readings ?? []) {
      if (!validReading(r)) continue;
      const s = a.series[r.window_id] ??= [];
      const row = { window_id: r.window_id, window_minutes: r.window_minutes, used_pct: r.used_pct, resets_at: r.resets_at,
        observed_at: r.observed_at, state: r.state, source: ['inband', 'probe', 'host', 'import'].includes(r.source) ? r.source : 'inband' };
      if (s.some(x => x.observed_at === row.observed_at && x.used_pct === row.used_pct && x.source === row.source)) continue;
      let i = s.length;
      while (i > 0 && s[i - 1].observed_at > row.observed_at) i--;
      const previous=s[i-1];
      // Account movement outside lent execution catches web, phone and other
      // computers without reading any host session or credential file.
      const overlapsLending=data.holds.some(h=>h.account===id&&h.created_at<=row.observed_at&&h.expires_at>previous?.observed_at)||
        data.entries.some(e=>e.account===id&&e.started_at<=row.observed_at&&e.ended_at>previous?.observed_at);
      if(previous&&row.observed_at>previous.observed_at&&sameReset(previous.resets_at,row.resets_at)&&
        row.used_pct>previous.used_pct&&!overlapsLending)a.owner_active_at=Math.max(a.owner_active_at??0,row.observed_at);
      s.splice(i, 0, row); added++;
      // A new weekly window invalidates the same-account result; it is re-checked each reset (review r2 N6).
      if ((row.window_id === 'seven_day' || row.window_id === 'codex:10080') && Number.isFinite(row.resets_at)) {
        const seen = a.same_account.observations.map(o => o.guest.find(g => g.window_id === row.window_id)?.resets_at).filter(Number.isFinite);
        if (seen.length && !seen.some(r => sameReset(r, row.resets_at)) && row.observed_at >= Math.max(...a.same_account.observations.map(o => o.at))) {
          a.same_account = { state: 'unknown', observations: [], invalidated_at: row.observed_at };
        }
      }
    }
    if (signal && typeof signal === 'object') {
      const at = finite(signal.at) ? signal.at : now(), previous = a.signal ?? {};
      const merged = { ...previous };
      let changed = false;
      for (const field of ['limit_reached', 'using_overage']) {
        // Omission is not a negative observation. Timestamp each field because
        // different sources observe different facts; an unrelated newer field
        // must neither clear this one nor make its later evidence look stale.
        if (typeof signal[field] !== 'boolean') continue;
        const timeKey = field + '_at';
        const priorAt = finite(previous[timeKey]) ? previous[timeKey] : typeof previous[field] === 'boolean' && finite(previous.at) ? previous.at : -Infinity;
        // Conflicting equal-time evidence keeps the affirmative safety signal.
        if (at < priorAt || at === priorAt && signal[field] !== true) continue;
        merged[field] = signal[field]; merged[timeKey] = at; changed = true;
      }
      if (changed) {
        merged.at = Math.max(finite(previous.at) ? previous.at : -Infinity, at);
        a.signal = merged;
      }
    }
    return added;
  }

  // Entries of one account and window that belong to the window instance resetting at `reset`.
  const instanceEntries = (data, id, windowId, reset) =>
    data.entries.filter(e => e.account === id && e.window_id === windowId && sameReset(e.resets_at, reset));

  function lentUntil(entries, t) { return entries.filter(e => e.ended_at <= t).reduce((s, e) => s + e.lent_pts, 0); }

  /** Owner's remaining demand per past complete window, at the current elapsed fraction (D4 F term). */
  function history(data, id, windowId, series, current, t) {
    if (!current || !finite(current.resets_at)) return [];
    const W = current.window_minutes * 60000, e = 1 - (current.resets_at - t) / W;
    const groups = [];
    for (const r of series) {
      if (!finite(r.resets_at) || sameReset(r.resets_at, current.resets_at)) continue;
      const g = groups.find(x => sameReset(x.reset, r.resets_at));
      if (g) g.rows.push(r); else groups.push({ reset: r.resets_at, rows: [r] });
    }
    const out = [];
    groups.sort((a, b) => a.reset - b.reset);
    for (let gi = 0; gi < groups.length; gi++) {
      const { reset, rows } = groups[gi];
      if (reset > t) continue;
      // A window cut short (an early reset or a reset credit) never counts as low demand: skip it.
      const next = groups[gi + 1]?.rows[0] ?? series.find(r => sameReset(r.resets_at, current.resets_at));
      if (next && next.observed_at < reset - HOUR) continue;
      // A reset credit can zero the window without moving resets_at: use never falls by more than rounding otherwise.
      if (rows.some((r, i) => i && r.used_pct < rows[i - 1].used_pct - 2)) continue;
      // A coarse tail would understate late-week demand: any gap over 6 h in the last 48 h excludes the window.
      const tail = rows.filter(r => r.observed_at >= reset - 48 * HOUR).map(r => r.observed_at);
      const points = [reset - 48 * HOUR, ...tail, reset];
      if (!tail.length || points.some((p, i) => i && p - points[i - 1] > 6 * HOUR)) continue;
      const entries = instanceEntries(data, id, windowId, reset);
      const owner = r => Math.max(0, r.used_pct - lentUntil(entries, r.observed_at));
      const at = reset - W + e * W;
      const before = rows.filter(r => r.observed_at <= at).at(-1), after = rows.find(r => r.observed_at >= at);
      if (!before || !after) continue;
      const ownerAt = after.observed_at === before.observed_at ? owner(before)
        : owner(before) + (owner(after) - owner(before)) * (at - before.observed_at) / (after.observed_at - before.observed_at);
      out.push(Math.max(0, owner(rows.at(-1)) - ownerAt));
    }
    return out.slice(-8);
  }

  function provenBorrowedThrough(entries, observedAt) {
    return entries.filter(entry => finite(entry.represented_at) && entry.represented_at <= observedAt &&
      finite(entry.lent_lower_pts) && entry.lent_lower_pts > 0).reduce((sum, entry) => sum + entry.lent_lower_pts, 0);
  }

  function ownerUsedPct(reading, entries) {
    return Math.max(0, reading.used_pct - provenBorrowedThrough(entries, reading.observed_at));
  }

  function maxRate(series, entries, current, t) {
    const anchor = current.resets_at - current.window_minutes * 60000;
    const rows = series.filter(row => row.observed_at >= Math.max(anchor, t - WEEK) && row.observed_at <= t &&
      sameReset(row.resets_at, current.resets_at));
    const points = [{observed_at: anchor, used_pct: 0}, ...rows.map(row => ({observed_at: row.observed_at,
      used_pct: ownerUsedPct(row, entries)}))];
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dt = (b.observed_at - a.observed_at) / HOUR;
      if (dt < 1 / 6) continue;
      best = Math.max(best, (b.used_pct - a.used_pct) / dt);
    }
    return Math.max(0, best);
  }

  /** 6-hour calibration bins for one window: Δ points vs priced units per family (D3). */
  function bins(data, id, windowId, sameAccount) {
    // A plan change resets the fit: only bins after the change count.
    const since = data.accounts[id]?.plan_since ?? 0;
    const series = (data.accounts[id]?.series[windowId] ?? []).filter(r => r.observed_at >= since);
    const entries = data.entries.filter(e => e.account === id && e.window_id === windowId && finite(e.priced_units) && e.priced_units > 0 && e.started_at >= since);
    if (!series.length || !entries.length) return [];
    const out = [];
    const first = Math.floor(series[0].observed_at / BIN) * BIN, last = series.at(-1).observed_at;
    for (let start = first; start < last; start += BIN) {
      const end = start + BIN;
      const before = series.filter(r => r.observed_at <= start && r.observed_at > start - 2 * HOUR).at(-1);
      const inside = series.filter(r => r.observed_at > start && r.observed_at <= end);
      const close = inside.at(-1);
      if (start < since || !before || !close || close.observed_at < end - 2 * HOUR || !inside.every(r => sameReset(r.resets_at, before.resets_at))) continue;
      const x = {};
      for (const e of entries) {
        const overlap = Math.max(0, Math.min(end, e.ended_at) - Math.max(start, e.started_at));
        const span = Math.max(1, e.ended_at - e.started_at);
        if (overlap > 0 || e.ended_at === e.started_at && e.ended_at > start && e.ended_at <= end)
          x[e.family] = (x[e.family] ?? 0) + e.priced_units * (overlap > 0 ? overlap / span : 1);
      }
      if (!Object.keys(x).length) continue;
      // Without a same-account host signal, a bin counts only when every movement happened while a lent job ran.
      if (sameAccount !== 'yes') {
        const pts = [before, ...inside];
        const unexplained = pts.some((r, i) => i && r.used_pct !== pts[i - 1].used_pct &&
          !entries.some(e => e.started_at < r.observed_at && e.ended_at + 10 * 60000 > pts[i - 1].observed_at));
        if (unexplained) continue;
      }
      out.push({ start, delta_pct: close.used_pct - before.used_pct, units: x });
    }
    return out;
  }

  function calibrationIn(data, id, windowId, { plan = 'unknown', t = now() } = {}) {
    const a = data.accounts[id];
    const rows = bins(data, id, windowId, a?.same_account?.state ?? 'unknown');
    const families = [...new Set(rows.flatMap(r => Object.keys(r.units)))];
    const halfLife = 2 * WEEK;
    const fit = rows.length >= 10 ? fitKappa(rows.map(r => ({ y: r.delta_pct, x: r.units, w: 0.5 ** ((t - r.start) / halfLife) })), families) : null;
    return { window_id: windowId, bins: rows.length, r2: fit?.r2 ?? null, fitted: fit ? fit.kappa : {}, plan,
      kappa_for: family => {
        if (fit && fit.kappa[family] > 0) return { kappa: fit.kappa[family], source: 'fit' };
        return kappaPrior(providerOf(id), plan, windowId, family);
      } };
  }

  // Returns true when the declared plan changed (the caller must then save).
  function notePlan(data, id, plan, t) {
    const a = account(data, id);
    if (a.plan === plan) return false;
    if (a.plan !== null) a.plan_since = t;
    a.plan = plan;
    return true;
  }

  function snapshotIn(data, id, { plan = 'unknown', model = null, t = now() } = {}) {
    const a = data.accounts[id] ?? accountState();
    const family = modelFamily(providerOf(id), model ?? data.entries.filter(e => e.account === id).at(-1)?.model ?? (providerOf(id) === 'codex' ? 'gpt-6' : null));
    const windows = [];
    for (const [windowId, series] of Object.entries(a.series)) {
      const latest = series.at(-1);
      if (!latest) continue;
      let state = latest.state;
      if (state === 'open' && !(latest.resets_at > t)) state = 'unknown';
      // `not_open` stands only on a fresh probe; otherwise the window is unknown (D2).
      if (state === 'not_open' && !(latest.source === 'probe' && t - latest.observed_at < FRESH_PROBE_MS)) state = 'unknown';
      const reset = latest.resets_at;
      const entries = state === 'open' ? instanceEntries(data, id, windowId, reset) : [];
      const reserved = data.holds.filter(h => h.account === id).flatMap(h => h.windows)
        .filter(w => w.window_id === windowId && (state !== 'open' || sameReset(w.resets_at, reset))).reduce((s, w) => s + w.est_pts, 0);
      const k = calibrationIn(data, id, windowId, { plan, t }).kappa_for(family);
      const ownerUsed = ownerUsedPct(latest, entries);
      windows.push({ window_id: windowId, window_minutes: latest.window_minutes, used_pct: latest.used_pct, owner_used_pct: ownerUsed, resets_at: reset,
        observed_at: latest.observed_at, state, source: latest.source, kappa: k?.kappa ?? null, kappa_source: k?.source ?? null,
        lent_pct: entries.reduce((s, e) => s + e.lent_pts, 0), reserved_pct: reserved,
        lent_last_hour_pct: data.entries.filter(e => e.account === id && e.window_id === windowId && e.ended_at > t - HOUR).reduce((s, e) => s + e.lent_pts, 0),
        history: state === 'open' ? history(data, id, windowId, series, latest, t) : [],
        max_rate_pct_per_hour: maxRate(series, entries, latest, t) });
    }
    const weekly = a.series.seven_day ?? a.series['codex:10080'] ?? [];
    const samples = weekly.filter(r => finite(r.resets_at)).map(r => ({ at: r.observed_at, resets_at: r.resets_at, window_minutes: r.window_minutes,
      owner_pct: Math.max(0, r.used_pct - lentUntil(instanceEntries(data, id, r.window_id, r.resets_at), r.observed_at)), source: r.source }));
    const observed = windows.map(w => w.observed_at);
    return { account: id, provider: id, plan, family, same_account: a.same_account.state, windows,
      owner_active_at: a.owner_active_at??null, read_at: observed.length ? Math.max(...observed) : null, signal: a.signal, history: samples,
      holds: data.holds.filter(h => h.account === id).length };
  }

  function charge(data, hold, { metered = null, started_at, ended_at, stop_reason = 'done', owner_active = false, recovered = false }) {
    const units = finite(metered?.priced_units) ? metered.priced_units : null;
    const startedAt = finite(started_at) ? started_at : hold.created_at, endedAt = finite(ended_at) ? Math.max(ended_at, startedAt) : now();
    const a = data.accounts[hold.account] ?? accountState();
    const entries = [];
    const overlapped = owner_active || data.entries.some(e => e.account === hold.account && e.reservation_id !== hold.id &&
      e.started_at < endedAt && e.ended_at > startedAt) || data.holds.some(h => h.account === hold.account && h.id !== hold.id && h.created_at < endedAt);
    for (const w of hold.windows) {
      const series = a.series[w.window_id] ?? [];
      const before = series.filter(r => r.observed_at <= startedAt).at(-1);
      const after = series.find(r => r.observed_at >= endedAt);
      const base = { reservation_id: hold.id, account: hold.account, window_id: w.window_id, job_digest: hold.job_digest, attempt_id: hold.attempt_id,
        started_at: startedAt, ended_at: endedAt, stop_reason, unit: metered?.unit ?? hold.unit, model: metered?.model ?? hold.model,
        family: metered?.family ?? hold.family, requester: hold.requester ?? null, tokens: metered?.tokens ?? null, list_usd_micros: metered?.list_usd_micros ?? null,
        catalog_rev: metered?.catalog_rev ?? null, kappa: w.kappa ?? null, est_pts: w.est_pts, recovered };
      const estimate = share => units !== null && finite(w.kappa) ? units * share * w.kappa : null;
      if (recovered || units === null) {
        // Spent is spent (D11): an unmeasured job keeps its whole reservation as lent use.
        entries.push({ ...base, resets_at: w.resets_at, priced_units: units, delta_pct: null, attribution: 'unknown',
          represented_at: null, lent_pts: w.est_pts, lent_lower_pts: 0 });
        continue;
      }
      const resetDuring = finite(w.resets_at) && w.resets_at > startedAt && w.resets_at < endedAt ||
        before && after && finite(before.resets_at) && finite(after.resets_at) && !sameReset(before.resets_at, after.resets_at);
      if (resetDuring) {
        // A reset seen mid-job splits the job across the two window instances, by time.
        const cut = finite(w.resets_at) && w.resets_at > startedAt && w.resets_at < endedAt ? w.resets_at : before?.resets_at ?? endedAt;
        const share = Math.max(0, Math.min(1, (cut - startedAt) / Math.max(1, endedAt - startedAt)));
        const lastOld = series.filter(r => r.observed_at <= cut && sameReset(r.resets_at, before?.resets_at)).at(-1);
        const oldDelta = before && lastOld ? lastOld.used_pct - before.used_pct : null;
        const newDelta = after && !sameReset(after.resets_at, before?.resets_at) ? after.used_pct : null;
        for (const [part, reset, delta] of [[share, before?.resets_at ?? w.resets_at, oldDelta],
          [1 - share, after?.resets_at ?? null, newDelta]]) {
          const est = estimate(part);
          entries.push({ ...base, resets_at: reset, priced_units: units === null ? null : units * part, units_share: part, delta_pct: delta,
            attribution: 'reset_split', represented_at: null, lent_pts: Math.max(0, est ?? delta ?? w.est_pts * part), lent_lower_pts: 0 });
        }
        continue;
      }
      const delta = before && after && sameReset(before.resets_at, after.resets_at) ? after.used_pct - before.used_pct : null;
      // Exact movement belongs only to an exclusive observation interval (before, after].
      // Unsettled holds have no proven end, even after expiry. Settled execution, or an
      // earlier claim whose aggregate proof extends into this interval, makes it shared.
      // Shared intervals assign no observed burn: retain estimates with zero lower bound.
      // Adjacent intervals may share an endpoint, but not the movement between endpoints.
      const sharedBracket = before && after && (
        data.holds.some(h => h.account === hold.account && h.id !== hold.id && h.created_at < after.observed_at) ||
        data.entries.some(e => e.account === hold.account && e.reservation_id !== hold.id &&
          (e.started_at < after.observed_at && e.ended_at > before.observed_at ||
            e.window_id === w.window_id && sameReset(e.resets_at, before.resets_at) &&
            finite(e.represented_at) && e.represented_at > before.observed_at)));
      const attribution = delta === null ? 'unknown' : overlapped || sharedBracket ? 'overlapped' : Math.abs(delta) < 2 ? 'below_resolution' : 'exact';
      const est = estimate(1);
      // Never fall back to the shared aggregate delta, even when no kappa is known.
      const lent = attribution === 'exact' ? delta : est ?? (sharedBracket ? w.est_pts : delta ?? w.est_pts);
      // Missing attribution is not zero usage. Throw before locked() saves: this
      // retains every hold and reading, even if an earlier window/hold was charged
      // in this transaction. The caller can retry with independent evidence.
      if (sharedBracket && units > 0 && !(finite(lent) && lent > 0)) {
        throw Object.assign(new Error('Shared metered usage has unresolved attribution'), {
          code: 'unresolved_attribution', reservation_id: hold.id, window_id: w.window_id,
        });
      }
      entries.push({ ...base, resets_at: before?.resets_at ?? w.resets_at, priced_units: units, delta_pct: delta, attribution,
        represented_at: after?.observed_at ?? null, lent_pts: Math.max(0, lent),
        lent_lower_pts: attribution === 'exact' ? Math.max(0, delta) : 0 });
    }
    // A job admitted with no known window (manual "Run it" while the allowance is unknown) still keeps its metered usage
    // in one unwindowed entry. It carries no points, so it never moves %, history or calibration.
    if (!hold.windows.length) entries.push({ reservation_id: hold.id, account: hold.account, window_id: 'unknown', resets_at: null,
      job_digest: hold.job_digest, attempt_id: hold.attempt_id, started_at: startedAt, ended_at: endedAt, stop_reason,
      unit: metered?.unit ?? hold.unit, model: metered?.model ?? hold.model, family: metered?.family ?? hold.family, requester: hold.requester ?? null,
      tokens: metered?.tokens ?? null, priced_units: units, list_usd_micros: metered?.list_usd_micros ?? null, catalog_rev: metered?.catalog_rev ?? null,
      kappa: null, est_pts: 0, delta_pct: null, attribution: 'unwindowed', represented_at: null,
      lent_pts: 0, lent_lower_pts: 0, recovered });
    data.holds = data.holds.filter(h => h.id !== hold.id);
    data.entries.push(...entries);
    return entries;
  }

  return {
    file,
    /** Store readings (validated lending-meter Reading objects) and an optional in-band signal {limit_reached, using_overage, at}. */
    recordReadings(id, readings, { signal = null } = {}) {
      return locked(data => { const added = recordReadingsIn(data, id, readings, signal); prune(data, now()); return { added }; });
    },
    // A status read must not update the saved plan or create ledger state.
    snapshotReadOnly(id, {plan = 'unknown', model = null} = {}) {
      if (!knownAccount(id)) throw new TypeError('unknown lending account');
      return locked(data => snapshotIn(data, id, {plan, model}), false);
    },
    // Display-only parsing cache. Admission callers must use snapshot/snapshotReadOnly.
    snapshotForDisplay(id, {plan = 'unknown', model = null} = {}) {
      if (!knownAccount(id)) throw new TypeError('unknown lending account');
      return structuredClone(snapshotIn(displayData(), id, {plan, model}));
    },
    /** The policy engine's input for one account. `plan` is the owner's declared plan (policy.accountPlans). */
    snapshot(id, { plan = 'unknown', model = null } = {}) {
      if (!knownAccount(id)) throw new TypeError('unknown lending account');
      let changed = false;
      const out = locked(data => { changed = notePlan(data, id, plan, now()); return snapshotIn(data, id, { plan, model }); }, false);
      if (changed) locked(data => { notePlan(data, id, plan, now()); });
      return out;
    },
    /**
     * Atomic check-and-hold. `admit(windows)` runs under the lock with current reserved_pct included and must return
     * true to hold. The hold reserves budget_units x κ points in every open window (D4 "Reservations").
     */
    reserve({ account: id, job_digest, attempt_id, budget_units, unit, model = null, plan = 'unknown', requester = null, max_requester_pct = null,
      ttl_ms = 2 * HOUR, admit = () => true }) {
      if (!finite(budget_units) || budget_units <= 0) throw new TypeError('budget_units must be positive');
      if (typeof job_digest !== 'string' || typeof attempt_id !== 'string') throw new TypeError('job_digest and attempt_id are required');
      return locked(data => {
        const t = now(), who = requesterOf(requester);
        // Bind the job's own request fields. Plan, model, requester cap and TTL are lender settings or observations that a
        // retry or restart may recompute; a change in them reuses the live hold instead of orphaning it.
        const payload = JSON.stringify([job_digest, budget_units, unit, who]);
        const prior = data.reserve_requests.find(r => r.account === id && r.attempt_id === attempt_id);
        const existing = data.holds.find(h => h.account === id && h.attempt_id === attempt_id);
        if (prior) {
          const windows = snapshotIn(data, id, { plan, model, t }).windows;
          if (!existing) return { ok: false, reason: 'reservation_closed', windows };
          if (prior.payload !== payload) return { ok: false, reason: 'reservation_conflict', windows };
          return { ok: true, reservation: existing, windows };
        }
        notePlan(data, id, plan, t);
        const snap = snapshotIn(data, id, { plan, model, t });
        if (admit(snap.windows) !== true) return { ok: false, reason: 'not_admitted', windows: snap.windows };
        const windows = snap.windows.filter(w => w.state !== 'unknown').map(w => ({ window_id: w.window_id, resets_at: w.resets_at,
          kappa: w.kappa, est_pts: finite(w.kappa) ? budget_units * w.kappa : 0 }));
        // Per-person ceiling (D14): charged points this window + this person's holds + this job's reservation.
        if (finite(max_requester_pct) && who) {
          for (const w of windows) {
            const charged = data.entries.filter(e => e.account === id && e.window_id === w.window_id && sameReset(e.resets_at, w.resets_at) &&
              e.requester?.circle === who.circle && e.requester?.keyId === who.keyId && CHARGED_STOP_REASONS.includes(e.stop_reason)).reduce((x, e) => x + e.lent_pts, 0);
            const held = data.holds.filter(h => h.account === id && h.requester?.circle === who.circle && h.requester?.keyId === who.keyId)
              .flatMap(h => h.windows).filter(x => x.window_id === w.window_id && sameReset(x.resets_at, w.resets_at)).reduce((x, y) => x + y.est_pts, 0);
            if (charged + held + w.est_pts > max_requester_pct) return { ok: false, reason: 'requester_limit', window_id: w.window_id, windows: snap.windows };
          }
        }
        const hold = { id: randomUUID(), account: id, job_digest, attempt_id, budget_units, unit, model, family: snap.family, requester: who,
          created_at: t, expires_at: t + ttl_ms, windows };
        data.holds.push(hold);
        // Kept permanently, including release without charge and history pruning.
        data.reserve_requests.push({ account: id, attempt_id, payload });
        return { ok: true, reservation: hold, windows: snapshotIn(data, id, { plan, model, t }).windows };
      });
    },
    /** Replace a hold by its measured, attributed entries. Idempotent: a reconciled id returns its entries. */
    reconcile(reservationId, outcome = {}) {
      return locked(data => {
        const hold = data.holds.find(h => h.id === reservationId);
        if (!hold) return { entries: data.entries.filter(e => e.reservation_id === reservationId), already: true };
        // Accepted but the agent never started (clone or sandbox failed before start): nothing was spent.
        if (outcome.started === false) { data.holds = data.holds.filter(h => h.id !== hold.id); return { entries: [], released: true }; }
        return { entries: charge(data, hold, outcome) };
      });
    },
    /**
     * Settle the hold of one attempt after the lender has proven the attempt ended (e.g. pending sandbox recovery).
     * started:false releases it with no charge. Otherwise, without `metered`, the full reservation is charged with
     * stop_reason 'error' (spent is spent, D11); with `metered`, the normal attribution applies.
     * Idempotent: a settled attempt returns what was recorded and charges nothing more. Expired holds are settled too.
     */
    reconcileAttempt(attemptId, outcome = {}) {
      if (typeof attemptId !== 'string' || !attemptId) throw new TypeError('attempt id is required');
      return locked(data => {
        const holds = data.holds.filter(h => h.attempt_id === attemptId && (!outcome.account || h.account === outcome.account));
        if (!holds.length) {
          const entries = data.entries.filter(e => e.attempt_id === attemptId && (!outcome.account || e.account === outcome.account));
          return { entries, already: true, attempt_id: attemptId };
        }
        if (outcome.started === false) {
          data.holds = data.holds.filter(h => !holds.includes(h));
          return { entries: [], released: true, attempt_id: attemptId };
        }
        const entries = [];
        for (const h of holds) entries.push(...(outcome.metered
          ? charge(data, h, outcome)
          : charge(data, h, { stop_reason: 'error', recovered: true, ended_at: now() })));
        return { entries, attempt_id: attemptId };
      });
    },
    /** After a crash: holds whose attempt is not live, or that expired, are charged at their full reservation. */
    recover({ liveAttemptIds = null } = {}) {
      return locked(data => {
        const t = now(), live = liveAttemptIds ? new Set(liveAttemptIds) : null;
        const orphans = data.holds.filter(h => h.expires_at <= t || live && !live.has(h.attempt_id));
        for (const h of orphans) charge(data, h, { stop_reason: 'error', recovered: true, ended_at: t });
        return { recovered: orphans.map(h => h.attempt_id) };
      });
    },
    /** Record one same-account observation (guest and host readings at one moment). Host readings are the caller's, gated. */
    recordSameAccount(id, { at = now(), guest = [], host = [] } = {}) {
      return locked(data => {
        const a = account(data, id);
        const keep = r => validReading(r) ? { window_id: r.window_id, used_pct: r.used_pct, resets_at: r.resets_at } : null;
        const obs = { at, guest: guest.map(keep).filter(Boolean), host: host.map(keep).filter(Boolean) };
        // Re-checked each reset (review r2 N6): only observations of the current weekly window are kept.
        const weekly = rs => rs.find(r => r.window_id === 'seven_day' || r.window_id === 'codex:10080')?.resets_at;
        const reset = weekly(obs.guest);
        a.same_account.observations = [...a.same_account.observations.filter(o => sameReset(weekly(o.guest), reset)), obs].slice(-24);
        a.same_account.state = sameAccountCheck(a.same_account.observations);
        a.same_account.checked_at = at;
        return a.same_account.state;
      });
    },
    calibration(id, windowId, { plan = 'unknown', model = null } = {}) {
      return locked(data => {
        notePlan(data, id, plan, now());
        const c = calibrationIn(data, id, windowId, { plan });
        const family = modelFamily(id, model);
        return { window_id: windowId, bins: c.bins, r2: c.r2, fitted: c.fitted, family, ...(c.kappa_for(family) ?? { kappa: null, source: null }) };
      });
    },
    /**
     * One requester's use of this lender, per account and window instance (current instances only unless `since`).
     * lent_pts: all points their jobs used. charged_pts: only the outcomes charged to them (CHARGED_STOP_REASONS).
     */
    requesterUsage(requester, { account: only = null, since = null } = {}) {
      const who = requesterOf(requester);
      if (!who) throw new TypeError('requester needs circle and keyId');
      return locked(data => {
        const t = now(), rows = {};
        for (const id of only ? [only] : ACCOUNTS) {
          const current = Object.fromEntries(Object.entries(data.accounts[id]?.series ?? {}).map(([w, s]) => [w, s.at(-1)?.resets_at]));
          for (const e of data.entries) {
            if (e.account !== id || e.requester?.circle !== who.circle || e.requester?.keyId !== who.keyId) continue;
            if (since !== null ? e.ended_at < since : !(sameReset(e.resets_at, current[e.window_id]) && current[e.window_id] > t)) continue;
            const key = id + '/' + e.window_id, row = rows[key] ??= { account: id, window_id: e.window_id, resets_at: e.resets_at, lent_pts: 0, charged_pts: 0, jobs: 0 };
            row.lent_pts += e.lent_pts; row.jobs += 1;
            if (CHARGED_STOP_REASONS.includes(e.stop_reason)) row.charged_pts += e.lent_pts;
          }
        }
        return Object.values(rows);
      }, false);
    },
    /** Local lender record for one job (never leaves the machine). */
    entries(filter = {}) {
      const match = (e, k, v) => k === 'circle' || k === 'keyId' ? e.requester?.[k] === v : e[k] === v;
      return locked(data => data.entries.filter(e => Object.entries(filter).every(([k, v]) => match(e, k, v))), false);
    },
  };
}
