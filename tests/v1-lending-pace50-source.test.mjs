import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {certifiedKappa, createRealPace50Source, stopProof, observationProofFailures, paceInputFromObservation, resourcesFromReadings} from '../lib/v1/lending-pace50-source.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {request} from './helpers/pace50-fixtures.mjs';
import {LENT_LABEL} from '../lib/v1/lending-kappa-lent.mjs';

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);
const readingsFor = (now = NOW) => ({windows: [
  {window_id: 'seven_day', window_minutes: 10080, used_pct: 20, resets_at: now + 42 * 3600000, observed_at: now, state: 'open'},
  {window_id: 'five_hour', window_minutes: 300, used_pct: 40, resets_at: now + 1.25 * 3600000, observed_at: now, state: 'open'},
]});
const fullContext = {consent: true, people: true, agents: true, schedule: true, unexpired: true,
  intent: 'on', paused: false, ownerAbsent: true, noUnresolvedExposure: true};

test('readings map exact quota resources and owner usage without deriving a pace allocator input', () => {
  const mapped = resourcesFromReadings(readingsFor().windows);
  assert.equal(mapped.complete, true);
  assert.deepEqual(mapped.resources.map((r) => [r.id, r.kind, r.used_micro, r.duration_ms]),
    [['seven_day', 'weekly', 20000000, 604800000], ['five_hour', 'short', 40000000, 18000000]]);
  assert.equal(mapped.resources[1].anchor_at, NOW + 1.25 * 3600000 - 18000000, 'anchor = reset minus stated length');
  assert.equal(mapped.resources[0].owner_used_micro, 20_000_000);
  const ownerReading = resourcesFromReadings([{...readingsFor().windows[0], owner_used_pct: 3, max_rate_pct_per_hour: .5}]);
  assert.equal(ownerReading.resources[0].owner_used_micro, 3_000_000);
  assert.equal('pace_rate_micro_per_hour' in ownerReading.resources[0], false,
    'demand-model posteriors consume observed owner usage, not a derived rate or trailing multiplier');
  assert.equal(mapped.resources[0].kappa_micro, null, 'no conversion is invented');
  assert.equal(resourcesFromReadings([{window_id: 'model_x', window_minutes: 0, used_pct: 1, resets_at: NOW, observed_at: NOW}]).complete, false);
  assert.equal(resourcesFromReadings([{window_id: 'five_hour', window_minutes: 300, used_pct: 1, resets_at: NOW + 1, observed_at: NOW}]).complete, false,
    'a roster without a weekly window is incomplete');
});

test('only shipped provider-plan-window-model calibration bounds authorize point conversion', () => {
  const weekly = certifiedKappa({provider:'claude', plan:'max20', window:'weekly', model:'claude-haiku-5-5'});
  const fiveHour = certifiedKappa({provider:'claude', plan:'max20', window:'five_hour', model:'claude-haiku-5-5'});
  assert.equal(weekly.upper_micro, 534_900);
  assert.equal(fiveHour.upper_micro, 1_583_100);
  assert.ok(weekly.provenance.boundReport);
  assert.ok(fiveHour.provenance.acceptedBy);
  assert.equal(certifiedKappa({provider:'codex', plan:'pro', window:'weekly', model:'gpt-6-sol'}).upper_micro, 135_700);
  assert.equal(certifiedKappa({provider:'codex', plan:'plus', window:'weekly', model:'gpt-6-sol'}), null, 'an unmeasured plan stays unknown');
  assert.equal(certifiedKappa({provider:'claude', plan:'max20', window:'weekly', model:'unknown'}), null);
});

test('the real source waits for current evidence when no same-run fact exists', async () => {
  const source = createRealPace50Source({readings: async () => readingsFor()});
  const obs = await source.observe({provider: 'claude', now: NOW});
  assert.equal(obs.identity.verified, false);
  assert.equal(obs.funding.subscription_only, 'unknown');
  assert.equal(obs.executor.single_executor, 'unknown');
  assert.equal(obs.stop.bounded_execution, 'unknown');
  assert.equal(paceInputFromObservation(obs, {now: NOW, context: fullContext}).refuse, 'objective_evidence_unknown');
  assert.equal(source.convertUsage({units_micro: 1000000}), null, 'the real conversion is unknown');
});

