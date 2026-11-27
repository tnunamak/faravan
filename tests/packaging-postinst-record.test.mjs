import './helpers/no-browser.mjs';
// The deb postinst's install record (design §3.4 install.run). The real packaging/scripts/postinstall.sh runs in a
// temporary home, against stubs for systemctl and the faravan CLI and a real socket as the session bus. Each outcome it
// can reach must leave one file that the app's own parser accepts, with the generation the policy names.
import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInboxFile } from '../lib/v1/telemetry/catalog.mjs';
import { project } from '../lib/v1/telemetry/projection.mjs';
import { writeCrashFile, writeInstallRun } from '../lib/v1/telemetry/crash.mjs';
import {createConsent} from '../lib/v1/telemetry/consent.mjs';
import { makeTelemetry, settle } from './helpers/telemetry-harness.mjs';
import { telemetryApp } from './helpers/telemetry-app.mjs';
import { api } from './helpers/v1-app-fixture.mjs';

const postinstRoots=new Set();
afterEach(()=>{for(const root of postinstRoots)rmSync(root,{recursive:true,force:true});postinstRoots.clear();});
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTINST = join(ROOT, 'packaging', 'scripts', 'postinstall.sh');
const LIB = join(ROOT, 'lib');
const POLICY_ON_GEN_3 = '{"version":2,"level":"on","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}';

// A systemctl --user that keeps the unit's state in $FAKE_STATE/active, and a faravan CLI that quits by removing it.
const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >> "$FAKE_STATE/log"
case "$*" in
  "--user daemon-reload"|"--user disable "*) exit 0 ;;
  "--user enable --now "*) [ "$FAKE_ENABLE" = ok ] || exit 1; : > "$FAKE_STATE/active"; exit 0 ;;
  "--user is-active --quiet "*) [ -e "$FAKE_STATE/active" ]; exit $? ;;
  "--user start "*) [ "$FAKE_START" = ok ] || exit 1; : > "$FAKE_STATE/active"; exit 0 ;;
  *) exit 0 ;;
esac
`;
const CLI = `#!/bin/sh
echo "faravan $*" >> "$FAKE_STATE/log"
case "$*" in
  "update status --json") [ -n "$FAKE_RUNNING" ] && printf '{"currentVersion":"%s"}\\n' "$FAKE_RUNNING"; exit 0 ;;
  "app quit --yes --json") rm -f "$FAKE_STATE/active"; exit "\${FAKE_QUIT:-0}" ;;
  "app info --json") if [ "$FAKE_INFO" = running ]; then echo '{"running":true}'; exit 0; fi; exit 1 ;;
  *) exit 0 ;;
