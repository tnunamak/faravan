import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {adaptLegacyJob, jobStatusLabel} from '../lib/v1/state-projection.mjs';

import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until, deferred} from './helpers/v1-lender-fixture.mjs';

// Replays of spec/tla/Stop.tla paths against the real signed client, server and SQLite coordinator.
const runs = f => f.calls.filter(([k]) => k === 'run').length;
function launch(f) {
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
    clock:f.clock, approve:async () => true, onEvent:event => f.events.push(event)});
  const task = lender.start(controller.signal);
  let failure;
  const settled = task.catch(e => {failure = e;});
  f.stop = async () => {
    controller.abort();
    let timer;
    try {await Promise.race([settled, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('stop test shutdown timed out')), 4000);})]);}
    finally {clearTimeout(timer);}
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
  return lender;
}
function completionWire(mode) {
  return (req, res) => {
    if (!req.url.endsWith('/complete')) return false;
    const head = res.writeHead, end = res.end;
    res.writeHead = function(status, headers) {
      const copy = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-length'));
      return head.call(this, status, copy);
    };
    res.end = function(bytes, ...args) {
      if (this.statusCode !== 200) return end.call(this, bytes, ...args);
      if (mode.value === 'lost') {req.socket.destroy(); return this;}
      if (mode.value === 'json') return end.call(this, '{');
      if (mode.value === 'shape') return end.call(this, '{}');
      return end.call(this, bytes, ...args);
    };
    return false;
  };
}
for (const delivery of ['live','recovery']) for (const format of ['json','shape'])
test(`${delivery}: coordinator accepts completion -> HTTP 200 ${format} reply -> accepted work must not become local failure`, {timeout:20000}, async t => {
  const mode = {value:delivery === 'recovery' ? 'lost' : format};
  const f = await realLenderFixture(t, {intercept:completionWire(mode)});
  let from = f.events.length;
  launch(f);
  if (delivery === 'recovery') {
    await until(() => f.events.some(e => e.reason === 'circle_unreachable'), 'lost completion acknowledgement');
    await f.stop();
    assert.ok(f.saved().resultPending, 'exact signed result survives the first ambiguous reply');
    mode.value = format;
    from = f.events.length;
    launch(f);
  }
  await until(() => f.events.slice(from).some(e => ['failed','finished','stopped'].includes(e.status) || e.status === 'sending-result' && e.reason), 'completion handled locally');
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted', 'real SQLite coordinator committed before reply corruption');
  assert.equal(runs(f), 1);
  assert.equal(f.events.some(e => e.status === 'failed'), false, 'an accepted result must stay successful or pending verification');
});

test('finished output -> borrower cancellation wins during send -> lender must not relabel finished work failed', {timeout:20000}, async t => {
  const f = await realLenderFixture(t);
  const gate = deferred(); let sending = false;
  t.after(() => gate.resolve());
  const complete = f.client.completeAttempt.bind(f.client);
  f.client.completeAttempt = async (...args) => {sending = true; await gate.promise; return complete(...args);};
  launch(f);
  await until(() => sending, 'finished output and durable completion waiting for delivery');
  assert.ok(f.saved().resultPending);
  const cancel = await f.owner.cancelJob(f.jobDigest);
  assert.equal(cancel.authority_revoked, true);
  gate.resolve();
  await until(() => f.events.some(e => ['failed','finished','stopped'].includes(e.status) || e.status === 'sending-result' && e.reason), 'cancellation conflict handled');
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'cancelled');
  assert.equal(f.events.some(e => e.status === 'failed'), false, 'finished work cancelled during delivery needs a cancelled/preserved outcome, not failed');
});

test('finished output -> borrower cancellation wins -> discarded journal -> restart must recover borrower final state', {timeout:20000}, async t => {
  const f = await realLenderFixture(t, {rosterValidUntil:'2026-11-07T11:00:00Z'});
  const gate = deferred(); let sending = false;
  t.after(() => gate.resolve());
  const complete = f.client.completeAttempt.bind(f.client);
  f.client.completeAttempt = async (...args) => {sending = true; await gate.promise; return complete(...args);};
  launch(f);
  await until(() => sending, 'finished output and durable completion waiting for delivery');
  assert.ok(f.saved().resultPending);
  const cancel = await f.owner.cancelJob(f.jobDigest);
  assert.equal(cancel.authority_revoked, true);
  gate.resolve();
  await until(() => f.events.some(e => ['failed','finished','stopped'].includes(e.status) || e.status === 'sending-result' && e.reason), 'cancellation conflict handled');
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'cancelled');
  f.policy.recoveryOnly = true;
  launch(f);
  await until(() => f.clock.pending().includes(1000), 'restart idle with no cessation report intent', 5000);
  f.clock.advance(7 * 86400e3);
  await until(() => f.clock.pending().includes(1000), 'recovery revisits after all deadlines and quota resets');
  await f.stop();
  const view = await f.clientFor(0).getJob(f.jobDigest);
  assert.equal(adaptLegacyJob(view).phase, 'stopped', 'the borrower must eventually leave Stopping after confirmed removal');
});

