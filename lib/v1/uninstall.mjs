import {sandboxRemediationLines} from '../sandbox-remediation.mjs';
import { installRoot } from '../sbx-daemon-owner.mjs';
// `faravan uninstall [--keep-data]`: leave circles first, then stop Faravan, remove the
// autostart entries, the command-line link and (unless kept) the local data.
// Every effect on the machine is injected (`run`, the app client, the device), so tests
// use a temporary home and never touch a real login item or service.
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { configHome } from '../local-state.mjs';
import { bundledLauncher, launchAgentPlist, launchProfileEnvironment } from './autostart.mjs';
import {channelIdentity, channelDataHome, isChannelIdentity} from '../channel-identity.mjs';
import {setResidentQuit} from './resident-intent.mjs';
import {acquireProcessLock, lockHeldBy, withProfileWriter} from './lock.mjs';
import {scopedRules} from '../sandbox-policy-cleanup.mjs';
import {acquireUninstallLock} from './uninstall-lock.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const exists = path => stat(path).then(() => true, () => false);
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const defaultRun = (command, args) => new Promise(done => execFile(command, args, {timeout: 20000, encoding: 'utf8'},
  (error, stdout, stderr) => done({code: error ? (error.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? ''})));
const SYSTEMD_UNITS = ['faravan-app.service', 'faravan-coordinator.service', 'faravan-tray.service'];
// Never synthesize another channel's login label for cleanup.
const launchAgentLabels = channel => [channel.launchAgentLabel, channel.launchAgentLabel + '.resident'];

const trayPattern = path => '^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)';
const psQuote = text => "'" + String(text).replace(/'/g, "''") + "'";
const NOTHING_OWNED = Object.freeze({units: [], tray: null, task: false, winRun: false, files: [], kept: []});

/**
 * What this platform keeps outside the data directory: files to delete, stop commands, and commands that undo a registration.
 * `owned` is what readOwnership proved belongs to this install. Nothing outside it is stopped, disabled or deleted.
 */
export function platformTargets({platform, userHome, env = {}, uid = 0, launchAgents = [], channel = channelIdentity(), owned = NOTHING_OWNED}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(userHome, 'AppData', 'Roaming');
    return {
      files: owned.files,
      commands: [
        ...(owned.task ? [['schtasks', ['/End', '/TN', 'Faravan-resident']]] : []),
        ...(owned.tray ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsTrayScript(owned.tray, 'stop')]]] : []),
      ],
      unregisterCommands: [
        ...(owned.task ? [['schtasks', ['/Delete', '/TN', 'Faravan-resident', '/F']]] : []),
        ...(owned.winRun ? [['reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Faravan', '/f']]] : []),
        ['reg', ['delete', 'HKCU\\Software\\Classes\\AppUserModelId\\Faravan.Desktop', '/f']],
        ['reg', ['delete', 'HKCU\\Software\\Classes\\faravan', '/f']],
        ['reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', '/v', 'FaravanSetup', '/f']],
      ],
      manual: ['Remove Faravan from Settings → Apps (winget package: tnunamak.Faravan).'],
      startupShortcut: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Faravan.lnk'),
    };
  }
  if (platform === 'darwin') {
    const agents = join(userHome, 'Library', 'LaunchAgents');
    const entries = launchAgents.map(agent => typeof agent === 'string'
      ? {path: join(agents, agent), label: null}
      : agent);
    const labels = [...new Set(entries.filter(agent => !agent.stopped).map(agent => agent.label).filter(Boolean))];
    return {
      files: [...new Set(entries.map(agent => agent.path).filter(Boolean))],
      commands: [
        ...labels.map(label => ['launchctl', ['bootout', 'gui/' + uid + '/' + label]]),
        ...(owned.tray ? [['pkill', ['-f', trayPattern(owned.tray)]]] : []),
      ],
      unregisterCommands: [],
      manual: ['Move Faravan.app to the Trash, or remove the existing cask: brew uninstall --cask faravan'],
    };
  }
  const config = env.XDG_CONFIG_HOME || join(userHome, '.config');
  const wants = {'faravan-app.service': 'default.target.wants', 'faravan-coordinator.service': 'default.target.wants', 'faravan-tray.service': 'graphical-session.target.wants'};
  return {
    files: [...owned.files, ...owned.units.map(unit => join(config, 'systemd', 'user', wants[unit]))],
    commands: [
      ...(owned.units.length ? [['systemctl', ['--user', 'stop', ...owned.units]]] : []),
      ...(owned.tray ? [['pkill', ['-f', trayPattern(owned.tray)]]] : []),
    ],
    unregisterCommands: owned.units.length ? [['systemctl', ['--user', 'disable', ...owned.units]]] : [],
    manual: [],
  };
}

const insidePath = (platform, root, candidate) => {
  if (typeof candidate !== 'string' || !candidate || !root) return false;
  const lib = platform === 'win32' ? win32 : posix;
  const fold = text => platform === 'win32' ? text.toLowerCase() : text;
  const relation = fold(lib.relative(lib.resolve(root), lib.resolve(candidate)));
  return relation !== '' && !relation.startsWith('..') && !lib.isAbsolute(relation);
};
const execCommand = text => text.trim().replace(/^[-@:+!|]+/, '').match(/^"([^"]*)"|^(\S+)/)?.slice(1).find(Boolean) ?? null;

function windowsTrayScript(path, action) {
  const match = `Get-Process -Name faravan-tray -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${psQuote(path)} }`;
  return action === 'stop'
    ? `$ErrorActionPreference='Stop'; ${match} | Stop-Process -Force; exit 0`
    : `$ErrorActionPreference='Stop'; if (${match}) { exit 1 }; exit 0`;
}
const windowsFamily = layout => {
  const name = win32.basename(layout), at = name.indexOf('__');
  return at < 0 ? null : (name.slice(0, name.indexOf('_')) + '_' + name.slice(at + 2)).toLowerCase();
};

/**
 * What this install owns, proven from each registration's own definition: a service ExecStart, a desktop Exec path, a task
 * action or a Run value must point inside this install's root. A definition that is foreign or cannot be read is kept and
 * listed in `kept`; it is never stopped, disabled or deleted. Without `run` only files are read (the dry run).
 */
