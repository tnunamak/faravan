// Hermetic harness for the multi-circle browser spec: ONE genuine faravan-coordinator child
// serving every circle on one port with its own verified process owner, an owner app that hosts them,
// and one member app. No provider, Docker or friend service is touched; all keys are created here.
// Every HTTP listener uses loopback. Prints synthetic fixture URLs/keys, never real local credentials.
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,syntheticBackend,bounded,boundedFetch} from '../helpers/v1-app-fixture.mjs';
import {hostV1,ensureV1HostState,coordinatorLaunchEnv} from '../../lib/v1/host.mjs';
import {openDevice} from '../../lib/v1/device.mjs';
import {coordinatorOwnerAlive} from '../../lib/v1/coordinator-owner.mjs';
import {readCoordinatorStatus} from '../../lib/host.mjs';
const lanAddress='127.0.0.1';

const holdAppStart = process.argv.includes('--hold-app-start') && !!process.send;
let coordinatorPid, verifiedCoordinatorPid;
const cleanups = [];
const startupAbort = new AbortController();
let stopping = false, cleanupPromise, stopCoordinator;
function assertStarting() {
  if (stopping) throw new Error('circle fixture stopped during startup');
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    const errors = [];
    for (const fn of cleanups.reverse()) { try { await fn(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'circle fixture cleanup failed');
  })();
}
async function main() {
// This harness owns signal shutdown: its root must outlive the child and apps.
const f = await appFixture({after: fn => cleanups.push(fn)}, {managedShutdown: true});
const ownerHome = await f.home('owner');
const coordinatorHome = join(f.root, 'coordinator');
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, lanAddress, () => { const {port} = probe.address(); probe.close(() => resolve(port)); });
});

const seams = {
  portInUse: async () => false,
  freePort: async () => { throw new Error('unexpected port change'); },
  chooseReachability: async () => { throw new Error('reachability must come from --tunnel lan'); },
  openDevice: options => openDevice({...options, home: ownerHome}),
  startServer: async (config, paths) => {
    assertStarting();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(FARAVAN_|FARAVAN_)/.test(name) && name !== 'NODE_OPTIONS'));
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../../bin/faravan-coordinator', import.meta.url)),
      '--host-config', paths.config,
    ], {stdio: ['ignore', 'ignore', 'pipe'], env: coordinatorLaunchEnv({
      ...env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'config'),
    }, {fenced: false, stopGeneration: config.stop_generation})});
    coordinatorPid = child.pid;
    let ended = false, launchError;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    const exited = new Promise(resolve => {
      child.on('error', error => { launchError = error; });
      child.once('exit', () => { ended = true; });
      // close follows exit AND drained stdio, including final ownership-release errors.
      child.once('close', (code, signal) => {
        ended = true;
        const result = {code, signal, stderr};
        if (holdAppStart) process.send({event: 'coordinator-exited', pid: child.pid, ...result});
        resolve(result);
      });
    });
    let stopPromise;
    const stop = () => stopPromise ??= (async () => {
      let timer;
      if (!ended) {
        // Signal only this ChildProcess, never a status-file PID or process group.
        child.kill('SIGTERM');
        timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 5000);
      }
      let result;
      try { result = await exited; } finally { clearTimeout(timer); }
      if (launchError || result.code !== 0 || result.signal !== null ||
          /ENOENT|Error|owner.marker|close failed/i.test(result.stderr)) {
        throw new Error('fixture coordinator did not close cleanly: ' +
          JSON.stringify({...result, launchError: launchError?.message}));
      }
    })();
    stopCoordinator = stop;
    cleanups.push(stop); // registered before waiting for any startup evidence
    return {child, stop, assertRunning() {
      if (launchError) throw launchError;
      if (ended) throw new Error('fixture coordinator exited before readiness');
    }};
  },
  waitReady: async (config, started) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (stopping) throw new Error('circle fixture stopped during startup');
      started.assertRunning();
      const status = await readCoordinatorStatus(config);
      if (status?.status === 'listening' && status.pid === started.child.pid &&
          status.protocol_version === 1 && status.public_url === config.v1_origin &&
          coordinatorOwnerAlive(status, paths.config)) {
        verifiedCoordinatorPid = status.pid;
        return status;
      }
      await delay(50);
    }
    throw new Error('fixture coordinator did not publish verified listening status');
  },
};
const {config,paths}=ensureV1HostState({home:coordinatorHome,port,name:'Weekend projects'});
await writeFile(paths.config,JSON.stringify({...config,keep_awake:false,reachability:{kind:'url',publicUrl:'http://127.0.0.1:'+port}}));
assertStarting();
const first = await hostV1({home: coordinatorHome, name: 'Weekend projects', port}, seams);

