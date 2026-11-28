import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

// The UI's own status poll (GET /api/agents) is the tick: the person does nothing else.
const tick = app => api(app, '/api/agents');
const settled = async app => {
  const row = (await tick(app))[0];
  return row.checking === false ? row : null;
};
const idle = () => new Promise(resolve => setTimeout(resolve, 300));

test('an unknown proxy identity is retried by the background check after its backoff, and ticks inside it do not probe', {timeout: 120000}, async t => {
  const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
  let time = Date.now(), probes = 0, ownerProbes = 0;
  const f = await appFixture(t);
  const {lender} = await f.connect({
    adapters: [{...native, installed: true, signedIn: false}],
    clock: {now: () => time},
    lendingIdentityCacheMs: 30000,
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    // Every probe answers unknown: the proxy cannot say whether the sign-in holds.
    lendingStoreBackedAgents: [], lendingIdentityProbe: async ({harnessNames}) => {
      probes++;
      return {providers: [{harness_id: harnessNames[0], installed: true, signedIn: null}]};
    },
    identityProbe: async ({harnessNames}) => {
      ownerProbes++;
      return {providers: [{harness_id: harnessNames[0], installed: true, signedIn: null}]};
    },
  });
  await tick(lender.app);
  await waitFor(async () => probes === 1 && await settled(lender.app), 'the first unknown probe');
  assert.equal((await codexRow(lender.app)).proxySignedIn, null);

  // Inside the first 30 s back-off: ticks run no probe.
  for (const step of [10000, 10000]) { time += step; await tick(lender.app); await idle(); }
  assert.equal(probes, 1, 'ticks inside the back-off run no second probe');

  // The back-off ends. The next tick retries, with no action from the person.
  time += 10000; await tick(lender.app);
  await waitFor(() => probes === 2, 'the background retry after the 30 s back-off', 20000);
  await waitFor(async () => await settled(lender.app), 'the retry finishes');

  // The proxy retry and the owner fallback after it share a budget of three automatic creates. This
  // answer-unknown agent has spent them, so later ticks, even long after the next back-off, run no probe.
  time += 60000; await tick(lender.app); await idle();
  assert.equal(probes, 2, 'the exhausted automatic budget stops further probes');
  assert.equal(ownerProbes, 1, 'the budget of three held two proxy probes and one owner probe');
});

async function codexRow(app) {
  return (await api(app, '/api/agents'))[0];
}

