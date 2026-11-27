import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {access, rm} from 'node:fs/promises';
import {createLender} from '../lib/v1/lender.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {currentPriceCatalog, setLiveListPrices} from '../lib/v1/lending-meter.mjs';
import {supportedAutoIntents, listPriceSnapshot} from '../lib/v1/auto-run-selection.mjs';

// "Cheapest that fits" and "Strongest offered": the lender chooses one exact pair before pricing the job, keeps it with the
// claim, and runs, prices and reports that same pair. These tests use the real store, client and lender with a fake sandbox.
const CAP = 'auto_run_v1';
const luna = effort => ({model: 'gpt-6-luna', effort}), sol = effort => ({model: 'gpt-6-sol', effort}), astra = effort => ({model: 'gpt-6-astra', effort});
const run = pairs => ({model: 'gpt-6-sol', effort: 'high', model_efforts: pairs});

function launch(t, f, approve = async () => true, c = new AbortController(), controls = {}) {
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock, approve, onEvent: e => f.events.push(e)});
  const timers = controls.timers ?? {setTimeout, clearTimeout};
  let outcome;
  const settled = (controls.start ? controls.start(c.signal) : lender.start(c.signal)).then(
    () => (outcome = {ok: true}),
    error => (outcome = {ok: false, error, expected: c.signal.aborted && error === c.signal.reason}));
  f.assertLoopHealthy = () => {
    if (outcome && !outcome.ok && !outcome.expected) throw outcome.error;
  };
  let stopping;
  f.stop = () => stopping ??= (async () => {
    c.abort();
    let watchdog;
    try {
      const outcome = await Promise.race([settled, new Promise((_, reject) => {
        watchdog = timers.setTimeout(() => reject(new Error('auto-run lender did not settle after abort')), 2000);
      })]);
      if (!outcome.ok && !outcome.expected) throw outcome.error;
    } finally { timers.clearTimeout(watchdog); }
  })();
  return {stop: f.stop, reconfigure: () => lender.reconfigure()};
}
async function waitFor(f, check, label, ms = 20000) {
  await until(() => {f.assertLoopHealthy?.(); return check();}, label, ms);
  f.assertLoopHealthy?.();
}
const setCap = (f, cap) => {
  f.policy.lendingRuntime.effortMax = () => cap;
  const candidate = f.policy.lendingRuntime.candidate, reserve = candidate.reserve.bind(candidate);
  candidate.reserve = async args => {const out = await reserve(args); return out.ok ? {...out, decision: {effort_max: cap}} : out;};
};
function spy(f) {
  const seen = {gate: [], reserve: []};
  const candidate = f.policy.lendingRuntime.candidate, gate = candidate.gate.bind(candidate), reserve = candidate.reserve.bind(candidate);
  // Only checks for this job count; the lender also checks its allowance in general, with no job.
  candidate.gate = async args => {if (args.job) seen.gate.push(args.model); return gate(args);};
  candidate.reserve = async args => {seen.reserve.push(args.model); return reserve(args);};
  // The agent's command line, as the sandbox was asked to run it.
  Object.defineProperty(seen, 'entrypoints', {get: () => [...new Set(f.calls.filter(([kind]) => kind === 'admit' || kind === 'prepare').map(([, spec]) => spec.entrypoint))]});
  return seen;
}
const autoOptions = (pairs, intent, extra = {}) => ({offers: extra.offers ?? true, run: run(pairs), mutateJob: job => {
  job.expires_at = new Date(Date.parse(job.created_at) + 3600000).toISOString().replace('.000Z', 'Z');
  job.requirements.harness = ['codex']; delete job.requirements.model;
  job.requirements.capabilities = [...new Set([...job.requirements.capabilities, CAP])];
  job.auto_run_v1 = {intent};
}});
// The result goes through the real host, which checks the receipt against the signed job before it accepts it.
async function finished(f, ms = 20000) {
  try {await waitFor(f, () => f.events.some(e => e.status === 'finished' || e.status === 'declined' || e.status === 'failed'), 'the job ended', ms);}
  catch (error) {error.events = f.events.slice(-6); throw error;}
  assert.ok(f.events.some(e => e.status === 'finished'), JSON.stringify(f.events.filter(e => e.status === 'declined' || e.status === 'failed')));
  const view = await f.owner.getJob(f.jobDigest);
  assert.equal(view.state, 'result-accepted', 'the host accepted the result');
  return (await f.owner.fetchResult(f.jobDigest, {includeMetadata: true, attempt: view.current_attempt})).receipt;
}
const heartbeat = (f, pairs, capabilities = ['budget_v1', 'model_effort_pairs_v1', CAP]) => f.client.heartbeat({boot: 'auto-run', seq: 0, intent: {state: 'ready'},
  execution: {state: 'idle'}, blockers: [], agents: [{adapter: 'codex', readiness: 'ready', models: [...new Set(pairs.map(p => p.model))], per_job_max_minutes: 2, model_efforts: pairs,
  ...(capabilities.includes(CAP) ? {auto_run_intents: supportedAutoIntents({pairs, prices: listPriceSnapshot()})} : {})}], capabilities});
