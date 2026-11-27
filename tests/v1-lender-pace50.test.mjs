import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender, requesterCounterKey} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The lender's real loop against the signed loopback coordinator and the fake sandbox. Only the lending runtime's
// candidate option differs from the legacy default. The synthetic source is trusted test evidence, not a provider.
function launch(f, options = {}) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: options.approve ?? (async () => true), onEvent: (event) => { f.events.push(event); }});
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

// Every legacy lending call the candidate path must never make. A nonzero count is a double count, which is a failure.
function countLegacyCalls(runtime) {
  const counts = {reserve: 0, finish: 0, release: 0, observe: 0, reconcileAttempt: 0, admission: 0};
  for (const name of ['reserve', 'finish', 'release', 'observe', 'reconcileAttempt']) {
    const original = runtime[name].bind(runtime);
    runtime[name] = (...args) => { counts[name] += 1; return original(...args); };
  }
  const admission = runtime.manager.admission.bind(runtime.manager);
  runtime.manager.admission = (...args) => { counts.admission += 1; return admission(...args); };
  return counts;
}

// The codex model the journey runs: a priced model, so its guard meter can be enforced and its usage settled.
const CODEX_RUN = {model: 'gpt-6-sol'};
const settingsOn = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({providerConsent: {codex: true}})}});

test('the candidate path runs a job the standing rule accepted, through the durable adapter, with no legacy lending call', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  const source = createSyntheticPace50Source({start: f.clock.now()});
  f.policy.userActive = async () => false; // the owner is away: presence is known, not assumed
  const directory = join(f.root, 'pace50');
  const open = () => createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  const runtime = open();
  // Explicit refresh populates the existing cache; snapshot status must preserve
  // the same valid known projection, without substituting a fabricated ready state.
  const refreshed = await runtime.candidate.projectStatus({provider:'codex'});
  assert.notEqual(refreshed.reason, 'objective_evidence_unknown');
  const snapshot = await runtime.candidate.projectStatus({provider:'codex', snapshotOnly:true});
  assert.deepEqual(snapshot, refreshed);
  const legacy = countLegacyCalls(runtime);
  f.policy.lendingRuntime = runtime;
  launch(f);
  await until(() => f.count('/complete') === 1, 'signed completion through the candidate path');
  await f.stop();
  assert.deepEqual(legacy, {reserve: 0, finish: 0, release: 0, observe: 0, reconcileAttempt: 0, admission: 0});
  const [attempt] = runtime.pace50.state().attempts;
  assert.equal(attempt.process_state, 'ceased', 'the cessation proof came from the lender cleanup record');
  assert.equal(attempt.hold_closed, false, 'the fake borrower zero report does not release quota exposure');
  assert.ok(attempt.resources.every((r) => r.held_micro > 0 && r.released_micro === 0));
  assert.ok(f.calls.some(([kind]) => kind === 'run'));
  assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
  await runtime.close();
  const restarted = open();
  assert.equal(restarted.pace50.state().attempts[0].process_state, 'ceased', 'the cleanup proof survives a restart');
  assert.equal(restarted.pace50.state().attempts[0].hold_closed, false, 'the unresolved quota exposure survives a restart');
  await restarted.close();
});

test('with no standing rule (ask mode, approval denied) the candidate path admits nothing and runs nothing', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'ask'}});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  const legacy = countLegacyCalls(runtime);
  f.policy.lendingRuntime = runtime;
  launch(f, {approve: async () => ({declined:true})});
  await until(() => f.events.some((e) => e.status === 'declined' && e.reason === 'approval_denied'), 'approval denied');
  await f.stop();
  assert.equal(runtime.pace50.state().revision, 0, 'no admission was persisted');
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false, 'nothing ran');
  assert.deepEqual(legacy, {reserve: 0, finish: 0, release: 0, observe: 0, reconcileAttempt: 0, admission: 0});
  await runtime.close();
});

