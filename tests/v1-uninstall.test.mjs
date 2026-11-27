import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, chmod, lstat, mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { runV1Command } from '../lib/v1/cli.mjs';
import { openDevice } from '../lib/v1/device.mjs';
import { platformTargets, installKind, dataDirectoryProblem, uninstallPlan, runUninstall } from '../lib/v1/uninstall.mjs';
import { sbxOwnerFile } from '../lib/sbx-daemon-owner.mjs';
import { sbxDaemonDescription, credentialStoreEnv } from '../lib/docker-backend.mjs';
import { launchAgentPlist as generatedLaunchAgentPlist } from '../lib/v1/autostart.mjs';
import { channelIdentity, STABLE_CHANNEL } from '../lib/channel-identity.mjs';
import { topLevelUsage, helpFor } from '../lib/v1/help.mjs';
import { systemdShowEnvironment } from './helpers/systemd-environment.mjs';

const exists = path => access(path).then(() => true, () => false);
const sink = () => { const chunks = []; return {chunks, text: () => chunks.join(''), write: t => chunks.push(t)}; };
// The launcher the installer writes for a root: it runs the runtime that lives under that same root.
const launcher = root => `#!/bin/sh\nexec "${root}/lib/faravan/runtime/bin/node" "${root}/lib/faravan/bin/faravan" "$@"\n`;
const launchAgentPlist = label => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>\n`;

// What a clean machine answers. A stop succeeds, and every read-back says "stopped" in the words the system uses for it:
// systemd 3 (inactive) and 4 (not installed), pgrep 1 (no process), launchctl 113 ("Could not find service") and
// tasklist's "No tasks are running". A test replaces only the answers it is about.
function cleanAnswer(command, args) {
  if (command === 'systemctl' && args.includes('is-active')) return {code: 3, stdout: '', stderr: ''};
  if (command === 'systemctl' && args.includes('show')) return {code: 0, stdout: 'not-found\n', stderr: ''};
  if (command === 'pgrep') return {code: 1, stdout: '', stderr: ''};
  if (command === 'launchctl' && args.includes('print')) return {code: 113, stdout: '', stderr: 'Could not find service'};
  if (command === 'tasklist') return {code: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\n', stderr: ''};
  return {code: 0, stdout: '', stderr: ''};
}
// A run double: `answer` replaces the clean answer when it returns one, and `record` sees every command in order.
const answering = (answer = () => undefined, record = () => {}) => async (command, args) => {
  record(command, args);
  const replacement = answer(command, args);
  if (replacement !== undefined) return replacement;
  if (command === 'plutil' && args[0] === '-extract' && args[1] === 'Label') {
    const xml = await readFile(args.at(-1), 'utf8').catch(() => '');
    const match = xml.match(/<key>\s*Label\s*<\/key>\s*<string(?:\s[^>]*)?>([^<]*)<\/string>/);
    return match ? {code: 0, stdout: match[1], stderr: ''} : {code: 1, stdout: '', stderr: 'Label is missing'};
  }
  return cleanAnswer(command, args);
};

// The three user services as this machine's portable install defines them: every ExecStart runs a program inside its root.
const ownUnits = userHome => (command, args) => {
  if (command !== 'systemctl') return undefined;
  if (args.includes('show')) return {code: 0, stdout: 'loaded\n', stderr: ''};
  if (args.includes('cat')) return {code: 0, stdout: `[Service]\nExecStart=${join(userHome, '.local/lib/faravan/runtime/bin/node')} ${join(userHome, '.local/lib/faravan/lib/v1/resident.mjs')}\n`, stderr: ''};
  return undefined;
};
// Windows answers by script text. The resident task's definition names this install's root; a tray read-back and the stop differ by Stop-Process.
const windowsAnswer = (m, {task = true, tray} = {}) => (command, args) => {
  if (command !== 'powershell.exe') return undefined;
  const script = args.at(-1);
  if (script.includes('exit 3')) return task ? {code: 0, stdout: 'powershell.exe -EncodedCommand ' + m.files.tree + '\n', stderr: ''} : {code: 3, stdout: '', stderr: ''};
  if (script.includes('faravan-tray') && !script.includes('Stop-Process') && tray) return tray;
  return undefined;
};
const withWindows = (m, options) => (command, args) => windowsAnswer(m, options)(command, args);
const withUnits = (userHome, answer) => (command, args) => answer(command, args) ?? ownUnits(userHome)(command, args);
const trayRegex = userHome => '^' + join(userHome, '.local/lib/faravan/faravan-tray').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)';

// A temporary home with what a portable Linux install leaves behind. Nothing here is real.
async function machine(t, {platform = 'linux', dataDirectory = 'Faravan Preview 20261026'} = {}) {
  const userHome = await mkdtemp(join(tmpdir(), 'spk-un-'));
  t.after(() => rm(userHome, {recursive: true, force: true}));
  const home = join(userHome, '.local/share', dataDirectory);
  const files = {
    autostart: join(userHome, '.config/autostart/faravan-tray.desktop'),
    handler: join(userHome, '.local/share/applications/faravan-open-link.desktop'),
    command: join(userHome, '.local/bin/faravan'),
    tree: join(userHome, '.local/lib/faravan'),
    marker: join(userHome, '.local/lib/faravan/.installed-via'),
  };
  for (const file of [files.autostart, files.handler, files.command, files.marker, join(home, 'v1/state.json')]) {
    await mkdir(join(file, '..'), {recursive: true});
    await writeFile(file, file.endsWith('.installed-via') ? 'tarball\n' : file === files.command ? launcher(join(userHome, '.local'))
      : file === files.autostart ? `[Desktop Entry]\nExec=${join(userHome, '.local/lib/faravan/faravan-tray')}\n`
      : file === files.handler ? `[Desktop Entry]\nExec=${join(userHome, '.local/bin/faravan')} open-link %u\n` : 'x\n');
  }
  const events = [];
  const device = (circles, leaveRequested = true) => ({
    listCircles: async () => circles,
    setCircleLifecycle: async (id, lifecycle) => { events.push(`lifecycle:${id}:${lifecycle}`); return {id, lifecycle}; },
    leaveCircle: async id => { events.push('leave:' + id + ':data=' + await exists(join(home, 'v1/state.json'))); return {id, left: true, leaveRequested}; },
  });
  const run = answering(platform === 'linux' ? ownUnits(userHome) : undefined, (command, args) => events.push('run:' + [command, ...args].join(' ')));
  // No sandbox runs on these machines; the real process scan is never read.
  const base = {home, userHome, platform, run, sleep: async () => {}, env: {}, installDir: files.tree, uid: 1000, inspectSandboxes: async () => []};
  const go = async (argv, extra = {}) => {
    const stdout = sink(), stderr = sink();
    const code = await runV1Command(['uninstall', ...argv], {...base, ...extra, stdout, stderr});
    return {code, out: stdout.text(), err: stderr.text()};
  };
  return {userHome, home, files, events, device, go, base};
}

async function defaultOfflineDevice(m) {
  await rm(join(m.home, 'v1'), {recursive:true, force:true});
  const device = await openDevice({home:m.home, origin:null});
  const [circle] = await device.listCircles();
  assert.equal(circle.name, 'My devices');
  assert.equal(circle.owned, true);
  assert.equal(circle.origin, null);
  return {device, circle};
}

test('uninstall leaves circles first, then removes autostart, the command and the data', async t => {
  const m = await machine(t);
  const result = await m.go(['--yes'], {device: m.device([{id: 'c1', name: 'Friends'}, {id: 'c2', name: 'Work'}])});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(m.events.filter(e => e.startsWith('leave')), ['leave:c1:data=true', 'leave:c2:data=true'], 'circles are left while the data still exists');
  assert.ok(m.events.findIndex(e => e.startsWith('run:')) > m.events.findIndex(e => e === 'leave:c2:data=true'), 'services stop only after circles are left');
  for (const path of [m.files.autostart, m.files.handler, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), false, path);
  assert.match(result.out, /Left Friends\./);
  assert.match(result.out, /Asked the owner of Friends, Work to remove this computer/);
  assert.match(result.out, /Faravan is uninstalled\./);
  assert.deepEqual(m.events.filter(e => e.startsWith('run:')), [
    ...['faravan-app.service', 'faravan-coordinator.service', 'faravan-tray.service'].flatMap(unit => [
      'run:systemctl --user show -p LoadState --value ' + unit, 'run:systemctl --user cat ' + unit]),
    'run:systemctl --user stop faravan-app.service faravan-coordinator.service faravan-tray.service', 'run:pkill -f ' + trayRegex(m.userHome),
    'run:systemctl --user is-active --quiet faravan-app.service', 'run:systemctl --user is-active --quiet faravan-coordinator.service',
    'run:systemctl --user is-active --quiet faravan-tray.service',
    'run:pgrep -f ' + trayRegex(m.userHome),
    // The sandbox services are their own units, found by the channel's description after cleanup; none runs here.
    'run:systemctl --user list-units --all --plain --no-legend --type=service faravan-sbxd-*',
    'run:systemctl --user disable faravan-app.service faravan-coordinator.service faravan-tray.service']);
});

// Two sandbox services run: this channel's (any sbx HOME it reached) and another channel's.
function sandboxServices({root, dataHome, mineState = 'inactive', mineCode = 3} = {}) {
  const mine = 'faravan-sbxd-aaaaaaaaaaaa-'+'a'.repeat(64)+'.service', other = 'faravan-sbxd-bbbbbbbbbbbb.service', commands = [];
  const answer = (command, args) => {
    if (command !== 'systemctl') return undefined;
    commands.push(args.join(' '));
    if (args.includes('list-units')) return {code: 0, stdout: `${mine} loaded active running Faravan\n${other} loaded active running Faravan\n`, stderr: ''};
    if (args.includes('show') && args.includes('Environment')) return {code:0,stdout:[
      'LoadState=loaded','ActiveState=active','MainPID=4242','InvocationID=checked-invocation',`Description=${sbxDaemonDescription(channelIdentity())}`,
      'ExecStart={ path=/usr/bin/sbx ; argv[]=/usr/bin/sbx daemon start ; }',
      'Environment='+systemdShowEnvironment({...credentialStoreEnv('/sandbox','linux'),FARAVAN_SBXD_OWNER_ID:'a'.repeat(64),FARAVAN_SBXD_INSTALL_ROOT:root,FARAVAN_SBXD_DATA_HOME:dataHome}),
    ].join('\n')};
    if (args.includes('show')) return {code: 0, stdout: (args.at(-1) === mine ? sbxDaemonDescription(channelIdentity()) : 'Faravan sandbox service (preview-other)') + '\n', stderr: ''};
    if (args.includes('is-active') && args.includes(mine)) return {code: mineCode, stdout: mineState + '\n', stderr: ''};
    return undefined;
  };
  return {mine, other, commands, answer};
}

test('uninstall stops only this installation\'s sandbox services and reads each stop back', async t => {
  const m = await machine(t);
  const services = sandboxServices({root:m.files.tree,dataHome:m.home});
  await writeFile(sbxOwnerFile(m.home, m.files.tree), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const result = await m.go(['--yes'], {device: m.device([]), run: answering(services.answer)});
  assert.equal(result.code, 0, result.err);
  assert.ok(services.commands.includes(`--user stop ${services.mine}`));
  assert.ok(services.commands.includes(`--user is-active ${services.mine}`));
  assert.equal(services.commands.some(line => line.includes('stop') && line.includes(services.other)), false, 'another channel\'s service is left alone');
});

// One uninstall lock is held from before the circles step until the data is
// gone; a sandbox create dispatch and a daemon restart honour the same lock.
test('uninstall holds its lock from the circles step on, and a second uninstall is refused', async t => {
  const m = await machine(t);
  const {uninstallInProgress, acquireUninstallLock} = await import('../lib/v1/uninstall-lock.mjs');
  let heldDuringCircles = null;
  const device = {...m.device([]), listCircles: async () => { heldDuringCircles = uninstallInProgress(m.home); return []; }};
  const result = await m.go(['--yes'], {device});
  assert.equal(result.code, 0, result.err);
  assert.equal(heldDuringCircles, true, 'the lock is held before the circles step');
  assert.equal(uninstallInProgress(m.home), false, 'the lock is released at the end');
  const m2 = await machine(t);
  const release = acquireUninstallLock(m2.home);
  try {
    const second = await m2.go(['--yes'], {device: m2.device([])});
    assert.equal(second.code, 1);
    assert.match(second.err, /Another uninstall/);
    for (const path of [m2.files.command, m2.files.tree, m2.home]) assert.equal(await exists(path), true, path);
  } finally { release(); }
});

test('uninstall leaves a sandbox service alone when it was replaced after the ownership check', async t => {
  const m = await machine(t);
  const services = sandboxServices({root:m.files.tree,dataHome:m.home});
  let shows = 0;
  const run = answering((command, args) => {
    if (command === 'systemctl' && args.includes('show') && args.includes('Environment')) {
      const shown = services.answer(command, args);
      return {...shown, stdout: shown.stdout + '\nInvocationID=' + (++shows === 1 ? 'checked-invocation' : 'replacement-invocation')};
    }
    return services.answer(command, args);
  });
  await writeFile(sbxOwnerFile(m.home, m.files.tree), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const result = await m.go(['--yes'], {device: m.device([]), run, inspectSandboxes: async () => []});
  assert.equal(result.code, 1);
  assert.equal(services.commands.includes(`--user stop ${services.mine}`), false, 'a replaced service is never stopped by name');
  assert.equal(await exists(m.home), true);
});

for (const [label, inventory] of [['runs a sandbox', [{pid: 77}]], ['cannot be checked for sandboxes', null]]) test(`uninstall leaves a sandbox service alone when it ${label}`, async t => {
  const m = await machine(t);
  const services = sandboxServices({root:m.files.tree,dataHome:m.home});
  const run = answering((command, args) => {
    const shown = services.answer(command, args);
    return command === 'systemctl' && args.includes('show') && args.includes('Environment') ? {...shown, stdout: shown.stdout + '\nInvocationID=checked-invocation'} : shown;
  });
  await writeFile(sbxOwnerFile(m.home, m.files.tree), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const result = await m.go(['--yes'], {device: m.device([]), run, inspectSandboxes: async () => inventory});
  assert.equal(result.code, 1);
  assert.equal(services.commands.includes(`--user stop ${services.mine}`), false);
  assert.equal(await exists(m.home), true);
});

for (const [label, state] of [['still running', {mineState: 'active', mineCode: 0}], ['still deactivating', {mineState: 'deactivating', mineCode: 3}]]) {
  test(`a sandbox service ${label} keeps the data and the installation`, async t => {
    const m = await machine(t);
    const services = sandboxServices({...state,root:m.files.tree,dataHome:m.home});
    await writeFile(sbxOwnerFile(m.home, m.files.tree), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
    const result = await m.go(['--yes'], {device: m.device([]), run: answering(services.answer)});
    assert.equal(result.code, 1);
    assert.match(result.err, /Could not stop the sandbox service: faravan-sbxd-a{12}-a{64}\.service/);
    for (const path of [m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
  });
}

test('when the owner cannot be asked, uninstall says to ask them by hand', async t => {
  const m = await machine(t);
  const result = await m.go(['--yes', '--json'], {device: m.device([{id: 'c1', name: 'Friends'}], false)});
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out);
  assert.deepEqual([report.asked, report.askByHand], [[], ['Friends']]);
  assert.ok(report.remaining.some(line => /Ask them to remove this computer/.test(line)));
});

test('--keep-data keeps the data folder and everything else still goes', async t => {
  const m = await machine(t);
  const result = await m.go(['--yes', '--keep-data'], {device: m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(join(m.home, 'v1/state.json')), true);
  assert.equal(await exists(m.files.autostart), false);
  assert.equal(await exists(m.files.command), false);
  assert.match(result.out, /Kept your data/);
});

test('interactive uninstall decline keeps the exact data directory untouched', async t => {
  const m = await machine(t);
  for (const keepData of [false, true]) {
    const stdin = Object.assign(Readable.from(['no\n']), {isTTY: true});
    const noEffects = () => assert.fail('a declined prompt must not start uninstall work');
    const result = await m.go(keepData ? ['--keep-data'] : [], {stdin, run: noEffects,
      kill: noEffects, device: {listCircles: noEffects}, inspectSandboxes: noEffects});
    assert.equal(result.code, 1);
    assert.ok(result.out.includes('Type "yes" to continue: '));
    assert.ok(result.out.includes('Nothing changed.'));
    const dataRemoval = 'removes the data directory ' + JSON.stringify(m.home) + ' and all its contents, including the archive of your earlier version.';
    if (keepData) {
      assert.ok(!result.out.includes(m.home));
      assert.ok(!result.out.includes('all its contents'));
    } else {
      assert.ok(result.out.includes(dataRemoval));
    }
    assert.equal(await readFile(join(m.home, 'v1/state.json'), 'utf8'), 'x\n');
    assert.equal(await exists(m.files.command), true);
  }
});

test('interactive uninstall decline quotes a selected path containing a quotation mark and newline', async t => {
  const m = await machine(t, {dataDirectory: 'Faravan "Preview"\narchive'});
  const stdin = Object.assign(Readable.from(['no\n']), {isTTY: true});
  const noEffects = () => assert.fail('a declined prompt must not start uninstall work');
  const result = await m.go([], {stdin, run: noEffects, kill: noEffects,
    device: {listCircles: noEffects}, inspectSandboxes: noEffects});
  assert.equal(result.code, 1);
  const [line] = result.out.split('\n');
  assert.ok(line.includes('removes the data directory ' + JSON.stringify(m.home) + ' and all its contents, including the archive of your earlier version.'));
  assert.match(line, /Type "yes" to continue:/);
  assert.ok(!result.out.includes(m.home));
  assert.equal(await readFile(join(m.home, 'v1/state.json'), 'utf8'), 'x\n');
  assert.equal(await exists(m.files.command), true);
});

test('without --yes a non-interactive run changes nothing', async t => {
  const m = await machine(t);
  const result = await m.go([], {device: m.device([{id: 'c1', name: 'Friends'}]), stdin: {isTTY: false}});
  assert.equal(result.code, 2);
  assert.match(result.err, /--yes/);
  assert.deepEqual(m.events, []);
  assert.equal(await exists(m.files.autostart), true);
});

test('an unknown option is a usage error', async t => {
  const m = await machine(t);
  assert.equal((await m.go(['--yes', '--force'])).code, 2);
  assert.equal(await exists(m.files.autostart), true);
});

test('a circle this computer hosts stops uninstall unless the user says so', async t => {
  const m = await machine(t);
  await planHost(m);
  const circles = [{id: 'h1', name: 'Family', owned: true}];
  let result = await m.go(['--yes'], {device: m.device(circles)});
  assert.equal(result.code, 1);
  assert.match(result.err, /hosts Family/);
  assert.deepEqual(m.events, [], 'it did not leave, stop or delete anything');
  assert.equal(await exists(m.home), true);
  result = await m.go(['--yes', '--keep-data'], {device: m.device(circles)});
  assert.equal(result.code, 0, 'keeping the data keeps the circle, so it is allowed');
  const again = await machine(t);
  result = await again.go(['--yes', '--delete-hosted-circles'], {device: again.device(circles)});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(again.home), false);
});

test('--keep-data keeps the real default offline owned circle and still removes the program', async t => {
  const m = await machine(t);
  const {device, circle} = await defaultOfflineDevice(m);
  const result = await m.go(['--yes', '--keep-data'], {device});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(await device.listCircles(), [circle], 'keep-data never leaves or changes an owned circle');
  assert.equal(await exists(join(m.home, 'v1/state.json')), true);
  assert.equal(await exists(m.files.command), false);
  assert.ok(m.events.some(event => event.startsWith('run:systemctl --user disable ')), 'service cleanup still runs');
  assert.match(result.out, /Kept your data/);
});

test('--delete-hosted-circles closes the real default offline circle before leaving it', async t => {
  const m = await machine(t);
  const {device, circle} = await defaultOfflineDevice(m);
  const calls = [];
  const realDevice = new Proxy(device, {get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'setCircleLifecycle') return async (...args) => {
      calls.push(['close', args[0], args[1]]);
      return value(...args);
    };
    if (property === 'leaveCircle') return async (...args) => {
      calls.push(['leave', args[0], target.selectCircle(args[0]).lifecycle]);
      return value(...args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const result = await m.go(['--yes', '--delete-hosted-circles'], {device:realDevice});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, [['close', circle.id, 'closed'], ['leave', circle.id, 'closed']]);
  assert.equal(await exists(m.home), false);
  assert.equal(await exists(m.files.command), false);
});

test('package purge preparation refuses a failed close on the real default offline circle', async t => {
  const m = await machine(t);
  const {device, circle} = await defaultOfflineDevice(m);
  const calls = [];
  const failingDevice = new Proxy(device, {get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === 'setCircleLifecycle') return async (...args) => {
      calls.push(['close', ...args]);
      throw new Error('lifecycle unavailable');
    };
    if (property === 'leaveCircle') return async (...args) => {
      calls.push(['leave', ...args]);
      return value(...args);
    };
    return typeof value === 'function' ? value.bind(target) : value;
  }});

  const result = await m.go(['--yes', '--delete-hosted-circles', '--package-prepare-only', '--json'], {device:failingDevice});
  assert.equal(result.code, 1);
  assert.match(result.err, /lifecycle unavailable/);
  assert.deepEqual(calls, [['close', circle.id, 'closed']]);
  assert.deepEqual(await device.listCircles(), [circle], 'the real device circle remains open');
  assert.equal(await exists(join(m.home, 'v1/state.json')), true);
  assert.deepEqual(m.events, [], 'no service or program cleanup ran');
});

test('uninstall rejects conflicting keep-data and delete-hosted-circles flags', async t => {
  const m = await machine(t);
  const {device, circle} = await defaultOfflineDevice(m);
  const result = await m.go(['--yes', '--keep-data', '--delete-hosted-circles'], {device});
  assert.equal(result.code, 2);
  assert.match(result.err, /Choose either --keep-data or --delete-hosted-circles/);
  assert.deepEqual(await device.listCircles(), [circle]);
  assert.deepEqual(m.events, []);
});

test('if leaving a circle fails nothing else is removed', async t => {
  const m = await machine(t);
  const device = {listCircles: async () => [{id: 'c1', name: 'Friends'}], leaveCircle: async () => { throw new Error('A job is still running.'); }};
  const result = await m.go(['--yes'], {device});
  assert.equal(result.code, 1);
  assert.match(result.err, /Could not leave your circles: A job is still running\./);
  for (const path of [m.files.autostart, m.files.command, m.home]) assert.equal(await exists(path), true, path);
  assert.deepEqual(m.events, []);
});

test('uninstalling twice is safe', async t => {
  const m = await machine(t);
  assert.equal((await m.go(['--yes'], {device: m.device([])})).code, 0);
  assert.equal((await m.go(['--yes'], {device: m.device([])})).code, 0);
});

test('a running app leaves the circles through its own API, is stopped, and its data goes', async t => {
  const m = await machine(t);
  await writeFile(join(m.home, 'v1/app.json'), JSON.stringify({port: 4321, token: 'secret-token', pid: 424242, started_at: new Date().toISOString()}));
  const calls = [];
  let running = true;
  const fetch = async (url, options) => {
    calls.push(options.method + ' ' + new URL(url).pathname + ' ' + options.headers['x-faravan-session-token']);
    const body = options.method === 'GET' ? [{id: 'c1', name: 'Friends'}] : {id: 'c1', left: true};
    return {ok: true, json: async () => body};
  };
  const kills = [];
  const result = await m.go(['--yes'], {fetch, alive: pid => pid === 424242 && running, kill: (pid, signal) => { kills.push(pid + ':' + signal); running = false; }, sleep: async () => {}});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, ['GET /api/circles secret-token', 'POST /api/circles/c1/leave secret-token']);
  assert.deepEqual(kills, ['424242:SIGTERM']);
  assert.equal(await exists(m.home), false);
  assert.equal(result.out.includes('secret-token'), false);
});

test('a PID saved in app.json that now names an unrelated process is never signalled', async t => {
  const m = await machine(t);
  // The app is gone: nothing holds the app lock, and its saved PID now belongs to a process the test started.
  const {spawn} = await import('node:child_process'), {once} = await import('node:events');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.send("ready");'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  t.after(async () => { if (unrelated.exitCode === null && unrelated.signalCode === null) { const done = once(unrelated, 'exit'); unrelated.kill('SIGKILL'); await done; } });
  await once(unrelated, 'message');
  await writeFile(join(m.home, 'v1/app.json'), JSON.stringify({port: 4321, token: 'secret-token', pid: unrelated.pid, started_at: new Date().toISOString()}));
  const fetch = async (url, options) => ({ok: true, json: async () => options.method === 'GET' ? [{id: 'c1', name: 'Friends'}] : {id: 'c1', left: true}});
  // No `kill` is injected: the real signal path runs, as it does for a person who runs uninstall.
  await m.go(['--yes'], {fetch, sleep: async () => {}});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(unrelated.exitCode, null, 'the unrelated process was not signalled');
  assert.equal(unrelated.signalCode, null, 'the unrelated process was not signalled');
});

test('a running app that refuses to leave a circle blocks uninstall', async t => {
  const m = await machine(t);
  await writeFile(join(m.home, 'v1/app.json'), JSON.stringify({port: 4321, token: 't', pid: 424242, started_at: new Date().toISOString()}));
  const fetch = async (url, options) => options.method === 'GET'
    ? {ok: true, json: async () => [{id: 'c1', name: 'Friends'}]}
    : {ok: false, json: async () => ({message: 'A job needs recovery first.'})};
  const result = await m.go(['--yes'], {fetch, alive: () => true, kill: () => assert.fail('must not stop the app'), sleep: async () => {}});
  assert.equal(result.code, 1);
  assert.match(result.err, /A job needs recovery first\./);
  assert.equal(await exists(m.home), true);
});

test('a package install is not touched: uninstall says how to remove it', async t => {
  const m = await machine(t);
  await rm(m.files.marker);
  const result = await m.go(['--yes'], {device: m.device([]), installDir: '/usr/lib/faravan'});
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /sudo apt remove faravan/);
  assert.equal(await exists(m.files.command), true, 'a package manager owns /usr, and a stray user link is not ours');
});

test('the data folder must look like Faravan data and never be the home folder', async t => {
  const m = await machine(t);
  assert.match(await dataDirectoryProblem(m.userHome, m.userHome), /not a safe place/);
  assert.match(await dataDirectoryProblem('/', m.userHome), /not a safe place/);
  assert.match(await dataDirectoryProblem(join(m.userHome, '..'), m.userHome), /not a safe place/);
  const other = join(m.userHome, 'Documents');
  await mkdir(other);
  await writeFile(join(other, 'thesis.docx'), 'x');
  assert.match(await dataDirectoryProblem(other, m.userHome), /does not look like Faravan data/);
  assert.equal(await dataDirectoryProblem(m.home, m.userHome), null);
  const result = await m.go(['--yes'], {device: m.device([]), home: other});
  assert.equal(result.code, 1);
  assert.equal(await exists(join(other, 'thesis.docx')), true);
  assert.equal(await exists(m.files.autostart), true, 'nothing was removed');
});

test('macOS: a label-only login agent stays until its ownership can be verified', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  for (const [name, label] of [['homebrew.mxcl.faravan.plist', 'homebrew.mxcl.faravan'], ['com.faravan.agent.plist', 'com.faravan.agent'], ['com.example.other.plist', 'com.example.other']]) {
    await writeFile(join(agents, name), launchAgentPlist(label));
  }
  const commands = [];
  const result = await m.go(['--yes', '--keep-data'], {device: m.device([]), run: answering(undefined, (c, a) => commands.push([c, ...a].join(' ')))});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /ownership/);
  assert.equal(await exists(join(agents, 'homebrew.mxcl.faravan.plist')), true, 'the Homebrew agent has a label this uninstall does not own');
  assert.equal(await exists(join(agents, 'com.faravan.agent.plist')), true);
  assert.equal(await exists(join(agents, 'com.example.other.plist')), true, 'someone else\'s agent stays');
  assert.ok(!commands.includes('launchctl bootout gui/1000/com.faravan.agent'));
});

test('Windows: the Run entry, the toast identity and the link handler are deleted from HKCU only', () => {
  const owned = {units: [], tray: 'C:\\Faravan\\faravan-tray.exe', task: true, winRun: true, files: ['C:\\Startup\\Faravan.lnk'], kept: []};
  const t = platformTargets({platform: 'win32', userHome: 'C:\\Users\\Rowan', env: {APPDATA: 'C:\\Users\\Rowan\\AppData\\Roaming'}, owned});
  const keys = t.unregisterCommands.filter(([c]) => c === 'reg').map(([, a]) => a[1]);
  assert.deepEqual(keys, ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'HKCU\\Software\\Classes\\AppUserModelId\\Faravan.Desktop', 'HKCU\\Software\\Classes\\faravan', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce']);
  assert.ok(keys.every(k => k.startsWith('HKCU\\')), 'never the machine hive');
  assert.match(t.files[0], /Startup/);
  assert.ok(t.commands.some(([c, a]) => c === 'powershell.exe' && a.at(-1).includes("$_.Path -eq 'C:\\Faravan\\faravan-tray.exe'")), 'the tray is stopped by its own path, never by image name');
  assert.ok(!t.commands.some(([c]) => c === 'taskkill'));
  const none = platformTargets({platform: 'win32', userHome: 'C:\\Users\\Rowan', env: {APPDATA: 'C:\\Users\\Rowan\\AppData\\Roaming'}});
  assert.deepEqual([none.commands, none.files, none.unregisterCommands.filter(([c, a]) => c === 'schtasks' || a.includes('/v') && a.includes('Faravan'))], [[], [], []], 'with nothing proven to be this install\'s, no task, tray, login entry or shortcut is touched');
});

test('Windows: a failed stop is not proof; a tray that is still running at its own path blocks deletion', async t => {
  const m = await machine(t, {platform: 'win32'});
  const run = answering(withWindows(m, {tray: {code: 1, stdout: '', stderr: ''}}));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /the tray is still running/);
  assert.equal(await exists(m.home), true, 'the data stays while the tray runs');
});

test('Windows: a tray read-back that fails to answer blocks uninstall', async t => {
  const m = await machine(t, {platform: 'win32'});
  const run = answering(withWindows(m, {tray: {code: 5, stdout: '', stderr: 'Access is denied.'}}));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /the tray could not be checked/);
  assert.equal(await exists(m.files.tree), true, 'the program stays when the tray cannot be proven stopped');
  assert.equal(await exists(m.home), true, 'the data stays when the tray cannot be proven stopped');
});

test('Windows: once the tray reads back stopped, uninstall removes the program and the data', async t => {
  const m = await machine(t, {platform: 'win32'});
  const result = await m.go(['--yes'], {device: m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.home), false);
});

test('tarball and checkout installs are told apart', async t => {
  const m = await machine(t);
  assert.equal((await installKind({installDir: m.files.tree})).kind, 'tarball');
  assert.equal((await installKind({installDir: '/usr/lib/faravan'})).kind, 'apt');
  assert.equal((await installKind({installDir: '/opt/homebrew/Cellar/faravan/0.1/libexec'})).kind, 'brew');
  assert.equal((await installKind({installDir: '/home/dev/faravan'})).kind, 'checkout');
});

test('uninstall has help', () => {
  assert.match(helpFor(['uninstall']), /--keep-data/);
  assert.match(topLevelUsage(), /uninstall/);
});

test('plan with no app and no data lists only what exists and changes nothing', async t => {
  const m = await machine(t);
  await rm(join(m.home, 'v1'), {recursive: true});
  const plan = await uninstallPlan({...m.base, device: undefined});
  assert.equal(plan.dry_run, true);
  assert.deepEqual([plan.app_running, plan.circles, plan.would_leave, plan.blocked, plan.data_problem], [false, [], [], null, null]);
  assert.deepEqual(plan.files.sort(), [m.files.autostart, m.files.handler].sort());
  assert.deepEqual(plan.install, {kind: 'tarball', remove: [m.files.command, m.files.tree]});
  assert.deepEqual(plan.data_dir, {path: m.home, would_remove: true, exists: true});
  assert.deepEqual(plan.commands.map(([c]) => c), ['pkill'], 'a dry run reads no service definition, so it lists only the tray at this install\'s own path');
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  for (const path of [m.files.autostart, m.files.command, m.home]) assert.equal(await exists(path), true, path);
  assert.deepEqual(m.events, []);
});

test('plan: a hosted circle blocks unless the data is kept or hosted circles may end', async t => {
  const m = await machine(t);
  await planHost(m);
  const device = m.device([{id: 'h1', name: 'Family', owned: true}, {id: 'c1', name: 'Friends'}]);
  const plan = await uninstallPlan({...m.base, device});
  assert.deepEqual(plan.blocked && [plan.blocked.code, plan.blocked.circles], ['hosted_circle', ['Family']]);
  assert.match(plan.blocked.message, /hosts Family/);
  assert.deepEqual(plan.circles, [{id: 'h1', name: 'Family', owned: true}, {id: 'c1', name: 'Friends', owned: false}]);
  assert.deepEqual(plan.would_leave, ['Family', 'Friends']);
  assert.equal((await uninstallPlan({...m.base, device, keepData: true})).blocked, null);
  assert.equal((await uninstallPlan({...m.base, device, deleteHostedCircles: true})).blocked, null);
  const kept = await uninstallPlan({...m.base, device, keepData: true});
  assert.deepEqual(kept.would_leave, ['Friends']);
  assert.deepEqual(kept.would_keep_hosted, ['Family']);
  assert.deepEqual(kept.data_dir, {path: m.home, would_remove: false, exists: true});
  assert.deepEqual(m.events, [], 'it never left a circle');
});

test('plan through a running app only reads the circle list and never stops the app', async t => {
  const m = await machine(t);
  await writeFile(join(m.home, 'v1/app.json'), JSON.stringify({port: 4321, token: 'secret-token', pid: 424242, started_at: new Date().toISOString()}));
  const calls = [];
  const fetch = async (url, options) => { calls.push(options.method + ' ' + new URL(url).pathname); return {ok: true, json: async () => [{id: 'c1', name: 'Friends'}]}; };
  const plan = await uninstallPlan({...m.base, fetch, alive: () => true, kill: () => assert.fail('must not stop the app')});
  assert.equal(plan.app_running, true);
  assert.deepEqual(plan.would_leave, ['Friends']);
  assert.deepEqual(calls, ['GET /api/circles']);
});

test('--dry-run --json prints the plan, needs no --yes and removes nothing', async t => {
  const m = await machine(t);
  const result = await m.go(['--dry-run', '--json'], {device: m.device([{id: 'c1', name: 'Friends'}]), kill: () => assert.fail('no kill'), stdin: {isTTY: false}});
  assert.equal(result.code, 0, result.err);
  const plan = JSON.parse(result.out);
  assert.deepEqual([plan.dry_run, plan.would_leave, plan.install.kind], [true, ['Friends'], 'tarball']);
  assert.deepEqual(m.events, [], 'no command ran and no circle was left');
  for (const path of [m.files.autostart, m.files.handler, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
});

test('--dry-run in words says what blocks it and still returns 0', async t => {
  const m = await machine(t);
  await planHost(m);
  const result = await m.go(['--dry-run'], {device: m.device([{id: 'h1', name: 'Family', owned: true}])});
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Dry run: nothing was changed\./);
  assert.match(result.out, /Blocked: This computer hosts Family/);
  assert.match(result.out, /Would remove .*faravan-tray\.desktop/);
  assert.deepEqual(m.events, []);
  assert.match(helpFor(['uninstall']), /--dry-run/);
});

for (const platform of ['linux', 'darwin', 'win32']) {
  for (const gate of ['stop', 'coordinator', 'cleanup']) {
    test(`${platform}: failed ${gate} keeps start-at-login registered`, async t => {
      const m = await machine(t, {platform});
      const commands = [];
      const run = answering((command, args) => {
        if (platform === 'linux') { const unit = ownUnits(m.userHome)(command, args); if (unit) return unit; }
        if (platform === 'win32') { const owned = windowsAnswer(m, {tray: gate === 'stop' ? {code: 1} : undefined})(command, args); if (owned) return owned; }
        if (gate !== 'stop') return undefined;
        if (command === 'pgrep') return {code: 0};
      }, (command, args) => commands.push([command, ...args].join(' ')));
      const result = await m.go(['--yes'], {
        device: m.device([]), run, channel: STABLE_CHANNEL, installDir: platform === 'darwin' ? join(m.userHome, 'Faravan.app/Contents/Resources/faravan') : m.files.tree,
        hostedCoordinatorRecord: async () => null,
        stopV1Host: async () => { if (gate === 'coordinator') throw new Error('coordinator still running'); },
        cleanupBackend: {reapCleanup: async () => {}, cleanupStatus: () => ({state: gate === 'cleanup' ? 'pending' : 'clear'})},
      });
      assert.equal(result.code, 1, result.out);
      assert.match(result.err, gate === 'stop' ? /the tray is still running/ : gate === 'coordinator' ? /Your data was kept/ : /Your data and installation were kept/);
      assert.deepEqual(commands.filter(command => /systemctl --user disable|delete login item|^reg delete |schtasks \/Delete/.test(command)), [],
        'a failed uninstall must not unregister start-at-login');
      for (const path of [m.files.autostart, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
    });
  }
}

test('Windows: a stopped registered resident task passes the stop gate before unregistering', async t => {
  const m = await machine(t, {platform: 'win32'});
  const events = [];
  let registered = true;
  const run = answering((command, args) => {
    if (command === 'schtasks' && args[0] === '/Delete') registered = false;
    const owned = windowsAnswer(m, {tray: {code: 0}})(command, args);
    if (owned) return owned;
    if (command === 'powershell.exe') return {code: registered && !args.at(-1).includes("State -eq 'Running'") ? 1 : 0};
  }, (command, args) => events.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {
    device: m.device([]), run, hostedCoordinatorRecord: async () => null, stopV1Host: async () => {},
    cleanupBackend: {reapCleanup: async () => { events.push('cleanup cleared'); }, cleanupStatus: () => ({state: 'clear'})},
  });
  assert.equal(result.code, 0, result.err);
  assert.ok(events.findIndex(event => event.startsWith('schtasks /Delete')) > events.indexOf('cleanup cleared'),
    'the registered but stopped resident task is removed only after cleanup clears');
  assert.equal(registered, false);
});

test('a service still running after its stop blocks uninstall, so no file is deleted under it', async t => {
  const m = await machine(t);
  const run = answering(withUnits(m.userHome, (command, args) => args.includes('is-active') ? {code: 0} : command === 'systemctl' && args.includes('stop') ? {code: 1} : undefined));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /faravan-app\.service is still running/);
  assert.match(result.err, /Nothing else was removed/);
  for (const path of [m.files.autostart, m.files.handler, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
});

test('a service whose state cannot be read blocks uninstall: no user bus is not proof of stopped', async t => {
  const m = await machine(t);
  const run = answering(withUnits(m.userHome, (command, args) => args.includes('is-active') ? {code: 1} : undefined));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /faravan-coordinator\.service could not be checked/);
  assert.equal(await exists(m.home), true);
  assert.equal(await exists(m.files.command), true);
});

test('a missing systemctl executable proves no ownership: the services are kept, never stopped, and listed as left in place', async t => {
  const m = await machine(t);
  const seen = [];
  const run = answering(command => command === 'systemctl'
    ? {code: 'ENOENT', stdout: '', stderr: 'spawn systemctl ENOENT'}
    : undefined, (command, args) => seen.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(seen.filter(line => /systemctl --user (stop|disable|is-active)/.test(line)), [], 'no service is stopped, disabled or read back');
  assert.match(result.out, /Left in place: The service faravan-app\.service could not be read, so its owner is unknown/);
  assert.equal(await exists(m.home), false);
});

test('a unit that was never installed is not a failure: its disable fails and its state reads as not installed', async t => {
  const m = await machine(t);
  // systemd 259 on this host: `show` says not-found for a missing unit. Nothing is stopped for it.
  const run = answering((command, args) => command === 'systemctl' && args.includes('stop') ? {code: 5} : undefined);
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.home), false);
  assert.equal(await exists(m.files.command), false);
});

test('a sandbox service list that cannot be read blocks uninstall', async t => {
  const m = await machine(t);
  const run = answering((command, args) => command === 'systemctl' && args.includes('list-units') ? {code: 1, stdout: '', stderr: 'Failed to connect to bus'} : undefined);
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /Could not stop the sandbox service: the sandbox service list/);
  assert.equal(await exists(m.home), true);
});

test('a tray still running after its signal blocks uninstall, even when pkill reported success', async t => {
  const m = await machine(t);
  const run = answering((command) => command === 'pgrep' ? {code: 0} : undefined);
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /the tray is still running/);
  assert.equal(await exists(m.files.command), true);
  assert.equal(await exists(m.home), true);
});

test('a tray whose state cannot be read blocks uninstall', async t => {
  const m = await machine(t);
  const run = answering((command) => command === 'pgrep' ? {code: 3} : undefined);
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /the tray could not be checked/);
  assert.equal(await exists(m.home), true);
});

test('macOS: a launch agent still loaded after bootout blocks uninstall', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  await writeFile(join(agents, 'com.faravan.agent.plist'), launchAgentPlist('com.faravan.agent'));
  const run = answering((command, args) => command === 'launchctl' && args.includes('bootout') ? {code: 5} : command === 'launchctl' ? {code: 0} : undefined);
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1);
  assert.match(result.err, /ownership|could not read.*Label|launch-agent Label/i);
  assert.equal(await exists(join(agents, 'com.faravan.agent.plist')), true);
  assert.equal(await exists(m.home), true);
});

test('macOS: a failed bootout and a launchctl print that cannot answer still block deletion', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  await writeFile(join(agents, 'com.faravan.agent.plist'), launchAgentPlist('com.faravan.agent'));
  const run = answering((command, args) => {
    if (command === 'launchctl' && args.includes('bootout')) return {code: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error'};
    if (command === 'launchctl' && args.includes('print')) return {code: 5, stdout: '', stderr: 'Input/output error'};
    return undefined;
  });
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /ownership|could not read.*Label|launch-agent Label/i);
  assert.equal(await exists(join(agents, 'com.faravan.agent.plist')), true);
  assert.equal(await exists(m.home), true, 'the data stays when the agent state is unknown');
});

test('macOS: a foreign launch-agent label is preserved even when its filename contains faravan', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  await writeFile(join(agents, 'com.faravan.wrapper.plist'), launchAgentPlist('com.faravan.actual'));
  const commands = [];
  const run = answering((command, args) => {
    if (command !== 'launchctl') return undefined;
    commands.push([command, ...args].join(' '));
    if (args[0] === 'bootout') return {code: 5, stdout: '', stderr: 'Boot-out failed'};
    if (args[0] === 'print' && args[1] === 'gui/1000/com.faravan.actual') return {code: 0, stdout: 'service = com.faravan.actual', stderr: ''};
    if (args[0] === 'print' && args[1] === 'gui/1000/com.faravan.wrapper') return {code: 113, stdout: '', stderr: 'Could not find service'};
    return undefined;
  });
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 0, result.err);
  assert.equal(commands.some(command => command.includes('com.faravan.actual')), false);
  assert.equal(await exists(join(agents, 'com.faravan.wrapper.plist')), true);
  assert.equal(await exists(m.files.tree), false);
});

test('macOS: a missing app plist does not hide its still-loaded known launch agent', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const plist = join(m.userHome, 'Library/LaunchAgents/com.faravan.agent.plist');
  await mkdir(join(m.userHome, 'Library/LaunchAgents'), {recursive: true});
  await writeFile(plist, launchAgentPlist('com.faravan.agent'));
  await rm(plist);
  const commands = [];
  const run = answering((command, args) => {
    if (command !== 'launchctl') return undefined;
    commands.push([command, ...args].join(' '));
    if (args[0] === 'bootout') return {code: 5, stdout: '', stderr: 'Service is still loaded'};
    if (args[0] === 'print' && args[1] === 'gui/1000/com.faravan.agent') return {code: 0, stdout: 'service = com.faravan.agent', stderr: ''};
    return undefined;
  });
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /ownership|could not read.*Label|launch-agent Label/i);
  assert.ok(!commands.includes('launchctl bootout gui/1000/com.faravan.agent'));
  assert.ok(commands.includes('launchctl print gui/1000/com.faravan.agent'));
  assert.equal(await exists(plist), false, 'the fixture is absent before uninstall');
  assert.equal(await exists(m.files.tree), true, 'the runtime stays while the known agent is loaded');
  assert.equal(await exists(m.home), true, 'the data stays while the known agent is loaded');
});

test('macOS: an unreadable launch-agent Label makes the state unknown and blocks deletion', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  await writeFile(join(agents, 'com.faravan.agent.plist'), '<plist><dict><key>KeepAlive</key><true/></dict></plist>');
  const commands = [];
  const run = answering((command, args) => {
    commands.push([command, ...args].join(' '));
    if (command === 'plutil') return {code: 1, stdout: '', stderr: 'Label is missing'};
    return undefined;
  });
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /ownership|could not read.*Label|launch-agent Label/i);
  assert.equal(commands.some(command => command.startsWith('launchctl ')), false, 'unknown Label prevents an unsafe stop attempt');
  assert.equal(await exists(m.files.tree), true);
  assert.equal(await exists(m.home), true);
});

test('a tarball install is removed from the root it runs in, never from a default root under ~/.local', async t => {
  const m = await machine(t);
  const custom = join(m.userHome, 'custom'), tree = join(custom, 'lib', 'faravan');
  await mkdir(join(tree, 'runtime', 'bin'), {recursive: true});
  await mkdir(join(custom, 'bin'), {recursive: true});
  await writeFile(join(tree, '.installed-via'), 'tarball\n');
  await writeFile(join(custom, 'bin', 'faravan'), launcher(custom));
  await writeFile(join(custom, 'bin', 'faravan'), `#!/bin/sh\n# faravan-tarball-shim: ${custom}\nexec "${custom}/bin/faravan" "$@"\n`);
  const result = await m.go(['--yes'], {device: m.device([]), installDir: tree});
  assert.equal(result.code, 0, result.err);
  for (const path of [tree, join(custom, 'bin', 'faravan'), join(custom, 'bin', 'faravan')]) assert.equal(await exists(path), false, path);
  for (const path of [m.files.command, m.files.tree]) assert.equal(await exists(path), true, 'a different install is not ours to remove: ' + path);
});

