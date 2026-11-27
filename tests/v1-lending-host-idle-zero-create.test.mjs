import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createGuardReads} from '../lib/v1/guard-read.mjs';
import {parseProbeOutput, createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createLendingReadingRunner} from '../lib/v1/lending-reading-runner.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

// An idle hour of guard reads, for both providers, through the real runtime path: the real host reading runner, the real lending
// probe and readings, the real guard-read context and the real host reader, with a fake provider. It counts requests and checks
// that a reading carries no stop and no executor. That no sandbox is reached is proved at the app, in v1-no-reading-sandbox.test.mjs.
const NOW = Date.UTC(2026, 10, 11, 12);
const iso = hours => new Date(NOW + hours * 3600e3).toISOString();
const replies = {
  '/api/oauth/usage': {five_hour: {utilization: 40, resets_at: iso(1.25)}, seven_day: {utilization: 20, resets_at: iso(42)}, extra_usage: {is_enabled: false}},
  '/api/oauth/profile': {account: {uuid: 'uuid-a', email: 'a@example.test'}, organization: {uuid: 'org-a'}},
  '/backend-api/wham/usage': {plan_type: 'plus', spend_control: {reached: false}, credits: {has_credits: false}, account_id: 'acct-1', email: 'a@example.test',
    rate_limit: {allowed: true, limit_reached: false, primary_window: {used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(NOW / 1000) + 4000},
      secondary_window: {used_percent: 5, limit_window_seconds: 604800, reset_at: Math.floor(NOW / 1000) + 400000}}},
};
async function runtime(t, {provider, fetchImpl, store, clock}) {
  await mkdir(join(homedir(), '.tmp'), {recursive: true});
  const directory = await mkdtemp(join(homedir(), '.tmp', 'zero-create-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: () => clock()});
  const reader = createUsageHostReader({store, fetchImpl, now: () => clock()});
  const probe = createLendingProbe({runGuest: createLendingReadingRunner({reader}), hostRead: args => reader.read(args), ledger, now: () => clock()});
  t.after(() => probe.close());
  // jobRunning is true: a lent job is running, so only a guard read may read the account.
  const readings = createLendingReadings({ledger, probe, jobRunning: () => true, now: () => clock()});
  return {reader, probe, readings, guard: createGuardReads({reader})({provider, accountKey: provider})};
}

for (const provider of ['claude', 'codex']) test(`an idle hour of ${provider} guard reads sends one usage request per read and carries no stop or executor`, {timeout: 120000}, async t => {
  const paths = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.equal(options.redirect, 'manual');
    return {status: 200, headers: {get: () => null}, json: async () => replies[path]};
  };
  const store = {credential: async accountKey => ({accountKey, provider, kind: 'oauth', generation: 'g1', bearer: 'synthetic-token'})};
  let clock = NOW;
  const {readings, guard, reader} = await runtime(t, {provider, fetchImpl, store, clock: () => clock});
  let reads = 0;
  for (; clock < NOW + 3600e3; clock += 10_000) {
    const snapshot = await readings(provider, {guardRead: guard, forceRefresh: true});
    assert.ok(snapshot.windows?.length > 0 && snapshot.refresh_succeeded !== false && !snapshot.probe?.reason, JSON.stringify(snapshot.probe));
    reads++;
  }
  assert.equal(reads, 360);
  const usage = paths.filter(p => p.endsWith('/usage')).length;
  assert.equal(usage, reads, 'one usage GET per read');
  assert.ok(paths.length - usage <= 1, 'at most one identity GET for the whole hour');
  // A usage reading is not stop proof and names no executor, on either path.
  for (const result of [await reader.read({provider, accountKey: provider}), await createLendingReadingRunner({reader})({provider, accountKey: provider})]) {
    assert.equal(result.stop, undefined, 'a reading carries no stop');
    assert.equal(result.executor, undefined, 'a reading names no executor');
  }
});

test('one job running on an added account: its guard and ordinary reads go to the host reader', {timeout: 60000}, async t => {
  const paths = [];
  const key = 'claude:7248ba68-0000-4000-8000-000000000001';
  const fetchImpl = async url => { const path = new URL(url).pathname; paths.push(path); return {status: 200, headers: {get: () => null}, json: async () => replies[path]}; };
  const store = {credential: async accountKey => ({accountKey, provider: 'claude', kind: 'setup-token', generation: 'g1', bearer: 'synthetic-token'})};
  let clock = NOW;
  const {probe, reader} = await runtime(t, {provider: 'claude', fetchImpl, store, clock: () => clock});
  for (let i = 0; i < 20; i++, clock += 10_000) {
    const result = await probe.probe(key, {runGuest: createGuardReads({reader})({provider: 'claude', accountKey: key}).run});
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  // An ordinary read of the added account goes to the host reader as well, never to the sandbox runner.
  assert.equal((await probe.probe(key, {})).ok, true);
});
