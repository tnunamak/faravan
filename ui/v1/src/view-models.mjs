import {requestLine} from '../../../lib/v1/request-line.mjs';
import {currentAccountDecision, currentCapacityWait, formatPauseDeadline} from '../../../lib/v1/lending-summary.mjs';
import {LEGACY_COMPOSE_PROBLEMS} from '../../../lib/v1/problem.mjs';
import {problemView, browserProblemContext, readStateView, applyProblemView, composeProblemView} from './problem-catalog.mjs';
import {requestContextVM} from './request-context.mjs';
import {formatDate, dateParts} from './dates.mjs';
export {checkLineVM} from './check-line.mjs';
/**
 * S0.3 display contract. No I/O, clock reads, mutation, authorization or accounting.
 * Current inputs: /api/status.lending, /api/approvals, /api/jobs and recent-activity
 * presence (app.mjs). Explicit state/person/poll fields also accept the proposed
 * projections; they are fixtures, not a claim that those endpoints exist today.
 * viewer: {id, role, petnames, now, timeZone}; now is explicit epoch milliseconds.
 * Actions are inert UI intents, never API calls. Consumers must retain server checks.
 * Copy: EXPERIENCE §§1.1, 1.5, 1.6, 6, 7.1; DESIGN-SYSTEM §4.1.
 */
import {lendingBlockers} from './blockers.mjs';
import {dockerStoppedRow, remedyWords, dockerSigninInconclusive} from '../../../lib/v1/docker-state.mjs';
import {dockerInstallVM} from './setup-install.mjs';
import {isSessionLost} from './helpers.mjs';
import {agentDisplayText} from '../../../lib/v1/agent-display.mjs';
import {jobTimingLine} from './transcript-feed.mjs';
import {searchSettings, settingPlace} from './settings-registry.mjs';
import {SETTINGS_READY} from './settings-model.mjs';
import {formatJobProjection, jobProjectionFor} from './job-projection-view.mjs';
import {RESULT_DELIVERY_FAILURE_CODES, LENDER_INTERRUPTION_CODES, resultDeliveryCopy} from './job-failure-copy.mjs';
import {lendingProjectionOf, formatLendingProjection} from './lending-projection-view.mjs';
import {probeFailureLine} from './lending-policy-view.mjs';
import {lendingStatus, identityHoldCopy, fundingHoldCopy} from '../../../lib/v1/lending-status-copy.mjs';
import {formatMembership, membershipProjectionFor} from './membership-projection-view.mjs';
import {choiceOffered} from './compose-model.mjs';
const computerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clean = (value, fallback = '') => typeof value === 'string' && value.trim()
  && !/^sha256:/.test(value) ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : fallback;
const idOf = person => typeof person === 'string' ? person :
  person?.id ?? person?.key_id ?? person?.requester ?? person?.author;
const op = (label, value, kind = 'secondary') => ({label, kind, op: value});
const link = (label, href) => ({label, kind: 'primary', href});
const vm = (kind, headline, reason = '', actions = []) => ({kind, headline, reason, actions});
const time = value => typeof value === 'number' ? value : Date.parse(value);
const lendingUntil = status => status.intent?.until ?? status.until ?? (status.lending ?? status).until ?? (status.lending ?? status).pause_until;
function clock(value, zone = computerZone(), date = false) {
  if (!Number.isFinite(time(value))) return '';
  return formatDate(time(value), date ? 'dateClock' : 'clock', {zone});
}
/** A current device identity is a person-of-one until person links exist. */
export function personName(person = {}, petnames = {}, viewer = {}) {
  person ??= {};
  const id = idOf(person), own = viewer.id ?? viewer.key_id ?? viewer.fingerprint;
  if (person.type === 'device' && id && id === viewer.deviceId) return 'This computer';
  if (id && own && id === own) return 'You';
  const nickname = petnames instanceof Map ? petnames.get(id) : petnames?.[id];
  return clean(nickname?.label ?? nickname) || clean(person.localName) || clean(person.personName ?? person.person_name ?? person.ownerName) ||
    clean(person.display_name ?? person.name ?? person.deviceName ?? person.device_name);
}
/** Accept the full status response or its lending member; needs-you is independent. */
export function lendingVM(status = {}) {
  const s = status.lending ?? status, current = status.currentJob ?? s.current;
  const needs = status.needs_you ?? s.needs_you ?? status.attention ?? [];
  const projection = lendingProjectionOf(status);
  const projected = formatLendingProjection(projection, {person: status.execution?.person ?? current?.person?.name ?? current?.requester ?? '', own: status.execution?.own===true});
  const state = projected.kind;
  const out = state === 'off' ? vm('off', projected.headline, projected.reason, [op('Turn on lending','lending.on','primary')])
    : state === 'paused' ? vm('off', projected.headline, projected.reason, [op('Resume lending','lending.resume','primary')])
    : vm(state === 'running' ? 'run' : ['blocked','unknown'].includes(projected.kind) ? 'need' : 'on',
      projected.headline, projected.reason);
  return {...out, state, needsYou: needs.length, glyph: needs.length || ['blocked','unknown'].includes(state)
    ? 'needs-you' : ['off','paused'].includes(state) || projection.admissionReason === 'daily_limit' ? 'paused' : 'on'};
}
/** Legacy cards expire at this computer's review-hold timeout; offers use the signed job deadline. */
export function requestVM(request = {}) {
  const identity = request.identity ?? {requester:request.requester,
    localName:request.localName, personName:request.personName, deviceName:request.requesterName};
  const name = personName(identity), expiry = clock(request.expiresAt, undefined, true);
  let repo = request.source?.kind === 'none' ? 'No project · prompt only' : '';
  if (request.source?.kind === 'git') {
    try { const url = new URL(request.source.url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash)
        repo = clean(url.pathname.replace(/^\//, '').replace(/\.git$/, ''));
    } catch { /* A malformed source never becomes display copy. */ }
  }
  const actions = [];
  const identityReady = !request.identity || ['memberPresent','rosterFresh','rootMatches','circleMatches']
    .every(key => request.identity[key] === true);
  if (request.id && identityReady && request.protection?.satisfied === true)
    actions.push(op('Run it', 'approval.accept:' + request.id, 'primary'));
  if (request.id) actions.push(op('Decline', 'approval.decline:' + request.id));
  return {...vm('need', name ? name + ' asked for help' : 'Needs you',
    expiry ? 'No rush. This request waits until ' + expiry + '.' : '', actions),
    prompt:requestContextVM(typeof request.prompt === 'string' ? request.prompt : '').instruction, source:[repo, Number.isSafeInteger(request.sourceFiles) ? request.sourceFiles + ' files' : ''].filter(Boolean).join(' · '), agent:agentName(request.harness),
    model:Array.isArray(request.model) ? request.model.map(x => clean(x)).filter(Boolean).join(', ') : '',
    timeLimit:Number.isFinite(request.runtimeSeconds) ? request.runtimeSeconds / 60 + ' min' : '',
    allowance:allowanceVM(request), friendMinutes:Number.isFinite(request.friendMinutes) && request.friendMinutes >= 0 ? request.friendMinutes : null,
    startsNow:request.startsNow === true};
}
// The week's allowance, never a share of one job. Unknown, other-provider or malformed values are omitted.
function allowanceVM(request) {
  const value = request.allowance;
  if (!['claude', 'claude-code', 'claude-code-subscription'].includes(request.harness) || !value) return null;
  if (!Number.isFinite(value.remaining) || value.remaining < 0 || value.remaining > 100 ||
      typeof value.checked_at !== 'string' || !Number.isFinite(Date.parse(value.checked_at))) return null;
  return {remaining:value.remaining, checkedAt:value.checked_at};
}
const agentName = id => ({codex:'Codex',claude:'Claude Code','claude-code':'Claude Code',
  'claude-code-subscription':'Claude Code',gemini:'Gemini'})[id] ?? '';
const presenceObservedAt = presence => presence.source === 'heartbeat' ? presence.last_heartbeat_at : presence.last_poll_at;
/** Never promote today's recent-activity aggregate into live presence. */
export function presenceLine(presence = {}, viewer = {}) {
  if (presence.approvalFor && presence.approvalFor === viewer.id) return 'Waiting for you to say yes';
  const name = personName(presence.person, viewer.petnames, viewer);
  if (presence.waiting_reason === 'all_declined') return 'Nobody can take this job right now.';
  if (presence.mode === 'ask' && name) return name + ' says yes before each job';
  if (presence.basis === 'recent-activity') return 'Waiting';
  if (presence.state === 'off') return 'Not lending';
  const observedAt = presenceObservedAt(presence);
  const age = viewer.now - time(observedAt);
  if (!Number.isFinite(age) || age < 0) return 'Waiting';
  if (age >= 900000) return 'Offline since ' + clock(observedAt, viewer.timeZone, true);
  if (age >= 90000) return 'Away · last seen ' + Math.floor(age / 60000) + ' min ago';
  if (presence.state === 'resting') return 'Resting' +
    (clock(presence.until, viewer.timeZone) ? ' until ' + clock(presence.until, viewer.timeZone) : '');
  return ['ready','running'].includes(presence.state) ? 'Lending now' : 'Not lending';
}
const executionFailureCodes = ['wall_timeout','output_too_large','execution_failed','tests_failed','agent_exit_nonzero','agent_group_not_ceased','agent_run_failed'];
/**
 * Copy classification only, not S3.1's accounting classifier.
 * role may be a role string or {role, lender, borrower, agent, minutes, circle}.
 * Only explicit display context is interpolated; raw errors/paths never are.
 */
export function failureVM(code, phase, role = 'borrower') {
  const c = typeof role === 'object' ? role : {role}, lender = clean(c.lender, 'The lender'),
    borrower = clean(c.borrower, 'the borrower'), agent = clean(c.agent, 'The agent');
  const privateView = c.role === 'lender';
  if (['requirements_unsupported','policy_unenforceable','expired'].includes(code))
    return privateView ? vm('off','') : vm('bad', code !== 'requirements_unsupported' || !c.circle || !c.agent ? 'Nobody can take this job right now.' :
      'No one in ' + clean(c.circle,'this circle') + ' lends ' + agent + '. Choose another agent.',
      '', [op('Use any agent','job.any-agent','primary')]);
  const delivery = resultDeliveryCopy(code, phase, privateView);
  if (delivery)
    return vm('bad', delivery.headline, delivery.text,
      [op(privateView ? 'Copy details' : 'Send it again…', privateView ? 'details.copy' : 'job.resend','primary')]);
  // A stop after the run started is final (T21): nothing reruns by itself, the sender decides.
  if (code === 'stopped_by_lender') return vm('wait', privateView ?
    'You stopped ' + borrower + '’s job' + (Number.isFinite(c.minutes) ? ' after ' + c.minutes + ' min.' : '.') :
    lender + ' stopped this run. Changes up to the stop weren’t kept.', '', privateView ? [] : [op('Send it again…', 'job.resend', 'primary')]);
  if (['agent_signed_out','sandbox_not_ready','readiness_changed','sandbox_start_failed',
    'sandbox_ready_timeout','entrypoint_start_failed'].includes(code) || phase === 'prepare')
    return vm('wait', privateView && code === 'agent_signed_out' ?
      agent + ' signed out. ' + borrower + '’s job went back to the queue.' :
      "Waiting · " + lender + '’s computer needs a moment', '',
      privateView ? [op(code === 'agent_signed_out' ? 'Sign in' : 'Check readiness again',
        code === 'agent_signed_out' ? 'agent.signin' : 'readiness.get','primary')] : []);
  if (executionFailureCodes.includes(code))
    return vm('bad', code === 'wall_timeout' && Number.isFinite(c.minutes) ?
      "The agent couldn't finish: it hit the " + c.minutes + '-minute limit.' : "The agent couldn't finish.",
      '', [op('View what it did','job.transcript','primary'),op('Send it again…','job.resend')]);
  // Anything else after the run started is uncertain (EXPERIENCE M12 `job.interrupted`): never an automatic retry, because
  // the agent may have done part of the work. The sender decides, with "Send it again…" (a new job).
  const stopped = clean(c.at), mins = Number.isFinite(c.minutes) && c.minutes > 0 ? c.minutes : null;
  return privateView
    ? vm('wait', 'Interrupted · You don’t need to do anything. If ' + borrower + ' sends it again, you’ll be asked like any request.', '', [op('Copy details','details.copy')])
    : vm('wait', 'Interrupted · ' + lender + '’s computer stopped answering' + (stopped ? ' at ' + stopped : '') + (mins ? ', ' + mins + (mins === 1 ? ' minute' : ' minutes') + ' into the job' : '') +
      '. The agent may have done part of the work, and anything it did outside your code (for example, sending an email) may have happened. Nothing came back.', '',
      [op('Send it again…', 'job.resend', 'primary')]);
}
/** Job API adapter: use current status/local metadata; no raw response is returned. */
export function jobRowVM(job = {}, viewer = {}) {
  const {key, preparing, waitingHeadline} = formatJobProjection(job);
  const own = viewer.role === 'borrower' || !!job.local ||
    !!viewer.id && job.historyIdentity?.author === viewer.id;
  const involved = own || viewer.role === 'lender';
  let headline = ({waiting:'Waiting',waiting_approval:'Waiting for an answer',approved:'Approved',starting:'Starting',working:'Running',
    stop_requested:'Stop requested',stop_unconfirmed:'Stop not confirmed',stopped:'Stopped',cancelled:'Cancelled',failed:'Failed',expired:'Expired',
    ready:'Ready to review',no_changes:'No changes',added_branch:'Added as a branch',unknown:'Status unavailable'})[key] ?? 'Status unavailable';
  const status = jobStatusVM(job, {role:own ? 'sent' : 'ran'});
  if (status.stoppedEarly) headline = jobVM(job, own ? 'sent' : 'ran').word;
  const kind = JOB_STATES[key]?.kind ?? 'off';
  return {...vm(kind, headline, preparing ? waitingHeadline : headline === 'Waiting' ? presenceLine(job.presence, viewer) : '',
    involved && job.job_digest ? [link('View job','#/jobs/' + encodeURIComponent(job.job_digest))] : []),
    title:involved ? clean(job.local?.title ?? job.title) : '',
    person:involved ? personName(own ? job.lender : job.historyIdentity, viewer.petnames, viewer) : ''};
}
/** Changes are already verified by the API. Only supplied text is displayed. */
export function jobPageVM(job = {}, changes = {}, viewer = {}) {
  const row = jobRowVM(job, viewer), ready = jobStateKey(job) === 'ready';
  const identity = jobVM(job, ['ran','received'].includes(job.role) ? job.role : 'sent', {changes});
  const visible = row.actions.length > 0;
  return {...row, sections:visible ? ['What changed','Use these changes','Files changed',
    'What the agent did','How it ran','What you asked'] : [],
    noChanges:identity.noChanges, resultPending:identity.resultPending,
    summary:visible && ready ? clean(changes.summary) : '',
    attribution:visible && clean(job.historyIdentity?.localName) && clean(job.historyIdentity?.deviceName)
      ? 'Sent by ' + clean(job.historyIdentity.localName) + ' from ' + clean(job.historyIdentity.deviceName) : '',
    feedback:visible && ready && job.canSetBorrowerOutcome === true ? 'Did this help? Only you see this.' : '',
    actions:visible && ready ? [op('Download as .zip','job.download','primary')] : row.actions};
}
/**
 * The Home tab badge: every needs-you item once. `home` is the /api/status response; its
 * attention list already holds one entry per waiting approval (carrying approvalId), and once
 * S1.1 lands needs_you replaces it. Approvals the list lacks are added, so none counts twice.
 */
/** The person started lending here: it is enabled, has a circle, or has an agent chosen. A fresh install's default of lending-on is not a start, so a computer that only borrows is never told lending setup blocks it. */
export const lendingStarted = (home, agents = []) => Boolean(home?.lending?.enabled || home?.lending?.circle || (Array.isArray(agents) && agents.some(a => a?.useForLending)));
export function needsYouItems({approvals, home, readiness, agents = [], jobs, zone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = Date.now(), lendingBlockers = null} = {}) {
  const known = home?.lending_blockers || readiness || agents.length;
  // A computer that only borrows is never told it is blocked by lending setup (founder capture, 10-20).
  // Lend reads each agent through lendingAgentVM; Home must too, or a remembered owner sign-in hides the server's stop.
  const blockers = home && known && lendingStarted(home, agents) ? (lendingBlockers ?? lendPageVM(home, {readiness, agents, zone, now, showWeeklyQuota:false}).blockers) : null;
  const listed = home?.needs_you ?? home?.attention;
  const byJobId = new Map((Array.isArray(jobs) ? jobs : []).map(job => [job.job_digest, job]));
  // Local borrower evidence survives a pending identity read and re-pairing.
  const ownRequest = card => {
    const job = byJobId.get(card?.jobDigest ?? card?.job_digest);
    if (!job || !(job.local || job.borrowerCircle || job.role === 'sent')) return false;
    const circle = card?.job?.circle ?? card?.circle;
    const jobCircle = job.circle?.id ?? job.circle;
    return !circle || !jobCircle || circle === jobCircle;
  };
  const cards = Array.isArray(approvals) ? approvals : [];
  const ownApprovalIds = new Set(cards.filter(ownRequest).map(card => card.id));
  const ownAttention = item => isRequestItem(item) &&
    (ownApprovalIds.has(item.approvalId ?? item.id) || ownRequest(item));
  approvals = cards.filter(card => !ownRequest(card));
  // A job counts as a result to review only while it is sent, ready, has changes and has no borrower outcome yet.
  // Listed results and jobs share this test, so the badge, the cards and the empty line cannot disagree.
  const reviewable = job => !['ran','received'].includes(job.role) && jobStateKey(job) === 'ready' && !jobVM(job,'sent').noChanges && !job.borrowerOutcome;
  const listedEmptyResult = item => {
    if (item?.kind !== 'result') return false;
    const loaded = byJobId.get(item.job_digest ?? item.id);
    if (loaded) return jobVM(loaded).noChanges || !reviewable(loaded);
    // Once the job list is loaded it is the whole truth about results: a listed job it lacks has no card to show.
    if (Array.isArray(jobs)) return true;
    return !!item.job && jobVM(item.job).noChanges;
  };
  const items = (Array.isArray(listed) ? listed : []).filter(item => !ownAttention(item) && !(home?.lendingStartFailed && item?.action === 'retry') && !listedEmptyResult(item) && !item?.agent && !['policy_unenforceable', 'requirements_unsupported', 'circle_not_joined', 'lending_not_started', 'safety_check_failed', 'docker_signed_out', 'docker_not_installed', 'docker_not_running', 'sandbox_not_ready', 'circle_unreachable', 'circle_update_needed', 'agent_signed_out', 'agent_not_ready', 'no_agents'].includes(item?.kind));
  const keys = new Set(items.map(item => item.approvalId ?? item.job_digest ?? item.id).filter(Boolean));
  for (const card of Array.isArray(approvals) ? approvals : []) if (!keys.has(card.id)) {items.push({kind: 'request', id: card.id, approvalId: card.id}); keys.add(card.id);}
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (reviewable(job) && !keys.has(job.job_digest)) {
      items.push({kind: 'result', id: job.job_digest, job}); keys.add(job.job_digest);
    }
  }
  for (const item of blockers?.needsYou ?? []) items.push({kind: 'blocker', id: item.key + ':' + (item.agent ?? ''), item});
  return items;
}
export function needsYouCount(args = {}) { return needsYouItems(args).length; }
const isRequestItem = item => ['request','approval'].includes(item.kind) || Boolean(item.approvalId);
/** The sidebar's "this computer" chip: its name, one line, and a status dot (the word is for screen readers). */
export function machineVM(home, devices, {readiness = null, agents = [], approvals, jobs, zone = computerZone(), now = Date.now(), unavailable = null} = {}) {
  const name = clean(devices?.name, 'This computer');
  if (isSessionLost(unavailable)) return {name,line:'Not connected',kind:'off',word:'Unknown'};
  if (unavailable?.code==='stale') return {name,line:'Status needs an update',kind:'off',word:'Unknown'};
  if (!home) {
    // A failed status read is not a check in progress: say what is known instead of "Checking" for ever.
    if (unavailable) return {name, line: isSessionLost(unavailable) ? 'Not connected' : 'Status unavailable', kind: 'off', word: 'Unknown'};
    return {name, line: 'Checking this computer…', kind: 'wait', word: 'Checking'};
  }
  const page = lendPageVM(home, {readiness, agents, zone, now});
  const deadline = lendingUntil(home), until = clock(deadline, zone);
  const pauseTime = formatPauseDeadline(deadline, {now, formatClock: at => clock(at, zone)});
  const projection = page.lendingProjection;
  const activeRun = (Array.isArray(jobs) ? jobs : []).find(job => {
    if (job?.role !== 'ran' && !(job?.role === 'sent' && job.ran === true)) return false;
    const {key, projection:jobProjection} = formatJobProjection(job);
    return key === 'working' && jobProjection.observation?.state !== 'last_known';
  });
  const projectedState = activeRun ? 'running' : formatLendingProjection(projection).kind;
  const chips = {
    ready: ['Ready for requests', 'on', 'On'],
    running: projection?.admissionReason === 'busy' && projection?.execution !== 'running' ? ['Starting a job', 'run', 'Starting'] : ['Running a job', 'run', 'Running'],
    resting: [page.headline === 'Done for today' ? page.headline : 'Resting' + (until ? ' until ' + until : ''), 'off', 'Resting'],
    paused: ['Paused' + (pauseTime ? ' until ' + pauseTime : ''), 'off', 'Paused'],
    off: ['Lending is off', 'off', 'Off'], outside: [page.headline, 'off', 'Outside hours'],
    starting: ['Checking this computer…', 'wait', 'Checking'],
    'blocked-partial': ['Needs you', 'need', 'Needs you'],
    blocked: ['Needs you', 'need', 'Needs you'], update: ['Needs you', 'need', 'Needs you'],
    unsupported: ['Can’t lend', 'off', 'Off'],
    unknown: ['Status unavailable', 'off', 'Unknown'],
  };
  let [line, kind, word] = chips[projectedState] ?? ['Status unavailable', 'off', 'Unknown'];
  // A generic blocked projection says lending cannot proceed; only Home's actionable evidence says the owner is needed.
  const hasAction = () => needsYouItems({home, readiness, agents, approvals, jobs, zone, now, lendingBlockers:page.blockers}).some(item =>
    ['request', 'approval', 'result'].includes(item?.kind) ||
    [item?.action, item?.href, item?.item?.action, item?.item?.href]
      .some(value => typeof value === 'string' && value.trim().length > 0));
  if (['blocked-partial', 'blocked', 'update'].includes(projectedState)) {
    if (page.limitAction) [line, kind, word] = ['Per-job limit too low', 'need', 'Needs you'];
    else if (!hasAction()) [line, kind, word] = ['Lending is blocked', 'wait', 'Waiting'];
  }
  // The chip says "Ready for requests" only when the computer verdict is ready. A hold starts no new job: the chip says what the page
  // says, with the waiting dot. Lending on with no current evidence is still checking.
  if (projectedState === 'ready' && page.readiness.state === 'holding')
    [line, kind, word] = hasAction() ? ['Needs you', 'need', 'Needs you']
      : page.ownerHold ? [page.headline, 'need', 'Needs you'] : [page.headline, 'wait', 'Waiting'];
  else if (projectedState === 'ready' && page.readiness.state === 'checking') [line, kind, word] = ['Checking this computer…', 'wait', 'Checking'];
  if (page.exec) {
    [line, kind, word] = [page.headline, 'run', formatLendingProjection(projection, {person:page.exec.who}).label];
  } else if (activeRun) {
    const own = activeRun.role === 'sent';
    const requester = jobVM(activeRun, 'ran').requester;
    [line, kind, word] = [own ? 'Running your job' : requester ? 'Running ' + requester + '’s job' : 'Running a job', 'run', 'Running'];
  }
  if (kind === 'need' && !page.exec && projectedState === 'unknown') [line, kind, word] = ['Status unavailable', 'off', 'Unknown'];
  return {name, ...(page.limitAction ? {href:page.limitAction.href} : {}), line, kind, word, state: projectedState};
}
/**
 * U3: the Lending page. Reads today's /api/status (effective state S1.1: state, reason,
 * until, needs_you; limits and counters from `lending`). `state: 'outside'` and `'update'`
 * are accepted ahead of S6.1 and the update slice, so only this adapter changes later.
 * Only controls for THIS computer are returned: no remote pause, no per-circle switches.
 * Copy: mockups/src/lend.html.
 */
const LENT_AGENTS = {claude:'Claude Code','claude-code':'Claude Code','claude-code-subscription':'Claude Code','claude-code-api-key':'Claude Code (API key)',
  codex:'Codex',gemini:'Gemini',opencode:'OpenCode','gh-cli':'GitHub CLI'};
export const canonicalAgentId = agent => agent?.canonical_id ?? (typeof agent?.id==='string'&&agent.id.endsWith('-lending')?agent.id.slice(0,-8):agent?.id);
const agentLabel = id => { const canonical=typeof id==='string'&&id.endsWith('-lending')?id.slice(0,-8):id; return LENT_AGENTS[canonical] ?? clean(canonical, 'An agent'); };
// Three failed automatic checks stop further ones. Each surface names the button it shows next to the sentence.
export const automaticChecksStoppedLine = button => 'Automatic checks stopped after 3 failures. Press ' + button + ' to try again.';
const lendingAgentVM = agent => {
  if(!agent?.lendingSignInTarget)return agent;
  const signedIn=typeof agent.proxySignedIn==='boolean'?agent.proxySignedIn:null;
  return {...agent,id:agent.lendingSignInTarget,canonical_id:canonicalAgentId(agent),
    auth_strategy:'docker-native-oauth',credential_in_guest:false,signedIn,
    signInState:signedIn===true?'Signed in':signedIn===false?'Sign-in needed':'Not checked',
    signInSupported:agent.lendingSignInSupported===true,canChoose:signedIn===true&&agent.installed===true};
};
const listWords = names => names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0] ?? '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hourOf = text => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return ''; const h = +m[1] % 12 || 12;
  return h + (m[2] === '00' ? '' : ':' + m[2]) + (+m[1] < 12 ? ' AM' : ' PM'); };
