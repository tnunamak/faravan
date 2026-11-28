import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Money review r2: a run that throws (no sandbox) used to leave the cadence unset, so the tick probed every 30 s.

test('approval copy cannot turn a hold or active job into a ready account', async () => {
  const {lendingStatus} = await import('../lib/v1/lending-status-copy.mjs');
  for (const args of [{admitted:false, reason:'controls'}, {admitted:false, reason:'identity_unknown'},
    {admitted:true, active:true}]) {
    assert.deepEqual(lendingStatus({...args, approvalRequired:true}), lendingStatus(args));
  }
  const ready = lendingStatus({admitted:true});
  assert.deepEqual(lendingStatus({admitted:true, approvalRequired:false}), ready);
  assert.equal(lendingStatus({admitted:true, approvalRequired:true}).line,
    ready.line + ' You approve each job before it starts.');
});
