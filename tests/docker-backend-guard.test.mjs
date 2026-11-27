import './helpers/no-browser.mjs';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DockerSbxBackend as RealDockerSbxBackend, normalizeLendingBudget } from '../lib/docker-backend.mjs';
import { jobCommand as claudeJobCommand } from '../lib/harnesses/claude-code-subscription.adapter.mjs';
import { claudeHeadroomUsd, claudeMaxBudgetUsd } from '../lib/faravan-guard-host.mjs';

const runtimeHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
const FIXTURES = fileURLToPath(new URL('./fixtures/guard/', import.meta.url));

/**
 * A stand-in `sbx` whose "guest" is this machine: `exec` runs the command locally in its own process group,
 * `cp` copies with the `SANDBOX:` prefix removed, `stop` kills every running exec group. HOME for exec
 * children is the scratch home, so the Codex fixture and the guard agree on where the rollout is.
 */
class DockerSbxBackend extends RealDockerSbxBackend {
  constructor(options = {}) {
    const home=path.join(process.env.FARAVAN_SCRATCH_ROOT??process.env.FARAVAN_TEST_HOME,'profile');
    super({home,cleanupDirectory:path.join(home,'v1/sandbox-cleanup'),...options, guestRuntime: async () => ({node:process.execPath, sha256:runtimeHash}) });
  }
  assertActive(handle,options={}) {return super.assertActive(handle,{...options,guestCommand:false});}
  async _dispatchProtected(handle,signal,launch) {await this.assertActive(handle);signal?.throwIfAborted();return launch();}
  async _runJobCommand(handle, args, ...rest) {
    const mapped = args.map(arg => arg.replace(/\/tmp\/faravan-runtime-[a-f0-9]{64}\/node/g, process.execPath));
    if (args[0] === 'exec' && args.includes('mkdir') && args.at(-1).startsWith('/tmp/faravan-guard-')) {
      const result = await super._runJobCommand(handle, mapped, ...rest);
      if (result.code !== 0) process.stderr.write(`guard fixture mkdir failed: exit=${result.code} stderr=${JSON.stringify(result.stderr || '')}\n`);
      return result;
    }
    if (args[0] === 'cp' && args.at(-1).includes(':/tmp/faravan-runtime-') ||
        args[0] === 'exec' && (args.at(-1).startsWith("mkdir -p '/tmp/faravan-runtime-") || args.at(-1).includes('hashlib.sha256') && !args.at(-1).includes('exit 125'))) return Promise.resolve({code:0,stdout:'',stderr:''});
    return super._runJobCommand(handle, mapped, ...rest);
  }
}

async function localGuest() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-guard-backend-'));
  const work = path.join(dir, 'work'); const home = path.join(dir, 'home');
  await mkdir(work); await mkdir(home);
  const bin = path.join(dir, 'sbx');
  await writeFile(bin, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
    'const dir = ' + JSON.stringify(dir) + ';',
    'const args = process.argv.slice(2);',
    "if (args[0] === 'daemon' && args[1] === 'status') { console.log('Status: running'); process.exit(0); }",
    "fs.appendFileSync(dir + '/argv.jsonl', JSON.stringify(args) + '\\n');",
    "const strip = (p) => p.replace(/^[^:/]+:/, '');",
    "if (args[0] === 'exec') {",
    "  const argv = args.slice(args.indexOf('--') + 1);",
    "  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'pipe'], detached: true, env: { ...process.env, HOME: dir + '/home', FARAVAN_HOME: dir + '/home/.faravan', CODEX_HOME: dir + '/home/.codex', CLAUDE_CONFIG_DIR: dir + '/home/.claude' } });",
    "  let stderrRemainder = ''; let duplicateSent = false;",
    "  child.stderr.on('data', chunk => { process.stderr.write(chunk); if (duplicateSent || !fs.existsSync(dir + '/duplicate-started')) return; stderrRemainder += chunk.toString(); const lines = stderrRemainder.split('\\n'); stderrRemainder = lines.pop(); for (const line of lines) { if (!duplicateSent && line.startsWith('{\\\"type\\\":\\\"faravan.started\\\"')) { process.stderr.write(line + '\\n'); fs.writeFileSync(dir + '/duplicate-sent', ''); duplicateSent = true; } } });",
    "  fs.appendFileSync(dir + '/pids', child.pid + '\\n');",
    "  child.on('exit', (code, signal) => process.exit(code ?? 137));",
    "} else if (args[0] === 'cp') {",
    "  fs.copyFileSync(strip(args[1]), strip(args[2]));",
    "} else if (args[0] === 'stop') {",
    "  for (const line of fs.readFileSync(dir + '/argv.jsonl', 'utf8').trim().split(String.fromCharCode(10))) { const a = JSON.parse(line), ctl = a[0] === 'exec' && a.includes('mkdir') ? a.at(-1) : ''; if (!new RegExp('^/tmp/faravan-guard-[0-9a-f]{16}/ctl$').test(ctl)) continue; try { process.kill(-Number(fs.readFileSync(ctl + '/agent.pgid', 'utf8')), 'SIGKILL'); } catch {} }",
    "  for (const pid of (fs.existsSync(dir + '/pids') ? fs.readFileSync(dir + '/pids', 'utf8') : '').split('\\n').filter(Boolean)) { try { process.kill(-Number(pid), 'SIGKILL'); } catch {} }",
    "} else if (args[0] === 'ls') { console.log('[]'); }",
  ].join('\n'), { mode: 0o755 });
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = bin;
  const previousScratch = process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT = path.join(dir, 'scratch');
  return {
    dir, work, home,
    duplicateStarted: () => writeFile(path.join(dir, 'duplicate-started'), ''),
    duplicateWasSent: () => existsSync(path.join(dir, 'duplicate-sent')),
    argv: async () => (await readFile(path.join(dir, 'argv.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    cleanup: async () => {
      if (previous === undefined) delete process.env.FARAVAN_SBX_BIN; else process.env.FARAVAN_SBX_BIN = previous;
      if (previousScratch === undefined) delete process.env.FARAVAN_SCRATCH_ROOT; else process.env.FARAVAN_SCRATCH_ROOT = previousScratch;
      for (const pid of (existsSync(path.join(dir, 'pids')) ? await readFile(path.join(dir, 'pids'), 'utf8') : '').split('\n').filter(Boolean)) { try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* gone */ } }
      // The local "guest" is this machine: remove the guard directories the backend made under /tmp.
      const made = existsSync(path.join(dir, 'argv.jsonl')) ? (await readFile(path.join(dir, 'argv.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) : [];
      for (const args of made) {
        const target = args[0] === 'exec' && args.includes('mkdir') ? args.at(-1) : null;
        if (target && /^\/tmp\/faravan-guard-[0-9a-f]{16}\/ctl$/.test(target)) {
          try { process.kill(-Number(await readFile(path.join(target,'agent.pgid'),'utf8')), 'SIGKILL'); } catch { /* gone */ }
          await rm(path.dirname(target), { recursive: true, force: true, maxRetries:5, retryDelay:50 });
        }
      }
      await rm(dir, { recursive: true, force: true, maxRetries:5, retryDelay:50 });
    },
  };
}

/**
 * A hand-built handle stands for a sandbox this dispatch created only once a cleanup record says so:
 * a stop reaches a sandbox only through that record. Give the handle a valid name and such a record.
 */
function recordCreated(backend, guest, handle, extra = {}) {
  handle.sandbox_id = 'wf-' + randomBytes(8).toString('hex');
  const record = { ...testSbxRuntimeFields(), job_id: handle.job_id, sandbox_id: handle.sandbox_id,
    scratch_dir: path.join(guest.dir, 'scratch', 'wf-job-' + handle.sandbox_id + '-guard') };
  mkdirSync(record.scratch_dir, { recursive: true });
  backend.cleanupJournal.register(record);
  backend.cleanupJournal.mark(record, { create: 'dispatched', compute_created: true, ...extra });
  Object.assign(handle, { _cleanupId: record._cleanupId, owner_scope: record.owner_scope, sbx_home: record.sbx_home, _sbxRuntime:record._sbxRuntime, sbx_runtime:record.sbx_runtime });
  return handle;
}

function handleFor(guest, entrypoint) {
  return { ...testSbxRuntimeFields(), backend_id: 'docker-sbx', job_id: 'job-guard', sandbox_id: 'wf-guard-test', scratch_dir: guest.work,
    _entrypoint: 'cd ' + guest.work + ' && ' + entrypoint,
    _deadline: { controller: new AbortController(), expired: false, handles: new Set(), endsAt: performance.now() + 600_000 } };
}

const fake = (name, mode) => `FAKE_MODE=${mode} node ${FIXTURES}${name}`;
const fastTimings = { heartbeat_ms: 100, sigint_grace_ms: 2000, sigterm_grace_ms: 1000 };
async function until(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('condition not reached');
}

test('guest agent waits for durable host launch acknowledgement', {timeout:30000}, async () => {
  const guest=await localGuest();
  let release;const gate=new Promise(resolve=>{release=resolve;});let entered=false;
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,fake('fake-claude.mjs','finish'));
    const running=backend.start(handle,{onLaunchDurable:()=>{entered=true;return gate;},onExecutionStarted:()=>{}});
    running.catch(()=>{});
    await until(()=>entered,3000);
    const ctl=(await guest.argv()).find(args=>args[0]==='exec'&&args.includes('mkdir')).at(-1);
    await writeFile(path.join(ctl,'launch-ack'),'forged');
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false,'agent cannot execute before acknowledgement');
    release();await running;
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),true);
  } finally {release();await guest.cleanup();}
});

