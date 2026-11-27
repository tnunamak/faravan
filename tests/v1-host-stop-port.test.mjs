import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stopV1Host} from '../lib/v1/host.mjs';
import {captureCoordinatorOwner} from '../lib/v1/coordinator-owner.mjs';
import {portAnswers, portListeners} from '../lib/v1/port-listeners.mjs';

// The stop is proven at the circle's port. Bug: the app said "stopped" while an older host process kept serving the circle.
const entry = fileURLToPath(new URL('../bin/faravan-coordinator', import.meta.url));
async function hostHome(t, {statusPid = null, wanted = true} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'spk-host-port-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const config = join(home, 'host.json'), status = join(home, 'status.json');
  await writeFile(config, JSON.stringify({schema_version: 1, protocol_version: 1, port: 8787, status_path: status, host_wanted: wanted}));
  const identityOptions = {platform: 'linux', readlink: file => file.endsWith('/exe') ? process.execPath : 'pid:[test]',
    readFile: file => file.endsWith('/cmdline') ? ['node', entry, '--host-config', config].join('\0') + '\0'
      : file.endsWith('/boot_id') ? 'test-boot' : '424242 (node) ' + ['S', ...Array(18).fill('0'), '42'].join(' ')};
  if (statusPid) await writeFile(status, JSON.stringify({protocol_version: 1, pid: statusPid, status: 'listening', owner: captureCoordinatorOwner(statusPid, config, identityOptions)}));
  return {home, config, identityOptions};
}

test('stop does not report stopped while another program still serves the circle port, and names it', async t => {
  const {home, config} = await hostHome(t);
  const signals = [];
  await assert.rejects(stopV1Host({home}, {clearIntent: true, sleep: async () => {}, signal: (...args) => signals.push(args),
    portAnswers: async port => port === 8787, portListeners: async () => [{pid: 5150, command: '/Applications/Old Faravan.app/node faravan host --json'}]}),
  error => error.code === 'host_still_running' && /port 8787/.test(error.message) && /pid 5150 \(\/Applications\/Old Faravan\.app/.test(error.message)
    && /left running/.test(error.message) && error.running[0].pid === 5150);
  assert.deepEqual(signals, [], 'a process this install cannot verify is never signalled');
  assert.equal(JSON.parse(await readFile(config, 'utf8')).host_wanted, false, 'the owner\'s stop still ends the intent');
});

test('a listener verified as this home\'s coordinator is stopped even when the status file names nothing', async t => {
  const {home, identityOptions} = await hostHome(t);
  let answering = true;
  const signals = [];
  await stopV1Host({home}, {identityOptions, sleep: async () => {},
    signal: (pid, sig) => { signals.push([pid, sig]); answering = false; },
    portAnswers: async () => answering, portListeners: async () => answering ? [{pid: 424242, command: 'node faravan-coordinator'}] : []});
  assert.deepEqual(signals, [[424242, 'SIGTERM']]);
});

test('a verified listener that keeps answering after its signal is reported, not called stopped', async t => {
  const {home, identityOptions} = await hostHome(t);
  await assert.rejects(stopV1Host({home}, {identityOptions, sleep: async () => {}, signal: () => {},
    portAnswers: async () => true, portListeners: async () => [{pid: 424242, command: null}]}),
  error => error.code === 'host_still_running' && /pid 424242\./.test(error.message));
});

test('an unnamed listener still blocks "stopped"', async t => {
  const {home} = await hostHome(t);
  await assert.rejects(stopV1Host({home}, {sleep: async () => {}, portAnswers: async () => true, portListeners: async () => { throw new Error('no lsof'); }}),
    error => error.code === 'host_still_running' && /could not tell which program/.test(error.message));
});

test('a free port after the stop reads as stopped and clears the intent', async t => {
  const {home, config} = await hostHome(t);
  await stopV1Host({home}, {clearIntent: true, sleep: async () => {}, portAnswers: async () => false});
  assert.equal(JSON.parse(await readFile(config, 'utf8')).host_wanted, false);
});

test('a stop that is not the owner\'s (an update) keeps the intent', async t => {
  const {home, config} = await hostHome(t);
  await stopV1Host({home}, {sleep: async () => {}, portAnswers: async () => false});
  assert.equal(JSON.parse(await readFile(config, 'utf8')).host_wanted, true);
});

test('listeners are read from lsof, and from ss on Linux without lsof', async () => {
  const calls = [];
  const fake = outputs => (command, args, _options, done) => { calls.push(command); const out = outputs[command]; out instanceof Error ? done(out, '') : done(null, out); };
  assert.deepEqual(await portListeners(8787, {platform: 'darwin', execFile: fake({lsof: 'p5150\nfnode\np5150\n', ps: '/usr/bin/node host\n'})}),
    [{pid: 5150, command: '/usr/bin/node host'}]);
  assert.deepEqual(await portListeners(8787, {platform: 'linux', execFile: fake({lsof: Object.assign(new Error('missing'), {code: 'ENOENT'}),
    ss: 'LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("node",pid=77,fd=21))\n', ps: Object.assign(new Error('gone'), {code: 1})})}),
  [{pid: 77, command: null}]);
  assert.deepEqual(await portListeners(8787, {platform: 'win32', execFile: () => assert.fail('not run')}), []);
});

test('faravan host --stop --json returns a named refusal while the circle port still answers', async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await portAnswers(port), true);
  const home = await mkdtemp(join(tmpdir(), 'spk-host-port-cli-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await writeFile(join(home, 'host.json'), JSON.stringify({schema_version: 1, protocol_version: 1, port, status_path: join(home, 'status.json'), host_wanted: true}));
  const result = await new Promise(resolve => execFile(process.execPath, [fileURLToPath(new URL('../bin/faravan', import.meta.url)), 'host', '--stop', '--json'], {
    env: {...process.env, FARAVAN_COORDINATOR_HOME: home, FARAVAN_HOME: join(home, 'app')}, encoding: 'utf8', timeout: 30000},
  (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
  const line = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(line.type, 'host_error', result.stdout + result.stderr);
  assert.equal(line.code, 'host_still_running');
  assert.match(line.message, new RegExp('port ' + port));
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /host_stopped/);
  server.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const freed = await new Promise(resolve => execFile(process.execPath, [fileURLToPath(new URL('../bin/faravan', import.meta.url)), 'host', '--stop', '--json'], {
    env: {...process.env, FARAVAN_COORDINATOR_HOME: home, FARAVAN_HOME: join(home, 'app')}, encoding: 'utf8', timeout: 30000},
  (error, stdout) => resolve({code: error?.code ?? 0, stdout})));
  assert.equal(JSON.parse(freed.stdout.trim().split('\n').at(-1)).type, 'host_stopped');
  assert.equal(JSON.parse(await readFile(join(home, 'host.json'), 'utf8')).host_wanted, false);
});

// Bug: the stop probed only 127.0.0.1, so a coordinator bound to another address (::, FARAVAN_COORDINATOR_HOST, a LAN
// or tailnet address) read as stopped while it still served members.
async function listenOn(t, host, port = 0) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({host, port, ipv6Only: host === '::'}, resolve); });
  t.after(() => server.close());
  return server.address().port;
}
async function stalePortHome(t, port, extra = {}) {
  const {home, config, identityOptions} = await hostHome(t);
  await writeFile(config, JSON.stringify({...JSON.parse(await readFile(config, 'utf8')), port, ...extra}));
  // No status names the listener: only the port can show what still serves the circle.
  return {home, config, identityOptions};
}

