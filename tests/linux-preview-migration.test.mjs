import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configHome } from '../lib/local-state.mjs';
import { openDevice } from '../lib/v1/device.mjs';
import { migratePreviewProfile } from '../lib/preview-migration.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'faravan-preview-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, name, { settings = true, source = true } = {}) {
  const dir = path.join(scratch(t), name);
  const legacy = path.join(dir, 'legacy');
  const destination = path.join(dir, 'data', 'Faravan Preview probe');
  const dataHome = path.dirname(destination);
  fs.mkdirSync(dataHome, { recursive: true });
  if (source) seedProfile(legacy, { settings });
  return { dir, legacy, destination, dataHome };
}

function seedProfile(home, { settings = true } = {}) {
  const v1 = path.join(home, 'v1');
  fs.mkdirSync(v1, { recursive: true });
  fs.writeFileSync(path.join(v1, 'state.json'), JSON.stringify({ version: 1, circles: [] }));
  const { privateKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(v1, 'device.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  fs.writeFileSync(path.join(v1, 'app-settings.json'), JSON.stringify({ version: 1, name: 'kept' }));
  if (settings) fs.writeFileSync(path.join(v1, 'settings.json'), JSON.stringify({ generation: 'legacy' }));
}

async function snapshot(dir) {
  // Process-lock registrations are transient ownership metadata, not profile state.
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => !entry.name.endsWith('.owners-v1')).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(entries.map(async entry => [entry.name, entry.isDirectory()
    ? await snapshot(path.join(dir, entry.name))
    : fs.readFileSync(path.join(dir, entry.name), 'base64')]));
}

async function profileSnapshot(home) {
  return snapshot(path.join(home, 'v1'));
}

function patchFsMethod(method, predicate, error) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    if (predicate(String(file))) throw error;
    return original.call(this, file, ...args);
  };
  return () => { fs[method] = original; };
}

test('ordinary migration copies a complete profile and records its transaction', async t => {
  const f = fixture(t, 'control-copy');
  await migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
  assert.deepEqual(await profileSnapshot(f.destination), await profileSnapshot(f.legacy));
  const marker = JSON.parse(fs.readFileSync(path.join(f.destination, '.migration-complete'), 'utf8'));
  assert.deepEqual({ type: marker.type, version: marker.version, mode: marker.mode, destination: marker.destination }, {
    type: 'faravan-channel-migration', version: 2, mode: 'copy', destination: f.destination,
  });
  assert.deepEqual(migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), {status:'committed', mode:'copy'});
});

test('an unreadable legacy source is unknown and must be rejected (L07)', async t => {
  const f = fixture(t, 'source-EACCES');
  const before = await snapshot(f.legacy);
  fs.chmodSync(f.legacy, 0);
  try {
    assert.throws(() => fs.statSync(path.join(f.legacy, 'v1')), { code: 'EACCES' }, 'fixture must produce real EACCES');
    assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  } finally {
    fs.chmodSync(f.legacy, 0o700);
  }
  assert.deepEqual(await snapshot(f.legacy), before);
  assert.equal(fs.existsSync(f.destination), false);
});

