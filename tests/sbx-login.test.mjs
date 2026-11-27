import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signInUrl, startSbxDockerLogin } from '../lib/sbx-login.mjs';
import {sbxChildEnv} from '../lib/docker-backend.mjs';

test('sbx login output produces a browser URL and one-time code, then completion waits for authenticated preflight', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, [
    '#!/bin/sh',
    "printf '%s\\n' 'Your one-time device confirmation code is: XQZN-BWCH'",
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=XQZN-BWCH'",
    'while :; do sleep 1; done',
  ].join('\n'));
  await chmod(sbx, 0o755);
  let authenticated = false;
  const flow = await startSbxDockerLogin({
    loginBin: sbx,
    pollIntervalMs: 5,
    completionTimeoutMs: 500,
    signedIn: async () => authenticated,
    probe: async () => ({ checks: [{ name: 'docker_login', ok: authenticated }] }),
  });
  t.after(() => flow.cancel());
  assert.equal(flow.url, 'https://login.docker.com/activate?user_code=XQZN-BWCH');
  assert.equal(flow.code, 'XQZN-BWCH');
  authenticated = true;
  assert.deepEqual(await flow.waitForCompletion(), { status: 'complete', detail: 'Docker sign-in was confirmed.' });
});

// sbx 0.48 prints a terms link before the activation link; the app showed the terms page as "Sign in".
const SBX_048_OUTPUT = [
  'By logging in, you agree to our Subscription Service Agreement. For more details, see https://www.docker.com/legal/docker-subscription-service-agreement/ ',
  '',
  'Your one-time device confirmation code is: DSHQ-DNSN',
  'Complete sign-in in your browser, then return to this terminal.',
  'Open this URL to sign in: https://login.docker.com/activate?user_code=DSHQ-DNSN',
].join('\n');

test('the sign-in link is the activation URL, not the terms link sbx 0.48 prints first', () => {
  assert.equal(signInUrl(SBX_048_OUTPUT), 'https://login.docker.com/activate?user_code=DSHQ-DNSN');
  assert.equal(signInUrl(SBX_048_OUTPUT.split('\n')[0]), undefined, 'the terms line alone is not a sign-in link');
  assert.equal(signInUrl('go to https://login.docker.com/activate?user_code=AB-CD now'), 'https://login.docker.com/activate?user_code=AB-CD');
});

test('startSbxDockerLogin waits past the terms line for the activation link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-048-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, [
    '#!/bin/sh',
    "printf '%s\\n' 'By logging in, you agree to our Subscription Service Agreement. For more details, see https://www.docker.com/legal/docker-subscription-service-agreement/ '",
    'sleep 0.3',
    "printf '%s\\n' 'Your one-time device confirmation code is: DSHQ-DNSN'",
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=DSHQ-DNSN'",
    'while :; do sleep 1; done',
  ].join('\n'));
  await chmod(sbx, 0o755);
  const flow = await startSbxDockerLogin({ loginBin: sbx, env: sbxChildEnv(), probe: async () => ({ checks: [] }) });
  try {
    assert.equal(flow.url, 'https://login.docker.com/activate?user_code=DSHQ-DNSN');
    assert.equal(flow.code, 'DSHQ-DNSN');
  } finally { flow.cancel(); }
});

test('completion uses the cheap signed-in check and runs one full preflight, not one per poll', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-cheap-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh',
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=AB-CD'",
    'while :; do sleep 1; done'].join('\n'));
  await chmod(sbx, 0o755);
  let quickCalls = 0, fullCalls = 0;
  const flow = await startSbxDockerLogin({
    loginBin: sbx, env: sbxChildEnv(), pollIntervalMs: 5, completionTimeoutMs: 2000,
    signedIn: async () => ++quickCalls >= 5,
    probe: async () => { fullCalls++; return { checks: [{ name: 'docker_login', ok: true }] }; },
  });
  assert.deepEqual(await flow.waitForCompletion(), { status: 'complete', detail: 'Docker sign-in was confirmed.' });
  assert.equal(quickCalls, 5); assert.equal(fullCalls, 1, 'the slow preflight ran once, after the cheap check passed');
});