test('failed durable launch write cannot release the agent', {timeout:30000}, async () => {
  const guest=await localGuest();let entered=false;
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,fake('fake-claude.mjs','finish'));
    const running=backend.start(handle,{onLaunchDurable:()=>{entered=true;throw new Error('storage failed');},onExecutionStarted:()=>{}});
    running.catch(()=>{});
    await until(()=>entered,3000);
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false);
    handle._deadline.controller.abort();
    await assert.rejects(running);
  } finally {await guest.cleanup();}
});

test('failed launch acknowledgement is coded and cannot release the agent', {timeout:30000}, async () => {
  const guest=await localGuest();
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const run=backend._runJobCommand.bind(backend);
    backend._runJobCommand=(handle,args,...rest)=>args.at(-1)?.startsWith('printf %s ')&&args.at(-1).includes('/launch-ack')
      ?Promise.resolve({code:1,stdout:'',stderr:'synthetic failure'}):run(handle,args,...rest);
    const handle=handleFor(guest,fake('fake-claude.mjs','finish'));
    const running=backend.start(handle,{onLaunchDurable:async()=>{},onExecutionStarted:()=>assert.fail('agent was released')});
    running.catch(()=>{});
    await until(()=>handle._lending?.observationError,3000);
    assert.equal(handle._lending.observationError.code,'launch_ack_failed');
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false);
    handle._deadline.controller.abort();await assert.rejects(running);
  } finally {await guest.cleanup();}
});

test('aborting before durable launch acknowledgement cannot release the agent', {timeout:30000}, async () => {
  const guest=await localGuest();let entered=false,release;
  const pending=new Promise(resolve=>{release=resolve;});
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,fake('fake-claude.mjs','finish'));
    const running=backend.start(handle,{onLaunchDurable:()=>{entered=true;return pending;},onExecutionStarted:()=>{}});
    running.catch(()=>{});await until(()=>entered,3000);
    handle._deadline.controller.abort();await assert.rejects(running);
    release();await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false);
  } finally {release();await guest.cleanup();}
});

test('run cancellation fences a late durable acknowledgement', {timeout:30000}, async () => {
  const guest=await localGuest(),controller=new AbortController();let entered=false,release;
  const pending=new Promise(resolve=>{release=resolve;});
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,fake('fake-claude.mjs','finish'));
    const running=backend.start(handle,{signal:controller.signal,onLaunchDurable:()=>{entered=true;return pending;},onExecutionStarted:()=>{}});
    running.catch(()=>{});await until(()=>entered,3000);
    controller.abort();release();
    const result=await Promise.race([running.then(()=>true,()=>false),new Promise(resolve=>setTimeout(()=>resolve('pending'),1000))]);
    assert.equal(result,false,'cancelled execution must stop');
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false);
  } finally {controller.abort();release();await guest.cleanup();}
});

