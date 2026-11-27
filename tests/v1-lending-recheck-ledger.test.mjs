import './helpers/no-browser.mjs';
// A running job's recheck (preview with replacingAttemptId) must rebuild the risk ledger that job was issued under,
// through the real durable adapter, policy, objective, continuous model and ledger. Each issuance in a weekly window
// carries a dense ordinal 1, 2, 3; with more than one job per account, a newer issuance must not break the recheck of
// an older job, and the recheck must still count every other job's hold and leave the durable state untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createContinuousDemandModel} from '../lib/v1/lending-continuous-model.mjs';
import {ACCOUNT, NOW, WEEK, MICRO, ordinaryInput, request, weekly} from './helpers/pace50-fixtures.mjs';

const LIGHT = createContinuousDemandModel({alpha0: 2, b0: 10});

function rig(t) {
  fs.mkdirSync(join(homedir(), '.tmp'), {recursive: true});
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'recheck-ledger-'));
  const box = {usedMicro: 20 * MICRO};
  const buildInput = async ({now}) => {
    const windows = [weekly(now, {used_micro: box.usedMicro})];
    const input = ordinaryInput({now, windows});
    input.objective = {...input.objective, demandModel: LIGHT, frozenProtectionSource: 'model',
      modelDataByResource: {weekly: {originAtMs: now, initialOwnerUsedMicro: 20 * MICRO}}};
    // A small signed budget per job, so several jobs hold issuances in one weekly window at once.
    input.objective.job.requestedUsdMicro = 2 * MICRO;
    return input;
  };
  const noop = async () => {};
  box.adapter = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW, buildInput,
    effects: {arm_cessation_deadline: async () => () => {}, launch_chunk: noop, open_short_window: noop,
      cancel_pending_attempt: noop, request_cessation: noop, request_fresh_complete_reconciliation: noop}});
  t.after(async () => { await box.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const jobRequest = id => request({attempt_id: id, job_id: id, requested_usd_micro: 2 * MICRO});
  box.admit = async id => {
    const out = await box.adapter.admit({expectedRevision: box.adapter.state().revision, request: jobRequest(id)});
    assert.equal(out.admitted, true, out.reason);
  };
  box.recheck = id => box.adapter.preview({request: jobRequest(id), replacingAttemptId: id});
  box.row = id => box.adapter.state().attempts.find(a => a.id === id).resources.find(r => r.id === 'weekly');
  box.stateFile = () => fs.readFileSync(join(directory, 'lending-pace50-state.json'), 'utf8');
  return box;
}

test('an older job\'s recheck passes while a newer job holds the next issuance', async t => {
  const r = rig(t);
  await r.admit('a1');
  await r.admit('a2');
  assert.deepEqual([r.row('a1').demand_model.update_index, r.row('a2').demand_model.update_index], [1, 2]);
  const out = await r.recheck('a1');
  assert.notEqual(out.reason, 'demand_model_invalid', 'the newer issuance must not leave a gap in the rebuilt ledger');
  assert.equal(out.admitted, true, out.reason);
});

test('each recheck reissues its own ordinal and still counts every other job\'s hold', async t => {
  const r = rig(t);
  for (const id of ['a1', 'a2', 'a3']) await r.admit(id);
  const rows = Object.fromEntries(['a1', 'a2', 'a3'].map(id => [id, r.row(id)]));
  assert.deepEqual(Object.values(rows).map(row => row.demand_model.update_index), [1, 2, 3]);
  for (const id of ['a1', 'a2', 'a3']) {
    const out = await r.recheck(id);
    assert.equal(out.admitted, true, `${id}: ${out.reason}`);
    // Same ordinal, same risk target, same readings: the protected owner reserve is the one this job was issued.
    assert.equal(out.objective.protectedOwnerPoints.weekly, rows[id].demand_model.reserve_points, id);
    // The other two jobs' holds, earlier and later, are still committed against the window.
    const othersHeld = Object.entries(rows).filter(([other]) => other !== id)
      .reduce((sum, [, row]) => sum + row.held_micro, 0);
    assert.equal(out.objective.committedPoints.weekly * MICRO, othersHeld, id);
  }
});

test('a recheck changes no durable hold, ordinal or reservation', async t => {
  const r = rig(t);
  for (const id of ['a1', 'a2', 'a3']) await r.admit(id);
  const before = r.stateFile();
  const revision = r.adapter.state().revision;
  for (const id of ['a1', 'a2', 'a3']) assert.equal((await r.recheck(id)).admitted, true, id);
  assert.equal(r.stateFile(), before, 'the durable state is byte-identical after the rechecks');
  assert.equal(r.adapter.state().revision, revision);
});

test('an older job\'s recheck still refuses when the owner has used the headroom', async t => {
  const r = rig(t);
  await r.admit('a1');
  await r.admit('a2');
  r.usedMicro = 99 * MICRO;
  const out = await r.recheck('a1');
  assert.equal(out.admitted, false, 'exhausted headroom must stop the older job');
  assert.notEqual(out.reason, 'demand_model_invalid', 'the refusal is for headroom, not a broken ledger');
});
