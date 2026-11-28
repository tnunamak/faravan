import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startAuthFlow } from '../lib/auth-flow.mjs';
import { join } from 'node:path';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';
import { createSignin, startProviderSignIn, SIGNIN_STARTING_STAGES } from '../lib/v1/signin.mjs';
import { beginSignIn, progressView, readProgress } from '../ui/v1/src/signin.mjs';

const testOptions = { timeout: 20000 };
const SECRET = 'sk-secret-token-0123456789';

// A fake flow handle the test finishes by hand. It never spawns anything.
function fakeFlow(extra = {}) {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const handle = { url: 'https://login.example.test/device', code: 'ABCD-1234', status: 'awaiting-browser',
    token: SECRET, stderr: SECRET, cancelled: 0,
    waitForCompletion: () => done, cancel() { handle.cancelled++; finish({ status: 'failed', detail: SECRET }); },
    complete: () => finish({ status: 'complete', detail: SECRET }), ...extra };
  return handle;
}
function recorder(make = fakeFlow) {
  const calls = [];
  const starter = async (...args) => { const handle = make(); calls.push({ handle, args }); return handle; };
  starter.calls = calls;
  return starter;
}
// A backend whose sandbox preflight reports docker_login according to `state.docker`.
function dockerBackend(root, state) {
  const backend = syntheticBackend(root);
  backend.probeCapabilities = async () => ({ available: true,
    preflight: { ok: state.docker, checks: [{ name: 'docker_login', ok: state.docker, detail: 'Docker sign-in', fix: 'Sign in to Docker.' }] } });
  return backend;
}
async function start(t, signin, state = { docker: false, signedIn: false }, extra = {}) {
  const f = await appFixture(t);
  const probes = [];
  const identityProbe = async () => { probes.push(state.signedIn); return { providers: [{ harness_id: 'codex', installed: true, signedIn: state.signedIn }] }; };
  const { app } = await f.start('owner', { backend: dockerBackend(f.root, state), identityProbe, signin, ...extra });
  const home = await f.home('owner');
  return { app, state, probes, home };
}
const post = (app, path, status = 200) => api(app, path, { method: 'POST', body: {}, status });

test('start returns the verification URL and code; polling reaches success and refreshes readiness and agents', testOptions, async t => {
  const docker = recorder(), state = { docker: false, signedIn: false };
  const { app, probes } = await start(t, { startDocker: docker }, state);
  assert.equal((await api(app, '/api/readiness')).checks.find(c => c.name === 'docker_login').ok, false);

  const started = await post(app, '/api/signin/docker');
  assert.equal(started.status, 'awaiting_browser');
  assert.equal(started.stage, undefined, 'a delivered provider URL ends preparation; later completion failure must not claim preparation failed');
  assert.equal(started.target, 'docker');
  assert.equal(started.url, 'https://login.example.test/device');
  assert.equal(started.code, 'ABCD-1234');
  assert.match(started.message, /Finish signing in/);
  assert.equal((await api(app, '/api/signin/' + started.flowId)).status, 'awaiting_browser');
  assert.equal(probes.length, 0, 'polling never probes');

  state.docker = true; state.signedIn = true;
  docker.calls[0].handle.complete();
  const done = await waitFor(async () => { const v = await api(app, '/api/signin/' + started.flowId); return v.status === 'complete' && v; }, 'sign-in complete');
  assert.equal(done.url, undefined);
  assert.equal(done.code, undefined);
  assert.equal(probes.length, 1, 'completion refreshed agent evidence once');
  assert.equal((await api(app, '/api/readiness')).checks.find(c => c.name === 'docker_login').ok, true);
  assert.equal((await api(app, '/api/agents'))[0].signedIn, true);
  const activity = await api(app, '/api/activity');
  assert.ok(activity.some(e => e.type === 'signin' && e.data.status === 'complete'));
  assert.ok(!JSON.stringify(activity).includes('login.example.test'), 'events never carry the URL');
});

test('provider sign-in drains an active background identity check before starting', testOptions, async t => {
  const entered = deferred();
  let probeDrained = false, signInStarted = false, probeCalls = 0;
  const { app } = await start(t, {
    startProvider: async (_spec, { onHandle }) => {
      assert.equal(probeDrained, true);
      signInStarted = true;
      const handle = fakeFlow(); onHandle(handle); return handle;
    },
  }, { docker: true, signedIn: false }, {
    adapters: HARNESS_ADAPTERS,
    identityProbe: async ({ signal }) => new Promise((resolve, reject) => {
      probeCalls++;
      const abort = () => { probeDrained = true; reject(Object.assign(new Error('aborted'), { code: 'aborted' })); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else entered.resolve();
    }),
  });
  await api(app, '/api/agents');
  await entered.promise;
  const callsBeforeSignIn = probeCalls;
  const flow = await api(app, '/api/signin/codex-lending', { method: 'POST', body: {} });
  assert.equal(signInStarted, true);
  assert.equal(flow.status, 'awaiting_browser');
  await api(app, '/api/agents');
  assert.equal(probeCalls, callsBeforeSignIn, 'new background checks do not start while sign-in is active');
});

test('lending identity cancellation drains before provider mutation', testOptions, async t => {
  const entered=deferred(), release=deferred();
  let drained=false, probeSignal, secretProbeSignal, timer;
  const codex={...HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex'),installed:true,proxySignedIn:true};
  const {app}=await start(t,{startProvider:async()=>{
    assert.equal(drained,true,'credential mutation waits for probe cleanup');
    return fakeFlow();
  }},{docker:true,signedIn:true},{adapters:[codex],lendingStoreBackedAgents:[],
    lendingSignInProbe:async(_id,{signal})=>{secretProbeSignal=signal;return {signedIn:true};},
    lendingIdentityProbe:async({signal})=>{
      probeSignal=signal;entered.resolve();
      await new Promise(resolve=>{
        release.promise.then(resolve);
        signal?.addEventListener('abort',()=>setTimeout(resolve,10),{once:true});
      });
      drained=true;
      return {providers:[{harness_id:'codex',installed:true,signedIn:true}]};
    }});
  const checking=api(app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  await entered.promise;
  const signing=post(app,'/api/signin/codex');
  try {
    const flow=await Promise.race([signing,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('lending probe was not cancelled for sign-in')),300);
    })]);
    assert.equal(probeSignal?.aborted,true);
    assert.equal(secretProbeSignal,probeSignal,'the fast secret probe uses the tracked cancellation signal');
    assert.equal(secretProbeSignal.aborted,true);
    assert.equal(flow.status,'awaiting_browser');
    assert.equal(drained,true);
  } finally {clearTimeout(timer);release.resolve();await Promise.allSettled([checking,signing]);}
});