test('host process death before durable acknowledgement cannot start the agent', {timeout:30000}, async () => {
  const guest=await localGuest(),marker=path.join(guest.dir,'host-entered');let child;
  try {
    const moduleUrl=new URL('../lib/docker-backend.mjs',import.meta.url).href;
    const program=`import {testSbxRuntimeFields} from ${JSON.stringify(new URL('./helpers/sandbox-receipt-fixture.mjs',import.meta.url).href)}; import {writeFileSync} from 'node:fs'; const runtimeHash=${JSON.stringify(runtimeHash)}; import {DockerSbxBackend} from ${JSON.stringify(moduleUrl)};
      const backend=new DockerSbxBackend({guardTimings:{heartbeat_ms:100},guestRuntime:async()=>({node:process.execPath,sha256:runtimeHash})});
      backend.assertActive=async()=>{};backend._dispatchProtected=async(_h,s,launch)=>{s?.throwIfAborted();return launch();};
      const original=backend._runJobCommand.bind(backend);
      backend._runJobCommand=(handle,args,...rest)=>args.at(-1).includes('faravan-runtime-')&&!args.at(-1).includes('faravan-guard-') ? Promise.resolve({code:0,stdout:'',stderr:''}) : original(handle,args.map(a=>a.replaceAll('/tmp/faravan-runtime-'+runtimeHash+'/node',process.execPath)),...rest);
      const handle={...testSbxRuntimeFields(),backend_id:'docker-sbx',job_id:'job-guard',sandbox_id:'wf-guard-test',scratch_dir:${JSON.stringify(guest.work)},
        _entrypoint:${JSON.stringify('cd '+guest.work+' && '+fake('fake-claude.mjs','finish'))},
        _deadline:{controller:new AbortController(),expired:false,handles:new Set(),endsAt:performance.now()+600000}};
      backend.start(handle,{onLaunchDurable:()=>{writeFileSync(${JSON.stringify(marker)},'entered');return new Promise(()=>{});},onExecutionStarted(){}}).catch(()=>{});`;
    child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:'ignore',env:process.env});
    await until(()=>existsSync(marker),3000);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(existsSync(path.join(guest.work,'edit.txt')),false);
  } finally {if(child?.exitCode===null)child.kill('SIGKILL');await guest.cleanup();}
});

test('a Claude budget stop resolves with the stop record, keeps the work, and keeps the allowance out of every log', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-claude.mjs', 'budget'));
    const logged = []; const meters = []; const beats = []; let starts = 0;
    const result = await backend.start(handle, { onLog: ({ stream, chunk }) => logged.push(stream + ':' + chunk), onMeter: (m) => meters.push(m), onHeartbeat: (b) => beats.push(b),
      onExecutionStarted: () => { starts++; },
      lendingBudget: { agent: 'claude', budget: { unit: 'claude_usd', limit: 0.05 } } });
    assert.equal(result.stop.stop_reason, 'budget');
    assert.equal(result.stop.used_units, 0.051);
    assert.equal(result.stop.budget_units, 0.05);
    assert.equal(await readFile(path.join(guest.work, 'edit.txt'), 'utf8'), 'partial\n', 'work stays for collection');
    assert.ok(meters.some((m) => m.windows.some((w) => w.window_id === 'seven_day' && w.used_pct === 37)));
    assert.ok(beats.length >= 1);
    assert.equal(starts, 1, 'the guest entrypoint spawn signal is reported once');
    for (const text of [logged.join(''), handle._lastExecStdout, handle._lastExecStderr]) {
      assert.doesNotMatch(text, /rate_limit_event|faravan\.|utilization|unifiedWindows/);
    }
    assert.match(handle._lastExecStdout, /"type":"result"/);
    assert.equal(handle._execution.stop, undefined, 'nothing lender-private enters the public execution record');
    assert.ok(!(await guest.argv()).some((args) => args[0] === 'cp' && args[2].startsWith('wf-guard-test:' + guest.work)), 'the guard is not placed in the workspace');
  } finally { await guest.cleanup(); }
});

test('requestStop(owner) interrupts with SIGINT and the pending start() resolves with stop_reason owner', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-claude.mjs', 'hang'));
    const running = backend.start(handle, { lendingBudget: { agent: 'claude', budget: null } });
    await until(() => existsSync(path.join(guest.work, 'edit.txt')));
    let cessations = 0;
    const answer = await backend.requestStop(handle, 'owner', { onCessation: () => { cessations++; } });
    assert.deepEqual(answer, { delivered: true, fallback: null, reason: 'owner' });
    assert.equal(cessations, 1, 'effective cessation is reported once, when the guard ended the run');
    const result = await running;
    assert.equal(result.stop.stop_reason, 'owner');
    assert.equal(result.stop.signal, 'SIGINT');
    assert.equal(await readFile(path.join(guest.work, 'interrupted.txt'), 'utf8'), 'SIGINT\n', 'the agent behind `cd … &&` got the interrupt');
    assert.match(handle._lastExecStdout, /error_during_execution/, 'the agent\'s final events after SIGINT are kept');
  } finally { await guest.cleanup(); }
});

test('a guard that cannot finish the stop in time falls back to sbx stop, and start() says the work was not kept', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: { ...fastTimings, sigint_grace_ms: 60_000 } });
    const handle = recordCreated(backend, guest, handleFor(guest, fake('fake-claude.mjs', 'ignore-sigint')));
    const running = backend.start(handle, { lendingBudget: { agent: 'claude', budget: null } });
    running.catch(() => {});
    await until(() => existsSync(path.join(guest.work, 'edit.txt')));
    const agentGroup=Number(await readFile(path.join(handle._lending.guard.ctl,'agent.pgid'),'utf8'));
    let cessations = 0;
    const answer = await backend.requestStop(handle, 'owner', { answerMs: 300, onCessation: () => { cessations++; } });
    assert.deepEqual(answer, { delivered: false, fallback: 'hard', reason: 'owner' });
    assert.equal(cessations, 0, 'a hard fallback is never reported as cessation');
    await assert.rejects(running, { code: 'stopped_without_delivery' });
    assert.ok((await guest.argv()).some((args) => args[0] === 'stop'));
    await until(()=>{try{process.kill(-agentGroup,0);return false;}catch{return true;}});
  } finally { await guest.cleanup(); }
});

