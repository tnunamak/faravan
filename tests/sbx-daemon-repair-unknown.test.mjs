import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSbxBackend, credentialStoreEnv, inspectIdentitySandboxes, restartSbxDaemonForCredentialStore } from '../lib/docker-backend.mjs';

// Review 4 P1-3: the sbx daemon restart (credential-store repair) ends every running sandbox. It may go ahead only on one
// complete, authoritative empty inventory: a complete process scan, or a readable `sbx ls`. Unknown is never empty.

const result = (overrides = {}) => ({ code: 0, stdout: '', stderr: '', ...overrides });
const OLD_ENVIRON = { HOME: '/old', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
const SHIM = '/usr/libexec/containerd-shim-nerdbox-v1';
const signedOutLs = async (_command, args, calls) => { calls.push(args.join(' ')); return args.join(' ') === 'ls --json' ? result({ code: 1, stderr: 'error: not signed in to Docker' }) : result(); };

async function fakeProc(root, entries) {
  for (const [pid, { argv, environ }] of Object.entries(entries)) {
    await mkdir(join(root, pid), { recursive: true });
    await writeFile(join(root, pid, 'cmdline'), argv.join('\0') + '\0');
    await writeFile(join(root, pid, 'environ'), Object.entries(environ).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  }
}

test('a process scan that cannot enumerate /proc is unknown, not empty', async () => {
  assert.equal(await inspectIdentitySandboxes({ procRoot: join(tmpdir(), 'wf-proc-does-not-exist-' + process.pid), home: '/h/.wfsbx' }), null);
});

test('a sandbox shim whose environment cannot be read makes the scan unknown', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-proc-'));
  try {
    await fakeProc(root, { 300: { argv: [SHIM, '-namespace', 'docker'], environ: { HOME: '/h/.wfsbx' } } });
    await chmod(join(root, '300', 'environ'), 0o000);
    assert.equal(await inspectIdentitySandboxes({ procRoot: root, home: '/h/.wfsbx' }), null, 'it may be ours: unknown');
  } finally { await chmod(join(root, '300', 'environ'), 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('a process that exits during the scan is skipped and the scan stays complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-proc-'));
  try {
    await fakeProc(root, { 400: { argv: [SHIM], environ: { HOME: '/h' } } });
    await mkdir(join(root, '401')); // listed, then gone: no cmdline any more
    assert.deepEqual(await inspectIdentitySandboxes({ procRoot: root, home: '/h/.wfsbx' }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [label, input] of [['unknown (null)', { sandboxes: null }], ['not supplied', {}]]) {
  test(`process inventory ${label} plus an unreadable sbx ls refuses the restart and stops nothing`, async () => {
    const calls = [];
    const refused = await restartSbxDaemonForCredentialStore({ runCommand: (c, a) => signedOutLs(c, a, calls),
      daemons: [{ pid: 7, environ: OLD_ENVIRON }], waitForExit: async () => true, ...input });
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /could not confirm that no sandbox is running/);
    assert.equal(calls.includes('daemon stop'), false, 'the daemon is never stopped on unknown inventory');
  });
}

test('an empty sbx inventory does not authorize restarting an unowned daemon', async () => {
  const calls = [];
  const runCommand = async (_c, args) => { calls.push(args.join(' ')); return args.join(' ') === 'ls --json' ? result({ stdout: '[]' }) : result(); };
  const done = await restartSbxDaemonForCredentialStore({ runCommand, daemons: [{ pid: 7, environ: OLD_ENVIRON }], sandboxes: null, waitForExit: async () => true });
  assert.equal(done.ok, false);
  assert.match(done.detail, /ownership/);
  assert.equal(calls.includes('daemon stop'), false);
});

test('unknown process inventory with sbx ls showing a running sandbox refuses', async () => {
  const calls = [];
  const runCommand = async (_c, args) => { calls.push(args.join(' ')); return args.join(' ') === 'ls --json' ? result({ stdout: JSON.stringify([{ name: 'wf-abc', status: 'running' }]) }) : result(); };
  const refused = await restartSbxDaemonForCredentialStore({ runCommand, daemons: [{ pid: 7, environ: OLD_ENVIRON }], sandboxes: null, waitForExit: async () => true });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /sandbox is running/);
  assert.equal(calls.includes('daemon stop'), false);
});

// End to end through probeCapabilities: signed out, stale daemon, process scan unknown or failing.
function signedOutStub(home) {
  const calls = [];
  const state = { stale: true };
  const runCommand = async (command, args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line === 'ls --json') return result({ code: 1, stderr: 'error: not signed in to Docker' });
    if (line === 'daemon stop') return result({ stdout: 'Stopped daemon' });
    if (line === 'daemon start --detach') { state.stale = false; return result({ stdout: 'started' }); }
    if (args[0] === 'version') return result({ stdout: 'sbx version: v0.51.0 abc123' });
    if (line === 'run --help') return result({ stdout: ['  -d, --detach', '      --name string', '      --kit stringArray', '      --cpus', '      --memory', '      --skills', '      --deny-network'].join('\n') });
    if (args[0] === 'diagnose') return result({ stdout: 'Daemon healthy\nDocker authentication healthy' });
    if (line === 'policy ls') return result({ stdout: 'Policy rules' });
    if (command === 'dpkg-query') return result({ stdout: 'docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n' });
    if (command === 'docker') return result({ stdout: '28.0.0' });
    if (command === 'containerd') return result({ stdout: 'containerd github.com/containerd/containerd v2.1.0' });
    if (command === 'test') return result();
    throw new Error(`unexpected command: ${command} ${line}`);
  };
  const inspectDaemons = async () => (state.stale ? [{ pid: 4242, environ: OLD_ENVIRON }] : [{ pid: 4343, environ: credentialStoreEnv(home, 'linux') }]);
  return { calls, runCommand, inspectDaemons };
}

for (const [label, inspectSandboxes] of [['returns unknown', async () => null], ['throws', async () => { throw new Error('EACCES'); }]]) {
  test(`doctor repair: a process scan that ${label} while signed out leaves the daemon running`, { skip: process.platform !== 'linux' }, async () => {
    const root = await mkdtemp('/tmp/wfc-'), home=join(root,'sbx');
    const saved=Object.fromEntries(['FARAVAN_HOME','FARAVAN_HOME','FARAVAN_SBX_HOME','FARAVAN_SBX_HOME'].map(k=>[k,process.env[k]]));
    delete process.env.FARAVAN_HOME;delete process.env.FARAVAN_SBX_HOME;delete process.env.FARAVAN_SBX_HOME;
    process.env.FARAVAN_HOME=root;
    try {
      const stub = signedOutStub(home);
      const report = await new DockerSbxBackend().probeCapabilities({ runCommand: stub.runCommand, inspectDaemons: stub.inspectDaemons,
        inspectSandboxes, platformName: 'linux', waitForExit: async () => true });
      assert.equal(report.available, false);
      const repair = report.identity_repairs.find((item) => item.name === 'sbx_credential_store');
      assert.equal(repair.ok, false);
      assert.match(repair.detail, /could not confirm that no sandbox is running/);
      assert.equal(stub.calls.some((line) => line === 'daemon stop' || line === 'daemon start --detach'), false);
    } finally {
      for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a GPU sandbox shim vetoes an empty sandbox inventory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wf-gpu-proc-'));
  try {
    await fakeProc(root,{500:{argv:['/usr/libexec/containerd-shim-nerdbox-gpu-v1'],environ:{HOME:'/fixture/sbx'}}});
    const inventory=await inspectIdentitySandboxes({procRoot:root,home:'/fixture/sbx'});
    assert.equal(inventory.length,1);assert.equal(inventory[0].pid,500);
  } finally {await rm(root,{recursive:true,force:true});}
});
