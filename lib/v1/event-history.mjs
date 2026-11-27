import {sanitizeProbeFailure, sanitizeProbeDeferral} from './lending-probe.mjs';
import {durableJson, durableWriteAsync} from '../durable-write.mjs';
// Durable event spine: append-only observations on this computer, kept for a stated time.
// Each app event is projected through an allowlist before it reaches disk, so prompts, titles,
// sources, paths, match codes and provider output never enter history. The file is JSON Lines;
// the only rewrite is an atomic compaction that drops whole expired or over-cap rows.
import {appendFile, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {constants, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireProcessLockSync} from './lock.mjs';
import { observedExecutionTime } from './state-projection.mjs';

export const HISTORY_RETENTION_DAYS = 90;
export const HISTORY_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, pageDefault: 50, pageMax: 200, idBlock: 10000 });
export const MEASUREMENT_LIMITS = Object.freeze({bytes: 16 * 1024 * 1024, rowBytes: 8 * 1024, metadataBytes: 64 * 1024});
const DAY_MS = 86400000;
const COMPACT_INTERVAL_MS = 3600000;
const measurementOwnerReleases = new Set();
process.once('exit', () => { for (const release of measurementOwnerReleases) { try { release(); } catch { /* process exit cleanup is best effort */ } } });

const TERMINAL = new Set(['Finished', 'Failed', 'Expired', 'Cancelled']);
const text = (value, max = 256) => {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? [...clean].slice(0, max).join('') : null;
};
const code = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
const iso = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
// Actor and attempt ids are opaque tokens (key ids are sha256 digests): no slashes, spaces or URLs.
const ident = (value, max = 128) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:=-]*$/.test(value) ? value : null;
// Status words come from the app's own vocabulary; anything else (paths, output, tokens) is dropped.
const words = (value, max = 40) => typeof value === 'string' && value.length <= max && /^[A-Z][A-Za-z' -]*$/.test(value) ? value : null;
// Attention is stored as a code. Its copy lives in the UI, so free text never reaches disk.
export const ATTENTION_CODES = Object.freeze({ "Lending couldn't continue.": 'lending_stopped' });
const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
const compact = object => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null && v !== undefined));

function attemptOf(a) {
  if (!a || typeof a !== 'object') return null;
  const attempt = compact({ attempt_id: ident(a.attempt_id, 64), holder: ident(a.holder), state: code(a.state), reason: code(a.reason),
    claimed_at: iso(a.claimed_at), execution_started_at: iso(a.execution_started_at), stopped_at: iso(a.stopped_at) });
  if (Object.hasOwn(a, 'execution_observed_at')) attempt.execution_observed_at = iso(a.execution_observed_at);
  return attempt;
}

/**
 * One app event to its stored form ({circle, job, attempt, data}) or null when it is not history.
 * Only named fields with checked shapes are kept.
 */
export function projectEvent(type, data) {
  if (!data || typeof data !== 'object') return null;
  const circleOf = value => text(typeof value === 'object' ? value?.id : value, 256);
  switch (type) {
    case 'job': {
      const job = digest(data.job_digest);
      if (!job) return null;
      if (data.deleted === true) return { circle: circleOf(data.circle), job, data: { job_digest: job, deleted: true } };
      const status = words(data.status), state = code(data.state);
      if (!status && !state) return null; // refresh hints and title edits carry no observation
      const signed = data.job?.payload ?? {};
      const circle = circleOf(data.circle) ?? circleOf(data.borrowerCircle) ?? circleOf(signed.circle);
      const attempt = attemptOf(data.current_attempt);
      return { circle, job, attempt: attempt?.attempt_id ?? null, data: compact({ job_digest: job, circle, status, state,
        // App job views carry the author and own-job submission time beside the projected job, not in a signed payload.
        author: ident(data.historyIdentity?.author) ?? ident(signed.author), created_at: iso(data.waitingTiming?.submittedAt) ?? iso(signed.created_at),
        attempts_started: Number.isSafeInteger(data.attempts_started) ? data.attempts_started : null,
        current_attempt: attempt, result_digest: digest(data.result_digest) }) };
    }
    case 'approval': {
      const approvalId = ident(data.id, 64);
      if (!approvalId) return null;
      const job = digest(data.jobDigest), circle = circleOf(data.job?.circle) ?? circleOf(data.circle);
      // A card has no state; it is the request waiting for a decision.
      const state = data.state === undefined ? 'waiting' : code(data.state);
      if (!state) return null;
      return { circle, job, data: compact({ approvalId, job_digest: job, circle, state, auto: typeof data.auto === 'string' && /^[a-z][a-z -]{0,39}$/.test(data.auto) ? data.auto : null,
        requester: ident(data.requester), expiresAt: iso(data.expiresAt) }) };
    }
    case 'lending': {
      const circle = circleOf(data.circle), current = typeof data.current === 'string' ? data.current : data.current?.attempt_id;
      return { circle, attempt: ident(current, 64), data: compact({ circle, status: code(data.status), reason: code(data.reason), current: ident(current, 64),
        currentRequester: ident(data.currentRequester), paused: typeof data.paused === 'boolean' ? data.paused : null }) };
    }
    case 'lending-action': {
      const action = code(data.action);
      return action ? { circle: circleOf(data.circle), data: compact({ circle: circleOf(data.circle), action }) } : null;
    }
    case 'agents':
      if (data.refreshed || typeof data.useForLending !== 'boolean' || !code(data.id)) return null;
      return { circle: null, data: { id: data.id, useForLending: data.useForLending } };
    case 'enrollment': {
      const state = code(data.state);
      return state ? { circle: circleOf(data.circle), data: compact({ circle: circleOf(data.circle), circleName: text(data.circleName, 120), state,
        automatic: data.automatic === true ? true : null, deviceName: text(data.deviceName, 120) }) } : null;
    }
    case 'member-left':
      return { circle: circleOf(data.circle), data: compact({ circle: circleOf(data.circle), circleName: text(data.circleName, 120), deviceName: text(data.deviceName, 120) }) };
    case 'attention': {
      const known = Object.hasOwn(ATTENTION_CODES, data.label) ? ATTENTION_CODES[data.label] : null;
      return known ? { circle: circleOf(data.circle), data: compact({ code: known, circle: circleOf(data.circle) }) } : null;
    }
    default: return null;
  }
}