test('a guard that ends without its own clean exit does not count as a delivered stop; the host hard-stops', async () => {
  const guest = await localGuest();
  let survivor = null;
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = recordCreated(backend, guest, handleFor(guest, fake('fake-guard-killer.mjs', 'hang')));
    const running = backend.start(handle, { lendingBudget: { agent: 'claude', budget: null } });
    running.catch(() => {});
    await until(() => existsSync(path.join(guest.work, 'survivor.pid')));
    survivor = Number(await readFile(path.join(guest.work, 'survivor.pid'), 'utf8'));
    const answer = await backend.requestStop(handle, 'owner', { answerMs: 3000 });
    assert.deepEqual(answer, { delivered: false, fallback: 'hard', reason: 'owner' });
    assert.ok((await guest.argv()).some((args) => args[0] === 'stop'), 'sbx stop was run');
    await until(() => { try { process.kill(survivor, 0); return false; } catch { return true; } });
  } finally {
    if (survivor) { try { process.kill(-survivor, 'SIGKILL'); } catch { /* gone */ } try { process.kill(survivor, 'SIGKILL'); } catch { /* gone */ } }
    await guest.cleanup();
  }
});

test('requestStop with no guarded run says so instead of pretending', async () => {
  const backend = new DockerSbxBackend();
  assert.deepEqual(await backend.requestStop({ sandbox_id: 'x' }, 'owner'), { delivered: false, fallback: null, reason: 'owner', running: false });
  await assert.rejects(backend.requestStop({}, 'done'), TypeError);
});

test('Codex under the guard: live meter readings and a credit budget stop with the work kept', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-codex.mjs', 'run'));
    const meters = [];
    const result = await backend.start(handle, { onMeter: (m) => meters.push(m),
      lendingBudget: { agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } } } });
    assert.equal(result.stop.stop_reason, 'budget');
    assert.ok(result.stop.used_units >= 3);
    assert.ok(meters.length >= 2);
    assert.equal(meters[0].source, 'codex-rollout');
    assert.deepEqual(meters[0].windows, [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 33, resets_at: '2026-10-27T06:32:06.000Z' }]);
    assert.ok(existsSync(path.join(guest.work, 'interrupted.txt')));
    assert.equal(handle._lending.readings.length, meters.length, 'readings stay on the handle as the lender\'s local record');
    assert.doesNotMatch(handle._lastExecStdout + handle._lastExecStderr, /rate_limits|plan_type|balance|faravan\./, 'no rollout or account line reaches the transcript');
    assert.ok(!(await guest.argv()).some((args) => args[0] === 'cp' && args[1].includes('.codex')), 'the rollout is never copied out');
  } finally { await guest.cleanup(); }
});

test('Codex run that ends on its own: the final reading is the last meter the host returns', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-codex.mjs', 'finish'));
    const meters = [];
    const result = await backend.start(handle, { onMeter: (m) => meters.push(m),
      lendingBudget: { agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } } } });
    assert.equal(result.stop, null, 'no stop record: the run ended on its own');
    assert.equal(meters.at(-1).final, true, 'the streamed last reading is final');
    assert.equal(result.meter.final, true, 'the returned meter is the final reading, not the last live one');
    assert.deepEqual(result.meter.tokens, { input: 1000, cached_input: 600, output: 100, reasoning_output: 40 });
  } finally { await guest.cleanup(); }
});

test('a silent guard is treated as tampering: the job is hard-stopped with guard_heartbeat_lost', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: { ...fastTimings, heartbeat_ms: 60_000, heartbeat_loss_ms: 400 } });
    const handle = recordCreated(backend,guest,handleFor(guest, fake('fake-claude.mjs', 'hang')));
    await assert.rejects(backend.start(handle, { lendingBudget: { agent: 'claude', budget: null } }), { code: 'guard_heartbeat_lost' });
  } finally { await guest.cleanup(); }
});

test('observation delivery is detached, contained, recorded, and invoked once', { timeout: 30000 }, async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const [name, callback, expectedError] of [
      ['pending', () => new Promise(() => {}), null],
      ['rejecting', () => Promise.reject(new Error('rejected observation')), 'rejected observation'],
      ['throwing', () => { throw new Error('thrown observation'); }, 'thrown observation'],
    ]) {
      const guest = await localGuest();
      try {
        const backend = new DockerSbxBackend({ guardTimings: fastTimings });
        const handle = handleFor(guest, fake('fake-claude.mjs', 'finish'));
        let starts = 0;
        await backend.start(handle, { onExecutionStarted: () => { starts++; return callback(); } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(starts, 1, `${name} callback is invoked once`);
        assert.equal(unhandled.length, 0, `${name} callback has no unhandled rejection`);
        assert.equal(handle._lending.observationError?.message ?? null, expectedError, `${name} failure is recorded`);
      } finally { await guest.cleanup(); }
    }
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

test('wrong-nonce and replayed started events never become meter readings', { timeout: 10000 }, async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    await guest.duplicateStarted();
    const forged = 'echo \'{"type":"faravan.started","v":1,"seq":99,"at":"2026-10-28T00:00:00.000Z","nonce":"00000000000000000000000000000000"}\' >&2; ';
    const handle = handleFor(guest, forged + fake('fake-claude.mjs', 'finish'));
    const meters = [];
    let starts=0;
    const result = await backend.start(handle, { onMeter: (m) => meters.push(m),
      onExecutionStarted: () => { starts++; return new Promise(() => {}); },
      lendingBudget: { agent: 'claude', budget: null } });
    assert.equal(result.stop, null);
    assert.equal(starts, 1);
    assert.ok(guest.duplicateWasSent(), 'the transport replayed the exact accepted started line');
    assert.ok(meters.every((entry) => entry.type === 'meter' && entry.seq !== 99));
    assert.ok(handle._lending.readings.every((entry) => entry.type === 'meter' && entry.seq !== 99));
    assert.equal(handle._lending.meter?.type, 'meter');
    assert.doesNotMatch(handle._lastExecStderr, /faravan/);
  } finally { await guest.cleanup(); }
});

test('an unmetered agent uses a guest start signal for execution evidence', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-claude.mjs', 'finish'));
    let starts = 0;
    const result = await backend.start(handle, { onExecutionStarted: () => { starts++; } });
    assert.equal(result.stop, null);
    assert.equal(starts, 1);
    assert.equal(handle._lending.guard.config.soft_deadline_s, null, 'generic observation adds no graceful-stop deadline');
    assert.match(handle._lastExecStdout, /"type":"result"/);
  } finally { await guest.cleanup(); }
});

