// One code, one message and one action for "Faravan needs a Docker sign-in" (the sbx identity
// in ~/.wfsbx). Everything that needs Docker (lending, agent checks, agent sign-in) reports this
// instead of a generic "safety check failed", "Check failed" or "Sign-in couldn't start".
export const DOCKER_SIGNED_OUT = 'docker_signed_out';
export const DOCKER_SIGNED_OUT_MESSAGE = "Sign in to Docker to lend.";
export const DOCKER_SIGNIN_REFRESH_MESSAGE = 'The sandbox could not refresh your Docker sign-in. This may be temporary. Open Setup and select Sign in to Docker.';
// Where the fix lives: the setup page's Docker sign-in step.
export const DOCKER_SIGNED_OUT_ACTION = Object.freeze({kind: 'docker-signin', label: 'Sign in to Docker', href: '#/setup', step: 'docker-signin'});

const loginRow = checks => (Array.isArray(checks) ? checks : []).find(check => check?.name === 'docker_login');
/**
 * True when a docker_login row says nothing certain about the sign-in: a read that could not finish, a saved state that cannot be
 * read, a refresh failure that may be temporary, or a working listing that no accepted create backs up.
 */
export const dockerSigninInconclusive = row => Boolean(row) && (row.unknown === true || row.cause === 'docker_signin_state_unavailable' ||
  row.cause === 'docker_signin_refresh_unavailable' || (row.ok === true && row.signinVerified === false && row.createAccepted !== true));
/** True / false when the checks include a conclusive docker_login; null when they do not say. */
export function dockerSignedOutFrom(checks) {
  const row = loginRow(checks);
  return row && !dockerSigninInconclusive(row) ? row.ok !== true : null;
}
/** The fields a client renders for this problem. */
export const dockerProblem = () => ({code: DOCKER_SIGNED_OUT, message: DOCKER_SIGNED_OUT_MESSAGE, action: {...DOCKER_SIGNED_OUT_ACTION}});
/** One safe error for create failures and probes; raw Docker output never enters it. */
export const dockerSignedOutError = () => Object.assign(new Error(DOCKER_SIGNED_OUT_MESSAGE), dockerProblem(), {probe_failure: DOCKER_SIGNED_OUT});

const DOCKER_INSTALLED_CHECKS = ['sbx_install', 'sbx_cli_contract'];
export const DOCKER_RUNNING_CHECKS = ['sbx_daemon', 'docker_runtime', 'kvm_access', 'sbx_credential_store', 'socket_path_length', 'hypervisor_platform'];
const allOf = (checks, names) => {
  const rows = (Array.isArray(checks) ? checks : []).filter(check => names.includes(check?.name));
  if (rows.length === 0) return null;
  if (rows.some(check => check.ok !== true && check.unknown !== true)) return false;
  // A timed-out read leaves the fact unknown (checking), not failed.
  return rows.every(check => check.ok === true) ? true : null;
};
/**
 * The blockers model's Docker inputs, from the preflight checks (BUILD-PLAN S1.1c): installed = sbx_install, sbx_version,
 * sbx_cli_contract; running = the daemon, runtime, virtualization and state-folder checks; signedIn = docker_login;
 * networkPolicy = network_policy. null means the checks do not say, never "ok".
 */
export function dockerFacts(checks) {
  return {
    installed: allOf(checks, DOCKER_INSTALLED_CHECKS),
    running: allOf(checks, DOCKER_RUNNING_CHECKS),
    // A working listing proves no identity: a sign-in not verified by a real create stays unknown, never signed in.
    signedIn: dockerSigninInconclusive(loginRow(checks)) ? null : allOf(checks, ['docker_login']),
    // A finished check that could not tell: the row says so and offers a recheck, it is not a check still running.
    ...(dockerSigninInconclusive(loginRow(checks)) ? (loginRow(checks).checking === true ? {signinChecking: true} : {signinSettled: true}) : {}),
    ...(loginRow(checks)?.ok === true && loginRow(checks).signinVerified === false && loginRow(checks).createAccepted === true ? {signinAccepted: true} : {}),
    ...(loginRow(checks)?.ok === false && loginRow(checks).cause === 'docker_signin_refresh_unavailable' ? {signinDetail: DOCKER_SIGNIN_REFRESH_MESSAGE} : {}),
    networkPolicy: allOf(checks, ['network_policy']),
  };
}

// A remedy that is a button label or a generic prompt is not part of the sentence a row shows.
const BUTTON_REMEDIES = new Set(['Check again', 'Choose Check again.', 'Open Settings', 'Restart Docker Sandboxes', 'Retry network setup',
  'Initialize sandbox network rules', 'Reset sandbox network rules']);
const line = value => typeof value === 'string' ? value.trim() : '';
/** The button a remedy names: its own label when it is one, else Check again. */
export const remedyAction = remedy => BUTTON_REMEDIES.has(line(remedy)) && line(remedy) !== 'Choose Check again.' ? line(remedy) : 'Check again';
/** The remedy as words a row can show: empty for a button label or a prompt, else the instruction itself. */
export const remedyWords = remedy => BUTTON_REMEDIES.has(line(remedy)) ? '' : line(remedy);
/**
 * The one row for a stopped sandbox, from the first failing check that makes `running` false. It says what the app
 * knows about that check and nothing more:
 *  - the service is down and Faravan's own repair runs on every read: `unknown` (working on it), no action;
 *  - a timed-out read, or a repair that asked for a retry: Faravan cannot confirm, so Check again;
 *  - a repair that failed: its own sentence and its real button (Open Settings);
 *  - anything else: the check's own sentence and remedy.
 * null when no running check fails, or when the update-restart row owns the service.
 */
export function dockerStoppedRow(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  for (const name of DOCKER_RUNNING_CHECKS) {
    const check = rows.find(row => row?.name === name);
    if (!check || check.ok === true) continue;
    if (name === 'sbx_daemon' && check.cause === 'daemon_restart_required') continue;
    const label = line(check.label), remedy = line(check.remedy);
    const row = {cause: name, status: 'blocked', action: 'Check again'};
    if (name === 'sbx_daemon') {
      if (check.repair === 'support') return {...row, detail: label || 'Docker Sandboxes could not start the sandbox service.', action: 'Open Settings'};
      if (check.reason === 'machine_checking') return {cause: name, status: 'unknown', detail: label};
      if (check.unknown === true) return {...row, detail: 'Faravan can’t confirm the sandbox service is running.'};
      if (check.repair === 'retry') return {...row, detail: 'The sandbox service check timed out.'};
      if (check.remedy === '' && !check.repair) return {cause: name, status: 'unknown', action: '', detail: 'The sandbox service isn’t running. Faravan is starting it.'};
    }
    const words = remedyWords(remedy);
    return {...row, detail: [label, words && !label.includes(words) ? words : ''].filter(Boolean).join(' ') || 'Docker Sandboxes isn’t ready.'};
  }
  return null;
}

// A damaged refusal record is local storage trouble, not an invitation to sign in again.
export const DOCKER_SIGNIN_STATE_UNAVAILABLE = 'docker_signin_state_unavailable';
export const dockerSignInStateError = () => Object.assign(new Error('Docker sign-in state could not be saved or read. Check access to the app data folder, then restart Faravan.'),
  {code:DOCKER_SIGNIN_STATE_UNAVAILABLE, probe_failure:'probe_unavailable'});