test('lost and late completion acknowledgement -> lender restart -> exact retry preserves finished result', {timeout:20000}, async t => {
  const mode = {value:'lost'};
  const f = await realLenderFixture(t, {intercept:completionWire(mode)});
  launch(f);
  await until(() => f.events.some(e => e.reason === 'circle_unreachable'), 'first reply lost');
  await f.stop();
  const intent = structuredClone(f.saved().resultPending);
  mode.value = 'good'; launch(f);
  await until(() => f.events.some(e => e.status === 'finished'), 'same completion accepted on replay');
  await f.stop();
  assert.equal(f.saved().resultPending, null);
  assert.equal(f.saved().lastResultOutcome, undefined);
  assert.equal(runs(f), 1);
  assert.ok(f.realRequests.filter(q => q.url.endsWith('/complete')).every(q => q.key === intent.idempotencyKey));
  assert.equal((await f.clientFor(0).getJob(f.jobDigest)).state, 'result-accepted');
});

for (const origin of ['borrower','lender'])
test(`${origin} Stop -> removal pending -> lender restart -> confirmed cessation -> borrower final state`, {timeout:25000}, async t => {
  const f = await realLenderFixture(t, {hold:true, run:{model:'gpt-6-sol'}});
  f.policy.userActive = async () => false;
  let removed = false;
  f.backend.destroy = async () => {f.calls.push(['destroy']); return {removed};};
  f.backend.reconcilePending = async pending => ({attemptId:pending.attemptId, removed});
  let lender = launch(f);
  await until(() => runs(f) === 1 || f.events.some(e => ['failed','declined','reserve','paused'].includes(e.status) && e.reason), 'sandbox or gate', 5000);
  assert.equal(runs(f), 1, JSON.stringify(f.events.map(e => ({status:e.status, reason:e.reason}))));
  const attempt = (await f.owner.getJob(f.jobDigest)).current_attempt;
  if (origin === 'borrower') {
    const ack = await f.owner.cancelJob(f.jobDigest);
    assert.equal(ack.compute_stopped, false, 'cancel ACK revokes authority without claiming cessation');
    f.clock.advance(30_000);
  } else await lender.stopCurrentJob(attempt.attempt_id);
  await until(() => f.events.some(e => e.reason === 'cleanup_pending'), 'removal not yet proven');
  assert.ok(f.saved().pending);
  assert.equal(f.events.some(e => e.stopCompletion), false, 'no stopped-success event without removal proof');
  await f.stop();
  removed = true; lender = launch(f);
  await until(() => f.saved().pending === null, 'restart consumes backend removal proof');
  if (origin === 'borrower') await until(() => f.saved().stoppedPending === null, 'borrower cancellation cessation report acknowledged');
  await f.stop();
  const view = await f.clientFor(0).getJob(f.jobDigest);
  assert.ok(['cancelled','failed','expired','result-accepted'].includes(view.state));
  assert.equal(view.current_attempt.compute_stopped, true);
  assert.equal(runs(f), 1);
});

test('borrower cancel intent -> lost reply -> borrower restart -> same cancellation is replayed and cessation is not invented', {timeout:20000}, async t => {
  const f = await realLenderFixture(t, {hold:true});
  launch(f);
  await until(() => runs(f) === 1, 'running before cancellation');
  const file = join(f.root, 'borrower-intents.json');
  fs.writeFileSync(file, '{}');
  const store = {
    get:async key => JSON.parse(fs.readFileSync(file))[key],
    set:async (key,value) => {const data = JSON.parse(fs.readFileSync(file)); data[key] = value; fs.writeFileSync(file, JSON.stringify(data));},
    list:async () => Object.values(JSON.parse(fs.readFileSync(file))),
  };
  function operations(client) {
    const device = {keyId:f.job.payload.author, selectCircle:async () => ({id:f.job.payload.circle}), client:async () => client,
      intentStore:() => store, withOperationLock:async (_, fn) => fn(),
      rosterCache:() => ({get:async () => ({current:{payload:{epoch:7}}})})};
    return createJobOperations({device, clock:() => Math.floor(f.clock.now()/1000)});
  }
  const cancel = f.owner.cancelJob.bind(f.owner);
  f.owner.cancelJob = async (...args) => {await cancel(...args); throw Object.assign(new Error('reply lost'), {code:'network_error'});};
  const input = {digest:f.jobDigest, circle:f.job.payload.circle};
  await assert.rejects(operations(f.owner).cancel(input), {code:'network_error'});
  const pending = await store.get('cancel:' + f.jobDigest);
  assert.equal(pending.state, 'pending');
  const ack = await operations(f.clientFor(0)).cancel(input);
  assert.equal(ack.compute_stopped, false);
  assert.equal((await store.get('cancel:' + f.jobDigest)).state, 'complete');
  const sent = f.realRequests.filter(q => q.url.endsWith('/cancel'));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(q => q.key === pending.operationKey && q.bodyDigest === sent[0].bodyDigest));
  const before = await f.clientFor(0).getJob(f.jobDigest);
  assert.equal(adaptLegacyJob(before).phase, 'stopping');
  f.clock.advance(30_000);
  await until(() => f.events.some(e => e.status === 'stopped'), 'renew detects cancellation and cleanup completes');
  await f.stop();
  const after = await f.clientFor(0).getJob(f.jobDigest);
  assert.equal(after.current_attempt.compute_stopped, true);
  assert.equal(adaptLegacyJob(after).phase, 'stopped');
});