test('provider sign-in uses the adapter spec and a second start for the same target returns the existing flow', testOptions, async t => {
  const provider = recorder();
  const { app } = await start(t, { startProvider: provider }, { docker: true, signedIn: false });
  const [first, second] = await Promise.all([post(app, '/api/signin/codex'), post(app, '/api/signin/codex')]);
  assert.equal(first.flowId, second.flowId);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].args[0].harness_id, 'codex');
  assert.equal((await post(app, '/api/signin/codex')).flowId, first.flowId);
  assert.equal(provider.calls.length, 1);
});

test('plain Codex sign-in uses the proxy flow when no provider CLI is on PATH', testOptions, async t => {
  const originalPath = process.env.PATH, strategies = [];
  process.env.PATH = '';
  try {
    const { app } = await start(t, { startProvider: async spec => {
      strategies.push(spec.auth_strategy);
      if (spec.auth_strategy !== 'docker-native-oauth') throw new Error('codex is not installed on the host');
      return fakeFlow();
    } }, { docker: true, signedIn: false });
    const started = await post(app, '/api/signin/codex');
    assert.equal(started.status, 'awaiting_browser');
    assert.deepEqual(strategies, ['docker-native-oauth'], 'the plain agent card selects the Docker proxy flow');
    await api(app, '/api/signin/' + started.flowId + '/cancel', { method: 'POST', body: {} });
  } finally { process.env.PATH = originalPath; }
});

test('plain sign-in keeps native flow for an adapter without a lending spec', testOptions, async t => {
  const adapter = { ...HARNESS_ADAPTERS.find(entry => entry.spec.harness_id === 'codex'), lendingSpec: undefined };
  const provider = recorder();
  const { app } = await start(t, { startProvider: provider }, { docker: true, signedIn: false }, { adapters: [adapter] });
  const started = await post(app, '/api/signin/codex');
  assert.equal(provider.calls[0].args[0].auth_strategy, 'provider-file-generation');
  await api(app, '/api/signin/' + started.flowId + '/cancel', { method: 'POST', body: {} });
});

