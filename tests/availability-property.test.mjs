import './helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountExecution} from '../lib/v1/account-execution.mjs';
import {sandboxServiceUnavailableHold, deadlineRecoveryError} from '../lib/sandbox-remediation.mjs';
import {decideLending} from '../lib/v1/lending-decision.mjs';
import {appFixture, syntheticBackend, api, waitFor} from './helpers/v1-app-fixture.mjs';

test('C: a timed-out cleanup listing remains a bounded wait', async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  const retryAt = Date.now() + 15_000;
  const held = sandboxServiceUnavailableHold(Object.assign(new Error('Sandbox listing timed out.'), {timedOut:true}), {rowCount:1, retryAt});
  backend.ensureSandboxAdmission = async () => {throw deadlineRecoveryError(held);};
  backend.deadlineRecoveryHold = () => held;
  backend.reapCleanup = async () => {};
  const {app} = await f.start('listing-wait', {backend});
  const status = await api(app, '/api/status');
  assert.equal(status.blockers.some(row => row.kind === 'cessation_unverified'), false);
  assert.equal(status.deadline_recovery.recovery_hold.retry_at_ms, retryAt);
});

test('C: a cleanup listing with no scheduled retry keeps its recovery blocker', async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  const held = sandboxServiceUnavailableHold(new Error('Sandbox listing timed out.'), {rowCount:1});
  backend.ensureSandboxAdmission = async () => {throw deadlineRecoveryError(held);};
  backend.deadlineRecoveryHold = () => held;
  backend.reapCleanup = async () => {};
  const {app} = await f.start('listing-blocked', {backend});
  const status = await api(app, '/api/status');
  assert.ok(status.blockers.some(row => row.kind === 'cessation_unverified'));
  assert.equal(status.deadline_recovery.recovery_hold.retry_at_ms, undefined);
});

test('C: each hard account availability fact gives one specific next action', () => {
  const nowMs = 1_800_000_000_000;
  const accountId = 'fixture-account';
  const baseline = {
    schemaVersion: 1,
    nowMs,
    account: {id:accountId, providerId:'fixture-provider', enabled:true, authState:'signed_in'},
    usage: {accountId, state:'ready', reading:null},
    policy: {enabled:true, revision:1, strategy:'automatic', strategyParams:{}},
    eligibility: {evaluatedAtMs:nowMs, settingsRevision:1, enabledNow:true},
    ledger: {accountId, resources:[]},
    history: {accountId, rows:[]},
    job: null,
    runtime: {canStart:true},
  };
  const cases = [
    [{policy:{...baseline.policy, enabled:false}}, 'lending_off', 'enable_lending'],
    [{runtime:{canStart:false}}, 'sandbox_cannot_start', 'repair_sandbox'],
    [{usage:{...baseline.usage, state:'signed_out'}}, 'account_signed_out', 'sign_in'],
    [{usage:{...baseline.usage, state:'limit', limitResetAtMs:nowMs + 1000}}, 'provider_limit_reached', 'wait_for_reset'],
  ];
  for (const [input, code, action] of cases) {
    const decision = decideLending({...baseline, ...input});
    assert.equal(decision.kind, 'hold', code);
    assert.equal(decision.code, code);
    assert.deepEqual(Object.keys(decision).sort(), ['code','kind','nextAction','schemaVersion']);
    assert.deepEqual(decision.nextAction.target, {accountId});
    assert.equal(decision.nextAction.id, action);
    assert.ok(decision.nextAction.label, code);
  }
});

