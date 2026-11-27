import { fault, ok } from './accounts.mjs';

const initial = () => ({ reading: null, jobReadings: [], events: {}, meters: {}, pending: {},
  windowHistory: [], lastAttemptAtMs: null, nextReadAtMs: null, state: 'unavailable', limitResetAtMs: null, failures: 0, readLease: null });
const readers = new Map();
// Saved utilization observations: one point per window, spaced far enough apart that adjacent points
// measure a real burn rate, pruned to a week. They are the account's own saved usage history, the rows
// its lending estimate is calibrated from (lagBoundsFor), so a read account stops assuming cold start.
const OBSERVATION_SPACING_MS = 25 * 60000, OBSERVATION_HISTORY_MS = 7 * 86400000, OBSERVATION_MAX_ROWS = 2048;
function rememberWindowObservations(usage, reading, nowMs) {
  usage.windowHistory ??= [];
  if (!Array.isArray(usage.windowHistory)) usage.windowHistory = [];
  const newest = new Map();
  for (const row of usage.windowHistory) {
    const key = row.id + '\u0000' + row.instance;
    if (!newest.has(key) || row.atMs > newest.get(key).atMs) newest.set(key, row);
  }
  for (const w of reading.windows) {
    const last = newest.get(w.id + '\u0000' + w.instance);
    if (last && reading.observedAtMs - last.atMs < OBSERVATION_SPACING_MS) continue;
    const row = {id: w.id, instance: w.instance, atMs: reading.observedAtMs, points: w.usedHiMicro / 1000000};
    usage.windowHistory.push(row);
    newest.set(row.id + '\u0000' + row.instance, row);
  }
  usage.windowHistory = usage.windowHistory.filter(row => nowMs - row.atMs <= OBSERVATION_HISTORY_MS).slice(-OBSERVATION_MAX_ROWS);
}
/** The saved observations as owner-history rows for the lending accounting: one trace per window, newest last. */
export function windowHistoryRows(usage, nowMs) {
  const byWindow = new Map();
  for (const row of Array.isArray(usage?.windowHistory) ? usage.windowHistory : []) {
    if (!Number.isFinite(row?.atMs) || !Number.isFinite(row?.points) || row.atMs > nowMs || typeof row.id !== 'string') continue;
    const key = row.id + '\u0000' + (row.instance ?? null);
    if (!byWindow.has(key)) byWindow.set(key, []);
    byWindow.get(key).push([row.atMs, row.points]);
  }
  return [...byWindow].map(([key, trace]) => ({window_id: key.split('\u0000')[0], trace: trace.sort((a, b) => a[0] - b[0])}));
}
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ?
  Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
