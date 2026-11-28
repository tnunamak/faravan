import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appFixture, api, browserApi} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import * as appModule from '../lib/v1/app.mjs';
import * as protocol from '../lib/protocol/index.mjs';
import {MODEL_EFFORT_PAIRS_CAPABILITY} from '../lib/v1/versions.mjs';
import {draftBody} from '../ui/v1/src/compose-draft.mjs';
import {composeVM} from '../ui/v1/src/view-models.mjs';

// The composer offers a (agent, model, effort) pair only when a fresh, ready, quota-backed lender can claim it, and a
// job sent with a pair is claimed only by a lender that offers that pair. The rows here stand in for the coordinator's
// presence page. v1-compose-offer-producer.test.mjs covers the lender-side heartbeat that writes those rows.
const testOptions = {timeout: 120000};
const vectors = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const agent = (adapter, pairs, readiness = 'ready') => ({adapter, readiness, models: [...new Set(pairs.map(p => p.model))], per_job_max_minutes: 20, model_efforts: pairs});
const lender = (device, agents, over = {}) => ({device, online: true, source: 'heartbeat', intent: {state: 'ready'},
  capabilities: [MODEL_EFFORT_PAIRS_CAPABILITY, 'budget_v1'], agents, ...over});
const presenceRows = () => [
  lender('lender-a', [agent('codex', [{model: 'example-model', effort: 'low'}, {model: 'other-model', effort: 'medium'}]),
    agent('claude-code-api-key', [{model: 'claude-opus-5-5', effort: 'high'}])]),
  lender('lender-b', [agent('codex', [{model: 'example-model', effort: 'low'}])]),
  lender('lender-c', [agent('claude-code-subscription', [{model: 'claude-opus-5-5', effort: 'medium'}])]),
  lender('lender-d', [agent('claude-code-subscription', [{model: 'claude-opus-5-5', effort: 'high'}], 'signed_out')]),
  lender('polled-lender', [agent('codex', [{model: 'polled-model', effort: 'high'}])], {source: 'poll', capabilities: []}),
  // presenceView keeps source 'heartbeat' for a stale heartbeat with no recent poll; online is what tells them apart.
  lender('stale-lender', [agent('codex', [{model: 'stale-model', effort: 'high'}])], {online: false, capabilities: []}),
  lender('paused-lender', [agent('codex', [{model: 'paused-model', effort: 'low'}])], {intent: {state: 'paused'}}),
  lender('no-budget-lender', [agent('codex', [{model: 'budget-less', effort: 'low'}])], {capabilities: [MODEL_EFFORT_PAIRS_CAPABILITY]}),
];
// The coordinator answers /presence with these rows; every other route keeps the shared fixture's behavior.
async function withPresence(f, rows) {
  const original = f.override;
  f.override = async args => {
    if (args.route === '/presence') {
      json(args.res, {now: new Date().toISOString(), online_seconds: 90, persons: [], devices: rows});
      return true;
    }
    return original(args);
  };
}
const composeState = (owner, circle) => api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');

test('compose offers come from the presence rows the coordinator returns, and the offers name no lender', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  await withPresence(f, presenceRows());
  const state = await composeState(owner, circle);
  assert.deepEqual(state.offers, [
    {harness: 'codex', model: 'example-model', effort: 'low'},
    {harness: 'codex', model: 'other-model', effort: 'medium'},
    {harness: 'claude-code', model: 'claude-opus-5-5', effort: 'medium'},
  ], 'one entry per pair; api-key, signed-out, stale, paused and budget-less lenders offer nothing');
  assert.doesNotMatch(JSON.stringify(state.offers), /lender|sha256|label|keyId|device/, 'no lender identity in the offers');
});

test('the compose response joins no pair to a lender: each lenders[] agent is its adapter and readiness only', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  await withPresence(f, presenceRows());
  const state = await composeState(owner, circle);
  assert.deepEqual(state.lenders.find(l => l.keyId === 'lender-a').agents, [
    {adapter: 'codex', readiness: 'ready'}, {adapter: 'claude-code-api-key', readiness: 'ready'}]);
  for (const l of state.lenders) for (const entry of l.agents) assert.deepEqual(Object.keys(entry).sort(), ['adapter', 'readiness']);
  assert.doesNotMatch(JSON.stringify(state.lenders), /example-model|other-model|claude-opus-5-5|polled-model|paused-model|budget-less/,
    'no pair a lender runs appears in the lender list, so no response entry links a pair to a lender');
});

test('offers read from the real store: fresh hand-built heartbeats offer their pairs, and the same heartbeats after 91 seconds offer nothing', testOptions, async t => {
  const f = await realLenderFixture(t, {offers: true, members: true});
  const heartbeat = (client, boot, model_efforts) => client.heartbeat({boot, seq: 1, intent: {state: 'ready'}, execution: {state: 'idle'},
    blockers: [], agents: [{adapter: 'codex', readiness: 'ready', models: ['example-model', 'other-model'], per_job_max_minutes: 2, model_efforts}],
    capabilities: ['budget_v1', MODEL_EFFORT_PAIRS_CAPABILITY]});
  await heartbeat(f.client, 'offers-a', [{model: 'example-model', effort: 'low'}]);
  await heartbeat(f.clientFor(3), 'offers-b', [{model: 'other-model', effort: 'low'}, {model: 'example-model', effort: 'high'}]);
  const fresh = await f.owner.fetchPresence();
  assert.ok(fresh.devices.some(d => d.source === 'heartbeat'), 'the coordinator reads both heartbeats as fresh');
  assert.deepEqual(appModule.modelEffortOffers(fresh).map(o => [o.harness, o.model, o.effort]),
    [['codex', 'example-model', 'low'], ['codex', 'other-model', 'low'], ['codex', 'example-model', 'high']]);
  f.clock.advance(91000);
  const stale = await f.owner.fetchPresence();
  assert.ok(stale.devices.every(d => !d.online), 'no lender is online after 91 seconds without a heartbeat');
  assert.ok(stale.devices.some(d => d.agents.length > 0), 'the stale agents remain on the page, so the projection must drop them');
  assert.deepEqual(appModule.modelEffortOffers(stale), []);
});