test('cancel stops the flow, is idempotent, and frees the target for a new flow', testOptions, async t => {
  const docker = recorder();
  const { app } = await start(t, { startDocker: docker });
  const first = await post(app, '/api/signin/docker');
  const cancelled = await post(app, '/api/signin/' + first.flowId + '/cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.url, undefined);
  assert.equal(docker.calls[0].handle.cancelled, 1);
  assert.equal((await post(app, '/api/signin/' + first.flowId + '/cancel')).status, 'cancelled');
  assert.equal(docker.calls[0].handle.cancelled, 1);
  const second = await post(app, '/api/signin/docker');
  assert.notEqual(second.flowId, first.flowId);
  assert.equal(second.status, 'awaiting_browser');
  await api(app, '/api/signin/' + first.flowId, { status: 200 });
});

test('a flow times out, cancels its handle and reports a retryable state', testOptions, async t => {
  const docker = recorder();
  const { app } = await start(t, { startDocker: docker, timeoutMs: 40 });
  const started = await post(app, '/api/signin/docker');
  const view = await waitFor(async () => { const v = await api(app, '/api/signin/' + started.flowId); return v.status === 'timed_out' && v; }, 'timeout');
  assert.match(view.message, /too long/);
  assert.equal(docker.calls[0].handle.cancelled, 1);
  assert.equal((await post(app, '/api/signin/docker')).status, 'awaiting_browser');
});

test('a failed start returns a fixed error and never leaks secrets', testOptions, async t => {
  const { app, probes } = await start(t, { startGitHub: async () => { throw new Error('boom ' + SECRET); } });
  const error = await api(app, '/api/signin/github', { method: 'POST', body: {}, status: 409 });
  assert.equal(error.code, 'signin_failed');
  assert.ok(!JSON.stringify(error).includes(SECRET));
  assert.ok(!JSON.stringify(await api(app, '/api/activity')).includes(SECRET));
  assert.equal(probes.length, 0);
});

test('a failed completion shows the failed state without handle detail', testOptions, async t => {
  const docker = recorder();
  const { app, probes } = await start(t, { startDocker: docker });
  const started = await post(app, '/api/signin/docker');
  docker.calls[0].handle.cancel(); // resolves waitForCompletion with {status:'failed', detail: SECRET}
  const view = await waitFor(async () => { const v = await api(app, '/api/signin/' + started.flowId); return v.status === 'failed' && v; }, 'failed');
  assert.ok(!JSON.stringify(view).includes(SECRET));
  assert.match(view.message, /wasn't completed/);
  assert.equal(probes.length, 0);
});

test('only https URLs are returned, malformed codes are dropped, github is a target', testOptions, async t => {
  const { app } = await start(t, {
    startDocker: recorder(() => fakeFlow({ url: 'javascript:alert(1)' })),
    startGitHub: recorder(() => fakeFlow({ url: 'https://github.com/login/device', code: 'bad code!' })),
  });
  const bad = await api(app, '/api/signin/docker', { method: 'POST', body: {}, status: 409 });
  assert.equal(bad.code, 'signin_failed');
  const github = await post(app, '/api/signin/github');
  assert.equal(github.url, 'https://github.com/login/device');
  assert.equal(github.code, undefined);
});

test('unknown targets, unsupported agents and malformed requests are rejected without side effects', testOptions, async t => {
  const docker = recorder();
  const apiKey = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'claude-code-api-key');
  const { app } = await start(t, { startDocker: docker }, undefined, { adapters: [{ spec: apiKey.spec, installed: true, signedIn: false }] });
  assert.equal((await post(app, '/api/signin/nope', 404)).code, 'not_found');
  assert.equal((await post(app, '/api/signin/claude-code-api-key', 409)).code, 'signin_unsupported');
  assert.equal((await api(app, '/api/signin/missing', { status: 404 })).code, 'not_found');
  assert.equal((await post(app, '/api/signin/missing/cancel', 404)).code, 'not_found');
  await api(app, '/api/signin/docker', { method: 'POST', body: { extra: 1 }, status: 400 });
  await api(app, '/api/signin/docker', { token: null, method: 'POST', body: {}, status: 401 });
  assert.equal(docker.calls.length, 0);
});

test('closing the app cancels active flows', testOptions, async t => {
  const docker = recorder();
  const { app } = await start(t, { startDocker: docker });
  await post(app, '/api/signin/docker');
  await app.close();
  assert.equal(docker.calls[0].handle.cancelled, 1);
});

test('module: an already signed-in provider completes immediately and finished flows are pruned', async () => {
  let refreshed = 0, clock = 0;
  const signin = createSignin({ adapters: async () => [], backend: () => null, onComplete: async () => { refreshed++; },
    startDocker: async () => ({ status: 'complete', waitForCompletion: async () => ({ status: 'complete' }), cancel() {} }),
    now: () => clock });
  const view = await signin.start('docker');
  assert.equal(view.status, 'complete');
  assert.equal(refreshed, 1);
  assert.equal(signin.get(view.flowId).status, 'complete');
  clock += 11 * 60_000;
  await signin.start('docker');
  assert.throws(() => signin.get(view.flowId), { code: 'not_found' });
});

test('module: cancel while the starter is still running stops the handle once it exists', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const handle = fakeFlow();
  const signin = createSignin({ adapters: async () => [], backend: () => null, onComplete: async () => {}, newId: () => 'f1',
    startDocker: async () => { await gate; return handle; } });
  const pending = signin.start('docker');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signin.cancel('f1').status, 'cancelled');
  release();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(handle.cancelled, 1);
  signin.close();
});

test('wait-true startup returns timed_out at its deadline and a late barrier cannot start authentication', async () => {
  let release, entered, authStarts = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const signin = createSignin({ timeoutMs: 15, beforeStart: async () => { entered(); await hold; },
    startDocker: async () => { authStarts++; return fakeFlow(); } });
  const started = signin.start('docker');
  await reached;
  const flow = await started;
  assert.equal(flow.status, 'timed_out');
  assert.equal(flow.message, 'Sign-in took too long. Try again.');
  assert.equal(flow.stage, 'backend_health');
  assert.equal(flow.reasonCode, 'signin_timeout');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authStarts, 0);
  assert.equal(signin.get(flow.flowId).status, 'timed_out');
  await signin.close();
});

test('wait-true startup still rejects real setup errors before the deadline', async () => {
  const signin = createSignin({ timeoutMs: 1000, adapters: async () => [], startDocker: async () => fakeFlow() });
  await assert.rejects(signin.start('unsupported'), { code: 'not_found' });
  await signin.close();
});

