// "What you lend": projection and form helpers for the lending settings page.
// Admission copy comes from the server's durable objective projection. This file does not
// rebuild a lending decision from readings.
import { LENDING_POLICY_DEFAULTS, LENDING_PARAMETERS, LENDING_STRATEGIES as ENGINE_STRATEGIES,
  lendingStrategyCatalog, normalizeLendingPolicy } from '../../../lib/v1/lending-policy.mjs';
import { CHOOSER_DIALS, CHOOSER_EXPLAINER, EXPLAINER, LINES, REASON_LINE, STRATEGY_COPY } from '../../../lib/v1/lending-status-copy.mjs';
import { PROTECTION_POSITIONS as ENGINE_POSITIONS } from '../../../lib/v1/lending-objective.mjs';
import { agentProduct } from './helpers.mjs';
import { circlePerson } from './circles-view.mjs';
import {dateParts,formatDate} from './dates.mjs';

const DAY = 86400000, MINUTE = 60000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const PROVIDERS = {claude: 'Claude', codex: 'Codex'};

export const providerName = provider => PROVIDERS[provider] ?? (typeof provider === 'string' && provider ? provider[0].toUpperCase() + provider.slice(1) : 'This account');

export function probeFailureLine(probe) {
  const reason = probe?.reason;
  const statusClass = ['1xx','2xx','3xx','4xx','5xx'].includes(probe?.status_class) ? probe.status_class : null;
  if (reason === 'rate_limited') return 'The provider asked Faravan to wait before checking the allowance. No new job starts until another check succeeds.';
  if (reason === 'auth' && statusClass === '4xx') return 'The provider could not authorize the allowance check (4xx). Check the agent’s sign-in, then check the allowance again.';
  if (reason === 'provider_error' && statusClass === '5xx') return 'The provider returned a server error (5xx) while Faravan checked the allowance. No new job starts until another check succeeds.';
  if (reason === 'http_error' && statusClass && statusClass !== '5xx') return `The provider returned an unexpected ${statusClass} response while Faravan checked the allowance. No new job starts until another check succeeds.`;
  if (reason === 'guest_failed') return 'Faravan could not complete the allowance check. No new job starts until another check succeeds.';
  if (reason === 'unreadable') return 'Faravan could not read the allowance response. No new job starts until another check succeeds.';
  return null;
}

function capacityResetLine(objective, {zone}) {
  // `seven_day` is the source's canonical weekly resource id. Other binding windows
  // keep their existing policy copy because their reset is not the weekly reset.
  if (objective?.reasonCode !== 'objective_exceeds_spare' || objective.bindingWindow !== 'seven_day') return null;
  const resetAt = Date.parse(objective?.resetsAt?.[objective?.bindingWindow]);
  if (!Number.isFinite(resetAt) || !objective.bindingWindow) return null;
  const day = dateParts(resetAt, 'weekdayDate', {zone, locale:'en-US'}).weekday;
  const time = clock(resetAt, zone);
  if (!day || !time) return null;
  return `Not enough spare capacity now. The weekly allowance resets ${day} at ${time}.`;
}

function clock(ms, zone) {
  const parts=dateParts(ms,'clock',{zone,locale:'en-US'});
  if(!parts.hour)return '';
  return parts.hour + (parts.minute === '00' ? '' : ':' + parts.minute) + ' ' + (parts.dayPeriod??'').toUpperCase();
}

/** "today 6 PM", "tomorrow 9 AM", then the day or date. */
export function whenText(ms, {now, zone}) {
  if (!finite(ms)) return '';
  ms = Math.round(ms / MINUTE) * MINUTE;
  const day = value => formatDate(value,'dayKey',{zone});
  const ahead = Math.round((Date.parse(day(ms)) - Date.parse(day(now))) / DAY);
  if (ahead === 0) return 'today ' + clock(ms, zone);
  if (ahead === 1) return 'tomorrow ' + clock(ms, zone);
  if (ahead > 1 && ahead < 7) return dateParts(ms,'weekdayDate',{zone,locale:'en-US'}).weekday + ' ' + clock(ms, zone);
  return formatDate(ms,'monthDay',{zone,locale:'en-US'});
}

