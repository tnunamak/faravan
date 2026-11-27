import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {renameSync,readFileSync} from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater, getUpdateBytes, isNewer, parseVersion, releaseFloor, verifyManifest, updaterForInstall, scheduleUpdates, relaunchApp, runUpdateCommand } from '../lib/v1/self-update.mjs';
import { buildSignedManifest } from '../packaging/sign-update.mjs';
import { createUpdateService } from '../lib/v1/update-service.mjs';

const run = promisify(execFile);
const exists = path => access(path).then(() => true, () => false);
const keys = () => {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  return {pub: publicKey.export({type: 'spki', format: 'pem'}), priv: privateKey.export({type: 'pkcs8', format: 'pem'})};
};

// A real tarball in the release layout, built with the system tar: usr/lib/faravan/{bin/faravan,VERSION}.
async function tarballFor(root, version) {
  const tree = join(root, 'pack-' + version);
  await mkdir(join(tree, 'usr/lib/faravan/bin'), {recursive: true});
  await writeFile(join(tree, 'usr/lib/faravan/bin/faravan'), '#!/bin/sh\necho ' + version + '\n');
  await writeFile(join(tree, 'usr/lib/faravan/VERSION'), version + '\n');
  const file = join(root, `faravan_${version}.tar.gz`);
  await run('tar', ['-czf', file, '-C', tree, 'usr']);
  return readFile(file);
}

// Signs a release dated `released`, served from the fake feed in the setup below.
function serveRelease(s, {version, released, tarball, assets}) {
  const signed = buildSignedManifest({tarball, version, releasedAt: new Date(released), assets,
    tarballUrl: 'https://example.test/rel/faravan.tar.gz', privateKeyPem: s.priv});
  s.files.set('https://example.test/rel/update.json', signed.bytes);
  s.files.set('https://example.test/rel/update.json.sig', Buffer.from(signed.signature));
  s.files.set('https://example.test/rel/faravan.tar.gz', tarball);
}

async function setup(t, {installed = '0.1.0', serve = '0.2.0', smoke, tamper, trailingSlash = false, lockWaitMs, hosts, log} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spk-upd-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const installDir = join(root, 'lib', 'faravan');
  await mkdir(join(installDir, 'bin'), {recursive: true});
  await writeFile(join(installDir, 'VERSION'), installed + '\n');
  await writeFile(join(installDir, '.installed-via'), 'tarball\n');
  await writeFile(join(installDir, 'bin/faravan'), 'old\n');
  const {pub, priv} = keys();
  const files = new Map();
  if (serve) {
    const tarball = await tarballFor(root, serve);
    // Dated on the updater's fixed clock below, so the release is never more than a day ahead of it.
    const {bytes, signature} = buildSignedManifest({tarball, version: serve, releasedAt: new Date('2026-10-19T11:00:00Z'),
      tarballUrl: 'https://example.test/rel/faravan.tar.gz', privateKeyPem: priv});
    files.set('https://example.test/rel/update.json', bytes);
    files.set('https://example.test/rel/update.json.sig', Buffer.from(signature));
    files.set('https://example.test/rel/faravan.tar.gz', tamper ? Buffer.concat([tarball, Buffer.from('x')]) : tarball);
  }
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    const body = files.get(url);
    return typeof body === 'function' ? body() : new Response(body ?? null, {status: body ? 200 : 404});
  };
  let clock = Date.parse('2026-10-19T12:00:00Z');
  const updater = createUpdater({installDir: trailingSlash ? installDir + '/' : installDir, stateFile: join(root, 'home/v1/update.json'), publicKey: pub, manifestUrl: 'https://example.test/rel/update.json',
    fetch, now: () => clock, smoke: smoke ?? (async () => {}), intervalMs: 3600_000, lockWaitMs, hosts, log});
  return {root, installDir, updater, files, requests, fetch, advance: ms => { clock += ms; }, pub, priv,
    version: () => readFile(join(installDir, 'VERSION'), 'utf8').then(s => s.trim()), state: () => readFile(join(root, 'home/v1/update.json'), 'utf8').then(JSON.parse, () => ({}))};
}

test('automatic update reports the real legacy host refusal until a later update succeeds', async t => {
  const privateDetail = 'private provider detail at /saved/legacy';
  const owner = {pid: 424242, owner: {}}, events = [], logs = [];
  let canStop = false;
  const s = await setup(t, {log: line => logs.push(line), hosts:{
    record: async () => owner,
    stop: async record => {
      assert.equal(record, owner);
      events.push('stop');
      if (!canStop) throw Object.assign(new Error(privateDetail), {code:'legacy_exposure_pending'});
    },
    start: async () => { events.push('start'); },
  }});
  const service = createUpdateService({updater:s.updater, currentVersion:'0.1.0', owner:'faravan'});
  const guidance = 'Review the saved legacy exposure before trying the update again. Your current version keeps running.';
  assert.equal(await service.tick({idle:true}), 'failed');
  assert.equal(service.status().error, guidance);
  assert.equal(service.status().currentVersion, '0.1.0');
  assert.equal(await s.version(), '0.1.0');
  assert.equal(await readFile(join(s.installDir + '.next', 'VERSION'), 'utf8'), '0.2.0\n');
  assert.equal(await exists(s.installDir + '.prev'), false);
  assert.deepEqual(events, ['stop']);
  assert.doesNotMatch(JSON.stringify({status:service.status(), logs}), /private provider|saved\/legacy|legacy_exposure_pending/);
  assert.equal(await service.tick({idle:false}), 'too-soon');
  assert.equal(service.status().error, guidance);
  assert.equal(await service.tick({idle:false, force:true}), 'staged');
  assert.equal(service.status().error, guidance);
  assert.deepEqual(events, ['stop']);
  canStop = true;
  assert.equal(await service.tick({idle:true, force:true}), 'applied');
  assert.equal(await s.version(), '0.2.0');
  assert.equal(service.status().error, null);
  assert.deepEqual(events, ['stop', 'stop', 'start']);
});

