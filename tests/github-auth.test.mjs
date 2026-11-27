import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startGitHubAuthFlow } from '../lib/github-auth.mjs';
import { currentGitHubGeneration } from '../lib/credential-generations.mjs';
import { withCredentialPreparation } from '../lib/sandbox-credentials.mjs';
import { spawn } from 'node:child_process';

// GitHub sign-in writes no sbx secret; its only writer is gh itself. A gh login that outlives its parent stays fenced.
test('R3: a surviving gh login writer fences preparation after its parent crashes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wf-github-crash-'));
  const marker = join(home, 'writer-pid');
  const gh = await executable('gh', `if [ "$2" = login ]; then echo 'one-time code: TEST-1234'; echo 'https://github.com/login/device'; printf '%s' "$$" > '${marker}'; trap '' TERM; while :; do sleep 1; done; else printf synthetic; fi`);
  const parentFile = join(home, 'parent.mjs');
  await writeFile(parentFile, `import {startGitHubAuthFlow} from ${JSON.stringify(new URL('../lib/github-auth.mjs', import.meta.url).href)};\nconst flow=await startGitHubAuthFlow({ghBin:${JSON.stringify(gh)},faravanHome:${JSON.stringify(home)}}); await flow.waitForCompletion();\n`);
  const parent = spawn(process.execPath, [parentFile], {stdio:'ignore'});
  let writerPid;
  t.after(() => { try { parent.kill('SIGKILL'); } catch {} if(writerPid) try { process.kill(writerPid,'SIGKILL'); } catch {} });
  const deadline = Date.now()+5000;
  while (Date.now()<deadline) { try { writerPid=Number(await readFile(marker,'utf8')); if (writerPid) break; } catch {} await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.ok(writerPid, 'writer started');
  const exited = new Promise(resolve=>parent.once('exit',resolve));
  parent.kill('SIGKILL'); await exited;
  await assert.rejects(withCredentialPreparation(home,async()=>{}), {code:'credential_writer_unresolved'});
  process.kill(writerPid,'SIGKILL');
  await assert.rejects(withCredentialPreparation(home,async()=>{}), {code:'credential_writer_unresolved'});
});

test('R2: GitHub sign-in completes without running sbx, and a cancelled sign-in publishes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wf-github-auth-fence-'));
  const ran = join(home, 'sbx-ran');
  const gh = await executable('gh', `if [ "$2" = login ]; then
echo 'First copy your one-time code: TEST-1234'
echo 'https://github.com/login/device'
else printf synthetic; fi`);
  const sbx = await executable('sbx', `printf ran > '${ran}'`);
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = sbx;
  try {
    const flow = await startGitHubAuthFlow({ghBin:gh,faravanHome:home});
    assert.deepEqual(await flow.waitForCompletion(), { status: 'complete', detail: 'GitHub task access is ready.' });
    assert.ok(await currentGitHubGeneration(home), 'the generation is published');
    // The gh login receipt is isolated to its own source, so a generation-aware preparation is not fenced by it.
    await withCredentialPreparation(home,async()=>{},{isolatedSources:true});
    const other = await mkdtemp(join(tmpdir(), 'wf-github-auth-cancel-'));
    const cancelled = await startGitHubAuthFlow({ghBin:gh,faravanHome:other});
    cancelled.cancel();
    assert.equal((await cancelled.waitForCompletion()).status, 'failed');
    assert.equal(await currentGitHubGeneration(other), null, 'a cancelled sign-in publishes nothing');
    assert.equal(await access(ran).then(()=>true,()=>false), false, 'sign-in never runs sbx');
  } finally { if (previous === undefined) delete process.env.FARAVAN_SBX_BIN; else process.env.FARAVAN_SBX_BIN = previous; }
});

async function executable(name, body) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-github-auth-'));
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

