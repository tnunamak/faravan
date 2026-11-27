import {durableJson} from '../durable-write.mjs';
// An owner-initiated, one-job presence override. The owner asks that one named job run although the owner is present. It names
// the job, it is single-use, and it expires within a bounded time. Nothing grants it by default: no request, a different job,
// an expired request and an already-used request all grant nothing. Every request and every grant is audited.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE = 'presence-override.json';
// The longest any one override may live. A request that asks for longer is refused, so an override cannot outlast a short job.
export const PRESENCE_OVERRIDE_MAX_TTL_MS = 30 * 60 * 1000;
const nonempty = (value) => typeof value === 'string' && value.trim() !== '';

export function createPresenceOverrideStore({directory}) {
  const path = join(directory, FILE);
  // The state, or null when the file exists and cannot be trusted. A missing file is an empty state.
  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed?.records) && Array.isArray(parsed?.audit) ? parsed : null;
    } catch (error) {
      return error?.code === 'ENOENT' ? {records: [], audit: []} : null;
    }
  };
  const write = (state) => {
    durableJson(path, state);
  };
  // The newest record for the job, with the reason it grants nothing (or null when it grants).
  const grantFor = (state, jobId, now) => {
    const record = [...state.records].reverse().find((r) => r.job_id === jobId);
    if (!record) return {granted: false, reason: 'no_override', record: null};
    if (record.consumed_at !== null) return {granted: false, reason: 'already_consumed', record};
    if (!(now < record.expires_at)) return {granted: false, reason: 'expired', record};
    return {granted: true, reason: null, record};
  };
  return {
    // Records an explicit request for one job. The owner, the reason and a bounded lifetime are all required.
    request({jobId, by, reason, now, ttlMs}) {
      if (!nonempty(jobId) || !nonempty(by) || !nonempty(reason) || !Number.isFinite(now) ||
        !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > PRESENCE_OVERRIDE_MAX_TTL_MS) {
        throw new Error('invalid_presence_override: a request needs a job, an owner, a reason, a time and a lifetime up to the bound');
      }
      const state = read();
      if (state === null) throw new Error('unreadable_presence_override: refusing to write over records whose contents are unknown');
      const record = {job_id: jobId, requested_by: by, reason, requested_at: now, expires_at: now + ttlMs, consumed_at: null};
      state.records.push(record);
      state.audit.push({event: 'requested', at: now, by, job_id: jobId, reason, expires_at: record.expires_at});
      write(state);
      return {...record};
    },
    // Whether the override would grant this job now. It spends nothing: the candidate calls consume only after its admission succeeds.
    available({jobId, now}) {
      const state = read();
      if (state === null) return {granted: false, reason: 'unreadable'};
      const {granted, reason} = grantFor(state, jobId, now);
      return {granted, reason};
    },
    // Grants the override for exactly this job, once, if it was requested, is unused, and has not expired. Otherwise grants nothing.
    consume({jobId, now}) {
      const state = read();
      if (state === null) return {granted: false, reason: 'unreadable'};
      const {granted, reason, record} = grantFor(state, jobId, now);
      if (!granted) return {granted: false, reason};
      record.consumed_at = now;
      state.audit.push({event: 'consumed', at: now, by: record.requested_by, job_id: jobId});
      write(state);
      return {granted: true};
    },
    // The overrides that are still usable at this time, for the owner to see.
    active({now}) {
      const state = read();
      if (state === null) throw new Error('unreadable_presence_override: the records cannot be read');
      return state.records.filter((r) => r.consumed_at === null && now < r.expires_at)
        .map((r) => ({job_id: r.job_id, requested_by: r.requested_by, reason: r.reason, expires_at: r.expires_at}));
    },
    audit() {
      return read()?.audit ?? [];
    },
  };
}