test('a genuine agent failure under the guard still fails the job', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-claude.mjs', 'fail'));
    await assert.rejects(backend.start(handle, { lendingBudget: { agent: 'claude', budget: null } }), { code: 'agent_exit_nonzero', exitCode: 2 });
  } finally { await guest.cleanup(); }
});

test('lending budgets are checked before anything reaches the guest', () => {
  for (const bad of [null, { agent: 'gemini' }, { agent: 'claude', budget: { unit: 'codex_credits', limit: 1 } }, { agent: 'claude', budget: { unit: 'claude_usd', limit: 0 } },
    { agent: 'codex', budget: { unit: 'codex_credits', limit: 3 } }, { agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: -1, cached_input: 0, output: 0 } } },
    { agent: 'claude', budget: null, soft_deadline_s: -5 }]) {
    assert.throws(() => normalizeLendingBudget(bad), { code: 'policy_unenforceable' }, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeLendingBudget({ agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: 1, cached_input: 0.1, output: 5, extra: 9 } } }),
    { agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: 1, cached_input: 0.1, output: 5 } }, soft_deadline_s: null });
});

test('Claude\'s native cap is the budget minus one call of headroom, and too small a budget does not start', async () => {
  assert.equal(claudeHeadroomUsd({ observedMaxCallUsd: 0.006 }), 0.006);
  // Opus 5.5 at its full 1M context: the 1-hour cache write case dominates (8 + 128k x 20 per M).
  const { worstCallUsd } = await import('../lib/v1/lending-meter.mjs');
  const headroom = claudeHeadroomUsd({ worstCaseUsd: worstCallUsd('claude-opus-5-5', { maxPromptTokens: 1_000_000, maxOutputTokens: 128_000 }) });
  assert.ok(Math.abs(headroom - 10.56) < 1e-9);
  assert.equal(claudeMaxBudgetUsd({ limitUsd: 0.05, headroomUsd: 0.006 }), 0.044);
  assert.equal(claudeMaxBudgetUsd({ limitUsd: 1, headroomUsd: 10.56 }), null);
  assert.throws(() => claudeHeadroomUsd({}), TypeError);
});

test('Haiku 5.5 at its full 1M context is priced at the higher tier: a $0.30 lend is too small, a $2.00 lend is capped just under $0.68', async () => {
  const { worstCallUsd } = await import('../lib/v1/lending-meter.mjs');
  const headroom = claudeHeadroomUsd({ worstCaseUsd: worstCallUsd('claude-haiku-5-5', { maxPromptTokens: 1_000_000, maxOutputTokens: 128_000 }) });
  assert.ok(Math.abs(headroom - 1.32) < 1e-9);
  assert.equal(claudeMaxBudgetUsd({ limitUsd: 0.30, headroomUsd: headroom }), null);
  // Floats put 2 - 1.32 a hair under 0.68, so the cap floors to 0.679999. A true shortfall is never rounded up past it.
  assert.equal(claudeMaxBudgetUsd({ limitUsd: 2, headroomUsd: headroom }), 0.679999);
  assert.equal(claudeMaxBudgetUsd({ limitUsd: 2, headroomUsd: 1.3200000004 }), 0.679999);
  const command = claudeJobCommand({ prompt: 'p', workspace: '/w', maxBudgetUsd: 0.044 });
  assert.match(command, /--max-budget-usd' '0\.044'/);
  assert.doesNotMatch(claudeJobCommand({ prompt: 'p', workspace: '/w' }), /max-budget/);
  assert.throws(() => claudeJobCommand({ prompt: 'p', workspace: '/w', maxBudgetUsd: 0 }), { code: 'policy_unenforceable' });
});

for (const [reason, budget] of [['owner', null], ['budget', null], ['time', null], ['provider_limit', null],
  ['budget', { unit: 'codex_credits', limit: 1000, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } }]]) {
  test(`a stop the host never imposed is refused even when the record is well-formed: agent-filed ${reason}${budget ? ' under budget' : ''}`, async () => {
    const guest = await localGuest();
    try {
      const backend = new DockerSbxBackend({ guardTimings: fastTimings });
      const handle = handleFor(guest, `FAKE_REASON=${reason} node ${FIXTURES}fake-tamper.mjs`);
      await assert.rejects(backend.start(handle, { lendingBudget: { agent: budget ? 'codex' : 'claude', budget } }), { code: 'guard_record_unverified' });
    } finally { await guest.cleanup(); }
  });
}

test('a budget stop the host decided from its own meter is delivered through requestStop', async () => {
  const guest = await localGuest();
  try {
    const backend = new DockerSbxBackend({ guardTimings: fastTimings });
    const handle = handleFor(guest, fake('fake-codex.mjs', 'run'));
    let asked = null;
    const running = backend.start(handle, { lendingBudget: { agent: 'codex', budget: null },
      onMeter: (m) => { if (!asked && m.tokens.output >= 300) asked = backend.requestStop(handle, 'budget'); } });
    const result = await running;
    assert.equal((await asked).delivered, true);
    assert.equal(result.stop.stop_reason, 'budget');
  } finally { await guest.cleanup(); }
});

for(const mode of ['missing','quiet','stale'])test('Codex metering '+mode+' stops independently of heartbeats and keeps partial work',async()=>{
 const guest=await localGuest();try{
  const backend=new DockerSbxBackend({guardTimings:{...fastTimings,meter_start_ms:1000,meter_loss_ms:500}});
  const stopRecordReads=[];const runSbx=backend.runSbx.bind(backend);
  backend.runSbx=async(args,options)=>{
   const result=await runSbx(args,options);
   if(args[0]==='exec'&&args.at(-1)?.includes('/stop.json'))stopRecordReads.push({code:result.code,stdout:result.stdout,stderr:result.stderr});
   return result;
  };
  const handle=handleFor(guest,fake('fake-codex.mjs',mode));
  const meters=[];
  const result=await backend.start(handle,{lendingBudget:{agent:'codex',budget:{unit:'codex_credits',limit:1000,weights:{input:0.001,cached_input:0.001,output:0.001}}},onMeter:m=>meters.push(m)});
  let stopFile;try{stopFile=await readFile(path.join(handle._lending.guard.ctl,'stop.json'),'utf8');}catch(error){stopFile={code:error.code};}
  assert.equal(result.stop?.stop_reason,'error',JSON.stringify({
   heartbeat_seq:handle._lending.heartbeat_seq,lastUsageAt:handle._lending.lastUsageAt,
   requested:[...handle._lending.requested],meter:handle._lending.meter,
   stopFile,stopRecordReads,argv:await guest.argv(),
   interrupted:existsSync(path.join(guest.work,'interrupted.txt')),
   stdout:handle._lastExecStdout,stderr:handle._lastExecStderr,
  }));assert.equal(await readFile(path.join(guest.work,'edit.txt'),'utf8'),'partial\n');
  assert.ok(handle._lending.heartbeat_seq!==null);
  if(mode==='stale')assert.ok(meters.slice(1).every(m=>m.used_units===null),'old totals cannot refresh the host usage deadline');
 }finally{await guest.cleanup();}
});

