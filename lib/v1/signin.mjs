import { randomUUID } from 'node:crypto';
import { startSbxDockerLogin } from '../sbx-login.mjs';
import { startProviderGenerationAuth } from '../provider-generation-auth.mjs';
import { AUTH_FLOW_DIAGNOSTIC_REASONS, startAuthFlow } from '../auth-flow.mjs';
import { startGitHubAuthFlow } from '../github-auth.mjs';
import { buildValidatedJobSpec, statusProbeCommand } from '../executor.mjs';
import { FARAVAN_SIGNIN_PROVIDERS } from './lent-claude-credential.mjs';

/**
 * Browser sign-in flows for the v1 app: Docker Sandboxes ("docker"), GitHub
 * ("github") and every adapter whose credential_discovery is a host URL flow.
 * Responses carry only the verification URL, the one-time user code, a status
 * and fixed copy. Process output, tokens and error text never leave this module.
 */
export const SIGNIN_TIMEOUT_MS = 5 * 60_000 + 15_000;
export const SIGNIN_STARTING_STAGES = Object.freeze([
  'backend_health', 'identity_drain', 'adapter_resolution', 'docker_guard',
  'capabilities', 'sandbox_prepare', 'provider_url',
]);
const RETAIN_MS = 10 * 60_000, RETAIN_MAX = 50;
const MESSAGES = Object.freeze({
  starting: 'Preparing sign-in. This can take a little while.',
  awaiting_browser: 'Finish signing in, then return here.',
  complete: 'Signed in.',
  failed: "Sign-in wasn't completed. Try again.",
  cancelled: 'Sign-in cancelled.',
  timed_out: 'Sign-in took too long. Try again.',
});
export const SIGNIN_DIAGNOSTIC_TARGETS = Object.freeze(['codex', 'codex-lending', 'docker']);
export const SIGNIN_DIAGNOSTIC_CODES = Object.freeze([
  ...AUTH_FLOW_DIAGNOSTIC_REASONS,
  'credential_scope_unenforceable',
  'credential_mutation_busy', 'completion_failed', 'startup_failed', 'provider_cli_missing',
  'invalid_url', 'signin_redirect_mismatch', 'codex_device_code_unavailable', 'codex_device_code_rate_limited',
  'codex_device_code_service_unavailable', 'codex_device_code_exchange_failed', 'codex_device_code_expired', 'signin_timeout', 'sandbox_not_ready', 'sandbox_start_failed',
  'sandbox_ready_timeout', 'sandbox_credential_store_failed', 'policy_unenforceable',
  'host_disk_low', 'storage_unenforceable', 'wall_timeout',
  // `sbx login` ended without a sign-in: a class of what it wrote to stderr, never the text.
  'login_browser_unavailable', 'login_keychain', 'login_network', 'login_denied', 'login_other', 'login_no_link',
]);
export const SIGNIN_DIAGNOSTIC_CONDITIONS = Object.freeze([
  'listing_json_invalid', 'listing_command_failed', 'listing_shape_unsupported',
  'environment_credential', 'writer_receipt_untrusted', 'writer_identity_unenforceable',
  'writer_directory_untrusted', 'writer_identity_publication_failed',
  'preparation_lock_unavailable', 'mutation_lock_unavailable', 'other_sandbox_lease',
  'credential_scope_missing', 'unrelated_service_credential', 'scoped_service_global', 'custom_credential',
  'shadowed_service', 'ssh_disable_failed', 'ssh_socket_clear_failed',
  'ssh_forwarding_query_failed', 'ssh_socket_query_failed', 'ssh_forwarding_enabled',
  'ssh_socket_present', 'legacy_provider_secret_global', 'unknown',
]);
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const diagnosticForError = error => {
  if (error?.code === 'credential_scope_unenforceable') return {
    code: 'credential_scope_unenforceable',
    condition: SIGNIN_DIAGNOSTIC_CONDITIONS.includes(error.condition) ? error.condition : 'unknown',
  };
  if (SIGNIN_DIAGNOSTIC_CODES.includes(error?.code)) return { code: error.code };
  return SIGNIN_DIAGNOSTIC_CODES.includes(error?.diagnosticReason)
    ? { code: error.diagnosticReason, ...exitCodeOf(error) }
    : { code: 'startup_failed' };
};
// The exit status of a sign-in command, kept with its class. Only a plain integer leaves.
const exitCodeOf = source => Number.isInteger(source?.exitCode) && source.exitCode >= -1 && source.exitCode <= 255 ? { exitCode: source.exitCode } : {};

