/**
 * Refresh of Faravan's own OAuth sign-in for one account, so a usage read never meets an expired token. It runs a
 * refresh_token grant against the provider's token endpoint (usage-provider-records.mjs `refresh`), checks the new token with
 * a host read that must name the same account (usage-host-reader.mjs `verify`), and saves the rotated pair as a new provider
 * generation under the credential lock (usage-account-store.mjs `rotate`). The old generation is never removed.
 *
 *  - Faravan refreshes when the remaining lifetime falls below `marginMs`.
 *  - One flight per account: concurrent callers share one request and one save.
 *  - The rotated refresh token is one-use at some providers, so the reply is staged to the owner-only store BEFORE the
 *    verification read. A crash between the reply and the save is finished from the staged pair, with no second request.
 *  - A rejected grant (invalid_grant) makes only this account unknown: it is not retried until the person signs in again,
 *    and no token or reply body is ever returned or logged.
 *  - HTTPS to the record's host only, no redirect with a secret. A 429 ends this exchange;
 *    full Retry-After delays the next caller, with no in-flight retry or truncated server deadline.
 *
 * The request body format ({grant_type, refresh_token, client_id}, JSON) is not probe-verified.
 */
import {PROVIDER_RECORDS} from './usage-provider-records.mjs';
import {providerOfKey} from './lending-account-key.mjs';

export const REFRESH_MARGIN_MS = 10 * 60_000;
const BACKOFF_CAP_MS = 15 * 60_000;

// Server deadlines are not capped by the local exponential-backoff setting.
function refreshRetryAt(header, at) {
  const value = String(header ?? '').trim();
  if (!value) return null;
  const deadline = /^\d+$/.test(value) ? at + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline >= 0 ? Math.max(at, deadline) : null;
}