test('guard meter omissions stay unknown in Docker host meter events', async () => {
  const guest = await localGuest();
  const backend = new DockerSbxBackend({ guardTimings: fastTimings });
  try {
    const codexMeters = [], beats = [];
    const codex = await backend.start(handleFor(guest, fake('fake-codex.mjs', 'run')), {
      lendingBudget: { agent: 'codex', budget: { unit: 'codex_credits', limit: 3, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } } },
      onMeter: event => { codexMeters.push(event); },
      onHeartbeat: beat => beats.push(beat),
    });
    assert.equal(codex.stop.stop_reason, 'budget');
    assert.ok(beats.length > 0, 'the real host path still parses heartbeats');
    const unknown = codexMeters.find(event => event.source === 'codex-rollout');
    assert.ok(unknown, 'the real guard emitted a Codex meter through the Docker host parser');
    assert.ok(unknown.tokens.output > 0, 'usage readings continue through the host parser');
    assert.ok(unknown.windows.some(window => window.window_id === 'codex:10080'));
    assert.equal(Object.hasOwn(unknown, 'limit_reached'), false, 'the host preserves unknown instead of fabricating false');
    assert.equal(Object.hasOwn(unknown, 'overage'), false, 'unknown overage stays absent');

    const claudeMeters = [];
    await backend.start(handleFor(guest, fake('fake-claude.mjs', 'finish')), {
      lendingBudget: { agent: 'claude', budget: null },
      onMeter: event => { claudeMeters.push(event); },
    });
    const recovery = claudeMeters.find(event => event.source === 'claude-stream' && event.final !== true);
    assert.ok(recovery, 'the real Claude stream emitted a provider-control reading');
    assert.equal(Object.hasOwn(recovery, 'limit_reached'), false, 'an allowed status is not authoritative limit recovery');
    assert.equal(recovery.overage, false, 'supported explicit false remains a recovery signal');
  } finally {
    await guest.cleanup();
  }
});

