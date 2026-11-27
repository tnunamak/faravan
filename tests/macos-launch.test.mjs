import './helpers/no-browser.mjs';
// The macOS launch supervisor (lib/v1/macos-launch.mjs). Faravan.app's native faravan-launch runs it with a pipe as
// standard input. The unit tests inject every boundary. The process tests run the real module and the real app in a
// temporary home, with a shell script in place of the tray. Linux runs them; Finder, LaunchServices and logout need a Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { parseLaunchArgs, superviseMacLaunch, handoffFor } from '../lib/v1/macos-launch.mjs';
import * as macLaunch from '../lib/v1/macos-launch.mjs';

const MODULE = fileURLToPath(new URL('../lib/v1/macos-launch.mjs', import.meta.url));
const SWIFT = fileURLToPath(new URL('../packaging/macos/launcher/main.swift', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const busy = () => Object.assign(new Error('busy'), {code:'lock_busy'});
const FOUND = {origin:'http://127.0.0.1:4100', token:'session-secret', pid:4242};
const HANDOFF = 'http://127.0.0.1:4100/auth/handoff?code=once';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function fakeTray() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.exitCode = null; child.signalCode = null;
  Object.defineProperty(child, 'ended', {get:() => child.stdin.writableEnded});
  child.exit = (code = 0) => { child.exitCode = code; child.emit('exit', code, null); };
  child.kill = () => true;
  return child;
}
function fakeApp() {
  const server = new EventEmitter();
  const app = {server, closed:0, handoffUrl:() => HANDOFF,
    close:async () => { app.closed++; }};
  return app;
}
function io(overrides = {}) {
  const calls = {opened:[], trays:[], started:0, released:0, handoffs:0};
  const owner = deferred();
  const base = {
    home:'/home/someone/.faravan', trayPath:'/Apps/Faravan.app/Contents/MacOS/faravan-tray', background:false,
    ownerGone:owner.promise,
    acquireLock:async () => () => { calls.released++; },
    discover:async () => null,
    startApp:async () => { calls.started++; return calls.app = fakeApp(); },
    requestHandoff:async () => { calls.handoffs++; return HANDOFF; },
    openUrl:url => { calls.opened.push(url); },
    spawnTray:path => { const child = fakeTray(); calls.trays.push({path, child}); return child; },
    sleep:async () => {},
    log:() => {},
    waitMs:200,
  };
  return {calls, owner, options:{...base, ...overrides}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check()); }

// Direct boundary tests: no source extraction or evaluation.
function shutdownFixture() {
  const stdin = new EventEmitter(), signals = new EventEmitter(), timers = new Map();
  const exits = [], exitCodes = [], input = [];
  let now = 0, next = 0;
  stdin.resume = () => input.push('resume');
  stdin.pause = () => input.push('pause');
  stdin.destroy = () => input.push('destroy');
  assert.equal(typeof macLaunch.createMacLaunchShutdown, 'function', 'shutdown boundary is exported');
  const shutdown = macLaunch.createMacLaunchShutdown({
    stdin, signals, exit:code => exits.push({code, at:now}),
    setExitCode:code => exitCodes.push(code),
    setTimeout:(fn, ms) => { const id = ++next; timers.set(id, {fn, at:now + ms}); return id; },
    clearTimeout:id => timers.delete(id),
  });
  const advance = async ms => {
    const end = now + ms;
    await tick();
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await tick();
    }
    now = end; await tick();
  };
  return {shutdown, stdin, signals, exits, exitCodes, input, timers, advance};
}

test('shutdown: a never-closing tray is bounded before waiting for full app close', async () => {
  const f = shutdownFixture(), tray = deferred(), app = deferred();
  const done = f.shutdown.finish({trayExits:[tray.promise], appClosed:app.promise});
  await f.advance(9999);
  assert.deepEqual(f.exits, []); assert.deepEqual(f.input, ['resume']);
  await f.advance(1);
  assert.deepEqual(f.exits, [], 'tray timeout must not interrupt app cleanup');
  assert.deepEqual(f.input, ['resume', 'pause', 'destroy']);
  await f.advance(5000);
  assert.deepEqual(f.exits, [], 'no five-second forced exit during app cleanup');
  app.resolve({state:'closed'});
  assert.equal(await done, false, 'a closed app cannot prove a tray that timed out has drained');
  assert.deepEqual(f.exits, [{code:0, at:15000}]);
  assert.equal(f.timers.size, 0);
});

test('shutdown: a never-closing app gets the full 30-second fallback after the tray bound', async () => {
  const f = shutdownFixture();
  const done = f.shutdown.finish({trayExits:[deferred().promise], appClosed:deferred().promise});
  await f.advance(10000);
  await f.advance(29999);
  assert.deepEqual(f.exits, []);
  await f.advance(1); await done;
  assert.deepEqual(f.exits, [{code:0, at:40000}]);
  assert.equal(f.timers.size, 0);
});

test('shutdown: cooperative tray still gives a never-closing app 30 seconds', async () => {
  const f = shutdownFixture();
  const done = f.shutdown.finish({trayExits:[Promise.resolve()], appClosed:deferred().promise});
  await f.advance(29999); assert.deepEqual(f.exits, []);
  await f.advance(1); await done;
  assert.deepEqual(f.exits, [{code:0, at:30000}]);
  assert.equal(f.timers.size, 0);
});

test('shutdown: second signals exit immediately before shutdown and during either wait', async () => {
  for (const stage of ['startup', 'tray', 'app']) {
    for (const first of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      for (const second of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const f = shutdownFixture(), tray = deferred(), app = deferred();
        f.signals.emit(first);
        assert.equal(await f.shutdown.ownerGone, 'owner');
        let done;
        if (stage !== 'startup') done = f.shutdown.finish({trayExits:[tray.promise], appClosed:app.promise});
        if (stage === 'app') { tray.resolve(); await tick(); }
        assert.deepEqual(f.exits, []);
        f.signals.emit(second);
        assert.deepEqual(f.exits, [{code:0, at:0}], stage + ': ' + first + ', ' + second);
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.equal(f.signals.listenerCount(signal), 1);
        tray.resolve(); app.resolve({state:'closed'});
        if (done) assert.equal(await done, false, 'a forced exit cannot acknowledge a late close');
        assert.equal(f.exits.length, 1, 'returning fake exit does not cause a second exit');
        assert.equal(f.timers.size, 0);
      }
    }
  }
});