test('a readings failure is a refresh failure, not an empty roster', async () => {
  const source = createRealPace50Source({readings: async () => { throw new Error('provider unavailable'); }});
  const obs = await source.observe({provider: 'codex', now: NOW});
  assert.equal(paceInputFromObservation(obs, {now: NOW, context: fullContext}).refuse, 'refresh_failed');
});

test('each missing fact is refused by its own name, in order, with the first gap winning', async () => {
  const cases = [
    [{proofs: {identity: false, funding: 'proven', executor: 'proven', stop: 'proven'}}, 'identity_unknown'],
    [{proofs: {identity: true, funding: 'unknown', executor: 'proven', stop: 'proven'}}, 'funding_unknown'],
    [{proofs: {identity: true, funding: 'proven', executor: 'unknown', stop: 'proven'}}, 'executor_unknown'],
    [{proofs: {identity: true, funding: 'proven', executor: 'proven', stop: 'unknown'}}, 'stop_bound_unknown'],
    [{kappa: {weekly: 0, short: 200000}}, 'conversion_unknown'],
  ];
  for (const [options, reason] of cases) {
    const source = createSyntheticPace50Source(options);
    const obs = await source.observe({provider: 'claude', now: NOW});
    assert.equal(paceInputFromObservation(obs, {now: NOW, context: fullContext}).refuse, reason, reason);
  }
  const noEpoch = createSyntheticPace50Source({epoch: ''});
  assert.equal(paceInputFromObservation(await noEpoch.observe({provider: 'claude', now: NOW}), {now: NOW, context: fullContext}).refuse,
    'epoch_unknown');
});

test('caller context cannot supply a provider fact: funding named in context does not satisfy an unknown funding observation', async () => {
  const source = createSyntheticPace50Source({proofs: {identity: true, funding: 'unknown', executor: 'proven', stop: 'proven'}});
  const obs = await source.observe({provider: 'claude', now: NOW});
  const forged = {...fullContext, funding: 'proven', subscription_only: true, identity: {verified: true, account_id: 'x'}};
  assert.equal(paceInputFromObservation(obs, {now: NOW, context: forged}).refuse, 'funding_unknown');
});

test('a synthetic observation with every fact proven maps to a policy input whose controls come from the caller context', async () => {
  const source = createSyntheticPace50Source();
  const obs = await source.observe({provider: 'claude', now: NOW});
  const input = paceInputFromObservation(obs, {now: NOW, context: fullContext});
  assert.equal(input.refuse, undefined);
  assert.deepEqual(input.controls, {consent: true, people: true, agents: true, schedule: true, unexpired: true,
    on: true, paused: false, owner_absent: true});
  assert.deepEqual(input.evidence.resource_ids, ['seven_day', 'five_hour']);
  assert.equal(paceInputFromObservation(obs, {now: NOW, context: {...fullContext, consent: false}}).controls.consent, false);
  const reserved = obs.resources.map(({id, instance, kappa_micro}) => ({id, instance, kappa_micro}));
  assert.deepEqual(source.convertUsage({units_micro: 2000000, resources: reserved}).map((r) => [r.id, r.amount_micro]),
    [['seven_day', 100000], ['five_hour', 400000]]);
});