/** "New York" from "America/New_York"; the zone is named wherever hours are (R3-75). */
export const zoneName = zone => { const text = clean(zone); return !text ? '' : text === 'UTC' ? 'UTC' : text.split('/').pop().replace(/_/g, ' '); };
export function scheduleParts(schedule, zone = '') {
  if (!schedule || !hourOf(schedule.from) || !hourOf(schedule.to)) return [];
  const days = Array.isArray(schedule.days) ? [...schedule.days].map(String).sort().join('') : '';
  // Overnight hours (from later than to) are nights; daytime hours are days (R3-75: a daytime schedule is not "nights").
  const overnight = schedule.from > schedule.to;
  const label = days === '12345' ? (overnight ? 'Weeknights' : 'Weekdays') : days === '0123456' ? (overnight ? 'Every night' : 'Every day') : overnight ? 'Some nights' : 'Some days';
  const where = zoneName(zone) ? ' (' + zoneName(zone) + ' time)' : '';
  return [{text: label + ' ', strong: false}, {text: hourOf(schedule.from) + '–' + hourOf(schedule.to), strong: true}, {text: where, strong: false},
    {text: schedule.weekends_all_day === true && days === '12345' ? ' and all weekend.' : '.', strong: false}];
}
export const scheduleText = (schedule, zone = '') => scheduleParts(schedule, zone).map(p => p.text).join('');
/** The one-paragraph limits summary, as [{text, strong}] so the page can bold the numbers. */
export function limitsSummary(lending = {}, schedule) {
  const limits = lending.limits ?? {}, parts = [], put = (text, strong = false) => parts.push({text, strong});
  const when = scheduleParts(schedule, limits.timeZone);
  if (when.length) { for (const p of when) put(p.text, p.strong); put(' '); }
  const hasDailyJobs=finite(limits.dailyJobs),hasDailyMinutes=finite(limits.dailyMinutes),hasDaily=hasDailyJobs||hasDailyMinutes;
  if (hasDaily) {
    put('Up to ');
    if(hasDailyJobs){put(limits.dailyJobs + (limits.dailyJobs === 1 ? ' job' : ' jobs'),true);if(hasDailyMinutes)put(' and ');}
    if(hasDailyMinutes)put(limits.dailyMinutes + ' minutes',true);
    put(' a day');
  }
  if (finite(limits.maxWallSeconds)) {
    if(hasDaily)put(', ');else put('Up to ');
    put(Math.round(limits.maxWallSeconds / 60) + ' minutes',true);put(' per job. ');
  } else if(limits.maxWallSeconds===null)put((hasDaily?'. ':'')+'Jobs must fit before reset. ');
  else if(hasDaily)put('. ');
  if (finite(limits.quotaReserve) && limits.quotaReserve > 0) {
    put('Keep '); put(limits.quotaReserve + '%', true); put(' of my weekly Claude allowance for me.');
  }
  while (parts.length && parts.at(-1).text.endsWith(' ') && !parts.at(-1).strong) parts.at(-1).text = parts.at(-1).text.trimEnd();
  return parts;
}
// Bind displayed usage to the projected attempt, never to the first selected agent.
function executingProvider(status, projection = lendingProjectionOf(status)) {
  if (!['running','finishing','stopping'].includes(projection.execution) || !projection.executionJob) return null;
  const s = status.lending ?? status, job = projection.executionJob;
  const matches = (s.accountStates ?? []).filter(account => account.current === job);
  const agent = matches.length === 1 ? matches[0].agent : matches.length === 0 && s.current === job ? s.agent : null;
  const canonical = typeof agent === 'string' ? agent.replace(/-lending$/, '') : null;
  return canonical === 'codex' ? 'codex' : canonical === 'claude-code-subscription' ? 'claude' : null;
}
// An account's usage windows: the fresh availability's own, else the decision's.
const windowsOf = account => account?.decision?.availability?.windows ?? account?.decision?.windows ?? [];
// The account's current weekly reading, the same reading the header shows. Older than a day, or absent, it is no reading.
function weeklyReadingOf(account, now = Date.now()) {
  const weekly = windowsOf(account).filter(window =>
    window.state === 'open' && (window.window_id === 'seven_day' || window.window_id === 'codex:10080' || window.window_minutes === 10080));
  if (weekly.length !== 1 || !finite(weekly[0].used_pct) || weekly[0].used_pct < 0 || weekly[0].used_pct > 100) return null;
  const observedAt = time(weekly[0].observed_at);
  if (!finite(observedAt) || now < observedAt || now - observedAt >= 86400000) return null;
  return {remaining: 100 - weekly[0].used_pct, observedAt};
}
function idleReadingLine(status, decision, reading = null) {
  const p = lendingProjectionOf(status);
  // Missing request evidence is not evidence of an empty queue.
  if (p.intent !== 'on' || p.execution !== 'idle' || !Array.isArray(status.needs_you) ||
      status.needs_you.some(item => item.kind === 'approval') || p.admissionReason === 'busy' ||
      (status.lending ?? status).current || (status.lending?.currentJobs ?? []).length) return null;
  const copy = lendingStatus({admitted:decision?.admitted === true, reason:decision?.reason, reasonCode:decision?.objective?.reasonCode,
    ruleReasonCode:decision?.ruleReasonCode, pendingRequest:false});
  if (copy.id !== 'reading_next') return null;
  // A current reading is what the owner sees everywhere; "will be checked" is only true while no reading exists.
  return reading ? Math.round(reading.remaining) + '% of your week left · checked ' + clock(reading.observedAt) : copy.line;
}
function runningAllowance(status, provider) {
  if (!provider) return null;
  const accounts = (status.lendingPolicy?.accounts ?? []).filter(account => account.provider === provider);
  // Do not pick one of several accounts for the same provider.
  if (accounts.length > 1) return null;
  const weekly = windowsOf(accounts[0]).filter(window =>
    window.state === 'open' && (window.window_id === 'seven_day' || window.window_id === 'codex:10080' || window.window_minutes === 10080));
  if (weekly.length === 1 && finite(weekly[0].used_pct)) {
    const w = weekly[0];
    return {provider, remaining:100 - w.used_pct, observedAt:w.observed_at, resetsAt:w.resets_at};
  }
  return status.allowance?.provider === provider ? status.allowance : null;
}
function pageMeters(s, allowance, use, now, zone) {
  const meters = [];
  if (finite(use?.jobs) && finite(use?.max) && use.max > 0)
    meters.push({label: 'Jobs today', value: String(use.jobs), of: 'of ' + use.max, percent: Math.min(100, Math.round(use.jobs / use.max * 100))});
  const read = ['claude','codex'].includes(allowance?.provider) && finite(allowance.remaining) && allowance.remaining >= 0 && allowance.remaining <= 100 &&
    finite(allowance.observedAt) && now >= allowance.observedAt && now - allowance.observedAt < 86400000;
  if (read) {
    const day = finite(allowance.resetsAt) && allowance.resetsAt > now ? WHEN_DAY(allowance.resetsAt, zone) : '';
    const note = ['checked ' + clock(allowance.observedAt, zone), day ? 'resets ' + day : ''].filter(Boolean).join(' · ');
    meters.push({label: (allowance.provider === 'codex' ? 'Codex' : 'Claude Code') + ' this week', value: Math.round(allowance.remaining * 10) / 10 + '%', of: 'of your weekly quota unused', note});
  }
  return meters;
}
export function homeProviderQuotaVM(status = {}, agents = [], {now = Date.now(), zone = computerZone(), stale = false} = {}) {
  const enabled = new Set((Array.isArray(agents) ? agents : []).filter(agent => agent?.useForLending === true)
    .map(agent => providerOf(canonicalAgentId(agent))));
  const accounts = Array.isArray(status?.lendingPolicy?.accounts) ? status.lendingPolicy.accounts : [];
  return [['claude', 'Claude Code'], ['codex', 'Codex']].filter(([provider]) => enabled.has(provider)).map(([provider, title]) => {
    const matches = accounts.filter(account => account?.provider === provider);
    const reading = !stale && matches.length === 1 ? weeklyReadingOf(matches[0], now) : null;
    const meter = reading && pageMeters(null, {provider, ...reading}, null, now, zone)[0];
    return {provider, title, meter: meter || null};
  });
}

