import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFailure, DockerSbxBackend } from '../lib/docker-backend.mjs';
import { HOST_DISK_HEADROOM_BYTES } from '../lib/host-disk.mjs';
import {
  DISK_FULL_PATTERN, DISK_RESUME_MARGIN_BYTES, createDiskWait, diskRecovered, diskWaitCopy, diskWaitFromReading, diskWaitUnreadable,
  listDockerReclaimable, parseDockerSize, parseDockerSystemDf, reclaimableDocker, volumeNameFor,
} from '../lib/disk-wait.mjs';

const GiB = 1024 ** 3;
const reading = (free, path = '/Users/test') => ({ free, volumes: [{ path, free, total: 500 * GiB, memory: false }] });
const reader = read => ({ free: async () => { const value = read(); if (value instanceof Error) throw value; return value; } });

test('the wait says the volume, what Faravan has, what it needs and how much to free', () => {
  const wait = diskWaitFromReading(reading(6.2 * GiB, 'Macintosh HD'));
  assert.equal(wait.kind, 'low');
  assert.equal(wait.copy, 'Waiting for disk space: Faravan needs 8 GiB free on Macintosh HD and it has 6.2 GiB. Free about 3 GiB.');
  assert.deepEqual([wait.free_bytes, wait.needed_bytes], [6.2 * GiB, HOST_DISK_HEADROOM_BYTES]);
});

test('a reading that rounds to the headroom still says it is short, and never claims more than it has', () => {
  const wait = diskWaitFromReading(reading(HOST_DISK_HEADROOM_BYTES - 0.04 * GiB));
  assert.match(wait.copy, /it has 7\.9 GiB\. Free about 2 GiB\./);
  assert.equal(diskWaitFromReading(reading(HOST_DISK_HEADROOM_BYTES)), null);
  assert.equal(diskWaitFromReading(reading(50 * GiB)), null);
});

test('the wait names the smallest disk-backed volume and ignores memory volumes', () => {
  const wait = diskWaitFromReading({ free: 3 * GiB, volumes: [{ path: '/dev/shm', free: 1 * GiB, memory: true }, { path: '/data', free: 3 * GiB }, { path: '/home', free: 20 * GiB }] });
  assert.equal(wait.volume, '/data');
});

test('an unreadable disk has its own honest words and is never called low', () => {
  const wait = diskWaitUnreadable(Object.assign(new Error('EIO'), { path: '/Users/test' }));
  assert.equal(wait.kind, 'unreadable');
  assert.equal(wait.free_bytes, null);
  assert.match(wait.copy, /^Waiting for disk space: Faravan could not read the free space on \/Users\/test\./);
  assert.doesNotMatch(wait.copy, /needs 8 GiB|it has/);
  assert.equal(diskWaitCopy({ kind: 'unreadable', volume: null }), 'Waiting for disk space: Faravan could not read the free space on this computer’s disk. It tries again by itself.');
});

test('out-of-space words are caught in every form sbx and Docker use', () => {
  for (const text of ['write /var/lib/x: no space left on device', 'ENOSPC: no space left', 'error: not enough space to extract layer', 'Disk full', 'the disk is full',
    'failed to register layer: out of disk space']) assert.match(text, DISK_FULL_PATTERN, text);
  for (const text of ['connection refused', 'image not found', 'timed out waiting', 'space is a place']) assert.doesNotMatch(text, DISK_FULL_PATTERN, text);
});

test('a full disk is classified before an image pull problem, a timeout or an unknown fault', () => {
  const full = text => workspaceFailure({ stderr: text });
  assert.equal(full('failed to pull image "x": write /var/lib/docker/tmp: no space left on device').cause, 'disk_full');
  assert.equal(full('image pull failed: not enough space on the volume').cause, 'disk_full');
  assert.equal(full('request timed out while extracting layer: no space left on device').cause, 'disk_full');
  assert.equal(full('ENOSPC').cause, 'disk_full');
  assert.equal(workspaceFailure(new Error('mkdir /x: no space left on device')).cause, 'disk_full');
  // The causes it must not take over still resolve as before.
  assert.equal(full('image pull failed: connection refused').cause, 'image_unavailable');
  assert.equal(full('something strange').cause, 'unknown');
  assert.equal(workspaceFailure({ code: 'daemon_restart_required', stderr: 'no space left on device' }).cause, 'daemon_restart_required');
  assert.match(full('no space left on device').detail, /ran out of disk space/);
});

