// Running an operation, the same way on every surface, and reaching the running app.
//
// runOp() validates input against the registry, refuses a consequential operation without confirmation, then calls the
// bound app route or the operation's handler. The app's POST /api/ops/<id> runs it in the app process. The CLI and the
// MCP server use createOpsClient(): operations bound to an app route are sent to the app's /api/ops/<id> (so the
// app checks confirmation and remembers idempotency keys in one place); the others run in the calling process.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { validate } from './schema.mjs';
import { opById, draftIdFor, needsConfirmation } from './registry.mjs';
import { sendsJob, resolveJobRecipient } from '../job-recipient.mjs';
import { clientHeaders } from '../telemetry/switch.mjs';
import {offlineOperationStatus, quitOfflineApp} from './offline-app.mjs';

export { opError } from './errors.mjs';
import { opError, isPublicError } from './errors.mjs';
import { outcomeFields } from '../outcome.mjs';

// Exit codes of `faravan <group> <verb>` and `faravan ops call`. The JSON problem's `code` is the stable detail.
export const EXIT = Object.freeze({ok:0, failed:1, invalid:2, not_found:3, conflict:4, timeout:5, confirmation_required:6, app_unavailable:7, human_only:8});
export function exitCodeFor(error) {
  const code = error?.code, status = error?.status;
  if (code === 'confirmation_required') return EXIT.confirmation_required;
  if (code === 'human_only') return EXIT.human_only;
  if (code === 'app_not_running' || code === 'app_unreachable') return EXIT.app_unavailable;
  if (code === 'invalid_request' || code === 'unknown_operation' || status === 400 || status === 415) return EXIT.invalid;
  if (status === 404 || ['not_found','circle_not_found','job_not_found'].includes(code)) return EXIT.not_found;
  if (code === 'timeout' || code === 'agent_check_timeout' || status === 504) return EXIT.timeout;
  if (status === 409 || status === 403 || status === 428) return EXIT.conflict;
  return EXIT.failed;
}
// Only stable hold-proof codes may cross this boundary, never process commands or exception text.
const HOLD_REFUSAL_DETAILS = new Set([
  'platform_unsupported','job_identity_unknown','sandbox_home_unverified',
  'sandbox_inventory_failed','sandbox_inventory_incomplete','sandbox_inventory_unreadable','sandbox_present',
  'process_scan_incomplete','process_present','sandbox_cleanup_unverified','process_scan_failed',
  'attempt_active','absence_check_failed','absence_proof_unavailable','attempt_identity_mismatch',
]);
const holdRefusalDetail = value => value?.code === 'cessation_unverified' && HOLD_REFUSAL_DETAILS.has(value.detail)
  ? {detail:value.detail} : {};

/** A JSON-safe problem for any error: {code, message, ...detail}. Never a stack or a path the app did not return. */
export function problemOf(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'internal_error';
  const trusted = isPublicError(error);
  const problem = {code, message:trusted && typeof error?.message === 'string' && error.message !== code && code !== 'internal_error' ? error.message : code.replaceAll('_', ' ')};
  for (const key of ['field','effect','confirmation_input','apply_code','repo_code','state','warning','action','error_id','op']) if ((trusted || (code === 'invalid_request' && key === 'field')) && error?.[key] !== undefined) problem[key] = error[key];
  Object.assign(problem, trusted ? holdRefusalDetail(error) : {}, outcomeFields(error));
  return problem;
}

function checkRetryKey(key) {
  if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key)))
    throw opError('invalid_request', 400, 'Idempotency-Key must be 1-255 visible characters.');
}

