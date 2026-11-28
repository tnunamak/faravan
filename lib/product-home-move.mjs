/** One-time move of the owner's profile into the single product data directory. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {durableWrite} from './durable-write.mjs';
import {syncDirectory} from './durable-directory.mjs';
import {selectSbxHome} from './sbx-home.mjs';
import {acquireProcessLockSync, lockHeldBy, profileWriterLockPath} from './v1/lock.mjs';

const markerName = '.faravan-data-moved';
const message = 'Circles from the earlier preview must be created or joined again. Your accounts and settings were kept.';
const stat = file => fs.lstatSync(file, {throwIfNoEntry:false});
function markerAt(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, markerName), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function saveMarker(home, marker) { durableWrite(path.join(home, markerName), JSON.stringify(marker) + '\n'); }
function syncTree(file) {
  const entry = fs.lstatSync(file);
  if (entry.isDirectory()) {
    for (const name of fs.readdirSync(file)) syncTree(path.join(file, name));
    syncDirectory(file);
  } else if (entry.isFile()) {
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
// Published sign-ins and their source files; runtime caches and pending writers stay archived.
const sandboxEntry = /^(?:\.docker|\.gh-task-access-[0-9a-f-]{36}|credential-generations|credential-sources|provider-sources|(?:claude|codex|github)-generation\.json|claude-account-.*\.json|usage-account-codex-.*\.json|usage-(?:successor|identity|refresh-staged)-.*\.json(?:\.pending)?)$/;
function copySignIns(from, to) {
  if (from === to || !stat(from)) return;
  fs.mkdirSync(to, {recursive:true, mode:0o700});
  for (const name of fs.readdirSync(from).filter(name => sandboxEntry.test(name))) {
    const target = path.join(to, name);
    fs.cpSync(path.join(from, name), target, {recursive:true, preserveTimestamps:true, verbatimSymlinks:true});
    syncTree(target);
  }
  syncDirectory(to);
}
function finishMove(home, marker) {
  if (marker.version !== 1 || !/^earlier-preview-\d{4}-\d{2}-\d{2}$/.test(marker.archiveName) || !Array.isArray(marker.entries) || marker.entries.some(name => name === '.' || name === '..' || path.basename(name) !== name)) throw new Error('Invalid profile move marker');
  const archive = path.join(home, marker.archiveName);
  fs.mkdirSync(archive, {recursive:true, mode:0o700});
  // Each original top-level entry moves once. A restart never archives the new v1 directory.
  for (const name of marker.entries) {
    const old = path.join(home, name), saved = path.join(archive, name);
    if (!stat(saved)) fs.renameSync(old, saved);
  }
  const copy = relative => {
    const from = path.join(archive, relative);
    if (!stat(from)) return;
    const to = path.join(home, relative);
    fs.mkdirSync(path.dirname(to), {recursive:true, mode:0o700});
    fs.cpSync(from, to, {recursive:true, preserveTimestamps:true, verbatimSymlinks:true});
    syncTree(to);
  };
  const keep = /^(?:device\.pem|app-settings\.json|accounts(?:[.-].*)?|account-providers\.json|lending-accounts\.json|.*signin.*|.*credentials.*)$/;
  for (const name of fs.readdirSync(path.join(archive, 'v1'))) if (keep.test(name)) copy(path.join('v1', name));
  for (const name of marker.entries) if (sandboxEntry.test(name)) copy(name);
  // An inside-profile sandbox moved into the archive along with its parent.
  const oldSandbox = marker.oldSandbox?.startsWith(marker.source + path.sep)
    ? path.join(archive, path.relative(marker.source, marker.oldSandbox)) : marker.oldSandbox;
  if (oldSandbox && marker.newSandbox) copySignIns(oldSandbox, marker.newSandbox);
  const stateFile = path.join(archive, 'v1', 'state.json');
  const state = stat(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {version:1};
  durableWrite(path.join(home, 'v1', 'state.json'), JSON.stringify({...state, circles:[], activeCircle:null}));
  syncDirectory(archive);
  syncDirectory(home);
  saveMarker(home, {...marker, phase:'complete', shown:false});
}
function move(destination, {home, platform, env, now, sandboxUserHome}) {
  const previous = markerAt(destination);
  if (previous?.phase === 'complete') return null;
  if (previous) { finishMove(destination, previous); return destination; }
  const dataBase = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const children = base => {
    try { return fs.readdirSync(base); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const legacy = '.spare' + 'kin';
  const candidates = [
    ...children(dataBase).filter(name => /^Faravan Preview [A-Za-z0-9.-]+$/.test(name)).map(name => path.join(dataBase, name)),
    ...children(home).filter(name => name.startsWith(legacy)).map(name => path.join(home, name)),
    path.join(home, '.faravan'),
  ].filter(source => source !== destination && fs.existsSync(path.join(source, 'v1')));
  const chosen = env.FARAVAN_MOVE_FROM;
  if (chosen && (!path.isAbsolute(chosen) || !candidates.includes(path.resolve(chosen)))) throw new Error('FARAVAN_MOVE_FROM must name one of the old profile folders: ' + candidates.join(', '));
  if (candidates.length > 1 && !chosen) throw new Error('Multiple old profiles found. Set FARAVAN_MOVE_FROM to one old folder: ' + candidates.join(', '));
  const source = chosen ? path.resolve(chosen) : candidates[0];
  if (!source) return null;
  if (!stat(source).isDirectory()) throw new Error('Old profile must be a real directory');
  let release;
  try { release = acquireProcessLockSync(profileWriterLockPath(source)); }
  catch (error) { if(error.code === 'lock_busy') throw new Error('Quit the old app, then start Faravan again.', {cause:error}); throw error; }
  try {
  const appFile = path.join(source, 'v1', 'app.json');
  if (stat(appFile)) {
    const app = JSON.parse(fs.readFileSync(appFile, 'utf8'));
    // The old app is running only if it holds its app lock; a saved PID may belong to an unrelated process.
    if (Number.isSafeInteger(app.pid) && app.pid > 0 && lockHeldBy(path.join(source, 'v1', 'app.lock'), app.pid)) throw new Error('Quit the old app, then start Faravan again.');
  }
  if (stat(destination)) {
    const state = path.join(destination, 'v1', 'state.json');
    if (stat(state) && JSON.parse(fs.readFileSync(state, 'utf8')).circles?.length) throw new Error('The new data folder already has circles; data was left unchanged.');
    if (!stat(destination).isDirectory() || fs.readdirSync(destination).length) throw new Error('The new data folder is not empty; data was left unchanged.');
    fs.rmdirSync(destination); // Only an empty launcher-created directory may be replaced.
  }
  fs.mkdirSync(path.dirname(destination), {recursive:true, mode:0o700});
  const sandbox = dataHome => selectSbxHome({home, dataHome, override:env.FARAVAN_SBX_HOME, channelPlatform:platform, channelEnv:env, userHome:sandboxUserHome}).home;
  const marker = {version:1, source, oldSandbox:sandbox(source), newSandbox:sandbox(destination), destination, archiveName:'earlier-preview-' + now().toISOString().slice(0,10), entries:fs.readdirSync(source).filter(name => name !== markerName), phase:'preparing', shown:false};
  saveMarker(source, marker);
  fs.renameSync(source, destination); // EXDEV leaves the source intact; never copy and delete across devices.
  syncDirectory(path.dirname(source));
  syncDirectory(path.dirname(destination));
  finishMove(destination, marker);
  return destination;
  } finally { release(); }
}
export function migrateProductHome(destination, options = {}) {
  if (markerAt(destination)?.phase === 'complete') return null;
  const deadline = performance.now() + 60000;
  let release;
  for (;;) {
    try { release = acquireProcessLockSync(profileWriterLockPath(destination)); break; }
    catch (error) {
      if (error.code !== 'lock_busy' || error.reason === 'lock_stale' && !error.retryable || performance.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return move(destination, {home:os.homedir(), platform:process.platform, env:process.env, now:() => new Date(), ...options}); }
  finally { release(); }
}
export function productMigrationNotice(home) {
  const marker = markerAt(home);
  return marker?.phase === 'complete' && !marker.shown ? {message, archive:path.join(home, marker.archiveName)} : null;
}
export function acknowledgeProductMigration(home) {
  const marker = markerAt(home);
  if (marker?.phase === 'complete' && !marker.shown) saveMarker(home, {...marker, shown:true});
}


// Packaging launchers call this before any app process can initialize the new home.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const destination = process.argv[2];
    if (!destination || !path.isAbsolute(destination)) throw new Error('Expected an absolute product data folder');
    migrateProductHome(destination);
    fs.mkdirSync(destination, {recursive:true, mode:0o700});
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
