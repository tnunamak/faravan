import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import { lendingLabel } from '../lib/v1/status.mjs';
import { appFixture, api, waitFor, boundedFetch, bounded, syntheticBackend, adapters } from './helpers/v1-lifecycle-fixture.mjs';

const gitInput = circle => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Synthetic task.', harness: 'codex'});
async function lendingOn(app, circle) {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const gone = async app => boundedFetch(app.origin + '/api/status', {headers: {'x-faravan-session-token': app.token}}).then(() => false, () => true);

async function refusalSnapshot(lender) {
  const lending = await api(lender.app, '/api/lending');
  const status = await api(lender.app, '/api/status');
  return {enabled: lending.enabled, current: lending.current, phase: lending.status, paused: lending.paused,
    mode: lending.mode, limits: lending.limits, intent: status.intent, execution: status.execution,
    settings: await readFile(join(lender.home, 'v1', 'app-settings.json'), 'utf8')};
}

// A client without offer discovery: the lender claims first and holds the job for a 60-second review (an older host).
function legacyClaims(app) {
  const getClient = app.device.client.bind(app.device);
  app.device.client = async (...args) => Object.assign(await getClient(...args), {listJobs: undefined});
}

test('shutdown refuses a claimed (legacy) review by name without changing its card or lending', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect();
  legacyClaims(lender.app);
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendingOn(lender.app, circle);
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  const before = await refusalSnapshot(lender);
  for (const body of [{}, {attemptId: before.current, confirmed: true}]) {
    const refused = await api(lender.app, '/api/shutdown', {method: 'POST', body, status: 409});
    assert.equal(refused.code, 'approval_pending');
    assert.equal(refused.approvalId, card.id);
    assert.ok(refused.message.includes(card.id), 'the refusal identifies the pending request');
    assert.ok(!refused.message.includes(card.prompt), 'the refusal does not echo the prompt');
    assert.deepEqual(await api(lender.app, '/api/approvals'), [card]);
    assert.deepEqual(await refusalSnapshot(lender), before);
  }
  assert.equal(card.offer, false, 'the fixture really produced a claimed hold');
  assert.equal(lendingLabel(await api(lender.app, '/api/lending')), 'Waiting for review');
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'run'), false);
  assert.equal(await gone(lender.app), false);
});

test('shutdown with an open offer ends its preview, keeps the offer listed and unhidden, and closes', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect();
  const submitted = await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendingOn(lender.app, circle);
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'offer card');
  assert.equal(card.offer, true);
  assert.deepEqual(await api(lender.app, '/api/shutdown', {method: 'POST', body: {}, status: 202}), {shuttingDown: true});
  await waitFor(() => gone(lender.app), 'the app closed', 20000);
  assert.equal(f.jobs.get(submitted.jobDigest).state, 'queued', 'the offer was never claimed and others can still take it');
  // No counters file at all is fine: nothing was hidden or reserved.
  const counters = await readFile(join(lender.home, 'v1', 'app-counters.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  assert.equal((counters.hiddenOffers ?? []).some(entry => entry.jobDigest === submitted.jobDigest), false,
    'Quit is not Skip: the offer is shown again after the next start');
  assert.equal(JSON.parse(await readFile(join(lender.home, 'v1', 'app-settings.json'), 'utf8')).intent, 'on');
  assert.equal(lender.backend.calls.some(([kind]) => ['prepare', 'run'].includes(kind)), false);
});

async function runningJob(t, lenderOptions = {}) {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect(lenderOptions);
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendingOn(lender.app, circle);
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'running fake sandbox');
  return {f, lender, attempt: (await api(lender.app, '/api/lending')).current};
}

test('closing the app (update, relaunch) with an open offer does not hide it', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect();
  const submitted = await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendingOn(lender.app, circle);
  assert.equal((await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'offer card')).offer, true);
  await bounded(lender.app.close(), 'close with an open offer');
  const counters = await readFile(join(lender.home, 'v1', 'app-counters.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  assert.equal((counters.hiddenOffers ?? []).some(entry => entry.jobDigest === submitted.jobDigest), false);
  assert.equal(f.jobs.get(submitted.jobDigest).state, 'queued');
});

test('shutdown with no job closes the app by itself', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect();
  await lendingOn(lender.app, circle);
  await api(lender.app, '/api/shutdown', {method: 'POST', token: null, body: {}, status: 401});
  await api(lender.app, '/api/shutdown', {method: 'POST', body: {surprise: 1}, status: 400});
  assert.deepEqual(await api(lender.app, '/api/shutdown', {method: 'POST', body: {}, status: 202}), {shuttingDown: true});
  await waitFor(() => gone(lender.app), 'the app closed', 20000);
});