async function setup(t, pairs, intent, {cap = 'high', offers = true, policy} = {}) {
  const f = await realLenderFixture(t, {...autoOptions(pairs, intent, {offers}), ...(policy ? {policy} : {})});
  setCap(f, cap);
  f.backend.requestStop = async () => ({compute_stopped: true});
  await heartbeat(f, pairs);
  return f;
}

test('cheapest runs the cheapest eligible pair, not the lender default, and gate, reserve and flags agree', {timeout: 60000}, async t => {
  const pairs = [sol('high'), sol('medium'), luna('medium'), luna('low')];
  const f = await setup(t, pairs, 'cheapest'), seen = spy(f);
  launch(t, f);
  const receipt = await finished(f);
  assert.ok(seen.gate.length >= 1 && seen.gate.every(model => model === 'gpt-6-luna'), 'every allowance check priced the chosen model: ' + seen.gate);
  assert.deepEqual(seen.reserve, ['gpt-6-luna'], 'the reservation held the chosen model');
  assert.equal(seen.entrypoints.length, 1);
  assert.match(seen.entrypoints[0], /'-m' 'gpt-6-luna'/);
  assert.match(seen.entrypoints[0], /'model_reasoning_effort=low'/);
  assert.deepEqual({...receipt.auto_run_v1, pricing_revision: typeof receipt.auto_run_v1.pricing_revision}, {intent: 'cheapest', model: 'gpt-6-luna', effort: 'low',
    rule_version: 'auto-run-v1', reason: 'lowest_list_price', capped: false, pricing_revision: 'string'});
  assert.ok(receipt.capabilities_applied.includes(CAP));
  assert.equal(receipt.budget_v1, undefined, 'no budget is invented for an automatic job');
});

test('strongest runs the highest-ranked pair the effort cap allows and says it was capped', {timeout: 60000}, async t => {
  const pairs = [luna('low'), sol('medium'), sol('high'), astra('high')];
  const f = await setup(t, pairs, 'strongest', {cap: 'medium'}), seen = spy(f);
  // The advertisement already leaves out pairs above the cap, so the strongest model with an eligible pair is sol.
  launch(t, f);
  const receipt = await finished(f);
  assert.ok(seen.gate.length >= 1 && seen.gate.every(model => model === 'gpt-6-sol'), String(seen.gate));
  assert.match(seen.entrypoints[0], /'-m' 'gpt-6-sol'/);
  assert.match(seen.entrypoints[0], /'model_reasoning_effort=medium'/);
  const choice = receipt.auto_run_v1;
  assert.deepEqual([choice.intent, choice.model, choice.effort, choice.capped], ['strongest', 'gpt-6-sol', 'medium', true]);
});