const WHEN_DAY = (ms, zone = computerZone()) => formatDate(ms, 'weekday', {zone});
/** The three ways to pause: a timed pause (POST lending/pause {until}) or until you resume. Tomorrow means 7:00 AM local. */
export function pauseChoices(now = Date.now(), zoneOffsetAt = at => new Date(at)) {
  const tomorrow = zoneOffsetAt(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(7, 0, 0, 0);
  return [
    {id: 'hour', label: 'For 1 hour', until: now + 3600000},
    {id: 'tomorrow', label: 'Until tomorrow, 7 AM', until: tomorrow.getTime()},
    {id: 'resume', label: 'Until I resume', until: null},
  ];
}
// Who is unreachable when the circle's host does not answer: the circle's name and the host person, from the circle blocker.
function hostOutageOf(blockers) {
  const item = blockers?.items?.find(x => x.key === 'circle' && x.status === 'blocked' && x.detail_code !== 'host_too_old');
  return {circleName: clean(item?.label), hostName: clean(item?.hostName)};
}
// Display only: the current hold selects the agent, never a stored sign-in flow or another account.
function identityHoldFor(account, agents = []) {
  const current = currentAccountDecision(account);
  if (!current || current.admitted === true) return null;
  const copy = identityHoldCopy(current.status?.id ?? current.reason ?? current.objective?.reasonCode,
    {provider:account.provider});
  if (!copy) return null;
  const id = account.provider === 'claude' ? 'claude-code-subscription' : 'codex';
  const agent = agents.map(lendingAgentVM).find(item => canonicalAgentId(item) === id && item.useForLending === true);
  return {...copy, name:agentLabel(id), target:agent?.installed !== false && agent?.signInSupported === true ? agent.id : null};
}

export function ownerLimitAction(status = {}) {
  let d = null;
  const held = (status.lendingPolicy?.accounts ?? []).find(account => {
    d = currentAccountDecision(account);
    return d && d.admitted !== true && (d.reason === 'owner_limit_too_low' || d.objective?.reasonCode === 'owner_limit_too_low');
  });
  return held ? {href:'#/lend/limits/owner-limit', label:'Raise limit', line:d.status?.line ?? d.objective?.reasonText} : null;
}
function fundingHoldFor(account) {
  const d = currentAccountDecision(account);
  return d?.admitted === true ? null : fundingHoldCopy(d?.status?.id ?? d?.reason, {provider:account?.provider, fundingReason:d?.fundingReason});
}
// A usage-estimate hold is an automatic wait for the next allowance check. A fresh weekly reading is shown as a measurement;
// it never says the next job is admitted.
function estimateHoldLine(reading, zone) {
  return reading
    ? Math.round(reading.remaining) + '% of your week left · checked ' + clock(reading.observedAt, zone) + '. The next request still waits for its allowance check.'
    : 'Waiting for a quota reading before taking requests.';
}
/** Display state only; sign-in and account availability are separate evidence. */
export function lentAgentState(agent = {}, account = null, zone = computerZone(), now = Date.now()) {
  const check = agentCheckVM(agent), name = agentLabel(canonicalAgentId(agent));
  const d = currentAccountDecision(account);
  const reset = windowsOf(account).map(w => time(w.resets_at)).filter(Number.isFinite).sort((a,b) => a-b)[0];
  const resetText = Number.isFinite(reset) ? ' Resets ' + clock(reset, zone, true) + '.' : '';
  if (agent.installed === false || !check.ready)
    return {name, state:'not-ready', kind:'need', summary:name + ' not ready', reason:name + ': ' + (agent.installed === false ? 'Not installed' : check.word)};
  if (agent.useForLending && d && d.admitted !== true) {
    const reason = identityHoldFor(account)?.line ?? fundingHoldFor(account)?.line ?? currentCapacityWait(account, {now, formatClock:at=>clock(at, zone, true)})?.line ?? (d.status?.id === 'usage_estimate' ? estimateHoldLine(weeklyReadingOf(account, now), zone) : d.status?.line) ?? d.objective?.reasonText ?? 'Waiting for a quota reading.';
    const code = d.reason ?? d.objective?.reasonCode;
    const reserved = ['owner_band', 'owner_harm', 'owner_reserve', 'defer'].includes(code);
    // Older automatic stopped snapshots carry no cause; keep their neutral headline.
    const waiting = code === 'objective_evidence_unknown' && d.status?.id === 'stopped' && d.status?.recovery?.who === 'automatic';
    const state = reserved ? 'reserved' : waiting ? 'waiting' : 'holding';
    return {name, state, kind:'wait', summary:name + (reserved ? ' reserved for you' : waiting ? ' waiting' : ' holding'), reason:/Codex usage limit/.test(reason) ? name + (/^Holding\b/i.test(reason) ? ': ' : ' holding: ') + reason + resetText : reason, resetText};
  }
  return {name, state:'lending', kind:'on', summary:name + ' lends now', reason:''};
}
function lentAgentStates(status, agents, zone, now) {
  return agents.map(lendingAgentVM).filter(a => a.useForLending).map(a => lentAgentState(a,
    status?.lendingPolicy?.accounts?.find(account => account.provider === (canonicalAgentId(a) === 'codex' ? 'codex' : 'claude')), zone, now));
}
/**
 * The one answer to "can this computer lend right now?", shared by every surface that shows it: the Lending verdict and page,
 * the sidebar chip, Setup's ready line and the blockers' canLend. It reads each lent agent's CURRENT availability only.
 *  - ready:    one lent account is currently admitted. A held sibling keeps its own wait; it does not veto the computer.
 *  - holding:  no account is admitted and one has a current hold. A hold is never ready.
 *  - checking: lending is on and a signed-in lent account has no current evidence (none, or only a retained job).
 *  - signin:   no lent account has evidence and no lent agent is installed and signed in, so its own sign-in row decides.
 *  - inactive: lending is not on and idle, so there is no idle verdict (off keeps today's sign-in rows).
 * perAccount lists every lent agent with its evidence: admitted | held | missing.
 */
export function computerReadiness({status = {}, projection = lendingProjectionOf(status), agents = []} = {}) {
  const perAccount = (Array.isArray(agents) ? agents : []).map(lendingAgentVM).filter(agent => agent.useForLending === true).map(agent => {
    const id = canonicalAgentId(agent);
    return {agent:id, provider:providerOf(id), usable:agent.installed !== false && agentCheckVM(agent).ready, ...accountEvidenceOf(status, id)};
  });
  const has = evidence => perAccount.some(account => account.evidence === evidence);
  // A recorded admission or hold counts whatever the agent's sign-in says (its own row shows that); only a missing reading
  // needs a usable agent, because a signed-out agent is not waiting for an allowance reading.
  const state = projection.intent !== 'on' || projection.execution !== 'idle' ? 'inactive'
    : has('admitted') ? 'ready'
    : has('held') ? 'holding'
    : perAccount.some(account => account.usable && account.evidence === 'missing') ? 'checking' : 'signin';
  return {state, perAccount, holdsBack:state === 'holding' || state === 'checking'};
}
function accountEvidenceOf(status, agentId) {
  const current = currentAvailabilityOf(status, agentId);
  return {evidence:current.admitted ? 'admitted' : current.held ? 'held' : 'missing', line:current.line};
}
const providerOf = agentId => agentId === 'codex' ? 'codex' : agentId === 'claude-code-subscription' ? 'claude' : null;
function lendingAccountHold(status, readiness, agents = [], now = Date.now(), zone = computerZone()) {
  const held = lendingProjectionOf(status).admission === 'allowed' && readiness.state === 'holding'
    ? readiness.perAccount.find(account => account.evidence === 'held') : null;
  const accountHold = held ? (status.lendingPolicy?.accounts ?? []).find(account => account.provider === held.provider) ?? null : null;
  const holdDecision = currentAccountDecision(accountHold);
  const idleReading = idleReadingLine(status, holdDecision, weeklyReadingOf(accountHold, now));
  const policyWait = currentCapacityWait(accountHold, {now, formatClock:at=>clock(at, zone, true)});
  // Infer a passive estimate wait only when the current snapshot explicitly has no owner actions.
  const passiveEstimate = holdDecision?.status?.id === 'usage_estimate' &&
    Array.isArray(status.needs_you) && status.needs_you.length === 0;
  const automatic = holdDecision?.status?.recovery?.who === 'automatic' || passiveEstimate;
  const ownerHold = Boolean(accountHold) && !idleReading && !policyWait && !automatic;
  return {accountHold, holdDecision, idleReading, policyWait, ownerHold, identityHold:identityHoldFor(accountHold, agents)};
}

/** Intent, effect and first reason come from the same ordered blockers used below. */
// Current Docker sign-in evidence owns this presentation, not a saved summary.
// Never use these display rows to change the projection or admission verdict.
function dockerConfirmationPresentation(readiness) {
  const row = readiness?.checks?.find?.(check => check.name === 'docker_login');
  if (!row) return null;
  const unknown = row.unknown === true || dockerSigninInconclusive(row) ||
    ['docker_signin_refresh_unavailable', 'docker_signin_state_unavailable'].includes(row.cause) ||
    (row.ok === true && row.signinVerified === false && row.createAccepted !== true);
  if (!unknown && row.ok !== false) return null;
  return {
    key: 'docker_signin', label: 'Docker sign-in', status: unknown ? 'unknown' : 'blocked',
    detail: unknown ? 'Faravan could not confirm the Docker sign-in.' : 'Not signed in.',
    action: unknown ? (row.checking === true ? undefined : 'Check again') : 'Sign in to Docker',
    headline: unknown ? 'Checking Docker sign-in' : 'Lending stopped: sign in to Docker',
  };
}

function withDockerConfirmation(blockers, confirmation) {
  if (!confirmation || !blockers.items.some(item => item.key === 'docker_signin' && item.status !== 'waits')) return blockers;
  const items = blockers.items.map(item => item.key === 'docker_signin' ? confirmation : item);
  const needsYou = blockers.needsYou.filter(item => item.key !== 'docker_signin');
  if (confirmation.action) {
    const index = needsYou.findIndex(item => items.indexOf(item) > items.indexOf(confirmation));
    needsYou.splice(index < 0 ? needsYou.length : index, 0, confirmation);
  }
  return {...blockers, items, needsYou};
}

export function lendingVerdictVM(status = {}, blockers, zone = Intl.DateTimeFormat().resolvedOptions().timeZone, agents = [], now = Date.now()) {
  const projection = lendingProjectionOf(status);
  const formatted = formatLendingProjection(projection, {
    until: lendingUntil(status), now, formatClock: at => clock(at, zone),
    agentName: blockers?.first?.agent ? agentLabel(blockers.first.agent) : '',
    circleName: status.lendingStartFailed?.circleName ?? '',
    stoppedJob: status.stoppedJob ? {requester: clean(status.stoppedJob.requester)} : null,
    hostOutage: hostOutageOf(blockers),
  });
  const readiness = computerReadiness({status, projection, agents});
  const hold = lendingAccountHold(status ?? {}, readiness, agents, now, zone);
  const agentStates = lentAgentStates(status, agents, zone, now);
  // A lent account with no current availability is checking, whatever the projection's admission says.
  // Only a projection that would otherwise say a request can run is turned into "checking"; its own holds keep their cause.
  const pending = formatted.ready && readiness.state === 'checking';
  const headline = hold.accountHold ? ownerLimitAction(status) ? 'Per-job limit too low' : hold.ownerHold ? 'Check lending accounts' : 'Lending on'
    : pending ? 'Checking this computer…' : formatted.headline;
  const reason = hold.accountHold ? hold.identityHold?.line ?? hold.policyWait?.line ?? hold.idleReading ?? probeFailureLine(hold.holdDecision?.probe) ?? hold.holdDecision?.status?.line ?? hold.holdDecision?.objective?.reasonText ?? formatted.reason
    : pending ? 'Checking how much allowance the lent account has.' : formatted.reason;
  const holds = agentStates.filter(a => a.state === 'holding');
  // The account cards explain their individual waits. The page describes the condition holding lending back.
  const waitReason = hold.accountHold && holds.length === 1 ? holds[0].reason : null;
  return {headline: headline === 'Lending on' && holds.length ? headline + ' · ' + holds.map(a => a.summary).join(' · ') : headline, reason: hold.idleReading ?? waitReason ?? reason, agentStates, on: formatted.on, ready: formatted.ready && !readiness.holdsBack, pending, readiness, waitReason, projection, ...hold};
}
export function lendPageVM(status = {}, {agents = [], use = null, now = Date.now(), readiness = null, zone = computerZone(), showWeeklyQuota = true} = {}) {
  const s = status.lending ?? status;
  const lendingAgents=(Array.isArray(agents)?agents:[]).map(lendingAgentVM);
  const blockers = blockersFor({status, readiness, agents:lendingAgents, zone, now});
  const projection = lendingProjectionOf(status);
  const verdict = lendingVerdictVM({...status, lendingProjection:projection}, blockers, zone, lendingAgents, now);
  const {accountHold, holdDecision, idleReading, policyWait, ownerHold, identityHold} = verdict;
  const today = status.today ?? {};
  const dailyFacts = {jobs:today.jobs, jobLimit:today.jobLimit, minutes:today.minutes, minuteLimit:today.minuteLimit, jobMinutes:today.jobMinutes};
  const execution = ['running','finishing','stopping'].includes(projection.execution)
    ? {...(status.execution ?? {}), state: projection.execution, job: projection.executionJob,
      person: status.execution?.person ?? status.runningJob?.requester} : null;
  const current = status.currentJob ?? s.current;
  const running = execution;
  const who = clean(execution?.person ?? running?.requester);
  const own = execution?.own === true;
  const finishing = execution ? execution.state !== 'running' : !verdict.on || projection.intent === 'paused';
  const stops = clock(execution?.stops_by ?? current?.stopsAt ?? current?.deadline ?? status.runningJob?.stopsAt, zone);
  const exec = running ? {who, own, job:execution?.job, finishing, stops:stops ? execution?.state === 'stopping'
    ? 'Scheduled stop: ' + stops + '. Waiting for confirmation that the job has stopped.' : 'Time limit: ' + stops : '', stopping: execution?.state === 'stopping',
    canStop: execution?.state !== 'stopping' && typeof execution?.job === 'string' && execution.job.length > 0,
    text: execution?.state === 'stopping' ? 'Stopping ' + (own ? 'your job' : who ? who + '’s job' : 'the job') + '…'
      : (own ? 'Your job' : who ? who + '’s job' : 'A job') + (finishing ? ' is finishing' : ' is running') + (stops ? ' · time limit: ' + stops : '')} : null;
  const circleName=status.lendingStartFailed?.circleName ?? '';
  const until = lendingUntil(status);
  const pauseExpired = projection.intent === 'paused' && time(until) <= now;
  const projectedView = formatLendingProjection(projection, {
    until, now, formatClock: at => clock(at, zone), person: who, own, circleName, dailyFacts,
    stoppedJob: status.stoppedJob ? {requester: clean(status.stoppedJob.requester)} : null, hostOutage: hostOutageOf(blockers),
  });
  const kind = projectedView.kind;
  // A hold that clears on its own (a reserve, a quota reading still to come) needs nothing from the owner: lending stays on
  // and the reason line says when it clears. Only a hold the owner must act on asks for attention.
  const provider = executingProvider(status, projection);
  const limitAction = verdict.readiness.state === 'ready' ? null : ownerLimitAction(status);
  const headline = !accountHold && !verdict.pending ? projectedView.headline : limitAction ? 'Per-job limit too low' : ownerHold ? 'Check lending accounts' : 'Lending on';
  const effectiveReason = identityHold?.line ?? idleReading ?? probeFailureLine(holdDecision?.probe) ?? holdDecision?.status?.line ?? holdDecision?.objective?.reasonText ?? projectedView.reason;
  const unsupported = projection.admissionReason === 'platform_unsupported';
  const idleAccounts = (status.lendingPolicy?.accounts ?? []).filter(account=>account.provider===status.allowance?.provider);
  const weekly = idleAccounts.length === 1 ? weeklyReadingOf(idleAccounts[0], now) : null;
  const idleAllowance = weekly ? {...status.allowance,...weekly} : status.allowance;
  const meters = pageMeters(s, showWeeklyQuota ? (execution ? runningAllowance(status, provider) : idleAllowance) : null, finite(today.jobs) && finite(today.jobLimit) ? {jobs: today.jobs, max: today.jobLimit} : use, now, zone);
  const minutes = finite(today.minutes) ? today.minutes : s.counters?.day === new Date(now).toISOString().slice(0, 10) && finite(s.counters?.milliseconds) ? Math.ceil(s.counters.milliseconds / 60000) : null;
  const maxMinutes = today.minuteLimit ?? s.limits?.dailyMinutes;
  if (finite(minutes) && finite(maxMinutes) && maxMinutes > 0)
    meters.splice(1, 0, {label: 'Minutes today', value: String(minutes), of: 'of ' + maxMinutes, percent: Math.min(100, Math.round(minutes / maxMinutes * 100))});
  if (!verdict.on) for (let i = meters.length - 1; i >= 0; i--) if (['Jobs today','Minutes today'].includes(meters[i].label) && Number(meters[i].value) === 0) meters.splice(i, 1);
  const displayBlockers = withDockerConfirmation(blockers, dockerConfirmationPresentation(readiness));
  const dockerDisplay = !execution && displayBlockers !== blockers && !displayBlockers.items.some(item =>
    ['docker_installed', 'docker_running'].includes(item.key) && item.status !== 'ok')
    ? displayBlockers.items.find(item => item.key === 'docker_signin') : null;
  const restart = displayBlockers.needsYou.find(item => item.key === 'lending' && item.action === 'Resume now');
  const firstAction = restart ?? displayBlockers.needsYou[0];
  const unchecked = displayBlockers.needsYou.filter(item => item.agent && item.action?.startsWith('Check '));
  const heroAction = firstAction?.agent && firstAction.action?.startsWith('Check ') && unchecked.length > 1
    ? {...firstAction, agent: undefined, action: 'Check agents'} : firstAction;
  return {kind,
    tone: ['blocked', 'starting', 'unknown', 'update'].includes(kind) ? 'need' : ['off', 'paused', 'outside', 'resting', 'unsupported'].includes(kind) ? 'off' : 'on',
    icon: kind === 'blocked' ? 'alert' : 'lend', headline: dockerDisplay?.headline ?? status.summary?.headline ?? (accountHold || verdict.pending ? verdict.headline : headline), agentStates: verdict.agentStates, readiness: verdict.readiness,
    // A selected account is held although the projection reads ready: no new job starts, so the headline is the verdict.
    accountHold: Boolean(accountHold), ownerHold, identityHold, limitAction,
    // A pause can expire while the last summary is still on screen.
    reason: dockerDisplay?.detail ?? (policyWait ? `${accountHold.provider === 'codex' ? 'Codex' : 'Claude Code'}: ${policyWait.line}` : (pauseExpired ? projectedView.reason : status.summary?.reason)
      ?? (verdict.accountHold || verdict.pending ? verdict.reason : effectiveReason)),
    lendingProjection: projection, dailyFacts, circleName,
    switch: unsupported ? null : {on: verdict.on, shown: true}, blockers: displayBlockers, checks: lendingChecksVM(displayBlockers), exec, meters,
    banner: null, needsList: [], actions: [], heroAction, latched: blockers.latched, canPause: projection.intent !== 'off' && ['ready', 'running', 'outside', 'blocked-partial'].includes(kind)};
}

/** Computer-only checklist; agent health remains in blockers.byAgent. The isolation-check time is authoritative. */
export function lendingChecksVM(blockers) {
  const items = blockers.items.filter(item => ['docker_installed', 'docker_running', 'docker_signin','readiness_requirement','isolation_check'].includes(item.key));
  return {items, ready:items.length>0&&items.every(item=>item.status==='ok'), checked:'', needsYou:blockers.needsYou.filter(item=>items.includes(item))};
}

export function trackAgentChecks(previous = [], next = [], now) {
  return next.map(agent => {
    const old = previous.find(item => item.id === agent.id);
    return {...agent, checkStartedAt: agent.checking ? old?.checking ? old.checkStartedAt : now : null};
  });
}
export function agentCheckVM(agent = {}, now = Date.now()) {
  const evidence = Array.isArray(agent.evidence) ? agent.evidence : [];
  const successAt = Math.max(-Infinity, ...evidence.filter(e => ['signed_in', 'successful_job'].includes(e.fact) && e.value === true).map(e => time(e.observed_at)).filter(Number.isFinite));
  const failedAt = time(agent.checkedAt);
  const failed = ['Check failed', "Can't check"].includes(agent.signInState) && !(successAt > failedAt);
  const elapsed = agent.checking && Number.isFinite(agent.checkStartedAt) ? Math.max(0, Math.floor((now - agent.checkStartedAt) / 1000)) : 0;
  const timeout = failed && /too long|time(?:d)? ?out|workspace|sandbox/i.test(agent.remedy ?? '');
  const signedOut = agent.signedIn === false || agent.signInReason === 'credential_missing';
  const ready = agent.signedIn === true && !failed && !signedOut;
  const stopped = agent.automaticChecksStopped === true && !ready && !signedOut;
  return {ready, signedOut, failed, stopped, timeout, checking: agent.checking === true, elapsed,
    word: failed ? timeout ? "Couldn't finish checking (slow sandbox start)" : "Couldn't finish checking"
      : ready ? 'Ready' : signedOut ? 'Signed out' : agent.checking ? 'Checking…' : 'Not checked yet',
    note: agent.checking && elapsed >= 10 ? 'Re-checking · ' + elapsed + ' s' : ''};
}

/** Selected agents use their checklist item, including unknown and dependency states. */
export function agentRowVM(agent = {}, reading = null, {now = Date.now(), account = null, lendingOn = false} = {}) {
  const check = agentCheckVM(agent, now);
  // The blocker is the last readiness snapshot. Fresh sign-in evidence replaces its "Signed out." so the card never
  // shows "Signed out" beside "Signed in", and its sign-in form (canSignIn) goes away with it.
  const blocker = check.ready && reading?.detail === 'Signed out.' ? null : reading;
  const canonicalId=canonicalAgentId(agent),name = agentLabel(canonicalId), installed = agent.installed !== false, signedIn = check.ready;
  const fallback = !installed ? ['Not installed', 'install', 'off'] : signedIn ? ['Ready', 'ready', 'on']
    : agent.signedIn === false ? ['Signed out', 'signin', 'need'] : ['Checking', 'checking', 'wait'];
  const values = blocker ? blocker.status === 'ok' ? ['Ready', 'ready', 'on']
    : blocker.status === 'unknown' ? ['Checking', 'checking', 'wait'] : blocker.status === 'waits' ? ['Waiting for ' + blocker.detail.replace(/^Waits for /, '').replace(/\.$/, ''), 'waiting', 'wait']
    : blocker.status === 'off' ? !installed ? ['Not installed', 'install', 'off'] : check.ready ? ['Ready · not lent yet', 'off', 'off'] : check.signedOut ? ['Signed out', 'signin', 'off'] : ['Not lent', 'off', 'off'] : blocker.detail === 'Signed out.' ? ['Signed out', 'signin', 'need']
    : blocker.detail === 'Not installed.' ? ['Not installed', 'install', 'off'] : ['Needs attention', 'blocked', 'need'] : fallback;
  let [word, state, kind] = values;
  if (installed && blocker?.status !== 'waits' && (!blocker || blocker.status !== 'off')) {
    if (check.failed) [word, state, kind] = [check.word, 'checking', 'wait'];
    else if (!check.ready && !check.signedOut) [word, state, kind] = [check.word, 'checking', 'wait'];
  }
  // Signed in is not ready to lend. A lent agent reads "Ready" only from its account's current admitted availability.
  // A held reading blocks the row. With no reading, a lending-on computer is checking; with lending off, sign-in alone stands as before.
  const current = agent.useForLending === true ? currentAvailabilityOf({lendingPolicy:{accounts:[account].filter(Boolean)}}, canonicalId) : {admitted:true};
  if (installed && state === 'ready' && !current.admitted) {
    if (current.held) [word, state, kind] = [current.line, 'holding', 'wait'];
    else if (lendingOn) [word, state, kind] = ['Checking', 'checking', 'wait'];
  }
  const display = lentAgentState(agent, account);
  const hold = ['holding', 'reserved', 'waiting'].includes(display.state) ? {line:display.reason} : null;
  if (hold) [word, state, kind] = [hold.line, display.state, 'wait'];
  return {id: canonicalId, name, icon: 'terminal', state, word, kind, note: check.stopped && !check.checking ? automaticChecksStoppedLine('Check ' + name) : check.note,
    sub: state === 'ready' ? ['Signed in', 'ready', clean(agent.run?.model, 'Default model'), clean(agent.run?.effort) ? clean(agent.run.effort) + ' effort' : ''].filter(Boolean) : [word],
    warn: kind === 'need', lending: agent.useForLending === true,
    // Choosing an installed agent records intent; signed-in evidence controls whether it can run.
    canChoose: agent.canChoose === undefined ? agent.installed === true : agent.canChoose === true, canEnable: agent.installed === true && check.ready,
    canCheck: installed && !check.ready, checking: check.checking,
    canSignIn: Boolean(agent.lendingSignInSupported && installed && agent.proxySignedIn !== true ||
      agent.signInSupported && installed && (blocker?.action?.startsWith('Sign in') || !agent.useForLending && check.signedOut))};
}

/** Label/value rows retain unknown and zero limits without inventing configuration. */
export function lendingLimitsVM(lending = {}, schedule, agents) {
  const l = lending.limits ?? {}, value = (n, unit) => n === null ? 'No cap' : finite(n) ? n + ' ' + unit : 'Not set';
  return [
    {label: 'Jobs per day', value: value(l.dailyJobs, l.dailyJobs === 1 ? 'job' : 'jobs')},
    {label: 'Minutes per day', value: value(l.dailyMinutes, 'minutes')},
    {label: 'Time per job', value: finite(l.maxWallSeconds) ? Math.round(l.maxWallSeconds / 60) + ' minutes' : 'Must fit before reset'},
    ...(!agents || agents.some(agent=>agent.useForLending && agent.id?.startsWith('claude')) ? [{label: 'Keep for yourself', value: finite(l.quotaReserve) ? l.quotaReserve + '% of your weekly Claude allowance' : 'Not set'}] : []),
    {label: 'Lending hours', value: scheduleText(schedule ?? l.schedule, l.timeZone) || (l.idleOnly ? 'Only while I am away' : 'Any time')},
    ...(l.idleOnly && scheduleText(schedule ?? l.schedule, l.timeZone) ? [{label: 'Owner presence', value: 'Only while I am away'}] : []),
  ];
}

/** Current objective availability by account and provider window. */
export function lendingQuotaLinesVM(snapshot = {}, approvalRequired = false, status = {}, {now = Date.now(), zone = computerZone()} = {}) {
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  if (accounts.length && lendingProjectionOf(status).intent === 'off')
    return [{key:'off',label:'Lending off',text:'No new jobs start; running jobs continue within their saved limits.'}];
  return accounts.flatMap(account => {
    const needsApproval = typeof approvalRequired === 'function'
      ? approvalRequired(account.provider) === true : approvalRequired === true;
    const current = currentAccountDecision(account) ?? {};
    const objective = current.objective ?? {};
    const points = objective.lendablePoints && typeof objective.lendablePoints === 'object'
      ? objective.lendablePoints : {};
    const unusedWeekly = weeklyReadingOf(account, now);
    const fallback = status.allowance?.provider === account.provider &&
      accounts.filter(row => row.provider === account.provider).length === 1 ? status.allowance : null;
    const [weeklyMeter] = pageMeters(null, unusedWeekly ? {provider:account.provider, ...unusedWeekly} : fallback, null, now, zone);
    const weeklyText = weeklyMeter ? weeklyMeter.value + ' ' + weeklyMeter.of + '.' : null;
    const windows = windowsOf(account);
    const windowsById = new Map(windows.filter(window => typeof window?.window_id === 'string')
      .map(window => [window.window_id, window]));
    const ids = [...windowsById.keys()];
    for (const id of Object.keys(points))
      if (!windowsById.has(id) && id !== 'five_hour' && id !== 'codex:300') ids.push(id);
    if (ids.length === 0) ids.push(null);
    const accountName = account.provider === 'claude' ? 'Claude Code' : account.provider === 'codex' ? 'Codex' : 'Account';
    const display = lentAgentState({id:account.provider === 'codex' ? 'codex' : 'claude-code-subscription', installed:true, signedIn:true, useForLending:true}, account);
    const reason = currentCapacityWait(account, {now, formatClock:at=>clock(at, zone, true)})?.line ?? idleReadingLine(status, current, weeklyReadingOf(account, now)) ?? (display.state === 'holding' ? display.reason : null) ?? current.status?.line ?? current.objective?.reasonText ?? 'Waiting for a quota reading.';
    // Running execution proves admission of this job, not quota for the next one.
    // Do not replace an account's current hold with an old quote or a new percentage.
    const p = lendingProjectionOf(status);
    if (p.execution === 'running' && executingProvider(status, p) === account.provider &&
        accounts.filter(item => item.provider === account.provider).length === 1)
      return [{key:account.provider, label:accountName, text:(status.execution?.own === true ? 'Running your job.' : 'Lending to a friend now.') + ' The next request gets a fresh allowance check.'}];
    const windowNameOf = id => {
      const minutes = windowsById.get(id)?.window_minutes;
      return id === 'seven_day' || id === 'codex:10080' || minutes === 10080 ? 'week'
        : id === 'five_hour' || id === 'codex:300' || minutes === 300 ? '5-hour window' : 'window';
    };
    const percentText = percent => percent === 0 ? '0%' : percent > 0 && percent < 0.1 ? 'less than 0.1%'
      : 'about ' + Math.round(percent * 10) / 10 + '%';
    // A hold is one decision for the account: a job must fit every window. Its reason is said once, not repeated as the
    // reason of each window, and each window's open amount follows so the owner sees which window holds the job.
    if (current.admitted !== true && (ids.length > 1 || ownerLimitAction({lendingPolicy:{accounts:[account]}}))) {
      const open = ids.filter(id => !weeklyText || windowNameOf(id) !== 'week').filter(id => windowNameOf(id) === '5-hour window' && windowsById.get(id)?.state === 'not_open' ||
          finite(points[id]) && points[id] >= 0)
        .map(id => ' This ' + windowNameOf(id) + ': ' +
          (windowNameOf(id) === '5-hour window' && windowsById.get(id)?.state === 'not_open'
            ? 'not started' : percentText(points[id])) + '.');
      return [{key: account.provider, label: accountName, text: (ownerLimitAction({lendingPolicy:{accounts:[account]}}) ? '' : reason) + (weeklyText ? ' ' + weeklyText : '') + open.join('')}];
    }
    return ids.map(id => {
      const window = windowsById.get(id), minutes = window?.window_minutes;
      const weekly = id === 'seven_day' || id === 'codex:10080' || minutes === 10080;
      const short = id === 'five_hour' || id === 'codex:300' || minutes === 300;
      const windowName = weekly ? 'this week' : short ? 'this 5-hour window' : id ? 'this window' : 'quota';
      const percent = points[id];
      const hasAmount = current.admitted === true && finite(percent) && percent >= 0;
      const amount = hasAmount ? Math.round(percent * 10) / 10 : null;
      const amountText = percent === 0 ? '0%' : percent > 0 && percent < 0.1 ? 'Less than 0.1%' : 'About ' + amount + '%';
      const text = weekly && weeklyText ? (current.admitted === true ? weeklyText : reason + ' ' + weeklyText)
        : short && window?.state === 'not_open' ? 'not started' : amount === null ? reason
        : amountText + ' of ' + (weekly ? "this week's" : short ? "this 5-hour window's" : "this window's") +
          ' quota is open to lend now' + (needsApproval ? '; you approve each job' : '') + '.';
      return {key: account.provider + '/' + (id ?? 'quota'), label: accountName + ' · ' + windowName, text};
    });
  });
}

/** Facts from this computer’s recorded per-job isolation check and its time. Empty when nothing is known. */
export function computerFactsVM(status = {}, readiness = null, zone = computerZone()) {
  return [];
}
/**
 * U9: the setup checklist (`setup.*`). Reads /api/readiness for Docker prerequisites,
 * /api/agents and the recorded S2.3 per-job isolation check from /api/home.
 * Linux kvm remediation appears when its check fails. The circle is the last row.
 */
const SANDBOX_CHECKS = ['sbx_install', 'sbx_version', 'sbx_cli_contract', 'sbx_daemon', 'network_policy', 'docker_runtime'];
const step = (id, state, title, detail, extra = {}) => ({id, state, title, detail, right: '', ...extra});
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
// The lead counts what the rows below show; "One step" above two warnings reads as a lie (r8 O12).
function stepsNeedYou(steps) {
  const n = steps.filter(s => s.state === 'need' || s.state === 'bad').length;
  return n === 1 ? 'One step needs you.' : (COUNT_WORDS[n] ?? String(n)) + ' steps need you.';
}
export function setupAgentCheckState(agent) {
  return !agent?.checks?.length ? 'pending' : agent.checks.some(check => check.state === 'fail') ? 'fail'
    : agent.checks.every(check => check.state === 'pass') ? 'pass' : 'pending';
}
// One agent can have several accounts, each with its own readiness row. The agent's step is as good as its worst account.
export const agentReadinessRows = (lendingReadiness, id) => lendingReadiness?.agents?.filter(row => row.id === id) ?? [];
export function setupAgentRowsState(rows) {
  const states = (rows ?? []).map(setupAgentCheckState);
  return states.includes('fail') ? 'fail' : states.length && states.every(state => state === 'pass') ? 'pass' : 'pending';
}
// Setup keeps its own pending/unknown wording; it borrows the Circles banner where that wording would be wrong:
// an automatic invitation has no match code to compare, and an expired or rejected request is not "waiting".
const membershipNote = circle => {
  if (!circle) return null;
  const {phase, invitationPolicy} = membershipProjectionFor(circle);
  return phase === 'expired' || phase === 'rejected' || (phase === 'pending' && invitationPolicy === 'automatic')
    ? formatMembership(circle, {surface:'banner'}).message : null;
};
// Optional display evidence only. The producer owns lease/attempt invalidation;
// parent props carry its latest observation. Identifiers are never rendered.
export function setupPreparationVM(value) {
  const state = value?.schemaVersion === 1 && ['prepared', 'pending'].includes(value.state)
    ? value.state : 'unknown';
  return {
    state, done: state === 'prepared' ? 1 : 0,
    label: state === 'prepared' ? 'Preparation observed' : state === 'pending' ? 'Preparing' : 'Not observed',
    detail: state === 'prepared' ? 'A job sandbox preparation was observed. Required lending checks still apply.'
      : state === 'pending' ? 'A job sandbox preparation is in progress. This is not a readiness check.'
      : 'No current job sandbox preparation is confirmed. Sign-in alone does not confirm preparation.',
  };
}

export function setupVM({readiness, agents, status, devices, circle, lendingReadiness = null, lendingReadinessError = false, zone: viewerZone = null} = {}) {
  const desktop = status?.desktop ?? {}, platform = desktop.platform ?? 'other';
  const device = clean(devices?.name, 'This computer');
  const membershipPhase = circle ? membershipProjectionFor(circle).phase : null;
  const circleReady = Boolean(circle?.origin) && membershipPhase === 'approved';
  if (['mac','macos'].includes(platform) && desktop.arch === 'x64') {
    return {kind:'unsupported',device,steps:[],ready:false,headline:'This Mac can’t lend',
      lead:'Lending from this Mac needs Apple silicon.',
      card:{title:'You can still use Faravan here',text:'Send jobs to your friends and get results on this computer.',
        action:circleReady ? {label:'Send a job',href:'#/jobs/new'} : {label:'Open Circles',href:'#/circles'}}};
  }
  if (platform === 'windows' || desktop.lendable === false || status?.reason === 'platform_unsupported') {
    const mac = platform === 'mac' || platform === 'macos';
    return {kind: 'unsupported', device, steps: [], ready: false, eyebrow: '',
      headline: mac ? 'This Mac can’t lend' : 'This computer can’t lend',
      lead: 'Lending needs Docker Sandboxes, which runs on Apple silicon Macs (M1 or newer) and Ubuntu 24.04 or later.' +
        (mac ? ' This Mac does not currently meet the lending requirements.' : ''),
      card: {title: 'You can still use Faravan here', text: circleReady
        ? 'Send jobs to your friends and get results on this computer, including `faravan apply` in the terminal.'
        : !circle ? 'Join or start a circle first. Once your membership is approved, you can send jobs to friends and get results here.'
        : membershipNote(circle) ?? 'Confirm your circle membership first. Open Circles to check your join request before sending a job.',
        action: circleReady ? {label: 'Send a job', href: '#/jobs/new'} : {label: 'Open Circles', href: '#/circles'}}};
  }
  // Share Home and Lending’s ordered blockers: Docker, sign-in, isolation failures, agents.
  // Keep definite agent problems visible; unknown checks can wait for earlier prerequisites.
  // Setup adds circle membership and omits the lending switch from the checklist.
  const checks = Array.isArray(readiness?.checks) ? readiness.checks : null;
  const byName = name => checks?.find(c => c.name === name);
  const mvpAgent = a => ['claude','claude-code','claude-code-subscription','codex'].includes(a.id);
  const list = Array.isArray(agents) ? agents.filter(mvpAgent).map(agent => {
    const lending = lendingAgentVM(agent);
    return {...lending, id:canonicalAgentId(lending)};
  }) : null;
  // Only persisted choices count as lending consent; never infer selection from detection.
  const inferred = blockersFor({status, readiness, agents: list ?? [], zone: viewerZone ?? computerZone()});
  const model = withDockerConfirmation(inferred, dockerConfirmationPresentation(readiness));
  const STATE = {ok: 'ok', blocked: 'need', waits: 'waits', unknown: 'now'};
  const steps = [];
  // A test workspace is a distinct required observation, not evidence that the
  // physical service or Docker account failed. Keep unknown reads actionable too.
  const workspace = byName('test_workspace');
  const workspaceHeld = workspace && workspace.ok !== true;
  const setupItems = workspaceHeld ? model.items.filter(item =>
    !(item.key === 'readiness_requirement' && ['test_workspace', workspace.reason].filter(Boolean).includes(item.cause))) : [...model.items];
  if (workspaceHeld) {
    const next = setupItems.findIndex(item => !['docker_installed', 'docker_running', 'docker_signin'].includes(item.key));
    setupItems.splice(next < 0 ? setupItems.length : next, 0, {
      key: 'readiness_requirement', cause: 'test_workspace', label: 'Test workspace',
      status: 'blocked',
      detail: workspace.ok === false && workspace.unknown !== true
        ? 'Faravan couldn’t start a test workspace, so this computer can’t lend yet.'
        : 'Faravan hasn’t confirmed a test workspace, so this computer can’t lend yet.',
      action: 'Check again',
    });
  }
  let docker = false;
  for (const item of setupItems) {
    if (item.agent && !mvpAgent({id:item.agent})) continue;
    if (['lending', 'circle'].includes(item.key) || item.status === 'off') continue;
    const id = item.agent ? 'agent:' + item.agent : item.key === 'docker_signin' ? 'docker-account' : item.key === 'isolation_check' ? 'isolation' : item.key === 'agent' ? 'agents' : item.key === 'readiness_requirement' ? 'requirement:' + item.cause : 'sandboxes';
    let state = STATE[item.status] ?? 'now', extra = {}, detail = item.detail;
    const dockerRow = byName('docker_login');
    // A working listing proves no sign-in. Only Docker accepting a create is evidence; without one the step is not checked yet.
    if (item.key === 'docker_signin' && ['ok', 'unknown'].includes(item.status) && dockerRow?.ok === true && dockerRow?.signinVerified === false) {
      if (dockerRow.createAccepted === true) detail = 'Docker accepted Faravan\'s request to start a test workspace.';
      // Faravan runs the test workspace itself after a sign-in. If it could not confirm, say so once, with a check that runs it again.
      else if (item.action === 'Check again') { state = 'need'; extra = {actions: ['recheck', 'docker-create']}; }
    }
    // A read that timed out or could not run is not a refusal: say Faravan is checking and will try again.
    if (item.key === 'docker_signin' && ['blocked', 'unknown'].includes(item.status) && (dockerRow?.unknown === true || dockerRow?.cause === 'docker_signin_refresh_unavailable'))
      { state = 'now'; detail = 'Faravan is checking Docker and will try again.'; extra = {actions: ['recheck']}; }
    else if (item.key === 'docker_signin' && item.status === 'unknown' && item.action === 'Check again')
      { extra = {actions: ['recheck']}; }
    else if (item.key === 'docker_signin' && item.status === 'blocked')
      { detail = item.detail + ' Docker Sandboxes needs a free Docker account. Docker uses this account to download sandbox images. This setup check does not verify what Docker software or services can access or record. Review Docker’s applicable data handling before using sensitive material.'; extra = {actions: ['docker-signin', 'docker-create', 'recheck']}; }
    else if (item.key === 'docker_installed' || item.key === 'docker_running') {
      if (item.status === 'blocked' && item.key === 'docker_installed')
        extra = {actions: ['recheck'], dockerInstall: dockerInstallVM({platform, remedy: byName('sbx_install')?.remedy}), remedy: ''};
      else if (item.status === 'blocked' && byName('sbx_daemon')?.cause==='daemon_restart_required') extra = {blocker:item, actions:['recheck'], remedy:remedyWords(clean(byName('sbx_daemon')?.remedy))};
      // The row already says what the app knows and what to do (blockers.mjs); Setup shows that once, with its button.
      else if (item.status === 'blocked') extra = {actions: ['recheck'], remedy: '', ...(item.action === 'Open Settings' ? {blocker:item} : {})};
      else if (item.status === 'unknown' && item.cause) extra = {actions: [], remedy: ''};
      if (docker) {
        if (item.status === 'ok') continue;
        const previous = steps.findIndex(s => s.id === 'sandboxes');
        if (previous >= 0) steps.splice(previous, 1);
      }
      docker = true;
    }
    else if (item.key === 'readiness_requirement' && item.cause === 'test_workspace' && workspaceHeld) {
      // The shared Check again control re-runs the workspace test, for a timeout as for an unconfirmed read. It changes nothing locally;
      // only a later successful readiness read clears this row. A trusted daemon update keeps its own restart row.
      extra = {blocker:item, remedy:''};
    }
    else if (item.key === 'readiness_requirement') { // a command the person must run is shown by itself; a sentence or button label is already in the row
      const words = item.status === 'blocked' ? remedyWords(byName(item.cause)?.remedy) : '';
      extra = {blocker:item, remedy: words && !item.detail?.includes(words) ? words : ''}; }
    else if (item.agent && item.status === 'blocked') {
      const a = (list ?? []).find(x => x.id === item.agent);
      extra = a?.installed === false ? {install: [{id: a.id, name: item.label}], link: {label: 'Open Lending', href: '#/lend'}} : {actions: ['agent-signin'], agent: {id: item.agent, name: item.label, signInSupported: a?.signInSupported === true}, link: {label: 'Open Lending', href: '#/lend'}};
    }
    else if (item.key === 'agent' && item.status === 'blocked') extra = {link: {label: 'Choose an agent in Lending', href: '#/lend'}};
    if (!(item.key === 'docker_running' && item.cause === 'kvm_access')) // Setup's own kvm row below carries the command
    steps.push(step(id, state, item.label, detail, {dockerStopped: item.key === 'docker_running' && item.status === 'blocked' && byName('sbx_install')?.ok === true, waitsFor: item.waitsFor ?? null,  ...(item.disk ? {disk: item.disk} : {}), ...extra}));
    // Platform rows come right after the Docker row, only when their own check fails.
    if (['docker_installed', 'docker_running'].includes(item.key)) {
      const kvm = byName('kvm_access');
      if (kvm?.ok === false) {
        const command = clean(kvm.remedy);
        steps.push(step('kvm', 'need', 'Permission to run sandboxes',
          'Your user needs to be in the kvm group. Run this, then log out and back in.', {command, actions: ['recheck']}));
      }
    }
  }
  if (!checks && !Array.isArray(status?.lending_blockers?.items)) steps.splice(0, steps.length, step('sandboxes', 'now', 'Docker Sandboxes', 'Looking for Docker Sandboxes on this computer…'),
    step('docker-account', 'now', 'Docker sign-in', 'Checking…'),
    ...(list ?? [{id:'claude-code-subscription'},{id:'codex'}]).map(a => step('agent:' + a.id, 'now', agentLabel(a.id), 'Checking…')));
  const circleDetail = circleReady ? clean(circle.name, 'Selected circle')
    : membershipNote(circle)
    ?? (membershipPhase === 'pending' ? 'Your join request is waiting for approval. Open Circles to compare the match code and check its status.'
    : !circle?.origin ? 'You haven’t joined or started a circle yet. Open Circles to get started.'
    : 'Faravan hasn’t confirmed your circle membership. Open Circles to check its status before trying another invitation.');
  steps.push(step('circle', circleReady ? 'ok' : 'need', 'Circle membership', circleDetail, {link:{label:'Open Circles',href:'#/circles'}}));
  const selected = (list ?? []).filter(a => a.useForLending === true);
  for (const row of steps.filter(s => s.id.startsWith('agent:'))) {
    const id = row.id.slice(6);
    row.lendingCheckState = lendingReadinessError ? 'pending' : setupAgentRowsState(agentReadinessRows(lendingReadiness, id));
    const account = status?.lendingPolicy?.accounts?.find(a => a.provider === (id === 'codex' ? 'codex' : 'claude'));
    const usageHold = ['holding', 'reserved', 'waiting'].includes(lentAgentState(selected.find(a => canonicalAgentId(a) === id), account, viewerZone ?? computerZone()).state) && selected.some(a => canonicalAgentId(a) === id && a.installed && a.signedIn);
    // A held account waits on its own allowance; that wait confirms the agent the same way a ready row does.
    row.confirmed = selected.some(a => canonicalAgentId(a) === id) && (row.state === 'ok' || row.state === 'waits' && usageHold) && (row.lendingCheckState === 'pass' || usageHold);
    // The checks stopped on their own: Lending holds the button that starts them again, so the step points there.
    const stoppedAgent = !row.confirmed && ['ok','now'].includes(row.state) && (list ?? []).some(a => canonicalAgentId(a) === id && agentCheckVM(a).stopped);
    if (stoppedAgent) {
      row.state = 'need';
      row.detail = 'Automatic checks stopped after 3 failures. Open Lending and press Check agents again to try again.';
      row.link = {label:'Open Lending',href:'#/lend'};
    } else if (!row.confirmed && ['ok','now'].includes(row.state)) {
      // Keep upstream prerequisites/known install and sign-in fixes intact. Unknown or locally
      // ready agents still need an actionable current step when lending evidence is incomplete.
      row.state = !lendingReadiness && !lendingReadinessError ? 'now' : 'need';
      row.detail = row.state === 'now' ? 'Checking whether this computer can lend…'
        : row.lendingCheckState === 'fail' ? 'Lending checks need attention. Open Lending for the recovery steps, then check again.'
        : 'Lending checks are not confirmed. Check again or open Lending for the recovery steps.';
      row.retryLendingChecks = true;
      row.link = {label:'Open Lending',href:'#/lend'};
    }
  }
  // One confirmed, explicitly selected agent is required; additional agents are optional.
  const confirmed = steps.filter(s => s.confirmed);
  const requiredAgent = confirmed[0] ?? steps.find(s => s.id.startsWith('agent:') && selected.some(a => canonicalAgentId(a) === s.id.slice(6)));
  for (const row of steps) row.required = !row.id.startsWith('agent:') || row === requiredAgent;
  if (['mac', 'macos', 'linux'].includes(platform)) {
    const isMac = platform === 'mac' || platform === 'macos';
    const original = [...steps];
    const install = original.find(s => s.dockerInstall);
    const version = byName('sbx_version');
    const needsInstall = Boolean(install || (isMac && version?.ok === false));
    const sandboxInstall = install ?? step('sandboxes', 'need', 'Install the sandbox', '', {
      dockerInstall: dockerInstallVM({platform, remedy: byName('sbx_install')?.remedy}), required:true});
    sandboxInstall.title = 'Install the sandbox';
    const account = original.find(s => s.id === 'docker-account') ?? step('docker-account', 'now', 'Sign in to Docker', 'Checking Docker sign-in…', {required:true});
    account.title = 'Sign in to Docker';
    const stopped = original.find(s => s.dockerStopped);
    if (!needsInstall && stopped) {
      stopped.id = 'sandbox-service';
      stopped.title = 'Start the sandbox';
      if (isMac) {
        stopped.remedy = '';
        if (/(?:brew|sudo|sbx|curl)\s/.test(stopped.detail)) stopped.detail = 'The sandbox could not start. Choose Check again.';
      }
    }
    const agent = requiredAgent ?? original.find(s => s.id === 'agents') ?? step('agents', 'need', 'Sign in to your agent', 'Choose an agent in Lending.', {link:{label:'Open Lending',href:'#/lend'},required:true});
    const signedAgent = selected.find(a => 'agent:' + canonicalAgentId(a) === agent.id && a.signedIn === true);
    const signIn = {...agent, title:'Sign in to your agent', required:true, confirmed:Boolean(signedAgent),
      ...(signedAgent ? {state:'ok', detail:'Signed in.', actions:[], retryLendingChecks:false, link:null} : {})};
    if (!signedAgent) {
      const choices = (requiredAgent ? list.filter(a => 'agent:' + canonicalAgentId(a) === requiredAgent.id) : list ?? [])
        .filter(a => a.signInSupported);
      if (choices.length) Object.assign(signIn, {state:'need', install:null, actions:[],link:null,
        detail:'Choose the agent you want to lend. Signing in here selects it for lending.', agentChoices:choices});
    }
    // Preserve every failed check and its recovery action in the final step.
    // Sign-in itself is separate from the protected test and account checks.
    const outstandingRows = original.filter(s => s.required && s.state !== 'ok' && s !== install && s !== account && s !== agent && s !== stopped);
    const outstanding = outstandingRows.find(s => s.id !== 'requirement:test_workspace') ?? outstandingRows[0];
    const agentPending = signedAgent && !agent.confirmed ? agent : null;
    const pending = outstanding ?? agentPending;
    const passed = readiness?.ready === true && confirmed.length > 0 && !pending;
    const workspacePending = !pending || pending.id === 'requirement:test_workspace';
    const checkPending = workspacePending || pending === agentPending;
    const checkStep = {...(pending ?? {}), id:checkPending ? 'check' : pending.id,
      title:checkPending ? 'Check' : pending.title, required:true,
      state:passed ? 'ok' : pending?.state === 'need' || pending?.state === 'bad' ? 'need' : 'now',
      detail:passed ? 'The protected test passed.' : pending?.detail || 'Faravan runs the protected test automatically after both sign-ins.',
      automaticCheck:workspacePending && !needsInstall && !stopped && account.state === 'ok' && Boolean(signedAgent) && !passed,
      ...(isMac ? {command:null, remedy:'', install:null} : {})};
    if (isMac && /(?:brew|sudo|sbx|curl)\s/.test(checkStep.detail))
      checkStep.detail = 'The sandbox check needs attention. Choose Check again.';
    if (!passed && !checkStep.blocker && !checkStep.link) checkStep.actions = ['recheck'];
    steps.splice(0, steps.length, ...(needsInstall ? [sandboxInstall] : stopped ? [stopped] : []), account, signIn, checkStep);
    for (const row of steps) {delete row.primary;row.required=true;row.managedSandbox=isMac;}
    // Later failed checks never take the current position from an earlier sign-in.
    const current = steps.find(s => s.state !== 'ok');
    if (current) current.primary = true;
  }
  const requiredSteps = steps.filter(s => s.required);
  const done = requiredSteps.filter(s => s.id.startsWith('agent:') ? s.confirmed : s.state === 'ok').length;
  const allOk = confirmed.length > 0 && requiredSteps.length === done;
  const first = requiredSteps.find(s => s.state === 'need' || s.state === 'bad');
  if (first && !steps.some(s => s.primary)) first.primary = true;
  const names = listWords(confirmed.map(s => s.title));
  const savedNames = listWords([...new Set(selected.map(a => agentLabel(a.id)))]);
  const working = requiredSteps.some(s => s.state === 'now');
  const pendingLendingChecks = selected.length > 0 && !lendingReadiness && !lendingReadinessError;
  const checksPending = working || pendingLendingChecks || requiredSteps.some(s =>
    s.id.startsWith('agent:') ? !s.confirmed : s.state !== 'ok');
  const optionalNotReady = steps.some(s => s.id.startsWith('agent:') && !s.required && !s.confirmed);
  // Conversion evidence is a readiness check, not a sign-in failure. Keep its
  // reason and owner action visible outside the collapsed checklist as well.
  const conversionNotes = selected.flatMap(agent => {
    const rows = agentReadinessRows(lendingReadiness, canonicalAgentId(agent));
    return rows.flatMap(reading => {
      const check = Array.isArray(reading?.checks)
        ? reading.checks.find(row => row.id === 'conversion' && row.state === 'unknown') : null;
      const detail = [clean(check?.line), clean(check?.fix)].filter(Boolean).join(' ');
      const name = rows.length > 1 && reading.accountLabel ? agentLabel(agent.id) + ' (' + reading.accountLabel + ')' : agentLabel(agent.id);
      return detail ? [name + ': ' + detail] : [];
    });
  });
  const readinessNote = lendingReadinessError ? 'Couldn’t confirm lending checks. Try again.' : conversionNotes.join(' ');
  const hasProjection = Boolean(status && Object.hasOwn(status, 'lendingProjection'));
  const projection = lendingProjectionOf(status ?? {});
  const on = hasProjection ? projection.intent === 'on' || projection.intent === 'paused'
    : status?.intent?.on ?? status?.lending?.enabled === true;
  const verdict = lendingVerdictVM(status, inferred, viewerZone ?? computerZone(), list ?? []);
  // Execution is its own axis (dot UI review P2): a job still running or finishing after lending was turned off is
  // shown with the same verdict Home and Lending give, never hidden behind the setup checklist.
  const executionActive = hasProjection && ['running', 'finishing', 'stopping'].includes(projection.execution);
  const dockerDisplay = !executionActive && !(hasProjection && projection.intent === 'unknown') && model !== inferred && !model.items.some(item =>
    ['docker_installed', 'docker_running'].includes(item.key) && item.status !== 'ok')
    ? model.items.find(item => item.key === 'docker_signin') : null;
  const circleName = clean(circle?.name), limits = status?.lending?.limits ?? {};
  const rules = [
    savedNames ? 'Lends ' + savedNames : on ? 'No agent is chosen to lend' : '',
    (status?.lending?.mode ?? 'ask') === 'auto' ? 'runs jobs without asking' : 'asks you before each job',
    scheduleText(status?.lending?.limits?.schedule ?? status?.schedule, status?.lending?.limits?.timeZone).replace(/\.$/, '').toLowerCase().replace(/^weeknights/, 'weeknights'),
    finite(limits.dailyJobs) && finite(limits.dailyMinutes) ? 'up to ' + limits.dailyJobs + (limits.dailyJobs === 1 ? ' job' : ' jobs') + ' and ' + limits.dailyMinutes + ' minutes a day' : '',
  ].filter(Boolean);
  const text = rules.length ? rules[0][0].toUpperCase() + rules[0].slice(1) + rules.slice(1).map(r => ' · ' + r).join('') + '.' : '';
  return {
    kind: 'checklist', device, circleName, latched: model.latched, on, executionActive,
    intentUnknown: hasProjection && projection.intent === 'unknown',
    confirmedOff: hasProjection ? projection.intent === 'off' : status?.intent?.on === false || status?.lending?.enabled === false,
    eyebrow: '',
    accountHold: Boolean(verdict.accountHold),
    limitAction: verdict.readiness.state === 'ready' ? null : ownerLimitAction(status),
    headline: dockerDisplay?.headline ?? (allOk && !checksPending && ownerLimitAction(status) && verdict.readiness.state !== 'ready' && !executionActive ? 'Your computer is ready' : allOk && !checksPending && on && !executionActive && !verdict.readiness.holdsBack ? 'This computer is ready to lend' : on || executionActive ? checksPending && verdict.ready && !executionActive ? 'Getting this computer ready to lend' : verdict.headline : hasProjection && projection.intent === 'unknown' ? 'Lending status unavailable' : allOk && !checksPending ? 'Your computer is ready' : 'Getting this computer ready to lend'),
    lead: dockerDisplay?.detail ?? (on ? (verdict.accountHold || verdict.waitReason ? verdict.reason : first ? 'Your lending choice is saved. Fix the step that needs you below.' : model.first || working || pendingLendingChecks ? 'Your lending choice is saved. Faravan is getting this computer ready.' : 'Your approval mode and limits apply.') : hasProjection && projection.intent === 'unknown' ? verdict.reason : allOk && !checksPending ? 'This computer is ready to lend with ' + names + '. Review your settings, then turn on lending.'
      : steps.some(s => s.state === 'bad') ? 'Lending stays off until it passes. Here is what happened.'
      : first ? stepsNeedYou(requiredSteps) : readinessNote || (working ? 'Checking Docker Sandboxes and coding agents.' : stepsNeedYou(requiredSteps))),
    steps, ready: allOk && !checksPending, done, required: requiredSteps.length, optionalNotReady, readinessNote,
    preparation: setupPreparationVM(readiness?.preparation),
    summary: {title: on ? circleName ? 'Lending settings for ' + circleName : 'Your lending settings' : 'Last step', text: on || allOk ? text : '',
      cta: on ? 'Open Lending' : 'Turn on lending' + (circleName ? ' for ' + circleName : ''), waiting: allOk ? '' : 'Finish the steps that need you to turn lending on.'},
  };
}

/**
 * The closed state vocabulary, ported from docs/design/experience/mockups/src/vocab.mjs (EXPERIENCE 1.14).
 * Every job status word on every screen comes from JOB_STATES. An unknown server state is `unknown`,
 * never a raw code. kind = the pill colour; terminal = no further change.
 */
export const JOB_STATES = {
  asked:            {word: 'Waiting for {lender}', kind: 'wait', terminal: false},
  waiting:          {word: 'Waiting', kind: 'wait', terminal: false},
  waiting_approval: {word: 'Waiting for an answer', kind: 'wait', terminal: false},
  approved:         {word: 'Approved', kind: 'wait', terminal: false},
  starting:         {word: 'Starting', kind: 'run', terminal: false},
  working:          {word: 'Working', kind: 'run', terminal: false},
  sending:          {word: 'Sending result', kind: 'run', terminal: false},
  delivery_delayed: {word: 'Result delayed', kind: 'wait', terminal: false},
  stop_requested:   {word: 'Stop requested', kind: 'wait', terminal: false},
  stop_unconfirmed: {word: 'Stop not confirmed', kind: 'bad', terminal: false},
  uncertain:        {word: 'Interrupted', kind: 'wait', terminal: false},
  ready:            {word: 'Ready to review', kind: 'on', terminal: false},
  no_changes:       {word: 'No changes', kind: 'off', terminal: true},
  added_branch:     {word: 'Added as a branch', kind: 'on', terminal: true},
  pr_open:          {word: 'Pull request open', kind: 'on', terminal: false},
  stopped:          {word: 'Stopped', kind: 'off', terminal: true},
  cancelled:        {word: 'Cancelled', kind: 'off', terminal: true},
  failed:           {word: 'Didn’t finish', kind: 'bad', terminal: true},
  nobody:           {word: 'Nobody can take it now', kind: 'bad', terminal: false},
  expired:          {word: 'Expired', kind: 'off', terminal: true},
  unknown:          {word: 'Status unavailable', kind: 'off', terminal: false},
};
export const JOB_STEPS = ['Asked', 'Approved', 'Working', 'Ready'];
export const STEP_OF = {asked: 0, waiting: 0, waiting_approval: 0, nobody: 0, approved: 1, starting: 2, working: 2, sending: 2, delivery_delayed: 2,
  stop_requested: 2, stop_unconfirmed: 2, uncertain: 2, ready: 3, no_changes: 3, added_branch: 3, pr_open: 3, failed: 2, stopped: 2, cancelled: null, expired: null, unknown: null};
/** The lender's words for jobs their computer ran. */
export const LENDER_JOB_STATES = {running: 'Running', sent: 'Sent to {person}', delivery_delayed: 'Result not sent yet',
  stopped: 'Stopped', failed: 'Didn’t finish', uncertain: 'Interrupted'};
/**
 * Today's /api/jobs row -> a vocab key. The coordinator's own `state` decides when it is one of its raw states
 * (the API's `status` label says "Starting" for every claimed job, even one that runs); a row that only has a
 * label (fixtures, older servers) is read from the label. Only states the API can tell apart are returned.
 */
export function jobStateKey(job = {}) {
  return formatJobProjection(job).key;
}
// The lender's own word for a state that the requester's vocabulary words differently. The Jobs lists and the job page
// pill both take it from here, so a lender sees one word for one job.
export const lenderStateWord = (role, key) => role === 'ran'
  ? ({working: LENDER_JOB_STATES.running, sending: LENDER_JOB_STATES.delivery_delayed, delivery_delayed: LENDER_JOB_STATES.delivery_delayed})[key]
  : role === 'received' && key === 'starting' ? 'Preparing' : undefined;
const stoppedResultWord = (key, role) => 'Stopped early · ' + (key === 'no_changes' ? 'no changes' : role === 'ran' ? 'sent back' : key === 'added_branch' ? 'added as a branch' : 'ready to review');
/** {kind, word, key, step} for one job; `lender` fills "Waiting for {lender}". */
export function jobStateView(job, {role = 'sent', lender = '', requester = ''} = {}) {
  const key = jobStateKey(job);
  const status = jobStatusVM(job, {role});
  if (status.stoppedEarly) return {key, word:status.pill.word, kind:status.pill.kind, step:STEP_OF[key]};
  if (role === 'ran') {
    const word = key === 'ready' ? LENDER_JOB_STATES.sent.replace('{person}', requester || 'the requester')
      : key === 'working' ? LENDER_JOB_STATES.running : key === 'failed' ? LENDER_JOB_STATES.failed
      : key === 'cancelled' || key === 'stop_requested' ? JOB_STATES[key].word : JOB_STATES[key].word;
    return {key, word, kind: key === 'ready' ? 'on' : JOB_STATES[key].kind, step: STEP_OF[key]};
  }
  const entry = JOB_STATES[key];
  return {key, word: entry.word.replace('{lender}', lender), kind: entry.kind, step: STEP_OF[key]};
}

/**
 * U14: the Jobs list and the jump palette. Rows come from GET /api/jobs (S4.2, S4.2b: each row
 * has role 'sent', 'received' before local execution, or 'ran'). The words are one closed set per row; "Merged" and "Done after
 * merge" are not here because nothing records a merge yet.
 */
export function whenLabel(value, now, zone = computerZone()) {
  const at = time(value);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const age = now - at;
  if (age < 0) return formatDate(at, 'monthDay', {zone});
  if (age < 60000) return 'just now';
  if (age < 3600000) return Math.floor(age / 60000) + ' min ago';
  if (age < 86400000) return Math.floor(age / 3600000) + ' h ago';
  return formatDate(at, 'monthDay', {zone});
}
const dayKey = (ms, zone) => formatDate(ms, 'dayKey', {zone});
export const JOB_FILTERS = [['all', 'All'], ['sent', 'Sent by me'], ['ran', 'Ran for others'], ['needs', 'Needs you']];

// These fields are display text. Bound by Unicode code points so an emoji is not split.
function boundedText(value, fallback = '') {
  const text = clean(value);
  return text ? Array.from(text).slice(0, 120).join('') : fallback;
}
function requestedTitle(job) {
  const prompt = clean(job.prompt) ? job.prompt : typeof job.local?.prompt === 'string' ? job.local.prompt : '';
  const firstLine = prompt.split(/\r\n|[\r\n\u2028\u2029]/u).find(line => clean(line));
  return boundedText(firstLine);
}
function ranTitleCandidate(value) {
  const title = boundedText(value);
  return ['Untitled job','Coding job','A circle member’s job','A job you ran'].includes(title) ? '' : title;
}
function jobAgent(job, statusKey) {
  const actual = clean(job.receipt?.harness) || clean(job.resultSummary?.receipt?.receipt?.harness) || clean(job.agent);
  const requested = clean(job.local?.agent) || clean(job.harness) || clean(job.job?.payload?.harness);
  const chosen = actual || requested;
  if (!chosen) return statusKey === 'waiting' ? 'Any agent' : 'Agent not recorded';
  return Object.hasOwn(LENT_AGENTS, chosen) ? agentLabel(chosen) + (!actual && !['waiting','waiting_approval','cancelled'].includes(statusKey) ? ' (requested)' : '') : 'Agent not recorded';
}
function resultChangeCount(job, changes) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (changes?.invalid === true || (changes?.format !== undefined && changes.format !== 'diff')) return null;
  if (changes?.format === 'diff' && !changes.invalid && Array.isArray(changes.files)) return changes.files.length;
  const topLevel = count(job.diffstat?.files);
  if (topLevel !== null) return topLevel;
  const receipt = job.receipt ?? job.resultSummary?.receipt?.receipt;
  if (receipt && (receipt.candidate_format === undefined || receipt.candidate_format === 'diff'))
    return count(receipt.diffstat?.files);
  return job.resultSummary?.noChanges === true ? 0 : null;
}