test('shutdown: normal quit reaps a cooperative tray and drains the app without forced exit', async () => {
  const f = shutdownFixture(), tray = deferred(), app = deferred();
  f.stdin.emit('data', Buffer.from('quit\n')); f.stdin.emit('end');
  assert.equal(await f.shutdown.ownerGone, 'quit');
  const done = f.shutdown.finish({trayExits:[tray.promise], appClosed:app.promise});
  tray.resolve(); await tick();
  assert.deepEqual(f.exits, []); assert.deepEqual(f.exitCodes, []);
  app.resolve(); await done;
  assert.deepEqual(f.exits, []); assert.deepEqual(f.exitCodes, [0]);
  assert.deepEqual(f.input, ['resume', 'pause', 'destroy']);
  assert.equal(f.timers.size, 0);
});

test('shutdown integration: owner quit bounds a stuck owned close without releasing the lock early', async () => {
  const f = shutdownFixture(), appClosed = deferred(), trayClosed = deferred();
  const {calls, options} = io({background:true, ownerGone:f.shutdown.ownerGone});
  options.startApp = async () => {
    calls.started++;
    const app = calls.app = fakeApp();
    app.close = () => { app.closed++; return appClosed.promise; };
    return app;
  };
  options.finishShutdown = ({app}) => f.shutdown.finish({trayExits:[trayClosed.promise], appClosed:app.close()});
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  f.signals.emit('SIGTERM'); await tick();
  assert.equal(calls.trays[0].child.ended, true);
  assert.equal(calls.app.closed, 1);
  assert.equal(calls.released, 0, 'owned cleanup still holds the launch lock');
  await f.advance(10000);
  await f.advance(29999);
  assert.deepEqual(f.exits, []); assert.equal(calls.released, 0);
  await f.advance(1);
  assert.deepEqual(f.exits, [{code:0, at:40000}]);
  assert.deepEqual(await run, {role:'primary', owned:true, reason:'owner'});
  assert.equal(calls.released, 1, 'returning fake exit permits final supervisor cleanup');
});

test('shutdown integration: cooperative owner quit retains the lock until full close and never forces exit', async () => {
  const f = shutdownFixture(), appClosed = deferred(), trayClosed = deferred();
  const {calls, options} = io({background:true, ownerGone:f.shutdown.ownerGone});
  options.startApp = async () => {
    const app = calls.app = fakeApp();
    app.close = () => { app.closed++; return appClosed.promise; };
    return app;
  };
  options.finishShutdown = ({app}) => f.shutdown.finish({trayExits:[trayClosed.promise], appClosed:app.close()});
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  f.stdin.emit('end'); await tick();
  trayClosed.resolve(); await tick();
  assert.equal(calls.released, 0); assert.deepEqual(f.exitCodes, []);
  appClosed.resolve({state:'closed', unfinished:[]});
  assert.deepEqual(await run, {role:'primary', owned:true, reason:'owner', ownedCloseCompleted:true});
  assert.equal(calls.released, 1); assert.equal(calls.app.closed, 1);
  assert.deepEqual(f.exits, []); assert.deepEqual(f.exitCodes, [0]);
  assert.equal(f.timers.size, 0);
});

test('shutdown integration: an interrupted app close never acknowledges a completed owned close', async () => {
  const f = shutdownFixture(), appClosed = deferred(), trayClosed = deferred();
  const {calls, options} = io({background:true, ownerGone:f.shutdown.ownerGone});
  const startApp = options.startApp;
  options.startApp = async () => Object.assign(await startApp(), {close:() => appClosed.promise});
  options.finishShutdown = ({app}) => f.shutdown.finish({trayExits:[trayClosed.promise], appClosed:app.close()});
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  f.stdin.emit('end');
  appClosed.resolve({state:'interrupted', unfinished:['lending']});
  await tick();
  assert.equal(calls.released, 0);
  trayClosed.resolve();
  assert.deepEqual(await run, {role:'primary', owned:true, reason:'owner'});
  assert.deepEqual(f.exits, []); assert.deepEqual(f.exitCodes, [0]);
});

test('shutdown integration: reused app is never passed to the close boundary', async () => {
  const f = shutdownFixture();
  const {calls, options} = io({background:true, discover:async () => FOUND, ownerGone:f.shutdown.ownerGone});
  options.finishShutdown = ({app}) => {
    assert.equal(app, null, 'only an app owned by this supervisor may be closed');
    return f.shutdown.finish({trayExits:[Promise.resolve()]});
  };
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  f.stdin.emit('end');
  assert.deepEqual(await run, {role:'primary', owned:false, reason:'owner'});
  assert.equal(calls.started, 0); assert.equal(calls.released, 1);
  assert.deepEqual(f.exits, []); assert.deepEqual(f.exitCodes, [0]);
});

