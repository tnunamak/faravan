import './helpers/no-browser.mjs';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startAuthFlow, isProviderSecretSet, describeAuthRequirement, AuthFlowError } from '../lib/auth-flow.mjs';
import { CODEX_HARNESS as CURRENT_CODEX, CLAUDE_CODE_HARNESS as CURRENT_CLAUDE } from '../lib/harnesses.mjs';
import { credentialStoreEnv } from '../lib/docker-backend.mjs';

// Retain the legacy sbx-writer regressions. App sign-in now uses native provider
// generations, covered separately; the raw legacy fence must still fail closed.
const CODEX_HARNESS={...CURRENT_CODEX,auth_strategy:'docker-native-oauth',credential_discovery:{...CURRENT_CODEX.credential_discovery,login_command:'sbx secret set -g openai --oauth --force',url_prompt_pattern:'Open this URL to sign in'},login_status_probe:{...CURRENT_CODEX.login_status_probe,success:{SBX_CRED_OPENAI_MODE:'oauth'}}};
const CLAUDE_CODE_HARNESS={...CURRENT_CLAUDE,auth_strategy:'docker-native-oauth'};

let originalSbxHome;
beforeEach(async () => {
  originalSbxHome=process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME=await mkdtemp(join(tmpdir(),'wf-authflow-home-'));
});
afterEach(() => {
  if(originalSbxHome===undefined) delete process.env.FARAVAN_SBX_HOME;
  else process.env.FARAVAN_SBX_HOME=originalSbxHome;
});

test('R2: provider sign-in cannot change credentials while another sandbox lease is active', async t => {
  const journal = join(credentialStoreEnv().HOME, 'scratch-journal');
  await mkdir(journal, { recursive: true, mode: 0o700 });
  const lease = join(journal, 'wf-1111111111111111.json');
  await writeFile(lease, '{}', { flag: 'wx' });
  t.after(() => rm(lease));
  const sbxBin = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
echo 'https://auth.openai.com/oauth/authorize?state=test'`);
  await assert.rejects(startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'login-check', leaseWaitMs: 200 }), error => {
    assert.equal(error.code, 'credential_scope_unenforceable');
    assert.equal(error.condition, 'other_sandbox_lease');
    return true;
  });
});

test('provider sign-in waits for a short-lived check sandbox lease to end', async t => {
  const journal = join(credentialStoreEnv().HOME, 'scratch-journal');
  await mkdir(journal, { recursive: true, mode: 0o700 });
  const lease = join(journal, 'wf-2222222222222222.json');
  await writeFile(lease, '{}', { flag: 'wx' });
  t.after(() => rm(lease, { force: true }));
  const sbxBin = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
echo 'Open this URL to sign in to Codex OAuth:'
echo 'https://auth.openai.com/oauth/authorize?state=test'; sleep 5`);
  const ended = setTimeout(() => rm(lease, { force: true }), 600);
  t.after(() => clearTimeout(ended));
  let handle;
  t.after(() => handle?.cancel());
  handle = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'login-check', leaseWaitMs: 10_000 });
  assert.match(handle.url, /^https:\/\/auth\.openai\.com\//);
});

async function stubSbx(script) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-authflow-'));
  const path = join(dir, 'sbx');
  // Old writer fixtures did not model the read-only attempt-start listing.
  // Keep that listing from accidentally executing their login side effects.
  if (script.includes('"$1" = exec') && !script.includes('"$2" = ls')) {
    script = 'if [ "$1" = secret ] && [ "$2" = ls ]; then echo "No secrets found"; exit 0; fi\n' + script;
  }
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

test('Claude Code subscription is a validated, drivable host-url-flow', () => {
  assert.equal(describeAuthRequirement(CLAUDE_CODE_HARNESS).drivable, true);
  assert.equal(CLAUDE_CODE_HARNESS.credential_discovery.login_command, 'claude auth login --claudeai');
  assert.equal(CLAUDE_CODE_HARNESS.credential_discovery.url_prompt_pattern, 'visit:');
  assert.deepEqual(CLAUDE_CODE_HARNESS.login_status_probe.success, { loggedIn: true, authMethod: 'claude.ai' });
});

test('startAuthFlow rejects a non-docker-native-oauth harness', async () => {
  const fakeSpec = { ...CODEX_HARNESS, auth_strategy: 'host-env-proxy' };
  await assert.rejects(startAuthFlow(fakeSpec, { sandboxId: 'job' }), AuthFlowError);
});