export async function readOwnership({platform, userHome, env = {}, root, installDir, run, kind = 'checkout', channel = channelIdentity(), launcher = null}) {
  const owned = {units: [], tray: null, task: false, winRun: false, files: [], kept: []};
  const inside = candidate => insidePath(platform, root, candidate);
  const packaged = kind === 'apt' ? ['/usr/bin/faravan'] : [];
  const ours = candidate => inside(candidate) || packaged.includes(candidate);
  const keep = (what, why) => owned.kept.push(what + ' ' + why);
  const execOwner = async (path, line) => {
    const text = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? null : undefined);
    if (text === null) return;
    if (text === undefined) return keep(path, 'could not be read, so its owner is unknown');
    const command = execCommand((text.split(/\r?\n/).find(l => l.startsWith(line)) ?? '').slice(line.length));
    if (ours(command)) owned.files.push(path); else keep(path, command ? 'starts ' + command + ', which is not part of this install' : 'has no readable command, so its owner is unknown');
  };
  if (platform === 'win32') {
    owned.tray = installDir ? win32.join(root, 'faravan-tray.exe') : null;
    const targets = platformTargets({platform, userHome, env, owned});
    if (run) {
      const reg = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
      const value = await run('reg', ['query', reg, '/v', 'Faravan']);
      const data = /REG_\w+\s+(.*\S)\s*$/m.exec(value?.stdout ?? '')?.[1];
      if (value?.code === 0 && data) { if (ours(execCommand(data))) owned.winRun = true; else keep('The Faravan login entry', 'starts ' + execCommand(data) + ', which is not part of this install'); }
      else if (value?.code !== 1) keep('The Faravan login entry', 'could not be read, so its owner is unknown');
      const shortcut = targets.startupShortcut;
      if (await exists(shortcut)) {
        const target = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (New-Object -ComObject WScript.Shell).CreateShortcut(" + psQuote(shortcut) + ").TargetPath"]);
        const where = (target?.stdout ?? '').trim();
        if (target?.code === 0 && where && ours(where)) owned.files.push(shortcut);
        else keep(shortcut, target?.code === 0 && where ? 'starts ' + where + ', which is not part of this install' : 'could not be read, so its owner is unknown');
      }
      const task = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; $t = Get-ScheduledTask | Where-Object TaskName -eq 'Faravan-resident'; if (-not $t) { exit 3 }; ($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join [Environment]::NewLine"]);
      if (task?.code === 3) { /* no such task */ }
      else if (task?.code === 0 && (task.stdout ?? '').trim()) {
        const encoded = /-EncodedCommand\s+(\S+)/.exec(task.stdout)?.[1];
        const script = (encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '') + '\n' + task.stdout;
        const family = windowsFamily(root), saved = /\$family = '([^']*)'/.exec(script)?.[1];
        if (script.toLowerCase().includes(root.toLowerCase()) || family && saved && saved.toLowerCase() === family) owned.task = true;
        else keep('The Faravan-resident task', 'runs a different install');
      } else keep('The Faravan-resident task', 'could not be read, so its owner is unknown');
    }
    return owned;
  }
  if (platform === 'darwin') {
    owned.tray = launcher ? join(dirname(launcher), 'faravan-tray') : null;
    if (!owned.tray) keep('The tray', 'is in a place this install does not know, so it was not stopped');
    return owned;
  }
  const config = env.XDG_CONFIG_HOME || join(userHome, '.config');
  const data = env.XDG_DATA_HOME || join(userHome, '.local', 'share');
  owned.tray = installDir ? join(installDir, 'faravan-tray') : null;
  for (const file of [join(config, 'autostart', 'faravan-tray.desktop'), join(config, 'autostart', 'faravan-setup.desktop'), join(data, 'applications', 'faravan-open-link.desktop')])
    await execOwner(file, 'Exec=');
  if (run) for (const unit of SYSTEMD_UNITS) {
    const load = await run('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', unit]);
    const loaded = load?.code === 0 ? (load.stdout ?? '').trim() : null;
    if (loaded === 'not-found') continue;
    const cat = loaded === 'loaded' ? await run('systemctl', ['--user', 'cat', unit]) : null;
    const commands = cat?.code === 0 ? (cat.stdout ?? '').split(/\r?\n/).filter(l => l.startsWith('ExecStart=')).map(l => execCommand(l.slice(10))) : [];
    if (commands.length && commands.every(ours)) owned.units.push(unit);
    else keep('The service ' + unit, commands.length ? 'starts a program that is not part of this install' : 'could not be read, so its owner is unknown');
  }
  return owned;
}

/**
 * Which kind of install is running, so we remove only what we own. A portable install lives at <root>/lib/faravan,
 * so its root is where it runs. The environment never picks the root: a copy installed elsewhere stays where it is.
 */
export async function installKind({installDir}) {
  const marker = await readFile(join(installDir, '.installed-via'), 'utf8').then(t => t.trim(), () => null);
  if (marker === 'tarball') {
    const dir = resolve(installDir);
    const inLibrary = basename(dir) === 'faravan' && basename(dirname(dir)) === 'lib';
    return {kind: 'tarball', root: inLibrary ? dirname(dirname(dir)) : null};
  }
  if (installDir.startsWith('/usr/')) return {kind: 'apt'};
  if (/(Cellar|homebrew|linuxbrew)/i.test(installDir)) return {kind: 'brew'};
  return {kind: 'checkout'};
}

/** The data directory must look like Faravan's before anything deletes it. */
export async function dataDirectoryProblem(dir, userHome) {
  const target = resolve(dir), home = resolve(userHome);
  if (target === sep || target === home || home.startsWith(target + sep) || target.split(sep).filter(Boolean).length < 2) return 'is not a safe place to delete';
  if (!await exists(target)) return null;
  const names = await readdir(target).catch(() => []);
  if (names.length && !names.some(n => ['v1', 'coordinator', 'device'].includes(n))) return 'does not look like Faravan data';
  return null;
}

/**
 * app.json holds a saved PID, and a number outlives its process. Signal it only while the app's own lock shows that process
 * (same PID, same start) still running. Without that proof the app is gone and the number may name an unrelated process.
 * `kill` is the tests' seam and is used as given.
 */
export function signalRecordedApp(home, pid, {kill} = {}) {
  if (kill === undefined) {
    if (!lockHeldBy(join(home, 'v1', 'app.lock'), pid)) return false;
  }
  try { (kill ?? process.kill)(pid, 'SIGTERM'); } catch { /* already gone */ }
  return true;
}

async function readApp(home, alive) {
  try {
    const record = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8'));
    return Number.isSafeInteger(record.pid) && alive(record.pid) && Number.isInteger(record.port) && typeof record.token === 'string' ? record : null;
  } catch { return null; }
}

