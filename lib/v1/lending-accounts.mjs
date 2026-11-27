import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableJson } from '../durable-write.mjs';
import { acquireProcessLockSync } from './lock.mjs';

/**
 * Local, standalone lending account identities. Origin is descriptive JSON metadata,
 * never identity. No credentials, ledger changes, provider discovery or app wiring.
 * All operations reload under the ledger's process-lock idiom.
 */
const migrations = new WeakMap();
const empty = () => ({ schema_version: 1, accounts: [], migrations: [] });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const corrupt = () => Object.assign(new Error('Lending account registry is corrupt or has an unknown format'),
  { code: 'account_registry_corrupt' });
const keys = (value, required, optional = []) => object(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

// Do not silently discard undefined, non-finite numbers, cycles or non-JSON objects.
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && Array.from(value).every(v => json(v, ancestors))
    : Object.values(value).every(v => json(v, ancestors));
  ancestors.delete(value);
  return valid;
}
function validAccount(a) {
  return keys(a, ['id', 'provider', 'label', 'enabled', 'created_at'], ['origin', 'legacy_provider', 'operation_key', 'removed']) &&
    uuid(a.id) && string(a.provider) && typeof a.label === 'string' &&
    typeof a.enabled === 'boolean' && Number.isSafeInteger(a.created_at) && a.created_at >= 0 &&
    (!Object.hasOwn(a, 'removed') || (a.removed === true && a.enabled === false)) &&
    (!Object.hasOwn(a, 'origin') || json(a.origin)) &&
    (!Object.hasOwn(a, 'operation_key') || string(a.operation_key)) &&
    (!Object.hasOwn(a, 'legacy_provider') || a.legacy_provider === a.provider);
}
function validate(data) {
  if (!keys(data, ['schema_version', 'accounts', 'migrations']) || data.schema_version !== 1 ||
      !Array.isArray(data.accounts) || !Array.isArray(data.migrations)) throw corrupt();
  const ids = new Set(), providers = new Set(), reserved = new Set(), opKeys = new Set();
  for (const a of data.accounts) {
    if (!validAccount(a) || ids.has(a.id)) throw corrupt();
    ids.add(a.id);
    if (Object.hasOwn(a, 'operation_key')) {
      if (opKeys.has(a.operation_key)) throw corrupt();
      opKeys.add(a.operation_key);
    }
  }
  for (const j of data.migrations) {
    if (!keys(j, ['provider', 'id', 'phase'], j?.phase === 'prepared' ? ['account'] : []) ||
        !string(j.provider) || !uuid(j.id) || providers.has(j.provider) || reserved.has(j.id) ||
        !['prepared', 'installed', 'complete'].includes(j.phase)) throw corrupt();
    providers.add(j.provider); reserved.add(j.id);
    const account = data.accounts.find(a => a.id === j.id);
    if (j.phase === 'prepared') {
      if (!validAccount(j.account) || j.account.id !== j.id || j.account.provider !== j.provider ||
          j.account.legacy_provider !== j.provider || account) throw corrupt();
    } else if (!account || account.provider !== j.provider || account.legacy_provider !== j.provider) throw corrupt();
  }
  for (const a of data.accounts) {
    if (Object.hasOwn(a, 'legacy_provider') &&
        !data.migrations.some(j => j.provider === a.provider && j.id === a.id && j.phase !== 'prepared')) throw corrupt();
  }
  return data;
}

// Resume every durable intent, even if the caller's current provider list no longer
// includes it. Never regenerate an id after intent publication.
function resumeMigration(data, j, save) {
  if (j.phase === 'prepared') {
    data.accounts.push(j.account);
    delete j.account;
    j.phase = 'installed'; save(data);
  }
  if (j.phase === 'installed') { j.phase = 'complete'; save(data); }
}

