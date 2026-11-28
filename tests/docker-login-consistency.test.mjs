import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';
import { probeSbxPreflight, sbxChildEnv } from '../lib/docker-backend.mjs';
import { probeSbxSignedIn, startSbxDockerLogin } from '../lib/sbx-login.mjs';
import { setupVM } from '../ui/v1/src/view-models.mjs';

const testOptions = { timeout: 30000 };

function commandResult(overrides = {}) {
  return { code: 0, stdout: '', stderr: '', ...overrides };
}

function runHelp() {
  return ['Usage: sbx run [flags] AGENT PATH', 'Flags:',
    '  -d, --detach', '      --detach-keys string', '      --name string', '      --kit stringArray',
    '      --cpus', '      --memory', '      --skills', '      --static-mcp', '      --deny-network'].join('\n');
}

function conflictingDockerEvidence() {
  const calls = [];
  let diagnoseSignedIn = true;
  const runCommand = async (command, args, options = {}) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'version') return commandResult({ stdout: 'sbx version: v0.51.0 abc123' });
    if (args.join(' ') === 'diagnose') return diagnoseSignedIn
      ? commandResult({ stdout: 'Daemon healthy\n✓ Authentication — authenticated\n✓ Global network policy — initialized' })
      : commandResult({ code: 1,
        stdout: 'Daemon healthy\n✗ Authentication — not authenticated\n✓ Global network policy — initialized' });
    if (args.join(' ') === 'ls -q') return commandResult({ stdout: 'sandbox-id\n' });
    if (args.join(' ') === 'policy ls') return commandResult({ stdout: 'Global network policy: deny-all' });
    if (args.join(' ') === 'run --help') return commandResult({ stdout: runHelp() });
    if (command === 'dpkg-query') return commandResult({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' });
    if (command === 'docker') return commandResult({ stdout: '28.0.0' });
    if (command === 'containerd') return commandResult({ stdout: 'containerd github.com/containerd/containerd v2.1.0' });
    if (command === 'test') return commandResult();
    throw new Error(`Unexpected preflight command: ${command} ${args.join(' ')}`);
  };
  return { calls, runCommand, setDiagnoseSignedIn(value) { diagnoseSignedIn = value; } };
}

function alreadySignedInProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.end('You are signed in [username: fixture]\n');
    child.emit('exit', 0);
  });
  return child;
}

test('cached readiness and signin stay aligned with doctor when diagnose contradicts the saved session', testOptions, async t => {
  const f = await appFixture(t);
  const stub = conflictingDockerEvidence();
  const probe = () => probeSbxPreflight({ runCommand: stub.runCommand, platformName: 'linux' });
  const fakeSbx = join(f.root, 'docker-cli-fixture');
  await writeFile(fakeSbx, '#!/bin/sh\nexit 0\n');
  await chmod(fakeSbx, 0o755);

  const backend = syntheticBackend(f.root);
  const baseCapabilities = backend.lenderCapabilities.bind(backend);
  const signedIn = () => probeSbxSignedIn({ bin: fakeSbx, env: sbxChildEnv() });
  backend.probeCapabilities = async () => {
    const preflight = await probe();
    return { available: preflight.ok, backend_id: 'docker-sbx', version: preflight.version, preflight };
  };
  backend.lenderCapabilities = async () => {
    const preflight = await probe();
    return { ...baseCapabilities(), available: preflight.ok, backend_id: 'docker-sbx', preflight };
  };

  const signin = { startDocker: () => startSbxDockerLogin({
    spawnProcess: alreadySignedInProcess,
    signedIn,
    probe,
    platformName: 'linux',
    env: sbxChildEnv(),
    loginBin: fakeSbx,
    urlTimeoutMs: 1000,
  }) };
  const { app } = await f.start('owner', { backend, signin });
  assert.equal(await signedIn(), null, 'a working listing does not prove a Docker session');

  const initialReadiness = await api(app, '/api/ops/readiness.get', { method: 'POST', body: { refresh: true } });
  assert.equal(initialReadiness.ready, false, 'an unverified listing is not lending readiness');
  assert.equal(initialReadiness.checks.find(check => check.name === 'docker_login')?.signinVerified, false);
  const signinView = await api(app, '/api/ops/signin.start', { method: 'POST', body: { target: 'docker' } });
  assert.equal(signinView.status, 'complete');

  stub.setDiagnoseSignedIn(false);
  const doctor = await api(app, '/api/ops/doctor.run', { method: 'POST', body: { quick: true } });
  const readiness = await api(app, '/api/ops/readiness.get', { method: 'POST', body: {} });
  const readinessLogin = readiness.checks.find(check => check.name === 'docker_login')?.ok;
  const doctorLogin = doctor.checks.find(check => check.name === 'docker_login')?.ok;

  assert.deepEqual({ readiness: readinessLogin, signin: signinView.status, doctor: doctorLogin },
    { readiness: true, signin: 'complete', doctor: true });
  assert.equal(readiness.ready, false, 'cached readiness also waits for proof of sandbox create');
  assert.equal(readiness.checks.find(check => check.name === 'docker_login')?.signinVerified, false);
  assert.equal(doctor.status, 'ready', 'quick doctor reports preflight, not verified lending readiness');
  assert.ok(stub.calls.includes('ls -q'), 'the backend uses the same status command as signin');

  const setup = setupVM({ readiness, agents: [], status: {lending: { enabled: false }} });
  // A working listing proves no sign-in, so Setup shows one unconfirmed step with a Check again button.
  assert.equal(setup.steps.find(step => step.id === 'docker-account')?.state, 'need');
  assert.match(setup.steps.find(step => step.id === 'docker-account')?.detail ?? '', /^Faravan could not confirm the Docker sign-in\./);
});

