import './helpers/no-browser.mjs';
// The isolated Linux preview (packaging/linux-preview.sh). Its launcher must start the bundled tray with the app's
// isolated environment, at most once, and nothing it starts may write to the real ~/.config/autostart. systemctl and
// systemd-run are fakes here, so no real user manager, session bus or display is touched, and the bundled CLI is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { access, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { openDevice } from '../lib/v1/device.mjs';
import { startApp } from '../lib/v1/app.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const generator = join(root, 'packaging/linux-preview.sh');
const LABEL = '20261026-2';
const NAME = `faravan-preview-${LABEL}`;
function units(iso, bundle) {
  const launcher = readFileSync(join(bundle, 'usr/bin', `${NAME}-launch`), 'utf8');
  const build = launcher.match(/^build_identity='([a-f0-9]{64})'$/m)?.[1];
  assert.ok(build, 'the generated launcher has a baked content identity');
  const hash = createHash('sha256').update(`${iso}\n${bundle}\n${build}\n`).digest('hex');
  return [`faravan-preview-app-${LABEL}-${hash}.service`, `faravan-preview-tray-${LABEL}-${hash}.service`];
}

// Deterministic manager state: retained failures, ownership metadata and atomic create.
const FAKE_SYSTEMCTL = `#!/bin/sh
for unit; do :; done
case "$*" in
  *is-active*) [ -d "$FAKE_SYSTEMD_STATE/active/$unit" ] ;;
  *reset-failed*)
    printf 'RESET %s\\n' "$unit" >> "$FAKE_SYSTEMD_LOG"
    rm -f "$FAKE_SYSTEMD_STATE/failed/$unit" ;;
  *Description*) cat "$FAKE_SYSTEMD_STATE/descriptions/$unit" ;;
  *ActiveState*)
    if [ -d "$FAKE_SYSTEMD_STATE/active/$unit" ]; then echo active
    elif [ -f "$FAKE_SYSTEMD_STATE/failed/$unit" ]; then echo failed
    else echo inactive; fi ;;
  *) exit 2 ;;
esac
`;

const FAKE_SYSTEMD_RUN = `#!/bin/sh
unit= description=
for arg; do case $arg in
  --unit=*) unit=\${arg#--unit=} ;;
  --description=*) description=\${arg#--description=} ;;
esac; done
mkdir -p "$FAKE_SYSTEMD_STATE/active" "$FAKE_SYSTEMD_STATE/failed" "$FAKE_SYSTEMD_STATE/descriptions"
case "$unit" in
  *-app-*) role=app ;;
  *) role=tray ;;
esac
if [ "\${FAKE_ERROR_ROLE:-}" = "$role" ]; then echo 'permission denied' >&2; exit 77; fi
if [ "\${FAKE_RETAINED_ROLE:-}" = "$role" ] && mkdir "$FAKE_SYSTEMD_STATE/seed-$unit" 2>/dev/null; then
  : > "$FAKE_SYSTEMD_STATE/failed/$unit"
  printf '%s' "$description" > "$FAKE_SYSTEMD_STATE/descriptions/$unit"
  if [ "\${FAKE_FOREIGN:-}" = 1 ]; then echo foreign > "$FAKE_SYSTEMD_STATE/descriptions/$unit"; fi
fi
if [ "\${FAKE_RACE_ROLE:-}" = "$role" ]; then
  mkdir "$FAKE_SYSTEMD_STATE/active/$unit" 2>/dev/null || true
  printf '%s' "$description" > "$FAKE_SYSTEMD_STATE/descriptions/$unit"
  # The winning launch's app publishes its record, as the real one would.
  for arg; do case "$arg" in FARAVAN_DATA_HOME=*) mkdir -p "\${arg#FARAVAN_DATA_HOME=}/v1" && : > "\${arg#FARAVAN_DATA_HOME=}/v1/app.json" ;; esac; done
fi
if [ -f "$FAKE_SYSTEMD_STATE/failed/$unit" ] || ! mkdir "$FAKE_SYSTEMD_STATE/active/$unit" 2>/dev/null; then
  printf 'DUPLICATE\\t%s\\n' "$unit" >> "$FAKE_SYSTEMD_LOG"
  echo "Unit $unit already exists." >&2
  exit 1
fi
printf '%s' "$description" > "$FAKE_SYSTEMD_STATE/descriptions/$unit"
printf 'RUN\\t%s' "$unit" >> "$FAKE_SYSTEMD_LOG"
for arg; do printf '\\t%s' "$arg" >> "$FAKE_SYSTEMD_LOG"; done
printf '\\n' >> "$FAKE_SYSTEMD_LOG"
while [ "$1" != -- ]; do shift; done
shift
# Like systemd, FAKE_APP_DELAY starts the app unit's process after systemd-run has returned.
if [ "$role" = app ] && [ -n "\${FAKE_APP_DELAY:-}" ]; then sleep "$FAKE_APP_DELAY" & wait_first=$!; else wait_first=; fi
[ -z "$wait_first" ] || { ( wait "$wait_first" 2>/dev/null; sleep "$FAKE_APP_DELAY"; /usr/bin/env -i PATH=/usr/bin:/bin HOME=/manager-home \\
  XDG_DATA_HOME="$FAKE_SYSTEMD_STATE/data" FAKE_SYSTEMD_STATE="$FAKE_SYSTEMD_STATE" PREVIEW_LOG="$FAKE_SYSTEMD_STATE/$unit.env" "$@" ) >/dev/null 2>&1 & exit 0; }
# Deliberately unlike the caller; execute only the staged shell stubs, never a real app.
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/manager-home XDG_CONFIG_HOME=/manager-config \\
  XDG_STATE_HOME=/manager-state XDG_DATA_HOME="$FAKE_SYSTEMD_STATE/data" XDG_CACHE_HOME=/manager-cache \\
  DBUS_SESSION_BUS_ADDRESS=manager-bus DISPLAY=manager-display WAYLAND_DISPLAY=manager-wayland \\
  XDG_CURRENT_DESKTOP=manager-desktop XDG_RUNTIME_DIR=/manager-runtime XAUTHORITY=/manager-auth \\
  PREVIEW_LOG="$FAKE_SYSTEMD_STATE/$unit.env" "$@"
`;

