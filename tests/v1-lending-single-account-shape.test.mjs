import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// A computer with one account per provider is the shape every installed copy has. Threading an account key through the
// engine must leave what such a computer records, and which provider a running job holds, exactly as they were.
const NOW = Date.parse('2026-10-23T06:40:00Z');
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: 4}};
const EXPECTED_ATTEMPT_KEYS = [
  'account', 'account_week_id', 'cessation_proven', 'cleanup_proven', 'created_at', 'epoch', 'id', 'job_id', 'late_ack_events', 'late_ack_unresolved', 'launch_state',
  'opening', 'price_rev', 'process_state', 'recoveries', 'resources', 'served_model', 'stop_ms', 'uncertainty_ms', 'usage_unknown', 'wall_ms'];
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true}); });
const dir = () => { const d = fs.mkdtempSync(join(tmpdir(), 'single-account-')); made.push(d); return d; };

test('an admitted chunk of a computer with one account is recorded with the same fields as before, and no account key', async t => {
  const opened = createPace50Candidate({directory: dir(), now: () => NOW, account: 'synthetic-account', account_week_id: 'synthetic-week-1',
    source: createSyntheticPace50Source({start: NOW})});
  t.after(() => opened.adapter.close());
  const grant = await opened.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-haiku-5-5', job,
    automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.deepEqual(grant.reservation, {provider: 'claude', attemptId: 'attempt-1', model: 'claude-haiku-5-5'});
  const [attempt] = opened.adapter.state().attempts;
  assert.deepEqual(Object.keys(attempt).sort(), EXPECTED_ATTEMPT_KEYS);
  assert.equal(JSON.stringify(opened.adapter.state()).includes('accountKey'), false, 'a single-account record carries no key');
});

test('a hold placed for one provider reaches that provider\'s worker and not the other\'s, as before', async t => {
  const created = [];
  const child = options => {
    const row = {options};
    created.push(row);
    return {start: () => new Promise(() => {}), getState: () => ({status: 'waiting_for_sandbox', reason: 'agent_not_chosen', label: 'x', current: null}),
      admits: () => null, refreshAdmission() {}, reconfigure() {}, pause() {}, resume() {}, cessation: () => ({proven: true})};
  };
  let stored = {jobs: 0, milliseconds: 0, pending: null, accounts: {}};
  const storage = {get: async () => structuredClone(stored), set: async next => { stored = structuredClone(next); }};
  const seen = [];
  const pool = createLendingPool({storage, capacity: 3, maxResources: {cpu: 8, memoryBytes: 64 * 1024 ** 3},
    policy: {enabled: true, lendingPolicy: {accountSlots: 1}, hold: (_job, {provider, attemptId}) => { seen.push([provider, attemptId]); return provider === 'claude' ? 'reading_allowance' : null; }},
    adapters: [{spec: {harness_id: 'claude-code-subscription'}}, {spec: {harness_id: 'codex'}}], createLender: child});
  pool.start();
  const until = async check => { for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };
  await until(() => created.length === 2);
  const byProvider = Object.fromEntries(created.map(row => [row.options.adapters[0].spec.harness_id === 'codex' ? 'codex' : 'claude', row]));
  assert.deepEqual(Object.keys(byProvider).sort(), ['claude', 'codex']);
  assert.equal(await byProvider.claude.options.policy.hold({}, {attemptId: 'a'}), 'reading_allowance');
  assert.equal(await byProvider.codex.options.policy.hold({}, {attemptId: 'a'}), null);
  assert.deepEqual(seen, [['claude', 'a'], ['codex', 'a']]);
  assert.deepEqual(pool.getState().accountStates.map(s => s.account).sort(), ['claude:0', 'codex:0']);
});