// The chooser copy is the lead-reviewed setting language in lib/v1/lending-status-copy.mjs.
export const DIAL_EXPLAINER = CHOOSER_EXPLAINER;
export const DEFAULT_PROTECTION_POSITION = LENDING_POLICY_DEFAULTS.protectionPosition;
export const PROTECTION_POSITIONS = Object.keys(ENGINE_POSITIONS).map(id => ({id, label: ENGINE_POSITIONS[id].label,
  description: CHOOSER_DIALS[id]}));
export const LENDING_STRATEGIES = lendingStrategyCatalog().strategies;

const POLICY_KEYS = Object.keys(LENDING_POLICY_DEFAULTS).filter(key => key !== 'personWeeklyPct');
const uiPolicy = policy => Object.fromEntries(POLICY_KEYS.map(key => [key, policy[key]]));

/** Read current server policy fields; old preset and volume fields are never re-created. */
export function policyDraft(policy = {}) {
  const current = Object.fromEntries(POLICY_KEYS.filter(key => Object.hasOwn(policy ?? {}, key)).map(key => [key, policy[key]]));
  const input = {...LENDING_POLICY_DEFAULTS, ...current,
    accountPlans: {...LENDING_POLICY_DEFAULTS.accountPlans, ...(current.accountPlans ?? {})}};
  try { return uiPolicy(normalizeLendingPolicy(input)); }
  catch { return uiPolicy(normalizeLendingPolicy()); }
}

// The one strategy parameter the owner edits on the page. Its range and default come from the engine table.
export const FIXED_SHARE_PARAM = LENDING_PARAMETERS.fixedSharePct;

/** Select a strategy in the draft. Fixed share starts at the engine default share when none is set. */
export function chooseStrategy(draft = {}, id) {
  const strategyParams = {...(draft.strategyParams ?? {})};
  if (id === 'fixed_share' && (strategyParams.fixedSharePct === undefined || strategyParams.fixedSharePct === null))
    strategyParams.fixedSharePct = FIXED_SHARE_PARAM.default;
  return {...draft, strategy: id, strategyParams};
}

/** Set the Fixed share number from the input text. Text that is not a number stays as text, so validation refuses it. */
export function withFixedShare(draft = {}, text) {
  const number = String(text).trim() === '' ? NaN : Number(text);
  return {...draft, strategyParams: {...(draft.strategyParams ?? {}),
    fixedSharePct: Number.isFinite(number) ? number : String(text)}};
}

export function validatePolicy(draft = {}) {
  const errors = {};
  const current = Object.fromEntries(POLICY_KEYS.filter(key => Object.hasOwn(draft ?? {}, key)).map(key => [key, draft[key]]));
  if (!PROTECTION_POSITIONS.some(position => position.id === (current.protectionPosition ?? LENDING_POLICY_DEFAULTS.protectionPosition)))
    errors.protectionPosition = 'Choose one of the three lending settings.';
  if (!LENDING_STRATEGIES.some(strategy => strategy.id === (current.strategy ?? LENDING_POLICY_DEFAULTS.strategy)))
    errors.strategy = 'Choose a lending strategy.';
  if (current.machineSlots !== undefined && current.machineSlots !== null && (!Number.isSafeInteger(current.machineSlots) || current.machineSlots < 1 || current.machineSlots > 32))
    errors.machineSlots = 'Use a whole number from 1 to 32, or leave it empty.';
  if (current.accountSlots !== undefined && (!Number.isSafeInteger(current.accountSlots) || current.accountSlots < 1 || current.accountSlots > 3))
    errors.accountSlots = 'Choose 1, 2 or 3 jobs per account.';
  if (Object.keys(errors).length) return {ok: false, errors, policy: null};
  const input = {...LENDING_POLICY_DEFAULTS, ...current,
    accountPlans: {...LENDING_POLICY_DEFAULTS.accountPlans, ...(current.accountPlans ?? {})}};
  try { return {ok: true, errors, policy: uiPolicy(normalizeLendingPolicy(input))}; }
  catch (error) {
    // The engine names the strategy parameter it refused; the message states that parameter's range.
    const field = typeof error?.field === 'string' ? error.field : '';
    const key = field.startsWith('strategyParams.') ? field.slice('strategyParams.'.length) : '';
    if (Object.hasOwn(LENDING_PARAMETERS, key)) errors[field] = `Use a number from ${LENDING_PARAMETERS[key].minimum} to ${LENDING_PARAMETERS[key].maximum}.`;
    else errors.policy = 'These settings are not valid.';
    return {ok: false, errors, policy: null};
  }
}

