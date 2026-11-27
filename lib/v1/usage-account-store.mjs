/**
 * Faravan's own store of usage credentials, one entry per lending account key (lending-account-key.mjs). The host reader
 * (usage-host-reader.mjs) asks it for the bearer of one account and nothing else. It never reads the owner's own CLI
 * login (~/.claude, ~/.codex): every value here came from Faravan's sign-in or from an account the owner added.
 *
 *   `claude`, `codex`        Faravan's own sign-in, the current provider generation (credential-generations.mjs).
 *   `claude:<uuid>`          an account the owner added: a subscription setup token, or an API key (no usage endpoint).
 *
 * A credential is bound to a generation string. A read that finished for an older generation is discarded by the caller.
 * The bearer is returned in memory only: no log, error or status carries it.
 *
 * Rotation (D2) is atomic. A refreshed token set is accepted only when a host read with it succeeds and names the same
 * account. The new generation is then published and one successor record names both generations, the account's identity
 * hash and the original measurement time. A crash between those steps is repaired by `recover`.
 */
import {rename, rm, readFile, open, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireCredentialMutation} from '../sandbox-credentials.mjs';
import {acquireProcessLock} from './lock.mjs';
import {accountIdOfKey, isAccountKey, providerOfKey} from './lending-account-key.mjs';
import {readCurrentProviderValue, readClaudeAccount, readClaudeAccountValue, createProviderSource,
  publishProviderGeneration, currentProviderGeneration} from '../credential-generations.mjs';

const unavailable = reason => Object.assign(new Error('The usage credential for this account is unavailable.'),
  {code: 'usage_credential_unavailable', reason});
/** The `exp` claim of a JWT access token, in ms, or null. Read from the token already in memory; nothing is verified or logged. */
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}
const HASH16 = /^[0-9a-f]{16}$/;

// Owner-only: the directory is created 0700 and the file 0600. A failed write leaves no temp file behind.
async function write(file, text) {
  const directory = join(file, '..');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const pending = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = await open(pending, 'wx', 0o600);
    try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
    await rename(pending, file);
  } catch (error) {
    await rm(pending, {force: true}).catch(() => {});
    throw error;
  }
  const dir = await open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/**
 * The credential lock the sign-in writers hold (credential-changes.lock), held for one callback. It waits a bounded time for a
 * sign-in that holds it, and it lets other prepared jobs run: a rotation writes only a new provider generation.
 */
export const credentialLockMutation = (home, {leaseWaitMs = 30_000} = {}) => async run => {
  let release;
  try { release = await acquireCredentialMutation(home, {isolatedSources: true, concurrentSources: true, leaseWaitMs}); }
  catch (error) {
    if (error?.condition === 'mutation_lock_unavailable' || error?.code === 'credential_writer_unresolved') {
      throw Object.assign(new Error('The credential store is busy. Try again shortly.'), {code: 'usage_credential_locked'});
    }
    throw error;
  }
  try { return await run(); } finally { await release(); }
};

/**
 * @param {{home: string, withMutation?: (run: () => Promise<any>) => Promise<any>}} options
 *   `withMutation` serializes a rotation with the sign-in and credential writers (the caller passes the credential lock).
 */
