import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import fs from 'node:fs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
import {sandboxDeadlineClock} from '../lib/sandbox-deadline.mjs';
import { DockerSbxBackend, probeSbxPreflight, dockerSessionRefused, workspaceFailure } from '../lib/docker-backend.mjs';
import { createSbxPolicy } from './helpers/sbx-policy-model.mjs';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { setupVM } from '../ui/v1/src/view-models.mjs';
import { fakeSandboxDeadlines } from './helpers/sandbox-receipt-fixture.mjs';
import { createDiskLedger } from '../lib/disk-ledger.mjs';

const SIGNED_IN = '✓ Authentication — authenticated';
const SIGNED_OUT = '✗ Authentication — not authenticated';
const CREATE_REFUSAL = 'error: not signed in to Docker';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
function runHelp() {
  return ['Usage: sbx run [flags] AGENT PATH', 'Flags:', '  -d, --detach', '      --detach-keys string', '      --name string', '      --kit stringArray',
    '      --cpus', '      --memory', '      --skills', '      --static-mcp', '      --deny-network'].join('\n');
}

// A fake sbx: listing always works (it works signed out), diagnose reports whatever `state.auth` says.
function preflightRunner(state) {
  return async (command, args) => {
    const key = args.join(' ');
    if (key === 'version') return ok('sbx version: v0.51.0 abc123');
    if (key === 'diagnose') return state.auth === null ? ok('Daemon healthy\n✓ Global network policy — initialized')
      : { code: state.auth === SIGNED_IN ? 0 : 1, stdout: `Daemon healthy\n${state.auth}\n✓ Global network policy — initialized`, stderr: '' };
    if (key === 'ls -q') return state.lsError ? { code: 1, stdout: '', stderr: state.lsError } : ok('sandbox-id\n');
    if (key === 'policy ls') return ok('Global network policy: deny-all');
    if (key === 'run --help') return ok(runHelp());
    if (command === 'dpkg-query') return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if (command === 'docker') return ok('28.0.0');
    if (command === 'containerd') return ok('containerd github.com/containerd/containerd v2.1.0');
    if (command === 'test') return ok();
    throw new Error(`Unexpected preflight command: ${command} ${key}`);
  };
}
const probe = (state, extra = {}) => probeSbxPreflight({ runCommand: preflightRunner(state), platformName: 'linux', sbxHomePath: '/s', inspectDaemons: async () => [], ...extra });
const login = result => result.checks.find(check => check.name === 'docker_login');

test('diagnose alone never fails the Docker sign-in: its answer depends on the environment sbx runs in', async () => {
  for (const auth of [SIGNED_OUT, null]) {
    const out = await probe({ auth });
    assert.equal(login(out).ok, true, String(auth));
    assert.equal(login(out).unknown, undefined);
  }
  assert.equal(login(await probe({ auth: SIGNED_IN })).ok, true);
});