const validRow = row => row && typeof row === 'object' && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.type === 'string' &&
  Number.isFinite(Date.parse(row.at)) && row.data && typeof row.data === 'object';
const rowBytes = row => Buffer.byteLength(JSON.stringify(row)) + 1;

/**
 * createEventHistory({directory}) stores events.jsonl and events.meta.json in directory.
 * nextId() is synchronous and durable: ids are reserved in blocks, so a restarted app never
 * hands out an id it used before, even for events that were not stored.
 */
export function createEventHistory({ directory, now = Date.now, retentionDays = HISTORY_RETENTION_DAYS, maxBytes = HISTORY_LIMITS.bytes, idBlock = HISTORY_LIMITS.idBlock } = {}) {
  const file = join(directory, 'events.jsonl'), metaFile = join(directory, 'events.meta.json');
  let rows = [], bytes = 0, lastId = 0, reserved = 0, trimmedBefore = null, chain = Promise.resolve(), lastCompact = -Infinity;
  // durable=false after any disk failure: events still flow and ids still rise, but this run may not be kept.
  let durable = true;
  const lastByKey = new Map(), approvalJobs = new Map();
  const cutoffMs = () => now() - retentionDays * DAY_MS;

  const writeMeta = () => {
    try {
      durableJson(metaFile,{version:1,reservedId:reserved,trimmedBefore});
    } catch { durable = false; }
  };
  const keyOf = row => JSON.stringify([row.type, row.circle, row.job, row.type === 'approval' ? row.data.approvalId : null]);
  const remember = row => {
    lastByKey.set(keyOf(row), JSON.stringify(row.data));
    if (row.type === 'approval' && row.data.approvalId && row.job) approvalJobs.set(row.data.approvalId, { job: row.job, circle: row.circle });
  };

  // Drop whole rows from the front: expired first, then the oldest until well under the cap.
  function trim() {
    const cutoff = cutoffMs();
    let dropped = false;
    while (rows.length && Date.parse(rows[0].at) < cutoff) { bytes -= rowBytes(rows.shift()); dropped = true; }
    if (bytes > maxBytes) {
      while (rows.length && bytes > maxBytes * 0.75) { const row = rows.shift(); bytes -= rowBytes(row); trimmedBefore = row.at; }
      dropped = true;
      writeMeta();
    }
    if(dropped) {
      lastByKey.clear();approvalJobs.clear();
      for(const row of rows)remember(row);
    }
    return dropped;
  }
  // The file content is taken when the rewrite is queued. Rows recorded later are queued as
  // appends behind it, so taking it at write time would store them twice.
  function rewrite() {
    const content = rows.map(row => JSON.stringify(row) + '\n').join('');
    lastCompact = now();
    return async () => {
      await durableWriteAsync(file,content);
    };
  }
  const queue = task => (chain = chain.then(task).catch(() => { durable = false; }));

  return {
    async load() {
      try {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
        if (Number.isSafeInteger(meta?.reservedId) && meta.reservedId > 0) reserved = meta.reservedId;
        if (typeof meta?.trimmedBefore === 'string') trimmedBefore = iso(meta.trimmedBefore);
      } catch { /* No meta yet, or unreadable: start from the stored rows. */ }
      let raw = '';
      try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') durable = false; }
      let skipped = 0;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        // Rows are written id first, so a torn or corrupt row still tells which ids were used.
        const torn = /^\{"id":(\d{1,15})[,}]/.exec(line);
        if (torn) lastId = Math.max(lastId, Number(torn[1]));
        let row;
        try { row = JSON.parse(line); } catch { skipped++; continue; }
        if (!validRow(row)) { skipped++; continue; }
        lastId = Math.max(lastId, row.id);
        if (rows.length && row.id <= rows.at(-1).id) { skipped++; continue; }
        rows.push(row); bytes += rowBytes(row); remember(row);
      }
      // Ids restart above everything reserved before, so a reconnecting stream's cursor stays valid.
      lastId = Math.max(lastId, reserved);
      reserved = lastId + idBlock; writeMeta();
      if ((trim() || skipped) && durable) await queue(rewrite());
      return { lastId, stored: rows.length, skipped, durable };
    },
    nextId() {
      lastId += 1;
      if (lastId > reserved) { reserved = lastId + idBlock; writeMeta(); }
      return lastId;
    },
    /** Stores one emitted event ({id, type, at, data}) if it is history. Returns the stored row or null. Never throws for disk errors. */
    record(event) {
      const projected = projectEvent(event?.type, event?.data);
      if (!projected || !Number.isSafeInteger(event.id) || !iso(event.at)) return null;
      if (rows.length && event.id <= rows.at(-1).id) return null;
      let { circle = null, job = null, attempt = null, data } = projected;
      if (event.type === 'approval' && !job) {
        const linked = approvalJobs.get(data.approvalId);
        if (linked) { job = linked.job; circle ??= linked.circle; data = { ...data, job_digest: job, ...(circle ? { circle } : {}) }; }
      }
      const row = { id: event.id, at: iso(event.at), type: event.type, circle: circle ?? null, job: job ?? null, ...(attempt ? { attempt } : {}), data };
      if (lastByKey.get(keyOf(row)) === JSON.stringify(row.data)) return null;
      rows.push(row); bytes += rowBytes(row); remember(row);
      const needsRewrite = bytes > maxBytes || (now() - lastCompact > COMPACT_INTERVAL_MS && rows.length && Date.parse(rows[0].at) < cutoffMs());
      if (needsRewrite) { trim(); queue(rewrite()); }
      else {
        const line = JSON.stringify(row) + '\n';
        queue(async () => { await mkdir(directory, { recursive: true }); await appendFile(file, line, { mode: 0o600 }); });
      }
      return row;
    },
    /** Writes queued so far are on disk when this resolves. */
    flush() { return queue(() => {}); },
    /** False after any disk failure in this run (telemetry reads it as a health fact). */
    get durable() { return durable; },
    /**
     * Newest first. circle/job/attempt filters are exact; device-level events have no circle.
     * before is an id cursor; nextBefore is null on the last page.
     */
    page({ circle = null, job = null, attempt = null, types = null, before = null, limit = HISTORY_LIMITS.pageDefault } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_LIMITS.pageMax) throw Object.assign(Error('invalid_request'), { code: 'invalid_request', status: 400 });
      if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw Object.assign(Error('invalid_request'), { code: 'invalid_request', status: 400 });
      const cutoff = cutoffMs(), out = [];
      let more = false;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (before !== null && row.id >= before) continue;
        if (Date.parse(row.at) < cutoff) break;
        if (circle !== null && row.circle !== circle) continue;
        if (job !== null && row.job !== job && !(attempt !== null && row.attempt === attempt)) continue;
        if (job === null && attempt !== null && row.attempt !== attempt) continue;
        if (types && !types.includes(row.type)) continue;
        if (out.length === limit) { more = true; break; }
        out.push(structuredClone(row));
      }
      return { events: out, nextBefore: more ? out.at(-1).id : null,
        retention: { days: retentionDays, cutoff: new Date(cutoff).toISOString(), trimmedBefore, oldestAt: rows[0]?.at ?? null, durable } };
    },
  };
}