const decisionOf = account => account?.decision?.availability ?? account?.decision ?? {};
const objectiveOf = account => decisionOf(account).objective ?? account?.objective ?? null;
export function needsPerJobApproval(mode, providerConsent = {}, provider = null) {
  if (mode !== 'auto') return true;
  if (typeof provider === 'string' && provider) return providerConsent?.[provider] !== true;
  const consents = Object.values(providerConsent ?? {});
  return consents.length === 0 || consents.some(consent => consent !== true);
}
function basisFor(source) {
  const kinds = typeof source === 'string' ? [source] : source && typeof source === 'object' && !Array.isArray(source)
    ? Object.values(source) : [];
  if (kinds.length && kinds.every(kind => kind === 'history'))
    return {line: 'Risk target based on your own weeks.', explainer: EXPLAINER};
  if (kinds.length && kinds.every(kind => kind === 'model'))
    return {line: 'Using an initial usage estimate. Your lending limits still apply.', startingAssumption: true};
  if (kinds.length && kinds.every(kind => kind === 'strategy'))
    return {line: 'Using the share you chose.'};
  return null;
}

/** Render the objective projection as supplied by the server. */
export function objectiveExplanationVM(snapshot = {}) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const items = accounts.map((account, index) => {
    const decision = decisionOf(account);
    const objective = objectiveOf(account);
    if (!objective || typeof objective.reasonText !== 'string') return null;
    const status = decision.status ?? {};
    const admitted = objective.admission === 'allowed' || decision.admitted === true;
    const basis = basisFor(objective.protectionSource) ?? (status.basis?.line ? {line: status.basis.line} : null);
    const reasonCode = objective.reasonCode ?? decision.reason ?? 'objective_evidence_unknown';
    const links = [
      basis?.startingAssumption ? {href:'#starting-assumption', label:'Starting assumption for new users'} : null,
      status.href && status.linkLabel ? {href:status.href, label:status.linkLabel} : null,
    ].filter(Boolean);
    return {id: String(account.id ?? account.provider ?? index), provider: account.provider ?? null, title: account.label || providerName(account.provider),
      admitted, reasonCode,
      line: admitted ? status.line ?? LINES.ready : probeFailureLine(decision.probe) ??
        capacityResetLine(objective, {zone: snapshot.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}) ??
        status.line ?? LINES[REASON_LINE[reasonCode] ?? 'proof'],
      basisLine: basis?.line ?? null,
      basisExplainer: status.explainer ?? basis?.explainer ?? null,
      links,
      href: basis?.startingAssumption ? '#starting-assumption' : status.href ?? null,
      linkLabel: basis?.startingAssumption ? 'Starting assumption for new users' : status.linkLabel ?? null};
  }).filter(Boolean);
  if (!items.length && snapshot?.objective && typeof snapshot.objective.reasonText === 'string') {
    const objective = snapshot.objective;
    const admitted = objective.admission === 'allowed';
    const basis = basisFor(objective.protectionSource);
    const reasonCode = objective.reasonCode ?? 'objective_evidence_unknown';
    const links = basis?.startingAssumption
      ? [{href:'#starting-assumption', label:'Starting assumption for new users'}]
      : [];
    items.push({id: 'lending', provider: objective.provider ?? snapshot.provider ?? null, title: 'Lending', admitted, reasonCode,
      line: admitted ? LINES.ready : LINES[REASON_LINE[reasonCode] ?? 'proof'],
      basisLine: basis?.line ?? null,
      basisExplainer: basis?.explainer ?? null,
      links,
      href: basis?.startingAssumption ? '#starting-assumption' : null,
      linkLabel: basis?.startingAssumption ? 'Starting assumption for new users' : null});
  }
  return items;
}