/** Circle membership and owner lifecycle operations. Listing is read-only. */
async function openCircles({app, home, hasState, options}) {
  if (app) {
    const call = (method, path, body = {}) => (options.fetch ?? globalThis.fetch)('http://127.0.0.1:' + app.port + path,
      {method, headers: {'x-faravan-session-token': app.token, 'content-type': 'application/json'}, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'error'});
    const listed = await call('GET', '/api/circles');
    if (!listed.ok) throw new Error('The running app did not list its circles.');
    const circles = await listed.json();
    return {circles, close: async circle => {
      const response = await call('POST', '/api/circles/' + encodeURIComponent(circle.id) + '/lifecycle', {state:'closed'});
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? 'The app could not close ' + circle.name + '.');
      return response.json().catch(() => ({}));
    }, leave: async circle => {
      const response = await call('POST', '/api/circles/' + encodeURIComponent(circle.id) + '/leave');
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? 'The app could not leave ' + circle.name + '.');
      return response.json().catch(() => ({}));
    }};
  }
  if (hasState || options.device) {
    const device = options.device ?? await (await import('./device.mjs')).openDevice({home});
    return {circles: await device.listCircles(), close: circle => device.setCircleLifecycle(circle.id, 'closed'), leave: circle => device.leaveCircle(circle.id)};
  }
  return {circles: [], close: undefined, leave: undefined};
}

const hostedBlock = hosted => 'This computer hosts ' + hosted.map(c => c.name).join(', ') + '. Removing its data ends that circle for everyone in it.\n' +
  'Run with --keep-data to keep it, or add --delete-hosted-circles to end it. Nothing was removed.\n';

function validLaunchAgentLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) ? label : null;
}

function xmlLaunchAgentLabel(xml) {
  const match = xml.match(/<key>\s*Label\s*<\/key>\s*<string(?:\s[^>]*)?>([^<]*)<\/string>/);
  if (!match) return null;
  const value = match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"})[entity]);
  return validLaunchAgentLabel(value);
}

async function discoverLaunchAgents(platform, userHome, run, options = {}) {
  if (platform !== 'darwin') return {agents: [], problem: null};
  const channel = options.channel ?? channelIdentity();
  if (!isChannelIdentity(channel) || !validLaunchAgentLabel(channel.launchAgentLabel))
    return {agents: [], problem: 'Invalid channel launch-agent identity.'};
  const knownLabels = launchAgentLabels(channel);
  const directory = join(userHome, 'Library', 'LaunchAgents');
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') names = [];
    else return {agents: [], problem: 'Could not inspect the LaunchAgents directory; launch-agent state is unknown.'};
  }

  const agents = [];
  for (const name of names.filter(n => n.endsWith('.plist'))) {
    const path = join(directory, name);
    let label = null;
    if (run) {
      let answer;
      try { answer = await run('plutil', ['-extract', 'Label', 'raw', '-o', '-', path]); }
      catch { answer = null; }
      if (answer?.code === 0) label = validLaunchAgentLabel(answer.stdout);
    } else {
      const xml = await readFile(path, 'utf8').catch(() => null);
      if (xml !== null) label = xmlLaunchAgentLabel(xml);
    }
    if (knownLabels.includes(label)) agents.push({name, path, label});
    else if (!label && knownLabels.includes(name.replace(/\.plist$/, ''))) agents.push({name, path, label});
  }
  const discoveredLabels = new Set(agents.map(agent => agent.label).filter(Boolean));
  // A known label without a plist still needs a launchctl print read-back.
  for (const label of knownLabels) {
    if (!discoveredLabels.has(label)) agents.push({name: label + '.plist', path: join(directory, label + '.plist'), label});
  }
  // A preview label is not proof of installation/profile ownership. Compare the
  // exact plist this install writes; refuse stale/foreign/unknown ownership.
  if (agents.length > 0) { // Every copy must verify the shared login agent's owner.
    const login = agents.find(agent => agent.label === channel.launchAgentLabel);
    if (login) {
      let saved;
      try { saved = await readFile(login.path, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') return {agents, problem: 'Could not read preview login-agent ownership at ' + login.path + '.'};
        saved = null;
      }
      if (saved === null) {
        // With no plist only an explicit not-loaded read-back permits proceeding.
        // A loaded job's saved command may differ from this installation.
        if (!run || await agentState(run, options.uid ?? process.getuid?.() ?? 0, login.label) !== 'stopped')
          return {agents, problem: 'Could not verify installation/profile ownership of preview login agent ' + login.label + '.'};
        login.path = null;
        login.stopped = true; // retain the label for the final read-back, never bootout
      } else {
        const launcher = bundledLauncher(join(resolveInstallDir(options), 'lib', 'v1', 'uninstall.mjs'));
        const home = options.home ?? configHome();
        const env = options.env ?? process.env;
        const profile = launchProfileEnvironment(env);
        const expectedHome = profile.FARAVAN_HOME ?? channelDataHome({channel, platform, home: userHome, env});
        const expected = launcher && expectedHome && resolve(expectedHome) === resolve(home)
          ? launchAgentPlist(launcher, login.label, profile) : null;
        if (!expected || saved.replace('<key>Disabled</key><true/>', '') !== expected)
          return {agents, problem: 'Could not verify installation/profile ownership of preview login agent ' + login.label + '.'};
        // Another copy of this preview can have loaded the same label from its own plist, and launchd keeps that
        // command until the next login. Boot out a loaded job only when its loaded command and profile are this install's.
        const state = run ? await agentState(run, options.uid ?? process.getuid?.() ?? 0, login.label) : 'running';
        if (state === 'unknown' || (state === 'running' && run &&
            !loadedJobMatches((await run('launchctl', ['print', 'gui/' + (options.uid ?? process.getuid?.() ?? 0) + '/' + login.label]))?.stdout, launcher, profile)))
          return {agents, problem: 'Could not verify loaded preview login-agent ownership for ' + login.label + '.'};
        login.stopped = state === 'stopped';
      }
    }
  }
  const unreadable = agents.filter(agent => !agent.label).map(agent => agent.name);
  return {
    agents,
    problem: unreadable.length ? 'Could not read the Label for launch agent ' + unreadable.join(', ') + '; its state is unknown.' : null,
  };
}

const tarballPaths = root => [join(root, 'bin', 'faravan'), join(root, 'lib', 'faravan'), join(root, 'lib', 'faravan.prev'), join(root, 'lib', 'faravan.new')];

/** The command is ours only if it is the launcher the installer wrote for this root (it runs that root's runtime). */
async function ownsCommand(path, root) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.includes(join(root, 'lib', 'faravan', 'runtime', 'bin', 'node')) ||
    text.includes(`# faravan-tarball-shim: ${root}`);
}

/** What a portable install removes. Its command is listed as foreign, and kept, when some other file sits at that path. */
async function tarballRemovals(root) {
  const remove = [], foreign = [];
  if (!root) return {remove, foreign};
  const commands = new Set([join(root, 'bin', 'faravan')]);
  for (const path of tarballPaths(root)) {
    if (!await exists(path)) continue;
    if (commands.has(path) && !await ownsCommand(path, root)) foreign.push(path);
    else remove.push(path);
  }
  return {remove, foreign};
}