test('destroy waits for independent delayed removal proof and refuses unknown listing',async()=>{
  for(const known of [true,false]){
    const dir=await mkdtemp(path.join(os.tmpdir(),'guard-cleanup-proof-'));
    let release,listed=false,finished=false;
    const pending=new Promise(resolve=>{release=resolve;});
    const calls=[];
    const backend=new DockerSbxBackend({runCommand:async args=>{
      calls.push(args);
      if(args[0]==='ls'){listed=true;await pending;return {code:known?0:1,stdout:known?'[]':'',stderr:''};}
      return {code:0,stdout:'',stderr:''};
    }});
    const h={job_id:'owned-proof',scratch_dir:dir};
    const previousScratch=process.env.FARAVAN_SCRATCH_ROOT;
    process.env.FARAVAN_SCRATCH_ROOT=path.join(dir,'scratch');
    // Removal is judged through the record of this dispatch's own create, once the sandbox was seen.
    recordCreated(backend,{dir},h,{create_settled:true});
    try{
      const destroying=backend.destroy(h).then(r=>{finished=true;return r;});
      await until(()=>listed);
      assert.equal(finished,false,'rm exit0 alone is not removed:true while host observation pending');
      release();
      const receipt=await destroying;
      assert.equal(receipt.removed,known);
      assert.equal(calls.some(a=>a[0]==='rm'),false,'absent or unreadable inventory does not authorize rm');
      assert.ok(calls.some(a=>a[0]==='ls'&&a[1]==='--json'));
    }finally{release();if(previousScratch===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previousScratch;await rm(dir,{recursive:true,force:true});}
  }
});

// Host disk stop. The halt is `sbx stop`, which the stand-in sbx carries out by killing every exec
// process group with SIGKILL. The root clean-up of inner containers is recorded, never run here: on
// this machine it would reach the host's own Docker. The SIGKILL escalation is a recording stub: the real
// one kills every sandbox of the sbx identity, which on this machine could be a real one.
function diskRig(guest, backend, startFree) {
  const disk = { free: startFree, async free_() { return { free: this.free, volumes: [] }; } };
  backend.hostDisk = { free: () => disk.free_() };
  const innerOff = [];
  const run = backend._runJobCommand.bind(backend);
  backend._runJobCommand = (handle, args, ...rest) => args.includes('-u') && args.includes('root') && String(args.at(-1)).includes('docker ps -aq')
    ? (innerOff.push(args), Promise.resolve({ code: 0, stdout: '', stderr: '' })) : run(handle, args, ...rest);
  const kills = [];
  backend.killSandboxes = async () => { kills.push(Date.now()); return false; };
  return { disk, innerOff, kills, sentry: handle => backend._diskSentries.get(handle.sandbox_id) };
}
const GiB = 1024 ** 3;

// Only the halt confirmation clock is manual. Disk sampling keeps its real timers.
// These success-path integration tests observe real sbx stop completion, not how
// quickly a loaded host starts the stand-in Node process.
function eventDrivenHalt(backend) {
  const records = [];
  let entered, release, firstHalt, completed = false;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const cancel = backend.cancel.bind(backend);
  backend.cancel = async handle => {
    entered();
    await gate;
    const result = await cancel(handle);
    completed = true;
    return result;
  };
  const timers = {
    setTimeout(fn, ms) { const record = { fn, ms, cleared: false, unref() {} }; records.push(record); return record; },
    clearTimeout(record) { if (record) record.cleared = true; },
  };
  const halt = backend._haltForDisk.bind(backend);
  backend._haltForDisk = (...args) => {
    const previous = backend.diskTimers;
    backend.diskTimers = timers;
    try {
      // _haltForDisk captures its timers synchronously before its first await.
      const pending = halt(...args);
      firstHalt ??= pending;
      return pending;
    } finally { backend.diskTimers = previous; }
  };
  return {
    release,
    async confirm(t, name) {
      await started;
      await t.test(name, async () => {
        assert.equal(completed, false, 'halt cannot complete before the real stop command');
        assert.equal(records[0]?.ms, backend.diskHaltMs * 4 / 5, 'the original halt bound is retained');
        assert.equal(records[0].cleared, false, 'confirmation is still outstanding');
        release();
        await firstHalt;
        assert.equal(completed, true, 'the real sbx stop completed');
        assert.equal(records[0].cleared, true, 'completion clears its deadline');
      });
    },
  };
}

test('low host disk halts a running writer with SIGKILL, keeps its partial result and says host_disk_low', {timeout:30000}, async t => {
  const guest=await localGuest();let handle,backend,halt;
  try {
    backend=new DockerSbxBackend({guardTimings:fastTimings,diskHaltMs:200});
    const {disk,innerOff,kills,sentry}=diskRig(guest,backend,20*GiB);
    halt=eventDrivenHalt(backend);
    const out=path.join(guest.work,'writes.log');
    handle=recordCreated(backend,guest,handleFor(guest,'echo partial; while :; do echo x >> '+out+'; sleep 0.05; done'));
    const running=backend.start(handle,{});
    await until(()=>existsSync(out),5000);
    disk.free=1*GiB;
    await halt.confirm(t,"writer waits for real halt confirmation with a controlled deadline");
    const stopped=await running;
    assert.equal(stopped.host_disk_low,true);
    assert.equal(handle._execution.host_disk_low,true);
    assert.match(handle._lastExecStdout,/partial/);
    assert.ok((await guest.argv()).some(args=>args[0]==='stop'&&args[1]===handle.sandbox_id),'the halt is sbx stop');
    assert.equal(innerOff.length,1,'inner containers are switched off as root after the halt');
    const size=(await readFile(out)).length;
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal((await readFile(out)).length,size,'no write lands after the halt');
    assert.equal(kills.length,0,'a stop that works is not escalated');
    // Still low while the work is collected: the sandbox is halted again and nothing is delivered.
    await until(()=>sentry(handle).again===true,3000);
    await assert.rejects(backend.assertActive(handle),error=>error.code==='host_disk_low'&&/was not kept/.test(error.message));
  } finally {halt?.release();if(handle)backend?._closeDiskSentry?.(handle);await guest.cleanup();}
});

for (const [name, cancel, escalations] of [
  ['an sbx stop that overruns escalates to SIGKILL', () => new Promise(() => {}), 1],
  ['an sbx stop that fails at once is not escalated, since the kill would end every job of the identity', async () => { throw Object.assign(new Error('stop failed'), { code: 'sandbox_stop_failed' }); }, 0],
]) test(`host disk halt: ${name}; a halt that fails keeps nothing and says the sandbox could not be halted`, {timeout:30000}, async () => {
  const guest=await localGuest();let handle,backend;
  try {
    backend=new DockerSbxBackend({guardTimings:fastTimings,diskHaltMs:200});
    const {disk,innerOff,kills,sentry}=diskRig(guest,backend,20*GiB);
    backend.cancel=cancel;
    const out=path.join(guest.work,'writes.log');
    handle=recordCreated(backend,guest,handleFor(guest,'while :; do echo x >> '+out+'; sleep 0.05; done'));
    const running=backend.start(handle,{});running.catch(()=>{});
    await until(()=>existsSync(out),5000);
    disk.free=1*GiB;
    await until(()=>sentry(handle)?.low,3000);
    handle._deadline.controller.abort();
    await assert.rejects(running,error=>error.code==='host_disk_low'&&/could not be halted/.test(error.message));
    assert.equal(kills.length,escalations);
    assert.equal(innerOff.length,0);
    await assert.rejects(backend.assertActive(handle),error=>error.code==='host_disk_low'&&/could not be halted/.test(error.message));
  } finally {if(handle)backend?._closeDiskSentry?.(handle);await guest.cleanup();}
});

test('a steady host disk never stops the run', {timeout:30000}, async () => {
  const guest=await localGuest();
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings,diskHaltMs:200});
    const {sentry}=diskRig(guest,backend,20*GiB);
    const handle=recordCreated(backend,guest,handleFor(guest,'sleep 0.5; echo done'));
    const result=await backend.start(handle,{});
    assert.notEqual(result.host_disk_low,true);
    assert.equal(sentry(handle).low,null);
    backend._closeDiskSentry(handle);
    assert.equal((await guest.argv()).some(args=>args[0]==='stop'),false);
  } finally {await guest.cleanup();}
});

test('after a disk stop of a lent run, handle copies collect the work and report their own failures', {timeout:30000}, async t => {
  const guest=await localGuest();let handle,backend,halt;
  try {
    backend=new DockerSbxBackend({guardTimings:fastTimings,diskHaltMs:200});
    const {disk,sentry}=diskRig(guest,backend,20*GiB);
    // The disk recovers as soon as the halt finishes, so the re-armed watch reads plenty of space.
    const cancel=backend.cancel.bind(backend);
    backend.cancel=async h=>{await cancel(h);disk.free=20*GiB;};
    halt=eventDrivenHalt(backend);
    const out=path.join(guest.work,'writes.log');
    handle=recordCreated(backend,guest,handleFor(guest,'echo partial; while :; do echo x >> '+out+'; sleep 0.05; done'));
    // A lent run: the guard is installed and handle._lending is set, as in runJob.
    const running=backend.start(handle,{onExecutionStarted(){}});
    await until(()=>existsSync(out),5000);
    disk.free=1*GiB;
    await halt.confirm(t,"lent collection waits for real halt confirmation with a controlled deadline");
    const stopped=await running;
    assert.equal(stopped.host_disk_low,true);
    assert.equal(stopped.stop.stop_reason,'owner');
    // execViaBackend's shape: a spread copy with a new entrypoint.
    await until(()=>sentry(handle).watch&&sentry(handle).collecting,3000);
    const copy={...handle,_entrypoint:'echo collected'};
    await backend.start(copy);
    assert.match(copy._lastExecStdout,/collected/,'the collection step ran');
    assert.equal(sentry(copy),sentry(handle),'the copy shares the sandbox watch, it does not start another');
    // A real failure of a collection step is reported, not swallowed.
    await assert.rejects(backend.start({...handle,_entrypoint:'exit 3'}),error=>error.code==='entrypoint_start_failed');
    backend._closeDiskSentry(handle);
    assert.equal(sentry(handle),undefined,'destroy closes the watch');
  } finally {halt?.release();if(handle)backend?._closeDiskSentry?.(handle);await guest.cleanup();}
});

