import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// The durable objective decision supplies total exposure; the native guard receives that total less one worst-case call.
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const headroomFor = claudeCallHeadroomUsd;
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};
const settingsOn = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({
  providerConsent: {claude: true}, accountPlans: {claude: 'max20'},
})}});

function sourceFor(start, options = {}) {
  const source = createSyntheticPace50Source({start, ...options});
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    const input = objectiveInputFor(args);
    input.job.worstCallUsdMicro = Math.round(headroomFor(args.request.model) * 1_000_000);
    return input;
  };
  return source;
}

function candidate(t, {ownerCapUsd = null, native = false, strategy = null} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-cap-'));
  let nextShort = null;
  const source = sourceFor(NOW, native ? {override: ({base}) => ({...base, resources: base.resources.map(r => ({...r,
    conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null,
    ...(r.kind === 'short' && nextShort !== null ? {instance:'next-short', anchor_at:nextShort, resets_at:nextShort+5*3600e3} : {})}))})} : {});
  if(strategy) {
    const build=source.objectiveInputFor;
    source.objectiveInputFor=args=>({...build(args), ...strategy});
  }
  const ownerSettings = ownerCapUsd === null ? null : {limit: () => ({state: 'set', maxJobUsd: ownerCapUsd})};
  const clock = {at: NOW};
  const opened = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source, ownerSettings});
  t.after(async () => {
    await opened.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {...opened, clock, source, nextShort: at => {nextShort=at;}};
}
const reserve = (pace, model, provider = 'claude') => pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1',
  provider, model, job, automatic: true, ownerAbsent: true});

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: (event) => { f.events.push(event); }});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch((error) => { failure = error; });
  f.stop = async () => {
    controller.abort();
    await settled;
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
}

test('the objective total exposure is reduced by one worst-call headroom for the native cap', {timeout: 30000}, async (t) => {
  const pace = candidate(t);
  const grant = await reserve(pace, HAIKU);
  assert.equal(grant.ok, true);
  const decision = pace.candidate.decisionFor('claude').objective;
  assert.equal(grant.maxBudgetUsd, decision.nativeMaxBudgetUsd);
  assert.ok(grant.maxBudgetUsd > 0, 'the cap is a positive USD budget');
  assert.ok(Math.abs(grant.maxBudgetUsd + headroomFor(HAIKU) - decision.maximumExposureUsd) <= 1e-9,
    'total exposure is exactly native cap plus one worst-case call');
});

test('an owner total-spend cap below one worst-case call is refused without a reservation', {timeout: 30000}, async (t) => {
  const pace = candidate(t, {ownerCapUsd: 1});
  const grant = await reserve(pace, HAIKU);
  assert.equal(grant.ok, false);
  assert.equal(grant.policyReason, 'budget_too_small');
  assert.equal(grant.reason, 'quota_reserve');
  assert.equal(pace.adapter.state().attempts.length, 0, 'the hold leaves no durable exposure');
});

test('control: a Codex grant has no native cap, because Codex is bounded in credits', {timeout: 30000}, async (t) => {
  const pace = candidate(t);
  const grant = await reserve(pace, 'gpt-6-sol', 'codex');
  assert.equal(grant.ok, true);
  assert.equal(grant.maxBudgetUsd, undefined);
});

test('a second native job is refused immediately after cleanup while both window holds remain', {timeout: 30000}, async t => {
  const pace = candidate(t,{native:true,ownerCapUsd:10,
    strategy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:0,perJobPct:2}}});
  const first = await reserve(pace,HAIKU);
  assert.equal(first.ok,true,JSON.stringify(first));
  await pace.candidate.started('attempt-1',{ok:true});
  await pace.candidate.recordCleanup('attempt-1',{removed:true});
  await pace.candidate.finish({attemptId:'attempt-1',provider:'claude',model:HAIKU,execution:{stdout:''}});

  const held = pace.adapter.state().attempts[0];
  assert.equal(held.hold_closed,false,'cleanup does not release native quota exposure');
  assert.ok(held.resources.every(row=>row.held_micro>0&&row.released_micro===0));
  const second = await pace.candidate.reserve({attemptId:'followup-attempt',jobId:'followup-job',provider:'claude',model:HAIKU,
    job,automatic:true,ownerAbsent:true});
  assert.equal(second.ok,false,'the second job cannot overlap the unresolved native hold');
  assert.ok(['native_attempt_in_flight','quota_reserve'].includes(second.reason),JSON.stringify(second));
});