test('startAuthFlow rejects an unknown docker-native-oauth harness clearly', async () => {
  const fakeSpec={...CODEX_HARNESS,harness_id:'unknown-agent'};
  await assert.rejects(startAuthFlow(fakeSpec,{sandboxId:'job'}),/does not support harness 'unknown-agent'/);
});

test('isProviderSecretSet detects an absent or present Docker secret', async () => {
  const absent = await stubSbx(`echo 'No secrets found for scope "(global)" and service "openai".'`);
  assert.equal((await isProviderSecretSet(CODEX_HARNESS, { sbxBin: absent })).alreadySet, false);
  const present = await stubSbx('echo "openai  oauth  (global)"');
  assert.equal((await isProviderSecretSet(CODEX_HARNESS, { sbxBin: present })).alreadySet, true);
});

test('startAuthFlow scrapes Codex host OAuth URL and proves completion through the sandbox status probe', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'wf-auth-state-')), 'ready');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then
      if [ -f '${state}' ]; then echo 'SBX_CRED_OPENAI_MODE=oauth'; else echo 'SBX_CRED_OPENAI_MODE=none'; fi
      exit 0
    fi
    echo 'Open this URL to sign in to Codex OAuth:'
    echo 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz'
    touch '${state}'
    sleep 10
  `);
  const flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job', completionTimeoutMs: 2_000 });
  assert.equal(flow.url, 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz');
  const started = Date.now();
  assert.equal((await flow.waitForCompletion()).status, 'complete');
  assert.ok(Date.now() - started < 1500, 'OAuth status is detected before the callback process exits');
  flow.cancel();
});

test('a finished Docker OAuth sign-in completes although the prepared sandbox never sees the new secret', async () => {
  // Live 2026-10-30: the browser showed "close this tab", Docker stored the
  // secret and the writer exited 0, but the sandbox prepared before sign-in
  // kept SBX_CRED_OPENAI_MODE=none, so the flow waited until its timeout.
  const state = join(await mkdtemp(join(tmpdir(), 'wf-auth-state-')), 'stored');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then
      echo 'SCOPE      SERVICE   SECRET'
      if [ -f '${state}' ]; then echo '(global)   openai    (oauth configured)'; fi
      exit 0
    fi
    echo 'Open this URL to sign in to Codex OAuth:'
    echo 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz'
    sleep 0.3; touch '${state}'; exit 0
  `);
  const flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job', completionTimeoutMs: 5_000 });
  const started = Date.now();
  const result = await flow.waitForCompletion();
  assert.equal(result.status, 'complete');
  assert.equal(result.diagnosticReason, 'authenticated');
  assert.ok(Date.now() - started < 3_000, 'completion follows the writer exit, not the timeout');
});

test('a sign-in whose writer exits cleanly without storing a secret fails at once', async () => {
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then echo 'No secrets found for scope "(global)" and service "openai".'; exit 0; fi
    echo 'Open this URL to sign in to Codex OAuth:'
    echo 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz'
    exit 0
  `);
  const flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job', completionTimeoutMs: 5_000 });
  const started = Date.now();
  const result = await flow.waitForCompletion();
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnosticReason, 'guest_not_authenticated');
  assert.ok(Date.now() - started < 3_000);
});

test('startAuthFlow accepts a provider URL emitted on stderr', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'wf-auth-state-')), 'ready');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then
      if [ -f '${state}' ]; then echo 'SBX_CRED_OPENAI_MODE=oauth'; else echo 'SBX_CRED_OPENAI_MODE=none'; fi
      exit 0
    fi
    echo 'Open this URL to sign in to Codex OAuth:' >&2
    echo 'https://auth.openai.com/oauth/authorize?client_id=stderr&state=xyz' >&2
    touch '${state}'
  `);
  const flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job', completionTimeoutMs: 2_000 });
  assert.equal(flow.url, 'https://auth.openai.com/oauth/authorize?client_id=stderr&state=xyz');
  assert.equal((await flow.waitForCompletion()).status, 'complete');
});

