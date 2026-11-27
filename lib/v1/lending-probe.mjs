import {createProbeDiagnostics,probeDiagnosticFields} from './probe-diagnostics.mjs';
/**
 * Idle allowance probe through the sandbox proxy (LENDING-POLICY-DESIGN.md D2 path 2; Phase 0 probe 2 and Codex probe 2).
 *
 * The probe runs ONE GET from inside a normal Faravan sandbox with the documented placeholder bearer. The sandbox
 * proxy injects the lent account's real token; Faravan never reads, writes, copies or refreshes a credential, and
 * never reads host logs. The guest script prints only a projection of permitted fields (no account id, e-mail or
 * user id), and the host re-validates it with the lending-meter parsers, because guest output is untrusted.
 *
 *   const probe = createLendingProbe({ runGuest, ledger, now });
 *   await probe.probe('claude')   -> { ok, readings?, reason? }
 *   probe.due('codex', { autoLending, jobRunning, pageOpen })  -> boolean   (cadence + 429 back-off)
 *
 *   runGuest({ provider, argv, timeoutMs }) -> Promise<{ exitCode, stdout, usage_seen_at? }>   (parent-owned: prepares/reuses a
 *   sandbox for `provider` through the normal backend and runs argv inside the guest; the probe adds no credential or env).
 *   `usage_seen_at` is the host time at which the guest's usage line (PROBE_USAGE_LINE) arrived; the readings are stamped with
 *   it, never with completion.
 *
 *   const lendingReadings = createLendingReadings({ ledger, probe, plans: () => policy.accountPlans })
 *   await lendingReadings('claude') -> snapshot for app.mjs options.lendingReadings
 */
import { parseClaudeUsage, parseCodexUsage } from './lending-meter.mjs';
import {deadlineRecoveryHold} from '../sandbox-remediation.mjs';
import {DOCKER_SIGNED_OUT, dockerProblem} from './docker-state.mjs';
import {PROVIDER_RECORDS} from './usage-provider-records.mjs';
import {isGuardRead} from './guard-read.mjs';
import {accountIdOfKey, isAccountKey, providerOfKey} from './lending-account-key.mjs';

// The provider inside an account key; a bare provider name is its own.
const baseProvider = key => isAccountKey(key) ? providerOfKey(key) : key;

// Placeholders the proxy replaces (Phase 0 evidence). They are not credentials.
export const PROBE_REQUESTS = Object.freeze({
  claude: { url: PROVIDER_RECORDS.claude.usage.url,
    headers: { Authorization: 'Bearer sk-ant-oat01-proxy-managed', ...PROVIDER_RECORDS.claude.usage.headers },
    keep: PROVIDER_RECORDS.claude.usage.keep,
    // The account's own profile, the read Claude Code makes for its login. The guest prints only hashes of its identifiers.
    identity: { url: PROVIDER_RECORDS.claude.identity.url, headers: { Authorization: 'Bearer sk-ant-oat01-proxy-managed', ...PROVIDER_RECORDS.claude.identity.headers } } },
  codex: { url: PROVIDER_RECORDS.codex.usage.url,
    headers: { Authorization: 'Bearer proxy-managed', ...PROVIDER_RECORDS.codex.usage.headers },
    keep: PROVIDER_RECORDS.codex.usage.keep },
});
const WINDOW_KEYS = ['used_percent', 'limit_window_seconds', 'reset_at', 'reset_after_seconds'];
// The guest prints and flushes this line as soon as the usage answer is in, before the identity read. The runner stamps the
// reading with the host time the line arrives: the host sees it, so the guest cannot choose the time.
export const PROBE_USAGE_LINE = '{"probe_usage":1';

/**
 * Guest probe script for `python3 -c`. Phase 0 proved this transport: Python urllib honours the guest's proxy
 * environment, so the sandbox proxy sees and authenticates the request. (Node's fetch ignores HTTP(S)_PROXY by
 * default, so it is not used.) It prints one line: {"faravan_probe":1,"status":N,"body":{...projection}}.
 */
