import {currentSbxRuntime,hostDefaultSbxRuntime,withSbxRuntime} from './sbx-runtime.mjs';
/** Structured Docker device-login flow for the Faravan sbx identity. */
import { setTimeout as delay } from 'node:timers/promises';
import { ensureSbxDaemon, probeSbxPreflight, sbxChildEnv, spawnSbxChild } from './docker-backend.mjs';

export class SbxLoginError extends Error {
  // `diagnosticReason` is one of the closed sign-in diagnostic codes; `exitCode` is the process exit status or null.
  constructor(message, { diagnosticReason, exitCode = null } = {}) {
    super(message); this.name = 'SbxLoginError';
    if (diagnosticReason) { this.diagnosticReason = diagnosticReason; this.failureClass = diagnosticReason; }
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  }
}

/**
 * The closed class of what `sbx login` wrote to stderr. Only the class leaves this function: the text can carry paths,
 * account names or codes, so it is never stored.
 */
export function classifyLoginStderr(text) {
  const t = String(text ?? '');
  if (/xdg-open|could not open (?:a |the )?browser|failed to open (?:a |the )?browser|unable to open (?:a |the )?browser|no (?:web )?browser|exec: "open"|\bopen: /i.test(t)) return 'login_browser_unavailable';
  if (/keychain|keyring|secret service|secret not found|errSec|credential store|credentials? helper/i.test(t)) return 'login_keychain';
  if (/timed? ?out|no such host|connection refused|network is unreachable|dial tcp|TLS|certificate|EOF/i.test(t)) return 'login_network';
  if (/denied|forbidden|unauthori[sz]ed|access_denied|expired|invalid (?:grant|code)/i.test(t)) return 'login_denied';
  return 'login_other';
}

function sbxBin() {
  return process.env.FARAVAN_SBX_BIN || 'sbx';
}

function stop(child) {
  try { child.kill('SIGTERM'); } catch { /* already exited */ }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 1_000);
  child.once('exit', () => clearTimeout(timer));
}

/**
 * The device-activation link from `sbx login` output. sbx 0.48 prints a terms link first
 * ("…see https://www.docker.com/legal/…"), so the first URL is not the sign-in link.
 */
export function signInUrl(output) {
  const labelled = /open this url to sign in:\s*(https:\/\/\S+)/i.exec(output)?.[1];
  if (labelled) return labelled;
  return [...output.matchAll(/https:\/\/\S+/g)].map((m) => m[0])
    .find((u) => { try { const h = new URL(u).hostname; return h === 'login.docker.com' || h.endsWith('.login.docker.com'); } catch { return false; } });
}

/**
 * A cheap negative/availability hint. A listing can work without a Docker account, so success
 * is deliberately null, never proof of sign-in. Only the login flow or an independent
 * injected status check can confirm authentication.
 */
export async function probeSbxSignedIn({ env = sbxChildEnv(), bin = sbxBin(), timeoutMs = 10_000 } = {}) {
  let runtime;
  try{runtime=currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary:bin,env});}catch{return null;}
  await withSbxRuntime(runtime,()=>ensureSbxDaemon({env,bin}));
  return new Promise((resolve) => {
    const child = spawnSbxChild(runtime, ['ls', '-q'], {mode:'callback',callback: (error, stdout, stderr) => {
      if (!error) return resolve(null);
      resolve(/not signed in|not authenticated|sbx login/i.test(`${stdout}\n${stderr}`) ? false : null);
    }, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    child.stdin?.end();
  });
}

/**
 * Runs `sbx login` in Waspflow's profile and returns its browser handoff.
 * Completion is proven by a fresh preflight, not by a browser click or text.
 */
export async function startSbxDockerLogin({
  spawnProcess,
  probe = probeSbxPreflight,
  signedIn = probeSbxSignedIn,
  platformName = process.platform,
  env: suppliedEnv,
  loginBin = sbxBin(),
  urlTimeoutMs = 15_000,
  completionTimeoutMs = 5 * 60_000,
  pollIntervalMs = 500,
} = {}) {
  // A caller-supplied env is the whole child environment, so it is also what the runtime fence compares against.
  const env=suppliedEnv??sbxChildEnv();
  const runtime=currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:suppliedEnv?()=>suppliedEnv:sbxChildEnv,binary:loginBin,env});
  await withSbxRuntime(runtime,()=>ensureSbxDaemon({env,bin:loginBin}));
  const child = spawnSbxChild(runtime,['login'],{mode:'spawn',env,stdio:['ignore','pipe','pipe']},spawnProcess?{spawn:spawnProcess}:undefined);
  let output = '';
  let exited = false;
  let exitCode = null;
  let errorOutput = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8'); });
  // Only the last part is kept, and only to be classified.
  child.stderr?.on('data', (chunk) => { errorOutput = (errorOutput + chunk.toString('utf8')).slice(-8192); });
  const exitSignal = new Promise((resolve) => child.once('exit', (code) => { exited = true; exitCode = code; resolve(); }));

  const confirmed = () => withSbxRuntime(runtime,async () => {
    // A listing/preflight alone cannot confirm login. A clean login exit or a real
    // positive status check is required before the readiness confirmation.
    const quick = await signedIn({ env }).catch(() => null);
    if (quick === false) return false;
    if (quick !== true && !(exited && exitCode === 0)) return false;
    const preflight = await probe({ platformName, env });
    return preflight.checks.find((item) => item.name === 'docker_login')?.ok === true;
  });
  const deadline = Date.now() + urlTimeoutMs;
  let url;
  let code;
  while (Date.now() < deadline) {
    url = signInUrl(output);
    code = /one-time device confirmation code is:\s*([A-Z0-9-]+)/i.exec(output)?.[1];
    if (url) break;
    if (exited) {
      // `sbx login` on a signed-in identity prints "You are signed in" and exits 0 without a link: nothing to do.
      if (exitCode === 0 && await confirmed()) {
        return { status: 'complete', cancel: () => {}, waitForCompletion: async () => ({ status: 'complete', detail: 'Docker sign-in was confirmed.' }) };
      }
      throw new SbxLoginError(`Docker sign-in ended before showing a browser link${exitCode === 0 ? '.' : ` (exit ${exitCode ?? 'unknown'}).`}`,
        { diagnosticReason: exitCode === 0 ? 'login_no_link' : classifyLoginStderr(errorOutput), exitCode });
    }
    await delay(25);
  }
  if (!url) {
    stop(child);
    throw new SbxLoginError('Docker sign-in did not provide a browser link.', { diagnosticReason: 'login_no_link', exitCode });
  }

  return {
    url,
    ...(code ? { code } : {}),
    cancel: () => stop(child),
    waitForCompletion: async () => {
      const completionDeadline = Date.now() + completionTimeoutMs;
      while (Date.now() < completionDeadline) {
        if (await confirmed()) {
          stop(child);
          return { status: 'complete', detail: 'Docker sign-in was confirmed.' };
        }
        if (exited && exitCode !== 0) return { status: 'failed', detail: 'Docker sign-in stopped before it was confirmed.',
          diagnosticReason: classifyLoginStderr(errorOutput), exitCode };
        // A clean exit of `sbx login` means the person approved: check again at once instead of waiting a poll.
        await (exited ? delay(pollIntervalMs) : Promise.race([delay(pollIntervalMs), exitSignal]));
      }
      stop(child);
      return { status: 'failed', detail: 'Docker sign-in timed out before it was confirmed.' };
    },
  };
}
