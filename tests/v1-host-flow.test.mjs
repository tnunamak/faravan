import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, parseOne } from './helpers/v1-journey.mjs';
import { ensureV1HostState } from '../lib/v1/host.mjs';

const bin = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

test('host command on loopback creates a circle, prints an invite, approves a member and queues its job', {timeout:45000}, async t => {
  // Reuse the isolated homes and bounded real CLI processes, but not the fixture's
  // synthetic coordinator: every journey request must reach the host's server.
  const cleanup = [];
  const f = await fixture({after: fn => cleanup.push(fn)});
  let host, closed, stdout = '', stderr = '';
  const signalHost = signal => {
    if (!host?.pid || host.exitCode !== null || host.signalCode !== null) return;
    try {
      if (process.platform === 'win32') host.kill(signal);
      else process.kill(-host.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  t.after(async () => {
    try {
      if (host) {
        signalHost('SIGTERM');
        try { await bounded(closed, 'host and coordinator shutdown'); }
        catch (error) {
          signalHost('SIGKILL');
          await bounded(closed, 'forced host and coordinator shutdown');
          throw error;
        }
      }
    } finally {
      for (const fn of cleanup.reverse()) await fn();
    }
  });

  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const origin = 'http://127.0.0.1:' + port;
  const coordinatorHome = join(f.root, 'coordinator');
  const {paths, config} = ensureV1HostState({home:coordinatorHome, port, name:'Host journey'});
  // --tunnel lan discovers a real NIC and --tunnel url requires HTTPS. The host
  // also supports persisted reachability, so seed only that loopback address.
  // Circle creation, provisioning, startup, publication and inviting remain real.
  await writeFile(paths.config, JSON.stringify({...config, reachability:{kind:'url', publicUrl:origin}}), {mode:0o600});
  assert.equal(config.circle_id, undefined);

  // Inherited by the host's coordinator as well as every member/owner CLI.
  // Stop probes the coordinator port on each local interface to detect an
  // orphaned listener. Permit those exact probes while fencing all other traffic.
  const localAddresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).map(({address}) => /^fe80:/i.test(address) ? address + '%' + name : address));
  const guard = join(f.root, 'local-fixture-only.cjs');
  await writeFile(guard, `
const net = require('node:net');
const connect = net.Socket.prototype.connect;
const localAddresses = new Set(${JSON.stringify(localAddresses)});
const coordinatorPort = ${port};
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  if (typeof values[0] !== 'number' && (typeof values[0] !== 'object' || values[0] === null))
    throw new Error('Host journey requires a TCP address');
  const options = typeof values[0] === 'object' ? values[0] :
    {port: values[0], host: typeof values[1] === 'string' ? values[1] : 'localhost'};
  const host = options.host ?? 'localhost';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const localStopProbe = options.port === coordinatorPort && localAddresses.has(host);
  if (options.path || (!loopback && !localStopProbe))
    throw new Error('Host journey forbids connections outside its local fixtures');
  return connect.apply(this, args);
};
`);
  const env = f.env;
  f.env = async name => ({...await env(name), FARAVAN_COORDINATOR_HOME:coordinatorHome,
    FARAVAN_NO_BROWSER:'1', NODE_OPTIONS:(process.env.NODE_OPTIONS ?? '') + ' --require ' + JSON.stringify(guard)});
  host = spawn(process.execPath, [bin, 'host', '--port', String(port), '--collective-name', 'Host journey', '--json'],
    {env:await f.env('owner'), detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe']});
  closed = new Promise((resolve, reject) => {
    host.once('error', reject);
    host.once('close', (code, signal) => resolve({code, signal}));
  });
  // Attach immediately so a failed spawn cannot create an unhandled rejection.
  closed.catch(() => {});
  host.stdout.on('data', chunk => { stdout += chunk; });
  host.stderr.on('data', chunk => { stderr += chunk; });
  const ready = await bounded((async () => {
    while (!stdout.includes('\n')) {
      assert.equal(host.exitCode, null, 'host exited before readiness: ' + stderr);
      assert.equal(host.signalCode, null, 'host was interrupted before readiness: ' + stderr);
      await pause(20);
    }
    return JSON.parse(stdout.split('\n')[0]);
  })(), 'host ready output', 15000);
  assert.equal(ready.type, 'host_ready');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.coordinator_url, origin);
  assert.equal(ready.local_port, port);
  assert.equal(ready.lan_mode, false, 'this is the supported persisted loopback mode, not a live LAN test');
  assert.equal(new URL(ready.invite).origin, origin);
  assert.match(new URL(ready.invite).pathname, /^\/i\/[a-z2-7]{10}$/);
  assert.match(new URL(ready.invite).hash, /^#[A-Za-z0-9_-]{43}$/);
  assert.notEqual(origin, f.origin);

  // G08: only the normal host command may recover the coordinator. No API call
  // or second host invocation is made between death and the replacement record.
  const firstStatus=JSON.parse(await readFile(config.status_path,'utf8'));
  process.kill(firstStatus.pid,'SIGKILL');
  await bounded((async()=>{
    for(;;){
      const current=JSON.parse(await readFile(config.status_path,'utf8'));
      if(current.pid!==firstStatus.pid&&['listening','public_listening'].includes(current.status))return;
      await pause(20);
    }
  })(),'automatic coordinator replacement',10000);

  const circle = ready.circle_id;
  const ownerState = JSON.parse(await readFile(join(await f.home('owner'), 'v1', 'state.json'), 'utf8'));
  assert.equal(ownerState.circles.find(item => item.id === circle)?.owned, true);
  const joined = parseOne(await f.cli(['circle', 'join', ready.invite, '--name', 'Host guest', '--json'], 'guest'));
  assert.equal(joined.id, circle);
  assert.equal(joined.owned, false);
  assert.equal(joined.enrollment.state, 'pending');
  const submit = ['job', 'submit', '--yes', '--git', 'https://example.test/synthetic.git@' + 'a'.repeat(40),
    '--prompt', 'Hermetic host journey; queue only', '--circle', circle, '--json'];
  const premature = await f.cli(submit, 'guest');
  assert.notEqual(premature.code, 0, 'joining alone must not grant submission rights');
  assert.equal(JSON.parse(premature.stdout).code, 'enrollment_pending');
  assert.deepEqual(parseOne(await f.cli(['job', 'list', '--circle', circle, '--json'])), []);

  const approval = parseOne(await f.cli(['circle', 'approve', '--circle', circle, '--json']));
  assert.deepEqual(approval.approved, [joined.enrollment.device_key_id]);
  assert.deepEqual(approval.rejected, []);
  assert.equal(approval.roster.payload.epoch, 2);
  assert.equal(approval.roster.payload.members.length, 2);
  assert.equal(approval.approvedDevices[0].device_name, 'Host guest');

  const submitted = parseOne(await f.cli(submit, 'guest'));
  assert.match(submitted.jobDigest, /^sha256:[0-9a-f]{64}$/);
  const queued = parseOne(await f.cli(['job', 'list', '--circle', circle, '--json']));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].job_digest, submitted.jobDigest);
  assert.equal(queued[0].state, 'queued');
  assert.equal(queued[0].attempts_started, 0);
  assert.equal(queued[0].current_attempt, null, 'no lender, Docker or agent runs');
  const status = parseOne(await f.cli(['job', 'status', submitted.jobDigest, '--circle', circle, '--json'], 'guest'));
  assert.equal(status.status, 'Waiting');
  assert.equal(status.state, 'queued');
  assert.equal(f.rawRequests.length, 0, 'the synthetic fixture coordinator was never used');

  // A separate stop command must retire the original supervisor as well as its
  // current child, otherwise the stopped circle comes back after the backoff.
  const stopped = parseOne(await f.cli(['host', '--stop', '--json']));
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(await bounded(closed, 'explicit host stop retires supervision', 3500), {code:0, signal:null});
  await assert.rejects(fetch(origin + '/v1/health', {signal:AbortSignal.timeout(1000)}));
});