esac
`;

/**
 * Runs postinst configure [previous] in a fresh temporary home. Returns the app home and the stub log, and the exit code.
 * `session` false leaves out the session bus, which is the "no user session" case. `info: 'running'` makes the CLI report an
 * app the person started by hand; `tray` is a path to a process named faravan-tray to stand in for the old tray.
 */
async function runPostinst({previous = '', session = true, active = false, policy = POLICY_ON_GEN_3, lease = true, now=Date.now(), systemctl = {}, cli = {}, tray = null, trayPid = null, env = {}}) {
  const root = mkdtempSync(join(tmpdir(), 'faravan-postinst-'));postinstRoots.add(root);
  const stubs = join(root, 'stubs'), state = join(root, 'state'), home = join(root, 'home'), app = join(root, 'app');
  const procRoot = join(root, 'proc');
  for (const dir of [stubs, state, home, app, procRoot]) mkdirSync(dir, {recursive: true});
  if (trayPid !== null) symlinkSync(`/proc/${trayPid}`, join(procRoot, String(trayPid)));
  writeFileSync(join(stubs, 'systemctl'), SYSTEMCTL);
  writeFileSync(join(root, 'faravan'), CLI);
  chmodSync(join(stubs, 'systemctl'), 0o755);
  chmodSync(join(root, 'faravan'), 0o755);
  const runtime = join(root, 'run');
  mkdirSync(runtime, {recursive: true});
  // A real socket file stands in for the session bus; the script only tests that it exists and is owned by us.
  const bus = session ? createServer() : null;
  if (bus) await new Promise(resolve => bus.listen(join(runtime, 'bus'), resolve));
  if (policy !== null) mkdirSync(join(app, 'v1', 'telemetry'), {recursive: true}), writeFileSync(join(app, 'v1', 'telemetry', 'policy.json'), policy);
  if(policy!==null&&lease){const c=createConsent({dir:join(app,'v1','telemetry'),base:root,uploadable:true,now:()=>now});c.grantRemoteLease(c.current().generation);}
  // The unit is running before the upgrade: the app is the old version and must be restarted.
  if (active) writeFileSync(join(state, 'active'), '');
  if (cli.running === undefined) cli.running = '';
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn('sh', [POSTINST, 'configure', ...(previous ? [previous] : [])], {env: {
        PATH: `${stubs}:${process.env.PATH}`, HOME: home, FARAVAN_HOME: app, FAKE_STATE: state,
        DPKG_MAINTSCRIPT_PACKAGE: 'faravan-test', FARAVAN_REMOVAL_TEST_STATE_DIR: join(root, 'removal-state'),
        FAKE_ENABLE: systemctl.enable ?? 'ok', FAKE_START: systemctl.start ?? 'ok', FAKE_QUIT: String(cli.quit ?? 0), FAKE_RUNNING: cli.running,
        FAKE_INFO: cli.info ?? '',
        FARAVAN_POSTINST_CLI: join(root, 'faravan'), FARAVAN_POSTINST_RUNTIME_DIR: runtime,
        FARAVAN_POSTINST_PROC_ROOT: procRoot,
        FARAVAN_POSTINST_TRAY: tray ?? join(root, 'no-tray'),
        FARAVAN_POSTINST_NODE: process.execPath, FARAVAN_POSTINST_LIB: LIB, FARAVAN_POSTINST_CLI_TIMEOUT: '5', ...env,
      }, stdio: ['ignore', 'pipe', 'pipe']});
      child.on('error', reject);
      child.on('exit', resolve);
    });
    const log = existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '';
    const telemetry = join(app, 'v1', 'telemetry', 'inbox');
    const files = existsSync(telemetry) ? readdirSync(telemetry).filter(name => name.endsWith('.json')) : [];
    return {exit, log, files: files.map(name => readFileSync(join(telemetry, name), 'utf8')), root};
  } finally {
    if (bus) await new Promise(resolve => bus.close(resolve));
  }
}

function seedInstaller(dir){writeFileSync(join(dir,'policy.json'),POLICY_ON_GEN_3);const c=createConsent({dir,base:dir,uploadable:true});c.grantRemoteLease(c.current().generation);}

const skipAsRoot = process.getuid?.() === 0 ? 'the stubs model a user session; run as a normal user' : false;

test('producer inputs containing user content stay out of queued and uploaded events', {skip: skipAsRoot, timeout: 60000}, async t => {
  const canaries = ['/home/alice/private', '/workspace/payroll/repo', 'rewrite my private payroll prompt', 'alice@example.com'];
  const content = canaries.join(' ');
  const root = mkdtempSync(join(tmpdir(), 'producer-privacy-'));
  const appHome = join(root, 'app');
  const h = makeTelemetry({dir: join(appHome, 'v1', 'telemetry'), base: root});
  const assertClean = (value, where) => {
    const text = JSON.stringify(value);
    for (const canary of canaries) assert.ok(!text.includes(canary), `${where} contains ${canary}`);
  };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    // Assert the projection itself too: catalog validation may otherwise mask a missing projection filter.
    const input = {status: 500, body: {code: content, message: content}, writer: 'app', surface: 'http'};
    assertClean(project('response', input, {}), 'projection');
    const live = await telemetryApp(t);
    await api(live.app, '/api/telemetry/ui', {method: 'POST', body: {records: [{kind: 'error_banner', route: 'home',
      op: 'jobs.list', code: 'not_found', message: content, path: content, prompt: content, email: content}]}});
    const liveHome = await live.f.home('owner');
    const cli = spawn(process.execPath, [join(ROOT, 'bin', 'faravan'), 'update', 'status', '--json'], {env: {...process.env,
      FARAVAN_HOME: liveHome, DO_NOT_TRACK: '0', FARAVAN_NO_TELEMETRY: '0', FARAVAN_NO_AUTOSTART: '1', CANARY_INPUT: content}, stdio: 'ignore'});
    assert.equal(await new Promise((resolve, reject) => { cli.on('error', reject); cli.on('exit', resolve); }), 0);
    live.clock.advance(2 * 86400000);
    live.tel.tick();
    const liveQueued = live.tel.preview().items.filter(item => item.state === 'queued');
    assert.ok(liveQueued.length > 0, 'the app and CLI queued events');
    const liveRecords = liveQueued.map(item => JSON.parse(item.body));
    assert.ok(liveRecords.some(record => record.name === 'ui.friction'), 'the app recorded the supplied UI event');
    assert.ok(liveRecords.some(record => record.name === 'op.count' && record.attrs.surface === 'cli'), 'the real CLI recorded an operation');
    assertClean(liveQueued, 'app and CLI queue');
    live.clock.advance(60 * 60000);
    await live.tel.flushNow();
    assert.ok(live.transport.records().length > 0, 'the app and CLI uploaded events');
    assertClean(live.transport.bodies(), 'app and CLI upload');
    for (const [writer, surface] of [['app', 'ui'], ['ops', 'cli']]) {
      h.tel.response({writer, req: {url: '/api/jobs', headers: {'faravan-surface': surface}}, status: 500,
        body: {code: content, message: content, path: content, prompt: content, email: content}, opId: 'jobs.list'});
    }
    h.clock.set(Date.now());h.tel.tick();
    h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'run', message: content, path: content});
    assert.ok(writeCrashFile({dir: h.dir, env: {}, kind: 'start_failed', error: new Error(content), now: h.clock.now}));
    assert.equal(writeInstallRun({dir: h.dir, env: {}, method: content, outcome: content, durationMs: 1}), false);
    assert.equal(writeInstallRun({dir: h.dir, env: {}, method: 'tarball', outcome: 'restart_failed', durationMs: 1, now:h.clock.now, message: content}), true);
    const policy = readFileSync(join(h.dir, 'policy.json'), 'utf8');
    const postinst = await runPostinst({policy, now:h.clock.now(), env: {CANARY_INPUT: content, FAKE_RUNNING: content}});
    assert.equal(postinst.files.length, 1);
    writeFileSync(join(h.dir, 'inbox', 'postinst.json'), postinst.files[0]);
    mkdirSync(join(root, 'coord'), {recursive: true});
    const coord = spawn(process.execPath, [join(ROOT, 'bin', 'faravan-coordinator')], {env: {PATH: process.env.PATH, HOME: root,
      FARAVAN_HOME: appHome, FARAVAN_COORDINATOR_HOME: join(root, 'coord'), FARAVAN_COORDINATOR_HOST: '127.0.0.1',
      FARAVAN_COORDINATOR_PORT: String(server.address().port), FARAVAN_COORDINATOR_V1_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      CANARY_INPUT: content}, stdio: 'ignore'});
    assert.equal(await new Promise((resolve, reject) => { coord.on('error', reject); coord.on('exit', resolve); }), 1);
    // The exact destination in retained exposure state is invalid. None of it may reach telemetry.
    writeFileSync(join(root,'coord','exposure.json'),JSON.stringify({
      spec:{target:content},routeOperationId:'canary-fixture-operation',
    }),{mode:0o600});
    const free = createServer();
    await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));
    const hostConfig = join(root, 'coord', 'host.json');
    writeFileSync(hostConfig, JSON.stringify({protocol_version: 1, port, v1_origin: `http://127.0.0.1:${port}`, keep_awake: false,
      status_path: join(root, 'coord', 'status.json'), data_dir: join(root, 'coord', 'tasks'),
      reachability:{kind:'gozar'}}));
    const tunnel = spawn(process.execPath, [join(ROOT, 'bin', 'faravan-coordinator'), '--host-config', hostConfig], {env: {
      PATH: process.env.PATH, HOME: root, FARAVAN_HOME: appHome, FARAVAN_COORDINATOR_HOME: join(root, 'coord'), CANARY_INPUT: content}, stdio: 'ignore'});
    assert.equal(await new Promise((resolve, reject) => { tunnel.on('error', reject); tunnel.on('exit', resolve); }), 1);
    // The legacy Go producer rejects v2 policy. Exercise its content filter in its own legacy home;
    // its old envelope must still fail closed when the current app ingests it without capture proof.
    const legacyTray=join(root,'legacy-tray');mkdirSync(legacyTray);writeFileSync(join(legacyTray,'policy.json'),'{"version":1,"level":"counts","region":null,"noticeShownAt":1,"decidedAt":1,"generation":3}');
    const tray = spawn('go', ['test', '-run', '^TestPrivacyJourneyWriter$', './internal/telemetry'], {cwd: join(ROOT, 'tray'),
      env: {...process.env, DO_NOT_TRACK: '', FARAVAN_PRIVACY_TEST_DIR: legacyTray, CANARY_INPUT: content}, stdio: 'pipe'});
    let trayError = '';
    tray.stderr.on('data', chunk => { trayError += chunk; });
    assert.equal(await new Promise((resolve, reject) => { tray.on('error', reject); tray.on('exit', resolve); }), 0, trayError);
    for(const name of readdirSync(join(legacyTray,'inbox')))copyFileSync(join(legacyTray,'inbox',name),join(h.dir,'inbox','legacy-tray-'+name));
    const inbox = readdirSync(join(h.dir, 'inbox')).map(name => readFileSync(join(h.dir, 'inbox', name), 'utf8'));
    assert.ok(inbox.some(text => JSON.parse(text).origin === 'tray'));
    assert.ok(inbox.filter(text => JSON.parse(text).origin === 'coordinator').length >= 3, 'listener and tunnel failures wrote coordinator records');
    assert.ok(inbox.some(text => JSON.parse(text).origin === 'installer'));
    assertClean(inbox, 'inbox');
    h.clock.set(Date.now());h.tel.tick();h.tel.ingestInbox();
    assert.ok(!h.tel.preview().items.some(item=>JSON.parse(item.body).origin==='tray'),'legacy producer records without capture proof are rejected');
    h.clock.advance(2 * 86400000);
    h.tel.tick();
    const queued = h.tel.preview().items.filter(item => item.state === 'queued');
    assert.ok(queued.length > 0, 'the journey queued events');
    assertClean(queued, 'queue');
    const outbox = join(h.dir, 'outbox');
    const segments = readdirSync(outbox).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(outbox, name), 'utf8'));
    assert.ok(segments.length > 0, 'queue segments exist');
    assertClean(segments, 'queue segments');
    await settle(h, {hours: 30});
    assert.ok(h.transport.records().length > 0, 'the journey uploaded events');
    assertClean(h.transport.bodies(), 'upload');
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.cleanup();rmSync(root,{recursive:true,force:true});
  }
});