test('a copied v1 symlink cannot alias the retained legacy profile (L19)', async t => {
  const f = fixture(t, 'source-v1-symlink');
  const actual = path.join(f.dir, 'actual-v1');
  fs.renameSync(path.join(f.legacy, 'v1'), actual);
  fs.symlinkSync(actual, path.join(f.legacy, 'v1'));
  assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  assert.equal(fs.lstatSync(path.join(f.legacy, 'v1')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(f.destination), false);
  assert.match(fs.readFileSync(path.join(actual, 'settings.json'), 'utf8'), /legacy/);
});

test('a real device profile without settings.json remains migratable (L21)', async t => {
  const f = fixture(t, 'real-profile-without-settings-json', { settings: false });
  await migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
  for (const name of ['state.json', 'device.pem', 'app-settings.json']) {
    assert.ok(fs.statSync(path.join(f.destination, 'v1', name)).isFile(), `${name} was migrated`);
  }
  assert.equal(fs.existsSync(path.join(f.destination, 'v1', 'settings.json')), false);
});

test('openDevice produces a migratable device profile without settings.json', async t => {
  const f = fixture(t, 'open-device-profile', { source: false });
  await openDevice({ home: f.legacy, ensureDefault: true, origin: null, clock: () => 1_798_000_000 });
  const before = JSON.parse(fs.readFileSync(path.join(f.legacy, 'v1', 'state.json'), 'utf8'));
  assert.equal(before.version, 1);
  assert.equal(before.circles.length, 1);
  assert.ok(fs.statSync(path.join(f.legacy, 'v1', 'device.pem')).isFile());
  assert.equal(fs.existsSync(path.join(f.legacy, 'v1', 'app-settings.json')), false);
  await migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
  const after = JSON.parse(fs.readFileSync(path.join(f.destination, 'v1', 'state.json'), 'utf8'));
  assert.deepEqual(after, before);
  assert.deepEqual(await profileSnapshot(f.destination), await profileSnapshot(f.legacy));
  assert.equal(fs.existsSync(path.join(f.destination, 'v1', 'settings.json')), false);
});

for (const missing of ['owned circle root key', 'owned circle roster']) {
  test(`copy refuses a real device profile missing its ${missing}`, async t => {
    const f = fixture(t, `copy-missing-${missing.replaceAll(' ', '-')}`, { source: false });
    await openDevice({ home: f.legacy, ensureDefault: true, origin: null, clock: () => 1_798_000_000 });
    const circle = JSON.parse(fs.readFileSync(path.join(f.legacy, 'v1', 'state.json'), 'utf8')).circles[0].id;
    const entry = missing === 'owned circle root key'
      ? path.join(f.legacy, 'v1', 'roots', `${circle}.pem`)
      : path.join(f.legacy, 'v1', 'circles', circle, 'roster.json');
    assert.ok(fs.statSync(entry).isFile(), `the fixture has its ${missing}`);
    fs.unlinkSync(entry);
    const sourceBefore = await snapshot(f.legacy);
    assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
    assert.deepEqual(await snapshot(f.legacy), sourceBefore);
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-transaction.')), false);
  });
}

for (const corruption of ['mismatched owned circle root key', 'tampered owned circle roster']) {
  test(`copy refuses a real device profile with a ${corruption}`, async t => {
    const f = fixture(t, `copy-${corruption.replaceAll(' ', '-')}`, { source: false });
    await openDevice({ home: f.legacy, ensureDefault: true, origin: null, clock: () => 1_798_000_000 });
    const circle = JSON.parse(fs.readFileSync(path.join(f.legacy, 'v1', 'state.json'), 'utf8')).circles[0].id;
    if (corruption === 'mismatched owned circle root key') {
      const { privateKey } = generateKeyPairSync('ed25519');
      fs.writeFileSync(path.join(f.legacy, 'v1', 'roots', `${circle}.pem`), privateKey.export({ format:'pem', type:'pkcs8' }), { mode:0o600 });
    } else {
      const rosterFile = path.join(f.legacy, 'v1', 'circles', circle, 'roster.json');
      const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
      roster.current.payload.members[0].device_name = 'tampered';
      fs.writeFileSync(rosterFile, JSON.stringify(roster));
    }
    const sourceBefore = await snapshot(f.legacy);
    assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
    assert.deepEqual(await snapshot(f.legacy), sourceBefore);
    assert.equal(fs.existsSync(f.destination), false);
    assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-transaction.')), false);
  });
}

test('a reserved marker directory in legacy input is rejected (L16)', async t => {
  const f = fixture(t, 'copied-marker-directory');
  fs.mkdirSync(path.join(f.legacy, '.migration-complete'));
  assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  assert.ok(fs.statSync(path.join(f.legacy, '.migration-complete')).isDirectory());
  assert.equal(fs.existsSync(f.destination), false);
});

test('a marker symlink is rejected without changing its target', async t => {
  const f = fixture(t, 'marker-symlink', { source: false });
  fs.mkdirSync(f.destination, { recursive: true });
  seedProfile(f.destination);
  const target = path.join(f.dataHome, 'marker-target');
  fs.writeFileSync(target, 'keep');
  const marker = path.join(f.destination, '.migration-complete');
  fs.symlinkSync(target, marker);
  assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('a multiply-linked profile file is rejected (source independence)', async t => {
  const f = fixture(t, 'source-hardlink');
  const key = path.join(f.legacy, 'v1', 'device.pem');
  fs.linkSync(key, path.join(f.dir, 'retained-key-copy.pem'));
  assert.equal(fs.lstatSync(key).nlink, 2);
  assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  assert.equal(fs.existsSync(f.destination), false);
});

test('a special file in the source profile is rejected', async t => {
  const f = fixture(t, 'source-fifo');
  const fifo = path.join(f.legacy, 'v1', 'unexpected-pipe');
  const created = childProcess.spawnSync('/usr/bin/mkfifo', [fifo]);
  assert.equal(created.status, 0, 'mkfifo is available for this Linux test');
  assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }));
  assert.equal(fs.existsSync(f.destination), false);
});

