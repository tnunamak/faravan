/**
 * The key under which one lending account's state is stored: meters, ledger rows, pins,
 * history, holds. The account that existed before multi-account lending (its registry
 * entry carries `legacy_provider`) keeps the bare provider name, so every row an
 * existing install already wrote stays addressable with no rewrite. Any account added
 * later gets `provider:<id>`. The provider stays the key for pricing, kappa priors and
 * parsing; it is never an account identity.
 */
const KEY = /^([a-z0-9][a-z0-9-]*)(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/;

export function accountKey(account) {
  if (!account || typeof account.provider !== 'string' || typeof account.id !== 'string')
    throw new TypeError('Expected a lending account');
  const key = Object.hasOwn(account, 'legacy_provider') ? account.provider : account.provider + ':' + account.id;
  if (!KEY.test(key)) throw new TypeError('Account has no valid storage key');
  return key;
}
export const isAccountKey = key => typeof key === 'string' && KEY.test(key);
export function providerOfKey(key) {
  const match = typeof key === 'string' ? KEY.exec(key) : null;
  if (!match) throw new TypeError('Not a lending account key');
  return match[1];
}
/** The registry id inside a key, or null for the legacy bare-provider key. */
export const accountIdOfKey = key => KEY.exec(key ?? '')?.[2] ?? null;

/**
 * A pool worker serves one account key and one numbered slot of it. Its id is `<accountKey>#<slot>`, so the
 * whole key survives: the slot is whatever follows the last `#`, and the key is never cut at a colon. An install
 * that already stores `claude:0` / `codex:1` rows keeps them: for the legacy bare-provider key the stored id is
 * `<provider>:<slot>`, and that form still parses. A key such as `claude:<uuid>` has no slot until a `#` gives one.
 */
const SLOT = /^(.+)#(\d+)$/;
const LEGACY_SLOT = /^([a-z0-9][a-z0-9-]*):(\d+)(?::.*)?$/;
export function parseChildId(id) {
  if (typeof id !== 'string') throw new TypeError('Not a worker id');
  const scoped = SLOT.exec(id);
  if (scoped && isAccountKey(scoped[1])) return {accountKey: scoped[1], slot: Number(scoped[2])};
  const legacy = LEGACY_SLOT.exec(id);
  if (legacy) return {accountKey: legacy[1], slot: Number(legacy[2])};
  return {accountKey: id, slot: null};
}
/** The id a worker is stored and reported under. The legacy key keeps the `provider:slot` form already on disk. */
export const childIdFor = (key, slot) => accountIdOfKey(key) === null ? key + ':' + slot : key + '#' + slot;