export function policySummary(policy) {
  return (PROTECTION_POSITIONS.find(position => position.id === policy?.protectionPosition)?.label ??
    PROTECTION_POSITIONS.find(position => position.id === DEFAULT_PROTECTION_POSITION).label) + '.';
}

export const PLAN_OPTIONS = {
  claude: [['unknown', 'Not sure'], ['max20', 'Max 20×'], ['max5', 'Max 5×'], ['pro', 'Pro']],
  codex: [['unknown', 'Not sure'], ['pro', 'Pro'], ['plus', 'Plus'], ['business', 'Business'], ['team', 'Team']],
};
// Every plan lends now. The plan label never sets a usage rate: an account with no measured rate lends in its own allowance
// points using the starting estimate until local agent logs measure a rate (native-window mode).
export const planHint = () => 'This account lends now in its own allowance points using the starting estimate. '
  + 'The plan label never sets a usage rate; only your local agent logs measure it.';

export function concurrencyText(policy, machineCapacity) {
  const per = policy.accountSlots ?? 1, cap = finite(policy.machineSlots) ? policy.machineSlots : machineCapacity;
  return per + ' per account' + (finite(cap) && cap > 0 ? ' (up to ' + cap + ' on this computer)' : '');
}

// ---------------------------------------------------------------- standing rules (who runs without asking)
const RULE_DAYS = 30;
function memberNames(circleId, devices) {
  const group = devices?.circles?.find(entry => (entry.circle ?? entry.id) === circleId);
  return new Map((group?.members ?? []).filter(m => m.key_id).map(m => [m.key_id, circlePerson(m)]));
}
const list = names => names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);

/** People in a circle who can be named in a rule (never this computer itself). */
export function rulePeople(circleId, devices) {
  const self = devices?.fingerprint;
  return [...memberNames(circleId, devices)].filter(([id]) => id !== self).map(([id, name]) => ({id, name}));
}

export function rulesVM(rules = [], {devices, circles = [], now, zone}) {
  return (Array.isArray(rules) ? rules : []).filter(rule => rule.expiresAt > now).map(rule => {
    const names = memberNames(rule.circle, devices), people = rule.people.map(id => names.get(id) ?? 'someone who left');
    const agents = [...new Set(rule.agents.map(id => agentProduct(id).name))];
    const circle = circles.find(c => c.id === rule.circle);
    const left = rule.expiresAt - now;
    return {id: rule.id, circle: rule.circle, circleName: circle?.name ? String(circle.name) : '',
      who: list(people.length > 4 ? [...people.slice(0, 3), people.length - 3 + ' others'] : people),
      scope: [agents.length ? list(agents) : 'any agent', Number.isFinite(rule.maxWallSeconds) ? 'jobs up to ' + Math.round(rule.maxWallSeconds / 60) + ' min' : 'jobs that fit before reset',
        rule.dailyJobs == null ? 'no daily job cap' : rule.dailyJobs + ' jobs a day',
        rule.dailyMinutes == null ? null : rule.dailyMinutes + ' minutes a day'].filter(Boolean).join(' · '),
      // An app-made Automatic rule renews itself from a verified, non-empty membership refresh, so it has no Renew button and
      // its date is only the current deadline.
      appOwned: rule.appOwned === true,
      until: rule.appOwned === true ? 'currently until ' + whenText(rule.expiresAt, {now, zone}) + '; renews after a verified, non-empty membership refresh while Automatic is on'
        : 'until ' + whenText(rule.expiresAt, {now, zone}), endingSoon: rule.appOwned === true ? false : left <= 3 * DAY};
  });
}

