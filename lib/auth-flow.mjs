/**
 * Waspflow-driven auth flow (auth UX reframe, 2026-07-20).
 *
 * Prior shape: HarnessSpec.credential_discovery.login_command was presented
 * to the OPERATOR as an instruction ("run this yourself"). The owner
 * corrected this model on three points:
 *
 *   (a) Waspflow RUNS the sbx auth command itself; the user does ONLY the
 *       browser part. Never "go type this in your shell."
 *   (b) Detect-first: check the prepared job sandbox's harness-defined
 *       status probe before triggering anything. Only start a login flow
 *       when a job actually needs a provider that isn't authed yet. Never
 *       re-prompt once set.
 *   (c) Not terminal-bound: the packaging target is an installed app
 *       (clawmeter-style), not a forced terminal. The auth step must emit a
 *       structured event {url, waitForCompletion} that a future non-terminal
 *       UI can render — never architected AS a terminal command, even though
 *       v0's own test harness happens to run in one.
 *
 * This module is the structured interface. `startAuthFlow()` returns an
 * AuthFlowHandle whose shape is stable regardless of what eventually
 * consumes it (a v0 terminal script today; a tray/GUI notification later).
 * It does NOT print anything itself — callers decide how to render
 * `handle.url`. See scripts/harness-auth-proof-live-run.sh for
 * the v0 terminal rendering of this same interface.
 *
 * A host-url-flow command may be host-side (Codex's sbx secret command) or
 * guest-side (Claude's CLI command). Guest-side commands run through `sbx
 * exec` in the prepared job sandbox; success is always proved by the
 * harness-defined status probe, never inferred from a browser click.
 */
import {currentSbxRuntime,hostDefaultSbxRuntime,withSbxRuntime} from './sbx-runtime.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSbxChild, credentialStoreEnv, ensureSbxDaemon, sanitizedEnv, suppressChildBrowserLaunch } from './docker-backend.mjs';
import { acquireCredentialMutation, spawnCredentialWriter } from './sandbox-credentials.mjs';
import { createDockerProxySource } from './credential-generations.mjs';

// A freshly-created Docker secret can take substantially longer than a normal
// browser handoff before it prints its URL.  Fifteen seconds made the UI turn
// a slow-but-valid first run into a false failure and left the underlying
// listener alive long enough to make the next attempt conflict.
export const DEFAULT_LOGIN_URL_TIMEOUT_MS = 75_000;
export const AUTH_FLOW_DIAGNOSTIC_REASONS = Object.freeze([
  'already_authenticated', 'existing_credential_prompt', 'writer_spawn_failed',
  'credential_writer_unresolved', 'child_exit_before_url', 'url_timeout', 'cancelled',
  'guest_not_authenticated', 'completion_timeout', 'authenticated',
]);

export class AuthFlowError extends Error {
  constructor(message, diagnosticReason) {
    super(message);
    this.name = 'AuthFlowError';
    if (AUTH_FLOW_DIAGNOSTIC_REASONS.includes(diagnosticReason)) {
      Object.defineProperty(this, 'diagnosticReason', { value: diagnosticReason });
    }
  }
}

/**
 * @typedef {object} AuthFlowHandle
 * @property {string} harness_id
 * @property {'pending'|'awaiting-browser'|'complete'|'failed'|'cancelled'} status
 * @property {string} [url]            present once parsed from the command's output
 * @property {() => Promise<{status: 'complete'|'failed', detail: string}>} waitForCompletion
 * @property {() => Promise<void>} cancel  synchronously fences cancellation, then drains owned processes and the lease
 */

/**
 * Checks whether a harness's provider secret is already set in the
 * Waspflow-scoped sbx profile, WITHOUT triggering any login flow. This
 * remains useful to callers that can decide before creating a job;
 * startAuthFlow() also performs the authoritative per-job status probe.
 *
 * @param {import('./harness-spec.mjs').HarnessSpec} harnessSpec
 * @param {{sbxBin?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [opts]
 * @returns {Promise<{alreadySet: boolean, raw: string}>}
 */
