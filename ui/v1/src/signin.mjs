import {SIGN_IN_RETRY_LABEL} from './problem-catalog.mjs';
// Pure helpers for the browser sign-in flow (no DOM, no network).
import {errorMessage} from './helpers.mjs';
import {formatDate} from './dates.mjs';
export const POLL_MS = 2000;
// The problem codes a sign-in action may show with their own copy; anything else is the generic sign-in failure, never raw text.
export const SIGNIN_ACTION_ERROR_CODES = ['credential_writer_unresolved', 'signin_redirect_mismatch', 'signin_code_invalid'];
export const actionErrorCode = error => SIGNIN_ACTION_ERROR_CODES.includes(error) ? error : 'signin_failed';
const TERMINAL = ['complete', 'failed', 'cancelled', 'timed_out'];
export const isTerminal = flow => TERMINAL.includes(flow?.status);
// Deadlines belong to receipts in this tab; monotonic times are never stored or shared between devices.
const codeDeadlines = new WeakMap();
export function codeIsShowable(flow, now = performance.now()) {
  return Boolean(flow?.code) && (!codeDeadlines.has(flow) || now < codeDeadlines.get(flow));
}
// Latest issued operation wins; terminal receipts cannot regress within a generation.
export function signInResponses() {
  let generation=0, sequence=0, flow=null;
  return {
    reset() { generation++; sequence=0; flow=null; },
    terminal() { return isTerminal(flow); },
    ticket(flowId=flow?.flowId) { return {generation, sequence:++sequence, flowId}; },
    current(ticket) { return ticket.generation===generation && ticket.sequence===sequence; },
    accept(ticket, next) {
      if (!this.current(ticket) || (ticket.flowId && next.flowId && ticket.flowId!==next.flowId) ||
          (isTerminal(flow) && next.status!==flow.status)) return false;
      if (next.code && Number.isFinite(next.expiresInMs))
        codeDeadlines.set(next, performance.now() + next.expiresInMs - 2000);
      flow=next; return true;
    },
  };
}
export const dockerSignInNeeded = readiness => (readiness?.checks || []).some(c => c.name === 'docker_login' && c.ok === false && c.unknown !== true && c.cause !== 'docker_signin_refresh_unavailable');
const SERVICE = { docker: 'Docker', github: 'GitHub' };
const STARTING_STAGE_COPY = Object.freeze({
  backend_health: 'Checking the sandbox service…', identity_drain: 'Finishing a background account check…',
  adapter_resolution: 'Finding the sign-in method…', docker_guard: 'Checking sandbox sign-in readiness…',
  capabilities: 'Checking sandbox support…', sandbox_prepare: 'Preparing a secure sign-in…',
  provider_url: 'Waiting for the provider sign-in page…',
});
// Each failure names its cause, then one step. "again" and "wait" lead to the retry button; "free" is a disk step; "support"
// is for causes only support can read. The inline panel has its own Start sign-in again button, so it never sends the
// person to another screen; the standalone sign-in tab says which screen to return to.
const FAIL = (cause, next = 'again') => Object.freeze({cause, next});
const TERMINAL_STAGE_FAILURE_COPY = Object.freeze({
  backend_health: Object.freeze({
    startup_failed: FAIL('Faravan could not reach the sandbox service.'),
    wall_timeout: FAIL('The sandbox service took too long to respond.'),
  }),
  identity_drain: Object.freeze({
    startup_failed: FAIL('A background account check did not finish.', 'wait'),
    wall_timeout: FAIL('A background account check took too long.', 'wait'),
  }),
  adapter_resolution: Object.freeze({
    startup_failed: FAIL('Faravan could not find this sign-in method.'),
    wall_timeout: FAIL('Finding this sign-in method took too long.'),
  }),
  docker_guard: Object.freeze({
    startup_failed: FAIL('Faravan could not check sandbox sign-in readiness.'),
    wall_timeout: FAIL('Checking sandbox sign-in readiness took too long.'),
  }),
  capabilities: Object.freeze({
    startup_failed: FAIL('Sign-in could not start.'),
    sandbox_not_ready: FAIL('The sandbox service is not ready.'),
    wall_timeout: FAIL('Checking sandbox support took too long.'),
  }),
  sandbox_prepare: Object.freeze({
    startup_failed: FAIL('Faravan could not prepare the secure sign-in sandbox.'),
    sandbox_start_failed: FAIL('The secure sign-in sandbox could not start.'),
    sandbox_ready_timeout: FAIL('The secure sign-in sandbox did not become ready.'),
    sandbox_credential_store_failed: FAIL('Faravan could not store sign-in credentials securely.'),
    policy_unenforceable: FAIL('Faravan could not apply the required sign-in security policy.', 'support'),
    host_disk_low: FAIL('This computer is low on disk space. Faravan needs at least 8 GiB free.', 'free'),
    storage_unenforceable: FAIL('Faravan could not secure sign-in storage.', 'support'),
    wall_timeout: FAIL('Preparing the secure sign-in sandbox took too long.'),
    signin_timeout: FAIL('Preparing the secure sign-in sandbox took too long.'),
  }),
  provider_url: Object.freeze({
    startup_failed: FAIL('Faravan could not open the provider sign-in page.'),
    wall_timeout: FAIL('The provider sign-in page took too long to open.'),
  }),
});
const REASON_FAILURE_COPY = Object.freeze({
  credential_mutation_busy: FAIL('Another background check holds the credential lock.', 'wait'),
  credential_scope_unenforceable: FAIL('Faravan could not secure the sign-in credential scope.', 'support'),
  provider_cli_missing: FAIL('Faravan could not find the agent’s command on this computer. Install it, or open it once in a terminal, then try again.'),
  completion_failed: FAIL('Faravan could not confirm sign-in completed.'),
  guest_not_authenticated: FAIL('No new authenticated credential was confirmed.'),
  completion_timeout: FAIL('The provider did not finish sign-in in time.'),
});
const SUPPORT_STEP = 'Save support archive in Settings → Data and send it to support.';
const nextStep = (next, retry) => next === 'support' ? SUPPORT_STEP : next === 'wait' ? 'Wait a moment, then ' + retry
  : next === 'free' ? 'Free some space, then ' + retry : retry[0].toUpperCase() + retry.slice(1);