test('an unverified identity (the real source) reports identity_unknown and admits nothing', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.policy.userActive = async () => false; // the owner is away: presence is known, not assumed
  const readings = {windows: [
    {window_id: 'seven_day', window_minutes: 10080, used_pct: 20, resets_at: f.clock.now() + 42 * 3600000, observed_at: f.clock.now(), state: 'open'},
    {window_id: 'five_hour', window_minutes: 300, used_pct: 40, resets_at: f.clock.now() + 1.25 * 3600000, observed_at: f.clock.now(), state: 'open'},
  ]};
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1',
      source: createRealPace50Source({readings: async () => readings,
        funding: () => ({observed_at:f.clock.now(),identity:null})})}});
  const legacy = countLegacyCalls(runtime);
  f.policy.lendingRuntime = runtime;
  launch(f);
  // The lender reports its existing not-ready status for an unknown quota fact, and no job is admitted.
  await until(() => f.events.some((e) => e.status === 'paused' && e.reason === 'identity_unknown'), 'not ready: identity_unknown');
  await f.stop();
  assert.equal(runtime.pace50.state().revision, 0, 'the refused builder persisted nothing');
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false, 'nothing ran');
  assert.deepEqual(legacy, {reserve: 0, finish: 0, release: 0, observe: 0, reconcileAttempt: 0, admission: 0});
  await runtime.close();
});
test('legacy state without a price revision records a $1 burn and retains its unresolved $4 envelope', async () => {
  const {mkdtemp, writeFile, readFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {setLiveListPrices} = await import('../lib/v1/lending-meter.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'legacy-price-revision-'));
  const created_at = 1000000, now = created_at + 1000, attemptId = 'legacy-attempt';
  const account = 'legacy-account', account_week_id = 'legacy-week', epoch = 'legacy-epoch';
  // Literal pre-release state/4, not an attempt admitted by the new implementation.
  const resource = {id: 'seven_day', instance: 'legacy-window', epoch, kind: 'weekly',
    anchor_at: 0, resets_at: 604800000, duration_ms: 604800000,
    baseline_used_micro: 10000000, kappa_micro: 1000000,
    aggregate_observed_at: created_at, aggregate_used_micro: 10000000,
    initial_micro: 4000000, spent_micro: 0, settled_micro: 0,
    held_micro: 4000000, released_micro: 0, unrepresented_micro: 0, burns: []};
  const legacy = {version: 'objective-lending/state/4', account, account_week_id,
    revision: 1, mode: 'on', owner_present: false, owner_absent_since: created_at,
    updated_at: created_at, opening_tokens: [{account_week_id, status: 'unused', attempt_id: null}],
    opened_windows: [], event_ids: [attemptId + ':cleanup-proven:legacy'],
    attempts: [{id: attemptId, account, account_week_id, epoch, job_id: 'legacy-job', created_at,
      wall_ms: 60000, stop_ms: 1000, uncertainty_ms: 0, launch_state: 'started',
      process_state: 'ceased', cessation_proven: true, cleanup_proven: true, hold_closed: false,
      usage_unknown: null, late_ack_unresolved: false, late_ack_events: [], opening: null,
      recoveries: [], resources: [resource]}]};
  const path = join(directory, 'lending-pace50-state.json');
  let adapter;
  try {
    await writeFile(path, JSON.stringify(legacy));
    const observation = {refresh_succeeded: true, complete: true, epoch, observed_at: now,
      resources: [{...resource, used_micro: 11000000}]};
    const opened = createPace50Candidate({directory, account, account_week_id, now: () => now,
      source: {observe: async () => observation,
        convertUsage: ({units_micro, resources}) => resources.map(r => ({
          id: r.id, instance: r.instance, amount_micro: units_micro}))}});
    adapter = opened.adapter;
    assert.equal(Object.hasOwn(adapter.state().attempts[0], 'price_rev'), false);
    // An authoritative currency total needs no historical token catalog.
    setLiveListPrices({'claude-sonnet-5-5': {provider: 'anthropic',
      fresh_input_per_m: 100, output_per_m: 200}});
    const result = await opened.candidate.finish({attemptId, provider: 'claude',
      model: 'claude-sonnet-5-5', observation,
      execution: {lending_meter: {model: 'claude-sonnet-5-5', tokens: {input: 1},
        cost_usd: 1, final: true}}});
    assert.equal(result.metered.units_micro, 1000000);
    assert.equal(result.public, null, 'do not claim a fallback catalog priced historical usage');
    assert.equal(result.cessation.applied, false);
    assert.equal(result.cessation.reason, 'usage_unreconciled');
    const saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.hold_closed, false, 'an aggregate rise does not prove complete provider posting');
    assert.equal(saved.resources[0].spent_micro, 1000000);
    assert.equal(saved.resources[0].released_micro, 0);
    assert.equal(saved.resources[0].held_micro, 3000000);
    assert.equal(saved.resources[0].unrepresented_micro, 1000000);
    assert.equal(saved.resources[0].burns.length, 1);
  } finally {
    setLiveListPrices({});
    await adapter?.close?.();
    await rm(directory, {recursive: true, force: true});
  }
});

test('revision-less token usage remains unresolved across restart after its meter rise', async () => {
  const {mkdtemp, writeFile, readFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {effectivePriceCatalog, priceListUsd, emptyTokens, setLiveListPrices} = await import('../lib/v1/lending-meter.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'legacy-price-revision-'));
  const created_at = 1000000, now = created_at + 1000, attemptId = 'legacy-attempt';
  const account = 'legacy-account', account_week_id = 'legacy-week', epoch = 'legacy-epoch';
  // Literal pre-release state/4, not an attempt admitted by the new implementation.
  const resource = {id: 'seven_day', instance: 'legacy-window', epoch, kind: 'weekly',
    anchor_at: 0, resets_at: 604800000, duration_ms: 604800000,
    baseline_used_micro: 10000000, kappa_micro: 1000000,
    aggregate_observed_at: created_at, aggregate_used_micro: 10000000,
    initial_micro: 4000000, spent_micro: 0, settled_micro: 0,
    held_micro: 4000000, released_micro: 0, unrepresented_micro: 0, burns: []};
  const legacy = {version: 'objective-lending/state/4', account, account_week_id,
    revision: 1, mode: 'on', owner_present: false, owner_absent_since: created_at,
    updated_at: created_at, opening_tokens: [{account_week_id, status: 'unused', attempt_id: null}],
    opened_windows: [], event_ids: [attemptId + ':cleanup-proven:legacy'],
    attempts: [{id: attemptId, account, account_week_id, epoch, job_id: 'legacy-job', created_at,
      wall_ms: 60000, stop_ms: 1000, uncertainty_ms: 0, launch_state: 'started',
      process_state: 'ceased', cessation_proven: true, cleanup_proven: true, hold_closed: false,
      usage_unknown: null, late_ack_unresolved: false, late_ack_events: [], opening: null,
      recoveries: [], resources: [resource]}]};
  const path = join(directory, 'lending-pace50-state.json');
  let adapter, opened, conversions = 0;
  let observation = {refresh_succeeded: true, complete: true, epoch, observed_at: now,
    resources: [{...resource, used_micro: 10000000}]};
  const open = () => createPace50Candidate({directory, account, account_week_id, now: () => now,
    source: {observe: async () => observation, convertUsage: () => { conversions++; return []; }}});
  const execution = {lending_meter: {model: 'gpt-6-sol', tokens: {input: 500000}, final: true}};
  try {
    await writeFile(path, JSON.stringify(legacy));
    const tokens = {...emptyTokens(), fresh_input: 500000};
    const historical = effectivePriceCatalog({'gpt-6-sol': {provider: 'openai',
      fresh_input_per_m: 8, output_per_m: 12, above: {threshold: 272000, fresh_input_per_m: 8}}});
    assert.equal(priceListUsd('gpt-6-sol', tokens, {catalog: historical,
      calls: [{...tokens, prompt: 500000}]}).usd, 4);
    assert.equal(priceListUsd('gpt-6-sol', tokens, {catalog: effectivePriceCatalog(),
      calls: [{...tokens, prompt: 500000}]}).usd, 2);
    opened = open(); adapter = opened.adapter;
    // Unknown execution previously selected an unbound fallback. Restart here
    // must not turn that selection into evidence of historical token prices.
    await opened.candidate.finish({attemptId, provider: 'codex', model: 'gpt-6-sol', execution: {}});
    assert.equal(adapter.state().attempts[0].usage_unknown, 'codex');
    await adapter.close();
    setLiveListPrices({'gpt-6-sol': {provider: 'openai', fresh_input_per_m: 100, output_per_m: 100}});
    opened = open(); adapter = opened.adapter;
    const result = await opened.candidate.finish({attemptId, provider: 'codex', model: 'gpt-6-sol', execution});
    assert.equal(result.metered.units_micro, null, 'historical $4 must not become an exact bundled $2');
    assert.equal(conversions, 0);
    let saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.usage_unknown, 'codex');
    assert.equal(saved.resources[0].held_micro, 4000000);
    assert.equal(saved.resources[0].released_micro, 0);
    assert.equal(saved.resources[0].burns.length, 0);
    await adapter.close();
    opened = open(); adapter = opened.adapter;
    observation = {...observation, resources: [{...resource, used_micro: 14000000}]};
    await opened.candidate.probeHeld();
    saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.hold_closed, false, 'the aggregate meter does not prove the complete usage interval');
    assert.equal(saved.resources[0].spent_micro, 4000000);
    assert.equal(saved.resources[0].released_micro, 0);
    assert.equal(saved.resources[0].held_micro, 0);
    assert.equal(saved.resources[0].unrepresented_micro, 4000000);
  } finally {
    setLiveListPrices({});
    await adapter?.close?.();
    await rm(directory, {recursive: true, force: true});
  }
});

test('unknown quota use retains its hold but charges measured runtime after cleanup proof', {timeout:90000}, async t=>{
  const f=await lenderFixture(t,{hold:true,policy:{mode:'auto'},run:CODEX_RUN,
    mutateJob:job=>{job.requirements.limits.wall_seconds=600;}});
  const source=createSyntheticPace50Source({start:f.clock.now()});
  f.policy.maxWallSeconds=600;f.policy.dailyMinutes=60;
  const requester=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    ruleUsage:[{id:'late-ack',attemptId:f.attempt().attempt_id,at:f.clock.now(),ms:600000}]});
  f.policy.userActive=async()=>false;
  const runtime=createLendingRuntime({directory:join(f.root,'finish-ack'),settings:settingsOn,
    backend:{},presence:()=>false,lastActiveAt:()=>null,selfKey:()=>null,now:()=>f.clock.now(),
    pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source}});
  t.after(()=>runtime.close());
  f.policy.lendingRuntime=runtime;
  let allow=false,calls=0,unbound=0;
  const original=runtime.candidate.finish.bind(runtime.candidate);
  runtime.candidate.finish=async args=>{
    calls++;
    if(calls===1)f.clock.advance(20000); // settlement latency is not execution time
    if(!allow)return {metered:{model:args.model,units_micro:null},public:null,
      cessation:{applied:false,reason:'price_snapshot_missing'}};
    return original(args);
  };
  const unbind=runtime.candidate.registry.unbind.bind(runtime.candidate.registry);
  runtime.candidate.registry.unbind=(...args)=>{unbound++;return unbind(...args);};
  launch(f);
  await until(()=>f.calls.some(([kind])=>kind==='run'),'work starts');
  f.clock.advance(60000);f.execution.resolve();
  await until(()=>f.count('/complete')===1,'work delivered');
  await until(()=>calls>=2,'normal finish and final cleanup both refuse');
  await until(()=>f.clock.pending().includes(1000),'recovery waits');
  assert.ok(f.saved().pending?.candidateSettlement?.execution,'exact finish inputs survive');
  assert.equal(unbound,0,'refused finish retains its live binding');
  assert.equal(f.saved().milliseconds,60000,'cleanup proof charges the measured run before quota ACK');
  assert.equal(f.saved().requesters[requester].milliseconds,60000);
  assert.equal(f.saved().ruleUsage.find(row=>row.id==='late-ack').ms,60000);
  const heldBeforeAck=runtime.pace50.state().attempts[0];
  assert.equal(heldBeforeAck.hold_closed,false,'the quota hold is independent of the time refund');
  assert.ok(heldBeforeAck.resources.every(row=>row.held_micro>0),'unknown quota exposure stays held');
  const inputs=structuredClone(f.saved().pending.candidateSettlement);
  allow=true;f.clock.advance(1000);
  await until(()=>f.saved().pending===null,'later finish acknowledged');
  await f.stop();
  const check=()=>{
    assert.equal(f.saved().milliseconds,60000,'cleanup proof fixes the lender-measured run time at 60 seconds');
    assert.equal(f.saved().requesters[requester].milliseconds,60000);
    assert.equal(f.saved().ruleUsage.find(row=>row.id==='late-ack').ms,60000);
    assert.equal(f.saved().jobs,1);
    assert.equal(f.saved().pending,null);
    const held=runtime.pace50.state().attempts[0];
    assert.equal(held.hold_closed,false,'quota usage is still unresolved');
    assert.ok(held.resources.every(row=>row.held_micro>0),'unknown quota exposure remains held');
  };
  check();
  f.policy.recoveryOnly=true;f.policy.enabled=false;f.policy.pollMs=1000;
  launch(f);await until(()=>f.clock.pending().includes(1000),'second recovery waits');await f.stop();
  check();
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,1,'recovery does not rerun the job');
  assert.ok(inputs.execution);
});

