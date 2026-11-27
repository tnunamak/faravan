// Run with the INSTALLED Node runtime. No platform overrides, network services or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {createHash, randomUUID} from 'node:crypto';

const [action, appRoot, scratch] = process.argv.slice(2);
assert.equal(process.platform, 'win32', 'Native Windows evidence is not yet run on this OS');
const moduleAt = name => pathToFileURL(join(appRoot, 'lib', name)).href;
fs.mkdirSync(scratch, {recursive:true});
const children = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw Error('Timed out waiting for native child/readiness');
}
function child(args) {
  const processChild = spawn(process.execPath, args, {stdio:['ignore','pipe','pipe']});
  children.add(processChild);
  let output = '', diagnostic = '';
  processChild.stdout.on('data', data => { output += data; });
  // Report only known error codes, never child output containing sign-in links or credentials.
  processChild.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-8192); });
  const errorCodes = () => [...new Set(diagnostic.match(/\b(?:EPERM|EACCES|ENOENT|EISDIR|EINVAL|SQLITE_ERROR|lock_busy)\b/g) ?? [])].join(',');
  const ended = once(processChild, 'exit');
  ended.catch(() => {});
  return {process:processChild, ended, errorCodes, ready:() => until(() => {
    if (output.includes('ready\n')) return true;
    assert.equal(processChild.exitCode, null, 'Native child exited before ready; codes=' + errorCodes());
    return false;
  })};
}
async function stop(c) {
  if (c.process.exitCode === null && c.process.signalCode === null) c.process.kill('SIGKILL');
  await c.ended;
}
const watchdog = setTimeout(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  console.error('Native probe exceeded 90 seconds');
  process.exit(1);
}, 90000);