test('a tarball root comes from the install directory, and a directory outside lib/faravan has no root to remove', async t => {
  const m = await machine(t);
  assert.deepEqual(await installKind({installDir: m.files.tree}), {kind: 'tarball', root: join(m.userHome, '.local')});
  const loose = join(m.userHome, 'loose');
  await mkdir(loose, {recursive: true});
  await writeFile(join(loose, '.installed-via'), 'tarball\n');
  assert.deepEqual(await installKind({installDir: loose}), {kind: 'tarball', root: null});
});

test('uninstall keeps a command it did not install and still removes the program', async t => {
  const m = await machine(t);
  await writeFile(m.files.command, '#!/bin/sh\necho my own tool\n');
  const foreignFaravan = join(m.userHome, '.local/bin/faravan');
  await writeFile(foreignFaravan, '#!/bin/sh\necho another tool\n');
  const result = await m.go(['--yes'], {device: m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.files.command), true, 'a command this install did not write stays');
  assert.equal(await exists(foreignFaravan), true, 'a Faravan command this install did not write stays');
  assert.equal(await exists(m.files.tree), false);
  assert.match(result.out, /not the launcher this install wrote/);
});

test('apt uninstall removes owned portable leftovers and preserves app-style profile neighbors', async t => {
  const m = await machine(t);
  const custom = join(m.userHome, 'custom-install');
  const roots = [join(m.userHome, '.local'), custom];
  const customLine = `case ":$PATH:" in *":${custom}/bin:"*) ;; *) export PATH="${custom}/bin:$PATH" ;; esac`;
  const localLine = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
  for (const root of roots) {
    await mkdir(join(root, 'lib', 'faravan', 'runtime', 'bin'), {recursive: true});
    await mkdir(join(root, 'bin'), {recursive: true});
    await writeFile(join(root, 'lib', 'faravan', '.installed-via'), 'tarball\n');
    await writeFile(join(root, 'bin', 'faravan'), launcher(root));
    await writeFile(join(root, 'bin', 'faravan'), `#!/bin/sh\n# faravan-tarball-shim: ${root}\nexec "${root}/bin/faravan" "$@"\n`);
  }
  await writeFile(join(m.userHome, '.profile'), `before\n# Faravan command path\n${customLine}\nafter custom\n# Faravan command path\n${localLine}\nafter local\n`);

  const result = await m.go(['--yes'], {
    device: m.device([]), installDir: '/usr/lib/faravan',
    env: {FARAVAN_INSTALL_ROOT: custom},
  });
  assert.equal(result.code, 0, result.err);
  for (const root of roots) {
    for (const path of [join(root, 'bin', 'faravan'), join(root, 'bin', 'faravan'), join(root, 'lib', 'faravan')])
      assert.equal(await exists(path), false, path);
  }
  assert.equal(await readFile(join(m.userHome, '.profile'), 'utf8'), 'before\nafter custom\nafter local\n');
  assert.match(result.out, /sudo apt remove faravan/);
  assert.match(result.out, /apt repository files remain/);
  assert.match(result.out, /faravan\.sources/);
  assert.match(result.out, /faravan-archive-keyring\.gpg/);
});

