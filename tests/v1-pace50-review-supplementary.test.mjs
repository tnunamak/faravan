import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, WEEK, NOW, ordinaryInput, request} from './helpers/pace50-fixtures.mjs';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {meteringSandbox} from './helpers/pace50-app-sandbox.mjs';
const handlers = () => ({arm_cessation_deadline: async () => () => {}, launch_chunk: async () => {},
  open_short_window: async () => {}, cancel_pending_attempt: async () => {}, request_cessation: async () => {},
  request_fresh_complete_reconciliation: async () => {}});
function adapter(t, effects = handlers()) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'review-control-'));
  const open = () => createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW,
    buildInput: async ({now}) => ordinaryInput({now}), effects});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, open};
}

for (const type of ['stop', 'pause', 'owner_return']) test(`independent ${type} fence beats queued On and admission`, async t => {
  let launches = 0;
  const r = adapter(t, {...handlers(), launch_chunk: async () => {launches++;}});
  const a = r.open();
  const on = a.transition({type: 'on', event_id: 'on', at: NOW}, {expectedRevision: 0});
  const admission = a.admit({expectedRevision: 1, request: request()});
  const stop = a.transition({type, event_id: 'control', at: NOW}, {expectedRevision: 1});
  assert.equal((await on).applied, true);
  assert.equal((await admission).admitted, false);
  assert.equal((await stop).applied, true);
  assert.equal(launches, 0);
  assert.equal(a.state().attempts.length, 0);
  await a.close();
});

test('deliver re-entry queues Pause without deadlocking or allowing the launch', async t => {
  let a, launches = 0;
  const r = adapter(t, {...handlers(), arm_cessation_deadline: async () => {
    assert.deepEqual(await a.deliver({type: 'pause', event_id: 'in-arm-pause', at: NOW}), {queued: true});
    return () => {};
  }, launch_chunk: async () => {launches++;}});
  a = r.open();
  const out = await a.admit({expectedRevision: 0, request: request()});
  const closing = await a.close(); // drains the queued Pause
  assert.equal(out.effects_dispatched, false);
  assert.equal(launches, 0);
  assert.equal(a.state().mode, 'paused');
  assert.equal(closing.live_attempts.length, 1);
});

test('restart recovery issues cessation without relaunching or releasing a stored reservation', async t => {
  const calls = [];
  const r = adapter(t, {...handlers(), launch_chunk: async () => {calls.push('launch');},
    request_cessation: async effect => {calls.push(effect.dedupe_key);}});
  const a = r.open(); await a.admit({expectedRevision: 0, request: request()}); await a.close();
  const b = r.open(); const before = b.state(); await b.recover(); await b.recover();
  assert.deepEqual(b.state(), before);
  assert.deepEqual(calls, ['launch', 'request_cessation:attempt-1', 'request_cessation:attempt-1']);
  assert.ok(b.state().attempts[0].resources.every(r => r.released_micro === 0));
  await b.close();
});

test('production recovery handler can block close on backend inventory with no deadline signal', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'review-default-recovery-'));
  let unblock, entered, receivedSignal;
  const hold = new Promise(resolve => {unblock = resolve;});
  const entry = new Promise(resolve => {entered = resolve;});
  const source = createSyntheticPace50Source({start: NOW});
  const open = () => createPace50Candidate({directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW,
    source, contextFor: () => ({consent: true}), pendingRecords: () => [{attemptId: 'attempt-1'}],
    backend: {reconcilePending: async (_record, opts) => {
      receivedSignal = opts.signal; entered(); await hold; return {removed: false, attemptId: 'attempt-1'};
    }}});
  const first = open();
  const grant = await first.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude',
    model: 'claude-haiku-5-5', job: {requirements: {limits: {wall_seconds: 60}},
      expires_at: new Date(NOW + 3600000).toISOString()}, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await first.adapter.close();
  const second = open(); const recovery = second.adapter.recover(); await entry;
  const closing = second.adapter.close();
  let timer;
  const outcome = await Promise.race([closing.then(() => 'closed'), new Promise(resolve => {
    timer = setTimeout(() => resolve('blocked'), 200);
  })]);
  clearTimeout(timer); unblock(); await recovery; await closing;
  fs.rmSync(directory, {recursive: true, force: true});
  console.log(JSON.stringify({probe: 'production-recovery', signalPassed: receivedSignal !== undefined, outcome}));
  assert.equal(outcome, 'closed', 'default handler and store close need a deadline independent of backend inventory');
});

test('a saved total-spend cap below one worst-case Haiku call holds before run or metering', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const backend = meteringSandbox(f.root, {source, tokens: {input: 1200, output: 300}, cost_usd: 2.5, model: 'claude-haiku-5-5'});
  const adapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
    harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
  const {owner, lender, circle} = await f.connect({backend, adapters, shutdownProofMs: 500,
    lendingPace50: {source, account_week_id: WEEK}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60,
    maxWallSeconds: 1200, idleOnly: false, lendingPolicy: {protectionPosition: 'balanced',
      providerConsent: {claude: true}, accountPlans: {claude: 'max20'}}}});
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {maxJobUsd: 1,
    reason: 'one dollar cannot cover a worst-case call'}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic budget regression probe.', harness: 'claude-code-subscription'}});
  // The owner cap bounds total spend. Since it is below the model's $1.32 worst call,
  // the objective holds with budget_too_small before any reservation or provider work.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const status = await api(lender.app, '/api/lending');
  const claude = status.objective.accounts.find(account => account.provider === 'claude');
  assert.equal(claude.decision.objective.reasonCode, 'budget_too_small', JSON.stringify(claude.decision));
  assert.equal(claude.decision.objective.maximumExposureUsd, 1);
  assert.equal(claude.decision.objective.nativeMaxBudgetUsd, 0);
  assert.equal(backend.calls.some(([kind]) => kind === 'run'), false, 'no run was started under the total-spend cap');
  assert.equal(backend.meters.length, 0, 'nothing was metered');
  assert.equal(source.state.used.weekly, 20000000, 'no provider usage moved');
});
