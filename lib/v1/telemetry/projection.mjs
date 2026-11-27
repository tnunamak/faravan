// Projection: what the app saw -> what telemetry may say about it. Pure, synchronous and total: bad input gives [].
// This is the privacy boundary. It reads only the fields it names, maps each to a catalog enum, a bucket label or a
// number, and drops everything else: job digests, attempt IDs, circle and key IDs, names, labels, messages and paths.
// Its sibling for local history is projectEvent() in event-history.mjs.
//
// An Observation is the vocabulary between projection and rollup; every `attrs` value is already a catalog value.
//   {op:'count', name, attrs, n?, origin?, period?, dedupe?}      add n (default 1) to a counts cell; `dedupe` counts a key once
//   {op:'hist',  name, attrs, value, origin?}                      one sample for a histogram cell
//   {op:'diag',  name, kind, attrs, sample?, origin?, hour?, duration_ms?, status?}  a diagnostic record; `sample` applies the exemplar rule
//   {op:'span',  family, key, step, ...}                           a lifecycle: step open | stage | close | discard
//   {op:'record', name, attrs}                                     a quota-week record
//   {op:'milestone', milestone}                                    a funnel milestone, once per install lifetime
//   {op:'suppress', key}                                           drop the lifecycle records of this local job key
// Only occurrence owners produce `problem.count`: `response`, `lender-failure`, crash and inbox. A spine event never does.
import { classify, FAILURE_CODES, isLenderDecision } from '../failures.mjs';
import { bucket, enumMembers } from './catalog.mjs';
import { observedExecutionTime } from '../state-projection.mjs';

const members = name => new Set(enumMembers(name));
const ERROR_TYPES = members('error_type'), PHASES = members('phase'), STOP_REASONS = members('stop_reason');
const FAILURES = new Set(FAILURE_CODES);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : null);
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const pick = (set, value, fallback) => (typeof value === 'string' && set.has(value) ? value : fallback);
const errorType = code => (typeof code === 'string' && ERROR_TYPES.has(code) ? code : 'unknown');
const secondsBetween = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && to >= from ? (to - from) / 1000 : null);
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));