test('the Mac plist explains Local Network access for circle hosts', () => {
  const plist = readFileSync(new URL('../packaging/macos/Info.plist', import.meta.url), 'utf8');
  const purpose = plist.match(/<key>NSLocalNetworkUsageDescription<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(purpose, 'the bundle template must declare its Local Network purpose');
  assert.equal(purpose[1], 'Faravan connects to circle hosts on your local network so you can join your circle and exchange jobs and results.');
});

test('launch arguments: --background and --open-only, an absolute --tray, and the -psn argument Finder may add', () => {
  assert.deepEqual(parseLaunchArgs(['--tray', '/A B/faravan-tray']), {background:false, openOnly:false, trayPath:'/A B/faravan-tray'});
  assert.deepEqual(parseLaunchArgs(['--background', '-psn_0_1234', '--tray', '/x/t']), {background:true, openOnly:false, trayPath:'/x/t'});
  assert.deepEqual(parseLaunchArgs(['--open-only']), {background:false, openOnly:true, trayPath:null});
  for (const bad of [['--tray'], ['--tray', 'relative/t'], ['--port', '1'], ['extra']]) assert.throws(() => parseLaunchArgs(bad), /usage/i, bad.join(' '));
});

test('first interactive launch starts the app, opens the one-time handoff (never the token URL) and owns the tray', async () => {
  const {calls, owner, options} = io();
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  assert.equal(calls.started, 1);
  assert.deepEqual(calls.opened, [HANDOFF]);
  assert.equal(calls.trays[0].path, options.trayPath);
  owner.resolve();
  const result = await run;
  assert.deepEqual(result, {role:'primary', owned:true, reason:'owner'});
  assert.equal(calls.app.closed, 1, 'a gone launcher stops the app it owns through its own close');
  assert.equal(calls.trays[0].child.ended, true, 'the tray reads end of input and quits');
});

test('--background starts the app and the tray without opening a browser', async () => {
  const {calls, owner, options} = io({background:true});
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  assert.deepEqual(calls.opened, []);
  owner.resolve(); await run;
});

test('a duplicate launch reuses the running one: it opens a handoff for it, starts nothing and signals nobody', async () => {
  const {calls, options} = io({acquireLock:async () => { throw busy(); }, discover:async () => FOUND});
  assert.deepEqual(await superviseMacLaunch(options), {role:'duplicate'});
  assert.deepEqual(calls.opened, [HANDOFF]);
  assert.equal(calls.started, 0); assert.equal(calls.trays.length, 0);
});

test('a duplicate --background launch exits quietly, and --open-only never becomes the owner', async () => {
  const quiet = io({background:true, acquireLock:async () => { throw busy(); }, discover:async () => FOUND});
  assert.deepEqual(await superviseMacLaunch(quiet.options), {role:'duplicate'});
  assert.deepEqual(quiet.calls.opened, []);
  let locked = false;
  const reopen = io({openOnly:true, acquireLock:async () => { locked = true; return () => {}; }, discover:async () => FOUND});
  assert.deepEqual(await superviseMacLaunch(reopen.options), {role:'duplicate'});
  assert.equal(locked, false); assert.deepEqual(reopen.calls.opened, [HANDOFF]); assert.equal(reopen.calls.started, 0);
});

test('a duplicate waits for the first launch to become ready, and rejects if no app answers', async () => {
  let reads = 0;
  const later = io({acquireLock:async () => { throw busy(); }, discover:async () => (++reads > 3 ? FOUND : null)});
  await superviseMacLaunch(later.options);
  assert.deepEqual(later.calls.opened, [HANDOFF]);
  const never = io({acquireLock:async () => { throw busy(); }, waitMs:0});
  await assert.rejects(superviseMacLaunch(never.options), {code:'launch_lock_held'});
  assert.deepEqual(never.calls.opened, []);
});

test('a busy foreground lock reports its owner PID without starting or releasing anything', async t => {
  const s = scratch(t), messages = [];
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  mkdirSync(join(s.home, 'v1'), {recursive:true});
  const lock = join(s.home, 'v1', 'launch.lock');
  const release = await acquireProcessLock(lock, {timeoutMs:0});
  try {
    const {calls, options} = io({home:s.home, waitMs:0, log:line => messages.push(line),
      acquireLock:path => acquireProcessLock(path, {timeoutMs:0})});
    await assert.rejects(superviseMacLaunch(options), {code:'launch_lock_held'});
    assert.deepEqual(messages, ['Faravan launch lock is held by PID ' + process.pid + '; no app answered.']);
    assert.equal(calls.started, 0); assert.equal(calls.released, 0);
    assert.deepEqual(calls.opened, []); assert.equal(calls.trays.length, 0);
    await assert.rejects(acquireProcessLock(lock, {timeoutMs:0}), {code:'lock_busy'});
  } finally { release(); }
});

test('launcher log persists the identical timestamped stderr line with private permissions and bounded size', async t => {
  const s = scratch(t), output = [];
  const {createLaunchLogger} = await import('../lib/v1/macos-launch.mjs');
  const log = createLaunchLogger(s.home, {stderr:{write:line => output.push(line)}});
  const directory = join(s.home, 'v1', 'logs'), file = join(directory, 'launcher.log');
  log('Faravan could not start: launch_lock_held');
  assert.equal(readFileSync(file, 'utf8'), output[0]);
  assert.match(output[0], /^\d{4}-\d{2}-\d{2}T.* Faravan could not start: launch_lock_held\n$/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const previous = Buffer.alloc(1024 * 1024, 'x');
  writeFileSync(file, previous);
  log('rotation marker');
  const expected = Buffer.concat([previous, Buffer.from(output[1])]).subarray(-512 * 1024);
  assert.deepEqual(readFileSync(file), expected);
  log('still appends');
  assert.equal(statSync(file).size, 512 * 1024 + Buffer.byteLength(output[2]));
  assert.ok(readFileSync(file, 'utf8').endsWith(output[2]));
});

test('launcher logging never throws when stderr or the log directory is unavailable', async t => {
  const s = scratch(t);
  const {createLaunchLogger} = await import('../lib/v1/macos-launch.mjs');
  const log = createLaunchLogger(s.home, {stderr:{write:() => { throw new Error('closed stderr'); }}});
  assert.doesNotThrow(() => log('stderr unavailable'));
  assert.match(readFileSync(join(s.home, 'v1', 'logs', 'launcher.log'), 'utf8'), /stderr unavailable/);
  const blockedHome = join(s.dir, 'not-a-directory');
  writeFileSync(blockedHome, 'file');
  assert.doesNotThrow(() => createLaunchLogger(blockedHome)('unwritable log directory'));
});

test('busy background retains quiet duplicate behavior', async () => {
  const quiet = io({background:true, acquireLock:async () => { throw busy(); },
    discover:async () => { assert.fail('background duplicate must not probe the app'); }});
  assert.deepEqual(await superviseMacLaunch(quiet.options), {role:'duplicate'});
});

test('open-only without a running app rejects with the error the CLI maps to exit 1', async () => {
  const messages = [];
  const reopen = io({openOnly:true, waitMs:0, log:line => messages.push(line),
    acquireLock:async () => { assert.fail('open-only must not acquire ownership'); }});
  await assert.rejects(superviseMacLaunch(reopen.options), {code:'app_unavailable'});
  assert.deepEqual(messages, ['Faravan is not running yet; nothing was opened.']);
  assert.equal(reopen.calls.started, 0);
  assert.equal(reopen.calls.released, 0);
  assert.equal(reopen.calls.handoffs, 0);
  assert.deepEqual(reopen.calls.opened, []);
  assert.deepEqual(reopen.calls.trays, []);
});

test('successful open-only retains the duplicate result the CLI maps to exit 0', async () => {
  const reopen = io({openOnly:true, waitMs:0, discover:async () => FOUND,
    acquireLock:async () => { assert.fail('open-only must not acquire ownership'); }});
  assert.deepEqual(await superviseMacLaunch(reopen.options), {role:'duplicate'});
  assert.equal(reopen.calls.handoffs, 1);
  assert.deepEqual(reopen.calls.opened, [HANDOFF]);
  assert.equal(reopen.calls.started, 0);
  assert.equal(reopen.calls.released, 0);
  assert.deepEqual(reopen.calls.trays, []);
});

test('an app started elsewhere (CLI or service) is reused and never closed by this launcher', async () => {
  const {calls, owner, options} = io({discover:async () => FOUND});
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  assert.equal(calls.started, 0); assert.deepEqual(calls.opened, [HANDOFF]);
  owner.resolve();
  assert.deepEqual(await run, {role:'primary', owned:false, reason:'owner'});
  assert.equal(calls.trays[0].child.ended, true);
});

test('losing the app-lock race to another starter falls back to reusing that app', async () => {
  let reads = 0;
  const {calls, owner, options} = io({
    discover:async () => (reads++ ? FOUND : null),
    startApp:async () => { throw Object.assign(new Error('app_already_running'), {code:'app_already_running', status:409}); },
  });
  const run = superviseMacLaunch(options);
  await until(() => calls.trays.length === 1);
  owner.resolve();
  assert.deepEqual(await run, {role:'primary', owned:false, reason:'owner'});
});

test('a live app that never answers is an error, not permission to start a second one', async () => {
  const {calls, options} = io({startApp:async () => { throw Object.assign(new Error('app_already_running'), {code:'app_already_running'}); }, waitMs:0});
  await assert.rejects(superviseMacLaunch(options), e => e.code === 'app_unavailable');
  assert.equal(calls.trays.length, 0); assert.equal(calls.released, 1);
});

test('tray Quit: a clean tray exit stops the owned app; the app closing by itself (POST /api/shutdown) ends the launch', async () => {
  const quit = io();
  const run = superviseMacLaunch(quit.options);
  await until(() => quit.calls.trays.length === 1);
  quit.calls.trays[0].child.exit(0);
  assert.deepEqual(await run, {role:'primary', owned:true, reason:'tray'});
  assert.equal(quit.calls.app.closed, 1);

  const shutdown = io();
  const done = superviseMacLaunch(shutdown.options);
  await until(() => shutdown.calls.trays.length === 1);
  shutdown.calls.app.server.emit('close');
  assert.deepEqual(await done, {role:'primary', owned:true, reason:'app'});
  assert.equal(shutdown.calls.app.closed, 0, 'the app is already running its own close; the launcher does not race it');
  assert.equal(shutdown.calls.trays[0].child.ended, true);
});

test('a crashed tray is restarted a bounded number of times; the app keeps running for the browser', async () => {
  const {calls, owner, options} = io({trayRestarts:2});
  const run = superviseMacLaunch(options);
  for (let n = 1; n <= 3; n++) { await until(() => calls.trays.length === n); calls.trays[n - 1].child.exit(2); }
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(calls.trays.length, 3);
  assert.equal(calls.app.closed, 0);
  owner.resolve();
  assert.equal((await run).reason, 'owner');
});

test('G08 the default Mac supervisor retains its icon restart obligation beyond three failures',async()=>{
  const {calls,owner,options}=io(),delays=[];
  options.sleep=async ms=>{delays.push(ms);};
  const done=superviseMacLaunch(options);
  for(let n=1;n<=6;n++){await until(()=>calls.trays.length===n);calls.trays[n-1].child.exit(1);}
  await until(()=>calls.trays.length===7);
  assert.deepEqual(delays,[1000,2000,4000,8000,16000,30000]);
  owner.resolve();await done;assert.equal(calls.app.closed,1);
});

test('G08 installed resident entrypoint replaces real app and tray deaths and honors durable Quit',{timeout:60000},async t=>{
  const s=scratch(t),resident=fileURLToPath(new URL('../lib/v1/resident.mjs',import.meta.url));
  writeFileSync(s.tray,`#!/bin/sh\necho $$ > '${s.dir}/tray.pid'\ncat > /dev/null\n`,{mode:0o755});
  // A CLI resident can precede desktop startup. The latter must still own the
  // icon and take over app supervision if that first owner dies.
  const cliOwner=spawn(process.execPath,[resident,'--background'],{env:s.env,stdio:'ignore'});
  const cliExit=once(cliOwner,'exit');
  t.after(async()=>{if(cliOwner.exitCode===null&&cliOwner.signalCode===null)cliOwner.kill('SIGTERM');await cliExit;});
  await waitFor(()=>s.record().pid);
  const start=()=>spawn(process.execPath,[resident,'--background','--tray',s.tray],{env:s.env,stdio:'ignore'});
  const child=start(),exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;});
  await waitFor(()=>s.record().pid&&existsSync(join(s.dir,'tray.pid')));
  const first=s.record(),trayPid=Number(readFileSync(join(s.dir,'tray.pid'),'utf8'));
  cliOwner.kill('SIGKILL');await cliExit;
  process.kill(first.pid,'SIGKILL');
  await waitFor(()=>s.record().pid!==first.pid);
  process.kill(trayPid,'SIGKILL');
  await waitFor(()=>Number(readFileSync(join(s.dir,'tray.pid'),'utf8'))!==trayPid);
  const replacement=s.record();
  const response=await fetch('http://127.0.0.1:'+replacement.port+'/api/shutdown',{
    method:'POST',headers:{'content-type':'application/json','x-faravan-session-token':replacement.token},body:'{}'});
  assert.equal(response.status,202);
  await exited;
  assert.equal(JSON.parse(readFileSync(join(s.home,'v1','resident-intent.json'),'utf8')).quit,true);
  const afterQuit=start();assert.deepEqual(await once(afterQuit,'exit'),[0,null]);
  assert.equal(existsSync(join(s.home,'v1','app.json')),false);
});

