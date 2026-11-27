import {durableJson} from '../durable-write.mjs';
import {RESET_JITTER_MS} from './quota-registry.mjs';
export {RESET_JITTER_MS};
// The durable record of who opened each short window. A window a lent attempt opened is recorded as lending. A window is
// recorded as owner-opened when the owner attests it, with who and when, for a window the lender has seen open recently, or
// when the lender sees it open with no lent opening confirmed for it and no lent attempt live: the lender admits only into a
// window already open, so a window that opens while no lent attempt runs was opened by the owner's own use of the account.
// That record says it was inferred. While a lent attempt is live, nothing is inferred, because the attempt may open a window
// (a pending opening, or a run past its window's reset). A wrong inference fails closed: lending's use in a window it did not
// open is never settled from the meter, so its holds stay whole. Records are keyed by the window instance (its
// canonical reset), so a reset starts a new instance with no inherited record. A window that opened while a lent job held a
// reservation made before it opened (a cold window) is recorded as unknown: the job or the owner may have used it first, and
// nothing tells which. It is never inferred as the owner's; the owner may still attest it. Every observation reconciles the file: instances
// that have reset are pruned. An unreadable file yields no origin, and it is never overwritten, because its records are unknown.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE = 'window-origin.json';
const INFERRED = 'no_lent_opening';
const ORIGINS = ['owner', 'lending', 'unknown'];
const COLD_BOUND = 'cold_reservation_bound';
const SHORT_MAX_MINUTES = 300; // a window longer than five hours is the weekly kind, as in the source
// The owner may attest only a window the lender saw open within this long before the attestation.
export const SEEN_WITHIN_MS = 10 * 60 * 1000;
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));
// This fallback key matches the source's provisional floor; active resources may align to a saved instance before origin lookup.
const wholeSecond = (ms) => Math.floor(ms / 1000) * 1000;
export const instanceOf = (windowId, resetsAt) => `${windowId}@${wholeSecond(toMs(resetsAt))}`;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isOpenShort = (window) => window?.state === 'open' && Number.isFinite(window.window_minutes) && window.window_minutes > 0 &&
  window.window_minutes <= SHORT_MAX_MINUTES;

