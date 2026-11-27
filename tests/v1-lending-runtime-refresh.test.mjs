import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lendingStatusLines} from '../lib/v1/status.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';

const T = Date.parse('2026-11-02T12:00:00Z');
const drain = async () => {for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));};

for (const [code, expected] of [
  ['usage_credential_unavailable', 'usage_credential_unavailable'],
  ['synthetic_unlisted_reason', undefined],
]) test(`Codex probe exposes only an allowlisted host diagnostic (${code})`, async t => {
  const ledger = {snapshot: () => ({read_at:null, windows:[]})};
  const probe = createLendingProbe({ledger, now:() => T, runGuest:async () => {
    throw Object.assign(new Error('private synthetic detail must not escape'), {
      probe_failure:'probe_unavailable', code,
    });
  }});
  t.after(() => probe.close());
  const readings = createLendingReadings({ledger, probe, now:() => T});
  const source = createRealPace50Source({readings});
  const observation = await source.observe({provider:'codex', forceRefresh:true});
  assert.equal(observation.refresh_succeeded, false);
  assert.equal(observation.complete, false);
  assert.deepEqual(observation.resources, []);
  assert.equal(observation.probe.reason, 'probe_unavailable');
  assert.equal(observation.probe.failure_class, 'probe_unavailable');
  assert.equal(observation.probe.cause_code, expected);
  assert.equal(Object.hasOwn(observation.probe, 'cause_code'), expected !== undefined);
  assert.ok(!JSON.stringify(observation).includes('private synthetic detail'));
});