test('a provider sandbox prepared after timeout is destroyed without starting native auth, and close waits for cleanup', async () => {
  let release, entered, authStarts = 0, destroys = 0, closeSettled = false;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const adapter = HARNESS_ADAPTERS.find(entry => entry.spec.harness_id === 'codex');
  const backend = {
    probeCapabilities: async () => ({ available: true }),
    prepare: async () => { entered(); await hold; return { sandbox_id: 'late-sandbox' }; },
    destroy: async handle => { destroys++; assert.equal(handle.sandbox_id, 'late-sandbox'); },
  };
  const signin = createSignin({ timeoutMs: 15, adapters: async () => [adapter], backend: () => backend,
    startProvider: (spec, options) => startProviderSignIn(spec, { ...options,
      startFlow: async () => { authStarts++; return fakeFlow(); } }) });
  try {
    const started = signin.start('codex');
    await reached;
    const flow = await started;
    assert.equal(flow.status, 'timed_out');
    const closing = signin.close().then(() => { closeSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeSettled, false, 'close waits for the outstanding owned preparation and cleanup');
    release();
    await closing;
    assert.equal(authStarts, 0);
    assert.equal(destroys, 1);
  } finally { release(); await signin.close(); }
});

test('injected sandbox sign-in hands the sandbox the adapter image (raw adapter specs have no .image)', async () => {
  const { startProviderSignIn } = await import('../lib/v1/signin.mjs');
  for (const id of ['codex', 'claude-code-subscription']) {
    const adapter = HARNESS_ADAPTERS.find(a => a.spec.harness_id === id);
    assert.equal(adapter.spec.image, undefined);
    let prepared;
    const backend = { probeCapabilities: async () => ({ available: true }),
      prepare: async job => { prepared = job; throw new Error('stop after prepare'); }, destroy: async () => {} };
    await assert.rejects(startProviderSignIn(adapter.spec, { backend, startFlow:async()=>{throw new Error('must not start');} }), /stop after prepare/);
    assert.equal(prepared.image, adapter.spec.install);
  }
});

test('the native provider start reports stage provider_url, and a missing command surfaces as its own reason code', testOptions, async () => {
  const adapter = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
  const stages = [];
  const signin = createSignin({ adapters: async () => [adapter], backend: () => ({ probeCapabilities: async () => ({ available: true }) }),
    newId: () => 'flow-missing',
    startProvider: (spec, options) => startProviderSignIn(spec, { ...options,
      setStage: stage => { stages.push(stage); options.setStage(stage); } }) });
  // The app PATH and the login shell both lack `codex`.
  const oldPath = process.env.PATH, oldShell = process.env.SHELL;
  process.env.PATH = '/nonexistent-faravan-path'; process.env.SHELL = '/nonexistent-faravan-shell';
  try {
    await assert.rejects(signin.start('codex'), { code: 'signin_failed' });
    const view = signin.get('flow-missing');
    assert.equal(view.status, 'failed');
    assert.equal(view.stage, 'provider_url');
    assert.equal(view.reasonCode, 'provider_cli_missing');
    assert.ok(stages.includes('provider_url'));
  } finally { process.env.PATH = oldPath; if (oldShell === undefined) delete process.env.SHELL; else process.env.SHELL = oldShell; await signin.close(); }
});

test('a provider sign-in that asks for a pasted code takes it from the app and checks it', testOptions, async t => {
  const submitted = [];
  const provider = recorder(() => fakeFlow({ acceptsCode: true, submitCode(code) { if (code === 'rejected-code') throw new Error(SECRET); submitted.push(code); } }));
  const { app } = await start(t, { startProvider: provider }, { docker: true, signedIn: false });
  const started = await post(app, '/api/signin/codex');
  assert.equal(started.codeEntry, true);
  const id = started.flowId;
  await api(app, '/api/signin/' + id + '/code', { method: 'POST', body: {}, status: 400 });
  await api(app, '/api/signin/' + id + '/code', { method: 'POST', body: { code: 'x', extra: 1 }, status: 400 });
  const rejected = await api(app, '/api/signin/' + id + '/code', { method: 'POST', body: { code: 'rejected-code' }, status: 400 });
  assert.equal(rejected.code, 'signin_code_invalid');
  assert.ok(!JSON.stringify(rejected).includes(SECRET));
  const ok = await api(app, '/api/signin/' + id + '/code', { method: 'POST', body: { code: '  good-code#state  ' } });
  assert.equal(ok.status, 'awaiting_browser');
  assert.deepEqual(submitted, ['good-code#state']);
  provider.calls[0].handle.complete();
  await waitFor(async () => (await api(app, '/api/signin/' + id)).status === 'complete', 'sign-in complete');
  const late = await api(app, '/api/signin/' + id + '/code', { method: 'POST', body: { code: 'late-code' }, status: 409 });
  assert.equal(late.code, 'signin_not_waiting_for_code');
});

test('closing the app waits for an open sign-in to remove its sandbox', testOptions, async t => {
  let removed = false;
  const provider = recorder(() => fakeFlow({ cancel() { return new Promise(resolve => setTimeout(() => { removed = true; resolve(); }, 200)); } }));
  const { app } = await start(t, { startProvider: provider }, { docker: true, signedIn: false });
  await post(app, '/api/signin/codex');
  await app.close();
  assert.equal(removed, true);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('Codex sign-in diagnostics retain finite reasons without errors or URLs', testOptions, async t => {
  let starts = 0;
  const { app, home } = await start(t, { startProvider: async (_spec, {setStage}) => {
    starts++;
    if (starts === 1) {
      setStage('sandbox_prepare');
      const error = new Error(SECRET + ' https://private.example.test/auth?state=hostile');
      error.code = 'credential_scope_unenforceable';
      error.condition = 'other_sandbox_lease';
      throw error;
    }
    if (starts === 2) return fakeFlow({ waitForCompletion: async () => ({
      status: 'failed', diagnosticReason: 'guest_not_authenticated',
      detail: SECRET + ' https://private.example.test/auth?state=hostile',
    }) });
    return fakeFlow({ waitForCompletion: async () => ({
      status: 'complete', diagnosticReason: 'authenticated',
      detail: SECRET + ' https://private.example.test/auth?state=hostile',
    }) });
  } }, { docker: true, signedIn: false });

  const failedStart = await api(app, '/api/signin/codex', { method: 'POST', body: {}, status: 409 });
  assert.equal(failedStart.code, 'signin_failed');
  const started = await post(app, '/api/signin/codex');
  assert.equal(started.status, 'awaiting_browser');
  await waitFor(async () => {
    const view = await api(app, '/api/signin/' + started.flowId);
    return view.status === 'failed' && view;
  }, 'failed Codex sign-in completion');

  const successful = await post(app, '/api/signin/codex');
  await waitFor(async () => {
    const view = await api(app, '/api/signin/' + successful.flowId);
    return view.status === 'complete' && view;
  }, 'successful Codex sign-in completion');

  const diagnosticFile = join(home, 'v1', 'lending-errors.jsonl');
  const records = await waitFor(async () => {
    try {
      const events = (await readFile(diagnosticFile, 'utf8')).trim().split('\n').map(JSON.parse);
      const signins = events.filter(event => event.phase === 'signin');
      return signins.length === 3 ? signins : null;
    } catch { return null; }
  }, 'three local sign-in diagnostic records');
  assert.deepEqual(records.map(event => event.code), ['credential_scope_unenforceable', 'guest_not_authenticated', 'authenticated']);
  assert.equal(records[0].condition, 'other_sandbox_lease');
  assert.equal(records[0].stage, 'sandbox_prepare');
  for (const event of records) {
    assert.equal(event.target, 'codex');
    assert.equal(Number.isSafeInteger(event.elapsed_ms), true);
    assert.ok(event.elapsed_ms >= 0);
    assert.ok(!JSON.stringify(event).includes(SECRET));
    assert.ok(!JSON.stringify(event).includes('private.example.test'));
  }
  const activity = await api(app, '/api/activity');
  assert.ok(!JSON.stringify(activity).includes(SECRET));
  assert.ok(!JSON.stringify(activity).includes('private.example.test'));
});

test('starting Codex does not let a suppressed Claude lending check erase cached sign-in evidence', testOptions, async t => {
  const checkEntered = deferred(), releaseCheck = deferred(), codexStarting = deferred();
  let holdClaudeCheck = false;
  // Claude's sign-in evidence is Faravan's own store; the Docker proxy's login does not answer for it.
  let storeState = 'in';
  const lendingUsageStore = { credential: async () => {
    if (storeState === 'in') return { kind: 'oauth', bearer: 'fake-access', refresh: 'fake-refresh', expiresAt: Date.now() + 3600e3, generation: 'g1', digest: 'd1' };
    throw Object.assign(new Error('no credential'), { code: 'usage_credential_unavailable', reason: storeState === 'out' ? 'not_signed_in' : 'unreadable' });
  } };
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  backend.waitForHealth = async () => { codexStarting.resolve(); };
  const claude = { ...HARNESS_ADAPTERS.find(entry => entry.spec.harness_id === 'claude-code-subscription'),
    installed: true, proxySignedIn: true };
  const codex = { ...HARNESS_ADAPTERS.find(entry => entry.spec.harness_id === 'codex'),
    installed: true, proxySignedIn: false };
  const { app } = await f.start('owner', {
    backend, lendingUsageStore,
    adapters: [claude, codex],
    lendingSignInProbe: async id => {
      if (id === 'claude-code-subscription' && holdClaudeCheck) {
        checkEntered.resolve();
        return releaseCheck.promise;
      }
      return { signedIn: null, source: 'unavailable' };
    },
    signin: { startProvider: async spec => {
      assert.equal(spec.harness_id, 'codex');
      return fakeFlow();
    } },
  });

  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['claude-code-subscription'] } });
  assert.equal((await api(app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription').proxySignedIn, true);

  storeState = 'out';
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['claude-code-subscription'] } });
  assert.equal((await api(app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription').proxySignedIn, false);
  storeState = 'in';
  await api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['claude-code-subscription'] } });
  assert.equal((await api(app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription').proxySignedIn, true);

  // The store cannot be read while the held check runs: unknown never erases what was last confirmed.
  storeState = 'unreadable';
  holdClaudeCheck = true;
  const refreshing = api(app, '/api/agents/refresh', { method: 'POST', body: { agents: ['claude-code-subscription'] } });
  await checkEntered.promise;
  const starting = post(app, '/api/signin/codex');
  await codexStarting.promise;
  releaseCheck.resolve({ signedIn: null, source: 'unavailable' });
  await refreshing;
  const started = await starting;
  assert.equal(started.status, 'awaiting_browser');

  const claudeAfter = (await api(app, '/api/agents')).find(agent => agent.id === 'claude-code-subscription');
  assert.equal(claudeAfter.proxySignedIn, true);
  assert.equal(claudeAfter.signedIn, true);
});

test('provider terminal paths destroy each prepared sandbox exactly once', testOptions, async t => {
  const { startProviderSignIn } = await import('../lib/v1/signin.mjs');
  const spec = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex').spec;
  for (const terminal of ['immediate', 'complete', 'failed', 'reject', 'cancel', 'timeout', 'invalid-url', 'start-error']) {
    await t.test(terminal, async () => {
      let prepared = 0, destroyed = 0;
      const completion = deferred();
      const raw = fakeFlow({
        ...(terminal === 'immediate' ? { status: 'complete' } : {}),
        ...(terminal === 'invalid-url' ? { url: 'http://invalid.example.test' } : {}),
        waitForCompletion: () => completion.promise,
        cancel() { completion.resolve({ status: 'failed' }); },
      });
      const backend = {
        probeCapabilities: async () => ({ available: true }),
        prepare: async () => { prepared++; return { sandbox_id: 'fake-only' }; },
        destroy: async () => { destroyed++; },
      };
      const signin = createSignin({
        adapters: async () => [{ spec }], backend: () => backend, onComplete: async () => {},
        timeoutMs: 10,
        startProvider: (spec, options) => startProviderSignIn(spec, { ...options,
          startFlow: async () => {
            if (terminal === 'start-error') throw new Error(SECRET);
            return raw;
          } }),
      });
      try {
        if (['invalid-url', 'start-error'].includes(terminal)) {
          await assert.rejects(signin.start('codex'), { code: 'signin_failed' });
        } else {
          const view = await signin.start('codex');
          if (terminal === 'complete') completion.resolve({ status: 'complete' });
          if (terminal === 'failed') completion.resolve({ status: 'failed' });
          if (terminal === 'reject') completion.reject(new Error(SECRET));
          if (terminal === 'cancel') signin.cancel(view.flowId);
          if (terminal !== 'immediate') await waitFor(() => signin.get(view.flowId).status !== 'awaiting_browser', terminal);
          assert.equal(signin.get(view.flowId).url, undefined);
          assert.equal(signin.get(view.flowId).code, undefined);
        }
        await signin.close();
        await signin.close();
        assert.equal(prepared, 1);
        assert.equal(destroyed, 1, terminal);
      } finally { completion.resolve({ status: 'failed' }); await signin.close(); }
    });
  }
});

test('already-complete POST does not wait for the background refresh', testOptions, async () => {
  const refresh = deferred();
  let called = 0;
  const signin = createSignin({ adapters: async () => [], backend: () => null,
    onComplete: () => { called++; return refresh.promise; },
    startDocker: async () => fakeFlow({ status: 'complete' }) });
  let response;
  const request = signin.post(['signin', 'docker'], {}).then(value => { response = value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response?.status, 'complete');
    assert.equal(response.url, undefined);
    assert.equal(response.code, undefined);
    assert.equal(called, 1);
  } finally { refresh.resolve(); await request; await signin.close(); }
});

test('close waits for late startup handles and asynchronous sandbox removal', testOptions, async () => {
  const startup = deferred(), removal = deferred();
  let earlyCancelled = 0, lateCancelled = 0, closed = false;
  const early = { cancel() { earlyCancelled++; } };
  const late = fakeFlow({ cancel() { lateCancelled++; return removal.promise; } });
  const signin = createSignin({ adapters: async () => [], backend: () => null, onComplete: async () => {},
    startGitHub: async ({ onHandle }) => { onHandle(early); await startup.promise; return late; } });
  const request = signin.start('github');
  await new Promise(resolve => setImmediate(resolve));
  const closing = signin.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'startup still pending');
    startup.resolve();
    await request;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'removal still pending');
    assert.equal(earlyCancelled, 1);
    assert.equal(lateCancelled, 1);
  } finally { startup.resolve(); removal.resolve(); await request; await closing; }
});

