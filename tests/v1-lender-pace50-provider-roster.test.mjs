import './helpers/no-browser.mjs';
import {guardReadFrom} from './helpers/guard-read.mjs';
import './helpers/no-browser.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {candidateBuildInput, createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';
import {createRealPace50Source, observationProofFailures, paceInputFromObservation} from './helpers/real-source.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createMeasurementHistory} from '../lib/v1/event-history.mjs';

const job = {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};
test('Claude admission uses its own roster while a cleaned-up native Codex attempt retains its hold', async t => {
  const directory = tempDir('provider-roster-');
  const source = createSyntheticPace50Source({start: NOW, override: ({base}) => {
    const identity = {...base.identity, account_id: base.provider === 'codex' ? 'synthetic-codex-account' : ACCOUNT};
    return {...base, identity, account_week_id: `${identity.account_id}:weekly:${base.resources.find(r => r.kind === 'weekly').resets_at}`,
      resources: base.resources.map(r => ({...r, conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null}))};
  }});
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source});
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const reserve = (id, provider, model) => pace.candidate.reserve({attemptId: id, jobId: id, provider, model, job,
    automatic: true, ownerAbsent: true});
  const codex = await reserve('codex-held', 'codex', 'gpt-6-sol');
  assert.equal(codex.ok, true, JSON.stringify(codex));
  await pace.candidate.started('codex-held', {ok: true});
  await pace.candidate.recordCleanup('codex-held', {removed: true});
  const before = pace.adapter.state().attempts.find(a => a.id === 'codex-held');
  assert.ok(before.resources.some(r => r.held_micro > 0));
  const claude = await reserve('claude-offer', 'claude', 'claude-haiku-5-5');
  assert.equal(claude.ok, true, JSON.stringify(claude));
  const after = pace.adapter.state();
  assert.deepEqual(after.attempts.find(a => a.id === 'claude-offer').resources.map(r => r.id), ['seven_day', 'five_hour']);
  assert.equal(after.account_week_id, `${ACCOUNT}:weekly:${NOW + 42 * 3600000}`);
  assert.deepEqual(after.attempts.find(a => a.id === 'codex-held').resources, before.resources);
});

// Exercise the production observation constructor as well as the candidate adapter.
const ids = provider => provider === 'codex' ? ['codex:10080', 'codex:300'] : ['seven_day', 'five_hour'];
function realSource(t, {cold = false, jitter = 0} = {}) {
  const directory = tempDir('real-provider-roster-');
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const clock = {at: NOW};
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: () => clock.at});
  const facts = {};
  for (const provider of ['codex', 'claude']) {
    const [weekly, short] = ids(provider);
    ledger.recordReadings(provider, [
      {window_id: weekly, window_minutes: 10080, used_pct: 20, resets_at: NOW + 42 * 3600000 + jitter, observed_at: NOW, state: 'open', source: 'probe'},
      {window_id: short, window_minutes: 300, used_pct: cold && provider === 'claude' ? 0 : 40, resets_at: cold && provider === 'claude' ? null : NOW + 1.25 * 3600000, observed_at: NOW, state: cold && provider === 'claude' ? 'not_open' : 'open', source: 'probe'},
    ]);
    facts[provider] = {observed_at: NOW,
      identity: {account_sha256_16: provider === 'codex' ? '1111111111111111' : '2222222222222222', email_sha256_16: '3333333333333333'},
      extra_usage: 'disabled', guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'},
      codex_plan: {plan_type: 'pro', limit_reached: false},
      executor: {backend_id: 'synthetic-backend', sbx_version: 'synthetic-version'},
      stop: {delivered: true, fallback: null, latency_ms: 1, removed: true}};
  }
  const enrolled = Object.fromEntries(Object.entries(facts).map(([provider, fact]) => [provider, fact.identity]));
  const readings = createLendingReadings({ledger, now: () => clock.at});
  const source = createRealPace50Source({readings, funding: provider => facts[provider],
    expectedIdentity: provider => enrolled[provider],
    expectedExecutor: {backend_id: 'synthetic-backend', accepts: v => v === 'synthetic-version'},
    windowOrigin: () => new Map([['five_hour', 'owner'], ['codex:300', 'owner']]), stopBoundMs: 60000});
  return {ledger, source, facts, readings, clock};
}