test('the claim keeps the chosen pair, so a retry or a restart replays it and never chooses again', {timeout: 60000}, async t => {
  const pairs = [sol('high'), luna('low'), luna('medium')];
  const f = await setup(t, pairs, 'cheapest');
  launch(t, f);
  await waitFor(f, () => f.saves.some(saved => saved?.claimPending?.autoRun), 'the claim was saved with its choice', 20000);
  const saved = f.saves.find(entry => entry?.claimPending?.autoRun).claimPending;
  assert.deepEqual(saved.advertisement.model_efforts, [{harness: 'codex', ...luna('low')}], 'the claim names exactly one pair');
  assert.deepEqual([saved.autoRun.intent, saved.autoRun.model, saved.autoRun.effort], ['cheapest', 'gpt-6-luna', 'low']);
  assert.ok(!saved.advertisement.capabilities || saved.advertisement.capabilities.includes(CAP));
});

test('a cap lowered after the claim declines the job instead of running it above the cap', {timeout: 60000}, async t => {
  const pairs = [sol('high'), sol('medium'), sol('low')];
  const f = await setup(t, pairs, 'strongest', {cap: 'high'}), seen = spy(f);
  const claim = f.client.claimJob.bind(f.client);
  f.client.claimJob = async (...args) => {const out = await claim(...args); setCap(f, 'low'); return out;};
  launch(t, f);
  await waitFor(f, () => f.events.some(e => e.status === 'declined'), 'the claim was declined', 20000);
  assert.equal(f.events.find(e => e.status === 'declined').reason, 'requirements_unsupported');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 0);
  assert.deepEqual(seen.entrypoints, []);
});

test('a lender with no priced pair does not claim a cheapest job at all', {timeout: 30000}, async t => {
  const pairs = [{model: 'mystery-model', effort: 'low'}, {model: 'other-mystery', effort: 'medium'}];
  const f = await setup(t, pairs, 'cheapest');
  launch(t, f);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 0);
  assert.ok(!f.realRequests.some(r => /\/claim$/.test(r.url)), 'no claim was sent');
});

test('the blind claim path never takes an automatic job, so an older host or lender cannot run it as an explicit one', {timeout: 30000}, async t => {
  const pairs = [luna('low'), sol('high')];
  const f = await setup(t, pairs, 'cheapest', {offers: false});
  launch(t, f);
  await waitFor(f, () => f.realRequests.some(r => /claim-next/.test(r.url)), 'the lender polled for work', 20000);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued', 'the job waits for a lender that can choose');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 0);
});

test('a lender whose heartbeat does not name the capability is refused the claim by the host', {timeout: 30000}, async t => {
  const pairs = [luna('low')];
  const f = await realLenderFixture(t, autoOptions(pairs, 'cheapest'));
  await heartbeat(f, pairs, ['budget_v1', 'model_effort_pairs_v1']);
  const report = f.backend.lenderCapabilities();
  const req = f.job.payload.requirements;
  const advertisement = {harnesses: ['codex'], models: ['gpt-6-luna'], capabilities: [...new Set([...req.capabilities, 'model_effort_pairs_v1'])], egress: report.egress,
    enforced_limits: report.enforced_limits, max_limits: report.max_limits, model_efforts: [{harness: 'codex', ...luna('low')}]};
  await assert.rejects(f.client.claimJob(f.jobDigest, advertisement, {leaseSeconds: 120, idempotencyKey: 'auto-no-cap'}), error => error.code === 'requirements_unsupported');
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
});

const advertise = (f, pairs, claimPairs = pairs) => {
  const report = f.backend.lenderCapabilities(), req = f.job.payload.requirements;
  return {harnesses: ['codex'], models: [...new Set(pairs.map(p => p.model))], capabilities: [...new Set([...req.capabilities, 'model_effort_pairs_v1'])], egress: report.egress,
    enforced_limits: report.enforced_limits, max_limits: report.max_limits, model_efforts: claimPairs.map(p => ({harness: 'codex', ...p}))};
};
const beat = (f, agent, capabilities = ['budget_v1', 'model_effort_pairs_v1', CAP]) => f.client.heartbeat({boot: 'auto-intents', seq: 0, intent: {state: 'ready'},
  execution: {state: 'idle'}, blockers: [], agents: [{adapter: 'codex', readiness: 'ready', per_job_max_minutes: 2, ...agent}], capabilities});