test('sign-in remains busy through credential-writer cancellation cleanup',async()=>{
  let release;const cleaned=new Promise(resolve=>{release=resolve;});
  const handle=fakeFlow({cancel:()=>cleaned});
  const signin=createSignin({backend:()=>null,startDocker:async()=>handle});
  assert.equal(signin.busy,false);
  const flow=await signin.start('docker');assert.equal(signin.busy,true);
  signin.cancel(flow.flowId);assert.equal(signin.busy,true);
  release();await signin.close();assert.equal(signin.busy,false);
});

test('sign-in is busy before beforeStart yields to recovery',async()=>{
  let release,entered;const hold=new Promise(resolve=>{release=resolve;});const reached=new Promise(resolve=>{entered=resolve;});
  const signin=createSignin({backend:()=>null,beforeStart:async()=>{entered();await hold;},startDocker:async()=>fakeFlow()});
  const start=signin.start('docker');await reached;
  try {assert.equal(signin.busy,true);}finally{release();await start;await signin.close();}
});

test('progress tab recovers server flow state when startup is slow and the opener cannot save its URL', async () => {
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const signin = createSignin({
    backend: () => null,
    beforeStart: async () => { entered(); await hold; },
    startDocker: async () => fakeFlow(),
  });
  const values = new Map(); let writes = 0;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes++; if (writes > 1) throw new Error('storage unavailable'); values.set(key, value); },
  };
  const api = {
    post: (path, body) => signin.post(path.split('/'), body),
    get: path => Promise.resolve(signin.get(path.split('/').at(-1))),
  };
  const id = '01234567-89ab-4def-8123-456789abcdef';
  try {
    const started = await beginSignIn({ api, target: 'docker', storage, open: () => null, id, onFlow: () => {} });
    assert.equal(started.status, 'starting');
    await reached;
    assert.equal(progressView(readProgress(storage, id)).url, null);
    assert.equal((await api.get('signin/' + id)).status, 'starting', 'the server exposes the flow before preparation finishes');
    const duplicateId = '11234567-89ab-4def-8123-456789abcdef';
    const duplicate = await signin.post(['signin', 'docker'], { requestId: duplicateId });
    assert.equal(duplicate.flowId, started.flowId, 'same-target starts remain deduplicated');
    assert.equal(signin.get(duplicateId).flowId, started.flowId, 'the duplicate progress ID resolves to the shared server flow');

    release();
    const recovered = await waitFor(async () => {
      const flow = await api.get('signin/' + id);
      return flow.url ? flow : false;
    }, 'server-owned URL');
    assert.equal(recovered.status, 'awaiting_browser');
    assert.equal(recovered.url, 'https://login.example.test/device');
    assert.equal(progressView({ target: 'docker', startedAt: Date.now(), flow: recovered }).url, recovered.url,
      'the progress tab can redirect from its server poll even though the URL-bearing localStorage write failed');
    await signin.close();
  } finally { release(); await signin.close(); }
});

