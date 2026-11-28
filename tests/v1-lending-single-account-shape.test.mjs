import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {createLendingPool} from '../lib/v1/lending-pool.mjs';

// A computer with one account per provider is the shape every installed copy has. Threading an account key through the
// engine must leave what such a computer records, and which provider a running job holds, exactly as they were.

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true}); });

test('a hold placed for one provider reaches that provider\'s worker and not the other\'s, as before', async t => {
  const created = [];
  const child = options => {
    const row = {options};
    created.push(row);
    return {start: () => new Promise(() => {}), getState: () => ({status: 'waiting_for_sandbox', reason: 'lending_off', label: 'x', current: null}),
      admits: () => null, refreshAdmission() {}, reconfigure() {}, pause() {}, resume() {}, cessation: () => ({proven: true})};
  };
  let stored = {jobs: 0, milliseconds: 0, pending: null, accounts: {}};
  const storage = {get: async () => structuredClone(stored), set: async next => { stored = structuredClone(next); }};
  const seen = [];
  const pool = createLendingPool({storage, capacity: 3, maxResources: {cpu: 8, memoryBytes: 64 * 1024 ** 3},
    policy: {enabled: true, lendingPolicy: {accountSlots: 1}, observeLending: (_job,{provider}) => { seen.push(provider);return {waits:provider==='claude'?[{reason:'conditions_unavailable',nextEvaluationAtMs:Date.now()+120000}]:[]}; }},
    adapters: [{spec: {harness_id: 'claude-code-subscription'}}, {spec: {harness_id: 'codex'}}], createLender: child});
  pool.start();
  const until = async check => { for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };
  await until(() => created.length === 2);
  const byProvider = Object.fromEntries(created.map(row => [row.options.adapters[0].spec.harness_id === 'codex' ? 'codex' : 'claude', row]));
  assert.deepEqual(Object.keys(byProvider).sort(), ['claude', 'codex']);
  assert.deepEqual((await byProvider.claude.options.policy.observeLending({})).waits.map(w=>w.reason),['conditions_unavailable']);
  assert.deepEqual((await byProvider.codex.options.policy.observeLending({})).waits,[]);
  assert.deepEqual(seen,['claude','codex']);
  assert.deepEqual(pool.getState().accountStates.map(s => s.account).sort(), ['claude:0', 'codex:0']);
});