export function isProviderSecretSet(harnessSpec,opts={}){
  const env=sandboxEnv(opts.env??process.env);
  const runtime=opts.sbxRuntime??currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:()=>sandboxEnv(process.env),binary:opts.sbxBin??process.env.FARAVAN_SBX_BIN??'sbx',env});
  return withSbxRuntime(runtime,()=>providerSecretSet(harnessSpec,opts));
}
async function providerSecretSet(harnessSpec, opts = {}) {
  const sbxBin = opts.sbxBin || process.env.FARAVAN_SBX_BIN || 'sbx';
  const env = sandboxEnv(opts.env || process.env);
  const args = ['secret', 'ls', '-g', '--service', harnessSpec.provider_service_id];
  await ensureSbxDaemon({ env, bin: sbxBin });
  const raw = await runAndCapture(sbxBin, args, { env, timeoutMs: opts.timeoutMs ?? 10_000 });
  // `sbx secret ls` has no --json output as of v0.35.0 (confirmed against a
  // real install); "No secrets found for scope ... and service ..." is the
  // documented empty-result text. Absence of that exact phrase, combined
  // with non-empty output, means a secret line was printed.
  const alreadySet = raw.trim().length > 0 && !/No secrets found/i.test(raw);
  return { alreadySet, raw };
}

/**
 * Starts a `docker-native-oauth` / `host-url-flow` login, driven entirely by
 * waspflow. The caller (a v0 terminal script, or eventually a tray/GUI) is
 * handed a structured handle — it never sees or types the raw `sbx` command.
 *
 * @param {import('./harness-spec.mjs').HarnessSpec} harnessSpec
 * @param {{sandboxId: string, sbxBin?: string, env?: NodeJS.ProcessEnv, urlTimeoutMs?: number, completionTimeoutMs?: number, pollIntervalMs?: number, leaseWaitMs?: number, onHandle?: (handle: AuthFlowHandle) => void}} opts
 * @returns {Promise<AuthFlowHandle>}
 */