test('startAuthFlow gives a clear error instead of waiting on an existing OAuth overwrite prompt', async () => {
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    echo 'OPENAI OAuth token already exists. Overwrite? (y/N): Cancelled'
  `);
  await assert.rejects(startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job' }), error => {
    assert.equal(error.diagnosticReason, 'existing_credential_prompt');
    assert.match(error.message, /existing OpenAI OAuth credential needs attention/);
    return true;
  });
});

test('startAuthFlow publishes a cancellable handle before a slow URL is available', async () => {
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    sleep 10
  `);
  let handle;
  const starting = startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'codex-job', urlTimeoutMs: 20_000, onHandle: (value) => { handle = value; } });
  while (!handle) await new Promise((resolve) => setTimeout(resolve, 5));
  handle.cancel();
  await assert.rejects(starting, error => {
    assert.equal(error.diagnosticReason, 'cancelled');
    return /exited|login URL|cancelled/.test(error.message);
  });
});

test('startAuthFlow classifies URL timeout and child exit without URL', async t => {
  const timeoutSbx = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
sleep 10`);
  t.after(() => rm(dirname(timeoutSbx), { recursive: true, force: true }));
  await assert.rejects(startAuthFlow(CODEX_HARNESS, {
    sbxBin: timeoutSbx, sandboxId: 'codex-job', urlTimeoutMs: 10,
  }), error => error.diagnosticReason === 'url_timeout');

  const exitSbx = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
echo 'private output https://private.example.test/path?state=synthetic'
exit 9`);
  t.after(() => rm(dirname(exitSbx), { recursive: true, force: true }));
  await assert.rejects(startAuthFlow(CODEX_HARNESS, { sbxBin: exitSbx, sandboxId: 'codex-job' }), error => {
    assert.equal(error.diagnosticReason, 'child_exit_before_url');
    assert.match(error.message, /private output/);
    return true;
  });
});

test('startAuthFlow distinguishes an unauthenticated guest exit from completion timeout', async t => {
  const exitSbx = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
echo 'Open this URL to sign in: https://private.example.test/path?state=synthetic'
exit 9`);
  t.after(() => rm(dirname(exitSbx), { recursive: true, force: true }));
  const exitFlow = await startAuthFlow(CODEX_HARNESS, { sbxBin: exitSbx, sandboxId: 'codex-job' });
  const exitResult = await exitFlow.waitForCompletion();
  assert.equal(exitResult.diagnosticReason, 'guest_not_authenticated');

  const timeoutSbx = await stubSbx(`if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
echo 'Open this URL to sign in: https://private.example.test/path?state=synthetic'
sleep 10`);
  t.after(() => rm(dirname(timeoutSbx), { recursive: true, force: true }));
  const timeoutFlow = await startAuthFlow(CODEX_HARNESS, {
    sbxBin: timeoutSbx, sandboxId: 'codex-job', completionTimeoutMs: 10,
  });
  const timeoutResult = await timeoutFlow.waitForCompletion();
  assert.equal(timeoutResult.diagnosticReason, 'completion_timeout');
});

test('startAuthFlow runs Claude login inside the job sandbox, scrapes visit: URL, and confirms claude.ai mode', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'wf-auth-state-'));
  const state = join(stateDir, 'ready');
  const sandboxRecord = join(stateDir, 'sandbox');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ] && [ "$4" = sh ]; then
      if [ -f '${state}' ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi
      exit 0
    fi
    if [ "$1" = exec ] && [ "$2" = -i ] && [ "$5" = claude ]; then
      printf '%s' "$3" > '${sandboxRecord}'
      echo "Opening browser to sign in… If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=abc"
      touch '${state}'
      exit 0
    fi
    exit 1
  `);
  const flow = await startAuthFlow(CLAUDE_CODE_HARNESS, { sbxBin, sandboxId: 'claude-job', completionTimeoutMs: 2_000 });
  assert.equal(flow.url, 'https://claude.com/cai/oauth/authorize?state=abc');
  assert.equal(await readFile(sandboxRecord, 'utf8'), 'claude-job');
  assert.equal((await flow.waitForCompletion()).status, 'complete');
});

test('startAuthFlow requires a job sandbox for guest status probes', async () => {
  await assert.rejects(startAuthFlow(CLAUDE_CODE_HARNESS), /requires the prepared job sandbox/);
});