export function ruleDraft(rule, {circle, people = [], agents = []} = {}) {
  return rule ? {id: rule.id, circle: rule.circle, people: [...rule.people], agents: [...rule.agents],
    maxWallSeconds: rule.maxWallSeconds ?? null,
    jobs: rule.dailyJobs == null ? '' : String(rule.dailyJobs),
    dailyMinutes: rule.dailyMinutes == null ? '' : String(rule.dailyMinutes), days: String(RULE_DAYS),
    schedule: rule.schedule ?? null, timeZone: rule.timeZone ?? null}
    : {id: null, circle, people: people.map(p => p.id), agents: [...agents], maxWallSeconds: null, jobs: '', dailyMinutes: '', days: String(RULE_DAYS)};
}

/** A complete standing rule for POST lending/rules, or the first problem with the draft. */
export function validateRule(draft, {now, makeId = () => globalThis.crypto.randomUUID()}) {
  const errors = {};
  if (!draft.people.length) errors.people = 'Choose at least one person.';
  if (!draft.agents.length) errors.agents = 'Choose at least one agent.';
  const whole = (key, min, max, label, optional = false) => {
    const text = String(draft[key] ?? '').trim();
    if (optional && text === '') return null;
    return /^\d+$/.test(text) && +text >= min && +text <= max ? +text
      : (errors[key] = label + ': use a whole number from ' + min + ' to ' + max + (optional ? ', or leave it empty for no cap.' : '.'), null);
  };
  const maxWallSeconds = draft.maxWallSeconds === null ? null : Number.isSafeInteger(draft.maxWallSeconds) && draft.maxWallSeconds > 0 ? draft.maxWallSeconds : (errors.maxWallSeconds = 'The saved job time limit is not valid.', null),
    jobs = whole('jobs', 1, 20, 'Jobs a day', true),
    dailyMinutes = whole('dailyMinutes', 5, 600, 'Minutes a day', true), days = whole('days', 1, RULE_DAYS, 'Days');
  if (Object.keys(errors).length) return {ok: false, errors, rule: null};
  return {ok: true, errors, rule: {id: draft.id ?? makeId(), circle: draft.circle, people: [...new Set(draft.people)], agents: [...new Set(draft.agents)],
    maxWallSeconds, dailyJobs: jobs, weeklyJobs: jobs === null ? null : jobs * 7,
    dailyMinutes, weeklyMinutes: dailyMinutes === null ? null : dailyMinutes * 7,
    schedule: draft.schedule ?? null, ...(draft.timeZone ? {timeZone: draft.timeZone} : {}), expiresAt: now + days * DAY}};
}

/** The full list to save: replace the edited rule, add a new one, or drop a revoked one. Expired rules are dropped. */
export function nextRules(rules = [], {put, revoke, now}) {
  const kept = rules.filter(rule => rule.expiresAt > now && rule.id !== revoke && rule.id !== put?.id);
  return put ? [...kept, put] : kept;
}

// ---------------------------------------------------------------- one-time legacy settings migration
/** The server includes this marker until a save acknowledges the migrated settings. */
export function migrationVM(lendingPolicy) {
  const migration = lendingPolicy?.migration;
  if (migration?.acknowledged !== false) return null;
  if (migration.presenceDefaultsChanged === true) {
    const reset = Array.isArray(migration.reset) ? migration.reset : [];
    const lines = reset.map(resetLine).filter(Boolean);
    const otherLines = reset.filter(row => !['idleOnly','stopOnReturn'].includes(row.field)).map(resetLine).filter(Boolean);
    return {legacyPolicy:false, lines,
      text:'Lending now runs while you use your computer, limited by your quota. To lend only while you are away, open What you lend and under When you use your computer turn on Only lend when I am away. To stop a running job when you return, turn on Stop a running job when I return.' +
        (otherLines.length ? ' ' + otherLines.join('; ') + '.' : '') +
        (migration.consentReset ? ' Lending was turned off. Turn it on again and choose the agents to lend.' : '')};
  }
  if ((migration.resetAtStartup === true || migration.perJobCapChanged === true) && Array.isArray(migration.reset) && migration.reset.length) {
    const lines = migration.reset.map(resetLine).filter(Boolean);
    return {legacyPolicy: false, lines,
      text: (migration.perJobCapChanged ? 'Your saved lending settings changed to the new defaults' : 'Some saved lending settings could not be used, so they were reset') + (lines.length ? ': ' + lines.join('; ') : '') +
        '. Your other settings were kept.' + (migration.presenceDefaultsUncertain ? ' Your saved activity settings were kept because this version cannot tell whether you chose them. Review Only lend when I am away and Stop a running job when I return below.' : '') + (migration.consentReset ? ' Lending was turned off. Turn it on again and choose the agents to lend.' : '')};
  }
  if (migration.presenceDefaultsUncertain === true) return {legacyPolicy:false,
    text:'Your saved activity settings were kept because this version cannot tell whether you chose them. Review Only lend when I am away and Stop a running job when I return below.'};
  if (migration.fromLegacyPolicy !== true) return null;
  return {legacyPolicy: true,
    text: 'Your saved lending strategy was migrated. Review the strategy below; your consent and lending rules were preserved.'};
}