/** A plain folder gets a ZIP and a Changes list only when the run changed something; `noChanges` is the known-zero count. */
export function plainFolderResultCaption(noChanges) {
  return noChanges ? 'No files changed. Your sent folder stays unchanged.'
    : 'The ZIP contains new and changed files. Deleted files are listed in Changes. Your sent folder stays unchanged.';
}

/** One identity for the list and detail; a lender's receipt adds only the “You ran” context. */
function rosterMemberName(job, key, devices) {
  const circleId = job.circle?.id ?? job.circleId ?? job.circle;
  if (key == null || circleId == null || !Array.isArray(devices?.circles)) return '';
  const circle = devices.circles.find(entry => (entry.circle ?? entry.id) === circleId);
  const members = Array.isArray(circle?.members) ? circle.members : [];
  const member = members.find(entry => (entry.key_id ?? entry.keyId) === key);
  if (!member) return '';
  return clean(member.localName?.label ?? member.localName) || clean(member.personName) || clean(member.device_name ?? member.name);
}
function rosterRequester(job, devices) {
  return rosterMemberName(job, job.historyIdentity?.author, devices);
}
/** Resolve people before computer labels, and keep the viewer's relation explicit. */
export function jobPeopleVM(job, devices, members) {
  job ??= {}; devices ??= {};
  const circleId = job.circle?.id ?? job.circleId ?? job.circle;
  const roster = members ?? devices.circles?.find(entry => (entry.circle ?? entry.id) === circleId)?.members ?? [];
  const viewer = devices.fingerprint;
  const person = (key, fallback) => {
    fallback ??= {};
    const member = roster.find(entry => (entry.key_id ?? entry.keyId) === key) ?? {};
    return clean(member.localName?.label ?? member.localName) || clean(fallback.localName?.label ?? fallback.localName)
      || clean(member.personName) || clean(fallback.personName)
      || (key && key === viewer ? clean(devices.ownerName) : '')
      || clean(member.device_name ?? member.name) || clean(fallback.deviceName);
  };
  const author = job.historyIdentity?.author, holder = job.current_attempt?.holder;
  const host = roster.find(entry => (entry.key_id ?? entry.keyId) === holder);
  const lenderDevice = clean(host?.device_name ?? host?.deviceName ?? host?.name) || clean(job.receipt?.device_name);
  return {requester:person(author,job.historyIdentity),lender:person(holder),lenderDevice,
    ownRequest:Boolean(job.local || author && author === viewer),ownRun:Boolean(holder && holder === viewer)};
}
export function jobVM(job = {}, role = ['ran','received'].includes(job.role) ? job.role : 'sent', {lender = '', requester = '', now, zone, changes, devices} = {}) {
  const identity = job.historyIdentity ?? {};
  const person = clean(requester) || clean(identity.localName) || clean(identity.personName) || rosterRequester(job, devices) || clean(identity.deviceName ?? job.requesterName);
  const lenderJob = role === 'ran' || role === 'received';
  const suppliedTitle = lenderJob
    ? ranTitleCandidate(job.title) || ranTitleCandidate(job.local?.title) || requestedTitle(job)
    : '';
  const title = lenderJob ? suppliedTitle || (person ? boundedText('Job for ' + person) : role === 'received' ? 'A job accepted here' : 'A job you ran')
    : clean(/:\s*$/.test(job.local?.title ?? job.title ?? '') ? job.local?.prompt ?? job.prompt : job.local?.title ?? job.title, 'Untitled job');
  const status = jobStatusVM(job, {role,lender,requester:person,now,zone,ownRun:lenderJob});
  const state = {key:status.key,kind:status.pill.kind,word:status.pill.word,step:status.step};
  const resultState = ['ready','added_branch','no_changes'].includes(status.key);
  const changeCount = resultState ? resultChangeCount(job, changes) : null;
  const returnedOutputs = ['message','files'].includes(changes?.format ?? job.format ?? job.output?.kind ?? job.resultSummary?.output?.kind);
  const appliedBranch = formatJobProjection(job).projection.application.appliedBranch;
  const noChanges = resultState && !appliedBranch && !returnedOutputs && changeCount === 0;
  const resultPending = resultState && !appliedBranch && !returnedOutputs && changeCount === null;
  if (role === 'ran') {
    if (['ready','added_branch'].includes(status.key)) Object.assign(state,{kind:'on',word:'Sent back'});
    else if (status.key === 'stopped') state.word = LENDER_JOB_STATES.stopped;
    else if (status.key === 'failed') state.word = LENDER_JOB_STATES.failed;
    else if (status.key === 'uncertain') state.word = LENDER_JOB_STATES.uncertain;
  }
  if (status.key === 'waiting' && formatJobProjection(job).noLender) state.word = 'Waiting · no lender';
  if (noChanges) Object.assign(state,{kind:'off',word:'No changes'});
  if (status.stoppedEarly) state.word = stoppedResultWord(noChanges ? 'no_changes' : status.key, role);
  const agent = jobAgent(job, status.key);
  // A saved copy (host unreachable) shows the status it was saved with, framed as last known (judge r9 O-C).
  const lastKnown = formatJobProjection(job).projection.observation?.state === 'last_known' && status.key !== 'unknown';
  const listWord = status.stoppedEarly ? state.word : noChanges ? 'No changes' : role === 'ran' && ['ready','added_branch'].includes(state.key) ? 'Sent back' : state.word;
  return {...state, listWord:lastKnown ? 'Last known: ' + listWord : listWord, lastKnown,
    title, receiptTitle:role === 'received' ? (person ? person + '’s accepted job' : 'A job accepted here') : person ? 'You ran ' + (person + '’s job') : 'You ran this job', requester:person,
    glyph:lenderJob ? 'laptop' : 'arrow-up-right', directionLabel:lenderJob ? 'Ran here' : 'Sent by you', reason:['failed','expired'].includes(status.key) ? status.headline : '', agent:agent || '—', noChanges, resultPending, stopNote:status.stoppedEarly ? status.text : ''};
}

/** Own jobs have no avatar. Device labels never become a person's initials. */
export function jobAvatarVM(job = {}, role = job.role) {
  if (!['ran','received'].includes(role)) return null;
  const name = clean(job.historyIdentity?.localName) || clean(job.historyIdentity?.personName), id = job.historyIdentity?.author ?? job.requester;
  return name ? {kind:'person', name, id:id || name} : {kind:'device'};
}

const jobUpdatedAt = job => [job.updated_at, job.receipt?.finished_at, job.current_attempt?.stopped_at,
  job.current_attempt?.execution_started_at, job.current_attempt?.claimed_at,
  job.waitingTiming?.submittedAt, job.local?.submittedAt, job.created_at]
  .map(time).find(Number.isFinite) ?? NaN;
// A calendar day number avoids 23/25-hour days when the computer changes to daylight saving time.
function localDay(ms, zone) {
  if (!Number.isFinite(ms)) return NaN;
  try {
    const parts = dateParts(ms, 'numericDate', {zone});
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day) / 86400000;
  } catch { return NaN; }
}

