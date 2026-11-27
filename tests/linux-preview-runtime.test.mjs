import './helpers/no-browser.mjs';
// Executes the generated launcher and its env(1) commands, not just argv checks.
// This is a synthetic private manager, NOT systemd/desktop acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const generator = fileURLToPath(new URL('../packaging/linux-preview.sh', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const desktop = ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'KDE_SESSION_VERSION', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'XAUTHORITY'];

// The shim deliberately discards the caller's environment when starting units.
// Both commands are absolute scratch paths baked into the launcher. No fallback
// to a real systemctl/systemd-run exists, and every child completes synchronously.
const manager = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const dir = process.env.PRIVATE_MANAGER;
if (!dir) process.exit(90);
fs.mkdirSync(dir, {recursive:true});
if (path.basename(process.argv[1]) === 'systemctl') {
  const unit = args.at(-1);
  if (args.includes('is-active')) process.exit(fs.existsSync(path.join(dir, unit + '.json')) ? 0 : 3);
  if (args.includes('--property=ActiveState')) { process.stdout.write(fs.existsSync(path.join(dir, unit + '.json')) ? 'active\\n' : 'inactive\\n'); process.exit(0); }
  process.exit(91);
}
const unit = args.find(x => x.startsWith('--unit='))?.slice(7);
const cut = args.indexOf('--');
if (!unit || cut < 0 || !/^[A-Za-z0-9.-]+$/.test(unit)) process.exit(92);
const out = path.join(dir, unit + '.json');
if (fs.existsSync(out)) process.exit(93);
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  DISPLAY: ':synthetic-manager', WAYLAND_DISPLAY: 'synthetic-manager',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic-no-bus',
  XDG_RUNTIME_DIR: '/synthetic-manager-runtime', XDG_CURRENT_DESKTOP: 'Synthetic', XAUTHORITY: '/synthetic-auth',
  PRIVATE_CAPTURE: out
};
const result = spawnSync(args[cut + 1], args.slice(cut + 2), {env, encoding:'utf8', timeout:5000});
if (result.error || result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(94); }
if (!fs.existsSync(out)) process.exit(95);
`;

// Actual child process: records its real profile environment. It never loads
// application/tray code.
const payload = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
fs.writeFileSync(process.env.PRIVATE_CAPTURE, JSON.stringify({argv:process.argv.slice(2), env:process.env}));
// Like the real app, an app start publishes its discovery record under the installed channel data folder.
if (process.argv[2] === 'app') {
  const channelPath = path.join(path.dirname(process.argv[1]), '..', 'lib', 'faravan', 'channel.json');
  const channel = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
  const appHome = path.join(process.env.FARAVAN_DATA_HOME, 'v1');
  fs.mkdirSync(appHome, {recursive:true});
  fs.writeFileSync(path.join(appHome, 'app.json'), '{}');
  const stateFile = path.join(appHome, 'state.json'), keyFile = path.join(appHome, 'device.pem');
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, JSON.stringify({version:1,circles:[]}));
  if (!fs.existsSync(keyFile)) {
    const {privateKey} = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({format:'pem',type:'pkcs8'}), {mode:0o600});
  }
}
`;

async function executable(path, body) {
  await mkdir(join(path, '..'), {recursive:true});
  await writeFile(path, body, {mode:0o755});
}