// Stands in for the bundled CLI (usr/bin/faravan, usr/bin/faravan): logs its arguments and environment, one block per run.
const FAKE_CLI = `#!/bin/sh
{ printf 'EXEC %s\\n' "$*"; env | sed 's/^/ENV /'; } >> "$PREVIEW_LOG"
# Like the real app, an app start publishes its discovery record. A start that finds one already says so.
data_home="\${FARAVAN_DATA_HOME:-\${XDG_DATA_HOME:-$HOME/.local/share}/Faravan Preview 20261026-2}"
if [ "\${1:-}" = app ] && [ -e "$data_home/v1/app.json" ]; then echo 'RECORD present' >> "$PREVIEW_LOG"; fi
if [ "\${1:-}" = app ]; then
  mkdir -p "$data_home/v1" && : > "$data_home/v1/app.json"
  "${process.execPath}" -e 'const fs=require("node:fs"), crypto=require("node:crypto"), path=require("node:path"); const dir=process.argv[1]; const state=path.join(dir,"state.json"), key=path.join(dir,"device.pem"); if(!fs.existsSync(state)) fs.writeFileSync(state,JSON.stringify({version:1,circles:[]})); if(!fs.existsSync(key)){const {privateKey}=crypto.generateKeyPairSync("ed25519"); fs.writeFileSync(key,privateKey.export({format:"pem",type:"pkcs8"}),{mode:0o600});}' "$data_home/v1"
fi
`;

const exists = path => access(path).then(() => true, () => false);

async function writeExecutable(path, body) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
  await chmod(path, 0o755);
}