test('a listener on the IPv6 wildcard only is found, though 127.0.0.1 refuses', async t => {
  const port = await listenOn(t, '::');
  assert.equal(await portAnswers(port, '127.0.0.1'), false);
  const {home} = await stalePortHome(t, port);
  const signals = [];
  await assert.rejects(stopV1Host({home}, {clearIntent: true, sleep: async () => {}, signal: (...args) => signals.push(args), portAnswers, portListeners: async () => []}),
    error => error.code === 'host_still_running' && new RegExp('port ' + port).test(error.message));
  assert.deepEqual(signals, []);
});

test('a coordinator bound to FARAVAN_COORDINATOR_HOST is probed there', async t => {
  const port = await listenOn(t, '127.0.0.2');
  const {home} = await stalePortHome(t, port);
  const saved = process.env.FARAVAN_COORDINATOR_HOST;
  process.env.FARAVAN_COORDINATOR_HOST = '127.0.0.2';
  t.after(() => { if (saved === undefined) delete process.env.FARAVAN_COORDINATOR_HOST; else process.env.FARAVAN_COORDINATOR_HOST = saved; });
  await assert.rejects(stopV1Host({home}, {sleep: async () => {}, portAnswers, portListeners: async () => [], networkInterfaces: () => ({})}),
    error => error.code === 'host_still_running');
});

test('a listener on an address no probe reaches is still found by listing the port, named, and never signalled', async t => {
  const port = await listenOn(t, '127.0.0.3');
  const {home} = await stalePortHome(t, port);
  const signals = [];
  await assert.rejects(stopV1Host({home}, {sleep: async () => {}, signal: (...args) => signals.push(args), portAnswers, portListeners, networkInterfaces: () => ({})}),
    error => error.code === 'host_still_running' && error.running.some(l => l.pid === process.pid) && error.message.includes('pid ' + process.pid));
  assert.deepEqual(signals, [], 'a program that is not this home\'s coordinator is never signalled');
});

test('this home\'s coordinator found only in the listener list is stopped, though no probed address answers', async t => {
  const {home, identityOptions} = await hostHome(t);
  let listening = true;
  const signals = [];
  await stopV1Host({home}, {identityOptions, sleep: async () => {}, signal: (pid, sig) => { signals.push([pid, sig]); listening = false; },
    portAnswers: async () => false, portListeners: async () => listening ? [{pid: 424242, command: 'node faravan-coordinator'}] : []});
  assert.deepEqual(signals, [[424242, 'SIGTERM']]);
});

test('the probed addresses cover loopback, the recorded and configured bind addresses and every interface', async () => {
  const {coordinatorAddresses} = await import('../lib/v1/host.mjs');
  const addresses = coordinatorAddresses({config: {reachability: {kind: 'lan', publicUrl: 'http://10.23.1.20:8787'}}, status: {host: '0.0.0.0'},
    env: {FARAVAN_COORDINATOR_HOST: '100.64.0.9'},
    networkInterfaces: () => ({en0: [{address: '10.23.1.20'}, {address: 'fe80::1'}], tailscale0: [{address: '100.101.102.103'}, {address: 'fd7a::5'}]})});
  for (const host of ['127.0.0.1', '::1', '100.64.0.9', '10.23.1.20', 'fe80::1%en0', '100.101.102.103', 'fd7a::5']) assert.ok(addresses.includes(host), host);
  assert.ok(!addresses.includes('0.0.0.0'), 'a wildcard bind is reached through loopback');
});