const MEASUREMENT_TYPES = new Set(['capture_epoch_started', 'capture_epoch_ended', 'observation_requested',
  'observation_completed', 'observation_failed', 'observation_deferred', 'admission_decided', 'admission_gate_refused', 'capture_gap']);
const OBSERVATION_CLASSES = new Set(['cache', 'shared', 'new_source', 'no_source']);
const DIAL_NAMES = new Set(['keep_more_for_me', 'balanced', 'share_more']);
const DEFERRAL_REASONS = new Set(['account_busy', 'probe_deferred']);
const FAILURE_REASONS = new Set(['cancelled', 'empty_result', 'refresh_failed', 'source_failed', 'unknown']);
const DECISION_OUTCOMES = new Set(['admitted', 'held', 'refused']);
const DECISION_REASONS = new Set(['native_attempt_in_flight', 'window_not_open', 'lending_window_missing', 'lending_window_memory_unreadable', 'lending_window_invalid', 'objective_lend', 'quota_unknown', 'quota_reserve', 'user_active', 'paused', 'job_expired',
  'internal_error', 'invalid_request', 'unreadable_window_origin', 'meter_unavailable', 'observation_changed',
  'readiness_changed', 'model_not_lendable', 'refresh_failed', 'account_busy', 'probe_deferred', 'identity_unknown', 'identity_mismatch', 'account_week_mapping_unknown', 'epoch_unknown',
  'resources_incomplete', 'funding_unknown', 'executor_unknown', 'stop_bound_unknown', 'conversion_unknown', 'history_unknown',
  'queue_unknown', 'owner_scenarios_unknown', 'friend_value_unknown', 'objective_evidence_unknown', 'owner_settings_unreadable',
  'strategy_config_unknown', 'demand_model_unavailable', 'demand_model_coupling_unknown', 'demand_model_invalid',
  'demand_model_exact_usage_required']);
// The sub-reason a stop refusal carries, and its measured facts. Anything else is dropped, never stored.
const REFUSAL_STOP_REASONS = new Set(['stop_bound_unconfigured', 'stop_answer_deadline_unknown', 'stop_bound_below_answer_deadline', 'stop_unmeasured', 'stop_unobserved', 'stop_not_delivered', 'stop_latency_over_bound', 'stop_removal_unverified']);
// Accepts the runtime names and the stored names, so a restored row projects to the same shape it was written with.
function projectRefusalDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const flag = value => value === true || value === false ? value : null;
  const millis = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const stopReason = detail.stopReason ?? detail.stop_reason;
  const projected = {stop_reason: REFUSAL_STOP_REASONS.has(stopReason) ? stopReason : null,
    delivered: flag(detail.delivered), fallback: typeof detail.fallback === 'string' ? detail.fallback.slice(0, 32) : null,
    latency_ms: millis(detail.latency_ms), bound_ms: millis(detail.bound_ms), removed: flag(detail.removed)};
  return Object.values(projected).some(value => value !== null) ? projected : null;
}
const measurementIso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const measurementInt = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const measurementMono = value => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : null;
const measurementField = value => Number.isSafeInteger(value) && value >= 0
  ? {value, null_reason: null} : {value: null, null_reason: 'missing_or_invalid'};

async function replaceMeasurementFile(file, content) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle = null;
  try {
    // No mkdir here: if the owner removes the partition during shutdown, logging must not recreate it.
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content); await handle.chmod(0o600); await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) try { await handle.close(); } catch { /* preserve the write failure */ }
    try { await unlink(temporary); } catch { /* the directory may already be gone */ }
    throw error;
  }
}