test('a run without cleanup proof keeps the full time and quota reservations across restart', {timeout:90000}, async t=>{
  const f=await lenderFixture(t,{hold:true,policy:{mode:'auto'},run:CODEX_RUN,
    mutateJob:job=>{job.requirements.limits.wall_seconds=600;}});
  const source=createSyntheticPace50Source({start:f.clock.now()});
  const directory=join(f.root,'unproven-cleanup');
  const open=()=>createLendingRuntime({directory,settings:settingsOn,backend:{},presence:()=>false,lastActiveAt:()=>null,
    selfKey:()=>null,now:()=>f.clock.now(),pace50:{account:'synthetic-account',account_week_id:'synthetic-week-1',source}});
  f.policy.userActive=async()=>false;
  f.policy.maxWallSeconds=600;f.policy.dailyMinutes=60;f.policy.recoveryOnly=false;
  const requester=requesterCounterKey(f.job.payload.circle,f.job.payload.author);
  await f.policy.storage.set({day:'2026-10-09',jobs:0,milliseconds:0,pending:null,
    ruleUsage:[{id:'unproven-run',attemptId:f.attempt().attempt_id,at:f.clock.now(),ms:600000}]});
  let runtime=open(),reconciliations=0;
  t.after(()=>runtime.close());
  f.policy.lendingRuntime=runtime;
  f.backend.destroy=async()=>{f.calls.push(['destroy']);return {removed:false};};
  f.backend.reconcilePending=async row=>{reconciliations++;return {removed:false,attemptId:row.attemptId};};
  launch(f);
  await until(()=>f.calls.some(([kind])=>kind==='run'),'work starts');
  f.clock.advance(60000);f.execution.resolve();
  await until(()=>f.count('/fail')===1,'unproven cleanup is reported');
  await until(()=>f.calls.some(([kind])=>kind==='destroy'),'cleanup attempt finishes');

  const assertReservations=()=>{
    const saved=f.saved(),attempt=runtime.pace50.state().attempts[0];
    assert.equal(saved.milliseconds,600000,'unproven run time keeps the full daily reservation');
    assert.equal(saved.requesters[requester].milliseconds,600000);
    assert.equal(saved.ruleUsage.find(row=>row.id==='unproven-run').ms,600000);
    assert.notEqual(attempt.hold_closed,true,'quota exposure stays open without cleanup proof');
    assert.ok(attempt.resources.every(row=>row.held_micro===row.initial_micro&&row.unrepresented_micro===0&&row.released_micro===0));
  };
  assertReservations();
  await f.stop();
  await runtime.close();
  runtime=open();f.policy.lendingRuntime=runtime;f.policy.recoveryOnly=true;f.policy.enabled=false;f.policy.pollMs=1000;
  launch(f);
  await until(()=>reconciliations>0,'restart recovery requests cleanup proof');
  await f.stop();
  assertReservations();
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,1,'restart does not rerun the job');
});

test('old-format acknowledged recovery conservatively keeps the full time charge', {timeout:15000}, async t=>{
  const f=await lenderFixture(t),attempt=f.attempt();
  const requester={circle:f.job.payload.circle,keyId:f.job.payload.author};
  const key=requesterCounterKey(requester.circle,requester.keyId);
  await f.policy.storage.set({day:'2026-10-09',jobs:1,milliseconds:600000,
    requesters:{[key]:{jobs:1,milliseconds:600000}},
    ruleUsage:[{id:'old',attemptId:attempt.attempt_id,at:f.clock.now(),ms:600000}],
    pending:{attemptId:attempt.attempt_id,attempt,requester,reservedMs:600000,executionStartRequested:true,
      candidateSettlement:{provider:'codex',execution:{stdout:''}}}});
  f.policy.recoveryOnly=true;f.policy.enabled=false;
  f.backend.reconcilePending=async row=>({removed:true,attemptId:row.attemptId});
  f.policy.lendingRuntime={candidate:{finish:async()=>({cessation:{applied:true}})}};
  launch(f);await until(()=>f.saved().pending===null,'old journal recovered');await f.stop();
  assert.equal(f.saved().milliseconds,600000);
  assert.equal(f.saved().requesters[key].milliseconds,600000);
  assert.equal(f.saved().ruleUsage[0].ms,600000);
});