test('the host holds a lender to the choices it said it can make: strongest is refused where only cheapest was advertised', {timeout: 30000}, async t => {
  const pairs = [luna('low')];
  const strongest = await realLenderFixture(t, autoOptions(pairs, 'strongest'));
  await beat(strongest, {models: ['gpt-6-luna'], model_efforts: pairs, auto_run_intents: ['cheapest']});
  await assert.rejects(strongest.client.claimJob(strongest.jobDigest, advertise(strongest, pairs), {leaseSeconds: 120, idempotencyKey: 'only-cheapest'}),
    error => error.code === 'requirements_unsupported');
  assert.equal((await strongest.owner.getJob(strongest.jobDigest)).state, 'queued');
  const cheapest = await realLenderFixture(t, autoOptions(pairs, 'cheapest'));
  await beat(cheapest, {models: ['gpt-6-luna'], model_efforts: pairs, auto_run_intents: ['cheapest']});
  const claimed = await cheapest.client.claimJob(cheapest.jobDigest, advertise(cheapest, pairs), {leaseSeconds: 120, idempotencyKey: 'cheapest-ok'});
  assert.equal(claimed.attempt.state, 'active');
});

test('a heartbeat that lists automatic choices needs the capability, and names only known choices', {timeout: 30000}, async t => {
  const pairs = [luna('low')], f = await realLenderFixture(t, autoOptions(pairs, 'cheapest'));
  const agent = intents => ({models: ['gpt-6-luna'], model_efforts: pairs, auto_run_intents: intents});
  await assert.rejects(beat(f, agent(['cheapest']), ['budget_v1', 'model_effort_pairs_v1']), error => error.code === 'invalid_request');
  await assert.rejects(beat(f, agent(['best'])), error => error.code === 'invalid_request');
  await assert.rejects(beat(f, agent(['cheapest', 'cheapest'])), error => error.code === 'invalid_request');
  await beat(f, agent([]));
});

// A later price change makes a re-choice differ: after this, luna is no longer the cheapest model on offer.
const makeLunaExpensive = () => setLiveListPrices({'gpt-6-luna': {provider: 'openai', fresh_input_per_m: 500, output_per_m: 500}});
const claimRequests = f => f.realRequests.filter(r => /\/claim$/.test(r.url));
const autoRunOf = f => f.saves.map(saved => saved?.claimPending?.autoRun ?? saved?.acceptedClaim?.intent?.autoRun).filter(Boolean);

test('prices that change while the allowance check waits do not change the priced pair', {timeout: 60000}, async t => {
  t.after(() => setLiveListPrices({}));
  const pairs = [sol('high'), luna('low')];
  const f = await setup(t, pairs, 'cheapest', {policy: {mode: 'auto'}}), seen = spy(f);
  f.policy.quota = () => ({provider: 'codex', remaining: 100, observedAt: f.clock.now()});
  const revisions = [], gate = f.policy.lendingRuntime.candidate.gate.bind(f.policy.lendingRuntime.candidate);
  f.policy.lendingRuntime.candidate.gate = async args => {
    if (args.job && !revisions.length) {revisions.push(currentPriceCatalog().revision); const out = await gate(args); makeLunaExpensive(); return out;}
    return gate(args);
  };
  launch(t, f);
  const receipt = await finished(f);
  assert.equal(revisions.length, 1, 'the allowance check ran once with the first prices');
  assert.ok(seen.gate.every(model => model === 'gpt-6-luna'), 'every allowance check priced the first choice: ' + seen.gate);
  assert.deepEqual(seen.reserve, ['gpt-6-luna']);
  const saved = autoRunOf(f);
  assert.ok(saved.length >= 1 && saved.every(entry => entry.model === 'gpt-6-luna' && entry.pricing_revision === revisions[0]), JSON.stringify(saved));
  assert.deepEqual([receipt.auto_run_v1.model, receipt.auto_run_v1.effort, receipt.auto_run_v1.pricing_revision], ['gpt-6-luna', 'low', revisions[0]]);
});

