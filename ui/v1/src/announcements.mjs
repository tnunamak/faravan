// Job-state announcements for screen readers (PRODUCT-UX-FIELD-RESEARCH §14.2). They go through the app's one polite
// notice region. Re-reads/reconnects do not repeat identities retained in this caller's bounded history.
// main.jsx keeps this state in a component ref: no cross-tab or remount persistence is provided.
// The first load only records what is known. Logs and transcript lines are never announced.
import {jobsListVM} from './view-models.mjs';

const HISTORY_LIMIT = 512;
const binding = (id, circleId) => JSON.stringify([id, circleId]);
const runOf = job => {
  const attempt = job?.current_attempt;
  return typeof attempt === 'string' ? attempt : attempt?.attempt_id ?? '';
};

/** `seen` is the Map from the previous call (null on the first load); returns the next Map and what to say.
 * Map entries describe the latest snapshot; its separate `history` Set retains up to 512 full identities,
 * evicting the oldest insertion first. Re-reading an identity does not refresh its age. After eviction it
 * may speak again. Both collections belong to the caller; this function never mutates the input state.
 * `options.open` is the job whose page is open: that page speaks for itself from its own, fresher read, so the
 * slower list never announces a status the page no longer shows (r8 O16). */
export function jobAnnouncements(seen, jobs, options = {}) {
  if (!Array.isArray(jobs)) return {seen, messages: []};
  const byId = new Map(jobs.map(job => [binding(job.job_digest, job.circle?.id ?? ''), job]));
  // group.rows is every row; group.items folds runs of 3+ jobs ran for others into one batch row for display only.
  const rows = jobsListVM(jobs, options).groups.flatMap(group => group.items.flatMap(item => item.batch ? item.rows : [item]));
  // Membership is fixed at call entry; output eviction must not make later rows new.
  const entryHistory = seen?.history ?? new Set();
  const next = new Map(), changed = [], history = new Set(entryHistory), observed = new Set();
  for (const row of rows) {
    if (!row.id) continue;
    const id = binding(row.id, row.circleId);
    const attempt = runOf(byId.get(id));
    const signature = JSON.stringify([row.id, row.circleId, attempt, row.key]);
    next.set(id, JSON.stringify([attempt, row.key]));
    const known = entryHistory.has(signature) || observed.has(signature);
    observed.add(signature);
    if (!known) {
      history.add(signature);
      while (history.size > HISTORY_LIMIT) history.delete(history.values().next().value);
      if (seen && row.id !== options.open) changed.push(row);
    }
  }
  next.history = history;
  const messages = changed.length > 2 ? [changed.length + ' jobs changed. Open Jobs to see them.']
    : changed.map(row => row.title + ': ' + row.word + '.');
  return {seen: next, messages};
}
