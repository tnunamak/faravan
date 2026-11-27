import './helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const root = process.cwd(); // Run from the full repository checkout.
const cliFile = path.join(root, 'bin/faravan');
const hostFile = path.join(root, 'lib/v1/host.mjs');
const cliSource = fs.readFileSync(cliFile, 'utf8');
const hostSource = fs.readFileSync(hostFile, 'utf8');
const realRequire = createRequire(import.meta.url);
const HELD = 8787;
const FREE = 49160;

// Models the owner's explicit-port observation and the inspected XNU port:0
// rule. It is deliberately not a model of every kernel/socket configuration.
function fakeNet(platform, occupiedHost = '127.0.0.1') {
  const active = new Set();
  const calls = [];
  return {
    active,
    calls,
    createServer() {
      const server = new EventEmitter();
      let bound;
      server.listen = (options, ready) => {
        const { host, port } = options;
        calls.push({ host, port });
        queueMicrotask(() => {
          const conflicts = port === HELD
            && (host === occupiedHost
              || (platform === 'linux' && host === '0.0.0.0'));
          if (conflicts) {
            server.emit('error', Object.assign(new Error('occupied'), {
              code: 'EADDRINUSE',
            }));
            return;
          }
          // Implicit allocation excludes the occupied port on both models.
          bound = { address: host, family: 'IPv4', port: port === 0 ? FREE : port };
          active.add(server);
          ready();
        });
        return server;
      };
      server.address = () => bound;
      server.close = done => {
        active.delete(server);
        queueMicrotask(() => done?.());
        return server;
      };
      return server;
    },
  };
}

// Execute the real CLI helper definitions without invoking main/telemetry.
// Their current absence from module.exports (bin/faravan:650) does not
// require a production export added solely for this regression.
function loadActualCliProbes(net, platform) {
  const mod = { exports: {} };
  const fakeRequire = id => {
    if (id === 'node:net') return net;
    assert.ok(id.startsWith('node:'), 'unexpected repository require: ' + id);
    return realRequire(id);
  };
  fakeRequire.main = null;
  const context = {
    require: fakeRequire,
    module: mod,
    exports: mod.exports,
    __dirname: path.dirname(cliFile),
    __filename: cliFile,
    process: { platform, env: {}, argv: [] },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    cliSource + '\nmodule.exports.portProbes = {localPortInUse, pickFreeLocalPort};',
    context,
    { filename: cliFile },
  );
  return mod.exports.portProbes;
}