export function createUsageTokenRefresher({store, reader, records = PROVIDER_RECORDS, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true}); }),
  timeoutMs = 20_000, marginMs = REFRESH_MARGIN_MS, backoffMs = 60_000} = {}) {
  const flights = new Map();
  const rejected = new Map();   // `${accountKey}\0${generation}` -> reason: no new request until the sign-in changes
  const stats = {requests: 0, saves: 0};

  const isDue = cred => cred.kind === 'oauth' && Boolean(cred.refresh) && Number.isFinite(cred.expiresAt) && cred.expiresAt - now() < marginMs;

  // A successor record vouches for an identity only while its generation is the credential in use.
  const currentSuccessorIdentity = async (accountKey, generation) => { const record = await store.successor?.(accountKey); return record?.generation === generation ? record.identity_sha256_16 : null; };

  async function exchange(record, refreshToken) {
    const target = new URL(record.refresh.url);
    if (target.protocol !== 'https:' || !record.refresh.hosts.includes(target.hostname)) return {kind: 'unavailable', reason: 'host_not_allowed'};
    for (let tries = 1; ; tries++) {
      let reply;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        stats.requests++;
        reply = await fetchImpl(target.href, {method: 'POST', redirect: 'manual', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
          body: JSON.stringify({grant_type: 'refresh_token', refresh_token: refreshToken, client_id: record.refresh.clientId}),
          signal: timeout});
      } catch { return {kind: 'unavailable', reason: 'refresh_unavailable'}; }
      if (reply.status === 429) {
        return {kind: 'unavailable', reason: 'refresh_throttled',
          retryAtMs: refreshRetryAt(reply.headers?.get?.('retry-after'), now())};
      }
      let body = null;
      try { body = await reply.json(); } catch { body = null; }
      if (reply.status === 200) return {kind: 'ok', body};
      if ((reply.status === 400 || reply.status === 401) && (reply.status === 401 || body?.error === 'invalid_grant')) return {kind: 'rejected'};
      return {kind: 'unavailable', reason: 'refresh_unavailable'};
    }
  }

  // The provider's own file shape, with the reply merged into the current one so nothing else in it is lost.
  function merged(provider, old, body, at = now()) {
    const now = () => at;
    if (typeof body?.access_token !== 'string' || !body.access_token) return null;
    if (provider === 'claude') {
      const expires = Number(body.expires_in);
      return {...old, claudeAiOauth: {...old.claudeAiOauth, accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : old.claudeAiOauth.refreshToken,
        expiresAt: Number.isFinite(expires) && expires > 0 ? now() + expires * 1000 : old.claudeAiOauth.expiresAt}};
    }
    return {...old, last_refresh: new Date(now()).toISOString(), tokens: {...old.tokens, access_token: body.access_token,
      refresh_token: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : old.tokens.refresh_token,
      ...(typeof body.id_token === 'string' && body.id_token ? {id_token: body.id_token} : {})}};
  }

  async function finish(accountKey, cred, value) {
    const provider = providerOfKey(accountKey);
    const result = await store.rotate(accountKey, {value, now,
      verify: bearer => reader.verify({provider, accountKey, bearer, kind: 'oauth'})});
    if (result.ok) { await store.clearStaged(accountKey); stats.saves++; return {ok: true, refreshed: true, generation: result.generation}; }
    if (result.reason === 'generation_changed') { await store.clearStaged(accountKey); return {ok: true, refreshed: false}; }
    if (result.reason === 'identity_changed') {
      await store.clearStaged(accountKey);
      rejected.set(`${accountKey}\u0000${cred.generation}`, 'identity_changed');
      return {ok: false, reason: 'identity_changed', account_state: 'unknown'};
    }
    // verify_failed and the rest are transient: the staged pair stays so the next call retries without a new request.
    return {ok: false, reason: result.reason, account_state: 'retry'};
  }

  // A 200 reply held in memory when it could not be staged to disk. It is never dropped: the next call in this process uses it.
  const held = new Map();   // `${accountKey}\0${generation}` -> {raw, at}

  // Turn a received reply into a provider file and finish. Any failure here keeps the reply and the old entry, and reads as retry.
  async function complete(accountKey, cred, reply) {
    let value;
    try {
      if (reply.value) value = reply.value;
      else {
        const {value: old} = await store.value(accountKey);
        value = merged(providerOfKey(accountKey), old, reply.raw, reply.at);
      }
    } catch { value = null; }
    if (!value) return {ok: false, reason: 'refresh_reply_invalid', account_state: 'retry'};
    if (!reply.value) {
      try { await store.stageRefresh(accountKey, {priorGeneration: cred.generation, value, now: () => reply.at}); }
      catch (error) { held.set(`${accountKey}\u0000${cred.generation}`, reply); return {ok: false, reason: error?.code === 'usage_credential_locked' ? 'credential_locked' : 'refresh_not_saved', account_state: 'retry'}; }
    }
    return finish(accountKey, cred, value);
  }

  // After a retry outcome (provider 5xx or 429, a failed check, a reply that could not be kept) the account waits before it sends
  // another request, so no guard read pays for a request or a sleep. The wait doubles to a cap and ends on any other outcome.
  const backoff = new Map();   // accountKey -> {failures, until}
  async function run(accountKey, options) {
    const waiting = backoff.get(accountKey);
    if (waiting && now() < waiting.until) return {ok: false, reason: 'refresh_backoff', account_state: 'retry'};
    let release = null;
    // One refresh of an account at a time across the processes that share this home. The credential is read after the lock is held.
    try { release = await store.lockRefresh?.(accountKey) ?? null; } catch { return {ok: false, reason: 'refresh_in_progress', account_state: 'retry'}; }
    let result;
    try { result = await runLocked(accountKey, options); }
    // A sign-in writer holds the credential lock: nothing was saved, and the caller is told to try again later.
    catch (error) { if (error?.code !== 'usage_credential_locked') throw error; result = {ok: false, reason: 'credential_locked', account_state: 'retry'}; }
    finally { release?.(); }
    if (!result.ok && result.account_state === 'retry') {
      const failures = (waiting?.failures ?? 0) + 1;
      backoff.set(accountKey, {failures, until: Math.max(
        now() + Math.min(backoffMs * 2 ** (failures - 1), BACKOFF_CAP_MS),
        result.retryAtMs ?? 0)});
    } else backoff.delete(accountKey);
    return result;
  }

  async function runLocked(accountKey, {force, ifGeneration}) {
    let cred;
    try { cred = await store.credential(accountKey); } catch { return {ok: false, reason: 'usage_credential_unavailable', account_state: 'unknown'}; }
    if (cred.kind !== 'oauth' || !cred.refresh) return {ok: false, reason: 'refresh_unsupported', account_state: 'none'};
    if (ifGeneration != null && cred.generation !== ifGeneration) return {ok: true, refreshed: false, generation: cred.generation};
    if (!force && !isDue(cred)) return {ok: true, refreshed: false, generation: cred.generation};
    const memo = rejected.get(`${accountKey}\u0000${cred.generation}`);
    if (memo) return {ok: false, reason: memo, account_state: 'unknown'};
    const provider = providerOfKey(accountKey), record = records[provider];
    if (!record?.refresh) return {ok: false, reason: 'refresh_unsupported', account_state: 'none'};
    const heldKey = `${accountKey}\u0000${cred.generation}`;
    let staged = await store.stagedRefresh(accountKey);
    if (staged && staged.prior_generation !== cred.generation) { await store.clearStaged(accountKey); staged = null; }
    if (staged) return complete(accountKey, cred, staged.value ? {value: staged.value} : {raw: staged.raw, at: staged.staged_at});
    if (held.has(heldKey)) return complete(accountKey, cred, held.get(heldKey));
    // The new token is checked against the account's identity. With none stored, bind it now with the current token: this read
    // is made before the request, so nothing is spent if it cannot bind.
    if (typeof store.identity === 'function' && !(await store.identity(accountKey)) && !await currentSuccessorIdentity(accountKey, cred.generation)) {
      const bound = await reader.verify({provider, accountKey, bearer: cred.bearer, kind: 'oauth'}).catch(() => ({ok: false}));
      if (!bound?.ok || !bound.identity_sha256_16 || !(await store.bindIdentity(accountKey, cred.generation, bound.identity_sha256_16).catch(() => false)))
        return {ok: false, reason: 'identity_unbound', account_state: 'retry'};
    }
    const reply = await exchange(record, cred.refresh);
    if (reply.kind === 'rejected') { rejected.set(heldKey, 'invalid_grant'); return {ok: false, reason: 'invalid_grant', account_state: 'unknown'}; }
    if (reply.kind !== 'ok') return {ok: false, reason: reply.reason, account_state: 'retry',
      ...(reply.retryAtMs != null ? {retryAtMs: reply.retryAtMs} : {})};
    // Stage the reply as received BEFORE parsing or looking anything up: the provider has already rotated the token.
    const received = {raw: reply.body, at: now()};
    try { await store.stageRefresh(accountKey, {priorGeneration: cred.generation, raw: received.raw, now: () => received.at}); }
    catch (error) { held.set(heldKey, received); return {ok: false, reason: error?.code === 'usage_credential_locked' ? 'credential_locked' : 'refresh_not_saved', account_state: 'retry'}; }
    return complete(accountKey, cred, received);
  }

  /**
   * Refresh one account if it is due (or `force`). `ifGeneration` makes the call a no-op once the credential has moved on.
   * Returns {ok:true, refreshed} or {ok:false, reason, account_state: 'unknown'|'retry'|'none'}; never a token.
   * The flight belongs to the account, not to a caller: it has its own timeouts and takes no caller's signal. A caller's abort
   * only ends that caller's wait, so a reply the provider already rotated is never lost to a cancelled caller.
   */
  function refresh(accountKey, {force = false, ifGeneration = null, signal} = {}) {
    let flight = flights.get(accountKey);
    if (!flight) {
      flight = Promise.resolve().then(() => run(accountKey, {force, ifGeneration}))
        .finally(() => { if (flights.get(accountKey) === flight) flights.delete(accountKey); });
      flights.set(accountKey, flight);
    }
    if (!signal) return flight;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      const onAbort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, {once: true});
      flight.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Why the account's refresh was rejected for its current sign-in, or null. */
  const rejection = async accountKey => {
    const cred = await store.credential(accountKey).catch(() => null);
    return cred ? rejected.get(`${accountKey}\u0000${cred.generation}`) ?? null : null;
  };

  return {refresh, isDue, rejection, requests: () => ({...stats})};
}