test('a job sent with a chosen pair is admitted only to a hand-built advertisement that carries that pair', testOptions, async t => {
  // The composer's body goes through the app's submit path; the requirements it signs are what the store gates on.
  const app = await appFixture(t), {owner, circle} = await app.connect();
  const ui=await browserApi(owner.app);
  const body = draftBody({id: 'draft-pair-0001', prompt: 'Synthetic pair check', sourceKind: 'none', agent: 'codex', model: 'example-model', effort: 'low'}, circle.id);
  const sent = await ui('/api/jobs', {method: 'POST', body});
  const signed = app.jobs.get(sent.jobDigest).job.payload;
  assert.deepEqual(signed.requirements.harness, ['codex']);
  assert.deepEqual(signed.requirements.model, {any_of: ['example-model']});
  assert.deepEqual(signed.budget_v1, {effort: 'low'});

  // The store admits the claim only when the lender's advertisement offers the same pair.
  const f = await realLenderFixture(t, {offers: true, members: true, mutateJob: job => {
    job.expires_at = new Date(Date.parse(job.created_at) + 3600000).toISOString().replace('.000Z', 'Z');
    // The app asks for a 20-minute wall, which this fixture backend (capped at 10 minutes) cannot run. The job keeps
    // the fixture's own limits, so the harness, model and budget the app signed are the only inputs the lenders differ on.
    job.requirements = {...structuredClone(signed.requirements), limits: structuredClone(job.requirements.limits)};
    job.budget_v1 = structuredClone(signed.budget_v1);
    // The protocol ties a typed result to results_v1 in the requirements, so the body carries the same result.
    if(signed.result!==undefined)job.result=structuredClone(signed.result);
    else delete job.result;
  }});
  const req = f.job.payload.requirements, report = f.backend.lenderCapabilities();  const advertisement = pairs => ({harnesses: ['codex'], models: [...new Set(pairs.map(p => p.model))],
    capabilities: [...new Set([...req.capabilities, MODEL_EFFORT_PAIRS_CAPABILITY])], egress: report.egress,
    enforced_limits: report.enforced_limits, max_limits: report.max_limits,
    model_efforts: pairs.map(p => ({harness: 'codex', ...p}))});
  const heartbeat = (client, boot, pairs) => client.heartbeat({boot, seq: 1, intent: {state: 'ready'}, execution: {state: 'idle'}, blockers: [],
    agents: [{adapter: 'codex', readiness: 'ready', models: ['example-model', 'other-model'], per_job_max_minutes: 2, model_efforts: pairs}],
    capabilities: ['budget_v1', MODEL_EFFORT_PAIRS_CAPABILITY]});
  const offering = [{model: 'example-model', effort: 'low'}], other = [{model: 'other-model', effort: 'low'}, {model: 'example-model', effort: 'high'}];
  await heartbeat(f.client, 'pair-lender-a', offering);
  const decoy = f.clientFor(3);
  await heartbeat(decoy, 'pair-lender-b', other);
  await assert.rejects(decoy.claimJob(f.jobDigest, advertisement(other), {leaseSeconds: 120, idempotencyKey: 'pair-decoy'}),
    error => error.code === 'requirements_unsupported', 'a lender that does not offer the pair is refused');
  // The store does not report which check refused the claim. The same check names the reason: only the pair fails.
  assert.deepEqual(protocol.canSatisfy(req, advertisement(other), {job: f.job.payload}).unmet, ['model_effort']);
  assert.equal(protocol.canSatisfy(req, advertisement(offering), {job: f.job.payload}).ok, true);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
  const claimed = await f.client.claimJob(f.jobDigest, advertisement(offering), {leaseSeconds: 120, idempotencyKey: 'pair-offering'});
  assert.equal(claimed.attempt.holder, vectors.keys[1].fingerprint, 'the lender that offers the pair holds the attempt');
  // The pair the job used is one the composer would offer, and the offers name no lender.
  const offers = appModule.modelEffortOffers(await f.owner.fetchPresence());
  assert.ok(offers.some(o => o.harness === 'codex' && o.model === 'example-model' && o.effort === 'low'));
});

test('a model with a blank effort is not sent when the offers name it only at other efforts', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  await withPresence(f, [lender('lender-a', [agent('codex', [{model: 'other-model', effort: 'medium'}])])]);
  const state = await composeState(owner, circle);
  assert.deepEqual(state.offers, [{harness: 'codex', model: 'other-model', effort: 'medium'}]);
  const vm = choice => composeVM({prompt: 'Synthetic pair check', repo: {status: 'ok', info: {path: '/synthetic/project', name: 'project',
    branch: 'main', head: 'a'.repeat(40), files: 2, changed: [], changed_count: 0}}, circle: {id: circle.id, name: 'Synthetic friends', state},
    choice, draftSaved: true, now: Date.now(), zone: 'UTC'});
  assert.equal(vm({agent: 'codex', model: 'other-model', effort: ''}).send.why, 'Choose an effort for other-model',
    'a model is sent with its effort, so the composer asks for one');
  assert.equal(vm({agent: 'codex', model: 'other-model', effort: 'medium'}).send.disabled, false, 'the offered pair can be sent');
});