test('the launcher leaving during startup closes the new app and starts no tray or browser', async () => {
  const gate = deferred();
  const {calls, owner, options} = io({startApp:async () => { await gate.promise; calls.started++; return calls.app = fakeApp(); }});
  const run = superviseMacLaunch(options);
  owner.resolve(); await tick(); gate.resolve();
  assert.equal((await run).reason, 'owner');
  assert.ok(!calls.app || calls.app.closed === 1); assert.equal(calls.trays.length, 0); assert.deepEqual(calls.opened, []);
});

test('the handoff request uses the session token header, and only a same-origin handoff URL is opened', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({url, init}); return {ok:true, json:async () => ({url:HANDOFF})}; };
  assert.equal(await handoffFor(FOUND, {fetch}), HANDOFF);
  assert.equal(seen[0].url, FOUND.origin + '/api/handoff');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-faravan-session-token'], FOUND.token);
  assert.equal(seen[0].url.includes(FOUND.token), false);
  for (const url of ['https://evil.example/auth/handoff?code=x', 'http://127.0.0.1:9/auth/handoff?code=x', FOUND.origin + '/?token=session-secret']) {
    assert.equal(await handoffFor(FOUND, {fetch:async () => ({ok:true, json:async () => ({url})})}), FOUND.origin + '/');
  }
  assert.equal(await handoffFor(FOUND, {fetch:async () => ({ok:false, json:async () => ({})})}), FOUND.origin + '/');
  assert.equal(await handoffFor(FOUND, {fetch:async () => { throw new Error('refused'); }}), FOUND.origin + '/');
});