test('versions only move forward', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  for (const bad of ['1.2', '1.2.3-beta', 'v1.2.3', '', '1.2.3.4']) assert.equal(parseVersion(bad), null, bad);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false, 'never a downgrade');
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('a manifest verifies only against the key that signed it', () => {
  const a = keys(), b = keys();
  const {bytes, signature} = buildSignedManifest({tarball: Buffer.from('x'), version: '1.0.0', tarballUrl: 'u', privateKeyPem: a.priv});
  assert.equal(verifyManifest(bytes, signature, a.pub).version, '1.0.0');
  assert.throws(() => verifyManifest(bytes, signature, b.pub), {code: 'bad_signature'});
  assert.throws(() => verifyManifest(Buffer.concat([bytes, Buffer.from(' ')]), signature, a.pub), {code: 'bad_signature'});
  assert.throws(() => verifyManifest(bytes, 'not base64 !!', a.pub), {code: 'bad_signature'});
});

test('an idle app takes a signed newer version, keeps the old tree, and keeps the install self-updating', async t => {
  const s = await setup(t);
  assert.equal(await s.updater.tick({idle: true}), 'applied');
  assert.equal(await s.version(), '0.2.0');
  assert.equal(await readFile(join(s.installDir + '.prev', 'VERSION'), 'utf8'), '0.1.0\n', 'the previous tree stays for a manual rollback');
  assert.equal((await readFile(join(s.installDir, '.installed-via'), 'utf8')).trim(), 'tarball');
  assert.equal(await exists(s.installDir + '.next'), false);
  assert.deepEqual((await readdir(join(s.root, 'lib'))).filter(n => n.startsWith('.faravan-update-')), [], 'no scratch left behind');
});

test('an install path with a trailing slash still swaps beside the install, not inside it', async t => {
  // The default install path comes from a directory URL, which ends in '/'.
  const s = await setup(t, {trailingSlash: true});
  assert.equal(await s.updater.tick({idle: true}), 'applied');
  assert.equal(await s.version(), '0.2.0');
  assert.equal(await readFile(join(s.installDir + '.prev', 'VERSION'), 'utf8'), '0.1.0\n');
  assert.deepEqual((await readdir(s.installDir)).filter(n => n.startsWith('.')), ['.installed-via'], 'no .next, .prev or lock inside the install');
});

test('a busy app downloads and verifies but does not swap until it is idle', async t => {
  const s = await setup(t);
  assert.equal(await s.updater.tick({idle: false}), 'staged');
  assert.equal(await s.version(), '0.1.0', 'nothing changed under a running job');
  s.advance(60_000); // inside the check interval, but idle with a staged update: apply it
  const before = s.requests.filter(u => u.endsWith('.tar.gz')).length;
  assert.equal(await s.updater.tick({idle: true}), 'applied');
  assert.equal(s.requests.filter(u => u.endsWith('.tar.gz')).length, before, 'the staged download is reused');
  assert.equal(await s.version(), '0.2.0');
});

test('checks are rate limited', async t => {
  const s = await setup(t, {serve: null});
  assert.equal(await s.updater.tick({idle: true}), 'failed', 'a missing manifest is a failure, not a crash');
  const s2 = await setup(t, {serve: '0.1.0'});
  assert.equal(await s2.updater.tick({idle: true}), 'current');
  const seen = s2.requests.length;
  assert.equal(await s2.updater.tick({idle: true}), 'too-soon');
  assert.equal(s2.requests.length, seen, 'no request inside the interval');
  s2.advance(3600_001);
  assert.equal(await s2.updater.tick({idle: true}), 'current');
});