test('activation refuses a destination that appears after staging (L25)', async t => {
  const f = fixture(t, 'destination-created-before-commit');
  const sourceBefore = await snapshot(f.legacy);
  const original = childProcess.spawnSync;
  let racedInode;
  childProcess.spawnSync = function (command, args, options) {
    if (String(command).endsWith('/mv') && args.some(arg => String(arg).startsWith(f.dataHome + '/.faravan-preview-copying.'))) {
      fs.mkdirSync(f.destination);
      racedInode = fs.statSync(f.destination).ino;
    }
    return original.call(this, command, args, options);
  };
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir })); }
  finally { childProcess.spawnSync = original; }
  assert.deepEqual(await snapshot(f.legacy), sourceBefore);
  assert.deepEqual(fs.readdirSync(f.destination), [], 'the raced empty destination remains in place');
  assert.equal(fs.statSync(f.destination).ino, racedInode, 'the no-clobber move preserves the raced directory inode');
  assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-copying.')), true, 'the ambiguous staged copy is retained');
});

test('destination lstat errors refuse migration or adoption (L06)', async t => {
  const f = fixture(t, 'destination-lstat-EIO', { source: false });
  fs.mkdirSync(f.destination, { recursive: true });
  seedProfile(f.destination);
  const restore = patchFsMethod('lstatSync', file => file === f.destination, Object.assign(new Error('injected destination EIO'), { code: 'EIO' }));
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), { code: 'EIO' }); }
  finally { restore(); }
  assert.equal(fs.existsSync(path.join(f.destination, '.migration-complete')), false);
});

test('a staged profile fsync error leaves the source intact and destination absent', async t => {
  const f = fixture(t, 'stage-fsync-EIO');
  const before = await profileSnapshot(f.legacy);
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    const actual = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (actual.startsWith(f.dataHome + '/.faravan-preview-copying.'))
      throw Object.assign(new Error('injected staged profile fsync EIO'), { code: 'EIO' });
    return original.call(this, fd);
  };
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), { code: 'EIO' }); }
  finally { fs.fsyncSync = original; }
  assert.deepEqual(await profileSnapshot(f.legacy), before);
  assert.equal(fs.existsSync(f.destination), false);
});

test('unsupported GNU mv capability fails before creating stage or journal', async t => {
  const f = fixture(t, 'unsupported-mv-capability');
  const sourceBefore = await snapshot(f.legacy);
  const original = childProcess.spawnSync;
  let probes = 0;
  childProcess.spawnSync = function (command, args, ...rest) {
    if (command === '/usr/bin/mv' && args.includes('--version')) {
      probes += 1;
      return {status:1, stdout:'', stderr:'unsupported option'};
    }
    return original.call(this, command, args, ...rest);
  };
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir })); }
  finally { childProcess.spawnSync = original; }
  assert.equal(probes, 1);
  assert.deepEqual(await snapshot(f.legacy), sourceBefore);
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(fs.readdirSync(f.dataHome).filter(name => !name.endsWith('.owners-v1')), []);
});

test('a prepared journal directory fsync error does not activate the staged profile', async t => {
  const f = fixture(t, 'prepared-journal-fsync-EIO');
  const before = await profileSnapshot(f.legacy);
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.dataHome)
      throw Object.assign(new Error('injected prepared journal directory fsync EIO'), { code: 'EIO' });
    return original.call(this, fd);
  };
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), { code: 'EIO' }); }
  finally { fs.fsyncSync = original; }
  assert.deepEqual(await profileSnapshot(f.legacy), before);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-copying.')), true);
  assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-transaction.')), true);
});