test('a slow sbx ls in an observation reads as unknown, never stopped or signed out', testOptions, async () => {
  const stub = conflictingDockerEvidence();
  const runCommand = async (command, args, options = {}) => {
    if (args.join(' ') === 'ls -q') return new Promise(() => {}); // never answers; the probe's own timeout ends it
    return stub.runCommand(command, args, options);
  };
  const diagnosticResult = commandResult({ stdout: 'Daemon healthy\n✓ Authentication — authenticated\n✓ Global network policy — initialized' });
  const slow = await probeSbxPreflight({ runCommand, platformName: 'linux', observation: true, diagnosticResult, commandTimeoutMs: 50 });
  const row = name => slow.checks.find(check => check.name === name);
  assert.equal(row('sbx_daemon').ok, false);
  assert.equal(row('sbx_daemon').unknown, true);
  assert.equal(row('docker_login').unknown, true);

  const refused = async (command, args, options = {}) => args.join(' ') === 'ls -q'
    ? commandResult({ code: 1, stderr: 'Cannot connect to the sandbox daemon' }) : stub.runCommand(command, args, options);
  const down = await probeSbxPreflight({ runCommand: refused, platformName: 'linux', observation: true, diagnosticResult });
  assert.equal(down.checks.find(check => check.name === 'sbx_daemon').unknown, undefined, 'a real error still counts as stopped');
});

const refreshError = 'error: list sandboxes: list local runtimes: list runtimes: request failed: 503 Service Unavailable: docker login service unavailable: the host is not fully awake docker session could not be refreshed due to a network issue; this should resolve automatically, try again shortly';
const refreshMessage = 'The sandbox could not refresh your Docker sign-in. This may be temporary. Open Setup and select Sign in to Docker.';