/** Sort before grouping; counts include every job, independent of the current search/filter. */
export function jobsListVM(jobs = [], {filter = 'all', query = '', now = Date.now(), computerZone: viewZone = computerZone(), machine = '', jobApprovals = [], devices} = {}) {
  const calendarZone = viewZone || computerZone();
  const approvalByDigest = new Map(jobApprovals.filter(card => card?.jobDigest && typeof card.id === 'string' && card.id).map(card => [card.jobDigest, card.id]));
  const all = (Array.isArray(jobs) ? jobs : []).map(job => {
    const role = ['ran','received'].includes(job.role) ? job.role : 'sent', at = jobUpdatedAt(job);
    const formatted = formatJobProjection(job);
    const lender = clean(job.lenderName ?? job.lender?.name ?? job.lender);
    const identity = jobVM(job, role, {lender,now,zone:calendarZone,devices}), {key, step, title, requester} = identity;
    const waitingReason = key === 'waiting' && formatted.noLender;
    const waitingCopy = key === 'waiting' ? waitingCopyVM(job,{circle:job.circle?.name,zone:calendarZone,lender,devices,now}) : null;
    const agent = identity.agent === 'Agent not recorded' ? '' : identity.agent;
    const agentWords = agent.endsWith(' (requested)') ? '' : agent;
    const who = role === 'ran' || role === 'received' ? 'On ' + (machine || 'this computer') + (requester ? ' · ' + (role === 'ran' ? 'ran for ' : 'for ') + requester : '')
      : lender ? agentWords ? lender + '’s ' + (agentWords === 'Any agent' ? 'agent' : agentWords) : lender : agentWords;
    const statusTitle = waitingCopy?.previousDecision
      ? [waitingCopy.previousDecision, waitingCopy.headline].filter(Boolean).join(' ')
      : waitingReason ? formatted.waitingHeadline || identity.listWord : undefined;
    const jobHref = job.job_digest ? '#/job/' + encodeURIComponent(job.job_digest) + (job.circle?.id ? '/' + encodeURIComponent(job.circle.id) : '') : '';
    const approvalId = approvalByDigest.get(job.job_digest) && jobs.filter(candidate => candidate.job_digest === job.job_digest).length === 1 ? approvalByDigest.get(job.job_digest) : null;
    const attention = identity.lastKnown ? null : approvalId ? { label:'Review request', href:'#/request/' + encodeURIComponent(approvalId) }
      : jobHref && key === 'ready' && role === 'sent' && !identity.noChanges && !identity.resultPending ? { label:'Review result', href:jobHref } : null;
    return {id:job.job_digest, circleId:job.circle?.id ?? '', circle:clean(job.circle?.name), role, kind:identity.kind, word:waitingReason ? (identity.lastKnown ? 'Last known: ' : '') + 'Waiting · no lender' : identity.listWord, statusTitle, key, step, glyph:identity.glyph, directionLabel:identity.directionLabel, reason:identity.reason,
      needs:Boolean(attention), attention, title, sentByAgent:job.local?.sentByAgent===true,
      lastKnown:identity.lastKnown, noChanges:identity.noChanges, resultPending:identity.resultPending, stopNote:identity.stopNote,
      agent, who, whoShort:role === 'ran' ? (requester ? 'ran for ' + requester : 'ran here') : role === 'received' ? (requester ? 'for ' + requester : 'accepted here') : who,
      when:whenLabel(at, now, calendarZone) || 'Time unavailable', at, day:localDay(at,calendarZone),
      avatar:jobAvatarVM(job,role), person:{name:requester || 'A circle member',id:job.historyIdentity?.author ?? requester},
      href:jobHref};
  }).sort((a,b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity) || 0);
  const matches = (row, id) => id === 'all' || id === 'needs' && row.needs || row.role === id || id === 'ran' && row.role === 'received';
  const q = String(query).trim().toLocaleLowerCase();
  const rows = all.filter(row => matches(row,filter) && (!q || [row.title,row.agent,row.word,row.who,row.circle].some(text => text.toLocaleLowerCase().includes(q))));
  const today = localDay(now,calendarZone), weekStart = today - (new Date(today * 86400000).getUTCDay() + 6) % 7, groups = [];
  for (const row of rows) {
    const title = row.day === today ? 'Today' : row.day === today - 1 ? 'Yesterday' : row.day >= weekStart && row.day < today ? 'Earlier this week' : 'Earlier';
    const last = groups.at(-1);
    if (last?.title === title) last.rows.push(row); else groups.push({title,rows:[row]});
  }
  for (const group of groups) {
    group.items = [];
    for (let i = 0; i < group.rows.length;) {
      const row = group.rows[i], run = [row];
      if (row.role === 'ran' && Number.isFinite(row.day)) {
        while (group.rows[i + run.length]?.role === 'ran' && group.rows[i + run.length].day === row.day) run.push(group.rows[i + run.length]);
      }
      if (run.length > 2) group.items.push({batch:true,id:row.id,rows:run,label:run.length + ' jobs you ran for others ' + (row.day === today ? 'today' : row.day === today - 1 ? 'yesterday' : 'on ' + formatDate(row.at, 'monthDay', {zone: calendarZone}))});
      else group.items.push(...run);
      i += run.length;
    }
  }
  const filters = JOB_FILTERS.map(([id,label]) => ({id,label,count:all.filter(row => matches(row,id)).length,on:id === filter}));
  return {groups,count:rows.length,filters:filters.filter(f => f.id !== 'needs' || f.count > 0)};
}
export const JOBS_EMPTY = readStateView({kind:'loaded-empty'});

/** The ⌘K palette: sections in the mockup's order, filtered by what was typed. */
export function paletteVM(query = '', {approvals = [], jobs = [], circles = [], lendingOn = false, ready = SETTINGS_READY} = {}) {
  const q = String(query).trim().toLowerCase();
  const has = text => !q || String(text).toLowerCase().includes(q);
  const fuzzy = text => { let at = 0; for (const ch of String(text).toLowerCase()) if (ch === q[at]) at++; return at === q.length; };
  const sections = [];
  const add = (title, items) => { if (items.length) sections.push({title, items}); };
  add('Go to', [
    ['home', 'Home', 'home'], ['jobs', 'Jobs', 'jobs'], ['lend', 'Lending', 'lend'],
    ['lend/limits', 'What you lend', 'clock'], ['circles', 'Circles', 'circles'], ['setup', 'Setup', 'check-circle'], ['you', 'You', 'user'], ['you/all', 'Settings', 'settings'],
  ].map(([page, label, icon]) => ({id: 'go:' + page, label, icon, href: '#/' + page})).filter(i => has(i.label)));
  add('Jobs', [...jobs].sort((a,b) => (b.at || 0) - (a.at || 0)).filter(j => fuzzy(j.title) || has(j.whoShort)).slice(0, 5)
    .map(j => ({id: j.circleId ? 'job:' + JSON.stringify([j.id,j.circleId]) : 'job:' + j.id, icon: 'jobs', label: j.title + (j.circleId ? ' · ' + (j.circle || j.circleId) : '') + (j.whoShort ? ' · ' + j.whoShort : '') + (j.word ? ' · ' + j.word.toLowerCase() : ''), href: j.href})));
  add('Circles', circles.filter(c => c.origin && has(c.name)).map(c => ({id: 'circle:' + c.id, icon: 'circles', label: clean(c.name, 'Your circle'), href: '#/circle/' + encodeURIComponent(c.id)})));
  const needs = approvals.map(card => {
    const name = personName({localName: card.localName, personName:card.identity?.personName ?? card.personName, deviceName: card.requesterName, requester: card.requester}) || 'a circle member';
    return {id: 'need:' + card.id, icon: 'avatar', avatarName:clean(card.localName),
      label: 'Review ' + name + '’s request', href: '#/request/' + encodeURIComponent(card.id)};
  });
  add('Actions', [...needs, {id: 'act:new', icon: 'plus', label: 'New job', key: 'N', href: '#/new'},
    ...(lendingOn ? [{id: 'act:pause', icon: 'pause', label: 'Pause lending', key: '⇧P', op: 'lending.pause'}] : []),
  ].filter(a => has(a.label)));
  // After actions, so "pause" offers Pause lending first. Individual settings by label or synonym ("quota", "dark mode"); each opens its page at the field.
  if (q) add('Settings', searchSettings(q, {ready, limit: 4}).map(item => ({id: 'setting:' + item.key, icon: 'settings',
    label: item.label + (settingPlace(item.href) ? ' · ' + settingPlace(item.href) : ''), href: item.href, focus: item.focus ?? null})));
  return {sections, items: sections.flatMap(s => s.items)};
}

/**
 * U16: the time and hours part of "What you lend". Limits are today's `lending.limits`, saved by
 * POST lending/limits together with the lending policy (lending-policy-view.mjs).
 */
export const HOURS = Array.from({length: 48}, (_, n) => {
  const h = Math.floor(n / 2), m = n % 2 ? '30' : '00', value = String(h).padStart(2, '0') + ':' + m;
  return {value, label: hourOf(value)};
});
export const WEEKDAYS = [['1', 'M', 'Monday'], ['2', 'T', 'Tuesday'], ['3', 'W', 'Wednesday'], ['4', 'T', 'Thursday'], ['5', 'F', 'Friday'], ['6', 'S', 'Saturday'], ['0', 'S', 'Sunday']];
export function limitsDraft(lending = {}, status = {}, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const l = lending.limits ?? {}, schedule = l.schedule ?? status.schedule ?? null;
  const text = value => finite(value) ? String(value) : '';
  return {
    dailyJobs: text(l.dailyJobs), dailyMinutes: text(l.dailyMinutes),
    maxMinutes: finite(l.maxWallSeconds) ? String(Math.round(l.maxWallSeconds / 60)) : '',
    // The old weekly reserve has no control any more (the lending policy replaced it); it is kept as saved.
    quotaReserve: finite(l.quotaReserve) ? l.quotaReserve : 0,
    idleOnly: l.idleOnly === true, timeZone: clean(l.timeZone, localZone || computerZone()), mode: lending.mode === 'ask' ? 'ask' : 'auto',
    // Lending hours are optional: `on` is whether the computer lends only in them. They are saved with the zone.
    schedule: {on: Boolean(schedule), days: (schedule?.days ?? [1, 2, 3, 4, 5]).map(String), from: schedule?.from ?? '22:00', to: schedule?.to ?? '07:00',
      weekendsAllDay: schedule ? schedule.weekends_all_day === true : true},
  };
}
/** The server's snake_case schedule for a draft, or null when lending is not limited to hours. */
export const scheduleOf = draft => draft.schedule?.on ? {days: draft.schedule.days.map(Number), from: draft.schedule.from, to: draft.schedule.to, weekends_all_day: draft.schedule.weekendsAllDay} : null;
const RANGES = {dailyJobs: [1, 20, 'Jobs a day'], dailyMinutes: [5, 600, 'Minutes a day'], maxMinutes: [5, 120, 'Longest job']};
export function validateLimits(draft) {
  const errors = {}, n = {};
  for (const [key, [min, max, label]] of Object.entries(RANGES)) {
    const text = String(draft[key] ?? '').trim();
    if (text === '') n[key] = null;
    else if (!/^\d+$/.test(text) || +text < min || +text > max) errors[key] = label + ': use a whole number from ' + min + ' to ' + max + ', or leave it empty for no cap.';
    else n[key] = +text;
  }
  if (draft.schedule?.on && draft.schedule.days.length === 0 && !draft.schedule.weekendsAllDay) errors.days = 'Choose at least one day.';
  const ok = Object.keys(errors).length === 0;
  return {ok, errors, limits: ok ? {dailyJobs: n.dailyJobs, dailyMinutes: n.dailyMinutes, maxWallSeconds: n.maxMinutes === null ? null : n.maxMinutes * 60,
    quotaReserve: draft.quotaReserve, idleOnly: draft.idleOnly, timeZone: draft.timeZone} : null};
}
/** The live sentence at the top of the form, from the draft rather than the saved rules. */
export function limitsPreview(draft, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const v = validateLimits(draft);
  const schedule = scheduleOf(draft);
  const limits = {timeZone: draft.timeZone,
    dailyJobs: draft.dailyJobs === '' ? null : +draft.dailyJobs,
    dailyMinutes: draft.dailyMinutes === '' ? null : +draft.dailyMinutes,
    maxWallSeconds: draft.maxMinutes === '' ? null : +draft.maxMinutes * 60};
  const parts = limitsSummary({limits: Object.fromEntries(Object.entries(limits).filter(([key, x]) => key === 'timeZone' || (Number.isFinite(x) && x >= 0 && (x > 0 || v.ok)))) }, schedule);
  return draft.timeZone === localZone ? parts.map(p => ({...p, text: p.text.replace(' (' + zoneName(localZone) + ' time)', '')})) : parts;
}

/**
 * U21: shell states. `connectionVM` says when the page shows old data (the status read
 * failed) or live updates are paused (reads still work, the event stream is down).
 * `updateVM` reads the updater’s restarting signal or an explicitly ready UI version.
 * An available package alone never asks the user to reload before installation.
 */
export const REQUIRED_RESOURCES = ['home', 'readiness', 'agents', 'circles', 'approvals', 'devices', 'activity', 'jobs'];
/** Per-resource freshness: only a resource that loaded this time moves its own timestamp. */
export function trackFreshness(old = {}, names = [], ok = [], at = '') {
  const next = {...old};
  names.forEach((name, i) => { if (ok[i]) next[name] = at; });
  return next;
}
export function connectionVM({connected = null, online = true, errors = {}, freshness = {}, zone = computerZone(), phone = false, capabilities = browserProblemContext().capabilities} = {}) {
  const stale = REQUIRED_RESOURCES.filter(name => errors[name]&&errors[name]?.name!=='AbortError'&&errors[name]?.code!=='device_busy');
  const pending = REQUIRED_RESOURCES.filter(name=>errors[name]?.code==='device_busy');
  const context = {surface:phone?'phone':'desktop',capabilities};
  const banner = (kind, input, names = stale, timingNames = names) => {
    const view = problemView(input?.problem ?? input, context);
    const times = timingNames.map(name => time(freshness[name])).filter(Number.isFinite);
    const at = kind!=='session'&&times.length ? clock(kind==='paused'?Math.max(...times):Math.min(...times), zone) : '';
    // Time is a formatting fact; the explanation/recovery remains catalog-owned.
    const retryable = ['check-status','reload','check-connection'].includes(view.action.kind);
    return {kind, icon:['offline','stale','paused'].includes(kind)?'cloud-off':'alert', stale:names,
      headline:view.title, text:view.detail + (connected === false && ['stale','error'].includes(kind) ? ' Live updates are paused.' : ''), ...(at?{asOf:'Last update '+at+'.'}:{}),
      action:retryable?(kind==='paused'?'Refresh':view.action.label):null,
      details:kind==='session'||phone?undefined:JSON.stringify(names.map(name=>({resource:name,code:errors[name]?.code??null,...(errors[name]?.diagnosticId?{diagnosticId:errors[name].diagnosticId}:{})}))),
    };
  };
  if (online === false) return banner('offline', {code:'offline'}, []);
  if (stale.some(name => errors[name]?.status===401 || errors[name]?.code==='unauthorized'))
    return banner('session', {code:'unauthorized'});
  if (stale.length) {
    const unreachable = stale.some(name => !errors[name]?.status&&['network','offline'].includes(errors[name]?.code));
    return banner(unreachable?'stale':'error', errors[stale[0]], stale, [stale[0]]);
  }
  if (connected === false) return banner('paused', {code:'updates_paused'}, [], REQUIRED_RESOURCES);
  if (pending.length) return {kind:'refreshing',icon:'refresh',stale:pending,text:problemView({code:'device_busy'},context).detail,action:null};
  return null;
}
export function updateVM(home = {}, status = null, dismissedVersions = []) {
  const update = home?.update;
  if(update?.state==='restarting')return {icon:'refresh',text:'Faravan is updating'+(clean(update.version)?' to '+clean(update.version):'')+'. This page reconnects by itself.',action:null,version:clean(update.version)};
  if (update?.ready === true)
    return {icon: 'refresh', text: 'A new version of Faravan is ready.', action: 'Reload', version: clean(update.version)};
  if (!['available','staged'].includes(status?.state)) return null;
  const version = typeof status.candidate === 'string' ? clean(status.candidate) : '';
  if (!version || version === clean(status.currentVersion) || dismissedVersions.includes(version)) return null;
  return {icon:'refresh',
    text:status.state === 'staged' ? 'A Faravan update is waiting to be installed.' : 'A new version of Faravan is available.',
    action:'View updates', actionKind:'updates', version};
}

/**
 * What a restart does to lending, from the real intent (app.mjs saves "on" and resumes it; a timed
 * pause resumes by itself at its end). Never a fixed sentence: it follows what lending is set to do.
 */
export function restartLine(status = {}) {
  const s = status.lending ?? status, intent = lendingProjectionOf(status).intent;
  const until = clock(status.intent?.until ?? status.until ?? s.until ?? s.pause_until);
  if (intent === 'paused') return 'Lending is paused' + (until ? ' until ' + until : '') + '. After a restart it stays paused' + (until ? ' and resumes by itself at that time.' : ' until you resume it.');
  if (intent === 'off' || (intent === undefined && s.enabled === false)) return 'Lending is off. After a restart it stays off until you turn it on.';
  if (intent === 'unknown' || (intent === undefined && s.enabled !== true)) return '';
  return 'Lending is on. After a restart it turns back on by itself.';
}

/**
 * What blocks lending (EXPERIENCE M4): blockers.mjs is the designer's one ordered model, ported unchanged. This is
 * the adapter from the app's real fields to its inputs. A fact the app does not have is null (never "ok"):
 * `readiness.checks` (sbx_install, sbx_daemon, docker_runtime, docker_login, and the sandbox checks), the lending
 * intent, and the lent agents in /lend order. Not in the API yet, so absent: Docker's account and the time its sign-in
 * expired, and the circle host's reachability.
 */
export {lendingBlockers, trayLines, BLOCKER_ORDER} from './blockers.mjs';
const DOCKER_INSTALLED = ['sbx_install'], DOCKER_RUNNING = ['sbx_daemon', 'docker_runtime'], DOCKER_SIGNIN = ['docker_login'];
export function blockersInput({status = {}, readiness = null, agents = [], zone = computerZone(), now = Date.now()} = {}) {
  const s = status.lending ?? status, state = status.intent?.state ?? status.state;
  const checks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  // true when every named check is there and ok, false when one failed, null when none can say
  const fact = names => { const found = checks.filter(c => names.includes(c.name)); return found.some(c => c.ok === false && c.unknown !== true) ? false : found.length && found.every(c => c.ok === true) ? true : null; };
  const reason = status.intent?.reason ?? status.reason ?? s.reason, kinds = [...(status.needs_you ?? []), ...(status.blockers ?? [])].map(n => n?.kind);
  const signedOut = reason === 'docker_signed_out' || kinds.includes('docker_signed_out');
  const latched = signedOut || reason === 'safety_check_failed' || reason === 'sandbox_not_ready' || kinds.includes('safety_check_failed');
  // The live checks (readiness) outrank the saved cause: a latch left over from an earlier failure must not make one
  // screen say "not signed in" while another says it is. A passed preflight (`ready`) says all three are fine even when
  // it lists no check by name.
  const passed = readiness?.ready === true;
  const docker = {installed: fact(DOCKER_INSTALLED) ?? (passed || null), running: fact(DOCKER_RUNNING) ?? (passed || null), signedIn: fact(DOCKER_SIGNIN) ?? (passed ? true : signedOut ? false : null)};
  const loginStorage=checks.find(c=>c.name==='docker_login'&&c.ok===false&&c.cause==='docker_signin_state_unavailable');
  if(loginStorage)docker.signedIn=null;
  // A working listing proves no Docker identity. Until a create is accepted the sign-in stays unknown in every shared view; the
  // permission to try a sandbox create is the app's own decision, not this fact.
  if(checks.some(c=>c.name==='docker_login'&&c.ok===true&&c.signinVerified===false&&c.createAccepted!==true)){docker.signedIn=null;docker.signinUnverified=true;}
  if(checks.some(c=>c.name==='docker_login'&&c.ok===true&&c.signinVerified===false&&c.createAccepted===true))docker.signinAccepted=true;
  const loginRefresh=checks.find(c=>c.name==='docker_login'&&c.ok===false&&c.cause==='docker_signin_refresh_unavailable');
  if(loginRefresh){docker.signedIn=null;docker.signinDetail=clean(loginRefresh.label);}
  if(checks.some(c=>c.name==='docker_login'&&dockerSigninInconclusive(c))){
    if(checks.some(c=>c.name==='docker_login'&&c.checking===true))docker.signinChecking=true;else docker.signinSettled=true;
  }
  const restart=checks.find(c=>c.name==='sbx_daemon'&&c.ok===false&&c.cause==='daemon_restart_required');
  if(restart)docker.restart={detail:clean(restart.label),action:restart.automatic===false?'Restart Docker Sandboxes':''};
  // The failing check behind "not running", said once with what the app knows about it (lib/v1/docker-state.mjs).
  else {const stopped=dockerStoppedRow(checks.filter(c=>DOCKER_RUNNING.includes(c.name)));if(stopped)docker.stopped=stopped;}
  const account = clean(readiness?.docker?.account), expired = clock(readiness?.docker?.expired_at, zone);
  if (account) docker.account = account;
  if (expired && docker.signedIn === false) docker.expiredAt = expired;
  // Platform prerequisites are separate from per-job isolation. Setup offers Linux kvm remediation; Windows is outside the MVP.
  const failing = checks.filter(c => c.ok === false && (c === loginStorage || !DOCKER_INSTALLED.concat(DOCKER_RUNNING, DOCKER_SIGNIN, ['hypervisor_platform', 'kvm_access']).includes(c.name)));
  const liveOk = Boolean(readiness) && docker.installed === true && docker.running === true && docker.signedIn === true && failing.length === 0 && passed;
  const stale = latched && liveOk;
  const seen = clock(readiness?.protection?.observed_at, zone);
  const why = c => clean(c?.label).replace(/\.$/, '') || clean(c?.name).replace(/_/g, ' ') || 'the check didn’t say why';
  const deadline = lendingUntil(status), until = clock(deadline, zone);
  const pauseTime = formatPauseDeadline(deadline, {now, formatClock: at => clock(at, zone)});
  // A saved failure that the live checks no longer show leaves lending stopped (the app turned it off): "off", with a way back.
  const intent = stale || state === 'off' || (state === undefined && s.enabled === false) ? {on: false}
    : state === 'paused' ? {on: true, pausedUntil: pauseTime || 'you resume'}
    : state === 'outside' ? {on: true, outsideUntil: until || 'your lending hours begin'}
    : state === 'resting' ? {on: true, restingUntil: until || 'midnight'}
    : state === 'starting' || (state === undefined && s.enabled === undefined) ? {} : {on: true};
  const lent = (Array.isArray(agents) ? agents : []).filter(a => a.useForLending === true)
    .map(a => ({id: canonicalAgentId(a), name: agentLabel(canonicalAgentId(a)), enabled: true, installed: typeof a.installed === 'boolean' ? a.installed : null, signedIn: agentCheckVM(a).signedOut ? false : typeof a.signedIn === 'boolean' ? a.signedIn : null}));
  return {docker, readinessRequirements:failing.map(c=>({cause:c===loginStorage?c.cause:c.reason??c.name,label:c.label,remedy:c.remedy})),isolationFailure:status.isolationFailure, intent, agents: lent, latched, stale};
}
// The account's current availability is the only readiness a lent agent can show. Missing evidence is unknown, never ready.
function currentAvailabilityOf(status, agentId) {
  const provider = agentId === 'codex' ? 'codex' : agentId === 'claude-code-subscription' ? 'claude' : null;
  const account = (status?.lendingPolicy?.accounts ?? []).find(item => item.provider === provider);
  const availability = currentAccountDecision(account);
  if (!availability || typeof availability !== 'object') return {admitted: false, held: false, line: null};
  if (availability.admitted === true) return {admitted: true, held: false, line: null};
  return {admitted: false, held: true, line: availability.status?.line ?? availability.objective?.reasonText ?? 'Holding because current allowance is unavailable.'};
}
/** The model for one render: `first` is the one thing to fix; `byAgent` maps each lent agent to its row. */
export function blockersFor(args = {}) {
  const input = blockersInput(args), server = args.status?.lending_blockers;
  // /api/home knows the persisted isolation-check version; a read-only preflight cannot override it.
  const valid = Array.isArray(server?.items) && server.items.length > 0 &&
    server.items.every(item => item && typeof item.key === 'string' && typeof item.detail === 'string' && ['ok', 'off', 'blocked', 'unknown', 'waits'].includes(item.status)) &&
    typeof server.canLend === 'boolean' && (!server.first || server.items.some(item => item.key === server.first.key && item.agent === server.first.agent && item.status === 'blocked'));
  const items = valid ? server.items.map(item => ({...item, detail:agentDisplayText(item.detail), ...(item.agent ? {label: agentLabel(item.agent)} : {})})) : null;
  const first = items && server.first ? items.find(item => item.key === server.first.key && item.agent === server.first.agent) : null;
  const model = valid ? {...server, items, first, needsYou: items.filter(item => item.status === 'blocked' && item.action)} : lendingBlockers(input);
  // Readiness can pass even when resuming the lender failed after a restart.
  // Keep that execution failure in the same ordered model and expose the recovery action.
  const startFailed = !['running','finishing','stopping'].includes(lendingProjectionOf(args.status).execution) &&
    (Boolean(args.status?.lendingStartFailed) || ['lending_not_started','lending_start_failed'].includes(args.status?.intent?.reason ?? args.status?.reason));
  if (startFailed) {
    const selected=(args.status?.circles ?? []).find(circle=>circle.id===(args.status?.activeCircle ?? args.status?.lending?.circle));
    const name=clean(args.status?.lendingStartFailed?.circleName ?? selected?.name);
    const cause={circle_unreachable:'The computer hosting this circle couldn’t be reached.',agent_not_ready:'A selected agent isn’t ready.',sandbox_not_ready:'Docker Sandboxes isn’t ready.'}[args.status?.lendingStartFailed?.code] ?? '';
    const detail='Lending couldn’t start' + (name ? ' for ' + circlePhrase(name) : '') + '.' + (cause ? ' '+cause : '');
    const restart = {key: 'lending', label: 'Lending', status: 'blocked', detail, action: 'Resume now', headline: 'Lending couldn’t start'};
    const index = model.items.findIndex(item => item.key === 'lending');
    if (index >= 0) model.items[index] = restart;
    else model.items.splice(model.items.findIndex(item => item.agent) < 0 ? model.items.length : model.items.findIndex(item => item.agent), 0, restart);
    model.first = model.items.find(item => item.status === 'blocked') ?? restart;
    model.needsYou = model.items.filter(item => item.status === 'blocked' && item.action);
    model.canLend = false;
  }
  const beforeReconciliation = model.items;
  model.items = model.items.map(item => {
    if (!item.agent || item.status === 'off') return item;
    const agent = (args.agents ?? []).find(a => canonicalAgentId(a) === item.agent);
    if (!agent) return item;
    const check = agentCheckVM(agent, args.now);
    if (agent.installed === false) return {...item,status:'blocked',detail:'Not installed.',action:'Install ' + agentLabel(agent.id),headline:'Lending stopped: ' + agentLabel(agent.id) + ' isn’t installed',waitsFor:undefined};
    if (check.signedOut) return {...item,status:'blocked',detail:'Signed out.',action:'Sign in to ' + agentLabel(agent.id) + (agent.signInReason === 'credential_missing' ? ' again' : ''),headline:'Lending stopped: ' + agentLabel(agent.id) + ' is signed out',waitsFor:undefined};
    // A fresh sign-in check does not clear a machine prerequisite.
    if (item.status === 'waits') return item;
    if (check.stopped && !check.checking)
      return {...item, status: 'unknown', detail: automaticChecksStoppedLine('Check ' + agentLabel(agent.id)), action: 'Check ' + agentLabel(agent.id), automaticChecksStopped: true};
    if (check.failed || item.status === 'unknown' && !check.ready && !check.signedOut)
      return {...item, status: 'unknown', detail: check.word + '.', action: check.checking ? undefined : 'Check ' + agentLabel(agent.id)};
    if (check.ready && (item.status === 'unknown' || item.detail === 'Signed out.')) {
      const dependency = model.items.find(row => ['docker_installed','docker_running','docker_signin','isolation_check'].includes(row.key) && row.status !== 'ok');
      return dependency ? {...item,status:'waits',detail:'Waits for ' + ({docker_signin:'the Docker sign-in',}[dependency.key] ?? 'Docker Sandboxes') + '.',waitsFor:dependency.key,action:undefined,headline:undefined}
        : {...item, status: 'ok', detail: 'Ready.', action: undefined, waitsFor:undefined,headline:undefined};
    }
    return item;
  });
  // Ready to lend needs a lent agent's own current availability. Sign-in, the server row and a retained job never supply it.
  // A held reading keeps the agent's row as a wait: it cannot lend, but nothing for the person to fix.
  // With no reading, only a lending-on computer is checking; with lending off there is no reading to wait for.
  // The evidence for each row comes from the computer verdict, the same answer every other surface reads.
  const readiness = computerReadiness({status:args.status, agents:args.agents});
  const lendingOn = lendingProjectionOf(args.status).intent === 'on';
  model.items = model.items.map(item => {
    if (item.status !== 'ok' || !item.agent) return item;
    const evidence = readiness.perAccount.find(account => account.agent === item.agent) ?? accountEvidenceOf(args.status, item.agent);
    if (evidence.evidence === 'admitted') return item;
    if (evidence.evidence === 'held') return {...item, status:'waits', detail:evidence.line, headline:undefined, action:undefined, waitsFor:undefined, holding:true};
    return lendingOn ? {...item, status:'unknown', detail:'Checking…', action:undefined, headline:undefined, waitsFor:undefined, checking:true} : item;
  });
  if (model.items.some((item,index) => item !== beforeReconciliation[index])) {
    // One admitted agent is enough to lend. A held or still-checking sibling does not veto it, and neither lends on its own.
    const agentsOk = input.agents.some(agent => agent.enabled === true &&
      input.agents.filter(other => other.id === agent.id).length === 1 &&
      model.items.some(item => item.agent === agent.id && item.status === 'ok' && item.holding !== true));
    model.first = model.items.find(item => item.status === 'blocked' && !(item.key === 'agent' && agentsOk)) ?? null;
    model.canLend = agentsOk && !model.first && model.items.every(item => item.key === 'agent' || item.status === 'ok' || item.status === 'off' || item.holding === true || item.checking === true);
    model.headline = model.first ? model.first.headline ?? model.first.detail
      : model.canLend ? 'Lending is on'
      : model.items.some(item => item.status === 'unknown') ? 'Checking this computer…' : 'Lending is waiting';
  }
  model.needsYou = model.items.filter(item => item.status !== 'off' && item.action &&
    (item.key !== 'lending' || startFailed && item.action === 'Resume now'));
  const byAgent = Object.fromEntries(model.items.filter(i => i.agent).flatMap(i => [i.agent,...(args.agents??[]).filter(a=>canonicalAgentId(a)===i.agent).map(a=>a.id)].map(key=>[key,i])));
  const waiting = model.items.filter(i => i.agent && i.status === 'waits');
  const steps = model.items.filter(i => i.status !== 'ok' && i.status !== 'off').length;
  // "Claude Code and Codex wait for the Docker sign-in." (Home), only when every waiting agent waits for the same row.
  const waits = waiting.length && new Set(waiting.map(i => i.waitsFor)).size === 1
    ? listWords(waiting.map(i => i.label)) + (waiting.length > 1 ? ' wait for ' : ' waits for ') + waiting[0].detail.replace(/^Waits for /, '') : '';
  // "Choose an agent" needs the agent list to have loaded; before that it is not a blocker.
  const chooseBeforeLoad = model.first?.key === 'agent' && !model.first.agent && !(Array.isArray(args.agents) && args.agents.length);
  return {...model, byAgent, steps, waits, source: valid ? 'server' : 'local', latched: input.latched, stale: valid ? false : input.stale, active: Boolean(model.first && model.first.key !== 'lending' && !chooseBeforeLoad && (valid || !input.stale))};
}