for (const [evidence, boundary] of [['denied', 'preparation'], ['stale', 'preparation'],
  ['allowed', 'preparation'], ['denied', 'start acknowledgement']]) test(
  'fresh launch admission after ' + boundary + ': ' + evidence, {timeout: 90000}, async t => {
    const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
    f.policy.userActive = async () => false;
    const synthetic = createSyntheticPace50Source({start: f.clock.now()});
    let changed = false, freshReads = 0;
    const source = {...synthetic, observe: async args => {
      const reading = await synthetic.observe(args);
      if (!changed) return reading;
      if (args.forceRefresh === true) freshReads++;
      if (evidence === 'denied') return {...reading,
        resources: reading.resources.map(row => ({...row, used_micro: 100_000_000}))};
      if (evidence === 'stale') return {...reading, observed_at: args.now - 86400000,
        resources: reading.resources.map(row => ({...row, observed_at: args.now - 86400000}))};
      return reading;
    }};
    const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn,
      backend: {}, presence: () => false, lastActiveAt: () => null, selfKey: () => null,
      now: () => f.clock.now(),
      pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
    f.policy.lendingRuntime = runtime;
    const legacy = countLegacyCalls(runtime);
    let prepared, resume;
    const preparing = new Promise(resolve => { prepared = resolve; });
    const held = new Promise(resolve => { resume = resolve; });
    const prepare = f.backend.prepare.bind(f.backend);
    let first = true;
    f.backend.prepare = async (...args) => {
      const handle = await prepare(...args);
      if (first && boundary === 'preparation') { first = false; prepared(); await held; }
      return handle;
    };
    if (boundary === 'start acknowledgement') {
      const start = f.client.startAttempt.bind(f.client);
      f.client.startAttempt = async (...args) => {
        const acknowledged = await start(...args);
        prepared(); await held;
        return acknowledged;
      };
    }
    t.after(async () => { resume(); await f.stop?.(); await runtime.close(); });
    launch(f);
    await preparing;
    const [reserved] = runtime.pace50.state().attempts;
    assert.ok(reserved.resources.some(row => row.held_micro > 0), 'the job already holds its allowance');
    changed = true;
    resume();
    await until(() => f.count('/complete') === 1 ||
      f.events.some(event => ['declined', 'reserve', 'failed', 'paused'].includes(event.status)), 'job runs or is held');
    await f.stop();
    assert.ok(freshReads > 0, 'provider evidence is read again after preparation');
    assert.equal(f.calls.filter(([kind]) => kind === 'run').length, evidence === 'allowed' ? 1 : 0);
    if (evidence !== 'allowed') {
      assert.equal(f.count('/complete'), 0);
      const [closed] = runtime.pace50.state().attempts;
      assert.equal(closed.id, reserved.id, 'the same candidate is checked');
      assert.equal(closed.process_state, 'ceased');
      assert.ok(closed.resources.every(row => row.held_micro === 0), 'unused allowance is returned: '+JSON.stringify(closed));
      assert.ok(closed.resources.every(row => row.burns.length === 0), 'no allowance is charged');
      assert.equal(f.saved().jobs, 0);
      assert.equal(f.saved().milliseconds, 0);
      assert.ok(f.events.some(event => ['declined', 'reserve', 'paused'].includes(event.status)));
    }
    assert.deepEqual(legacy, {reserve: 0, finish: 0, release: 0, observe: 0, reconcileAttempt: 0, admission: 0});
  });

async function durableLaunchFixture(t) {
  const f = await lenderFixture(t, {policy:{mode:'auto'}, run:CODEX_RUN});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start:f.clock.now()});
  const directory = join(f.root, 'durable-launch');
  f.openRuntime = () => createLendingRuntime({directory, settings:settingsOn, backend:{}, presence:()=>false,
    lastActiveAt:()=>null, selfKey:()=>null, now:()=>f.clock.now(),
    pace50:{account:'synthetic-account', account_week_id:'synthetic-week-1', source}});
  f.policy.lendingRuntime = f.openRuntime();
  return f;
}

test('a refused durable launch never dispatches and refunds only after cleanup', {timeout:15000}, async t => {
  const f = await durableLaunchFixture(t), runtime = f.policy.lendingRuntime;
  const transition = runtime.candidate.adapter.transition;
  runtime.candidate.adapter.transition = (event, options) => event.type === 'launch_result'
    ? Promise.resolve({applied:false, reason:'revision_conflict'}) : transition(event, options);
  launch(f);
  await until(() => f.calls.some(([kind]) => kind === 'destroy'), 'sandbox cleanup');
  await until(() => f.saved().pending === null || f.count('/complete') > 0, 'dispatch settled');
  await f.stop();
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 0, 'no dispatch without a durable start');
  const [row] = runtime.pace50.state().attempts;
  assert.equal(row.launch_state, 'reserved');
  assert.equal(row.hold_closed, true);
  assert.ok(row.resources.every(r => r.held_micro === 0 && r.burns.length === 0 && r.released_micro === r.initial_micro));
  assert.equal(f.saved().jobs, 0);
  assert.equal(f.saved().milliseconds, 0);
});

for (const legacy of [false, true]) test(
  `NORMAL_FINISH replay keeps unknown usage held${legacy ? ' for old prepared:false and a lost launch' : ''}`,
  {timeout:15000}, async t => {
    const f = await durableLaunchFixture(t);
    let runtime = f.policy.lendingRuntime;
    // Reproduce an old build which dispatched despite losing the launch write.
    if (legacy) runtime.candidate.started = async () => ({applied:true});
    const finish = runtime.candidate.finish;
    runtime.candidate.finish = async () => { throw new Error('settlement unavailable'); };
    runtime.candidate.settle = async () => { throw new Error('settlement unavailable'); };
    launch(f);
    await until(() => f.saved()?.pending?.candidateSettlement?.reason === 'done', 'finished intent saved');
    await f.stop();
    assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
    assert.equal(runtime.pace50.state().attempts[0].cleanup_proven, true);
    assert.ok(runtime.pace50.state().attempts[0].resources.every(r => r.burns.length === 0));
    if (legacy) {
      const saved = structuredClone(f.saved());
      saved.pending.candidateSettlement.prepared = false;
      delete saved.pending.candidateSettlement.cleaned_up;
      await f.policy.storage.set(saved);
    }
    runtime.candidate.finish = finish;
    await runtime.close();
    runtime = f.openRuntime(); f.policy.lendingRuntime = runtime;
    f.policy.recoveryOnly = true; f.policy.enabled = false; f.policy.pollMs = 1000;
    launch(f);
    await until(() => f.saved().pending === null, 'recovered finished intent');
    await f.stop();
    const [row] = runtime.pace50.state().attempts;
    assert.ok(row.hold_closed !== true || row.resources.every(r => r.released_micro === 0), 'finished work cannot get a zero-use release');
    assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1, 'recovery never dispatches again');
  });

