import './helpers/no-browser.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from "./helpers/v1-app-fixture.mjs";
import {OPS} from '../lib/v1/ops/registry.mjs';

// Item 3 of the startup lane: the status read names the hold it is in. A named evidence hold is not replaced by a generic
// operation_failed, and every decision carries its strategy id and protection source. Synthetic readings only.

test('the status read names each enrolled account hold instead of operation_failed',async t=>{
 const f=await appFixture(t),{lender}=await f.connect();
 const account=(await api(lender.app,'/api/accounts')).accounts[0];
 const status=await api(lender.app,'/api/lending');
 const row=status.objective.accounts.find(row=>row.id===account.id);
 assert.equal(row.provider,'codex');
 assert.equal(row.decision.reason,'lending_off');
 assert.notEqual(row.decision.reason,'operation_failed');
 assert.equal(row.decision.nextAction.target.accountId,account.id);
});

test('the status read shows the strategy the owner chose, not a hard-coded automatic one', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  const saved = await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    lendingPolicy: {strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30}}}});
  assert.ok(saved, 'the owner can save a fixed share strategy');
  const view = await api(lender.app, '/api/lending');
  assert.equal(view.objective.accounts.find(account => account.provider === 'codex').decision.strategy, 'fixed_share');
});

// Agents read the registry before they call lending.get, so its description must name the three things the status read carries.
test('the ops registry describes the strategy id, the hold reason and the protection source', () => {
  const lending = OPS.find(op => op.id === 'lending.get');
  assert.ok(lending, 'lending.get is registered');
  assert.match(lending.description, /each provider objective/);
  assert.match(lending.output.properties.objective.description, /strategy id/);
  assert.match(lending.description, /hold reason/);
  assert.match(lending.description, /protection source/);
});