test('shutdown never interrupts a running job unasked: refusal preserves lending and the job keeps running', {timeout: 120000}, async t => {
  const {lender, attempt} = await runningJob(t);
  assert.ok(attempt);
  const before = await refusalSnapshot(lender);
  const refused = await api(lender.app, '/api/shutdown', {method: 'POST', body: {}, status: 409});
  assert.equal(refused.code, 'job_running');
  assert.deepEqual(await refusalSnapshot(lender), before);
  assert.equal((await api(lender.app, '/api/lending')).current, attempt);
  assert.equal(await gone(lender.app), false, 'the app is still running');
});

test('shutdown for another attempt, or without confirmation, is refused', {timeout: 120000}, async t => {
  const {lender, attempt} = await runningJob(t);
  const before = await refusalSnapshot(lender);
  for (const body of [{attemptId: 'some-other-attempt', confirmed: true}, {attemptId: attempt}, {confirmed: true}]) {
    assert.equal((await api(lender.app, '/api/shutdown', {method: 'POST', body, status: 409})).code, 'job_changed');
    assert.deepEqual(await refusalSnapshot(lender), before);
  }
  assert.equal(await gone(lender.app), false);
  assert.equal((await api(lender.app, '/api/lending')).current, attempt);
});

test('shutdown with the confirmed attempt stops that job, then the app closes itself', {timeout: 120000}, async t => {
  const {lender, attempt} = await runningJob(t);
  assert.deepEqual(await api(lender.app, '/api/shutdown', {method: 'POST', body: {attemptId: attempt, confirmed: true}, status: 202}), {shuttingDown: true});
  await waitFor(() => gone(lender.app), 'the app closed after stopping the job', 30000);
  assert.ok(lender.backend.calls.some(([kind]) => ['cancel', 'destroy'].includes(kind)), 'the sandbox was stopped, not abandoned');
});

// Review 3 P1: Stop and Quit exited the process as soon as the stop was acknowledged, even when removal of the sandbox could not be
// proven. The recovery that would keep trying lives in the app, so quitting then left an unproven sandbox with no one watching.
test('quit with a stop the backend cannot prove keeps the app open and says so; once removal is proven it closes', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect({shutdownProofMs: 1500});
  let provable = false;
  lender.backend.destroy = async handle => { lender.backend.calls.push(['destroy']); handle._release?.(); return {removed: provable, scratch_removed: true}; };
  lender.backend.reconcilePending = async pending => provable ? {removed: true, attemptId: pending.attemptId, sbx_home: pending.sbx_home} : {removed: false};
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendingOn(lender.app, circle);
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'running fake sandbox');
  const attempt = (await api(lender.app, '/api/lending')).current;

  const refused = await api(lender.app, '/api/shutdown', {method: 'POST', body: {attemptId: attempt, confirmed: true}, status: 409});
  assert.equal(refused.code, 'cessation_unverified');
  assert.match(refused.message, /stays open/);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await gone(lender.app), false, 'the app stays alive so its recovery can keep trying');
  assert.equal((await api(lender.app, '/api/status')).execution.state, 'stopping', 'and it says it is still stopping');

  // Removal can be proven now: the same Quit goes through, and the app closes.
  provable = true;
  const quit = async () => (await boundedFetch(lender.app.origin + '/api/shutdown', {method: 'POST', body: '{}',
    headers: {'x-faravan-session-token': lender.app.token, 'content-type': 'application/json'}}).catch(() => null))?.status === 202;
  await waitFor(quit, 'quit accepted once removal is proven', 30000);
  await waitFor(() => gone(lender.app), 'the app closed', 30000);
});

// Review 4 / pin-1 P1-1: after a restart with lending off, paused, or still resuming, there is no in-memory lender. Quit must
// still prove from the durable counters that the recorded attempt's sandbox is gone, and never discard the saved intent.
const DURABLE = {attemptId: 'attempt-durable', jobId: 'job-durable',
  attempt: {attempt_id: 'attempt-durable', job_digest: 'sha256:' + 'd'.repeat(64), generation: 1}};