test('the native launcher and this module agree on the bundle contract', () => {
  const swift = readFileSync(SWIFT, 'utf8');
  for (const part of ['Resources/faravan/runtime/bin/node', 'Resources/faravan/lib/v1/macos-launch.mjs', 'MacOS/faravan-tray',
    '"--tray"', '"--background"', '"--open-only"', 'applicationShouldTerminate', 'applicationShouldHandleReopen', 'SIGTERM'])
    assert.ok(swift.includes(part), 'main.swift: ' + part);
  assert.equal(/\bkill\s*\(/.test(swift), false, 'the launcher ends its child by closing the owner pipe, never by a signal');
});

// ---- Process tests: the real module, the real app, a shell tray. ----

test('process: foreground busy lock exits 1 and persists the startup failure despite discarded output', {timeout:30000}, async t => {
  const s = scratch(t);
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  mkdirSync(join(s.home, 'v1'), {recursive:true});
  const release = await acquireProcessLock(join(s.home, 'v1', 'launch.lock'), {timeoutMs:0});
  const child = launch(s, ['--managed'], ['pipe', 'ignore', 'ignore']);
  const exited = once(child, 'exit');
  try {
    assert.deepEqual(await exited, [1, null]);
    const log = readFileSync(join(s.home, 'v1', 'logs', 'launcher.log'), 'utf8');
    assert.ok(log.includes('Faravan launch lock is held by PID ' + process.pid + '; no app answered.'));
    assert.match(log, /Faravan could not start: launch_lock_held/);
    assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    release();
  }
});

function scratch(t) {
  const dir = mkdtempSync('/tmp/ml-');
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const tray = join(dir, 'tray.sh'), trayLog = join(dir, 'tray.log');
  // Like the real tray when owned: run until standard input ends, then quit.
  writeFileSync(tray, `#!/bin/sh\necho "start $FARAVAN_TRAY_OWNER" >> '${trayLog}'\ncat > /dev/null\necho eof >> '${trayLog}'\n`, {mode:0o755});
  const home = join(dir, 'home');
  const sbx=join(dir,'sbx');writeFileSync(sbx,'#!/bin/sh\nexit 1\n',{mode:0o755});
  const env = {...process.env, HOME:dir, FARAVAN_SBX_BIN:sbx, FARAVAN_HOME:home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_NO_BROWSER:'1'};
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return {dir, tray, trayLog, home, env, record:() => JSON.parse(readFileSync(join(home, 'v1', 'app.json'), 'utf8'))};
}
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);
async function waitFor(check, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { try { if (check()) return; } catch {} if (Date.now() > end) assert.fail('timed out: ' + check); await new Promise(r => setTimeout(r, 50)); }
}
// On macOS an unmanaged --background hands off to launchd, which starts the supervisor with --managed (macos-session.mjs).
// These fixtures own the supervisor's stdin, so they start that managed supervisor directly.
const supervisorArgs = args => process.platform === 'darwin' && args.includes('--background') && !args.includes('--managed') ? ['--managed', ...args] : args;
function launch(s, args, stdio = ['pipe', 'pipe', 'pipe']) {
  const launchArgs = supervisorArgs(args);
  const child = spawn(process.execPath, [MODULE, ...launchArgs], {env:s.env, stdio});
  let out = ''; child.stdout?.on('data', b => { out += b; }); child.stderr?.on('data', b => { out += b; });
  child.output = () => out;
  return child;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function startupProbeStub(s, {naturalMs, probe, done, cancelStarted, cancelAck, release}) {
  writeFileSync(s.env.FARAVAN_SBX_BIN, '#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    if(process.argv[2]==='version'){console.log('sbx version 0.48.0');}
    else if(process.argv[2]==='run' && process.argv[3]==='--help'){
      // Install before publishing the PID so the parent cannot race signal setup.
      process.on('SIGTERM',()=>{
        fs.writeFileSync(${JSON.stringify(cancelStarted)},'SIGTERM received');
        const waitForRelease=setInterval(()=>{
          if(fs.existsSync(${JSON.stringify(release)})){
            clearInterval(waitForRelease);
            fs.writeFileSync(${JSON.stringify(cancelAck)},'SIGTERM acknowledged');
            process.exit(0);
          }
        },10);
      });
      fs.writeFileSync(${JSON.stringify(probe)},String(process.pid));
      setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'completed');process.exit(0);},${naturalMs});
    }else process.exitCode=1;
  `,{mode:0o755});
}

function exitWithin(exit, ms) {
  let timer;
  return Promise.race([
    exit.then(([code, signal]) => ({code, signal})),
    new Promise(resolve => { timer=setTimeout(()=>resolve(null),ms); }),
  ]).finally(()=>clearTimeout(timer));
}

async function cleanupProbeOwner(child, exit, probePid, release) {
  writeFileSync(release,'release');
  if(child.stdin && !child.stdin.destroyed) child.stdin.end();
  let result=await exitWithin(exit,2500);
  if(!result){
    if(probePid && alive(probePid))try{process.kill(probePid,'SIGTERM');}catch{}
    child.kill('SIGTERM');
    result=await exitWithin(exit,1500);
  }
  if(!result){child.kill('SIGKILL');result=await exitWithin(exit,1500);}
  let probeStopped=true;
  if(probePid && alive(probePid)){
    try{process.kill(probePid,'SIGKILL');}catch{}
    try{await waitFor(()=>!alive(probePid),1500);}catch{probeStopped=false;}
  }
  assert.ok(result,'the supervisor was reaped during fixture cleanup');
  assert.ok(probeStopped,'the owned probe was reaped during fixture cleanup');
}

test('process: owner shutdown waits for startup probe cancellation and reaps it', {timeout:60000}, async t => {
  const s=scratch(t),probe=join(s.dir,'probe.pid'),done=join(s.dir,'probe.done');
  const cancelStarted=join(s.dir,'probe.cancel-started'),cancelAck=join(s.dir,'probe.cancel-ack');
  const release=join(s.dir,'probe.release');
  startupProbeStub(s,{naturalMs:10000,probe,done,cancelStarted,cancelAck,release});
  const child=launch(s,['--background']),exit=once(child,'exit');
  let probePid;
  try {
    await waitFor(()=>existsSync(probe),5000);
    probePid=Number(readFileSync(probe,'utf8'));
    assert.ok(Number.isSafeInteger(probePid) && probePid>0,'the stub published its live command PID');
    child.stdin.end();
    await waitFor(()=>existsSync(cancelStarted),5000);
    assert.equal(child.exitCode,null,'the supervisor must wait while its owned command handles cancellation');
    assert.equal(alive(probePid),true,'the stub keeps the command alive until the test releases cleanup');
    writeFileSync(release,'release');
    const result=await exit;
    assert.equal(result[0],0,child.output());
    assert.equal(result[1],null);
    assert.equal(existsSync(cancelAck),true,'the probe acknowledged SIGTERM before the supervisor exited');
    assert.equal(existsSync(done),false,'shutdown cancelled the pending probe instead of waiting for natural completion');
    assert.equal(alive(probePid),false,'the cancelled probe was reaped before the supervisor exited');
    assert.equal(existsSync(join(s.home,'v1','app.json')),false,'app discovery was removed after confirmed cleanup');
  } finally {
    await cleanupProbeOwner(child,exit,probePid,release);
  }
});

test('process: an unsignaled startup probe can finish naturally before owner shutdown', {timeout:60000}, async t => {
  const s=scratch(t),probe=join(s.dir,'probe.pid'),done=join(s.dir,'probe.done');
  const cancelStarted=join(s.dir,'probe.cancel-started'),cancelAck=join(s.dir,'probe.cancel-ack');
  const release=join(s.dir,'probe.release');
  startupProbeStub(s,{naturalMs:250,probe,done,cancelStarted,cancelAck,release});
  const child=launch(s,['--background']),exit=once(child,'exit');
  let probePid;
  try {
    await waitFor(()=>existsSync(probe),5000);
    probePid=Number(readFileSync(probe,'utf8'));
    assert.ok(Number.isSafeInteger(probePid) && probePid>0,'the stub published its live command PID');
    await waitFor(()=>existsSync(done),5000);
    await waitFor(()=>!alive(probePid),5000);
    assert.equal(existsSync(cancelStarted),false,'the control probe completed without a shutdown signal');
    assert.equal(child.exitCode,null,'the supervisor remains open while its owner is still present');
    assert.ok(existsSync(join(s.home,'v1','app.json')),'discovery remains while the app is still open');
    child.stdin.end();
    const result=await exit;
    assert.equal(result[0],0,child.output());
    assert.equal(result[1],null);
    assert.equal(existsSync(cancelAck),false);
    assert.equal(alive(probePid),false,'the naturally completed probe was reaped');
    assert.equal(existsSync(join(s.home,'v1','app.json')),false,'app discovery was removed after owner shutdown');
  } finally {
    await cleanupProbeOwner(child,exit,probePid,release);
  }
});

test('process: owner shutdown reaps a tray that takes time to exit after EOF', {timeout:60000}, async t => {
  const s=scratch(t);
  writeFileSync(s.tray, `#!/bin/sh\necho $$ > '${s.dir}/tray.pid'\necho start >> '${s.trayLog}'\ncat > /dev/null\nsleep 0.3\necho done >> '${s.trayLog}'\n`, {mode:0o755});
  const child=launch(s,['--background','--tray',s.tray]);
  let trayPid;
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){child.stdin.end();await once(child,'exit');}
    if(trayPid)await waitFor(()=>!alive(trayPid));
  });
  await waitFor(()=>lines(s.trayLog).includes('start'));
  trayPid=Number(readFileSync(join(s.dir,'tray.pid'),'utf8').trim());
  child.stdin.end();
  assert.equal((await once(child,'exit'))[0],0,child.output());
  assert.ok(lines(s.trayLog).includes('done'),'the supervisor must wait for its owned tray to exit');
  assert.equal(alive(trayPid),false,'the tray process has been reaped before the supervisor exits');
});