test('canceling a server-owned starting flow prevents auth startup after the preparation barrier', async () => {
  let release, entered, started = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const signin = createSignin({ beforeStart: async () => { entered(); await hold; }, startDocker: async () => { started++; return fakeFlow(); } });
  try {
    const flow = await signin.post(['signin', 'docker'], { requestId: '01234567-89ab-4def-8123-456789abcdef' });
    await reached;
    assert.equal(flow.status, 'starting');
    assert.equal(signin.cancel(flow.flowId).status, 'cancelled');
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 0);
    assert.equal(signin.get(flow.flowId).status, 'cancelled');
  } finally { release(); await signin.close(); }
});

test('starting exposes only finite stages through health, identity drain, guard, and provider preparation', async () => {
  const allowed = new Set(SIGNIN_STARTING_STAGES);
  let release, entered;
  const hold = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const spec = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === 'codex').spec;
  const seen=[];
  const backend = {
    probeCapabilities: async () => ({ available: true }),
    prepare: async () => ({ sandbox_id: 'fake-only' }),
    destroy: async () => {},
  };
  let signin;
  signin = createSignin({
    adapters: async () => { seen.push(signin.get(id).stage); return [{ spec }]; }, backend: () => backend,
    beforeStart: async setStage => { setStage('backend_health'); seen.push(signin.get(id).stage); setStage('identity_drain'); seen.push(signin.get(id).stage); entered(); await hold; },
    guard: async (_target, setStage) => { setStage('docker_guard'); seen.push(signin.get(id).stage); },
    startProvider: (spec, options) => startProviderSignIn(spec, { ...options,
      setStage: stage => { seen.push(stage); options.setStage(stage); },
      startFlow: async (_spec, { onHandle }) => { const flow = fakeFlow(); onHandle(flow); return flow; } }),
  });
  const id='41234567-89ab-4def-8123-456789abcdef';
  try {
    const started=await signin.post(['signin','codex'],{requestId:id});
    assert.equal(started.stage,'identity_drain');
    await reached;
    assert.equal(signin.get(id).stage,'identity_drain');
    assert.ok(allowed.has(signin.get(id).stage));
    release();
    const ready=await waitFor(()=>{
      const view=signin.get(id);
      return view.status==='awaiting_browser'?view:false;
    },'provider URL');
    assert.equal(ready.stage,undefined,'stage is omitted once the browser URL is ready');
    assert.deepEqual(seen,['backend_health','identity_drain','adapter_resolution','docker_guard','capabilities','sandbox_prepare','provider_url']);
    assert.ok(seen.every(stage=>allowed.has(stage)));
  } finally { release(); await signin.close(); }
});