// The layout packaging/build.sh stages: usr/bin for the commands, usr/lib/faravan for the runtime and the tray.
async function stagedTree(dir, { tray = true } = {}) {
  await writeExecutable(join(dir, 'usr/bin/faravan'), FAKE_CLI);
  await writeExecutable(join(dir, 'usr/bin/faravan'), FAKE_CLI);
  if (tray) await writeExecutable(join(dir, 'usr/lib/faravan/faravan-tray'), FAKE_CLI);
  await mkdir(join(dir, 'usr/lib/faravan/lib'), {recursive:true});
  await copyFile(join(root, 'lib/preview-migration.mjs'), join(dir, 'usr/lib/faravan/lib/preview-migration.mjs'));
  for (const migrationHelper of ['product-home-move.mjs','durable-write.mjs','durable-directory.mjs','sbx-home.mjs','channel-identity.mjs','v1/lock.mjs','v1/windows-process.mjs']) { await mkdir(join(dir, 'usr/lib/faravan/lib/', 'v1'), {recursive:true}); await copyFile(join(root, 'lib', migrationHelper), join(dir, 'usr/lib/faravan/lib/', migrationHelper)); }
  await copyFile(join(root, 'packaging/assets/faravan-session-environment.sh'), join(dir, 'usr/lib/faravan/lib/session-environment.sh'));
  await copyFile(join(root, 'lib/durable-directory.mjs'), join(dir, 'usr/lib/faravan/lib/durable-directory.mjs'));
  await mkdir(join(dir, 'usr/lib/faravan/lib/v1'), {recursive:true});
  await copyFile(join(root, 'lib/v1/lock.mjs'), join(dir, 'usr/lib/faravan/lib/v1/lock.mjs'));
  await copyFile(join(root, 'lib/v1/windows-process.mjs'), join(dir, 'usr/lib/faravan/lib/v1/windows-process.mjs'));
  await copyFile(join(root, 'lib/v1/versions.mjs'), join(dir, 'usr/lib/faravan/lib/v1/versions.mjs'));
  await copyFile(join(root, 'lib/v1/run-request.mjs'), join(dir, 'usr/lib/faravan/lib/v1/run-request.mjs'));
  await cp(join(root, 'lib/protocol'), join(dir, 'usr/lib/faravan/lib/protocol'), {recursive:true});
  await mkdir(join(dir, 'usr/lib/faravan/docs'), {recursive:true});
  await cp(join(root, 'docs/protocol'), join(dir, 'usr/lib/faravan/docs/protocol'), {recursive:true});
  await copyFile(join(root, 'lib/working-directory.mjs'), join(dir, 'usr/lib/faravan/lib/working-directory.mjs'));
  await mkdir(join(dir, 'usr/lib/faravan/lib/harnesses'), {recursive:true});
  await copyFile(join(root, 'lib/harnesses/job-framing.mjs'), join(dir, 'usr/lib/faravan/lib/harnesses/job-framing.mjs'));
  await writeExecutable(join(dir, 'usr/lib/faravan/runtime/bin/node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  return dir;
}

async function seedProfile(home, { settings = true, circle = false } = {}) {
  const v1 = join(home, 'v1');
  await mkdir(v1, {recursive:true});
  let circleId = null;
  if (circle) {
    await openDevice({home, ensureDefault:true, origin:null, clock:()=>1_798_000_000});
    circleId = JSON.parse(await readFile(join(v1, 'state.json'), 'utf8')).circles[0].id;
  } else {
    await writeFile(join(v1, 'state.json'), JSON.stringify({version:1, circles:[]}));
    const {privateKey} = generateKeyPairSync('ed25519');
    await writeFile(join(v1, 'device.pem'), privateKey.export({format:'pem', type:'pkcs8'}), {mode:0o600});
  }
  await writeFile(join(v1, 'app-settings.json'), JSON.stringify({version:1, name:'kept'}));
  if (settings) await writeFile(join(v1, 'settings.json'), JSON.stringify({generation:'legacy'}));
  return circleId;
}

async function migrationFault(f, kind, target = '') {
  const shim = join(f.work, `migration-fault-${kind}.mjs`);
  await writeFile(shim, `import fs from 'node:fs';
import childProcess from 'node:child_process';
const kind = process.env.FARAVAN_TEST_FAULT;
const target = process.env.FARAVAN_TEST_FAULT_TARGET;
const fail = () => Object.assign(new Error('injected migration EIO'), {code:'EIO'});
if (kind === 'ancestor-sync') {
  const original = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    const actual = fs.readlinkSync('/proc/self/fd/' + fd);
    fs.appendFileSync(process.env.FARAVAN_TEST_TRACE, actual + '\\n');
    if (actual === target) throw fail();
    return original.call(this, fd);
  };
}
if (kind === 'readdir') {
  const original = fs.readdirSync;
  fs.readdirSync = function (file, ...args) { if (String(file) === target) throw fail(); return original.call(this, file, ...args); };
}
if (kind === 'marker-write') {
  const original = fs.writeFileSync;
  fs.writeFileSync = function (file, data, ...args) {
    const body = Buffer.isBuffer(data) ? data.toString() : String(data);
    if (body.includes('faravan-channel-migration') && body.includes('"type"')) {
      original.call(this, file, body.slice(0, 24), ...args);
      throw fail();
    }
    return original.call(this, file, data, ...args);
  };
}
if (kind === 'marker-rename') {
  const original = fs.renameSync;
  fs.renameSync = function (from, to, ...args) { if (String(to).endsWith('/.migration-complete')) throw fail(); return original.call(this, from, to, ...args); };
}
if (kind === 'marker-read') {
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const actual = typeof file === 'number' ? fs.readlinkSync('/proc/self/fd/' + file) : String(file);
    if (actual === target) throw fail();
    return original.call(this, file, ...args);
  };
}
if (kind === 'activation-race') {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = function (command, args, ...rest) {
    if (String(command).endsWith('/mv') && args.some(arg => String(arg).includes('.faravan-preview-copying.'))) fs.mkdirSync(target);
    return original.call(this, command, args, ...rest);
  };
}
`);
  return {NODE_OPTIONS:`--import=${pathToFileURL(shim).href}`, FARAVAN_TEST_FAULT:kind, FARAVAN_TEST_FAULT_TARGET:target};
}

async function profileSnapshot(dir) {
  const v1 = join(dir, 'v1');
  const entries = (await readdir(v1, {withFileTypes:true})).filter(entry => entry.name !== 'app.json' && !entry.name.endsWith('.owners-v1'));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(entries.map(async entry => [entry.name, entry.isDirectory()
    ? await snapshotDirectory(join(v1, entry.name))
    : await readFile(join(v1, entry.name), 'base64')]));
}

async function snapshotDirectory(dir) {
  const entries = await readdir(dir, {withFileTypes:true});
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(entries.map(async entry => [entry.name, entry.isDirectory()
    ? await snapshotDirectory(join(dir, entry.name))
    : await readFile(join(dir, entry.name), 'base64')]));
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'spk-linux-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function generate(env, label = LABEL) {
  return run('bash', [generator, label], { env: { PATH: process.env.PATH, HOME: env.HOME ?? '/nonexistent', ...env } });
}

// systemd-run calls, as {unit, args} in the order they were made.
async function systemdCalls(log) {
  const text = await readFile(log, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  return text.split('\n').filter(line => line.startsWith('RUN\t')).map(line => {
    const [, unit, ...args] = line.split('\t');
    return { unit, args };
  });
}

async function duplicateCalls(log) {
  const text = await readFile(log, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  return text.split('\n').filter(line => line.startsWith('DUPLICATE\t'));
}

// The NAME=VALUE words that systemd-run's command passes to env(1).
function envWords(args) {
  const words = {};
  for (const word of args) {
    const at = word.indexOf('=');
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, at))) words[word.slice(0, at)] = word.slice(at + 1);
  }
  return words;
}

// Each CLI run is one EXEC line followed by its ENV lines.
async function cliRuns(log) {
  const text = await readFile(log, 'utf8').catch(error => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  const runs = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('EXEC ')) runs.push({ args: line.slice(5), env: {} });
    else if (line.startsWith('ENV ') && runs.length) {
      const body = line.slice(4), at = body.indexOf('=');
      if (at > 0) runs.at(-1).env[body.slice(0, at)] = body.slice(at + 1);
    }
  }
  return runs;
}