test('a Claude job runs with the objective-derived native cap in its command', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription',
    mutateJob: (payload) => { payload.requirements.model = {any_of: [HAIKU]}; }});
  f.adapters[0].models = [HAIKU];
  f.policy.userActive = async () => false;
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source: sourceFor(f.clock.now())}});
  // The command the sandbox runs is framed after prepare, so it is read where the fake sandbox starts it.
  const started = [];
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (handle, opts) => { started.push(handle._entrypoint); return start(handle, opts); };
  f.policy.lendingRuntime = runtime;
  launch(f);
  await until(() => f.count('/complete') === 1, 'signed completion through the candidate path');
  await f.stop();
  const command = started.find((c) => c.includes('claude --print'));
  assert.ok(command, 'the Claude command ran');
  const match = /max-budget-usd'?\s+'?([0-9.]+)/.exec(command);
  assert.ok(match, `the Claude command carries --max-budget-usd: ${command}`);
  const cap = Number(match[1]);
  const decision = runtime.candidate.decisionFor('claude').objective;
  assert.equal(cap, decision.nativeMaxBudgetUsd);
  assert.ok(Math.abs(cap + headroomFor(HAIKU) - decision.maximumExposureUsd) <= 1e-9,
    'the command cap leaves one worst-case call inside the objective total exposure');
  await runtime.close();
});

test('a Sonnet job is admitted when objective spare covers its model-specific headroom', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription',
    mutateJob: payload => { payload.requirements.model = {any_of: [SONNET]}; }});
  f.adapters[0].models = [SONNET];
  f.policy.userActive = async () => false;
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source: sourceFor(f.clock.now())}});
  const started = [];
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (handle, opts) => { started.push(handle._entrypoint); return start(handle, opts); };
  f.policy.lendingRuntime = runtime;
  launch(f);
  await until(() => f.count('/complete') === 1, 'the objective-sized Sonnet job completed');
  await f.stop();
  const command = started.find(entry => entry.includes('claude --print'));
  assert.ok(command, 'the Sonnet command ran');
  const match = /max-budget-usd'?\s+'?([0-9.]+)/.exec(command);
  assert.ok(match, `the command carries --max-budget-usd: ${command}`);
  const cap = Number(match[1]);
  const decision = runtime.candidate.decisionFor('claude').objective;
  assert.equal(decision.reasonCode, 'objective_lend');
  assert.equal(cap, decision.nativeMaxBudgetUsd);
  assert.ok(Math.abs(cap + headroomFor(SONNET) - decision.maximumExposureUsd) <= 1e-9,
    'Sonnet uses the same objective exposure rule with its own worst-call headroom');
  await runtime.close();
});

