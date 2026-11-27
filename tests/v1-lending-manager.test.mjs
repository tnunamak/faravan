import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingManager} from '../lib/v1/lending-manager.mjs';

function candidateFixture(reason = null) {
  const calls = [];
  const decision = {reason: reason ?? 'objective_lend', objective: {nativeMaxBudgetUsd: 3.25}};
  const candidate = {
    async gate(input) { calls.push(['gate', input]); return reason; },
    decisionFor(provider) { calls.push(['decisionFor', provider]); return decision; },
    async reserve(input) { calls.push(['reserve', input]); return {ok: true, reservation: {id: 'r'}}; },
    async finish(input) { calls.push(['finish', input]); return {settled: true}; },
    async release(id, input) { calls.push(['release', id, input]); return {applied: true}; },
  };
  return {manager: createLendingManager({candidate}), calls, candidate};
}

test('manager admission reports the durable candidate answer and its objective budget', async () => {
  const f = candidateFixture();
  const input = {provider: 'claude', model: 'claude-sonnet-5-5', job: {id: 'j'}, automatic: true,
    ownerAbsent: true, intentOn: true, paused: false};
  const out = await f.manager.admission(input);

  assert.equal(out.admitted, true);
  assert.equal(out.reason, 'objective_lend');
  assert.equal(out.budget_units, 3.25);
  assert.deepEqual(f.calls, [['gate', {...input, jobId: undefined}], ['decisionFor', 'claude']]);
});

test('a candidate hold is returned unchanged; no confirming-surplus allocator is applied', async () => {
  const f = candidateFixture('friend_value_le_harm');
  const out = await f.manager.admission({provider: 'codex', automatic: false});

  assert.equal(out.admitted, false);
  assert.equal(out.reason, 'friend_value_le_harm');
  assert.equal(out.objective.nativeMaxBudgetUsd, 3.25);
});

test('manager forwards reservation and settlement operations to the same durable candidate', async () => {
  const f = candidateFixture();
  const reservation = {attemptId: 'attempt-1', provider: 'claude'};
  const finish = {attemptId: 'attempt-1', execution: {usage: 1}};
  const release = {reason: 'cancelled'};

  assert.deepEqual(await f.manager.reserve(reservation), {ok: true, reservation: {id: 'r'}});
  assert.deepEqual(await f.manager.finish(finish), {settled: true});
  assert.deepEqual(await f.manager.release('attempt-1', release), {applied: true});
  assert.deepEqual(f.calls.slice(-3), [
    ['reserve', reservation], ['finish', finish], ['release', 'attempt-1', release],
  ]);
});

test('without a durable candidate the manager holds with a specific evidence reason', async () => {
  const manager = createLendingManager();
  for (const automatic of [false, true]) {
    const out = await manager.admission({provider: 'claude', automatic});
    assert.equal(out.admitted, false);
    assert.equal(out.reason, 'objective_evidence_unknown');
  }
  assert.deepEqual(await manager.reserve({}), {ok: false, reason: 'objective_evidence_unknown'});
});