test('a manifest signed by another key changes nothing', async t => {
  const s = await setup(t);
  const other = keys();
  const forged = buildSignedManifest({tarball: Buffer.from('evil'), version: '9.9.9', tarballUrl: 'https://example.test/rel/faravan.tar.gz', privateKeyPem: other.priv});
  s.files.set('https://example.test/rel/update.json', forged.bytes);
  s.files.set('https://example.test/rel/update.json.sig', Buffer.from(forged.signature));
  assert.equal(await s.updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0');
  assert.equal(await exists(s.installDir + '.next'), false);
});

test('a tarball that does not match its signed hash is never unpacked', async t => {
  const s = await setup(t, {tamper: true});
  assert.equal(await s.updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0');
  assert.equal(await exists(s.installDir + '.next'), false);
});

test('a tarball whose version differs from its manifest is refused', async t => {
  const s = await setup(t, {serve: null});
  const tarball = await tarballFor(s.root, '0.1.5');
  const {bytes, signature} = buildSignedManifest({tarball, version: '0.3.0', tarballUrl: 'https://example.test/rel/faravan.tar.gz', privateKeyPem: s.priv});
  s.files.set('https://example.test/rel/update.json', bytes);
  s.files.set('https://example.test/rel/update.json.sig', Buffer.from(signature));
  s.files.set('https://example.test/rel/faravan.tar.gz', tarball);
  assert.equal(await s.updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0');
});

test('a new version that cannot start is rolled back and not tried again', async t => {
  const s = await setup(t, {smoke: async () => { throw new Error('boom'); }});
  assert.equal(await s.updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0', 'the old tree is back');
  assert.equal(await readFile(join(s.installDir, 'bin/faravan'), 'utf8'), 'old\n');
  assert.equal((await s.state()).failedVersion, '0.2.0');
  s.advance(3600_001);
  assert.equal(await s.updater.tick({idle: true}), 'skipped-failed-version');
});

test('without a pinned key nothing updates', async t => {
  const s = await setup(t);
  const off = createUpdater({installDir: s.installDir, stateFile: join(s.root, 'x.json'), publicKey: null, fetch: async () => { throw new Error('no network'); }});
  assert.equal(await off.tick({idle: true}), 'disabled');
  await assert.rejects(off.check(), {code: 'no_key'});
});

test('only a tarball install builds an updater, and the opt-out works', async t => {
  const s = await setup(t);
  assert.ok(await updaterForInstall({home: s.root, installDir: s.installDir, env: {}}));
  assert.equal(await updaterForInstall({home: s.root, installDir: s.installDir, env: {FARAVAN_NO_UPDATE: '1'}}), null);
  await rm(join(s.installDir, '.installed-via'));
  assert.equal(await updaterForInstall({home: s.root, installDir: s.installDir, env: {}}), null, 'a package or checkout is not ours to replace');
});

test('the schedule applies only when idle, then restarts once', {timeout: 5000}, async t => {
  // Production timers intentionally unref. A Promise alone does not keep Node 23 alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const outcomes = ['staged', 'staged', 'applied'];
  const idles = [false, false, true];
  const calls = [];
  const updater = {intervalMs: 5, startDelayMs: 0, installDir: '/x', tick: async ({idle}) => { calls.push(idle); return outcomes.shift(); }};
  let applied = 0;
  const done = new Promise(resolve => {
    const schedule = scheduleUpdates({updater, isIdle: async () => idles.shift(), onApplied: async () => { applied++; resolve(); }});
    t.after(() => schedule.stop());
  });
  await done;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, [false, false, true]);
  assert.equal(applied, 1, 'it stops after the swap');
});

test('stopping the schedule cancels the next tick', async () => {
  let ticks = 0;
  const updater = {intervalMs: 5, startDelayMs: 5, tick: async () => { ticks++; return 'current'; }};
  const schedule = scheduleUpdates({updater, isIdle: async () => true, onApplied: async () => {}});
  schedule.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ticks, 0);
});

test('relaunch starts the new tree detached, without opening a browser', () => {
  const seen = [];
  relaunchApp({installDir: '/home/u/.local/lib/faravan'}, {spawnProcess: (cmd, args, opts) => { seen.push({cmd, args, opts}); return {unref() { seen.push('unref'); }}; }, env: {A: '1'}});
  assert.equal(seen[0].args.join(' '), '/home/u/.local/lib/faravan/bin/faravan app');
  assert.equal(seen[0].opts.detached, true);
  assert.equal(seen[0].opts.env.FARAVAN_NO_BROWSER, '1');
  assert.equal(seen[1], 'unref');
});

const capture = () => { const out = [], err = []; return {out, err, stdout: {write: t => out.push(t)}, stderr: {write: t => err.push(t)}}; };

test('faravan update --check reports and changes nothing; update applies only with no app running', async t => {
  const s = await setup(t);
  let io = capture();
  assert.equal(await runUpdateCommand(['--check'], {updater: s.updater, appRunning: async () => false, ...io}), 0);
  assert.match(io.out.join(''), /0\.2\.0 is available \(you have 0\.1\.0\)/);
  assert.equal(await s.version(), '0.1.0');
  io = capture();
  assert.equal(await runUpdateCommand([], {updater: s.updater, appRunning: async () => true, ...io}), 0);
  assert.match(io.out.join(''), /update itself between jobs/);
  assert.equal(await s.version(), '0.1.0', 'a running app is never swapped from under itself');
  io = capture();
  assert.equal(await runUpdateCommand([], {updater: s.updater, appRunning: async () => false, ...io}), 0);
  assert.match(io.out.join(''), /Updated Faravan from 0\.1\.0 to 0\.2\.0/);
  assert.equal(await s.version(), '0.2.0');
  io = capture();
  assert.equal(await runUpdateCommand([], {updater: s.updater, appRunning: async () => false, ...io}), 0);
  assert.match(io.out.join(''), /up to date/);
});

test('faravan update explains itself on a package install, and rejects unknown options', async () => {
  let io = capture();
  assert.equal(await runUpdateCommand([], {updater: null, appRunning: async () => false, ...io}), 0);
  assert.match(io.out.join(''), /apt upgrade/);
  io = capture();
  assert.equal(await runUpdateCommand(['--force'], {updater: null, appRunning: async () => false, ...io}), 2);
});

// Review 2026-10-19: the idle answer was taken before the download, so a job could start before the swap.
test('a job that starts during the download stops the swap: the update waits staged and nothing is replaced', async t => {
  const s = await setup(t);
  let busy = false, asked = 0;
  const exclusive = async () => { asked++; return busy ? null : () => {}; };
  // idle was true when the tick began; the job starts while the update downloads.
  busy = true;
  assert.equal(await s.updater.tick({idle: true, exclusive}), 'staged');
  assert.equal(asked, 1, 'the exclusion is asked after the download, not before');
  assert.equal(await s.version(), '0.1.0', 'the tree under the running job is untouched');
  busy = false;
  s.advance(60_000);
  assert.equal(await s.updater.tick({idle: true, exclusive}), 'applied');
  assert.equal(await s.version(), '0.2.0');
});

test('the exclusion is held through the swap and released when the swap fails', async t => {
  const s = await setup(t, {smoke: async () => { throw new Error('boom'); }});
  const events = [];
  const exclusive = async () => { events.push('hold'); return async () => { events.push('release'); }; };
  assert.equal(await s.updater.tick({idle: true, exclusive}), 'failed');
  assert.deepEqual(events, ['hold', 'release'], 'a failed swap gives lending back');
  const ok = await setup(t);
  const seen = [];
  assert.equal(await ok.updater.tick({idle: true, exclusive: async () => { seen.push('hold'); return async () => { seen.push('release'); }; }}), 'applied');
  assert.deepEqual(seen, ['hold'], 'after a swap the caller shuts down; the hold ends with it');
  const none = await setup(t);
  let called = false;
  assert.equal(await none.updater.tick({idle: false, exclusive: async () => { called = true; return () => {}; }}), 'staged');
  assert.equal(called, false, 'a busy app does not even ask');
});

test('if the second rename fails the old tree goes back and the launcher is not stranded', async t => {
  const s = await setup(t);
  let calls = 0;
  const {rename} = await import('node:fs/promises');
  const updater = createUpdater({installDir: s.installDir, stateFile: join(s.root, 'home/v1/update.json'), publicKey: s.pub, manifestUrl: 'https://example.test/rel/update.json',
    fetch: async url => { const body = s.files.get(url); return new Response(body ?? null, {status: body ? 200 : 404}); },
    smoke: async () => {}, rename: async (a, b) => { calls++;return rename(a, b); },
    renameSync:(a,b)=>{calls++;if(a.endsWith('.next'))throw Object.assign(new Error('EXDEV'),{code:'EXDEV'});return renameSync(a,b);}});
  assert.equal(await updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0', 'the install is back');
  assert.equal(await readFile(join(s.installDir, 'bin/faravan'), 'utf8'), 'old\n');
  assert.ok(calls >= 3);
});

test('an interrupted swap (install moved to .prev, new tree not in place) is repaired by the next update', async t => {
  const s = await setup(t);
  await s.updater.stage((await s.updater.check()).manifest);
  const {rename} = await import('node:fs/promises');
  await rename(s.installDir, s.installDir + '.prev'); // the process died between the two renames
  assert.equal(await exists(s.installDir), false);
  s.advance(3600_001);
  assert.equal(await s.updater.tick({idle: true}), 'applied');
  assert.equal(await s.version(), '0.2.0');
  assert.equal(await readFile(join(s.installDir + '.prev', 'VERSION'), 'utf8'), '0.1.0\n');
});

test('an interrupted swap with nothing newer to apply still gets the old tree back on the next tick', async t => {
  const s = await setup(t, {serve: '0.1.0'});
  const {rename} = await import('node:fs/promises');
  await rename(s.installDir, s.installDir + '.prev');
  // The app's own tick cannot read VERSION without an install; the repair runs before it looks.
  assert.equal(await s.updater.tick({idle: true, force: true}), 'current');
  assert.equal(await s.version(), '0.1.0');
});

test('one updater at a time: a second apply or stage while another holds the install lock is refused', async t => {
  const s = await setup(t);
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  const manifest = (await s.updater.check()).manifest;
  const release = await acquireProcessLock(s.installDir + '.update.lock', {timeoutMs: 0});
  await assert.rejects(s.updater.stage(manifest), {code: 'busy'});
  await assert.rejects(s.updater.apply(manifest), {code: 'busy'});
  assert.equal(await s.updater.tick({idle: true}), 'failed');
  assert.equal(await s.version(), '0.1.0');
  release();
  await s.updater.stage(manifest);
  const results = await Promise.allSettled([s.updater.apply(manifest), s.updater.apply(manifest)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'exactly one updater swaps');
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'busy');
});

test('the tarball install launcher puts the old tree back when an update was interrupted', async t => {
  const installer = await readFile(new URL('../bin/faravan-install.sh', import.meta.url), 'utf8');
  const heredoc = /cat > "\$STUB_TMP" <<EOF\n([\s\S]*?)\nEOF\n/.exec(installer)?.[1];
  assert.ok(heredoc, 'the installer writes a temporary launcher before atomic replacement');
  const root = await mkdtemp(join(tmpdir(), 'spk-launch-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  // Expand the heredoc the way sh does, with the install root filled in and \$@ left for the launcher.
  const launcher = heredoc.replaceAll('$INSTALL_ROOT', root).replaceAll('\\$@', '$@');
  await mkdir(join(root, 'bin'), {recursive: true});
  await writeFile(join(root, 'bin/faravan'), launcher, {mode: 0o755});
  // The old tree is stranded at .prev, as after a crash between the two renames. Its "node" just says it ran.
  await mkdir(join(root, 'lib/faravan.prev/runtime/bin'), {recursive: true});
  await writeFile(join(root, 'lib/faravan.prev/runtime/bin/node'), '#!/bin/sh\necho ran-old-tree\n', {mode: 0o755});
  const {stdout} = await run(join(root, 'bin/faravan'), ['--help']);
  assert.equal(stdout.trim(), 'ran-old-tree');
  assert.equal(await exists(join(root, 'lib/faravan')), true);
  assert.equal(await exists(join(root, 'lib/faravan.prev')), false);
});

test('scheduled updater publishes verified candidate and check time for Settings', async t => {
  const f=await setup(t);
  assert.equal(await f.updater.tick({idle:false,force:true}),'staged');
  const view=await f.updater.status();
  assert.equal(view.candidate,'0.2.0');
  assert.ok(view.checkedAt);
});

test('a manual availability check retains its check time and verified candidate across restart',async t=>{
 const f=await setup(t);await f.updater.check();
 const saved=await f.updater.status();assert.equal(saved.candidate,'0.2.0');assert.ok(saved.checkedAt);
});

test('release notes travel inside the verified signed update manifest',()=>{
 const {pub,priv}=keys();
 const {bytes,signature}=buildSignedManifest({tarball:Buffer.from('example'),version:'1.1.0',tarballUrl:'https://example.test/app.tar.gz',privateKeyPem:priv,notes:['Keep browser sessions','Pair a device'],releaseNotesUrl:'https://example.test/releases/1.1.0'});
 const manifest=verifyManifest(bytes,signature,pub);
 assert.equal(manifest.notes,'Keep browser sessions\nPair a device');assert.equal(manifest.release_notes_url,'https://example.test/releases/1.1.0');
});

const inertUpdateTimer = () => ({unref() {}});
test('packaged update prepares its helper before closing and never uses the tarball relaunch',async()=>{
  const events=[];let signal;
  const updater=createUpdateService({updater:{
    tick:async()=>{events.push('staged');return 'handoff';},
    prepareHandoff:async options=>{signal=options.signal;events.push('helper-ready');return {ready:true,cancel:async()=>events.push('cancel')};},
  }});
  let schedule;
  schedule=scheduleUpdates({updater,isIdle:async()=>true,setTimer:inertUpdateTimer,clearTimer:()=>{},
    onApplied:async()=>events.push('tarball-relaunch'),
    onHandoff:async()=>{assert.equal(signal.aborted,false);events.push('close');schedule.stop();}});
  await schedule.step();await schedule.step();
  assert.deepEqual(events,['staged','helper-ready','close']);
  assert.equal(signal.aborted,false,'closing the app does not cancel the prepared helper');
  assert.equal(updater.status().state,'staged','helper preparation is not a completed update');
});

test('packaged update keeps the app running while helper readiness is pending',async()=>{
  let ready,entered,closed=false;
  const started=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{ready=resolve;});
  const schedule=scheduleUpdates({updater:{tick:async()=> 'handoff',prepareHandoff:async()=>{entered();return pending;}},
    isIdle:async()=>true,setTimer:inertUpdateTimer,clearTimer:()=>{},
    onHandoff:async()=>{closed=true;},onApplied:assert.fail});
  const step=schedule.step();await started;assert.equal(closed,false);
  ready({ready:true,cancel:async()=>{}});await step;assert.equal(closed,true);
});

test('packaged update helper failure is visible without closing the app',async()=>{
  let closed=0,relaunched=0;
  const updater=createUpdateService({updater:{tick:async()=> 'handoff',prepareHandoff:async()=>{throw Error('helper failed');}}});
  const schedule=scheduleUpdates({updater,isIdle:async()=>true,setTimer:inertUpdateTimer,
    onHandoff:async()=>{closed++;},onApplied:async()=>{relaunched++;}});
  await schedule.step();assert.equal(updater.status().state,'failed');
  assert.equal(closed,0);assert.equal(relaunched,0);
  assert.match(updater.status().error,/current version keeps running/);
});

test('packaged update rejects an unacknowledged helper and cancels only that handoff',async()=>{
  let cancelled=0,closed=0,relaunched=0;
  const schedule=scheduleUpdates({updater:{tick:async()=> 'handoff',prepareHandoff:async()=>({ready:false,cancel:async()=>{cancelled++;}})},
    isIdle:async()=>true,setTimer:inertUpdateTimer,onHandoff:async()=>{closed++;},onApplied:async()=>{relaunched++;}});
  await schedule.step();assert.equal(cancelled,1);assert.equal(closed,0);assert.equal(relaunched,0);
});

test('stopping during helper preparation aborts and cancels without a late app close',async()=>{
  let ready,entered,signal,cancelled=0,closed=0,relaunched=0;
  const started=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{ready=resolve;});
  const schedule=scheduleUpdates({updater:{tick:async()=> 'handoff',prepareHandoff:async options=>{signal=options.signal;entered();return pending;}},
    isIdle:async()=>true,setTimer:inertUpdateTimer,clearTimer:()=>{},onHandoff:async()=>{closed++;},onApplied:async()=>{relaunched++;}});
  const step=schedule.step();await started;schedule.stop();assert.equal(signal.aborted,true);
  ready({ready:true,cancel:async()=>{cancelled++;}});await step;assert.equal(cancelled,1);assert.equal(closed,0);assert.equal(relaunched,0);
});

test('packaged update cancels its helper if the app cannot close',async()=>{
  let cancelled=0;
  const schedule=scheduleUpdates({updater:{tick:async()=> 'handoff',prepareHandoff:async()=>({ready:true,cancel:async()=>{cancelled++;}})},
    isIdle:async()=>true,setTimer:inertUpdateTimer,onHandoff:async()=>{throw Error('close failed');},onApplied:assert.fail});
  await schedule.step();assert.equal(cancelled,1);
});

// These bodies never end: the updater must stop the iterator at the byte limit.
for (const [kind, cap] of [['manifest', 512 * 1024], ['signature', 4096], ['tarball', null]]) {
  test(`bounded ${kind} stream stops at its cap without changing the install`, async t => {
    const s = await setup(t);
    const manifest = JSON.parse(s.files.get('https://example.test/rel/update.json'));
    const limit = cap ?? manifest.size;
    let reads = 0, cancelled = false;
    const chunk = Buffer.alloc(Math.min(limit, 1024), 32);
    const url = 'https://example.test/rel/' + (kind === 'tarball' ? 'faravan.tar.gz' : 'update.json' + (kind === 'signature' ? '.sig' : ''));
    s.files.set(url, () => ({
      ok: true, status: 200, headers: new Headers(),
      body: {
        [Symbol.asyncIterator]() { return this; },
        async next() { reads++; return {done: false, value: chunk}; },
        async return() { cancelled = true; return {done: true}; },
      },
      // An unbounded reader fails promptly rather than hanging this regression.
      async arrayBuffer() { throw new Error('unbounded body read'); },
    }));
    if (kind === 'tarball') {
      const checked = await s.updater.check();
      await assert.rejects(s.updater.stage(checked.manifest), {code: 'too_large'});
    } else await assert.rejects(s.updater.check(), {code: 'too_large'});
    assert.equal(reads, Math.floor(limit / chunk.length) + 1);
    assert.equal(cancelled, true);
    assert.equal(await s.version(), '0.1.0');
    assert.equal(await exists(s.installDir + '.next'), false);
    assert.equal(await exists(s.installDir + '.prev'), false);
  });
}

test('accepted release and version marks reject replay across updater instances and allow equal installed metadata', async t => {
  const s = await setup(t, {serve: null});
  const tarball = await tarballFor(s.root, '0.5.0');
  const serve = (version, released) => {
    const signed = buildSignedManifest({tarball, version, releasedAt: new Date(released),
      tarballUrl: 'https://example.test/rel/faravan.tar.gz', privateKeyPem: s.priv});
    s.files.set('https://example.test/rel/update.json', signed.bytes);
    s.files.set('https://example.test/rel/update.json.sig', Buffer.from(signed.signature));
    s.files.set('https://example.test/rel/faravan.tar.gz', tarball);
  };
  const fresh = () => createUpdater({installDir: s.installDir, stateFile: join(s.root, 'home/v1/update.json'),
    publicKey: s.pub, manifestUrl: 'https://example.test/rel/update.json', fetch: s.fetch, smoke: async () => {}});
  // Old signed feeds are valid; there is deliberately no expiry.
  const t1 = '2020-01-01T00:00:00.000Z', t2 = '2020-02-01T00:00:00.000Z';
  serve('0.5.0', t2);
  const accepted = (await s.updater.check()).manifest;
  assert.equal(accepted.version, '0.5.0');
  // The mark moves when the release is applied, so the replay checks run against an applied 0.5.0.
  await s.updater.stage(accepted);
  await s.updater.apply(accepted);
  assert.equal(await s.version(), '0.5.0');
  for (const updater of [s.updater, fresh()]) {
    for (const [version, released] of [['0.3.0', t1], ['0.6.0', t1], ['0.3.0', t2]]) {
      serve(version, released);
      await assert.rejects(updater.check(), {code: 'metadata_rollback'});
      assert.equal(await s.version(), '0.5.0');
    }
  }
  serve('0.5.0', t2);
  assert.equal((await fresh().check()).manifest, null);
  serve('0.3.0', t1);
  await assert.rejects(fresh().check(), {code: 'metadata_rollback'});
});

for (const channel of ['stable', 'preview-20261029']) {
  test(`incompatible signed metadata cannot poison the ${channel} update mark`, async t => {
    const preview = channel !== 'stable';
    const installed = preview ? '0.1.0-preview.20261029.20' : '0.1.0';
    const newer = preview ? '0.1.0-preview.20261029.21' : '0.2.0';
    const incompatible = preview ? '9.0.0' : '0.1.0-preview.20261029.99';
    const s = await setup(t, {installed, serve: null});
    await writeFile(join(s.installDir, 'channel.json'), JSON.stringify({id: channel}));
    const serve = (version, targetChannel, released) => {
      const tarball = Buffer.from('signed archive');
      const signed = buildSignedManifest({tarball, version, privateKeyPem: s.priv,
        tarballUrl: 'https://example.test/rel/faravan.tar.gz', releasedAt: new Date(released),
        assets: [{archive: tarball, platform: 'linux', arch: process.arch, kind: 'tarball',
          channel: targetChannel, url: 'https://example.test/rel/faravan.tar.gz'}]});
      s.files.set('https://example.test/rel/update.json', signed.bytes);
      s.files.set('https://example.test/rel/update.json.sig', Buffer.from(signed.signature));
    };
    const oldDate = '2020-01-01T00:00:00.000Z', futureDate = '2030-01-01T00:00:00.000Z';
    serve(installed, channel, oldDate);
    assert.equal((await s.updater.check()).manifest, null);
    const before = await s.state();
    serve(incompatible, preview ? 'stable' : 'preview-20261029', futureDate);
    await assert.rejects(s.updater.check(), {code: 'bad_target'});
    assert.deepEqual(await s.state(), before);
    // Same-version metadata is current, so a missing asset for it is not an error; its future date is refused before anything moves.
    serve(installed, preview ? 'preview-20261030' : 'preview-20261029', futureDate);
    await assert.rejects(s.updater.check(), {code: 'bad_manifest'});
    assert.deepEqual(await s.state(), before);
    serve(newer, channel, '2020-02-01T00:00:00.000Z');
    assert.equal((await s.updater.check()).manifest.version, newer);
    assert.equal(await s.version(), installed);
  });
}

// A corrupt state file must not stop the interrupted swap from being repaired, and must not make status throw.
for (const [label, bad] of [['unparseable', '{"accepted": '], ['misshapen', JSON.stringify({accepted: {version: 'x'}})]]) {
  test(`a ${label} update state is moved aside: the interrupted swap is still repaired and status still answers`, async t => {
    const s = await setup(t);
    const {rename} = await import('node:fs/promises');
    await mkdir(join(s.root, 'home/v1'), {recursive: true});
    await writeFile(join(s.root, 'home/v1/update.json'), bad);
    await rename(s.installDir, s.installDir + '.prev'); // the process died between the two renames
    assert.equal((await s.updater.status()).checkedAt, null);
    s.advance(3600_001);
    assert.equal(await s.updater.tick({idle: true}), 'applied');
    assert.equal(await s.version(), '0.2.0');
    assert.ok((await readdir(join(s.root, 'home/v1'))).some(name => /^update\.json\.corrupt-/.test(name)), 'the bad file is kept aside');
    assert.equal((await s.state()).accepted.version, '0.2.0');
  });
}

test('a release dated more than a day ahead is refused and sets no mark', async t => {
  const s = await setup(t, {serve: null});
  const tarball = await tarballFor(s.root, '0.2.0');
  serveRelease(s, {version: '0.2.0', released: '2026-10-21T12:30:00.000Z', tarball});
  await assert.rejects(s.updater.check(), {code: 'bad_manifest'});
  assert.equal((await s.state()).accepted, undefined);
  serveRelease(s, {version: '0.2.0', released: '2026-10-20T11:00:00.000Z', tarball});
  assert.equal((await s.updater.check()).manifest.version, '0.2.0');
});

test('a higher release that fails its smoke test never moves the floor, so a lower republished release installs', async t => {
  const smoke = async dir => { if (await readFile(join(dir, 'VERSION'), 'utf8') === '0.3.0\n') throw new Error('does not start'); };
  const s = await setup(t, {serve: null, smoke});
  serveRelease(s, {version: '0.3.0', released: '2026-10-19T10:00:00.000Z', tarball: await tarballFor(s.root, '0.3.0')});
  assert.equal(await s.updater.tick({idle: true, force: true}), 'failed');
  assert.equal((await s.state()).failedVersion, '0.3.0');
  serveRelease(s, {version: '0.2.0', released: '2026-10-19T09:00:00.000Z', tarball: await tarballFor(s.root, '0.2.0')});
  assert.equal(await s.updater.tick({idle: true, force: true}), 'applied');
  assert.equal(await s.version(), '0.2.0');
});

for (const [label, installed, newer, channel, mark] of [
  ['a stable install ignores a preview mark', '0.1.0', '0.2.0', null,
    {version: '0.1.0-preview.20261029.20', released: '2026-10-01T00:00:00.000Z', channel: 'faravan', parts: 5}],
  ['a preview install ignores a stable mark', '0.1.0-preview.20261029.20', '0.1.0-preview.20261029.21', 'preview-20261029',
    {version: '0.5.0', released: '2026-10-01T00:00:00.000Z', channel: 'faravan', parts: 3}],
]) {
  test(`${label}: a release for this install is still accepted`, async t => {
    const s = await setup(t, {installed, serve: null});
    if (channel) await writeFile(join(s.installDir, 'channel.json'), JSON.stringify({id: channel}));
    await mkdir(join(s.root, 'home/v1'), {recursive: true});
    await writeFile(join(s.root, 'home/v1/update.json'), JSON.stringify({accepted: mark}));
    const tarball = await tarballFor(s.root, newer);
    const assets = channel ? [{archive: tarball, platform: 'linux', arch: process.arch, kind: 'tarball', channel, url: 'https://example.test/rel/faravan.tar.gz'}] : undefined;
    serveRelease(s, {version: newer, released: '2026-10-19T09:00:00.000Z', tarball, assets});
    assert.equal((await s.updater.check()).manifest.version, newer);
  });
}

test('with no saved mark the installed version is the floor, so an older signed release is refused on first contact', async t => {
  const s = await setup(t, {installed: '0.5.0', serve: null});
  serveRelease(s, {version: '0.3.0', released: '2020-01-01T00:00:00.000Z', tarball: await tarballFor(s.root, '0.3.0')});
  await assert.rejects(s.updater.check(), {code: 'metadata_rollback'});
  serveRelease(s, {version: '0.5.0', released: '2020-01-01T00:00:00.000Z', tarball: await tarballFor(s.root, '0.5.0')});
  assert.equal((await s.updater.check()).manifest, null);
});

test('a feed with no asset for this installation reads as current when it offers nothing newer', async t => {
  const s = await setup(t, {serve: null});
  const tarball = await tarballFor(s.root, '0.1.0');
  serveRelease(s, {version: '0.1.0', released: '2026-10-19T09:00:00.000Z', tarball,
    assets: [{archive: tarball, platform: 'linux', arch: process.arch, kind: 'tarball', channel: 'faravan', url: 'https://example.test/rel/faravan.tar.gz'}]});
  assert.equal((await s.updater.check()).manifest, null);
});

test('a state lock held for a moment is waited for', async t => {
  const s = await setup(t, {serve: null, lockWaitMs: 2000});
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  await mkdir(join(s.root, 'home/v1'), {recursive: true});
  serveRelease(s, {version: '0.2.0', released: '2026-10-19T09:00:00.000Z', tarball: await tarballFor(s.root, '0.2.0')});
  const held = await acquireProcessLock(join(s.root, 'home/v1/update.json.lock'), {timeoutMs: 0});
  setTimeout(held, 100);
  assert.equal((await s.updater.check()).manifest.version, '0.2.0');
});

test('a state lock that stays busy is reported as busy, not as a raw lock error', async t => {
  const s = await setup(t, {serve: null, lockWaitMs: 50});
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  await mkdir(join(s.root, 'home/v1'), {recursive: true});
  serveRelease(s, {version: '0.2.0', released: '2026-10-19T09:00:00.000Z', tarball: await tarballFor(s.root, '0.2.0')});
  const held = await acquireProcessLock(join(s.root, 'home/v1/update.json.lock'), {timeoutMs: 0});
  try { await assert.rejects(s.updater.check(), {code: 'busy'}); }
  finally { held(); }
});

test('a failed smoke test saves its version even while the state lock is briefly held', async t => {
  const s = await setup(t, {serve: '0.2.0', smoke: async () => { throw new Error('does not start'); }, lockWaitMs: 2000});
  const {manifest} = await s.updater.check();
  await s.updater.stage(manifest);
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  const held = await acquireProcessLock(join(s.root, 'home/v1/update.json.lock'), {timeoutMs: 0});
  setTimeout(held, 100);
  await assert.rejects(s.updater.apply(manifest), {code: 'rolled_back'});
  assert.equal((await s.state()).failedVersion, '0.2.0');
});

test('an applied update stays applied when its release mark cannot be saved', async t => {
  const s = await setup(t, {serve: '0.2.0', lockWaitMs: 50});
  const {manifest} = await s.updater.check();
  await s.updater.stage(manifest);
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  const held = await acquireProcessLock(join(s.root, 'home/v1/update.json.lock'), {timeoutMs: 0});
  try { await s.updater.apply(manifest); }
  finally { held(); }
  assert.equal((await readFile(join(s.root, 'lib/faravan/VERSION'), 'utf8')).trim(), '0.2.0');
});

test('the release floor is never below the installed version', () => {
  const scope = {channel: 'faravan', parts: 3};
  const state = {accepted: {version: '0.2.0', channel: 'faravan', parts: 3, released: '2026-10-19T09:00:00.000Z'}};
  assert.equal(releaseFloor(state, scope, '0.3.0').version, '0.3.0');
  assert.equal(releaseFloor(state, scope, '0.1.0').version, '0.2.0');
});

test('a download that times out surfaces as an update error, not a raw timeout', async () => {
  const fetch = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
  await assert.rejects(getUpdateBytes(fetch, 'https://example.test/update.json', 1024), {code: 'fetch_failed'});
});

test('Quit beginning during update preparation fences the actual install swap and permits retry after refusal',async t=>{
  const entered=Promise.withResolvers(),ready=Promise.withResolvers();
  t.after(()=>ready.resolve());
  const s=await setup(t,{smoke:async()=>{entered.resolve();await ready.promise;}});
  const owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  const options={idle:true,exclusive:async()=>()=>{},admit:()=>handle.commit(()=>{})};
  const ticking=s.updater.tick(options);await entered.promise;
  const attempt=owner.register('Quit attempt','producer',{provisional:true});ready.resolve();
  assert.equal(await ticking,'staged');assert.equal(await s.version(),'0.1.0');
  attempt.cancel();assert.equal(await s.updater.tick(options),'applied');assert.equal(await s.version(),'0.2.0');
});

test('Quit between install moves restores the old install and retains the staged update',async t=>{
  const s=await setup(t),owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  let attempt,moves=0;
  const afterMove=(from,to)=>{
    if(to!==s.installDir+'.prev')return;
    moves++;
    assert.equal(readFileSync(join(to,'VERSION'),'utf8'),'0.1.0\n');
    attempt=owner.register('Quit attempt','producer',{provisional:true});
  };
  const updater=createUpdater({installDir:s.installDir,stateFile:join(s.root,'state.json'),publicKey:s.pub,
    manifestUrl:'https://example.test/rel/update.json',fetch:s.fetch,now:()=>Date.parse('2026-10-19T12:00:00Z'),smoke:async()=>{},
    rename:async(from,to)=>{await (await import('node:fs/promises')).rename(from,to);afterMove(from,to);},
    renameSync:(from,to)=>{renameSync(from,to);afterMove(from,to);}});
  const options={idle:true,admit:()=>handle.commit(()=>{}),commit:fn=>handle.commit(fn)};
  const service=createUpdateService({updater});
  assert.equal(await service.tick(options),'staged');
  assert.equal(moves,1);assert.equal(await s.version(),'0.1.0');
  assert.equal(await readFile(join(s.installDir+'.next','VERSION'),'utf8'),'0.2.0\n');
  assert.equal(await exists(s.installDir+'.prev'),false,'rollback returns the old tree to its active name');
  attempt.cancel();
});

test('scheduled update service forwards guarded publication through to its updater',async()=>{
  const owner=new AppLifetime(),handle=owner.register('updater','producer',{blockedByHold:true});
  let published=0,applied=0,attempt;
  const updater={startDelayMs:1,intervalMs:100,tick:async options=>{
    attempt=owner.register('Quit attempt','producer',{provisional:true});
    options.commit(()=>{published++;});return 'applied';
  }};
  const schedule=scheduleUpdates({updater:createUpdateService({updater}),isIdle:async()=>true,
    admit:()=>handle.commit(()=>{}),commit:fn=>handle.commit(fn),onApplied:async()=>{applied++;},
    setTimer:()=>({unref(){}}),clearTimer:()=>{}});
  await schedule.step();schedule.stop();await schedule.settled();attempt.cancel();
  assert.equal(published,0);assert.equal(applied,0);
});

test('Linux installed updater reads early-build preference at startup',async t=>{
  const s=await setup(t);const home=join(s.root,'candidate-home');await mkdir(join(home,'v1'),{recursive:true});
  await writeFile(join(home,'v1/app-settings.json'),JSON.stringify({earlyBuilds:true}));
  const requested=[];
  const updater=await updaterForInstall({home,installDir:s.installDir,env:{},publicKey:s.pub,fetch:async url=>{requested.push(url);return new Response('',{status:404});}});
  await assert.rejects(updater.check());
  assert.equal(requested[0],'https://tnunamak.github.io/faravan-updates/candidate/update.json');
});
