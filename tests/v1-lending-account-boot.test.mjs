import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountKey, accountIdOfKey, isAccountKey, providerOfKey } from '../lib/v1/lending-account-key.mjs';
import { legacyProviders, openLendingAccounts } from '../lib/v1/lending-account-boot.mjs';
import { appFixture } from './helpers/v1-app-fixture.mjs';

const ID = '0b6f2d3e-6c52-4c2a-8f6e-0c9a8e1d2b3c';
const dir = t => {
  const d = fs.mkdtempSync(join(tmpdir(), 'lending-boot-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('the legacy account keeps the bare provider key; later accounts are scoped by id', () => {
  assert.equal(accountKey({ id: ID, provider: 'claude', legacy_provider: 'claude' }), 'claude');
  assert.equal(accountKey({ id: ID, provider: 'claude' }), 'claude:' + ID);
  assert.equal(providerOfKey('claude'), 'claude');
  assert.equal(providerOfKey('claude:' + ID), 'claude');
  assert.equal(accountIdOfKey('claude'), null);
  assert.equal(accountIdOfKey('codex:' + ID), ID);
  for (const bad of ['', 'Claude', 'claude:0', 'claude:' + ID + ':x', ':' + ID, null, undefined, 3])
    assert.equal(isAccountKey(bad), false, String(bad));
  assert.throws(() => providerOfKey('claude:0'), TypeError);
  assert.throws(() => accountKey({ provider: 'claude' }), TypeError);
});

test('legacy providers come only from Faravan state, never from provider config directories', t => {
  const d = dir(t);
  const ledgerFile = join(d, 'ledger.json'), counterFile = join(d, 'counters.json');
  assert.deepEqual(legacyProviders({ settings: {}, ledgerFile, counterFile }), [], 'empty install');
  assert.deepEqual(legacyProviders({ settings: { agents: { 'claude-code-subscription': false } } }), ['claude'],
    'a chosen-then-unchosen agent still has history');
  assert.deepEqual(legacyProviders({ settings: { limits: { lendingPolicy: { accountPlans: { codex: 'pro' } } } } }), ['codex']);
  assert.deepEqual(legacyProviders({ settings: { limits: { lendingPolicy: { providerConsent: { claude: false },
    accountPlans: { claude: 'unknown', codex: 'unknown' } } } } }), [], 'the fresh-install defaults are not state');
  fs.writeFileSync(ledgerFile, JSON.stringify({ accounts: { claude: {} } }));
  fs.writeFileSync(counterFile, JSON.stringify({ accounts: { 'codex:0': {}, 'recovery:0': {} } }));
  assert.deepEqual(legacyProviders({ settings: {}, ledgerFile, counterFile }), ['claude', 'codex']);
  fs.writeFileSync(ledgerFile, '{not json');
  assert.deepEqual(legacyProviders({ settings: {}, ledgerFile, counterFile }), ['codex'], 'a damaged file is skipped, not fatal');
});

test('opening migrates once, refresh is idempotent, and a corrupt registry degrades instead of throwing', t => {
  const d = dir(t);
  let settings = {};
  const accounts = openLendingAccounts({ directory: d, settings: () => settings, now: () => 1 });
  assert.deepEqual(accounts.list(), []);
  assert.equal(fs.existsSync(join(d, 'lending-accounts.json')), false, 'empty install writes nothing');
  settings = { agents: { codex: true } };
  assert.equal(accounts.refresh(), true);
  const [codex] = accounts.list();
  assert.equal(codex.key, 'codex');
  assert.equal(accounts.get(codex.id).key, 'codex');
  accounts.refresh();
  assert.deepEqual(accounts.list(), [codex]);
  fs.writeFileSync(join(d, 'lending-accounts.json'), '{broken');
  assert.deepEqual(accounts.list(), []);
  assert.deepEqual(accounts.health(), { ok: false, code: 'account_registry_corrupt' });
  assert.equal(accounts.refresh(), false);
  assert.equal(accounts.get(codex.id), null);
});

test('removed explicit account survives reboot as disabled pool history, not a legacy migration', t => {
  const directory=dir(t);
  const first=openLendingAccounts({directory,settings:()=>({}),now:()=>1});
  const registry=first.registry();
  const codex=registry.add({provider:'codex',label:'Synthetic Codex'});
  registry.markRemoved(codex.id);
  const restored=openLendingAccounts({directory,now:()=>2,settings:()=>({agents:{codex:true,'claude-code-subscription':true}})});
  assert.equal(restored.health().ok,true);
  const [unrelated]=restored.list();
  assert.equal(unrelated.provider,'claude');
  assert.equal(unrelated.enabled,true);
  assert.equal(restored.list().length,1,'the public list hides the removed row without resurrecting Codex');
  const tombstone=restored.listForPool().find(account=>account.id===codex.id);
  assert.deepEqual(tombstone,restored.get(codex.id));
  assert.equal(tombstone.removed,true);
  assert.equal(tombstone.enabled,false);
  assert.equal(restored.listForPool().some(account=>account.provider==='codex'&&account.enabled),false);
});

test('an existing install gets one account per provider at startup and keeps it across restarts', async t => {
  const f = await appFixture(t);
  const home = await f.home('owner');
  fs.mkdirSync(join(home, 'v1'), { recursive: true });
  fs.writeFileSync(join(home, 'v1', 'app-settings.json'), JSON.stringify({
    version: 1, name: 'legacy', enabled: false, intent: 'off', activeCircle: null, modes: {}, agents: { 'claude-code-subscription': true },
    lendingAuth: { 'claude-code-subscription': true }, limits: { lendingPolicy: { accountPlans: { claude: 'max20' } } },
  }));
  const first = await f.start('owner');
  const before = first.app.lendingAccounts().list();
  assert.deepEqual(before.map(a => [a.provider, a.key, a.enabled]), [['claude', 'claude', true]]);
  assert.deepEqual(first.app.lendingAccounts().health(), { ok: true });
  await first.app.close();
  const second = await f.start('owner');
  assert.deepEqual(second.app.lendingAccounts().list(), before, 'same opaque id after restart; no second account');
});

test('a fresh install has no lending account until a provider has state', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  assert.deepEqual(owner.app.lendingAccounts().list(), []);
});