/** Run one operation. ctx: {rest, call, home, confirmed, idempotencyKey, signal, progress, strict, discover, startApp}. */
export async function runOp(id, input = {}, ctx) {
  const op = opById(id);
  if (!op) throw opError('unknown_operation', 404, 'There is no operation ' + JSON.stringify(id) + '. List them with faravan ops list.');
  if (op.safety === 'human') throw opError('human_only', 403, op.description);
  validate(op.input, input);
  checkRetryKey(ctx?.idempotencyKey);
  if (op.idempotencyField && ctx.idempotencyKey && input[op.idempotencyField] === undefined && draftIdFor(ctx.idempotencyKey))
    input = {...input, [op.idempotencyField]:ctx.idempotencyKey};
  let effect;
  if (sendsJob(id)) {
    const prepared = resolveJobRecipient(input, await ctx.rest('GET','/api/circles', {signal:ctx.signal}));
    input = prepared.input; effect = op.confirm({...input,circle:prepared.circle.name ?? prepared.circle.id});
  }
  const permitted = ctx.confirmed !== true && await ctx.confirmationPolicy?.(op, input, ctx.principal);
  checkConfirmation(op, input, ctx.confirmed === true || permitted === true, effect);
  // A caller that went away (MCP cancellation, a closed connection) never starts the side effect.
  if (ctx.signal?.aborted) throw opError('cancelled', 499, 'The request was cancelled.');
  const result = op.rest ? await viaRest(op, input, ctx) : await op.handler(ctx, input);
  if (ctx.strict) validate(op.output, result, 'output of ' + op.id);
  return result;
}
function checkConfirmation(op, input, confirmed, resolvedEffect) {
  if (needsConfirmation(op, input) && confirmed !== true) {
    const effect = resolvedEffect ?? op.confirm?.(input) ?? op.title;
    throw opError('confirmation_required', 428, effect + ' Confirm to go ahead.', {effect, op:op.id,
      ...(sendsJob(op.id) ? {confirmation_input:{circle:input.circle,expected_circle_id:input.expected_circle_id,...(input.expected_default_circle ? {expected_default_circle:input.expected_default_circle} : {})}} : {})});
  }
}

/** Map input to the bound route: {name} path segments, then query (GET/DELETE) or JSON body (POST). */
export function restRequest(op, input) {
  const used = new Set();
  const path = op.rest.path.replace(/\{(\w+)\}/g, (_, key) => { used.add(key); return encodeURIComponent(input[key]); });
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !used.has(key)));
  if (op.rest.method === 'GET' || op.rest.method === 'DELETE') return {method:op.rest.method, path, query:rest};
  return {method:op.rest.method, path, body:op.rest.body ? op.rest.body(rest) : {...rest, ...op.rest.fixed}};
}
async function viaRest(op, input, ctx) {
  const {method, path, query, body} = restRequest(op, input);
  return ctx.rest(method, path, {query, body, signal:ctx.signal,
    ...(needsConfirmation(op,input)&&ctx.confirmed===true?{headers:{'faravan-confirm':'yes'}}:{})});
}