/**
 * The safety and receipt sentences are the designer's safety-copy.mjs, ported unchanged (its 459,201-case totality
 * test is safety-copy.test.mjs). Below, the adapters from the app's fields to its inputs. A fact the app does not
 * have is null and reads as the cautious sentence; today no API field carries `credential_proxy_verified` as true
 * (S5.2) or an independent `boundary_verified` (S5.3), so a lender still reads the sign-in warning.
 */
import {safetyFacts, usageLine, receiptLines, runFacts, circleDisclosure, RECEIPT_COPY, circlePhrase} from './safety-copy.mjs';
export {safetyFacts, usageLine, groupEgress, receiptLines, runFacts, circleDisclosure, borrowerDisclosure, giftFacts, overviewFacts} from './safety-copy.mjs';

/** Display names and hosts of the adapters (S5.1 `safety.provider`, `safety.provider_hosts`); the table covers a view without them. */
const PROVIDER_NAMES = {anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter', github: 'GitHub'};
const PROVIDERS = {
  codex: {provider: 'OpenAI', hosts: ['**.openai.com', '**.chatgpt.com']},
  'claude-code-subscription': {provider: 'Anthropic', hosts: ['**.anthropic.com', '**.claude.ai']},
  gemini: {provider: 'Google', hosts: ['**.googleapis.com']},
  opencode: {provider: 'OpenRouter', hosts: ['openrouter.ai']},
};
/** The app says 'provider-only'; the copy module says 'provider'. */
const networkOf = (mode, registries) => ({mode: mode === 'provider-only' ? 'provider' : mode ?? null, registries: Array.isArray(registries) ? registries : []});

/**
 * U6: what the job page says about one job (EXPERIENCE 6.3, mockups/job.html), from what the API gives today:
 * the job's state, its current attempt (`holder`, `execution_started_at`, `compute_stopped`) and the progress
 * steps. The page body for each state comes from here; no screen writes its own status sentence.
 * ctx: {now, zone, role 'sent'|'ran', lender, agent, device, progress: [entries of GET /api/jobs/:id/progress]}. A name or fact that is unknown is '' and
 * the sentence is written without it.
 */
/**
 * Rows for the working card from the progress channel: `{stage, elapsed_s}` entries (P8b: preparing, agent, checks,
 * sending) and `{step}` entries (what the agent is doing, named by kind, never its words). The sandbox row reads "Prepared"
 * with its own time once the agent has started; with no stage entries (an older lender) only the latest step shows.
 */
function progressRows(entries, agentMinutes, activity, now) {
  const list = Array.isArray(entries) ? entries : [], stages = list.filter(e => typeof e?.stage === 'string'), steps = list.filter(e => typeof e?.step === 'string' && e.kind !== 'done');
  const stage = stages.at(-1)?.stage, started = stages.find(e => e.stage === 'agent'), last = clean(steps.at(-1)?.step);
  const lastWords = last ? last[0].toLowerCase() + last.slice(1) : '';
  const m = seconds => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const rows = [];
  if (started && finite(started.elapsed_s)) rows.push({tone: 'ok', text: 'Prepared the sandbox · ' + m(started.elapsed_s)});
  if (stage === 'preparing') rows.push({tone: 'now', text: 'Preparing the sandbox'});
  else if (stage === 'sending') rows.push({tone: 'ok', text: 'Agent finished'}, {tone: 'now', text: 'Sending the result'});
  else if (stage === 'checks') rows.push({tone: 'ok', text: 'Agent finished'}, {tone: 'now', text: 'Faravan’s checks'});
  // The transcript feed, when this reader may see it, names the step itself: "running" and the command.
  else if (activity?.code) {
    const running = Number.isFinite(activity.since) && Number.isFinite(now) ? Math.max(0, Math.floor((now - activity.since) / 1000)) : activity.seconds;
    // The card's facts already say how long the job has run, so this row times the step, not the job.
    rows.push({tone: 'now', text: ['Agent working', clean(activity.doing)].filter(Boolean).join(' · '), code: activity.code,
      ...(Number.isFinite(running) ? {after: 'for ' + m(running)} : {})});
  }
  else rows.push({tone: 'now', text: ['Agent working', agentMinutes ? agentMinutes + ' min' : '', lastWords].filter(Boolean).join(' · ')});

  return rows;
}
const capital = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const minutesSince = (value, now) => { const at = time(value); return Number.isFinite(at) && Number.isFinite(now) && now >= at ? Math.max(0, Math.floor((now - at) / 60000)) : null; };
export function jobStatusVM(job = {}, {now = Date.now(), zone = computerZone(), role = 'sent', lender = '', requester:requesterName = '', ownRun = role === 'ran', ownRequest = role === 'sent', agent = '', device = '', progress = [], activity = null, lastOutputAt = null} = {}) {
  const {projection, key} = formatJobProjection(job), evidence = projection.evidence ?? {};
  const startedAt = evidence.executionStartedAt;
  const started = typeof startedAt === 'string' && startedAt !== '';
  const version = projection.version ?? {};
  const attemptTarget = typeof version.attemptId === 'string' && version.attemptId &&
    Number.isSafeInteger(version.generation) && version.generation > 0
    ? {attemptId:version.attemptId,generation:version.generation} : null;
  // A Stop the lender's computer verified and recorded, not one this requester sent (a requester's own cancel leaves the job cancelled).
  const sharedHolderStop = evidence.sharedStopRequestedAt != null && evidence.rawState !== 'cancelled';
  const state = JOB_STATES[key], who = clean(lender), whose = who ? who + '’s ' : '', computer = ownRun ? 'your computer' : who ? who + '’s computer' : 'the lender’s computer';
  const kit = clean(agent), requester = clean(requesterName) || clean(job.historyIdentity?.localName) || clean(job.historyIdentity?.personName) || clean(job.historyIdentity?.deviceName);
  const out = {key, executionStarted:started, attemptTarget,
    pill: {kind: state.kind, word: lenderStateWord(role, key) ?? state.word.replace('{lender}', who || 'a lender')}, step: STEP_OF[key], fail: ['failed', 'stopped'].includes(key),
    kind: key === 'waiting' ? 'waiting' : ['ready', 'added_branch', 'no_changes'].includes(key) ? 'ready' : 'status', headline: '', facts: [], text: '', progress: [], note: '', canStop: false, stopLabel: ''};
  const ago = minutesSince(startedAt, now);
  // A requester's saved copy of a job that may have started cannot show a Stop the lender's computer recorded after the copy
  // was saved, so it offers no second Stop (judge r13 R13-1). This computer keeps its own Stop (ownRun).
  const savedStop = !ownRun && typeof job.savedAt === 'string';
  switch (key) {
    case 'waiting': Object.assign(out, {canStop: true, stopLabel: 'Cancel job'}); break;
    case 'waiting_approval': Object.assign(out, {headline: 'Waiting for ' + (who || 'a lender') + ' to say yes', canStop: true, stopLabel: 'Cancel job'}); break;
    case 'approved': Object.assign(out, {headline: who ? who + ' said yes' : 'A lender said yes', text: 'The agent has not started yet.', canStop: true, stopLabel: 'Cancel job'}); break;
    case 'starting': Object.assign(out, {headline: ownRun ? 'Preparing on your computer' : who ? 'Waiting for ' + who + '’s computer' : 'Waiting for the lender', text: 'The agent has not started yet.', canStop: !savedStop, stopLabel: 'Stop this job'}); break;
    case 'working': {
      // A requester cannot stop a job whose stop status it could not check. This computer keeps its own Stop (ownRun).
      const unknownStop = !ownRun && evidence.sharedStopRequestUnavailable === true;
      Object.assign(out, {headline: ownRun ? 'Your ' + (kit || 'agent') + ' is running ' + (ownRequest ? 'your job' : requester ? requester + '’s job' : 'this job') : who ? whose + (kit || 'agent') + ' is working on it' : (kit ? 'A ' + kit + ' agent' : 'An agent') + ' is working on it',
        facts: [device ? 'On ' + device : '', jobTimingLine({now, startedAt, stopsAt:job.runTiming?.hardStopAt, lastOutputAt, zone})].filter(Boolean),
        progress: progressRows(progress, ago, activity, now),
        note: [unknownStop ? 'A stop request may be pending. Faravan could not check.' : '', role==='ran' ? '' : who ? 'Progress reported by ' + computer + '.' : ''].filter(Boolean).join(' '),
        canStop: !unknownStop && !savedStop, stopLabel: 'Stop this job'});
      break;
    }
    case 'stop_requested': Object.assign(out, jobProjectionFor(job).evidence.localStopRequested === true ? {
      // This computer stopped the job it runs (judge r9 O-E): the same state Lending and Home show, with no fresh Stop.
      headline: 'Stopping ' + (ownRequest ? 'your job' : requester ? requester + '’s job' : 'this job'),
      text: 'Waiting for the sandbox on your computer to confirm it stopped.'} : {headline: ownRun && !ownRequest ? (requester || 'The sender') + ' asked to stop this job' : sharedHolderStop ? 'Stop requested for ' + (ownRequest ? 'your job' : requester ? requester + '’s job' : 'this job') : (ownRequest ? 'You asked ' : (requester || 'The sender') + ' asked ') + computer + ' to stop',
      text: (ownRun ? 'Your computer hasn’t confirmed yet.' : 'It hasn’t confirmed yet.') + ' Until it does, the agent may still be working. We’ll show “Stopped” when it confirms.'}); break;
    case 'stop_unconfirmed': Object.assign(out, {headline: 'Faravan couldn’t confirm the job stopped',
      text: 'The agent may still be working.' + (clock(job.runTiming?.hardStopAt, zone) ? ' Its configured stop time is ' + clock(job.runTiming.hardStopAt, zone) + ', but Faravan has not confirmed that it stopped.' : ' The job’s hard stop time wasn’t recorded.'), note: 'Copy the details if you need help checking the running computer.'}); break;
    case 'stopped': { const ranMinutes = minutesSince(startedAt, time(evidence.stoppedAt)); Object.assign(out, {headline: ranMinutes !== null && ranMinutes > 0 ? 'Stopped after ' + ranMinutes + (ranMinutes === 1 ? ' minute' : ' minutes') : 'Stopped',
      text: capital(computer) + ' confirmed that the sandbox stopped. The agent’s changes up to the stop weren’t kept. ' + capital(computer) + ' may still hold a copy of ' + (role === 'sent' ? 'your code' : 'the code') + ' until it cleans up.'}); break; }
    case 'cancelled': Object.assign(out, {headline: role === 'sent' ? 'You cancelled this job before it started' : 'This job was cancelled before it started', text: 'Nothing ran.'}); break;
    case 'failed': {
      const reason = {code:projection.reasonCode, phase:evidence.failurePhase};
      const knownFailure = ['requirements_unsupported','policy_unenforceable','expired','stopped_by_lender','agent_signed_out','sandbox_not_ready','readiness_changed','sandbox_start_failed','sandbox_ready_timeout','entrypoint_start_failed',...RESULT_DELIVERY_FAILURE_CODES,...LENDER_INTERRUPTION_CODES,...executionFailureCodes].includes(reason?.code);
      // The coordinator fails a job that no run was ever spent on only when its bounded start failures are used up, whatever code
      // the last one carried. Several computers may have tried, so no one is named: nothing ran, not a wait that will not end.
      const neverStarted = evidence.rawState === 'failed' && job.attempts_started === 0 && evidence.executionStartedAt == null && !['run', 'result'].includes(reason.phase);
      const failure = neverStarted ? {headline:ownRun ? 'Your computer couldn’t start this job' : 'This job couldn’t start', reason:'It tried several times and gave up. Nothing ran.'} : knownFailure ? failureVM(reason.code, reason.phase, {role:role === 'ran' ? 'lender' : 'borrower',lender:who,borrower:requester,agent:kit,minutes:job.safety?.budget_minutes}) : null;
      const sourceKind = job.local?.sourceKind ?? job.source?.kind ?? job.job?.payload?.source?.kind;
      const hasProject = sourceKind !== 'none' && (['git','folder','archive','files'].includes(sourceKind) || Boolean(job.local?.sourcePath));
      const fallback = role === 'sent' && hasProject ? 'Nothing was added to your code.'
        : 'No completed result came back. Check the transcript and Failure details for any recorded cause before deciding whether to send again.';
      Object.assign(out, {headline:failure?.headline || 'The job didn’t finish',text:failure?.reason || fallback,recovery:reason?.code === 'wall_timeout' ? 'followup' : 'resend'}); break;
    }
    case 'expired': {
      const span = Math.round((time(job.waitingTiming?.expiresAt) - time(job.waitingTiming?.submittedAt)) / 3600000), at = clock(job.waitingTiming?.expiresAt, zone);
      // M12: "Nobody took it within 24 hours. No agent started on it." (a claimed job that lost its lender says less).
      const claimed = evidence.attemptPresent === true;
      Object.assign(out, {headline: claimed ? 'The job expired before a result came back' : Number.isFinite(span) && span > 0 ? 'Nobody took it within ' + span + (span === 1 ? ' hour' : ' hours') : 'Nobody took it in time',
        text: (claimed ? 'It expired before a result came back.' : 'No agent started on it.') + (at ? ' It expired at ' + at + '.' : '')});
      break;
    }
    case 'no_changes':
    case 'ready':
    case 'added_branch':
      // A graceful lender stop returns the work done so far as an ordinary result; say so instead of a plain "ready".
      if (typeof evidence.sharedStopRequestedAt === 'string') Object.assign(out, {stoppedEarly: true, text: (ownRun ? 'You stopped this job early.' :
        (lender || 'The person lending') + ' stopped this job early.') + ' This is the work done until then.'});
      if (out.stoppedEarly) {
        const returnedOutputs = ['message','files'].includes(job.format ?? job.output?.kind ?? job.resultSummary?.output?.kind);
        const noChanges = key === 'no_changes' || !returnedOutputs && resultChangeCount(job) === 0;
        out.pill.word = stoppedResultWord(noChanges ? 'no_changes' : key, role);
        out.headline = out.pill.word;
      }
      break;
    default: Object.assign(out, {headline: 'We can’t tell what happened to this job', text: 'The current status couldn’t be read. Refresh the page to check it again.'});
  }
  if(projection.observation&&projection.actionHints.length===0)out.canStop=false;
  return out;
}

/**
 * U17: "How it ran" from the job's own receipt (`job.receipt`: duration_ms, egress_evidence, egress_applied, harness,
 * harness_version, model, backend). Nothing here reads a field the receipt does not have: the checks, the preflight
 * line and the cleanup line appear only when the API supplies them. The two MVP lines of M11 come first.
 */
export function runDurationVM(ms) {
  if (!finite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return {short:minutes ? minutes + ' min' + (rest ? ' ' + rest + ' s' : '') : seconds + ' s',
    long:minutes ? minutes + (minutes === 1 ? ' minute' : ' minutes') + (rest ? ' ' + rest + (rest === 1 ? ' second' : ' seconds') : '') : seconds + (seconds === 1 ? ' second' : ' seconds')};
}
// "Cheapest that fits" / "Strongest offered": what was asked for, what the lender passed to the agent and what the provider
// reported are three separate facts. The effort passed to the agent is never shown as an effort the provider served.
const AUTO_ASKED = {cheapest: 'Cheapest that fits', strongest: 'Strongest offered'};
// "Asked for" is the person's own choice and comes from the job. "Requested for this run" comes only from the choice the lender saved
// (the receipt's auto_run_v1); until then it says so. "Provider reported" comes only from the provider's own evidence.
function autoRunLines(job, receipt) {
  const auto = receipt?.auto_run_v1 && typeof receipt.auto_run_v1 === 'object' ? receipt.auto_run_v1 : null;
  const intent = [job.requestedAutoRun, auto?.intent].find(value => Object.hasOwn(AUTO_ASKED, value));
  if (!intent) return [];
  const saved = auto && auto.intent === intent && clean(auto.model) && clean(auto.effort) ? auto : null;
  const reported = clean(receipt?.model);
  return [
    {tone: 'info', icon: 'cpu', text: 'Asked for: ' + AUTO_ASKED[intent], by: 'your request'},
    {tone: 'info', icon: 'cpu', text: saved ? 'Requested for this run: `' + saved.model + '` / ' + saved.effort + ' effort' + (saved.capped === true ? ' (held to the lender’s effort limit)' : '') : 'Requested for this run: not chosen yet',
      by: saved ? 'chosen by the lender' : 'the lender'},
    {tone: 'info', icon: 'cpu', text: !receipt ? 'Provider reported: nothing yet' : reported ? 'Provider reported: `' + reported + '`' : 'Provider reported: model not reported', by: 'the provider'},
    {tone: 'info', icon: 'cpu', text: 'Provider effort: not reported', by: 'the provider'},
  ];
}
export function howItRanVM(job = {}, {lender = '', device = '', agent = '', role = 'sent', compact = false} = {}) {
  const receipt = job.receipt && typeof job.receipt === 'object' ? job.receipt : null;
  const checkSource = Array.isArray(job.checks) ? job : Array.isArray(job.result?.checks) ? job.result : Array.isArray(receipt?.checks) ? receipt : null;
  const checks = checkSource?.checks ?? null;
  const checkLines = receiptLines({receipt: {checks: (checks ?? []).map(c => ({...c,
    check_context:c?.check_context ?? checkSource.check_context}))}})
    .filter(line => line.icon === 'terminal');
  if (!receipt) return {lines: [...(agent && agent !== 'Any agent' ? [{tone: 'info', icon: 'cpu', text: agent, by: 'requested agent'}] : []), ...autoRunLines(job, null)], checks: checkLines, checksEmpty: checks?.length === 0, usage: '', note: '', missing: role === 'ran' ? RECEIPT_COPY.missingRun : ''};
  const known = PROVIDERS[receipt.harness] ?? {}, safety = job.safety && typeof job.safety === 'object' ? job.safety : {};
  const hosts = [safety.provider_hosts, receipt.provider_hosts].find(Array.isArray) ?? known.hosts ?? [];
  const provider = clean(receipt.provider) || PROVIDER_NAMES[safety.provider] || known.provider || '';
  const duration = runDurationVM(receipt.duration_ms), minutes = duration ? receipt.duration_ms / 60000 : null;
  const rules = receipt.egress_applied === 'internet' ? ['public websites'] : receipt.egress_applied === 'provider-only' ? [provider || 'the agent’s model service'] : [];
  const who = {name: lender, deviceName: device}, selfRun=job.ranHere && role!=='ran';
  const lines = receiptLines({viewer: role === 'ran' || selfRun ? 'lender' : 'borrower', lender: who, adapter: {provider, providerHosts: hosts},
    receipt: {minutes, durationText:duration?.short, egressEvidence: receipt.egress_evidence, allowedByRules: rules, preflight: receipt.preflight === true ? true : receipt.preflight === false ? false : undefined,
      checks: [], cleanupVerified: receipt.cleanup_verified === true}});
  const run = runFacts({viewer:selfRun?'own':role==='ran'?'lender':'borrower',lender: who, run: {agent: agent || agentLabel(receipt.harness), version: receipt.harness_version === 'unknown' ? null : receipt.harness_version, model: receipt.model,
    effort: receipt.effort, backend: ['docker-sandboxes','docker-sbx'].includes(receipt.backend) ? 'Docker Sandboxes' : receipt.backend, backendVersion: receipt.backend_version, minutes, durationText:duration?.long}});
  const observed = lines.some(l => l.by === 'Docker Sandboxes network log');
  const autoLines = autoRunLines(job, receipt);
  // The job count is the lender's; the receipt does not say, so only the run lines speak of time.
  const missing = role === 'ran' && typeof receipt.cleanup_verified !== 'boolean' ? RECEIPT_COPY.missingCleanup : '';
  if (compact) {
    const unknown = [
      ...(!duration ? [run[1],lines[0]] : []),
      ...(!observed ? lines.filter(line=>line.icon==='globe') : []),
      ...(missing ? [{text:missing,tone:'info',icon:'trash',by:''}] : []),
    ];
    const knownLines=[...run.filter((_,index)=>duration||index===0),...autoLines,
      ...lines.filter((line,index)=>index!==0&&(observed||line.icon!=='globe')&&!(line.icon==='trash'&&receipt.cleanup_verified!==true))];
    if (!observed && rules.length) knownLines.push({tone:'info',icon:'globe',text:'The rules allowed: '+rules.join(', ')+'.',by:'from the job’s rules'});
    return {lines:knownLines,details:unknown,checks:checkLines,checksEmpty:checks?.length===0,usage:'',note:'',
      missing:unknown.length?"Some run details weren't recorded.":''};
  }
  return {lines: [...run, ...autoLines, ...lines], checks: checkLines, checksEmpty: checks?.length === 0, usage: '', missing,
    note: observed ? 'Each line says who observed it. Sites come from the Docker Sandboxes network log for this sandbox, read on ' + (selfRun ? 'this' : lender ? lender + '’s' : 'the lender’s') + ' computer after the agent stopped. It lists sites (up to 32), not what was sent.' : ''};
}

/**
 * U5: what a request can do on this computer, from the approval card the app holds (`GET /api/approvals`).
 * `card.safety` (S5.1) carries the exact inputs: network {mode, registries}, provider, credential_in_guest,
 * credential_proxy_verified, boundary_verified, budget_minutes, quota.remaining (percent); each is null when unknown.
 * A card without `safety` (an older app) is read from its own fields.
 */
export function requestFactsVM(card = {}, {device = '', own = false} = {}) {
  const safety = card.safety && typeof card.safety === 'object' ? card.safety : null, requirements = card.job?.requirements ?? {};
  const known = PROVIDERS[card.harness] ?? {}, name = agentLabel(card.harness);
  const provider = (safety && PROVIDER_NAMES[safety.provider]) || known.provider || null;
  const legacy = requirements.network ?? (['internet', 'provider-only'].includes(card.network) ? card.network : null);
  const job = safety ? {network: networkOf(safety.network?.mode, safety.network?.registries), maxMinutes: safety.budget_minutes}
    : {network: networkOf(legacy, requirements.registries), maxMinutes: finite(card.runtimeSeconds) ? Math.ceil(card.runtimeSeconds / 60) : null};
  const adapter = {name, provider, providerHosts: [safety?.provider_hosts, known.hosts].find(Array.isArray) ?? [],
    credentialInGuest: safety ? safety.credential_in_guest : typeof card.credentialInGuest === 'boolean' ? card.credentialInGuest : null,
    credentialProxyVerified: safety ? safety.credential_proxy_verified : null};
  const remaining = finite(safety?.quota?.remaining) ? safety.quota.remaining / 100 : null;
  const {facts} = safetyFacts({job, adapter, boundaryVerified: safety?.boundary_verified === true, quota: safety ? {remaining, checkedAt: safety.quota?.checkedAt ?? safety.quota?.checked_at, source:safety.quota?.source} : null, lender: {deviceName: clean(device) || null}});
  // The request names the lending computer without assuming which device displays the page.
  const here = text => text.replaceAll('this computer', 'your computer');
  const forOwn = text => own ? text.replace(/ (?:Say yes only to people you trust|Ask the sender before you say yes)\.$/, '') : text;
  return {heading: own || !clean(device) ? 'What it can do on your computer' : 'What this job can do on your ' + clean(device), agent: name,
    facts: facts.map(f => ({...f, text: forOwn(here(f.text))}))};
}

/**
 * U5 (EXPERIENCE M8, claim-then-ask): the sentences around the two buttons. A lender's computer claims the job and
 * asks; the code is fetched only after "Run it". `expiresAt` is the app's own approval deadline.
 */
export function requestTimingVM(card = {}, {now = Date.now(), zone = computerZone(), circle = ''} = {}) {
  const at = time(card.expiresAt), known = Number.isFinite(at), expired = known && now >= at;
  const circleName = clean(circle, 'the circle'), name = clean(card.localName) || clean(card.identity?.personName ?? card.personName) || clean(card.requesterName, 'A circle member');
  return {known, expired,
    answerBy: !known ? 'We can’t tell when this request goes back. Refresh this review.' : expired ? '' : 'Answer by ' + clock(at, zone) + '. If you don’t, it goes back for someone else.',
    back: 'Back for others · ' + name + '’s job goes back to ' + circleName + '. You won’t be asked about it again.',
    asked: name + ' asked all of ' + circleName + '. Not now keeps this request pending until its deadline. Decline removes it from this computer; other lenders can still run it.'};
}
/** "Started on MacBook · stops by 3:01 PM": the hard limit is the start plus the job's own limit. */
export function startedLineVM({device = '', startedAt = Date.now(), runtimeSeconds = null, zone = computerZone()} = {}) {
  const stops = finite(runtimeSeconds) ? clock(startedAt + runtimeSeconds * 1000, zone) : '';
  return 'Started on ' + (clean(device) || 'your computer') + (stops ? ' · stops by ' + stops : '') + '.';
}

/** M7 "After Send" (job.waiting-approval): never a finish time before the job starts. */
export function waitingCopyVM(job = {}, {circle = '', zone = computerZone(), lender = '', devices, now = Date.now()} = {}) {
  const {projection, preparing, sharedWaitingSummary, sharedLeadIn, waitingHeadline, previousReason, previousAttemptHolder, hold} = formatJobProjection(job);
  // An own job the app holds says why and what clears it; no queue wording applies while it is held.
  if (hold) return {headline:'On hold', text:hold.reason+' '+hold.action, previousDecision:''};
  if (preparing) return {headline:waitingHeadline, text:'', previousDecision:''};
  if (projection.phase==='waiting'&&clean(job.waitingHome)) return {headline:'Waiting for '+clean(job.waitingHome),
    text:'This job waits for that computer. Choose Stop, then send again to choose a computer afresh.',previousDecision:''};
  const nobodyCanTake = sharedLeadIn === 'Nobody can take it right now';
  const sent = clock(job.waitingTiming?.submittedAt ?? job.local?.submittedAt, zone), at = time(job.waitingTiming?.expiresAt);
  const day = Number.isFinite(at) ? formatDate(at, 'weekday', {zone}) + ' ' + clock(at, zone) : '';
  const where = clean(circle, 'the circle');
  const denied = projection.phase === 'waiting' && ['approval_denied', 'approval_skipped'].some(code => projection.reasonCode === code || previousReason === code);
  const decisionMaker = clean(lender) || clean(job.lenderName) || rosterMemberName(job, previousAttemptHolder, devices) || 'A lender';
  const previousDecision = denied ? decisionMaker + ' declined this request. It went back to the circle; another computer can pick it up.' :
    projection.phase === 'waiting' && job.declined_count > 0 ? 'A lender declined this request. Another computer can still pick it up.' :
    projection.phase === 'waiting' && ['preparation_failed','sandbox_failed','sandbox_start_failed','agent_signed_out','sandbox_not_ready'].includes(previousReason)
      ? decisionMaker + ' couldn’t start it; it’s open again.' : '';
  if(job.offerWaiting) {
    const {readyCount,deciding,dailyLimitCount,dailyLimitDevices,dailyLimitNames}=job.offerWaiting;
    const availability=Number.isSafeInteger(readyCount)?readyCount+' lending '+(readyCount===1?'device is':'devices are')+' ready. ':'';
    if (!deciding && readyCount === 0 && Number.isSafeInteger(dailyLimitCount) && dailyLimitCount > 0) {
      const name=dailyLimitCount===1 ? clean(dailyLimitNames?.[0]) || (Array.isArray(dailyLimitDevices) ? rosterMemberName(job,dailyLimitDevices[0],devices) : '') : '';
    return {headline:dailyLimitCount===1 ? (name ? name+'’s computer' : 'A lending computer')+' has reached its limit for today' : dailyLimitCount+' lending computers have reached their limits for today',
        text:[sharedWaitingSummary,'This job waits until a computer has time to lend.'+(day?' Open until '+day+'.':'')].filter(Boolean).join(' '),previousDecision};
    }
    const headline=deciding?(rosterMemberName(job,deciding,devices)||'A lender')+' is deciding (older app)':nobodyCanTake?sharedLeadIn:'Waiting for someone to run it';
    const repeatsHeadline=readyCount===null && job.job?.payload?.runRequest &&
      (sharedWaitingSummary===headline || sharedWaitingSummary===headline+'.');
    return {headline,text:[repeatsHeadline?'':sharedWaitingSummary || availability,day ? 'Open until '+day+'.' : ''].filter(Boolean).join(' '),previousDecision};
  }
  return {headline: projection.phase === 'waiting' ? nobodyCanTake ? sharedLeadIn : waitingHeadline || 'Waiting for a computer' : 'Job status is unavailable',
    timing:jobTimingLine({now, queuedAt:job.waitingTiming?.submittedAt ?? job.local?.submittedAt, zone}),
    text: [sharedWaitingSummary,'Sent to ' + where + (sent ? ' at ' + sent : '') + '. A lender’s computer takes it when it is free and has time left today.' + (day ? ' Expires ' + day + ' if nobody takes it.' : '')].filter(Boolean).join(' '),
    previousDecision};
}

/**
 * First-run Home (a computer with no circle): "ready" only when every step lending needs is done, never because nothing
 * has been checked, and no promise that a circle turns lending on (it only creates the circle; lending is its own switch).
 */
export function firstRunVM(blockers, device = 'This computer') {
  // Choosing which agents to lend happens when lending is turned on, so "no agent chosen" is not a fault before a circle exists.
  const chooses = i => i.key === 'agent' && !i.agent;
  const name = clean(device, 'This computer'), steps = (blockers?.items ?? []).filter(i => !['lending', 'circle'].includes(i.key) && i.status !== 'off' && !chooses(i));
  const fault = blockers?.first && !['lending', 'circle'].includes(blockers.first.key) && !chooses(blockers.first);
  const invite = 'Borrow idle coding agents from people you trust. Start a circle and invite the people you want to help.';
  if (fault) return {state: 'blocked', headline: name + ' isn’t ready to lend yet', text: invite + ' Lending can’t start until the step on the right is done.'};
  if (!steps.length || steps.some(i => i.status !== 'ok')) return {state: 'checking', headline: 'Checking ' + name + '…', text: invite};
  return {state: 'ready', headline: name + ' is ready to lend', text: invite + ' Then turn on lending.'};
}

/**
 * Lending shows only the two MVP agents, in a stable order. Other installed adapters remain available to the backend,
 * but exposing unfinished integrations here makes the first-run choice look larger and less reliable than it is.
 */
export function agentSectionsVM(agents = []) {
  const list = Array.isArray(agents) ? agents : [];
  const shown = ['claude-code-subscription', 'codex'].map(id => list.find(agent => canonicalAgentId(agent) === id)).filter(Boolean).map(lendingAgentVM);
  const stoppedNote = shown.some(agent => agentCheckVM(agent).stopped) ? automaticChecksStoppedLine('Check agents again') : undefined;
  return {shown, other: [], stoppedNote};
}
/**
 * What a "Check again" found, one definite sentence for each MVP agent that was checked. It reads each agent through
 * the same row model as the page (judge r8 O11): an agent waiting for a computer-wide step (Docker Sandboxes, the
 * isolation check) is "waiting", never "ready", because the check does not change that step. `byAgent` is the page's
 * blocker model; only its waiting entries carry over, the refreshed agent supplies the rest.
 */
export function agentsCheckedVM(agents = [], byAgent = {}) {
  const list = agentSectionsVM(agents).shown;
  if (!list.length) return 'Checked. No agents were found on this computer.';
  const result = list.map(agent => {
    const reading = byAgent?.[agent.id] ?? byAgent?.[canonicalAgentId(agent)];
    const waits = reading?.status === 'waits' ? reading : null;
    const row = agentRowVM(agent, waits), name = row.name;
    if (agent.installed === false) return name + ' is not installed.';
    if (row.state === 'waiting') return name + ' is ' + row.word[0].toLowerCase() + row.word.slice(1) + '.';
    if (row.state === 'ready' || row.state === 'off' && agentCheckVM(agent).ready) return name + ' is ready.';
    if (row.state === 'signin') return name + ' needs you.';
    return name + ' couldn’t be checked.';
  });
  return 'Checked. ' + result.join(' ');
}
/** A sentence of an agent's own failure remedy with no command in it ("Run faravan doctor" is never shown). */
export const plainRemedy = text => String(text ?? '').split(/(?<=[.!?])\s+/).filter(sentence => sentence && !/\x60|\b(?:sudo|sbx|faravan|faravan|docker|brew|npm|git)\s+[a-z-]+/.test(sentence)).join(' ').trim();

/**
 * U22: Add as a branch (EXPERIENCE M10). The preview is what the app's dry run says it would write; the sheet shows it
 * all before anything is written. Refusals are the `job.apply-*` states, one to one, each with its own words and next step.
 */
const base7 = sha => clean(sha).slice(0, 7), repoName = path => clean(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || clean(path);
/** Unified diff rows keep both line numbers; metadata is available separately. */
export function jobDiffVM(data = {}) {
  const files = [], details = [];
  let file, oldLine = 0, newLine = 0, binary = false;
  const all = String(data.diff ?? '').split('\n');
  if (all.at(-1) === '') all.pop();
  for (const text of all.slice(0, 4000)) {
    if (text.startsWith('diff --git ')) {
      file = {path: data.files?.[files.length]?.path || text.replace(/^diff --git a\/.* b\//, ''), rows: []};
      files.push(file); details.push(text); binary = false; continue;
    }
    if (text === 'GIT binary patch' || text.startsWith('Binary files ')) { binary = true; continue; }
    if (binary) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename )/.test(text)) { details.push(text); continue; }
    if (!file) { file = {path: data.files?.[0]?.path || 'Changes', rows: []}; files.push(file); }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); file.rows.push({kind: 'meta', text, old: '', next: ''}); continue; }
    const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : text.startsWith('\\') ? 'meta' : 'ctx';
    file.rows.push({kind, text, old: ['add', 'meta'].includes(kind) ? '' : oldLine++, next: ['del', 'meta'].includes(kind) ? '' : newLine++});
  }
  for (const listed of data.files ?? []) if (!files.some(f => f.path === listed.path)) files.push({path:listed.path,rows:[]});
  return {files: files.map(f => ({...f, preview:data.files?.find(x => x.path === f.path)?.preview, binary:data.files?.find(x => x.path === f.path)?.binary, status:data.files?.find(x => x.path === f.path)?.status, plus: data.files?.find(x => x.path === f.path)?.insertions ?? f.rows.filter(r => r.kind === 'add').length,
    minus: data.files?.find(x => x.path === f.path)?.deletions ?? f.rows.filter(r => r.kind === 'del').length})), details: details.join('\n'), truncated: data.truncated || all.length > 4000};
}

/** Faravan's signed job metadata is separate from agent messages. */
export function jobContextVM(transcript = '') {
  for (const line of String(transcript).split('\n').reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'faravan.job_context' && Number.isSafeInteger(event.job_framing_version) && typeof event.workspace_path === 'string') return event;
    } catch {}
  }
  return {};
}