// `screen` is the screen to return to, or '' when the panel with the retry button is already on screen.
const failureCopy = ({cause, next}, screen) => cause + ' ' + nextStep(next, screen ? 'return to ' + screen + ' to try again.' : 'choose ' + SIGN_IN_RETRY_LABEL + '.');
// Shown only when OpenAI refused the device code; the person turns the setting on, or signs in another way.
export const DEVICE_CODE_UNAVAILABLE_COPY = 'OpenAI did not allow a device code sign-in. In ChatGPT, open Settings → Security, turn on device code login for Codex, then try again.';
// One plain line per way a Codex device sign-in can end. The CLI's own text is never shown.
export const DEVICE_FAILURE_COPY = Object.freeze({
  codex_device_code_unavailable: DEVICE_CODE_UNAVAILABLE_COPY,
  codex_device_code_rate_limited: 'OpenAI is limiting sign-in requests. Wait a few minutes, then try again.',
  codex_device_code_service_unavailable: 'OpenAI is unavailable right now. Try again in a moment.',
  codex_device_code_exchange_failed: 'The approval did not complete. Start the sign-in again.',
  codex_device_code_expired: 'The code expired before it was approved. Start the sign-in again.',
});
const timeoutCopy = screen => failureCopy(FAIL('Sign-in timed out.'), screen);
// The server's one fixed message for a credential lock held by another check; any other message is never shown.
const LOCK_HELD_MESSAGE = 'Another background check holds the credential lock. Wait a moment, then choose Start sign-in again.';
const terminalStageFailureCopy = (flow, screen = '') => {
  if (Object.hasOwn(DEVICE_FAILURE_COPY, flow?.reasonCode)) return DEVICE_FAILURE_COPY[flow.reasonCode];
  // Only this fixed server-authored condition copy is accepted; never raw errors.
  if (flow?.reasonCode === 'credential_scope_unenforceable' && flow.message === LOCK_HELD_MESSAGE) return failureCopy(REASON_FAILURE_COPY.credential_mutation_busy, screen);
  if (Object.hasOwn(REASON_FAILURE_COPY, flow?.reasonCode)) return failureCopy(REASON_FAILURE_COPY[flow.reasonCode], screen);
  const byReason = TERMINAL_STAGE_FAILURE_COPY[flow?.stage];
  if (!byReason) return null;
  const reason = Object.hasOwn(byReason, flow?.reasonCode) ? flow.reasonCode : 'startup_failed';
  return failureCopy(byReason[reason] || byReason.startup_failed, screen);
};
export const startingStageCopy = stage => STARTING_STAGE_COPY[stage] || 'Faravan is preparing the sign-in page.';
export const signInLabel = (target, agentName) => 'Sign in to ' + (SERVICE[target] || agentName || 'this agent');
// Only an https URL may reach an href or window.open.
export const safeSignInUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
// One panel: it says what to do, that Faravan notices when it is done, and keeps a quiet live status. There is no
// manual check while the automatic one runs; "Check now" is only the fallback when the automatic check cannot reach the app.
// Codex has a second way in: the loopback browser flow. It is offered under the device code, and after OpenAI refuses one.
const isCodex = flow => ['codex', 'codex-lending'].includes(flow?.target);
export const hasOtherWays = flow => isCodex(flow) && (flow.status === 'awaiting_browser'
  ? Boolean(flow.code) && flow.redirectEntry !== true && flow.codeEntry !== true
  : ['failed', 'timed_out'].includes(flow.status) && Object.hasOwn(DEVICE_FAILURE_COPY, flow.reasonCode));