function measurementReadings(resources, headroom = null) {
  if (!Array.isArray(resources)) return [];
  return resources.slice(0, 8).map((resource, index) => ({
    resource_slot: index,
    used_micro: measurementField(resource?.used_micro),
    kappa_micro: measurementField(resource?.kappa_micro),
    duration_ms: measurementField(resource?.duration_ms),
    observed_at_ms: measurementField(resource?.observed_at),
    resets_at_ms: measurementField(resource?.resets_at),
    headroom_micro: measurementField(headroom?.[index]),
  }));
}

function projectMeasurement(type, data = {}) {
  if (!MEASUREMENT_TYPES.has(type) || !data || typeof data !== 'object') return null;
  switch (type) {
    case 'capture_epoch_started':
    case 'capture_epoch_ended':
      return {coverage_status: 'partial: part A, no authority receipts'};
    case 'observation_requested':
      return {classification: OBSERVATION_CLASSES.has(data.classification) ? data.classification : 'no_source',
        started_at_utc: measurementIso(data.started_wall_ms), started_monotonic_ns: measurementMono(data.started_monotonic_ns)};
    case 'observation_completed':
      const readingSetPresent = Array.isArray(data.resources) && data.resources.length > 0;
      return {request_event_id: typeof data.request_event_id === 'string' && /^[0-9a-f-]{36}$/.test(data.request_event_id) ? data.request_event_id : null,
        classification: OBSERVATION_CLASSES.has(data.classification) ? data.classification : 'no_source',
        started_at_utc: measurementIso(data.started_wall_ms), started_monotonic_ns: measurementMono(data.started_monotonic_ns),
        completed_at_utc: measurementIso(data.completed_wall_ms), completed_monotonic_ns: measurementMono(data.completed_monotonic_ns),
        readings: measurementReadings(data.resources), readings_null_reason: readingSetPresent ? null : 'missing_or_empty'};
    case 'observation_deferred': {
      const probe = sanitizeProbeDeferral(data.probe);
      if (!DEFERRAL_REASONS.has(data.reason) || probe?.reason !== data.reason) return null;
      return {request_event_id: typeof data.request_event_id === 'string' && /^[0-9a-f-]{36}$/.test(data.request_event_id) ? data.request_event_id : null,
        classification: OBSERVATION_CLASSES.has(data.classification) ? data.classification : 'no_source',
        reason:data.reason, probe,
        started_at_utc: measurementIso(data.started_wall_ms), started_monotonic_ns: measurementMono(data.started_monotonic_ns),
        completed_at_utc: measurementIso(data.completed_wall_ms), completed_monotonic_ns: measurementMono(data.completed_monotonic_ns)};
    }
    case 'observation_failed':
      return {request_event_id: typeof data.request_event_id === 'string' && /^[0-9a-f-]{36}$/.test(data.request_event_id) ? data.request_event_id : null,
        classification: OBSERVATION_CLASSES.has(data.classification) ? data.classification : 'no_source',
        reason: FAILURE_REASONS.has(data.reason) ? data.reason : 'unknown',
        ...(sanitizeProbeFailure(data.probe) ? {probe:sanitizeProbeFailure(data.probe)} : {}),
        started_at_utc: measurementIso(data.started_wall_ms), started_monotonic_ns: measurementMono(data.started_monotonic_ns),
        completed_at_utc: measurementIso(data.completed_wall_ms), completed_monotonic_ns: measurementMono(data.completed_monotonic_ns)};
    case 'admission_gate_refused':
    case 'admission_decided':
      const outcome = DECISION_OUTCOMES.has(data.outcome) ? data.outcome : 'refused';
      return {policy_version: data.policy_version === 'objective/m1' ? data.policy_version : null,
        policy_version_null_reason: data.policy_version === 'objective/m1' ? null : 'unsupported_or_unknown',
        dial: DIAL_NAMES.has(data.dial) ? data.dial : null,
        dial_null_reason: DIAL_NAMES.has(data.dial) ? null : 'unsupported_or_unknown',
        outcome, reason: DECISION_REASONS.has(data.reason) ? data.reason : 'internal_error',
        ...(['claude', 'codex'].includes(data.provider) ? {provider: data.provider} : {}),
        ...(typeof data.policy_reason === 'string' ? {policy_reason: data.policy_reason.slice(0, 256)} : {}), candidate_revision: measurementInt(data.candidate_revision),
        candidate_revision_null_reason: measurementInt(data.candidate_revision) === null ? 'missing_or_invalid' : null,
        input_observation_event_ids: Array.isArray(data.input_observation_event_ids)
          ? data.input_observation_event_ids.filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)).slice(0, 8) : null,
        input_observation_event_ids_null_reason: Array.isArray(data.input_observation_event_ids) && data.input_observation_event_ids.length > 0
          ? null : 'missing_or_unrecorded',
        resource_headroom: Array.isArray(data.resource_headroom)
          ? data.resource_headroom.slice(0, 8).map(measurementField) : null,
        resource_headroom_null_reason: Array.isArray(data.resource_headroom) && data.resource_headroom.length > 0 ? null : 'missing_or_unavailable',
        ...(projectRefusalDetail(data.refusal_detail) ? {refusal_detail: projectRefusalDetail(data.refusal_detail)} : {})};
    case 'capture_gap':
      return {reason: data.reason === 'oldest_rows_dropped' || data.reason === 'write_failed' ||
        data.reason === 'oversized_row' || data.reason === 'invalid_record' || data.reason === 'unclean_restart'
          ? data.reason : 'invalid_record', dropped_rows: measurementInt(data.dropped_rows),
        dropped_through_sequence: measurementInt(data.dropped_through_sequence)};
    default: return null;
  }
}