/** A final message can explain why a run returned no files. Paths stay plain text. */
export function jobOutputWarningVM(summary = '', workspace = '') {
  const normalize = path => {
    const parts = [];
    for (const part of path.split('/')) {
      if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    }
    return '/' + parts.join('/');
  };
  const root = workspace ? normalize(workspace) : '';
  const paths = [];
  const matches = String(summary).matchAll(new RegExp("`((?:~/|/)[^`\\n]+)`|(?<![\\w:/])((?:~/|/)[^\\s`<>'\"()\\[\\]{}]+)", 'g'));
  for (const match of matches) {
    const path = (match[1] || match[2]).replace(/[.,;:!?]+$/, '');
    const normalized = normalize(path);
    const outside = path.startsWith('~/') || (root ? normalized !== root && !normalized.startsWith(root + '/') : /^\/(?:tmp|home|root)\//.test(path));
    const context = String(summary).slice(Math.max(0, match.index - 180), match.index);
    const saveCue = /\b(?:sav(?:ed|ing)|wrote|written|creat(?:ed|ing)|render(?:ed)?|output|generated|exported|stored)\b/i.test(context);
    const filePath = /\.[a-z0-9]{1,10}$/i.test(path) || /^(?:~\/|\/tmp\/)/.test(path);
    const referenceOnly = /\b(?:removed|deleted|references?|read|opened|inspected)\b/i.test(context) && !saveCue;
    const saved = !referenceOnly && (saveCue || filePath);
    if (outside && saved && !paths.includes(path)) paths.push(path);
    if (paths.length === 5) break;
  }
  return paths.length ? "The agent saved files outside the project, which don't come back: " + paths.join(', ') : '';
}

/** Expand the saved automatic preview on the detail page; preserve edited titles. */
export function jobHeadingVM(job = {}, title = '') {
  const line = requestLine(job.local?.prompt ?? job.prompt ?? '');
  const chars = [...line];
  const preview = chars.length > 80 ? chars.slice(0,79).join('') + '…' : line;
  return line && title === preview ? line : title;
}
export function jobDetailVM(job = {}, {role = 'sent', agent = '', recipient = '', zone = computerZone()} = {}) {
  const key = jobStateKey(job), ready = ['ready', 'added_branch', 'no_changes'].includes(key), receipt = job.receipt ?? {};
  const own = role === 'sent', duration = runDurationVM(receipt.duration_ms);
  return {ready, terminal: ['ready', 'added_branch', 'no_changes', 'failed', 'cancelled', 'expired', 'stopped'].includes(key),
    result: own && ready, receipt: role === 'ran' && ready,
    receiptTitle: 'You ran ' + (clean(recipient) ? clean(recipient) + '’s job' : 'this job'),
    receiptContext: ['Result sent back' + (clock(receipt.finished_at ?? job.endedAt, zone) ? ' at ' + clock(receipt.finished_at ?? job.endedAt, zone) : ''), duration ? duration.short + ' of ' + (receipt.harness ? agentLabel(receipt.harness) : agent && agent !== 'Any agent' ? agent : 'agent time') : ''].filter(Boolean).join(' · '),
    sourceFolder: clean(job.local?.sourcePath) || (/^(\/|~\/|[A-Za-z]:[\\/])/.test(job.local?.source ?? '') ? job.local.source.replace(/ \(folder.*\)$/, '') : ''),
    canReadTranscript: ready || key === 'working' || own && key === 'failed', canResend: own && ['failed', 'cancelled', 'expired', 'stopped'].includes(key)};
}
export function jobRetentionVM({data, error} = {}, zone = computerZone()) {
  if (error) return 'The deletion date couldn’t be loaded. Copy details if you need help checking the host.';
  if (!data) return 'Loading the deletion date…';
  const at = time(data.retained_until);
  if (!Number.isFinite(at)) return 'The host hasn’t reported a deletion date for this job.';
  return 'The request, code and result are kept on the host until ' + formatDate(at, 'longDate', {zone}) + '.';
}
export function createdJobVM(seed, id, circle) {
  if (!seed || seed.job_digest !== id || seed.circle?.id !== circle) return null;
  return {...seed, state:'queued', local:seed.submittedByMe ? {title:seed.title,prompt:seed.prompt,submittedAt:seed.submittedAt} : undefined};
}
export function jobRoleVM(job, device) {
  // Borrower ownership is independent of the asynchronously loaded fingerprint.
  if (job.local || job.borrowerCircle) return 'sent';
  return device && job.current_attempt?.holder === device ? 'ran' : 'viewer';
}

/** Only a final agent message is a summary; tool output and check output never become one. */
export function agentSummaryVM(transcript = '') {
  let summary = '';
  for (const line of String(transcript).split('\n')) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'item.completed' && entry.item?.type === 'agent_message' && typeof entry.item.text === 'string') summary = entry.item.text;
    if (entry.type === 'result' && typeof entry.result === 'string') summary = entry.result;
  }
  return summary.trim().slice(0, 4000);
}