function heldCoordinatorHarness(portInUse, {
  platform = 'darwin',
  bindHost = '127.0.0.1',
  owned = true,
} = {}) {
  const home = '/fixture/coordinator';
  const origin = 'http://192.0.2.44:' + HELD;
  const primary = {
    id: 'circle-1', name: 'Primary circle', origin,
    pinnedRootFingerprint: 'fixture-root',
    provisioningPath: '/fixture/primary.json',
  };
  const second = {
    ...primary, id: 'circle-2', name: 'Second circle',
    provisioningPath: '/fixture/second.json',
  };
  const config = {
    schema_version: 1, protocol_version: 1, port: HELD,
    circle_id: primary.id, circle_name: primary.name,
    root_fingerprint: primary.pinnedRootFingerprint,
    v1_origin: origin, reachability: { kind: 'lan', publicUrl: origin },
    circle_ids: [primary.id], host_wanted: true,
    status_path: home + '/status.json',
  };
  const paths = {
    home, config: home + '/config.json',
    status: config.status_path, data: home + '/data',
  };
  const previous = {
    protocol_version: 1, status: 'listening', port: HELD, host: bindHost,
    pid: 4242, owner: { fixture: true },
    public_url: origin, circles_router: true,
  };
  const calls = [];
  class FaravanHostError extends Error {}
  const forbidden = label => () => {
    throw new Error('unexpected ' + label + ': coordinator must be reused');
  };
  const device = {
    selectCircle(id) {
      assert.equal(id, primary.id);
      return primary;
    },
    async createCircle(actualOrigin, options) {
      assert.equal(actualOrigin, origin);
      assert.equal(options.name, second.name);
      assert.equal(options.publish, false);
      assert.equal(options.reuse, false);
      calls.push('create-second-circle');
      return second;
    },
    async publishRoster(id) {
      assert.equal(id, second.id);
      calls.push('publish');
    },
    async createInviteLinks(id) {
      assert.equal(id, second.id);
      calls.push('invite');
      return { short: 'fixture-invite' };
    },
  };
  const globals = {
    path, process: { platform }, FaravanHostError,
    OWNER_LOCK_WAIT_MS: 1, RESUME_LOCK_WAIT_MS: 10000,
    ensureDurableDirectory() {},
    async acquireProcessLock() {
      calls.push('host-lock');
      return () => calls.push('release-host-lock');
    },
    ensureV1HostState: () => ({ config, paths }),
    coordinatorStatus: () => ({ status: previous, locked: true }),
    coordinatorBindHost: () => bindHost,
    coordinatorHosting: () => ({read: () => null}),
    legacyLoopbackOrigin: () => null,
    externalHostOrigin: forbidden('legacy origin lookup'),
    resolveLanUrl({port}) {
      assert.equal(port, HELD);
      return origin;
    },
    save: (_paths, next) => next,
    fail: message => { throw new FaravanHostError(message); },
    fs: { unlinkSync: forbidden('status removal') },
  };
  const start = hostSource.indexOf('export async function hostV1(');
  assert.notEqual(start, -1, 'hostV1 declaration must exist');
  const end = hostSource.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'hostV1 closing brace must exist');
  const declaration = hostSource.slice(start, end + 2).replace(/^export /, '');
  const hostV1 = vm.runInNewContext(
    declaration + '\nhostV1', globals, { filename: hostFile },
  );
  const seams = {
    platform, portInUse,
    openDevice: async () => device,
    processExists(status) {
      assert.equal(status, previous);
      calls.push('verify-process');
      return owned;
    },
    async provision({ circle, additional }) {
      assert.equal(circle.id, second.id);
      assert.equal(additional, true);
      calls.push('provision');
    },
    freePort: forbidden('free-port allocation'),
    chooseReachability: forbidden('reachability selection'),
    startServer: forbidden('coordinator launch'),
    stopServer: forbidden('coordinator stop'),
    waitReady: forbidden('readiness wait'),
  };
  return {
    calls,
    run: () => hostV1({
      home, base: '/fixture', name: second.name, newCircle: true,
    }, seams),
  };
}

function assertReused(result, calls) {
  assert.equal(result.status, 'ready');
  assert.equal(result.circle.id, 'circle-2');
  assert.equal(result.process, null);
  assert.equal(result.invite, 'fixture-invite');
  assert.deepEqual(calls, [
    'host-lock', 'verify-process', 'create-second-circle', 'provision',
    'publish', 'invite', 'release-host-lock',
  ]);
}

for (const platform of ['darwin', 'linux']) {
  test(platform + ': existing loopback coordinator is occupied', async () => {
    const net = fakeNet(platform);
    const probes = loadActualCliProbes(net, platform);
    assert.equal(await probes.localPortInUse(HELD), true);
    assert.equal(net.active.size, 0);
  });

  test(platform + ': unoccupied endpoint stays free', async () => {
    const net = fakeNet(platform);
    const probes = loadActualCliProbes(net, platform);
    assert.equal(await probes.localPortInUse(FREE), false);
    assert.equal(net.active.size, 0);
  });

  test(platform + ': port-zero allocation excludes held port', async () => {
    const net = fakeNet(platform);
    const probes = loadActualCliProbes(net, platform);
    assert.equal(await probes.pickFreeLocalPort(), FREE);
    assert.notEqual(FREE, HELD);
    assert.equal(net.active.size, 0);
  });

  test(platform + ': new circle reuses held ready coordinator', async () => {
    const net = fakeNet(platform);
    const probes = loadActualCliProbes(net, platform);
    const harness = heldCoordinatorHarness(probes.localPortInUse, { platform });
    const result = await harness.run();
    assertReused(result, harness.calls);
    assert.equal(net.active.size, 0);
  });
}