export const OTHER_WAYS_LABEL = 'Other ways to sign in';
export function signInView(flow, error, { pollFailed = false, checkNote = '', elapsedMs = 0 } = {}) {
  if (error && !flow) return { heading: null, body: errorMessage({code:actionErrorCode(error)}), actions: ['retry'] };
  if (error && !isTerminal(flow)) return {...signInView(flow, '', {pollFailed,checkNote,elapsedMs}), actionError: errorMessage({code:actionErrorCode(error)})};
  if (!flow) return { heading: null, body: null, actions: ['start'] };
  if (flow.status === 'starting') return { heading: 'Preparing sign-in…', body: null,
    status: pollFailed ? 'Can’t check right now.' : startingStageCopy(flow.stage), actions: ['cancel'] };
  if (flow.status === 'awaiting_browser') {
    if (flow.code && !codeIsShowable(flow)) return { heading: null, body: DEVICE_FAILURE_COPY.codex_device_code_expired, actions: ['retry'] };
    if (flow.codeEntry === true) return { heading: 'Sign in on the page that opened. Then paste the code it shows you here.', body: null,
      code: flow.code || null, url: safeSignInUrl(flow.url), codeEntry: true, actions: ['open', 'cancel'] };
    return { heading: 'Finish sign-in in your browser. Faravan notices when you’re done.', body: null, code: flow.code || null, url: safeSignInUrl(flow.url),
      ...(flow.redirectEntry === true ? { redirectEntry: true } : {}),
      ...(hasOtherWays(flow) ? { otherWays: true } : {}),
      status: pollFailed ? 'Can’t check right now.' + (checkNote ? ' ' + checkNote : '') : checkNote ||
        'Waiting for you to finish in the browser…' + (elapsedMs >= 10000 ? ' ' + Math.floor(elapsedMs / 1000) + ' seconds elapsed.' : ''),
      actions: pollFailed ? ['open', 'check', 'cancel'] : ['open', 'cancel'] };
  }
  if (flow.status === 'complete') return { heading: null, body: null, status: 'Signed in', actions: [] };
  if (flow.status === 'cancelled') return { heading: 'Sign-in cancelled', body: null, status: 'You can start again when you’re ready.', actions: ['retry'] };
  if (flow.status === 'timed_out') return { heading: null, body: terminalStageFailureCopy(flow) || timeoutCopy(''), actions: ['retry'],
    ...(hasOtherWays(flow) ? { otherWays: true } : {}) };
  return { heading: null, body: terminalStageFailureCopy(flow) || errorMessage({code:'signin_failed'}), actions: ['retry'],
    ...(hasOtherWays(flow) ? { otherWays: true } : {}) };
}
export const ACTION_LABELS = { start: null, retry: SIGN_IN_RETRY_LABEL, open: 'Open sign-in page', check: 'Check now', cancel: 'Cancel sign-in' };