try {
  if (action === 'lock') {
    const {acquireProcessLockSync:acquire} = await import(moduleAt('v1/lock.mjs'));
    const lock = join(scratch, 'native.lock');
    const script = join(scratch, 'holder.mjs');
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      const {acquireProcessLockSync:acquire} = await import(process.argv[2]);
      const mode = process.argv[4];
      if (mode !== 'hold') {
        const write = fs.writeFileSync;
        fs.writeFileSync = (fd, data, ...args) => {
          if (typeof fd === 'number') {
            if (mode === 'partial') write(fd, Buffer.from(data).subarray(0, 3), ...args);
            console.log('ready');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          return write(fd, data, ...args);
        };
      }
      acquire(process.argv[3]);
      console.log('ready'); setInterval(() => {}, 1000);
    `);
    const holder = child([script, moduleAt('v1/lock.mjs'), lock, 'hold']);
    await holder.ready();
    const entries = fs.readdirSync(lock + '.owners-v1');
    assert.ok(entries.some(name => name.endsWith('.ticket')));
    for (const name of entries) assert.ok(fs.lstatSync(join(lock + '.owners-v1', name)).isFile());
    assert.throws(() => acquire(lock), {code:'lock_busy'}, 'Never steal a live owner');
    await stop(holder);
    const release = acquire(lock); release(); release();
    console.log('PASS native file records, live contention, killed-owner recovery and idempotent release');
    // Instrument only the write boundary, on the real Windows filesystem; no platform/liveness override.
    for (const mode of ['empty', 'partial']) {
      const interruptedLock = join(scratch, mode + '.lock');
      const publisher = child([script, moduleAt('v1/lock.mjs'), interruptedLock, mode]);
      await publisher.ready(); await stop(publisher);
      assert.ok(fs.readdirSync(interruptedLock + '.owners-v1').some(name => name.endsWith('.staging')));
      const unlock = acquire(interruptedLock); unlock();
      console.log('PASS recovery after ' + mode + ' staging publication crash');
    }
    const unknown = join(scratch, 'unknown.lock');
    fs.mkdirSync(unknown + '.owners-v1');
    const record = join(unknown + '.owners-v1', randomUUID() + '.choosing');
    fs.writeFileSync(record, 'unknown');
    assert.throws(() => acquire(unknown), {code:'lock_busy'});
    assert.equal(fs.readFileSync(record, 'utf8'), 'unknown');
    console.log('PASS unknown published owner is preserved and blocks admission');
  } else if (action === 'ownership') {
    const {openDevice} = await import(moduleAt('v1/device.mjs'));
    const {ensureV1HostState, provisionLocalCircle, stopOwnedCoordinatorProcess} = await import(moduleAt('v1/host.mjs'));
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const hostHome = join(scratch, 'coordinator with spaces');
    const device = await openDevice({home:join(scratch, 'owner'), ensureDefault:false});
    const circle = await device.createCircle('http://127.0.0.1:' + port, {name:'Native verification', publish:false});
    await provisionLocalCircle({home:hostHome, circle});
    const {paths, config} = ensureV1HostState({home:hostHome, port});
    fs.writeFileSync(paths.config, JSON.stringify({...config, keep_awake:false, circle_id:circle.id,
      root_fingerprint:circle.pinnedRootFingerprint, v1_origin:circle.origin,
      provisioning_path:circle.provisioningPath, reachability:{kind:'url', publicUrl:circle.origin}}));
    const coordinator = child([join(appRoot, 'bin', 'faravan-coordinator'), '--host-config', paths.config]);
    await until(() => {
      assert.equal(coordinator.process.exitCode, null, 'Coordinator exited; codes=' + coordinator.errorCodes());
      try { return JSON.parse(fs.readFileSync(config.status_path, 'utf8')).status === 'listening'; }
      catch { return false; }
    });
    const unrelated = child(['-e', "console.log('ready');setInterval(()=>{},1000)"]);
    await unrelated.ready();
    assert.throws(() => stopOwnedCoordinatorProcess(unrelated.process.pid, paths.config), /cannot verify/);
    process.kill(unrelated.process.pid, 0);
    assert.throws(() => stopOwnedCoordinatorProcess(coordinator.process.pid, join(scratch, 'wrong.json')), /cannot verify/);
    process.kill(coordinator.process.pid, 0);
    stopOwnedCoordinatorProcess(coordinator.process.pid, paths.config);
    await coordinator.ended;
    console.log('PASS real PowerShell identity: owned coordinator stopped; unrelated PID and wrong config refused');
  } else if (action === 'ready' || action === 'state') {
    const {configHome} = await import(moduleAt('local-state.mjs'));
    const {coordinatorHome} = await import(moduleAt('host.mjs'));
    const dataHome = configHome();
    let pid = null;
    if (action === 'ready') {
      const discovery = JSON.parse(fs.readFileSync(join(dataHome, 'v1', 'app.json'), 'utf8'));
      assert.ok(Number.isInteger(discovery.port) && discovery.port > 0 && discovery.port < 65536);
      assert.ok(Number.isInteger(discovery.pid) && discovery.pid > 0);
      process.kill(discovery.pid, 0);
      const response = await fetch('http://127.0.0.1:' + discovery.port + '/api/status', {
        headers:{'x-faravan-session-token':discovery.token},
        signal:AbortSignal.timeout(10000), redirect:'error',
      });
      assert.equal(response.status, 200);
      await response.json();
      pid = discovery.pid;
    }
    const hash = file => createHash('sha256').update(fs.readFileSync(join(dataHome, 'v1', file))).digest('hex');
    // Never log discovery contents, tokens, private keys, circle names or status bodies.
    console.log(JSON.stringify({dataHome, coordinatorHome:coordinatorHome(), pid, deviceKeySha256:hash('device.pem'),
      stateSha256:hash('state.json'), settingsSha256:hash('app-settings.json')}));
  } else if (action === 'cli') {
    const alias = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'faravan.exe');
    const help = spawnSync(alias, ['--help'], {encoding:'utf8', input:'', timeout:15000});
    assert.equal(help.status, 0, 'App Execution Alias help failed or timed out');
    assert.match(help.stdout, /[Ff]aravan/);
    const invalid = spawnSync(alias, ['windows-verification-invalid-command'], {encoding:'utf8', input:'', timeout:15000});
    assert.equal(invalid.error, undefined, 'App Execution Alias failed to execute');
    assert.ok(Number.isInteger(invalid.status) && invalid.status !== 0, 'Alias must propagate a failing CLI exit code');
    const cmd = spawnSync('cmd.exe', ['/d', '/c', 'faravan.exe --help'], {encoding:'utf8', input:'', timeout:15000});
    assert.equal(cmd.status, 0, 'CLI help must work from cmd.exe PATH as well');
    assert.match(cmd.stdout, /[Ff]aravan/);
    console.log(help.stdout);
    console.log('PASS alias forwards arguments, stdout and nonzero exit status; cmd.exe PATH works');
  } else if (action === 'uninstall') {
    const result = spawnSync(process.execPath, [join(appRoot, 'bin', 'faravan'), 'uninstall', '--yes', '--keep-data'],
      {encoding:'utf8', input:'', timeout:60000});
    assert.equal(result.status, 0, 'Keep-data uninstall failed or timed out; package must not be removed');
    console.log('PASS keep-data CLI uninstall');
  } else if (action === 'filesystem') {
    const {saveJsonFile} = await import(moduleAt('local-state.mjs'));
    const {openDevice} = await import(moduleAt('v1/device.mjs'));
    const target = join(scratch, 'path with spaces', 'native.json');
    saveJsonFile(target, {value:'UTF-8 round trip'}, {base:scratch});
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).value, 'UTF-8 round trip');
    const device = await openDevice({home:join(scratch, 'device'), ensureDefault:false});
    assert.ok(device.keyId);
    const list = join(scratch, 'files.list');
    fs.writeFileSync(list, Buffer.from('files.list\0'));
    const tar = spawnSync('tar.exe', ['--no-xattrs', '--null', '-T', list, '--no-recursion', '-cf',
      join(scratch, 'native.tar')], {cwd:scratch, encoding:'utf8', timeout:10000});
    assert.equal(tar.status, 0, 'Shipped tar flags must work; tar error=' + (tar.error?.code ?? 'none'));
    console.log('PASS installed atomic/device writes, fsync path and Windows tar flags');
  } else {
    throw Error('Unknown native probe: ' + action);
  }
} finally {
  clearTimeout(watchdog);
  await Promise.all([...children].map(processChild => stop({process:processChild, ended:onceEnded(processChild)})));
}

function onceEnded(processChild) {
  return processChild.exitCode !== null || processChild.signalCode !== null ? Promise.resolve() : once(processChild, 'exit');
}