/** A harness id or family -> the catalog's harness enum. */
const harnessOf = value => {
  const id = text(value) ?? '';
  return id.startsWith('claude') ? 'claude-code' : id.startsWith('codex') ? 'codex' : id === 'any' ? 'any' : 'unknown';
};
const providerHarness = provider => (provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex' : 'unknown');

// ---- Responses (the response observer) ------------------------------------------------------------------------

/** The code of a failed response. The minimal local form of normalizeProblem until the problem catalog lands (design §10). */
export function problemCode(body, status) {
  const source = isObject(body) ? body : {};
  const secondary = source.code === 'apply_refused' ? 'result_' + text(source.apply_code) : source.code === 'repo_refused' ? text(source.repo_code) : null;
  let code = secondary && ERROR_TYPES.has(secondary) ? secondary : errorType(source.code);
  if (status === 401) code = 'unauthorized';
  else if (status === 429) code = 'rate_limited';
  else if (code === 'unknown' && !source.code && status === 409) code = 'conflict';
  else if (code === 'unknown' && !source.code && status === 404) code = 'not_found';
  return code;
}

const WRITER_COMPONENT = {app: 'app', ops: 'ops', phone: 'phone'};
const API_AREAS = members('api_area');
const SURFACES = members('surface');

/** The coarse readiness of this computer for a problem exemplar: four facts, each ok, blocked or unknown. */
function readinessSnapshot(health) {
  if (!isObject(health)) return undefined;
  const checks = new Map((Array.isArray(health.readiness?.checks) ? health.readiness.checks : []).map(c => [c?.name, c?.ok === true]));
  const group = names => {
    const seen = names.filter(name => checks.has(name));
    return seen.length === 0 ? 'unknown' : seen.every(name => checks.get(name)) ? 'ok' : 'blocked';
  };
  const fact = (value, yes, no) => (value === yes ? 'ok' : value === no ? 'blocked' : 'unknown');
  return {docker: group(['docker_runtime', 'docker_login']),
    sbx: group(['sbx_install', 'sbx_version', 'sbx_cli_contract', 'sbx_daemon', 'kvm_access', 'sbx_credential_store', 'network_policy']),
    agent_signed_in: fact(health.signedIn?.any, true, false)};
}

function problemObservations({code, phase, component, surface, extra = {}, health}) {
  if (isLenderDecision(code)) return []; // a stop or a decision is not a problem (design §2.2)
  const outcome = classify(code, phase === 'none' ? 'before_claim' : phase).outcome;
  const attrs = {'error.type': code, 'problem.registry': FAILURES.has(code) ? 'failure' : 'problem', component, phase, outcome, surface};
  return [{op: 'count', name: 'problem.count', attrs}, {op: 'diag', name: 'problem.observed.readiness', kind: 'event', attrs: compact({...attrs, ...extra, readiness: readinessSnapshot(health)}), sample: code + '|' + component}];
}

function responseObservations(data, ctx) {
  const status = number(data.status);
  if (status === null) return [];
  const surface = pick(SURFACES, data.surface, 'http');
  const writer = pick(new Set(Object.keys(WRITER_COMPONENT)), data.writer, 'app');
  const failed = status >= 400;
  const code = failed ? problemCode(data.body, status) : null;
  const out = [];
  // Ops calls are usage. A failure that came from the inner REST call was already counted there (`fromRest`).
  if (data.opId) {
    const op = pick(members('op'), data.opId, null);
    if (op) {
      const attrs = compact({op, surface, ok: !failed, 'error.type': code ?? undefined});
      out.push({op: 'count', name: 'op.count', attrs});
      const seconds = number(data.durationMs) === null ? null : data.durationMs / 1000;
      if (seconds !== null) out.push({op: 'hist', name: 'op.duration', attrs, value: seconds});
    }
  }
  // A failed hosting start or stop is the coordinator's occurrence: the coordinator writes the record for the listener, store
  // or tunnel that failed (design §2.3, §7). Here the op is only usage, so one failure is never counted twice.
  const coordinatorOwned = data.opId === 'hosting.start' || data.opId === 'hosting.stop';
  if (failed && !(data.opId && data.fromRest) && !coordinatorOwned) {
    const area = pick(API_AREAS, data.area, undefined);
    out.push(...problemObservations({code, phase: 'none', component: WRITER_COMPONENT[writer], surface,
      extra: compact({op: pick(members('op'), data.opId, undefined), 'api.area': area}), health: ctx.health}));
  }
  if (data.scopeOff && !failed && isObject(data.body) && typeof data.body.job_digest === 'string') out.push({op: 'suppress', key: 'borrower:' + data.body.job_digest});
  return out;
}

// Another computer taking the job first is contention, not a fault: the offer-decision event records it.
const CONTENTION = new Set(['conflict']);
function lenderFailureObservations(data, ctx) {
  if (CONTENTION.has(data.code)) return [];
  const code = errorType(data.code);
  return problemObservations({code, phase: pick(PHASES, data.phase, 'none'), component: 'lender', surface: 'background', health: ctx.health});
}

// ---- Spans ------------------------------------------------------------------------------------------------------

const OK_OUTCOMES = new Set(['finished', 'complete', 'applied', 'staged', 'ok', 'passed']);
/**
 * Lifecycle families. `stages` names the enum of a span's stage list; `derive(closed)` gives the counts and histograms a
 * closed span adds (preserving failure rates and durations alongside spans). `closed` is
 * {attrs, durationMs, stages:[{stage, ms, ok}]}.
 */
export const FAMILIES = Object.freeze({
  'job.run': {stages: 'job_stage', derive: ({attrs, durationMs, stages}) => [
    {op: 'count', name: 'job.outcome.count', attrs: compact({'job.role': attrs['job.role'], outcome: attrs.outcome, 'error.type': attrs['error.type']})},
    {op: 'hist', name: 'job.duration', attrs: {'job.role': attrs['job.role'], outcome: attrs.outcome}, value: durationMs / 1000},
    ...stages.map(s => ({op: 'hist', name: 'job.stage.duration', attrs: {'job.role': attrs['job.role'], stage: s.stage}, value: s.ms / 1000}))]},
  'setup.readiness': {derive: ({attrs}) => (attrs.checks ?? []).map(c => ({op: 'count', name: 'setup.check.count', attrs: {check: c.check, state: c.state, repaired: c.repaired}}))},
  'upgrade.run': {stages: 'upgrade_stage', derive: ({attrs}) => [{op: 'count', name: 'upgrade.count', attrs: {owner: attrs.owner, outcome: attrs.outcome}}]},
  'install.run': {derive: ({attrs}) => [{op: 'count', name: 'install.count', attrs: {method: attrs.method, outcome: attrs.outcome}}]},
  'signin.run': {derive: ({attrs}) => [{op: 'count', name: 'signin.count', attrs: {harness: attrs.harness, outcome: attrs.outcome}}]},
});
export const spanOk = attrs => OK_OUTCOMES.has(attrs.outcome);

const open = (family, key, extra = {}) => ({op: 'span', family, key, step: 'open', ...extra});
const stage = (family, key, name) => ({op: 'span', family, key, step: 'stage', stage: name});
const close = (family, key, attrs, extra = {}) => ({op: 'span', family, key, step: 'close', attrs: compact(attrs), ...extra});

// ---- Borrower jobs (event:job) ----------------------------------------------------------------------------------

const SOURCE_KINDS = members('source_kind'), RESULT_KINDS = members('result_kind');
const sourceKind = source => (!isObject(source) ? 'none' : pick(SOURCE_KINDS, text(source.kind) === 'files_v1' ? 'files' : source.kind, 'folder'));
const JOB_OUTCOME = {'result-accepted': 'finished', failed: 'failed', expired: 'expired', cancelled: 'cancelled'};

function jobObservations(view, ctx) {
  const digest = text(view.job_digest);
  if (!digest || view.deleted === true) return [];
  const state = text(view.state);
  const payload = isObject(view.job?.payload) ? view.job.payload : {};
  const requirements = isObject(payload.requirements) ? payload.requirements : {};
  const harnesses = Array.isArray(requirements.harness) ? requirements.harness : [];
  const harness = harnesses.length === 1 ? harnessOf(harnesses[0]) : 'any';
  const created = Date.parse(payload.created_at), expires = Date.parse(payload.expires_at);
  const deadline = Number.isFinite(created) && Number.isFinite(expires) ? bucket('wait_s', Math.max(0, (expires - created) / 1000)) : bucket('wait_s', 0);
  const attempts = number(view.attempts_started) ?? 0;
  const key = 'borrower:' + digest;
  const code = text(view.current_attempt?.reason?.code) ?? text(view.waiting_reason);
  const requestAttrs = {harness, deadline, 'source.kind': sourceKind(payload.source), ...(isObject(payload.result) ? {'result.kind': pick(RESULT_KINDS, payload.result.kind, undefined)} : {})};
  const out = [];
  const request = outcome => out.push({op: 'count', name: 'lending.request.outcome', attrs: compact({outcome, ...requestAttrs}), dedupe: 'request:' + digest});

  const opening = {since: created, stageName: 'waiting', abandon: {'job.role': 'borrower', outcome: 'abandoned'}};
  if (state === 'queued') out.push(open('job.run', key, opening));
  if (state === 'claimed') {
    const executionAt = observedExecutionTime(view.current_attempt);
    out.push(open('job.run', key, opening), stage('job.run', key, executionAt ? 'run' : 'prepare'));
    // The request's outcome is reported once, when it ends (below): a claimed job may still run out of retries.
    const claimed = Date.parse(view.current_attempt?.claimed_at);
    const wait = secondsBetween(created, claimed);
    if (wait !== null) out.push({op: 'hist', name: 'lending.request.wait', attrs: {harness}, value: wait, dedupe: 'wait:' + digest});
  }
  const outcome = JOB_OUTCOME[state];
  if (outcome) {
    const retryExhausted = code === 'retry_exhausted';
    if (attempts === 0 && outcome === 'expired') request('expired_unclaimed');
    else if (attempts === 0 && outcome === 'cancelled') request('cancelled_unclaimed');
    else if (retryExhausted) request('retry_exhausted');
    else request('claimed');
    out.push(close('job.run', key, {
      'job.role': 'borrower', outcome, 'error.type': outcome === 'failed' || outcome === 'expired' ? errorType(code ?? 'unknown') : undefined,
      harness, egress: pick(members('egress'), requirements.egress, undefined), 'source.kind': requestAttrs['source.kind'], 'result.kind': requestAttrs['result.kind'],
      verify: isObject(payload.verify), attempts: bucket('small', attempts)}, {since: created, ranFrom: Date.parse(observedExecutionTime(view.current_attempt))}));
  }
  return out;
}

// ---- Lender jobs (event:lending) --------------------------------------------------------------------------------

const LENDER_CLOSE = new Set(['finished', 'failed', 'stopped', 'declined', 'preparation-failed', 'result-unconfirmed']);
function lendingObservations(data) {
  const status = text(data.status);
  const account = text(data.account);
  if (!status || !account) return [];
  const key = 'lender:' + account;
  const harness = providerHarness(account.split(':')[0]);
  const reason = text(data.reason);
  if (status === 'accepting' || status === 'preparing') return [open('job.run', key, {stageName: 'prepare', abandon: {'job.role': 'lender', outcome: 'abandoned'}})];
  if (status === 'running') return [stage('job.run', key, 'run')];
  // The stop reason (done, budget, time, owner, provider_limit) rides on the states that follow the run.
  if (status === 'sending-result') return [stage('job.run', key, 'result'), ...(data.stopReason ? [{op: 'span', family: 'job.run', key, step: 'note', attrs: {'stop.reason': pick(STOP_REASONS, text(data.stopReason), undefined)}}] : [])];
  if (!LENDER_CLOSE.has(status)) return [];
  const code = reason ? errorType(reason) : undefined;
  let outcome = 'finished', stop;
  if (status === 'failed' || status === 'declined' || status === 'preparation-failed') {
    const row = classify(reason ?? 'unknown', status === 'preparation-failed' ? 'prepare' : 'run');
    outcome = row.outcome === 'uncertain' || row.outcome === 'delayed' ? 'uncertain' : 'failed';
  } else if (status === 'result-unconfirmed') {
    outcome = 'uncertain';
  } else if (status === 'stopped') {
    outcome = reason === 'cancelled' ? 'cancelled' : 'stopped';
    stop = reason === 'stopped_by_lender' ? 'owner' : undefined;
  } else {
    stop = pick(STOP_REASONS, text(data.stopReason), undefined);
  }
  // A job that stopped at its budget or time limit still finished: the reason says why.
  return [close('job.run', key, {'job.role': 'lender', outcome, 'error.type': outcome === 'failed' || outcome === 'uncertain' ? code : undefined, 'stop.reason': stop, harness})];
}

// ---- Setup, sign-in, updates -----------------------------------------------------------------------------------

const READINESS = members('readiness_check');

/** The last readiness report -> the setup.readiness `checks` list. */
function readinessChecks(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  return checks.flatMap(check => (typeof check?.name === 'string' && READINESS.has(check.name)
    ? [{check: check.name, state: check.ok === true ? 'ok' : 'blocked', repaired: false}] : [])).slice(0, 16);
}

function signinObservations(view) {
  const flow = text(view.flowId), status = text(view.status);
  if (!flow || !status) return [];
  const key = 'signin:' + flow;
  if (status === 'starting') return [open('signin.run', key, {abandon: {harness: harnessOf(view.target), outcome: 'timed_out'}})];
  if (!['complete', 'failed', 'cancelled', 'timed_out'].includes(status)) return [];
  return [close('signin.run', key, {harness: harnessOf(view.target), outcome: status}),
    ...(status === 'complete' ? [{op: 'milestone', milestone: 'agent_signed_in'}] : [])];
}

const UPDATE_OWNERS = members('update_owner');
function updateObservations(view) {
  const state = text(view.state);
  const key = 'upgrade:run';
  if (state === 'checking') return [open('upgrade.run', key, {stageName: 'check'})];
  if (state === 'available') return [stage('upgrade.run', key, 'download')];
  if (state === 'current' || state === 'idle' || state === 'managed') return [{op: 'span', family: 'upgrade.run', key, step: 'discard'}];
  if (!['applied', 'staged', 'failed', 'rolled_back'].includes(state)) return [];
  const owner = pick(UPDATE_OWNERS, view.owner, null);
  const from = text(view.currentVersion), to = text(view.candidate);
  if (!owner || !from || !to) return [];
  return [close('upgrade.run', key, {from, to, owner, outcome: state, 'error.type': state === 'failed' ? 'unknown' : undefined}),
    ...(state === 'applied' ? [{op: 'milestone', milestone: 'upgraded'}] : [])];
}

// ---- Lending demand and quota (new spine events from lending code) ---------------------------------------------

const OFFER_OUTCOMES = members('offer_outcome'), OFFER_REASONS = members('offer_reason'), MODES = members('offer_mode'), PRESETS = members('preset'), PLANS = members('plan');
function offerObservations(data, ctx) {
  const outcome = pick(OFFER_OUTCOMES, data.outcome, null);
  if (!outcome) return [];
  const preset = pick(PRESETS, ctx.preset, 'unknown');
  // Why offers are refused is also the best sign of a lender's meter and sign-in: reported as health, once an hour.
  const health = {quota_unknown: ['quota_meter', 'degraded'], agent_signed_out: ['agent_signin', 'blocked']}[data.reason];
  const state = health ? [{op: 'count', name: 'health.state', attrs: {check: health[0], state: health[1]}, dedupe: 'health:' + health[0] + ':' + ctx.hour}] : [];
  const overflow = number(data.mapOverflow) > 0 ? [{op: 'count', name: 'telemetry.self', attrs: {reason: 'offer_map_full', entry: 'lending.offer.decision'}, n: data.mapOverflow}] : [];
  return [...overflow, ...state, {op: 'count', name: 'lending.offer.decision', attrs: {outcome, reason: pick(OFFER_REASONS, data.reason, 'none'), harness: harnessOf(data.harness), preset,
    mode: pick(MODES, data.mode, 'ask'), wall: bucket('duration_s', number(data.wallSeconds) ?? 0), deadline: bucket('wait_s', number(data.deadline) ?? 0)}}];
}

/** The allowance totals are the owner's use of the whole agent account, outside Faravan too: sent only when the person chooses them (D3). */
export const ALLOWANCE_RECORDS = Object.freeze(['quota.week', 'quota.window.closed']);

function quotaObservations(data, ctx) {
  const provider = pick(members('provider'), data.provider, null);
  if (!provider || !isObject(data)) return [];
  const slots = Array.isArray(data.slots) ? data.slots : [];
  const slot = value => (number(value) === null ? null : bucket('points', value));
  const attrs = {provider, plan: pick(PLANS, data.plan, 'unknown'), preset: pick(PRESETS, ctx.preset ?? data.preset, 'unknown'), lending_on: data.lendingOn === true,
    owner_used: bucket('pct10', number(data.ownerUsedPct) ?? 0), lent: bucket('points', number(data.lentPoints) ?? 0), unused: bucket('pct10', number(data.unusedPct) ?? 0),
    shortfall: data.shortfall === true, coverage: bucket('coverage', number(data.coverage) ?? 0), contaminated: data.contaminated === true, history: bucket('small', number(data.history) ?? 0)};
  // The allowance totals are the owner's use across the whole account, outside Faravan too: sent only when the person chose them.
  if (data.windowKind === 'five_hour') return ctx.allowance ? [{op: 'count', name: 'quota.window.closed', attrs}] : [];
  // Per-job charges come from the seven-day window only, so a job that spans both windows is counted once.
  const charges = data.windowKind === 'seven_day' && Array.isArray(data.charges) ? data.charges.flatMap(charge => (number(charge?.points) === null ? [] : [{op: 'hist', name: 'lending.job.charge',
    attrs: {harness: providerHarness(provider), 'stop.reason': pick(STOP_REASONS, charge.stopReason, 'error'), preset: attrs.preset}, value: charge.points}])) : [];
  if (data.windowKind !== 'seven_day' || slots.length !== 28) return [];
  if (!ctx.allowance) return charges;
  return [...charges, {op: 'record', name: 'quota.week', attrs: {...attrs, slots: slots.map(s => ({o: slot(s?.o), l: slot(s?.l)}))}}];
}

// ---- Health snapshot -------------------------------------------------------------------------------------------

const HEALTH_CHECKS = members('health_check');
const HEALTH_STATES = members('health_state');
const stateOf = ok => (ok === true ? 'ok' : ok === false ? 'blocked' : 'unknown');

/**
 * The hourly health pull: raw status objects the app already has -> health.state per check, once per install-hour, and
 * install.active once per install-day. Each section is optional; a missing one is simply not reported.
 */
function healthObservations(data, ctx) {
  const rows = [];
  const add = (check, state, reason) => { if (HEALTH_CHECKS.has(check) && HEALTH_STATES.has(state)) rows.push({check, state, reason}); };
  for (const c of Array.isArray(data.readiness?.checks) ? data.readiness.checks : []) if (typeof c?.name === 'string') add(c.name, stateOf(c.ok));
  if (data.history) add('event_history_durable', data.history.durable === false ? 'degraded' : 'ok');
  if (data.notifications) add('notifications', data.notifications.degraded ? 'degraded' : 'ok', data.notifications.degraded ? 'internal_error' : undefined);
  if (data.updater) add('updater', data.updater.state === 'failed' ? 'degraded' : 'ok', data.updater.state === 'failed' ? 'unknown' : undefined);
  if (data.quotaMeter) add('quota_meter', stateOf(data.quotaMeter.ok));
  if (data.circle) add('circle_connection', stateOf(data.circle.connected));
  if (data.phone) add('phone_listener', data.phone.degraded ? 'degraded' : 'ok');
  if (data.signedIn) add('agent_signin', data.signedIn.any === true ? 'ok' : 'blocked');
  if (data.outbox) add('outbox', data.outbox.degraded ? 'degraded' : 'ok');
  const hour = ctx.hour;
  const out = rows.map(row => ({op: 'count', name: 'health.state', attrs: compact({check: row.check, state: row.state, reason: row.reason ? errorType(row.reason) : undefined}), dedupe: 'health:' + row.check + ':' + hour}));
  const install = data.install;
  if (isObject(install)) {
    const agents = new Set(Array.isArray(install.agents) ? install.agents : []);
    out.push({op: 'count', name: 'install.active', dedupe: 'active:' + ctx.day, attrs: {lending_on: install.lendingOn === true, hosts_circle: install.hostsCircle === true,
      circles: bucket('small', number(install.circles) ?? 0), agents: agents.has('claude') && agents.has('codex') ? 'both' : agents.has('claude') ? 'claude' : agents.has('codex') ? 'codex' : 'none', level: ctx.level}});
  }
  for (const milestone of data.milestones ?? []) out.push({op: 'milestone', milestone});
  return out;
}

// ---- UI and phone friction -------------------------------------------------------------------------------------

const FRICTION = { kinds: members('friction_kind'), routes: members('route'), actions: members('recovery_action'), ops: members('op'), surfaces: members('ui_surface') };
function frictionObservations(data, ctx) {
  const kind = pick(FRICTION.kinds, data.kind, null), route = pick(FRICTION.routes, data.route, null);
  if (!kind || !route) return [];
  const origin = ctx.origin === 'phone' ? 'phone' : 'ui';
  return [{op: 'count', name: 'ui.friction', origin, attrs: compact({kind, route, op: pick(FRICTION.ops, data.op, 'none'), 'error.type': data.code ? errorType(data.code) : undefined,
    action: pick(FRICTION.actions, data.action, 'none'), surface: origin})}];
}

// ---- Outside producers (inbox files, crash and unclean-exit markers) -------------------------------------------

function inboxObservations({record, origin}) {
  if (!isObject(record) || typeof record.name !== 'string') return [];
  const base = {origin: record.origin ?? origin};
  if (record.value !== undefined) return [{op: 'count', name: record.name, attrs: record.attrs, n: record.value, period: record.period, ...base}];
  const diag = {op: 'diag', name: record.name, kind: record.kind, attrs: record.attrs, hour: record.hour, duration_ms: record.duration_ms, status: record.status, ...base};
  if (record.name === 'app.crash') return [diag, {op: 'count', name: 'crash.count', attrs: {'crash.kind': record.attrs?.['crash.kind']}}];
  const family = FAMILIES[record.name];
  return family ? [diag, ...family.derive({attrs: record.attrs, durationMs: record.duration_ms ?? 0, stages: []})] : [diag];
}

function markerObservations(data) {
  return [{op: 'count', name: 'app.unclean_exit', attrs: {'service.name': pick(members('service'), data.service, 'app')}}];
}

// ---- Entry point -----------------------------------------------------------------------------------------------

const EVENT_PROJECTIONS = {
  readiness: (_data,ctx)=>{const checks=readinessChecks(ctx.readiness);return [{op:'diag',name:'setup.readiness',kind:'span',attrs:{checks},duration_ms:0,status:'ok'},...checks.map(attrs=>({op:'count',name:'setup.check.count',attrs}))];},
  job: jobObservations, lending: lendingObservations, signin: signinObservations, update: updateObservations,
  'offer-decision': offerObservations, 'quota-window': quotaObservations,
};
/**
 * project(kind, data, ctx) -> Observation[]. kind: `response`, `lender-failure`, `health`, `ui`, `inbox`, `marker`, or
 * `event:<spine type>`. ctx: {origin, surface, now, hour, day, level, readiness, preset}. Total: any input gives an array.
 */
export function project(kind, data, ctx = {}) {
  try {
    if (!isObject(data) || typeof kind !== 'string') return [];
    switch (kind) {
      case 'response': return responseObservations(data, ctx);
      case 'lender-failure': return lenderFailureObservations(data, ctx);
      case 'health': return healthObservations(data, ctx);
      case 'ui': return frictionObservations(data, ctx);
      case 'inbox': return inboxObservations(data);
      case 'marker': return markerObservations(data);
      default: {
        const handler = kind.startsWith('event:') ? EVENT_PROJECTIONS[kind.slice(6)] : null;
        return handler ? handler(data, ctx) : [];
      }
    }
  } catch {
    return [];
  }
}