test('Claude login does not complete for API or unknown authentication mode', async t => {
  for (const status of [{loggedIn:true,authMethod:'api_key'}, {loggedIn:true}]) {
    await t.test(JSON.stringify(status), async t => {
      const sbxBin = await stubSbx(`
        if [ "$1" = exec ] && [ "$4" = sh ]; then
          printf '%s\\n' '${JSON.stringify(status)}'
          exit 0
        fi
        echo 'visit: https://claude.com/cai/oauth/authorize?state=synthetic'
      `);
      t.after(() => rm(dirname(sbxBin), {recursive:true,force:true}));
      const flow = await startAuthFlow(CLAUDE_CODE_HARNESS, {
        sbxBin, sandboxId:'synthetic-claude-job', completionTimeoutMs:200, pollIntervalMs:10,
      });
      t.after(() => flow.cancel());
      assert.equal(flow.status, 'awaiting-browser');
      assert.match(flow.url, /^https:\/\/claude\.com\//);
      assert.equal((await flow.waitForCompletion()).status, 'failed');
    });
  }
});

test('a Claude login that asks for a pasted code accepts it through stdin inside the sandbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-authflow-code-'));
  const got = join(dir, 'got');
  const sbxBin = await stubSbx(`
case "$*" in
  *"auth login"*)
    [ "$2" = "-i" ] || { echo "stdin not kept open" >&2; exit 9; }
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1"
    printf "Paste code here if prompted > "
    read code; printf '%s' "$code" > ${got}; exit 0 ;;
  *"auth status"*) if [ -f ${got} ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi ;;
esac`);
  const flow = await startAuthFlow(CLAUDE_CODE_HARNESS, { sbxBin, sandboxId: 'claude-job', completionTimeoutMs: 5_000, pollIntervalMs: 50 });
  assert.match(flow.url, /^https:\/\/claude\.com\//);
  for (let i = 0; i < 50 && !flow.acceptsCode; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(flow.acceptsCode, true);
  assert.throws(() => flow.submitCode('bad code with spaces'), AuthFlowError);
  flow.submitCode('abcDEF123_-.~#state42');
  const result = await flow.waitForCompletion();
  assert.equal(result.status, 'complete');
  assert.equal(await readFile(got, 'utf8'), 'abcDEF123_-.~#state42');
});

