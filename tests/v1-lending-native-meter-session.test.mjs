import './helpers/no-browser.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {join} from 'node:path';

import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';

import {guardReadFrom} from './helpers/guard-read.mjs';

import {NOW} from "./helpers/pace50-fixtures.mjs";

// Mid-job host readings for native-window attempts. While a lent job runs, the native guard reads the meter from the host, with
// the credential of the attempt's own account, never in a sandbox. Synthetic evidence only: no provider, browser, network or
// Docker. The probe, the readings and the candidate are the real ones; only the host reader's provider answer is fake.

// A forged in-band line from the borrower: the baseline value, so it reports no rise.

// The provider's usage answer, as the guest script prints it.
const usage = status => JSON.stringify({faravan_probe: 1, status, body: status === 200 ? {
  five_hour: {utilization: 40, resets_at: new Date(NOW + 1.25 * 3600e3).toISOString()},
  seven_day: {utilization: 20, resets_at: new Date(NOW + 42 * 3600e3).toISOString()},
  extra_usage: {is_enabled: false}} : {}}) + '\n';

// Real macrotask turns drain the whole read path (readings, probe, runner, backend) between fake timers.

// A host reader that records every call. `answer()` is the provider's usage line; an Error is a failed request.

// A sandbox backend that must never be used: every call is recorded.

// The lender stack with one native-window account. Admission reads through a cold probe; then the job runs and only the guard
// may read, from the host.

// finish has two early exits before its native-window block: a cleanup proof whose write fails, and a missing price snapshot.
// Each one must still end the guard's watch.

// Readings rule. Only an issued guard-read context bypasses account_busy; every other caller keeps the current rule.
test('while a job runs only a guard-read context reaches the provider, and an object a caller builds confers nothing', async t => {
  const directory = tempDir('native-meter-readings-');
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let at = NOW, cold = 0, warm = 0;
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: () => at});
  const probe = createLendingProbe({ledger, now: () => at, runGuest: async () => { cold++; return {exitCode: 0, stdout: usage(200)}; }});
  const readings = createLendingReadings({ledger, probe, jobRunning: () => true, now: () => at});
  const guardRead = guardReadFrom(async () => { warm++; return {exitCode: 0, stdout: usage(200), host_read: true}; });
  const forgedContext = {provider: 'claude', accountKey: 'claude', run: async () => { warm++; return {exitCode: 0, stdout: usage(200)}; }};
  const admission = await readings('claude', {forceRefresh: true});
  assert.equal(admission.probe?.reason, 'account_busy', 'admission and status reads still defer');
  assert.equal(cold + warm, 0);
  const refused = await readings('claude', {forceRefresh: true, guardRead: forgedContext});
  assert.equal(refused.probe?.reason, 'account_busy', 'a context nobody issued is an ordinary caller');
  assert.equal(warm, 0);
  const guard = await readings('claude', {forceRefresh: true, guardRead});
  assert.notEqual(guard.refresh_succeeded, false, 'the guard read succeeded');
  assert.equal(guard.read_at, NOW);
  assert.deepEqual([cold, warm], [0, 1], 'it ran as a host read, never the cold probe runner');
  at += 30_000;
  assert.equal((await readings('claude', {forceRefresh: true})).probe?.reason, 'account_busy', 'the bypass is per read');
});