test('provider preparation failures retain only an allowlisted reason and the last finite stage', async () => {
  const spec = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === 'codex').spec;
  const hostile = 'policy failed https://attacker.test/?token=' + SECRET + ' for user alice';
  const events = [];
  const signin = createSignin({ adapters: async () => [{ spec }], backend: () => null,
    startProvider: async (_spec, { setStage }) => {
      setStage('sandbox_prepare');
      throw Object.assign(new Error(hostile), { code: 'policy_unenforceable' });
    }, onDiagnostic: event => events.push(event) });
  const requestId = '51234567-89ab-4def-8123-456789abcdef';
  try {
    await signin.begin('codex', requestId);
    const failed = await waitFor(() => {
      const view = signin.get(requestId);
      return view.status === 'failed' ? view : false;
    }, 'sandbox preparation failure');
    assert.equal(failed.reasonCode, 'policy_unenforceable');
    assert.equal(failed.stage, 'sandbox_prepare');
    assert.deepEqual(events, [{ target: 'codex', code: 'policy_unenforceable', elapsedMs: events[0].elapsedMs, stage: 'sandbox_prepare' }]);
    assert.ok(!JSON.stringify(failed).includes(hostile));
    assert.ok(!JSON.stringify(events).includes(hostile));
  } finally { await signin.close(); }
});

test('unknown provider errors remain startup_failed and do not expose their message', async () => {
  const spec = HARNESS_ADAPTERS.find(adapter => adapter.spec.harness_id === 'codex').spec;
  const hostile = 'private detail https://attacker.test/?token=' + SECRET;
  const events = [];
  const signin = createSignin({ adapters: async () => [{ spec }], backend: () => null,
    startProvider: async (_spec, { setStage }) => {
      setStage('sandbox_prepare');
      throw Object.assign(new Error(hostile), { code: 'arbitrary_private_code' });
    }, onDiagnostic: event => events.push(event) });
  try {
    const requestId = '61234567-89ab-4def-8123-456789abcdef';
    await signin.begin('codex', requestId);
    const failed = await waitFor(() => {
      const view = signin.get(requestId);
      return view.status === 'failed' ? view : false;
    }, 'unknown startup failure');
    assert.equal(failed.reasonCode, 'startup_failed');
    assert.equal(failed.stage, 'sandbox_prepare');
    assert.equal(events[0].code, 'startup_failed');
    assert.equal(events[0].stage, 'sandbox_prepare');
    assert.ok(!JSON.stringify(failed).includes(hostile));
    assert.ok(!JSON.stringify(events).includes(hostile));
  } finally { await signin.close(); }
});

test('Q4 P2-2 lease condition reaches the UI in safe existing message copy', async t => {
  const signin=createSignin({startGitHub:async()=>{throw Object.assign(Error(SECRET),{
    code:'credential_scope_unenforceable',condition:'other_sandbox_lease'});}});
  t.after(()=>signin.close());
  const initial=await signin.begin('github','condition-case');
  await waitFor(()=>signin.get(initial.flowId).status==='failed','lease failure');
  const flow=signin.get(initial.flowId);
  assert.equal(flow.reasonCode,'credential_scope_unenforceable');
  assert.match(flow.message,/another.*wait/i);
  assert.match(progressView({target:'github',flow}).status,/another.*wait/i);
  assert.ok(!JSON.stringify(flow).includes(SECRET));
});