test('GitHub device flow exposes the real UI shape and keeps its token in a private generation, not the sbx store', async () => {
  const record = join(await mkdtemp(join(tmpdir(), 'wf-github-auth-record-')), 'store-input');
  const faravanHome = await mkdtemp(join(tmpdir(), 'wf-github-auth-home-'));
  const gh = await executable('gh', `
if [ "$1" = auth ] && [ "$2" = login ]; then
  echo 'First copy your one-time code: TEST-1234'
  echo 'Open this URL to continue in your web browser: https://github.com/login/device'
  exit 0
fi
if [ "$1" = auth ] && [ "$2" = token ]; then printf 'secret-token'; exit 0; fi
exit 1
`);
  const sbx = await executable('sbx', `printf '%s' "$HOME" > '${record}.home'\ncat > '${record}'`);
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = sbx;
  try {
    const flow = await startGitHubAuthFlow({ ghBin: gh, env: { PATH: process.env.PATH, HOME: '/personal-gh-must-not-be-used' }, faravanHome });
    assert.equal(flow.url, 'https://github.com/login/device');
    assert.equal(flow.code, 'TEST-1234');
    assert.deepEqual(await flow.waitForCompletion(), { status: 'complete', detail: 'GitHub task access is ready.' });
  } finally { if (previous === undefined) delete process.env.FARAVAN_SBX_BIN; else process.env.FARAVAN_SBX_BIN = previous; }
  assert.equal(await access(record).then(()=>true,()=>false), false, 'no global sbx secret is written at sign-in');
  const generation = await currentGitHubGeneration(faravanHome);
  assert.equal(generation.digest, createHash('sha256').update('secret-token').digest('hex'));
  assert.equal(generation.directory.startsWith(faravanHome), true, 'the copy stays in the Faravan identity');
});

test('cancelling GitHub device login removes its isolated insecure config', async () => {
  const record = join(await mkdtemp(join(tmpdir(), 'wf-github-auth-record-')), 'config-dir');
  const faravanHome = await mkdtemp(join(tmpdir(), 'wf-github-auth-home-'));
  const gh = await executable('gh', `
if [ "$1" = auth ] && [ "$2" = login ]; then
  mkdir -p "$GH_CONFIG_DIR"
  printf token > "$GH_CONFIG_DIR/hosts.yml"
  printf '%s' "$GH_CONFIG_DIR" > '${record}'
  echo 'First copy your one-time code: TEST-5678'
  echo 'Open this URL to continue in your web browser: https://github.com/login/device'
  trap 'exit 0' TERM
  while true; do sleep 1; done
fi
exit 1
`);
  const flow = await startGitHubAuthFlow({ ghBin: gh, env: { PATH: process.env.PATH, HOME: '/personal-gh-must-not-be-used' }, faravanHome });
  const configDir = await readFile(record, 'utf8');
  await access(configDir);
  flow.cancel();
  assert.deepEqual(await flow.waitForCompletion(), { status: 'failed', detail: 'cancelled before completion' });
  await assert.rejects(() => access(configDir));
});

// A GitHub sign-in changes the published generation and the binding. It must not start while a borrowed sandbox is running.
test('GitHub sign-in waits for a running sandbox lease and starts nothing while it is active', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wf-github-lease-'));
  const started = join(home, 'gh-started');
  const gh = await executable('gh', `printf started > '${started}'\nif [ "$2" = login ]; then echo 'one-time code: TEST-1234'; echo 'https://github.com/login/device'; else printf synthetic; fi`);
  const sbx = await executable('sbx', 'cat > /dev/null');
  await mkdir(join(home, 'scratch-journal'));
  const lease = join(home, 'scratch-journal', 'borrowed-sandbox.json');
  await writeFile(lease, '{}');
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(startGitHubAuthFlow({ ghBin: gh, sbxBin: sbx, faravanHome: home, leaseWaitMs: 150 }),
    { code: 'credential_scope_unenforceable', condition: 'other_sandbox_lease' });
  assert.equal(await access(started).then(() => true, () => false), false, 'gh never ran');
  // Once the sandbox ends, a waiting sign-in proceeds.
  const waiting = startGitHubAuthFlow({ ghBin: gh, sbxBin: sbx, faravanHome: home, leaseWaitMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await access(started).then(() => true, () => false), false, 'gh still waiting for the lease');
  await rm(lease);
  const flow = await waiting;
  flow.cancel();
  await flow.waitForCompletion().catch(() => {});
});