const storedTime = value => typeof value === 'string' && iso(value) === value ? value : null;
const storedMono = value => value === null || measurementMono(value) ? value : null;
const storedField = field => {
  if (!field || typeof field !== 'object') return null;
  if (field.value === null && field.null_reason === 'missing_or_invalid') return {value: null, null_reason: 'missing_or_invalid'};
  return Number.isSafeInteger(field.value) && field.value >= 0 && field.null_reason === null
    ? {value: field.value, null_reason: null} : null;
};
function restoreMeasurementData(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (type === 'capture_epoch_started' || type === 'capture_epoch_ended')
    return data.coverage_status === 'partial: part A, no authority receipts'
      ? {coverage_status: 'partial: part A, no authority receipts'} : null;
  if (type === 'capture_gap') {
    const projected = projectMeasurement(type, data);
    return projected?.reason === data.reason ? projected : null;
  }
  if (type === 'admission_decided' || type === 'admission_gate_refused') {
    if (!DECISION_OUTCOMES.has(data.outcome) || !DECISION_REASONS.has(data.reason)) return null;
    const projected = projectMeasurement(type, data);
    if (data.resource_headroom === null) {
      if (data.resource_headroom_null_reason !== 'missing_or_unavailable') return null;
      return projected;
    }
    if (!Array.isArray(data.resource_headroom) || data.resource_headroom.length > 8) return null;
    const resourceHeadroom = data.resource_headroom.map(storedField);
    if (resourceHeadroom.some(field => field === null)) return null;
    const nullReason = data.resource_headroom_null_reason;
    if (nullReason !== (resourceHeadroom.length > 0 ? null : 'missing_or_unavailable')) return null;
    return {...projected, resource_headroom: resourceHeadroom};
  }
  const base = {classification: OBSERVATION_CLASSES.has(data.classification) ? data.classification : null,
    started_at_utc: storedTime(data.started_at_utc), started_monotonic_ns: storedMono(data.started_monotonic_ns)};
  if (!base.classification || (data.started_at_utc !== null && base.started_at_utc === null) ||
      (data.started_monotonic_ns !== null && base.started_monotonic_ns === null)) return null;
  if (type === 'observation_requested') return base;
  const requestId = data.request_event_id === null || typeof data.request_event_id === 'string' && /^[0-9a-f-]{36}$/.test(data.request_event_id)
    ? data.request_event_id : undefined;
  const completedAt = storedTime(data.completed_at_utc), completedMono = storedMono(data.completed_monotonic_ns);
  if (requestId === undefined || (data.completed_at_utc !== null && completedAt === null) ||
      (data.completed_monotonic_ns !== null && completedMono === null)) return null;
  if (type === 'observation_deferred') {
    const probe = sanitizeProbeDeferral(data.probe);
    if (!DEFERRAL_REASONS.has(data.reason) || probe?.reason !== data.reason ||
        ['provider', 'failure_class', 'deferral_cause', 'retry_at'].some(key => data.probe[key] !== probe[key])) return null;
    return {...base, request_event_id:requestId, reason:data.reason, probe,
      completed_at_utc:completedAt, completed_monotonic_ns:completedMono};
  }
  if (type === 'observation_failed') {
    if (!FAILURE_REASONS.has(data.reason)) return null;
    return {...base, request_event_id: requestId, reason: data.reason,
      ...(sanitizeProbeFailure(data.probe) ? {probe:sanitizeProbeFailure(data.probe)} : {}), completed_at_utc: completedAt,
      completed_monotonic_ns: completedMono};
  }
  if (type === 'observation_completed') {
    if (!Array.isArray(data.readings) || data.readings.length > 8 ||
        ![null, 'missing_or_empty'].includes(data.readings_null_reason)) return null;
    const readings = data.readings.map((reading, index) => {
      if (reading?.resource_slot !== index) return null;
      const fields = ['used_micro', 'kappa_micro', 'duration_ms', 'observed_at_ms', 'resets_at_ms', 'headroom_micro'];
      const clean = {resource_slot: index};
      for (const field of fields) { clean[field] = storedField(reading[field]); if (!clean[field]) return null; }
      return clean;
    });
    if (readings.some(reading => reading === null)) return null;
    return {...base, request_event_id: requestId, completed_at_utc: completedAt,
      completed_monotonic_ns: completedMono, readings, readings_null_reason: data.readings_null_reason};
  }
  return null;
}
function restoreMeasurementRow(row) {
  if (row?.schema_version !== 1 || row?.coverage !== 'partial' || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
      !MEASUREMENT_TYPES.has(row.type) || typeof row.event_id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.event_id) ||
      typeof row.capture_epoch_id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.capture_epoch_id)) return null;
  const data = restoreMeasurementData(row.type, row.data);
  if (!data) return null;
  const recordedAt = storedTime(row.recorded_at_utc), monotonic = storedMono(row.monotonic_ns);
  if ((row.recorded_at_utc !== null && recordedAt === null) || (row.monotonic_ns !== null && monotonic === null)) return null;
  const restored = {schema_version: 1, coverage: 'partial', event_id: row.event_id, capture_epoch_id: row.capture_epoch_id,
    sequence: row.sequence, type: row.type, recorded_at_utc: recordedAt,
    recorded_at_null_reason: row.recorded_at_null_reason === null || row.recorded_at_null_reason === 'wall_clock_unavailable'
      ? row.recorded_at_null_reason : null,
    monotonic_ns: monotonic, monotonic_null_reason: row.monotonic_null_reason === null || row.monotonic_null_reason === 'monotonic_clock_unavailable'
      ? row.monotonic_null_reason : null, data};
  return Buffer.byteLength(JSON.stringify(restored) + '\n') <= MEASUREMENT_LIMITS.rowBytes ? restored : null;
}

/**
 * A private, bounded partition for lending measurements. It has no read/page API and is not
 * connected to app history fan-out. Projection happens synchronously before rows enter the
 * asynchronous writer queue; writer errors only mark this capture invalid.
 */
