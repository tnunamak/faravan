// Served-model evidence labels. Kept free of Node built-ins: the web UI imports it
// through lending-policy.mjs, and attempt-evidence.mjs needs node:crypto.
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value)
  && !/^(sk-|Bearer)/i.test(value) ? value : null;
const enumOf = (value, values) => values.includes(value) ? value : null;

// Model names are evidence labels, never pricing inputs. A requested name alone
// cannot identify the model that served a run, and provider effort is unobserved.
export function servedModelEvidence(value) {
  const source = enumOf(value?.source, ['guard', 'stream']);
  const served = source ? id(value?.served) : null;
  return {requested: id(value?.requested), effort_requested: id(value?.effort_requested),
    served, source: served === null ? 'unknown' : source,
    reason: served !== null ? null : value == null ? 'not_recorded'
      : enumOf(value.reason, ['not_recorded', 'no_source_reported_model', 'invalid_reported_model']) ?? 'no_source_reported_model',
    effort_served: 'unknown', effort_served_reason: 'provider_does_not_report_effort'};
}

export function observeServedModel({model = null, effort = null, observation = null, parsed = null} = {}) {
  // Preserve the meter's guard-before-stream precedence without feeding this
  // projection back into the meter or falling back to the requested model.
  const reported = observation?.model ?? parsed?.model ?? null;
  const source = observation?.model != null ? 'guard' : parsed?.model != null ? 'stream' : 'unknown';
  return servedModelEvidence({requested: model, effort_requested: effort, served: reported, source,
    reason: reported === null ? 'no_source_reported_model' : 'invalid_reported_model'});
}

export function mergeServedModelEvidence(previous, value) {
  const before = servedModelEvidence(previous), after = servedModelEvidence(value);
  const rank = {unknown: 0, stream: 1, guard: 2};
  // Retries may supply missing evidence but cannot erase an established request
  // or replace a guard report with a weaker stream/request-only observation.
  const reported = rank[after.source] >= rank[before.source] ? after : before;
  return {...reported, requested: before.requested ?? after.requested,
    effort_requested: before.effort_requested ?? after.effort_requested};
}