// "Paste code here if prompted >" (Claude Code 2.1). Codes are URL-safe characters, often "code#state".
const CODE_PROMPT = /paste (the )?code here/i;
const PASTED_CODE = /^[A-Za-z0-9#_.~-]{8,512}$/;

export async function startAuthFlow(harnessSpec,opts={}){
  const env=sandboxEnv(opts.env??process.env);
  const runtime=opts.sbxRuntime??currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:()=>sandboxEnv(process.env),binary:opts.sbxBin??process.env.FARAVAN_SBX_BIN??'sbx',env});
  const flow=await withSbxRuntime(runtime,()=>startQualifiedAuthFlow(harnessSpec,opts));
  for(const name of ['cancel','waitForCompletion'])if(typeof flow[name]==='function'){const method=flow[name].bind(flow);flow[name]=(...args)=>withSbxRuntime(runtime,()=>method(...args));}
  return flow;
}
async function startQualifiedAuthFlow(harnessSpec, opts = {}) {
  if (harnessSpec.auth_strategy !== 'docker-native-oauth') {
    throw new AuthFlowError(`startAuthFlow only drives docker-native-oauth harnesses; '${harnessSpec.harness_id}' is '${harnessSpec.auth_strategy}'`);
  }
  if (harnessSpec.credential_discovery.flow_shape !== 'host-url-flow') {
    throw new AuthFlowError(
      `startAuthFlow only drives 'host-url-flow' — '${harnessSpec.harness_id}' is '${harnessSpec.credential_discovery.flow_shape}', which requires an ` +
      `interactive fallback (see describeAuthRequirement() for the honest description of that case).`
    );
  }
  if (typeof opts.sandboxId !== 'string' || !opts.sandboxId) {
    throw new AuthFlowError(`startAuthFlow requires the prepared job sandbox for '${harnessSpec.harness_id}'`);
  }

  const sbxBin = opts.sbxBin || process.env.FARAVAN_SBX_BIN || 'sbx';
  const env = sandboxEnv(opts.env || process.env);
  const urlTimeoutMs = opts.urlTimeoutMs ?? DEFAULT_LOGIN_URL_TIMEOUT_MS;
  const completionTimeoutMs = opts.completionTimeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const provider = ({codex:'codex','claude-code-subscription':'claude'})[harnessSpec.harness_id];
  if (!provider) throw new AuthFlowError(`startAuthFlow does not support harness '${harnessSpec.harness_id}'`);

  if (await probeReportsSuccess(harnessSpec, opts.sandboxId, { sbxBin, env, timeoutMs: 10_000 })) {
    return {
      harness_id: harnessSpec.harness_id,
      status: 'complete',
      diagnosticReason: 'already_authenticated',
      waitForCompletion: async () => ({ status: 'complete', detail: 'already authenticated' }),
      cancel: (() => { const stopped = Promise.resolve(); return () => stopped; })(),
    };
  }
  // Background identity and safety checks hold short sandbox leases. Sign-in
  // stops new checks while it runs, so wait for running ones to end.
  const releaseCredentials = await (opts.acquireCredentialMutation ?? acquireCredentialMutation)(env.HOME, { sandboxId: opts.sandboxId, isolatedSources: true, leaseWaitMs: opts.leaseWaitMs ?? 90_000 });
  let releasePromise;
  const releaseOnce = () => releasePromise ??= Promise.resolve().then(() => releaseCredentials()).catch(() => {
    // Fixed text only: lease errors can contain private paths or credential details.
    try { (opts.log ?? console.error)('Credential lease release failed; check sign-in diagnostics before retrying.'); } catch {}
  });
  let child;
  let writerStopped = Promise.resolve(), writerClosed = false, cancelTimer, cancelPromise, cleanupPromise;
  // True only once waitForCompletion has published its result; a killed
  // writer can set status to failed earlier, while release is still pending.
  let completionSettled = false;
  const commands = new Set();
  const lifetime = new AbortController();
  const proofOptions = { sbxBin, env, timeoutMs: 10_000, commands, signal: lifetime.signal };
  const drainCommands = async () => {
    const active = [...commands];
    for (const command of active) command.cancel();
    await Promise.all(active.map(command => command.stopped));
  };
  const disposers = [];
  const listen = (emitter, event, listener, once = false) => {
    emitter[once ? 'once' : 'on'](event, listener);
    disposers.push(() => emitter.removeListener(event, listener));
  };
  const signalGroup = (signal) => {
    if (child) try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
  };
  const cleanup = (kill = true) => {
    if (kill && !writerClosed) signalGroup('SIGKILL');
    return cleanupPromise ??= (async () => {
      lifetime.abort();
      await drainCommands();
      await writerStopped;
      clearTimeout(cancelTimer);
      for (const dispose of disposers) dispose();
      await releaseOnce();
    })();
  };
  let handedOff = false;
  try {
  const words = harnessSpec.credential_discovery.login_command.split(' ');
  const hostSecretWriter = words[0] === 'sbx' && words[1] === 'secret' && words[2] === 'set';
  // Snapshot while holding the mutation lease, before this attempt can write.
  // An unreadable snapshot cannot prove that a later listing is new.
  const previousSecrets = hostSecretWriter ? await hostSecretLines(harnessSpec, proofOptions) : null;
  const args = words[0] === 'sbx'
    ? words.slice(1)
    : ['exec', '-i', opts.sandboxId, '--', ...words]; // -i: a login that asks for a pasted code reads it from stdin
  // detached: the child leads its own process group, so cancel() can signal the sbx helpers
  // it started as well as sbx itself. Signalling only the direct child left those helpers
  // running (the test suite caught a `sleep` left behind after cancel).
  const source = await createDockerProxySource(env.HOME, provider, harnessSpec.provider_service_id);
  try {
    await ensureSbxDaemon({ env, bin: sbxBin });
    child = await spawnCredentialWriter(env.HOME, sbxBin, args, {
      sbxRuntime:currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:()=>sandboxEnv(process.env),binary:sbxBin,env}),
      env,
      credentialIsolation: { kind: 'docker-proxy-source', id: source.id },
    });
  } catch (error) {
    const reason = error?.code === 'credential_writer_unresolved' ? 'credential_writer_unresolved' : 'writer_spawn_failed';
    const failure = new AuthFlowError('The credential writer could not be started.', reason);
    if (error?.code === 'credential_writer_unresolved') failure.code = error.code;
    throw failure;
  }
  // A helper can outlive the OAuth leader. End its entire process group
  // before allowing a job to publish a credential lease.
  writerStopped = new Promise(resolve => {
    const stopHelpers = () => {
      signalGroup('SIGKILL');
      clearTimeout(cancelTimer);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    listen(child, 'exit', stopHelpers, true);
    listen(child, 'error', stopHelpers, true);
    listen(child, 'close', () => { writerClosed = true; clearTimeout(cancelTimer); resolve(); }, true);
  });
  // Writer exit stops helpers, but is not permission for another writer yet:
  // the final read-only proof must observe the store under this same lease.

  /** @type {AuthFlowHandle} */
  const handle = {
    harness_id: harnessSpec.harness_id,
    status: 'pending',
    url: undefined,
    waitForCompletion: undefined, // assigned below once we can build the promise
    cancel: () => {
      if (cancelPromise) return cancelPromise;
      // Settled success/failure remains terminal. During release, cancellation
      // still fences publication even if the writer has already exited.
      if (!completionSettled) handle.status = 'cancelled';
      if (!writerClosed && child.exitCode === null && child.signalCode === null) {
        signalGroup('SIGTERM');
        cancelTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
        cancelTimer.unref();
      }
      return cancelPromise = cleanup(false);
    },
  };
  // Some logins (Claude Code) finish by asking the person to paste a code shown in the browser.
  handle.acceptsCode = false;
  handle.submitCode = (code) => {
    if (!handle.acceptsCode || handle.status !== 'awaiting-browser') throw new AuthFlowError('this sign-in is not waiting for a code');
    if (typeof code !== 'string' || !PASTED_CODE.test(code)) throw new AuthFlowError('that does not look like a sign-in code');
    child.stdin.write(code + '\n');
  };
  // The URL can be slow on a first Docker-secret setup. Publish cancellation
  // as soon as the child exists so a retry never has to wait for that URL
  // timeout before it can clean up the stale listener.
  opts.onHandle?.(handle);

  let stdoutBuf = '';
  let stderrBuf = '';
  const urlPattern = new RegExp(harnessSpec.credential_discovery.url_prompt_pattern, 'i');
  const urlLineExtract = /https?:\/\/\S+/;
  const existingCredentialPrompt = /OAuth token already exists\.\s*Overwrite\?/i;

  const urlReady = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const captureUrl = () => {
      // sbx and the underlying provider disagree on which stream carries
      // progress output. Treat the two streams as one human-facing transcript:
      // a valid URL on stderr is just as actionable as one on stdout.
      const output = `${stdoutBuf}\n${stderrBuf}`;
      if (existingCredentialPrompt.test(output)) {
        finish(reject, new AuthFlowError(
          'An existing OpenAI OAuth credential needs attention before another sign-in can start. It was not accepted by the sandbox status check; remove or refresh it, then try again.',
          'existing_credential_prompt'));
        return;
      }
      if (CODE_PROMPT.test(output)) handle.acceptsCode = true;
      if (!handle.url && urlPattern.test(output)) {
        const match = urlLineExtract.exec(output);
        if (match) {
          handle.url = match[0];
          if (handle.status !== 'cancelled') handle.status = 'awaiting-browser';
          finish(resolve, handle.url);
        }
      }
    };
    listen(child.stdout, 'data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      captureUrl();
    });
    listen(child.stderr, 'data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      captureUrl();
    });
    listen(child, 'error', (error) => finish(reject, new AuthFlowError(`failed to spawn '${sbxBin}': ${error.message}`, 'writer_spawn_failed')));
    listen(child, 'exit', (code) => {
      if (!handle.url) finish(reject, new AuthFlowError(
        handle.status === 'cancelled' ? 'login URL wait was cancelled' : code === 0
          ? 'login command exited before producing a URL'
          : `exited ${code}: ${(stderrBuf || stdoutBuf).trim()}`,
        handle.status === 'cancelled' ? 'cancelled' : 'child_exit_before_url',
      ));
    });
  });

  let completionTimedOut = false;
  const completion = new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    listen(child, 'error', (error) => {
      if (handle.status !== 'cancelled') handle.status = 'failed';
      settle({ status: 'failed', diagnosticReason: 'writer_spawn_failed', detail: `failed to spawn '${sbxBin}': ${error.message}` });
    });
    listen(child, 'exit', (code) => {
      // A SIGKILLed child's stdio pipes can otherwise keep Node's event
      // loop alive indefinitely (observed directly: a killed child left the
      // process hanging until an external `timeout` intervened, even though
      // the 'exit' event itself fired correctly) — explicitly release them.
      child.stdout.destroy();
      child.stderr.destroy();
      if (handle.status === 'cancelled') {
        settle({ status: 'failed', diagnosticReason: completionTimedOut ? 'completion_timeout' : 'cancelled', detail: 'cancelled before completion' });
        return;
      }
      if (code !== 0) {
        handle.status = 'failed';
        settle({ status: 'failed', diagnosticReason: 'guest_not_authenticated', detail: `exited ${code}: ${(stderrBuf || stdoutBuf).trim()}` });
        return;
      }
      // The login command finished cleanly. The sandbox probe alone cannot
      // confirm a host-side sbx secret: a sandbox gets its credential mode
      // when it is created, so the sandbox prepared before sign-in never
      // reports the new secret. Confirm from Docker's secret store instead.
      settle({ status: 'writer_exited' });
    });
  });

  const cancelledResult = () => ({ status: 'failed',
    diagnosticReason: completionTimedOut ? 'completion_timeout' : 'cancelled', detail: 'cancelled before completion' });
  let completionPromise;
  const waitForCompletion = async () => {
    // Use an AbortController so the losing side of the race is actually
    // cancelled — an uncleared node:timers/promises setTimeout keeps the
    // event loop alive for its full duration even after the other side
    // wins, which would otherwise make every caller's process hang.
    const timeoutController = new AbortController();
    const abortTimeout = () => timeoutController.abort();
    lifetime.signal.addEventListener('abort', abortTimeout, { once: true });
    if (lifetime.signal.aborted) abortTimeout();
    const timeoutPromise = delay(completionTimeoutMs, undefined, { signal: timeoutController.signal })
      .then(() => {
        const reason = `timed out after ${completionTimeoutMs}ms waiting for the browser step to complete`;
        completionTimedOut = true;
        handle.cancel();
        return { status: 'failed', diagnosticReason: 'completion_timeout', detail: reason };
      })
      .catch(() => null); // aborted — completion() won the race, ignore
    try {
      while (!lifetime.signal.aborted) {
        const result = await Promise.race([
          completion,
          timeoutPromise,
          probeReportsSuccess(harnessSpec, opts.sandboxId, proofOptions)
            .then((success) => success ? { status: 'complete', diagnosticReason: 'authenticated', detail: 'status probe reported authenticated' } : null),
        ]);
        await drainCommands(); // Stop the losing race probe before final proof or release.
        if (handle.status === 'cancelled') return cancelledResult();
        if (result?.status === 'writer_exited') {
          const confirmed = await probeReportsSuccess(harnessSpec, opts.sandboxId, proofOptions) ||
            (hostSecretWriter && await hostSecretStored(harnessSpec, proofOptions, previousSecrets));
          if (handle.status === 'cancelled') return cancelledResult();
          return confirmed
            ? { status: 'complete', diagnosticReason: 'authenticated', detail: 'login command finished and the credential is stored' }
            : { status: 'failed', diagnosticReason: 'guest_not_authenticated', detail: 'login command finished but no credential was found' };
        }
        if (result) {
          signalGroup('SIGKILL');
          if (handle.status === 'cancelled') return cancelledResult();
          return result;
        }
        await delay(pollIntervalMs, undefined, { signal: lifetime.signal }).catch(() => {});
      }
      return cancelledResult();
    } finally {
      // The browser deadline ends at accepted proof, not after lease cleanup.
      // Explicit cancellation remains fenced by the wrapper after cleanup.
      timeoutController.abort();
      lifetime.signal.removeEventListener('abort', abortTimeout);
      await cleanup();
    }
  };
  handle.waitForCompletion = () => completionPromise ??= waitForCompletion().then(result => {
    completionSettled = true;
    if (handle.status === 'cancelled') return cancelledResult();
    handle.status = result.status;
    return result;
  });

  const urlTimeoutController = new AbortController();
  const urlTimeout = delay(urlTimeoutMs, undefined, { signal: urlTimeoutController.signal })
    .then(() => { throw new AuthFlowError(`timed out after ${urlTimeoutMs}ms waiting for a login URL to appear`, 'url_timeout'); })
    .catch((error) => {
      if (error?.name === 'AbortError') return null;
      throw error;
    });
  try {
    const result = await Promise.race([urlReady, urlTimeout]);
    if (result === null) throw new AuthFlowError('login URL wait was cancelled');
  } catch (error) {
    handle.cancel();
    throw error;
  } finally {
    urlTimeoutController.abort();
  }
  handedOff = true;
  return handle;
  } finally {
    if (!handedOff) await cleanup();
  }
}

