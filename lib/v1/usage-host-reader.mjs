/**
 * The host usage reader. It makes the same request the guest probe script made (lending-probe.mjs guestProbeScript), from
 * the host, with the bearer of one account (usage-account-store.mjs). Its answer is the guest's one line, so the parsers and
 * identity hashing in lending-probe.mjs and lending-meter.mjs run unchanged. No sandbox, CLI or model is involved.
 *
 * Budget per cycle and account (D4): ONE usage GET. Claude adds ONE profile GET only on a rebind (no cached identity for
 * this account and generation, or after a 401). A 429 is retried at most twice, so the ceilings are Claude 3, Claude on
 * rebind 6, Codex 3. Concurrent callers for one account and generation share one cycle.
 *
 * A bearer goes only to an HTTPS host on the record's allow-list, and no redirect is followed while it is attached.
 * A reply for a generation that is no longer current is discarded.
 */
import {createHash} from 'node:crypto';
import {PROVIDER_RECORDS} from './usage-provider-records.mjs';

const hx = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex').slice(0, 16);
const pick = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  ? Object.fromEntries(keys.filter(key => key in object).map(key => [key, object[key]])) : null;
const BUSY = new Set(['credential_locked', 'refresh_in_progress']);
const failure = (probeFailure, code) => Object.assign(new Error('The host usage read could not run.'),
  {probe_failure: probeFailure, ...(code ? {code} : {})});

function codexIdentity(cred, data) {
  let account = data.account_id;
  const email = data.email;
  if (typeof email !== 'string' || !email.trim()) return {status: 200};
  if (account == null || account === '') {
    // Older usage replies omit the account ID. Bind the reply to the exact
    // bearer accepted by the usage endpoint and to the saved sign-in.
    try {
      const claims = JSON.parse(Buffer.from(cred.bearer.split('.')[1], 'base64url'));
      const tokenAccount = claims['https://api.openai.com/auth']?.chatgpt_account_id;
      const tokenEmail = claims['https://api.openai.com/profile']?.email;
      if (typeof tokenAccount === 'string' && tokenAccount === (cred.chatgptAccountId ?? cred.fallbackAccountId) && typeof tokenEmail === 'string' && hx(email) === hx(tokenEmail))
        account = tokenAccount;
    } catch {}
  }
  if (typeof account !== 'string' || !account.trim() || (cred.chatgptAccountId && account !== cred.chatgptAccountId))
    return {status: 200};
  return {status: 200, account_sha256_16: hx(account), email_sha256_16: hx(email)};
}

function project(record, data) {
  const body = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return body;
  for (const [key, keys] of Object.entries(record.usage.keep)) {
    if (!(key in data)) continue;
    const value = data[key];
    if (keys === true) { if (typeof value === 'string') body[key] = value.slice(0, 20); }
    else if (Array.isArray(value)) body[key] = value.slice(0, 32).map(item => pick(item, keys));
    else if (key === 'rate_limit' && value && typeof value === 'object') {
      const out = pick(value, keys);
      for (const window of ['primary_window', 'secondary_window']) if (out[window] != null) out[window] = pick(out[window], record.windowKeys);
      body[key] = out;
    } else body[key] = pick(value, keys);
  }
  return body;
}

/**
 * @param {{store: {credential: Function}, records?: object, fetchImpl?: Function, now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, timeoutMs?: number}} options
 */
