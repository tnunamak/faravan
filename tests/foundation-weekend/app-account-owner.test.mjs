import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountBroker} from '../../lib/v1/account-broker.mjs';

// Partial compatibility regression only; NOT the AppLifetime integration suite.
// Synthetic provider ports, no network, credentials, sandbox or installed state.
function fixture(cancel) {
  let next = 0, finishes = 0;
  const adapter = {
    beginSignIn: async () => ({ok:true, value:{flowId:'flow-' + (++next)}}),
    cancelSignIn: cancel,
    finishSignIn: async () => { finishes++; throw new Error('must not finish cancelled flow'); },
  };
  const broker = createAccountBroker({
    store:{read:()=>({records:{}})}, clock:()=>1000, providers:{getProvider:()=>({ok:true,value:adapter})},
    proxy:{}, authority:{},
  });
  return {broker, finishes:()=>finishes};
}

test('cancel only a matching flow owned by this broker; repeated cancel is inert', async () => {
  const cancelled = [];
  const {broker} = fixture(async id => { cancelled.push(id); });
  const flow = await broker.enroll({providerId:'synthetic',label:'one'});
  assert.equal(typeof broker.cancelSignIn, 'function');
  assert.equal((await broker.cancelSignIn('foreign-flow')).ok, true);
  assert.deepEqual(cancelled, []);
  assert.equal((await broker.cancelSignIn(flow.value.flowId)).ok, true);
  assert.equal((await broker.cancelSignIn(flow.value.flowId)).ok, true);
  assert.deepEqual(cancelled, [flow.value.flowId]);
  await broker.close();
  assert.deepEqual(cancelled, [flow.value.flowId]);
});

test('pending cancellation coalesces and prevents completion claiming the flow', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const {broker, finishes} = fixture(async () => { calls++; await pending; });
  const flow = await broker.enroll({providerId:'synthetic',label:'one'});
  const first = broker.cancelSignIn(flow.value.flowId);
  const second = broker.cancelSignIn(flow.value.flowId);
  await Promise.resolve();
  const completed = await broker.complete({flowId:flow.value.flowId,answer:{}});
  assert.equal(completed.ok, false);
  assert.equal(finishes(), 0);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(calls, 1);
  await broker.close();
});

test('failed cancellation retains owned cleanup for retry and never reports success', async () => {
  let calls = 0;
  const {broker} = fixture(async () => { if (++calls === 1) throw new Error('synthetic failure'); });
  const flow = await broker.enroll({providerId:'synthetic',label:'one'});
  const result = await broker.cancelSignIn(flow.value.flowId);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'signin_cancel_failed');
  assert.equal((await broker.cancelSignIn(flow.value.flowId)).ok, true);
  assert.equal(calls, 2);
  await broker.close();
});

test('close shares pending cancellation instead of cancelling twice', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const {broker} = fixture(async () => { calls++; await pending; });
  const flow = await broker.enroll({providerId:'synthetic',label:'one'});
  const cancelling = broker.cancelSignIn(flow.value.flowId);
  const closing = broker.close();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([cancelling, closing]);
  assert.equal(calls, 1);
});