for (const provider of ['claude', 'codex']) test(`${provider} idle lending refreshes on cadence, honors backoff, and stops refreshing when off`, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const directory = fs.mkdtempSync(join(tmpdir(), 'runtime-refresh-'));
  let at = T, calls = 0;
  const harness = provider === 'claude' ? 'claude-code-subscription' : 'codex';
  const settings = {enabled:true, intent:'on', agents:{[harness]:true}, lendingAuth:{[harness]:true},
    limits:{lendingPolicy:{accountPlans:{[provider]:'unknown'}}}};
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => at});
  const probe = createLendingProbe({ledger, now:() => at, runGuest:async () => {
    calls++;
    return {stdout:JSON.stringify({faravan_probe:1, status:calls === 1 ? 200 : 429,
      body:provider === 'claude' ? {seven_day:{utilization:14, resets_at:new Date(T + 7 * 86400e3).toISOString()}, extra_usage:{is_enabled:false}}
        : {rate_limit:{allowed:true, limit_reached:false, primary_window:{used_percent:14, limit_window_seconds:604800, reset_at:(T + 7 * 86400e3) / 1000}}, credits:{has_credits:false}, plan_type:'pro'},
      identity:{status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'},
      guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'}})};
  }});
  const readings = createLendingReadings({ledger, probe, now:() => at});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'})});
  const runtime = createLendingRuntime({directory, backend:{}, settings:() => settings, presence:async () => false,
    now:() => at, pace50:{source, account:'runtime-refresh', account_week_id:'runtime-refresh-week'}});
  t.after(async () => {await runtime.close(); await probe.close(); fs.rmSync(directory, {recursive:true, force:true});});
  await probe.probe(provider); // Seed the cache as app startup already does.
  assert.equal(calls, 1);
  runtime.start();
  const tickAt = async time => {at = time; t.mock.timers.tick(30_000); await drain();};
  await tickAt(T + 14 * 60_000);
  assert.equal(calls, 1, 'not due before the ordinary cadence');
  await tickAt(T + 16 * 60_000);
  assert.equal(calls, 2, 'exactly one scheduled refresh after sixteen idle minutes');
  const backoffUntil = probe.backoffUntil(provider);
  assert.equal(backoffUntil, at + 5 * 60_000);
  for (const time of [at + 30_000, backoffUntil - 1]) await tickAt(time);
  assert.equal(calls, 2, 'ticks inside provider backoff make no requests');
  settings.enabled = false;
  await tickAt(T + 60 * 60_000);
  assert.equal(calls, 2, 'lending off makes no requests even when due');
  settings.enabled = true;
  await tickAt(T + 61 * 60_000);
  assert.equal(calls, 3, 'lending resumes ordinary refresh after backoff and cadence');
});

// Money review r2: a run that throws (no sandbox) used to leave the cadence unset, so the tick probed every 30 s.
for (const authorized of [true, false]) test(`a probe that throws keeps the refresh cadence (lending sign-in ${authorized ? 'on' : 'off'})`, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const directory = fs.mkdtempSync(join(tmpdir(), 'runtime-refresh-fail-'));
  let at = T, calls = 0;
  const settings = {enabled:true, intent:'on', agents:{codex:true}, lendingAuth:{codex:authorized},
    limits:{lendingPolicy:{accountPlans:{codex:'unknown'}}}};
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => at});
  const probe = createLendingProbe({ledger, now:() => at, runGuest:async () => {
    calls++;
    throw Object.assign(new Error('no sandbox'), {probe_failure:'sandbox_start_failed'});
  }});
  const readings = createLendingReadings({ledger, probe, now:() => at});
  const source = createRealPace50Source({readings, funding:p => probe.funding(p),
    expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'})});
  const runtime = createLendingRuntime({directory, backend:{}, settings:() => settings, presence:async () => false,
    now:() => at, pace50:{source, account:'runtime-refresh', account_week_id:'runtime-refresh-week'}});
  t.after(async () => {await runtime.close(); await probe.close(); fs.rmSync(directory, {recursive:true, force:true});});
  runtime.start();
  for (let i = 1; i <= 10; i++) {at = T + i * 30_000; t.mock.timers.tick(30_000); await drain();}
  assert.equal(calls, authorized ? 1 : 0, authorized ? 'one failed run in five minutes, not one per tick' : 'no lending sign-in, no refresh');
});

for (const [plan, reached, expected] of [['pro', true, 'limit'], ['unknown', true, 'funding'], [null, false, 'funding'], ['pro', undefined, 'funding']]) {
  test(`Codex usage reply (${plan}, limit ${reached}) keeps its funding hold and explains the cause`, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'codex-limit-copy-'));
    const settings = {enabled:true, intent:'on', agents:{codex:true}, lendingAuth:{codex:true},
      limits:{lendingPolicy:{accountPlans:{codex:'unknown'}}}};
    const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => T});
    const probe = createLendingProbe({ledger, now:() => T, runGuest:async () => ({stdout:JSON.stringify({
      faravan_probe:1, status:200, body:{plan_type:plan, rate_limit:{allowed:reached === undefined ? undefined : !reached,
        limit_reached:reached, primary_window:{used_percent:reached ? 100 : 14, limit_window_seconds:604800,
          reset_at:(T + 7 * 86400e3) / 1000}}, spend_control:{reached:false}},
      identity:{status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'},
    })})});
    const readings = createLendingReadings({ledger, probe, now:() => T});
    const source = createRealPace50Source({readings, funding:p => probe.funding(p),
      expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'})});
    const runtime = createLendingRuntime({directory, backend:{}, settings:() => settings, presence:async () => false,
      now:() => T, pace50:{source, account:'codex-copy', account_week_id:'codex-copy-week'}});
    t.after(async () => {await runtime.close(); await probe.close(); fs.rmSync(directory, {recursive:true, force:true});});
    await runtime.candidate.refreshObservation({provider:'codex', plan:'unknown', now:T});
    const before = runtime.candidate.adapter.state();
    const projected = await runtime.candidate.projectStatus({provider:'codex', plan:'unknown', snapshotOnly:true});
    assert.equal(projected.admitted, false);
    assert.equal(projected.reason, 'funding_unknown');
    assert.deepEqual(runtime.candidate.adapter.state(), before, 'the held preview changes no budgets or exposure');
    const view = await runtime.view();
    const cli = lendingStatusLines({enabled:true, objective:view}).join('\n');
    if (expected === 'limit') {
      assert.match(cli, /this account has reached its Codex usage limit/);
      assert.doesNotMatch(cli, /plan and billing/);
    }
    const account = view.accounts.find(row => row.provider === 'codex');
    for (const decision of [account.decision, account.decision.availability]) {
      assert.equal(decision.reason, 'funding_unknown');
      assert.equal(decision.admitted, false);
      assert.equal(decision.status.id, 'funding');
      assert.equal(decision.objective.reasonText, decision.status.line);
      if (expected === 'limit') {
        assert.match(decision.status.line, /this account has reached its Codex usage limit/);
        assert.match(decision.status.line, /when the limit resets/);
        assert.doesNotMatch(decision.status.line, /plan and billing/);
        assert.deepEqual(decision.status.recovery, {who:'automatic', when:'the limit resets'});
      } else {
        assert.match(decision.status.line, /subscription-only funding cannot be confirmed/);
        assert.match(decision.status.line, /plan and billing/);
      }
    }
  });
}

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