test('uninstall finds an owned custom install from its PATH block when FARAVAN_INSTALL_ROOT is unset', async t => {
  const m = await machine(t);
  const custom = join(m.userHome, 'custom-install'), tree = join(custom, 'lib', 'faravan');
  await mkdir(join(tree, 'runtime', 'bin'), {recursive: true});
  await mkdir(join(custom, 'bin'), {recursive: true});
  await writeFile(join(tree, '.installed-via'), 'tarball\n');
  await writeFile(join(custom, 'bin', 'faravan'), launcher(custom));
  await writeFile(join(custom, 'bin', 'faravan'), `#!/bin/sh\n# faravan-tarball-shim: ${custom}\nexec "${custom}/bin/faravan" "$@"\n`);
  await writeFile(join(m.userHome, '.profile'), `# Faravan command path\n# keep this note\ncase ":$PATH:" in *":${custom}/bin:"*) ;; *) export PATH="${custom}/bin:$PATH" ;; esac\n`);
  const result = await m.go(['--yes'], {device: m.device([]), installDir: '/usr/lib/faravan', env: {}});
  assert.equal(result.code, 0, result.err);
  for (const path of [tree, join(custom, 'bin', 'faravan'), join(custom, 'bin', 'faravan')]) assert.equal(await exists(path), false, path);
  assert.equal(await readFile(join(m.userHome, '.profile'), 'utf8'), '# keep this note\n');
});

