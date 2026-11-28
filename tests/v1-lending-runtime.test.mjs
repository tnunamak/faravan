import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';

const reading = at => ({windows:[{window_id:'five_hour',window_minutes:300,used_pct:10,
  observed_at:at,resets_at:at+3600000,state:'open'}]});

test('view uses explicit local snapshots without sampling presence or probing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'faravan-runtime-view-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const at = Date.now(), sequence = [];
  let backendTouches = 0;
  const backend = new Proxy({}, {get() { backendTouches++; return async () => null; }});
  const settings = {intent:'off', limits:{lendingPolicy:normalizeLendingPolicy({accountPlans:{claude:'max20'}})}};
  const runtime = createLendingRuntime({directory, backend, settings:() => settings, now:() => at,
    presence:async () => { sequence.push('presence'); return true; },
    statusRead:()=>assert.fail('status must not read a provider'),
    accountStatus:async()=>{sequence.push('accounts');return [{id:'a',provider:'claude',readings:reading(at).windows,decision:{windows:reading(at).windows}},{id:'b',provider:'codex'}];}});
  t.after(async () => runtime.close());

  const view = await runtime.view();

  assert.deepEqual(sequence, ['accounts']);
  assert.deepEqual(view.accounts.map(account => account.provider), ['claude','codex']);
  assert.deepEqual(view.accounts[0].readings, reading(at).windows);
  assert.deepEqual(view.accounts[0].decision.windows, reading(at).windows);
  assert.equal(backendTouches, 0, 'a status snapshot must not invoke a provider backend');
});