test('Q4 P1-2 a pre-existing OAuth listing is not evidence of this attempt', async () => {
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then echo '(global) openai (oauth configured)'; exit 0; fi
    echo 'Open this URL to sign in: https://auth.example.test/attempt'
    sleep 0.1; exit 0
  `);
  const flow = await startAuthFlow(CODEX_HARNESS,{sbxBin,sandboxId:'codex-job',completionTimeoutMs:2000});
  assert.equal((await flow.waitForCompletion()).diagnosticReason,'guest_not_authenticated');
});

test('Q4 P2-1 cancellation fences a late successful confirmation probe', async t => {
  const dir = await mkdtemp(join(tmpdir(),'wf-auth-cancel-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const ready=join(dir,'ready'), entered=join(dir,'entered'), proceed=join(dir,'proceed');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then
      if [ -f '${ready}' ]; then
        touch '${entered}'
        while [ ! -f '${proceed}' ]; do sleep 0.01; done
        echo 'SBX_CRED_OPENAI_MODE=oauth'
      else echo 'SBX_CRED_OPENAI_MODE=none'; fi
      exit 0
    fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then echo 'No secrets found'; exit 0; fi
    echo 'Open this URL to sign in: https://auth.example.test/attempt'
    touch '${ready}'; sleep 0.1; exit 0
  `);
  const flow = await startAuthFlow(CODEX_HARNESS,{sbxBin,sandboxId:'codex-job',completionTimeoutMs:2000});
  t.after(() => flow.cancel());
  // The writer must already have exited so the awaited confirmation wins the race.
  await new Promise(resolve => setTimeout(resolve,200));
  const pending=flow.waitForCompletion();
  for(let i=0;i<100;i++){try{await readFile(entered);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  await readFile(entered);
  flow.cancel();
  await writeFile(proceed,'go');
  const result=await pending;
  assert.equal(flow.status,'cancelled');
  assert.equal(result.status,'failed');
  assert.equal(result.diagnosticReason,'cancelled');
});

test('R3 release failures are bounded and async waiting is isolated from confirmation', async t => {
  const { acquireCredentialMutation } = await import('../lib/sandbox-credentials.mjs');
  for (const mode of ['resolve', 'reject', 'throw']) {
    await t.test(mode, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'wf-auth-release-'));
      const ready = join(dir, 'ready'), probing = join(dir, 'probing');
      const proceed = join(dir, 'proceed'), confirmed = join(dir, 'confirmed');
      let releaseEntered, settleRelease, releaseDone;
      const entered = new Promise(resolve => { releaseEntered = resolve; });
      const gate = new Promise(resolve => { settleRelease = resolve; });
      const logs = [];
      const sbxBin = await stubSbx(`
        if [ "$1" = exec ]; then
          if [ -f '${ready}' ]; then
            touch '${probing}'
            while [ ! -f '${proceed}' ]; do sleep 0.01; done
          fi
          echo 'SBX_CRED_OPENAI_MODE=none'; exit 0
        fi
        if [ "$1" = secret ] && [ "$2" = ls ]; then
          if [ -f '${proceed}' ]; then touch '${confirmed}'; fi
          echo 'No secrets found'; exit 0
        fi
        echo 'Open this URL to sign in: https://auth.example.test/attempt'
        touch '${ready}'; exit 0
      `);
      let flow, pending;
      t.after(async () => {
        await writeFile(proceed, 'go'); settleRelease(); flow?.cancel();
        if (pending) await within(pending.catch(() => {}), 'release test cleanup');
        if (releaseDone) await releaseDone;
        await rm(dirname(sbxBin), { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
      });
      flow = await startAuthFlow(CODEX_HARNESS, {
        sbxBin, sandboxId: 'release-check', completionTimeoutMs: 5000,
        log: line => logs.push(line),
        acquireCredentialMutation: async (...args) => {
          const release = await acquireCredentialMutation(...args);
          return () => {
            releaseEntered();
            releaseDone = Promise.resolve().then(release);
            if (mode === 'throw') throw Error('synthetic release failure');
            return gate.then(async () => {
              await releaseDone;
              if (mode === 'reject') throw Error('synthetic release failure');
            });
          };
        },
      });
      pending = flow.waitForCompletion();
      await waitForFile(probing);
      await writeFile(proceed, 'go');
      await waitForFile(confirmed); // Final listing, after the gated confirmation probe.
      await within(entered, 'release entry: dependency seam must be installed');
      if (mode !== 'throw') {
        const observation = await Promise.race([
          pending.then(() => 'settled', () => 'rejected'),
          tick(100).then(() => 'waiting'),
        ]);
        assert.equal(observation, 'waiting', 'only the release gate remains pending');
      }
      settleRelease();
      let result;
      await assert.doesNotReject(async () => {
        result = await within(pending, `${mode} release must neither reject nor hang`);
      }, 'release failure must not escape or strand completion');
      await within(releaseDone, 'underlying release');
      assert.equal(result.diagnosticReason, 'guest_not_authenticated');
      assert.equal(logs.length, mode === 'resolve' ? 0 : 1);
      if (logs.length) assert.match(logs[0], /credential lease release failed/i);
    });
  }
});

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, label, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { await tick(10); }
  }
  assert.fail(`timed out waiting for ${path}`);
}