export function createUsageHostReader({store, records = PROVIDER_RECORDS, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true}); }),
  timeoutMs = 20_000, refresher = null} = {}) {
  const identities = new Map();   // `${accountKey}\0${generation}` -> hashes, in memory only
  const flights = new Map();
  const stats = {usage: 0, identity: 0};

  async function get(record, url, headers, bearer, signal) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !record.hosts.includes(target.hostname)) throw failure('probe_unavailable', 'host_not_allowed');
    let tries = 0;
    for (;;) {
      tries++;
      const timeout = AbortSignal.timeout(timeoutMs);
      const reply = await fetchImpl(target.href, {method: 'GET', redirect: 'manual', headers: {...headers, Authorization: 'Bearer ' + bearer},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
      // A redirect is never followed with the token: it is an error status.
      if (reply.status === 429 && tries < 3) {
        const header = reply.headers?.get?.('retry-after'), wait = header == null || String(header).trim() === '' ? NaN : Number(header);
        await sleep(Math.min(Math.max(Number.isFinite(wait) ? wait : [5, 10][tries - 1], 0), 15) * 1000, signal);
        signal?.throwIfAborted();
        continue;
      }
      return {status: reply.status >= 300 && reply.status < 400 ? 0 : reply.status, tries, reply};
    }
  }

  async function cycle(cred, record, signal) {
    const out = {faravan_probe: 1, status: 0, body: {}, attempts: {usage: 0, identity: 0}};
    // The reading is as old as the request: a slow answer, a 429 wait or the identity read must not make it look fresh.
    const dispatchedAt = now();
    const bound = `${cred.accountKey}\u0000${cred.generation}`;
    let data = {};
    let usageStatus = 0, failureClass = null;
    try {
      const usage = await get(record, record.usage.url, record.usage.headers, cred.bearer, signal);
      stats.usage += usage.tries; out.attempts.usage = usage.tries; usageStatus = usage.status;
      if (usageStatus === 200) { data = await usage.reply.json(); out.body = project(record, data); }
    } catch (error) {
      if (signal?.aborted) throw failure('cancelled');
      if (error?.probe_failure) throw error;
      usageStatus = -1;
      failureClass = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : error instanceof SyntaxError ? 'parse_failed' : 'network_error';
    }
    out.status = usageStatus;
    if (failureClass) out.failure_class = failureClass;
    if (usageStatus === 401 || usageStatus === 403) identities.delete(bound);
    let identity = null;
    if (record.identity && usageStatus === 200) {
      identity = identities.get(bound) ?? null;
      if (!identity) {
        identity = {status: -1};
        try {
          const profile = await get(record, record.identity.url, record.identity.headers, cred.bearer, signal);
          stats.identity += profile.tries; out.attempts.identity = profile.tries;
          identity = {status: profile.status};
          if (profile.status === 200) {
            const doc = await profile.reply.json();
            const account = doc?.account && typeof doc.account === 'object' ? doc.account : {};
            const org = doc?.organization && typeof doc.organization === 'object' ? doc.organization : {};
            for (const [name, source, key] of [['account_sha256_16', account, 'uuid'], ['email_sha256_16', account, 'email'], ['org_sha256_16', org, 'uuid']])
              if (typeof source[key] === 'string' && source[key].trim() &&
                  source[key] === source[key].trim()) identity[name] = hx(source[key]);
            identities.set(bound, identity);
          }
        } catch { if (signal?.aborted) throw failure('cancelled'); identity = {status: -1}; }
      }
    } else if (!record.identity && record.parser === 'codex' && usageStatus === 200 && data && typeof data === 'object') {
      identity = codexIdentity(cred, data);
    }
    if (identity) out.identity = identity;
    // Host-owned auth evidence (D3): this account's credential kind is a subscription sign-in, and this read returned 200.
    // It replaces the guest's `claude auth status`. A 200 alone proves nothing: the kind comes from the store.
    if (record.parser === 'claude' && usageStatus === 200 && record.subscriptionKinds.includes(cred.kind))
      out.guest_auth = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
    return {out, seenAt: dispatchedAt};
  }

  /**
   * One read, and on a 401 or 403 for an OAuth account at most ONE forced refresh and ONE re-read with the new sign-in. A refresh
   * that fails, or a second refusal, leaves the first refusal as the answer: the account reads as unknown and needs a new sign-in.
   * Callers for one account and generation share this flight, so concurrent refusals make one refresh request. A refresh that
   * finds the credential already replaced makes no request; the re-read then uses the replacement.
   */
  const expired = cred => cred.kind === 'oauth' && Number.isFinite(cred.expiresAt) && cred.expiresAt <= now();
  async function attempt(cred, record) {
    const first = await cycle(cred, record, undefined);
    const refused = first.out.status === 401 || first.out.status === 403;
    if (!refused || !refresher || cred.kind !== 'oauth') return {...first, generation: cred.generation};
    const outcome = await refresher.refresh(cred.accountKey, {force: true, ifGeneration: cred.generation})
      .catch(error => ({ok: false, reason: error?.code === 'usage_credential_locked' ? 'credential_locked' : 'refresh_unavailable'}));
    // Another refresh or a sign-in writer holds the account: say "try again shortly", and make no re-read and no auth claim.
    if (BUSY.has(outcome.reason)) throw failure('probe_unavailable', 'retry_later');
    if (!outcome.ok) return {...first, generation: cred.generation};
    let fresh;
    try { fresh = await store.credential(cred.accountKey); } catch { return {...first, generation: cred.generation}; }
    if (fresh.provider !== cred.provider || fresh.kind !== 'oauth') return {...first, generation: cred.generation};
    // The re-read passes the same expiry guard as a first read: a replacement already known to be expired is not sent.
    if (expired(fresh)) return {...first, generation: cred.generation};
    return {...await cycle(fresh, record, undefined), generation: fresh.generation};
  }

  /**
   * One host read, in the shape of runGuest: {exitCode, stdout, usage_seen_at, host_read, account_key, generation}.
   * It never reports an executor or a stop: a usage reading is not stop proof.
   */
  async function read({provider, accountKey, signal} = {}) {
    const record = records[provider];
    if (!record) throw failure('probe_unavailable', 'provider_unknown');
    let cred;
    try { cred = await store.credential(accountKey); } catch { throw failure('probe_unavailable', 'usage_credential_unavailable'); }
    if (refresher && cred.kind === 'oauth' && refresher.isDue(cred)) {
      // Refresh before expiry. A failed refresh makes only this account unknown; the old token is not tried once refused.
      const outcome = await refresher.refresh(accountKey, {ifGeneration: cred.generation, signal}).catch(error => ({ok: false, reason: error?.code === 'usage_credential_locked' ? 'credential_locked' : 'refresh_unavailable'}));
      // A busy credential lock is retry-later, not an unknown account: say so instead of reading on as if nothing happened.
      if (BUSY.has(outcome.reason)) throw failure('probe_unavailable', 'retry_later');
      if (outcome.ok) { try { cred = await store.credential(accountKey); } catch { throw failure('probe_unavailable', 'usage_credential_unavailable'); } }
      else if (outcome.account_state === 'unknown') throw failure('probe_unavailable', 'refresh_rejected');
    }
    // A credential known to be expired, and not replaced by the refresh above, is not sent: the account reads unknown.
    if (expired(cred)) throw failure('probe_unavailable', 'credential_expired');
    if (cred.provider !== provider) throw failure('probe_unavailable', 'account_provider_mismatch');
    if (!record.subscriptionKinds.includes(cred.kind)) throw failure('probe_unavailable', 'no_usage_endpoint');
    const key = `${cred.accountKey}\u0000${cred.generation}`;
    let flight = flights.get(key);
    if (!flight) {
      flight = attempt(cred, record).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
      flights.set(key, flight);
    }
    const abort = new Promise((_, reject) => {
      if (signal?.aborted) reject(failure('cancelled'));
      signal?.addEventListener('abort', () => reject(failure('cancelled')), {once: true});
    });
    const {out, seenAt, generation} = await Promise.race([flight, abort]);
    // A reply that finished after the credential changed names an older generation: discard it.
    const after = await store.credential(accountKey).catch(() => null);
    if (after?.generation !== generation) throw failure('cancelled');
    // The first successful read of a generation binds the account's identity on disk, so a refresh after a restart can compare.
    const hash = out.status === 200 ? out.identity?.account_sha256_16 : null;
    if (hash && typeof store.bindIdentity === 'function') await store.bindIdentity(accountKey, generation, hash).catch(() => {});
    return {exitCode: 0, stdout: JSON.stringify(out), usage_seen_at: seenAt, host_read: true,
      account_key: cred.accountKey, generation};
  }

  /**
   * Check a candidate bearer for an account before it is saved (D2): one fresh read with it, never cached.
   * Returns {ok, identity_sha256_16}. The caller compares the identity with the one stored for the account.
   */
  async function verify({provider, accountKey, bearer, kind = 'oauth', signal} = {}) {
    if (signal?.aborted) throw failure('cancelled');
    const record = records[provider];
    if (!record) return {ok: false};
    const bound = `${accountKey}\u0000verify`;
    identities.delete(bound);
    try {
      const fallbackAccountId = provider === 'codex' ? (await store.credential(accountKey)).chatgptAccountId : undefined;
      const {out} = await cycle({accountKey, generation: 'verify', bearer, kind, fallbackAccountId}, record, signal);
      if (signal?.aborted) throw failure('cancelled');
      const hash = out.identity?.account_sha256_16 ?? null;
      return {ok: out.status === 200 && Boolean(hash), identity_sha256_16: hash};
    } finally { identities.delete(bound); }
  }

  /** Requests made so far, for budget tests. */
  return {read, verify, requests: () => ({...stats}), forgetIdentity: accountKey => { for (const key of identities.keys()) if (key.startsWith(accountKey + '\u0000')) identities.delete(key); }};
}