test('through the adapter: no consent is refused by the policy, unknown identity is refused by the seam, both persist nothing', async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pace50-source-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let calls = 0;
  const effects = {
    arm_cessation_deadline: async () => () => {},
    launch_chunk: async () => { calls += 1; },
    open_short_window: async () => {},
    cancel_pending_attempt: async () => {},
    request_cessation: async () => {},
    request_fresh_complete_reconciliation: async () => {},
  };
  const build = (source) => async ({now, context, state, request}) => {
    const observation = await source.observe({provider: 'claude', model: request?.model, plan: request?.plan, now});
    const input = paceInputFromObservation(observation, {now, context});
    if (!input.refuse && typeof source.objectiveInputFor === 'function')
      input.objective = await source.objectiveInputFor({state, request, now, context, observation, input});
    return input;
  };
  const synthetic = createSyntheticPace50Source();
  const adapter = createPace50Adapter({directory, account: 'synthetic-account', account_week_id: 'synthetic-week-1',
    buildInput: build(synthetic), effects, now: () => NOW});
  const noConsent = await adapter.admit({expectedRevision: 0, request: request(), context: {...fullContext, consent: false}});
  assert.equal(noConsent.reason, 'controls');
  assert.equal(adapter.state().revision, 0);
  assert.equal(calls, 0);
  const admitted = await adapter.admit({expectedRevision: 0, request: request(), context: fullContext});
  assert.equal(admitted.admitted, true, JSON.stringify(admitted.reason));
  assert.equal(calls, 1, 'the synthetic observation, with consent, launches once');
  await adapter.close();

  const real = createRealPace50Source({readings: async () => readingsFor()});
  const realStore = fs.mkdtempSync(join(tmpdir(), 'pace50-source-real-'));
  t.after(() => fs.rmSync(realStore, {recursive: true, force: true}));
  const guarded = createPace50Adapter({directory: realStore, account: 'synthetic-account', account_week_id: 'synthetic-week-1',
    buildInput: build(real), effects, now: () => NOW});
  const unknown = await guarded.admit({expectedRevision: 0, request: request(), context: fullContext});
  assert.equal(unknown.reason, 'objective_evidence_unknown');
  assert.equal(unknown.effects.length, 0);
  assert.equal(guarded.state().revision, 0, 'a refused builder persists nothing');
  assert.equal(calls, 1, 'the refused real observation launches nothing further');
  await guarded.close();
});

test('the observation carries the sanitized failure and HTTP status of the read it came from, and no status when the read threw', async () => {
  // The read's raw statuses cross the boundary only as the closed failure contract: usage_http_<status>. Attempt counts and
  // the identity status do not cross it (batch8a sanitizes at the observation boundary).
  const probe = { reason: 'rate_limited', usage_status: 429, identity_status: 429, usage_attempts: 3, identity_attempts: 1 };
  const failed = createRealPace50Source({ readings: async () => ({ windows: [], probe }) });
  assert.deepEqual((await failed.observe({ provider: 'claude', now: 1 })).probe,
    { reason: 'rate_limited', provider: 'claude', failure_class: 'usage_http_429' });
  const thrown = createRealPace50Source({ readings: async () => { throw new Error('probe failed'); } });
  assert.deepEqual((await thrown.observe({ provider: 'claude', now: 1 })).probe,
    { reason: 'guest_failed', provider: 'claude', failure_class: 'other' },
    'a thrown read names no HTTP status, so the probe has no status or attempt fields');
});

test('one window read with different sub-second reset noise names one instance, so a lent job stays in its window', () => {
  // Live Claude reads of one window on 2026-10-27 gave resets_at fractions from .011 to .921 above the same whole second.
  // Rounding split them into two instances, which stranded a finished job's exposure in a window "no longer offered".
  const reset = Date.UTC(2026, 9, 27, 23, 20, 0);
  const named = [11, 499, 501, 921].map((ms) => resourcesFromReadings([
    {window_id: 'seven_day', window_minutes: 10080, used_pct: 20, resets_at: NOW + 42 * 3600000 + ms, observed_at: NOW, state: 'open'},
    {window_id: 'five_hour', window_minutes: 300, used_pct: 40, resets_at: reset + ms, observed_at: NOW, state: 'open'},
  ]).resources.map((r) => [r.instance, r.anchor_at, r.resets_at].join(' ')));
  assert.equal(new Set(named.map((n) => n.join('|'))).size, 1);
  assert.equal(named[0][1], `five_hour@${reset} ${reset - 18000000} ${reset}`);
});

const ACC='0123456789abcdef', identity={account_sha256_16:ACC,email_sha256_16:'fedcba9876543210'};
const verifiedSource=(kappaForUsage,plan='max20')=>createRealPace50Source({readings:async()=>readingsFor(),
  funding:()=>({observed_at:NOW,identity,codex_plan:{plan_type:plan,limit_reached:false}}),
  expectedIdentity:()=>({account_sha256_16:ACC}),kappaForUsage});