test('the wait ends only when free space passes the headroom plus the margin, so it does not flap at the line', () => {
  const wait = diskWaitFromReading(reading(7.9 * GiB));
  const ends = free => diskRecovered(wait, reading(free));
  assert.deepEqual([7.9, 8, 8.5, 8.99].map(gib => ends(gib * GiB)), [false, false, false, false]);
  assert.equal(ends(HOST_DISK_HEADROOM_BYTES + DISK_RESUME_MARGIN_BYTES), true);
  assert.equal(ends(20 * GiB), true);
  assert.equal(diskRecovered(wait, { free: NaN }), false);
  assert.equal(diskRecovered(wait, null), false);
});

// Two disks: following the advice for every short disk must be enough for the test to run again.
const twoDisks = (a, b) => ({ free: Math.min(a, b), volumes: [{ path: '/A', free: a, total: 500 * GiB, memory: false }, { path: '/B', free: b, total: 500 * GiB, memory: false },
  { path: '/dev/shm', free: 0.5 * GiB, total: 1 * GiB, memory: true }] });

test('one short disk of two: the copy names it alone, and the wait ends once it has the margin and the other has the headroom', () => {
  const wait = diskWaitFromReading(twoDisks(7 * GiB, 8.5 * GiB));
  assert.equal(wait.copy, 'Waiting for disk space: Faravan needs 8 GiB free on /A and it has 7.0 GiB. Free about 2 GiB.');
  assert.deepEqual(wait.volumes.map(v => v.volume_path), ['/A']);
  const ends = (a, b) => diskRecovered(wait, twoDisks(a * GiB, b * GiB));
  assert.equal(ends(9, 8.5), true, 'the advice (free about 2 GiB on /A) is enough');
  assert.equal(ends(9, 8), true);
  assert.equal(ends(8.9, 8.5), false, '/A has not passed the margin');
  assert.equal(ends(9, 7.9), false, '/B fell below the headroom');
});

test('two short disks: one sentence names each disk with its own amount, and both must pass the margin', async () => {
  const wait = diskWaitFromReading(twoDisks(7.0 * GiB, 6.2 * GiB));
  assert.equal(wait.copy, 'Waiting for disk space: Faravan needs 8 GiB free on each disk it uses. /B has 6.2 GiB and /A has 7.0 GiB. Free about 3 GiB on /B and 2 GiB on /A.');
  const ends = (a, b) => diskRecovered(wait, twoDisks(a * GiB, b * GiB));
  assert.equal(ends(9, 9.3), true);
  assert.equal(ends(8.5, 9.3), false);
  assert.equal(ends(9, 8.9), false);
  const named = await createDiskWait({ hostDisk: reader(() => twoDisks(7.0 * GiB, 6.2 * GiB)),
    volumeName: async path => ({ '/A': 'Data', '/B': 'Macintosh HD' })[path] }).check();
  assert.equal(named.copy, 'Waiting for disk space: Faravan needs 8 GiB free on each disk it uses. Macintosh HD has 6.2 GiB and Data has 7.0 GiB. Free about 3 GiB on Macintosh HD and 2 GiB on Data.');
  assert.equal(named.volume, 'Macintosh HD');
});

test('a reading without a volume list recovers on its own free space', () => {
  const wait = diskWaitFromReading({ free: 6 * GiB });
  assert.equal(diskRecovered(wait, { free: 8.9 * GiB }), false);
  assert.equal(diskRecovered(wait, { free: 9 * GiB }), true);
});

test('a full Docker disk with room on the host waits for free space to grow, not just to exist', async () => {
  const state = { free: 12 * GiB };
  const disk = createDiskWait({ hostDisk: reader(() => reading(state.free)) });
  const wait = await disk.fault();
  assert.equal(wait.kind, 'docker_full');
  assert.match(wait.copy, /Docker Sandboxes ran out of space while preparing a job, though \/Users\/test has 12\.0 GiB free\./);
  assert.equal(await disk.recovered(wait), false, 'the same free space is not recovery');
  state.free = 12.5 * GiB;
  assert.equal(await disk.recovered(wait), false, 'a little more is not enough');
  state.free = 13 * GiB;
  assert.equal(await disk.recovered(wait), true);
});

test('free space hovering around the headroom never ends a wait', async () => {
  let n = 0;
  const disk = createDiskWait({ hostDisk: reader(() => reading((n++ % 2 ? 8.2 : 7.8) * GiB)) });
  const wait = await disk.check();
  assert.equal(wait.kind, 'low');
  const answers = [];
  for (let i = 0; i < 20; i++) answers.push(await disk.recovered(wait));
  assert.equal(answers.includes(true), false);
});