test('an activation parent fsync error can recover the exact prepared transaction', async t => {
  const f = fixture(t, 'activation-parent-fsync-EIO');
  const before = await profileSnapshot(f.legacy);
  const original = fs.fsyncSync;
  let parentSyncs = 0;
  fs.fsyncSync = function (fd) {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.dataHome && ++parentSyncs === 2)
      throw Object.assign(new Error('injected activation parent fsync EIO'), { code: 'EIO' });
    return original.call(this, fd);
  };
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), { code: 'EIO' }); }
  finally { fs.fsyncSync = original; }
  assert.deepEqual(await profileSnapshot(f.legacy), before);
  assert.deepEqual(await profileSnapshot(f.destination), before);
  assert.deepEqual(migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), {status:'committed', mode:'copy'});
  assert.deepEqual(await profileSnapshot(f.destination), before);
});

test('marker lstat errors do not trigger adoption (L08)', async t => {
  const f = fixture(t, 'marker-lstat-EIO', { source: false });
  fs.mkdirSync(f.destination, { recursive: true });
  seedProfile(f.destination);
  const marker = path.join(f.destination, '.migration-complete');
  fs.writeFileSync(marker, 'preserve-this-marker\n');
  const restore = patchFsMethod('lstatSync', file => file === marker, Object.assign(new Error('injected marker EIO'), { code: 'EIO' }));
  try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), { code: 'EIO' }); }
  finally { restore(); }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve-this-marker\n');
});

test('a process death before marker publication leaves copied state recoverable without activation', async t => {
  const f = fixture(t, 'crash-before-marker-rename');
  const before = await profileSnapshot(f.legacy);
  const helper = pathToFileURL(path.join(repo, 'lib/preview-migration.mjs')).href;
  const childScript = `import fs from 'node:fs';
const original = fs.renameSync;
fs.renameSync = function (from, to, ...rest) {
  if (String(to).endsWith('/.migration-complete')) process.kill(process.pid, 'SIGKILL');
  return original.call(this, from, to, ...rest);
};
const { migratePreviewProfile } = await import(${JSON.stringify(helper)});
await migratePreviewProfile(${JSON.stringify({ source: f.legacy, destination: f.destination, base:f.dir })});`;
  const crashed = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', childScript], { encoding: 'utf8', timeout: 5000 });
  assert.equal(crashed.signal, 'SIGKILL');
  assert.deepEqual(await profileSnapshot(f.legacy), before);
  assert.equal(fs.existsSync(f.destination), false, 'no incomplete profile became active');
  await migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
  assert.deepEqual(await profileSnapshot(f.legacy), before);
  assert.deepEqual(await profileSnapshot(f.destination), before);
});

test('a markerless destination with no source requires reconciliation without writes', async t => {
  const f = fixture(t, 'unproven-destination-no-source', {source:false});
  seedProfile(f.destination);
  const before = await snapshot(f.destination);
  assert.throws(() => migratePreviewProfile({source:f.legacy, destination:f.destination, base:f.dir}), /reconciliation/);
  assert.deepEqual(await snapshot(f.destination), before);
  assert.deepEqual(fs.readdirSync(f.dataHome), [path.basename(f.destination)]);
  assert.equal(fs.existsSync(f.legacy), false);
});

test('a historical adoption record without source provenance requires reconciliation', async t => {
  const f = fixture(t, 'unproven-historical-adoption');
  seedProfile(f.destination);
  const marker = {type:'faravan-channel-migration', version:2, mode:'adopt',
    transaction:'11111111-1111-1111-1111-111111111111', destination:f.destination};
  fs.writeFileSync(path.join(f.destination, '.migration-complete'), JSON.stringify(marker));
  const identity = fs.statSync(f.destination);
  const journal = path.join(f.dataHome, '.faravan-preview-transaction.' + createHash('sha256').update(f.destination).digest('hex') + '.json');
  fs.writeFileSync(journal, JSON.stringify({phase:'committed', marker, source:f.legacy,
    stage:f.destination, dev:identity.dev, ino:identity.ino, inventory:[]}));
  const before = await snapshot(f.destination), sourceBefore = await snapshot(f.legacy);
  assert.throws(() => migratePreviewProfile({source:f.legacy, destination:f.destination, base:f.dir}), /reconciliation/);
  assert.deepEqual(await snapshot(f.destination), before);
  assert.deepEqual(await snapshot(f.legacy), sourceBefore);
});