export function createWindowOriginStore({directory}) {
  const path = join(directory, FILE);
  // The state, or null when the file exists and cannot be trusted. A missing file is an empty state.
  const read = () => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return error?.code === 'ENOENT' ? {records: [], seen: []} : null;
    }
    const valid = parsed?.version === 1 && Array.isArray(parsed.records) && parsed.records.every((r) =>
      typeof r?.instance === 'string' && ORIGINS.includes(r.origin) && Number.isFinite(r.resets_at));
    if (!valid) return null;
    // An owner record counts only with the owner's attestation or the lender's inference. Records written by the old default
    // have neither, so they are unknown.
    const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((s) => typeof s?.instance === 'string' && Number.isFinite(s.seen_at)) : [];
    return {records: parsed.records.filter((r) => r.origin !== 'owner' || nonempty(r.attested_by) || r.inferred === INFERRED), seen};
  };
  const write = (records, seen) => {
    durableJson(path, {version: 1, records, seen});
  };
  const seenOpenFrom = (state, now, maxAgeMs) => state.seen
    .filter((s) => now - s.seen_at <= maxAgeMs && s.resets_at > now)
    .map((s) => ({instance: s.instance, window_id: s.window_id, window_minutes: s.window_minutes, state: 'open',
      resets_at: s.resets_at, observed_at: s.seen_at}));
  return {
    // The origin recorded for one window instance, or null when none is recorded or the file cannot be trusted.
    originFor(instance) {
      const state = read();
      return state?.records.find((r) => r.instance === instance)?.origin ?? null;
    },
    // The records, and the open short windows the lender saw recently: the only windows the owner can attest.
    snapshot({now, maxAgeMs = SEEN_WITHIN_MS}) {
      const state = read();
      if (state === null) throw new Error('unreadable_window_origin: the records cannot be read');
      return {records: state.records, seen: seenOpenFrom(state, now, maxAgeMs)};
    },
    // Records a lending opening for each open short window a lent attempt opened, notes every open short window seen now, reconciles
    // away reset instances, and persists. With `lentAttemptLive` false, an open short window with no lent opening is recorded as
    // the owner's, inferred. A caller that does not say whether a lent attempt is live infers nothing.
    observeOpen({windows = [], lendingInstances = [], unknownWindows = [], lentAttemptLive = true, now}) {
      const state = read();
      if (state === null) throw new Error('unreadable_window_origin: refusing to overwrite records whose contents are unknown');
      const lending = new Set(lendingInstances);
      const records = state.records.filter((r) => r.resets_at > now);
      const seen = [];
      for (const window of windows) {
        if (!isOpenShort(window)) continue;
        const instance = instanceOf(window.window_id, window.resets_at);
        seen.push({instance, window_id: window.window_id, window_minutes: window.window_minutes,
          resets_at: wholeSecond(toMs(window.resets_at)), seen_at: now});
        const at = records.findIndex((r) => r.instance === instance);
        const base = {instance, window_id: window.window_id, resets_at: wholeSecond(toMs(window.resets_at)), recorded_at: now};
        // A confirmed lent opening outranks an inference; an owner's attestation is never replaced.
        const reset = wholeSecond(toMs(window.resets_at));
        const unknown = unknownWindows.some((u) => u?.window_id === window.window_id && Number.isFinite(u.resets_at) &&
          Math.abs(u.resets_at - reset) <= RESET_JITTER_MS);
        if (lending.has(instance)) {
          if (at === -1) records.push({...base, origin: 'lending'});
          else if (records[at].inferred === INFERRED) records[at] = {...base, origin: 'lending'};
        } else if (unknown) {
          if (at === -1 || records[at].inferred === INFERRED) records[at === -1 ? records.length : at] = {...base, origin: 'unknown', reason: COLD_BOUND};
        } else if (at === -1 && lentAttemptLive === false) {
          records.push({...base, origin: 'owner', inferred: INFERRED});
        }
      }
      write(records, seen);
      return records;
    },
    // The open short windows the lender has seen within the window of time, for the owner to choose from.
    seenOpen({now, maxAgeMs = SEEN_WITHIN_MS}) {
      const state = read();
      if (state === null) throw new Error('unreadable_window_origin: the records cannot be read');
      return seenOpenFrom(state, now, maxAgeMs);
    },
    // The owner's affirmative attestation that they opened this window. It is refused for an instance that is not open short
    // now, without a named owner and reason, and over a lending record. It is audited on the record: who, why, and when.
    attestOwnerOpening({windows = [], instance, by, reason, now}) {
      if (!nonempty(by) || !nonempty(reason) || !Number.isFinite(now)) throw new Error('origin_attestation_invalid: an owner, a reason and a time are required');
      const state = read();
      if (state === null) throw new Error('unreadable_window_origin: refusing to overwrite records whose contents are unknown');
      const window = windows.find((w) => isOpenShort(w) && instanceOf(w.window_id, w.resets_at) === instance);
      if (!window) throw new Error('origin_attestation_invalid: the window is not open short now');
      const records = state.records.filter((r) => r.resets_at > now);
      const existing = records.find((r) => r.instance === instance);
      if (existing?.origin === 'lending') throw new Error('origin_attestation_conflict: a lent attempt opened this window');
      if (existing?.origin === 'owner' && existing.inferred !== INFERRED) return records;
      // An attestation replaces an inference, so a later lent opening can no longer replace it.
      const attested = {instance, window_id: window.window_id, origin: 'owner', resets_at: wholeSecond(toMs(window.resets_at)),
        recorded_at: now, attested_by: by, attested_at: now, attested_reason: reason};
      write([...records.filter((r) => r !== existing), attested], state.seen);
      return [...records.filter((r) => r !== existing), attested];
      return records;
    },
  };
}

// The origin for each resource, keyed by resource id, as the pace source takes it.
export function originMapFor(store, resources) {
  return new Map(resources.map((resource) => [resource.id, store.originFor(resource.instance)]));
}