async function probeReportsSuccess(harnessSpec, sandboxId, { sbxBin, env, timeoutMs, commands, signal }) {
  await ensureSbxDaemon({ env, bin: sbxBin });
  const raw = await runAndCapture(sbxBin, ['exec', sandboxId, '--', 'sh', '-c', harnessSpec.login_status_probe.command], { env, timeoutMs, commands, signal })
    .catch(() => '');
  let values = {};
  try { values = JSON.parse(raw); } catch {
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
  }
  return Object.entries(harnessSpec.login_status_probe.success).every(([key, value]) => values[key] === value);
}

/**
 * For flow_shapes startAuthFlow cannot drive (interactive-session-flow),
 * returns an honest structured description instead of forcing a false
 * {url, waitForCompletion} shape. A caller (terminal or future UI) uses this
 * to render "attach to a sandbox session and run /login" rather than a URL
 * prompt that doesn't exist for this harness.
 *
 * @param {import('./harness-spec.mjs').HarnessSpec} harnessSpec
 * @returns {{drivable: boolean, flow_shape: string, instruction?: string}}
 */
export function describeAuthRequirement(harnessSpec) {
  const shape = harnessSpec.credential_discovery?.flow_shape;
  if (harnessSpec.auth_strategy === 'docker-native-oauth' && shape === 'host-url-flow') {
    return { drivable: true, flow_shape: shape };
  }
  if (harnessSpec.auth_strategy === 'docker-native-oauth' && shape === 'interactive-session-flow') {
    return {
      drivable: false,
      flow_shape: shape,
      instruction: `Attach an interactive sandbox session (sbx run ${harnessSpec.install}) and run '${harnessSpec.credential_discovery.login_command}' inside it. Waspflow cannot drive this host-side — there is no URL to capture.`,
    };
  }
  return { drivable: false, flow_shape: shape ?? 'n/a', instruction: `'${harnessSpec.harness_id}' does not use a docker-native-oauth login flow (strategy: ${harnessSpec.auth_strategy}).` };
}