test('graceful lender Stop -> job finishes while Stop notification is delayed -> result stays finished on both computers', {timeout:20000}, async t => {
  const f = await realLenderFixture(t, {hold:true});
  const notice = deferred(); let notifying = false;
  const request = f.client.requestStop.bind(f.client);
  f.client.requestStop = async (...args) => {notifying = true; await notice.promise; return request(...args);};
  t.after(() => notice.resolve());
  const lender = launch(f);
  await until(() => runs(f) === 1, 'running before delayed Stop');
  const stopping = lender.stopCurrentJob(lender.getState().current).catch(e => e);
  await until(() => notifying, 'Stop message in flight');
  f.execution.resolve();
  await until(() => f.events.some(e => e.status === 'finished'), 'normal completion wins while Stop notification waits');
  notice.resolve();
  await stopping;
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
  assert.equal(f.events.some(e => e.status === 'failed'), false);
});

test('Stop request lost -> cessation reply lost -> lender restart retries the exact report without reporting premature success', {timeout:20000}, async t => {
  const f = await realLenderFixture(t, {hold:true});
  let notifications = 0, reports = 0;
  const request = f.client.requestStop.bind(f.client), report = f.client.stopped.bind(f.client);
  f.client.requestStop = async (...args) => {
    if (++notifications === 1) throw Object.assign(new Error('request lost before commit'), {code:'network_error'});
    return request(...args);
  };
  f.client.stopped = async (...args) => {
    const ack = await report(...args);
    if (++reports === 1) throw Object.assign(new Error('reply lost after commit'), {code:'network_error'});
    return ack;
  };
  const lender = launch(f);
  await until(() => runs(f) === 1, 'running before lost Stop message');
  const id = lender.getState().current;
  await lender.stopCurrentJob(id);
  await until(() => f.events.some(e => e.reason === 'cleanup_pending'), 'lost stopped acknowledgement retains journal');
  assert.equal(f.events.some(e => e.stopCompletion), false);
  const saved = structuredClone(f.saved().pending);
  assert.ok(saved.cessationVerified);
  await f.stop(); launch(f);
  await until(() => f.events.some(e => e.stopCompletion), 'restart retries the stopped report');
  await f.stop();
  assert.equal(f.saved().pending, null);
  assert.equal(runs(f), 1);
  assert.ok(f.realRequests.filter(q => q.url.endsWith('/stopped')).every(q => q.key === saved.stopReportKey));
  assert.equal((await f.owner.getJob(f.jobDigest)).current_attempt.compute_stopped, true);
});

test('graceful lender Stop preserves partial output and reports cessation to the borrower', {timeout:20000}, async t => {
  const f = await realLenderFixture(t, {hold:true});
  // The graceful backend returns the work produced so far after receiving Stop.
  f.backend.requestStop = async () => {f.execution.resolve(); return {delivered:true};};
  const lender = launch(f);
  await until(() => runs(f) === 1, 'running before graceful Stop');
  f.policy.lendingRuntime = {reconcileAttempt() {}};
  await lender.stopCurrentJob(lender.getState().current);
  await until(() => f.events.some(e => e.status === 'finished'), 'partial output delivered');
  await f.stop();
  const view = await f.owner.getJob(f.jobDigest);
  assert.equal(view.state, 'result-accepted');
  assert.ok(view.result_digest);
  assert.equal(view.current_attempt.compute_stopped, true);
  assert.ok(view.current_attempt.stopped_at);
  view.stopRequest = await f.owner.getStopRequest(view.current_attempt);
  assert.equal(jobStatusLabel(view), 'Stopped by lender');
  assert.equal(adaptLegacyJob(view).result.available, true);
});
