// Replay the launcher-death boundary with a real coordinator process lock.
// Process/network effects are seams: a rejected waitReady and no-op cleanup
// model the launcher disappearing while its child retains the independent lock.
// No SIGKILL or network operation is performed by this replay.
import '../helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostV1, hostedCoordinatorRecord, stopV1Host } from '../../lib/v1/host.mjs';
import { acquireCoordinatorProcessLock, coordinatorProcessLockPath, processLockOwners } from '../../lib/v1/lock.mjs';

const origin = 'http://10.23.4.10:8787', root = 'sha256:' + 'a'.repeat(64);
async function wantedHost(t, cleanup = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'protocol-replay-two-coordinators-'));
  t.after(async () => { cleanup(); await rm(dir, { recursive: true, force: true }); });
  const home = join(dir, 'coordinator');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'host.json'), JSON.stringify({ schema_version: 1, protocol_version: 1, port: 8787,
    status_path: join(home, 'status.json'), data_dir: join(home, 'data'), circle_id: 'c1', circle_ids: ['c1'],
    root_fingerprint: root, v1_origin: origin, reachability:{kind:'lan',publicUrl:origin}, host_wanted: true }));
  return home;
}
function identity(home, command) {
  return {platform:'linux', probe:() => {},
    readlink:file => file.endsWith('/exe') ? process.execPath : 'pid:[test]',
    readFile:file => file.endsWith('/cmdline')
      ? (command ?? [process.execPath, fileURLToPath(new URL('../../bin/faravan-coordinator', import.meta.url)), '--host-config', join(home, 'host.json')]).join('\0') + '\0'
      : file.endsWith('/boot_id') ? 'test-boot' : process.pid + ' (node) ' + ['S', ...Array(18).fill('0'), '42'].join(' ')};
}
const device = {
  selectCircle:() => ({id:'c1', origin, pinnedRootFingerprint:root}),
  publishRoster:async () => {}, createInviteLinks:async () => ({short:'invite'}),
};

test('two coordinators: a child lock survives the launcher boundary and blocks a second start before bind', async t => {
  let release, starts = 0, cleanups = 0, identityReads = 0;
  const home = await wantedHost(t, () => release?.());
  const io = identity(home), read = io.readFile;
  io.readFile = (...args) => { identityReads++; return read(...args); };
  const seams = {
    openDevice:async () => device, provision:async()=>{},portInUse:async()=>false,
    networkInterfaces:()=>({lan:[{family:'IPv4',address:'10.23.4.10',internal:false}]}),
    identityOptions:io,
    startServer:async () => {
      starts++;
      release = acquireCoordinatorProcessLock(home);
      return {stop:async () => { cleanups++; }}; // launcher death runs no child cleanup
    },
    waitReady:async () => { throw new Error('launcher died before bind'); },
  };
  await assert.rejects(hostV1({home}, seams), /launcher died/);
  assert.equal(starts, 1);
  assert.equal(cleanups, 1, 'the seam records, but does not perform, crash cleanup');
  assert.equal(existsSync(join(home, 'status.json')), false);
  await assert.rejects(hostV1({home}, seams), error => error.code === 'coordinator_starting' && error.cleanupVerified === false);
  assert.equal(starts, 1, 'the orphan holds the only coordinator slot for this home');
  assert.ok(identityReads > 0, 'a lock never bypasses coordinator identity verification');
  assert.equal(hostedCoordinatorRecord(home, io).pid, process.pid);
});

test('a pre-bind lock with an unverified program is never adopted or stopped', async t => {
  let release;
  const home = await wantedHost(t, () => release?.());
  release = acquireCoordinatorProcessLock(home);
  const io = identity(home, [process.execPath, '/unrelated/program']);
  const seams = {identityOptions:io, openDevice:async () => device, portInUse:async () => false,
    processExists:() => true,
    startServer:async () => assert.fail('must not start'), stopServer:async () => assert.fail('must not stop'),
    signal:() => assert.fail('must not signal')};
  await assert.rejects(hostV1({home}, seams), error => /cannot verify/.test(error.message) && error.cleanupVerified === false);
  assert.throws(() => hostedCoordinatorRecord(home, io), /cannot verify/);
  await assert.rejects(stopV1Host({home}, seams), /cannot verify/);
});

test('a pre-bind lock retires stale status at the same PID without trusting its old identity', async t => {
  let release;
  const home = await wantedHost(t, () => release?.());
  release = acquireCoordinatorProcessLock(home);
  const io = identity(home);
  const current = hostedCoordinatorRecord(home, io);
  await writeFile(join(home, 'status.json'), JSON.stringify({protocol_version:1, status:'listening',
    pid:process.pid, port:8787, owner:{...current.owner, start:'41'}}));
  assert.deepEqual(hostedCoordinatorRecord(home, io), current);
  await assert.rejects(hostV1({home}, {identityOptions:io, openDevice:async () => device,
    portInUse:async () => false, startServer:async () => assert.fail('must not start')}),
    error => error.code === 'coordinator_starting' && error.cleanupVerified === false);
});

test('unknown or incomplete coordinator lock never proves launch cleanup', async t => {
  let release;
  const home = await wantedHost(t, () => release?.());
  release = acquireCoordinatorProcessLock(home);
  const lock = coordinatorProcessLockPath(home), [owner] = processLockOwners(lock);
  const seams = {identityOptions:identity(home), openDevice:async () => device,
    portInUse:async () => false, startServer:async () => assert.fail('must not start')};
  const refuses = () => assert.rejects(hostV1({home}, seams), error => error.cleanupVerified === false);
  const unknown = join(lock + '.owners-v1', 'unknown');
  await writeFile(unknown, 'unknown');
  await refuses();
  await unlink(unknown);
  const ticket = join(lock + '.owners-v1', owner.token + '.ticket');
  await unlink(ticket);
  await writeFile(ticket, 'malformed');
  await refuses();
  await unlink(ticket);
  await refuses(); // registration exists, ticket selection is incomplete
});