// Observe once after the awaited completion/close event. Do not poll here:
// waiting for a genuinely live helper would hide premature cleanup.
async function authProcessRunning(pid, {
  kill = process.kill.bind(process), readStat = readFile, platform = process.platform,
} = {}) {
  try { kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (platform !== 'linux') return true; // No /proc: require ESRCH.
  let stat;
  try { stat = await readStat(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
    // Reaping can happen between kill(0) and stat. Missing proc data alone
    // is insufficient: corroborate disappearance without waiting.
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    try { kill(pid, 0); } catch (gone) {
      if (gone.code === 'ESRCH') return false;
      throw gone;
    }
    return true;
  }
  return !/\) Z /.test(stat);
}

for (const finding of ['writer-failure proof drain', 'deadline proof drain', 'listing timeout drain']) {
  test(`${finding}: a process reaped during the liveness read is stopped`, async () => {
    let kills = 0;
    const running = await authProcessRunning(42, {
      platform: 'linux',
      kill(pid, signal) {
        assert.equal(pid, 42); assert.equal(signal, 0);
        if (++kills === 2) throw Object.assign(new Error('reaped'), { code: 'ESRCH' });
      },
      async readStat(path, encoding) {
        assert.equal(path, '/proc/42/stat'); assert.equal(encoding, 'utf8');
        assert.equal(kills, 1, 'the first existence observation succeeded');
        throw Object.assign(new Error('reaped after kill(0)'), { code: 'ENOENT' });
      },
    });
    assert.equal(running, false, 'reaping is not evidence of a running process');
    assert.equal(kills, 2, 'disappearance is corroborated');
  });
}

test('auth liveness observation retains live, zombie, platform and error controls', async () => {
  const options = { platform: 'linux', kill() {}, readStat: async () => '42 (helper) S 1' };
  assert.equal(await authProcessRunning(42, options), true, 'a live helper still fails the drain assertion');
  assert.equal(await authProcessRunning(42, { ...options, readStat: async () => '42 (helper) Z 1' }), false);
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.equal(await authProcessRunning(42, { ...options, readStat: missing }), true,
    'missing proc data alone cannot hide a process still observable by kill(0)');
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(authProcessRunning(42, { ...options, readStat: async () => { throw denied; } }), error => error === denied);
  await assert.rejects(authProcessRunning(42, { ...options, kill() { throw denied; } }), error => error === denied);
  assert.equal(await authProcessRunning(42, { ...options, platform: 'darwin',
    readStat: async () => { assert.fail('non-Linux must not assume /proc'); } }), true);
  assert.equal(await authProcessRunning(42, { ...options, platform: 'darwin',
    kill() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }), false);
});

test('R1 a second writer cannot supply the first attempt final proof', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-auth-two-attempts-'));
  const exit = join(dir, 'exit'), finalProbe = join(dir, 'final');
  const proceed = join(dir, 'proceed'), stored = join(dir, 'stored');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then
      if [ "$2" = attempt-a ] && [ -f '${exit}' ]; then
        if ! mkdir '${dir}/first-probe' 2>/dev/null; then touch '${finalProbe}'; fi
        while [ ! -f '${proceed}' ]; do sleep 0.01; done
      fi
      echo 'SBX_CRED_OPENAI_MODE=none'; exit 0
    fi
    if [ "$1" = secret ] && [ "$2" = ls ]; then
      if [ -f '${stored}' ]; then echo '(global) openai (oauth configured)'; else echo 'No secrets found'; fi
      exit 0
    fi
    echo 'Open this URL to sign in: https://auth.example.test/attempt'
    if mkdir '${dir}/first-writer' 2>/dev/null; then
      touch '${exit}'
      while [ ! -d '${dir}/first-probe' ]; do sleep 0.01; done
    else touch '${stored}'; fi
    exit 0
  `);
  // Model only the promised exclusive mutation contract, not private lease internals.
  let tail = Promise.resolve(), acquisitions = 0, requests = 0, bEntered, bRequested;
  const bRequest = new Promise(resolve => { bRequested = resolve; });
  const bAcquired = new Promise(resolve => { bEntered = resolve; });
  const acquire = async () => {
    if (++requests === 2) bRequested();
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    if (++acquisitions === 2) bEntered();
    return unlock;
  };
  let a, b, pendingB;
  t.after(async () => {
    await writeFile(proceed, 'go');
    a?.cancel(); b?.cancel();
    if (pendingB) { b = await within(pendingB, 'B startup cleanup'); b.cancel(); }
    await rm(dirname(sbxBin), { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });
  a = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'attempt-a',
    acquireCredentialMutation: acquire, completionTimeoutMs: 5000 });
  await waitForFile(exit);
  const pendingA = a.waitForCompletion();
  await waitForFile(finalProbe); // Both post-exit probes are paused; the writer is stopped.
  pendingB = startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'attempt-b',
    acquireCredentialMutation: acquire, completionTimeoutMs: 5000 });
  await within(bRequest, 'B mutation request');
  const enteredBeforeProof = await Promise.race([bAcquired.then(() => true), tick(150).then(() => false)]);
  if (enteredBeforeProof) await waitForFile(stored); // Reproduce the base's false proof.
  await writeFile(proceed, 'go');
  const resultA = await within(pendingA, 'A completion');
  b = await within(pendingB, 'B startup');
  assert.equal((await within(b.waitForCompletion(), 'B completion')).status, 'complete');
  assert.equal(resultA.diagnosticReason, 'guest_not_authenticated',
    'A must not accept the credential written by B');
  assert.equal(enteredBeforeProof, false, 'A retains exclusivity through its final proof');
});

for (const winner of ['probe', 'writer-exit']) {
  for (const cancelDuringCleanup of [false, true]) {
    test(`R2 ${winner} proof survives slow release; explicit cancel=${cancelDuringCleanup}`, async t => {
      const dir = await mkdtemp(join(tmpdir(), 'wf-auth-slow-release-'));
      const ready = join(dir, 'ready'), proof = join(dir, 'proof');
      let releaseEntered, releaseGate;
      const entered = new Promise(resolve => { releaseEntered = resolve; });
      const gate = new Promise(resolve => { releaseGate = resolve; });
      const sbxBin = await stubSbx(`
        if [ "$1" = exec ]; then
          if [ -f '${ready}' ] && [ '${winner}' = probe ]; then
            touch '${proof}'; echo 'SBX_CRED_OPENAI_MODE=oauth'
          else echo 'SBX_CRED_OPENAI_MODE=none'; fi
          exit 0
        fi
        if [ "$1" = secret ] && [ "$2" = ls ]; then
          if [ -f '${ready}' ]; then touch '${proof}'; echo '(global) openai (oauth configured)';
          else echo 'No secrets found'; fi
          exit 0
        fi
        echo 'Open this URL to sign in: https://auth.example.test/attempt'
        touch '${ready}'
        if [ '${winner}' = probe ]; then sleep 30; fi
        exit 0
      `);
      let flow;
      t.after(async () => {
        releaseGate(); flow?.cancel();
        await rm(dirname(sbxBin), { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
      });
      flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'slow-release',
        completionTimeoutMs: 800,
        acquireCredentialMutation: async () => () => { releaseEntered(); return gate; } });
      let settled = false;
      const pending = flow.waitForCompletion().then(result => { settled = true; return result; });
      await within(entered, 'release entry');
      await waitForFile(proof);
      await tick(900); // Cleanup, not provider authentication, crosses the browser deadline.
      const statusBeforeCancel = flow.status;
      assert.equal(settled, false, 'completion waits for release');
      if (cancelDuringCleanup) flow.cancel();
      releaseGate();
      const result = await within(pending, 'completion after release');
      assert.notEqual(statusBeforeCancel, 'cancelled', 'browser timer must stop at proof');
      assert.equal(result.diagnosticReason, cancelDuringCleanup ? 'cancelled' : 'authenticated');
      assert.equal(result.status, cancelDuringCleanup ? 'failed' : 'complete');
    });
  }
}

for (const winner of ['writer-failure', 'deadline', 'writer-success']) {
  test(`cleanup drains a gated proof group before ${winner} completion`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-auth-proof-drain-'));
    const ready = join(dir, 'ready'), probing = join(dir, 'probing'), finish = join(dir, 'finish');
    const leader = join(dir, 'leader'), helper = join(dir, 'helper');
    const timers = new Set();
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      let timer;
      timer = realSetTimeout(() => { timers.delete(timer); fn(...args); }, ms);
      if (ms === 10_000 || ms === 1000) timers.add(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return realClearTimeout(timer); });
    const sbxBin = await stubSbx(`
      if [ "$1" = exec ]; then
        if [ ! -f '${ready}' ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
        if mkdir '${dir}/first' 2>/dev/null; then
          echo $$ > '${leader}'
          sleep 30 & echo $! > '${helper}'
          touch '${probing}'
          wait
          exit 1
        fi
        echo 'SBX_CRED_OPENAI_MODE=oauth'; exit 0
      fi
      if [ "$1" = secret ] && [ "$2" = ls ]; then echo 'No secrets found'; exit 0; fi
      touch '${ready}'
      echo 'Open this URL to sign in: https://auth.example.test/drain'
      while [ ! -f '${finish}' ]; do sleep 0.01; done
      if [ '${winner}' = writer-failure ]; then exit 7; fi
      exit 0
    `);
    let flow, pending;
    t.after(async () => {
      await writeFile(finish, 'go');
      await flow?.cancel();
      await pending;
      for (const path of [leader, helper]) {
        const pid = Number(await readFile(path, 'utf8').catch(() => '0'));
        if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      await rm(dirname(sbxBin), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    });
    flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'proof-drain',
      completionTimeoutMs: winner === 'deadline' ? 1000 : 5000,
      acquireCredentialMutation: async () => () => {} });
    pending = flow.waitForCompletion();
    await waitForFile(probing);
    if (winner !== 'deadline') await writeFile(finish, 'go');
    const result = await within(pending, 'proof group drain', 5000);
    assert.equal(result.status, winner === 'writer-success' ? 'complete' : 'failed');
    for (const path of [leader, helper]) {
      const pid = Number(await readFile(path, 'utf8'));
      const running = await authProcessRunning(pid);
      assert.equal(running, false, `proof process ${pid} stopped before completion`);
    }
    assert.equal(timers.size, 0, 'owned command and kill timers were disposed');
  });
}

test('native cancel is idempotent and disposes fallback signals after writer stop', async t => {
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then echo 'SBX_CRED_OPENAI_MODE=none'; exit 0; fi
    echo 'Open this URL to sign in: https://auth.example.test/cancel'
    sleep 30
  `);
  let flow;
  t.after(async () => { await flow?.cancel(); await rm(dirname(sbxBin), { recursive: true, force: true }); });
  flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'cancel-drain',
    acquireCredentialMutation: async () => () => {} });
  const timers = new Set(), signals = [];
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, kill = process.kill;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    let timer;
    timer = realSetTimeout(() => { timers.delete(timer); fn(...args); }, ms);
    if (ms === 1000) timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return realClearTimeout(timer); });
  t.mock.method(process, 'kill', (pid, signal) => { signals.push([pid, signal]); return kill.call(process, pid, signal); });
  const first = flow.cancel(), second = flow.cancel();
  assert.equal(typeof first?.then, 'function', 'native cancel returns its drain');
  assert.equal(first, second, 'repeated cancel retains one promise');
  await first;
  assert.equal(timers.size, 0, 'fallback is cleared when the writer stops');
  const signalCount = signals.length;
  assert.equal(flow.cancel(), first);
  await tick(1100);
  assert.equal(signals.length, signalCount, 'no late or repeated group signals');
  assert.equal(flow.status, 'cancelled');
});