function manualTimers() {
  const timers = [];
  return { timers, setTimeout(callback, milliseconds) { const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {} };
}

// Create is the one command that refuses a signed-out session. `world.createFails` switches it.
let profile = 0;
function createWorld({ createFails = true, createStderr = CREATE_REFUSAL } = {}) {
  const world = { createFails, auth: SIGNED_IN, calls: [], plans: [] };
  const policy = createSbxPolicy();
  let sandbox, exists = false;
  const sbx = async args => {
    world.calls.push([...args]);
    if (args[0] === 'settings') return { code: 0, stdout: args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '' };
    if (args[0] === 'secret') return { code: 0, stdout: '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}', stderr: '' };
    if (args[0] === 'run' || args[0] === 'create') {
      const plan = world.plans.shift() ?? {};
      if (plan.hold) await plan.hold;
      const fails = plan.fails ?? world.createFails;
      sandbox = args[args.indexOf('--name') + 1];
      exists = !fails;
      if (fails) return world.createResult ?? { code: 1, exited: true, stderr: createStderr, stdout: '' };
      policy.createSandbox(sandbox, { kitAllow: ['api.anthropic.com:443'] });
    }
    if (args[0] === 'rm') exists = false;
    if (args[0] === 'policy') return policy.run(args);
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify(exists ? [{ name: sandbox, status: 'running' }] : []), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  world.timers = manualTimers();
  const home = join(process.env.FARAVAN_TEST_HOME, 'docker-login-profile-' + (++profile));
  world.home = home;
  const backendOptions = { home, cleanupDirectory: join(home, 'v1/sandbox-cleanup'),
    diskLedger: createDiskLedger({ file: join(home, 'disk-ledger.json') }),
    runCommand: sbx, deadlineTimers: world.timers, sandboxDeadlines: fakeSandboxDeadlines() };
  world.backend = new DockerSbxBackend(backendOptions);
  world.restart = () => { world.backend = new DockerSbxBackend(backendOptions); };
  world.report = (extra = {}) => world.backend.lenderCapabilities({ runCommand: preflightRunner(world), platformName: 'linux', sbxHomePath: '/s', inspectDaemons: async () => [], ...extra });
  return world;
}

test('a sandbox create that refuses with "not signed in" fails docker_login until a later check proves sign-in', async () => {
  const world = createWorld();
  const before = await world.report();
  assert.equal(login(before.preflight).ok, true, 'before any create refusal the listing stands');

  const workspace = await world.backend.testWorkspace();
  assert.equal(workspace.cause, 'not_signed_in');

  for (let again = 0; again < 2; again++) {
    const after = await world.report();
    assert.equal(after.available, false);
    assert.equal(login(after.preflight).ok, false, 'a diagnose that still says signed in does not clear it');
    assert.equal(login(after.preflight).detail, 'Sign in to Docker to lend.');
    assert.equal(login(after.preflight).fix, 'Open Faravan and select Sign in to Docker.');
  }
  const watched = await world.report({ observation: true });
  assert.equal(login(watched.preflight).ok, false, 'observations show it too');

  // Diagnose never clears the mark, whatever it reports: only an accepted create does.
  for (const auth of [SIGNED_OUT, SIGNED_IN, null]) {
    world.auth = auth;
    assert.equal(login((await world.report()).preflight).ok, false, String(auth));
  }
  assert.equal(world.backend.signInRefused(), true);
  world.createFails = false;
  assert.equal((await world.backend.recoverSignIn())?.ok, true);
  const cleared = await world.report();
  assert.equal(login(cleared.preflight).ok, true);
  assert.equal(cleared.available, true);
});

test('a cleanup hold on a create is a hold, never a Docker sign-out: no create reaches sbx and no refusal is recorded', async () => {
  // The create would be refused as signed out if it ran. The hold stops it first, for the target and for everything.
  for (const scope of ['target', 'global']) {
    const world = createWorld();
    world.backend.deadlineTargetDebt = () => [{id: 'row', name: 'held', status: 'pending', protected: false}];
    if (scope === 'global') world.backend.ensureSandboxAdmission = async () => { throw Object.assign(new Error('Cleanup is unverified.'), {code: 'cessation_unverified', recovery_scope: 'global'}); };
    const before = world.backend.signInRefused();
    const result = await world.backend.testWorkspace().catch(error => ({thrown: error}));
    assert.notEqual(result?.cause, 'not_signed_in', scope + ': a hold is not a sign-out');
    assert.equal(world.calls.some(call => call[0] === 'create' || call[0] === 'run'), false, scope + ': the create never reached sbx');
    assert.equal(world.backend.signInRefused(), before, scope + ': no refusal evidence was written');
    assert.equal(login((await world.report()).preflight).ok, true, scope + ': Docker sign-in still stands');
  }
});

test('a create that dies in transport keeps its subcause and exit evidence, and never claims a sign-out', async () => {
  // Evidence set where the create fails (lib/docker-backend.mjs create-failure seam) is what the probe diagnostics read.
  for (const [label, result, subcause, exitCode] of [
    ['timeout', { code: 1, errorCode: 'ETIMEDOUT', stderr: 'private', stdout: '' }, 'timeout', undefined],
    ['killed', { code: 137, killed: true, stderr: 'private', stdout: '' }, 'killed', undefined],
    ['signal beats exit', { code: 137, exited: true, signal: 'SIGKILL', stderr: 'private', stdout: '' }, 'killed', undefined],
    ['real exit', { code: 23, exited: true, stderr: 'private', stdout: '' }, 'unknown', 23],
    ['gate refusal passes through', { code: 1, probe_subcause: 'execution_gate_refused', stderr: 'private', stdout: '' }, 'execution_gate_refused', undefined],
  ]) {
    const world = createWorld();
    world.createResult = result;
    let seen;
    const prepare = world.backend.prepare.bind(world.backend);
    world.backend.prepare = async (...args) => { try { return await prepare(...args); } catch (error) { seen = error; throw error; } };
    await world.backend.testWorkspace();
    assert.equal(seen?.code, 'sandbox_start_failed', label);
    assert.equal(seen.probe_subcause, subcause, label);
    assert.equal(seen.exitCode, exitCode, label);
    assert.ok(!JSON.stringify({ ...seen, message: undefined }).includes('private'), label + ': no raw stderr in the evidence');
    assert.equal(world.backend.signInRefused(), false, label + ': not a sign-out');
  }
});

test('a create that works clears an earlier sign-in refusal', async () => {
  const world = createWorld();
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  assert.equal(login((await world.report()).preflight).ok, false);
  world.createFails = false;
  assert.equal((await world.backend.testWorkspace()).ok, true);
  assert.equal(login((await world.report()).preflight).ok, true);
});

test('other create failures do not claim a sign-out', async () => {
  const world = createWorld({ createStderr: 'daemon timeout' });
  assert.notEqual((await world.backend.testWorkspace()).cause, 'not_signed_in');
  assert.equal(login((await world.report()).preflight).ok, true);
});

test('the signed-out state never prints or stores a token', async () => {
  const secret = 'dckr_pat_SYNTHETICSECRET123';
  const world = createWorld({ createStderr: `${CREATE_REFUSAL}\ntoken ${secret}` });
  const workspace = await world.backend.testWorkspace();
  const report = await world.report();
  assert.equal(login(report.preflight).ok, false);
  assert.ok(!JSON.stringify(report).includes(secret), 'readiness carries no token');
  assert.ok(!JSON.stringify(Object.getOwnPropertyNames(world.backend).map(name => world.backend[name] instanceof Map ? [...world.backend[name]] : world.backend[name]))
    .includes(secret), 'the backend keeps no token');
  assert.ok(!JSON.stringify({ ...workspace, diagnostics: undefined }).includes(secret));
});

test('Setup and blockers show the Docker sign-in step after a create refusal, with the listing working', async t => {
  const f = await appFixture(t);
  const world = createWorld();
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => { const report = await world.report(); return { available: report.available, preflight: report.preflight }; };
  const { lender, circle } = await f.connect({ backend });
  const app = lender.app;
  await api(app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });

  const readiness = await api(app, '/api/ops/readiness.get', { method: 'POST', body: { refresh: true } });
  const blockers = await api(app, '/api/ops/status.blockers', { method: 'POST', body: {} });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.find(c => c.name === 'docker_login').ok, false);
  assert.equal(blockers.can_lend, false);
  assert.equal(blockers.blockers.filter(b => b.kind === 'docker_signed_out').length, 1);
  assert.equal(blockers.blockers.some(b => b.kind === 'agent_not_ready'), false, 'Docker sign-in is the named cause');
  assert.deepEqual(blockers.blockers.find(b => b.kind === 'docker_signed_out').fix, { op: 'signin.start', input: { target: 'docker' } });

  const setup = setupVM({ readiness, agents: [], status: { lending: { enabled: false } } });
  assert.notEqual(setup.steps.find(s => s.id === 'docker-account')?.state, 'ok');
});