// Was a 'measuring' hold; no history now lends natively (native-window mode), never a hold.
test('no measurement of its own: any plan label converts nothing, invents no rate, and lends in native-window mode', async () => {
  for (const [provider, plan, model] of [['claude','pro','claude-haiku-5-5'], ['claude','max20','claude-haiku-5-5'],
    ['claude','unknown','claude-haiku-5-5'], ['codex','plus','gpt-6-sol'], ['codex','pro','gpt-6-sol'], ['codex','team','gpt-6-sol']]) {
    const asked=[];
    const source=verifiedSource(query=>{asked.push(query);return null;},plan);
    const obs=await source.observe({provider,plan,model});
    assert.equal(obs.identity.verified,true);
    assert.deepEqual(obs.resources.map(r=>r.kappa_micro),[null,null],`${provider} ${plan} has no seed rate`);
    assert.deepEqual(obs.resources.map(r=>r.conversion),['native_window','native_window']);
    assert.equal(obs.calibration_missing,undefined,'no history is not a hold');
    assert.deepEqual(obs.learning,[{reason:'learning',provider,window:'weekly'},{reason:'learning',provider,window:'five_hour'}]);
    assert.ok(asked.every(query=>query.account_id===ACC&&!('plan' in query)),'the plan never selects a rate');
    assert.equal(source.convertUsage({units_micro:1000000,resources:obs.resources}),null);
    assert.ok(!observationProofFailures(obs).includes('conversion_unknown'));
  }
  // With learning from local logs off, nothing can be measured from logs: the job still lends, and the learning line says so.
  const off=createRealPace50Source({readings:async()=>readingsFor(),
    funding:()=>({observed_at:NOW,identity,codex_plan:{plan_type:'pro',limit_reached:false}}),
    expectedIdentity:()=>({account_sha256_16:ACC}),kappaForUsage:()=>null,learningOn:()=>false});
  assert.ok((await off.observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'})).learning
    .every(row=>row.reason==='learning'&&row.learning_off===true));
  // An expired measurement returns to native-window mode, and says it expired: a fresh meter reading does not renew it.
  const asked=[];
  const expired=createRealPace50Source({readings:async()=>readingsFor(),
    funding:()=>({observed_at:NOW,identity,codex_plan:{plan_type:'pro',limit_reached:false}}),
    expectedIdentity:()=>({account_sha256_16:ACC}),kappaForUsage:()=>null,
    measurementExpired:q=>{asked.push(q.resource);assert.equal(q.account_id,ACC,'the verified account is named');return true;}});
  const held=await expired.observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  assert.ok(held.learning.length>0);
  assert.ok(held.learning.every(row=>row.reason==='learning'&&row.expired===true&&row.learning_off===undefined));
  assert.ok(held.resources.every(r=>r.kappa_micro===null&&r.conversion==='native_window'));
  assert.ok(asked.every(resource=>resource.startsWith('claude:')));
  // Plan use with no account named in it (an older Codex CLI) says so, before the expired line.
  const unknown=createRealPace50Source({readings:async()=>readingsFor(),
    funding:()=>({observed_at:NOW,identity,codex_plan:{plan_type:'pro',limit_reached:false}}),
    expectedIdentity:()=>({account_sha256_16:ACC}),kappaForUsage:()=>null,
    creatorUnknown:()=>true,measurementExpired:()=>true});
  const unnamed=await unknown.observe({provider:'codex',plan:'pro',model:'gpt-6-sol'});
  assert.ok(unnamed.learning.length>0);
  assert.ok(unnamed.learning.every(row=>row.reason==='learning'&&row.creator_unknown===true&&row.expired===undefined));
  const unreadable=createRealPace50Source({readings:async()=>{throw Error('unavailable');}});
  const unread=await unreadable.observe({provider:'codex',plan:'plus'});
  assert.equal(unread.calibration_missing,undefined);
  assert.equal(unread.learning,undefined,'an unreadable meter is not learning: it keeps its own named hold');
  const invalid=verifiedSource(()=>({upper_micro:0,binding:{account_sha256_16:ACC}}));
  const obs=await invalid.observe({provider:'claude',plan:'pro',model:'claude-haiku-5-5'});
  assert.equal(obs.resources[0].kappa_micro,null);
  assert.equal(invalid.convertUsage({units_micro:1000000,resources:obs.resources}),null);
});

test('a measurement converts only for its own account, and a shipped bound is a floor under it', async () => {
  const measured=upper=>()=>({upper_micro:upper,lower_micro:null,binding:{account_sha256_16:ACC},
    provenance:{method:'current-window',label:'measured from your usage'}});
  // Below the floor: the larger shipped bound for the same provider, window and model wins, whatever the plan label.
  const low=await verifiedSource(measured(100)).observe({provider:'claude',plan:'pro',model:'claude-haiku-5-5'});
  assert.deepEqual(low.resources.map(r=>[r.id,r.kappa_micro,r.kappa_provenance.label]),
    [['seven_day',534900,'shipped bound'],['five_hour',1583100,'shipped bound']]);
  assert.deepEqual(low.learning,[]);
  // Above the floor: the measurement wins.
  const high=await verifiedSource(measured(9_000_000)).observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  assert.deepEqual(high.resources.map(r=>r.kappa_micro),[9_000_000,9_000_000]);
  // No shipped bound for this window: the measurement alone.
  const codex=await verifiedSource(measured(50_000),'plus').observe({provider:'codex',plan:'plus',model:'gpt-6-sol'});
  assert.deepEqual(codex.resources.map(r=>r.kappa_micro),[135700,50_000]);
  // Another account's measurement is refused by name.
  const other=await verifiedSource(()=>({upper_micro:9_000_000,binding:{account_sha256_16:'ffffffffffffffff'}}))
    .observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  // Refused measurements leave the window native (no rate), never borrowed from the other account.
  assert.deepEqual(other.resources.map(r=>[r.kappa_micro,r.kappa_rejection_code,r.conversion]),
    [[null,'binding_mismatch','native_window'],[null,'binding_mismatch','native_window']]);
  const unbound=await verifiedSource(()=>({upper_micro:9_000_000})).observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  assert.deepEqual(unbound.resources.map(r=>[r.kappa_micro,r.conversion]),[[null,'native_window'],[null,'native_window']]);
});

// Was a five-hour-only hold; the mode is now all or none per attempt, so both windows lend natively and the weekly rate is kept as evidence.
test('an unmeasured five-hour window makes the attempt native; the weekly measurement is kept as evidence', async () => {
  const source=verifiedSource(({resource})=>resource==='claude:seven_day'
    ?{upper_micro:900_000,binding:{account_sha256_16:ACC},provenance:{method:'ratio-of-sums/8-weeks'}}:null);
  const obs=await source.observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  assert.deepEqual(obs.resources.map(r=>[r.conversion,r.kappa_micro,r.measured_kappa_micro]),
    [['native_window',null,900_000],['native_window',null,undefined]]);
  assert.equal(obs.calibration_missing,undefined);
  assert.deepEqual(obs.learning,[{reason:'learning',provider:'claude',window:'five_hour'}]);
});

test('a rate measured from lent jobs converts for its own account and is labelled as such', async () => {
  const lent=({account_id,resource})=>({upper_micro:2_000_000,lower_micro:null,binding:{account_sha256_16:account_id,since:null},
    provenance:{method:'lent-job',label:LENT_LABEL},resource});
  const obs=await verifiedSource(lent).observe({provider:'claude',plan:'max20',model:'claude-haiku-5-5'});
  assert.deepEqual(obs.resources.map(r=>[r.conversion,r.kappa_micro,r.kappa_provenance.label]),
    [['measured',2_000_000,LENT_LABEL],['measured',2_000_000,LENT_LABEL]]);
  assert.deepEqual(obs.learning,[]);
});

test('Codex limit detail leaves admission, effects and durable money state unchanged', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'codex-limit-admission-'));
  let reached = true, effects = 0;
  const source = createRealPace50Source({readings:async () => readingsFor(),
    funding:() => ({observed_at:NOW, identity, codex_plan:{plan_type:'pro', limit_reached:reached}}),
    expectedIdentity:() => ({account_sha256_16:ACC})});
  const buildInput = async () => paceInputFromObservation(await source.observe({provider:'codex', now:NOW}), {now:NOW});
  const handlers = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window',
    'cancel_pending_attempt', 'request_cessation', 'request_fresh_complete_reconciliation'].map(name =>
    [name, async () => {effects++;}]));
  const adapter = createPace50Adapter({directory, account:'limit-test', account_week_id:'week',
    buildInput, effects:handlers, now:() => NOW});
  t.after(async () => {await adapter.close(); fs.rmSync(directory, {recursive:true, force:true});});
  const before = adapter.state();
  const held = await adapter.admit({expectedRevision:before.revision, request:request()});
  assert.equal(held.admitted, false);
  assert.equal(held.reason, 'funding_unknown');
  assert.deepEqual(held.detail, {fundingReason:'limit_reached'});
  assert.deepEqual(held.effects, []);
  assert.equal(effects, 0);
  assert.deepEqual(adapter.state(), before);
  reached = false;
  const observation = await source.observe({provider:'codex', now:NOW});
  assert.deepEqual(observation.funding, {subscription_only:'proven', reason:null});
  assert.ok(!observationProofFailures(observation).includes('funding_unknown'));
});