test('pause after successful prepare requires cleanup before any zero-use release', {timeout:15000}, async t => {
  const f = await durableLaunchFixture(t), runtime = f.policy.lendingRuntime;
  let resume, prepared;
  const held = new Promise(resolve => { resume = resolve; });
  const ready = new Promise(resolve => { prepared = resolve; });
  const prepare = f.backend.prepare.bind(f.backend);
  f.backend.prepare = async (...args) => { const handle = await prepare(...args); prepared(); await held; return handle; };
  const destroy = f.backend.destroy.bind(f.backend);
  let cleanupRequested, clean;
  const cleanupReady = new Promise(resolve => { cleanupRequested = resolve; });
  const cleanupHeld = new Promise(resolve => { clean = resolve; });
  f.backend.destroy = async (...args) => { cleanupRequested(); await cleanupHeld; return destroy(...args); };
  t.after(() => { resume(); clean(); });
  const lender = launch(f);
  await ready; lender.pause(); resume();
  await cleanupReady;
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false);
  assert.notEqual(runtime.pace50.state().attempts[0].hold_closed, true, 'prepared sandbox still needs cleanup');
  assert.ok(runtime.pace50.state().attempts[0].resources.every(r => r.released_micro === 0));
  clean();
  await until(() => f.saved().pending === null, 'pause cleanup settled');
  await f.stop();
  assert.equal(runtime.pace50.state().attempts[0].hold_closed, true);
  assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
});

test('a lost launch acknowledgement dispatches after rereading the durable started row', {timeout:15000}, async t => {
  const f = await durableLaunchFixture(t), runtime = f.policy.lendingRuntime;
  const transition = runtime.candidate.adapter.transition;
  let lost = false;
  runtime.candidate.adapter.transition = async (event, options) => {
    const out = await transition(event, options);
    if (event.type === 'launch_result') {
      assert.equal(out.applied, true);
      lost = true;
      return {applied:false, reason:'acknowledgement_lost'};
    }
    return out;
  };
  launch(f);
  await until(() => f.count('/complete') === 1, 'durably started job completes');
  await f.stop();
  assert.equal(lost, true);
  assert.equal(runtime.pace50.state().attempts[0].launch_state, 'started');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
});