async function restartWithDurablePending(t, {settings = {}, extra = {}} = {}) {
  const f = await appFixture(t), {lender, circle} = await f.connect();
  await lendingOn(lender.app, circle);
  await bounded(lender.app.close(), 'close before the simulated crash');
  const settingsFile = join(lender.home, 'v1', 'app-settings.json'), counterFile = join(lender.home, 'v1', 'app-counters.json');
  // A setting given as a function is read when it is written, so a clock-relative pause starts after the slow setup.
  const applied = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, typeof value === 'function' ? value() : value]));
  await writeFile(settingsFile, JSON.stringify({...JSON.parse(await readFile(settingsFile, 'utf8')), ...applied}));
  const counters = await readFile(counterFile, 'utf8').then(JSON.parse, () => ({day: '2026-10-20', jobs: 0, milliseconds: 0}));
  // A pending record without its sandbox home is a legacy record: its proof is never trusted.
  const backend = syntheticBackend(f.root), proofs = [];
  await writeFile(counterFile, JSON.stringify({...counters, circle: circle.id, pending: {...DURABLE, ...backend.sandboxOwnership(), reservedMs: 60000}}));
  let answer = () => ({removed: false, attemptId: DURABLE.attemptId, code: 'cessation_unverified'});
  backend.reconcilePending = async pending => {proofs.push(structuredClone(pending));return answer(pending);};
  const restarted = await f.start('lender', {backend, shutdownProofMs: 1200, ...extra});
  return {f, circle, applied, app: restarted.app, home: restarted.home, backend, proofs, settingsFile, answer: next => {answer = next;}};
}
const quitStatus = async app => (await boundedFetch(app.origin + '/api/shutdown', {method: 'POST', body: '{}',
  headers: {'x-faravan-session-token': app.token, 'content-type': 'application/json'}}).catch(() => null))?.status;

async function assertQuitWaitsForExactProof(r) {
  assert.equal((await api(r.app, '/api/lending')).enabled, false, 'no lender runs in this restart');
  // Destroy failed (the sandbox is still listed): Quit refuses and the app stays open.
  assert.equal((await api(r.app, '/api/shutdown', {method: 'POST', body: {}, status: 409})).code, 'cessation_unverified');
  assert.ok(r.proofs.length > 0 && r.proofs.every(p => p.attemptId === DURABLE.attemptId && p.jobId === DURABLE.jobId),
    'the durable record, not a remote name, is what the backend is asked about');
  // UNKNOWN inventory (sbx ls unreadable) is not proof either.
  r.answer(() => {throw Object.assign(new Error('sbx ls failed'), {code: 'inventory_unknown'});});
  assert.equal((await api(r.app, '/api/shutdown', {method: 'POST', body: {}, status: 409})).code, 'cessation_unverified');
  // Removal proven for a different attempt does not count.
  r.answer(() => ({removed: true, attemptId: 'some-other-attempt'}));
  assert.equal((await api(r.app, '/api/shutdown', {method: 'POST', body: {}, status: 409})).code, 'cessation_unverified');
  assert.equal(await gone(r.app), false, 'the app is still open after every unproven Quit');
  // The exact attempt's removal is proven: Quit goes through and the app closes itself.
  r.answer(pending => ({removed: true, attemptId: pending.attemptId, sbx_home: pending.sbx_home}));
  assert.equal(await quitStatus(r.app), 202);
  await waitFor(() => gone(r.app), 'the app closed after proof', 20000);
  assert.equal(r.backend.calls.some(([kind]) => ['prepare', 'run'].includes(kind)), false, 'recovery never claimed or ran work');
  assert.equal(r.f.networkTrace.some(entry => entry.device === 'lender' && entry.route.endsWith('/jobs/claim-next')), false);
}

test('quit after a restart with lending off proves the durable pending sandbox is gone before closing', {timeout: 120000}, async t => {
  const r = await restartWithDurablePending(t, {settings: {intent: 'off', enabled: false}});
  await assertQuitWaitsForExactProof(r);
  assert.equal(JSON.parse(await readFile(r.settingsFile, 'utf8')).intent, 'off');
});

test('quit during a timed pause proves the durable pending sandbox is gone and keeps the pause and intent', {timeout: 120000}, async t => {
  const pauseUntil = Date.now() + 3600000;
  const r = await restartWithDurablePending(t, {settings: {intent: 'on', pause_until: pauseUntil}});
  await assertQuitWaitsForExactProof(r);
  const saved = JSON.parse(await readFile(r.settingsFile, 'utf8'));
  assert.equal(saved.intent, 'on', 'Quit is not Off: lending resumes after the next start');
  assert.equal(saved.pause_until, pauseUntil, 'and the timed pause still ends when it was set to');
});