// ---- Reaching the running app ------------------------------------------------------------------------------

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
/** The running app's address and session token from <home>/v1/app.json (mode 0600), or null. */
export async function discoverApp(home) {
  let record;
  try { record = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8')); } catch { return null; }
  if (!Number.isSafeInteger(record?.pid) || !alive(record.pid) || !Number.isInteger(record.port) || typeof record.token !== 'string') return null;
  return {origin:'http://127.0.0.1:' + record.port, token:record.token, pid:record.pid, started_at:record.started_at ?? null};
}

const REQUEST_LIMIT_MS = 15 * 60 * 1000;
/** A loopback JSON call with the session token. Errors carry the app's {code,message} and the HTTP status. */
export async function appRequest(app, method, path, {query, body, headers = {}, signal, fetchImpl = globalThis.fetch} = {}) {
  const url = new URL(app.origin + path);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  let response;
  // A bound on every call so a stalled app never hangs a caller; agent checks and the doctor finish well within it.
  const limit = AbortSignal.timeout(REQUEST_LIMIT_MS);
  try {
    response = await fetchImpl(url, {method, redirect:'error', signal:signal ? AbortSignal.any([signal, limit]) : limit,
      headers:{'x-faravan-session-token':app.token, ...(body === undefined ? {} : {'content-type':'application/json'}), ...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  } catch (error) {
    if (signal?.aborted) throw error;
    if (limit.aborted) throw opError('timeout', 504, 'The Faravan app did not answer within ' + REQUEST_LIMIT_MS / 60000 + ' minutes.');
    throw opError('app_unreachable', 503, 'The Faravan app is not answering at ' + app.origin + '.');
  }
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (!response.ok) {
    const problem = value && typeof value === 'object' ? value : {};
    // fromRest tells the ops writer that the app already observed this failure on the REST response it rebuilds here.
    throw Object.assign(opError(typeof problem.code === 'string' ? problem.code : 'http_' + response.status, response.status,
      typeof problem.message === 'string' ? problem.message : undefined, {...Object.fromEntries(Object.entries(problem).filter(([k]) => ['field','effect','confirmation_input','apply_code','repo_code','state','warning','action','error_id','op','outcome','operationKey','jobDigest'].includes(k))), ...holdRefusalDetail(problem)}), {fromRest:true});
  }
  return value;
}

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'faravan');
/** Start the app in the background (no browser) and wait for it to answer. */
export async function startAppProcess(home, {env = process.env, waitMs = 15000} = {}) {
  const child = spawn(process.execPath, [BIN, 'app'], {detached:true, stdio:'ignore', env:{...env, FARAVAN_HOME:home, FARAVAN_NO_BROWSER:'1'}});
  let failed = null;
  child.once('error', error => { failed = error; });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (failed) break;
    const app = await discoverApp(home);
    if (app) return app;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw opError('app_not_running', 503, 'Faravan could not start. Run faravan app to see why.');
}

/**
 * The client the CLI and MCP server use. autostart (default: unless FARAVAN_NO_AUTOSTART=1) starts the app when an
 * operation needs it and none runs.
 */
export function createOpsClient(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home;
  const autostart = options.autostart ?? (env.FARAVAN_NO_AUTOSTART) !== '1';
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let app = null, legacyApp = false;
  async function connection({allowAutostart = autostart} = {}) {
    if (app && alive(app.pid)) return app;
    app = await discoverApp(home); legacyApp = false;
    if (!app && allowAutostart) app = await startAppProcess(home, {env});
    if (!app) throw opError('app_not_running', 503, 'The Faravan app is not running. Start it with faravan app start (or faravan app).');
    return app;
  }
  // Every call says where it comes from (cli or mcp) and carries the person's telemetry switch (design §4.5).
  const callerHeaders = clientHeaders(env, options.surface);
  // A REST call carrying headers on top of the client's own: each call builds one, so a call's restriction reaches every request it makes.
  const restWith = (headers, allowAutostart = autostart) => async (method, path, request = {}) => appRequest(await connection({allowAutostart}), method, path, {...request, headers:{...headers, ...request.headers}, fetchImpl});
  const rest = restWith(callerHeaders);
  async function call(id, input = {}, opts = {}) {
    try { return await invoke(id, input, opts); }
    catch (error) {
      // An HTTP refusal (including job_running/cessation_unverified/auth errors)
      // is authoritative. Only a local connection failure can use offline state.
      if (opts.signal?.aborted || error.fromRest || !['app_not_running','app_unreachable'].includes(error.code)) throw error;
      let result;
      if (id === 'status.get') result = offlineOperationStatus(home, {unreachable:error.code === 'app_unreachable'});
      if (id === 'app.quit' && error.code === 'app_not_running' && quitOfflineApp(home, {signal:opts.signal}))
        result = {shuttingDown:true};
      if (!result) throw error;
      if (options.strict ?? env.FARAVAN_OPS_STRICT === '1') validate(opById(id).output, result, 'output of ' + id);
      return result;
    }
  }
  async function invoke(id, input, opts) {
    const op = opById(id);
    if (!op) throw opError('unknown_operation', 404, 'There is no operation ' + JSON.stringify(id) + '.');
    // A newer client may reach an app with older safety classifications. Guard here before discovery/autostart too.
    if (op.safety === 'human') throw opError('human_only', 403, op.description);
    validate(op.input, input);
    checkRetryKey(opts.idempotencyKey);
    // A caller may restrict this call (MCP tool metadata); the restriction reaches every request the call makes.
    // A saved startup failure belongs to the existing retrying resident. Reading
    // it must not launch a competing app. Without one, retain normal autostart.
    const allowAutostart = autostart && id !== 'app.quit' && !(id === 'status.get' && offlineOperationStatus(home));
    const restricted = {...callerHeaders, ...(opts.telemetryOff ? {'faravan-telemetry':'off'} : {})}, callRest = restWith(restricted, allowAutostart);
    let effect;
    if (sendsJob(id) && (opts.confirmed === true || !input.circle || input.expected_circle_id || input.expected_default_circle)) {
      const prepared = resolveJobRecipient(input, await callRest('GET','/api/circles', {signal:opts.signal}));
      input = prepared.input; effect = op.confirm({...input,circle:prepared.circle.name ?? prepared.circle.id});
    }
    if (!appMayAuthorize(op.id)) checkConfirmation(op, input, opts.confirmed, effect);
    if (opts.signal?.aborted) throw opError('cancelled', 499, 'The request was cancelled.');
    if ((op.rest || appMayAuthorize(id)) && !legacyApp) {
      // One place checks confirmation and remembers idempotency keys: the app.
      try {
        const result = await appRequest(await connection({allowAutostart}), 'POST', '/api/ops/' + id, {body:input, signal:opts.signal, fetchImpl,
          headers:{...restricted, ...(opts.confirmed ? {'faravan-confirm':'yes'} : {}), ...(opts.idempotencyKey ? {'idempotency-key':opts.idempotencyKey} : {})}});
        if (options.strict ?? env.FARAVAN_OPS_STRICT === '1') validate(op.output, result, 'output of ' + op.id);
        return result;
      } catch (error) {
        // An app started before this version (it updates between jobs, so a newer CLI can meet an older app) has no
        // /api/ops: call its route directly; runOp below checks input and confirmation here instead.
        if (error.status !== 404 || error.code !== 'not_found') throw error;
        // A route's own 404 (a missing approval, say) also says not_found: only an app without GET /api/ops is older.
        const listing = await appRequest(await connection({allowAutostart}), 'GET', '/api/ops', {headers:restricted, fetchImpl}).then(() => true, e => e.status === 404 ? false : true);
        if (listing) throw error;
        legacyApp = true;
      }
    }
    if (legacyApp && sendsJob(id) && input.freeze_audience)
      throw opError('app_too_old', 409, 'Update the Faravan app before sending a job with a frozen audience.');
    if (legacyApp && opts.idempotencyKey && op.safety !== 'read')
      throw opError('idempotency_unsupported', 409, 'Update the Faravan app before retrying a keyed write. This older app cannot remember its answer.');
    return runOp(id, input, {...options, home, rest:callRest, discover:() => discoverApp(home), startApp:() => startAppProcess(home, {env}).then(started => (app = started)),
      call:(inner, value, extra = {}) => call(inner, value, {...opts, idempotencyKey:sendsJob(inner)?opts.idempotencyKey:undefined, ...(extra.signal ? {signal:extra.signal} : {})}),
      confirmed:opts.confirmed === true, idempotencyKey:opts.idempotencyKey, signal:opts.signal, progress:opts.progress,
      strict:options.strict ?? env.FARAVAN_OPS_STRICT === '1'});
  }
  return {call, rest, connection, home};
}

// Only these calls can use an app-owned standing permission. An older app's
// fallback still runs runOp without a policy, so it keeps per-call confirmation.
export const appMayAuthorize = id => ['jobs.submit','jobs.send_and_wait','jobs.apply'].includes(id);