test('a marker-only fresh profile can be retried before app initialization', t => {
  const f = fixture(t, 'fresh-marker-only', { source: false });
  assert.deepEqual(migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), {status:'committed', mode:'fresh'});
  assert.deepEqual(migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), {status:'committed', mode:'fresh'});
  assert.deepEqual(fs.readdirSync(f.destination), ['.migration-complete']);
});

test('a fully initialized fresh profile remains valid on retry', async t => {
  const f = fixture(t, 'fresh-initialized', { source: false });
  migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
  await openDevice({ home: f.destination, ensureDefault: true, origin: null, clock: () => 1_798_000_000 });
  const before = await snapshot(f.destination);
  assert.deepEqual(migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir }), {status:'committed', mode:'fresh'});
  assert.deepEqual(await snapshot(f.destination), before);
});

for (const defect of ['missing device key', 'corrupt device state', 'state read EIO', 'destination root listing EIO']) {
  test(`a committed fresh marker cannot excuse ${defect}`, async t => {
    const f = fixture(t, `fresh-authority-${defect.replaceAll(' ', '-')}`, { source: false });
    migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir });
    await openDevice({ home: f.destination, ensureDefault: true, origin: null, clock: () => 1_798_000_000 });
    const stateFile = path.join(f.destination, 'v1', 'state.json');
    if (defect === 'missing device key') fs.unlinkSync(path.join(f.destination, 'v1', 'device.pem'));
    if (defect === 'corrupt device state') fs.writeFileSync(stateFile, '{');
    const before = await snapshot(f.destination);
    let restore = () => {};
    if (defect === 'state read EIO') {
      restore = patchFsMethod('readFileSync', file => {
        if (!/^\d+$/.test(file)) return false;
        try { return fs.readlinkSync(`/proc/self/fd/${file}`) === stateFile; }
        catch { return false; }
      }, Object.assign(new Error('injected fresh state EIO'), {code:'EIO'}));
    }
    if (defect === 'destination root listing EIO') {
      restore = patchFsMethod('readdirSync', file => file === f.destination, Object.assign(new Error('injected fresh destination listing EIO'), {code:'EIO'}));
    }
    try { assert.throws(() => migratePreviewProfile({ source: f.legacy, destination: f.destination, base:f.dir })); }
    finally { restore(); }
    assert.deepEqual(await snapshot(f.destination), before);
    assert.equal(fs.existsSync(path.join(f.destination, '.migration-complete')), true);
    assert.equal(fs.readdirSync(f.dataHome).some(name => name.startsWith('.faravan-preview-transaction.')), true);
  });
}