// Applications use broker.getAccountUsage; this optional explicit registry has no
// implicit host/store discovery and is useful for consumers of the frozen facade.
export function getAccountUsage(accountId) {
  if (!readers.has(accountId)) throw Object.assign(new Error('account_not_found'), fault('account_not_found', accountId).error);
  return readers.get(accountId);
}
export function createAccountUsage({ accountId, store, broker, adapter, clock = Date.now,
  running = () => false, enabled = () => true }) {
  let cached = store.get(accountId)?.usage ?? initial(), inFlight, closed = false;
  const lifetime = new AbortController();
  const listeners = new Set();
  const read = () => store.get(accountId)?.usage ?? initial();
  const save = async fn => store.transaction(state => {
    const record = state.records[accountId];
    if (!record) return;
    record.usage ??= initial();
    fn(record.usage, record);
    cached = structuredClone(record.usage);
  });
  const emit = () => { for (const listener of listeners) { try { listener(api.snapshot(clock())); } catch { /* consumer owns listener */ } } };
  function snapshot(nowMs) {
    cached = read();
    const value = { schemaVersion: 1, accountId, reading: cached.reading, jobReadings: cached.jobReadings,
      ageMs: cached.reading ? Math.max(0, nowMs - cached.reading.observedAtMs) : null,
      lastAttemptAtMs: cached.lastAttemptAtMs, nextReadAtMs: cached.nextReadAtMs,
      state: cached.state, limitResetAtMs: cached.limitResetAtMs };
    if (value.state === 'limit' && value.limitResetAtMs !== null && nowMs >= value.limitResetAtMs) {
      value.state = 'unavailable'; value.limitResetAtMs = null;
    }
    return structuredClone(value);
  }
  async function performRead() {
    if (closed || adapter.descriptor.usageKind !== 'remote') return snapshot(clock());
    // The account effect lock serializes with rotation/removal. A durable lease
    // survives a dead reader, while the kernel lock releases on process death.
    let claimed = false, generation;
    await store.exclusive(accountId, async () => {
      await save((usage, account) => {
        const now = clock();
        if (usage.nextReadAtMs !== null && now < usage.nextReadAtMs) return;
        if (usage.readLease?.expiresAtMs > now) return;
        if (!enabled() && !running()) return;
        generation = account.generation;
        usage.lastAttemptAtMs = now;
        usage.nextReadAtMs = now + (running() ? 120000 : 300000);
        usage.readLease = { generation, expiresAtMs: now + 60000 };
        claimed = true;
      });
    });
    if (!claimed) return snapshot(clock());
    let outcome;
    try {
      const auth = await broker.withAuth(accountId, async auth => {
        generation = auth.generation;
        // Persist generation after lazy refresh before issuing the GET.
        await save(usage => { if (usage.readLease) usage.readLease.generation = generation; });
        return adapter.readUsage({ auth, signal: lifetime.signal });
      });
      outcome = auth.ok ? auth.value : { kind: 'unavailable', code: auth.error.code };
    } catch { outcome = { kind: 'unavailable', code: 'transport_error' }; }
    await save((usage, account) => {
      usage.readLease = null;
      const now = clock();
      // Rate limits belong to the account, not the credential generation.
      if (outcome.kind === 'throttled') {
        usage.failures++;
        const fallback = now + Math.min(3600000, 300000 * 2 ** Math.min(usage.failures - 1, 4));
        const retryAt = Number.isSafeInteger(outcome.retryAtMs) && outcome.retryAtMs >= now
          ? outcome.retryAtMs : fallback;
        usage.nextReadAtMs = Math.max(usage.nextReadAtMs ?? 0, retryAt);
        usage.state = 'backoff';
      }
      if (account.generation !== generation) return;
      // A scheduled read that proved this generation's subject retires the pending identity verification
      // from a renewed sign-in whose profile read was throttled.
      if (outcome.subjectVerified === true && account.subjectVerificationPending === true) delete account.subjectVerificationPending;
      switch (outcome.kind) {
        case 'reading': {
          const r = outcome.reading;
          if (!validReading(r, accountId, now) || (usage.reading && r.sequence <= usage.reading.sequence)) {
            usage.state = 'unavailable'; break;
          }
          usage.reading = structuredClone(r); usage.state = 'ready'; usage.failures = 0; usage.limitResetAtMs = null;
          rememberWindowObservations(usage, r, now);
          break;
        }
        case 'throttled': break; // Account-wide backoff was persisted above.
        case 'limit': usage.state = 'limit'; usage.limitResetAtMs = outcome.resetAtMs; break;
        case 'signed_out': usage.state = 'signed_out'; account.authState = 'signed_out'; break;
        default: usage.state = 'unavailable';
      }
    });
    if (outcome.kind === 'auth_expired' && store.get(accountId)?.generation === generation) {
      await broker.refreshAuth(accountId);
    }
    emit();
    return snapshot(clock());
  }
  const api = {
    snapshot,
    requestRead({ signal } = {}) {
      if (!inFlight) inFlight = store.exclusiveUsage(accountId, performRead).finally(() => { inFlight = null; });
      const work = inFlight;
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    },
    async ingestJobReading(event) {
      if (!validEvent(event, accountId, adapter.descriptor, clock())) return fault('invalid_provider_response', accountId);
      let result;
      await save(usage => {
        const identity = JSON.stringify([event.attemptId, event.eventId]);
        const serialized = canonical(event);
        if (usage.events[identity]) {
          result = usage.events[identity] === serialized ? ok({ kind: 'replay', lastSequence: usage.meters[JSON.stringify(event.attemptId)]?.sequence ?? 0 }) : fault('event_conflict', accountId);
          return;
        }
        // Compare conserved content, not the event ID alias or arrival time.
        const content = e => canonical({ accountId: e.accountId, attemptId: e.attemptId,
          sequence: e.sequence, semantics: e.semantics, meterEpoch: e.meterEpoch,
          amount: e.amount, windowDebits: e.windowDebits });
        const sameSequence = Object.values(usage.events).map(value => JSON.parse(value))
          .filter(e => e.attemptId === event.attemptId && e.sequence === event.sequence);
        if (sameSequence.some(e => content(e) !== content(event))) {
          result = fault('event_conflict', accountId); return;
        }
        if (sameSequence.length) {
          usage.events[identity] = serialized;
          result = ok({ kind: 'replay', lastSequence: usage.meters[JSON.stringify(event.attemptId)]?.sequence ?? 0 });
          return;
        }
        const previous = usage.meters[JSON.stringify(event.attemptId)];
        if (previous && event.sequence <= previous.sequence) {
          usage.events[identity] = serialized;
          result = ok({ kind: 'replay', lastSequence: previous.sequence }); return;
        }
        if (previous && (event.amount.unit !== previous.unit || event.semantics !== previous.semantics)) {
          result = fault('event_conflict', accountId); return;
        }
        if (Object.values(usage.pending).some(p => p.attemptId === event.attemptId &&
          (p.amount.unit !== event.amount.unit || p.semantics !== event.semantics))) {
          result = fault('event_conflict', accountId); return;
        }
        const pendingKey = JSON.stringify([event.attemptId, event.sequence]);
        if (usage.pending[pendingKey] && canonical(usage.pending[pendingKey]) !== serialized) {
          result = fault('event_conflict', accountId); return;
        }
        if (previous?.retiredEpochs.includes(event.meterEpoch)) {
          result = ok({ kind: 'replay', lastSequence: previous.sequence }); return;
        }
        if (previous?.epoch === event.meterEpoch && event.semantics === 'cumulative' &&
          (event.amount.value < previous.total || event.windowDebits.some(w =>
            w.micro < (previous.windows[JSON.stringify([w.id, w.instance])] ?? 0)))) {
          result = fault('event_conflict', accountId); return;
        }
        usage.events[identity] = serialized;
        usage.pending[pendingKey] = structuredClone(event);
        let current = event, applied = false;
        for (;;) {
          const meter = usage.meters[JSON.stringify(current.attemptId)];
          const last = meter?.sequence ?? 0;
          if (current.semantics === 'delta' && current.sequence !== last + 1) break;
          if (meter?.retiredEpochs.includes(current.meterEpoch)) { delete usage.pending[JSON.stringify([current.attemptId, current.sequence])]; break; }
          const sameEpoch = meter?.epoch === current.meterEpoch;
          const oldTotal = sameEpoch ? meter.total : 0;
          if (current.semantics === 'cumulative' && current.amount.value < oldTotal) {
            result = fault('event_conflict', accountId); break;
          }
          const debit = structuredClone(current);
          debit.semantics = 'delta';
          debit.amount.value -= current.semantics === 'cumulative' ? oldTotal : 0;
          for (const window of debit.windowDebits) {
            const key = JSON.stringify([window.id, window.instance]);
            const prior = sameEpoch ? meter.windows[key] ?? 0 : 0;
            if (current.semantics === 'cumulative' && window.micro < prior) { result = fault('event_conflict', accountId); break; }
            if (current.semantics === 'cumulative') window.micro -= prior;
          }
          if (result && !result.ok) break;
          usage.jobReadings.push(debit);
          const retiredEpochs = [...(meter?.retiredEpochs ?? [])];
          if (meter && !sameEpoch) retiredEpochs.push(meter.epoch);
          usage.meters[JSON.stringify(current.attemptId)] = { sequence: current.sequence, epoch: current.meterEpoch,
            total: current.amount.value, unit: current.amount.unit, semantics: current.semantics, retiredEpochs,
            windows: { ...(sameEpoch ? meter.windows : {}),
              ...Object.fromEntries(current.windowDebits.map(w => [JSON.stringify([w.id, w.instance]), w.micro])) } };
          delete usage.pending[JSON.stringify([current.attemptId, current.sequence])];
          applied = true;
          current = usage.pending[JSON.stringify([event.attemptId, current.sequence + 1])];
          if (!current) break;
        }
        result ??= ok({ kind: applied ? 'applied' : 'gap', lastSequence: usage.meters[JSON.stringify(event.attemptId)]?.sequence ?? 0 });
      });
      emit(); return result ?? fault('account_not_found', accountId);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { closed = true; lifetime.abort(); if (inFlight) await inFlight; listeners.clear(); if (readers.get(accountId) === api) readers.delete(accountId); },
  };
  readers.set(accountId, api);
  return api;
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validReading(r, id, now) {
  return r?.schemaVersion === 1 && r.accountId === id && typeof r.observationId === 'string' && integer(r.sequence) &&
    integer(r.observedAtMs) && r.observedAtMs <= now && integer(r.receivedAtMs) && r.receivedAtMs <= now &&
    (r.postingUncertaintyMs === null || integer(r.postingUncertaintyMs)) && Array.isArray(r.windows) &&
    r.windows.every(w => typeof w.id === 'string' && typeof w.instance === 'string' && integer(w.capacityMicro) &&
      integer(w.usedLoMicro) && integer(w.usedHiMicro) && w.usedLoMicro <= w.usedHiMicro &&
      (w.resetsAtMs === null || integer(w.resetsAtMs)) &&
      (w.maxOwnerRateMicroPerMs === null || (Number.isFinite(w.maxOwnerRateMicroPerMs) && w.maxOwnerRateMicroPerMs >= 0))) &&
    (r.coverage?.kind === 'unknown' || (r.coverage?.kind === 'proven' &&
      r.coverage.throughSequenceByAttempt && Object.values(r.coverage.throughSequenceByAttempt).every(integer)));
}
function validEvent(e, id, descriptor, now) {
  return e?.schemaVersion === 1 && e.accountId === id && typeof e.attemptId === 'string' && e.attemptId &&
    typeof e.eventId === 'string' && e.eventId && integer(e.sequence) && e.sequence > 0 && integer(e.atMs) && e.atMs <= now &&
    ['delta', 'cumulative'].includes(e.semantics) && typeof e.meterEpoch === 'string' && e.meterEpoch &&
    integer(e.amount?.value) && descriptor.nativeUnits.some(u => u.id === e.amount.unit && integer(u.scale) && u.scale > 0) &&
    Array.isArray(e.windowDebits) && e.windowDebits.every(w => typeof w.id === 'string' && typeof w.instance === 'string' && integer(w.micro));
}