// A native run settles durably, then the process dies before the lender receives that acknowledgement or saves its counters. Its
// journal still names the settlement, and the candidate has closed the same attempt. Each restart must acknowledge that closed
// settlement, refund the 540 s the run did not use from all three ledgers, and clear the journal, without charging the provider again.
test('a lost native settlement acknowledgement recovers on restart, refunds all three ledgers, and never charges again', {timeout: 120000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription',
    mutateJob: (payload) => { payload.requirements.model = {any_of: [HAIKU]}; payload.requirements.limits.wall_seconds = 600; },
    agent: () => f.clock.advance(60000)});
  f.adapters[0].models = [HAIKU];
  f.policy.userActive = async () => false;
  f.policy.maxWallSeconds = 600;
  // The job's own view, read when the lender checks the claimed job after the crash.
  f.override = async (record) => {
    if (record.req.method !== 'GET' || record.route !== '/jobs/' + f.jobDigest.replace(/^sha256:/, '')) return false;
    f.json(record.res, {job_digest: f.jobDigest, state: 'claimed', current_attempt: f.attempt()});
    return true;
  };
  f.policy.standingRules = [{id: 'rule', circle: f.job.payload.circle, people: [f.job.payload.author], agents: ['claude-code-subscription'],
    maxWallSeconds: 600, dailyJobs: 10, weeklyJobs: 70, dailyMinutes: 600, weeklyMinutes: 4200, expiresAt: f.clock.now() + 30 * 86400000}];
  f.backend.reconcilePending = async (pending) => ({attemptId: pending.attemptId, removed: true});
  // Native windows settle from the meter; their charges are not converted from a burn.
  let coverage = null;
  const nativeWindows = ({base}) => ({...base, resources: base.resources.map(r => ({...r, ...(coverage ? {used_micro:coverage[r.id]} : {}), conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null}))});
  const source = sourceFor(f.clock.now(), {override: nativeWindows});
  const open = () => createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(), pace50: {account: ACCOUNT, account_week_id: WEEK, source,
      contextFor: () => ({consent: true, ownerAbsent: true}), ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}}});
  const runtime = open();
  f.policy.lendingRuntime = runtime;
  // The candidate settles durably, then the process is gone: the settlement's acknowledgement never reaches the lender, and nothing
  // after it can be written.
  let crashed = false;
  const finish = runtime.candidate.finish.bind(runtime.candidate);
  runtime.candidate.finish = async (args) => {
    await finish(args);
    coverage = Object.fromEntries(runtime.pace50.state().attempts[0].resources.map(r=>[r.id,r.baseline_used_micro+r.initial_micro]));
    f.clock.advance(120_000);
    await runtime.candidate.probeHeld();
    const outcome = await finish(args);
    crashed = true;
    throw Object.assign(new Error('injected crash after settlement'), {code: 'injected_crash', outcome});
  };
  const write = f.policy.storage.set;
  f.policy.storage.set = async (value) => {
    if (crashed) throw Object.assign(new Error('process crashed'), {code: 'injected_crash'});
    return write(value);
  };
  launch(f);
  await until(() => crashed, 'the candidate settled before the crash', 60000);
  await f.stop().catch((error) => { if (error.code !== 'injected_crash') throw error; });
  await runtime.close();

  const journaled = f.saved().pending;
  assert.ok(journaled?.candidateSettlement, 'the journal still names the settlement');
  assert.equal(journaled.actualUse.ms, 60000, 'the actual use was journaled before the settlement');
  assert.equal(f.saved().milliseconds, 600000, 'before recovery the daily time still holds the full reservation');
  const ruleHold = () => f.saved().ruleUsage.filter((row) => row.id === 'rule').map((row) => row.ms);
  assert.deepEqual(ruleHold(), [600000]);

  const passes = [];
  for (const pass of [1, 2]) {
    f.policy.enabled = false;
    f.policy.storage.set = write;
    const reopened = open();
    f.policy.lendingRuntime = reopened;
    const attempt = () => reopened.pace50.state().attempts.find((row) => row.id === journaled.attemptId);
    const before = attempt().resources.map((r) => r.spent_micro);
    launch(f);
    if (pass === 1) await until(() => f.saved()?.pending === null, 'the first recovery clears the journal', 15000);
    await f.stop();
    const requesterTime = Object.values(f.saved().requesters ?? {}).map((used) => used.milliseconds);
    passes.push({pending: f.saved().pending, daily: f.saved().milliseconds, requester: requesterTime, rule: ruleHold(),
      spent: attempt().resources.map((r) => r.spent_micro), before, holdClosed: attempt().resources.every(r=>r.native_release_used_micro!==undefined)});
    await reopened.close();
  }
  for (const [index, result] of passes.entries()) {
    assert.equal(result.pending, null, `pass ${index + 1}: the journal is cleared`);
    assert.equal(result.daily, 60000, `pass ${index + 1}: the daily ledger holds the 60 s use`);
    assert.deepEqual(result.requester, [60000], `pass ${index + 1}: the requester ledger holds the 60 s use`);
    assert.deepEqual(result.rule, [60000], `pass ${index + 1}: the standing rule holds the 60 s use`);
    assert.equal(result.holdClosed, true, `pass ${index + 1}: the candidate's hold is closed`);
  }
  assert.deepEqual(passes[1].spent, passes[0].spent, 'the second recovery adds no provider charge');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1, 'the job ran once');
});