export function createAccountRegistry({ file, now = Date.now, lockWaitMs = 2000 } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('Account registry needs an absolute file');
  if (typeof now !== 'function' || !Number.isFinite(lockWaitMs) || lockWaitMs < 0)
    throw new TypeError('Invalid account registry clock or lock wait');
  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    let data;
    try { data = JSON.parse(text); } catch { throw corrupt(); }
    return validate(data);
  }
  // Counts completed durable writes, so an operation that wrote nothing can tell and
  // re-establish the persistence barriers (see confirm).
  let writes = 0;
  function save(data) { durableJson(file, validate(data)); writes++; }
  // A failed save may have left a renamed file whose directory entry never reached disk. A
  // retry that finds that visible state must not acknowledge it unconfirmed: rewrite the
  // validated bytes, which redoes the file and directory fsyncs. A failure still throws.
  function confirm(data) { save(data); }
  let writesAtLockStart = 0;
  function locked(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = performance.now() + lockWaitMs;
    let release;
    for (;;) {
      try { release = acquireProcessLockSync(file + '.lock'); break; }
      catch (error) {
        if (error.code !== 'lock_busy' || performance.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    let failed = false;
    try {
      const data = load();
      writesAtLockStart = writes;
      // A crash can leave a published migration intent. Finish it before any caller
      // sees the registry, so list/get/resolve never miss a recoverable account.
      for (const j of data.migrations) resumeMigration(data, j, save);
      return fn(data);
    } catch (error) { failed = true; throw error; }
    finally {
      try { release(); } catch (error) { if (!failed) throw error; }
    }
  }
  function normalize(input = {}) {
    if (!object(input) || !Object.keys(input).every(k => ['provider', 'label', 'origin', 'key'].includes(k)))
      throw new TypeError('Unknown account creation field');
    const { provider, label = provider, origin, key } = input;
    if (!string(provider) || typeof label !== 'string' || (origin !== undefined && !json(origin)) ||
        (key !== undefined && !string(key)))
      throw new TypeError('Invalid account provider, label, JSON origin or operation key');
    return { provider, label, origin, key };
  }
  function makeAccount(data, input, enabled = false) {
    const { provider, label, origin, key } = normalize(input);
    const created_at = now();
    if (!Number.isSafeInteger(created_at) || created_at < 0) throw new TypeError('Invalid account creation time');
    let id;
    do { id = randomUUID(); }
    while (data.accounts.some(a => a.id === id) || data.migrations.some(j => j.id === id));
    return { id, provider, label, enabled, created_at,
      ...(origin === undefined ? {} : { origin: clone(origin) }),
      ...(key === undefined ? {} : { operation_key: key }) };
  }
  // Key order never changes the meaning of origin metadata.
  const canonical = value => JSON.stringify(value, (_k, v) => object(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);
  const registry = {
    // Active accounts. A removed account keeps its row (its id may still appear in history) but is not listed.
    list() { return locked(data => clone(data.accounts.filter(a => a.removed !== true))); },
    // Internal admission inventory includes disabled removal rows; do not expose it through list().
    listForPool() { return locked(data => clone(data.accounts)); },
    get(id) { return locked(data => clone(data.accounts.find(a => a.id === id) ?? null)); },
    /**
     * Pass a caller-chosen `key` to make creation retry-safe: if the first attempt
     * committed but threw before returning, the same key returns that account
     * instead of appending a second one. Provider/label never dedupe: independent
     * accounts may share both.
     */
    add(input) {
      // Validate the whole payload first: a replay with a bad field is still a caller bug.
      const wanted = normalize(input);
      return locked(data => {
        if (wanted.key !== undefined) {
          const existing = data.accounts.find(a => a.operation_key === wanted.key);
          if (existing) {
            if (existing.provider !== wanted.provider || existing.label !== wanted.label ||
                canonical(existing.origin) !== canonical(wanted.origin)) throw Object.assign(
              new Error('Operation key already used for a different account'), { code: 'account_key_conflict' });
            confirm(data);
            return clone(existing);
          }
        }
        const account = makeAccount(data, input);
        data.accounts.push(account); save(data);
        return clone(account);
      });
    },
    setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
      return locked(data => {
        const account = data.accounts.find(a => a.id === id);
        if (!account) return null;
        account.enabled = enabled;
        save(data); // also confirms an already-visible change whose first barrier failed
        return clone(account);
      });
    },
    // The owner's order for one provider is the order of its rows. The listed ids move to the front of that provider's
    // slots in the given order; accounts not listed keep their relative order after them.
    setOrder(provider, ids) {
      if (!string(provider) || !Array.isArray(ids) || !ids.every(string)) throw new TypeError('order needs a provider and account ids');
      return locked(data => {
        const slots = data.accounts.flatMap((a, i) => (a.provider === provider ? [i] : []));
        const own = slots.map(i => data.accounts[i]);
        const wanted = ids.map(id => own.find(a => a.id === id));
        if (wanted.some(a => !a) || new Set(ids).size !== ids.length) throw new TypeError('order names an account that is not this provider\'s');
        const next = [...wanted, ...own.filter(a => !ids.includes(a.id))];
        slots.forEach((slot, n) => { data.accounts[slot] = next[n]; });
        save(data);
        return clone(next.filter(a => a.removed !== true));
      });
    },
    // Disables the account for good: it leaves list(), and get() still answers for old references.
    markRemoved(id) {
      return locked(data => {
        const account = data.accounts.find(a => a.id === id);
        if (!account) return null;
        account.enabled = false; account.removed = true;
        save(data);
        return clone(account);
      });
    },
    resolve({ provider, accountId } = {}) {
      return locked(data => {
        // An explicit but unknown/disabled id never falls back to a provider.
        const candidates = accountId !== undefined
          ? data.accounts.filter(a => a.id === accountId && a.enabled)
          : data.accounts.filter(a => a.provider === provider && a.enabled);
        // Several enabled accounts of one provider are an owner-ordered list: the first one in the order is chosen.
        if (!candidates.length) return { ok: false, reason: 'none' };
        return { ok: true, account: clone(candidates[0]) };
      });
    },
  };
  migrations.set(registry, providers => locked(data => {
    for (const provider of providers) {
      // Settings and counters outlive removal; they must not resurrect this provider as legacy.
      if (data.migrations.some(j => j.provider === provider) || data.accounts.some(a => a.provider === provider && a.removed === true)) continue;
      const account = { ...makeAccount(data, { provider }, true), legacy_provider: provider };
      const j = { provider, id: account.id, phase: 'prepared', account };
      data.migrations.push(j); save(data);
      resumeMigration(data, j, save);
    }
    // Nothing written this call: the journal may still be a visible state whose last barrier failed.
    if (writes === writesAtLockStart && data.migrations.length) confirm(data);
    return clone(data.accounts.filter(a => Object.hasOwn(a, 'legacy_provider')));
  }));
  return registry;
}

/**
 * providers: array of provider names already known by the caller to have legacy
 * lending state; [] means empty install. This module neither probes nor modifies
 * that state. Repeated names are deduplicated. Returns all migrated accounts.
 *
 * The registry file is also the journal: prepared persists the chosen identity,
 * installed atomically publishes that account, complete seals the migration.
 * Each boundary uses durableJson; a failed save propagates and a retry reloads
 * disk, including a rename that succeeded before its durability barrier failed.
 */
export function migrateLegacyAccounts(registry, { providers = [] } = {}) {
  const migrate = migrations.get(registry);
  if (!migrate) throw new TypeError('Expected an account registry');
  if (!Array.isArray(providers) || !providers.every(string)) throw new TypeError('providers must be provider names with legacy state');
  return migrate([...new Set(providers)]);
}