test('an unreadable disk recovers when it reads again with room', async () => {
  let broken = true;
  const disk = createDiskWait({ hostDisk: reader(() => broken ? Object.assign(new Error('EIO'), { path: '/Users/test' }) : reading(20 * GiB)) });
  const wait = await disk.check();
  assert.equal(wait.kind, 'unreadable');
  assert.equal(await disk.recovered(wait), false);
  broken = false;
  assert.equal(await disk.recovered(wait), true);
  assert.equal(disk.cached, null);
});

test('the volume name comes from the resolver once per path, and a failing resolver falls back to the path', async () => {
  let asked = 0;
  const disk = createDiskWait({ hostDisk: reader(() => reading(1 * GiB, '/Users/test')), volumeName: async path => { asked++; return path === '/Users/test' ? 'Macintosh HD' : path; } });
  assert.match((await disk.check()).copy, /on Macintosh HD and/);
  await disk.check();
  assert.equal(asked, 1);
  const broken = createDiskWait({ hostDisk: reader(() => reading(1 * GiB)), volumeName: async () => { throw new Error('no diskutil'); } });
  assert.match((await broken.check()).copy, /on \/Users\/test and/);
  assert.equal(await createDiskWait({}).check(), null, 'without a reader there is nothing to wait for');
});

test('volumeNameFor reads the macOS startup volume and leaves other systems alone', async () => {
  const run = async () => '   Device Identifier:        disk3s1s1\n   Volume Name:              Macintosh HD\n';
  assert.equal(await volumeNameFor('/Users/me', { platform: 'darwin', run }), 'Macintosh HD');
  assert.equal(await volumeNameFor('/Volumes/Work/x', { platform: 'darwin', run }), 'Work');
  assert.equal(await volumeNameFor('/Users/me', { platform: 'darwin', run: async () => null }), '/Users/me');
  assert.equal(await volumeNameFor('/home/me', { platform: 'linux', run }), '/home/me');
});

// ---- Docker listing (read only) ----------------------------------------------------------------------------------

const JSON_DF = JSON.stringify({
  Images: [
    { ID: 'sha256:' + 'a'.repeat(64), Repository: 'node', Tag: '20', Size: '1.1GB', UniqueSize: '900MB', Containers: '0' },
    { ID: 'b'.repeat(12), Repository: '<none>', Tag: '<none>', Size: '2.5GB', UniqueSize: '2.5GB', Containers: '0' },
    { ID: 'c'.repeat(12), Repository: 'postgres', Tag: '16', Size: '4GB', UniqueSize: '4GB', Containers: '1' },
  ],
  Volumes: [
    { Name: 'pgdata', Links: '0', Size: '3.2GB' },
    { Name: 'cache', Links: '0', Size: '120MB' },
    { Name: 'busy', Links: '2', Size: '9GB' },
    { Name: 'bad name; rm -rf /', Links: '0', Size: '8GB' },
  ],
});
const TABLE_DF = `Images space usage:

REPOSITORY   TAG       IMAGE ID       CREATED        SIZE      SHARED SIZE   UNIQUE SIZE   CONTAINERS
node         20        ${'a'.repeat(12)}   2 weeks ago    1.1GB     200MB         900MB         0
<none>       <none>    ${'b'.repeat(12)}   3 weeks ago    2.5GB     0B            2.5GB         0
postgres     16        ${'c'.repeat(12)}   3 weeks ago    4GB       0B            4GB           1

Containers space usage:

CONTAINER ID   IMAGE   COMMAND   LOCAL VOLUMES   SIZE   CREATED   STATUS   NAMES

Local Volumes space usage:

VOLUME NAME   LINKS     SIZE
pgdata        0         3.2GB
cache         0         120MB
busy          2         9GB

Build cache usage: 0B
`;

test('Docker sizes parse as decimal units and reject anything else', () => {
  assert.equal(parseDockerSize('1.2GB'), 1.2e9);
  assert.equal(parseDockerSize('187MB'), 187e6);
  assert.equal(parseDockerSize('12.5kB'), 12500);
  assert.equal(parseDockerSize('0B'), 0);
  assert.equal(parseDockerSize('N/A'), null);
  assert.equal(parseDockerSize(undefined), null);
});

test('the largest three unused items come with the exact command a person could run, from JSON or the table', () => {
  for (const [label, text] of [['json', JSON_DF], ['table', TABLE_DF]]) {
    const items = reclaimableDocker(parseDockerSystemDf(text));
    assert.deepEqual(items.map(item => [item.kind, item.name, item.size, item.command]), [
      ['volume', 'pgdata', '3.2GB', 'docker volume rm pgdata'],
      ['image', `Unnamed image ${'b'.repeat(12)}`, '2.5GB', `docker image rm ${'b'.repeat(12)}`],
      ['image', 'node:20', '900MB', label === 'json' ? 'docker image rm sha256:' + 'a'.repeat(64) : `docker image rm ${'a'.repeat(12)}`],
    ], label);
  }
});