test('process: a closed owner pipe drains the owned app and the tray, removes discovery and exits 0', {timeout:60000}, async t => {
  const s = scratch(t);
  const child = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitFor(() => s.record().pid === child.pid && lines(s.trayLog).length === 1);
  assert.deepEqual(lines(s.trayLog), ['start stdin']);
  const {token} = s.record();
  // A duplicate --background launch while it runs: returns at once and changes nothing.
  const dup = launch(s, ['--background', '--tray', s.tray]);
  dup.stdin.end();
  assert.equal((await once(dup, 'exit'))[0], 0, dup.output());
  assert.equal(s.record().pid, child.pid); assert.deepEqual(lines(s.trayLog), ['start stdin']);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, child.output());
  assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false);
  await waitFor(() => lines(s.trayLog).includes('eof'));
  assert.equal(child.output().includes(token), false, 'the log never holds the session token');
});

test('process: Force Quit of the native launcher (SIGKILL, no handler runs) still ends the backend and tray', {timeout:60000}, async t => {
  const s = scratch(t);
  // Stand-in for faravan-launch: holds the only write end of the supervisor's input, then is killed outright.
  const holder = spawn(process.execPath, ['-e', `
    const c=require('node:child_process').spawn(process.execPath,${JSON.stringify([MODULE, ...supervisorArgs(['--background', '--tray', s.tray])])},{stdio:['pipe','ignore','ignore']});
    console.log(c.pid);setInterval(()=>{},1000);`], {env:s.env, stdio:['ignore', 'pipe', 'ignore']});
  const [pidLine] = await once(holder.stdout, 'data');
  const supervisor = Number(String(pidLine).trim());
  t.after(() => { for (const pid of [holder.pid, supervisor]) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  await waitFor(() => s.record().pid === supervisor && lines(s.trayLog).length === 1);
  holder.kill('SIGKILL');
  await waitFor(() => !alive(supervisor));
  assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false, 'the app closed through its own cleanup');
  await waitFor(() => lines(s.trayLog).includes('eof'));
});

test('process: tray Quit path, POST /api/shutdown, ends the launcher without killing anything', {timeout:60000}, async t => {
  const s = scratch(t);
  const child = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitFor(() => s.record().pid === child.pid && lines(s.trayLog).length === 1);
  const {port, token} = s.record();
  const response = await fetch('http://127.0.0.1:' + port + '/api/shutdown', {method:'POST', headers:{'x-faravan-session-token':token, 'content-type':'application/json'}, body:'{}'});
  assert.equal(response.status, 202);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, child.output());
  assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false);
  await waitFor(() => lines(s.trayLog).includes('eof'));
});

test('process: SIGTERM at logout drains the owned app the same way', {timeout:60000}, async t => {
  const s = scratch(t);
  const child = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitFor(() => s.record().pid === child.pid && lines(s.trayLog).length === 1);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, child.output());
  assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false);
});

test('process: an app started by the CLI is reused and left running when the launcher goes', {timeout:60000}, async t => {
  const s = scratch(t);
  const app = spawn(process.execPath, [BIN, 'app'], {env:s.env, stdio:'ignore'});
  t.after(() => { if (app.exitCode === null) app.kill('SIGTERM'); });
  await waitFor(() => s.record().pid === app.pid);
  const child = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitFor(() => lines(s.trayLog).length === 1);
  child.stdin.end();
  assert.equal((await once(child, 'exit'))[0], 0, child.output());
  assert.equal(alive(app.pid), true);
  assert.equal(s.record().pid, app.pid);
  app.kill('SIGTERM'); await once(app, 'exit');
});

