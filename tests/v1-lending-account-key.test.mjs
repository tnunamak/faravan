import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as pool from '../lib/v1/lending-pool.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createMockUsage} from './helpers/mock-usage.mjs';

const other = 'claude:12345678-1234-4123-8123-123456789abc';
const at = Date.UTC(2026, 9, 23, 10);
async function candidateFor(t, scripts) {
  const directory = await mkdtemp(join(tmpdir(), 'account-key-test-'));
  const mock = createMockUsage(scripts);
  const {candidate} = createPace50Candidate({
    directory, now: () => at, account: 'synthetic-account',
    account_week_id: 'synthetic-week', source: mock.source,
  });
  t.after(async () => {
    await candidate.cancelObservations();
    await rm(directory, {recursive: true, force: true});
  });
  return {candidate, mock};
}

test('a cached reading never crosses whole account keys', async t => {
  const legacy = {refresh_succeeded: false, resources: [], marker: 'legacy'};
  const distinct = {refresh_succeeded: false, resources: [], marker: 'distinct'};
  const {candidate, mock} = await candidateFor(t, [
    ['claude', [legacy]], [other, [distinct]],
  ]);
  const first = await candidate.observe({provider: 'claude', accountKey: 'claude', now: at});
  const second = await candidate.observe({provider: 'claude', accountKey: other, now: at});
  assert.equal(first.marker, 'legacy');
  assert.equal(second.marker, 'distinct');
  assert.deepEqual(mock.calls.map(call => call.accountKey), ['claude', other]);
  assert.equal(candidate.observeSnapshot({provider: 'claude', accountKey: other}).marker, 'distinct');
  assert.equal(candidate.observeSnapshot({provider: 'claude', accountKey: 'claude'}).marker, 'legacy');
});

test('an unknown account cannot fall back to a legacy reading', async t => {
  const {candidate} = await candidateFor(t, [
    ['claude', [{refresh_succeeded: false, resources: [], marker: 'legacy'}]],
  ]);
  await candidate.observe({provider: 'claude', accountKey: 'claude', now: at});
  assert.equal(candidate.observeSnapshot({provider: 'claude', accountKey: other}), null);
  assert.equal(await candidate.observe({provider: 'claude', accountKey: other, now: at}), null);
});

test('child ids preserve the whole account key and distinguish numeric slots', () => {
  assert.equal(typeof pool.parseChildId, 'function');
  assert.deepEqual(pool.parseChildId('claude'), {accountKey: 'claude', slot: null});
  assert.deepEqual(pool.parseChildId(other), {accountKey: other, slot: null});
  assert.deepEqual(pool.parseChildId('claude:0'), {accountKey: 'claude', slot: 0});
  assert.deepEqual(pool.parseChildId('codex:12'), {accountKey: 'codex', slot: 12});
  for (const accountKey of ['claude', 'codex', other]) {
    for (const slot of [0, 1, 12]) {
      assert.deepEqual(pool.parseChildId(accountKey + '#' + slot), {accountKey, slot});
    }
  }
  assert.equal(pool.parseChildId(other).slot, null);
});

test('scripted preflight holds stay separate for two accounts of one provider', async t => {
  const unknownIdentity = {refresh_succeeded: true, complete: true, resources: [],
    identity: {verified: false}, funding: {subscription_only: 'proven'}};
  const failedRefresh = {refresh_succeeded: false, complete: false, resources: [],
    identity: {verified: true}, funding: {subscription_only: 'proven'}};
  const {candidate} = await candidateFor(t, [
    ['claude', [unknownIdentity]], [other, [failedRefresh]],
  ]);
  await candidate.preflight({provider: 'claude', accountKey: 'claude'});
  const legacyHold = structuredClone(candidate.decisionFor('claude'));
  await candidate.preflight({provider: 'claude', accountKey: other});
  const otherHold = candidate.decisionFor(other);
  assert.notEqual(otherHold.reason, 'objective_evidence_unknown');
  assert.notEqual(otherHold.reason, legacyHold.reason);
  assert.deepEqual(candidate.decisionFor('claude'), legacyHold);
});
