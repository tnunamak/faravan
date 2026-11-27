import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {meteringSandbox} from './helpers/pace50-app-sandbox.mjs';

const evidence = source => ({source, account_week_id: 'synthetic-week-1'});
const state = home => JSON.parse(fs.readFileSync(join(home, 'v1/lending-pace50-state.json'), 'utf8'));
const job = (circle, harness = 'codex') => ({circle: circle.id, git: 'https://github.com/example/synthetic.git',
  commit: '1'.repeat(40), prompt: 'Synthetic independent safety probe. No external execution.', harness});
async function enable(lender, circle, harness = 'codex') {
  const provider=harness==='codex'?'codex':'claude';
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy:{providerConsent:{[provider]:true}}}});
  await api(lender.app, `/api/agents/${harness}`, {method: 'POST', body: {useForLending: true}});
  if(harness!=='codex')await api(lender.app, `/api/agents/${harness}/run`, {method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const effects = () => ({arm_cessation_deadline: async () => () => {}, launch_chunk: async () => {},
  open_short_window: async () => {}, cancel_pending_attempt: async () => {}, request_cessation: async () => {},
  request_fresh_complete_reconciliation: async () => {}});

test('real app must not run the backend after its deadline arm failed', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  const source = createSyntheticPace50Source({start: Date.now()});
  let arms = 0;
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 500,
    lendingPace50: {...evidence(source), effects: {...effects(), arm_cessation_deadline: async () => {
      arms++; throw new Error('injected arm failure');
    }}}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: job(circle)});
  await enable(lender, circle);
  await waitFor(() => arms > 0, 'failed arm', 30000);
  await waitFor(() => state(lender.home).attempts[0]?.process_state==='ceased', 'ceased refusal', 30000);
  await waitFor(()=>[...f.jobs.values()].some(v=>v.state==='queued'),'job requeued after refusal',30000);
  const runs = backend.calls.filter(([kind]) => kind === 'run').length;
  console.log(JSON.stringify({probe: 'app-arm', arms, runs, attempt: state(lender.home).attempts[0]}));
  assert.equal(runs, 0, 'an unarmed, unauthorized attempt must not reach the actual backend');
});

test('real app must retain metered spend when the provider run fails', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const backend = meteringSandbox(f.root, {source, tokens: {input: 1200, output: 300}, cost_usd: 2.5, model: 'claude-haiku-5-5'});
  const start = backend.start.bind(backend);
  backend.start = async (handle, options) => {const result = await start(handle, options);
    if (options?.lendingBudget) throw Object.assign(new Error('injected failure after usage'), {code: 'execution_failed'});
    return result;
  };
  const adapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
    harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
  const {owner, lender, circle} = await f.connect({backend, adapters, shutdownProofMs: 500, lendingPace50: evidence(source)});
  await api(owner.app, '/api/jobs', {method: 'POST', body: job(circle, 'claude-code-subscription')});
  await enable(lender, circle, 'claude-code-subscription');
  await waitFor(() => state(lender.home).attempts[0]?.process_state === 'ceased', 'cleanup settlement', 30000);
  const ledger = state(lender.home).attempts[0].resources.find(r => r.kind === 'weekly');
  console.log(JSON.stringify({probe: 'app-error-spend', actualSpend: source.state.used.weekly - 20000000, ledger}));
  assert.ok(source.state.used.weekly - 20000000 >= 125000, 'the provider paid at least the metered burn; the double also moves on each conversion');
  assert.ok(ledger.spent_micro + ledger.settled_micro + ledger.held_micro >= 125000, 'the paid burn must remain accounted');
});

test('real app shutdown bound must cover recovery callbacks as well as the lender loop', {timeout: 60000}, async t => {
  const f = await appFixture(t, {hold: true});
  const backend = syntheticBackend(f.root, {hold: true});
  const source = createSyntheticPace50Source({start: Date.now()});
  let unblockCancel, unblockRecovery, recoveryEntered;
  const cancellation = new Promise(resolve => {unblockCancel = resolve;});
  const recovery = new Promise(resolve => {unblockRecovery = resolve;});
  const entered = new Promise(resolve => {recoveryEntered = resolve;});
  const cancel = backend.cancel.bind(backend);
  backend.cancel = async handle => {await cancellation; return cancel(handle);};
  const {owner, lender, circle} = await f.connect({backend, shutdownProofMs: 100,
    lendingPace50: {...evidence(source), effectOverrides: {request_cessation: async () => {
      recoveryEntered(); await recovery;
    }}}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: job(circle)});
  await enable(lender, circle);
  await waitFor(() => backend.calls.some(([kind]) => kind === 'run'), 'running job', 30000);
  const closing = lender.app.close();
  await entered;
  let timer;
  const outcome = await Promise.race([closing.then(() => 'closed'), new Promise(resolve => {
    timer = setTimeout(() => resolve('blocked'), 300);
  })]);
  clearTimeout(timer); unblockRecovery(); unblockCancel(); backend.release();
  // close() stops waiting for the lending loop once the shutdown bound passes, so the loop keeps writing into the
  // lender's data directory after the callbacks are released. Wait for it before the fixture removes that directory.
  const closed = await closing;
  await closed.lending_loop_settled;
  console.log(JSON.stringify({probe: 'app-close', shutdownProofMs: 100, outcomeAfterRecoveryMs: 300, outcome}));
  assert.equal(outcome, 'closed', 'recovery must not bypass the shutdown bound');
});

test('R3 full app holds exposure when its last guard event contains no usage', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now()});
  const backend = meteringSandbox(f.root, {source, tokens: {input: 1200, output: 300}, cost_usd: 2.5, model: 'claude-haiku-5-5'});
  const start = backend.start.bind(backend);
  backend.start = async (handle, options) => {const result = await start(handle, options?.lendingBudget ? {...options,onMeter:()=>{}} : options);
    if (options?.lendingBudget) { const result = {stop:null,meter:{type:'meter',seq:1,at:new Date().toISOString(),source:'claude-stream',model:'claude-haiku-5-5',tokens:{input:0,cached_input:0,output:0,reasoning_output:0},windows:[],cost_usd:null,final:false}}; options.onMeter?.(result.meter); return result; }
    return result;
  };
  const adapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
    harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
  const {owner, lender, circle} = await f.connect({backend, adapters, shutdownProofMs: 500, lendingPace50: evidence(source)});
  await api(owner.app, '/api/jobs', {method: 'POST', body: job(circle, 'claude-code-subscription')});
  await enable(lender, circle, 'claude-code-subscription');
  // Corrected wait (see original-probes-disposition.md): an unreported run is never ceased, so the wait is for the lender to record
  // the finish as unreported. The assertions below are the reviewer's, unchanged.
  await waitFor(() => state(lender.home).attempts[0]?.usage_unknown === 'claude', 'finish recorded as unreported', 30000);
  const ledger = state(lender.home).attempts[0].resources.find(r => r.kind === 'weekly');
  console.log(JSON.stringify({probe: 'app-empty-meter', actualSpend: source.state.used.weekly - 20000000, ledger}));
  assert.ok(source.state.used.weekly - 20000000 >= 125000, 'the provider paid at least the metered burn; the double also moves on each conversion');
  assert.ok(ledger.spent_micro + ledger.settled_micro + ledger.held_micro >= 125000, 'the paid burn must remain accounted');
});

