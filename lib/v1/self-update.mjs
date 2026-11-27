import {readEarlyBuilds,updateFeedURL} from './update-feed.mjs';
// Self-update for the tarball install (a package install updates through apt).
//
// A release publishes update.json and update.json.sig: an Ed25519 signature over the
// exact bytes of update.json. The manifest names the tarball and its sha256, so one
// signature covers the download. The updater only moves forward, applies only when
// the app is idle (between jobs), keeps the previous tree, and rolls back if the new
// tree cannot start. It never runs unsigned code.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rename as fsRename, rm, writeFile, copyFile, stat, readdir, readlink } from 'node:fs/promises';
import { dirname, join, sep, relative, resolve } from 'node:path';
import { existsSync, constants, renameSync as fsRenameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {durableJsonAsync} from '../durable-write.mjs';
import { UPDATE_PUBLIC_KEY } from './update-key.mjs';
import { acquireProcessLock } from './lock.mjs';
import {selectUpdateAsset,validateManifestAssets} from './update-assets.mjs';
import {parseUpdateVersion,validMacUpdateVersion} from './macos-update-version.mjs';
export {selectUpdateAsset} from './update-assets.mjs';

const execFileAsync = promisify(execFile);
export const DEFAULT_MANIFEST_URL = 'https://github.com/tnunamak/faravan/releases/latest/download/update.json';
export const PREVIEW_FEED_URL = 'https://tnunamak.github.io/faravan-updates/preview/update.json';
const defaultManifestUrl = version => parseVersion(version)?.length === 5 ? PREVIEW_FEED_URL : DEFAULT_MANIFEST_URL;
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;
// One cap per signed file on every platform (the larger macOS sizes).
export const MANIFEST_MAX_BYTES = 512 * 1024;
export const SIGNATURE_MAX_BYTES = 4096;
// A release dated further ahead than this cannot be a real publication; it would block every later release.
const MAX_RELEASE_AHEAD_MS = 24 * 3600_000;
const MARKER = '.installed-via';

export const UNMANAGED_COORDINATOR_WARNING = 'A Faravan coordinator that this app did not start may still be using a different version. Restart it to use the installed version.';

/** Read-only Linux census. Missing/inaccessible processes are unknown, not warnings.
 * Both the filesystem and the complete snapshot are injectable; no process is probed with a signal.
 */
export async function coordinatorSnapshot({installDir, platform = process.platform, uid = process.getuid?.(),
  fs = {readdir, readFile, readlink, stat}}) {
  const snapshot = {installIdentity: null, processes: []};
  if (platform !== 'linux' || !Number.isInteger(uid)) return snapshot;
  try { const s = await fs.stat(installDir); snapshot.installIdentity = String(s.dev) + ':' + String(s.ino); } catch {}
  let pids;
  try { pids = await fs.readdir('/proc'); } catch { return snapshot; }
  const startOf = text => text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[19];
  for (const name of pids) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const root = '/proc/' + name;
    try {
      if ((await fs.stat(root)).uid !== uid) continue;
      const start = startOf(await fs.readFile(root + '/stat', 'utf8'));
      const exe = await fs.readlink(root + '/exe');
      const argv = (await fs.readFile(root + '/cmdline', 'utf8')).split('\0');
      // The shipped coordinator is a direct entry script, not a word somewhere in arbitrary arguments.
      const entry = argv[1] ?? '';
      if (!/^\d+$/.test(start ?? '') || start !== startOf(await fs.readFile(root + '/stat', 'utf8'))
          || (await fs.stat(root)).uid !== uid) continue;
      snapshot.processes.push({pid: Number(name), start, exe, entry});
    } catch { /* exited, PID changed, or permission denied */ }
  }
  return snapshot;
}

/** Path membership alone never proves that a process at the active path uses an older tree.
 * A retained start token plus a changed install inode is needed for that case.
 */
export function unmanagedCoordinators({installDir, before, after, records = []}) {
  const clean = value => typeof value === 'string' && value.startsWith('/') ? resolve(value.replace(/ \(deleted\)$/, '')) : '';
  const member = value => {
    const path = clean(value);
    if (!path) return null;
    for (const root of [installDir, installDir + '.prev', installDir + '.next'])
      if (path === root || path.startsWith(root + sep)) return root;
    const suffix = path.slice(installDir.length);
    return path.startsWith(installDir + '.rollback-') && /^\.rollback-[^/]+(?:\/|$)/.test(suffix) ? 'rollback' : null;
  };
  const coordinator = value => /\/bin\/faravan-coordinator$/.test(clean(value));
  return (after?.processes ?? []).filter(p => {
    if (!coordinator(p.entry) && !coordinator(p.exe)) return false;
    if (records.some(r => r?.pid === p.pid && (r.owner?.start != null && String(r.owner.start) === p.start))) return false;
    const paths = [p.exe, p.entry].filter(member);
    if (!paths.length) return false;
    if (paths.some(path => path.endsWith(' (deleted)') || member(path) !== installDir)) return true;
    return before?.installIdentity && after?.installIdentity && before.installIdentity !== after.installIdentity
      && before.processes.some(old => old.pid === p.pid && old.start === p.start
        && [old.exe, old.entry].some(member));
  }).map(({pid, start}) => ({pid, start}));
}