test('the preview tarball carries the Linux tray and its dated launcher, with no autostart entry', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  await generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist, FARAVAN_PREVIEW_ROOT: join(work, 'iso'),
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const listing = (await run('tar', ['-tvzf', join(dist, `${NAME}_linux_amd64.tar.gz`)])).stdout.trim().split('\n');
  const entry = path => listing.find(line => line.endsWith(' ' + path)) ?? '';
  assert.match(entry('usr/lib/faravan/faravan-tray'), /^-rwx/, 'the tray ships, executable');
  assert.match(entry('usr/lib/faravan/lib/preview-migration.mjs'), /^-rw/, 'the migration helper ships with the app');
  assert.match(entry('usr/lib/faravan/lib/protocol/index.mjs'), /^-rw/, 'the profile validator ships its protocol verifier');
  assert.match(entry('usr/lib/faravan/docs/protocol/roster.schema.json'), /^-rw/, 'the roster schema ships with the verifier');
  assert.match(entry('usr/lib/faravan/lib/working-directory.mjs'), /^-rw/, 'the protocol working-directory dependency ships');
  assert.match(entry('usr/lib/faravan/lib/harnesses/job-framing.mjs'), /^-rw/, 'the protocol framing dependency ships');
  assert.match(entry('usr/lib/faravan/runtime/bin/node'), /^-rwx/, 'the helper uses the bundled Node wrapper');
  assert.match(entry(`usr/bin/${NAME}-launch`), /^-rwx/, 'the dated launcher ships, executable');
  assert.match(entry('MIGRATION.md'), /^-rw/, 'the stop-all-versions and recovery procedure ships');
  assert.equal(listing.some(line => line.split(/\s+/).pop().startsWith('etc/')), false, 'no etc/: nothing installs an XDG autostart entry');
});

test('the generator refuses a staged tree without the Linux tray', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  const stage = await stagedTree(join(work, 'stage'), { tray: false });
  await assert.rejects(generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: join(work, 'dist'), FARAVAN_PREVIEW_ROOT: join(work, 'iso'),
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  }), error => {
    assert.match(error.stderr, /faravan-tray/, 'the error names the missing tray');
    return true;
  });
});

test('the generator refuses a state root that would break the launcher quoting', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  const stage = await stagedTree(join(work, 'stage'));
  await assert.rejects(generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: join(work, 'dist'), FARAVAN_PREVIEW_ROOT: '/home/x/with space',
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  }), error => {
    assert.match(error.stderr, /FARAVAN_PREVIEW_ROOT/);
    return true;
  });
});