for (const [label, stderr, expected] of [
  ['refresh unavailable', refreshError, refreshMessage],
  ['unknown list failure', 'error: list sandboxes: unexpected registry response', 'Faravan could not list Docker sandboxes. Open Setup and choose Check again. If asked, select Sign in to Docker.'],
  ['explicit signed-out listing without a create', 'error: not signed in to Docker', "The sandbox service isn't signed in to Docker yet."],
]) test(`failed sbx sign-in: ${label} reaches blockers, doctor and the UI and prevents claims`, testOptions, async t => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {createRequire} = await import('node:module');
  const {preflightHumanLines} = createRequire(import.meta.url)('../bin/faravan');
  const {blockersFor} = await import('../ui/v1/src/view-models.mjs');
  const f = await appFixture(t), stub = conflictingDockerEvidence();
  const fakeSbx = join(f.root, 'sbx');
  await writeFile(fakeSbx, `#!/bin/sh\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`, {mode:0o755});
  const execute = promisify(execFile);
  const runCommand = async (command, args, options) => {
    if (args.join(' ') !== 'ls -q') return stub.runCommand(command, args, options);
    try { const output = await execute(fakeSbx, args, {env:{PATH:process.env.PATH, HOME:f.root}}); return commandResult(output); }
    catch (error) { return commandResult({code:error.code, stdout:error.stdout, stderr:error.stderr}); }
  };
  const probe = () => probeSbxPreflight({runCommand, platformName:'linux', sbxHomePath:'/synthetic-sbx', userHome:f.root, inspectDaemons:async()=>[]});
  const backend = syntheticBackend(f.root);
  let createAccepted = false;
  backend.probeCapabilities = async () => {
    const preflight = await probe();
    if (createAccepted) {
      const login = preflight.checks.find(check => check.name === 'docker_login');
      assert.equal(login?.ok, true, 'fixture acceptance requires a successful listing first');
      login.createAccepted = true;
    }
    return {available:preflight.ok, preflight};
  };
  const {owner, lender, circle} = await f.connect({backend});
  const app = lender.app;
  await api(app, '/api/lending/limits', {method:'POST', body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(app, '/api/agents/codex', {method:'POST', body:{useForLending:true}});
  await api(app, '/api/lending/mode', {method:'POST', body:{circle:circle.id,mode:'ask'}});
  await api(app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
  const readiness = await api(app, '/api/ops/readiness.get', {method:'POST', body:{refresh:true}});
  const blockers = await api(app, '/api/ops/status.blockers', {method:'POST', body:{}});
  const doctor = await api(app, '/api/ops/doctor.run', {method:'POST', body:{quick:true}});
  const status = await api(app, '/api/status'), agents = await api(app, '/api/agents');
  const ui = blockersFor({status, readiness, agents});
  const doctorLine = preflightHumanLines(doctor).find(line=>line.includes('docker_login:'));
  await api(owner.app, '/api/jobs', {method:'POST', headers:{'faravan-confirm':'yes'}, body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task.',harness:'codex'}});
  await new Promise(resolve=>setTimeout(resolve,900));
  const approvals = await api(app, '/api/approvals');
  console.log(JSON.stringify({label,claims:approvals.length,can_lend:blockers.can_lend,blockers:blockers.blockers,readiness:readiness.checks.find(c=>c.name==='docker_login'),doctor:doctorLine,ui:ui.items.filter(c=>c.key.startsWith('docker'))}));
  assert.equal(readiness.ready, false);
  assert.equal(blockers.can_lend, false);
  // A refresh failure may be temporary, so it is an unconfirmed sign-in with a recheck, never a sign-out that sends the person to sign in.
  if (label === 'refresh unavailable') { assert.equal(blockers.blockers.filter(b=>b.kind==='docker_signed_out').length, 0); assert.equal(blockers.blockers.filter(b=>b.kind==='sandbox_not_ready').length, 1); }
  assert.equal(doctor.checks.find(c=>c.name==='docker_login').detail, expected);
  if (label === 'refresh unavailable') {
    assert.equal(blockers.blockers.find(b=>b.kind==='sandbox_not_ready').message, expected);
    assert.equal(ui.items.find(c=>c.key==='docker_signin').detail, expected);
    assert.match(doctorLine, /FAIL docker_login: The sandbox could not refresh your Docker sign-in/);
  }
  assert.deepEqual(approvals, [], 'no job is claimed while Docker sign-in is blocked');
  assert.equal(backend.calls.filter(([kind])=>kind==='prepare'||kind==='start').length,0);
  await writeFile(fakeSbx, '#!/bin/sh\nexit 0\n', {mode:0o755});
  // This is the fixture's exact accepted-create event, distinct from the listing.
  createAccepted = true;
  await api(app, '/api/ops/readiness.get', {method:'POST',body:{refresh:true}});
  await api(app, '/api/agents/refresh', {method:'POST',body:{}});
  await waitFor(async () => (await api(app, '/api/approvals'))[0], 'the same waiting job is claimed when Docker sign-in recovers');
});

for (const platformName of ['linux','darwin','win32']) test(`refresh failure overrides authenticated diagnostics on ${platformName}`, async () => {
  const stub = conflictingDockerEvidence();
  const runCommand = async (command,args,options) => {
    if (args.join(' ') === 'ls -q') return commandResult({code:1,stderr:refreshError});
    if (command === 'powershell.exe') return commandResult({stdout:'Enabled'});
    return stub.runCommand(command,args,options);
  };
  for (const observation of [false,true]) {
    const result = await probeSbxPreflight({runCommand,platformName,observation,
      diagnosticResult:commandResult({stdout:'Daemon healthy\n✓ Authentication — authenticated'}),
      sbxHomePath:'/s',userHome:'/user',realpathPath:()=>'/synthetic-keychains',inspectDaemons:async()=>[]});
    const login = result.checks.find(c=>c.name==='docker_login');
    assert.equal(result.ok,false);
    assert.equal(login.ok,false);
    assert.equal(login.cause,'docker_signin_refresh_unavailable');
    assert.equal(login.detail,refreshMessage);
    assert.equal(login.unknown,undefined);
    if(platformName!=='win32') assert.equal(result.checks.find(c=>c.name==='sbx_daemon').ok,true,'a sign-in refusal proves the service responded');
  }
});

test('a refresh refusal from both ls and diagnose stays a sign-in blocker', async () => {
  const stub = conflictingDockerEvidence();
  const runCommand = async (command,args,options) => ['ls -q','diagnose','policy ls'].includes(args.join(' '))
    ? commandResult({code:1,stderr:refreshError}) : stub.runCommand(command,args,options);
  const result = await probeSbxPreflight({runCommand,platformName:'linux',sbxHomePath:'/s',inspectDaemons:async()=>[]});
  assert.equal(result.ok,false);
  assert.equal(result.checks.find(c=>c.name==='sbx_daemon').ok,true);
  assert.equal(result.checks.find(c=>c.name==='docker_login').detail,refreshMessage);
  assert.equal(result.checks.find(c=>c.name==='network_policy').waitsFor,'docker_login');
});

for (const platformName of ['linux', 'darwin', 'win32']) {
  for (const observation of [false, true]) test(`unrecognised ls failure stays unknown on ${platformName}, observation=${observation}`, async () => {
    const stub = conflictingDockerEvidence();
    let failed = true;
    const runCommand = async (command, args, options) => {
      if (args.join(' ') === 'ls -q' && failed) return commandResult({code:1, stderr:'error: list sandboxes: unexpected registry response'});
      if (command === 'powershell.exe') return commandResult({stdout:'Enabled'});
      return stub.runCommand(command, args, options);
    };
    const probe = () => probeSbxPreflight({runCommand, platformName, observation,
      diagnosticResult:commandResult({stdout:'Daemon healthy\n✓ Authentication — authenticated'}),
      sbxHomePath:'/s', userHome:'/user', realpathPath:()=>'/synthetic-keychains', inspectDaemons:async()=>[]});
    const result = await probe();
    const login = result.checks.find(c=>c.name==='docker_login');
    assert.equal(login.ok, false);
    assert.equal(login.unknown, true);
    assert.equal(login.detail, 'Faravan could not list Docker sandboxes. Open Setup and choose Check again. If asked, select Sign in to Docker.');
    assert.equal(result.ok, false);
    failed = false;
    assert.equal((await probe()).ok, true, 'a successful listing still qualifies the healthy machine');
  });
}

for (const [label, stderr, refresh] of [
  ['production stderr', refreshError, true],
  ['no colon and mixed case', refreshError.replace('docker login service unavailable:', 'DOCKER LOGIN SERVICE UNAVAILABLE'), true],
  ['service unavailable without refresh marker', 'error: docker login service unavailable: try later', false],
]) test(`refresh classification requires both markers: ${label}`, async () => {
  const stub = conflictingDockerEvidence();
  const runCommand = (command,args,options) => args.join(' ') === 'ls -q'
    ? commandResult({code:1,stderr}) : stub.runCommand(command,args,options);
  const result = await probeSbxPreflight({runCommand,platformName:'linux',sbxHomePath:'/s',inspectDaemons:async()=>[]});
  const login = result.checks.find(c=>c.name==='docker_login');
  assert.equal(login.ok,false);
  assert.equal(login.cause,refresh ? 'docker_signin_refresh_unavailable' : undefined);
  assert.equal(login.unknown,refresh ? undefined : true);
});