export function createUsageAccountStore({home, withMutation = credentialLockMutation(home), refreshLockWaitMs = 0}) {
  // One writer per account in this process at a time (rotate, recover, refresh); the credential lock then orders this
  // process against the sign-in writers and other processes.
  const tails = new Map();
  function serialized(accountKey, work) {
    const run = (tails.get(accountKey) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    tails.set(accountKey, tail);
    tail.then(() => { if (tails.get(accountKey) === tail) tails.delete(accountKey); });
    return run;
  }

  const successorFile = key => join(home, 'usage-successor-' + key.replace(/[^a-z0-9-]/g, '_') + '.json');
  const pendingFile = key => successorFile(key) + '.pending';

  /**
   * The credential of one account: {accountKey, provider, kind, generation, bearer, refresh}. `kind` is
   * 'oauth' (Faravan's own sign-in), 'setup-token' or 'api-key'. `refresh` is the refresh token, present for 'oauth' only.
   * A missing or damaged entry throws usage_credential_unavailable with a reason: only this account reads unknown.
   */
  async function credential(accountKey) {
    if (!isAccountKey(accountKey)) throw unavailable('account_unknown');
    const provider = providerOfKey(accountKey), id = accountIdOfKey(accountKey);
    try {
      if (id === null) {
        const current = await readCurrentProviderValue(home, provider);
        if (!current) throw unavailable('not_signed_in');
        if (provider === 'claude') {
          const oauth = current.value.claudeAiOauth;
          return {accountKey, provider, kind: 'oauth', generation: current.id, digest: current.digest,
            bearer: oauth.accessToken, refresh: oauth.refreshToken, expiresAt: oauth.expiresAt};
        }
        const tokens = current.value.tokens;
        return {accountKey, provider, kind: 'oauth', generation: current.id, digest: current.digest,
          bearer: tokens.access_token, refresh: tokens.refresh_token, expiresAt: jwtExpiry(tokens.access_token),
          chatgptAccountId: typeof tokens.account_id === 'string' ? tokens.account_id : null};
      }
      if (provider === 'codex') {
        const added = await readAddedCodex(id);
        const tokens = added.value.tokens;
        return {accountKey, provider, kind: 'oauth', generation: added.generation, digest: added.generation,
          bearer: tokens.access_token, refresh: tokens.refresh_token, expiresAt: jwtExpiry(tokens.access_token),
          chatgptAccountId: typeof tokens.account_id === 'string' ? tokens.account_id : null};
      }
      if (provider !== 'claude') throw unavailable('account_unknown');
      const record = await readClaudeAccount(home, id);
      const value = await readClaudeAccountValue(home, record);
      return {accountKey, provider, kind: record.kind === 'api-key' ? 'api-key' : 'setup-token',
        generation: record.id, digest: record.digest, bearer: value, refresh: null, expiresAt: null};
    } catch (error) {
      throw error?.code === 'usage_credential_unavailable' ? error : unavailable('unreadable');
    }
  }

  // An added Codex account keeps its own sign-in (a Codex auth.json) in one owner-only file, with a generation string that
  // changes on every rotation. Added Claude accounts keep a setup token or API key and never rotate.
  const addedCodexFile = id => join(home, 'usage-account-codex-' + id + '.json');
  async function readAddedCodex(id) {
    const record = JSON.parse(await readFile(addedCodexFile(id), 'utf8'));
    if (record?.version !== 1 || record.account_id !== id || typeof record.generation !== 'string' || typeof record.value?.tokens?.access_token !== 'string') throw unavailable('unreadable');
    return record;
  }
  /** Save the sign-in of an added Codex account (a parsed Codex auth.json). It is the account's first generation. */
  const addCodexAccount = (id, value) => withMutation(() => write(addedCodexFile(id), JSON.stringify({version: 1, account_id: id, generation: randomUUID(), value})));

  /** The parsed provider file of an account, in memory, with its generation. The refresher merges a reply into it. */
  async function value(accountKey) {
    if (!isAccountKey(accountKey)) throw unavailable('account_unknown');
    if (accountIdOfKey(accountKey) !== null) {
      if (providerOfKey(accountKey) !== 'codex') throw unavailable('account_unknown');
      const added = await readAddedCodex(accountIdOfKey(accountKey)).catch(() => { throw unavailable('not_signed_in'); });
      return {generation: added.generation, value: added.value};
    }
    const current = await readCurrentProviderValue(home, providerOfKey(accountKey)).catch(() => null);
    if (!current) throw unavailable('not_signed_in');
    return {generation: current.id, value: current.value};
  }

  // A refresh reply can carry a one-use refresh token. It is staged here, owner-only, before the verification read, so a
  // crash between the reply and the save loses nothing: the next refresh finishes from the staged pair.
  const stagedFile = key => join(home, 'usage-refresh-staged-' + key.replace(/[^a-z0-9-]/g, '_') + '.json');
  // `raw` is the provider's reply as received; `value` is a merged provider file. Either keeps the one-use refresh token.
  const stageRefresh = (accountKey, {priorGeneration, value: staged = undefined, raw = undefined, now = Date.now}) => withMutation(() =>
    write(stagedFile(accountKey), JSON.stringify({version: 1, account_key: accountKey, prior_generation: priorGeneration, staged_at: now(),
      ...(raw !== undefined ? {raw} : {value: staged})})));
  async function stagedRefresh(accountKey) {
    try {
      const record = JSON.parse(await readFile(stagedFile(accountKey), 'utf8'));
      return record?.version === 1 && record.account_key === accountKey && (record.value || record.raw) && typeof record.prior_generation === 'string' ? record : null;
    } catch { return null; }
  }
  const clearStaged = accountKey => rm(stagedFile(accountKey), {force: true});

  // The identity hash of the account behind one credential generation. It holds no secret. It is written on the first
  // successful read of a generation and carried to the next generation by a rotation, so it survives a restart.
  const identityFile = key => join(home, 'usage-identity-' + key.replace(/[^a-z0-9-]/g, '_') + '.json');
  async function identity(accountKey) {
    try {
      const current = await credential(accountKey);
      const record = JSON.parse(await readFile(identityFile(accountKey), 'utf8'));
      return record?.version === 1 && record.account_key === accountKey && record.generation === current.generation && HASH16.test(record.identity_sha256_16 ?? '')
        ? record.identity_sha256_16 : null;
    } catch { return null; }
  }
  const bindIdentity = (accountKey, generation, hash) => serialized(accountKey, async () => {
    if (!HASH16.test(hash ?? '')) return false;
    const current = await credential(accountKey).catch(() => null);
    if (!current || current.generation !== generation || await identity(accountKey) !== null) return false;
    await write(identityFile(accountKey), JSON.stringify({version: 1, account_key: accountKey, generation, identity_sha256_16: hash, bound_at: Date.now()}));
    return true;
  });
  /** One refresher per account across processes that share this home: a held lock means another refresh is under way. */
  async function lockRefresh(accountKey) {
    await mkdir(home, {recursive: true, mode: 0o700});
    try { return await acquireProcessLock(join(home, 'usage-refresh-' + accountKey.replace(/[^a-z0-9-]/g, '_') + '.lock'), {timeoutMs: refreshLockWaitMs}); }
    catch (error) {
      if (error?.code === 'lock_busy') throw Object.assign(new Error('Another refresh of this account is under way.'), {code: 'usage_refresh_busy'});
      throw error;
    }
  }

  /** The recorded successor of an account, or null. It holds no secret. */
  async function successor(accountKey) {
    try {
      const record = JSON.parse(await readFile(successorFile(accountKey), 'utf8'));
      return record?.version === 1 && record.account_key === accountKey ? record : null;
    } catch { return null; }
  }

  /**
   * Replace the account's OAuth credential with a refreshed token set.
   * `tokens` is the provider's reply, in the provider's own file shape (`value`), already parsed.
   * `verify(bearer)` must do the host read with the new token and return {ok, identity_sha256_16}.
   * Returns {ok:true, generation} or {ok:false, reason}; on any refusal nothing was written.
   */
  function rotate(accountKey, options) { return serialized(accountKey, () => rotateNow(accountKey, options)); }
  async function rotateNow(accountKey, {value, verify, measuredAt, now = Date.now}) {
    const prior = await credential(accountKey);
    if (prior.kind !== 'oauth') return {ok: false, reason: 'rotation_unsupported'};
    const bearer = prior.provider === 'claude' ? value?.claudeAiOauth?.accessToken : value?.tokens?.access_token;
    if (typeof bearer !== 'string' || !bearer) return {ok: false, reason: 'refresh_reply_invalid'};
    // A successor record counts only while its output is the credential in use. After a newer sign-in it describes another account's history.
    const recorded = await successor(accountKey), before = recorded?.generation === prior.generation ? recorded : null, stored = await identity(accountKey);
    const answer = await verify(bearer).catch(() => ({ok: false}));
    if (!answer?.ok) return {ok: false, reason: 'verify_failed'};
    if (!HASH16.test(answer.identity_sha256_16 ?? '')) return {ok: false, reason: 'identity_unobserved'};
    // The old account's identity comes only from what was stored before this refresh. The answer to the check cannot supply it:
    // a first rotation that took "known" from the new token would accept any account.
    const known = stored ?? before?.identity_sha256_16 ?? null;
    // No bound identity means nothing proves the new token is the same account: nothing is saved.
    if (known === null) return {ok: false, reason: 'identity_unbound'};
    if (known !== answer.identity_sha256_16) return {ok: false, reason: 'identity_changed'};
    return withMutation(async () => {
      // The generation may have changed while the verification read ran: that read named an older credential.
      if ((await credential(accountKey)).generation !== prior.generation) return {ok: false, reason: 'generation_changed'};
      const intent = {version: 1, account_key: accountKey, prior_generation: prior.generation,
        identity_sha256_16: answer.identity_sha256_16, measured_at: before?.measured_at ?? measuredAt ?? now()};
      if (accountIdOfKey(accountKey) !== null) {
        // An added account is one file: the new generation and its value are replaced together.
        const generation = randomUUID();
        await write(addedCodexFile(accountIdOfKey(accountKey)), JSON.stringify({version: 1, account_id: accountIdOfKey(accountKey), generation, value}));
        await write(successorFile(accountKey), JSON.stringify({...intent, generation, carried: true}));
        await write(identityFile(accountKey), JSON.stringify({version: 1, account_key: accountKey, generation, identity_sha256_16: answer.identity_sha256_16, bound_at: now()}));
        return {ok: true, generation};
      }
      const source = await createProviderSource(home, prior.provider);
      // The intent names the source this rotation writes to. Recovery trusts a current generation only if it came from that source.
      await write(pendingFile(accountKey), JSON.stringify({...intent, output_source: source.id}));
      const file = prior.provider === 'claude' ? '.credentials.json' : 'auth.json';
      await write(join(source.directory, file), JSON.stringify(value));
      const published = await publishProviderGeneration(home, source);
      await write(successorFile(accountKey), JSON.stringify({...intent, generation: published.id, carried: true}));
      await write(identityFile(accountKey), JSON.stringify({version: 1, account_key: accountKey, generation: published.id, identity_sha256_16: answer.identity_sha256_16, bound_at: now()}));
      await rm(pendingFile(accountKey), {force: true});
      return {ok: true, generation: published.id};
    });
  }

  /**
   * Repair a rotation that stopped between publishing the new generation and writing its successor record. If the new
   * generation is current, the record is finished; if not, the intent is dropped and the old credential stays.
   */
  function recover(accountKey) { return serialized(accountKey, () => withMutation(() => recoverNow(accountKey))); }
  async function recoverNow(accountKey) {
    if (accountIdOfKey(accountKey) !== null) return 'none';
    let intent;
    try { intent = JSON.parse(await readFile(pendingFile(accountKey), 'utf8')); } catch { return 'none'; }
    const now = await currentProviderGeneration(home, providerOfKey(accountKey)).catch(() => null);
    // Only this rotation's own output counts. Any other newer generation (a later sign-in) is not credited to the intent;
    // an intent that names no output source cannot prove anything and is dropped.
    if (intent?.account_key === accountKey && typeof intent.output_source === 'string' && now?.source?.id === intent.output_source
      && now.id !== intent.prior_generation) {
      const {output_source, ...record} = intent;
      await write(successorFile(accountKey), JSON.stringify({...record, generation: now.id, carried: true}));
      await rm(pendingFile(accountKey), {force: true});
      return 'finished';
    }
    await rm(pendingFile(accountKey), {force: true});
    return 'dropped';
  }

  return {credential, value, addCodexAccount, identity, bindIdentity, lockRefresh, successor, rotate, recover, serialized, stageRefresh, stagedRefresh, clearStaged};
}