test('real source keeps Codex and Claude weekly identity and evidence roster separate', async t => {
  const {source} = realSource(t);
  for (const provider of ['codex', 'claude', 'codex', 'claude']) {
    const obs = await source.observe({provider, admissionOnly: true});
    const input = paceInputFromObservation(obs, {now: NOW});
    assert.equal(input.refuse, undefined, JSON.stringify(obs));
    assert.equal(input.weekly_resource_id, ids(provider)[0]);
    assert.deepEqual(input.evidence.resource_ids, ids(provider));
    assert.deepEqual(input.windows.map(w => w.id), ids(provider));
    assert.ok(input.windows.every(w => w.conversion === 'native_window'));
  }
});

test('mixed-time Claude rows reproduce resources_incomplete before the policy, without a wrong weekly id', async t => {
  const {ledger, source} = realSource(t);
  // A later non-probe reading for just one row leaves the other at the funding fact's timestamp.
  ledger.recordReadings('claude', [{window_id: 'five_hour', window_minutes: 300, used_pct: 40,
    resets_at: NOW + 1.25 * 3600000, observed_at: NOW + 1, state: 'open', source: 'inband'}]);
  const obs = await source.observe({provider: 'claude', admissionOnly: true});
  assert.equal(obs.weekly_resource_id, 'seven_day');
  assert.deepEqual(obs.resources.map(r => r.id), ['seven_day', 'five_hour']);
  assert.equal(obs.complete, false);
  assert.equal(paceInputFromObservation(obs, {now: NOW + 1}).refuse, 'resources_incomplete');
});

