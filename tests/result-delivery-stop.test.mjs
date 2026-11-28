import './helpers/no-browser.mjs';
// A job that already produced its output must reach the borrower, whatever happens to the run's controls afterwards.
// These tests use the real signed client, HTTP server, SQLite coordinator and lender with a fake backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until, deferred} from './helpers/v1-lender-fixture.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
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
// A slow upload: waits for the gate, or for the caller's abort, then runs the real upload.
function slowUpload(f, gate, seen) {
  const upload = f.client.uploadResultArtifacts.bind(f.client);
  f.client.uploadResultArtifacts = async (input, opts = {}) => {
    seen.calls++;
    await Promise.race([gate.promise, new Promise(resolve => opts.signal?.addEventListener('abort', resolve, {once:true}))]);
    return upload(input, opts);
  };
}
const ended = e => ['failed', 'finished', 'stopped', 'result-unconfirmed'].includes(e.status) || e.stopCompletion;
const renewals = f => f.realRequests.filter(r => r.url.endsWith('/renew')).length;

// The lender presses Stop at `hold`, a step that runs after the output exists. The output must still be delivered.
async function stopAt(t, hold) {
  const f = await realLenderFixture(t);
  const gate = deferred(); let reached = false;
  t.after(() => gate.resolve());
  hold(f, async () => {reached = true; await gate.promise;});
  const lender = launch(f);
  await until(() => reached, 'lender held at the chosen step');
  // A save held by `hold` blocks every later save, so the Stop may only settle after the gate opens.
  // A Stop deferred because the output exists is answered like a Stop for a job that already finished.
  const stopping = lender.stopCurrentJob(lender.getState().current).catch(e => assert.equal(e.code, 'no_current_job'));
  await new Promise(resolve => setTimeout(resolve, 100));
  gate.resolve();
  await stopping;
  await until(() => f.events.some(ended), 'stop or delivery outcome');
  await f.stop();
  const stopShown = f.events.some(e => e.stopCompletion || e.status === 'stopped');
  const view = await f.owner.getJob(f.jobDigest);
  assert.equal(view.state, 'result-accepted', 'finished output must reach the borrower; got ' + view.state + ' (' + view.terminal_reason + ')');
  assert.equal(stopShown && Boolean(f.saved().outputPending), false, 'Stopped shown while the output is still undelivered');
}

test('Stop while the collected output is being saved still delivers the output', {timeout:20000}, async t => {
  await stopAt(t, (f, held) => {
    const set = f.policy.storage.set;
    f.policy.storage.set = async value => {if(value.outputPending && !f.saved()?.outputPending) await held(); return set(value);};
  });
});

test('Stop while the sandbox of a finished run is removed still delivers the output', {timeout:20000}, async t => {
  await stopAt(t, (f, held) => {
    const destroy = f.backend.destroy.bind(f.backend);
    f.backend.destroy = async (...args) => {if (f.saved()?.outputPending) await held(); return destroy(...args);};
  });
});

test('Stop while the finished output uploads still delivers the output', {timeout:20000}, async t => {
  await stopAt(t, (f, held) => {
    const upload = f.client.uploadResultArtifacts.bind(f.client);
    f.client.uploadResultArtifacts = async (...args) => {await held(); return upload(...args);};
  });
});

test('the lease keeps renewing while a deferred Stop waits for the upload', {timeout:20000}, async t => {
  const f = await realLenderFixture(t);
  const gate = deferred(), seen = {calls:0};
  t.after(() => gate.resolve());
  slowUpload(f, gate, seen);
  const lender = launch(f);
  await until(() => seen.calls === 1, 'finished output, upload in flight');
  await lender.stopCurrentJob(lender.getState().current).catch(e => assert.equal(e.code, 'no_current_job'));
  const before = renewals(f);
  for (let i = 0; i < 3; i++) {
    f.clock.advance(f.policy.renewMs + 1000);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(renewals(f) > before, 'the lease was not renewed while the upload was in flight');
  gate.resolve();
  await until(() => f.events.some(ended), 'delivery outcome');
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
});

test('a borrower cancel during the upload does not make the lender show the kept output as failed', {timeout:20000}, async t => {
  const f = await realLenderFixture(t);
  const gate = deferred(), seen = {calls:0};
  t.after(() => gate.resolve());
  slowUpload(f, gate, seen);
  launch(f);
  await until(() => seen.calls === 1, 'finished output, upload in flight');
  await f.owner.cancelJob(f.jobDigest);
  f.clock.advance(120e3); // the lease renewal sees the cancellation and aborts the upload
  await until(() => f.events.some(e => e.status === 'stopped'), 'lender shows Stopped after the cancel');
  gate.resolve();
  await until(() => f.events.some(e => e.status === 'failed') || f.saved().outputPending == null, 'spool handled', 8000).catch(() => {});
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'cancelled');
  const failed = f.events.find(e => e.status === 'failed');
  assert.equal(failed, undefined, 'finished, cancelled work shown failed: ' + failed?.reason);
});

test('Stop while the output waits for its first durable save still stops the provider work before cleanup', {timeout:20000}, async t => {
  const f = await realLenderFixture(t);
  const gate = deferred(); let reached = false; const stops = [];
  t.after(() => gate.resolve());
  f.backend.requestStop = async (handle, reason) => {stops.push(reason); return {delivered:false};};
  const set = f.policy.storage.set;
  f.policy.storage.set = async value => {if(value.outputPending && !f.saved()?.outputPending) {reached = true; await gate.promise;} return set(value);};
  const lender = launch(f);
  await until(() => reached, 'output held at its first durable save');
  await lender.stopCurrentJob(lender.getState().current).catch(e => assert.equal(e.code, 'no_current_job'));
  const providerStops = [...stops];
  gate.resolve();
  await until(() => f.events.some(ended), 'delivery outcome');
  await f.stop();
  assert.deepEqual(providerStops, ['owner'], 'provider work was not stopped while the output waited to be saved');
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted', 'finished output must still reach the borrower');
});

for (const [name, answer] of [['not delivered', async () => ({delivered:false})], ['throws', async () => {throw new Error('backend gone');}]]) {
  test('Stop with held output and a backend stop that ' + name + ' keeps a durable Stop record and stops the provider work after the save', {timeout:20000}, async t => {
    const f = await realLenderFixture(t);
    const gate = deferred(); let reached = false; const stops = [];
    t.after(() => gate.resolve());
    f.backend.requestStop = async (handle, reason) => {stops.push(reason); return answer();};
    const set = f.policy.storage.set; const durable = [];
    f.policy.storage.set = async value => {
      if(value.pending?.gracefulStopReason === 'owner' && value.pending.stopRequestKey) durable.push(value.pending.stopRequestKey);
      if(value.outputPending && !f.saved()?.outputPending) {reached = true; await gate.promise;}
      return set(value);
    };
    const lender = launch(f);
    await until(() => reached, 'output held at its first durable save');
    await lender.stopCurrentJob(lender.getState().current).catch(e => assert.equal(e.code, 'no_current_job'));
    gate.resolve();
    await until(() => f.events.some(ended), 'delivery outcome');
    await f.stop();
    assert.ok(durable.length > 0, 'no durable Stop record was written for an undelivered stop');
    assert.ok(stops.length >= 2, 'the hard stop did not follow the saved output: ' + JSON.stringify(stops));
    assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted', 'finished output must still reach the borrower');
  });
}