test('uninstall with no install marker removes its PATH block and reports the program left in place', async t => {
  const m = await machine(t);
  await rm(m.files.marker);
  const profile = join(m.userHome, '.profile');
  await writeFile(profile, '# Faravan command path\n# user note\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n');
  const result = await m.go(['--yes'], {device: m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.files.tree), true);
  assert.equal(await readFile(profile, 'utf8'), '# user note\n');
  assert.match(result.out, /Faravan program remains at .* install type could not be identified/);
  assert.doesNotMatch(result.out, /Faravan is uninstalled\./);
});

test('uninstall rewrites a symlinked shell profile atomically and keeps the target mode', async t => {
  const m = await machine(t);
  const target = join(m.userHome, 'shell-profile-target'), profile = join(m.userHome, '.profile');
  await writeFile(target, 'before\n# Faravan command path\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\nafter\n', {mode: 0o640});
  await chmod(target, 0o640);
  await symlink(target, profile);
  const result = await m.go(['--yes'], {device: m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.equal((await lstat(profile)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'before\nafter\n');
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});

test('profile updates stage in the resolved target directory and rename over the target', async () => {
  const source = await readFile(new URL('../lib/v1/uninstall.mjs', import.meta.url), 'utf8');
  assert.match(source, /const target = await realpath\(path\);[\s\S]*mkdtemp\(join\(dirname\(target\)/);
  assert.match(source, /await rename\(temp, target\)/);
});

test('dry-run lists the actual .new runtime staging path', async t => {
  const m = await machine(t);
  const staged = join(m.userHome, '.local', 'lib', 'faravan.new');
  await mkdir(staged);
  const plan = await uninstallPlan({home: m.home, userHome: m.userHome, installDir: m.files.tree, device: m.device([])});
  assert.ok(plan.install.remove.includes(staged));
});

async function previewLogin(t) {
  const m = await machine(t, {platform: 'darwin'});
  const installDir = join(m.userHome, 'Preview.app/Contents/Resources/faravan');
  await mkdir(join(installDir, 'lib'), {recursive: true});
  await writeFile(join(installDir, 'channel.json'), JSON.stringify({...STABLE_CHANNEL,
    id: 'faravan', name: 'Faravan', dataFolder: 'Faravan',
    bundleId: 'com.faravan.app', helperBundleId: 'com.faravan.app.notify',
    launchAgentLabel: 'com.faravan.agent', linuxPrefix: 'faravan'}));
  const channel = channelIdentity(join(installDir, 'lib/channel-identity.mjs'));
  const launcher = join(m.userHome, 'Preview.app/Contents/MacOS/faravan-launch');
  const env = {FARAVAN_HOME: m.home};
  const agents = join(m.userHome, 'Library/LaunchAgents');
  await mkdir(agents, {recursive: true});
  const plist = join(agents, channel.launchAgentLabel + '.plist');
  await writeFile(plist, generatedLaunchAgentPlist(launcher, channel.launchAgentLabel, env));
  const options = {...m.base, channel, installDir, env, device: m.device([]),
    alive: () => false, kill: () => assert.fail('no real process signal'),
    cleanupBackend: {reapCleanup: async () => {}, cleanupStatus: () => ({state: 'clear'})}};
  const go = async (extra = {}, argv = ['--yes', '--keep-data']) => {
    const stdout = sink(), stderr = sink();
    const code = await runUninstall(argv, {...options, ...extra, stdout, stderr});
    return {code, out: stdout.text(), err: stderr.text()};
  };
  return {...m, channel, agents, plist, launcher, options, go};
}

test('macOS preview uninstall plans and cleans only the stopped exact current login label with read-back', async t => {
  const m = await previewLogin(t);
  const foreign = ['com.other.agent', 'com.faravan.other-preview.agent'];
  for (const label of foreign) await writeFile(join(m.agents, label + '.plist'), launchAgentPlist(label));
  const plan = await uninstallPlan({...m.options, keepData: true});
  assert.equal(plan.blocked, null);
  assert.ok(plan.files.includes(m.plist));
  assert.equal(plan.commands.some(([command]) => command === 'osascript'), false);
  assert.equal(plan.commands.some(([, args]) => foreign.some(label => args.includes('gui/1000/' + label))), false);
  const commands = [];
  let loaded = false;
  const run = answering((command, args) => {
    if (command === 'launchctl' && args[1] === 'gui/1000/' + m.channel.launchAgentLabel) {
      if (args[0] === 'bootout') { loaded = false; return {code: 0}; }
      if (args[0] === 'print') return {code: loaded ? 0 : 113};
    }
  }, (command, args) => commands.push([command, ...args].join(' ')));
  const result = await m.go({run});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.plist), false);
  const boot = commands.indexOf('launchctl bootout gui/1000/' + m.channel.launchAgentLabel);
  const readBack = commands.indexOf('launchctl print gui/1000/' + m.channel.launchAgentLabel);
  assert.equal(boot, -1, 'a plist is not authorization to signal a loaded job');
  assert.ok(readBack >= 0);
  assert.equal(commands.filter(command => command === 'launchctl print gui/1000/' + m.channel.launchAgentLabel).length, 2);
  for (const label of foreign) assert.equal(await exists(join(m.agents, label + '.plist')), true);
  assert.equal(commands.some(command => foreign.some(label => command.endsWith('/' + label))), false);
});

// launchctl print output for a loaded login job, in the shape macOS prints it.
const printedJob = (program, home) => ['gui/1000/x = {', '\tstate = running', '', '\tprogram = ' + program, '\targuments = {',
  '\t\t' + program, '\t\t--background', '\t}', '', '\tenvironment = {', '\t\tFARAVAN_HOME => ' + home,
  '\t\tXPC_SERVICE_NAME => x', '\t}', '}'].join('\n');

const loadedLogin = (m, stdout, extra = () => undefined) => {
  const state = {loaded: true, commands: []};
  state.run = answering((command, args) => {
    if (command === 'launchctl' && args[1] === 'gui/1000/' + m.channel.launchAgentLabel) {
      if (args[0] === 'bootout') { state.loaded = false; return {code: 0}; }
      if (args[0] === 'print') return state.loaded ? {code: 0, stdout, stderr: ''} : {code: 113, stdout: '', stderr: ''};
    }
    return extra(command, args);
  }, (command, args) => state.commands.push([command, ...args].join(' ')));
  return state;
};

test('macOS preview loaded login running this install\'s command and profile is booted out and read back stopped', async t => {
  const m = await previewLogin(t);
  const job = loadedLogin(m, printedJob(m.launcher, m.home));
  const result = await m.go({run: job.run});
  assert.equal(result.code, 0, result.err);
  assert.ok(job.commands.includes('launchctl bootout gui/1000/' + m.channel.launchAgentLabel));
  assert.equal(job.loaded, false);
  assert.equal(await exists(m.plist), false);
});

for (const [what, stdout] of [['another copy\'s launcher', m => printedJob(join(m.userHome, 'Other.app/Contents/MacOS/faravan-launch'), m.home)],
  ['another profile', m => printedJob(m.launcher, join(m.userHome, 'other-profile'))], ['an unparsable print', () => 'state = running']]) {
  test('macOS preview refuses to boot out a loaded login job with ' + what + ' even when the plist on disk is this install\'s', async t => {
    const m = await previewLogin(t);
    const job = loadedLogin(m, stdout(m));
    const result = await m.go({run: job.run}, ['--yes']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.err, /loaded preview login-agent ownership/);
    assert.equal(job.commands.some(command => command.startsWith('launchctl bootout ')), false);
    assert.equal(await exists(m.plist), true);
    assert.equal(await exists(m.home), true);
  });
}

test('a checkout uninstaller cannot unload the bundled app login agent after the identity switch', async t => {
  if(STABLE_CHANNEL.id !== 'faravan')return t.skip('the rename command enables the shared install identity');
  const m = await previewLogin(t);
  const job = loadedLogin(m, printedJob(m.launcher,m.home));
  const result = await m.go({installDir:join(m.userHome,'checkout'),run:job.run}, ['--yes']);
  assert.equal(result.code,1,result.out);
  assert.match(result.err,/ownership/);
  assert.equal(job.commands.some(command=>command.startsWith('launchctl bootout ')),false);
  assert.equal(await exists(m.plist),true);
});

test('macOS preview uninstall ignores a running stable tray and checks only its own bundle tray', async t => {
  const m = await previewLogin(t);
  const job = loadedLogin(m, printedJob(m.launcher, m.home), (command, args) =>
    command === 'pgrep' && args[0] === '-x' && args[1] === 'faravan-tray' ? {code: 0, stdout: '1\n', stderr: ''} : undefined);
  const result = await m.go({run: job.run});
  assert.equal(result.code, 0, result.err);
  const pgreps = job.commands.filter(command => command.startsWith('pgrep '));
  assert.ok(pgreps.length > 0);
  assert.ok(pgreps.every(command => command.startsWith('pgrep -f ^') && command.includes('Preview\\.app/Contents/MacOS/faravan-tray')), pgreps.join('\n'));
});

test('macOS preview uninstall still waits for its own bundle tray', async t => {
  const m = await previewLogin(t);
  const job = loadedLogin(m, printedJob(m.launcher, m.home), (command, args) =>
    command === 'pgrep' && args[0] === '-f' ? {code: 0, stdout: '1\n', stderr: ''} : undefined);
  const result = await m.go({run: job.run, sleep: async () => {}});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /the tray is still running/);
  assert.equal(await exists(m.home), true);
});

test('macOS preview login with an unreadable launchd answer refuses and retains data', async t => {
  const m = await previewLogin(t);
  const result = await m.go({run: answering((command, args) =>
    command === 'launchctl' && args[0] === 'print' &&
    args[1] === 'gui/1000/' + m.channel.launchAgentLabel ? {code: 5, stderr: 'launchctl failed'} : undefined)}, ['--yes']);
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /loaded preview login-agent ownership/);
  assert.equal(await exists(m.plist), true);
  assert.equal(await exists(m.home), true);
});

for (const mismatch of ['launcher', 'profile']) {
  test('macOS preview login refuses a different ' + mismatch + ' before cleanup', async t => {
    const m = await previewLogin(t);
    await writeFile(m.plist, generatedLaunchAgentPlist(
      mismatch === 'launcher' ? join(m.userHome, 'Other.app/Contents/MacOS/faravan-launch') : m.launcher,
      m.channel.launchAgentLabel,
      {FARAVAN_HOME: mismatch === 'profile' ? join(m.userHome, 'other-profile') : m.home}));
    const plan = await uninstallPlan({...m.options, keepData: true});
    assert.match(plan.blocked?.message ?? '', /ownership/);
    const commands = [];
    const result = await m.go({run: answering(undefined, (command, args) => commands.push([command, ...args].join(' ')))});
    assert.equal(result.code, 1, result.out);
    assert.match(result.err, /ownership/);
    assert.equal(commands.some(command => /^(launchctl|pkill|osascript) /.test(command)), false);
    assert.equal(await exists(m.plist), true);
    assert.equal(await exists(m.home), true);
  });
}

test('macOS preview loaded-only login is unknown ownership, not permission to boot out', async t => {
  const m = await previewLogin(t);
  await rm(m.plist);
  const commands = [];
  const result = await m.go({run: answering((command, args) =>
    command === 'launchctl' && args[0] === 'print' &&
    args[1] === 'gui/1000/' + m.channel.launchAgentLabel ? {code: 0} : undefined,
  (command, args) => commands.push([command, ...args].join(' ')))});
  assert.equal(result.code, 1, result.out);
  assert.match(result.err, /ownership/);
  assert.equal(commands.some(command => command.startsWith('launchctl bootout ')), false);
  assert.equal(await exists(m.home), true);
});

test('macOS preview missing plist keeps its exact login label in final stopped read-back', async t => {
  const m = await previewLogin(t);
  await rm(m.plist);
  let prints = 0;
  const commands = [];
  const result = await m.go({run: answering((command, args) => {
    if (command === 'launchctl' && args[0] === 'print' &&
        args[1] === 'gui/1000/' + m.channel.launchAgentLabel)
      return {code: ++prints === 1 ? 113 : 0};
  }, (command, args) => commands.push([command, ...args].join(' ')))}, ['--yes']);
  assert.equal(result.code, 1, result.out);
  assert.ok(prints >= 2, 'a newly loaded job must block deletion');
  assert.match(result.err, /is still loaded/);
  assert.equal(commands.includes('launchctl bootout gui/1000/' + m.channel.launchAgentLabel), false);
  assert.equal(await exists(m.home), true);
});

// Only temporary files and injected process/service/hosting doubles are used below.
async function hostedUninstall(t) {
  const m = await machine(t);
  const coordinatorHome = join(m.home, 'coordinator');
  await mkdir(coordinatorHome, {recursive: true});
  const data = join(coordinatorHome, 'kept-data');
  await writeFile(data, 'host data\n');
  const paths = [...Object.values(m.files), m.home, coordinatorHome, data, join(m.home, 'v1/state.json')];
  const assertKept = async () => {
    for (const path of paths) assert.equal(await exists(path), true, path);
    assert.equal(await readFile(data, 'utf8'), 'host data\n');
  };
  const record = {pid: 424242, owner: {pid: 424242, marker: 'verified identity double'}};
  const options = {...m.base, coordinatorHome, device: m.device([]),
    alive: () => false, kill: () => assert.fail('no real signal'),
    hostedCoordinatorRecord: async () => record,
    stopV1Host: async () => assert.fail('stop must be supplied by the test'),
    cleanupBackend: {reapCleanup: async () => {}, cleanupStatus: () => ({state: 'clear'})}};
  const go = async (extra = {}, argv = ['--yes']) => {
    const stdout = sink(), stderr = sink();
    const code = await runUninstall(argv, {...options, ...extra, stdout, stderr});
    return {code, out: stdout.text(), err: stderr.text()};
  };
  return {...m, coordinatorHome, data, record, options, assertKept, go};
}

test('uninstall verifies a live hosted coordinator after service read-back and stops it before file removal', async t => {
  const m = await hostedUninstall(t);
  const calls = [];
  const tailscaleRun = () => assert.fail('no real tunnel command');
  const result = await m.go({tailscaleRun,
    hostedCoordinatorRecord: async home => {
      assert.equal(home, m.coordinatorHome);
      assert.equal(m.events.at(-1), 'run:pgrep -f ' + trayRegex(m.userHome), 'service read-backs precede coordinator read');
      await m.assertKept();
      calls.push('read');
      return m.record;
    },
    stopV1Host: async (options, seams) => {
      assert.deepEqual(options, {home: m.coordinatorHome, expectedOwner: m.record.owner});
      assert.equal(options.expectedOwner, m.record.owner, 'pass the exact verified owner identity, not its record wrapper');
      assert.deepEqual(seams, {clearIntent:true});
      await m.assertKept();
      calls.push('stop');
    }});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(calls, ['read', 'stop']);
  assert.equal(await exists(m.home), false);
  assert.equal(await exists(m.files.tree), false);
});

test('uninstall keeps all files when stopping the hosted coordinator throws', async t => {
  const m = await hostedUninstall(t);
  let stops = 0;
  const result = await m.go({stopV1Host: async () => { stops++; throw new Error('coordinator still running'); }});
  assert.equal(result.code, 1, result.out);
  assert.equal(stops, 1);
  assert.match(result.err, /coordinator still running.*Your data was kept.*Run faravan host --stop, then retry uninstall\./);
  assert.equal(result.err.trim().split('\n').length, 1);
  await m.assertKept();
});

test('uninstall keeps all files and never stops an unverifiable hosted coordinator', async t => {
  const m = await hostedUninstall(t);
  let reads = 0, stops = 0;
  const result = await m.go({
    hostedCoordinatorRecord: async () => { reads++; throw new Error('cannot verify live coordinator'); },
    stopV1Host: async () => { stops++; },
  });
  assert.equal(result.code, 1, result.out);
  assert.equal(reads, 1);
  assert.equal(stops, 0);
  assert.match(result.err, /cannot verify live coordinator.*Your data was kept.*Run faravan host --stop, then retry uninstall\./);
  await m.assertKept();
});

test('uninstall without a live hosted coordinator keeps the existing tunnel-only stop', async t => {
  const m = await hostedUninstall(t);
  let reads = 0, stops = 0;
  const tailscaleRun = () => assert.fail('no real tunnel command');
  const result = await m.go({tailscaleRun,
    hostedCoordinatorRecord: async home => { assert.equal(home, m.coordinatorHome); reads++; return null; },
    stopV1Host: async (options, seams) => {
      stops++;
      assert.deepEqual(options, {home: m.coordinatorHome});
      assert.deepEqual(Object.keys(seams).sort(), ['clearIntent','exposureOnly','processExists']);
      assert.equal(seams.exposureOnly,true);
      assert.equal(seams.processExists(m.record), false);
      await m.assertKept();
    }});
  assert.equal(result.code, 0, result.err);
  assert.equal(reads, 1);
  assert.equal(stops, 1);
  assert.equal(await exists(m.home), false);
});

test('dry-run lists the hosted coordinator without stopping or writing anything', async t => {
  const m = await hostedUninstall(t);
  let reads = 0, stops = 0;
  const extra = {
    run: () => assert.fail('dry-run must not execute commands'),
    hostedCoordinatorRecord: async home => { assert.equal(home, m.coordinatorHome); reads++; return m.record; },
    stopV1Host: async () => { stops++; },
  };
  const snapshot = async dir => {
    const files = {};
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      files[name] = (await stat(path)).isDirectory() ? await snapshot(path) : await readFile(path, 'utf8');
    }
    return files;
  };
  const before = await snapshot(m.userHome);
  const plan = await uninstallPlan({...m.options, ...extra});
  assert.deepEqual(plan.would_stop_coordinator, {pid: m.record.pid, home: m.coordinatorHome});
  const result = await m.go(extra, ['--dry-run']);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes('Would stop hosted coordinator pid ' + m.record.pid + ' at ' + m.coordinatorHome));
  assert.equal(reads, 2);
  assert.equal(stops, 0);
  assert.deepEqual(m.events, []);
  await m.assertKept();
  assert.deepEqual(await snapshot(m.userHome), before, 'dry-run creates, removes, or changes no fixture files');
});