// Count attempted sandbox acquisitions, including prepare() calls that throw before
// a handle exists. Neither these probes nor the backend can launch a real agent.
async function failingCreateFixture(t, {ownerOnly = false, remembered = false, ownerSucceeds = false} = {}) {
  const {syntheticBackend} = await import('./helpers/v1-app-fixture.mjs');
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
  let time = Date.now(), successful = false, serial = 0;
  const creates = [];
  backend.prepare = async spec => {
    creates.push({at: time, kind: spec.testProbe});
    // A successful synthetic owner acquisition creates no real sandbox or process.
    if (ownerSucceeds && spec.testProbe === 'owner') return {job_id: spec.job_id, sandbox_id: 'synthetic-owner-check'};
    throw Object.assign(new Error('synthetic create failure'), {code: 'sandbox_create_failed'});
  };
  backend.destroy = async handle => ({job_id: handle.job_id, sandbox_id: handle.sandbox_id, removed: true, scratch_removed: true});
  const probe = kind => async ({harnessNames: [id], backendFactory}) => {
    if (successful) return {providers: [{harness_id: id, installed: true, signedIn: true}]};
    const handle = await backendFactory().prepare({
      job_id: 'wf-pull-0000000000000000-' + (++serial).toString(16).padStart(8, '0'),
      entrypoint: 'true', testProbe: kind,
    });
    if (ownerSucceeds && kind === 'owner') {
      await backendFactory().destroy(handle);
      return {providers: [{harness_id: id, installed: true, signedIn: true}]};
    }
    assert.fail('the failing backend must never return a sandbox');
  };
  const {app} = await f.start('create-cap', {
    backend, adapters: [{...native, installed: true, signedIn: remembered ? true : null}],
    clock: {now: () => time},
    // A very short proxy TTL deliberately makes the owner fallback eligible on
    // successive passes. Its failure backoff must be independent of this TTL.
    ...(ownerOnly ? {lendingIdentityCacheMs: 1} : {}),
    lendingSignInProbe: async () => ownerOnly
      ? {signedIn: false, secretPresent: false}
      : {signedIn: null, secretPresent: true},
    signInProbe: async () => ({signedIn: null, source: 'unavailable'}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: probe('proxy'), identityProbe: probe('owner'),
  });
  const poll = async (advance = 0) => {
    time += advance;
    // Both read surfaces must share the same budget; neither is an explicit Check.
    await api(app, '/api/status');
    await api(app, '/api/home');
    await idle();
    await waitFor(async () => (await tick(app)).every(row => !row.checking), 'identity checks settle', 20000);
  };
  const check = () => api(app, '/api/agents/refresh', {method: 'POST', body: {agents: ['codex']}});
  return {app, creates, poll, check, succeed: value => {successful = value;}};
}

test('status and home polling share a three-create automatic budget across proxy and owner probes', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t);
  await f.poll();
  assert.ok(f.creates.some(row => row.kind === 'proxy'), 'a proxy create was actually attempted');
  assert.ok(f.creates.some(row => row.kind === 'owner'), 'the failed proxy reached the owner fallback');
  for (let i = 0; i < 6; i++) await f.poll(600001);
  assert.equal(f.creates.length, 3, 'a pass that tries proxy and owner spends two slots, not one');
  for (let i = 0; i < 3; i++) await f.poll(3600000);
  assert.equal(f.creates.length, 3, 'elapsed time and GETs cannot refill an exhausted budget');
});

test('successful owner checks do not refill the unknown lending proxy budget', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t, {ownerSucceeds: true});
  for (let i = 0; i < 6; i++) await f.poll(600001);
  assert.deepEqual(f.creates.map(row => row.kind), ['proxy', 'owner', 'proxy'], 'owner success still spends a place until the proxy answers');
  const row = await stoppedRow(f);
  assert.equal(row.signedIn, true, 'the owner really did sign in successfully');
  assert.equal(row.proxySignedIn, null, 'the lending proxy never resolved');
  assert.equal(row.automaticChecksStopped, true);
  assert.equal(row.remedy, STOPPED);
  await f.poll(3600000);
  assert.equal(f.creates.length, 3, 'more time cannot refill the unresolved proxy budget');
});

test('a resolving automatic proxy check resets the budget after owner-only success', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t, {ownerSucceeds: true});
  await f.poll();
  assert.deepEqual(f.creates.map(row => row.kind), ['proxy', 'owner']);
  f.succeed(true);
  await f.poll(600001);
  assert.equal((await stoppedRow(f)).proxySignedIn, true, 'the proxy itself supplied positive evidence');
  f.succeed(false);
  const before = f.creates.length;
  for (let i = 0; i < 6; i++) await f.poll(600001);
  assert.equal(f.creates.length - before, 3, 'the next unresolved episode gets one fresh bounded budget');
  assert.equal((await stoppedRow(f)).automaticChecksStopped, true);
});

test('an explicit Check can create again after automatic failures exhaust the cap', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t);
  for (let i = 0; i < 5; i++) await f.poll(600001);
  assert.equal(f.creates.length, 3, 'automatic create attempts stop before the user retries');
  const before = f.creates.length;
  await f.check();
  assert.ok(f.creates.length > before, 'explicit Check bypasses the exhausted automatic budget');
  const after = f.creates.length;
  await f.poll();
  assert.equal(f.creates.length, after, 'the failed explicit check still respects failure backoff');
});