test('a card held for review keeps the pair that was priced for it when prices change while it waits', {timeout: 60000}, async t => {
  t.after(() => setLiveListPrices({}));
  const pairs = [sol('high'), luna('low')];
  const f = await setup(t, pairs, 'cheapest'), seen = spy(f);
  // A matching standing rule whose allowance reading is unknown is an objective hold: in ask mode it becomes a card, priced first.
  f.policy.standingRules = [{id: 'rule-1', circle: f.job.payload.circle, people: [f.job.payload.author], agents: ['codex'], maxWallSeconds: 300, dailyJobs: 10, weeklyJobs: 70,
    dailyMinutes: 60, weeklyMinutes: 420, expiresAt: f.clock.now() + 30 * 86400000}];
  let cards = 0, release;
  const waiting = new Promise(resolve => {release = resolve;});
  launch(t, f, async () => {cards++; await waiting; return true;});
  await waitFor(f, () => cards === 1, 'the card is waiting for a person', 20000);
  assert.deepEqual(seen.gate, ['gpt-6-luna'], 'the hold priced the cheapest pair');
  makeLunaExpensive();
  release();
  const receipt = await finished(f);
  assert.ok(seen.gate.every(model => model === 'gpt-6-luna'), 'every allowance check priced the first choice: ' + seen.gate);
  assert.deepEqual(seen.reserve, ['gpt-6-luna'], 'the reservation held the priced pair');
  assert.deepEqual([...new Set(autoRunOf(f).map(entry => entry.model + '/' + entry.effort))], ['gpt-6-luna/low'], 'the saved choice is the priced pair');
  assert.deepEqual([receipt.auto_run_v1.model, receipt.auto_run_v1.effort], ['gpt-6-luna', 'low']);
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
});

test('the host gives an automatic job to no blind claim, whatever the caller advertises', {timeout: 30000}, async t => {
  const pairs = [luna('low')];
  const f = await realLenderFixture(t, autoOptions(pairs, 'cheapest'));
  await heartbeat(f, pairs);
  const report = f.backend.lenderCapabilities(), req = f.job.payload.requirements;
  const advertisement = {harnesses: ['codex'], models: ['gpt-6-luna'], capabilities: [...new Set([...req.capabilities, 'model_effort_pairs_v1', CAP])], egress: report.egress,
    enforced_limits: report.enforced_limits, max_limits: report.max_limits, model_efforts: [{harness: 'codex', ...luna('low')}]};
  assert.equal(await f.client.claimNext(advertisement, {leaseSeconds: 120, waitSeconds: 0, idempotencyKey: 'blind-auto'}), null);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
});

test('a lost claim response is retried with the same pair and the same claim', {timeout: 60000}, async t => {
  t.after(() => setLiveListPrices({}));
  const pairs = [sol('high'), luna('low'), luna('medium')];
  const f = await setup(t, pairs, 'cheapest');
  const claim = f.client.claimJob.bind(f.client);
  let lost = 0;
  f.client.claimJob = async (...args) => {
    const out = await claim(...args);
    if (!lost++) {makeLunaExpensive(); setTimeout(() => f.clock.advance(1000), 100); throw Object.assign(new Error('the response was lost'), {code: 'network_error'});}
    return out;
  };
  launch(t, f);
  const receipt = await finished(f);
  assert.equal(lost, 2, 'the claim was sent again');
  const keys = f.saves.map(saved => saved?.claimPending?.idempotencyKey).filter(Boolean);
  assert.ok(keys.length >= 1 && new Set(keys).size === 1, 'one claim identity for every retry');
  const saved = autoRunOf(f);
  assert.ok(saved.every(entry => JSON.stringify(entry) === JSON.stringify(saved[0])), 'the saved choice never changed');
  assert.deepEqual([receipt.auto_run_v1.model, receipt.auto_run_v1.effort], ['gpt-6-luna', 'low']);
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
});