for (const measured of [false, true]) test(`real admission cache retains same-run facts after 429 (${measured ? 'measured' : 'default'} rate)`, async t => {
  const {usableAdmissionEvidence} = await import('../lib/v1/lender-pace50.mjs');
  const {createStopEvidenceStore, STOP_EVIDENCE_TTL_MS} = await import('../lib/v1/stop-evidence.mjs');
  const directory = fs.mkdtempSync(join(tmpdir(), 'real-admission-cache-'));
  let at = T, calls = 0, status = 200, fundingOffset = 0;
  // A real ledger rate: 14 points over 24 hours, versus no elapsed sample interval.
  const reset = T + (measured ? 6 : 7) * 86400e3;
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => at});
  const probe = createLendingProbe({ledger, now:() => at, runGuest:async () => {
    calls++;
    return {stdout:JSON.stringify({faravan_probe:1, status, body:{
      plan_type:'pro', rate_limit:{allowed:true, limit_reached:false,
        primary_window:{used_percent:14, limit_window_seconds:604800, reset_at:reset / 1000}},
      // A rate-limit answer alone does not prove the separate spend-control fact.
      spend_control:{reached:false}},
      identity:{status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'}})};
  }});
  t.after(async () => {try {await probe.close();} finally {fs.rmSync(directory, {recursive:true, force:true});}});
  const readings = createLendingReadings({ledger, probe, now:() => at});
  let cachedCalls = 0;
  const cached = readings.cached;
  readings.cached = (...args) => {cachedCalls++; return cached(...args);};
  const binding = {backend_id:'synthetic-cache-host', sbx_version:'test/1'};
  // Independent stop evidence has its own file and clock, never a usage-derived receipt.
  const stops = createStopEvidenceStore({file:join(directory, 'stop-evidence.json'), now:() => at});
  const generation = await stops.begin();
  assert.equal(await stops.succeed(generation, {...binding, measured_at:T,
    stop:{delivered:true, fallback:null, removed:true, latency_ms:1}}), true);
  const source = createRealPace50Source({readings,
    funding:key => {const fact = probe.funding(key); return fact && {...fact, observed_at:fact.observed_at + fundingOffset};},
    expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'}),
    expectedExecutor:{backend_id:binding.backend_id, accepts:version => version === 'test/1'},
    stopBoundMs:60000,
    stopEvidence:async () => {
      const receipt = await stops.current(binding);
      return receipt && {executor:binding, stop:{delivered:receipt.delivered, fallback:receipt.fallback,
        removed:receipt.removed, latency_ms:receipt.latency_ms}, measured_at:receipt.measured_at};
    }});
  const args = {provider:'codex', model:'gpt-6-sol'};
  const request = {wall_ms:1000, stop_ms:60000, uncertainty_ms:30000};
  const successfulRefresh = await source.observe(args);
  assert.equal(successfulRefresh.refresh_succeeded, true);
  assert.equal(probe.funding('codex').codex_plan.limit_reached, false,
    'positive fixture includes both rate-limit and spend-control evidence');
  const first = await source.observe({...args, admissionOnly:true});
  assert.equal(calls, 1);
  assert.equal(first.refresh_succeeded, true);
  assert.equal(first.identity.verified, true);
  assert.equal(first.funding.subscription_only, 'proven');
  assert.equal(first.executor.single_executor, 'proven');
  assert.equal(first.stop.bounded_execution, 'proven');
  assert.equal(first.complete, true);
  assert.equal(first.observed_at, T);
  assert.equal(first.resources.length, 1);
  assert.equal(first.resources[0].observed_at, T);
  assert.equal(first.resources[0].max_rate_pct_per_hour, measured ? 14 / 24 : 0);
  assert.equal(usableAdmissionEvidence(first, request, at), null, 'proof baseline, not final allowance');
  assert.equal(first.latest_attempt.outcome, 'good');
  const evidenceGeneration = first.evidence_generation;
  assert.equal(Number.isSafeInteger(evidenceGeneration), true);

  const empty = await source.observe({...args, accountKey:'synthetic-other-account', admissionOnly:true});
  assert.equal(empty.identity.verified, false);
  assert.equal(empty.refresh_succeeded, false);
  assert.equal(usableAdmissionEvidence(empty, request, at), 'refresh_failed');
  assert.equal(calls, 1, 'an account with no successful reading never borrows the first account');

  fundingOffset = 1;
  const mismatch = await source.observe({...args, admissionOnly:true});
  assert.equal(mismatch.observed_at, null);
  assert.equal(mismatch.funding.subscription_only, 'unknown');
  assert.equal(usableAdmissionEvidence(mismatch, request, at), 'objective_evidence_unknown');
  fundingOffset = 0;
  await drain(); // Join the source's optional cadence-limited refresh request.
  assert.equal(calls, 1);

  at = T + 25 * 60000; status = 429;
  const failed = await source.observe(args);
  assert.equal(calls, 2);
  assert.equal(failed.refresh_succeeded, false);
  assert.equal(failed.resources.length, 0);
  assert.equal(failed.probe.reason, 'rate_limited');
  const attempt = probe.latestAttempt('codex');
  assert.equal(attempt.outcome, 'failed');
  assert.equal(attempt.reason, 'rate_limited');
  assert.equal(attempt.started_at, at);
  assert.equal(attempt.generation > evidenceGeneration, true);
  assert.equal(probe.funding('codex').observed_at, T);
  assert.equal(readings.cached('codex').windows[0].observed_at, T);
  const beforeCalls = calls, beforeCached = cachedCalls;
  const retained = await source.observe({...args, admissionOnly:true});
  assert.equal(calls, beforeCalls, 'admission does not request the provider');
  assert.equal(cachedCalls > beforeCached, true, 'admission delegates to the actual ledger cache');
  assert.equal(retained.refresh_succeeded, true, 'same-run binding does not compare with the wall clock');
  assert.equal(retained.observed_at, T);
  assert.equal(retained.resources[0].observed_at, T);
  assert.equal(retained.evidence_generation, evidenceGeneration);
  assert.deepEqual(retained.latest_attempt, attempt, 'the newest failed attempt is not rewritten as good');
  assert.equal(retained.identity.verified, true);
  assert.equal(retained.funding.subscription_only, 'proven');
  assert.equal(usableAdmissionEvidence(retained, request, at), null,
    'normalized retained facts use the unchanged age estimate for both measured and default rates');
  const {readingAgeReserve} = await import('../lib/v1/lending-reading-age.mjs');
  if (!measured) {
    assert.equal(readingAgeReserve(retained.resources[0], at), 8333334);
    const absentRate = structuredClone(retained);
    delete absentRate.resources[0].max_rate_pct_per_hour;
    assert.equal(readingAgeReserve(absentRate.resources[0], at), 8333334);
    assert.equal(usableAdmissionEvidence(absentRate, request, at), null);
  }
  const again = await source.observe(args);
  assert.equal(again.refresh_succeeded, false);
  assert.equal(again.resources.length, 0);
  assert.equal(again.probe.reason, 'rate_limited');
  assert.equal(calls, beforeCalls, 'provider backoff keeps the real failure, not a successful refresh');
  assert.deepEqual(probe.latestAttempt('codex'), attempt);
  assert.deepEqual(source.admissionEvidence(retained, 'codex').latest_attempt, attempt);

  // The already returned proof has its own deadline, independently of a new
  // source read. Judge it after that deadline without inventing new facts.
  const cutoff = T + STOP_EVIDENCE_TTL_MS;
  assert.equal(retained.stop.proven_until, cutoff);
  if (measured) {
    assert.equal(usableAdmissionEvidence(retained, request, cutoff - 1), null,
      'the measured reading still has headroom immediately before Stop proof expiry');
  }
  assert.equal(usableAdmissionEvidence(retained, request, cutoff), 'stop_bound_unknown',
    'the retained proof expires at the same instant as the store receipt');
  assert.equal(usableAdmissionEvidence(retained, request, cutoff + 1), 'stop_bound_unknown');

  // A fresh observation after expiry receives NO machine receipt. The real
  // source loses BOTH executor and Stop proof; executor is the first refusal.
  at = T + STOP_EVIDENCE_TTL_MS;
  assert.equal(await stops.status(binding), 'expired');
  assert.equal(await stops.current(binding), null);
  const expired = await source.observe({...args, admissionOnly:true});
  assert.equal(expired.refresh_succeeded, true, 'retained account facts still bind to their own reading');
  assert.equal(expired.observed_at, T);
  assert.equal(expired.executor.single_executor, 'unknown');
  assert.equal(expired.executor.reason, 'executor_unobserved');
  assert.equal(expired.stop.bounded_execution, 'unknown');
  assert.equal(expired.stop.reason, 'stop_unobserved');
  assert.equal(expired.stop_bound_ms, null);
  assert.equal(usableAdmissionEvidence(expired, request, at), 'executor_unknown');
  assert.equal(calls, beforeCalls, 'checking receipt expiry requires no provider read');
  assert.deepEqual(expired.latest_attempt, attempt);

  probe.invalidateFacts('synthetic account binding changed');
  assert.equal(probe.funding('codex'), null);
  assert.equal(probe.successfulResult('codex'), null);
  assert.notEqual(probe.evidenceGeneration('codex'), evidenceGeneration);
  const invalidated = await source.observe({...args, admissionOnly:true});
  assert.equal(invalidated.refresh_succeeded, false);
  assert.equal(invalidated.observed_at, null);
  assert.equal(invalidated.identity.verified, false);
  assert.equal(invalidated.funding.subscription_only, 'unknown');
  assert.equal(usableAdmissionEvidence(invalidated, request, at), 'objective_evidence_unknown');
  await drain(); // Join any ordinary refresh requested by missing same-run facts.
  assert.equal(probe.funding('codex'), null, 'a 429 after invalidation cannot restore account authority');
});


test('retained real Stop proof expires exclusively while independently fresh quota remains usable', async t => {
  const {usableAdmissionEvidence, currentFor} = await import('../lib/v1/lender-pace50.mjs');
  const {createStopEvidenceStore, STOP_EVIDENCE_TTL_MS} = await import('../lib/v1/stop-evidence.mjs');
  const directory = fs.mkdtempSync(join(tmpdir(), 'retained-stop-deadline-'));
  let at = T, calls = 0;
  const deadline = T + STOP_EVIDENCE_TTL_MS;
  const quotaAt = deadline - 60_000;
  const reset = quotaAt + 7 * 86400e3;
  const binding = {backend_id:'synthetic-stop-deadline-host', sbx_version:'test/1'};
  const stops = createStopEvidenceStore({file:join(directory, 'stop-evidence.json'), now:() => at});
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => at});
  const probe = createLendingProbe({ledger, now:() => at, runGuest:async () => {
    calls++;
    return {stdout:JSON.stringify({faravan_probe:1, status:200, body:{
      plan_type:'pro', rate_limit:{allowed:true, limit_reached:false,
        primary_window:{used_percent:14, limit_window_seconds:604800, reset_at:reset / 1000}},
      spend_control:{reached:false}},
      identity:{status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'}})};
  }});
  t.after(async () => {try {await probe.close();} finally {fs.rmSync(directory, {recursive:true, force:true});}});
  const generation = await stops.begin();
  assert.equal(await stops.succeed(generation, {...binding, measured_at:T,
    stop:{delivered:true, fallback:null, removed:true, latency_ms:1}}), true);
  const readings = createLendingReadings({ledger, probe, now:() => at});
  const source = createRealPace50Source({readings, funding:key => probe.funding(key),
    expectedIdentity:() => ({email_sha256_16:'aaaabbbbccccdddd'}),
    expectedExecutor:{backend_id:binding.backend_id, accepts:version => version === binding.sbx_version},
    stopBoundMs:60000,
    stopEvidence:async () => {
      const receipt = await stops.current(binding);
      return receipt && {executor:binding, stop:{delivered:receipt.delivered, fallback:receipt.fallback,
        removed:receipt.removed, latency_ms:receipt.latency_ms}, measured_at:receipt.measured_at};
    }});
  // Refresh the quota independently, without renewing the older machine receipt.
  at = quotaAt;
  const args = {provider:'codex', model:'gpt-6-sol'};
  assert.equal((await source.observe(args)).refresh_succeeded, true);
  const retained = await source.observe({...args, admissionOnly:true});
  const request = {wall_ms:1000, stop_ms:60000, uncertainty_ms:30000};
  assert.equal(calls, 1);
  assert.equal(retained.complete, true);
  assert.equal(retained.identity.verified, true);
  assert.equal(retained.funding.subscription_only, 'proven');
  assert.equal(retained.executor.single_executor, 'proven');
  assert.equal(retained.stop.bounded_execution, 'proven');
  assert.equal(retained.stop.proven_until, deadline);
  assert.equal(retained.observed_at, quotaAt);
  assert.ok(retained.resources.length > 0);
  assert.ok(retained.resources.every(resource => resource.observed_at === quotaAt));
  const saved = structuredClone(retained);

  for (const offset of [-1, 0, 1]) {
    at = deadline + offset;
    assert.equal(currentFor(retained, at), true, 'fresh quota headroom is not the refusal');
    assert.ok(retained.resources.every(resource => at + 91_000 < resource.resets_at),
      'every quota reset remains beyond the complete request margin');
    assert.equal(usableAdmissionEvidence(retained, request, at),
      offset < 0 ? null : 'stop_bound_unknown',
      'judge the SAME already-returned proof, including exactly at its exclusive deadline');
    assert.deepEqual(retained, saved, 'judging does not replace or mutate the retained proof');
    assert.equal(await stops.status(binding), offset < 0 ? null : 'expired');
    assert.equal((await stops.current(binding)) !== null, offset < 0);
  }

  const objectiveInputFor=({input})=>{
    const weekly=input.windows.find(row=>row.kind==='weekly'),domain=input.windows.map(row=>row.id+'@decision');
    return {position:'balanced',band:{weekStart:weekly.anchor_at,epoch:'retained-history/1',
      procedure:'retained-history/1',domain,weeks:Array.from({length:19},(_,i)=>({id:'week-'+i,
        end:weekly.anchor_at-(19-i)*7*86400e3,epoch:'retained-history/1',procedure:'retained-history/1',
        complete:true,upperScores:Object.fromEntries(domain.map(id=>[id,0]))})),
      forecasts:input.windows.map(row=>({id:row.id,domain:row.id+'@decision',prediction:0,scale:1}))},
      owner:{scenarios:[{probability:1,attempts:[]}]},laterBurnCapacityMicro:0,
      job:{friendValue:100,estimateUsdMicro:1000000,worstCallUsdMicro:1320000}};
  };
  const {normalizeLendingPolicy} = await import('../lib/v1/lending-policy.mjs');
  const settings = () => ({intent:'on',limits:{lendingPolicy:normalizeLendingPolicy({providerConsent:{codex:true}})}});
  const observe = source.observe;
  // Reserve receives the same observation, not a new Stop read at equality.
  source.observe = input => input.admissionOnly ? Promise.resolve(retained) : observe.call(source, input);
  const job = {requirements:{limits:{wall_seconds:60}},expires_at:new Date(deadline+3600000).toISOString(),
    budget_v1:{max_list_usd:1.5}};
  for (const [offset,attemptId,renew] of [
    [-1,'before-cutoff',false], [0,'at-cutoff',false],
    [1,'after-cutoff',false], [1,'after-recovery',true],
  ]) {
    at = deadline + offset;
    if (renew) {
      const otherExecutor = {...binding, sbx_version:'test/other-executor'};
      const next = await stops.begin();
      assert.equal(await stops.succeed(next, {...otherExecutor, measured_at:at,
        stop:{delivered:true, fallback:null, removed:true, latency_ms:1}}), true);
      assert.equal((await stops.current(otherExecutor))?.measured_at, at);
      assert.equal(await stops.current(binding), null);
      assert.equal(await stops.status(binding), 'changed');
      source.observe = observe;
      const current = await source.observe({...args, admissionOnly:true});
      assert.equal(currentFor(current, at), true);
      assert.equal(current.observed_at, quotaAt);
    }
    const timers = new Set();
    let arms = 0;
    const runtime = createLendingRuntime({directory:join(directory,attemptId),backend:{},settings,
      presence:()=>false,now:()=>at,pace50:{source,account:'retained-device',account_week_id:'retained-device-week',
        objectiveInputFor,nativeGuard:{setTimer(fn,ms){
          arms++;
          const timer={fn,ms,unref(){}};timers.add(timer);return timer;
        },clearTimer:timer=>timers.delete(timer)}}});
    try {
      const before = structuredClone(runtime.pace50.state().attempts);
      assert.equal(before.length,0);
      const reserveInput = {attemptId,jobId:'retained-job',...args,job,automatic:false,ownerAbsent:true};
      if (renew) {
        const refused = await runtime.candidate.reserve(reserveInput);
        assert.equal(refused.ok, false);
        assert.equal(refused.policyReason, 'executor_unknown');
        assert.deepEqual(runtime.pace50.state().attempts, before);
        assert.equal(arms, 0);

        const next = await stops.begin();
        assert.equal(await stops.succeed(next, {...binding, measured_at:at,
          stop:{delivered:true, fallback:null, removed:true, latency_ms:1}}), true);
        const fresh = await source.observe({...args, admissionOnly:true});
        assert.equal(fresh.stop.bounded_execution, 'proven');
        assert.equal(fresh.stop.proven_until, at + STOP_EVIDENCE_TTL_MS);
        assert.equal(fresh.observed_at, quotaAt, 'recovery preserves the independently saved quota');
        assert.equal(calls, 1, 'new Stop evidence did not fetch quota');
      }
      const grant = await runtime.candidate.reserve(reserveInput);
      if (offset < 0 || renew) {
        assert.equal(grant.ok,true,JSON.stringify(grant));
        assert.equal(runtime.pace50.state().attempts.length,1);
        const recorded=runtime.pace50.state().attempts.find(row=>row.id===attemptId);
        assert.ok(recorded?.resources.length,'public reserve has a recorded reservation');
        assert.ok(recorded.resources.every(row=>row.initial_micro>0&&row.held_micro>0));
      } else {
        assert.equal(grant.ok,false);
        assert.equal(grant.policyReason,'stop_bound_unknown');
        assert.deepEqual(runtime.pace50.state().attempts,before);
        assert.equal(arms,0,'refusal did not arm a new native guard');
      }
      assert.deepEqual(retained,saved,'reserve decisions do not mutate the original retained evidence');
    } finally {
      runtime.candidate.nativeGuard.unwatch(attemptId);
      await runtime.close();
      timers.clear();
    }
  }
  assert.equal(calls, 1, 'recovered public reserve does not fetch quota again');

  // Keep the successor proof duration real, but refresh quota just before its cutoff.
  // The single refreshed quota read is a positive control, not part of either reserve.
  const successor = await stops.current(binding);
  assert.ok(successor && successor.generation > generation);
  const successorDeadline = successor.measured_at + STOP_EVIDENCE_TTL_MS;
  at = successorDeadline - 60_000;
  assert.equal((await source.observe(args)).refresh_succeeded,true);
  const renewed = await source.observe({...args,admissionOnly:true});
  assert.equal(renewed.stop.bounded_execution,'proven');
  assert.equal(renewed.stop.proven_until,successorDeadline);
  assert.equal(renewed.observed_at,at);
  const renewedSaved = structuredClone(renewed), probeCount = calls;
  assert.equal(probeCount,2);
  const successorJob = {...job,expires_at:new Date(successorDeadline+3600000).toISOString()};
  // Independent control: this runtime receives fresh observations from the real
  // source on both sides of the cutoff, not either cached snapshot above.
  source.observe = observe;
  const timers = new Set();
  let arms = 0;
  const realBeforeId = 'real-source-before-cutoff';
  const realAtId = 'real-source-at-cutoff';
  at = successorDeadline - 1;
  const runtime = createLendingRuntime({directory:join(directory,'real-source-cutoff'),backend:{},settings,
    presence:()=>false,now:()=>at,pace50:{source,account:'retained-device',account_week_id:'retained-device-week',
      objectiveInputFor,nativeGuard:{setTimer(fn,ms){
        arms++;
        const timer={fn,ms,unref(){}};timers.add(timer);return timer;
      },clearTimer:timer=>timers.delete(timer)}}});
  try {
    assert.equal(currentFor(renewed,at),true);
    assert.ok(renewed.resources.length > 0 && renewed.resources.every(row => row.resets_at > at+91_000));
    const before = await runtime.candidate.reserve({attemptId:realBeforeId,jobId:realBeforeId,
      ...args,job:successorJob,automatic:false,ownerAbsent:true});
    assert.equal(before.ok,true,JSON.stringify(before));
    const held = structuredClone(runtime.pace50.state().attempts);
    assert.deepEqual(held.map(row=>row.id),[realBeforeId]);
    assert.ok(held[0].resources.length > 0);
    assert.ok(held[0].resources.every(row=>row.initial_micro>0 && row.held_micro>0));
    assert.equal(arms,1);

    at = successorDeadline;
    const expired = await source.observe({...args,admissionOnly:true});
    assert.equal(currentFor(expired,at),true,'the quota is independently current at equality');
    assert.equal(expired.observed_at,renewedSaved.observed_at);
    assert.deepEqual(expired.resources.map(row=>[row.observed_at,row.resets_at,row.max_rate_pct_per_hour]),
      renewedSaved.resources.map(row=>[row.observed_at,row.resets_at,row.max_rate_pct_per_hour]));
    assert.deepEqual(expired.latest_attempt,renewedSaved.latest_attempt);
    assert.equal(expired.executor.single_executor,'unknown');
    assert.equal(expired.stop.bounded_execution,'unknown');
    const refused = await runtime.candidate.reserve({attemptId:realAtId,jobId:realAtId,
      ...args,job:successorJob,automatic:false,ownerAbsent:true});
    assert.equal(refused.ok,false);
    assert.equal(refused.policyReason,'executor_unknown');
    assert.deepEqual(runtime.pace50.state().attempts,held,'the exact pre-cutoff hold survives refusal');
    assert.equal(arms,1,'refusal does not arm another native guard');
    assert.equal(calls,probeCount,'neither real-source reserve triggers an additional quota probe');
    assert.deepEqual(renewed,renewedSaved);
  } finally {
    runtime.candidate.nativeGuard.unwatch(realBeforeId);
    runtime.candidate.nativeGuard.unwatch(realAtId);
    await runtime.close();
    timers.clear();
  }
});

for (const refreshed of [true, false]) test(`Codex retained refresh failure retries on the next offer (refresh success: ${refreshed})`, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'retained-offer-recovery-'));
  let at = T, recovering = false, reads = 0, requested;
  const retained = {refresh_succeeded:false, complete:false, resources:[{id:'weekly', observed_at:T}]};
  const renewed = {...retained, refresh_succeeded:refreshed, complete:refreshed,
    resources:[{id:'weekly', observed_at:refreshed ? T + 70 * 60_000 : T}]};
  const fakeRead = Promise.withResolvers();
  const source = {kind:'real', async observe(input) {
    if (!recovering) return retained;
    reads++;
    requested = input;
    return fakeRead.promise;
  }};
  const {candidate, adapter} = createPace50Candidate({directory, account:'retained-fixture', account_week_id:'fixture-week',
    source, now:()=>at, pendingReadingWaitMs:2_000});
  t.after(async () => {fakeRead.resolve(renewed); await candidate.cancelObservations();
    await adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const args = {provider:'codex', accountKey:'fixture-account', model:'fixture-model'};
  at += 70 * 60_000;
  await candidate.refreshObservation({...args, now:at});
  // The injected policy result stands in for ordinary preview evaluation, not for the recovery reader.
  const assessed = [];
  candidate.preview = async input => {
    const reading = candidate.observeSnapshot(input);
    assessed.push(reading?.refresh_succeeded === true);
    return reading?.refresh_succeeded === true ? {admitted:true} : {admitted:false, reason:'refresh_failed'};
  };
  recovering = true;
  const offer = {...args, jobId:'fixture-first', job:{}, offerDeadline:at + 10_000};
  const first = candidate.gate(offer), second = candidate.gate({...offer, jobId:'fixture-second'});
  await drain();
  assert.equal(reads, 1, 'overlapping offers join one read on the account');
  assert.equal(requested.accountKey, args.accountKey);
  assert.equal(requested.forceRefresh, false, 'the reader retains ownership of retry cooldown');
  fakeRead.resolve(renewed);
  assert.deepEqual(await Promise.all([first, second]), refreshed ? [null, null] : ['refresh_failed', 'refresh_failed']);
  assert.deepEqual(assessed, refreshed ? [false, false, true, true] : [false, false]);
});