test('cancel after native completion preserves terminal status without scheduling signals', async t => {
  const ready = join(await mkdtemp(join(tmpdir(), 'wf-auth-terminal-')), 'ready');
  const sbxBin = await stubSbx(`
    if [ "$1" = exec ]; then
      if [ -f '${ready}' ]; then echo 'SBX_CRED_OPENAI_MODE=oauth'; else echo 'SBX_CRED_OPENAI_MODE=none'; fi
      exit 0
    fi
    touch '${ready}'
    echo 'Open this URL to sign in: https://auth.example.test/terminal'
    sleep 30
  `);
  let flow;
  t.after(async () => { await flow?.cancel(); await rm(dirname(sbxBin), { recursive: true, force: true }); await rm(dirname(ready), { recursive: true, force: true }); });
  flow = await startAuthFlow(CODEX_HARNESS, { sbxBin, sandboxId: 'terminal',
    acquireCredentialMutation: async () => () => {} });
  assert.equal((await flow.waitForCompletion()).status, 'complete');
  const kill = t.mock.method(process, 'kill', () => { throw Error('terminal flow must not signal'); });
  const first = flow.cancel();
  assert.equal(flow.cancel(), first);
  await first;
  assert.equal(flow.status, 'complete');
  assert.equal(kill.mock.callCount(), 0);
});