export function guestProbeScript(provider) {
  const spec = PROBE_REQUESTS[provider];
  if (!spec) throw new TypeError('unknown provider');
  const identity = spec.identity ? { url: spec.identity.url, headers: spec.identity.headers } : null;
  const config = JSON.stringify(JSON.stringify({ url: spec.url, headers: spec.headers, keep: spec.keep, windowKeys: WINDOW_KEYS, identity }));
  return [
    'import json,time,urllib.request,urllib.error,hashlib,subprocess,socket',
    'spec=json.loads(' + config + ')',
    'def pick(o,ks): return {k:o[k] for k in ks if k in o} if isinstance(o,dict) else None',
    // One GET. HTTP 429 (a rate limit) is retried at most twice: after the Retry-After in seconds, else after 5 s and then 10 s,
    // and no wait is longer than 15 s. Any other status is returned as it is. Returns (status, body, tries).
    'def get(url,headers):',
    ' n=0',
    ' while True:',
    '  n+=1',
    '  try:',
    '   s=urllib.request.urlopen(urllib.request.Request(url,headers=headers,method="GET"),timeout=20)',
    '   return s.status,s.read(),n',
    '  except urllib.error.HTTPError as e:',
    '   if e.code!=429 or n>=3: return e.code,b"",n',
    '   try: wait=float(e.headers.get("retry-after"))',
    '   except (TypeError,ValueError): wait=(5,10)[n-1]',
    '   time.sleep(min(max(wait,0),15))',
    'status,body,usage_n,identity_n,d=0,{},0,0,{}',
    'failure_class=None',
    'try:',
    ' status,raw,usage_n=get(spec["url"],spec["headers"])',
    ' d=json.loads(raw) if status==200 else {}',
    ' for k,ks in spec["keep"].items():',
    '  if not isinstance(d,dict) or k not in d: continue',
    '  v=d[k]',
    '  if ks is True:',
    '   if isinstance(v,str): body[k]=v[:20]',
    '  elif isinstance(v,list): body[k]=[pick(x,ks) for x in v[:32]]',
    '  elif k=="rate_limit" and isinstance(v,dict):',
    '   p=pick(v,ks)',
    '   for w in ("primary_window","secondary_window"):',
    '    if p.get(w) is not None: p[w]=pick(p[w],spec["windowKeys"])',
    '   body[k]=p',
    '  else: body[k]=pick(v,ks)',
    'except (TimeoutError,socket.timeout): status=-1; failure_class="timeout"',
    'except urllib.error.URLError as e: status=-1; failure_class="timeout" if isinstance(e.reason,(TimeoutError,socket.timeout)) else "network_error"',
    'except Exception: status=status or -1; failure_class="parse_failed"',
    'print(json.dumps({"probe_usage":1,"status":status},separators=(",",":")),flush=True)',
    // Identity: hashes of the profile's account id, e-mail and organization id. No value leaves the guest.
    'def hx(v): return hashlib.sha256(str(v).strip().lower().encode()).hexdigest()[:16]',
    'identity=None',
    // No identity read when usage did not answer 200: a rate-limited account is not asked again.
    'if spec.get("identity") and status==200:',
    ' identity={"status":-1}',
    ' try:',
    '  ist,ibody,identity_n=get(spec["identity"]["url"],spec["identity"]["headers"])',
    '  identity={"status":ist}',
    '  if ist==200:',
    '   pd=json.loads(ibody)',
    '   acc=pd.get("account") if isinstance(pd,dict) and isinstance(pd.get("account"),dict) else {}',
    '   org=pd.get("organization") if isinstance(pd,dict) and isinstance(pd.get("organization"),dict) else {}',
    '   for name,obj,key in (("account_sha256_16",acc,"uuid"),("email_sha256_16",acc,"email"),("org_sha256_16",org,"uuid")):',
    '    if isinstance(obj.get(key),str) and obj.get(key): identity[name]=hx(obj[key])',
    ' except Exception: identity={"status":-1}',
    // Codex: the usage reply itself names the account. The guest prints only hashes of its account id and e-mail.
    'if ' + JSON.stringify(provider) + '=="codex" and status==200 and isinstance(d,dict):',
    ' identity={"status":200}',
    ' for name,key in (("account_sha256_16","account_id"),("email_sha256_16","email")):',
    '  if isinstance(d.get(key),str) and d.get(key): identity[name]=hx(d[key])',
    'guest_auth=None',
    'if ' + JSON.stringify(provider) + '=="claude":',
    ' try:',
    '  auth=subprocess.run(["claude","auth","status","--json"],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=False,text=True)',
    '  ad=json.loads(auth.stdout) if auth.returncode==0 else {}',
    '  if isinstance(ad,dict): guest_auth={k:ad[k] for k in ("loggedIn","authMethod","apiProvider") if k in ad and isinstance(ad[k],(bool,str))}',
    ' except Exception: pass',
    'out={"faravan_probe":1,"status":status,"body":body,"attempts":{"usage":usage_n,"identity":identity_n}}',
    'if failure_class is not None: out["failure_class"]=failure_class',
    'if identity is not None: out["identity"]=identity',
    'if guest_auth is not None: out["guest_auth"]=guest_auth',
    'print(json.dumps(out,separators=(",",":")))',
  ].join('\n');
}
/** The argv for runGuest. */
export const guestProbeArgv = provider => ['python3', '-c', guestProbeScript(provider)];

/** Parse the guest's probe output (untrusted). Returns { status, readings, ... } or null. */
export function parseProbeOutput(provider, stdout, observedAt) {
  const line = String(stdout ?? '').trim().split('\n').reverse().find(l => l.startsWith('{"faravan_probe":1'));
  if (!line || line.length > 64 * 1024) return null;
  let out; try { out = JSON.parse(line); } catch { return null; }
  if (!Number.isSafeInteger(out.status)) return null;
  const probe = probeStatuses(out);
  if (out.status !== 200) return { status: out.status, readings: [], probe };
  const parsed = provider === 'claude' ? parseClaudeUsage(out.body, observedAt) : parseCodexUsage(out.body, observedAt, { preserveUnknownLimit: true });
  return parsed && { status: 200, ...parsed, identity: parseAccountIdentity(out.identity),
    guest_auth: parseGuestAuth(out.guest_auth), probe };
}

