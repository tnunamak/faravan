import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, browserApi, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';

import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {HOST_CAPABILITIES, MODEL_EFFORT_PAIRS_CAPABILITY} from '../lib/v1/versions.mjs';

import {draftBody} from '../ui/v1/src/compose-draft.mjs';

// Producer to consumer. The lender's own heartbeat writer is the producer: its real body becomes the presence row that
// the composer reads. A pair offered by that row must be one the lender would claim and run.
const testOptions = {timeout: 120000};

// Every heartbeat body the coordinator receives, with the key that signed it.
function captureHeartbeats(f) {
  const beats = [];
  const original = f.override;
  f.override = async args => {
    if (args.route === '/heartbeat') beats.push({signer: JSON.parse(Buffer.from(args.req.headers['faravan-proof'], 'base64url')).payload.key_id, body: args.body});
    return original(args);
  };
  return beats;
}

// The composer's offers when the coordinator's presence page carries this heartbeat body as the lender's row. Intent is
// fixed to ready: these tests are about the agents a lender publishes, not about whether lending is switched on.
async function composerOffers(f, owner, circle, body) {
  const original = f.override;
  f.override = async args => {
    if (args.route === '/presence') {
      json(args.res, {now: new Date().toISOString(), online_seconds: 90, persons: [], devices: [
        {device: 'lender-under-test', online: true, source: 'heartbeat', intent: {state: 'ready'}, capabilities: body.capabilities, agents: body.agents}]});
      return true;
    }
    return original(args);
  };
  return (await api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose')).offers;
}

test('a lender whose backend cannot stop a job publishes no effort pairs', testOptions, async t => {
  const f = await appFixture(t), beats = captureHeartbeats(f);
  // Effort jobs need budget_v1, and a quota lender advertises it only with a stop control. Without one, no pair is publishable.
  const backend = syntheticBackend(f.root, {});
  delete backend.requestStop;
  const {owner, lender, circle} = await f.connect({heartbeatMs: 100, backend, codexRun: {model_efforts: [{model: 'example-model', effort: 'low'}]}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const {body} = await waitFor(() => beats.findLast(b => b.signer === lender.app.device.keyId && b.body.agents?.some(a => a.adapter === 'codex')),
    'codex heartbeat', 15000);
  assert.equal(body.agents.find(a => a.adapter === 'codex').model_efforts, undefined, 'no pair is published without a stop control');
  assert.ok(!body.capabilities.includes(MODEL_EFFORT_PAIRS_CAPABILITY), 'and the lender does not declare the pair capability');
  assert.deepEqual(await composerOffers(f, owner, circle, body), []);
});

// The lender as the app runs it: createLender over the fixture's client, backend and policy.
function launch(f) {
  const controller = new AbortController();
  let failure;
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: () => {}});
  const running = Promise.resolve(lender.start(controller.signal)).catch(error => { failure = error; });
  return async () => {
    controller.abort();
    await running;
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
}

test('a job the composer signs for a pair is claimed and run by a lender at that pair effort', testOptions, async t => {
  // The composer's body becomes the signed job through the app. The lender then claims it with its own advertisement.
  const app = await appFixture(t), {owner, circle} = await app.connect();
  const ui=await browserApi(owner.app);
  const body = draftBody({id: 'draft-pair-run-0001', prompt: 'Synthetic pair run', sourceKind: 'none', agent: 'codex', model: 'other-model', effort: 'high'}, circle.id);
  const sent = await ui('/api/jobs', {method: 'POST', body});
  const signed = app.jobs.get(sent.jobDigest).job.payload;
  assert.deepEqual(signed.runRequest,{schemaVersion:1,models:[{providerId:'codex',modelId:'other-model'}],effortId:'high'});

  const f = await lenderFixture(t, {harness: 'codex', offers: true,
    run: {model_efforts: [{model: 'example-model', effort: 'low'}, {model: 'other-model', effort: 'high'}]},
    mutateJob: job => {
      // The fixture backend caps wall time below the composer's request, so the job keeps the fixture's own limits.
      job.requirements = {...structuredClone(signed.requirements), limits: structuredClone(job.requirements.limits)};
      job.runRequest = structuredClone(signed.runRequest);
      if (signed.result !== undefined) job.result = structuredClone(signed.result);
      else delete job.result;
    }});
  f.runOptions.runAccounts=()=>[{accountId:'fixture-account',providerId:'codex',models:[{id:'other-model',enabled:true,efforts:[{id:'high'}],defaultEffort:null}]}];
  // The host must declare the pair capability, or the lender advertises no pair and other-model is never claimed. The lender
  // takes offers from the coordinator's offer list, so this fake serves the job that way, as v1-lender-offers.test.mjs does.
  const offerHost = [...HOST_CAPABILITIES, MODEL_EFFORT_PAIRS_CAPABILITY, 'offers_v1'];
  let offered = false;
  f.client.capabilities = async () => ({artifact_head: false, faravan: null, min_member: null, capabilities: offerHost});
  f.client.listOffers = async function* () {
    if (!offered) yield {job_digest: f.jobDigest, job: f.job, state: 'queued', published_at: '2026-10-09T12:00:00Z', current_attempt: null};
  };
  f.client.claimJob = async (_digest, advertisement, opts) => { offered = true; return f.client.claimNext(advertisement, {...opts, waitSeconds: 0}); };
  // A quota lender can stop a job; the fixture backend has no stop control, and budget_v1 needs one.
  f.backend.requestStop = async () => ({delivered: false});
  let entrypoint;
  const admit = f.backend.admitJob.bind(f.backend);
  f.backend.admitJob = async spec => { entrypoint = spec.entrypoint; return admit(spec); };
  const stop = launch(f);
  try {
    await until(() => entrypoint !== undefined, 'the lender admitted the composer job', 30000);
    assert.ok(entrypoint.includes("'-m' 'other-model' '-c' 'model_reasoning_effort=high'"), entrypoint);
  } finally {
    await stop();
  }
});