test('F1 launcher bounds lock contention and explains how to recover', t => {
  const source = fs.readFileSync(path.join(repo, 'packaging/linux-preview.sh'), 'utf8');
  const lock = source.slice(source.indexOf('exec 9>'), source.indexOf('\nstart_unit()'));
  assert.match(lock, /flock -x -w 15 9/);
  assert.match(lock, /Another preview launch is still preparing your data\. Wait for it to finish; if it is stuck, keep both terminals and ask the person who invited you\./);
  assert.doesNotMatch(lock, /rm |unlink|flock -u/);
  const dir = scratch(t);
  const probe = 'data_home="$1"\ndata_identity=test\nflock() { return 1; }\n' + lock;
  const result = childProcess.spawnSync('/bin/sh', ['-c', probe, 'probe', dir], {encoding:'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another preview launch is still preparing your data/);
  assert.ok(fs.existsSync(path.join(dir, '.faravan-preview-migration-test.lock')));
});

test('launcher moves the earlier profile before starting the app', async () => {
  const source = fs.readFileSync(path.join(repo, 'packaging/linux-preview.sh'), 'utf8');
  const launcher = source.slice(source.indexOf("#!/bin/sh\n"));
  assert.ok(launcher.indexOf('lib/product-home-move.mjs') >= 0);
  assert.ok(launcher.indexOf('lib/product-home-move.mjs') < launcher.indexOf(' --app'));
  const {requireExactMove} = await import('../lib/preview-migration.mjs');
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({status:0, stdout:'mv (uutils coreutils) 0.0.27'});
    assert.throws(() => requireExactMove(), /system mv is not GNU/);
    childProcess.spawnSync = (_bin, args) => args.includes('--no-copy')
      ? {status:1, stdout:''} : {status:0, stdout:'mv (GNU coreutils) 8.32'};
    assert.throws(() => requireExactMove(), /9\.2 or newer.*Ubuntu 24\.04.*Debian 13.*Ubuntu 22\.04.*Debian 12/);
    childProcess.spawnSync = () => ({status:0, stdout:'mv (GNU coreutils) 9.2'});
    assert.doesNotThrow(() => requireExactMove());
  } finally { childProcess.spawnSync = original; }
});

test('F5 stderr diagnostics are private bounded and never persist arbitrary sign-in text', async t => {
  const {createPreviewDiagnostics, runPreviewApp} = await import('../lib/preview-migration.mjs');
  const home = path.join(scratch(t), 'profile');
  fs.mkdirSync(home);
  const log = createPreviewDiagnostics(home);
  assert.equal(path.dirname(log.file), path.join(path.dirname(home), '.profile.diagnostics'));
  assert.deepEqual(fs.readdirSync(home), [], 'diagnostics leave the profile untouched');
  assert.equal(fs.statSync(path.dirname(log.file)).mode & 0o777, 0o700);
  log.write(Buffer.from('EACCES opening app storage\nhttps://localhost/sign'));
  log.write(Buffer.from('in?token=SYNTHETIC-ONE-USE\ncustom:opaque-SYNTHETIC\n'));
  for (let i = 0; i < 1000; i++) log.write(Buffer.alloc(4096, 120));
  log.write(Buffer.from('\n'));
  for (let i = 0; i < 3000; i++) log.write(Buffer.from('ENOENT unsafe-details\n'));
  log.close();
  const kept = fs.readFileSync(log.file, 'utf8'), st = fs.statSync(log.file);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(st.size <= 64 * 1024);
  assert.match(kept, /EACCES/);
  assert.doesNotMatch(kept, /SYNTHETIC|https|localhost|unsafe-details|opening app storage|xxxx/);
  const stub = path.join(home, 'app-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "EACCES https://localhost/signin?token=SYNTHETIC" >&2\nexit 23\n', {mode:0o700});
  assert.equal(await runPreviewApp(home, stub), 23);
  assert.match(fs.readFileSync(log.file, 'utf8'), /EACCES/);
  assert.doesNotMatch(fs.readFileSync(log.file, 'utf8'), /SYNTHETIC|https|localhost/);
  fs.unlinkSync(log.file);
  const target = path.join(home, 'keep');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, log.file);
  assert.throws(() => createPreviewDiagnostics(home));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  const source = fs.readFileSync(path.join(repo, 'packaging/linux-preview.sh'), 'utf8');
  assert.match(source, /--app "\$channel_data" "\$bundle\/usr\/bin\/faravan"/);
  assert.match(source, /wait_app_unit \|\| \{ app_failure; return 1; \}/);
  assert.match(source, /diagnostics.*\$app_diagnostics/);
});

test('the --app wrapper runs the command given after the executable', async t => {
  const home = path.join(scratch(t), 'profile'), stub = path.join(home, 'args-stub'), seen = path.join(home, 'args.txt');
  fs.mkdirSync(home);
  fs.writeFileSync(stub, `#!/bin/sh\nprintf "%s|" "$@" > "${seen}"\n`, {mode:0o700});
  const run = args => childProcess.spawnSync(process.execPath, [new URL('../lib/preview-migration.mjs', import.meta.url).pathname, '--app', home, stub, ...args]);
  assert.equal(run(['app', '--json', '--extra']).status, 0);
  assert.equal(fs.readFileSync(seen, 'utf8'), 'app|--json|--extra|', 'the unit tail is the command that runs');
  assert.equal(run([]).status, 0);
  assert.equal(fs.readFileSync(seen, 'utf8'), 'app|--json|', 'no tail keeps the default app command');
});