// The installer accepts a matching PATH line anywhere after its marker. Preserve lines between them.
function installerPathBlocks(lines, userHome) {
  const defaultBlock = 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
  const blocks = [];
  let marker = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r?\n$/, '');
    if (line === '# Faravan command path') { marker = index; continue; }
    if (marker === null) continue;
    const custom = line.match(/^case ":\$PATH:" in \*":(.+)\/bin:"\*\) ;; \*\) export PATH="(.+)\/bin:\$PATH" ;; esac$/);
    const root = line === defaultBlock ? join(userHome, '.local') : custom && custom[1] === custom[2] ? custom[1] : null;
    if (root) { blocks.push({marker, line: index, root}); marker = null; }
  }
  return blocks;
}

async function removeInstallerPathBlock(userHome, env = process.env, rootsToRemove = null) {
  const removed = [];
  const zdotdir = env.ZDOTDIR || userHome;
  const profiles = new Set([
    join(userHome, '.bashrc'), join(userHome, '.bash_profile'), join(userHome, '.bash_login'), join(userHome, '.profile'),
    join(zdotdir, '.zshrc'), join(zdotdir, '.zprofile'),
  ]);
  for (const path of profiles) {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) continue;
    const lines = text.split(/(?<=\n)/);
    const indexes = new Set();
    for (const block of installerPathBlocks(lines, userHome)) {
      if (!rootsToRemove || rootsToRemove.has(block.root)) { indexes.add(block.marker); indexes.add(block.line); }
    }
    const updated = lines.filter((_, index) => !indexes.has(index)).join('');
    if (updated === text) continue;
    const target = await realpath(path);
    const mode = (await stat(target)).mode & 0o7777;
    const tempDir = await mkdtemp(join(dirname(target), '.faravan-profile-'));
    try {
      const temp = join(tempDir, 'profile');
      await writeFile(temp, updated, {mode});
      await chmod(temp, mode);
      await rename(temp, target);
    } finally { await rm(tempDir, {recursive: true, force: true}); }
    removed.push(path);
  }
  return removed;
}

function aptRemaining(env) {
  const sources = env.FARAVAN_APT_SOURCES || '/etc/apt/sources.list.d/faravan.sources';
  const keyring = env.FARAVAN_APT_KEYRING || '/usr/share/keyrings/faravan-archive-keyring.gpg';
  return [
    'Remove the Faravan package: sudo apt remove faravan',
    `The apt repository files remain; remove ${sources} and ${keyring} if you no longer want the repository configured.`,
  ];
}

async function aptTarballDetails(userHome, env) {
  const roots = new Set([join(userHome, '.local'), ...(env.FARAVAN_INSTALL_ROOT ? [env.FARAVAN_INSTALL_ROOT] : [])]);
  const profileRoots = new Set();
  const profiles = [join(userHome, '.bashrc'), join(userHome, '.bash_profile'), join(userHome, '.bash_login'), join(userHome, '.profile'),
    join(env.ZDOTDIR || userHome, '.zshrc'), join(env.ZDOTDIR || userHome, '.zprofile')];
  for (const profile of profiles) {
    const lines = (await readFile(profile, 'utf8').catch(() => '')).split(/\r?\n/);
    for (const {root} of installerPathBlocks(lines, userHome)) { roots.add(root); profileRoots.add(root); }
  }
  const remove = [], foreign = [], pathRoots = new Set();
  for (const root of roots) {
    const marker = await readFile(join(root, 'lib', 'faravan', '.installed-via'), 'utf8').catch(() => '');
    const launcher = await ownsCommand(join(root, 'bin', 'faravan'), root);
    if (marker.trim() === 'tarball' || profileRoots.has(root)) {
      const targets = await tarballRemovals(root);
      if (marker.trim() === 'tarball' || launcher) {
        remove.push(...targets.remove);
        if (!targets.foreign.length) pathRoots.add(root);
      }
      foreign.push(...targets.foreign);
    }
  }
  return {remove: [...new Set(remove)], foreign: [...new Set(foreign)], pathRoots};
}

const aptTarballRemovals = async (userHome, env) => (await aptTarballDetails(userHome, env)).remove;

/**
 * Waits for a read-back that is still finishing: a signal or an unload takes effect after its command has returned.
 * Only 'running' is retried; 'stopped' and 'unknown' are final.
 */
async function settled(read, sleep) {
  let state = await read();
  for (let attempt = 0; state === 'running' && attempt < 25; attempt++) { await sleep(200); state = await read(); }
  return state;
}

// Each read-back answers 'stopped', 'running' or 'unknown', from the system and never from a stop command's exit status.
// Only 'stopped' lets deletion go on. A missing unit or agent counts as stopped only when the system says so in its own words.
async function unitState(run, unit) {
  const code = (await run('systemctl', ['--user', 'is-active', '--quiet', unit]))?.code;
  if (code === 0) return 'running';
  // 3: inactive or failed. 4: read-back says not installed. ENOENT and all other results do not prove the unit stopped.
  return [3, 4].includes(code) ? 'stopped' : 'unknown';
}

// Find candidate services by channel, then require the saved installation owner immediately before stopping each one.
// One install can reach more than one sbx HOME. null means the candidate list could not be read.
async function channelSbxDaemonUnits(run, description) {
  const listed = await run('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--type=service', 'faravan-sbxd-*']);
  if (listed?.code === 'ENOENT') return []; // No systemctl on this machine, so no sandbox service can exist.
  if (listed?.code !== 0) return null;
  const units = String(listed.stdout ?? '').split('\n').map(line => line.trim().split(/\s+/)[0]).filter(name => /^faravan-sbxd-[0-9a-f]{12}(?:-[0-9a-f]{64})?\.service$/.test(name));
  const mine = [];
  for (const unit of units) {
    const shown = await run('systemctl', ['--user', 'show', '-p', 'Description', '--value', unit]);
    if (shown?.code !== 0) return null;
    if (String(shown.stdout ?? '').trim() === description) mine.push(unit);
  }
  return mine;
}

// Like unitState, but a unit still deactivating (is-active also exits 3 for it) is not yet stopped.
async function sbxDaemonUnitState(run, unit) {
  const answer = await run('systemctl', ['--user', 'is-active', unit]);
  const state = String(answer?.stdout ?? '').trim();
  if (answer?.code === 0 || state === 'deactivating' || state === 'activating') return 'running';
  return [3, 4].includes(answer?.code) ? 'stopped' : 'unknown';
}

async function trayPathState(run, path) {
  const code = (await run('pgrep', ['-f', trayPattern(path)]))?.code;
  return code === 1 ? 'stopped' : code === 0 ? 'running' : 'unknown';
}