test('darwin: startup forwards the actual non-loopback bind address', async () => {
  const bindHost = '192.0.2.44'; // A fake address; no real socket is opened.
  const net = fakeNet('darwin', bindHost);
  const probes = loadActualCliProbes(net, 'darwin');
  const harness = heldCoordinatorHarness(probes.localPortInUse, { bindHost });
  const result = await harness.run();
  assertReused(result, harness.calls);
  assert.equal(net.calls[0].host, bindHost);
  assert.equal(net.active.size, 0);
});

test('darwin: an unrelated wildcard listener is never reused as a coordinator', async () => {
  const bindHost = '0.0.0.0';
  const net = fakeNet('darwin', bindHost);
  const probes = loadActualCliProbes(net, 'darwin');
  const harness = heldCoordinatorHarness(probes.localPortInUse, {bindHost, owned:false});
  await assert.rejects(harness.run(), /port 8787 is already in use/);
  assert.deepEqual(harness.calls, ['host-lock', 'verify-process', 'release-host-lock']);
  assert.equal(net.active.size, 0);
});

function loadActualStopCallback(portInUse, bindHost) {
  const start = cliSource.indexOf('    stopServer:async ');
  assert.notEqual(start, -1, 'CLI stopServer callback must exist');
  const end = cliSource.indexOf('    startServer:async ', start);
  assert.notEqual(end, -1, 'CLI stopServer callback boundary must exist');
  const entry = cliSource.slice(start, end);
  return vm.runInNewContext(
    '({' + entry + '}).stopServer',
    {
      path,
      os: { homedir: () => '/fixture' },
      home: '/fixture/.local/share/Faravan/coordinator',
      installedDefaultHome: '/fixture/.local/share/Faravan/coordinator',
      coordinatorServiceInstalled: () => true,
      runCommand: async () => ({ code: 0 }),
      coordinatorBindHost: () => bindHost,
      localPortInUse: portInUse,
      // Advance polling without sleeping or opening real sockets.
      setTimeout: done => { queueMicrotask(done); return 0; },
      fail: message => { throw new Error(message); },
    },
    { filename: cliFile },
  );
}

for (const bindHost of ['127.0.0.1', '192.0.2.44']) {
  test('darwin: shutdown poll still sees listener at ' + bindHost, async () => {
    const net = fakeNet('darwin', bindHost);
    const probes = loadActualCliProbes(net, 'darwin');
    const stop = loadActualStopCallback(probes.localPortInUse, bindHost);
    // Simulate a successful service-stop command whose listener remains alive.
    await assert.rejects(
      stop({ port: HELD, reachability: { kind: 'url' } }, { host: bindHost }),
      /the previous host did not stop/,
    );
    assert.equal(net.active.size, 0);
  });
}


test('a listener on [::1] only counts as a held port', async () => {
  const net = fakeNet('darwin', '::1');
  const { localPortInUse } = loadActualCliProbes(net, 'darwin');
  assert.equal(await localPortInUse(HELD), true);
  assert.equal(await localPortInUse(FREE), false);
});

test('a host without IPv6 does not call the port held', async () => {
  const net = fakeNet('darwin');
  const create = net.createServer;
  net.createServer = () => {
    const server = create();
    const listen = server.listen;
    server.listen = (options, ready) => {
      if (options.host !== '::1') return listen(options, ready);
      queueMicrotask(() => server.emit('error', Object.assign(new Error('no v6'), { code: 'EADDRNOTAVAIL' })));
      return server;
    };
    return server;
  };
  const { localPortInUse } = loadActualCliProbes(net, 'darwin');
  assert.equal(await localPortInUse(FREE), false);
});

test('a picked free port is checked on every probed address', async () => {
  const net = fakeNet('darwin');
  const { pickFreeLocalPort } = loadActualCliProbes(net, 'darwin');
  assert.equal(await pickFreeLocalPort(), FREE);
  assert.ok(net.calls.some(c => c.host === '::1' && c.port === FREE));
});