function parseGuestAuth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = {};
  if (typeof raw.loggedIn === 'boolean') allowed.loggedIn = raw.loggedIn;
  if (typeof raw.authMethod === 'string' && raw.authMethod.length <= 40) allowed.authMethod = raw.authMethod;
  if (typeof raw.apiProvider === 'string' && raw.apiProvider.length <= 40) allowed.apiProvider = raw.apiProvider;
  return Object.keys(allowed).length ? allowed : null;
}

/**
 * Each request's HTTP status and try count, as the guest reported them. A refusal carries these, so the record shows which
 * statuses it was based on. A count the guest could not have made (outside 1 to 3) is null.
 */
function probeStatuses(out) {
  const tries = (n) => (Number.isSafeInteger(n) && n >= 1 && n <= 3 ? n : null);
  return { usage_status: out.status,
    ...(['timeout','network_error','parse_failed','other'].includes(out.failure_class) ? {failure_class:out.failure_class} : {}),
    identity_status: Number.isSafeInteger(out.identity?.status) ? out.identity.status : null,
    usage_attempts: tries(out.attempts?.usage), identity_attempts: tries(out.attempts?.identity) };
}

// The backend's own error code, kept beside the public reason so a generic label does not hide the real cause.
// Only the code string leaves here: an error message can carry private output.
const causeCode = error => typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/i.test(error.code) ? {cause_code: error.code} : {};

// Fixed top-level diagnostics emitted by usage-host-reader.mjs for probe_unavailable.
// refresh_rejected has its own auth branch; no error message or unlisted code is public.
const HOST_PROBE_CAUSES = new Set(['host_not_allowed', 'provider_unknown', 'retry_later',
  'usage_credential_unavailable', 'credential_expired', 'account_provider_mismatch', 'no_usage_endpoint']);
const hostProbeCause = (reason, code) =>
  reason === 'probe_unavailable' && HOST_PROBE_CAUSES.has(code) ? {cause_code:code} : {};

const FAILURE_REASONS = new Set(['network_error', 'rate_limited', 'auth', 'provider_error', 'http_error', 'guest_failed',
  'unreadable', 'cancelled', 'closed', 'history_write_failed', 'account_busy', 'probe_unavailable', 'probe_deferred',
  'identity_failed', 'guard_runtime_unavailable', 'sandbox_start_failed', 'cessation_unverified', 'docker_signed_out', 'timeout']);
// Unknown outcomes cannot certify continued use of an earlier account reading.
export function admissionRefreshClass(attempt) {
  if (!attempt || attempt.outcome === 'pending' || (attempt.outcome === 'good' && attempt.reason == null)) return 'good';
  if (['cancelled', 'closed'].includes(attempt.reason)) return 'cancelled';
  if (['timeout', 'network_error', 'provider_error', 'rate_limited', 'account_busy', 'probe_deferred',
    'guest_failed', 'sandbox_start_failed', 'probe_unavailable', 'history_write_failed'].includes(attempt.reason)) return 'transient';
  return 'invalidating';
}

const HTTP_STATUS_CLASSES = new Set(['1xx', '2xx', '3xx', '4xx', '5xx']);