// launchctl print: top-level keys sit one tab in; a block's entries sit two tabs in and end at a one-tab "}".
function launchctlBlock(text, name) {
  const lines = text.split('\n'), start = lines.indexOf('\t' + name + ' = {');
  if (start < 0) return [];
  const end = lines.indexOf('\t}', start);
  return end < 0 ? null : lines.slice(start + 1, end).map(line => line.replace(/^\t\t/, ''));
}

/** True only when the loaded job runs this launcher with --background and exactly this install's profile selectors. */
export function loadedJobMatches(text, launcher, profile) {
  if (typeof text !== 'string' || !launcher) return false;
  const program = /^\tprogram = (.*)$/m.exec(text)?.[1];
  const args = launchctlBlock(text, 'arguments'), env = launchctlBlock(text, 'environment');
  if (program !== launcher || !args || args.length !== 2 || args[0] !== launcher || args[1] !== '--background' || !env) return false;
  const loaded = {};
  for (const line of env) {
    const match = /^(FARAVAN_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR) => (.*)$/.exec(line);
    if (match) loaded[match[1]] = match[2];
  }
  const keys = ['FARAVAN_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  return keys.every(key => loaded[key] === profile[key]);
}

async function agentState(run, uid, label) {
  const answer = await run('launchctl', ['print', 'gui/' + uid + '/' + label]);
  if (answer?.code === 0) return 'running';
  // launchctl's own not-found answer is the only proof that an agent is not loaded: exit 113, or "Could not find service".
  const words = (answer?.stdout ?? '') + (answer?.stderr ?? '');
  return answer?.code === 113 || /Could not find service/.test(words) ? 'stopped' : 'unknown';
}

/** What may still run, one reason each; empty when every read-back says stopped. Only what this install owns is read. */
async function stillRunning({platform, run, sleep, uid, labels, owned}) {
  const checks = [];
  if (platform === 'linux') {
    for (const unit of owned.units) checks.push([unit, 'is still running', () => unitState(run, unit)]);
    if (owned.tray) checks.push(['the tray', 'is still running', () => trayPathState(run, owned.tray)]);
  }
  if (platform === 'darwin') {
    for (const label of labels) checks.push([label, 'is still loaded', () => agentState(run, uid, label)]);
    if (owned.tray) checks.push(['the tray', 'is still running', () => trayPathState(run, owned.tray)]);
  }
  if (platform === 'win32') {
    if (owned.tray) checks.push(['the tray', 'is still running', async () => {
      const answer = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsTrayScript(owned.tray, 'read')]);
      return answer?.code === 0 ? 'stopped' : answer?.code === 1 ? 'running' : 'unknown';
    }]);
    if (owned.task) checks.push(['the resident task', 'is still running', async()=>{
      const answer=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; if (Get-ScheduledTask | Where-Object TaskName -eq 'Faravan-resident' | Where-Object State -eq 'Running') { exit 1 }; exit 0"]);
      return answer.code===0?'stopped':answer.code===1?'running':'unknown';
    }]);
  }
  const left = [];
  for (const [what, busy, read] of checks) {
    const state = await settled(read, sleep);
    if (state === 'running') left.push(what + ' ' + busy);
    else if (state === 'unknown') left.push(what + ' could not be checked');
  }
  return left;
}

const resolveInstallDir = options => options.installDir ?? installRoot;

/** The registrations that belong to this install, read from their own definitions. */
async function ownershipOf({platform, userHome, env, options, run}) {
  const installDir = resolveInstallDir(options), channel = options.channel ?? channelIdentity();
  const kind = await installKind({installDir});
  const layout = basename(installDir) === 'app' ? dirname(installDir) : installDir;
  const root = platform === 'win32' ? layout : kind.kind === 'tarball' && kind.root ? kind.root : installDir;
  const launcher = platform === 'darwin' ? bundledLauncher(join(installDir, 'lib', 'v1', 'uninstall.mjs')) : null;
  return readOwnership({platform, userHome, env, root, installDir, run, kind: kind.kind, channel, launcher});
}

async function uninstallCoordinatorHome(options, home, env) {
  const {coordinatorHome} = await import('../host.mjs');
  return options.coordinatorHome ?? (env.FARAVAN_COORDINATOR_HOME) ??
    coordinatorHome(options.home ? {appHome:home} : {});
}

