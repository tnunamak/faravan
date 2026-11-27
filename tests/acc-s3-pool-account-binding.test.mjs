import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';

// Slice 3, behavior 3: a job runs on exactly the account chosen, and its sandbox is bound to that account only.
// The pool hands each lender worker the identity its sandbox session is bound to (createLender option accountKey, which the
// lender passes to backend.beginLendingSession). Seam (smallest): createLendingPool({accounts: () => [{id, provider}]}), the
// owner's enabled accounts in order, so each worker is keyed by one account id. Today the pool keys workers by provider
// plus slot number ('claude', slot 0/1), so two accounts of one provider share the key 'claude' and nothing names the account.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

test('two accounts of one provider get workers bound to their own account ids, never a shared provider key', async t => {
  const made = [];
  let disk = {jobs: 0, milliseconds: 0, accounts: {}};
  const stop = new AbortController();
  const pool = createLendingPool({
    storage: {get: async () => structuredClone(disk), set: async v => { disk = structuredClone(v); }, acquire: async () => () => {}},
    capacity: 2,
    policy: {enabled: true, dailyJobs: null, dailyMinutes: null, lendingPolicy: {accountSlots: 1, machineSlots: 2}},
    adapters: [{spec: {harness_id: 'claude-code-subscription'}}],
    accounts: () => [{id: A, provider: 'claude'}, {id: B, provider: 'claude'}],
    createLender: options => {
      made.push(options.accountKey);
      return {start: signal => new Promise(resolve => signal.addEventListener('abort', resolve, {once: true})),
        getState: () => ({status: 'idle', reason: null, current: null}), admits: () => null, cessation: () => ({proven: true})};
    }});
  const running = pool.start(stop.signal);
  t.after(async () => { stop.abort(); await running; });
  for (let i = 0; i < 200 && made.length < 2; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual([...made].sort(), ['claude:' + A, 'claude:' + B].sort(), 'each worker, and so each sandbox session, is bound to one account key (provider:id, as lending-account-key.mjs defines it)');
});