/** True when the app can drive this adapter's sign-in from the host (no terminal). */
export const supportsHostSignIn = spec =>
  ['docker-native-oauth','provider-file-generation'].includes(spec.auth_strategy) && spec.credential_discovery?.flow_shape === 'host-url-flow';

/** Starts the selected provider sign-in flow with its own credential scope. */
export async function startProviderSignIn(spec, { backend, onHandle, startFlow, setStage = () => {}, isActive = () => true, method } = {}) {
  startFlow ??= spec.auth_strategy==='docker-native-oauth'?startAuthFlow:startProviderGenerationAuth;
  setStage('capabilities');
  const capabilities = await backend.probeCapabilities();
  if (!isActive()) fail('signin_stopped');
  if (!capabilities.available) fail('sandbox_not_ready');
  if(startFlow===startProviderGenerationAuth){setStage('provider_url');return startFlow(spec,{onHandle,...(method?{method}:{})});}
  const codexProxy = (spec.image ?? spec.install) === 'codex' && spec.auth_strategy === 'docker-native-oauth';
  const jobSpec = buildValidatedJobSpec({ taskDigest: '0'.repeat(64), harness: spec,
    entrypointWithPrompt: statusProbeCommand(spec.harness_id) || 'true',
    ...(codexProxy ? { network: 'disabled' } : {}) });
  let handle, cleanupPromise;
  const cancelled = new WeakMap();
  // Share one removal across completion, cancellation, startup errors and shutdown.
  const cleanup = () => cleanupPromise ??= Promise.resolve().then(() => backend.destroy(handle)).catch(() => {});
  const wrap = flow => ({
    ...flow,
    // Live view of the login: it starts accepting a code after this object is made.
    get acceptsCode() { return flow.acceptsCode === true; },
    submitCode: code => flow.submitCode(code),
    cleanup,
    async waitForCompletion() { try { return await flow.waitForCompletion(); } finally { await cleanup(); } },
    cancel() {
      if (!cancelled.has(flow)) {
        let stopping;
        try { stopping = flow.cancel(); } catch { /* removal must still run */ }
        // All wrappers for the same native flow retain its first drain promise.
        cancelled.set(flow, Promise.resolve(stopping).catch(() => {}).then(cleanup));
      }
      return cancelled.get(flow);
    },
  });
  try {
    setStage('sandbox_prepare');
    handle = codexProxy && backend.prepareSignIn
      ? await backend.prepareSignIn(jobSpec) : await backend.prepare(jobSpec);
    if (!isActive()) fail('signin_stopped');
    setStage('provider_url');
    const flow = await startFlow(spec, { sandboxId: handle.sandbox_id,sbxRuntime:handle._sbxRuntime,
      onHandle: flow => onHandle?.(wrap(flow)) });
    return wrap(flow);
  } catch (error) {
    if (handle) await cleanup();
    throw error;
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<Array<{spec: object}>>} deps.adapters
 * @param {() => object} deps.backend
 * @param {() => Promise<void>} deps.onComplete  refresh agent evidence after a successful sign-in
 * @param {(event: object) => void} [deps.onChange]  receives {flowId,target,status} only
 * @param {(event: {target:string,code:string,elapsedMs:number,condition?:string}) => void} [deps.onDiagnostic]
 *   receives only a supported target, finite reason code, elapsed time and optional finite scope condition
 */
export function createSignin({ adapters, backend, onComplete, onChange = () => {}, timeoutMs = SIGNIN_TIMEOUT_MS,
  onDiagnostic = () => {}, startDocker = startSbxDockerLogin, startGitHub = startGitHubAuthFlow, startProvider = startProviderSignIn,
  now = Date.now, newId = randomUUID, guard = null, beforeStart = null } = {}) {
  const flows = new Map(), active = new Map(), requestFlows = new Map();
  const pendingStarts = new Set(), pendingCleanups = new Set(), cancelledHandles = new WeakSet();
  let closed = false, starting = 0;

  // Only Codex has a second way in: the device code is the default, the loopback browser flow is the other.
  const checkMethod = (target, method) => {
    if (method !== undefined && (method === 'browser' ? target.replace(/-lending$/, '') !== 'codex' : method !== 'device')) fail('invalid_request', 400);
  };
  async function resolveTarget(target, method) {
    if (target === 'docker') return { start: () => startDocker() };
    if (target === 'github') return { start: onHandle => startGitHub({ onHandle }) };
    const lending = target.endsWith('-lending'), id = lending ? target.slice(0, -8) : target;
    const entry = (await adapters()).find(a => a.spec.harness_id === id);
    if (!entry) fail('not_found', 404);
    // Claude and Codex sign in once, through Faravan's own sign-in: it serves the allowance reading and every lent job.
    const spec = Object.hasOwn(FARAVAN_SIGNIN_PROVIDERS, id) ? entry.spec : entry.lendingSpec ?? (lending ? null : entry.spec);
    if (!spec || !supportsHostSignIn(spec)) fail('signin_unsupported');
    return { start: (onHandle, setStage, isActive) => startProvider(spec, { backend: backend(), onHandle, setStage, isActive, ...(method ? { method } : {}) }) };
  }

  function view(flow) {
    return { flowId: flow.id, target: flow.target, status: flow.status,
      ...(['starting', 'failed', 'timed_out'].includes(flow.status) && SIGNIN_STARTING_STAGES.includes(flow.stage) ? { stage: flow.stage } : {}),
      ...(['failed', 'timed_out'].includes(flow.status) && SIGNIN_DIAGNOSTIC_CODES.includes(flow.reasonCode)
        ? { reasonCode: flow.reasonCode } : {}),
      message: flow.status === 'failed' && flow.reasonCode === 'credential_scope_unenforceable'
        ? (flow.condition === 'other_sandbox_lease' ? "Another background check holds the credential lock. Wait a moment, then choose Start sign-in again." : "Faravan could not secure the sign-in credential scope. Contact support before trying again.")
        : MESSAGES[flow.status],
      ...(flow.status === 'awaiting_browser' && flow.url ? { url: flow.url, ...(flow.code ? { code: flow.code } : {}),
        ...(flow.code ? { expiresInMs: Math.max(0, flow.codeExpiresAt - now()) } : {}),
        ...(flow.code && Number.isFinite(flow.expiresAt) ? { expiresAt: flow.expiresAt } : {}),
        ...(flow.handle?.acceptsCode === true ? { codeEntry: true } : {}),
        ...(flow.handle?.acceptsRedirect === true ? { redirectEntry: true } : {}) } : {}) };
  }
  function prune() {
    for (const old of [...flows.values()]) if (old.endedAt !== undefined && now() - old.endedAt >= RETAIN_MS) flows.delete(old.id);
    while (flows.size > RETAIN_MAX) {
      const oldest = [...flows.values()].find(f => f.endedAt !== undefined);
      if (!oldest) break;
      flows.delete(oldest.id);
    }
  }
  function settle(flow, status) {
    if (!['starting', 'awaiting_browser'].includes(flow.status)) return false;
    clearTimeout(flow.timer);
    flow.status = status;
    flow.url = flow.code = undefined;
    flow.endedAt = now();
    if (active.get(flow.target)?.flow === flow) active.delete(flow.target);
    if (['timed_out', 'cancelled'].includes(status)) flow.stopStarting?.(view(flow));
    prune();
    onChange({ flowId: flow.id, target: flow.target, status });
    return true;
  }
  function diagnose(flow, detail) {
    const code = SIGNIN_DIAGNOSTIC_CODES.includes(detail?.code) ? detail.code : 'startup_failed';
    const elapsedMs = Math.max(0, Math.round(now() - flow.startedAt));
    const event = { target: flow.target, code, elapsedMs, ...exitCodeOf(detail), ...(/^login_/.test(code) ? { failureClass: code } : {}) };
    if (['failed', 'timed_out'].includes(flow.status) && SIGNIN_STARTING_STAGES.includes(flow.stage)) event.stage = flow.stage;
    if (code === 'credential_scope_unenforceable') {
      event.condition = SIGNIN_DIAGNOSTIC_CONDITIONS.includes(detail.condition) ? detail.condition : 'unknown';
    }
    try { Promise.resolve(onDiagnostic(event)).catch(() => {}); } catch {}
  }
  function finish(flow, reason = 'authenticated') {
    if (!['starting', 'awaiting_browser'].includes(flow.status)) return;
    if (flow.target === 'docker' && flow.dockerBackend?.confirmDockerSignIn?.(flow.dockerRefusalEpoch) === false) {
      stop(flow, 'failed', 'completion_failed');
      return;
    }
    if (!settle(flow, 'complete')) return;
    diagnose(flow, { code: reason });
    // Refresh is advisory and must never hold a successful POST open.
    Promise.resolve().then(() => onComplete(flow.target)).catch(() => {});
  }
  function trackCleanup(removal) {
    if (removal && typeof removal.then === 'function') {
      const tracked = Promise.resolve(removal).catch(() => {}).finally(() => pendingCleanups.delete(tracked));
      pendingCleanups.add(tracked);
    }
  }
  function cancelHandle(handle) {
    if (!handle || cancelledHandles.has(handle)) return;
    cancelledHandles.add(handle);
    try { trackCleanup(handle.cancel()); } catch { /* already stopped */ }
  }
  function stop(flow, status, reason) {
    if (!['starting', 'awaiting_browser'].includes(flow.status)) return false; // a settled flow keeps its first reason
    if (['failed', 'timed_out'].includes(status)) {
      const detail = typeof reason === 'string' ? { code: reason } : reason;
      flow.reasonCode = SIGNIN_DIAGNOSTIC_CODES.includes(detail?.code) ? detail.code : 'startup_failed';
      flow.condition = SIGNIN_DIAGNOSTIC_CONDITIONS.includes(detail?.condition) ? detail.condition : 'unknown';
    }
    if (!settle(flow, status)) return false;
    if (reason) diagnose(flow, typeof reason === 'string' ? { code: reason } : reason);
    cancelHandle(flow.handle);
    return true;
  }

  async function launch(flow, target, setStage) {
    let handle;
    try {
      handle = await target.start(h => { flow.handle = h; if (flow.status !== 'starting') cancelHandle(h); }, setStage,
        () => flow.status === 'starting');
    } catch (error) {
      if (flow.status !== 'starting') return; // cancelled while starting
      stop(flow, 'failed', diagnosticForError(error));
      fail(error?.code === 'credential_writer_unresolved' ? error.code : 'signin_failed');
    }
    flow.handle = handle;
    if (flow.status !== 'starting') { cancelHandle(handle); return; }
    if (handle.status === 'complete') {
      trackCleanup(handle.cleanup?.());
      finish(flow, SIGNIN_DIAGNOSTIC_CODES.includes(handle.diagnosticReason) ? handle.diagnosticReason : 'authenticated');
      return;
    }
    let url;
    try { url = new URL(handle.url); } catch { /* rejected below */ }
    if (url?.protocol !== 'https:') { stop(flow, 'failed', 'invalid_url'); fail('signin_failed'); }
    flow.url = url.href;
    flow.code = typeof handle.code === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(handle.code) ? handle.code : undefined;
    flow.status = 'awaiting_browser';
    flow.stage = undefined;
    flow.expiresAt = Number.isFinite(handle.expiresAt) ? handle.expiresAt : undefined;
    flow.codeExpiresAt = flow.expiresAt ?? now() + timeoutMs;
    clearTimeout(flow.timer);
    // A device code is good until its own expiry: the flow ends then as timed out, and the expired code leaves the view.
    const expiry = Number.isFinite(handle.expiresAt);
    flow.timer = setTimeout(() => stop(flow, 'timed_out', expiry ? 'codex_device_code_expired' : 'signin_timeout'),
      expiry ? Math.max(0, handle.expiresAt - now()) : timeoutMs);
    flow.timer.unref?.();
    Promise.resolve().then(() => handle.waitForCompletion()).then(
      result => result?.status === 'complete'
        ? finish(flow, SIGNIN_DIAGNOSTIC_CODES.includes(result.diagnosticReason) ? result.diagnosticReason : 'authenticated')
        : result?.diagnosticReason === 'codex_device_code_expired' ? stop(flow, 'timed_out', 'codex_device_code_expired')
        : stop(flow, 'failed', SIGNIN_DIAGNOSTIC_CODES.includes(result?.diagnosticReason)
          ? { code: result.diagnosticReason, ...exitCodeOf(result) } : 'completion_failed'),
      () => stop(flow, 'failed', 'completion_failed'));
  }

  async function start(target, method) {
    starting++;
    try {return await startFlow(target, { wait: true, method });}finally{starting--;}
  }

  async function startFlow(target, { wait = true, requestId, method } = {}) {
    if (closed) fail('signin_closed');
    checkMethod(target, method);
    prune();
    const current = active.get(target);
    if (current) {
      if (requestId) requestFlows.set(requestId, current.flow);
      if (wait) await Promise.race([current.ready, current.stoppedWhileStarting]);
      return view(current.flow);
    }
    const id = requestId || newId();
    if (flows.has(id) || requestFlows.has(id)) fail('signin_request_conflict');
    const flow = { id, target, status: 'starting', stage: 'backend_health', startedAt: now() };
    const setStage = stage => { if (flow.status === 'starting' && SIGNIN_STARTING_STAGES.includes(stage)) flow.stage = stage; };
    let stopStarting;
    const stoppedWhileStarting = new Promise(resolve => { stopStarting = resolve; });
    const entry = { flow, ready: null, stoppedWhileStarting };
    flow.stopStarting = stopStarting;
    active.set(target, entry);
    flows.set(flow.id, flow);
    if (requestId) requestFlows.set(requestId, flow);
    // Bound preparation too. launch() replaces this deadline with the browser window
    // only after a valid verification URL is ready.
    flow.timer = setTimeout(() => stop(flow, 'timed_out', 'signin_timeout'), timeoutMs);
    flow.timer.unref?.();
    entry.ready = (async () => {
      try {
        await beforeStart?.(setStage);
        if (flow.status !== 'starting') return;
        setStage('adapter_resolution');
        const resolved = await resolveTarget(target, method);
        if (flow.status !== 'starting') return;
        // Provider credentials will be consumed by Docker: retain its readiness guard.
        if (target !== 'docker' && target !== 'github') {
          setStage('docker_guard');
          await guard?.(target, setStage);
        }
        if (flow.status !== 'starting') return;
        setStage('provider_url');
        if (target === 'docker') {
          flow.dockerBackend = backend();
          flow.dockerRefusalEpoch = flow.dockerBackend?.signInRefusalEpoch?.() ?? null;
        }
        await launch(flow, resolved, setStage);
      } catch (error) {
        if (flow.status === 'failed') fail(error?.code === 'credential_writer_unresolved' ? error.code : 'signin_failed');
        if (flow.status !== 'starting') return;
        stop(flow, 'failed', diagnosticForError(error));
        throw error?.code ? error : Object.assign(error, { code: 'signin_failed' });
      }
    })();
    // begin() intentionally returns before preparation settles; retain its rejection for
    // synchronous start() callers without producing an unhandled rejection.
    entry.ready.catch(() => {});
    pendingStarts.add(entry.ready);
    entry.ready.then(() => pendingStarts.delete(entry.ready), () => pendingStarts.delete(entry.ready));
    if (wait) await Promise.race([entry.ready, entry.stoppedWhileStarting]);
    return view(flow);
  }
  const get = id => { const flow = flows.get(id) || requestFlows.get(id); if (!flow) fail('not_found', 404); return flow; };

  const cancel = id => { const flow = get(id); stop(flow, 'cancelled', 'cancelled'); return view(flow); };
  return {
    get busy(){return starting>0||active.size>0||pendingStarts.size>0||pendingCleanups.size>0;},
    start,
    cancel,
    get: id => view(get(id)),
    begin: (target, requestId) => startFlow(target, { wait: false, requestId }),
    /** Routes POST /signin/{target}, /signin/{flowId}/cancel and /signin/{flowId}/code; parts excludes the "api" segment. */
    async post(parts, input) {
      if (parts.length === 3 && parts[2] === 'code') {
        if (Object.keys(input).length !== 1 || typeof input.code !== 'string') fail('invalid_request', 400);
        const flow = get(parts[1]);
        if (flow.status === 'awaiting_browser' && flow.handle?.acceptsRedirect === true) {
          try { await flow.handle.submitRedirect(input.code.trim()); }
          catch (error) {
            if (error?.code === 'signin_redirect_mismatch') { diagnose(flow, { code: 'signin_redirect_mismatch' }); fail('signin_redirect_mismatch', 400); }
            fail('signin_code_invalid', 400);
          }
          return view(flow);
        }
        if (flow.status !== 'awaiting_browser' || flow.handle?.acceptsCode !== true) fail('signin_not_waiting_for_code');
        try { flow.handle.submitCode(input.code.trim()); } catch { fail('signin_code_invalid', 400); }
        return view(flow);
      }
      if (parts.length < 2 || parts.length > 3 || (parts.length === 3 && parts[2] !== 'cancel')) fail('invalid_request', 400);
      if (parts.length === 3) {
        if (Object.keys(input).length) fail('invalid_request', 400);
        return cancel(parts[1]);
      }
      const { method, ...rest } = input;
      if (method !== undefined && typeof method !== 'string') fail('invalid_request', 400);
      if (rest.requestId !== undefined) {
        if (Object.keys(rest).length !== 1 || typeof rest.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(rest.requestId)) fail('invalid_request', 400);
        return startFlow(parts[1], { wait: false, requestId: rest.requestId, method });
      }
      if (Object.keys(rest).length) fail('invalid_request', 400);
      return start(parts[1], method);
    },
    /** Cancels every open flow and resolves when their sign-in sandboxes are removed. */
    async close() {
      closed = true;
      for (const flow of [...active.values()].map(e => e.flow)) stop(flow, 'cancelled', 'cancelled');
      // Startup can hand us a new cancellable handle after close has begun.
      await Promise.allSettled([...pendingStarts]);
      while (pendingCleanups.size) await Promise.allSettled([...pendingCleanups]);
    },
  };
}
