import {emptyTokens, priceCodexCredits} from './lending-meter.mjs';

// Codex's existing guard weights describe how its meter charges a model. They
// are meter inputs, not a second admission rule.
export function weightsFor(model, catalog) {
  const part = key => priceCodexCredits(model, {...emptyTokens(), [key]: 1}, {catalog}).credits;
  const input = part('fresh_input');
  const cached_input = part('cache_read');
  const output = part('output');
  return [input, cached_input, output].every(Number.isFinite) ? {input, cached_input, output} : null;
}

// Compatibility facade for callers that still ask the runtime manager for an
// admission. All decisions and reservations come from the durable candidate.
export function createLendingManager({candidate = null} = {}) {
  const unavailable = {admitted: false, reason: 'objective_evidence_unknown', budget_units: 0};
  return {
    async admission({provider, harness, automatic, ownerAbsent, jobId, job, model, intentOn, paused} = {}) {
      if (!candidate) return unavailable;
      const resolved = provider ?? (String(harness).startsWith('claude') ? 'claude' : harness === 'codex' ? 'codex' : null);
      if (!resolved) return unavailable;
      const reason = await candidate.gate({provider: resolved, automatic, ownerAbsent, jobId, job, model, intentOn, paused});
      const decision = candidate.decisionFor?.(resolved);
      return {admitted: !reason, reason: reason ?? decision?.reason ?? 'objective_evidence_unknown',
        budget_units: decision?.objective?.nativeMaxBudgetUsd ?? 0, objective: decision?.objective ?? null};
    },
    async reserve(args) {
      if (!candidate) return {ok: false, reason: unavailable.reason};
      return candidate.reserve(args);
    },
    async finish(args) {
      if (!candidate) return {metered: null, cessation: {applied: false, reason: unavailable.reason}};
      return candidate.finish(args);
    },
    async release(attemptId, args) {
      if (!candidate) return {applied: false, reason: unavailable.reason};
      return candidate.release(attemptId, args);
    },
    observe() {},
    shadow: () => [],
  };
}