test('a diagnose with no Authentication line does not block lending', async t => {
  const f = await appFixture(t);
  const state = { auth: null };
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => { const preflight = await probe(state); return { available: preflight.ok, preflight }; };
  const { lender } = await f.connect({ backend });
  const readiness = await api(lender.app, '/api/ops/readiness.get', { method: 'POST', body: { refresh: true } });
  assert.equal(readiness.checks.find(c => c.name === 'docker_login').ok, true);
  assert.equal(readiness.ready, true);
});

// ---- Recovery, narrow classification, cache fences, refusal epochs, shared result boundary ----

test('recovery: one explicit create clears a refusal even when diagnose reads signed in throughout', async () => {
  const world = createWorld();
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  assert.equal(world.backend.signInRefused(), true);
  assert.equal(login((await world.report()).preflight).ok, false);

  // Still refused: the recovery create fails, the refusal stays, and nothing was left behind.
  assert.equal((await world.backend.recoverSignIn())?.cause, 'not_signed_in');
  assert.equal(world.backend.signInRefused(), true);

  world.createFails = false;
  assert.equal((await world.backend.recoverSignIn())?.ok, true);
  assert.equal(world.backend.signInRefused(), false);
  assert.ok(world.calls.some(args => args[0] === 'rm'), 'the throwaway sandbox is removed');
  const after = await world.report();
  assert.equal(login(after.preflight).ok, true);
  assert.equal(after.available, true);
  assert.equal(await world.backend.recoverSignIn(), null, 'no refusal, no create');
});

test('recovery is single-flight: two callers share one create', async () => {
  const world = createWorld();
  await world.backend.testWorkspace();
  world.createFails = false;
  const before = world.calls.filter(args => args[0] === 'run' || args[0] === 'create').length;
  const [a, b] = await Promise.all([world.backend.recoverSignIn(), world.backend.recoverSignIn()]);
  assert.equal(a, b);
  assert.equal(world.calls.filter(args => args[0] === 'run' || args[0] === 'create').length - before, 1);
});

test('the app recovers on Check again: refusal, then a working create, with diagnose signed in throughout', async t => {
  const f = await appFixture(t);
  const world = createWorld();
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => { const report = await world.report(); return { available: report.available, preflight: report.preflight }; };
  backend.signInRefused = () => world.backend.signInRefused();
  backend.recoverSignIn = () => world.backend.recoverSignIn();
  const { lender, circle } = await f.connect({ backend });
  const app = lender.app;
  await api(app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });

  const refused = await api(app, '/api/readiness?refresh=true');
  assert.equal(refused.checks.find(c => c.name === 'docker_login').ok, false);

  world.createFails = false;
  const recovered = await api(app, '/api/readiness?refresh=true');
  assert.equal(recovered.checks.find(c => c.name === 'docker_login').ok, true);
  const blockers = await api(app, '/api/ops/status.blockers', { method: 'POST', body: {} });
  assert.equal(blockers.blockers.some(b => b.kind === 'docker_signed_out'), false);
});