async function planHost(m) {
  const {hostPaths} = await import('../lib/host.mjs');
  const dir = join(m.home, 'coordinator');
  m.base.coordinatorHome = dir;
  await mkdir(dir, {recursive:true});
  await writeFile(hostPaths(dir).config, JSON.stringify({protocol_version:1, circle_id:'h1'}));
}

test('fresh install plan does not call the serverless My devices circle hosted', async t => {
  const m = await machine(t);
  const {device} = await defaultOfflineDevice(m);
  const plan = await uninstallPlan({...m.base, device});
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.would_keep_hosted, []);
});

test('plan explains shared services and trays, including other installs', async t => {
  const m = await machine(t);
  const result = await m.go(['--dry-run'], {device:m.device([])});
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /only the services, tasks, autostart entries and tray that start a program inside this install/);
  assert.match(result.out, /Any other copy is kept/);
});

test('fresh install uninstall closes its local circle without a hosted-circle override', async t => {
  const m = await machine(t);
  const {device} = await defaultOfflineDevice(m);
  const result = await m.go(['--yes'], {device});
  assert.equal(result.code, 0, result.err);
  assert.equal(await exists(m.home), false);
});

test('unreadable host configuration refuses uninstall before leaving circles', async t => {
  const m = await machine(t);
  await planHost(m);
  const {hostPaths} = await import('../lib/host.mjs');
  const config = hostPaths(m.base.coordinatorHome).config;
  await rm(config);
  await mkdir(config);
  const device = m.device([{id:'h1', name:'Family', owned:true}]);
  await assert.rejects(uninstallPlan({...m.base, device}), {code:'EISDIR'});
  const result = await m.go(['--yes'], {device});
  assert.equal(result.code, 1);
  assert.deepEqual(m.events, []);
  assert.equal(await exists(m.home), true);
});

