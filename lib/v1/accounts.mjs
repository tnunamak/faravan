import fs from 'node:fs';
import path from 'node:path';
import { durableJson } from '../durable-write.mjs';
import { createStoreCoordinator } from '../store-lock.mjs';
import { createAccountVault } from './account-vault.mjs';

export const ok = value => ({ ok: true, value });
export function fault(code, accountId, retryAtMs = null) {
  let action = { id: 'retry', label: 'Retry' };
  if (/signed_out|reauthorization|uncertain/.test(code)) action = { id: 'sign_in', label: 'Sign in to this account' };
  if (/^signin_(failed|expired)$/.test(code)) action = { id: 'retry_signin', label: 'Retry sign-in' };
  if (code === 'account_exists') action = { id: 'select_account', label: 'Select existing account' };
  if (/provider_not_found|adapter_unsupported|model_unavailable|effort_unavailable/.test(code)) action = { id: 'select_provider', label: 'Select a supported provider, model or effort' };
  if (code === 'invalid_provider_response') action = { id: 'report_provider_error', label: 'Report a provider error' };
  if (code === 'account_not_found') action = { id: 'account_settings', label: 'Open account settings' };
  return { ok: false, error: { code, retryAtMs, nextAction: {
    ...action,
    target: accountId ? { accountId } : {},
  } } };
}
export const publicAccount = record => Object.fromEntries([
  'schemaVersion', 'id', 'providerId', 'label', 'authState', 'generation', 'expiresAtMs', 'enabled', 'modelOrder',
  ...(record.modelPreferences === undefined ? [] : ['modelPreferences']),
  ...(record.paretoOnly === undefined ? [] : ['paretoOnly']),
].map(key => [key, structuredClone(record[key])]));

// Explicit private directory only: never discovers or imports native CLI stores.
// One metadata lock protects account creation/removal; per-account locks protect effects.
export function createAccountStore({ directory, publishMetadata = durableJson }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = createStoreCoordinator({ dir: directory });
  const file = path.join(directory, 'accounts.json');
  const vault = createAccountVault({directory:path.join(directory, 'account-vault')});
  const readMetadata = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
    { schemaVersion: 1, records: {}, accountOrder: [] };
  // These existing ports are host-private. Hydration never changes the public projection.
  const hydrate = state => {
    for (const record of Object.values(state.records)) {
      if (record.secretRef) {
        if (Object.hasOwn(record, 'secret')) throw new Error('ambiguous_account_secret');
        record.secret = vault.get(record.secretRef, record);
      }
    }
    return state;
  };
  const read = () => hydrate(readMetadata());
  const accountLocks = new Map();
  const usageLocks = new Map();
  const lock = id => {
    if (!accountLocks.has(id)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid_account_id');
      const dir = path.join(directory, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      accountLocks.set(id, createStoreCoordinator({ dir }));
    }
    return accountLocks.get(id);
  };
  return {
    read,
    get: id => { const records = read().records; return Object.hasOwn(records, id) ? records[id] : null; },
    transaction: fn => metadata.exclusive(async gate => {
      const previous = readMetadata();
      const state = hydrate(structuredClone(previous));
      const result = await fn(state);
      if (!gate.held()) throw new Error('store_lock_lost');
      const stored = structuredClone(state);
      for (const [id, record] of Object.entries(stored.records)) {
        if (record.id !== id) throw new Error('invalid_account_id');
        const before = previous.records[id];
        // References are storage-owned: callers cannot redirect an account.
        if (record.secretRef && JSON.stringify(record.secretRef) !== JSON.stringify(before?.secretRef))
          throw new Error('invalid_account_secret_reference');
        if (Object.hasOwn(record, 'secret')) {
          const reusable = before?.secretRef && record.generation === before.generation &&
            record.providerId === before.providerId &&
            JSON.stringify(vault.get(before.secretRef, before)) === JSON.stringify(record.secret);
          record.secretRef = reusable ? before.secretRef : vault.put(record, record.secret);
          delete record.secret;
          record.secretRefs = [...(before?.secretRefs ?? (before?.secretRef ? [before.secretRef] : []))];
          if (!record.secretRefs.some(ref => ref.id === record.secretRef.id)) record.secretRefs.push(record.secretRef);
        } else {
          delete record.secretRef;
        }
      }
      if (!gate.held()) throw new Error('store_lock_lost');
      // Keep old generations while the account exists: host readers can still
      // hold old metadata. Removal cleanup is durable and retryable, not forgotten.
      stored.secretCleanup = [...(previous.secretCleanup ?? [])];
      for (const before of Object.values(previous.records)) if (!stored.records[before.id])
        for (const ref of before.secretRefs ?? (before.secretRef ? [before.secretRef] : []))
          stored.secretCleanup.push({reference:ref, account:{id:before.id,
            providerId:before.providerId,generation:ref.generation}});
      // On ambiguous publication failure retain both generations for recovery.
      publishMetadata(file, stored);
      const pending = stored.secretCleanup.filter(item => {
        try { vault.remove(item.reference, item.account); return false; }
        catch { return true; }
      });
      if (pending.length !== stored.secretCleanup.length && gate.held()) {
        stored.secretCleanup = pending;
        // A failed receipt write leaves the durable cleanup queue replayable.
        try { publishMetadata(file, stored); } catch { /* removal already committed */ }
      }
      return result;
    }),
    exclusive: (id, fn) => lock(id).exclusive(fn),
    exclusiveUsage(id, fn) {
      lock(id); // Validate the opaque ID before deriving a directory.
      if (!usageLocks.has(id)) {
        const dir = path.join(directory, id, 'usage');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        usageLocks.set(id, createStoreCoordinator({ dir }));
      }
      return usageLocks.get(id).exclusive(fn);
    },
    async compareAndSwap(id, generation, patch) {
      return this.transaction(state => {
        const record = state.records[id];
        if (!record || record.generation !== generation) return false;
        Object.assign(record, patch);
        return true;
      });
    },
  };
}