test('only Docker\'s own session refusal latches: registry, private-image and provider errors do not', async () => {
  for (const stderr of [
    'error: pull access denied: authentication required for registry.example.com/private/image',
    'Error: registry mirror is not authenticated',
    'error: authentication failed for provider anthropic: not signed in to Claude',
    'unauthorized: authentication required',
  ]) {
    const world = createWorld({ createStderr: stderr });
    await world.backend.testWorkspace();
    assert.equal(world.backend.signInRefused(), false, stderr);
    assert.equal(login((await world.report()).preflight).ok, true, stderr);
  }
  for (const stderr of ['error: not signed in to Docker', 'no valid user session, sign in to Docker', 'user is not authenticated to Docker']) {
    const world = createWorld({ createStderr: stderr });
    await world.backend.testWorkspace();
    assert.equal(world.backend.signInRefused(), true, stderr);
  }
});

test('a latch change drops cached readings: a cache primed before the refusal and before the recovery cannot answer', async () => {
  const world = createWorld({ createFails: false });
  // Prime both caches while signed in.
  assert.equal(login((await world.report({ cached: true })).preflight).ok, true);
  assert.equal(login((await world.report({ observation: true })).preflight).ok, true);
  world.createFails = true;
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  assert.equal(login((await world.report({ cached: true })).preflight).ok, false, 'cached read after the refusal');
  assert.equal(login((await world.report({ observation: true })).preflight).ok, false, 'observation after the refusal');
  // Prime again while refused, then recover.
  world.createFails = false;
  assert.equal((await world.backend.recoverSignIn())?.ok, true);
  assert.equal(login((await world.report({ cached: true })).preflight).ok, true, 'cached read after recovery');
  assert.equal(login((await world.report({ observation: true })).preflight).ok, true, 'observation after recovery');
});

test('a pending read that started before a refusal cannot clear or hide it', async () => {
  const world = createWorld({ createFails: false });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = preflightRunner(world);
  const pending = world.report({ runCommand: async (command, args) => { if (args.join(' ') === 'ls -q') await gate; return slow(command, args); } });
  await new Promise(resolve => setImmediate(resolve));
  world.createFails = true;
  await world.backend.testWorkspace();
  release();
  await pending;
  assert.equal(login((await world.report()).preflight).ok, false);
});

test('each refusal starts a new epoch: an older probe finishing late cannot clear refusal B', async () => {
  const world = createWorld();
  await world.backend.testWorkspace(); // refusal A
  world.auth = SIGNED_OUT;
  assert.equal(login((await world.report()).preflight).ok, false); // A sees signed out
  world.auth = SIGNED_IN;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const base = preflightRunner(world);
  // A full probe that will read "authenticated" starts and waits.
  const slow = world.report({ runCommand: async (command, args) => { const result = await base(command, args); if (args.join(' ') === 'diagnose') await gate; return result; } });
  await new Promise(resolve => setImmediate(resolve));
  await world.backend.testWorkspace(); // refusal B while the probe is pending
  release();
  await slow;
  assert.equal(world.backend.signInRefused(), true, 'B stays latched');
  assert.equal(login((await world.report()).preflight).ok, false, 'B stays blocked');
});

test('a refusal that returns while the signal fires is still recorded', async () => {
  const world = createWorld();
  const controller = new AbortController();
  const prepare = world.backend.prepare.bind(world.backend);
  world.backend.prepare = (job, deadline, options) => prepare(job, deadline, { ...options, signal: controller.signal });
  const original = world.backend.runSbx.bind(world.backend);
  world.backend.runSbx = async (args, options) => {
    const result = await original(args, options);
    if (args[0] === 'run' || args[0] === 'create') controller.abort(new Error('deadline'));
    return result;
  };
  await world.backend.testWorkspace().catch(() => {});
  assert.equal(world.backend.signInRefused(), true);
  assert.equal(login((await world.report()).preflight).ok, false);
});

test('rank 4: a Docker read that timed out or could not run says checking, never "Sign in to Docker"', async t => {
  for (const [label, row] of [
    ['timed out', { name: 'docker_login', ok: false, unknown: true, detail: 'The Docker sign-in read timed out.' }],
    ['refresh unavailable', { name: 'docker_login', ok: false, unknown: true, cause: 'docker_signin_refresh_unavailable', detail: 'Docker could not refresh the sign-in.' }],
  ]) {
    const f = await appFixture(t);
    const backend = syntheticBackend(f.root);
    backend.probeCapabilities = async () => {
      const preflight = await probe({ auth: SIGNED_IN });
      preflight.checks = preflight.checks.map(c => c.name === 'docker_login' ? { ...c, ...row } : c);
      preflight.ok = false;
      return { available: false, preflight };
    };
    const { lender } = await f.connect({ backend });
    const readiness = await api(lender.app, '/api/readiness?refresh=true');
    const docker = readiness.checks.find(c => c.name === 'docker_login');
    assert.doesNotMatch(String(docker.remedy), /Sign in to Docker/, label);
    const step = setupVM({ readiness, agents: [], status: { lending: { enabled: false } } }).steps.find(s => s.id === 'docker-account');
    assert.equal(step.state, 'now', label);
    assert.match(step.detail, /checking/i, label);
    assert.ok(!(step.actions ?? []).includes('docker-signin'), label);
  }
});