for (const [reason, requested, denied] of [
  ['error', true, false], ['restart_interrupted', true, false],
  ['restart_interrupted', false, false], ['error', true, true], ['error', undefined, false],
]) test(`legacy reserved recovery: ${reason}, requested=${requested}, denied=${denied}`, {timeout:15000}, async t => {
  const f = await durableLaunchFixture(t), runtime = f.policy.lendingRuntime, attempt = f.attempt();
  const grant = await runtime.candidate.reserve({attemptId:attempt.attempt_id, jobId:'legacy-recovery', provider:'codex',
    model:'gpt-6-sol', job:f.job.payload, automatic:false, ownerAbsent:true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await f.policy.storage.set({day:'2026-10-09', jobs:1, milliseconds:120000,
    pending:{attemptId:attempt.attempt_id, attempt, reservedMs:120000,
      ...(requested === undefined ? {} : {executionStartRequested:requested}), ...(denied ? {agentStartDenied:true} : {}),
      candidateSettlement:{provider:'codex',model:'gpt-6-sol',execution:null,prepared:true,reason}}});
  await runtime.close();
  f.policy.lendingRuntime = f.openRuntime();
  f.policy.recoveryOnly = true; f.policy.enabled = false;
  f.backend.reconcilePending = async pending => ({removed:true,attemptId:pending.attemptId});
  launch(f);
  await until(() => f.saved().pending === null, 'legacy recovery settled');
  await f.stop();
  const [row] = f.policy.lendingRuntime.pace50.state().attempts;
  assert.notEqual(row.hold_closed, true, 'unstamped legacy preparation cannot become a zero-use release');
  assert.ok(row.resources.every(r => r.released_micro === 0 && r.held_micro > 0));
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false, 'recovery never reruns the agent');
});

for (const [stamped, denied] of [[false,false], [false,true], [true,false], [true,true]]) test(
  `prepare contract recovery: stamped=${stamped}, denied=${denied}`, {timeout:15000}, async t => {
    const f = await durableLaunchFixture(t), runtime = f.policy.lendingRuntime;
    // This synthetic adapter models the old non-native provider preparation path.
    f.adapters[0].spec = {...f.adapters[0].spec,auth_strategy:'docker-stored-secret'};
    const commands = [];
    let defaultSessionRan = false;
    const runner = async args => {
      commands.push(args);
      if (args[0] === 'run' && args.includes('-d')) defaultSessionRan = true;
      return {code:0,stdout:'',stderr:''};
    };
    const save = f.policy.storage.set;
    f.policy.storage.set = async value => {
      const next = structuredClone(value);
      if (!stamped && next.pending) delete next.pending.prepare_contract;
      await save(next);
    };
    let prepared, resume;
    const ready = new Promise(resolve => { prepared = resolve; });
    const held = new Promise(resolve => { resume = resolve; });
    const prepare = f.backend.prepare.bind(f.backend);
    f.backend.prepare = async spec => {
      if (stamped) assert.equal(f.saved().pending.prepare_contract,'create-only','stamp is durable before preparation');
      const handle = await prepare(spec);
      await runner([stamped ? 'create' : 'run','--name',handle.sandbox_id,spec.image,...(stamped ? [] : ['-d'])]);
      prepared(); await held;
      return handle;
    };
    // Preserve the journal during shutdown, as an interrupted old process would.
    runtime.candidate.release = async () => { throw new Error('settlement unavailable'); };
    t.after(() => resume());
    const lender = launch(f);
    await ready;
    lender.pause(); resume();
    await f.stop();
    assert.ok(f.saved().pending,'recovery still owns the prepared attempt');
    assert.equal(f.calls.some(([kind]) => kind === 'run'),false,'explicit dispatch never happened');
    assert.equal(defaultSessionRan,!stamped,'only old preparation ran the default provider session');
    const saved = structuredClone(f.saved());
    assert.equal(saved.pending.executionStartRequested,false);
    if (denied) { saved.pending.executionStartRequested = true; saved.pending.agentStartDenied = true; }
    await f.policy.storage.set(saved);
    await runtime.close();
    f.policy.storage.set = save;
    f.policy.lendingRuntime = f.openRuntime();
    f.policy.recoveryOnly = true; f.policy.enabled = false;
    f.backend.reconcilePending = async pending => ({removed:true,attemptId:pending.attemptId});
    launch(f);
    await until(() => f.saved().pending === null,'prepared attempt recovered');
    await f.stop();
    const [row] = f.policy.lendingRuntime.pace50.state().attempts;
    if (stamped) {
      assert.equal(saved.pending.prepare_contract,'create-only','the real lender stamped the pending write before prepare');
      assert.equal(row.hold_closed,true);
      assert.ok(row.resources.every(r => r.spent_micro === 0 && r.released_micro === r.initial_micro));
    } else {
      assert.notEqual(row.hold_closed,true,'an old default provider session cannot get a zero-use release');
      assert.ok(row.resources.every(r => r.released_micro === 0 && r.held_micro + r.unrepresented_micro > 0));
    }
    assert.equal(commands.length,1,'recovery never starts another provider session');
  });

for(const measured of [false,true])for(const transient of ['429','account_busy'])test(
  'real retained 25-minute '+(measured?'measured':'default')+' evidence admits through durable candidate after '+transient,
  {timeout:15000},async()=>{
    const fs=await import('node:fs');
    const {tmpdir}=await import('node:os');
    const {createLendingLedger}=await import('../lib/v1/lending-ledger.mjs');
    const {createLendingProbe,createLendingReadings}=await import('../lib/v1/lending-probe.mjs');
    const {createStopEvidenceStore}=await import('../lib/v1/stop-evidence.mjs');
    const {usableAdmissionEvidence}=await import('../lib/v1/lender-pace50.mjs');
    const {readingAgeReserve}=await import('../lib/v1/lending-reading-age.mjs');
    const directory=fs.mkdtempSync(join(tmpdir(),'retained-candidate-'));
    const T=Date.parse('2026-11-02T12:00:00Z'),reset=T+(measured?6:7)*86400e3;
    let at=T,status=200,calls=0,busy=false,account='1111222233334444',runtime;
    const timers=new Set(),seen=[];
    const ledger=createLendingLedger({file:join(directory,'ledger.json'),now:()=>at});
    const probe=createLendingProbe({ledger,now:()=>at,runGuest:async()=>{
      calls++;
      return {stdout:JSON.stringify({faravan_probe:1,status,body:{plan_type:'pro',
        rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:14,
          limit_window_seconds:604800,reset_at:reset/1000}},spend_control:{reached:false}},
        identity:{status:200,account_sha256_16:account,email_sha256_16:'aaaabbbbccccdddd'}})};
    }});
    const readings=createLendingReadings({ledger,probe,now:()=>at,jobRunning:()=>busy});
    const binding={backend_id:'synthetic-retained-host',sbx_version:'test/1'};
    const stops=createStopEvidenceStore({file:join(directory,'stop.json'),now:()=>at});
    const source=createRealPace50Source({readings,funding:key=>probe.funding(key),
      expectedIdentity:()=>({email_sha256_16:'aaaabbbbccccdddd'}),
      expectedExecutor:{backend_id:binding.backend_id,accepts:version=>version===binding.sbx_version},
      stopBoundMs:60000,stopEvidence:async()=>{
        const receipt=await stops.current(binding);
        return receipt&&{executor:binding,measured_at:receipt.measured_at,
          stop:{delivered:receipt.delivered,fallback:receipt.fallback,removed:receipt.removed,latency_ms:receipt.latency_ms}};
      }});
    // The only objective fixture is an empty owner queue plus compatible complete history.
    // No observation, account, funding, Stop or executor field is provided here.
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
    const observe=source.observe.bind(source);
    source.observe=async args=>{const row={...args};seen.push(row);try{return await observe(args);}finally{row.settled=true;}};
    const args={provider:'codex',model:'gpt-6-sol'};
    const request={wall_ms:60000,stop_ms:60000,uncertainty_ms:30000};
    const attemptId='retained-attempt';
    try {
      const generation=await stops.begin();
      assert.equal(await stops.succeed(generation,{...binding,measured_at:T,
        stop:{delivered:true,fallback:null,removed:true,latency_ms:1}}),true);
      const fresh=await source.observe(args);assert.equal(fresh.refresh_succeeded,true);assert.equal(calls,1);
      at=T+25*60000;
      if(transient==='429')status=429;else busy=true;
      const ordinary=await source.observe({...args,forceRefresh:true});
      assert.equal(ordinary.refresh_succeeded,false);assert.equal(ordinary.resources.length,0);
      assert.equal(ordinary.probe.reason,transient==='429'?'rate_limited':'account_busy');
      if(transient==='account_busy')assert.equal(ordinary.refresh_outcome,'deferred');
      const beforeCalls=calls,latest=structuredClone(probe.latestAttempt('codex'));
      const cachedBefore=structuredClone(readings.cached('codex')),fundingBefore=probe.funding('codex');
      const retained=await source.observe({...args,admissionOnly:true});
      assert.equal(retained.refresh_succeeded,true);assert.equal(retained.observed_at,T);
      assert.equal(retained.evidence_generation,cachedBefore.evidence_generation);
      assert.deepEqual(retained.latest_attempt,latest);
      assert.equal(retained.resources[0].max_rate_pct_per_hour,measured?14/24:0);
      assert.equal(usableAdmissionEvidence(retained,request,at),null);
      assert.equal(retained.stop.proven_until,T+24*60*60000);
      if(!measured){
        assert.equal(readingAgeReserve(retained.resources[0],at),8333334);
        const absent=structuredClone(retained);delete absent.resources[0].max_rate_pct_per_hour;
        assert.equal(readingAgeReserve(absent.resources[0],at),8333334);
        assert.equal(usableAdmissionEvidence(absent,request,at),null);
      }
      runtime=createLendingRuntime({directory:join(directory,'candidate'),backend:{},settings:settingsOn,
        presence:()=>false,now:()=>at,pace50:{source,account:'retained-device',account_week_id:'retained-device-week',
          objectiveInputFor,nativeGuard:{setTimer(fn,ms){const timer={fn,ms,unref(){}};timers.add(timer);return timer;},
            clearTimer:timer=>timers.delete(timer)}}});
      const job={requirements:{limits:{wall_seconds:60}},expires_at:new Date(at+3600000).toISOString(),
        budget_v1:{max_list_usd:1.5}};
      const grant=await runtime.candidate.reserve({attemptId,jobId:'retained-job',...args,job,automatic:false,ownerAbsent:true});
      assert.equal(grant.ok,true,JSON.stringify(grant));
      const before=structuredClone(runtime.pace50.state());
      assert.equal(before.attempts.length,1);
      assert.ok(before.attempts[0].resources.every(row=>row.initial_micro>0&&row.held_micro>0));
      assert.equal((await runtime.candidate.admitStart(attemptId)).ok,true);
      assert.equal((await runtime.candidate.admitStart(attemptId)).ok,true);
      assert.deepEqual(runtime.pace50.state(),before,'final admission neither duplicates nor subtracts the existing reservation');
      assert.equal(calls,beforeCalls,'all cached admission work is local');
      assert.deepEqual(probe.latestAttempt('codex'),latest);
      assert.deepEqual(readings.cached('codex'),cachedBefore);
      assert.deepEqual(probe.funding('codex'),fundingBefore);
      // Exercise the actual native guard producer without allowing a provider call:
      // backoff (429) or active-account deferral (busy) still controls ordinary reads.
      const poll=[...timers][0];assert.ok(poll);timers.delete(poll);poll.fn();
      await until(()=>seen.some(row=>row.admissionOnly===false&&row.settled),
        'actual guard producer uses ordinary source reads');
      assert.equal(calls,beforeCalls);
      const guardObservation=await source.observe({...args,admissionOnly:true,guardRead:{}});
      assert.equal(guardObservation.refresh_succeeded,false,'guard context cannot borrow admission-only normalization');
      assert.equal(guardObservation.resources.length,0);
      // A new successful provider generation changes the account before dispatch.
      busy=false;status=200;account='5555666677778888';at+=6*60000;
      await source.observe({...args,forceRefresh:true});
      assert.notEqual(probe.evidenceGeneration('codex'),retained.evidence_generation);
      assert.equal(source.admissionEvidence(retained,'codex').latest_attempt.reason,'evidence_superseded');
      assert.equal(usableAdmissionEvidence(source.admissionEvidence(retained,'codex'),request,at),'refresh_failed');
      const afterRefreshCalls=calls;
      assert.equal((await runtime.candidate.admitStart(attemptId)).ok,false,'old reservation cannot dispatch under a new account generation');
      assert.equal(calls,afterRefreshCalls);
      assert.equal(runtime.pace50.state().attempts.length,1);
      assert.deepEqual(runtime.pace50.state().attempts[0].resources,before.attempts[0].resources);
    } finally {
      if(runtime){runtime.candidate.nativeGuard.unwatch(attemptId);await runtime.close();}
      await probe.close();timers.clear();fs.rmSync(directory,{recursive:true,force:true});
    }
  });

