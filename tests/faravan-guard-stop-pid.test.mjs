import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../lib/faravan-guard.mjs', import.meta.url));
const stop = ctl => spawnSync(process.execPath, [guard, 'stop', 'owner', '--ctl', ctl],
  { encoding: 'utf8', env: process.env, timeout: 5000 });

async function inspectOwnerStop(child, ctl, {
  signal = name => process.kill(child.pid, name),
  readState = async () => {
    const stat = await readFile('/proc/' + child.pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  },
  sendStop = () => stop(ctl),
  readRequest = () => readFile(join(ctl, 'stop-request'), 'utf8'),
  abort,
} = {}) {
  // Stop verifies /proc argv and kill(pid, 0), both valid for a stopped guard.
  // Wait for the kernel acknowledgement, not for an assumed scheduling delay.
  signal('SIGSTOP');
  try {
    while (await readState() !== 'T') abort?.throwIfAborted();
    abort?.throwIfAborted();
    const result = sendStop();
    assert.equal(result.status, 0, result.stderr);
    const request = await readRequest();
    assert.equal(request, 'owner');
    return { result, request };
  } finally {
    // Also resume after failed assertions, so the caller's cleanup can drain it.
    signal('SIGCONT');
  }
}

async function withCtl(fn) {
  const ctl = await mkdtemp(join(tmpdir(), 'faravan-stop-pid-'));
  try { await fn(ctl); } finally { await rm(ctl, { recursive: true, force: true }); }
}

function rejected(result, ctl) {
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /not running|not a guard|cannot verify|invalid guard PID/);
  assert.equal(existsSync(join(ctl, 'stop-request')), false);
  assert.equal(existsSync(join(ctl, 'stop-request.tmp')), false);
}

test('stale guard.pid pointing at a live non-guard process must not accept Stop', async () => {
  await withCtl(async ctl => {
    // This test runner is definitely live, but is not a guard. No unrelated process is signalled.
    await writeFile(join(ctl, 'guard.pid'), String(process.pid));
    rejected(stop(ctl), ctl);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  });
});

test('a guard name in unrelated node argv is not a guard script invocation', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'faravan-guard.mjs', 'run'],
    { stdio: 'ignore', env: process.env });
  const done = once(child, 'close');
  try {
    await once(child, 'spawn');
    await withCtl(async ctl => {
      await writeFile(join(ctl, 'guard.pid'), String(child.pid));
      rejected(stop(ctl), ctl);
      assert.doesNotThrow(() => process.kill(child.pid, 0));
    });
  } finally { child.kill('SIGKILL'); await done; }
});

test('guard PID must be a complete positive integer, never a process group or numeric prefix', async () => {
  for (const value of ['0', '-1', String(process.pid) + 'junk', String(process.pid) + '\n123']) {
    await withCtl(async ctl => {
      await writeFile(join(ctl, 'guard.pid'), value);
      rejected(stop(ctl), ctl);
    });
  }
});

test('missing PID fails closed without a stop request', async () => {
  await withCtl(async ctl => rejected(stop(ctl), ctl));
});

test('real guard invocation still accepts owner Stop on Linux; other platforms fail closed', { timeout: 10000 }, async t => {
  await withCtl(async ctl => {
    const home = join(ctl, 'home'); await mkdir(home);
    const config = { v: 1, mode: 'claude', ctl, nonce: 'n'.repeat(32), heartbeat_ms: 20,
      soft_deadline_s: 3, sigint_grace_ms: 50, sigterm_grace_ms: 50 };
    const child = spawn(process.execPath, [guard, 'run', '--config', Buffer.from(JSON.stringify(config)).toString('base64'),
      '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') } });
    const done = once(child, 'close');
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(ctl, 'guard.pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(existsSync(join(ctl, 'guard.pid')), true);
      if (process.platform === 'linux') {
        // The guard removes stop-request when it consumes it. Hold that consumer
        // while retaining the exact request-content assertion, then let it stop.
        await inspectOwnerStop(child, ctl, { abort: t.signal });
        const [code] = await done;
        assert.equal(code, 0);
        assert.equal(JSON.parse(await readFile(join(ctl, 'stop.json'), 'utf8')).stop_reason, 'owner');
      } else {
        const result = stop(ctl);
        rejected(result, ctl);
        assert.match(result.stderr, /cannot verify.*platform/);
        await done;
      }
    } finally {
      // Only terminate the process group that this synthetic guard created.
      try { const pid = Number(await readFile(join(ctl, 'agent.pgid'), 'utf8')); if (Number.isSafeInteger(pid) && pid > 1) process.kill(-pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null) child.kill('SIGKILL');
      await done;
    }
  });
});

test('owner Stop inspection gates consumption until the request assertion completes', async () => {
  let paused = false, acknowledged = false, request = null, reads = 0;
  const signals = [];
  const sendStop = () => { request = 'owner'; return { status: 0, stderr: '' }; };
  const readRequest = async () => {
    // Deterministic slow-parent schedule: the consumer runs before this read.
    // The real guard consumes by readFileSync + rmSync in its interval callback.
    if (!paused) request = null;
    if (request === null) throw Object.assign(new Error('consumed'), { code: 'ENOENT' });
    assert.equal(acknowledged, true, 'kernel stop must be acknowledged before inspection');
    return request;
  };
  sendStop();
  await assert.rejects(readRequest(), { code: 'ENOENT' }, 'base Stop-then-read ordering races consumption');
  const result = await inspectOwnerStop({ pid: 123 }, '/unused', {
    signal: name => {
      signals.push(name);
      if (name === 'SIGSTOP') paused = true;
      if (name === 'SIGCONT') { paused = false; request = null; }
    },
    readState: async () => {
      reads += 1;
      acknowledged = reads > 1;
      return acknowledged ? 'T' : 'R';
    },
    sendStop: () => {
      assert.equal(acknowledged, true, 'do not publish before the stop acknowledgement');
      return sendStop();
    },
    readRequest,
  });
  assert.equal(result.result.status, 0);
  assert.equal(result.request, 'owner');
  assert.equal(reads, 2);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
  assert.equal(paused, false);
  assert.equal(request, null, 'consumer can proceed after the assertion');

  const failureSignals = [];
  await assert.rejects(inspectOwnerStop({ pid: 123 }, '/unused', {
    signal: name => failureSignals.push(name),
    readState: async () => 'T',
    sendStop,
    readRequest: async () => { throw new Error('read failed'); },
  }), /read failed/);
  assert.deepEqual(failureSignals, ['SIGSTOP', 'SIGCONT'], 'read failure must not leave the guard stopped');
});
