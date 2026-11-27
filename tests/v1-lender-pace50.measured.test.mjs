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
  f.policy.userActive = async () => false; // the owner is away: presence is known, not assumed
  const directory = join(f.root, 'pace50');
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const open = () => createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {postingLagBoundMs:120000,account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
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
  f.clock.advance(120000);await runtime.candidate.probeHeld();
  const [attempt] = runtime.pace50.state().attempts;
  assert.equal(attempt.process_state, 'ceased', 'the cessation proof came from the lender cleanup record');
  assert.ok(attempt.resources.every((r) => r.held_micro === 0), 'the unused reservation is released');
  assert.ok(f.calls.some(([kind]) => kind === 'run'));
  assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
  await runtime.close();
  const restarted = open();
  assert.equal(restarted.pace50.state().attempts[0].process_state, 'ceased', 'the proof and the release survive a restart');
  await restarted.close();
});

test('with no standing rule (ask mode, approval denied) the candidate path admits nothing and runs nothing', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'ask'}});
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {postingLagBoundMs:120000,account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
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
    pace50: {postingLagBoundMs:120000,account: 'synthetic-account', account_week_id: 'synthetic-week-1',
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
test('R1 revision-less $4 token usage remains unknown across restart, then reconciles from its meter', async () => {
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
  let observation = {refresh_succeeded:true,complete:true,epoch,account_week_id,identity:{verified:true,account_id:account},observed_at:now,
    resources: [{...resource, used_micro: 10000000}]};
  let postingLagBoundMs=null;
  const open = () => createPace50Candidate({postingLagBoundMs,directory, account, account_week_id, now: () => now,
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
    await opened.candidate.recordCleanup(attemptId,{removed:true});
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
    postingLagBoundMs=0;await adapter.close();opened=open();adapter=opened.adapter;
    observation = {...observation, resources: [{...resource, used_micro: 14000000}]};
    await opened.candidate.probeHeld();
    observation.resources[0].used_micro=15000000;await opened.candidate.probeHeld();
    saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.hold_closed, true);
    assert.equal(saved.resources[0].spent_micro, 5000000);
    assert.equal(saved.resources[0].released_micro, 0);
    assert.equal(saved.resources[0].held_micro, 0);
  } finally {
    setLiveListPrices({});
    await adapter?.close?.();
    await rm(directory, {recursive: true, force: true});
  }
});

// A legacy state/4 attempt has no price revision. An authoritative cost_usd needs no historical token catalog, and at a measured
// posting bound the hold closes once a reading taken after cessation plus the bound covers the burn.
test('M2 legacy state/4 without price_rev settles a $1 burn and releases its $4 hold at the measured bound', async () => {
  const {mkdtemp, writeFile, readFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {createPace50Candidate} = await import('../lib/v1/lender-pace50.mjs');
  const {setLiveListPrices} = await import('../lib/v1/lending-meter.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'legacy-price-revision-'));
  const created_at = 1000000, attemptId = 'legacy-attempt';
  let now = created_at + 1000;
  const account = 'legacy-account', account_week_id = 'legacy-week', epoch = 'legacy-epoch';
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
    const observation = {refresh_succeeded: true, complete: true, epoch, account_week_id, identity: {verified: true, account_id: account}, observed_at: now,
      resources: [{...resource, used_micro: 11000000}]};
    const opened = createPace50Candidate({postingLagBoundMs: 120000, directory, account, account_week_id, now: () => now,
      source: {observe: async () => ({...observation, observed_at: now}),
        convertUsage: ({units_micro, resources}) => resources.map(r => ({
          id: r.id, instance: r.instance, amount_micro: units_micro}))}});
    adapter = opened.adapter;
    assert.equal(Object.hasOwn(adapter.state().attempts[0], 'price_rev'), false);
    await opened.candidate.recordCleanup(attemptId, {removed: true});
    setLiveListPrices({'claude-sonnet-5-5': {provider: 'anthropic', fresh_input_per_m: 100, output_per_m: 200}});
    const result = await opened.candidate.finish({attemptId, provider: 'claude', model: 'claude-sonnet-5-5', observation,
      execution: {lending_meter: {model: 'claude-sonnet-5-5', tokens: {input: 1}, cost_usd: 1, final: true}}});
    assert.equal(result.metered.units_micro, 1000000);
    assert.equal(result.public, null, 'do not claim a fallback catalog priced historical usage');
    assert.equal(result.cessation.applied, false, 'a reading before the measured bound cannot close the hold');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).attempts[0].hold_closed, false);
    now += 121000; observation.resources[0].used_micro = 12000000;
    await opened.candidate.probeHeld();
    let saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.resources[0].held_micro, 0, 'the covering reading releases the unused reservation');
    assert.equal(saved.resources[0].unrepresented_micro, 1000000, 'the $1 burn is not yet on the meter, so the hold is not closed');
    assert.equal(saved.hold_closed, false);
    // A later owner rise by the unrepresented amount shows the burn on the meter and closes the hold.
    now += 1000; observation.resources[0].used_micro = 13000000;
    await opened.candidate.probeHeld();
    saved = JSON.parse(await readFile(path, 'utf8')).attempts[0];
    assert.equal(saved.hold_closed, true);
    assert.equal(saved.resources[0].held_micro, 0);
    assert.equal(saved.resources[0].unrepresented_micro, 0);
    assert.equal(saved.resources[0].spent_micro + saved.resources[0].released_micro, 4000000, 'the $4 reservation is conserved');
    assert.equal(saved.resources[0].released_micro, 1000000);
    assert.equal(saved.resources[0].burns.reduce((sum, b) => sum + b.amount_micro, 0), saved.resources[0].spent_micro);
  } finally {
    setLiveListPrices({});
    await adapter?.close?.();
    await rm(directory, {recursive: true, force: true});
  }
});
