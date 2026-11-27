/**
 * Stop evidence: the one receipt that says this computer's guarded Stop works.
 *
 * The receipt belongs to the machine's sandbox runtime, so it binds to the backend id and the exact sbx version and to
 * nothing else: no account, no identity, no daemon key. It is valid for 0 <= now - measured_at < 24 h. Only the app's guarded
 * Stop of the stop-check sandbox may write it (stop-check.mjs). A usage reading never does.
 *
 * Order is kept by a generation, not by a clock. `begin()` takes the next generation and saves it before the check starts. A
 * success is accepted only if no newer generation has failed and no newer generation has begun, and a failure is recorded for its
 * own generation. So a late success of an older check cannot revive a receipt that a newer check refused, and a crash in the
 * middle of a check leaves the older receipt unusable instead of silently trusted.
 *
 * Every save writes a temporary file, syncs it, renames it over the old file and syncs the folder. A save that fails leaves
 * the last good file in place and the new evidence absent.
 */
import {open, readFile, rename, rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export const STOP_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const FORMAT = 1;

const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** A stop fact is kept only whole: a delivered, non-fallback, measured, removed stop. Anything else is refused. */
export function qualifyingStop(value) {
  return Boolean(value) && value.delivered === true && value.fallback === null && value.removed === true &&
    Number.isFinite(value.latency_ms) && value.latency_ms >= 0;
}

function sanitizeReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  if (!text(value.backend_id, 80) || !text(value.sbx_version, 120)) return null;
  if (!Number.isSafeInteger(value.measured_at) || value.measured_at < 0) return null;
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) return null;
  if (!qualifyingStop(value)) return null;
  return {backend_id: value.backend_id, sbx_version: value.sbx_version, measured_at: value.measured_at, generation: value.generation,
    delivered: true, fallback: null, latency_ms: value.latency_ms, removed: true};
}

async function writeAtomic(file, body) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = await open(pending, 'wx', 0o600);
    try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
    await rename(pending, file);
  } catch (error) { await rm(pending, {force: true}).catch(() => {}); throw error; }
  const dir = await open(dirname(file), 'r').catch(() => null);
  if (dir) { try { await dir.sync(); } catch { /* A folder that cannot sync does not undo a finished rename. */ } finally { await dir.close().catch(() => {}); } }
}

export function createStopEvidenceStore({file, now = Date.now, write = writeAtomic} = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('A stop evidence store needs a file');
  // receipt: the newest accepted success. begun: the newest generation that started a check. failed: the newest generation that failed.
  let state = {receipt: null, begun: 0, failed: 0};
  let loaded = null;
  let saving = Promise.resolve();

  async function load() {
    let parsed = null;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { parsed = null; }
    if (parsed?.v === FORMAT && Number.isSafeInteger(parsed.begun) && Number.isSafeInteger(parsed.failed)) {
      state = {receipt: sanitizeReceipt(parsed.receipt), begun: Math.max(0, parsed.begun), failed: Math.max(0, parsed.failed)};
    }
  }
  const ready = () => loaded ??= load();
  const serialized = body => JSON.stringify({v: FORMAT, receipt: body.receipt, begun: body.begun, failed: body.failed});
  // Read, validate, construct and save each mutation in one transaction. A failed
  // transaction does not poison the queue; its fail-closed memory update runs inside it.
  function transaction(operation) {
    const run = saving.then(operation);
    saving = run.catch(() => {});
    return run;
  }
  // A write can publish the file and still fail after it (a writer that throws late). Memory then reloads from disk before
  // the error goes on, so the next transaction never reuses a generation that a reopened store would already see.
  async function commit(next) {
    try { await write(file, serialized(next)); } catch (error) { await load(); throw error; }
    state = next;
  }
  // A receipt counts only if no later check began or failed after it: a check that began and never finished leaves it unusable.
  const standing = (receipt, at) => receipt !== null && Number.isFinite(at) && receipt.measured_at <= at &&
    at - receipt.measured_at < STOP_EVIDENCE_TTL_MS && state.failed < receipt.generation && state.begun <= receipt.generation;

  return {
    /** The receipt, if it is valid now. It does not look at the binding: callers compare backend and version themselves. */
    async receipt() { await ready(); await saving; return standing(state.receipt, now()) ? {...state.receipt} : null; },
    /** The receipt, only if it is valid now and bound to exactly this backend and sbx version. */
    async current(binding) {
      const receipt = await this.receipt();
      return receipt && receipt.backend_id === binding?.backend_id && receipt.sbx_version === binding?.sbx_version ? receipt : null;
    },
    /** Why there is no usable receipt for this binding: 'missing', 'expired', 'changed' or 'failed'. null when one is usable. */
    async status(binding) {
      await ready(); await saving;
      const r = state.receipt;
      if (r === null) return state.failed > 0 ? 'failed' : 'missing';
      if (state.failed >= r.generation) return 'failed';
      if (state.begun > r.generation) return 'missing';
      if (r.backend_id !== binding?.backend_id || r.sbx_version !== binding?.sbx_version) return 'changed';
      return standing(r, now()) ? null : 'expired';
    },
    /** Starts a check: takes the next generation and saves it. Rejects if the save fails, so no check runs unrecorded. */
    async begin() {
      await ready();
      return transaction(async () => {
        const generation = state.begun + 1;
        if (!Number.isSafeInteger(generation)) throw new RangeError('Stop evidence generation exhausted');
        await commit({...state, begun: generation});
        return generation;
      });
    },
    /** Records a qualifying stop of generation `generation`. Returns true only if the receipt was saved and now stands. */
    async succeed(generation, {backend_id, sbx_version, stop, measured_at = now()} = {}) {
      await ready();
      return transaction(async () => {
        if (!Number.isSafeInteger(generation) || generation < state.failed + 1 || generation < state.begun) return false;
        if (state.receipt && generation <= state.receipt.generation) return false;
        const receipt = sanitizeReceipt({backend_id, sbx_version, measured_at, generation, ...stop});
        if (!receipt) return false;
        try { await commit({receipt, begun: Math.max(state.begun, generation), failed: state.failed}); } catch { return false; }
        return true;
      });
    },
    /** Records that a qualifying stop check failed. It invalidates every older receipt. Never throws; false if it could not be saved. */
    async fail(generation) {
      await ready();
      return transaction(async () => {
        if (!Number.isSafeInteger(generation) || generation < 1) return false;
        const failed = Math.max(state.failed, generation);
        try { await commit({...state, begun: Math.max(state.begun, generation), failed}); } catch {
          // Keep the refusal in memory before allowing the next transaction to run.
          state = {...state, begun: Math.max(state.begun, generation), failed};
          return false;
        }
        return true;
      });
    },
  };
}