test('listing timeout waits for command group close and clears its kill timer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-auth-listing-timeout-'));
  const leader = join(dir, 'leader'), helper = join(dir, 'helper');
  const sbxBin = await stubSbx(`
    trap '' TERM
    echo $$ > '${leader}'
    sleep 30 & echo $! > '${helper}'
    wait
  `);
  t.after(async () => {
    for (const path of [leader, helper]) {
      const pid = Number(await readFile(path, 'utf8').catch(() => '0'));
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(dirname(sbxBin), { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });
  const timers = new Set(), realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    let timer;
    timer = realSetTimeout(() => { timers.delete(timer); fn(...args); }, ms);
    if (ms === 1000) timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); return realClearTimeout(timer); });
  const result = isProviderSecretSet(CODEX_HARNESS, { sbxBin, timeoutMs: 500 });
  // Register rejection before waiting for child readiness.
  const rejected = assert.rejects(result, AuthFlowError);
  await waitForFile(helper);
  await within(rejected, 'listing timeout drain');
  for (const path of [leader, helper]) {
    const pid = Number(await readFile(path, 'utf8'));
    const running = await authProcessRunning(pid);
    assert.equal(running, false, 'timeout must await termination, not just send TERM');
  }
  assert.equal(timers.size, 0, 'no remaining escalation timer after rejection');
});