export function createMeasurementHistory({directory, now = Date.now, monotonicNow = () => process.hrtime.bigint().toString(),
  maxBytes = MEASUREMENT_LIMITS.bytes, writer = null} = {}) {
  maxBytes = Number.isSafeInteger(maxBytes) ? Math.min(MEASUREMENT_LIMITS.bytes, Math.max(4096, maxBytes)) : MEASUREMENT_LIMITS.bytes;
  const root = typeof directory === 'string' && directory ? join(directory, 'measurements') : null;
  const file = root ? join(root, 'measurements.jsonl') : null;
  const metaFile = root ? join(root, 'measurements.meta.json') : null;
  const epochId = randomUUID();
  let rows = [], bytes = 0, sequence = 0, diskBytes = 0, chain = Promise.resolve();
  let durable = true, invalid = false, gap = null, pending = [], pendingBytes = 0, scheduled = false,
    needsRewrite = false, rewriteGeneration = 0, statusChain = Promise.resolve(), statusPending = false, closeRequested = false;
  let writerAvailable = false, releaseOwnership = null;

  const defaultWriter = {
    async append(path, content) {
      const handle = await open(path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      try { lstatSync(root); } catch { throw new Error('measurement_directory_removed'); }
    },
    async rewrite(path, content) { await replaceMeasurementFile(path, content); },
    async status(path, content) { await replaceMeasurementFile(path, content); },
  };
  const safeWriter = {...defaultWriter, ...(writer ?? {})};
  const statusValue = () => ({schema_version: 1, coverage: 'partial', capture_epoch_id: epochId,
    invalid, durable, gap: gap ? {...gap} : null});
  const requestRewrite = () => { needsRewrite = true; rewriteGeneration++; };
  const releaseWriter = () => {
    if (releaseOwnership) {
      const release = releaseOwnership;
      releaseOwnership = null;
      measurementOwnerReleases.delete(release);
      try { release(); } catch { /* The partition may already be removed during shutdown. */ }
    }
    writerAvailable = false;
  };
  const persistStatus = () => {
    if (!metaFile || !writerAvailable) return Promise.resolve();
    const snapshot = JSON.stringify(statusValue());
    statusPending = true;
    let next;
    next = statusChain.then(() => safeWriter.status(metaFile, snapshot))
      .catch(() => { durable = false; invalid = true; gap ??= {reason: 'write_failed', dropped_rows: null, dropped_through_sequence: null}; })
      .finally(() => { if (statusChain === next) statusPending = false; });
    statusChain = next;
    return statusChain;
  };
  const makeRow = (type, data, at = now(), mono = monotonicNow()) => {
    const projected = projectMeasurement(type, data);
    if (!projected) return null;
    const recordedAt = measurementIso(at), monotonic = measurementMono(String(mono));
    const row = {schema_version: 1, coverage: 'partial', event_id: randomUUID(), capture_epoch_id: epochId,
      sequence: ++sequence, type, recorded_at_utc: recordedAt,
      recorded_at_null_reason: recordedAt ? null : 'wall_clock_unavailable', monotonic_ns: monotonic,
      monotonic_null_reason: monotonic ? null : 'monotonic_clock_unavailable', data: projected};
    return {row, line: JSON.stringify(row) + '\n'};
  };
  const appendGap = (reason, droppedRows = 0, droppedThrough = null) => {
    const unchanged = gap?.reason === reason && gap.dropped_rows === droppedRows && gap.dropped_through_sequence === droppedThrough;
    gap = {reason, dropped_rows: droppedRows, dropped_through_sequence: droppedThrough};
    invalid = true;
    const marker = makeRow('capture_gap', gap);
    if (marker && Buffer.byteLength(marker.line) <= MEASUREMENT_LIMITS.rowBytes) {
      const previous = rows.at(-1);
      if (previous?.type !== 'capture_gap' || previous.data.reason !== reason) {
        rows.push(marker.row); bytes += Buffer.byteLength(marker.line);
        if (pendingBytes + Buffer.byteLength(marker.line) <= 1024 * 1024) {
          pending.push(marker.line); pendingBytes += Buffer.byteLength(marker.line);
        } else {
          pending = []; pendingBytes = 0; requestRewrite();
        }
        trimRows();
      }
    }
    if (!unchanged) void persistStatus();
  };
  // Over the cap, drop to the same low-water mark as app history. Dropping only enough for one row made every
  // later record rewrite the whole file (16 MiB per row), which kept a long-running app's event loop busy.
  // Below the cap nothing is dropped: gap markers call this unconditionally.
  const trimRows = () => {
    if (bytes <= maxBytes) return;
    let droppedRows = 0, droppedThrough = null;
    while (rows.length && bytes > maxBytes * 0.75) {
      const row = rows.shift();
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      bytes -= size; droppedRows++; droppedThrough = row.sequence;
    }
    if (droppedRows) {
      requestRewrite();
      pending = []; pendingBytes = 0;
      if (gap?.reason !== 'write_failed')
        gap = {reason: 'oldest_rows_dropped', dropped_rows: droppedRows, dropped_through_sequence: droppedThrough};
      invalid = true;
      const marker = makeRow('capture_gap', gap), markerSize = marker ? Buffer.byteLength(marker.line) : 0;
      if (marker && markerSize <= maxBytes) {
        while (rows.length && bytes + markerSize > maxBytes) {
          const row = rows.shift(); bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
        }
        rows.push(marker.row); bytes += markerSize;
      }
      void persistStatus();
    }
  };
  const schedule = () => {
    if (scheduled || !file || !writerAvailable) return;
    scheduled = true;
    chain = chain.then(async () => {
      // A row batch is either appended under the committed-byte cap or replaced by the retained snapshot.
      const batch = pending;
      const batchBytes = pendingBytes;
      pending = []; pendingBytes = 0;
      if (needsRewrite || diskBytes + batchBytes > maxBytes) {
        const rewriteSnapshot = rewriteGeneration;
        const content = rows.map(row => JSON.stringify(row) + '\n').join('');
        await safeWriter.rewrite(file, content);
        diskBytes = Buffer.byteLength(content);
        if (rewriteSnapshot === rewriteGeneration) needsRewrite = false;
      } else if (batch.length) {
        await safeWriter.append(file, batch.join(''));
        diskBytes += batchBytes;
      }
    }).catch(async () => {
      durable = false; invalid = true;
      gap = {reason: 'write_failed', dropped_rows: null, dropped_through_sequence: null};
      const marker = makeRow('capture_gap', gap);
      if (marker) { rows.push(marker.row); bytes += Buffer.byteLength(marker.line); }
      trimRows();
      const rewriteSnapshot = rewriteGeneration;
      const content = rows.map(row => JSON.stringify(row) + '\n').join('');
      // One best-effort atomic rewrite stores the explicit gap marker after a transient append failure.
      // It is not retried recursively; the separate status file remains the fallback if this also fails.
      pending = []; pendingBytes = 0;
      try {
        await safeWriter.rewrite(file, content);
        diskBytes = Buffer.byteLength(content);
      }
      catch { /* The capture status still records the gap when its own write succeeds. */ }
      if (rewriteSnapshot === rewriteGeneration) needsRewrite = false;
      void persistStatus();
    }).finally(() => {
      scheduled = false;
      if (pending.length || needsRewrite) schedule();
      else if (closeRequested && !statusPending) releaseWriter();
    });
  };

  try {
    if (!root) throw new Error('directory_unavailable');
    mkdirSync(root, {recursive: true, mode: 0o700});
    const dirStat = lstatSync(root);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('directory_invalid');
    chmodSync(root, 0o700);
    releaseOwnership = acquireProcessLockSync(join(root, '.measurements.owner.lock'));
    measurementOwnerReleases.add(releaseOwnership);
    writerAvailable = true;
    for (const name of readdirSync(root)) {
      if (!/^measurements\.jsonl\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const temporary = join(root, name), temporaryStat = lstatSync(temporary);
      if (temporaryStat.isFile() && !temporaryStat.isSymbolicLink()) unlinkSync(temporary);
    }
    try {
      const fileStat = lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('file_invalid');
      chmodSync(file, 0o600);
      diskBytes = statSync(file).size;
      if (diskBytes > maxBytes) {
        invalid = true; diskBytes = maxBytes + 1; requestRewrite();
        appendGap('oldest_rows_dropped', null, null);
      }
      else {
        const content = readFileSync(file, 'utf8');
        if (content && !content.endsWith('\n')) requestRewrite();
        for (const line of content.split('\n')) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            const restored = restoreMeasurementRow(row);
            if (!restored || restored.sequence <= sequence) { invalid = true; requestRewrite(); continue; }
            sequence = restored.sequence;
            rows.push(restored); bytes += Buffer.byteLength(JSON.stringify(restored)) + 1;
            if (JSON.stringify(restored) !== line) requestRewrite();
          } catch { invalid = true; requestRewrite(); }
        }
        if (invalid && !gap) appendGap('invalid_record');
        if (rows.at(-1)?.type !== 'capture_epoch_ended') appendGap('unclean_restart');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const metaStat = lstatSync(metaFile);
      if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > MEASUREMENT_LIMITS.metadataBytes)
        throw new Error('metadata_invalid');
      chmodSync(metaFile, 0o600);
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      if (meta?.schema_version === 1 && meta?.coverage === 'partial') {
        invalid ||= meta.invalid === true;
        if (meta.gap && ['oldest_rows_dropped', 'write_failed', 'oversized_row', 'invalid_record', 'unclean_restart'].includes(meta.gap.reason)) gap = {reason: meta.gap.reason,
          dropped_rows: measurementInt(meta.gap.dropped_rows), dropped_through_sequence: measurementInt(meta.gap.dropped_through_sequence)};
      }
    } catch (error) { if (error.code !== 'ENOENT') { invalid = true; gap ??= {reason: 'write_failed', dropped_rows: null, dropped_through_sequence: null}; } }
  } catch {
    durable = false; invalid = true; gap = {reason: 'write_failed', dropped_rows: null, dropped_through_sequence: null};
  }
  if (pending.length || needsRewrite) schedule();
  const drain = async () => {
    for (;;) {
      const current = chain;
      await current;
      const status = statusChain;
      await status;
      if (current === chain && status === statusChain && !scheduled && pending.length === 0 && !needsRewrite && !statusPending) return true;
      if (!scheduled && (pending.length || needsRewrite)) schedule();
    }
  };

  return {
    /** Adds one allow-listed measurement row. Returns its local opaque id, or null on projection failure. */
    record(type, data = {}) {
      try {
        if (!writerAvailable || closeRequested) return null;
        if (invalid && gap?.reason === 'write_failed') {
          const marker = makeRow('capture_gap', gap);
          if (marker) { rows.push(marker.row); bytes += Buffer.byteLength(marker.line); pending.push(marker.line); pendingBytes += Buffer.byteLength(marker.line); }
          gap = null;
        }
        const made = makeRow(type, data);
        if (!made) { appendGap('invalid_record'); schedule(); return null; }
        const size = Buffer.byteLength(made.line);
        if (size > MEASUREMENT_LIMITS.rowBytes) { appendGap('oversized_row'); schedule(); return null; }
        if (pendingBytes + size > 1024 * 1024) {
          gap = {reason: 'write_failed', dropped_rows: null, dropped_through_sequence: made.row.sequence};
          invalid = true; void persistStatus(); schedule(); return null;
        }
        rows.push(made.row); bytes += size; pending.push(made.line); pendingBytes += size;
        if (bytes > maxBytes) trimRows();
        schedule();
        return made.row.event_id;
      } catch {
        appendGap('invalid_record'); schedule(); return null;
      }
    },
    /** Waits for this partition's queued writes; callers in lending paths must not await it. */
    async flush({timeoutMs = Infinity} = {}) {
      if (!Number.isFinite(timeoutMs)) return drain();
      let timer;
      const timed = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      });
      try { return await Promise.race([drain(), timed]); }
      finally { clearTimeout(timer); }
    },
    close() {
      const alreadyDrained = !scheduled && pending.length === 0 && !needsRewrite && !statusPending;
      if (!writerAvailable) return true;
      closeRequested = true;
      if (alreadyDrained) releaseWriter();
      else void drain().then(releaseWriter, () => {});
      return alreadyDrained;
    },
    status() { return statusValue(); },
    get directory() { return root; },
  };
}

