import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';

// Negative admission boundaries through the real store, client and lender.
// The app/broker-backed positive journey is in account-authority-integration.
const CAP = 'run_request_v1';
const account = (accountId, providerId, models) => ({accountId, providerId, models});
const model = (id, efforts, defaultEffort = null) => ({id, enabled: true, efforts: efforts.map(effort => ({id: effort})), defaultEffort});
// The lender runs the codex adapter, so only a codex account can run a request. Another provider's account is advertised but never used.
const ACCOUNTS = [account('acct-other', 'provider-y', [model('m-large', ['high'], 'high')]),
  account('acct-a', 'codex', [model('gpt-6-luna', ['low'], 'low'), model('gpt-6-sol', ['low', 'high'], 'low')])];

const options = request => ({offers: true, run: {model: 'gpt-6-sol', effort: 'high'}, mutateJob: job => {
  job.expires_at = new Date(Date.parse(job.created_at) + 3600000).toISOString().replace('.000Z', 'Z');
  job.requirements.harness = ['codex']; delete job.requirements.model;
  job.requirements.capabilities = [...new Set([...job.requirements.capabilities, CAP])];
  job.runRequest = request;
}});
async function setup(t, request, accounts = ACCOUNTS, extra = {}) {
  const f = await realLenderFixture(t, options(request));
  f.backend.requestStop = async () => ({compute_stopped: true});
  await f.client.heartbeat({boot: 'run-request', seq: 0, intent: {state: 'ready'}, execution: {state: 'idle'}, blockers: [],
    agents: [{adapter: 'codex', readiness: 'ready', models: ['m'], per_job_max_minutes: 2}], capabilities: [CAP], accounts});
  const c = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    ...extra,...(extra.accountExecution?{accountExecution:{...f.runOptions.accountExecution,...extra.accountExecution}}:{}),
    approve: async () => true, runAccounts: () => accounts, onEvent: e => f.events.push(e)});
  const loop = lender.start(c.signal);
  t.after(async () => {c.abort(); await Promise.race([loop.catch(() => {}), new Promise(r => setTimeout(r, 2000))]);});
  f.lender=lender;
  return f;
}
const ended = (f, ms = 20000) => until(() => f.events.some(e => ['finished', 'declined', 'failed'].includes(e.status)), 'the job ended', ms);

test('account metadata without a broker execution path cannot authorize a run', {timeout:60000}, async t=>{
  const f=await setup(t,{schemaVersion:1,models:'any',effortId:'high'});
  await ended(f);
  assert.ok(!f.events.some(e=>e.status==='finished'));
  assert.equal(f.calls.filter(([kind])=>['admit','prepare','run'].includes(kind)).length,0);
  assert.notEqual((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
});

test('a model no account offers is refused, never run on another account', {timeout: 60000}, async t => {
  const f = await setup(t, {schemaVersion: 1, models: [{providerId: 'provider-z', modelId: 'm-none'}], effortId: null});
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.ok(!f.events.some(e => ['finished', 'working', 'claimed'].includes(e.status)), 'no run started: ' + JSON.stringify(f.events.slice(-3)));
  const view = await f.owner.getJob(f.jobDigest);
  assert.equal(view.state, 'queued', 'the job stays queued; it is never run on an account that does not match');
  assert.equal(view.current_attempt, null);
});

for(const effortId of ['high',null])test('effective effort above the owner cap is refused before reservation or admission: '+String(effortId),{timeout:60000},async t=>{
  const accounts=[account('acct-a','codex',[model('gpt-6-sol',['low','high'],'high')])];
  const f=await setup(t,{schemaVersion:1,models:'any',effortId},accounts,
    {accountExecution:{wrap(){assert.fail('cap must be checked before account launch');}}});
  f.policy.lendingRuntime.effortMax=()=> 'low';
  await ended(f);
  assert.equal(f.calls.filter(([kind])=>['admit','prepare','run'].includes(kind)).length,0);
  assert.ok(!f.events.some(e=>e.status==='finished'));
  assert.notEqual((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
});

test('only the adapter\'s own provider can run a request: an advertised account of another provider is never used', {timeout: 60000}, async t => {
  const f = await setup(t, {schemaVersion: 1, models: 'any', effortId: null}, [ACCOUNTS[0]], {
    accountExecution:{availability:async({providerIds})=>{assert.deepEqual(providerIds,['codex']);assert.equal(ACCOUNTS[0].providerId,'provider-y');return {decision:{kind:'hold',code:'no_accounts',nextAction:{id:'add_account',label:'Add an agent account',target:{}}},accountIds:[]};},wrap(){assert.fail('the wrong provider must not reach launch');}},
  });
  // No own-provider account means this worker cannot advertise capacity or claim a job.
  await until(()=>f.lender.admits()==='no_accounts','the worker holds without an eligible account');
  assert.ok(!f.events.some(e => ['claimed', 'working', 'finished'].includes(e.status)));
  assert.equal(f.calls.filter(([kind]) => ['admit', 'prepare', 'run'].includes(kind)).length, 0);
  const view = await f.owner.getJob(f.jobDigest);
  assert.equal(view.state, 'queued');
  assert.equal(view.current_attempt, null);
});