// ---- Uninstall removes this install only ----

// A second copy (a preview beside the stable install, or the reverse) whose services, tray autostart and tasks start
// programs under its own root. `uninstalling` names the copy that runs uninstall.
async function twoCopies(t, uninstalling) {
  const m = await machine(t);
  const stableRoot = join(m.userHome, '.local'), previewRoot = join(m.userHome, '.preview');
  await mkdir(join(previewRoot, 'lib/faravan'), {recursive: true});
  await writeFile(join(previewRoot, 'lib/faravan/.installed-via'), 'tarball\n');
  const own = uninstalling === 'stable' ? stableRoot : previewRoot, other = uninstalling === 'stable' ? previewRoot : stableRoot;
  const wants = [join(m.userHome, '.config/systemd/user/default.target.wants/faravan-app.service'),
    join(m.userHome, '.config/systemd/user/graphical-session.target.wants/faravan-tray.service')];
  for (const file of wants) { await mkdir(join(file, '..'), {recursive: true}); await writeFile(file, 'link\n'); }
  await writeFile(m.files.autostart, `[Desktop Entry]\nExec=${join(other, 'lib/faravan/faravan-tray')}\n`);
  await writeFile(m.files.handler, `[Desktop Entry]\nExec=${join(other, 'bin/faravan')} open-link %u\n`);
  const commands = [];
  const foreignUnits = (command, args) => {
    if (command !== 'systemctl') return undefined;
    if (args.includes('show')) return {code: 0, stdout: 'loaded\n', stderr: ''};
    if (args.includes('cat')) return {code: 0, stdout: `[Service]\nExecStart=${join(other, 'lib/faravan/runtime/bin/node')} ${join(other, 'lib/faravan/lib/v1/resident.mjs')}\n`, stderr: ''};
    return undefined;
  };
  const run = answering(foreignUnits, (command, args) => commands.push([command, ...args].join(' ')));
  return {m, own, other, wants, commands, run, installDir: join(own, 'lib/faravan'), ownTray: join(own, 'lib/faravan/faravan-tray')};
}