test('process: hard death of the supervisor itself (SIGKILL) still ends the tray, and the next launch takes over', {timeout:60000}, async t => {
  const s = scratch(t);
  const child = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitFor(() => s.record().pid === child.pid && lines(s.trayLog).length === 1);
  child.kill('SIGKILL'); // no handler, no close(): the kernel closes the tray's input pipe
  await once(child, 'exit');
  await waitFor(() => lines(s.trayLog).includes('eof'));
  // The dead owner's launch lock and stale app.json do not block the next launch.
  const next = launch(s, ['--background', '--tray', s.tray]);
  t.after(() => { if (next.exitCode === null) next.kill('SIGKILL'); });
  await waitFor(() => s.record().pid === next.pid && lines(s.trayLog).filter(line => line.startsWith('start')).length === 2);
  next.stdin.end();
  assert.equal((await once(next, 'exit'))[0], 0, next.output());
  assert.equal(existsSync(join(s.home, 'v1', 'app.json')), false);
});

test('managed snapshots reject unknown pipe, parent, reused tray and changing births',async()=>{
  const {managedProcessSnapshot}=await import('../lib/v1/macos-launch.mjs');
  const tray={pid:333,exitCode:null,signalCode:null},birth={boot:'darwin:fixture',start:'42',state:'live'};
  const options={appPath:'/Applications/Faravan.app',tray,pid:111,parentPid:222,pipeOwned:async()=>true,
    readParentExecutable:async()=>'/Applications/Faravan.app/Contents/MacOS/faravan-launch',readBirth:async()=>birth};
  assert.deepEqual((await managedProcessSnapshot(options)).map(x=>x.role),['app','native','tray']);
  await assert.rejects(managedProcessSnapshot({...options,pipeOwned:async()=>false}));
  await assert.rejects(managedProcessSnapshot({...options,readParentExecutable:async()=>'/other'}));
  let calls=0;await assert.rejects(managedProcessSnapshot({...options,readBirth:async()=>({...birth,start:String(++calls)})}));
  await assert.rejects(managedProcessSnapshot({...options,tray:{...tray,exitCode:0}}));
});

test('reused app never receives managed recovery callback',async()=>{
  let attempted=0;const {owner,options}=io({discover:async()=>FOUND,onOwnedReady:async()=>{attempted++;}});
  const run=superviseMacLaunch(options);await tick();owner.resolve();await run;assert.equal(attempted,0);
});

test('busy recovery exclusion does not capture process owners or start a helper',async t=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath}=await import('node:fs/promises');
  const {prepareManagedRecovery}=await import('../lib/v1/macos-update-recovery.mjs');
  const root=await mkdtemp(join(await realpath('/tmp'),'rb-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const appPath=join(root,'Faravan.app'),home=join(root,'home'),identity={appPath,version:'1.0.2',channel:'faravan',bundleId:'com.example'};
  await mkdir(home);await writeFile(appPath+'.update-journal.json',JSON.stringify({schema:1,id:'11111111-1111-1111-1111-111111111111',appPath,home,channel:'faravan',bundleId:'com.example',version:'1.0.2',previousVersion:'1.0.1',phase:'starting'}),{mode:0o600});
  let touched=false, entered=false;const result=await prepareManagedRecovery({home,identity,exclusive:async()=>{entered=true;return null;},snapshot:async()=>{touched=true;},prepare:async()=>{touched=true;}});
  assert.equal(result,null);assert.equal(entered,true);assert.equal(touched,false);
});

