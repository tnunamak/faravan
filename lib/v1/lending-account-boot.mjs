import fs from 'node:fs';
import { join } from 'node:path';
import { createAccountRegistry, migrateLegacyAccounts } from './lending-accounts.mjs';
import { accountKey } from './lending-account-key.mjs';

// The harness each existing singleton enrollment lives under, by provider.
export const LEGACY_HARNESS = Object.freeze({ claude: 'claude-code-subscription', codex: 'codex' });
const providerOfName = name => String(name).split(':')[0];

function jsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Providers that already have lending state on this install. Reads only Faravan's own
 * settings, meter ledger and counters, never a provider credential or config directory.
 * A provider with any trace keeps its history under its existing account.
 */
export function legacyProviders({ settings, ledgerFile, counterFile } = {}) {
  const found = new Set();
  const policy = settings?.limits?.lendingPolicy ?? {};
  for (const [provider, harness] of Object.entries(LEGACY_HARNESS)) {
    if (settings?.agents?.[harness] !== undefined || settings?.lendingAuth?.[harness] !== undefined ||
        (typeof policy.accountPlans?.[provider] === 'string' && policy.accountPlans[provider] !== 'unknown')) found.add(provider);
  }
  const ledger = ledgerFile ? jsonOrNull(ledgerFile) : null;
  const counters = counterFile ? jsonOrNull(counterFile) : null;
  for (const name of [...Object.keys(ledger?.accounts ?? {}), ...Object.keys(counters?.accounts ?? {})]) {
    const provider = providerOfName(name);
    if (Object.hasOwn(LEGACY_HARNESS, provider)) found.add(provider);
  }
  return [...found].sort();
}

/**
 * Opens the durable account registry beside the other lending files and gives every
 * provider with existing lending state exactly one account, once. Calling refresh()
 * again (after a first sign-in, say) is idempotent. A corrupt registry degrades to
 * "no accounts" and reports its code; it never stops the app or touches legacy state.
 */
export function openLendingAccounts({ directory, settings, now = Date.now } = {}) {
  const ledgerFile = join(directory, 'lending-meter-ledger.json'), counterFile = join(directory, 'app-counters.json');
  let registry, failure = null;
  try { registry = createAccountRegistry({ file: join(directory, 'lending-accounts.json'), now }); }
  catch (error) { failure = error; }
  const withKey = account => ({ ...account, key: accountKey(account) });
  function refresh() {
    if (!registry) return false;
    try {
      migrateLegacyAccounts(registry, { providers: legacyProviders({ settings: settings(), ledgerFile, counterFile }) });
      failure = null;
      return true;
    } catch (error) { failure = error; return false; }
  }
  refresh();
  return {
    refresh,
    /** Every account with its storage key; [] when the registry cannot be read. */
    list() {
      if (!registry) return [];
      try { return registry.list().map(withKey); } catch (error) { failure = error; return []; }
    },
    listForPool() {
      if (!registry) return [];
      try { return registry.listForPool().map(withKey); } catch (error) { failure = error; return []; }
    },
    get(id) {
      if (!registry) return null;
      try { const account = registry.get(id); return account ? withKey(account) : null; }
      catch (error) { failure = error; return null; }
    },
    registry: () => registry,
    health: () => failure ? { ok: false, code: failure.code ?? 'account_registry_unavailable' } : { ok: true },
  };
}
