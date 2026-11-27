import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The same launch as the cleanup-journal tests: the lender runs in the background, and f.stop aborts it.
function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: (event) => { f.events.push(event); }});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch((error) => { failure = error; });
  f.stop = async () => {
    controller.abort();
    let timer;
    try {
      await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lender shutdown timed out')), 2000); })]);
    } finally {
      clearTimeout(timer);
    }
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
  return lender;
}

const CODEX_RUN = {model: 'gpt-6-sol'};
const settingsOn = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({providerConsent: {codex: true}}),
  dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});

for (const kind of ['result', 'stopped']) for (const ignoresAbort of [false, true])
test(kind + ' recovery deadline keeps intent and permits the next request' + (ignoresAbort ? ' with a silent transport' : ''),
  {timeout: 20000}, async t => {
    const f = await lenderFixture(t);
    f.policy.recoveryOnly = true;
    f.policy.enabled = false;
    const field = kind === 'result' ? 'resultPending' : 'stoppedPending';
    const method = kind === 'result' ? 'completeAttempt' : 'stopped';
    const intent = {attempt: {attempt_id: 'saved-run', job_digest: f.jobDigest, generation: 1},
      idempotencyKey: 'saved-recovery-key',
      ...(kind === 'result' ? {payload: {saved: true}} : {stoppedAt: '2026-10-09T00:00:00Z'})};
    await f.policy.storage.set({day: '2026-10-09', jobs: 0, milliseconds: 0, pending: null, [field]: intent});
    const requests = [];
    let finishFirst;
    f.client[method] = (...args) => {
      const options = args.at(-1);
      requests.push({args, signal: options.signal});
      if (requests.length > 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        finishFirst = resolve;
        if (!ignoresAbort) options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
      });
    };
    launch(f);
    await until(() => requests.length === 1, 'first recovery request');
    f.clock.advance(29999);
    assert.equal(requests[0].signal.aborted, false);
    f.clock.advance(1);
    assert.equal(requests[0].signal.aborted, true, 'stalled recovery is aborted at 30 seconds');
    await until(() => f.clock.pending().includes(1000), 'next recovery pass scheduled');
    assert.deepEqual(f.saved()[field], intent, 'timeout preserves the exact durable intent');
    assert.equal(f.saved().rejectedResult, undefined);
    f.clock.advance(1000);
    await until(() => requests.length === 2 && f.saved()[field] === null, 'next request completes');
    assert.equal(requests[1].signal.aborted, false, 'each request has a fresh deadline');
    assert.deepEqual(requests[1].args.slice(0, -1), requests[0].args.slice(0, -1));
    assert.equal(requests[1].args.at(-1).idempotencyKey, intent.idempotencyKey);
    finishFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.saved()[field], null, 'a late response cannot overwrite the next pass');
    await f.stop();

    await f.policy.storage.set({...f.saved(), [field]: intent});
    let cancelledSignal;
    f.client[method] = (...args) => {
      cancelledSignal = args.at(-1).signal;
      return new Promise(() => {});
    };
    launch(f);
    await until(() => cancelledSignal, 'restarted recovery request');
    await f.stop();
    assert.equal(cancelledSignal.aborted, true, 'loop cancellation also aborts the bounded request');
    assert.deepEqual(f.saved()[field], intent, 'loop cancellation retains the durable intent');
  });