test('a successful Check resets the failure budget for later automatic checks', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t);
  for (let i = 0; i < 5; i++) await f.poll(600001);
  assert.equal(f.creates.length, 3, 'first failure episode exhausts its budget');
  f.succeed(true);
  const rows = await f.check();
  assert.equal(rows.find(row => row.id === 'codex').proxySignedIn, true, 'the reset follows positive evidence');
  f.succeed(false);
  const before = f.creates.length;
  for (let i = 0; i < 6; i++) await f.poll(600001);
  assert.equal(f.creates.length - before, 3, 'a later failure episode gets a fresh three-create budget');
  await f.poll(3600000);
  assert.equal(f.creates.length - before, 3, 'that fresh budget is also bounded');
});

test('owner fallback create failures back off for at least thirty seconds even when proxy evidence is due', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t, {ownerOnly: true});
  await f.poll();
  assert.deepEqual(f.creates.map(row => row.kind), ['owner'], 'missing proxy credentials do not create a proxy sandbox');
  const first = f.creates[0].at;
  for (const advance of [1, 999, 9000, 10000, 9999]) await f.poll(advance);
  assert.equal(f.creates.length, 1, 'repeated reads inside thirty seconds cannot retry owner creation');
  await f.poll(1);
  assert.equal(f.creates.length, 2, 'an owner retry is allowed after the failure backoff');
  assert.ok(f.creates[1].at - first >= 30000);
});

const STOPPED = 'Automatic checks stopped after 3 failures. Press Check agents to try again.';
const stoppedRow = async f => (await api(f.app, '/api/agents')).find(row => row.id === 'codex');

test('after three failed automatic checks the agent says so, and an explicit Check clears it', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t);
  await f.poll();
  assert.notEqual((await stoppedRow(f)).remedy, STOPPED, 'one failure does not announce a stop');
  for (let i = 0; i < 5; i++) await f.poll(600001);
  assert.equal(f.creates.length, 3);
  const capped = await stoppedRow(f);
  assert.equal(capped.remedy, STOPPED);
  assert.equal(capped.automaticChecksStopped, true);
  await f.check();
  const after = await stoppedRow(f);
  assert.notEqual(after.remedy, STOPPED);
  assert.notEqual(after.automaticChecksStopped, true);
});

test('a successful Check also clears the stop message', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t);
  for (let i = 0; i < 5; i++) await f.poll(600001);
  assert.equal((await stoppedRow(f)).remedy, STOPPED);
  f.succeed(true);
  await f.check();
  assert.notEqual((await stoppedRow(f)).remedy, STOPPED);
});

// The pause-end and startup resumes are automatic checks: they spend the same budget and honour the same backoff.
const unknownAgent = {providers: [{harness_id: 'codex', installed: true, signedIn: null}]};
const coldCodex = async () => {
  const {legacyProxyHarness} = await import('./helpers/legacy-proxy-harness.mjs');
  return [{spec: legacyProxyHarness('codex')}];
};
async function lendingOnFor(app, circle) {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}

test('a second timed resume does not probe again inside the backoff of the first one\'s failed check', {timeout: 120000}, async t => {
  const {appFixture: lifecycle} = await import('./helpers/v1-lifecycle-fixture.mjs');
  const f = await lifecycle(t);
  const {lender, circle} = await f.connect({});
  await lendingOnFor(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {until: Date.now() + 2500}});
  await lender.app.close();
  let probes = 0;
  const restarted = await f.start('lender', {adapters: await coldCodex(), identityCacheMs: 1, identityProbe: async () => { probes++; return unknownAgent; }});
  await waitFor(async () => (await api(restarted.app, '/api/status')).reason === 'no_accounts', 'the first resume ran and could not start', 20000);
  assert.equal(probes, 1);
  await api(restarted.app, '/api/lending/pause', {method: 'POST', body: {until: Date.now() + 1500}});
  await waitFor(async () => (await api(restarted.app, '/api/status')).state !== 'paused', 'the second pause ended', 20000);
  await idle();
  assert.equal(probes, 1, 'the second timed resume honoured the failure backoff');
});