test('process: session registration failure writes one early diagnostic and exits nonzero', {timeout:10000}, async t => {
  const s = scratch(t);
  const script = `
    const {runMacLaunch} = await import(${JSON.stringify(new URL('../lib/v1/macos-launch.mjs', import.meta.url).href)});
    await runMacLaunch({
      argv: [], platform: 'darwin',
      loadConfig: async () => ({configHome: () => ${JSON.stringify(s.home)}}),
      loadSession: async () => ({ensureMacSession: async () => { throw new TypeError('registration failed'); }}),
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env:s.env, stdio:'ignore'});
  assert.deepEqual(await once(child, 'exit'), [1, null]);
  const lines = readFileSync(join(s.home, 'v1', 'logs', 'launcher.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Faravan could not start: TypeError \(step=session-registration, class=TypeError\)$/);
  assert.equal(lines[0].includes('registration failed'), false);
});

test('early startup diagnostic excludes secret messages, arbitrary names, codes and home descendants', async t => {
  const s = scratch(t), output = [], exits = [];
  const {runMacLaunch} = await import('../lib/v1/macos-launch.mjs');
  const secret = 'sk-test-not-a-real-key';
  const error = Object.assign(new Error('token=' + secret + ' prompt=private /Users/person/secret.txt'), {
    name: 'PrivateError-' + secret, code: 'token=' + secret,
  });
  await runMacLaunch({
    argv:[], platform:'darwin',
    loadConfig:async () => ({configHome:() => s.home}),
    loadSession:async () => ({ensureMacSession:async () => { throw error; }}),
    stderr:{write:line => output.push(line)}, exit:code => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  const saved = readFileSync(join(s.home, 'v1', 'logs', 'launcher.log'), 'utf8');
  assert.equal(saved, output.join(''));
  assert.match(saved, /step=session-registration, class=Error/);
  for (const forbidden of [secret, 'private', '/Users/person', error.name, error.code, s.home]) assert.equal(saved.includes(forbidden), false);
  assert.equal(saved.trim().split('\n').length, 1);
});

test('session import failure is classified before the managed supervisor exists', async t => {
  const s = scratch(t), exits = [];
  const {runMacLaunch} = await import('../lib/v1/macos-launch.mjs');
  await runMacLaunch({
    argv:[], platform:'darwin', loadConfig:async () => ({configHome:() => s.home}),
    loadSession:async () => { throw new SyntaxError('private source path'); },
    stderr:{write:() => {}}, exit:code => exits.push(code),
  });
  assert.deepEqual(exits, [1]);
  assert.match(readFileSync(join(s.home, 'v1', 'logs', 'launcher.log'), 'utf8'), /step=session-import, class=SyntaxError/);
});

test('native repeated failure alert has a two-minute three-exit gate, one-launch guard and Quit route', () => {
  const swift = readFileSync(SWIFT, 'utf8');
  assert.match(swift, /systemUptime/);
  assert.match(swift, /now - \$0 <= 120\.0/);
  assert.match(swift, /recentFailures\.count >= 3/);
  assert.match(swift, /guard !startupFailureShown else/);
  assert.match(swift, /startupFailureShown = true/);
  assert.ok(swift.includes('Faravan could not start. Details are in the Faravan log.'));
  assert.ok(swift.includes('v1/logs/launcher.log'));
  assert.ok(swift.includes('alert.addButton(withTitle: "Quit")'));
  assert.match(swift, /guard !stopping else \{ return \}/);
  assert.ok(swift.includes('self.startSupervisor()'), 'retry remains available');
});

test('J1-01 tray spawn error followed by close restarts once',async()=>{
  const f=io();const running=superviseMacLaunch(f.options);await until(()=>f.calls.trays.length===1);
  const child=f.calls.trays[0].child;child.emit('error',Error('resource unavailable'));child.emit('close',-2,null);
  try {await until(()=>f.calls.trays.length===2);assert.equal(f.calls.trays.length,2);}
  finally {f.owner.resolve();await running;}
});

test('J4-3 managed context reads the replacement tray',async()=>{
  let current;const f=io({onOwnedReady:async context=>{current=context.getTray;}});
  const running=superviseMacLaunch(f.options);await until(()=>f.calls.trays.length===1);
  f.calls.trays[0].child.exit(2);await until(()=>f.calls.trays.length===2);
  try {
    assert.equal(typeof current,'function');assert.equal(current(),f.calls.trays[1].child);
    current().pid=334;
    const owners=await macLaunch.managedProcessSnapshot({appPath:'/Applications/Faravan.app',tray:current(),pid:111,parentPid:222,
      pipeOwned:async()=>true,readParentExecutable:async()=>'/Applications/Faravan.app/Contents/MacOS/faravan-launch',
      readBirth:async()=>({boot:'darwin:fixture',start:'42',state:'live'})});
    assert.equal(owners.find(x=>x.role==='tray').pid,334);
  }
  finally {f.owner.resolve();await running;}
});

test('J4-6 managed recovery retries transient preparation errors',async()=>{
  let calls=0;const f=io({onOwnedReady:async()=>{if(++calls===1)throw Object.assign(Error('read unavailable'),{code:'EIO'});}});
  const running=superviseMacLaunch(f.options);
  try {await until(()=>calls===2);}
  finally {f.owner.resolve();await running;}
});

test('J4-6 untrusted recovery is surfaced without retrying',async()=>{
  let calls=0;const logs=[],f=io({onOwnedReady:async()=>{calls++;throw Error('untrusted journal');},log:line=>logs.push(line)});
  const running=superviseMacLaunch(f.options);await until(()=>logs.some(line=>line.includes('Automatic update recovery stopped')));await tick();
  f.owner.resolve();await running;assert.equal(calls,1);
});

test('J1-01 exit and close together schedule only one tray replacement',async()=>{
  const f=io(),running=superviseMacLaunch(f.options);await until(()=>f.calls.trays.length===1);
  const child=f.calls.trays[0].child;child.exit(2);child.emit('close',2,null);
  await until(()=>f.calls.trays.length===2);await tick();assert.equal(f.calls.trays.length,2);
  f.owner.resolve();await running;
});

test('J4-6 transient recovery helper preparation retries under admission exclusion',async t=>{
  const {mkdtemp,mkdir,writeFile,rm,realpath}=await import('node:fs/promises');
  const {prepareManagedRecovery}=await import('../lib/v1/macos-update-recovery.mjs');
  const root=await mkdtemp(join(await realpath('/tmp'),'rr-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const appPath=join(root,'Faravan.app'),home=join(root,'home'),identity={appPath,version:'1.0.2',channel:'faravan',bundleId:'com.example'};
  await mkdir(home);await writeFile(appPath+'.update-journal.json',JSON.stringify({schema:1,id:'11111111-1111-1111-1111-111111111111',appPath,home,channel:'faravan',bundleId:'com.example',version:'1.0.2',previousVersion:'1.0.1',phase:'starting'}),{mode:0o600});
  let calls=0,held=false,ticket;
  const f=io({onOwnedReady:async({signal})=>{
    ticket=await prepareManagedRecovery({home,identity,signal,snapshot:async()=>[],exclusive:async()=>{assert.equal(held,false);held=true;return ()=>{held=false;};},
      prepare:async options=>{assert.equal(held,true);if(++calls===1)throw Object.assign(Error('temporary read failure'),{code:'EIO'});
        const release=await options.exclusive();return {ready:true,cancel:release};}});
  }});
  const running=superviseMacLaunch(f.options);
  try {
    for(let i=0;i<500&&!ticket?.ready;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(ticket?.ready,true);assert.equal(calls,2);assert.equal(held,true);await ticket.cancel();assert.equal(held,false);
  }
  finally {f.owner.resolve();await running;}
});

for(const code of ['ENOENT','EACCES'])test('R2 permanent tray spawn '+code+' opens browser fallback without retry',async()=>{
  const f=io({background:true}),run=superviseMacLaunch(f.options);
  await until(()=>f.calls.trays.length===1);
  const child=f.calls.trays[0].child;child.emit('error',Object.assign(Error('cannot spawn'),{code}));child.emit('close',-2,null);
  await tick();await tick();
  try {assert.equal(f.calls.trays.length,1);assert.deepEqual(f.calls.opened,[HANDOFF]);assert.equal(f.calls.app.closed,0);}
  finally {f.owner.resolve();await run;}
});

test('R2 default tray retry has a finite browser fallback and keeps exit-close deduplication',async()=>{
  const f=io({background:true}),run=superviseMacLaunch(f.options);
  try {
    for(let n=1;n<=7;n++){
      await until(()=>f.calls.trays.length===n);const child=f.calls.trays[n-1].child;
      child.emit('error',Object.assign(Error('temporary spawn failure'),{code:'EAGAIN'}));child.exit(2);child.emit('close',2,null);
    }
    await tick();await tick();assert.equal(f.calls.trays.length,7);assert.deepEqual(f.calls.opened,[HANDOFF]);assert.equal(f.calls.app.closed,0);
  } finally {f.owner.resolve();await run;}
});

for(const stale of [true,false])test('R2 managed recovery '+(stale?'refuses stale ownership':'has a total retry bound'),async()=>{
  let calls=0;const logs=[];
  const f=io({log:line=>logs.push(line),onOwnedReady:async()=>{
    if(++calls>20)return;
    throw Object.assign(Error('unavailable'),{code:'lock_busy',...(stale?{reason:'lock_stale'}:{})});
  }}),run=superviseMacLaunch(f.options);
  try {
    for(let i=0;i<100;i++)await tick();
    assert.equal(calls,stale?1:7);assert.ok(logs.some(line=>/stopped|check|repair/i.test(line)));
  } finally {f.owner.resolve();await run;}
});