// A check the person asks for must show itself at once and say what it found (a button that looks dead is a bug).
export function checkView({ phase = 'idle', at = null, changed = false, error = '', zone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (phase === 'checking') return { label: 'Checking…', busy: true, note: 'Checking this computer…' };
  if (phase === 'done') {
    const when = Number.isFinite(at) ? formatDate(at, 'clock', {zone}) : '';
    return { label: 'Check again', busy: false, note: error ? 'Couldn’t check: ' + error : 'Checked' + (when ? ' ' + when : '') + '.' + (changed ? '' : ' Nothing changed.') };
  }
  return { label: 'Check again', busy: false, note: '' };
}

const PROGRESS_PREFIX = 'faravan-signin-progress:';
export const progressKey = id => PROGRESS_PREFIX + id;
export function readProgress(storage, id) {
  try { return JSON.parse(storage?.getItem(progressKey(id)) ?? 'null'); } catch { return null; }
}
export function writeProgress(storage, id, value) {
  try { storage?.setItem(progressKey(id), JSON.stringify(value)); } catch { /* the original panel remains usable */ }
}
export function progressView(progress, now = Date.now()) {
  const recovery = progress?.target === 'docker' ? {href:'#/setup',label:'Go to Setup',name:'Setup'} : {href:'#/lend',label:'Return to Lending',name:'Lending'};
  return {...progressState(progress,now,recovery.name),recovery};
}
function progressState(progress, now, destination) {
  const name = SERVICE[progress?.target] || progress?.agentName || 'your agent';
  const elapsed = Math.max(0, Math.floor((now - (progress?.startedAt || now)) / 1000));
  if (!progress) return { heading: 'This sign-in is no longer available', status: 'Return to Lending to start again.', terminal: true };
  if (progress.sessionExpired) return { heading: 'Sign-in session expired', status: 'Reopen the app to continue.', terminal: true };
  if (progress.unavailable) return { heading: 'This sign-in is no longer available', status: 'Return to '+destination+' to start again.', terminal: true };
  if (progress.flow?.status === 'cancelled') return { heading: 'Sign-in cancelled', status: 'You can start again from '+destination+'.', terminal: true };
  // Docker's sign-in lives on Setup, so a Docker sign-in that stopped leads back there.
  const retry = progress.target === 'docker' ? { next: 'setup' } : {};
  if ((progress.errorCode || progress.error) && !progress.flow) return { heading: 'Sign-in didn’t finish', status: errorMessage({code:progress.errorCode}), terminal: true,
    ...(['signin_failed', 'sign_in_failed'].includes(progress.errorCode) ? retry : {}) };
  if (progress.flow?.status === 'timed_out') return { heading: 'Sign-in didn’t finish', status: terminalStageFailureCopy(progress.flow, destination) || timeoutCopy(destination), terminal: true, ...retry };
  if (progress.flow?.status === 'failed') return { heading: 'Sign-in didn’t finish', status: terminalStageFailureCopy(progress.flow, destination) || errorMessage({code:'signin_failed'}), terminal: true, ...retry };
  if (progress.flow?.status === 'complete') return { heading: 'Already signed in to ' + name, status: 'You can return to '+destination+' or close this tab.', terminal: true, complete: true };
  if (progress.cancelRequested || progress.cancelled) return { heading: 'Cancellation requested', status: progress.cancelError ? 'Could not confirm cancellation. Retry Cancel sign-in or return to '+destination+'.' : 'Waiting for confirmation. The sign-in may still be running.', terminal: false };
  if (progress.flow?.status === 'awaiting_browser' && progress.flow.code && !codeIsShowable(progress.flow))
    return { heading: 'Sign-in didn’t finish', status: DEVICE_FAILURE_COPY.codex_device_code_expired, terminal: true, expired: true, ...retry };
  if (progress.readFailed && !codeIsShowable(progress.flow)) return { heading: 'Can’t check sign-in right now', status: 'Retry the check or return to '+destination+'.', terminal: false };
  // A flow with a code (Codex and Docker device sign-in) must show it before the person is sent anywhere: this tab
  // stays, with the code, a Copy code button and the link, and never redirects on its own.
  if (progress.flow?.status === 'awaiting_browser' && progress.flow.code && safeSignInUrl(progress.flow.url))
    return { heading: 'Finish signing in to ' + name, status: 'Open the sign-in page, then enter this code there. Faravan notices when you are done.', terminal: false,
      code: progress.flow.code, url: safeSignInUrl(progress.flow.url), keepOpen: true };
  const status=progress.flow?.status==='starting'?startingStageCopy(progress.flow.stage):'Usually 30–60 seconds.';
  return { heading: 'Starting a secure sign-in for ' + name + '…', status: status + (elapsed >= 10 ? ' ' + elapsed + ' seconds elapsed.' : ''), terminal: false, url: safeSignInUrl(progress.flow?.url) };
}
// Open a real application page synchronously with the click, before the slow provider work starts.
export async function beginSignIn({api, target, agentName, storage, open, id, now = Date.now(), onFlow, method}) {
  const progress = {target, agentName, startedAt: now};
  writeProgress(storage, id, progress);
  try { open('/#/signin/' + encodeURIComponent(id), '_blank', 'noopener,noreferrer'); } catch { /* the same-tab progress link remains available */ }
  try {
    let flow = await api.post('signin/' + encodeURIComponent(target), {requestId:id, ...(method ? {method} : {})});
    const cancelRequested=Boolean(readProgress(storage,id)?.cancelRequested || readProgress(storage,id)?.cancelled);
    let cancelError=false;
    if (cancelRequested && !isTerminal(flow)) {
      try { flow = await api.post('signin/' + encodeURIComponent(flow.flowId) + '/cancel', {}); }
      catch { cancelError=true; }
    }
    writeProgress(storage, id, {...progress, cancelRequested, cancelError, flow});
    onFlow(flow);
    return flow;
  } catch (error) {
    writeProgress(storage, id, {...progress, errorCode: error.code || 'sign_in_failed'});
    throw error;
  }
}