test('a second lender built from the saved state keeps the saved pair and the same claim', {timeout: 60000}, async t => {
  t.after(() => setLiveListPrices({}));
  const pairs = [sol('high'), luna('low'), luna('medium')];
  const f = await setup(t, pairs, 'cheapest');
  const claim = f.client.claimJob.bind(f.client), first = new AbortController();
  let crashed = false;
  f.client.claimJob = async (...args) => {
    const out = await claim(...args);
    if (!crashed) {crashed = true; first.abort(); throw Object.assign(new Error('the process ended'), {code: 'network_error'});}
    return out;
  };
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock, approve: async () => true, onEvent: e => f.events.push(e)});
  await lender.start(first.signal).catch(() => {});
  const before = f.saved();
  assert.ok(before.claimPending?.autoRun, 'the choice was saved before the claim was sent');
  const key = before.claimPending.idempotencyKey, record = structuredClone(before.claimPending.autoRun);
  makeLunaExpensive();
  launch(t, f);
  const receipt = await finished(f);
  assert.deepEqual(receipt.auto_run_v1, record, 'the second lender reports the saved choice');
  assert.ok(autoRunOf(f).every(entry => JSON.stringify(entry) === JSON.stringify(record)));
  assert.equal(f.saves.filter(saved => saved?.claimPending?.idempotencyKey && saved.claimPending.idempotencyKey !== key).length, 0, 'no second claim identity');
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
});

test('a lost real completion ACK replays the retained result without executing the automatic pair twice', {timeout: 60000}, async t => {
  const pairs = [sol('high'), luna('low')];
  const f = await setup(t, pairs, 'cheapest'), seen = spy(f);
  const lifecycle = [];
  const candidate = f.policy.lendingRuntime.candidate;
  for (const name of ['reserve', 'admitStart', 'started', 'recordCleanup', 'finish', 'settle']) {
    const original = candidate[name].bind(candidate);
    candidate[name] = async (...args) => {
      lifecycle.push({name, args: structuredClone(args)});
      return original(...args);
    };
  }
  const complete = f.client.completeAttempt.bind(f.client);
  const requests = [], responses = [];
  let retryEntered = false, release;
  const waiting = new Promise(resolve => {release = resolve;});
  t.after(() => release());
  f.client.completeAttempt = async (attempt, payload, options) => {
    requests.push({attempt: structuredClone(attempt), payload: structuredClone(payload), key: options.idempotencyKey});
    if (requests.length === 2) {
      retryEntered = true;
      await waiting;
    }
    const ack = await complete(attempt, payload, options);
    if (requests.length === 2) {
      const pending = f.saved().resultPending;
      assert.ok(pending, 'pending remains until genuine replay ACK is returned to the lender');
      assert.deepEqual([pending.attempt, pending.payload, pending.idempotencyKey], [attempt, payload, options.idempotencyKey]);
    }
    responses.push(structuredClone(ack));
    if (requests.length === 1)
      throw Object.assign(new Error('synthetic loss after real store committed'), {code: 'network_error'});
    return ack;
  };
  launch(t, f);
  const stop = f.stop;
  f.stop = () => {release(); return stop();};
  try {
    await waitFor(f, () => retryEntered, 'real completion committed and retained result reached recovery');
    assert.equal(responses.length, 1);
    const before = await f.owner.getJob(f.jobDigest);
    assert.equal(before.state, 'result-accepted', 'the genuine store committed before the reply was lost');
    const retained = structuredClone(f.saved().resultPending);
    assert.ok(retained, 'uncertain completion retains its exact result intent');
    assert.deepEqual(retained.attempt, requests[0].attempt);
    assert.deepEqual(retained.payload, requests[0].payload);
    assert.equal(retained.idempotencyKey, requests[0].key);
    assert.deepEqual(requests[1], requests[0], 'recovery reuses attempt, payload and request identity');
    assert.deepEqual([before.current_attempt.attempt_id, before.current_attempt.generation],
      [retained.attempt.attempt_id, retained.attempt.generation]);
    assert.equal(f.realRequests.filter(row => /\/complete$/.test(row.url)).length, 1,
      'retry has not transmitted while its real completion is held');
    assert.ok(!f.events.some(e => e.status === 'finished'));
    release();
    const receipt = await finished(f);
    await waitFor(f, () => f.saved().resultPending === null, 'real replay resolution clears pending result');
    await f.stop();
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[1], responses[0], 'genuine host replay acknowledges the original result');
    const transmissions = f.realRequests.filter(row => /\/complete$/.test(row.url));
    assert.equal(transmissions.length, 2);
    assert.deepEqual(transmissions.map(row => row.key), [retained.idempotencyKey, retained.idempotencyKey]);
    assert.match(transmissions[0].bodyDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(transmissions[1].bodyDigest, transmissions[0].bodyDigest);
    assert.deepEqual([receipt.auto_run_v1.model, receipt.auto_run_v1.effort], ['gpt-6-luna', 'low']);
    assert.equal(f.calls.filter(([kind]) => kind === 'prepare').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'destroy').length, 1);
    assert.equal(seen.entrypoints.length, 1);
    assert.match(seen.entrypoints[0], /'-m' 'gpt-6-luna'/);
    assert.match(seen.entrypoints[0], /'model_reasoning_effort=low'/);
    // destroy wrapper, returned cleanup receipt, and final durable-cleanup fence all record removal.
    assert.deepEqual(lifecycle.map(row => row.name),
      ['reserve', 'admitStart', 'started', 'recordCleanup', 'recordCleanup', 'finish', 'recordCleanup']);
    for (const row of lifecycle.filter(row => row.name === 'recordCleanup')) {
      assert.equal(row.args[0], retained.attempt.attempt_id);
      assert.equal(row.args[1].removed, true);
    }
    const finish = lifecycle.find(row => row.name === 'finish').args[0];
    assert.equal(finish.attemptId, retained.attempt.attempt_id);
    assert.deepEqual([finish.model, finish.effort], ['gpt-6-luna', 'low']);
    assert.equal(f.saved().resultPending, null);
    // Fake candidate lifecycle is not evidence of durable accounting or a monetary refund.
  } finally {release();}
});