// Composed evidence only: real observation parsing/identity/funding/Stop/measurement and
// durable origin records, with explicitly SYNTHETIC demand/history (objectiveInputFor only).
// The fixture's no-live-attempt premise is not qualification of a provider or owner history.
async function realOriginWaitFixture(t, {objective = true, origin = 'owner'} = {}) {
  const {mkdtemp, readFile, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {createWindowOriginStore, originMapFor} = await import('../lib/v1/window-origin.mjs');
  const {ownMeasurement} = await import('./helpers/own-measurement.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'real-origin-wait-'));
  const originPath = join(directory, 'window-origin.json');
  const T = Date.UTC(2026, 9, 23, 10);
  let clock = T, reads = 0, builds = 0, transitions = 0, originReads = 0;
  let identity = {account_sha256_16:'1111222233334444', email_sha256_16:'aaaa0000bbbb1111'};
  let funding = 'disabled', stopOk = true, generation = 1, probe = null;
  let windows = [
    {window_id:'seven_day', window_minutes:10080, used_pct:0, resets_at:T+42*3600000, observed_at:T, state:'open'},
    {window_id:'five_hour', window_minutes:300, used_pct:0, resets_at:T+4500000, observed_at:T, state:'open'},
  ];
  let store = createWindowOriginStore({directory});
  const source = createRealPace50Source({
    readings:async () => { reads++; return {windows:structuredClone(windows), evidence_generation:generation, probe}; },
    funding:() => ({observed_at:windows[0].observed_at, extra_usage:funding,
      guest_auth:{loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty'}, identity}),
    expectedIdentity:() => ({email_sha256_16:'aaaa0000bbbb1111'}),
    expectedExecutor:{backend_id:'docker-sbx', accepts:version=>version==='fixture-1'},
    stopEvidence:() => stopOk ? {executor:{backend_id:'docker-sbx', sbx_version:'fixture-1'},
      stop:{delivered:true, fallback:null, latency_ms:700, removed:true}, measured_at:T} : null,
    stopBoundMs:30000, kappaForUsage:ownMeasurement,
    windowOrigin:(_provider, resources) => {originReads++; return originMapFor(store, resources);},
  });
  const syntheticObjective = createSyntheticPace50Source().objectiveInputFor;
  const makeRuntime = () => createLendingRuntime({directory:join(directory,'runtime'), backend:{}, now:()=>clock,
    settings:() => ({intent:'on', enabled:true, limits:{lendingPolicy:normalizeLendingPolicy({
      providerConsent:{claude:true}, accountPlans:{claude:'max20'}})},
      agentRun:{'claude-code-subscription':{model:'claude-haiku-5-5'}}}),
    presence:()=>false,
    pace50:{account:'fixture-durable-account',
      account_week_id:identity.account_sha256_16+':weekly:'+windows[0].resets_at, source,
      ...(origin === 'owner' ? {windowOrigins:store} : {}),
      ...(objective ? {objectiveInputFor:args=>{builds++;return syntheticObjective(args);}} : {})}});
  let runtime = makeRuntime();
  const countTransitions = () => {
    const transition = runtime.pace50.transition.bind(runtime.pace50);
    runtime.pace50.transition = (...args) => {transitions++;return transition(...args);};
  };
  countTransitions();
  const reopen = async () => {await runtime.close();runtime=makeRuntime();countTransitions();};
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const recordOpen = () => {
    const state = runtime.pace50.state();
    assert.deepEqual(state.attempts, [], 'fixture has no live attempt OR reservation; no inference from silence');
    store.observeOpen({windows, lendingInstances:[], lentAttemptLive:false, now:clock});
    store = createWindowOriginStore({directory});
  };
  if (origin === 'owner') recordOpen();
  else if (origin === 'unknown') store.observeOpen({windows, now:clock});
  else if (origin === 'unreadable') await writeFile(originPath,'{broken');
  const originBytes = () => readFile(originPath,'utf8').catch(error=>{
    if(error.code==='ENOENT')return null; throw error;
  });
  const refresh = () => runtime.refreshCapacity('claude');
  const account = async () => (await runtime.view()).accounts.find(row=>row.id==='claude');
  const counters = () => ({reads, builds, transitions, originReads, revision:runtime.pace50.state().revision});
  return {get runtime(){return runtime;}, source, T, originPath, originBytes, recordOpen, refresh, account, counters, reopen,
    setClock:value=>{clock=value;}, setUsed:value=>{windows[0].used_pct=value;generation++;},
    setProbe:value=>{probe=value;}, setIdentity:value=>{identity=value;generation++;},
    setFunding:value=>{funding=value;generation++;}, setStop:value=>{stopOk=value;generation++;},
    replaceShort:()=>{windows[1]={...windows[1],resets_at:windows[1].resets_at+3600000};generation++;},
    windows:()=>structuredClone(windows), store:()=>store,
  };
}

test('real observation plus synthetic objective and durable inferred origin reaches admission before owner_reserve; status is quiet', async t=>{
  const f=await realOriginWaitFixture(t);
  assert.equal((await f.refresh()).admitted,true,'host must establish this positive baseline first');
  const observed=f.runtime.candidate.observeSnapshot({provider:'claude',model:'claude-haiku-5-5',plan:'max20'});
  const short=observed.resources.find(r=>r.kind==='short');
  assert.equal(f.store().originFor(short.instance),'owner','actual real-source instance, read from reopened durable store');
  assert.equal(f.store().snapshot({now:f.T}).records.find(r=>r.instance===short.instance).inferred,'no_lent_opening');
  f.setUsed(100);
  const held=await f.refresh();
  assert.equal(held.reason,'owner_reserve');
  assert.deepEqual(held.wait,{accountKey:'claude',reason:'owner_reserve',
    strategyId:held.objective?.strategyId??null,nextEvaluationAtMs:short.resets_at,source:'window_reset'});
  const bytes=await f.originBytes(), before=f.counters();
  const timers=[];
  for(const name of ['setTimeout','setInterval']){
    const real=globalThis[name];
    t.mock.method(globalThis,name,(...args)=>{timers.push(name);return real(...args);});
  }
  const row=await f.account();
  const again=await f.account();
  assert.deepEqual(f.counters(),before,'cached status reads neither source/origin nor objective/transition');
  assert.equal(await f.originBytes(),bytes,'status never writes the durable origin store');
  assert.deepEqual(timers,[],'status starts no timers');
  assert.deepEqual(again.decision.availability.wait,held.wait);
  assert.equal(row.decision.lastJobDecision,null,'availability is not a job decision');
  const json=JSON.parse(JSON.stringify(row.decision.availability.wait));
  assert.equal(typeof json.nextEvaluationAtMs,'number');
  assert.ok(Number.isSafeInteger(json.nextEvaluationAtMs));
});

test('actual cached projection reselects after an explicitly supplied same-observation retry deadline; rollback/account isolation', async t=>{
  const f=await realOriginWaitFixture(t);
  f.setUsed(100);
  // Explicit fixture metadata, not a claim that a successful live probe publishes retries.
  // The real source's existing sanitizer accepts this metadata alongside these bound windows.
  f.setProbe({reason:'rate_limited',retry_at:f.T+1000});
  const first=await f.refresh();
  assert.equal(first.reason,'owner_reserve');
  assert.equal(first.wait.source,'probe_retry_at');
  assert.equal(first.wait.nextEvaluationAtMs,f.T+1000);
  const before=f.counters(), bytes=await f.originBytes();
  f.setClock(f.T+1001); // still inside the actual candidate cache lifetime
  const next=(await f.account()).decision.availability;
  assert.equal(next.reason,'owner_reserve');
  assert.equal(next.wait.source,'window_reset');
  assert.equal(next.wait.nextEvaluationAtMs,f.windows()[1].resets_at);
  assert.deepEqual(f.counters(),before,'actual WeakMap projection hit, not an authored projector');
  assert.equal(await f.originBytes(),bytes);
  const foreign=await f.runtime.candidate.projectStatus({provider:'claude',accountKey:'claude:other',
    model:'claude-haiku-5-5',plan:'max20',snapshotOnly:true});
  assert.equal(foreign.reason,'objective_evidence_unknown');assert.equal(foreign.wait,undefined);
  f.setClock(f.T-1);
  const rollback=(await f.account()).decision.availability;
  assert.equal(rollback.reason,'objective_evidence_unknown');assert.equal(rollback.wait,undefined);
  assert.equal(f.counters().reads,before.reads);
});

for(const origin of ['missing','unknown','unreadable'])test('real source missing origin remains untimed: '+origin,async t=>{
  const f=await realOriginWaitFixture(t,{origin});
  f.setUsed(100);
  const bytes=await f.originBytes();
  const result=await f.refresh();
  assert.equal(result.reason,'window_origin_unknown');
  assert.equal(result.wait,undefined);
  assert.equal(await f.originBytes(),bytes,'negative has no origin writer');
  assert.equal(f.runtime.pace50.state().revision,0);
});

test('a reset instance never inherits another instance origin and needs its own fixture observation',async t=>{
  const f=await realOriginWaitFixture(t,{origin:'unknown'});
  f.recordOpen();
  assert.equal((await f.refresh()).admitted,true);
  const old=f.runtime.candidate.observeSnapshot({provider:'claude',model:'claude-haiku-5-5',plan:'max20'})
    .resources.find(r=>r.kind==='short').instance;
  f.replaceShort();
  assert.equal((await f.refresh()).reason,'window_origin_unknown');
  const current=f.runtime.candidate.observeSnapshot({provider:'claude',model:'claude-haiku-5-5',plan:'max20'})
    .resources.find(r=>r.kind==='short').instance;
  assert.notEqual(current,old);assert.equal(f.store().originFor(current),null);
  f.recordOpen();
  assert.equal((await f.refresh()).admitted,true);
  assert.equal(f.store().originFor(current),'owner');
});

test('raw real source without the synthetic objective is still evidence_unknown',async t=>{
  const f=await realOriginWaitFixture(t,{objective:false});
  const result=await f.refresh();
  assert.equal(result.reason,'objective_evidence_unknown');assert.equal(result.wait,undefined);
});

for(const [label,change] of [
  ['identity',f=>f.setIdentity(null)],['funding',f=>f.setFunding('enabled')],['Stop',f=>f.setStop(false)],
])test('real '+label+' failure supersedes cached owner_reserve before synthetic objective evaluation',async t=>{
  const f=await realOriginWaitFixture(t);f.setUsed(100);
  assert.equal((await f.refresh()).reason,'owner_reserve');
  const before=f.counters().builds;change(f);
  await f.refresh();
  const result=(await f.account()).decision.availability;
  assert.notEqual(result.reason,'owner_reserve');assert.equal(result.admitted,false);assert.equal(result.wait,undefined);
  assert.equal(f.counters().builds,before);
});

for(const mode of ['pause','stop'])test('durable '+mode+' is untimed rather than a cached owner_reserve',async t=>{
  const f=await realOriginWaitFixture(t);f.setUsed(100);
  assert.equal((await f.refresh()).reason,'owner_reserve');
  const transition=await f.runtime.pace50.transition({type:mode,event_id:'fixture-'+mode,at:f.T}, {expectedRevision:f.runtime.pace50.state().revision});
  assert.equal(transition.applied,true);
  await f.reopen();
  await f.refresh();
  const result=(await f.account()).decision.availability;
  assert.equal(result.reason,mode==='pause'?'paused':'stopped');assert.equal(result.wait,undefined);
});


test('new-result status uses only sanitized same-bound deadlines and eligibility holds remain untimed',async t=>{
  const f=await realOriginWaitFixture(t);f.setUsed(100);
  for(const retry_at of [null, 'later', -1, f.T, Number.MAX_SAFE_INTEGER]){
    f.setProbe({reason:'rate_limited',retry_at});
    const held=await f.refresh();
    assert.equal(held.reason,'owner_reserve');
    assert.equal(held.wait.source,'window_reset');
    assert.equal(held.wait.nextEvaluationAtMs,f.windows()[1].resets_at);
  }
  const fresh=await f.runtime.candidate.projectStatus({provider:'claude',model:'claude-haiku-5-5',plan:'max20'});
  assert.equal(fresh.reason,'owner_reserve');
  assert.equal(fresh.wait.source,'window_reset','non-snapshot return is presented too');
  const invalidModel=await f.runtime.candidate.projectStatus({provider:'claude',model:'unpriced-model',plan:'max20',snapshotOnly:true});
  assert.equal(invalidModel.admitted,false);assert.notEqual(invalidModel.reason,'owner_reserve');
  assert.equal(invalidModel.wait,undefined);
});