test('retries of a startup resume that timed out cannot probe past the automatic budget', {timeout: 120000}, async t => {
  const {appFixture: lifecycle} = await import('./helpers/v1-lifecycle-fixture.mjs');
  const f = await lifecycle(t);
  const {lender, circle} = await f.connect({});
  await lendingOnFor(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await lender.app.close();
  let probes = 0;
  const restarted = await f.start('lender', {adapters: await coldCodex(), identityCacheMs: 1, agentCheckTimeoutMs: 100, blockerRecheckMs: 50,
    identityProbe: async () => { probes++; await new Promise(resolve => setTimeout(resolve, 250)); return unknownAgent; }});
  await waitFor(() => probes >= 1, 'the startup check ran', 20000);
  await new Promise(resolve => setTimeout(resolve, 10000));
  assert.ok(probes <= 3, 'the retries stayed inside the three-check budget, got ' + probes);
});

test('the stop is shown while the proxy is unconfirmed, even when a remembered owner sign-in reads as signed in', {timeout: 120000}, async t => {
  const f = await failingCreateFixture(t, {remembered: true});
  for (let i = 0; i < 5; i++) await f.poll(600001);
  const row = await stoppedRow(f);
  assert.equal(row.signedIn, true, 'the remembered owner sign-in makes the row read signed in');
  assert.equal(row.proxySignedIn, null);
  assert.equal(row.automaticChecksStopped, true);
  assert.equal(row.remedy, STOPPED);
});

test('status_blockers carries the stop on a lent agent row, naming the button beside it', {timeout: 120000}, async t => {
  const {appFixture: lifecycle, syntheticBackend} = await import('./helpers/v1-lifecycle-fixture.mjs');
  const f = await lifecycle(t);
  const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
  const known = {providers: [{harness_id: 'codex', installed: true, signedIn: true}]};
  const {lender, circle} = await f.connect({
    adapters: [{...native, installed: true, signedIn: true}],
    lendingSignInProbe: async () => ({signedIn: true, secretPresent: true}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: async () => known, identityProbe: async () => known,
  });
  await lendingOnFor(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await lender.app.close();
  let time = Date.now();
  const unknown = async () => unknownAgent;
  const restarted = await f.start('lender', {
    adapters: [{...native, installed: true, signedIn: null}], clock: {now: () => time},
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    signInProbe: async () => ({signedIn: null, source: 'unavailable'}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: unknown, identityProbe: unknown,
  });
  const itemOf = async () => (await api(restarted.app, '/api/status')).lending_blockers.items.find(row => row.agent === 'codex');
  for (let i = 0; i < 6; i++) {
    time += 600001; await api(restarted.app, '/api/status'); await api(restarted.app, '/api/home'); await idle();
    await waitFor(async () => (await api(restarted.app, '/api/agents')).every(row => !row.checking), 'checks settle', 20000);
  }
  const item = await itemOf();
  assert.equal(item.automaticChecksStopped, true, JSON.stringify(item));
  assert.ok(item.detail.endsWith(STOPPED));
  assert.equal(item.status,'blocked');
  const status=await api(restarted.app,'/api/status');
  assert.equal(status.lending_blockers.first.action,'Check agents');
  assert.equal(status.lending_blockers.headline,'Lending stopped: agent checks failed');
  assert.equal(item.action, 'Check agents');
  await api(restarted.app, '/api/agents/refresh', {method: 'POST', body: {agents: ['codex']}});
  const after = await itemOf();
  assert.notEqual(after.automaticChecksStopped, true);
  assert.notEqual(after.detail, STOPPED);
});