async function hostedCircles(circles, options, home, env) {
  const {hostPaths} = await import('../host.mjs');
  const hostHome = await uninstallCoordinatorHome(options, home, env);
  const hostConfig = await readFile(hostPaths(hostHome).config, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  const hostedIds = hostConfig?.protocol_version === 1
    ? [hostConfig.circle_id, ...(hostConfig.circle_ids ?? [])] : [];
  return circles.filter(c => c.owned && hostedIds.includes(c.id));
}

/** What `faravan uninstall` would do, as data. Reads only: it never writes, deletes, stops or runs anything. */
export async function uninstallPlan(options = {}) {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, userHome = options.userHome ?? homedir();
  const home = options.home ?? configHome(), alive = options.alive ?? isAlive, keepData = options.keepData === true;
  const app = await readApp(home, alive);
  const {circles} = await openCircles({app, home, hasState: await exists(join(home, 'v1')), options});
  const hosted = await hostedCircles(circles, options, home, env);
  const discovered = await discoverLaunchAgents(platform, userHome, undefined, {...options, home, env});
  const owned = await ownershipOf({platform, userHome, env, options});
  const targets = platformTargets({platform, userHome, env, uid: options.uid ?? process.getuid?.() ?? 0, launchAgents: discovered.agents, channel: options.channel ?? channelIdentity(), owned});
  const hostedBlocker = !keepData && hosted.length && options.deleteHostedCircles !== true
    ? {code: 'hosted_circle', message: hostedBlock(hosted).trimEnd(), circles: hosted.map(c => c.name)} : null;
  const agentBlocker = discovered.problem
    ? {code: 'launch_agent_label', message: discovered.problem + ' Nothing can be removed.', agents: discovered.agents.filter(agent => !agent.label).map(agent => agent.name)} : null;
  const kind = await installKind({installDir: resolveInstallDir(options)});
  const problem = keepData ? null : await dataDirectoryProblem(home, userHome);
  const present = async paths => { const found = []; for (const path of paths) if (await exists(path)) found.push(path); return found; };
  const dataExists = await exists(home);
  const coordinatorHome = await uninstallCoordinatorHome(options, home, env);
  const readCoordinator = options.hostedCoordinatorRecord ?? (await import('./host.mjs')).hostedCoordinatorRecord;
  const coordinator = await readCoordinator(coordinatorHome);
  const cleanupBackend=options.cleanupBackend??new (await import('../docker-backend.mjs')).DockerSbxBackend({home});
  const remediation=await cleanupBackend.inspectCleanupRemediation?.({signal:AbortSignal.timeout(options.cleanupTimeoutMs??30000)})??[];
  return {
    remediation,
    dry_run: true, keep_data: keepData, app_running: app !== null,
    would_stop_coordinator: coordinator ? {pid: coordinator.pid, home: coordinatorHome} : null,
    circles: circles.map(c => ({id: c.id, name: c.name, owned: c.owned === true})),
    would_leave: circles.filter(c => !(keepData && c.owned)).map(c => c.name),
    would_keep_hosted: keepData ? hosted.map(c => c.name) : [], blocked: hostedBlocker ?? agentBlocker ?? (remediation.length?{code:'cessation_unverified',message:'Legacy sandbox cleanup is unverified. Follow the recovery guidance before uninstalling.'}:null),
    data_problem: problem ? 'The data folder ' + problem + ': ' + home : null,
    commands: [...targets.commands, ...targets.unregisterCommands], files: await present(targets.files),
    install: {kind: kind.kind, remove: kind.kind === 'tarball' ? (await tarballRemovals(kind.root)).remove : kind.kind === 'apt' ? await aptTarballRemovals(userHome, env) : []},
    stop_scope: 'Stops, disables and deletes only the services, tasks, autostart entries and tray that start a program inside this install. Any other copy is kept and listed when you run uninstall.',
    data_dir: {path: home, would_remove: !keepData && !problem && dataExists && !remediation.length, exists: dataExists},
    remaining: [...(kind.kind === 'apt' ? aptRemaining(env) : kind.kind === 'brew' ? ['Remove the Faravan package: brew uninstall faravan'] : []), ...targets.manual],
  };
}

function describePlan(plan) {
  const lines = ['Dry run: nothing was changed.'];
  lines.push(...sandboxRemediationLines(plan.remediation));
  if (plan.stop_scope) lines.push(plan.stop_scope);
  if (plan.app_running) lines.push('Faravan is running and would be stopped.');
  if (plan.would_stop_coordinator) lines.push('Would stop hosted coordinator pid ' + plan.would_stop_coordinator.pid + ' at ' + plan.would_stop_coordinator.home + '.');
  lines.push(plan.would_leave.length ? 'Would leave: ' + plan.would_leave.join(', ') + '.' : 'No circles to leave.');
  if (plan.would_keep_hosted.length) lines.push('Would keep hosted circles: ' + plan.would_keep_hosted.join(', ') + '.');
  if (plan.blocked) lines.push('Blocked: ' + plan.blocked.message.replace(/\n/g, ' '));
  if (plan.data_problem) lines.push('Blocked: ' + plan.data_problem + '.');
  for (const path of [...plan.files, ...plan.install.remove]) lines.push('Would remove ' + path);
  lines.push(plan.data_dir.would_remove ? 'Would remove ' + plan.data_dir.path : 'Would keep ' + plan.data_dir.path + '.');
  lines.push(...plan.remaining);
  return lines.join('\n') + '\n';
}

export async function runUninstall(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr, stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, userHome = options.userHome ?? homedir();
  const home = options.home ?? configHome(), run = options.run ?? defaultRun, alive = options.alive ?? isAlive, sleep = options.sleep ?? wait;
  const json = argv.includes('--json');
  const known = ['--keep-data', '--yes', '--delete-hosted-circles', '--dry-run', '--json', '--package-prepare-only'];
  const bad = argv.find(a => !known.includes(a));
  if (bad) { stderr.write('Usage: faravan uninstall [--dry-run] [--keep-data] [--yes] [--delete-hosted-circles]\n'); return 2; }
  if (argv.includes('--keep-data') && argv.includes('--delete-hosted-circles')) {
    stderr.write('Choose either --keep-data or --delete-hosted-circles.\n');
    return 2;
  }
  const packagePrepareOnly = argv.includes('--package-prepare-only');
  if (packagePrepareOnly && (!argv.includes('--yes') || !argv.includes('--delete-hosted-circles') || argv.includes('--keep-data'))) {
    stderr.write('Usage: faravan uninstall --yes --delete-hosted-circles --package-prepare-only --json\n');
    return 2;
  }
  const keepData = argv.includes('--keep-data');
  const reapCleanup=async()=>{
    const backend=options.cleanupBackend??new (await import('../docker-backend.mjs')).DockerSbxBackend({cleanupDirectory:join(home,'v1','sandbox-cleanup')});
    const signal=AbortSignal.timeout(options.cleanupTimeoutMs??30000),blocked=[];
    await backend.reapCleanup({signal});
    const status=backend.cleanupStatus({onBlocked:row=>blocked.push(row.sandbox_id)});
    for(const line of sandboxRemediationLines(status.remediation))stderr.write(line+'\n');
    if(status.state==='blocked'){
      const listing=await backend.runSbx(['policy','ls','--json'],{signal}).catch(()=>null);
      for(const sandbox of new Set(blocked)){
        const rules=scopedRules(listing,sandbox);
        if(rules?.length===0)continue; // The rules are gone now; nothing is left for the owner to remove.
        stderr.write('Warning: sandbox '+JSON.stringify(sandbox)+' still has network rules '+(rules?JSON.stringify(rules.map(rule=>rule.id)):'whose IDs could not be read')+'. Remove them by hand in sbx; use sbx policy ls --json to inspect them.\n');
      }
    }else if(status.state!=='clear')throw new Error('pending cleanup debt ('+JSON.stringify(status)+')');
  };
  if (argv.includes('--dry-run')) {
    try {
      const plan = await uninstallPlan({...options, home, env, platform, userHome, alive, keepData, deleteHostedCircles: argv.includes('--delete-hosted-circles')});
      stdout.write(json ? JSON.stringify(plan) + '\n' : describePlan(plan));
      return 0;
    } catch (error) { stderr.write('Could not build the plan: ' + (error.message ?? 'unknown error') + '\n'); return 1; }
  }
  const report = {left: [], keptCircles: [], asked: [], askByHand: [], removed: [], remaining: [], keptData: keepData};
  const say = text => { if (!json) stdout.write(text + '\n'); };

  if (!argv.includes('--yes')) {
    if (!stdin.isTTY || json) { stderr.write('Uninstalling leaves your circles and removes Faravan from this computer. Run it again with --yes to go ahead.\n'); return 2; }
    const dataRemoval = keepData ? '' : ' This also removes the data directory ' + JSON.stringify(home) + ' and all its contents, including the archive of your earlier version.';
    stdout.write('This leaves your circles and removes Faravan from this computer.' + dataRemoval + ' Type "yes" to continue: ');
    const {createInterface} = await import('node:readline');
    const rl = createInterface({input: stdin, terminal: false});
    const answer = await new Promise(done => { rl.once('line', done); rl.once('close', () => done('')); });
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') { stdout.write('Nothing changed.\n'); return 1; }
  }
  if (!keepData) {
    const problem = await dataDirectoryProblem(home, userHome);
    if (problem) { stderr.write('The data folder ' + problem + ': ' + home + '. Nothing was removed.\n'); return 1; }
  }

  // One lock from before the circles step until the data is gone: while it is
  // held, no sandbox create is dispatched and no sandbox service restarts.
  let releaseUninstallLock;
  try { releaseUninstallLock = acquireUninstallLock(home); }
  catch { stderr.write('Another uninstall of this Faravan is running, or its lock could not be checked. Nothing was removed.\n'); return 1; }
  try { return await uninstallSteps(); }
  finally { releaseUninstallLock(); }

  async function uninstallSteps() {
  const launchAgentDiscovery = await discoverLaunchAgents(platform, userHome, run, {...options, home, env});
  if (launchAgentDiscovery.problem) {
    stderr.write(launchAgentDiscovery.problem + ' Nothing was removed.\n');
    return 1;
  }
  const launchAgents = launchAgentDiscovery.agents;

  // 1. Leave circles. A running app does it, so lending stops and waiting jobs are cancelled first.
  const app = await readApp(home, alive);
  const hasState = await exists(join(home, 'v1'));
  let circles = [], close, leave;
  try {
    ({circles, close, leave} = await openCircles({app, home, hasState, options}));
    const hosted = await hostedCircles(circles, options, home, env);
    if (!keepData && hosted.length && !argv.includes('--delete-hosted-circles')) {
      stderr.write(hostedBlock(hosted));
      return 1;
    }
    for (const circle of circles) {
      if (keepData && circle.owned) {
        report.keptCircles.push(circle.name);
        say('Kept circle ' + circle.name + '.');
        continue;
      }
      if (circle.owned && (argv.includes('--delete-hosted-circles') || !circle.origin)) {
        if (!close) throw new Error('Circle lifecycle controls are unavailable for ' + circle.name + '.');
        await close(circle);
        say('Closed circle ' + circle.name + '.');
      }
      const result = await leave(circle);
      report.left.push(circle.name);
      // A joined circle's owner is asked to remove this computer; an older coordinator or an offline one means asking by hand.
      if (!circle.owned) (result?.leaveRequested === true ? report.asked : report.askByHand).push(circle.name);
      say('Left ' + circle.name + '.');
    }
  } catch (error) {
    stderr.write('Could not leave your circles: ' + (error.message ?? 'unknown error') + '\nNothing else was removed. Finish or wait for the current job, then run uninstall again.\n');
    return 1;
  }

  if (packagePrepareOnly) {
    try{await reapCleanup();}
    catch(error){stderr.write('Could not clear sandbox cleanup debt: '+error.message+'\nYour data and installation were kept. Restore Docker or close active work, then retry uninstall.\n');return 1;}
    if (json) stdout.write(JSON.stringify(report) + '\n');
    else say('Prepared circle lifecycle changes for package purge.');
    return 0;
  }

  // 2. Stop the app (it drains and removes its discovery file), the tray and any service.
  try{if(await exists(home))setResidentQuit(true,home);}
  catch(error){stderr.write('Could not stop resident recovery: '+error.message+'\nYour data and installation were kept.\n');return 1;}
  if (app) {
    // Without a lock held by that process the app is gone: nothing was signalled and there is nothing to wait for.
    if (signalRecordedApp(home, app.pid, {kill: options.kill})) {
      for (let i = 0; i < 100 && alive(app.pid); i++) await sleep(200);
      if (alive(app.pid)) { stderr.write('Faravan is still stopping. Run uninstall again in a minute.\n'); return 1; }
    }
  }
  // 2b. From here to the end of the removal this process holds the profile gate that every app start takes, so an app the
  // user opens now cannot start under the deletion. The gate is a sibling of the data directory (<data>.profile-write.lock...),
  // so removing the data never removes it; it is released only after the last file is gone. A start that meets it
  // is refused with a message. An app that started in the gap above holds its own app lock, which is checked next.
  const removeWhileGated = async () => {
  if (await exists(join(home, 'v1'))) {
    let releaseApp;
    try { releaseApp = await acquireProcessLock(join(home, 'v1', 'app.lock'), {timeoutMs: 0}); }
    catch (error) {
      if (error.code !== 'lock_busy') throw error;
      stderr.write('Faravan was started again while uninstall was running. Nothing else was removed. Quit Faravan, then run uninstall again.\n');
      return 1;
    }
    releaseApp();
  }
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const owned = await ownershipOf({platform, userHome, env, options, run});
  const targets = platformTargets({platform, userHome, env, uid, launchAgents, channel: options.channel ?? channelIdentity(), owned});
  for (const [command, args] of targets.commands) await run(command, args);
  // The stop commands above are not proof. Deletion waits until each process and service that must be gone reads back as stopped.
  const running = await stillRunning({platform, run, sleep, uid, labels: launchAgents.map(agent => agent.label), owned});
  if (running.length) {
    stderr.write('Could not stop Faravan: ' + running.join(', ') + '.\nNothing else was removed. Stop Faravan, then run uninstall again.\n');
    return 1;
  }
  report.remaining.push(...owned.kept.map(line => 'Left in place: ' + line + '.'));

  // The coordinator can outlive the app. Verify and stop it before removing any files.
  try {
    const host = await import('./host.mjs');
    const coordinatorHome = await uninstallCoordinatorHome(options, home, env);
    const record = await (options.hostedCoordinatorRecord ?? host.hostedCoordinatorRecord)(coordinatorHome);
    const stop = options.stopV1Host ?? host.stopV1Host;
    // stopV1Host expects the owner identity, not the {pid, owner} read-back wrapper.
    if (record) await stop({home:coordinatorHome, expectedOwner:record.owner}, {clearIntent:true});
    else await stop({home:coordinatorHome}, {exposureOnly:true,clearIntent:true,processExists:() => false});
  } catch (error) { stderr.write('Could not stop the hosted coordinator or tunnel: ' + String(error.message ?? 'unknown error').replace(/[\r\n]+/g, ' ') + '. Your data was kept. Run faravan host --stop, then retry uninstall.\n'); return 1; }

  try{await reapCleanup();}
  catch(error){stderr.write('Could not clear sandbox cleanup debt: '+error.message+'\nYour data and installation were kept. Restore Docker or close active work, then retry uninstall.\n');return 1;}

  // On Linux the sandbox service runs as its own unit so that it outlives app restarts; stopping the app's units does not
  // stop it. It goes last, after cleanup's own sandbox calls, and every stop is read back like the others.
  if (platform === 'linux') {
    const {sbxDaemonDescription, withDaemonLifecycle, classifySbxDaemonCause, sbxDaemonUnitEvidence, verifySbxDaemonUnitForRemoval, inspectIdentitySandboxes, systemdEnvironmentValue} = await import('../docker-backend.mjs');
    const inspectSandboxes = options.inspectSandboxes ?? inspectIdentitySandboxes;
    const showUnit = unit => run('systemctl', ['--user','show','-p','LoadState','-p','ActiveState','-p','MainPID','-p','InvocationID','-p','Description','-p','ExecStart','-p','Environment',unit]);
    const left = await withDaemonLifecycle(async () => {
      const description = sbxDaemonDescription(options.channel ?? channelIdentity());
      const units = await channelSbxDaemonUnits(run, description);
      const left = units === null ? ['the sandbox service list'] : [];
      for (const unit of units ?? []) {
        const identity = await showUnit(unit);
        const checked = identity?.code === 0 ? sbxDaemonUnitEvidence(identity.stdout) : null;
        if (!checked || !verifySbxDaemonUnitForRemoval(checked, unit, {dataHome:home, root:resolveInstallDir(options)})) {
          stderr.write(`Sandbox service ${unit} was left alone: ${classifySbxDaemonCause('unit_conflict').detail}\n`);
          left.push(unit);
          continue;
        }
        // Under the uninstall lock no new sandbox starts, so an idle service stays idle.
        const sandboxes = await Promise.resolve().then(() => inspectSandboxes({home: systemdEnvironmentValue(checked.environment, 'HOME')})).catch(() => null);
        if (!Array.isArray(sandboxes) || sandboxes.length > 0) {
          stderr.write(`Sandbox service ${unit} was left alone: ${sandboxes ? 'a sandbox still runs in it' : 'Faravan could not check it for running sandboxes'}.\n`);
          left.push(unit);
          continue;
        }
        // Stop only the instance that was checked: a unit restarted meanwhile is another daemon.
        const again = await showUnit(unit);
        if (!checked.invocationId || again?.code !== 0 || sbxDaemonUnitEvidence(again.stdout).invocationId !== checked.invocationId) {
          stderr.write(`Sandbox service ${unit} was left alone: it changed after Faravan checked it.\n`);
          left.push(unit);
          continue;
        }
        await run('systemctl', ['--user', 'stop', unit]);
        if (await sbxDaemonUnitState(run, unit) !== 'stopped') left.push(unit);
      }
      return left;
    });
    if (left.length) {
      stderr.write('Could not stop the sandbox service: ' + left.join(', ') + '. Your data was kept. Resolve the reported service ownership or state, then retry uninstall.\n');
      return 1;
    }
  }

  // 3. Unregister only after stop, coordinator and sandbox-cleanup gates have passed.
  for (const [command, args] of targets.unregisterCommands) await run(command, args);
  if (platform === 'win32' && owned.task) {
    const answer = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; if (Get-ScheduledTask | Where-Object TaskName -eq 'Faravan-resident') { exit 1 }; exit 0"]);
    if (answer.code !== 0) { stderr.write('Could not remove the resident task. Your data and installation were kept. Retry uninstall.\n'); return 1; }
  }
  for (const file of targets.files) if (await exists(file)) { await rm(file, {force: true}); report.removed.push(file); }
  say('Removed the login and autostart entries.');

  // 4. The command, when this is a portable install. A package manager removes its own files.
  const installDir = resolveInstallDir(options);
  const kind = await installKind({installDir});
  if (kind.kind === 'tarball') {
    if (!kind.root) report.remaining.push('Could not tell where this copy of Faravan is installed, so its program and command were kept. Remove them by hand.');
    const {remove, foreign} = await tarballRemovals(kind.root);
    for (const path of remove) { await rm(path, {recursive: true, force: true}); report.removed.push(path); }
    report.removed.push(...await removeInstallerPathBlock(userHome, env, foreign.length ? new Set() : new Set([kind.root])));
    for (const path of foreign) report.remaining.push('Kept ' + path + ': it is not the launcher this install wrote.');
    if (kind.root && [join(kind.root, 'bin', 'faravan')].some(path => remove.includes(path)))
      say('Removed the Faravan command.');
  } else if (kind.kind === 'apt') {
    const portable = await aptTarballDetails(userHome, env);
    for (const path of portable.remove) {
      await rm(path, {recursive: true, force: true});
      report.removed.push(path);
    }
    report.removed.push(...await removeInstallerPathBlock(userHome, env, portable.pathRoots));
    for (const path of portable.foreign) report.remaining.push('Kept ' + path + ': it is not the launcher this install wrote.');
    report.remaining.push(...aptRemaining(env));
  } else {
    report.removed.push(...await removeInstallerPathBlock(userHome, env, new Set([join(userHome, '.local'), ...(env.FARAVAN_INSTALL_ROOT ? [env.FARAVAN_INSTALL_ROOT] : [])])));
    if (kind.kind === 'brew') report.remaining.push('Remove the Faravan package: brew uninstall faravan');
    if (kind.kind === 'checkout') report.remaining.push('Faravan program remains at ' + installDir + ': its install type could not be identified, so the program was kept.');
  }
  report.remaining.push(...targets.manual);

  // 5. The data, last, so a failure above never costs the user their circles' keys.
  if (keepData) say('Kept your data in ' + home + '.');
  else if (await exists(home)) { await rm(home, {recursive: true, force: true}); report.removed.push(home); say('Removed ' + home + '.'); }

  if (report.asked.length) report.remaining.push('Asked the owner of ' + report.asked.join(', ') +
    ' to remove this computer. Their computer does it automatically when it is online.');
  if (report.askByHand.length) report.remaining.push('Could not reach the owner of ' + report.askByHand.join(', ') +
    '. Ask them to remove this computer from the circle.');
  if (json) stdout.write(JSON.stringify(report) + '\n');
  else {
    for (const line of report.remaining) stdout.write(line + '\n');
    const programRemains = report.remaining.some(line => /Remove the Faravan package|sudo apt remove faravan|Faravan program remains|program and command were kept/.test(line));
    stdout.write(programRemains ? 'Faravan uninstall steps are complete.\n' : 'Faravan is uninstalled.\n');
  }
  return 0;
  };
  try { return await withProfileWriter(home, removeWhileGated, {timeoutMs: 0}); }
  catch (error) {
    if (error.code !== 'lock_busy') throw error;
    stderr.write('Faravan is starting or being changed right now. Nothing else was removed. Try uninstall again in a minute.\n');
    return 1;
  }
  }
}