for (const fault of ['stop failure', 'loop rejection', 'expected abort', 'missing abort', 'unsettled loop']) {
  test('actual auto-run teardown negative control: '+fault, {timeout:30000}, async t=>{
    const callbacks=[], runs=new Map();
    let f, releaseLoop, resources, originals, controller, controlledLoop, outerGuard, abortOwned;
    let rescued=false, suppressedAborts=0;
    const missingAbort=new Error('auto-run teardown did not cooperatively abort its controlled loop');
    const pending=new Map(), cleared=[];
    const timers={
      setTimeout(fn,ms){assert.equal(ms,2000);const key={};pending.set(key,fn);return key;},
      clearTimeout(key){cleared.push(key);pending.delete(key);},
    };
    const invoke=fn=>{
      if(!runs.has(fn))runs.set(fn,Promise.resolve().then(fn));
      return runs.get(fn);
    };
    const drain=async()=> {
      const results=[];
      for(const fn of [...callbacks].reverse()){
        try{await invoke(fn);results.push({ok:true});}
        catch(error){results.push({error});}
      }
      return results;
    };
    try {
      f=await realLenderFixture({after:fn=>callbacks.push(fn)},{publish:false,exposeTeardown:true});
      resources=f.teardownResources;
      const counts={handler:0,connections:0,server:0,store:0};
      originals={
        handler:resources.handler.close.bind(resources.handler),
        connections:resources.server.closeAllConnections.bind(resources.server),
        server:resources.server.close.bind(resources.server),
        store:f.store.close.bind(f.store),
      };
      resources.handler.close=(...args)=>{counts.handler++;return originals.handler(...args);};
      resources.server.closeAllConnections=(...args)=>{counts.connections++;return originals.connections(...args);};
      resources.server.close=(...args)=>{counts.server++;return originals.server(...args);};
      f.store.close=(...args)=>{counts.store++;return originals.store(...args);};
      const sentinel=new Error('owned teardown sentinel: '+fault);
      if(fault==='stop failure')f.stop=async()=>{throw sentinel;};
      else {
        controller=new AbortController();
        abortOwned=controller.abort.bind(controller);
        if(fault==='missing abort'){
          // Mutation of the actual launch.stop cancellation, not a copied cleanup.
          controller.abort=()=>{suppressedAborts++;};
        }
        const start=signal=>controlledLoop=(fault==='loop rejection'?Promise.reject(sentinel):
          fault==='unsettled loop'?new Promise(resolve=>{releaseLoop=resolve;}):
          new Promise((_,reject)=>{
            releaseLoop=reject;
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
          }));
        launch(t,f,async()=>true,controller,{start,timers});
        // Let the settled-loop observer publish its own outcome, not a later timeout.
        await Promise.resolve();
        if(fault==='loop rejection')
          await assert.rejects(waitFor(f,()=>true,'must not wait'),error=>error===sentinel);
      }
      if(fault==='expected abort'||fault==='missing abort'){
        // This real timer is independent of the intentionally inert stop watchdog.
        // Install rescue BEFORE drain can wait; settling the owned loop lets the
        // actual registered callbacks dispose handler/server/store/directories.
        outerGuard=setTimeout(()=>{rescued=true;releaseLoop(missingAbort);},500);
        const disarm=()=>clearTimeout(outerGuard);
        controlledLoop.then(disarm,disarm);
      }
      const cleanup=drain();
      if(fault==='unsettled loop'){
        // No global timer mock or wall-clock sleep: fire the actual stop watchdog.
        for(let turn=0;turn<20&&!pending.size;turn++)await Promise.resolve();
        assert.equal(pending.size,1,'teardown reached its bounded watchdog');
        [...pending.values()][0]();
      }
      const results=await cleanup;
      assert.deepEqual(counts,{handler:1,connections:1,server:1,store:1},
        'each counter delegates to the real resource close');
      assert.equal(resources.server.listening,false);
      await assert.rejects(access(resources.dir),{code:'ENOENT'});
      await assert.rejects(access(f.root),{code:'ENOENT'});
      assert.equal(pending.size,0);
      if(fault!=='stop failure')assert.equal(cleared.length,1,'watchdog cleared on success or rejection');
      if(fault==='expected abort'){
        assert.equal(rescued,false,'ordinary expected abort must settle without outer rescue');
        assert.equal(controller.signal.aborted,true,'ordinary stop actually aborted the owned controller');
        assert.equal(results.length,2);
        assert.ok(results.every(result=>result.ok),'cooperative abort, not a later watchdog, is success');
      } else if(fault==='missing abort'){
        assert.equal(suppressedAborts,1,'the real memoized stop attempted cancellation');
        assert.equal(controller.signal.aborted,false,'negative control suppressed cancellation');
        assert.equal(rescued,true,'independent real guard bounded the missing-abort observer');
        assert.equal(results.length,2);
        for(const result of results)assert.equal(result.error,missingAbort,
          'both actual cleanup callbacks preserve the specific missing-abort failure');
      } else if(fault==='unsettled loop'){
        assert.equal(results.length,2);
        for(const result of results)assert.match(result.error?.message??'',/auto-run lender did not settle after abort/);
        assert.equal(results[0].error,results[1].error,'memoized stop keeps the original watchdog failure');
      } else {
        assert.equal(results.length,2);
        for(const result of results)assert.equal(result.error,sentinel,'original failure, not a later timeout');
      }
    } finally {
      clearTimeout(outerGuard);
      abortOwned?.();
      releaseLoop?.(missingAbort);
      await controlledLoop?.catch(()=>{});
      // Clear only our scoped watchdogs, then always run every captured callback.
      for(const key of [...pending.keys()])timers.clearTimeout(key);
      if(f)f.stop=async()=>{};
      await drain();
      // Independent rescue for deliberately broken fail-fast cleanup or a failed assertion.
      // These are only fixture-owned resources; successful assertions happened before rescue.
      if(resources){
        await Promise.allSettled([
          Promise.resolve().then(()=>originals?.handler()),
          Promise.resolve().then(()=>originals?.connections()),
          Promise.resolve().then(()=>resources.server.listening?
            new Promise((resolve,reject)=>originals.server(error=>error?reject(error):resolve())):undefined),
          Promise.resolve().then(()=>originals?.store()),
        ]);
        await rm(resources.dir,{recursive:true,force:true});
      }
      if(f)await rm(f.root,{recursive:true,force:true});
    }
  });
}
