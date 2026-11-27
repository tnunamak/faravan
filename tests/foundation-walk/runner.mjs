import { CHECKS, receipt, aggregate, jsonl } from './receipts.mjs';

export const DEADLINES = Object.freeze({
  W03_INVITE_JOIN: 60_000, W05_SEND_SELECTED: 300_000, W06_RESULT_RETURN: 600_000,
});
/**
 * Portable test seam, NOT a new product API. Integration supplies:
 * clock {now,setTimeout,clearTimeout}; state {load,save,writeEvidence} (atomic durable save; evidence writes local only);
 * driver {run,resume,cleanup}; secretFile {withValue(callback)}.
 * driver owns opaque login flow state; resume must continue, never re-enroll
 * or re-submit. No filesystem, browser, credential store or network is used
 * here. withValue must enforce absolute 0600 secret-file access externally.
 * Driver results: {outcome,observed,evidencePaths,pause:'login'?}.
 * Cleanup is always W10, including after failure or login pause. All effects
 * must honor signal; a timeout alone never proves remote cessation.
 */
export function createRunner({ binding, clock, state, driver, secretFile }) {
  binding = { platform: binding.platform, head: binding.head, artifactSha256: binding.artifactSha256 };
  // Validate pinned identity before any effect, even with an empty receipt history.
  receipt({ schemaVersion: 1, ...binding, check: CHECKS[0], outcome: 'blocked', observed: {}, elapsedMs: 0, evidencePaths: [] });
  let busy = false;
  async function walk({ resume = false } = {}) {
    if (busy) throw new Error('walk_already_running');
    busy = true;
    try {
      let saved = await state.load();
      if (saved && (saved.schemaVersion !== 1 || JSON.stringify(saved.binding) !== JSON.stringify(binding))) {
        throw new Error('walk_binding_mismatch');
      }
      saved ??= { schemaVersion: 1, binding: { ...binding }, receipts: [], pending: null };
      // Validate old receipts before any driver effect.
      aggregate(saved.receipts, binding);
      const persist = () => state.save(structuredClone(saved));
      async function execute(check, recovering) {
        const prior = recovering ? saved.pending : null;
        const now = clock.now();
        const used = prior ? prior.elapsedMs + (prior.status === 'running' ? Math.max(0, now - prior.startedAt) : 0) : 0;
        const budget = DEADLINES[check] ?? null;
        const controller = new AbortController();
        saved.pending = { check, startedAt: now, elapsedMs: used, status: 'running' };
        await persist(); // Ambiguous effects survive a crash as resume-only.
        let timer;
        let elapsedMs = used;
        let entry;
        let paused = false;
        try {
          await secretFile.withValue(async secret => {
            const operation = budget !== null && used >= budget ? Promise.resolve(null) : Promise.resolve().then(() =>
              (recovering ? driver.resume : driver.run)({
                check, signal: controller.signal, binding: { ...binding }, secret,
              }));
            const timeout = budget === null ? new Promise(() => {}) : new Promise(resolve => {
              timer = clock.setTimeout(() => {
                controller.abort();
                resolve({ outcome: 'fail', observed: { code: 'walk_deadline_exceeded' }, evidencePaths: [] });
              }, Math.max(0, budget - used));
            });
            // A past-deadline crash recovery must not start another action.
            let result = budget !== null && used >= budget
              ? { outcome: 'fail', observed: { code: 'walk_deadline_exceeded' }, evidencePaths: [] }
              : await Promise.race([operation, timeout]);
            elapsedMs = used + Math.max(0, clock.now() - now);
            if (budget !== null && elapsedMs >= budget) {
              result = { outcome: 'fail', observed: { code: 'walk_deadline_exceeded' }, evidencePaths: [] };
            }
            paused = result.pause === 'login' && result.outcome === 'blocked';
            entry = receipt({ schemaVersion: 1, ...binding, check,
              outcome: result.outcome, observed: result.observed,
              evidencePaths: result.evidencePaths, elapsedMs }, [secret]);
          });
        } catch {
          // Never serialize thrown errors, upstream bodies, or login URLs.
          entry = receipt({ schemaVersion: 1, ...binding, check, outcome: 'fail',
            observed: { code: 'walk_driver_failed' }, elapsedMs: used + Math.max(0, clock.now() - now),
            evidencePaths: [] });
        } finally {
          if (timer !== undefined) clock.clearTimeout(timer);
          controller.abort();
        }
        saved.receipts.push(entry);
        saved.pending = paused ? { check, startedAt: clock.now(), elapsedMs, status: 'login' } : null;
        await persist();
        return paused;
      }
      const pending = saved.pending;
      let paused = false;
      if (pending && !resume) paused = true;
      else if (pending) paused = await execute(pending.check, true);
      for (const check of CHECKS) {
        if (paused || check === 'W10_CLEANUP') continue;
        // Retain every receipt; a previous failure must never be overwritten.
        if (saved.receipts.some(r => r.check === check)) continue;
        paused = await execute(check, false);
      }
      // Cleanup has its own driver method and must never erase login state.
      try {
        const started = clock.now();
        await secretFile.withValue(async secret => {
          const result = await driver.cleanup({ binding: { ...binding }, paused });
          saved.receipts.push(receipt({ schemaVersion: 1, ...binding, check: 'W10_CLEANUP',
            outcome: result.outcome, observed: result.observed, evidencePaths: result.evidencePaths,
            elapsedMs: Math.max(0, clock.now() - started) }, [secret]));
        });
      } catch {
        saved.receipts.push(receipt({ schemaVersion: 1, ...binding, check: 'W10_CLEANUP',
          outcome: 'fail', observed: { code: 'walk_cleanup_failed' }, evidencePaths: [], elapsedMs: 0 }));
      }
      await persist();
      const output = { records: structuredClone(saved.receipts), jsonl: jsonl(saved.receipts),
        result: aggregate(saved.receipts, binding) };
      await state.writeEvidence('checks.jsonl', output.jsonl);
      await state.writeEvidence('result.json', JSON.stringify(output.result) + '\n');
      return output;
    } finally { busy = false; }
  }
  return { walk };
}