// A retried settlement is acknowledged only for the attempt that closed it. An absent attempt, a different attempt, or a closed attempt
// that was not settled from its meter is still refused.
test('a retried native settlement is acknowledged only for the attempt it closed', {timeout: 30000}, async (t) => {
  const pace = candidate(t, {native: true, ownerCapUsd: 10,
    strategy:{strategy:'fixed_share', strategyParams:{fixedSharePct:20, keepPct:0, perJobPct:2}}});
  const settlement = {provider: 'claude', model: HAIKU, execution: null, prepared: false, reason: 'done'};
  const open = async (attemptId) => {
    const grant = await pace.candidate.reserve({attemptId, jobId: `job-${attemptId}`, provider: 'claude', model: HAIKU, job:{...job, expires_at:new Date(pace.clock.at+3600e3).toISOString()},
      automatic: true, ownerAbsent: true});
    assert.equal(grant.ok, true, JSON.stringify(grant));
    await pace.candidate.started(attemptId, {ok: true});
    await pace.candidate.recordCleanup(attemptId, {removed: true});
  };
  await open('attempt-1');
  await pace.candidate.settle('attempt-1', settlement);
  for(const r of pace.adapter.state().attempts.at(-1).resources) pace.source.state.used[r.kind]=r.baseline_used_micro+r.initial_micro;
  pace.clock.at += 120_000;
  await pace.candidate.probeHeld();
  const first = await pace.candidate.settle('attempt-1', settlement);
  assert.equal(first.cessation?.applied, true, JSON.stringify(first.cessation));
  const retry = await pace.candidate.settle('attempt-1', settlement);
  assert.deepEqual([retry.cessation?.applied, retry.cessation?.reason], [true, 'already_settled'], JSON.stringify(retry.cessation));
  const refusedAbsent = await pace.candidate.settle('no-such-attempt', settlement);
  assert.equal(refusedAbsent.applied, false, `an absent attempt is refused: ${JSON.stringify(refusedAbsent)}`);
  // The closed attempt's record does not stand in for a sibling: each settlement names its own attempt.
  pace.clock.at=pace.adapter.state().attempts[0].resources.find(r=>r.kind==='short').resets_at+1;
  await pace.candidate.probeHeld();
  pace.nextShort(pace.clock.at);
  pace.source.state.used.short=40_000_000;
  await open('attempt-2');
  const sibling = await pace.candidate.settle('attempt-2', settlement);
  assert.equal(sibling.cessation?.applied, false, JSON.stringify(sibling.cessation));
  assert.equal(sibling.cessation.reason, 'native_usage_held');
  for(const r of pace.adapter.state().attempts.at(-1).resources) pace.source.state.used[r.kind]=r.baseline_used_micro+r.initial_micro;
  pace.clock.at += 120_000;
  await pace.candidate.probeHeld();
  assert.ok(pace.adapter.state().attempts.find(a => a.id === 'attempt-2').resources.every(r=>r.native_release_used_micro!==undefined));
  assert.notEqual(sibling.cessation.reason, 'already_settled', 'attempt-2 was not closed before this settlement');
  assert.ok(pace.adapter.state().attempts.find(a => a.id === 'attempt-1').resources.every(r=>r.held_micro===0));
});


test('a native meter hold clears the lender journal and survives restart until a post-delay host reading arrives', {timeout: 30000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription',
    mutateJob: payload => { payload.requirements.model = {any_of: [HAIKU]}; }});
  f.adapters[0].models = [HAIKU];
  f.policy.userActive = async () => false;
  let unread = false;
  const source = sourceFor(f.clock.now(), {override: ({base}) => ({...base,
    complete: !unread, resources: base.resources.map(r => ({...r,
      conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null}))})});
  const destroy = f.backend.destroy.bind(f.backend);
  f.backend.destroy = async (...args) => { const result = await destroy(...args); unread = true; return result; };
  const open = () => createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source,
      ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}}});
  let runtime = open();
  try {
    f.policy.lendingRuntime = runtime;
    launch(f);
    await until(() => f.count('/complete') === 1, 'the result was delivered');
    await until(() => f.saved()?.pending === null, 'the durable native hold clears the journal', 2000);
    await f.stop();
    const before = runtime.pace50.state().attempts[0];
    assert.equal(before.cleanup_proven, true);
    assert.equal(before.process_state, 'ceased');
    assert.equal(before.hold_closed, false);
    assert.ok(before.resources.every(r => r.held_micro > 0));
    const initial = before.resources.map(r => r.initial_micro);
    await runtime.close();
    runtime = open();
    const row = () => runtime.pace50.state().attempts[0];
    assert.deepEqual(row().resources.map(r => r.held_micro), before.resources.map(r => r.held_micro));
    f.clock.advance(120_000);
    await runtime.candidate.probeHeld();
    assert.equal(row().hold_closed, false, 'an incomplete meter does not release the hold');
    unread = false;
    const grant = await runtime.candidate.reserve({attemptId: 'next-claude', jobId: 'next', provider: 'claude', model: HAIKU,
      job: {...job, expires_at: new Date(f.clock.now() + 3600e3).toISOString()}, ownerAbsent: true});
    assert.equal(grant.ok, false);
    assert.equal(grant.policyReason, 'native_attempt_in_flight', 'the durable hold still protects every reserved point');
    await runtime.candidate.probeHeld();
    assert.equal(row().hold_closed, false, 'an unchanged meter retains exposure after restart');
    assert.deepEqual(row().resources.map(r => r.held_micro + r.unrepresented_micro), initial,
      'a post-delay reading does not reduce the original unresolved envelope');
    assert.ok(row().resources.every(r => r.released_micro === 0 && r.spent_micro >= 1_000_000));
  } finally { await f.stop?.(); await runtime.close(); }
});