test('an unclear listing and positive preflight cannot complete an unfinished login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-fallback-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh',
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=AB-CD'",
    'while :; do sleep 1; done'].join('\n'));
  await chmod(sbx, 0o755);
  const flow = await startSbxDockerLogin({
    loginBin: sbx, env: sbxChildEnv(), pollIntervalMs: 5, completionTimeoutMs: 35,
    signedIn: async () => null, probe: async () => ({ checks: [{ name: 'docker_login', ok: true }] }),
  });
  assert.equal((await flow.waitForCompletion()).status, 'failed');
});

test('a clean exit of sbx login is checked at once, not after the next poll', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-exit-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh',
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=AB-CD'",
    'sleep 0.3', 'exit 0'].join('\n'));
  await chmod(sbx, 0o755);
  let approved = false;
  const flow = await startSbxDockerLogin({
    loginBin: sbx, env: sbxChildEnv(), pollIntervalMs: 60_000, completionTimeoutMs: 20_000,
    signedIn: async () => approved, probe: async () => ({ checks: [{ name: 'docker_login', ok: true }] }),
  });
  setTimeout(() => { approved = true; }, 100);
  const started = Date.now();
  assert.equal((await flow.waitForCompletion()).status, 'complete');
  assert.ok(Date.now() - started < 5000, 'woke on the child exit rather than the 60 s poll');
});

test('probeSbxSignedIn reads sbx ls: exit 0 is inconclusive, "not signed in" is signed out, other failures are unclear', async () => {
  const { probeSbxSignedIn } = await import('../lib/sbx-login.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-quick-'));
  const make = async (name, body) => { const f = join(dir, name); await writeFile(f, `#!/bin/sh\n${body}\n`); await chmod(f, 0o755); return f; };
  const env = sbxChildEnv();
  assert.equal(await probeSbxSignedIn({ env, bin: await make('ok', 'echo SANDBOX; exit 0') }), null);
  assert.equal(await probeSbxSignedIn({ env, bin: await make('out', "echo 'error: not signed in to Docker' >&2; echo '  try: sbx login' >&2; exit 1") }), false);
  assert.equal(await probeSbxSignedIn({ env, bin: await make('boom', "echo 'daemon unreachable' >&2; exit 1") }), null);
  assert.equal(await probeSbxSignedIn({ env, bin: join(dir, 'missing') }), null);
});

// Live on Linux, sbx 0.50.0 (2026-10-28): on a signed-in identity `sbx login` prints only this and exits 0, with no
// link. Setup showed "Sign-in didn't finish" and the person had no way forward.
const signedInLogin = async (name) => {
  const dir = await mkdtemp(join(tmpdir(), name));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh', "printf '%s\\n' 'You are signed in [username: someone]'", 'exit 0'].join('\n'));
  await chmod(sbx, 0o755);
  return sbx;
};

test('sbx login on an identity that is already signed in completes once a preflight confirms it', async () => {
  const sbx = await signedInLogin('wf-sbx-login-signed-in-');
  let probes = 0;
  const flow = await startSbxDockerLogin({ loginBin: sbx, env: sbxChildEnv(),
    signedIn: async () => true, probe: async () => { probes++; return { checks: [{ name: 'docker_login', ok: true }] }; } });
  assert.equal(flow.status, 'complete');
  assert.equal(flow.url, undefined);
  assert.deepEqual(await flow.waitForCompletion(), { status: 'complete', detail: 'Docker sign-in was confirmed.' });
  assert.equal(probes, 1);
});

test('a linkless clean exit that no preflight confirms is still a failed sign-in', async () => {
  const sbx = await signedInLogin('wf-sbx-login-unconfirmed-');
  await assert.rejects(startSbxDockerLogin({ loginBin: sbx, env: sbxChildEnv(),
    signedIn: async () => null, probe: async () => ({ checks: [{ name: 'docker_login', ok: false }] }) }),
  { name: 'SbxLoginError', message: /ended before showing a browser link/ });
});