test('rank 4: an explicit refusal still asks for the sign-in', () => {
  const readiness = { ready: false, checks: [{ name: 'docker_login', ok: false, detail: "The sandbox service isn't signed in to Docker yet.", remedy: 'Choose Sign in to Docker.' }] };
  const step = setupVM({ readiness, agents: [], status: { lending: { enabled: false } } }).steps.find(s => s.id === 'docker-account');
  assert.notEqual(step.state, 'ok');
  assert.ok((step.actions ?? []).includes('docker-signin'));
});

// ---- Round 4: create-only clearing, narrow forms, dispatch epochs, owned recovery, app caches ----

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) { for (let i = 0; i < 500 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(test(), 'condition reached'); }
const creates = world => world.calls.filter(args => args[0] === 'run' || args[0] === 'create').length;

test('an exact Docker refusal from a failed listing records the sign-in blocker without a create', async () => {
  for (const lsError of ['error: not signed in to Docker', 'user is not authenticated to Docker']) {
    const world = createWorld({ createFails: false });
    world.lsError = lsError;
    const out = await world.report();
    assert.equal(login(out.preflight).ok, false, lsError);
    assert.equal(login(out.preflight).unknown, undefined, lsError);
    assert.equal(login(out.preflight).cause, 'docker_signed_out', lsError);
    assert.match(String(login(out.preflight).fix), /Sign in to Docker/, lsError);
    assert.equal(world.backend.signInRefused(), true);
    assert.equal(world.calls.some(args => args[0] === 'create'), false);
  }
});

test('listing advice about signing in remains unknown and starts no sign-in refusal', async () => {
  const world = createWorld({ createFails: false });
  world.lsError = 'network error: if you are not signed in to Docker, run sbx login';
  const out = await world.report();
  assert.equal(login(out.preflight).unknown, true);
  assert.equal(world.backend.signInRefused(), false);
});

test('only a whole-line Docker refusal is a refusal: advice, command names and provider errors are not', () => {
  for (const text of [
    'network timeout contacting sbx login endpoint',
    'provider anthropic: no valid user session',
    'network error: if you are not signed in to Docker, run sbx login',
    'dial tcp: i/o timeout\n  try: sbx login',
    'error: authentication required for registry.example.com',
  ]) {
    assert.equal(dockerSessionRefused(text), false, text);
    assert.notEqual(workspaceFailure({ stderr: text }).cause, 'not_signed_in', text);
  }
  for (const text of ['error: not signed in to Docker\n  try: sbx login', 'no valid user session, sign in to Docker', 'sbx create failed for sandbox x-1: error: not signed in to Docker']) {
    assert.equal(dockerSessionRefused(text), true, text);
    assert.equal(workspaceFailure({ stderr: text }).cause, 'not_signed_in', text);
  }
});

test('an accepted create that was dispatched before a newer refusal cannot clear it', async () => {
  const world = createWorld({ createFails: false });
  // Model an already-dispatched create; store serialization has its own protocol tests.
  world.backend._admitDiskJob=async()=>null;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  world.plans.push({ hold: gate, fails: false });
  const first = world.backend.testWorkspace(); // create A: dispatched, accepted later
  await until(() => creates(world) === 1);
  // Store creation is serialized. Inject the newer refusal to test the older
  // result callback without queuing another create behind the parked one.
  world.backend._setSignInRefusal(true);
  assert.equal(world.backend.signInRefused(), true);
  release();
  await first;
  assert.equal(world.backend.signInRefused(), true, 'A was dispatched before refusal B');
  assert.equal(login((await world.report()).preflight).ok, false);
  // A create dispatched after the refusal does clear it.
  assert.equal((await world.backend.recoverSignIn())?.ok, true);
  assert.equal(world.backend.signInRefused(), false);
});

test('recovery timeout while queued: the timed-out check never runs, and a repeat adds exactly one', async () => {
  const world = createWorld();
  await world.backend.testWorkspace();
  world.createFails = false;
  const callsBefore = creates(world);
  let free;
  const busy = world.backend.withSandboxCheck(() => new Promise(resolve => { free = resolve; }));
  await tick();
  const mark = world.timers.timers.length;
  const first = world.backend.recoverSignIn();
  const deadline = world.timers.timers[mark];
  assert.equal(deadline.milliseconds, 60000);
  assert.equal(world.backend.recoverSignIn(), first, 'a second click while waiting joins the flight');
  deadline.callback(); // the clock reaches the deadline while the check is still queued
  assert.equal(await first, null);
  assert.equal(creates(world), callsBefore, 'the timed-out check created nothing');
  const second = world.backend.recoverSignIn(); // queued behind the busy check, in order
  free();
  await busy;
  assert.equal((await second)?.ok, true);
  assert.equal(creates(world), callsBefore + 1, 'one create in total');
  assert.equal(world.backend.signInRefused(), false);
});

test('recovery timeout while the create is pending: still one check, and it cleans up before the next starts', async () => {
  const world = createWorld();
  await world.backend.testWorkspace();
  world.createFails = false;
  let release;
  world.plans.push({ hold: new Promise(resolve => { release = resolve; }), fails: false });
  const before = creates(world);
  const mark = world.timers.timers.length;
  const first = world.backend.recoverSignIn();
  await until(() => creates(world) === before + 1);
  world.timers.timers[mark].callback();
  assert.equal(world.backend.recoverSignIn(), first);
  assert.equal(creates(world), before + 1, 'no second create while the first is outstanding');
  release();
  await first;
  assert.equal(creates(world), before + 1);
  assert.ok(world.calls.some(args => args[0] === 'rm'), 'the sandbox from the check is removed');
});

async function lendingApp(t, world, extra = {}) {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => {
    const report = await world.report();
    const hold = world.hold; world.hold = null;
    if (hold) { world.held = true; await hold; }
    return { available: report.available, preflight: report.preflight };
  };
  backend.signInRefused = () => world.backend.signInRefused();
  backend.recoverSignIn = () => world.backend.recoverSignIn();
  Object.defineProperty(backend, 'signInGeneration', { get: () => world.backend.signInGeneration });
  const { lender } = await f.connect({ backend, ...extra });
  return lender.app;
}
const dockerRow = async app => (await api(app, '/api/readiness')).checks.find(c => c.name === 'docker_login');

test('the app serves the new state on the next plain read after a refusal and after a clear', async t => {
  const world = createWorld({ createFails: false });
  const app = await lendingApp(t, world);
  assert.equal((await dockerRow(app)).ok, true);
  assert.equal((await dockerRow(app)).ok, true, 'cache primed while healthy');
  world.createFails = true;
  assert.equal((await world.backend.testWorkspace()).cause, 'not_signed_in');
  assert.equal((await dockerRow(app)).ok, false, 'the next read, with no explicit refresh');
  const blockers = await api(app, '/api/ops/status.blockers', { method: 'POST', body: {} });
  assert.equal(blockers.blockers.filter(b => b.kind === 'docker_signed_out').length, 1);
  world.createFails = false;
  assert.equal((await world.backend.recoverSignIn())?.ok, true);
  assert.equal((await dockerRow(app)).ok, true, 'cache primed while refused, then cleared');
});

test('completing the Docker sign-in runs the one recovery create', async t => {
  const world = createWorld();
  await world.backend.testWorkspace();
  world.createFails = false;
  const app = await lendingApp(t, world, { signin: { startDocker: async () => ({ status: 'complete', cleanup: async () => {} }) } });
  assert.equal((await dockerRow(app)).ok, false);
  const before = creates(world);
  await api(app, '/api/ops/signin.start', { method: 'POST', body: { target: 'docker' } });
  await until(() => world.backend.signInRefused() === false);
  assert.equal(creates(world), before + 1);
  assert.equal((await dockerRow(app)).ok, true);
});

test('a report that was in flight when the sign-in state moved is never published or returned', async t => {
  for (const [label, start, move, expected] of [
    ['refusal during the read', { createFails: false }, async world => { world.createFails = true; await world.backend.testWorkspace(); }, false],
    ['clear during the read', { createFails: true }, async world => { world.createFails = false; await world.backend.recoverSignIn(); }, true],
  ]) {
    const world = createWorld(start);
    if (start.createFails) await world.backend.testWorkspace();
    const app = await lendingApp(t, world);
    await api(app, '/api/readiness?refresh=true'); 
    await new Promise(resolve => setTimeout(resolve, 300)); // settle start-up reads first
    let release;
    world.hold = new Promise(resolve => { release = resolve; });
    const reading = api(app, '/api/readiness?refresh=true');
    await until(() => world.held === true);
    await move(world);
    release();
    const returned = (await reading).checks.find(c => c.name === 'docker_login');
    assert.equal(returned.ok, expected, label + ': the caller gets the current state');
    assert.equal((await dockerRow(app)).ok, expected, label + ': so does the next read');
  }
});

test('a stalled storage or disk read cannot hold recovery past its deadline', async () => {
  for (const stalled of ['storage', 'disk']) {
    const world = createWorld();
    await world.backend.testWorkspace();
    world.createFails = false;
    if (stalled === 'storage') world.backend.storage.supported = () => new Promise(() => {});
    else world.backend.hostDisk = { free: () => new Promise(() => {}) };
    const before = creates(world), mark = world.timers.timers.length;
    const first = world.backend.recoverSignIn();
    await tick();
    world.timers.timers[mark].callback(); // the 60 s deadline passes
    const result = await Promise.race([first, new Promise(resolve => setTimeout(() => resolve('still pending'), 1000))]);
    assert.notEqual(result, 'still pending', stalled + ': Check again settles');
    assert.equal(creates(world), before, 'no create after the deadline');
    assert.equal(world.backend.signInRefused(), true);
    assert.notEqual(world.backend.recoverSignIn(), first, 'ownership is released; the next click starts a fresh check');
  }
});

// Restart/readiness regression: these run against the real backend with the existing offline sbx fake.
test('a create-only Docker refusal survives restart and prevents another ordinary prepare', async () => {
  const world = createWorld({createStderr:'user is not authenticated to Docker: no default account profile set: secret not found'});
  assert.equal((await world.backend.testWorkspace()).cause,'not_signed_in');
  assert.equal(world.backend.signInRefused(),true,'the create refusal is saved before returning');
  assert.equal(typeof world.backend._signInState.read()?.epoch,'string','the durable record exists before restart');
  world.restart();
  assert.equal(world.backend.signInRefused(),true);
  const report=await world.report();
  assert.equal(report.available,false);
  assert.equal(login(report.preflight).cause,'docker_signed_out');
  const before=creates(world);
  await assert.rejects(world.backend.prepare({resources:{wall_seconds:60}}),error=>error.code==='docker_signed_out'&&error.message==='Sign in to Docker to lend.');
  assert.equal(creates(world),before,'no ordinary create is dispatched while held');
  const step=setupVM({readiness:{ready:false,checks:report.preflight.checks},agents:[],status:{lending:{enabled:false}}}).steps.find(s=>s.id==='docker-account');
  assert.ok(step.actions.includes('docker-signin'));
  world.createFails=false;
  assert.equal((await world.backend.recoverSignIn()).ok,true);
  world.restart();
  assert.equal(world.backend.signInRefused(),false);
  assert.equal((await world.report()).available,true);
});

test('a Linux store without an account remains usable when creates succeed', async () => {
  const world=createWorld({createFails:false});
  world.auth=SIGNED_OUT;
  assert.equal((await world.backend.testWorkspace()).ok,true);
  const report=await world.report();
  assert.equal(report.available,true);
  assert.equal(login(report.preflight).signinVerified,false,'listing is not proof of an identity');
  assert.equal(login(report.preflight).createAccepted,true,'the accepted create is reported as exactly that');
  assert.equal(world.backend.signInRefused(),false);
});

test('completed owner login clears only the captured refusal and persists the clear', async () => {
  const world=createWorld();
  await world.backend.testWorkspace();
  const old=world.backend.signInRefusalEpoch();
  world.backend._setSignInRefusal(true);
  assert.equal(world.backend.confirmDockerSignIn(old),false);
  assert.equal(world.backend.confirmDockerSignIn(world.backend.signInRefusalEpoch()),true);
  world.restart();
  assert.equal(world.backend.signInRefused(),false);
});

test('a damaged refusal record blocks creates with a local-state remedy, including explicit recovery', async () => {
  const world=createWorld();
  world.backend._signInState={read:()=>({epoch:'unreadable',error:new Error('private storage detail')})};
  const before=creates(world);
  await assert.rejects(world.backend.prepare({resources:{wall_seconds:60}}),error=>error.code==='docker_signin_state_unavailable'&&!error.action&&!error.message.includes('private'));
  const checks=(await world.report()).preflight.checks;
  assert.equal(login({checks}).cause,'docker_signin_state_unavailable');
  await world.backend.recoverSignIn();
  assert.equal(creates(world),before,'even explicit recovery cannot launch with unreadable state');
});

// A named, unrelated deadline obligation is not a global Docker sign-in gate.
test('explicit Docker sign-in recovery succeeds while an unrelated overdue row remains unresolved', async () => {
  const world=createWorld();
  world.createResult={code:1,exited:false,timedOut:true,stderr:'fixture create timeout',stdout:''};
  assert.equal((await world.backend.testWorkspace()).cause,'timeout');
  world.backend._setSignInRefusal(true);
  world.restart();
  const directory=join(world.home,'v1/sandbox-cleanup');
  const names=fs.readdirSync(directory).filter(name=>name.endsWith('.json'));
  assert.equal(names.length,1,'the unrelated timed-out create left its durable obligation');
  const file=join(directory,names[0]),row=JSON.parse(fs.readFileSync(file,'utf8')),clock=sandboxDeadlineClock();
  fs.writeFileSync(file,JSON.stringify({...row,deadline_at:clock.wall-1,
    deadline_clock:{version:1,boot_id:clock.boot_id,boot_at:clock.boot_ms-1}}));
  const before=fs.readFileSync(file),release=acquireProcessLockSync(file+'.lock');
  try {
    world.createFails=false;
    const count=creates(world),result=await world.backend.recoverSignIn();
    assert.equal(result?.ok,true,'another row must not turn the explicit check into an unknown failure');
    assert.equal(creates(world),count+1,'exactly one fresh check is created');
    assert.equal(world.backend.signInRefused(),false);
    assert.deepEqual(fs.readFileSync(file),before,'the unrelated row stays untouched and unresolved');
    const report=await world.backend.recoverSandboxDeadlines();
    assert.equal(report.rows.find(item=>item.id===row._cleanupId)?.status,'in_progress');
    world.restart();
    assert.equal(world.backend.signInRefused(),false,'successful recovery clear survives restart');
  } finally { release(); }
});

const createCount = world => world.calls.filter(args => args[0] === 'run' || args[0] === 'create').length;
const signinRow = body => (body.lending_blockers?.items ?? []).find(item => item.key === 'docker_signin');

test('confirmSignIn runs the bounded test workspace without an earlier refusal, single flight', async () => {
  const world = createWorld({ createFails: false });
  const before = login((await world.report()).preflight);
  assert.equal(before.ok, true);
  assert.equal(before.createAccepted, undefined, 'a working listing with no create is unconfirmed');
  assert.equal(world.backend.signInRefused(), false);
  const [a, b] = await Promise.all([world.backend.confirmSignIn(), world.backend.confirmSignIn()]);
  assert.equal(a, b);
  assert.equal(createCount(world), 1, 'two callers, one test workspace');
  assert.equal(login((await world.report()).preflight).createAccepted, true);
  assert.ok(world.calls.some(args => args[0] === 'rm'), 'the throwaway sandbox is removed');
  assert.equal(world.backend.signInConfirming(), false);
});

test('a confirmation deadline before workspace creation reaches the retry caller', async () => {
  const { backend } = createWorld({ createFails: false });
  let deadline;
  backend.deadlineTimers = {
    setTimeout(callback) { deadline = callback; },
    clearTimeout() {},
  };
  backend.testWorkspace = ({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  });
  const checking = backend.confirmSignIn();
  deadline();
  assert.equal((await checking)?.cause, 'timeout');
  assert.equal(backend.signInConfirming(), false);
});

test('a Docker sign-in with no earlier refusal is confirmed once, and every row and card agree', async t => {
  const f = await appFixture(t);
  const world = createWorld({ createFails: false });
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => { const report = await world.report(); return { available: report.available, preflight: report.preflight }; };
  backend.signInRefused = () => world.backend.signInRefused();
  backend.recoverSignIn = () => world.backend.recoverSignIn();
  backend.confirmSignIn = () => world.backend.confirmSignIn();
  backend.signInConfirming = () => world.backend.signInConfirming();
  const handle = { url: 'https://login.example.test/device', code: 'ABCD-1234', waitForCompletion: async () => ({ status: 'complete' }), cancel() {} };
  const { app } = await f.start('owner', { backend, signin: { startDocker: async () => handle } });
  assert.equal(createCount(world), 0, 'nothing is checked before the sign-in');
  const flow = await api(app, '/api/signin/docker', { method: 'POST', body: {} });
  await waitFor(() => createCount(world) === 1, 'the confirm check runs once after the sign-in completes');
  await waitFor(async () => (await api(app, '/api/readiness?refresh=true')).checks.find(c => c.name === 'docker_login')?.createAccepted === true, 'docker_login carries createAccepted');
  assert.equal(createCount(world), 1, 'Check again on a confirmed sign-in runs nothing more');
  const row = signinRow(await api(app, '/api/status'));
  assert.equal(row?.status, 'ok', 'the Lending blockers row is ok');
  assert.equal(row?.detail, 'Docker accepted Faravan\'s request to start a test workspace.');
  assert.equal(flow.flowId.length > 0, true);
});

test('Check again on an unconfirmed Docker sign-in runs the check; two presses share one workspace', async t => {
  const f = await appFixture(t);
  const world = createWorld({ createFails: false });
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => { const report = await world.report(); return { available: report.available, preflight: report.preflight }; };
  backend.signInRefused = () => world.backend.signInRefused();
  backend.recoverSignIn = () => world.backend.recoverSignIn();
  backend.confirmSignIn = () => world.backend.confirmSignIn();
  backend.signInConfirming = () => world.backend.signInConfirming();
  const { app } = await f.start('owner', { backend });
  const unconfirmed = await api(app, '/api/readiness?refresh=true');
  assert.equal(unconfirmed.checks.find(c => c.name === 'docker_login').createAccepted, undefined);
  const settled = signinRow(await api(app, '/api/status'));
  assert.equal(settled?.unconfirmed, true, 'one unconfirmed row, not a refusal');
  assert.equal(settled?.action, 'Check again');
  assert.equal(settled?.detail, 'Faravan could not confirm the Docker sign-in.');
  assert.equal(createCount(world), 0);
  await Promise.all([api(app, '/api/readiness?refresh=true'), api(app, '/api/readiness?refresh=true')]);
  assert.equal(createCount(world), 1, 'two presses, one test workspace');
  assert.equal(signinRow(await api(app, '/api/status'))?.status, 'ok');
});