function recordOf(text) {
  const parsed = parseInboxFile(text);
  assert.equal(parsed.origin, 'installer');
  assert.equal(parsed.record.name, 'install.run');
  assert.equal(parsed.record.kind, 'span');
  assert.ok(Number.isInteger(parsed.record.duration_ms) && parsed.record.duration_ms >= 0);
  return parsed;
}

// Waits until a process has exec'd a binary of this name (its comm), so the postinst sees it as a tray.
async function waitForComm(pid, name) {
  for (let i = 0; i < 50; i++) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === name) return;
    } catch { /* not started yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`process ${pid} did not become ${name}`);
}

test('a first install without a shown notice records nothing', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({policy:null});
  assert.equal(run.exit, 0);assert.deepEqual(run.files,[]);
  const disabled=await runPostinst({lease:false});assert.deepEqual(disabled.files,[],'a noticed policy without a remote flag still records nothing');
});

test('no user session records session_unknown, and the install still succeeds', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({session: false});
  assert.equal(run.exit, 0, 'a missing session must not fail dpkg');
  const parsed = recordOf(run.files[0]);
  assert.equal(parsed.record.attrs.outcome, 'session_unknown');
  assert.equal(parsed.record.status, 'error');
});

test('a unit that will not enable on a first install records restart_failed', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({systemctl: {enable: 'fail'}});
  assert.equal(run.exit, 0);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'restart_failed');
});

test('an upgrade whose app refuses to quit records quit_unanswered', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0', active: true, cli: {quit: 1}});
  assert.equal(run.exit, 0);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'quit_unanswered');
});

test('an upgrade whose app is busy with a job is left running, and records deferred: not ok, not a failure', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0', active: true, cli: {quit: 4}});
  assert.equal(run.exit, 0);
  const parsed = recordOf(run.files[0]);
  assert.equal(parsed.record.attrs.outcome, 'deferred');
  assert.equal(parsed.record.status, 'error');
});

test('an upgrade that leaves an app you started yourself running records deferred', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0', cli: {info: 'running'}});
  assert.equal(run.exit, 0);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'deferred');
});

test('an upgrade whose tray cannot be replaced records tray_restart_failed', {skip: skipAsRoot}, async () => {
  // A copy of the shell named faravan-tray stands in for the old tray. It is a standalone binary, so it keeps the name it was
  // started under (multi-call binaries such as coreutils and node do not), and its exe is the path the postinst inspects. It
  // waits on stdin, so it stays up until it is stopped. The relaunch starts no tray, so the replacement is not running.
  const root = mkdtempSync(join(tmpdir(), 'faravan-postinst-tray-'));
  const tray = join(root, 'faravan-tray');
  copyFileSync(realpathSync('/bin/sh'), tray);
  chmodSync(tray, 0o755);
  const old = spawn(tray, ['-c', 'read line'], {env: {PATH: process.env.PATH, HOME: root}, stdio: ['pipe', 'ignore', 'ignore']});
  try {
    await waitForComm(old.pid, 'faravan-tray');
    const run = await runPostinst({previous: '0.1.0', tray, trayPid: old.pid});
    assert.equal(run.exit, 0);
    const parsed = recordOf(run.files[0]);
    assert.equal(parsed.record.attrs.outcome, 'tray_restart_failed');
    assert.equal(parsed.record.status, 'error');
  } finally {
    old.kill('SIGKILL');
    rmSync(root, {recursive: true, force: true});
  }
});

test('an upgrade that quits, restarts and reports the new version records ok', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0', active: true, cli: {quit: 0, running: ''}});
  assert.equal(run.exit, 0);
  assert.match(run.log, /systemctl --user start/);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'ok');
});

test('an upgrade that cannot start the unit again records restart_failed', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0', active: true, cli: {quit: 0}, systemctl: {start: 'fail'}});
  assert.equal(run.exit, 0);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'restart_failed');
});

test('an upgrade of an app that was not running records ok and starts nothing', {skip: skipAsRoot}, async () => {
  const run = await runPostinst({previous: '0.1.0'});
  assert.equal(run.exit, 0);
  assert.doesNotMatch(run.log, /app quit/);
  assert.equal(recordOf(run.files[0]).record.attrs.outcome, 'ok');
});

test('the record carries the generation the policy names, and an off policy writes nothing', {skip: skipAsRoot}, async () => {
  const enabled = await runPostinst({policy: POLICY_ON_GEN_3});
  assert.equal(recordOf(enabled.files[0]).gen, 3);
  const off = await runPostinst({policy: '{"version":1,"level":"off","region":null,"noticeShownAt":1,"decidedAt":1,"generation":4}'});
  assert.equal(off.exit, 0);
  assert.deepEqual(off.files, []);
  const switched = await runPostinst({policy: POLICY_ON_GEN_3, env: {FARAVAN_NO_TELEMETRY: '1'}});
  assert.equal(switched.exit, 0);
  assert.deepEqual(switched.files, []);
});

test('the record writer takes both install methods, marks every non-ok outcome as an error, and rejects values the catalog does not list', async t => {
  const {writeInstallRun} = await import('../lib/v1/telemetry/crash.mjs');
  const dirs=[];t.after(()=>dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
  const dirOf = () => {const dir=mkdtempSync(join(tmpdir(), 'faravan-install-record-'));dirs.push(dir);seedInstaller(dir);return dir;};
  const written = (dir, options) => {
    const ok = writeInstallRun({dir, env: {}, ...options});
    const names = existsSync(join(dir, 'inbox')) ? readdirSync(join(dir, 'inbox')) : [];
    return {ok, parsed: names.length ? parseInboxFile(readFileSync(join(dir, 'inbox', names[0]), 'utf8')) : null};
  };
  const tarball = dirOf();
  const bad = written(tarball, {method: 'tarball', outcome: 'tray_restart_failed', durationMs: 1500});
  assert.equal(bad.ok, true);
  assert.equal(bad.parsed.record.status, 'error');
  assert.deepEqual({...bad.parsed.record.attrs}, {method: 'tarball', outcome: 'tray_restart_failed'});
  assert.equal(written(dirOf(), {method: 'deb', outcome: 'ok', durationMs: 0}).parsed.record.status, 'ok');
  assert.equal(written(dirOf(), {method: 'brew', outcome: 'ok', durationMs: 0}).ok, true, 'brew is a live install method');
  assert.equal(written(dirOf(), {method: 'deb', outcome: 'exploded', durationMs: 0}).ok, false, 'an outcome outside the catalog is never written');
});

test('deferred is written at schema 2, the version that made it live; ok stays at schema 1', async t => {
  const {writeInstallRun} = await import('../lib/v1/telemetry/crash.mjs');
  const parseWritten = outcome => {
    const dir = mkdtempSync(join(tmpdir(), 'faravan-install-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));seedInstaller(dir);
    assert.equal(writeInstallRun({dir, env: {}, method: 'deb', outcome, durationMs: 0}), true);
    return parseInboxFile(readFileSync(join(dir, 'inbox', readdirSync(join(dir, 'inbox'))[0]), 'utf8'));
  };
  const deferred = parseWritten('deferred');
  assert.equal(deferred.schemaVersion, 2);
  assert.equal(deferred.record.attrs.outcome, 'deferred');
  assert.equal(deferred.record.status, 'error');
  assert.equal(parseWritten('ok').schemaVersion, 1);
});

test('a root run with SUDO_USER=root writes nothing into root\'s app home', {skip: skipAsRoot}, async () => {
  // Stubs stand in for root: id reports 0, runuser runs its command here, and systemctl finds no session. The root path
  // then takes the name root, which is the case a review found writing into root's home before this guard.
  const root = mkdtempSync(join(tmpdir(), 'faravan-postinst-root-'));
  const stubs = join(root, 'stubs'), app = join(root, 'app'), home = join(root, 'home');
  for (const dir of [stubs, app, home]) mkdirSync(dir, {recursive: true});
  writeFileSync(join(stubs, 'id'), '#!/bin/sh\ncase "$*" in\n  "-u") echo 0 ;;\n  "-u -- root") echo 0 ;;\n  *) /usr/bin/id "$@" ;;\nesac\n');
  writeFileSync(join(stubs, 'runuser'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n');
  writeFileSync(join(stubs, 'systemctl'), '#!/bin/sh\nexit 1\n');
  for (const name of ['id', 'runuser', 'systemctl']) chmodSync(join(stubs, name), 0o755);
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn('sh', [POSTINST, 'configure'], {env: {PATH: `${stubs}:/usr/bin:/bin`, HOME: home, SUDO_USER: 'root', SUDO_UID: '0',
        DPKG_MAINTSCRIPT_PACKAGE: 'faravan-test', FARAVAN_REMOVAL_TEST_STATE_DIR: join(root, 'removal-state'),
        FARAVAN_HOME: app, FARAVAN_POSTINST_LIB: LIB, FARAVAN_POSTINST_NODE: process.execPath, FARAVAN_POSTINST_CLI_TIMEOUT: '5'}, stdio: ['ignore', 'pipe', 'pipe']});
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(exit, 0, 'the install still completes');
    assert.equal(existsSync(join(app, 'v1', 'telemetry', 'inbox')), false, 'nothing is written into the root app home');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('the script is valid sh', () => {
  const check = spawn('sh', ['-n', POSTINST]);
  return new Promise((resolve, reject) => {
    check.on('error', reject);
    check.on('exit', code => (code === 0 ? resolve() : reject(new Error('sh -n failed'))));
  });
});