test('gate refusals persist their exact local reason and provider before reserve, without job identity', async t => {
  const directory = tempDir('gate-refusal-history-');
  const history = createMeasurementHistory({directory: join(directory, 'history'), now: () => NOW});
  let incomplete = true;
  const source = createSyntheticPace50Source({start: NOW, override: ({base}) => ({...base, complete: !incomplete})});
  const build = candidateBuildInput({source});
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source,
    measurementHistory: history, buildInput: async args => {
      const input = await build(args);
      return input.refuse ? input : {...input, weekly_resource_id: 'codex:10080'};
    }});
  t.after(async () => { await pace.adapter.close(); history.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  assert.equal(await pace.candidate.preflight({provider: 'claude', jobId: 'private-job', ownerAbsent: true}), 'resources_incomplete');
  assert.equal(await pace.candidate.preflight({provider: 'claude', jobId: 'another-private-job', ownerAbsent: true}), 'resources_incomplete');
  incomplete = false;
  await pace.candidate.refreshObservation({provider: 'claude', model: 'claude-haiku-5-5'});
  const refused = await pace.candidate.preview({jobId: 'private-job', job, provider: 'claude', model: 'claude-haiku-5-5', ownerAbsent: true});
  assert.equal(refused.reason, 'resource_identity');
  await history.flush();
  history.close();
  const reopened = createMeasurementHistory({directory: join(directory, 'history'), now: () => NOW});
  await reopened.flush();
  reopened.close();
  const rows = fs.readFileSync(join(history.directory, 'measurements.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'admission_gate_refused');
  assert.equal(rows.length, 2, 'identical gate refusals are deduplicated, but a changed exact reason is recorded');
  assert.equal(rows[0].data.policy_reason, 'resources_incomplete');
  assert.equal(rows[0].data.provider, 'claude');
  assert.equal(rows[0].data.reason, 'resources_incomplete');
  assert.equal(rows[1].data.reason, 'resources_incomplete');
  assert.equal(rows[1].data.policy_reason, 'resource_identity');
  assert.equal(rows[1].data.provider, 'claude');
  assert.ok(!JSON.stringify(rows).includes('private-job'));
});

test('a cold Claude short window and reset jitter still quote on Claude after a native Codex hold', async t => {
  const {source, facts} = realSource(t, {cold: true, jitter: 742});
  source.objectiveInputFor = createSyntheticPace50Source({start: NOW}).objectiveInputFor;
  const directory = tempDir('cold-provider-roster-');
  const pace = createPace50Candidate({directory, now: () => NOW + 230000, account: ACCOUNT, account_week_id: WEEK, source});
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const reserve = (id, provider, model) => pace.candidate.reserve({attemptId: id, jobId: id, provider, model, job,
    automatic: true, ownerAbsent: true});
  assert.equal((await reserve('codex-held', 'codex', 'gpt-6-sol')).ok, true);
  await pace.candidate.started('codex-held', {ok: true});
  await pace.candidate.recordCleanup('codex-held', {removed: true});
  const held = pace.adapter.state().attempts.find(a => a.id === 'codex-held');
  assert.equal(held.process_state, 'ceased');
  assert.equal(held.cleanup_proven, true);
  assert.ok(held.resources.some(row => row.held_micro > 0));
  facts.claude.observed_at = NOW + 1000;
  assert.equal(await pace.candidate.preflight({provider: 'claude', ownerAbsent: true}), 'objective_evidence_unknown');
  assert.deepEqual(pace.adapter.state().attempts.find(a => a.id === 'codex-held'), held);
  facts.claude.observed_at = NOW;
  await pace.candidate.refreshObservation({provider: 'claude', model: 'claude-haiku-5-5'});
  const claude = await reserve('claude-cold', 'claude', 'claude-haiku-5-5');
  assert.equal(claude.ok, true, JSON.stringify(claude));
  const state = pace.adapter.state();
  const rows = state.attempts.find(a => a.id === 'claude-cold').resources;
  assert.deepEqual(rows.map(r => r.id), ['seven_day', 'five_hour']);
  assert.equal(state.account_week_id, `2222222222222222:weekly:${NOW + 42 * 3600000}`);
});

for (const [scenario, gap] of [['newer fact', 1000], ['newer fact after 950-second cadence', 950000],
  ['older fact', 950000], ['no fact after restart', 0]]) {
  test(`real cached cold-window source: ${scenario} waits for same-run evidence`, async t => {
    const {ledger, source, facts, readings, clock} = realSource(t, {cold: true});
    if (scenario.startsWith('newer fact')) { clock.at += gap; facts.claude.observed_at = clock.at; }
    if (scenario === 'older fact') {
      const rows = readings.cached('claude').windows;
      clock.at += gap;
      ledger.recordReadings('claude', rows.map(row => ({...row, observed_at: clock.at})));
      assert.equal(readings.cached('claude').windows.find(row => row.window_id === 'five_hour').state, 'not_open');
    }
    if (scenario === 'no fact after restart') facts.claude = null;
    let cachedReads = 0;
    const cached = readings.cached;
    readings.cached = provider => { cachedReads++; return cached(provider); };
    const obs = await source.observe({provider: 'claude', admissionOnly: true,
      excludingAttemptId: 'codex-held', guardRead: guardReadFrom(() => { throw Error('admission must use cached windows'); })});
    assert.ok(cachedReads > 0, 'admission consumes cached meter rows');
    assert.equal(obs.complete, false, 'cold conversion requires a fact matching its timestamp');
    assert.equal(obs.identity.verified, false);
    assert.equal(obs.funding.subscription_only, 'unknown', 'different-run facts never prove funding');
    assert.deepEqual(observationProofFailures(obs), ['objective_evidence_unknown']);
    assert.equal(paceInputFromObservation(obs, {now: clock.at}).refuse, 'objective_evidence_unknown');
  });
}

test('a cold row from a different run than the weekly row refuses resources_incomplete, then recovers on a coherent run', async t => {
  const {ledger, source, readings, facts, clock} = realSource(t, {cold: true});
  clock.at += 1000;
  const cold = readings.cached('claude').windows.find(row => row.window_id === 'five_hour');
  ledger.recordReadings('claude', [{...cold, observed_at: clock.at}]);
  const mixed = await source.observe({provider: 'claude', admissionOnly: true});
  assert.equal(mixed.identity.verified, true, 'the weekly row still matches the fact');
  assert.equal(mixed.funding.subscription_only, 'proven');
  assert.equal(paceInputFromObservation(mixed, {now: clock.at}).refuse, 'resources_incomplete');
  // A complete new probe updates both meter rows and its facts together.
  clock.at += 1000;
  ledger.recordReadings('claude', readings.cached('claude').windows.map(row => ({...row, observed_at: clock.at})));
  facts.claude.observed_at = clock.at;
  const coherent = await source.observe({provider: 'claude', admissionOnly: true});
  assert.equal(paceInputFromObservation(coherent, {now: clock.at}).refuse, undefined);
  assert.deepEqual(coherent.resources.map(row => row.id), ['seven_day', 'five_hour']);
  assert.equal(coherent.resources.find(row => row.id === 'five_hour').cold_open, true);
});