test('stop notification recovery keeps its three-second deadline with a silent transport', {timeout: 20000}, async t => {
  const f = await lenderFixture(t);
  f.policy.recoveryOnly = true;
  f.policy.enabled = false;
  // Drive the old short guard with the same clock too: the regression is the
  // blocked await after cancellation, not which timer implementation is used.
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController();
    f.clock.setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const run = {attempt_id: 'saved-stop', job_digest: f.jobDigest, generation: 1};
  await f.policy.storage.set({day: '2026-10-09', jobs: 1, milliseconds: 120000,
    pending: {...f.backend.sandboxOwnership(),attemptId: run.attempt_id, attempt: run, reservedMs: 120000, executionStartRequested: true,
      stopReason: 'stopped_by_lender', stopRequestKey: 'saved-notification-key',
      stopReleaseKey: 'saved-release-key', stopReportKey: 'saved-report-key', stopReleased: true,
      stoppedAt: '2026-10-09T00:00:00Z',
      cessationVerified: {sbx_home:f.backend.sandboxOwnership().sbx_home,attemptId: run.attempt_id, jobDigest: f.jobDigest, generation: 1}}});
  const notifications = [];
  f.client.requestStop = (value, options) => {
    notifications.push({value, options});
    return notifications.length === 1 ? new Promise(() => {}) : Promise.resolve();
  };
  let reports = 0;
  f.client.stopped = async () => {
    if (++reports === 1) throw Object.assign(new Error('offline'), {code: 'network_error'});
  };
  launch(f);
  await until(() => notifications.length === 1, 'stop notification started');
  const durable = structuredClone(f.saved().pending);
  f.clock.advance(2999);
  assert.equal(notifications[0].options.signal.aborted, false);
  f.clock.advance(1);
  assert.equal(notifications[0].options.signal.aborted, true);
  await until(() => reports === 1 && f.clock.pending().includes(1000), 'recovery proceeds past the silent notification');
  assert.deepEqual(f.saved().pending, durable, 'failed reporting retains the saved stop');
  f.clock.advance(1000);
  await until(() => reports === 2 && f.saved().pending === null, 'next recovery pass completes');
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].options.idempotencyKey, notifications[0].options.idempotencyKey);
  assert.deepEqual(notifications[1].value, notifications[0].value);
  await f.stop();
});

test('Stop recovery reports verified cessation for a job the allowance candidate never reserved', {timeout: 20000}, async t => {
  const f = await lenderFixture(t);
  const attempt = f.attempt();
  await f.client.startAttempt(attempt);
  const ownership = f.backend.sandboxOwnership();
  f.policy.enabled = false;
  f.policy.recoveryOnly = true;
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:120000,pending:{
    ...ownership,attemptId:attempt.attempt_id,attempt,reservedMs:120000,executionStartRequested:true,
    stopReason:'stopped_by_lender',stopRequestKey:'saved-notification-key',
    stopReleaseKey:'saved-release-key',stopReportKey:'saved-report-key',stoppedAt:'2026-10-09T12:02:00Z',
    cessationVerified:{sbx_home:ownership.sbx_home,attemptId:attempt.attempt_id,jobDigest:f.jobDigest,generation:attempt.generation}
  }});
  const runtime = createLendingRuntime({directory:join(f.root,'pace50'),settings:settingsOn,backend:{},presence:()=>false,
    lastActiveAt:()=>null,selfKey:()=>null,now:f.clock.now,
    pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source:createSyntheticPace50Source({start:f.clock.now()})}});
  f.policy.lendingRuntime = runtime;
  t.after(() => runtime.close());
  assert.deepEqual(runtime.candidate.adapter.state().attempts, []);
  let backendReconciles = 0;
  f.backend.reconcilePending = async () => { backendReconciles++; return {removed:false}; };

  launch(f);
  try {
    await until(() => f.saved().pending === null, 'verified Stop reaches the coordinator', 8000);
    assert.equal(f.count('/stop-request'), 1);
    assert.equal(f.count('/release'), 1);
    assert.equal(f.count('/stopped'), 1);
    assert.equal(backendReconciles, 0, 'the saved proof already establishes cessation');
    assert.deepEqual(runtime.candidate.adapter.state().attempts, []);
  } finally {
    await f.stop();
  }
});

// A Stop whose first write fails before the lender signals the run. The owner retries it, and the retry must still reach the run.
test('a Stop that fails before it signals the run can be retried, and the retry stops the run', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN, hold: true});
  f.policy.userActive = async () => false;
  // The graceful path needs a requestStop that declines, so the lender writes its graceful reason before it signals.
  f.backend.requestStop = async () => ({delivered: false});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: f.clock.now()})}});
  f.policy.lendingRuntime = runtime;
  t.after(() => runtime.close());
  const set = f.policy.storage.set;
  let failedOnce = false;
  f.policy.storage.set = async (value) => {
    if (!failedOnce && value?.pending?.gracefulStopReason === 'owner') {
      failedOnce = true;
      throw new Error('injected write failure');
    }
    return set(value);
  };
  const lender = launch(f);
  await until(() => f.calls.some(([kind]) => kind === 'run'), 'the run started');
  const attemptId = f.attempt().attempt_id;
  await assert.rejects(lender.stopCurrentJob(attemptId), /injected write failure/);
  // The first attempt never signalled the run, so the retry must reach it.
  await lender.stopCurrentJob(attemptId);
  f.execution.resolve();
  await until(() => f.calls.some(([kind]) => kind === 'destroy'), 'the sandbox was removed after the retried Stop');
  await f.stop();
});