function httpStatusClass(status) {
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx` : null;
}

function failureReason(reason) {
  return FAILURE_REASONS.has(reason) ? reason : 'unreadable';
}

function failureStatusClass(reason, statusClass) {
  if (!HTTP_STATUS_CLASSES.has(statusClass)) return null;
  if (reason === 'rate_limited' || reason === 'auth') return statusClass === '4xx' ? statusClass : null;
  if (reason === 'provider_error') return statusClass === '5xx' ? statusClass : null;
  if (reason === 'http_error') return statusClass === '5xx' ? null : statusClass;
  return null;
}

/** Expected skips carry their own cause, never the earlier request's failure class. */
export function sanitizeProbeDeferral(probe, provider = probe?.provider) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe) || !['account_busy', 'probe_deferred'].includes(probe.reason)) return null;
  const retryAt = probe.reason === 'probe_deferred' && Number.isSafeInteger(probe.retry_at) &&
    probe.retry_at >= 0 && probe.retry_at <= 8.64e15 ? probe.retry_at : null;
  return {reason:probe.reason,
    ...(['claude', 'codex'].includes(provider) ? {provider,
      failure_class:probe.reason === 'account_busy' ? 'probe_busy' : 'probe_deferred'} : {}),
    ...(probe.reason === 'probe_deferred' && ['rate_limited','target_cleanup'].includes(probe.deferral_cause) ? {deferral_cause:probe.deferral_cause} : {}),
    ...probeDiagnosticFields(probe),
    ...(retryAt !== null ? {retry_at:retryAt} : {})};
}
export const isDeferredObservation = observation => observation?.refresh_outcome === 'deferred' &&
  observation.refresh_succeeded === false && sanitizeProbeDeferral(observation.probe) !== null;

/** Closed, secret-free diagnostics. Provider is the caller's routing key, never an account identity. */
export function sanitizeProbeFailure(probe, provider = probe?.provider) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe) || typeof probe.reason !== 'string') return null;
  const deferred = sanitizeProbeDeferral(probe, provider);
  if (deferred) return deferred;
  const reason = FAILURE_REASONS.has(probe.reason) ? probe.reason : 'unreadable';
  if(reason==='cessation_unverified')return {reason,...(['claude','codex'].includes(provider)?{provider,failure_class:'probe_deferred'}:{}),
    ...probeDiagnosticFields(probe),
    recovery_hold:deadlineRecoveryHold(probe.recovery_hold,{rowCount:probe.recovery_hold?.row_count})};
  const statusClass = failureStatusClass(reason, probe.status_class);
  const status = Number.isSafeInteger(probe.usage_status) && probe.usage_status >= 100 && probe.usage_status <= 599
    ? probe.usage_status : null;
  const classes = new Set(['probe_busy', 'probe_deferred', 'probe_unavailable', 'probe_cancelled',
    'rate_limited', 'identity_failed', 'sandbox_start_failed', 'docker_signed_out', 'guard_runtime_unavailable', 'parse_failed', 'timeout', 'other']);
  const supplied = typeof probe.failure_class === 'string' &&
    (classes.has(probe.failure_class) || /^usage_http_[1-5][0-9]{2}$/.test(probe.failure_class))
    ? probe.failure_class : null;
  const mapped = {account_busy:'probe_busy', probe_deferred:'probe_deferred', probe_unavailable:'probe_unavailable',
    cancelled:'probe_cancelled', closed:'probe_cancelled', rate_limited:'rate_limited',
    docker_signed_out:'docker_signed_out', guard_runtime_unavailable:'guard_runtime_unavailable', unreadable:'parse_failed', identity_failed:'identity_failed', sandbox_start_failed:'sandbox_start_failed',
    timeout:'timeout', network_error:'other', guest_failed:'other', history_write_failed:'other'}[reason];
  const failureClass = supplied ?? (status !== null && status !== 200 ? `usage_http_${status}` : mapped ?? 'other');
  const validProvider = provider === 'claude' || provider === 'codex';
  return {reason,...probeDiagnosticFields(probe), ...hostProbeCause(reason, probe.cause_code), ...(reason === DOCKER_SIGNED_OUT ? dockerProblem() : {}), ...(statusClass ? {status_class:statusClass} : {}),
    ...(validProvider ? {provider, failure_class:failureClass} : {}),
    ...(failureClass === 'rate_limited' && Number.isSafeInteger(probe.retry_at) && probe.retry_at >= 0 && probe.retry_at <= 8.64e15
      ? {retry_at:probe.retry_at} : {})};
}

const HASH16 = /^[0-9a-f]{16}$/;
/**
 * The guest's identity hashes (see guestProbeScript). Only well-formed hashes survive, and only the three named keys are
 * kept, so no raw e-mail, uuid or other field can reach admission. The account and e-mail hashes are required; the
 * organization hash is kept when present, for evidence.
 */
export function parseAccountIdentity(raw) {
  if (!raw || typeof raw !== 'object' || raw.status !== 200) return null;
  const hash = (v) => (typeof v === 'string' && HASH16.test(v) ? v : null);
  const account_sha256_16 = hash(raw.account_sha256_16), email_sha256_16 = hash(raw.email_sha256_16);
  if (!account_sha256_16 || !email_sha256_16) return null;
  return { account_sha256_16, email_sha256_16, org_sha256_16: hash(raw.org_sha256_16) };
}

const MIN = 60000;
export function createLendingProbe({ runGuest, hostRead = null, ledger, history = null, warnHistoryWrite = null, now = Date.now, timeoutMs = 120000, onProbeEvent, onProbeReceipt } = {}) {
  if (typeof runGuest !== 'function') throw new TypeError('createLendingProbe needs runGuest');
  const state = {};
  let closed = false;
  let closePromise = null;
  const s = provider => state[provider] ??= { last: null, result: null, backoffUntil: 0, backoffMs: 0, pending: null, controller: null, funding: null, good: null, attempt: null, generation: 0, invalidated: false };
  const waitForProbe = (st, signal, interested = true) => {
    const controller = st.controller, waiters = st.waiters;
    return new Promise((resolve, reject) => {
      const waiter = {};
      if (interested) waiters.add(waiter);
      const detach = () => {
        waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        detach();
        if (interested && waiters.size === 0 && !controller.signal.aborted)
          controller.abort(signal.reason ?? new DOMException('The quota observation was cancelled.', 'AbortError'));
        resolve({ok:false, reason:'cancelled'});
      };
      st.pending.then(result => { detach(); resolve(result); }, error => { detach(); reject(error); });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, {once:true});
    });
  };
  return {
    /**
     * Last successful funding and identity facts also survive failed probes; they may lag account changes. A reading carries no
     * executor and no stop: those belong to the machine's stop receipt (stop-evidence.mjs), never to an account's reading.
     */
    funding(provider) {
      const f = state[provider]?.funding;
      return f ? { ...f } : null;
    },
    invalidateFacts(reason) {
      for (const provider of Object.keys(PROBE_REQUESTS)) {
        const st = s(provider);
        st.funding = null; st.good = null; st.last = null;
        st.attempt = null; st.result = null; st.probeContext = null;
        st.invalidated = true;
        st.goodGeneration = ++st.generation;
        st.controller?.abort(new DOMException(reason ?? 'Probe evidence changed.', 'AbortError'));
      }
    },
    outcome(provider) {
      const st=s(provider),latest=st.attempt;
      return latest ? {outcome:latest.outcome, reason:latest.reason === null ? null : failureReason(latest.reason),
        at:latest.ended_at ?? latest.started_at,...probeDiagnosticFields(latest.outcome==='pending'&&latest.generation===st.generation?st.probeContext?.snapshot():latest)} : null;
    },
    successfulResult(provider) { return s(provider).good; },
    evidenceGeneration(provider) { return s(provider).goodGeneration ?? null; },
    latestAttempt(provider) { const st = s(provider); return st.attempt ? {...st.attempt, ...(st.attempt.outcome==='pending'&&st.attempt.generation===st.generation?probeDiagnosticFields(st.probeContext?.snapshot()):{}), invalidated:st.invalidated} : null; },
    backoffUntil(provider) { return s(provider).backoffUntil; },
    inFlight(provider) { return s(provider).pending !== null; },
    lastResult(provider) { return closed ? {ok:false, reason:'closed'} : s(provider).result; },
    retryAt(provider, {intervalMinutes = 15, force = false} = {}) {
      const st = s(provider);
      if (closed || st.pending) return null;
      return Math.max(st.backoffUntil, force || st.last === null ? 0 : st.last + intervalMinutes * MIN);
    },
    /** Cadence (D2): every 30 min while automatic lending is on and idle; on page open/offer when older than 15 min. */
    due(provider, { autoLending = false, jobRunning = false, pageOpen = false, force = false, intervalMinutes = 30 } = {}) {
      if (closed) return false;
      const st = s(provider), t = now();
      if (jobRunning || st.pending || t < st.backoffUntil) return false;
      if (force || st.result?.reason==='cessation_unverified' && (autoLending || pageOpen)) return true;
      const age = st.last === null ? Infinity : t - st.last;
      return autoLending ? age >= intervalMinutes * MIN : pageOpen && age >= 15 * MIN;
    },
    // `runGuest` may name another runner for this one read: the native guard's host read (createLendingReadings).
    // `provider` is the account key: the first account's key is its provider, another account's is `provider:<id>`. State is kept
    // per key; the request, parser and provider rules use the provider inside it. An added account has no sandbox probe: it is read
    // from the host (usage-host-reader.mjs), which carries no executor or stop fact.
    probe: async function probe(key, {signal, runGuest: runner = runGuest} = {}) {
      const provider = baseProvider(key);
      if (!PROBE_REQUESTS[provider]) throw new TypeError('unknown provider');
      if (runner === runGuest && hostRead && accountIdOfKey(key) !== null) runner = hostRead;
      if (closed) return {ok: false, reason: 'closed'};
      const st = s(key);
      if (signal?.aborted) return {ok:false, reason:'cancelled'};
      // An abandoned transport still owns its sandbox until cleanup finishes.
      if (st.pending && st.controller.signal.aborted) {
        await waitForProbe(st, signal, false).catch(() => {});
        return probe(key, {signal, runGuest:runner});
      }
      // A running job's meter read must not wait behind a cold check that is still waiting for a sandbox-service turn.
      // That queued check yields: it is cancelled and the meter read runs. A check already using the service is joined as before.
      if (st.pending && !st.controller.signal.aborted && st.runner === runGuest && runner !== runGuest && runGuest?.isQueued?.(st.controller.signal) === true) {
        st.controller.abort(new DOMException('A running job needs its meter read.', 'AbortError'));
        await waitForProbe(st, signal, false).catch(() => {});
        return probe(key, {signal, runGuest:runner});
      }
      if (!st.pending) {
        const controller = new AbortController();
        st.controller = controller;
        st.runner = runner;
        st.waiters = new Set();
        const generation = ++st.generation, started_at = now();
        const probeContext=createProbeDiagnostics({...runner.probeIdentity,purpose:runner.probeIdentity?.purpose??'allowance',provider,generation,now,onEvent:onProbeEvent,onReceipt:onProbeReceipt});
        st.probeContext=probeContext;
        st.attempt = {generation, started_at, ended_at:null, outcome:'pending', reason:null};
        let pending;
        pending = (async () => {
        let result;
        if (controller.signal.aborted || closed) return {ok: false, reason: closed ? 'closed' : 'cancelled'};
        const requestedAt = now();
        try { result = await runner({ provider, accountKey: key, argv: guestProbeArgv(provider), timeoutMs, signal: controller.signal, probeContext }); }
        catch (error) {
          if (controller.signal.aborted || closed) return {ok: false, reason: closed ? 'closed' : 'cancelled'};
          if(error?.recovery_scope==='target'||error?.probe_failure==='probe_deferred')return {ok:false,reason:'probe_deferred',
            ...(error?.recovery_scope==='target'?{deferral_cause:'target_cleanup'}:{})};
          if(error?.code==='cessation_unverified'||error?.probe_failure==='cessation_unverified')
            return {ok:false,reason:'cessation_unverified',recovery_hold:deadlineRecoveryHold(error,{rowCount:error?.recovery_hold?.row_count})};
          // A failed run still counts for cadence, so a broken sandbox is retried on schedule, not on every read.
          st.last = now();
          // The host reader could not refresh this account's sign-in: the owner has to sign in again.
          if (error?.code === 'refresh_rejected') return {ok: false, reason: 'auth'};
          if (error?.code === DOCKER_SIGNED_OUT) return {ok:false, reason:DOCKER_SIGNED_OUT, ...dockerProblem()};
          return {ok: false, reason: ['timeout', 'guard_runtime_unavailable', 'sandbox_start_failed', 'probe_unavailable'].includes(error?.probe_failure)
            ? error.probe_failure : 'guest_failed', ...causeCode(error?.cause),
            ...hostProbeCause(error?.probe_failure, error?.code)};
        }
        if (controller.signal.aborted || closed) return {ok: false, reason: closed ? 'closed' : 'cancelled'};
        if(result?.probe_failure==='probe_deferred'||result?.probe_error?.recovery_scope==='target')return {ok:false,reason:'probe_deferred',
          ...(result?.probe_error?.recovery_scope==='target'?{deferral_cause:'target_cleanup'}:{})};
        if(result?.probe_failure==='cessation_unverified')return {ok:false,reason:'cessation_unverified',
          recovery_hold:deadlineRecoveryHold(result.probe_error??result,{rowCount:result.recovery_hold?.row_count??result.probe_error?.recovery_hold?.row_count})};
        const t = now();
        st.last = t;
        // The reading is as old as the usage answer. Identity retries, Stop and sandbox removal run after it, so the completion
        // time would make an older reading look fresh. The runner names host dispatch time after sandbox readiness,
        // no later than usage acquisition, never log receipt. A value before the probe's own start or after the runner
        // returned falls back to the probe's start.
        const ra = result?.usage_seen_at;
        const observedAt = Number.isSafeInteger(ra) && ra >= requestedAt && ra <= t ? ra : requestedAt;
        if (['timeout', 'guard_runtime_unavailable', 'sandbox_start_failed', 'probe_unavailable', 'cancelled', 'guest_failed'].includes(result?.probe_failure))
          return {ok:false, reason:result.probe_failure, ...causeCode(result.probe_error)};
        const parsed = parseProbeOutput(provider, result?.stdout, observedAt);
        if (!parsed) return { ok: false, reason: 'unreadable' };
        if (parsed.status !== 200 && parsed.probe.failure_class) return {ok:false,
          reason:parsed.probe.failure_class === 'timeout' ? 'timeout' : parsed.probe.failure_class === 'network_error' ? 'network_error' : parsed.probe.failure_class === 'parse_failed' ? 'unreadable' : 'guest_failed'};
        if (controller.signal.aborted || closed) return {ok: false, reason: closed ? 'closed' : 'cancelled'};
        // A 429 from either required endpoint (usage, or Claude's identity) is a rate-limited failed observation.
        const rateLimited = parsed.status === 429 || parsed.probe.identity_status === 429;
        const statusClass = httpStatusClass(rateLimited ? 429 : parsed.status);
        if (rateLimited) {
          // After a 429: back off 5 min, doubling to 1 h.
          st.backoffMs = Math.min(60 * MIN, st.backoffMs ? st.backoffMs * 2 : 5 * MIN);
          st.backoffUntil = t + st.backoffMs;
          return { ok: false, reason: 'rate_limited', status_class: statusClass, retry_at: st.backoffUntil };
        }
        if (parsed.status !== 200) {
          if (!statusClass) return {ok: false, reason: 'unreadable'};
          const reason = parsed.status === 401 || parsed.status === 403 ? 'auth'
            : statusClass === '5xx' ? 'provider_error' : 'http_error';
          return {ok: false, reason, status_class: statusClass, usage_status: parsed.status};
        }
        st.backoffMs = 0; st.backoffUntil = 0;
        // A usage reading, from the host or from anywhere else, is never stop proof: the fact keeps no executor and no stop.
        const fact = { extra_usage: parsed.extra_usage_state, observed_at: observedAt, identity: parsed.identity ?? null,
          ...(parsed.guest_auth ? {guest_auth: parsed.guest_auth} : {}),
          ...(provider === 'codex' ? {codex_plan: {plan_type: parsed.plan_type ?? null, limit_reached: parsed.limit_reached}} : {})};
        ledger?.recordReadings(key, parsed.readings, { signal: { at: observedAt,
          ...(typeof parsed.limit_reached === 'boolean' ? { limit_reached: parsed.limit_reached } : {}) } });
        let warning = null;
        // Optional learning must not withhold current quota, identity or funding. Keep the ledger
        // write above outside this catch: durable accounting failures still fail the observation.
        try {
          // Imported usage history is kept per provider for the first account only.
          const providerHistory = key !== provider ? null : typeof history === 'function' ? history(provider) : history;
          if (typeof providerHistory?.record === 'function') {
            const weeklyEpoch = parsed.readings.find(row => row.window_minutes > 300)?.resets_at ?? null;
            for (const row of parsed.readings) providerHistory.record({...row, account_week_epoch: weeklyEpoch,
              censoring: {complete: false, limit_reached: parsed.limit_reached === true,
                owner_refused: false, owner_deferred: false}});
          }
        } catch {
          // Diagnostics are best-effort too, and never include raw storage/recorder error text.
          warning = 'history_write_failed';
          try { Promise.resolve(warnHistoryWrite?.({at: t, code: warning})).catch(() => {}); }
          catch { /* Logging cannot gate lending. */ }
        }
        if (generation !== st.generation) return {ok:false, reason:'cancelled'};
        st.funding = fact;
        return { ok: true, readings: parsed.readings,
          ...(!parsed.identity ? {probe: {reason:'identity_failed'}} : {}),
          ...(warning ? {warning} : {}) };
        })().then(result => {
          const diagnostics=probeContext.finish(result.ok&&!result.probe?.reason?'ok':result.reason==='probe_deferred'?'deferred':['cancelled','closed'].includes(result.reason)?'cancelled':result.reason==='timeout'?'timed_out':'failed');
          const fields=probeDiagnosticFields(diagnostics);
          result={...result,...fields,...(result.probe?{probe:{...result.probe,...fields}}:{})};
          if (generation !== st.generation) return {ok:false, reason:'cancelled'};
          st.result = result;
          st.attempt = {generation, started_at, ended_at:now(), outcome:result.ok ? 'good' : result.reason==='probe_deferred' ? 'deferred' : 'failed', reason:result.reason ?? result.probe?.reason ?? null,
            ...(result.reason==='probe_deferred'&&result.deferral_cause==='target_cleanup'?{deferral_cause:'target_cleanup'}:{}),...probeDiagnosticFields(result)};
          if (result.ok) { st.good = result; st.goodGeneration = generation; st.invalidated = false; }
          else if (admissionRefreshClass(st.attempt) === 'invalidating') st.invalidated = true;
          return result;
        }, error => {
          const diagnostics=probeContext.finish(controller.signal.aborted?'cancelled':'failed');
          if (generation !== st.generation) throw error;
          st.result = {ok:false, reason:'guest_failed',...probeDiagnosticFields(diagnostics)};
          st.attempt = {generation, started_at, ended_at:now(), outcome:'failed', reason:'guest_failed',...probeDiagnosticFields(diagnostics)};
          // A local probe crash says nothing about quota; retain any earlier invalidation latch.
          throw error;
        }).finally(() => {
          if (st.pending === pending) { st.pending = null; st.controller = null; }
        });
        st.pending = pending;
      }
      return waitForProbe(st, signal);
    },
    close() {
      closed = true;
      for (const st of Object.values(state)) st.controller?.abort(new DOMException('The app is closing.', 'AbortError'));
      closePromise ??= Promise.allSettled(Object.values(state).map(st => st.pending).filter(Boolean)).then(() => undefined);
      return closePromise;
    },
  };
}

/**
 * app.mjs `options.lendingReadings(provider)`: the ledger snapshot, probing first when the newest reading is stale
 * (over 15 min) or this process has no probe fact yet, and no lent job is running on that account. Probe failure never throws; the engine then sees
 * stale or unknown windows and declines.
 *
 * While a lent job runs, only the native guard reads the meter, and only through `guardRead`: a context issued by guard-read.mjs
 * for the attempt's own account, which reads from the host and never from the job's sandbox. Every other caller gets
 * account_busy, as before. A guard read keeps the probe's cadence rules: it waits for a probe in flight, and after a 429 it waits out the back-off.
 * A wait after a successful probe is deferred; a prior failure (including 429) keeps its failure class.
 * Neither provides fresh evidence, so the guard's stale stop still applies.
 */
// Waiting jobs keep their existing two-minute probe cadence.
export const ADMISSION_PROBE_MINUTES = 2;
// A saved reading this old needs a fresh probe. It matches how long a not-open window stands on its probe in the ledger.
export const READING_STALE_MS = 15 * MIN;
// How long a guarded Stop waits for the run to end before it hard-stops it. The probe runner and the stop proof share it.
export const STOP_ANSWER_MS = 30_000;

export function createLendingReadings({ ledger, probe = null, plans = () => ({}), jobRunning = () => false, now = Date.now, cleanupRetryMs = 3000 }) {
  const cached = provider => {
    const snap = (ledger.snapshotReadOnly ?? ledger.snapshot).call(ledger, provider, {plan:plans()?.[provider] ?? 'unknown'});
    const last = probe?.lastResult?.(provider);
    const good = probe?.successfulResult?.(provider);
    const detail = good ? good.probe : last?.probe ?? (last?.ok === false ? last : snap.read_at === null ? {reason:'probe_unavailable'} : null);
    return {...snap, age_ms:snap.read_at === null ? null : Math.max(0, now() - snap.read_at),
      ...(detail ? {probe:sanitizeProbeFailure(detail, baseProvider(provider))} : {}),
      evidence_generation:probe?.evidenceGeneration?.(provider) ?? null,
      latest_attempt:probe?.latestAttempt?.(provider) ?? (last ? {outcome:last.ok ? 'good' : 'failed', reason:last.reason} : null)};
  };
  const lendingReadings = async function(provider, {signal, forceRefresh = false, maxAgeMs = null, guardRead = null, excludingAttemptId = null, admissionOnly = false} = {}) {
    const plan = plans()?.[provider] ?? 'unknown';
    let snap = admissionOnly ? cached(provider) : ledger.snapshot(provider, { plan });
    const failed = detail => ({...snap, refresh_succeeded:false, probe:sanitizeProbeFailure(detail, baseProvider(provider))});
    const deferred = detail => ({...snap, refresh_succeeded:false, refresh_outcome:'deferred',
      probe:sanitizeProbeDeferral(detail, baseProvider(provider))});
    if (signal?.aborted) return failed({reason:'cancelled'});
    // Admission consumes the saved reading; optional provider work cannot delay it.
    if (admissionOnly) return snap;
    const running = jobRunning(provider, excludingAttemptId);
    const stale = snap.read_at === null || now() - snap.read_at >= READING_STALE_MS;
    // A reading saved before a restart has no same-run funding or identity fact, and admission needs both; probe once now
    // rather than hold until the saved reading is 15 min old.
    const unbound = typeof probe?.funding === 'function' && probe.funding(provider) === null;
    const tooOld = Number.isFinite(maxAgeMs) && (snap.read_at === null || now() - snap.read_at > maxAgeMs);
    const required = forceRefresh || stale || unbound || tooOld || probe?.lastResult?.(provider)?.ok === false;
    if (!required) return snap;
    if (running && !isGuardRead(guardRead)) return deferred({reason:'account_busy'});
    if (!probe) return failed({reason:'probe_unavailable'});
    // The refresher joins an existing provider probe. Ordinary refreshes retain cadence;
    // explicit refreshes still honor provider backoff.
    const due = probe.inFlight?.(provider) === true ||
      probe.due(provider, {pageOpen: true, force: forceRefresh}) ||
      (tooOld && probe.due(provider, {autoLending: true, intervalMinutes: ADMISSION_PROBE_MINUTES}));
    if (!due) {
      const last = probe.lastResult?.(provider);
      const retry_at = probe.retryAt?.(provider, {
        intervalMinutes:tooOld ? ADMISSION_PROBE_MINUTES : 15, force:forceRefresh});
      if (last?.reason === 'probe_deferred') return deferred(last);
      // A cadence skip cannot turn the most recent failed request into an expected wait.
      if (last?.ok !== true) return failed({...last, reason:last?.reason ?? 'probe_unavailable',
        ...(last?.reason === 'rate_limited' ? {retry_at} : {})});
      return deferred({reason:'probe_deferred', retry_at});
    }
    {
      const priorAttempt=probe.latestAttempt?.(provider);
      try {
        const read = () => probe.probe(provider, {signal, ...(isGuardRead(guardRead) ? {runGuest: guardRead.run} : {})});
        let r = await read();
        // A read skipped because the previous sandbox of its name was still being removed is not a refusal: one more read after a
        // short wait. A second skip is returned as a deferral, never a third read.
        if (r?.reason === 'probe_deferred' && r.deferral_cause === 'target_cleanup' && !signal?.aborted) {
          await new Promise(resolve => { const timer = setTimeout(resolve, cleanupRetryMs); timer.unref?.(); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true}); });
          if (!signal?.aborted) r = await read();
        }
        if (signal?.aborted || r?.reason === 'cancelled' || r?.reason === 'closed')
          return failed({...r,reason:signal?.aborted ? 'cancelled' : r.reason});
        if (r?.reason === 'probe_deferred') return deferred(r);
        if (r.ok) snap = {...ledger.snapshot(provider, { plan }),
          ...(r.probe ? {probe:sanitizeProbeFailure(r.probe, baseProvider(provider))} : {})};
        else snap = failed({...r, reason:failureReason(r?.reason)});
      } catch {
        if (signal?.aborted) return failed({reason:'cancelled'});
        const attempt=probe.latestAttempt?.(provider);
        const current=attempt?.outcome==='failed'&&Number.isSafeInteger(attempt.generation)&&
          (!Number.isSafeInteger(priorAttempt?.generation)||attempt.generation>priorAttempt.generation||
            priorAttempt.outcome==='pending'&&attempt.generation===priorAttempt.generation);
        return failed({reason:'guest_failed',...(current?probeDiagnosticFields(attempt):{})});
      }
    }
    return snap;
  };
  lendingReadings.requestRefresh = provider => {
    void lendingReadings(provider).catch(() => {});
  };
  lendingReadings.cached = cached;
  return lendingReadings;
}
