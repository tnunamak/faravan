import './helpers/no-browser.mjs';
// A finished result that is still being delivered must keep its files, even when another job shares them and is deleted.
// Runs the real lender, signed client, HTTP server and SQLite coordinator, with a fake backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until, deferred} from './helpers/v1-lender-fixture.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
    clock:f.clock, approve:async () => true, onEvent:event => f.events.push(event)});
  const settled = lender.start(controller.signal).catch(() => {});
  f.stop = async () => {
    controller.abort();
    let timer;
    try {await Promise.race([settled, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('shutdown timed out')), 4000);})]);}
    finally {clearTimeout(timer);}
  };
  return lender;
}
const ended = e => ['failed', 'finished', 'stopped', 'result-unconfirmed'].includes(e.status) || e.stopCompletion;

test('deleting a finished job does not remove the result files of a second job that shares them and is still delivering',
  {timeout:20000}, async t => {
  const f = await realLenderFixture(t);
  launch(f);
  await until(() => f.events.some(e => e.status === 'finished'), 'first job delivered');
  const first = f.jobDigest, firstView = await f.owner.getJob(first);
  assert.equal(firstView.state, 'result-accepted');
  // Second job: same deterministic candidate bytes. Hold its completion after its upload finished.
  const gate = deferred(); let completing = false;
  t.after(() => gate.resolve());
  const complete = f.client.completeAttempt.bind(f.client);
  f.client.completeAttempt = async (...args) => {completing = true; await gate.promise; return complete(...args);};
  const from = f.events.length;
  const second = await f.submit();
  await until(() => completing, 'second result uploaded, completion in flight');
  const intent = f.saved().resultPending;
  const firstResult = await f.owner.fetchResult(first, {attempt:firstView.current_attempt, includeMetadata:true});
  assert.equal(intent.payload.candidate.digest, firstResult.candidate.digest, 'both results name one content-addressed blob');
  await f.owner.deleteJob(first);
  gate.resolve();
  await until(() => f.events.slice(from).some(ended), 'second delivery outcome');
  await f.stop();
  const view = await f.owner.getJob(second);
  const outcome = f.saved().lastResultOutcome;
  assert.equal(view.state, 'result-accepted', 'second finished job was refused: ' + (outcome?.code ?? view.state));
  assert.equal(f.events.slice(from).some(e => e.status === 'failed'), false, 'finished work reported failed');
});