for (const uninstalling of ['stable', 'preview']) {
  test(`${uninstalling} uninstall never stops, disables or deletes the other copy's services, autostart or tray`, async t => {
    const c = await twoCopies(t, uninstalling);
    const result = await c.m.go(['--yes'], {device: c.m.device([]), run: c.run, installDir: c.installDir});
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(c.commands.filter(line => /systemctl --user (stop|disable|is-active)/.test(line)), [], 'no service of the other copy is touched');
    for (const line of c.commands.filter(line => /^(pkill|pgrep) /.test(line)))
      assert.ok(line.includes(c.ownTray.replace(/\./g, '\\.')), 'the tray is matched by this copy\'s own path only: ' + line);
    assert.ok(!c.commands.some(line => /^(pkill|pgrep) -x /.test(line)), 'never a tray matched by name');
    for (const file of [c.m.files.autostart, c.m.files.handler, ...c.wants]) assert.equal(await exists(file), true, file + ' belongs to the other copy');
    assert.match(result.out, /Left in place: The service faravan-app\.service starts a program that is not part of this install/);
    assert.match(result.out, /Left in place: .*faravan-tray\.desktop starts .*which is not part of this install/);
  });
}

test('services and autostart entries whose owner cannot be read are kept and reported, never stopped', async t => {
  const m = await machine(t);
  await rm(m.files.autostart); await mkdir(m.files.autostart); // a directory cannot be read as a file
  const commands = [];
  const run = answering((command, args) => command === 'systemctl' && args.includes('show') ? {code: 0, stdout: 'loaded\n', stderr: ''}
    : command === 'systemctl' && args.includes('cat') ? {code: 1, stdout: '', stderr: 'Failed to connect to bus'} : undefined,
  (command, args) => commands.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(commands.filter(line => /systemctl --user (stop|disable|is-active)/.test(line)), []);
  assert.equal(await exists(m.files.autostart), true, 'an unreadable autostart entry stays');
  assert.match(result.out, /Left in place: The service faravan-tray\.service could not be read, so its owner is unknown/);
  assert.match(result.out, /Left in place: .*faravan-tray\.desktop could not be read, so its owner is unknown/);
});

test('Windows: a resident task, login entry and shortcut of another copy are never ended, deleted or removed', async t => {
  const m = await machine(t, {platform: 'win32'});
  const shortcut = join(m.userHome, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/Faravan.lnk');
  await mkdir(join(shortcut, '..'), {recursive: true}); await writeFile(shortcut, 'lnk');
  const commands = [];
  const other = 'D:\\Other\\Faravan';
  const run = answering((command, args) => {
    if (command === 'reg' && args[0] === 'query') return {code: 0, stdout: `    Faravan    REG_SZ    "${other}\\faravan-tray.exe"\n`, stderr: ''};
    if (command !== 'powershell.exe') return undefined;
    const script = args.at(-1);
    if (script.includes('exit 3')) return {code: 0, stdout: `powershell.exe -EncodedCommand ${Buffer.from("$layout = '" + other + "'", 'utf16le').toString('base64')}\n`, stderr: ''};
    if (script.includes('CreateShortcut')) return {code: 0, stdout: other + '\\faravan-tray.exe\n', stderr: ''};
    return undefined;
  }, (command, args) => commands.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {device: m.device([]), run, env: {APPDATA: join(m.userHome, 'AppData/Roaming')}});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(commands.filter(line => /^schtasks|^reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /.test(line)), [], 'neither the task nor the Run value is touched');
  assert.equal(await exists(shortcut), true, 'the shortcut to the other copy stays');
  assert.ok(!commands.some(line => /^taskkill/.test(line)), 'no tray is ended by image name');
  assert.match(result.out, /Left in place: The Faravan-resident task runs a different install/);
  assert.match(result.out, /Left in place: The Faravan login entry starts .*which is not part of this install/);
});

test('Windows: a task whose definition cannot be read is kept and never ended', async t => {
  const m = await machine(t, {platform: 'win32'});
  const commands = [];
  const run = answering((command, args) => command === 'powershell.exe' && args.at(-1).includes('exit 3') ? {code: 5, stdout: '', stderr: 'Access is denied.'} : undefined,
    (command, args) => commands.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {device: m.device([]), run});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(commands.filter(line => /^schtasks/.test(line)), []);
  assert.match(result.out, /Left in place: The Faravan-resident task could not be read, so its owner is unknown/);
});

test('macOS: a tray whose place in this install is unknown is not stopped by name', async t => {
  const m = await machine(t, {platform: 'darwin'});
  const commands = [];
  const run = answering(undefined, (command, args) => commands.push([command, ...args].join(' ')));
  const result = await m.go(['--yes'], {device: m.device([]), run, channel: STABLE_CHANNEL});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(commands.filter(line => /^(pkill|pgrep)/.test(line)), []);
  assert.match(result.out, /Left in place: The tray is in a place this install does not know/);
});

// ---- No app may start under the removal ----

const noWork = {hostedCoordinatorRecord: async () => null, stopV1Host: async () => {}};
const clearedBackend = work => ({reapCleanup: work, cleanupStatus: () => ({state: 'clear'})});

test('an app started while uninstall removes files is refused, and uninstall still finishes', async t => {
  const m = await machine(t);
  const {setResidentQuit} = await import('../lib/v1/resident-intent.mjs');
  const {startApp} = await import('../lib/v1/app.mjs');
  const attempts = {};
  const result = await m.go(['--yes'], {device: m.device([]), ...noWork, cleanupBackend: clearedBackend(async () => {
    // Between the stop read-back and the deletion: the user opens Faravan.
    try { setResidentQuit(false, m.home); attempts.resident = 'started'; } catch (error) { attempts.resident = error.message; }
    try { await startApp({home: m.home, base: m.userHome, port: 0}); attempts.app = 'started'; } catch (error) { attempts.app = error.code; }
  })});
  assert.equal(result.code, 0, result.err);
  assert.match(attempts.resident, /being removed or changed right now.*try again/);
  assert.equal(attempts.app, 'app_already_running');
  assert.equal(await exists(m.home), false, 'nothing recreated the data folder under the removal');
});

test('the gate stays held through the last deletion and is free afterwards', async t => {
  const m = await machine(t);
  const {acquireProcessLock, profileWriterLockPath} = await import('../lib/v1/lock.mjs');
  let atDelete;
  const result = await m.go(['--yes'], {device: m.device([]), ...noWork, cleanupBackend: clearedBackend(async () => {
    atDelete = await acquireProcessLock(profileWriterLockPath(m.home), {timeoutMs: 0}).then(release => { release(); return 'free'; }, error => error.code);
  })});
  assert.equal(result.code, 0, result.err);
  assert.equal(atDelete, 'lock_busy', 'the gate is held after the read-backs, before any file is removed');
  assert.equal(await exists(m.home), false, 'the data folder is gone: the gate lives beside it, not inside it');
  const release = await acquireProcessLock(profileWriterLockPath(m.home), {timeoutMs: 0});
  release();
});

test('an app that already holds its lock stops uninstall before anything is deleted', async t => {
  const m = await machine(t);
  const {acquireProcessLock} = await import('../lib/v1/lock.mjs');
  const release = await acquireProcessLock(join(m.home, 'v1/app.lock'), {timeoutMs: 0});
  let result;
  try { result = await m.go(['--yes'], {device: m.device([]), ...noWork}); } finally { release(); }
  assert.equal(result.code, 1);
  assert.match(result.err, /started again while uninstall was running.*Nothing else was removed/s);
  for (const path of [m.files.autostart, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
});

test('a start that holds the profile gate makes uninstall remove nothing', async t => {
  const m = await machine(t);
  const {acquireProcessLock, profileWriterLockPath} = await import('../lib/v1/lock.mjs');
  const release = await acquireProcessLock(profileWriterLockPath(m.home), {timeoutMs: 0});
  let result;
  try { result = await m.go(['--yes'], {device: m.device([]), ...noWork}); } finally { release(); }
  assert.equal(result.code, 1);
  assert.match(result.err, /starting or being changed right now.*Nothing else was removed/s);
  for (const path of [m.files.autostart, m.files.command, m.files.tree, m.home]) assert.equal(await exists(path), true, path);
});

test('uninstall leaves a same-channel sandbox service from another install alone', async t => {
  const m = await machine(t);
  const services = sandboxServices({root:m.files.tree,dataHome:m.home});
  const foreign='faravan-sbxd-aaaaaaaaaaaa.service';
  await writeFile(sbxOwnerFile(m.home, m.files.tree), JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  let foreignStopped=false;
  const result = await m.go(['--yes'], {device:m.device([]),run:answering((command,args)=> {
    if(command==='systemctl' && args.includes('list-units'))return {code:0,stdout:foreign+' loaded active running Faravan\n'};
    if(command==='systemctl' && args.includes('Description'))return {code:0,stdout:sbxDaemonDescription(channelIdentity())};
    if(command==='systemctl' && args.includes('Environment'))return {code:0,stdout:'HOME=/synthetic FARAVAN_SBXD_OWNER_ID='+'b'.repeat(64)};
    if(command==='systemctl' && args.includes('stop') && args.includes(foreign))foreignStopped=true;
    return services.answer(command,args);
  })});
  assert.equal(foreignStopped,false);
  assert.equal(result.code,1);
  assert.match(result.err,/ownership|left alone/i);
  assert.doesNotMatch(result.err,/repair-owner|systemctl --user stop/,'unproven ownership must not offer a stop or a repair that refuses');
});

test('a legacy name replaced after the ownership read is never stopped', async t => {
  const m=await machine(t), services=sandboxServices({root:m.files.tree,dataHome:m.home});
  await writeFile(sbxOwnerFile(m.home,m.files.tree),JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const legacy='faravan-sbxd-aaaaaaaaaaaa.service';
  let replaced=false,foreignStopped=false;
  const result=await m.go(['--yes'],{device:m.device([]),run:answering((command,args)=>{
    if(command==='systemctl' && args.includes('list-units'))return {code:0,stdout:legacy+' loaded active running Faravan\n'};
    if(command==='systemctl' && args.includes('Description')){replaced=true;return {code:0,stdout:sbxDaemonDescription(channelIdentity())};}
    if(command==='systemctl' && args.includes('Environment')){replaced=true;return {code:0,stdout:systemdShowEnvironment({FARAVAN_SBXD_OWNER_ID:'a'.repeat(64),FARAVAN_SBXD_INSTALL_ROOT:root})};}
    if(command==='systemctl' && args.includes('stop') && args.includes(legacy))foreignStopped=replaced;
    return services.answer(command,args);
  })});
  assert.equal(foreignStopped,false);
  assert.equal(result.code,1);
});

test('uninstall resolves its installation identity from a path containing spaces', async t => {
  const m=await machine(t);
  const root=join(m.userHome,'install with space');
  await cp(new URL('../lib/',import.meta.url),join(root,'lib'),{recursive:true});
  await cp(new URL('../docs/protocol/',import.meta.url),join(root,'docs/protocol'),{recursive:true});
  await symlink(new URL('../node_modules/',import.meta.url),join(root,'node_modules'));
  const {runUninstall:copiedUninstall}=await import(new URL('file://'+join(root,'lib/v1/uninstall.mjs')));
  const services=sandboxServices({root,dataHome:m.home});
  await writeFile(sbxOwnerFile(m.home,root),JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const stdout=sink(),stderr=sink();
  const code=await copiedUninstall(['--yes','--keep-data'],{home:m.home,userHome:m.userHome,platform:'linux',
    run:answering(services.answer),sleep:async()=>{},env:{},uid:1000,device:m.device([]),stdout,stderr});
  assert.equal(code,0,stderr.text());
  assert.ok(services.commands.includes('--user stop '+services.mine));
});

for (const root of [undefined, '/another/install']) test(`uninstall refuses sandbox unit with install root ${root}`, async t => {
  const m=await machine(t), services=sandboxServices({root,dataHome:m.home});
  await writeFile(sbxOwnerFile(m.home,m.files.tree),JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const result=await m.go(['--yes'],{device:m.device([]),run:answering(services.answer)});
  assert.equal(result.code,1);
  assert.equal(services.commands.includes(`--user stop ${services.mine}`),false);
  assert.match(result.err,/ownership/);
});

for(const defect of ['data-home','ExecStart','HOME'])test(`uninstall refuses a matching owner with foreign ${defect}`,async t=>{
  const m=await machine(t),services=sandboxServices({root:m.files.tree,dataHome:m.home});
  await writeFile(sbxOwnerFile(m.home,m.files.tree),JSON.stringify({id:'a'.repeat(64),executable:'/usr/bin/sbx'}));
  const result=await m.go(['--yes'],{device:m.device([]),run:answering((command,args)=>{
    if(command==='systemctl'&&args.includes('Environment')) {
      const evidence=services.answer(command,args);
      evidence.stdout=defect==='data-home'?evidence.stdout.replace(/"?FARAVAN_SBXD_DATA_HOME=[^"\s]*"?/,'FARAVAN_SBXD_DATA_HOME=/foreign/profile')
        :defect==='ExecStart'?evidence.stdout.replace('path=/usr/bin/sbx','path=/foreign/sbx')
        :evidence.stdout.replace('HOME=/sandbox','HOME=/foreign');
      return evidence;
    }
    return services.answer(command,args);
  })});
  assert.equal(result.code,1);assert.equal(services.commands.includes('--user stop '+services.mine),false);
});

test('uninstall plan displays exact legacy recovery guidance',async t=>{
  const m=await machine(t),name='wf-0123456789abcdef',command="env HOME='/synthetic sandbox' 'sbx' rm --force '"+name+"'";
  const remediation=[{name,home:'/synthetic sandbox',command}];
  const result=await m.go(['--dry-run'],{device:m.device([]),cleanupBackend:{inspectCleanupRemediation:async()=>remediation,cleanupStatus:()=>({state:'pending',remediation})}});
  assert.equal(result.code,0);assert.ok(result.out.includes(command));assert.match(result.out,/only if this install created the job/);
});
