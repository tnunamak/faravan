import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate, currentFor, declineCodeFor} from '../lib/v1/lender-pace50.mjs';
import {createRealPace50Source, standingStopEvidence} from './helpers/real-source.mjs';
import {admissionRefreshClass, createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {NOW, HOUR_MS} from './helpers/pace50-fixtures.mjs';

// Real candidate/source/readings/probe/ledger; provider transport, host proofs,
// calibration and owner-demand inputs are fixtures. No sandbox or agent runs.
async function replay(t, variant = 'usable', recover = false, outcome = 'cancelled', order = 'before', subscribers = 1, change = null) {
  // Adapter lock retries use unreferenced timers; keep the test alive through cleanup.
  const keepAlive = setInterval(() => {}, 1000);
  const directory = fs.mkdtempSync(join(homedir(), '.tmp', 'admission-cancel-'));
  let plan = 'pro', controlTag = 0;
  let at = NOW, block = false, entered, probeSignal, failure = null, duringSample = null;
  const started = new Promise(resolve => {entered = resolve;});
  const identity = {status:200, account_sha256_16:'1111222233334444', email_sha256_16:'aaaabbbbccccdddd'};
  const executor = {backend_id:'docker-sbx', sbx_version:'sbx version v0.49.2'};
  const ledger = createLendingLedger({file:join(directory, 'ledger.json'), now:() => at});
  const recordReadings = ledger.recordReadings.bind(ledger);
  const probe = createLendingProbe({ledger, now:() => at, runGuest:async ({signal}) => {
    if (failure === 'rejected') {
      ledger.recordReadings = () => { throw new Error('local ledger failure'); };
      failure = null; block = false;
    }
    if (failure) {
      if (failure === 'history_write_failed') return {probe_failure:'guest_failed'};
      if (failure === 'crash') throw new Error('local probe crash');
      if (failure === 'network_error') return {stdout:JSON.stringify({faravan_probe:1, status:-1, failure_class:'network_error'})};
      if (failure === 'auth') return {stdout:JSON.stringify({faravan_probe:1, status:401})};
      if (failure === 'unknown') return {stdout:'unrecognized provider reply'};
      return {probe_failure:failure};
    }
    if (block) {
      probeSignal = signal;
      entered();
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
      throw signal.reason;
    }
    return {stdout:JSON.stringify({faravan_probe:1, status:200, identity, body:{plan_type:plan, spend_control:{reached:false},
      rate_limit:{allowed:true, limit_reached:false, primary_window:{used_percent:1,
        limit_window_seconds:604800, reset_at:(NOW + 72 * HOUR_MS) / 1000}}}}),
      executor, stop:{delivered:true, fallback:null, latency_ms:1, removed:true}};
  }});
  const readings = createLendingReadings({ledger, probe, now:() => at, plans:() => ({codex:'pro'})});
  const cached = readings.cached.bind(readings);
  readings.cached = provider => {
    const snapshot = cached(provider);
    return failure === 'history_write_failed' ? {...snapshot, latest_attempt:{outcome:'failed', reason:failure}} : snapshot;
  };
  const source = createRealPace50Source({readings, funding:async p => { if (duringSample) { const run = duringSample; duringSample = null; await run(); } return probe.funding(p); },
    expectedIdentity:() => ({email_sha256_16:identity.email_sha256_16}), expectedExecutor:{backend_id:executor.backend_id, accepts:v => v === executor.sbx_version},
    stopEvidence:standingStopEvidence({backend_id:executor.backend_id, accepts:v => v === executor.sbx_version}, {measured_at:NOW, version:executor.sbx_version}),
    stopBoundMs:60_000, kappaForUsage:() => ({binding:{account_sha256_16:identity.account_sha256_16},
      upper_micro:200_000, lower_micro:200_000})});
  let preStartSignal;
  const observe = source.observe.bind(source);
  source.observe = args => {
    if (args.excludingAttemptId === 'race') preStartSignal = args.signal;
    return observe(args);
  };
  const fixture = createSyntheticPace50Source({start:NOW});
  const {candidate, adapter} = createPace50Candidate({directory:join(directory,'candidate'), source,
    now:() => at, account:'synthetic', account_week_id:'synthetic-week',
    contextFor:() => ({controlTag}),
    objectiveInputFor:async args => {
      const out = await fixture.objectiveInputFor(args);
      if (change === 'builder-auth' && candidate.registry.entry('race').liveCheck) {
        failure = 'auth'; await probe.probe('codex');
      }
      return out;
    }});
  t.after(async () => {
    try {
      await candidate.cancelObservations();
      await probe.close();
      await adapter.close();
      fs.rmSync(directory, {recursive:true, force:true});
    } finally { clearInterval(keepAlive); }
  });
  assert.equal((await probe.probe('codex')).ok, true);
  const saved = readings.cached('codex');
  const job = {requirements:{limits:{wall_seconds:300}}, budget_v1:{max_list_usd:2},
    expires_at:new Date(NOW + 86400e3).toISOString()};
  const args = {jobId:'first', job, provider:'codex', model:'gpt-6-sol', automatic:true, ownerAbsent:true};
  {
    failure = outcome;
    await probe.probe('codex').catch(error => { if (outcome !== 'rejected') throw error; });
    ledger.recordReadings = recordReadings;
    const first = await candidate.preview(args);
    assert.equal(first.admitted, !['auth', 'unknown'].includes(outcome), JSON.stringify(first));
    if (['auth', 'unknown'].includes(outcome)) {
      assert.equal(first.reason, 'refresh_failed');
      assert.equal(declineCodeFor(first.reason), 'refresh_failed');
    } else assert.equal(first.reason, 'objective_lend');
    if (['auth', 'unknown'].includes(outcome)) {
      failure = 'cancelled';
      await probe.probe('codex');
      const stillInvalid = await candidate.preview(args);
      assert.equal(stillInvalid.admitted, false);
      assert.equal(stillInvalid.reason, 'refresh_failed');
    }
    if (variant === 'stale') {
      at += 365 * 24 * HOUR_MS;
      assert.equal((await candidate.preview(args)).admitted, false, 'first check rejects exhausted windows');
      at = NOW;
    }
    failure = null;
    await probe.probe('codex');
  }
  block = true;
  const pending = candidate.refreshObservation({provider:'codex', forceRefresh:true, now:at});
  await started;
  const second = subscribers > 1 ? candidate.refreshObservation({provider:'codex', forceRefresh:true, now:at}) : null;
  assert.equal(probe.inFlight('codex'), true);
  const grant = await candidate.reserve({attemptId:'race', jobId:'race', provider:'codex', model:'gpt-6-sol',
    automatic:true, ownerAbsent:true, job:{requirements:{limits:{wall_seconds:300}},
      budget_v1:{max_list_usd:2}, expires_at:new Date(NOW + 86400e3).toISOString()}});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  // Only reserve invalidates this shared observation.
  await pending;
  assert.equal(probeSignal.aborted, true);
  assert.equal(probe.lastResult('codex').reason, 'cancelled');
  assert.deepEqual(readings.cached('codex').windows, saved.windows);
  assert.equal(readings.cached('codex').probe, undefined);
  assert.equal(readings.cached('codex').latest_attempt.reason, 'cancelled');
  if (second) await second;
  const observation = await source.observe({provider:'codex', model:'gpt-6-sol', admissionOnly:true});
  assert.equal(observation.refresh_succeeded, true, 'saved windows survive the cancelled refresh');
  {
    const inject = async () => {
      failure = outcome;
      await probe.probe('codex').catch(error => { if (outcome !== 'rejected') throw error; });
      ledger.recordReadings = recordReadings;
    };
    if (order === 'after') duringSample = inject;
    else await inject();
  }
  if (recover) {
    failure = null;
    block = false;
    assert.equal((await probe.probe('codex')).ok, true);
  }
  if (variant === 'stale') at += 365 * 24 * HOUR_MS;
  if (variant === 'uncovered') {
    ledger.recordReadings('codex', saved.windows.map(w => ({...w, used_pct:100})));
  }
  if (variant === 'stale') assert.equal(currentFor(observation, at), false, 'age reserve exhausts saved headroom');
  let passes = 0;
  const newer = async () => {
    failure = null; block = false;
    if (change === 'account') identity.account_sha256_16 = '5555666677778888';
    if (change === 'plan') plan = 'plus';
    await probe.probe('codex');
  };
  if (change === 'before') duringSample = newer;
  const preview = adapter.preview.bind(adapter);
  adapter.preview = async args => {
    passes++;
    const out = await preview(args);
    if (change === 'preview-headroom') at += 365 * 24 * HOUR_MS;
    if (change === 'preview-auth') { failure = 'auth'; await probe.probe('codex'); }
    if (['after', 'account', 'plan'].includes(change) && passes === 1) await newer();
    if (change === 'controls' && passes === 1) controlTag++;
    if (change === 'revision' || change === 'churn') {
      if (passes === 1 || change === 'churn') {
        block = false; failure = null;
        const rate = {id:'other-job-window', instance:'other', epoch:'other', anchor_at:NOW - 1000,
          resets_at:NOW + HOUR_MS, kappa_micro:1, used_micro:1};
        for (const type of ['meter_feedback', 'meter_feedback_covered']) {
          const result = await adapter.transition({type, event_id:`${type}:${passes}`, at, observed_at:at,
            account:adapter.state().account, resources:[rate], complete:true, refresh_succeeded:true},
            {expectedRevision:adapter.state().revision});
          assert.equal(result.applied, true, JSON.stringify(result));
        }
      }
    }
    return out;
  };
  if (change === 'builder-auth') {
    const held = await candidate.preview(args);
    assert.equal(held.reason, 'refresh_failed', 'the builder final evidence check sees invalidation during its await');
  }
  if (change === 'missing-baseline') candidate.registry.entry('race').liveCheck.baseline = null;
  const result = await candidate.admitStart('race');
  const decision = candidate.lastJobDecisionFor('codex');
  if (variant === 'uncovered') {
    const first = await candidate.preview(args);
    assert.equal(first.admitted, false);
    assert.equal(first.reason, 'owner_reserve');
  }
  if (change === 'churn') assert.equal(passes, 3);
  if (['after', 'revision', 'controls'].includes(change)) assert.equal(passes, 2);
  if (change !== 'missing-baseline') assert.equal(preStartSignal?.aborted, false, 'pre-start inherits cancelled detail without its own signal being aborted');
  return {result, decision};
}

for (const order of ['before', 'after']) {
  for (const outcome of ['cancelled', 'timeout', 'network_error', 'auth', 'unknown']) {
    test(`${outcome} refresh ${order} pre-start sample uses the same evidence rule at both checks`, async t => {
      const {result, decision} = await replay(t, 'usable', false, outcome, order, 2);
      if (['cancelled', 'timeout', 'network_error'].includes(outcome)) assert.deepEqual(result, {ok:true});
      else {
        assert.deepEqual(result, {ok:false, reason:'refresh_failed'});
        assert.equal(decision.reason, 'refresh_failed');
      }
    });
  }
}
for (const variant of ['stale', 'uncovered']) {
  test(`cancelled refresh: ${variant} saved windows refuse`, async t => {
    const {result, decision} = await replay(t, variant);
    // Stale saved windows outlive the stop proof of the probe that wrote them, so that proof refuses first.
    const reason = variant === 'stale' ? 'stop_bound_unknown' : 'budget_too_small';
    assert.deepEqual(result, {ok:false, reason:variant === 'stale' ? 'stop_bound_unknown' : 'quota_reserve'});
    assert.equal(decision.reason, reason);
  });
}

for (const variant of ['usable', 'stale', 'uncovered']) {
  test(`control: successful refresh before pre-start checks ${variant} saved windows`, async t => {
    const {result, decision} = await replay(t, variant, true);
    assert.equal(result.ok, variant === 'usable', JSON.stringify({result, decision}));
    if (variant !== 'usable') {
      assert.notEqual(decision.reason, 'cancelled');
      assert.notEqual(result.reason, 'quota_unknown');
    }
  });
}

test('unknown attempt reasons fail closed; cancellation cannot clear invalidation', () => {
  assert.equal(admissionRefreshClass({outcome:'failed', reason:'future_provider_reason'}), 'invalidating');
  assert.equal(admissionRefreshClass({outcome:'good', reason:'identity_failed'}), 'invalidating');
});

for (const outcome of ['guest_failed', 'sandbox_start_failed', 'probe_unavailable', 'history_write_failed', 'crash', 'rejected']) {
  for (const variant of ['usable', 'stale', 'uncovered']) {
    test(`${outcome}: both checks enforce ${variant} saved windows`, async t => {
      const {result} = await replay(t, variant, false, outcome);
      assert.equal(result.ok, variant === 'usable', JSON.stringify(result));
    });
  }
}
for (const change of ['before', 'after', 'revision', 'controls', 'account', 'plan', 'churn']) {
  test(`pre-start re-evaluates ${change} inputs`, async t => {
    const {result, decision} = await replay(t, 'usable', false, 'cancelled', 'before', 1, change);
    assert.equal(result.ok, ['before', 'after', 'revision', 'controls'].includes(change), JSON.stringify({result, decision}));
    if (['account', 'plan'].includes(change)) assert.equal(decision.reason, 'job_epoch_incompatible');
    if (change === 'churn') assert.equal(decision.reason, 'controls');
  });
}

for (const change of ['preview-auth', 'builder-auth', 'missing-baseline']) {
  test(`pre-start refuses ${change}`, async t => {
    const {result, decision} = await replay(t, 'usable', false, 'cancelled', 'before', 1, change);
    const reason = change === 'missing-baseline' ? 'job_epoch_incompatible' : 'refresh_failed';
    assert.equal(decision.reason, reason);
    assert.equal(result.ok, false);
    assert.equal(result.reason, declineCodeFor(reason));
  });
}

test('pre-start refuses headroom exhausted after an admitted preview', async t => {
  const {result, decision} = await replay(t, 'usable', false, 'cancelled', 'before', 1, 'preview-headroom');
  // The clock moves a year during the preview, so the sampled stop proof has expired too, and it refuses first.
  assert.deepEqual(result, {ok:false, reason:'stop_bound_unknown'});
  assert.equal(decision.reason, 'stop_bound_unknown');
});