test('Sign in to Docker on an already signed-in identity answers complete, not a 409', async () => {
  const { createSignin } = await import('../lib/v1/signin.mjs');
  const sbx = await signedInLogin('wf-sbx-login-route-');
  const completed = [];
  const signin = createSignin({ adapters: async () => [], backend: () => null, onComplete: target => completed.push(target),
    startDocker: () => startSbxDockerLogin({ loginBin: sbx, env: sbxChildEnv(),
      signedIn: async () => true, probe: async () => ({ checks: [{ name: 'docker_login', ok: true }] }) }) });
  const view = await signin.post(['signin', 'docker'], {});
  assert.equal(view.status, 'complete');
  assert.equal(view.url, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(completed, ['docker']);
  await signin.close();
});

test('login confirmation probes use the exact immutable environment used by sbx login', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-context-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh',
    "printf '%s\\n' 'Open this URL to sign in: https://login.docker.com/activate?user_code=AB-CD'",
    'while :; do sleep 1; done'].join('\n'));
  await chmod(sbx, 0o755);
  const savedHome=process.env.FARAVAN_SBX_HOME;process.env.FARAVAN_SBX_HOME=join(dir,'profile');
  t.after(()=>{if(savedHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=savedHome;});
  const env = Object.freeze(sbxChildEnv());
  let loginEnv, quickEnv, probeEnv;
  let authenticated = false;
  const flow = await startSbxDockerLogin({ loginBin: sbx, env,
    spawnProcess: (...args) => { loginEnv = args[2].env; return spawn(...args); },
    signedIn: async options => { quickEnv = options.env; return authenticated; },
    probe: async options => { probeEnv = options.env; return { checks: [{ name: 'docker_login', ok: authenticated }] }; },
    pollIntervalMs: 5, completionTimeoutMs: 1000 });
  authenticated = true;
  assert.equal((await flow.waitForCompletion()).status, 'complete');
  assert.equal(loginEnv, env);
  assert.equal(quickEnv, env);
  assert.equal(probeEnv, env);
});

test('a fresh negative status still vetoes a clean login exit', async () => {
  const sbx=await signedInLogin('wf-sbx-login-negative-');
  await assert.rejects(startSbxDockerLogin({loginBin:sbx,env:sbxChildEnv(),
    signedIn:async()=>false,probe:async()=>({checks:[{name:'docker_login',ok:true,signinVerified:false}]})}),{name:'SbxLoginError'});
});

test('owner-login completion does not report success when a newer refusal remains', async () => {
  const {createSignin}=await import('../lib/v1/signin.mjs');
  const completed=[];
  const signin=createSignin({adapters:async()=>[],backend:()=>({signInRefusalEpoch:()=> 'old',confirmDockerSignIn:()=>false}),
    onComplete:target=>completed.push(target),startDocker:async()=>({status:'complete'})});
  const result=await signin.start('docker');
  assert.equal(result.status,'failed');
  assert.deepEqual(completed,[]);
  await signin.close();
});

// `sbx login` writes its refusal to stderr. Only a class of it is kept, with the exit code; the text is never stored.
async function failingSbx(stderrText, exitCode) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-sbx-login-fail-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh', `printf '%s\\n' '${stderrText}' >&2`, `exit ${exitCode}`].join('\n'));
  await chmod(sbx, 0o755);
  return sbx;
}

for (const [label, text, reason] of [
  ['a browser that cannot be opened', 'Error: exec: "open": executable file not found in $PATH for user alice token sk-private-123', 'login_browser_unavailable'],
  ['a keychain refusal', 'failed to store credentials: keychain item not found', 'login_keychain'],
  ['a network failure', 'dial tcp login.docker.com: i/o timeout', 'login_network'],
  ['an unknown error', 'something odd happened', 'login_other'],
]) {
  test(`sbx login that exits 1 with ${label} reports a sanitized class and the exit code, never the text`, async () => {
    const bin = await failingSbx(text, 1);
    const error = await startSbxDockerLogin({ loginBin: bin, signedIn: async () => false, probe: async () => ({ checks: [] }) })
      .then(() => null, e => e);
    assert.equal(error?.name, 'SbxLoginError');
    assert.equal(error.diagnosticReason, reason);
    assert.equal(error.exitCode, 1);
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('alice'));
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('sk-private'));
  });
}

test('sbx login that exits 0 without a link is its own class, with exit 0', async () => {
  const bin = await failingSbx('', 0);
  const error = await startSbxDockerLogin({ loginBin: bin, signedIn: async () => false, probe: async () => ({ checks: [] }) })
    .then(() => null, e => e);
  assert.equal(error.diagnosticReason, 'login_no_link');
  assert.equal(error.exitCode, 0);
});