test('a launcher built without a state root uses the home folder of the person who runs it', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  const builderHome = join(work, 'builder-home');
  await mkdir(builderHome);
  await generate({
    HOME: builderHome, FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist,
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const bundle = await realpath(join(dist, NAME));
  const launcher = join(bundle, 'usr/bin', `${NAME}-launch`);
  assert.equal((await readFile(launcher, 'utf8')).includes(builderHome), false, 'the release names no path from the computer that built it');
  const userHome = join(work, 'user-home');
  await mkdir(join(work, 'systemd/data'), {recursive:true});
  await mkdir(userHome);
  const env = {
    PATH: process.env.PATH, HOME: userHome, XDG_DATA_HOME: join(work, 'systemd/data'), XDG_RUNTIME_DIR: join(work, 'runtime'),
    FAKE_SYSTEMD_STATE: join(work, 'systemd'), FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log'),
  };
  await run(launcher, [], { env });
  const root = await realpath(join(userHome, `.local/share/faravan`));
  const calls = await systemdCalls(env.FAKE_SYSTEMD_LOG);
  assert.deepEqual(calls.map(call => call.unit), units(root, bundle), 'the units belong to the runner\'s own preview root');
  assert.equal(envWords(calls[0].args).CODEX_HOME, join(root, 'codex-home'), 'agent sign-ins live under the runner\'s home');
});

test('a launcher without a baked root refuses a missing or relative HOME and starts nothing', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  await generate({
    HOME: join(work, 'builder-home'), FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist,
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const launcher = join(await realpath(join(dist, NAME)), 'usr/bin', `${NAME}-launch`);
  const cwd = join(work, 'cwd');
  await mkdir(cwd);
  for (const home of [undefined, '', 'relative-home']) {
    const env = {PATH: process.env.PATH, XDG_DATA_HOME: join(work, 'data'), FAKE_SYSTEMD_STATE: join(work, 'systemd'),
      FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log'), ...(home === undefined ? {} : {HOME: home})};
    await assert.rejects(run(launcher, [], {env, cwd}), `HOME=${home} is refused`);
  }
  assert.deepEqual(await readdir(cwd), [], 'nothing is created relative to the working directory');
  assert.deepEqual(await systemdCalls(join(work, 'systemd.log')), [], 'no unit starts');
});

test('a launcher without a baked root works under a HOME that contains a space', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  await generate({
    HOME: join(work, 'builder-home'), FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist,
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const bundle = await realpath(join(dist, NAME));
  const home = join(work, 'user home');
  await mkdir(home);
  await mkdir(join(work, 'data'));
  await run(join(bundle, 'usr/bin', `${NAME}-launch`), [], {env: {PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(work, 'data'),
    XDG_RUNTIME_DIR: join(work, 'runtime'), FAKE_SYSTEMD_STATE: join(work, 'systemd'), FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log')}});
  const root = await realpath(join(home, `.local/share/faravan`));
  const calls = await systemdCalls(join(work, 'systemd.log'));
  assert.deepEqual(calls.map(call => call.unit), units(root, bundle));
  assert.equal(envWords(calls[0].args).CODEX_HOME, join(root, 'codex-home'), 'the path with a space reaches the app intact');
});

test('the launcher starts the app and tray with separate Faravan data and the caller OS profile', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  const iso = join(work, 'iso');
  await generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist, FARAVAN_PREVIEW_ROOT: iso,
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const bundle = await realpath(join(dist, NAME));
  const [APP_UNIT, TRAY_UNIT] = units(iso, bundle);
  const launcher = join(bundle, 'usr/bin', `${NAME}-launch`);
  const realHome = join(work, 'real-home');
  await mkdir(realHome);
  const env = {
    PATH: `${join(work, 'installer-bin')}:${process.env.PATH}`, HOME: realHome,
    XDG_STATE_HOME: '/caller-state', XDG_DATA_HOME: join(work, 'systemd/data'), XDG_CACHE_HOME: '/caller-cache',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/caller bus', DISPLAY: ':7', WAYLAND_DISPLAY: 'wayland-7',
    XDG_CURRENT_DESKTOP: 'Caller', KDE_SESSION_VERSION: '6', XDG_SESSION_TYPE: 'wayland',
    XDG_RUNTIME_DIR: join(work, 'runtime'), XAUTHORITY: '/caller-auth',
    FAKE_SYSTEMD_STATE: join(work, 'systemd'), FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log'),
  };

  await mkdir(env.HOME, {recursive:true});
  if (env.XDG_DATA_HOME) await mkdir(env.XDG_DATA_HOME, {recursive:true});
  await run(launcher, [], { env });

  const calls = await systemdCalls(env.FAKE_SYSTEMD_LOG);
  assert.deepEqual(calls.map(call => call.unit), [APP_UNIT, TRAY_UNIT], 'one unit for the app and one for the tray');
  const [appCall, trayCall] = calls;
  assert.deepEqual(appCall.args.slice(-2), ['app', '--json'], 'the app unit runs faravan app');
  assert.equal(trayCall.args.at(-1), join(bundle, 'usr/lib/faravan/faravan-tray'), 'the tray unit runs the bundled tray');

  const appEnv = envWords(appCall.args), trayEnv = envWords(trayCall.args);
  const expectedUnitPath = [join(bundle, 'usr/bin'), join(bundle, 'usr/lib/faravan/runtime/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  assert.equal(appEnv.PATH, expectedUnitPath, 'the app unit uses the preview package PATH');
  assert.equal(trayEnv.PATH, expectedUnitPath, 'the tray unit does not inherit the install-time PATH');
  assert.equal(appEnv.HOME, undefined, 'the launcher does not pass a fake HOME');
  assert.equal(appEnv.XDG_CONFIG_HOME, undefined, 'the launcher does not pass fake XDG paths');
  assert.equal(appEnv.FARAVAN_HOME, undefined, 'the app data path comes from channel metadata');
  assert.equal(appEnv.FARAVAN_HOME, undefined, 'the app data path comes from channel metadata');
  assert.equal(appEnv.FARAVAN_DATA_HOME, join(env.XDG_DATA_HOME, `Faravan`));
  for (const key of ['FARAVAN_NO_AUTOSTART', 'FARAVAN_NO_UPDATE', 'FARAVAN_NO_BROWSER']) assert.equal(appEnv[key], '1', key);
  const { PATH: appPath, ...appWithoutPath } = appEnv;
  const { PATH: trayPath, ...trayWithoutPath } = trayEnv;
  const desktop = ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'KDE_SESSION_VERSION', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'XDG_SESSION_TYPE'];
  const actualApp = (await cliRuns(join(env.FAKE_SYSTEMD_STATE, `${APP_UNIT}.env`)))[0].env;
  const actualTray = (await cliRuns(join(env.FAKE_SYSTEMD_STATE, `${TRAY_UNIT}.env`)))[0].env;
  assert.equal(actualApp.PATH, expectedUnitPath, 'the app runs with the fixed PATH after the manager environment is applied');
  assert.equal(actualTray.PATH, expectedUnitPath, 'the tray runs with the fixed PATH after the manager environment is applied');
  assert.equal(actualApp.HOME, '/manager-home', 'the app keeps the user manager HOME');
  assert.equal(actualTray.HOME, '/manager-home', 'the tray keeps the user manager HOME');
  for (const key of desktop) {
    assert.equal(appEnv[key], undefined);
    assert.equal(actualApp[key], undefined, `manager ${key} cleared for app`);
    assert.equal(trayEnv[key], env[key]);
    assert.equal(actualTray[key], env[key]);
    delete trayWithoutPath[key];
  }
  for (const e of [appEnv, trayEnv, actualApp, actualTray]) {
    if (e.HOME !== undefined) assert.ok(!e.HOME.startsWith(iso), 'HOME is not changed to Faravan data');
    for (const key of ['XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_DATA_HOME','XDG_CACHE_HOME']) if (e[key] !== undefined) assert.ok(!e[key].startsWith(iso), key + ' is not changed to Faravan data');
  }
  assert.deepEqual(trayWithoutPath, appWithoutPath, 'the tray gets exactly the app environment, plus its session');
  assert.equal(appPath, expectedUnitPath);
  assert.equal(trayPath, expectedUnitPath);

  const cli = await cliRuns(env.PREVIEW_LOG);
  assert.equal(cli.length, 1, 'the final exec runs the bundled CLI once');
  assert.equal(cli[0].args, 'app', 'the final exec runs faravan app');
  assert.equal(cli[0].env.HOME, realHome, 'the foreground app keeps the caller home');

  assert.deepEqual(await readdir(realHome), [], 'nothing is written to the real home, so not to ~/.config/autostart');
});

test('relative XDG_DATA_HOME resolves once and the app, tray and CLI receive the same absolute folder', {timeout:60000}, async t => {
  const f = await fixture(t);
  await run(f.launcher, [], {env:{...f.env, XDG_DATA_HOME:'relative/data', FARAVAN_HOME:'/wrong/faravan'}});
  const expected = join(f.env.HOME, '.local/share', `Faravan`);
  const [app, tray] = await Promise.all(f.unitNames.map(async unit => (await cliRuns(join(f.env.FAKE_SYSTEMD_STATE, `${unit}.env`)))[0]));
  const cli = (await cliRuns(f.env.PREVIEW_LOG))[0];
  for (const execution of [app, tray, cli]) {
    assert.equal(execution.env.FARAVAN_DATA_HOME, expected);
    assert.equal(execution.env.FARAVAN_HOME, undefined);
    assert.equal(execution.env.FARAVAN_HOME, undefined);
  }
  assert.equal(expected.startsWith('/'), true);
});


for (const physicalName of ['plain-root', 'volume with spaces', 'volume-é']) {
}





for (const binding of ['root', 'data-home']) {
  test(`launcher refuses a failed ${binding} ancestor sync before service startup`, {timeout:60000}, async t => {
    const f = await fixture(t);
    const parent = binding === 'root' ? join(f.iso, '..') : join(f.env.HOME, '.local');
    const trace = join(f.work, `ancestor-${binding}.trace`);
    const fault = await migrationFault(f, 'ancestor-sync', parent);
    await assert.rejects(run(f.launcher, [], {env:{...f.env, ...fault, FARAVAN_TEST_TRACE:trace}}), /injected migration EIO/);
    const entries = (await readFile(trace, 'utf8')).trim().split('\n');
    assert.equal(entries.at(-1), parent, 'the containing directory sync was attempted');
    if (binding === 'data-home') assert.ok(entries.indexOf(f.env.HOME) < entries.indexOf(parent));
    assert.equal(await exists(f.env.FAKE_SYSTEMD_STATE), false);
    assert.equal(await exists(join(f.env.HOME, '.local/share', `Faravan`)), false);
  });
}

for (const faultKind of ['marker-write', 'marker-rename']) {
}




test('the final exec waits for an app unit that starts after systemd-run returns', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist'), iso = join(work, 'iso');
  await generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist, FARAVAN_PREVIEW_ROOT: iso,
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const launcher = join(await realpath(join(dist, NAME)), 'usr/bin', `${NAME}-launch`);
  const env = {PATH: process.env.PATH, HOME: join(work, 'real-home'), XDG_DATA_HOME: join(work, 'systemd/data'), FAKE_APP_DELAY: '1',
    FAKE_SYSTEMD_STATE: join(work, 'systemd'), FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log')};
  await mkdir(env.HOME, {recursive:true});
  if (env.XDG_DATA_HOME) await mkdir(env.XDG_DATA_HOME, {recursive:true});
  await run(launcher, [], { env });
  const log = await readFile(env.PREVIEW_LOG, 'utf8');
  assert.match(log, /^RECORD present$/m, 'the final exec ran only after the unit\'s app published its record');
});

test('a second launch starts no second app or tray unit', { timeout: 60000 }, async t => {
  const work = await scratch(t);
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  await generate({
    FARAVAN_PREVIEW_STAGE: stage, FARAVAN_PREVIEW_DIST: dist, FARAVAN_PREVIEW_ROOT: join(work, 'iso'),
    FARAVAN_PREVIEW_SYSTEMCTL: join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN: join(work, 'fake/systemd-run'),
  });
  const [APP_UNIT, TRAY_UNIT] = units(join(work, 'iso'), await realpath(join(dist, NAME)));
  const launcher = join(dist, NAME, 'usr/bin', `${NAME}-launch`);
  const env = {
    PATH: process.env.PATH, HOME: join(work, 'real-home'),
    FAKE_SYSTEMD_STATE: join(work, 'systemd'), FAKE_SYSTEMD_LOG: join(work, 'systemd.log'), PREVIEW_LOG: join(work, 'cli.log'),
  };
  await mkdir(env.HOME);

  await mkdir(env.HOME, {recursive:true});
  if (env.XDG_DATA_HOME) await mkdir(env.XDG_DATA_HOME, {recursive:true});
  await run(launcher, [], { env });
  await mkdir(env.HOME, {recursive:true});
  if (env.XDG_DATA_HOME) await mkdir(env.XDG_DATA_HOME, {recursive:true});
  await run(launcher, [], { env });

  const calls = await systemdCalls(env.FAKE_SYSTEMD_LOG);
  assert.deepEqual(calls.map(call => call.unit), [APP_UNIT, TRAY_UNIT], 'the second launch made no systemd-run call');
  assert.deepEqual(await duplicateCalls(env.FAKE_SYSTEMD_LOG), [], 'no unit was asked to start while active');
  assert.equal((await cliRuns(env.PREVIEW_LOG)).length, 2, 'each launch still opens the app, as before');
  assert.equal(await exists(join(env.HOME, '.config')), false, 'the second launch wrote nothing to the real home either');
});

async function fixture(t) {
  const work = await scratch(t);
  await mkdir(join(work, 'home'));
  await writeExecutable(join(work, 'fake/systemctl'), FAKE_SYSTEMCTL);
  await writeExecutable(join(work, 'fake/systemd-run'), FAKE_SYSTEMD_RUN);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist'), iso = join(work, 'iso');
  const config = {FARAVAN_PREVIEW_STAGE:stage, FARAVAN_PREVIEW_DIST:dist, FARAVAN_PREVIEW_ROOT:iso,
    FARAVAN_PREVIEW_SYSTEMCTL:join(work, 'fake/systemctl'), FARAVAN_PREVIEW_SYSTEMD_RUN:join(work, 'fake/systemd-run')};
  await generate(config);
  const bundle = await realpath(join(dist, NAME));
  return {work, config, iso, bundle, unitNames:units(iso, bundle), launcher:join(bundle, 'usr/bin', `${NAME}-launch`), env:{
    PATH:process.env.PATH, HOME:join(work, 'home'), FAKE_SYSTEMD_STATE:join(work, 'systemd'),
    FAKE_SYSTEMD_LOG:join(work, 'systemd.log'), PREVIEW_LOG:join(work, 'cli.log')}};
}

test('a failed first app start before v1 initialization permits a working retry', {timeout:60000}, async t => {
  const f = await fixture(t);
  const destination = join(f.env.HOME, '.local/share', `Faravan`);
  const executable = join(f.bundle, 'usr/bin/faravan');
  // Collect a failed stub process just as the real transient unit is collected.
  await writeExecutable(f.config.FARAVAN_PREVIEW_SYSTEMD_RUN, FAKE_SYSTEMD_RUN + String.raw`
status=$?
if [ "$status" -ne 0 ]; then rmdir "$FAKE_SYSTEMD_STATE/active/$unit"; fi
exit "$status"
`);
  await writeExecutable(executable, '#!/bin/sh\necho "EACCES first-start failure" >&2\nexit 23\n');
  let failure;
  await assert.rejects(run(f.launcher, [], {env:f.env}), error => {
    failure = error;
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unable to start preview app unit/);
    return true;
  });
  assert.equal(await exists(join(destination, 'v1')), false, 'the failed child initialized no device state');
  assert.equal(await exists(destination), true);

  await writeExecutable(executable, FAKE_CLI);
  await run(f.launcher, [], {env:f.env});
  assert.equal(JSON.parse(await readFile(join(destination, 'v1/state.json'), 'utf8')).version, 1);
  assert.equal(await exists(join(destination, 'v1/device.pem')), true);
  assert.equal(await exists(join(destination, 'preview-app-stderr.log')), false);
  const diagnostics = join(f.env.HOME, '.local/share', '.Faravan.diagnostics', 'preview-app-stderr.log');
  assert.ok(failure.stderr.includes(diagnostics), 'failure prints the actual sibling diagnostic path');
  assert.equal(await exists(diagnostics), true);
});

test('a repeat generated launch reuses a destination with a real running app lock', {timeout:60000}, async t => {
  const f = await fixture(t);
  await seedProfile(join(f.iso, 'state'));
  await run(f.launcher, [], {env:f.env});
  const destination = join(f.env.HOME, '.local/share', `Faravan`);
  const app = await startApp({home:destination, port:0, freshLending:'off'});
  try { await run(f.launcher, [], {env:f.env}); }
  finally { await app.close(); }
  assert.equal((await systemdCalls(f.env.FAKE_SYSTEMD_LOG)).length, 2);
  assert.deepEqual(await duplicateCalls(f.env.FAKE_SYSTEMD_LOG), []);
});

test('reserved collision labels and overlong labels are rejected', async t => {
  const f = await fixture(t);
  for (const label of ['x'.repeat(81), 'a..b', 'a.']) {
    await assert.rejects(generate(f.config, label), e => /LABEL|valid channel identity/.test(e.stderr));
  }
});


for (const role of ['app', 'tray']) {
  test(`retained failed ${role} is reset exactly once and restarted`, async t => {
    const f = await fixture(t);
    await run(f.launcher, [], {env:{...f.env, FAKE_RETAINED_ROLE:role}});
    const log = await readFile(f.env.FAKE_SYSTEMD_LOG, 'utf8');
    assert.deepEqual(log.split('\n').filter(l => l.startsWith('RESET ')), [`RESET ${f.unitNames[role === 'app' ? 0 : 1]}`]);
    assert.equal((await systemdCalls(f.env.FAKE_SYSTEMD_LOG)).length, 2);
  });
  test(`concurrent create winner for ${role} is reused without reset`, async t => {
    const f = await fixture(t);
    await run(f.launcher, [], {env:{...f.env, FAKE_RACE_ROLE:role}});
    assert.doesNotMatch(await readFile(f.env.FAKE_SYSTEMD_LOG, 'utf8'), /RESET/);
    assert.equal((await systemdCalls(f.env.FAKE_SYSTEMD_LOG)).length, 1);
  });
  test(`foreign retained ${role} is not reset and errors are visible`, async t => {
    const f = await fixture(t);
    const result = await run(f.launcher, [], {env:{...f.env, FAKE_RETAINED_ROLE:role, FAKE_FOREIGN:'1'}}).catch(e => e);
    assert.match(result.stderr, /Unable to start preview/);
    assert.doesNotMatch(await readFile(f.env.FAKE_SYSTEMD_LOG, 'utf8'), /RESET/);
    if (role === 'app') assert.equal(result.code, 1);
  });
  test(`ordinary ${role} creation errors are reported without recovery`, async t => {
    const f = await fixture(t);
    const result = await run(f.launcher, [], {env:{...f.env, FAKE_ERROR_ROLE:role}}).catch(e => e);
    assert.match(result.stderr, /Unable to start preview/);
    if (role === 'app') assert.equal(result.code, 1);
    assert.equal((await duplicateCalls(f.env.FAKE_SYSTEMD_LOG)).length, 0);
  });
  test(`active ${role} with the other unit missing starts only the missing unit`, async t => {
    const f = await fixture(t);
    // Start both units for real first, so the active app has migrated and published its
    // discovery record, as a running app has; readiness now requires that record.
    await run(f.launcher, [], {env:f.env});
    const missing = f.unitNames[role === 'app' ? 1 : 0];
    await rm(join(f.env.FAKE_SYSTEMD_STATE, 'active', missing), {recursive:true, force:true});
    await writeFile(f.env.FAKE_SYSTEMD_LOG, '');
    await run(f.launcher, [], {env:f.env});
    assert.deepEqual((await systemdCalls(f.env.FAKE_SYSTEMD_LOG)).map(c => c.unit), [missing]);
  });
}

test('parallel launches create each unit once and unset desktop vars clear manager values', async t => {
  const f = await fixture(t);
  await Promise.all([run(f.launcher, [], {env:f.env}), run(f.launcher, [], {env:f.env})]);
  assert.deepEqual((await systemdCalls(f.env.FAKE_SYSTEMD_LOG)).map(c => c.unit), f.unitNames);
  assert.deepEqual(await duplicateCalls(f.env.FAKE_SYSTEMD_LOG), []);
  const tray = (await cliRuns(join(f.env.FAKE_SYSTEMD_STATE, `${f.unitNames[1]}.env`)))[0].env;
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR', 'XAUTHORITY']) assert.equal(tray[key], undefined);
});

// Exercise the actual wait function with a deterministic synthetic clock/manager.
// These are boundary regressions, not app ownership or real-systemd acceptance.
for (const [scenario, state, record, wasActive] of [
  ['accepted then crashed', 'inactive', 'none', 'no'],
  ['activating beyond deadline', 'activating', 'none', 'no'],
  ['stale discovery record', 'active', 'old', 'no'],
  ['previously active service died', 'failed', 'old', 'yes'],
]) {
  test('readiness refuses foreground fallback: ' + scenario, async () => {
    const source = await readFile(generator, 'utf8');
    const body = source.match(/wait_app_unit\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(body);
    const script = [
      body,
      'manager() { case "$*" in *ActiveState*) echo "$STATE" ;; *is-active*) [ "$STATE" = active ] ;; *) return 2 ;; esac; }',
      'stat() { [ "$RECORD" != none ] || return 1; echo "$RECORD"; }',
      'sleep() { :; }',
      'systemctl=manager; app_unit=synthetic.service; app_record=unused',
      'app_record_before=old; app_was_active="$WAS_ACTIVE"',
      'wait_app_unit || exit 31',
      'echo FOREGROUND',
    ].join('\n');
    await assert.rejects(run('sh', ['-c', script], {
      env: {PATH:process.env.PATH, STATE:state, RECORD:record, WAS_ACTIVE:wasActive},
    }), error => {
      assert.equal(error.code, 31);
      assert.doesNotMatch(error.stdout, /FOREGROUND/);
      assert.match(error.stderr, /readiness/);
      return true;
    });
  });
}

test('unit-property-only rebuild changes identity and identical specification is a no-op', {timeout:60000}, async t => {
  const work = await scratch(t);
  const stage = await stagedTree(join(work, 'stage'));
  const dist = join(work, 'dist');
  const env = {PATH:process.env.PATH, HOME:'/nonexistent',
    FARAVAN_PREVIEW_STAGE:stage, FARAVAN_PREVIEW_DIST:dist,
    FARAVAN_PREVIEW_ROOT:join(work, 'iso')};
  const launcher = join(dist, NAME, 'usr/bin', NAME + '-launch');
  const identity = async () => (await readFile(launcher, 'utf8')).match(/^build_identity='([a-f0-9]{64})'$/m)[1];
  await generate(env);
  const before = await identity();
  await generate(env);
  assert.equal(await identity(), before, 'unchanged tree and effective template reuse identity');
  const source = await readFile(generator, 'utf8');
  // Run a property-only variant without editing repository source.
  const variant = source.replace(/^package_dir=.*$/m, 'package_dir=' + JSON.stringify(join(root, 'packaging')))
    .replace('--property=StandardError=null', '--property=StandardError=journal');
  assert.notEqual(variant, source);
  await run('bash', ['-c', variant, 'property-only-test', LABEL], {env});
  assert.notEqual(await identity(), before, 'a systemd property is part of identity');
});

test('diagnostic app unit keeps the app command tail and launches that exact child', {timeout:60000}, async t => {
  const f = await fixture(t);
  await run(f.launcher, [], {env:f.env});
  const [appCall] = await systemdCalls(f.env.FAKE_SYSTEMD_LOG);
  const destination = join(f.env.HOME, '.local/share', `Faravan`);
  assert.deepEqual(appCall.args.slice(-5), [
    '--app', destination, join(f.bundle, 'usr/bin/faravan'), 'app', '--json',
  ], 'the diagnostics wrapper retains the public app command tail');
  const actual = await cliRuns(join(f.env.FAKE_SYSTEMD_STATE, `${appCall.unit}.env`));
  assert.equal(actual[0].args, 'app --json', 'the app child receives no wrapper arguments');
  assert.ok(appCall.args.includes('--property=KillMode=control-group'));
  assert.ok(appCall.args.includes('--property=StandardError=null'));
  assert.equal(await exists(join(destination, 'preview-app-stderr.log')), false, 'diagnostics never contaminate the profile');
  assert.equal(await exists(join(f.env.HOME, '.local/share', '.Faravan.diagnostics', 'preview-app-stderr.log')), true, 'the diagnostics wrapper still runs');
});
