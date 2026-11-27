import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startApp} from '../lib/v1/app.mjs';
import {syntheticBackend, api} from './helpers/v1-app-fixture.mjs';
import * as p from '../lib/protocol/index.mjs';

// State written by earlier releases carries no account key. Loading it, and using it for the one account it describes,
// must leave every stored byte as it was: nothing is rewritten into a keyed form.
const released = new URL('./fixtures/upgrade/62/', import.meta.url);
function env(t, key, value) { const old = process.env[key]; process.env[key] = value; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }); }

// Copies the released home into a scratch root and sets the environment the app expects. Returns the paths.
async function scratchHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-bytes-'));
  const home = join(root, 'data');
  await cp(released, home, {recursive: true});
  for (const key of ['HOME', 'FARAVAN_HOME', 'FARAVAN_HOME', 'FARAVAN_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FARAVAN_COORDINATOR_HOME', 'FARAVAN_COORDINATOR_HOME']) env(t, key, home);
  env(t, 'FARAVAN_SCRATCH_ROOT', join(root, 'scratch'));
  env(t, 'TZ', 'America/Chicago');
  const bin = join(root, 'bin');
  await mkdir(bin); await mkdir(join(root, 'scratch'));
  for (const command of ['sbx', 'docker']) await writeFile(join(bin, command), '#!/bin/sh\nexit 97\n', {mode: 0o755});
  env(t, 'PATH', bin + ':' + process.env.PATH);
  const counters = join(home, 'v1/app-counters.json');
  await writeFile(counters, (await readFile(counters, 'utf8')).replaceAll('@ROOT@', root));
  return {root, home, settings: join(home, 'v1/app-settings.json'), counters, pace50: join(home, 'v1/lending-pace50-state.json')};
}

// Starts the app on a home, with no network probes. The caller closes it.
function launch(root, home, extra = {}) {
  return startApp({home, port: 0, freshLending: 'off', adapters: [], backendFactory: async () => syntheticBackend(root), ...extra,
    signInProbe: async () => ({signedIn: null}), lendingSignInProbe: async () => ({signedIn: null}),
    identityProbe: async () => ({providers: []}), lendingIdentityProbe: async () => ({providers: []}),
    autostart: {status: async () => ({supported: false, enabled: false})}});
}

// What the first start of this release adds to saved settings: one-time default versions and empty per-circle bookkeeping maps
// (Automatic-rule ids, notices shown, roster state). None of them holds a choice; every saved choice keeps its bytes.
const MIGRATION_MARKERS = {presence:{answer:null,notice:{kind:'pair'}},presenceDefaultsVersion:2,perJobCapDefaultsVersion:1,appRuleIds:{},noticesShown:{},rosterApplied:{},rosterAppliedEpoch:{}};

test('saved settings add only migration markers while earlier counters serve a lending read without a rewrite', {timeout: 30000}, async t => {
  const paths = await scratchHome(t);
  // Startup saves settings in compact JSON. With the time zone chosen, only the new migration markers are added.
  const parsed = JSON.parse(await readFile(paths.settings, 'utf8'));
  await writeFile(paths.settings, JSON.stringify({...parsed, timeZoneChosen: true}));
  const files = [paths.settings, paths.counters];
  const before = await Promise.all(files.map(file => readFile(file)));
  const app = await launch(paths.root, paths.home);
  t.after(() => app.close());
  // Registered after the app's close, so the directory is removed only once the app has stopped writing.
  t.after(() => rm(paths.root, {recursive: true, force: true}));
  await api(app, '/api/lending');
  const after = await Promise.all(files.map(file => readFile(file)));
  assert.equal(after[0].toString(), JSON.stringify({...JSON.parse(before[0]),...MIGRATION_MARKERS}), 'only the one-time migration markers are added; saved choices are kept');
  assert.ok(before[1].equals(after[1]), 'the counters file is byte-for-byte what the earlier release wrote');
});

test('a pace50 ledger from an earlier release is not rewritten by the first start of this release, nor by recovery', {timeout: 60000}, async t => {
  const paths = await scratchHome(t);
  // Settings are compact here, as startup writes them, so the settings bytes are a fair baseline (see the test above).
  const parsed = JSON.parse(await readFile(paths.settings, 'utf8'));
  await writeFile(paths.settings, JSON.stringify({...parsed, timeZoneChosen: true}));
  // The device identity: the ledger names the account of the device key in v1/device.pem. The test creates that key, so
  // the ledger's account can be set to it without starting this release first.
  const {privateKey} = p.generateDeviceKeyPair();
  await writeFile(join(paths.home, 'v1/device.pem'), privateKey.export({format: 'pem', type: 'pkcs8'}));
  const keyId = p.fingerprint(p.exportPublicKey(privateKey));
  // The captured ledger was written by a real lender before this release. Only its account string changes, to this device's key.
  const captured = await readFile(new URL('./fixtures/pace50-state-two-provider-week-1031.json', import.meta.url), 'utf8');
  const capturedAccount = JSON.parse(captured).account;
  await writeFile(paths.pace50, captured.replaceAll(capturedAccount, keyId));
  const at = JSON.parse(captured).updated_at + 60_000;
  // Closes the app if a failing assertion left it open, then removes the scratch home. One teardown, in order.
  let app = null;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(paths.root, {recursive: true, force: true}); }
  });
  const files = [paths.settings, paths.counters, paths.pace50];
  // The baseline is taken before this release starts at all.
  const before = await Promise.all(files.map(file => readFile(file)));
  app = await launch(paths.root, paths.home, {lendingNow: () => at});
  await api(app, '/api/lending');
  await app.close();
  app = null;
  const afterFirst = await Promise.all(files.map(file => readFile(file)));
  for (const [index, file] of files.entries()) assert.ok((index===0?Buffer.from(JSON.stringify({...JSON.parse(before[index]),...MIGRATION_MARKERS})):before[index]).equals(afterFirst[index]), `${file} keeps its bytes apart from the one-time settings migration markers`);
  // Extra coverage: a second start on the same files must not change them either.
  app = await launch(paths.root, paths.home, {lendingNow: () => at});
  await api(app, '/api/lending');
  await app.close();
  app = null;
  const afterSecond = await Promise.all(files.map(file => readFile(file)));
  for (const [index, file] of files.entries()) assert.ok(afterFirst[index].equals(afterSecond[index]), `${file} is unchanged by a second start`);
});