const applyBranchName = value => clean(value).replace(/^refs\/heads\//, '');
export function applyPreviewVM(summary = {}, {lender = '', digest = '', sourceBranch = ''} = {}) {
  const files = Array.isArray(summary.files_changed) ? summary.files_changed : [], n = finite(summary.files) ? summary.files : files.length;
  const current = applyBranchName(summary.current_branch), source = applyBranchName(sourceBranch);
  return {
    adds: [{text: 'Adds the branch '}, {text: applyBranchName(summary.branch), strong: true}, {text: ' to '}, {text: repoName(summary.repo), strong: true}, {text: '.'}],
    starts: 'It starts from the version' + (source ? ' of ' + source : '') + ' you sent. ' + (current ? 'Your current branch (' + current + ')' : 'Your current files') + ' and your local changes are not touched.',
    count: n + (n === 1 ? ' file changes:' : ' files change:'),
    files: files.map(f => ({path: clean(f.path), plus: finite(f.insertions) && f.insertions > 0 ? '+' + f.insertions : '', minus: finite(f.deletions) && f.deletions > 0 ? '−' + f.deletions : ''})),
    commit: 'The result' + (clean(lender) ? ' from ' + clean(lender) : '') + ' will be saved on the new branch.',
  };
}
export function applyCommandVM({digest = '', branch = ''} = {}) {
  // The CLI resolves this locally submitted job's unique prefix across circles.
  return 'faravan apply ' + String(digest).replace(/^sha256:/, '').slice(0,12) + (branch ? ' --branch ' + shellQuote(branch) : '');
}
export function applyRefusalVM(refusal = {}, context = {}) {
  return applyProblemView(refusal, context.surface?context:browserProblemContext());
}
export function defaultApplyBranchVM(digest) { return 'faravan/' + String(digest).replace(/^sha256:/, '').slice(0,12); }
export function showBranchCommandVM(repo, branch) { return 'git -C ' + shellQuote(repo || '.') + ' show --stat ' + shellQuote(branch || 'HEAD'); }
export const appliedLineVM = applied => ({heading: 'Added as branch ' + applyBranchName(applied?.branch), repo: repoName(applied?.repo), switch: 'git switch ' + shellQuote(clean(applied?.branch))});

/* ---- U7m the MVP composer (EXPERIENCE M7; compose.local, compose.not-git, compose.host-offline, compose.send-uncertain) ---- */
const hourMinute = (ms, zone) => formatDate(ms, 'clock', {zone});
/** "Thursday 15 October, 6:10 PM": a date and time spelled the way EXPERIENCE M5.4 does. */
export function dateTimeWords(value, zone) {
  const at = time(value);
  if (!Number.isFinite(at)) return '';
  const parts = dateParts(at, 'weekdayDayMonth', {zone});
  return parts.weekday + ' ' + parts.day + ' ' + parts.month + ', ' + hourMinute(at, zone);
}
/** "today at 6:10 PM", "yesterday at 6:10 PM", or "on Thursday 15 October at 6:10 PM": for a sentence that says when something last happened. */
export function whenWords(value, now = Date.now(), zone) {
  const at = time(value);
  if (!Number.isFinite(at)) return '';
  const day = dayKey(at, zone);
  if (day === dayKey(now, zone)) return 'today at ' + hourMinute(at, zone);
  if (day === dayKey(now - 86400000, zone)) return 'yesterday at ' + hourMinute(at, zone);
  return 'on ' + dateTimeWords(at, zone).replace(', ', ' at ');
}
const fileCount = n => n + (n === 1 ? ' file' : ' files');
/** The project card: where it is, what would be sent, and the choice about uncommitted changes. */
export function projectVM(info, {include = false} = {}) {
  const head = clean(info?.head).slice(0, 6), count = Number.isFinite(info?.changed_count) ? info.changed_count : (info?.changed ?? []).length;
  const omitted = info?.sourceOmissions?.[include ? 'workingTree' : 'head'];
  const excluded = new Set((omitted ?? []).map(file => file.path));
  const listed = (info?.changed ?? []).filter(f => !excluded.has(f.path)).map(f => clean(f.path)).filter(Boolean);
  const sentChanges = Number.isInteger(info?.sendableChangedCount) ? info.sendableChangedCount : count - (info?.changed ?? []).filter(f => excluded.has(f.path)).length;
  const credentials = (omitted ?? []).filter(file => file.reason === 'credentials');
  return {
    notSent: Array.isArray(omitted) ? {
      summary: omitted.length ? fileCount(omitted.length) + ' not sent' : '0 files not sent by filename rules',
      credentialNote: credentials.length ? credentials.length + (credentials.length === 1 ? ' looks' : ' look') + ' like credentials' : '',
      files: [...credentials, ...omitted.filter(file => file.reason !== 'credentials')],
    } : null,
    title: clean(info?.path), name: clean(info?.name),
    meta: info?.kind==='folder' ? [clean(info.name),fileCount(Number(info.files)||0),'Folder snapshot'].join(' · ') : [clean(info?.name), (clean(info?.branch) ? clean(info.branch) + ' @ ' + head : 'a detached commit @ ' + head), fileCount(Number(info?.files) || 0)].join(' · '),
    note: info?.kind==='folder' ? 'Files are copied into a new workspace. Results never overwrite this folder.' : count ? (include ? sentChanges ? 'Your uncommitted changes will be sent (' + fileCount(sentChanges) + '). ' + fileCount(Math.max(0, count - sentChanges)) + ' excluded by the current file rules.' : 'None of your changed files will be sent under the current file rules.' : 'Uncommitted changes are not sent.') : 'Nothing is uncommitted.',
    checkbox: count ? 'Also send my uncommitted changes' : '',
    sending: include && sentChanges ? 'Also sending ' + fileCount(sentChanges) + ': ' + listed.slice(0, 8).join(', ') + (sentChanges > 8 ? ', and ' + (sentChanges - 8) + ' more' : '') + '.' : '',
  };
}
export const COMPOSE_REPO_STATES = Object.keys(LEGACY_COMPOSE_PROBLEMS);
const unnamed = 'another member’s computer';
const hostLabelOf = host => clean(host?.label, 'the host’s computer');
const sentenceCase = text => text[0].toUpperCase() + text.slice(1);
/** Said while the composer's default moved off the last circle used because its host does not answer (composeCircle). */
export function skippedCircleNotice(skipped, chosen, {now = Date.now(), zone} = {}) {
  if (!skipped || !chosen || skipped.id === chosen.id) return '';
  const name = clean(skipped.name, 'Your last circle'), last = whenWords(skipped.host?.lastReachedAt, now, zone);
  return name + ' isn’t answering' + (last ? ' (last seen ' + last + ')' : '') + ', so this request goes to ' + clean(chosen.name, 'another circle') +
    '. To send to ' + name + ' anyway, choose it under Circle.';
}
/** A circle choice in the composer says when its host is known not to answer. */
export const composeCircleLabel = circle => clean(circle?.name, 'Unnamed circle') + (circle?.host?.reachable === false && circle?.sendReachable !== true ? ' · offline' : '');
/** The circle is unreachable: who hosts it, when it was last reached, and that a draft can still be written. */
export function hostOfflineBanner(state = {}, circleName, {now = Date.now(), zone} = {}) {
  const host = state.host ?? {}, last = whenWords(host.lastReachedAt, now, zone)?.replace(/^on /, ''), circle = sentenceCase(circlePhrase(clean(circleName ?? state.name, '')));
  if (state.hosted === true) return {tone:'wait',icon:'cloud-off',headline:circle + ' isn’t answering',
    text:'Its circle server on this computer isn’t answering. Start it again from Circles → Host a circle on this computer.',
    href:'#/circles/host', linkLabel:'Host a circle'};
  return {tone: 'wait', icon: 'cloud-off', headline: circle + ' is unreachable',
    text: (last ? 'Can’t reach ' + hostLabelOf(host) + ' since ' + last : sentenceCase(hostLabelOf(host)) + ' hosts it and can’t be reached right now') + '. You can write a job now and send it when the circle is back.'};
}
/**
 * What a member sees about a circle whose host does not answer (H3, EXPERIENCE M5.3-M5.4). The roster the host signs lasts
 * 7 days: from the 4th day offline there is a dated warning, and once it runs out the membership waits for the host.
 * Returns [] for a circle this computer hosts, one with no server, or one whose host answers.
 */
export function memberHostVM(state, {now = Date.now(), zone} = {}) {
  if (!state || state.hosted || state.networked === false || state.host?.reachable !== false) return [];
  const host = state.host, name = clean(state.name, 'this circle'), label = hostLabelOf(host), banners = [{...hostOfflineBanner(state, name, {now, zone}), id: 'host-offline'}];
  const until = time(host.rosterValidUntil);
  if (!Number.isFinite(until)) return banners;
  if (until <= now) banners.push({tone: 'bad', icon: 'alert', id: 'membership-expired', headline: 'Your membership of ' + name + ' needs ' + label + ' to come back online.',
    text: 'Nothing is deleted. It comes back by itself when ' + label + ' does.'});
  else if (until - now <= 3 * 86400000) {
    const since = dateTimeWords(host.lastReachedAt, zone);
    banners.push({tone: 'need', icon: 'alert', id: 'membership-warning', headline: since ? sentenceCase(label) + ' hasn’t been online since ' + since + '.' : sentenceCase(label) + ' hasn’t been online for days.',
      text: 'If it is still offline on ' + dateTimeWords(until, zone) + ', this computer can’t lend to or borrow from ' + name + ' until it comes back.'});
  }
  return banners;
}
/** Everything the composer shows for one state. `repo.status`: idle | checking | ok | refused; `submission`: idle | sending | busy (a busy host is waited out) | uncertain. */
// The sender's Model or Effort, when no lender offers it, would wait forever. Say which one; Send stays off.
function missingPairCopy({model = '', effort = ''}) {
  if (model && effort) return `No lender offers ${model} at ${effort} right now`;
  return model ? `No lender offers ${model} right now` : `No lender offers ${effort} effort right now`;
}
// The saved automatic choice is one this screen does not know, or no online lender says it can make it. Send stays off; the copy says what to change.
const autoPickCopy = auto => AUTO_ASKED[auto]
  ? `No lender can make “${AUTO_ASKED[auto]}” right now. Choose another model, or Let the lender choose`
  : `The saved choice “${auto}” isn’t one Faravan can send. Choose Cheapest that fits or Strongest offered, or Let the lender choose`;
// A model is sent with its effort, never alone: a lender that offers the model only at other efforts would skip it.
function pickBlocker(offers, choice) {
  if (!choiceOffered(offers, choice)) return choice.auto ? autoPickCopy(choice.auto) : missingPairCopy(choice);
  return choice.model && !choice.effort ? `Choose an effort for ${choice.model}` : '';
}
// `instead`: a circle whose host answers, offered while this circle's host does not (composeCircle in compose-model.mjs).
export function composeVM({prompt = '', repo = {status: 'idle'}, circle = {}, submission = 'idle', now = Date.now(), uncertainSince = null, sourceKind = 'folder', draftSaved = false, zone, viewerSession, computerName, clientOffline = false, choice = {}, instead = null} = {}) {
  if (sourceKind === 'none') repo = {status:'ok'};
  const computer = hostComputerReference(viewerSession, computerName);
  const state = circle.state ?? {}, host = state.host ?? {}, circleName = clean(circle.name ?? state.name, 'this circle'), hostName = clean(host.label, 'the host’s computer');
  const recoveryTarget = state.hosted === true ? 'the circle server' : hostName;
  const refusal = repo.status === 'refused' ? composeProblemView(repo.refusal?.state) : null;
  const plainFolder=sourceKind==='folder'&&repo.status==='ok'&&repo.info?.kind==='folder';
  const help=plainFolder?['You can send this folder as files. To get changes back as a branch, run ',{code:'git init'},' in this folder, or choose another.']:refusal?.help;
  const refusedState = refusal ? (Object.hasOwn(LEGACY_COMPOSE_PROBLEMS,repo.refusal?.state)?repo.refusal.state:'compose.repo-missing') : '';
  const offline = state.networked !== false && host.reachable === false && state.sendReachable !== true;
  const lenders = (state.lenders ?? []).filter(l => !l.self).map(l => clean(l.label, unnamed));
  const pickWhy = pickBlocker(state.offers, choice);
  const hostOffline = hostOfflineBanner(state, circleName, {now, zone});
  if (instead?.id && submission === 'idle') hostOffline.action = {label: 'Send to ' + clean(instead.name, 'another circle') + ' instead', circle: instead.id};
  const elapsed = Number.isFinite(uncertainSince) ? Math.max(0, Math.floor((now - uncertainSince) / 1000)) : 0;
  const elapsedWords = elapsed >= 60 ? Math.floor(elapsed / 60) + (elapsed < 120 ? ' minute' : ' minutes') : Math.floor(elapsed / 10) * 10 + ' seconds';
  const uncertain = {tone: 'wait', icon: 'cloud-off', headline: 'Checking whether it was sent…',
    text: [(draftSaved ? problemView({code:'submission_uncertain'}).detail : 'This request may already have been sent. Keep this page open while Faravan checks. After a reload, check Jobs before preparing another request.') + (elapsed >= 10 ? ' ' + elapsedWords + ' elapsed.' : '')]};
  const repoBanner = refusal && {tone: 'bad', icon: 'alert', headline: refusal.headline, text: refusal.text, id: 'repo-problem'};
  const readUncertain = ['checking','failed'].includes(state.readStatus);
  const readBanner = readUncertain ? {tone:'wait',icon:'cloud-off',headline:state.readStatus === 'failed' ? 'Couldn’t refresh circle details' : 'Checking circle details…',
    text:state.readStatus === 'failed' ? 'Couldn’t refresh circle details. Faravan retries every 15 seconds while this page is open. Your request is unchanged.' : 'Sending waits for an updated response. We haven’t confirmed whether the host is reachable.'} : null;
  const banner = submission === 'uncertain' ? uncertain : submission === 'busy' ? {tone:'wait',icon:'clock',headline:'Waiting to send…',text:'The host is busy. Faravan will retry this same request. Your request and destination are locked until the outcome is known.'} : repoBanner || readBanner || (offline ? hostOffline : null);
  const noCircle = !circle.id ? 'You need an approved circle membership before sending. Open Circles to join or check your approval.' : state.networked === false ? nameHostComputerInCopy('Start a circle on this computer, or join with an invitation.', computer) : '';
  if (banner) banner.chip = submission === 'uncertain' ? 'Confirming send' : submission === 'busy' ? 'Waiting to send' : readUncertain ? (state.readStatus === 'failed' ? 'Circle status unavailable' : 'Checking circle') : offline ? 'Circle unreachable' : 'Project unavailable';
  const why = submission !== 'idle' ? '' : clientOffline ? 'You’re offline. Reconnect, then choose Send. This draft has not been submitted.' : readUncertain ? 'Circle details need an update before sending. Your request is unchanged.' : offline ? (draftSaved ? 'Your draft is kept on this computer. ' : '') + 'Send is enabled again when ' + recoveryTarget + ' answers.' + (instead?.id ? ' Or choose another circle.' : '') : noCircle
    || (refusal ? refusal.why : repo.status === 'checking' ? (sourceKind==='folder'?'Send is off while Faravan looks at the folder.':'Send is off while Faravan checks the source.') : repo.status !== 'ok' ? (sourceKind==='git'?'Resolve a repository branch before sending.':sourceKind==='files'?'Choose files or a ZIP before sending.':'Send is off until you choose a project.') : '')
    || pickWhy
    || (!String(prompt).trim() ? 'Send is off until you say what the agent should do.' : '');
  const stateKey = submission === 'uncertain' ? 'compose.send-uncertain' : refusedState || (offline ? 'compose.host-offline' : 'compose.local');
  return {
    state: stateKey, banner, plainFolder,
    folderError: refusal ? refusal.detail : '',
    meta: refusal ? refusal.meta : '', ...(help && {help}),
    disclosure: circleDisclosure({circle: circleName, lenders, host: hostName, networked: state.networked}).replace('gets your code', sourceKind === 'none' ? 'gets your prompt' : 'gets your code'),
    send: {label: submission === 'uncertain' ? 'Checking whether it was sent…' : submission === 'busy' ? 'Waiting to send…' : submission === 'sending' ? 'Sending…' : 'Send', disabled: submission !== 'idle' || Boolean(why), why},
  };
}

/* ---- H1 Hosting in the app (EXPERIENCE M5; circles.host-choose, host-running, host-woke, host-address-changed) ---- */
export const HOST_METHODS = [
  {id:'lan',title:'Local network only',needs:'Friends on the same local network.',fact:'Traffic on this network is unencrypted.',warn:true},
  {id:'private',title:'Private network',needs:'Friends with access to the same private network.',fact:'Review available offers in a terminal.'},
  {id:'public',title:'Public HTTPS',needs:'A stable HTTPS route verified by Gozar.',fact:'Anyone with the address can reach sign-in. Only members can use the circle.'},
];
export const HOST_FACTS = [
  {tone: 'info', icon: 'laptop', text: 'This computer runs the circle. While it is asleep or off, nobody in the circle can send or get jobs; jobs already sent wait here.'},
  {tone: 'ok', icon: 'shield', text: 'Friends’ computers only connect out to this address. Nothing connects to theirs.'},
  {tone: 'info', icon: 'clock', text: 'Jobs, code and results kept here are deleted 30 days after each job ends.'},
];
// Local browser sessions identify as local; the phone inbox payload carries its host in `computer`.
export function hostComputerReference(viewerSession, computerName) {
  const phoneInbox = Array.isArray(viewerSession?.phone?.scopes) && viewerSession.phone.scopes.includes('inbox:read');
  const nonHost = viewerSession?.kind === 'phone' || viewerSession?.kind === 'remote' || phoneInbox;
  if (!nonHost) return null;
  return clean(viewerSession.computer ?? computerName, 'the host computer');
}
export function nameHostComputerInCopy(text, reference) {
  if (!reference) return text;
  const name = reference === 'the host computer' ? 'The host computer' : reference;
  return text.replace(/\b(this computer|here)\b/gi, match => {
    if (match.toLowerCase() === 'this computer') return match[0] === 'T' ? name : reference;
    return match[0] === 'H' ? 'On ' + reference : 'on ' + reference;
  });
}
export function hostFactsFor(reference) {
  return HOST_FACTS.map(item => ({...item, text: nameHostComputerInCopy(item.text, reference)}));
}
export function hostStopCopy(hosting, computerReference = null) {
  const circles = Array.isArray(hosting?.circles) ? hosting.circles : [];
  const many = circles.length > 1;
  return {
    title: many ? `Stop hosting all ${circles.length} circles?` : 'Stop hosting this circle?',
    members: many ? `Members of ${circles.map(circle => circle.name).join(' and ')} cannot send or get jobs.` : 'Members cannot send or get jobs.',
    data: nameHostComputerInCopy('Stopping hosting does not delete data here. Jobs, code and results are still deleted 30 days after each job ends.', computerReference),
    action: many ? 'Stop hosting all circles' : 'Stop hosting this circle',
  };
}
const shellQuote = text => /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : '\'' + text.replace(/'/g, '\'\\\'\'') + '\'';
export function hostCommand({method, name = ''} = {}) {
  const parts = ['faravan host'];
  if (HOST_METHODS.some(choice=>choice.id===method)) parts.push('--tunnel '+method);
  if (String(name).trim()) parts.push('--circle-name ' + shellQuote(String(name).trim()));
  return parts.join(' ');
}
export function hostChooseVM({method = 'lan', name = ''} = {}, {viewerSession, computerName} = {}) {
  const computer = hostComputerReference(viewerSession, computerName);
  const chosen = HOST_METHODS.find(item => item.id === method) ?? HOST_METHODS[0];
  return {
    title:nameHostComputerInCopy('Start a circle on this computer', computer),
    methods:HOST_METHODS.map(item => ({...item, needs:nameHostComputerInCopy(item.needs,computer),
      fact:nameHostComputerInCopy(item.fact,computer), selected:item.id===chosen.id})),
    chosen, facts:hostFactsFor(computer), command:hostCommand({method:chosen.id,name}),
    start:chosen.id==='lan'?{tunnel:'lan',...(String(name).trim()&&{name:String(name).trim()})}:null,
  };
}
const REACH_WORDS = {lan:'Local network', tailnet:'Private network', internet:'Public HTTPS'};
export const hostReachWord = reach => REACH_WORDS[reach?.audience ?? reach?.kind] ?? '';
const memberWords = n => Number.isInteger(n) && n > 0 ? (n === 1 ? 'Just you so far' : n + ' members') : '';
/** What the page is: choose (nothing hosted yet), running, stopped (hosted before, not now) or address-changed; a wake gap rides along. */
export function hostStatusVM(hosting, {now = Date.now(), zone, viewerSession, computerName, setupError = '', setupUncertain = ''} = {}) {
  const computer = hostComputerReference(viewerSession, computerName), copy = text => nameHostComputerInCopy(text, computer);
  if (setupUncertain && hosting?.running) return {kind: 'setup-uncertain', title: 'Circle setup unconfirmed', banner: {tone: 'wait', icon: 'alert', headline: 'The Start response was lost. Circle setup is not confirmed.', text: 'A running host alone cannot confirm circle setup. Inspect your circles before taking further setup actions. ' + setupUncertain}};
  // A hosting read that failed is not "nothing set up" and not "stopped": say it could not be read, and why.
  if (hosting?.unreadable || hosting?.processState === 'unreadable') return {kind: 'unreadable', title: clean(hosting.name, 'Hosting'), banner: {tone: 'bad', icon: 'alert',
    headline: copy('Couldn’t read hosting status on ' + (computer || 'this computer') + '.'), text: clean(hosting.unreadable?.reason ?? hosting.statusError, 'The hosting files could not be read').replace(/[.\s]+$/, '') + '. Faravan changed nothing. Check hosting status again once the file is fixed.'}};
  if (!hosting?.configured) return {kind: 'choose', title: copy('Start a circle on this computer'), banner: null};
  if (hosting.running && setupError) return {kind: 'setup-failed', title: 'Circle setup incomplete', banner: {tone: 'bad', icon: 'alert', headline: 'The host process is running, but circle setup did not finish.', text: setupError}};
  if (!hosting.circle && !(hosting.circles?.length)) return {kind: 'choose', title: copy('Start a circle on this computer'), banner: null,
    setupNotice: copy('Hosting setup was started on this computer, but Faravan has not confirmed a running circle yet.')};
  const name = clean(hosting.name, 'Your circle'), reach = hostReachWord(hosting.reach);
  const wake = hosting.wake && Number.isFinite(time(hosting.wake.from)) && Number.isFinite(time(hosting.wake.to)) ? hosting.wake : null;
  const waited = wake && Number.isInteger(wake.waitedJobs) ? wake.waitedJobs : 0;
  const woke = wake && {tone: 'wait', icon: 'moon', headline: copy('This computer was asleep from ' + hourMinute(time(wake.from), zone) + ' to ' + hourMinute(time(wake.to), zone) + '.'),
    text: 'Nobody in ' + name + ' could send or get jobs then.' + (waited ? ' ' + waited + (waited === 1 ? ' job waited.' : ' jobs waited.') : '')};
  if (hosting.addressChanged) {
    const {expected, observed} = hosting.addressChanged;
    return {kind: 'address-changed', title: name, banner: {tone: 'bad', icon: 'alert',
      headline: copy('This computer is now reached at a different address.'),
      text: 'Members and invitations use ' + clean(expected) + ', but ' + 'it now answers at ' + clean(observed) + '. Faravan won’t publish the circle at an address members didn’t agree to.'},
      restore: hosting.reach?.kind === 'lan' ? copy("This circle uses the saved local address " + clean(expected) + ". Restore that address on this computer’s local network, then check hosting status again. This app cannot change existing invitations to a different address.") : null,
      reference: 'Error host_origin_changed',
      details: JSON.stringify({code: 'host_origin_changed', expected, observed})};
  }
  if (!hosting.running) return {kind: 'stopped', title: name, banner: {tone: 'wait', icon: 'cloud-off', headline: name + ' isn’t running ' + (computer ? 'on ' + computer : 'on this computer') + '.',
    // On this computer the Start control sits under the banner; another device can only point back to the host.
    text: hosting.wanted&&hosting.resumeBlocker?.message?clean(hosting.resumeBlocker.message):copy('Members can’t send or get jobs until it is back. Jobs already sent wait here.' + (computer ? ' Start it again here; Faravan notices when it is up.' : ''))}, command: 'faravan host'};
  const reached = hosting.lastReachedAt ? 'Members reached it ' + whenLabel(hosting.lastReachedAt, now, zone) + '.' : '';
  return {kind: 'running', title: name, banner: woke, headline: copy('Runs on this computer'), status: 'Online',
    line: [clean(hosting.origin), reach, memberWords(hosting.members)].filter(Boolean).join(' · '), reached, inviteHref: hosting.circle ? '#/circle/' + encodeURIComponent(hosting.circle) : ''};
}

/** Lending scope names the computer, its selected agents and the saved circle. */
export function lendingSubtitle(computer, agents = [], circles = [], circle, enabled = true) {
  if(!enabled)return clean(computer,'This computer')+' · lending is off';
  const names = [...new Set(agents.filter(a => a.useForLending).map(a => agentLabel(a.id)))];
  const selected = circles.find(c => c.id === circle && c.name !== 'My devices' && c.private !== true);
  return clean(computer, 'This computer') + (names.length && selected ? ' · lends ' + listWords(names) + ' to ' + clean(selected.name, 'your circle') : ' · this computer');
}

/** What kind of output a finished job returned: 'message', 'files', 'diff', or 'unknown' until a read says. */
export function resultOutputKind(job, changes, receipt) {
  const kinds = {message: 'message', files: 'files', diff: 'diff', branch: 'diff'};
  const candidates = [changes?.format, job?.format, job?.output?.kind, job?.resultSummary?.output?.kind,
    job?.payload?.result?.kind, job?.resultSummary?.receipt?.receipt?.candidate_format, receipt?.receipt?.candidate_format,
    job?.payload?.source?.kind === 'none' ? 'message' : null];
  for (const value of candidates) if (kinds[value]) return kinds[value];
  return 'unknown';
}
// Home's result card follows the output: a poem is read, not reviewed as changes (r8 O8).
export const HOME_RESULT_COPY = {
  message: {lead: 'Your answer is back. Read it.', action: 'Read', summary: false},
  files: {lead: 'Your files are back. Open the result to see them.', action: 'Open', summary: false},
  diff: {lead: 'Your result is back. Review the changes before you use them.', action: 'Review', summary: true},
  unknown: {lead: 'Your result is back.', action: 'Open', summary: false},
};

// Home acknowledgement is display-only. An unversioned legacy result has a job-level key.
export function homeResultDismissalKey(job) {
  const circleId = job?.circle?.id ?? job?.circle;
  if (typeof circleId !== 'string' || !circleId || typeof job?.job_digest !== 'string' || !job.job_digest) return null;
  return JSON.stringify([circleId, job.job_digest, jobProjectionFor(job).result.digest]);
}

export function homePageVM({jobs = null, approvals = null, changes = null, receipt = null, lendingBlockers = null, unavailable = null, dismissedResults = new Set(), ...options} = {}) {
  const rows = jobsListVM(jobs, options).groups.flatMap(group => group.rows);
  const jobList = Array.isArray(jobs) ? jobs : [];
  const byId = new Map(jobList.map(job => [job.job_digest, job]));
  const byCircleAndJob = new Map(jobList.map(job => [JSON.stringify([job.circle?.id ?? job.circle, job.job_digest]), job]));
  const eligibleResults = rows.filter(row => row.role === 'sent' && row.key === 'ready' && !row.noChanges && !byId.get(row.id)?.borrowerOutcome);
  const dismissalKeyForRow = row => homeResultDismissalKey(byCircleAndJob.get(JSON.stringify([row.circleId, row.id])));
  const dismissed = job => dismissedResults.has(homeResultDismissalKey(job));
  const results = eligibleResults.filter(row => !dismissedResults.has(dismissalKeyForRow(row)));
  const now = options.now ?? Date.now();
  const heldOffers = (options.home?.lending?.heldOffers ?? []).filter(offer =>
    offer.circle === options.home.activeCircle && offer.expiresAt > now && !byId.has(offer.id)).map(offer => {
    const provider = providerOf(offer.agent);
    const account = options.home.lendingPolicy?.accounts?.find(entry =>
      (entry.accountKey ?? entry.provider) === (offer.accountKey ?? provider));
    const reason = offer.reason === 'quota_reserve' ? 'owner_reserve' : offer.reason;
    const wait = reason === 'owner_reserve'
      ? currentCapacityWait(account, {now, formatClock:at=>clock(at, options.zone, true)}) : null;
    const checkAfterExpiry = wait?.state === 'waiting' && currentAccountDecision(account).wait.nextEvaluationAtMs >= offer.expiresAt;
    const status = lendingStatus({reason, pendingRequest:true});
    return {id:offer.id, agent:agentLabel(offer.agent), line:checkAfterExpiry
      ? 'Your remaining allowance is being kept for you. This request is held by the lender’s reserve and may expire before allowance becomes available.'
      : wait?.line ?? (status.id === 'usage_estimate' ? 'Checking whether this computer can start the request.' : status.line)};
  });
  const active = new Set(['waiting', 'asked', 'waiting_approval', 'approved', 'starting', 'working', 'sending', 'delivery_delayed', 'stop_requested', 'stop_unconfirmed', 'uncertain', 'unknown']);
  // Home loads the top result's receipt for its preview; it names the agent that ran, as the Jobs page does.
  const ranWith = clean(receipt?.receipt?.harness), first = results[0] ?? null;
  const result = first && ranWith && !first.agent
    ? jobsListVM([{...byId.get(first.id), receipt: {harness: ranWith}}], options).groups.flatMap(group => group.rows)[0] ?? first : first;
  const resultKind = resultOutputKind(result ? byId.get(result.id) : null, changes, receipt);
  const files = Array.isArray(changes?.files) ? changes.files : [];
  const stat=changes?.diffstat ?? (receipt?.receipt?.candidate_format==='diff' ? receipt.receipt.diffstat : null);
  // A preview is one file. Never append another file’s hunk under this file’s label.
  const firstPatch = typeof changes?.diff === 'string' ? changes.diff.split(/(?=^diff --git )/m).find(part => part.trim()) ?? '' : '';
  const preview = changes?.format === 'diff' && !changes.invalid
    ? firstPatch.split('\n').filter(line => /^[+-]/.test(line) && !/^([+]{3}|[-]{3})/.test(line)).slice(0, 4).map(text => ({kind: text[0] === '+' ? 'add' : 'del', text: text.slice(1)})) : [];
  const attention = needsYouItems({home:options.home, readiness:options.readiness, agents:options.agents, jobs, approvals, zone:options.zone, now, lendingBlockers})
    .filter(item => item.kind !== 'result' || !dismissed(item.job ?? byId.get(item.job_digest ?? item.id)));
  const blockerItems = attention.filter(item => item.kind === 'blocker');
  const approvalIds = new Set((Array.isArray(approvals) ? approvals : []).map(card => card.id));
  const pendingRequests = attention.filter(isRequestItem)
    .map(item => ({id:item.approvalId ?? item.id})).filter(item => item.id && !approvalIds.has(item.id));
  const resultCount = attention.filter(item => item.kind === 'result').length;
  const requestCount = attention.filter(isRequestItem).length;
  const requestIds = new Set(attention.filter(isRequestItem).map(item => item.approvalId ?? item.id));
  const setupCount = blockerItems.length;
  const otherItems = attention.filter(item => !['blocker','result','request','approval'].includes(item.kind) && !item.approvalId);
  const otherCount = otherItems.length;
  const counts = {results:resultCount, requests:requestCount, setup:setupCount, other:otherCount};
  const subtitle = [
    counts.results ? counts.results + (counts.results === 1 ? ' result to review' : ' results to review') : '',
    counts.requests ? counts.requests + (counts.requests === 1 ? ' request needs you' : ' requests need you') : '',
    counts.setup ? counts.setup + (counts.setup === 1 ? ' setup step' : ' setup steps') : '',
    counts.other ? counts.other + (counts.other === 1 ? ' other item' : ' other items') : '',
  ].filter(Boolean).join(' · ') || (options.home != null && Array.isArray(jobs) && Array.isArray(approvals) ? 'You’re all caught up.'
    : unavailable && options.home == null ? (isSessionLost(unavailable) ? 'Not connected. Open Faravan again to see what needs you.' : 'This computer’s status couldn’t be loaded.')
    : 'Loading requests and results…');
  const loaded = options.home != null && Array.isArray(jobs) && Array.isArray(approvals);
  // Home-only display grace; elapsed time never confirms that the lender stopped.
  const stopGraceMs = 15 * 60 * 1000;
  const stopTimes = new Map((Array.isArray(jobs) ? jobs : []).map(job => [
    JSON.stringify([job.circle?.id ?? '', job.job_digest]),
    Date.parse(jobProjectionFor(job).evidence.sharedStopRequestedAt),
  ]));
  const unresolvedStop = row => ['stop_requested', 'stop_unconfirmed'].includes(row.key)
    && Number.isFinite(now)
    && now - stopTimes.get(JSON.stringify([row.circleId, row.id])) >= stopGraceMs;
  return {
    subtitle, counts, results, result, resultKind, resultDismissalKey: result ? dismissalKeyForRow(result) : null, resultCopy: HOME_RESULT_COPY[resultKind], requests:requestCount, requestIds, pendingRequests, blockerItems, otherItems, needs: attention.length, loaded,
    offerNewJob: loaded && attention.length === 0 && !lendingBlockers?.needsYou?.length,
    inMotion: rows.filter(row => active.has(row.key) && !unresolvedStop(row)), heldOffers,
    unresolvedStops: rows.filter(unresolvedStop),
    recent: rows.filter(row => !eligibleResults.includes(row)).filter(row => ['ready', 'pr_open'].includes(row.key) || JOB_STATES[row.key]?.terminal).slice(0, 5).map(row => row.role === 'ran' ? {...row, word:row.word, whoShort:'', circle:'', when:row.when || whenLabel(time(byId.get(row.id)?.current_attempt?.execution_started_at ?? byId.get(row.id)?.current_attempt?.claimed_at), options.now ?? Date.now(), options.zone) || 'Time unavailable'} : row),
    preview: {file: clean(files[0]?.path), lines: preview, summary: finite(stat?.files) ? stat.files + (stat.files === 1 ? ' file changed' : ' files changed') + (finite(stat.insertions) && finite(stat.deletions) ? ', +' + stat.insertions + ' −' + stat.deletions : '') : '',
      prompt: clean(result ? byId.get(result.id)?.local?.prompt ?? byId.get(result.id)?.prompt : '')},
    jobsLoaded: Array.isArray(jobs),
  };
}

/** One job event supplies a shared timestamp and participant set to each people surface. */
export function jobActivity(job = {}) {
  const at = [job.updated_at, job.receipt?.finished_at, job.current_attempt?.stopped_at,
    job.current_attempt?.execution_started_at, job.current_attempt?.claimed_at, job.current_attempt?.completed_at,
    job.waitingTiming?.submittedAt, job.local?.submittedAt, job.created_at]
    .map(time).filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), -Infinity);
  if (!Number.isFinite(at)) return null;
  const author = job.historyIdentity?.author ?? idOf(job.requester) ?? idOf(job.payload?.author);
  const holder = job.current_attempt?.holder;
  const lender = job.receipt?.lender;
  const participants = [author, holder, lender].filter(value => typeof value === 'string' && value);
  return {at, holder, participants};
}

export function homePeopleVM(members = [], {ownId, now = Date.now(), zone, jobs = [], circleId} = {}) {
  const activity = new Map(), running = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const jobCircle = job.circle?.id ?? job.circle ?? job.circle_id ?? job.payload?.circle?.id ?? job.payload?.circle_id;
    if (circleId == null || jobCircle == null || String(jobCircle) !== String(circleId)) continue;
    const event = jobActivity(job);
    if (!event) continue;
    const projection = formatJobProjection(job).projection;
    if (projection.phase === 'running' && !['last_known', 'transitional'].includes(projection.observation?.state) && typeof event.holder === 'string' && event.holder) running.add(event.holder);
    for (const participant of event.participants) {
      const previous = activity.get(participant);
      if (!Number.isFinite(previous) || event.at > previous) activity.set(participant, event.at);
    }
  }
  const rows = (Array.isArray(members) ? members : []).filter(m => (ownId == null || String(idOf(m)) !== String(ownId)) && m.thisComputer !== true).map(m => {
    const name = clean(m.localName?.name ?? m.localName) || clean(m.personName ?? m.person?.name) || clean(m.device_name ?? m.deviceName ?? m.ownerName, 'A circle member');
    const presence = m.presence ?? {};
    const age = now - time(presenceObservedAt(presence));
    const freshPresence = presence.source !== 'poll' && typeof presence.state === 'string' && age >= 0 && age < 90000;
    const isRunning = running.has(String(idOf(m)));
    const online = isRunning || freshPresence || m.online === true;
    const seenAt = [m.lastSeen, m.last_seen_at, m.lastContactAt, m.last_contact_at, presence.last_poll_at, presence.last_heartbeat_at]
      .map(time).filter(at => Number.isFinite(at) && at <= now).reduce((latest, at) => Math.max(latest, at), -Infinity);
    const jobAt = activity.get(String(idOf(m)));
    const lastActivity = Math.max(seenAt, jobAt <= now ? jobAt : -Infinity);
    let state;
    if (isRunning) state = 'Running a job now';
    else if (freshPresence) state = presenceLine(presence, {now,timeZone:zone});
    else if (m.online === true) state = m.ready === true ? 'Ready to lend' : 'Online';
    else if (m.role === 'borrower') state = 'Borrows';
    else state = Number.isFinite(jobAt) && jobAt === lastActivity && jobAt > seenAt ? 'Last active ' + whenLabel(jobAt,now,zone)
      : Number.isFinite(seenAt) ? 'Last seen ' + whenLabel(seenAt,now,zone) : 'No recent activity';
    const device = clean(m.device_name ?? m.deviceName);
    const duplicateKey = device && JSON.stringify([m.person_id ?? name, device]);
    const older = !online && Number.isFinite(lastActivity) && now - lastActivity >= 7 * 86400000;
    return {row:{id:idOf(m),name,state:device && device !== name ? device + ' · ' + state : state},
      duplicateKey,online,older,unreported:m.reported===false && !Number.isFinite(lastActivity)};
  });
  const onlineNames = new Set(rows.filter(item => item.online && item.duplicateKey).map(item => item.duplicateKey));
  return rows.map(({row,duplicateKey,older,unreported}) => older || unreported && onlineNames.has(duplicateKey)
    ? {...row,earlier:true} : row);
}