// Stop-bound rule: a past receipt shows the Stop path works; it never sets the bound for the next Stop.
const STOP_ANSWER_MS = 30_000;
const stopObservation = async (stop, {stopBoundMs = 35_000, stopAnswerMs = STOP_ANSWER_MS} = {}) => {
  const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
  const source = createRealPace50Source({
    readings: async () => readingsFor(),
    funding: async () => ({extra_usage: 'disabled', observed_at: NOW, guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'},
      identity: {account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org}}),
    // The stop comes from the machine's receipt, never from the reading's own fact.
    stopEvidence: async () => ({executor: {backend_id: 'docker-sbx', sbx_version: 'v1'}, stop, measured_at: NOW}),
    expectedIdentity: async () => ({email_sha256_16: H.email}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true},
    stopBoundMs, stopAnswerMs, kappaForUsage: () => null,
  });
  return source.observe({provider: 'claude', now: NOW});
};
const goodStop = latency_ms => ({delivered: true, fallback: null, latency_ms, removed: true});

test('one fast past stop does not set the next stop bound', async () => {
  const obs = await stopObservation(goodStop(1));
  assert.equal(obs.stop.bounded_execution, 'proven');
  assert.equal(obs.stop_bound_ms, 35_000, 'the bound is the configured one, not the 1 ms sample');
  assert.equal(obs.uncertainty_ms, 35_000 - STOP_ANSWER_MS, 'the time left for the hard stop and removal');
  assert.ok(obs.uncertainty_ms > 0);
});