// Only a new/changed provider OAuth line is evidence for this attempt.
async function hostSecretLines(harnessSpec, { sbxBin, env, commands, signal }) {
  await ensureSbxDaemon({ env, bin: sbxBin });
  const service = harnessSpec.provider_service_id;
  const raw = await runAndCapture(sbxBin, ['secret', 'ls', '-g', '--service', service], { env, timeoutMs: 10_000, commands, signal }).catch(() => null);
  return raw === null ? null : raw.split(/\r?\n/).map(line => line.trim())
    .filter(line => line.split(/\s+/).includes(service) && /oauth/i.test(line));
}
async function hostSecretStored(harnessSpec, options, previous) {
  if (previous === null) return false;
  const current = await hostSecretLines(harnessSpec, options);
  return current?.some(line => !previous.includes(line)) === true;
}

function runAndCapture(command, args, { env, timeoutMs, commands, signal }) {
  if (signal?.aborted) return Promise.reject(new AuthFlowError('Credential status command was cancelled.'));
  const child = spawnSbxChild(currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:()=>sandboxEnv(process.env),binary:command,env}),args,{mode:'spawn',env,detached:true,signal});
  let out = '', err = '', failure, timer, killTimer, closed = false, cancelling = false, stopped;
  const signalGroup = signal => {
    if (child.pid) try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  };
  const cancel = () => {
    if (closed || cancelling) return;
    cancelling = true;
    failure ??= new AuthFlowError('Credential status command was cancelled.');
    clearTimeout(timer);
    clearTimeout(killTimer);
    signalGroup('SIGKILL');
  };
  const onOut = chunk => { out += chunk.toString('utf8'); };
  const onErr = chunk => { err += chunk.toString('utf8'); };
  const onError = error => { failure ??= error; };
  const onExit = () => {
    // Helpers may hold inherited pipes after the leader exits.
    signalGroup('SIGKILL');
    clearTimeout(timer);
    clearTimeout(killTimer);
    child.stdin?.destroy();
    // Keep output pipes until close: the process group must stop before the
    // command result (and its stopped promise) can settle.
  };
  const result = new Promise((resolve, reject) => {
    stopped = new Promise(done => {
      child.once('close', code => {
        closed = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', cancel);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        child.stdout.removeListener('data', onOut);
        child.stderr.removeListener('data', onErr);
        commands?.delete(result);
        done();
        if (failure) reject(failure);
        else if (code !== 0) reject(new AuthFlowError('Credential status command did not complete successfully.'));
        else resolve(out || err);
      });
    });
    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      failure = new AuthFlowError('Credential status command timed out.');
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
    }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  result.cancel = cancel;
  result.stopped = stopped;
  commands?.add(result);
  return result;
}

function sandboxEnv(baseEnv) {
  // MUST resolve the sbx identity exactly like the backend that CREATED the
  // job sandbox (sbxChildEnv: the isolated Waspflow sbx home with the
  // short-path/legacy selection logic). A prior revision fell back to the
  // user's REAL HOME, so the login `sbx exec` talked to the PERSONAL sbx
  // daemon — which has never heard of the job's sandbox — failing
  // "no sandbox named <id>" on every fresh contribute (found live on both a
  // fresh VM and the host). One resolver, one identity.
  const env = sanitizedEnv(baseEnv);
  Object.assign(env, credentialStoreEnv());
  // Same rationale as sbxChildEnv: login children must not pop the desktop
  // browser; their URLs surface in the Faravan UI instead.
  return suppressChildBrowserLaunch(env);
}