export class UpdateError extends Error {
  constructor(code, message, {cause, recovery} = {}) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'FaravanUpdateError'; this.code = code;
    if (recovery) this.recovery = recovery;
  }
}
export function secureUpdateURL(value,base){let u;try{u=new URL(value,base);}catch{throw new UpdateError('bad_manifest','Invalid update address');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new UpdateError('bad_manifest','Update addresses must use HTTPS');return u.href;}
export async function getUpdateBytes(fetch,url,max,{signal:parentSignal}={}) {
  const timeout=AbortSignal.timeout(60000),signal=parentSignal?AbortSignal.any([parentSignal,timeout]):timeout;
  try {
    let response, address=secureUpdateURL(url);
    for(let hops=0;;hops++) {
      signal.throwIfAborted();
      response=await fetch(address,{redirect:'manual',signal});
      signal.throwIfAborted();
      if(![301,302,303,307,308].includes(response.status))break;
      await response.body?.cancel().catch(()=>{});
      const location=response.headers?.get?.('location');
      if(hops>=5||!location)throw new UpdateError('fetch_failed','The update download has too many redirects');
      address=secureUpdateURL(location,address);
    }
    if(!response.ok||!response.body)throw new UpdateError('fetch_failed','Could not download the update');
    const length=response.headers?.get?.('content-length');
    if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>max)){await response.body.cancel?.().catch(()=>{});throw new UpdateError('too_large','Update download exceeds its limit');}
    let total=0;const chunks=[];
    for await(const chunk of response.body){signal.throwIfAborted();total+=chunk.length;if(total>max)throw new UpdateError('too_large','Update download exceeds its limit');chunks.push(Buffer.from(chunk));}
    signal.throwIfAborted();
    return Buffer.concat(chunks,total);
  } catch(error) {
    if(error?.name==='TimeoutError'||error?.name==='AbortError')throw new UpdateError('fetch_failed','The update download timed out.',{cause:error});
    throw error;
  }
}

/**
 * The saved update state, or {} when there is none. A file that does not parse, or whose accepted mark is misshapen,
 * is moved aside as <file>.corrupt-<time>, so the install keeps updating. Its mark is then seeded from the installed version.
 */
export async function readUpdateState(file, now = Date.now) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new UpdateError('invalid_state', 'The saved update state cannot be read.', {cause: error});
  }
  let state;
  try { state = JSON.parse(text); } catch { /* quarantined below */ }
  if (validUpdateState(state)) return state;
  // Move aside only the bad text read above, so a valid file another process just wrote is kept.
  if (await readFile(file, 'utf8').catch(() => null) !== text) return readUpdateState(file, now);
  await fsRename(file, file + '.corrupt-' + new Date(now()).toISOString().replace(/[:.]/g, '-')).catch(() => {});
  return {};
}
const validMark = mark => mark !== null && typeof mark === 'object' && Boolean(parseVersion(mark.version))
  && typeof mark.channel === 'string' && Number.isSafeInteger(mark.parts)
  && typeof mark.released === 'string' && Number.isFinite(Date.parse(mark.released));
const validUpdateState = state => state !== null && typeof state === 'object' && !Array.isArray(state)
  && (state.accepted === undefined || validMark(state.accepted));
/** The floor this install enforces: its own mark when the mark is for the same channel and version shape, else the installed version. */
export function releaseFloor(state, scope, installed) {
  const mark = state.accepted;
  if (mark?.channel !== scope.channel || mark?.parts !== scope.parts) return {version: installed, released: null};
  return isNewer(installed, mark.version) ? {...mark, version: installed} : mark;
}
export const acceptedMark = (manifest, scope) => ({released: manifest.released, version: manifest.version, channel: scope.channel, parts: scope.parts});
/** Refuses a release dated too far ahead, or older than the floor. `newer(a, b)` compares two versions of one channel. */
export function assertReleaseAccepted(manifest, floor, {newer, now}) {
  if (typeof manifest.released !== 'string' || !Number.isFinite(Date.parse(manifest.released)))
    throw new UpdateError('bad_manifest', 'The update release date is not valid.');
  const released = Date.parse(manifest.released);
  if (released > now() + MAX_RELEASE_AHEAD_MS) throw new UpdateError('bad_manifest', 'The update release date is in the future.');
  const older = floor.released != null && released < Date.parse(floor.released);
  const lower = manifest.version !== floor.version && !newer(manifest.version, floor.version);
  if (older || lower) throw new UpdateError('metadata_rollback', 'The update metadata is older than an already accepted release.');
}

