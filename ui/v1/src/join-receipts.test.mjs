import test from 'node:test';
import assert from 'node:assert/strict';
import {joinReceipt, applyJoinReceipts} from './join-receipts.mjs';

const pending = {id: 'c1', name: 'G2 friends', enrollment: {enrollment_id: 'e1', state: 'pending'}, joinInfo: {approval: 'each', ownerName: 'Alex Rivera'}};
test('I16: an approved check answer marks the waiting circle joined before the circles read returns', () => {
  const receipt = joinReceipt('circles/c1/check', {state: 'approved'}, [pending]);
  assert.deepEqual(receipt, {circle: 'c1', enrollment: 'e1'});
  const [circle] = applyJoinReceipts([pending], {c1: receipt});
  assert.equal(circle.enrollment.state, 'approved');
  // A delayed read that started before the approval still says pending; the receipt keeps the joined state.
  assert.equal(applyJoinReceipts([structuredClone(pending)], {c1: receipt})[0].enrollment.state, 'approved');
});
test('a pending answer, another path or a new enrollment is not changed by a receipt', () => {
  assert.equal(joinReceipt('circles/c1/check', {state: 'pending'}, [pending]), null);
  assert.equal(joinReceipt('circles/c1/leave', {state: 'approved'}, [pending]), null);
  const receipt = {circle: 'c1', enrollment: 'e1'};
  const rejoined = {...pending, enrollment: {enrollment_id: 'e2', state: 'pending'}};
  assert.equal(applyJoinReceipts([rejoined], {c1: receipt})[0].enrollment.state, 'pending');
  const rejected = {...pending, enrollment: {enrollment_id: 'e1', state: 'rejected'}};
  assert.equal(applyJoinReceipts([rejected], {c1: receipt})[0].enrollment.state, 'rejected');
  const list = [pending];
  assert.equal(applyJoinReceipts(list, {}), list, 'no receipt keeps the same array');
});