const STAGES = [
  ['sent', 'Sent'], ['picked_up', 'Picked up'], ['approval', 'Approval'], ['preparing', 'Preparing the sandbox'], ['running', 'Agent working'],
  ['checks', 'Running checks'], ['screenshots', 'Taking screenshots'], ['sending', 'Sending the result'], ['finished', 'Finished'],
];
const PROGRESS_STAGE = { preparing: 'preparing', agent: 'running', checks: 'checks', screenshots: 'screenshots', sending: 'sending' };
const FINISH_LABEL = { completed: 'Finished', failed: 'Failed', released: 'Handed back', expired: 'Expired', cancelled: 'Cancelled' };

/**
 * A per-job stage timeline from real timestamps only.
 * view: the coordinator job view; progress: its progress entries; history: this computer's rows for the job.
 * Each stage: {key, label, at, clock, durationMs, noticed, outcome?}. at is a normalized ISO time, or null when no time was recorded.
 * durationMs is set only when both ends come from one clock (the lender's monotonic elapsed_s,
 * or two observations on this computer); it is never computed across machines.
 * noticed=true means at is when this computer noticed the stage, not when it happened.
 */
export function buildJobTimeline({ view = {}, progress = [], history = [] } = {}) {
  const found = new Map();
  const put = (key, value) => { if (!found.has(key)) found.set(key, { durationMs: null, noticed: false, ...value }); };
  const attempt = view.current_attempt ?? null, signed = view.job?.payload ?? {};
  const executionAt = observedExecutionTime(attempt);
  // Only the sender knows when a job was sent; a lender's view has no submission time.
  const sentAt = iso(view.waitingTiming?.submittedAt) ?? iso(signed.created_at);
  put('sent', { at: sentAt, clock: sentAt ? 'sender' : null });
  if (iso(attempt?.claimed_at)) put('picked_up', { at: iso(attempt.claimed_at), clock: 'coordinator' });

  const approvals = history.filter(row => row.type === 'approval').sort((a, b) => a.id - b.id);
  if (approvals.length) {
    const asked = approvals.find(row => row.data?.state === 'waiting');
    const decided = approvals.find(row => row.data?.state && !['waiting', 'identity-changed'].includes(row.data.state));
    const start = asked ?? decided;
    put('approval', { at: iso(start.at), clock: 'this-computer', outcome: view.approval === 'approved' ? 'accepted' : decided?.data.state ?? 'waiting', auto: decided?.data.auto ?? null,
      durationMs: asked && decided ? Math.max(0, Date.parse(decided.at) - Date.parse(asked.at)) : null });
  }

  if (view.approval === 'approved') put('approval', {at:null,clock:null,outcome:'accepted',auto:null});

  const stages = progress.filter(entry => typeof entry?.stage === 'string' && PROGRESS_STAGE[entry.stage] && Number.isSafeInteger(entry.elapsed_s))
    .sort((a, b) => a.seq - b.seq);
  stages.forEach((entry, index) => {
    const key = PROGRESS_STAGE[entry.stage], next = stages[index + 1];
    if (key === 'running' && !iso(executionAt)) return;
    // A stage report can wait in the lender's send queue; the coordinator's execution start is exact.
    const at = key === 'running' && iso(executionAt) ? iso(executionAt) : iso(entry.at);
    put(key, { at, clock: key === 'running' && iso(executionAt) ? 'coordinator' : 'reported',
      durationMs: next ? Math.max(0, (next.elapsed_s - entry.elapsed_s) * 1000) : null });
  });
  if (!found.has('running') && iso(executionAt)) put('running', { at: iso(executionAt), clock: 'coordinator' });

  const terminalState = attempt && ['completed', 'failed', 'released', 'expired', 'cancelled'].includes(attempt.state) && iso(attempt.stopped_at) ? attempt.state : null;
  if (terminalState) put('finished', { at: iso(attempt.stopped_at), clock: 'coordinator', outcome: terminalState, label: FINISH_LABEL[terminalState] });
  else {
    const seen = history.filter(row => row.type === 'job' && TERMINAL.has(row.data?.status)).sort((a, b) => a.id - b.id)[0];
    if (seen) put('finished', { at: iso(seen.at), clock: 'this-computer', noticed: true, outcome: seen.data.status.toLowerCase(), label: seen.data.status });
    else if (['failed', 'expired', 'cancelled'].includes(view.state) || view.state === 'result-accepted')
      put('finished', { at: null, clock: null, outcome: view.state === 'result-accepted' ? 'completed' : view.state });
  }
  return {
    job_digest: view.job_digest ?? null,
    approval: view.approval ?? null,
    complete: found.has('finished'),
    stages: STAGES.filter(([key]) => found.has(key)).map(([key, label]) => ({ key, label, ...found.get(key), label: found.get(key).label ?? label })),
  };
}