/** The one error to report for a run of failures: that error, or all of them when several steps failed. */
const failureOf = errors => (errors.length === 1 ? errors[0] : new AggregateError(errors, 'several update steps failed'));

/** Stable dotted versions or dated previews, with numeric date/build ordering. */
export function parseVersion(text) {
  const value=String(text).trim(),stable=/^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return stable ? stable.slice(1).map(Number) : parseUpdateVersion(value);
}
export function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Returns the manifest only when the signature verifies against the pinned key. */
function verifyManifestFor(bytes, signatureBase64, publicKeyPem, versionValid) {
  let valid = false;
  try {
    valid = verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(String(signatureBase64).trim(), 'base64'));
  } catch { valid = false; }
  if (!valid) throw new UpdateError('bad_signature', 'The update manifest is not signed by the Faravan release key.');
  let manifest;
  try { manifest = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new UpdateError('bad_manifest', 'The update manifest is not valid.'); }
  if (manifest?.schema !== 1 || !versionValid(manifest.version) || typeof manifest.tarball !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')
      || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_TARBALL_BYTES)
    throw new UpdateError('bad_manifest', 'The update manifest is not valid.');
  try {validateManifestAssets(manifest);} catch {throw new UpdateError('bad_manifest', 'The update asset manifest is not valid.');}
  return manifest;
}
export function verifyManifest(bytes,signature,publicKey) {return verifyManifestFor(bytes,signature,publicKey,parseVersion);}
export function verifyMacManifest(bytes,signature,publicKey,channel) {return verifyManifestFor(bytes,signature,publicKey,version=>validMacUpdateVersion(version,channel));}

const exists = path => access(path).then(() => true, () => false);
const readText = path => readFile(path, 'utf8').then(t => t.trim(), () => null);

async function defaultExtract(tarFile, directory) { await execFileAsync('tar', ['-xzf', tarFile, '-C', directory]); }
/** The runtime a tree ships with (D6), else the one running now: an update may bring a newer Node. */
export async function runtimeFor(installDir, execPath = process.execPath) {
  const bundled = join(installDir, 'runtime', 'bin', 'node');
  return await access(bundled).then(() => bundled, () => execPath);
}
async function defaultSmoke(installDir, execPath) {
  await execFileAsync(await runtimeFor(installDir, execPath), [join(installDir, 'bin', 'faravan'), '--help'], {timeout: 20000, env: {...process.env, FARAVAN_NO_BROWSER: '1'}});
}

/**
 * installDir is the tree to replace (<root>/lib/faravan). Everything that touches
 * the network, tar or a child process is injected, so tests need none of them.
 * hosts (optional) is the circle host on this computer: record(), stop(record) and start(). A swap stops it
 * while its identity still verifies, and starts it again from the new install before the update is done.
 */