// The words the "What you lend" page uses for each saved setting. The page and the reset notice both read this table.
export const POLICY_LABELS = Object.freeze({
  strategy: 'Lending strategy',
  protectionPosition: 'How much to lend',
  machineSlots: 'Your computer runs at most',
  accountSlots: 'Jobs per account',
  stopOnReturn: 'Stop a running job when I return',
  fixedSharePct: 'Share of each week friends can use',
});
const unreadable = () => { throw new Error('unreadable'); };
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : unreadable();
const percent = value => number(value) + '%';
const jobs = value => value === null ? 'the detected capacity' : number(value) + (value === 1 ? ' job' : ' jobs');
const onOff = value => typeof value === 'boolean' ? (value ? 'on' : 'off') : unreadable();
// Per saved setting: how a value reads in a sentence. The notice shows the old value and the default it went back to.
const POLICY_VALUE_TEXT = {
  strategy: [POLICY_LABELS.strategy, value => STRATEGY_COPY[value]?.label ?? unreadable()],
  protectionPosition: [POLICY_LABELS.protectionPosition, value => PROTECTION_POSITIONS.find(position => position.id === value)?.label ?? unreadable()],
  warningPct: ['Warning level', percent],
  effortMax: ['Highest effort to lend', value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : unreadable()],
  allowFast: ['Allow fast mode', onOff],
  idleOnly: ['Only lend when I am away', onOff],
  stopOnReturn: [POLICY_LABELS.stopOnReturn, onOff],
  machineSlots: [POLICY_LABELS.machineSlots, jobs],
  accountSlots: [POLICY_LABELS.accountSlots, jobs],
  watchOnlyUntil: ['Watch-only until', value => value === null ? 'not set' : formatDate(number(value))],
  probeMinutes: ['Check agent limits every', value => number(value) + ' minutes'],
  'strategyParams.perJobPct': ['Per-job cap', value => value === undefined ? 'no cap' : percent(value)],
  'strategyParams.fixedSharePct': [POLICY_LABELS.fixedSharePct, percent],
  'strategyParams.keepPct': ['Part of each week kept for you', percent],
  'strategyParams.e0': ['Where friends start in the week', value => number(value)],
};
// A saved value can be of any type; show only plain numbers and short words.
const shown = (format, value) => {
  if (typeof value === 'object' && value !== null || (typeof value === 'string' && value.length > 24)) return 'a value that could not be read';
  try { return format(value); } catch { return 'a value that could not be read'; }
};
function resetLine({field, was}) {
  if (field === 'lendingPolicy') return 'your saved lending settings could not be read';
  if (field === 'providerConsent') return null;
  if (field === 'accountPlans') return 'a saved agent plan could not be read';
  const entry = POLICY_VALUE_TEXT[field];
  if (!entry) return 'one unrecognized setting was removed';
  const [label, format] = entry;
  const key = field.replace('strategyParams.', '');
  const fallback = field.startsWith('strategyParams.') ? LENDING_PARAMETERS[key]?.default : field === 'idleOnly' ? false : LENDING_POLICY_DEFAULTS[field];
  return `${label}: ${shown(format, was)}, reset to ${shown(format, fallback)}`;
}