test('items in use, and names that are not plain names, are never offered', () => {
  const items = reclaimableDocker(parseDockerSystemDf(JSON_DF), { limit: 10 });
  assert.equal(items.some(item => item.name === 'busy' || item.name.includes('postgres')), false);
  assert.equal(items.some(item => /rm -rf|;/.test(item.command)), false);
  assert.equal(items.length, 4);
});

test('Docker output that is neither JSON nor a table is not guessed at', () => {
  assert.equal(parseDockerSystemDf(''), null);
  assert.equal(parseDockerSystemDf('Cannot connect to the Docker daemon'), null);
  assert.equal(parseDockerSystemDf('not json {'), null);
});

test('the listing asks Docker read-only, falls back to the table, and gives null when Docker is absent or silent', async () => {
  const asked = [];
  const old = await listDockerReclaimable({ run: async args => { asked.push(args.join(' ')); return args.includes('--format') ? { code: 125, stdout: '', stderr: 'unknown flag: --format' } : { code: 0, stdout: TABLE_DF }; } });
  assert.deepEqual(asked, ['system df -v --format json', 'system df -v']);
  assert.equal(old.command, 'docker system df -v');
  assert.equal(old.items.length, 3);
  assert.equal(asked.every(line => /^system df/.test(line)), true, 'only the read-only listing runs');
  assert.equal(await listDockerReclaimable({ run: async () => ({ code: 1, stdout: '', stderr: 'spawn docker ENOENT', missing: true }) }), null);
  assert.equal(await listDockerReclaimable({ run: async () => { throw new Error('boom'); } }), null);
  assert.equal(await listDockerReclaimable({ run: async () => ({ code: 0, stdout: 'garbage' }) }), null);
  const empty = await listDockerReclaimable({ run: async () => ({ code: 0, stdout: JSON.stringify({ Images: [], Volumes: [] }) }) });
  assert.deepEqual(empty.items, []);
});

test('describe attaches the listing and Faravan leftovers, and survives a failing lister', async () => {
  const disk = createDiskWait({ hostDisk: reader(() => reading(1 * GiB)),
    listReclaimable: async () => ({ docker: { command: 'docker system df -v', items: [] }, faravan: [{ kind: 'sandbox', name: 'wf-0123456789abcdef' }] }) });
  const wait = await disk.describe(await disk.check());
  assert.equal(wait.reclaim.faravan[0].name, 'wf-0123456789abcdef');
  const failing = createDiskWait({ hostDisk: reader(() => reading(1 * GiB)), listReclaimable: async () => { throw new Error('x'); } });
  assert.deepEqual((await failing.describe(await failing.check())).reclaim, { docker: null, faravan: [] });
});

// ---- The doctor path ---------------------------------------------------------------------------------------------

test('the doctor does not start a test workspace when there is not enough room', async () => {
  const calls = [];
  const backend = new DockerSbxBackend({ hostDisk: reader(() => reading(6.2 * GiB, 'Macintosh HD')) });
  backend.prepare = async () => { calls.push('prepare'); throw new Error('must not run'); };
  backend.runSbx = async args => { calls.push(args[0]); return { code: 0, stdout: '[]' }; };
  const result = await backend.testWorkspace({ version: '0.48.0' });
  assert.deepEqual(calls, [], 'no workspace and no sbx command ran');
  assert.deepEqual([result.ok, result.cause], [false, 'disk_wait']);
  assert.equal(result.detail, 'Waiting for disk space: Faravan needs 8 GiB free on Macintosh HD and it has 6.2 GiB. Free about 3 GiB.');
});

test('the doctor reports the same words when the disk fills during the test workspace', async () => {
  let reads = 0;
  const backend = new DockerSbxBackend({ hostDisk: reader(() => reading((reads++ === 0 ? 20 : 4.5) * GiB)) });
  backend.storage = { supported: async () => false };
  backend.prepare = async () => { throw Object.assign(new Error('pull failed'), { stderr: 'failed to pull image: no space left on device' }); };
  backend.runSbx = async args => ({ code: 0, stdout: args[0] === 'ls' ? '[]' : '' });
  const result = await backend.testWorkspace({ version: '0.48.0' });
  assert.deepEqual([result.ok, result.cause], [false, 'disk_full']);
  assert.match(result.detail, /^Waiting for disk space: Faravan needs 8 GiB free on \/.* and it has 4\.5 GiB\. Free about 5 GiB\.$/);
});