export function createUpdater({installDir: givenInstallDir, stateFile, publicKey = UPDATE_PUBLIC_KEY, manifestUrl,
  arch = process.arch,
  fetch = globalThis.fetch, extract = defaultExtract, execPath = process.execPath, smoke = dir => defaultSmoke(dir, execPath),
  now = Date.now, log = () => {}, intervalMs = 6 * 3600_000, startDelayMs = 120_000, rename = fsRename, renameSync = fsRenameSync, hosts = null, census = coordinatorSnapshot,
  lockWaitMs = 3000} = {}) {
  // A directory URL path ends in '/', which would put .next, .prev and the lock inside the install.
  const installDir = typeof givenInstallDir === 'string' ? resolve(givenInstallDir) : givenInstallDir;
  const next = installDir + '.next', prev = installDir + '.prev', lockPath = installDir + '.update.lock';

  /** One updater at a time per install: the app's schedule and a manual `faravan update` share the staging and swap paths. */
  async function withLock(work) {
    let release;
    try { release = await acquireProcessLock(lockPath, {timeoutMs: 0}); }
    catch (error) {
      if (error?.code === 'lock_busy') throw new UpdateError('busy', 'Another Faravan update is already running.');
      throw error;
    }
    try { return await work(); } finally { release(); }
  }
  /** An interrupted swap (installDir moved to .prev, the new tree not yet in place) leaves no install: put the old one back. */
  async function recoverLayout() {
    if (await exists(installDir) || !await exists(prev)) return false;
    await rename(prev, installDir);
    log('restored the previous version after an interrupted update');
    return true;
  }

  const readState = () => readUpdateState(stateFile, now);
  /** Every state change is a read-modify-write under the state lock. A briefly held lock is waited for; a busy one is reported as busy. */
  async function updateState(change,{signal,admit=()=>{},commit=fn=>{admit();return fn();}}={}) {
    signal?.throwIfAborted();admit();
    await mkdir(dirname(stateFile), {recursive: true});
    let release;
    try { release = await acquireProcessLock(stateFile + '.lock', {timeoutMs: lockWaitMs,signal}); }
    catch (error) {
      if (error?.code === 'lock_busy') throw new UpdateError('busy', 'The saved update state is being written by another Faravan process.');
      throw error;
    }
    try { await durableJsonAsync(stateFile, change(await readState()),{publish:replace=>{signal?.throwIfAborted();return commit(replace);}}); }
    finally { release(); }
  }
  /** This install's channel and version shape: the scope a release mark is kept for. */
  async function installScope(current) {
    let channel;try {channel=JSON.parse(await readText(join(installDir,'channel.json')));} catch {}
    const parts = parseVersion(current)?.length;
    if (!parts) throw new UpdateError('unknown_version', 'This installation has no supported version.');
    return {channel: typeof channel?.id === 'string' ? channel.id : 'faravan', parts};
  }

  /** The newest verified manifest, or null when this install is current or updates are off. */
  async function check({signal,admit=()=>{},commit}={}) {
    signal?.throwIfAborted();admit();
    if (!publicKey) throw new UpdateError('no_key', 'This build has no release key pinned, so it does not update itself.');
    const current = await readText(join(installDir, 'VERSION'));
    if (!parseVersion(current)) throw new UpdateError('unknown_version', 'This install has no readable version.');
    const url = manifestUrl || defaultManifestUrl(current);
    const bytes = await getUpdateBytes(fetch, url, MANIFEST_MAX_BYTES,{signal});
    admit();
    const manifest = verifyManifest(bytes, (await getUpdateBytes(fetch, url + '.sig', SIGNATURE_MAX_BYTES,{signal})).toString('utf8'), publicKey);
    if (parseVersion(manifest.version).length !== parseVersion(current).length)
      throw new UpdateError('bad_target', 'The update version does not match this installation.');
    const scope = await installScope(current);
    const candidate=isNewer(manifest.version,current)?manifest:null;
    // Only a newer release needs an asset for this install; a feed with nothing newer for it reads as current.
    if (candidate) {
      try {selectUpdateAsset(manifest,{platform:'linux',arch,channel:scope.channel});}
      catch {throw new UpdateError('bad_target','No update matches this installation');}
    }
    assertReleaseAccepted(manifest, releaseFloor(await readState(), scope, current), {newer: isNewer, now});
    // The release mark moves only when an update is applied (see apply), so a broken release can be withdrawn.
    await updateState(state => ({...state, checkedAt:new Date(now()).toISOString(),candidate:candidate?.version??null,
      notes:typeof candidate?.notes==='string'?candidate.notes.split('\n').slice(0,3).map(x=>x.slice(0,300)):[],
      notesUrl:typeof candidate?.release_notes_url==='string'&&/^https:\/\//.test(candidate.release_notes_url)?candidate.release_notes_url:null}),{signal,admit,commit});
    return {current,manifest:candidate};
  }

  /** Download, verify the hash against the signed manifest, and unpack to <installDir>.next. */
  async function stage(manifest) {
    return withLock(() => stageLocked(manifest));
  }
  async function stageLocked(manifest) {
    if (await readText(join(next, 'VERSION')) === manifest.version) return;
    const url = new URL(manifest.tarball, manifestUrl || defaultManifestUrl(await readText(join(installDir, 'VERSION'))));
    if (url.protocol !== 'https:') throw new UpdateError('bad_manifest', 'The update must come over https.');
    if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_TARBALL_BYTES)
      throw new UpdateError('bad_manifest', 'The update archive size is not valid.');
    const bytes = await getUpdateBytes(fetch, url.toString(), manifest.size);
    if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256)
      throw new UpdateError('bad_hash', 'The downloaded update does not match its signed manifest.');
    const work = await mkdtemp(join(dirname(installDir), '.faravan-update-'));
    try {
      await writeFile(join(work, 'update.tar.gz'), bytes);
      await mkdir(join(work, 'unpacked'));
      await extract(join(work, 'update.tar.gz'), join(work, 'unpacked'));
      const tree = join(work, 'unpacked', 'usr', 'lib', 'faravan');
      if (!await exists(join(tree, 'bin', 'faravan')) || await readText(join(tree, 'VERSION')) !== manifest.version)
        throw new UpdateError('bad_tarball', 'The update does not contain the version its manifest names.');
      await copyFile(join(installDir, MARKER), join(tree, MARKER)); // keeps the new tree self-updating
      await rm(next, {recursive: true, force: true});
      await rename(tree, next);
    } finally { await rm(work, {recursive: true, force: true}); }
  }

  /**
   * Swap the staged tree in. The staged tree must start before anything moves, so a bad update never disturbs a
   * running circle host. A hosted coordinator is stopped while its identity still verifies, which is only before the
   * swap, and the update reports done only after the new install has started it. Failures roll back to the old tree.
   */
  async function apply(manifest,{admit=()=>{},commit=fn=>{admit();return fn();}}={}) {
    admit();
    return withLock(async () => {
      const before = await snapshotCoordinators();
      let hosted = null;
      try {
        await recoverLayout();
        const scope = await installScope(await readText(join(installDir, 'VERSION')));
        if (await readText(join(next, 'VERSION')) !== manifest.version)
          throw new UpdateError('bad_tarball', 'The staged update is not the version its manifest names.');
        try { await smoke(next); } catch {
          await rm(next, {recursive: true, force: true});
          await recordFailure(manifest);
          throw new UpdateError('rolled_back', 'The new version did not start, so Faravan kept the old one.');
        }
        await checkLaunchRuntime();
        hosted = hosts ? await recordHosted() : null;
        admit();
        if (hosted) { log('stopping the circle host'); await stopHosted(hosted); }
        log('swapping in version ' + manifest.version);
        try { await swapIn(admit,commit); }
        catch (error) {
          if (error.code === 'restore_failed') throw error; // the old tree is not back, so its host must not start over a missing install
          if (hosted) await restartHosted(error); // the old tree is back in place, and its coordinator was stopped
          throw error;
        }
        if (hosted) { log('starting the circle host on version ' + manifest.version); await startNewHost(manifest); }
        // Only now is the release applied: a staged or smoke-failed release never moves the floor.
        // Best effort: the new tree is already live, and its VERSION is the floor if the mark is not saved.
        try { await updateState(state => ({...state, accepted: acceptedMark(manifest, scope)})); }
        catch (error) { log('could not save the release mark: ' + (error.message ?? error)); }
      } finally { await warnUnmanaged(before, hosted); }
    });
  }
  async function snapshotCoordinators() {
    try { return await census({installDir}); } catch { return null; }
  }
  async function warnUnmanaged(before, hosted) {
    // Diagnostics must never replace the original update error or interrupt rollback/restart.
    try {
      const after = await snapshotCoordinators();
      const records = [...(await hosts?.censusRecords?.() ?? []), ...(hosted ? [hosted] : [])];
      const unmanaged = unmanagedCoordinators({installDir, before, after, records});
      const warning = unmanaged.length ? UNMANAGED_COORDINATOR_WARNING : null;
      await updateState(state => ({...state, unmanagedCoordinators: unmanaged, warning}));
      if (warning) log(warning);
    } catch { /* best-effort diagnostic; update outcome is unchanged */ }
  }
  async function recordFailure(manifest) {
    await updateState(state => ({...state, failedVersion: manifest.version, failedAt: new Date(now()).toISOString()}));
  }
  /** Without a verified record, nothing is stopped and nothing is swapped. */
  async function recordHosted() {
    try { return await hosts.record(); }
    catch { throw new UpdateError('host_unverified', 'Faravan cannot verify the circle host on this computer, so the update was not applied.'); }
  }
  /** The old tree is still in place. If the failed stop took the coordinator down, start it again; if it still runs, leave it. */
  async function stopHosted(hosted) {
    try { await hosts.stop(hosted); }
    catch (error) {
      let running = true; // unknown counts as running: never start a second coordinator beside one
      try { running = await hosts.record() !== null; } catch { /* still running or unverifiable */ }
      if (!running) await restartHosted();
      if (error?.code === 'legacy_exposure_pending')
        throw new UpdateError('legacy_exposure_pending', 'The circle host refused to stop because of a saved legacy exposure. Review the saved legacy exposure and retry the update.');
      throw new UpdateError('host_stop_failed', 'Faravan could not stop the circle host, so the update was not applied. The current version keeps running.');
    }
  }
  /** Starts the old coordinator again. `cause` is the failure that made the restart necessary, kept with a restart failure. */
  async function restartHosted(cause) {
    try { await hosts.start(); }
    catch (error) { throw new UpdateError('host_restart_failed', 'The circle host did not restart. Run faravan host to start it.', {cause: cause ? failureOf([cause, error]) : error}); }
  }
  /**
   * The new install starts its coordinator before the update counts as done. If that fails, the old install comes back
   * with its coordinator. Each recovery step runs even when an earlier one failed. The error keeps every failure, and
   * error.recovery says which steps succeeded.
   */
  async function startNewHost(manifest) {
    let startError;
    try { await hosts.start(); return; }
    catch (error) { startError = error; log('the circle host did not start on the new version: ' + (error.message ?? error)); }
    // A launch that is still alive may yet start a coordinator. Until it is gone, nothing is stopped or moved.
    if (['launcher_running', 'launcher_unverified'].includes(startError?.code) || startError?.cleanup_verified === false)
      throw new UpdateError('host_unverified', 'The new version did not start its circle host, and its coordinator cleanup could not be verified, so Faravan kept the new version. Run faravan host to check it.', {cause: startError});
    try {
      // A coordinator that half-started must not run beside the old one. An unknown state is not guessed at.
      const live = await hosts.record();
      if (live) await hosts.stop(live);
    } catch (error) {
      throw new UpdateError('host_unverified', 'The new version did not start its circle host, and Faravan cannot verify what is running. Run faravan host to check it.', {cause: failureOf([startError, error])});
    }
    const failures = [startError], recovery = {restarted: false, failedVersionRecorded: false};
    try { await recordFailure(manifest); recovery.failedVersionRecorded = true; }
    catch (error) { failures.push(error); }
    await putBackPrevious(failures, recovery);
    log('rolled back to the previous version; restarting its circle host');
    try { await hosts.start(); recovery.restarted = true; }
    catch (error) {
      failures.push(error);
      throw new UpdateError('host_restart_failed', 'The previous version is back, but the circle host did not restart. Run faravan host to start it.', {cause: failureOf(failures), recovery});
    }
    throw new UpdateError('rolled_back', 'The circle host did not start on the new version, so Faravan kept the old one.', {cause: failureOf(failures), recovery});
  }
  /**
   * The circle host and the app start from the new tree's own Node, else from the Node running this updater. A Node inside
   * the tree being replaced is moved away by the swap, so such an update is refused before anything stops.
   */
  async function checkLaunchRuntime() {
    const executable = async file => {
      try { return (await stat(file)).isFile() && await access(file, constants.X_OK).then(() => true); }
      catch { return false; }
    };
    if (await executable(join(next, 'runtime', 'bin', 'node'))) return;
    const runtimeRelative = relative(resolve(installDir), resolve(execPath));
    if (runtimeRelative === '..' || runtimeRelative.startsWith('..' + sep) || runtimeRelative.startsWith(sep)) return;
    if (runtimeRelative && await executable(join(next, runtimeRelative))) return;
    throw new UpdateError('runtime_missing', 'The new version has no Node of its own, and this update runs from ' + execPath
      + ', which is inside the version it replaces. Faravan kept the old version.');
  }
  /** Moves the old tree to .prev and the staged tree into installDir. If the staged tree does not move in, the old one goes back. */
  async function swapIn(admit,commit) {
    admit();
    await rm(prev, {recursive: true, force: true});
    // Both moves finish inside their guard, without yielding between the old
    // tree moving out and the staged tree moving in. A refused promotion rolls back.
    commit(()=>renameSync(installDir, prev));
    try { commit(()=>renameSync(next, installDir)); }
    catch (error) { await putBackPrevious([error]); throw error; }
  }
  /**
   * Puts the previous tree back at installDir. When that fails, the restore_failed error names what is on disk, and the
   * caller must not start the old coordinator, because its install is not there.
   */
  async function putBackPrevious(earlier, recovery = {}) {
    try {
      await rm(installDir, {recursive: true, force: true}); // the staged tree that did not start, if it is still here
      await rename(prev, installDir);
    } catch (error) {
      const present = await exists(installDir);
      throw new UpdateError('restore_failed', 'Faravan could not put the previous version back. It is still at ' + prev
        + ', and ' + installDir + (present ? ' holds the version that did not start.' : ' is missing.'),
        {cause: failureOf([...earlier, error]), recovery});
    }
  }

  /**
   * One scheduled step. Returns 'disabled' | 'too-soon' | 'current' | 'staged' | 'applied' | 'skipped-failed-version' | 'failed'.
   * 'staged' means a verified update is ready and waits for an idle moment.
   * `idle` was sampled before the download, so it only says whether to try. `exclusive` (optional) is asked after the
   * download: it stops new work from starting, rechecks that nothing started meanwhile, and returns a release function
   * (or null when something did). Its hold lasts through the swap; the caller's shutdown ends it after 'applied'.
   */
  let automaticFailure = null;
  async function tick({idle, exclusive, admit=()=>{}, commit, force = false} = {}) {
    const settled = outcome => { automaticFailure = null; return outcome; };
    try {
      if (!publicKey) return settled('disabled');
      // A crashed swap leaves no install to read a version from; repair it before anything else looks, state included.
      await withLock(recoverLayout).catch(error => { if (error?.code !== 'busy') throw error; });
      const state = await readState();
      if (!force && state.scheduledCheckedAt && now() - Date.parse(state.scheduledCheckedAt) < intervalMs && !(idle && await exists(next))) return 'too-soon';
      const {manifest} = await check({admit,commit});
      await updateState(state => ({...state, scheduledCheckedAt: new Date(now()).toISOString()}),{admit,commit});
      if (!manifest) return settled('current');
      if (state.failedVersion === manifest.version) return settled('skipped-failed-version');
      await stage(manifest);
      if (!idle) return 'staged';
      const release = exclusive ? await exclusive() : () => {};
      if (release === null) return 'staged';
      try { await apply(manifest,{admit,commit}); } catch (error) { await release(); throw error; }
      log('updated to ' + manifest.version);
      return settled('applied');
    } catch (error) {
      if (error?.code === 'legacy_exposure_pending') {
        automaticFailure = 'legacy_exposure_pending';
        log('update: saved legacy exposure needs review');
        return 'failed';
      }
      log('update: ' + (error.message ?? error));
      if (['app_quitting','app_closing'].includes(error?.code)) return 'staged';
      return error?.code === 'no_key' ? settled('disabled') : 'failed';
    }
  }
  async function status() {const s=await readState().catch(()=>({}));return {checkedAt:s.checkedAt??null,candidate:s.candidate??null,notes:s.notes??[],notesUrl:s.notesUrl??null,unmanagedCoordinators:s.unmanagedCoordinators??[],warning:s.warning??null,automaticFailure};}
  return {check, stage, apply, tick, status, installDir, intervalMs, startDelayMs};
}

/**
 * The updater for a tarball install, or null for a checkout, a package install, or an opt-out. coordinatorHome names
 * the circle host this computer may run; without it the updater leaves hosting alone.
 */
export async function updaterForInstall({home, env = process.env, installDir = fileURLToPath(new URL('../..', import.meta.url)), platform=process.platform, managedContext, coordinatorHome, ...overrides} = {}) {
  if (env.FARAVAN_NO_UPDATE) return null;
  installDir = resolve(installDir); // a directory-shaped path ends in '/', which would miss the packaged-app suffix below
  if(platform==='darwin') {
    const suffix='/Contents/Resources/faravan';
    if(installDir.endsWith(suffix)) {
      const {createMacUpdaterForInstall}=await import('./macos-update-factory.mjs');
      const hosts=coordinatorHome?(await import('./hosted-coordinators.mjs')).createHostedCoordinators({home,coordinatorHome,installDir}):null;
      return createMacUpdaterForInstall({home,installDir,env,managedContext,hosts,...overrides});
    }
  }
  if (await readText(join(installDir, MARKER)) !== 'tarball') return null;
  const hosts = coordinatorHome ? (await import('./hosted-coordinators.mjs')).createHostedCoordinators({home, coordinatorHome, installDir}) : null;
  return createUpdater({installDir, stateFile: join(home, 'v1', 'update.json'), manifestUrl: updateFeedURL({earlyBuilds:await readEarlyBuilds(home),override:env.FARAVAN_UPDATE_URL}), hosts, ...overrides});
}

/**
 * Runs the updater on a timer. isIdle is asked fresh on every tick, and `exclusive` again after the download,
 * just before the swap: an update never lands under a running job, a waiting review or an unsettled claim.
 * onApplied runs once, after a tarball swap. A packaged-app updater instead
 * returns 'handoff': its owned helper must acknowledge readiness before the app
 * closes. That helper, not this process, owns the later swap and native launch.
 */
export function scheduleUpdates({updater, isIdle, exclusive, onApplied, onHandoff, admit=()=>{}, commit=fn=>{admit();return fn();}, run=fn=>fn(), setTimer = setTimeout, clearTimer = clearTimeout}) {
  let timer, stopped = false, running = false, preparing = null, work = null, applied = false, cancellationError = null;
  const cancellations=new Set();
  const cancel=ticket=>{
    if(typeof ticket?.cancel!=='function')return;
    const pending=Promise.resolve().then(()=>ticket.cancel());cancellations.add(pending);
    pending.then(()=>cancellations.delete(pending),error=>{cancellations.delete(pending);cancellationError??=error;});return pending;
  };
  const arm = delay => { if (!stopped) { timer = setTimer(step, delay); timer.unref?.(); } };
  async function step() {
    if (stopped || running) return;
    running = true;
    try {
      admit();
      if(applied){
        const idle=await (work=run(()=>isIdle()));
        if(stopped)return;
        admit();if(!idle){arm(updater.intervalMs);return;}
        await onApplied();stopped=true;return;
      }
      const idle = await (work=run(()=>isIdle()));
      if (stopped) return;
      admit();
      const outcome = await (work=run(()=>updater.tick({idle, exclusive, admit, commit})));
      if (stopped) return;
      if (outcome === 'applied') { applied=true;admit();await onApplied();stopped=true;return; }
      if (outcome === 'handoff') {
        if (stopped) return;
        if (typeof onHandoff !== 'function' || typeof updater.prepareHandoff !== 'function')
          throw new UpdateError('handoff_unavailable', 'This app cannot hand the update to its helper.');
        const controller = new AbortController(); preparing = controller;
        let ticket;
        try { admit();ticket = await (work=run(()=>updater.prepareHandoff({signal:controller.signal, exclusive}))); }
        finally { if (preparing === controller) preparing = null; }
        if (stopped || controller.signal.aborted) { await cancel(ticket); return; }
        if (ticket?.ready !== true || typeof ticket.cancel !== 'function') {
          await cancel(ticket);
          throw new UpdateError('handoff_unavailable', 'The update helper did not acknowledge readiness.');
        }
        try { await onHandoff(ticket); }
        catch (error) { await cancel(ticket); throw error; }
        stopped = true; return;
      }
    } catch { /* the next tick tries again */ } finally { running = false; }
    arm(updater.intervalMs);
  }
  arm(updater.startDelayMs);
  return {stop() { stopped = true; preparing?.abort(); clearTimer(timer); }, settled:async()=>{await Promise.resolve(work).then(()=>{},()=>{});while(cancellations.size)await Promise.allSettled([...cancellations]);if(cancellationError)throw cancellationError;}, step};
}

function bundledOrCurrent(installDir) {
  const bundled = join(installDir, 'runtime', 'bin', 'node');
  return existsSync(bundled) ? bundled : process.execPath;
}

/** Start the new tree's app after the old one has closed (and released its lock). */
export function relaunchApp(updater, {spawnProcess = spawn, env = process.env, runtime = null} = {}) {
  const child = spawnProcess(runtime ?? bundledOrCurrent(updater.installDir), [join(updater.installDir, 'bin', 'faravan'), 'app'],
    {detached: true, stdio: 'ignore', env: {...env, FARAVAN_NO_BROWSER: '1'}});
  child.unref?.();
}

/**
 * `faravan update [--check]`. A running app updates itself between jobs, so a manual
 * apply only happens when no app is running; --check never changes anything.
 */
export async function runUpdateCommand(argv, {updater, appRunning, stdout = process.stdout, stderr = process.stderr, platform=process.platform}) {
  const check = argv.includes('--check');
  if (argv.some(a => a !== '--check')) { stderr.write('Usage: faravan update [--check]\n'); return 2; }
  if (!updater) {
    stdout.write(platform==='darwin'?'This Faravan installation cannot update automatically.\n':'This install does not update itself. A package install updates with apt (sudo apt upgrade).\n');
    return 0;
  }
  const printWarning = async () => { try { const warning = (await updater.status?.())?.warning; if (warning) stderr.write(warning + '\n'); } catch {} };
  try {
    const {current, manifest} = await updater.check();
    if (!manifest) { stdout.write('Faravan ' + current + ' is up to date.\n'); return 0; }
    if (check) { stdout.write('Faravan ' + manifest.version + ' is available (you have ' + current + ').'+(updater.kind==='packaged-mac'?' Open Faravan to update between jobs.':' Run: faravan update')+'\n'); return 0; }
    if (updater.kind==='packaged-mac') {
      stdout.write('Faravan '+manifest.version+' is available. Open Faravan to update between jobs.\n');
      return 0;
    }
    if (await appRunning()) {
      stdout.write('Faravan ' + manifest.version + ' is available. Faravan is running, so it will update itself between jobs.\n');
      return 0;
    }
    await updater.stage(manifest);
    await updater.apply(manifest);
    await printWarning();
    stdout.write('Updated Faravan from ' + current + ' to ' + manifest.version + '.\n');
    return 0;
  } catch (error) {
    await printWarning();
    stderr.write('faravan: ' + (error?.name === 'FaravanUpdateError' ? error.message : 'Could not update Faravan.') + '\n');
    return 1;
  }
}