async function fixture(t) {
  if (process.platform !== 'linux') { t.skip('Linux launcher runtime test requires Linux'); return; }
  for (const tool of ['bash', 'sh', 'readlink', 'sha256sum', 'flock', 'sed', 'tar', 'cp', 'mkdir', 'rm', 'chmod', 'dirname', 'mktemp']) {
    try { await run('sh', ['-c', 'command -v "$1"', 'probe', tool]); }
    catch { t.skip(`Required launcher tool unavailable: ${tool}`); return; }
  }
  const dir = await mkdtemp(join(tmpdir(), 'faravan-runtime-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const bin = join(dir, 'manager-bin');
  for (const name of ['systemctl', 'systemd-run']) await executable(join(bin, name), manager);
  const stage = join(dir, 'stage');
  for (const name of ['usr/bin/faravan', 'usr/bin/faravan', 'usr/lib/faravan/faravan-tray']) await executable(join(stage, name), payload);
  await mkdir(join(stage, 'usr/lib/faravan/lib'), {recursive:true});
  await copyFile(join(repo, 'lib/preview-migration.mjs'), join(stage, 'usr/lib/faravan/lib/preview-migration.mjs'));
  for (const migrationHelper of ['product-home-move.mjs','durable-write.mjs','durable-directory.mjs','sbx-home.mjs','channel-identity.mjs','v1/lock.mjs','v1/windows-process.mjs']) { await mkdir(join(stage, 'usr/lib/faravan/lib/', 'v1'), {recursive:true}); await copyFile(join(repo, 'lib', migrationHelper), join(stage, 'usr/lib/faravan/lib/', migrationHelper)); }
  await copyFile(join(repo, 'packaging/assets/faravan-session-environment.sh'), join(stage, 'usr/lib/faravan/lib/session-environment.sh'));
  await copyFile(join(repo, 'lib/durable-directory.mjs'), join(stage, 'usr/lib/faravan/lib/durable-directory.mjs'));
  await mkdir(join(stage, 'usr/lib/faravan/lib/v1'), {recursive:true});
  await copyFile(join(repo, 'lib/v1/lock.mjs'), join(stage, 'usr/lib/faravan/lib/v1/lock.mjs'));
  await copyFile(join(repo, 'lib/v1/windows-process.mjs'), join(stage, 'usr/lib/faravan/lib/v1/windows-process.mjs'));
  await copyFile(join(repo, 'lib/v1/versions.mjs'), join(stage, 'usr/lib/faravan/lib/v1/versions.mjs'));
  await copyFile(join(repo, 'lib/v1/run-request.mjs'), join(stage, 'usr/lib/faravan/lib/v1/run-request.mjs'));
  await cp(join(repo, 'lib/protocol'), join(stage, 'usr/lib/faravan/lib/protocol'), {recursive:true});
  await mkdir(join(stage, 'usr/lib/faravan/docs'), {recursive:true});
  await cp(join(repo, 'docs/protocol'), join(stage, 'usr/lib/faravan/docs/protocol'), {recursive:true});
  await copyFile(join(repo, 'lib/working-directory.mjs'), join(stage, 'usr/lib/faravan/lib/working-directory.mjs'));
  await mkdir(join(stage, 'usr/lib/faravan/lib/harnesses'), {recursive:true});
  await copyFile(join(repo, 'lib/harnesses/job-framing.mjs'), join(stage, 'usr/lib/faravan/lib/harnesses/job-framing.mjs'));
  await executable(join(stage, 'usr/lib/faravan/runtime/bin/node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  const callerHome = join(dir, 'caller-home');
  await mkdir(callerHome);
  await mkdir(join(dir, 'caller-data'));
  const env = { PATH:process.env.PATH, HOME:callerHome, XDG_CONFIG_HOME:'/synthetic-caller-config',
    XDG_STATE_HOME:'/synthetic-caller-state', XDG_DATA_HOME:join(dir, 'caller-data'), XDG_CACHE_HOME:'/synthetic-caller-cache',
    FARAVAN_NO_BROWSER:'1', BROWSER:'true', PRIVATE_MANAGER:join(dir, 'units') };
  async function build(name) {
    const root = join(dir, name), dist = join(dir, `dist-${name}`);
    await run('bash', [generator, 'runtime'], {env:{...env,
      FARAVAN_PREVIEW_STAGE:stage, FARAVAN_PREVIEW_DIST:dist, FARAVAN_PREVIEW_ROOT:root,
      FARAVAN_PREVIEW_SYSTEMCTL:join(bin, 'systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN:join(bin, 'systemd-run')}, timeout:10000});
    return {root, launcher:join(dist, 'faravan-preview-runtime/usr/bin/faravan-preview-runtime-launch')};
  }
  return {dir, env, build, callerHome};
}

function verifyDestinations(env, callerHome, root) {
  assert.equal(env.HOME, callerHome, 'Faravan keeps the operating-system account home');
  for (const [key, value] of Object.entries({XDG_CONFIG_HOME:'/synthetic-caller-config', XDG_STATE_HOME:'/synthetic-caller-state', XDG_DATA_HOME:join(callerHome, '..', 'caller-data'), XDG_CACHE_HOME:'/synthetic-caller-cache'})) {
    assert.equal(env[key], value, `${key} remains the caller value`);
    assert.ok(!value.startsWith(root), `${key} does not point inside Faravan data`);
  }
  for (const key of ['FARAVAN_NO_BROWSER', 'FARAVAN_NO_UPDATE', 'FARAVAN_NO_AUTOSTART']) assert.equal(env[key], '1', key);
  assert.ok(env.FARAVAN_DATA_HOME.startsWith(join(callerHome, '..', 'caller-data')), 'the explicit channel data folder follows caller XDG data');
}

test('executed app, tray and CLI isolate persistent destinations; tray receives literal caller desktop values', {timeout:30000}, async t => {
  const f = await fixture(t); if (!f) return;
  const p = await f.build('preview');
  const caller = {...f.env, PRIVATE_CAPTURE:join(f.dir, 'cli.json'),
    XDG_CONFIG_HOME:'/synthetic-caller-config', XDG_STATE_HOME:'/synthetic-caller-state',
    XDG_DATA_HOME:join(f.dir, 'caller-data'), XDG_CACHE_HOME:'/synthetic-caller-cache',
    DISPLAY:':7', WAYLAND_DISPLAY:'wayland-7', DBUS_SESSION_BUS_ADDRESS:'unix:path=/synthetic caller bus',
    XDG_CURRENT_DESKTOP:'literal $(false); `false`', KDE_SESSION_VERSION:'6', XDG_SESSION_TYPE:'wayland',
    XDG_RUNTIME_DIR:join(f.dir, 'desktop-runtime'), XAUTHORITY:'/synthetic caller auth'};
  await run(p.launcher, [], {env:caller, timeout:10000});
  const names = await readdir(f.env.PRIVATE_MANAGER);
  assert.equal(names.length, 2);
  for (const name of names) {
    const {env} = JSON.parse(await readFile(join(f.env.PRIVATE_MANAGER, name), 'utf8'));
    verifyDestinations(env, f.callerHome, p.root);
    for (const key of desktop) assert.equal(env[key], name.includes('-tray-') ? caller[key] : undefined, key);
  }
  const cli = JSON.parse(await readFile(caller.PRIVATE_CAPTURE, 'utf8'));
  verifyDestinations(cli.env, f.callerHome, p.root);
  for (const key of desktop) assert.equal(cli.env[key], undefined);
  assert.equal(cli.env.FARAVAN_HOME, undefined);
  assert.equal(cli.env.FARAVAN_HOME, undefined);
  assert.deepEqual(await readdir(f.callerHome), []);
});




test('same-label rebuilds at the same path start new app and tray units for changed content', {timeout:60000}, async t => {
  const f = await fixture(t); if (!f) return;
  const launch = async p => run(p.launcher, [], {env:{...f.env, PRIVATE_CAPTURE:join(f.dir, 'rebuild-cli.json')}, timeout:10000});
  let p = await f.build('preview');
  await launch(p);
  let previous = (await readdir(f.env.PRIVATE_MANAGER)).sort();
  assert.equal(previous.length, 2);
  await launch(await f.build('preview'));
  assert.deepEqual((await readdir(f.env.PRIVATE_MANAGER)).sort(), previous, 'identical rebuild reuses units');

  for (const [entry, build] of [['usr/bin/faravan', 'new-app'], ['usr/lib/faravan/faravan-tray', 'new-tray']]) {
    await executable(join(f.dir, 'stage', entry), payload.replace('JSON.stringify({argv:', `JSON.stringify({build:'${build}', argv:`));
    p = await f.build('preview');
    await launch(p);
    const current = (await readdir(f.env.PRIVATE_MANAGER)).sort();
    const added = current.filter(name => !previous.includes(name));
    assert.equal(added.length, 2, 'changed bytes create both fresh units despite old units remaining active');
    const app = added.find(name => name.includes('-app-'));
    const tray = added.find(name => name.includes('-tray-'));
    assert.ok(app && tray);
    assert.equal(JSON.parse(await readFile(join(f.env.PRIVATE_MANAGER, app), 'utf8')).build, 'new-app');
    if (build === 'new-tray') assert.equal(JSON.parse(await readFile(join(f.env.PRIVATE_MANAGER, tray), 'utf8')).build, 'new-tray');
    previous = current;
    await launch(await f.build('preview'));
    assert.deepEqual((await readdir(f.env.PRIVATE_MANAGER)).sort(), previous, 'repeat rebuilt launch still reuses its units');
  }
});