test('a configured bound below the enforced answer deadline is not proven', async () => {
  const obs = await stopObservation(goodStop(1), {stopBoundMs: 20_000});
  assert.equal(obs.stop.bounded_execution, 'unknown');
  assert.equal(obs.stop.reason, 'stop_bound_below_answer_deadline');
  assert.equal(obs.stop_bound_ms, null);
  assert.equal(stopProof(goodStop(1), 20_000, STOP_ANSWER_MS).bounded_execution, 'unknown');
});

test('a past stop slower than the bound refutes the proof', async () => {
  const obs = await stopObservation(goodStop(35_001));
  assert.equal(obs.stop.bounded_execution, 'unknown');
  assert.equal(obs.stop.reason, 'stop_latency_over_bound');
  assert.equal(stopProof(goodStop(35_000), 35_000, STOP_ANSWER_MS).bounded_execution, 'proven', 'at the bound is not over it');
});

test('an unknown enforced answer deadline is not proven, and an undelivered or unremoved stop is not proven', () => {
  assert.equal(stopProof(goodStop(1), 35_000, null).reason, 'stop_answer_deadline_unknown');
  assert.equal(stopProof({...goodStop(1), fallback: 'hard'}, 35_000, STOP_ANSWER_MS).reason, 'stop_not_delivered');
  assert.equal(stopProof({...goodStop(1), removed: false}, 35_000, STOP_ANSWER_MS).reason, 'stop_removal_unverified');
});