test('a check command stopped by low host disk is skipped, not failed', {timeout:30000}, async t => {
  const guest=await localGuest();let handle,backend,halt;
  try {
    backend=new DockerSbxBackend({guardTimings:fastTimings,diskHaltMs:200});
    const {disk}=diskRig(guest,backend,20*GiB);
    halt=eventDrivenHalt(backend);
    const out=path.join(guest.work,'check.log');
    handle=recordCreated(backend,guest,handleFor(guest,'true'));
    backend._diskSentry(handle);
    const checking=backend.verify(handle,{cmd:'while :; do echo x >> '+out+'; sleep 0.05; done',workdir:guest.work});
    await until(()=>existsSync(out),5000);
    disk.free=1*GiB;
    await halt.confirm(t,"check waits for real halt confirmation with a controlled deadline");
    const observed=await checking;
    assert.deepEqual(observed,{exit:null,timed_out:false,stdout:'',skipped:'disk'});
    assert.ok((await guest.argv()).some(args=>args[0]==='stop'&&args[1]===handle.sandbox_id),'the check sandbox is halted');
  } finally {halt?.release();if(handle)backend?._closeDiskSentry?.(handle);await guest.cleanup();}
});

// Launch fence (store.mjs): the coordinator frees a held job at lease end + wall limit, so a run must end by its
// deadline even when nothing on the host is left to stop it.
test('a guarded run whose host side is gone stops by itself at its deadline', {timeout:30000}, async () => {
  const guest=await localGuest();
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,'sleep 60');
    handle._deadline.endsAt=performance.now()+1000;
    let acked=false;
    const running=backend.start(handle,{onLaunchDurable:()=>{acked=true;},onExecutionStarted:()=>{}});
    running.catch(()=>{});
    const mkdir=async()=>existsSync(path.join(guest.dir,'argv.jsonl'))?(await guest.argv()).find(args=>args[0]==='exec'&&args.includes('mkdir')):null;
    await until(mkdir,5000);
    const ctl=(await mkdir()).at(-1);
    await until(()=>acked&&existsSync(path.join(ctl,'agent.pgid')),5000);
    const agent=Number(await readFile(path.join(ctl,'agent.pgid'),'utf8'));
    const alive=()=>{try{process.kill(-agent,0);return true;}catch{return false;}};
    // The host side is gone: the exec process and the guard die, nobody sends a stop.
    for (const pid of (await readFile(path.join(guest.dir,'pids'),'utf8')).split('\n').filter(Boolean))
      try{process.kill(-Number(pid),'SIGKILL');}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(alive(),true,'the agent outlives its guard');
    // Deadline 1 s + the guard stop window (2 s + 1 s + 2 s) = 6 s.
    await until(()=>!alive(),12000);
  } finally {await guest.cleanup();}
});

test('every guarded run carries the in-guest wall backstop', {timeout:30000}, async () => {
  const guest=await localGuest();
  try {
    const backend=new DockerSbxBackend({guardTimings:fastTimings});
    const handle=handleFor(guest,'true');
    handle._deadline.endsAt=performance.now()+600_000;
    await backend.start(handle,{onExecutionStarted:()=>{}});
    const run=(await guest.argv()).find(args=>args[0]==='exec'&&args.some(arg=>arg.includes('faravan-guard.mjs')&&arg.includes(' run ')));
    assert.match(run.at(-1),/e=\$\(\(\$\(date \+%s\)\+605\)\).*kill -KILL 0/);
  } finally {await guest.cleanup();}
});

test('backend accepts cleaned helpers and preserves exit 3', {timeout:30000}, async () => {
  for (const mode of ['child', 'nonzero']) {
    const guest = await localGuest();
    try {
      const backend = new DockerSbxBackend({guardTimings:fastTimings});
      const handle = handleFor(guest, fake('fake-agent-exit.mjs', mode));
      if (mode === 'child') {
        await backend.start(handle, {onExecutionStarted(){}});
        assert.equal(handle._lending.exit.leftover_terminated, true);
        assert.equal(handle._lending.exit.group_ceased, true);
        continue;
      }
      await assert.rejects(backend.start(handle, {onExecutionStarted(){}}), error => {
        assert.equal(error.code, 'agent_exit_nonzero');
        assert.equal(error.guardExit.agent_exit_code, 3);
        assert.equal(error.guardExit.group_ceased, true);
        assert.equal(error.guardExit.stop_imposed, false);
        assert.equal(error.guardExit.agent_signal, null);
        assert.match(error.message, new RegExp('exit ' + error.exitCode));
        assert.equal(error.exitCode, 3);
        assert.match(error.stdout, /READY/);
        return true;
      });
    } finally { await guest.cleanup(); }
  }
});


test('missing or mismatched start evidence stays a start failure; missing exit evidence stays a run failure', async () => {
  for (const mode of ['none','wrong-nonce','started']) {
    const guest = await localGuest();
    try {
      const backend = new DockerSbxBackend({guardTimings:fastTimings});
      const run = backend._runJobCommand.bind(backend);
      backend._runJobCommand = async (handle, args, onLog, options) => {
        if (!onLog) return run(handle, args, onLog, options);
        if (mode !== 'none') onLog({stream:'stderr', chunk:Buffer.from(JSON.stringify({type:'faravan.started', v:1,
          seq:1, at:new Date().toISOString(), nonce:mode === 'started' ? handle._lending.guard.config.nonce : 'f'.repeat(32)}) + '\n')});
        onLog({stream:'stderr', chunk:Buffer.from('Reading additional input from stdin...\n')});
        return {code:3,stdout:'',stderr:''};
      };
      await assert.rejects(backend.start(handleFor(guest, 'true'), {onExecutionStarted(){}}), error => {
        assert.equal(error.code, mode === 'started' ? 'agent_run_failed' : 'entrypoint_start_failed');
        assert.equal(error.exitCode, 3);
        assert.equal(error.guardExit, null);
        assert.match(error.message, /exit 3/);
        assert.match(error.stderr, /Reading additional input/);
        return true;
      });
    } finally { await guest.cleanup(); }
  }
});