// All fixture traffic is loopback. Preserve app cancellation as well as the
// timeout: replacing its signal can strand a refresh while close awaits it.
function readyBackend(){const backend=syntheticBackend(f.root,{});backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});return backend;}
const appOptions = {fetch: boundedFetch,
  coordinatorHome, pollMs: 250, approvalPollMs: 1500, hostProfileMs: 1000};
// Only the regression child opts into this callable startup seam, over its private IPC channel.
async function startApp(name, options) {
  assertStarting();
  if (holdAppStart && name === 'owner') {
    await new Promise(resolve => {
      const finish = () => {
        process.off('message', release);
        startupAbort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const release = message => {
        if (message?.event === 'release-app-start') finish();
      };
      process.on('message', release);
      startupAbort.signal.addEventListener('abort', finish, {once: true});
      if (startupAbort.signal.aborted) finish();
      else process.send({event: 'app-start-held', coordinatorPid, verifiedCoordinatorPid, root: f.root});
    });
  }
  assertStarting();
  return f.start(name, options);
}
const owner = await startApp('owner', {...appOptions, backend:readyBackend(), autoApprove: true, joinWaitMs: 0});
const other = await startApp('other', {...appOptions, backend:readyBackend(), joinWaitMs: 0});
const member = await startApp('member', {...appOptions, backend:readyBackend(), joinWaitMs: 0});
// Private fixture lifecycle control: await the actual app shutdown before a
// manual legacy heartbeat, so its modern background writer cannot race the test.
let memberClose;
process.on('message', message => {
  if (message?.event !== 'stop-member-app' || !process.send) return;
  memberClose ??= (async () => {
    // Start the real shutdown first, then drain only this fixture's listener.
    // Open browser streams must not keep an owned app connection alive while
    // shutdown waits for its pending work. Neither coordinator is stopped here.
    const closing = member.app.close();
    member.app.server.closeAllConnections?.();
    try {
      await bounded(closing, 'member app shutdown');
    } finally {
      member.app.server.closeAllConnections?.();
    }
  })();
  memberClose.then(
    () => process.send?.({event:'member-app-stopped'}),
    () => process.send?.({event:'member-app-stop-failed'}),
  );
});

assertStarting();
console.log(JSON.stringify({
  owner: owner.app.origin, member: member.app.origin, other:other.app.origin,
  origin: first.origin, circle: first.circle.id, invite: first.invite, root: f.root, coordinatorHome,
  tokens: {owner: owner.app.token, member: member.app.token, other:other.app.token},
}));

}

const startup = main();
async function stop() {
  if (stopping) return;
  stopping = true;
  // Unblock only our private startup hold; assertStarting prevents any app launch.
  startupAbort.abort();
  // Start reaping the real coordinator now, even if an app startup is still pending.
  // cleanup() awaits this same idempotent promise and reports any failure.
  void stopCoordinator?.().catch(() => {});
  try { await startup; } catch { /* startup failure still requires cleanup */ }
  try { await cleanup(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
startup.catch(async error => {
  if (stopping) return; // stop() owns awaited cleanup after interrupted startup
  console.error(error);
  try { await cleanup(); } catch (cleanupError) { console.error(cleanupError); }
  process.exit(1);
});