test('a timed pause still ends by itself after a Quit that could not prove cessation', {timeout: 120000}, async t => {
  const r = await restartWithDurablePending(t, {settings: {intent: 'on', pause_until: () => Date.now() + 12000}});
  const pauseUntil = r.applied.pause_until;
  assert.equal((await api(r.app, '/api/lending')).enabled, false, 'still paused');
  assert.ok(Date.now() < pauseUntil - 3000, 'the pause must outlast the failed Quit for this test to mean anything');
  assert.equal((await api(r.app, '/api/shutdown', {method: 'POST', body: {}, status: 409})).code, 'cessation_unverified');
  assert.ok(Date.now() < pauseUntil, 'Quit failed before the pause ended');
  await waitFor(async () => (await api(r.app, '/api/lending')).enabled === true, 'lending came back on when the pause ended', 30000);
});

test('quit before a delayed automatic resume finishes proves cessation and the resume never starts a lender', {timeout: 120000}, async t => {
  let releaseProbe, probing = 0;
  const gate = new Promise(resolve => {releaseProbe = resolve;});
  // Like the real probe it honours its abort signal, which the app's close uses.
  const identityProbe = async ({harnessNames, signal}) => {probing++;
    await Promise.race([gate, new Promise(resolve => signal?.addEventListener('abort', resolve, {once: true}))]);
    return {providers: harnessNames.map(id => ({harness_id: id, installed: true, signedIn: true}))};};
  // Agents not yet checked in this start: the automatic resume checks them first, and that check is held open.
  const cold = adapters().map(entry => ({...entry, signedIn: null}));
  const r = await restartWithDurablePending(t, {settings: {intent: 'on'}, extra: {identityProbe, adapters: cold}});
  t.after(() => releaseProbe());
  await waitFor(() => probing > 0, 'the automatic resume is checking agents');
  await assertQuitWaitsForExactProof(r);
  releaseProbe();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(r.backend.calls.some(([kind]) => ['prepare', 'run'].includes(kind)), false);
  const saved = JSON.parse(await readFile(r.settingsFile, 'utf8'));
  assert.equal(saved.intent, 'on', 'the saved intent survives Quit and the next start resumes lending');
});

test('while Quit waits for proof, lending cannot be turned back on behind it', {timeout: 120000}, async t => {
  const r = await restartWithDurablePending(t, {settings: {intent: 'off', enabled: false}, extra: {shutdownProofMs: 4000}});
  const quitting = api(r.app, '/api/shutdown', {method: 'POST', body: {}, status: 409});
  await waitFor(() => r.proofs.length > 0, 'quit is checking the sandbox');
  const refused = await api(r.app, '/api/lending/on', {method: 'POST', body: {circle: r.circle.id}, status: 409});
  assert.equal(refused.code, 'app_quitting');
  assert.equal((await quitting).code, 'cessation_unverified');
  assert.equal(await gone(r.app), false);
});

test('quit with no job keeps lending intent on for the next start', {timeout: 120000}, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect();
  await lendingOn(lender.app, circle);
  assert.deepEqual(await api(lender.app, '/api/shutdown', {method: 'POST', body: {}, status: 202}), {shuttingDown: true});
  await waitFor(() => gone(lender.app), 'the app closed', 20000);
  const saved = JSON.parse(await readFile(join(lender.home, 'v1', 'app-settings.json'), 'utf8'));
  assert.equal(saved.intent, 'on');
  assert.equal(saved.activeCircle, circle.id);
});

// Quota cleanup must not delay stopping independently executing borrower work.
test('shutdown starts borrower Stop before awaiting a held quota observation', {timeout:120000}, async t => {
  const source=createSyntheticPace50Source({start:Date.now()}),observe=source.observe.bind(source);
  let hold=false,entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  source.observe=async args=>{
    if(hold&&args.forceRefresh){entered();await gate;}
    return observe(args);
  };
  t.after(()=>release());
  const {lender}=await runningJob(t,{lendingPace50:{source,account_week_id:'synthetic-week-1'}});
  hold=true;
  const refreshing=fetch(lender.app.origin+'/api/agents/refresh',{method:'POST',
    headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},body:JSON.stringify({agents:['codex']})});
  await bounded(started,'explicit quota read started');
  let closed=false;
  const closing=lender.app.close().then(()=>{closed=true;});
  try {
    await waitFor(()=>lender.backend.calls.some(([kind])=>['cancel','destroy'].includes(kind)),
      'borrower Stop before quota cleanup is released');
    assert.equal(closed,false,'the app still owns and drains its held quota callback');
  } finally {
    release();await closing;
    await refreshing.then(r=>r.arrayBuffer(),()=>{});
  }
});