test('real native cancellation keeps service busy and close pending through lease release', testOptions, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-signin-native-drain-'));
  const originalHome = process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME = join(dir, 'home');
  const sbxBin = join(dir, 'sbx');
  await writeFile(sbxBin, `#!/bin/sh
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then echo 'No secrets found'; exit 0; fi
    echo 'Open this URL to sign in: https://auth.example.test/native'
    sleep 30
  `, { mode: 0o755 });
  const current = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex').spec;
  const spec = { ...current, auth_strategy: 'docker-native-oauth',
    credential_discovery: { ...current.credential_discovery,
      login_command: 'sbx secret set -g openai --oauth --force', url_prompt_pattern: 'Open this URL to sign in' },
    login_status_probe: { ...current.login_status_probe, success: { SBX_CRED_OPENAI_MODE: 'oauth' } } };
  const releaseEntered = deferred(), releaseGate = deferred();
  let released = false, destroyed = 0, closed = false, native, earlyWrapper, finalWrapper;
  const backend = {
    probeCapabilities: async () => ({ available: true }),
    prepare: async () => ({ sandbox_id: 'native-drain' }),
    destroy: async () => { destroyed++; },
  };
  const signin = createSignin({
    adapters: async () => [{ spec }], backend: () => backend, onComplete: async () => {},
    startProvider: async (spec, options) => {
      finalWrapper = await startProviderSignIn(spec, { ...options,
        onHandle: handle => { earlyWrapper = handle; options.onHandle(handle); },
        startFlow: async (spec, flowOptions) => {
          native = await startAuthFlow(spec, { ...flowOptions, sbxBin,
            acquireCredentialMutation: async () => async () => {
              releaseEntered.resolve();
              await releaseGate.promise;
              released = true;
            } });
          return native;
        } });
      return finalWrapper;
    },
  });
  t.after(async () => {
    releaseGate.resolve();
    await signin.close();
    if (originalHome === undefined) delete process.env.FARAVAN_SBX_HOME;
    else process.env.FARAVAN_SBX_HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  });
  const flow = await signin.start('codex');
  assert.equal(flow.status, 'awaiting_browser');
  signin.cancel(flow.flowId);
  await releaseEntered.promise;
  const closing = signin.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(released, false);
  assert.equal(signin.busy, true, 'native writer/lease drain remains tracked');
  assert.equal(closed, false, 'close must await native cleanup, not just sandbox destruction');
  const stopping = native.cancel();
  assert.equal(native.cancel(), stopping, 'native cancellation has one drain promise');
  assert.equal(earlyWrapper.cancel(), finalWrapper.cancel(), 'early and final wrappers retain one cancellation drain');
  releaseGate.resolve();
  await closing;
  assert.equal(released, true);
  assert.equal(signin.busy, false);
  assert.equal(destroyed, 1, 'prompt backend destroy is still exactly once');
});

test('a Docker sign-in that fails writes a diagnostic row with its class and exit code', async t => {
  const { SbxLoginError } = await import('../lib/sbx-login.mjs');
  const docker = async () => { throw new SbxLoginError('Docker sign-in ended before showing a browser link (exit 1).', { diagnosticReason: 'login_browser_unavailable', exitCode: 1 }); };
  const f = await appFixture(t);
  const { app } = await f.start('owner', { backend: dockerBackend(f.root, { docker: false, signedIn: false }), identityProbe: async () => ({}), signin: { startDocker: docker } });
  const failed = await post(app, '/api/signin/docker', 409);
  assert.equal(failed.code, 'signin_failed');
  const file = join(await f.home('owner'), 'v1', 'lending-errors.jsonl');
  let last = { state: 'not read', rows: [] };
  const row = await waitFor(async () => {
    try {
      const rows = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
        .filter(entry => entry.phase === 'signin' && entry.target === 'docker');
      last = { state: 'read', rows: rows.map(({code, exit_code}) => ({code, exit_code})) };
      return rows[0] ?? null;
    } catch (error) {
      last = { state: error.code ?? error.name, rows: [] };
      return null;
    }
  }, 'a docker sign-in diagnostic row').catch(cause => {
    throw new Error('Docker sign-in diagnostic not observed; last read: ' + JSON.stringify(last), {cause});
  });
  assert.equal(row.code, 'login_browser_unavailable');
  assert.equal(row.exit_code, 1);
});

// Every server receipt is serialized by view(), including wait's nested flow.
test('remaining code lifetime is present and decreases on start, get, wait, replay and submit receipts', async t => {
  const {opById}=await import('../lib/v1/ops/registry.mjs');
  let time=Date.now();
  const handle=fakeFlow({expiresAt:time+60_000, acceptsCode:true, submitCode() {}});
  const signin=createSignin({backend:()=>({}),now:()=>time, startDocker:async()=>handle, onComplete:async()=>{}});
  t.after(()=>signin.close());
  const first=await signin.start('docker');
  assert.equal(first.expiresInMs,60_000,'start');
  time+=1000;
  assert.equal(signin.get(first.flowId).expiresInMs,59_000,'get / phone polling serializer');
  time+=1000;
  const waited=await opById('signin.wait').handler({call:async()=>signin.get(first.flowId)}, {flowId:first.flowId,until:'browser'});
  assert.equal(waited.flow.expiresInMs,58_000,'wait');
  time+=1000;
  assert.equal((await signin.post(['signin','docker'],{})).expiresInMs,57_000,'replayed start');
  time+=1000;
  assert.equal((await signin.post(['signin',first.flowId,'code'],{code:'12345678'})).expiresInMs,56_000,'submit');
  assert.equal(signin.cancel(first.flowId).expiresInMs,undefined,'terminal receipt has no code or remaining duration');
});
test('codes without a provider expiry use the server sign-in window, no-code receipts omit duration', async t => {
  let time=Date.now();
  const signin=createSignin({backend:()=>({}),now:()=>time,timeoutMs:60_000,startDocker:async()=>fakeFlow(),onComplete:async()=>{}});
  t.after(()=>signin.close());
  const flow=await signin.start('docker');
  assert.equal(flow.expiresInMs,60_000);
  time+=1000;
  assert.equal(signin.get(flow.flowId).expiresInMs,59_000);
  const noCode=createSignin({backend:()=>({}),startDocker:async()=>fakeFlow({code:undefined}),onComplete:async()=>{}});
  t.after(()=>noCode.close());
  assert.equal((await noCode.start('docker')).expiresInMs,undefined);
});