test('C: joined idle lending retries an inconclusive Docker check without a sign-in prompt', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  const clock = {value:Date.now(), now(){return this.value;}};
  const confirmationTimes = [];
  let observation = 'waiting', starts = 0;
  backend.start = async () => {
    starts++;
    assert.fail('The idle synthetic backend must not start a run');
  };
  const probe = backend.probeCapabilities;
  backend.probeCapabilities = async () => {
    const report = await probe();
    const login = {name:'docker_login', detail:'Synthetic Docker observation'};
    const row = observation === 'refused'
      ? {...login, ok:false, cause:'docker_signed_out'}
      : observation === 'inconclusive'
        ? {...login, ok:true, signinVerified:false}
        : {...login, ok:false, unknown:true};
    return {...report, preflight:{...report.preflight,
      checks:report.preflight.checks.map(check => check.name === 'docker_login' ? row : check)}};
  };
  const summary = backend.protectionSummary;
  backend.protectionSummary = async (...args) => {
    const report = await summary(...args);
    return {...report, observed_at:new Date(clock.now()).toISOString()};
  };
  backend.confirmSignIn = async () => {
    confirmationTimes.push(clock.now());
    return {ok:false, cause:'timeout'};
  };
  backend.signInGeneration = 0;

  const {lender,circle} = await f.connect({backend,clock,readinessCacheMs:0}, {clock});
  await api(lender.app, '/api/lending/on', {method:'POST',body:{circle:circle.id}});

  const observe = async condition => waitFor(async () => {
    const report = await api(lender.app, '/api/readiness');
    return condition(report) ? report : null;
  }, 'synthetic Docker readiness', 20_000);
  observation = 'inconclusive';
  backend.signInGeneration++;
  // Passive reads drive the normal background retry, not the explicit refresh
  // route that would reset the automatic retry budget.
  const waiting = await observe(report =>
    confirmationTimes.length > 0 &&
    report.checks.some(row => row.name === 'docker_login' && row.signinVerified === false));
  assert.deepEqual(confirmationTimes, [clock.now()]);
  assert.ok(waiting.checks.filter(row => row.name !== 'docker_login').every(row => row.ok));
  assert.notEqual(waiting.code, 'docker_signed_out');
  assert.notEqual(waiting.action?.kind, 'docker-signin');

  const retryAt = confirmationTimes[0] + 60_000;
  clock.value = retryAt - 1;
  await observe(report => report.observed_at === new Date(clock.now()).toISOString());
  assert.deepEqual(confirmationTimes, [retryAt - 60_000], 'no retry before the deadline');

  clock.value = retryAt;
  await observe(() => confirmationTimes.length >= 2);
  assert.deepEqual(confirmationTimes, [retryAt - 60_000, retryAt]);

  observation = 'refused';
  backend.signInGeneration++;
  const refusal = await observe(report => report.code === 'docker_signed_out');
  assert.equal(refusal.action?.kind, 'docker-signin');
  assert.equal(refusal.ready, false);
  assert.equal(starts, 0);

  // A successful listing does not itself prove the Docker check is ready.
  assert.equal(waiting.ready, false, 'inconclusive confirmation must not report ready');
});

// Runs the production account-advertisement filter, not a mirrored decision
// reducer. All account facts and transport-adjacent objects are synthetic.
test('C: 1000 seeded soft account mixes preserve lend-or-retry at advertisement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faravan-seeded-availability-'));
  const accountId = 'fixture-available';
  const clock = 1_800_000_000_000;
  const account = {id:accountId, providerId:'fixture-provider', enabled:true, authState:'signed_in'};
  const offered = [{accountId, providerId:account.providerId}];
  const policy = {schemaVersion:1, enabled:true, revision:1, strategy:'automatic',
    strategyParams:{}, protectionPosition:'keep_more_for_me'};
  let usage;
  const execution = createAccountExecution({
    directory, clock:()=>clock, settings:async()=>policy,
    providers:{listProviders:()=>[{nativeUnits:[{id:'tokens',scale:1}]}]},
    store:{get:id=>id === accountId ? structuredClone(account) : null},
    broker:{getAccountUsage:id=>{
      assert.equal(id, accountId);
      return {snapshot:()=>structuredClone(usage)};
    }},
  });
  t.after(async () => {
    try { await execution.close(); }
    finally { rmSync(directory, {recursive:true, force:true}); }
  });

  const seed = 0x54c0dd;
  let state = seed;
  const random = max => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * max);
  };
  for (let i = 0; i < 1000; i++) {
    const cold = i === 0 || random(4) === 0;
    const age = random(30_000);
    const used = random(100) * 1_000_000;
    const observedAtMs = clock - age;
    usage = {schemaVersion:1, accountId, state:'ready', reading:cold ? null : {
      schemaVersion:1, accountId, observationId:`seed-${i}`, sequence:i + 1,
      observedAtMs, receivedAtMs:observedAtMs, postingUncertaintyMs:null,
      windows:[{id:'seven_day',instance:'seven_day:fixture',capacityMicro:100_000_000,
        usedLoMicro:used,usedHiMicro:used,resetsAtMs:clock + 7 * 86_400_000,
        maxOwnerRateMicroPerMs:null}], coverage:{kind:'unknown'},
    }, jobReadings:[], windowHistory:[], limitResetAtMs:null};
    const label = `seed=${seed} case=${i} cold=${cold} age=${age} used=${used}`;
    const decision = await execution.lendability({accountId});
    const visible = await execution.lendableAccounts(offered);
    assert.ok(decision.kind === 'lend' || decision.kind === 'wait', label + ': ' + JSON.stringify(decision));
    assert.deepEqual(visible, decision.kind === 'lend' ? offered : [], label);
    if (decision.kind === 'wait') {
      assert.ok(Number.isSafeInteger(decision.nextEvaluationAtMs) &&
        decision.nextEvaluationAtMs > clock, label + ' must offer a future retry');
    }
    if (cold) {
      assert.equal(decision.kind, 'lend', label + ' can use cold pace');
      assert.ok(decision.amount.byResource.some(resource => resource.amount > 0), label);
    }
  }
});
