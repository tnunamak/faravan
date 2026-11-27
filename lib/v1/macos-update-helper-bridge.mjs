// Internal bridge only: the copied entrypoint must implement the IPC protocol
// and perform the transaction after parent disconnect. This module does neither.
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {durableJsonAsync} from '../durable-write.mjs';

const protocol = 'faravan-mac-update-helper-v1';
const controlName = '.handoff-control.json';
const error = (code, message) => Object.assign(new Error(message), {code});
const inside = (root, path) => path !== root && !relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path));
const safeRelative = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
  !path.split('/').some(part => !part || part === '.' || part === '..') && !path.includes('\\');

// Source paths and destinations are an explicit trusted internal manifest, never
// values taken from an update manifest or an API request.
export async function prepareMacUpdateHelper({appPath, sourceRoot, capsuleRoot, files, runtime, entrypoint, spec,
  signal, exclusive, timeoutMs = 10000, cancelTimeoutMs = 5000, spawnProcess = spawn, env = process.env,
  timers = {setTimeout, clearTimeout}} = {}) {
  if (typeof exclusive !== 'function' || !Array.isArray(files) || files.length < 2 || files.length > 64 ||
      !safeRelative(runtime) || !safeRelative(entrypoint) || runtime === entrypoint ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs <= 0)
    throw error('invalid_manifest', 'Invalid helper manifest');
  const destinations = new Set();
  for (const item of files) {
    if (!item || !safeRelative(item.source) || !safeRelative(item.destination) || (item.executable!==undefined && typeof item.executable!=='boolean') || item.destination === controlName || destinations.has(item.destination))
      throw error('invalid_manifest', 'Invalid or duplicate helper file');
    destinations.add(item.destination);
  }
  if (!destinations.has(runtime) || !destinations.has(entrypoint)) throw error('invalid_manifest', 'Runtime or entrypoint missing');
  if (!isAbsolute(appPath ?? '') || resolve(appPath) !== appPath || !appPath.endsWith('.app') || !isAbsolute(sourceRoot ?? '') || resolve(sourceRoot) !== sourceRoot || !isAbsolute(capsuleRoot ?? '') || resolve(capsuleRoot) !== capsuleRoot)
    throw error('invalid_path', 'Helper roots must be absolute canonical paths');
  const uid = process.getuid?.();
  async function owned(path, directory) {
    const st = await lstat(path);
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) ||
        (uid !== undefined && st.uid !== uid) || (!directory && st.nlink !== 1))
      throw error('invalid_path', 'Helper input is not an owned regular path');
    return st;
  }
  async function sourceFile(name) {
    const parts = name.split('/'); let path = sourceRoot;
    for (let i = 0; i < parts.length; i++) { path = join(path, parts[i]); await owned(path, i < parts.length - 1); }
    if (!inside(sourceRoot, path) || await realpath(path) !== path) throw error('invalid_path', 'Helper source escapes its root');
    return path;
  }
  signal?.throwIfAborted();
  const release = await exclusive();
  if (release === null) throw error('busy', 'The app is not idle');
  if (typeof release !== 'function') throw error('invalid_exclusion', 'The app did not provide an exclusion release');
  let releasePromise, capsule, child, exited = false, exitPromise, cancellation, nonce, controlPath;
  const releaseOnce = () => releasePromise ??= Promise.resolve().then(release);
  const cleanup = async () => { if (capsule && (!child || exited)) { await rm(capsule, {recursive:true, force:true}); capsule = null; } };
  try {
    signal?.throwIfAborted();
    await owned(appPath, true); await owned(sourceRoot, true); await owned(capsuleRoot, true);
    if (await realpath(appPath) !== appPath || !(sourceRoot === appPath || inside(appPath, sourceRoot)) ||
        capsuleRoot === appPath || inside(appPath, capsuleRoot) || await realpath(sourceRoot) !== sourceRoot || await realpath(capsuleRoot) !== capsuleRoot ||
        inside(sourceRoot, capsuleRoot) || sourceRoot === capsuleRoot)
      throw error('invalid_path', 'Helper capsule must be outside the source root');
    const rootStat = await lstat(capsuleRoot);
    if ((rootStat.mode & 0o077) !== 0) throw error('invalid_path', 'Helper capsule root is not private');
    capsule = await mkdtemp(join(capsuleRoot, 'mac-update-')); await chmod(capsule, 0o700);
    for (const item of files) {
      signal?.throwIfAborted();
      const src = await sourceFile(item.source), target = join(capsule, item.destination);
      if (!inside(capsule, target)) throw error('invalid_path', 'Invalid helper destination');
      await mkdir(dirname(target), {recursive:true, mode:0o700});
      // Open with NOFOLLOW and copy from the held descriptor, so replacing the
      // final source with a symlink cannot redirect the copy.
      const fd = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await fd.stat();
        if (!st.isFile() || (uid !== undefined && st.uid !== uid) || st.nlink !== 1)
          throw error('invalid_path', 'Helper input changed during copy');
        const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.destination === runtime || item.executable === true ? 0o700 : 0o600);
        try { await out.writeFile(await fd.readFile()); await out.sync(); } finally { await out.close(); }
      } finally { await fd.close(); }
    }
    signal?.throwIfAborted();
    nonce = randomBytes(32).toString('hex');
    controlPath = join(capsule, controlName);
    await durableJsonAsync(controlPath, {protocol, nonce, state:'prepared'});
    child = spawnProcess(join(capsule, runtime), [join(capsule, entrypoint)],
      {detached:true, stdio:['ignore','ignore','ignore','ipc'], env:{...env}});
    let exitResolve;
    exitPromise = new Promise(resolveExit => { exitResolve = resolveExit; });
    child.once('exit', (code, childSignal) => { exited = true; exitResolve({code, signal:childSignal}); });
    child.once('error', () => { if (!child.pid) { exited = true; exitResolve({spawnError:true}); } });
    const cancel = () => cancellation ??= (async () => {
      // Revoke before restoring admission, even if an unresponsive child cannot
      // acknowledge the message. The runner must check this record before acting
      // on parent disconnect; losing IPC alone never restores cancelled authority.
      if (!exited) await durableJsonAsync(controlPath, {protocol, nonce, state:'cancelled'});
      if (!exited && child.connected) {
        try { child.send({protocol, type:'cancel', nonce}, () => {}); } catch { /* await owned child's exit */ }
      }
      let timer;
      const result = await Promise.race([exitPromise, new Promise(resolveTimeout => { timer = timers.setTimeout(() => resolveTimeout(null), cancelTimeoutMs); })]);
      timers.clearTimeout(timer);
      await releaseOnce();
      if (!result) throw error('ownership_unknown', 'Helper did not confirm cessation; capsule retained');
      await cleanup();
    })();
    const abortAfterReady = () => { cancel().catch(() => {}); };
    const ready = await new Promise((resolveReady, reject) => {
      let settled = false;
      const finish = (failure) => {
        if (settled) return; settled = true; timers.clearTimeout(timer);
        child.removeListener('message', onMessage); child.removeListener('error', onError); child.removeListener('disconnect', onDisconnect);
        signal?.removeEventListener('abort', onAbort);
        failure ? reject(failure) : resolveReady(true);
      };
      const onMessage = message => { if (message?.protocol === protocol && message.type === 'ready' && message.nonce === nonce) finish(); };
      const onError = () => finish(error('helper_start_failed', 'Helper could not start'));
      const onAbort = () => finish(error('aborted', 'Helper preparation was cancelled'));
      const onDisconnect = () => finish(error('helper_disconnected', 'Helper disconnected before readiness'));
      const timer = timers.setTimeout(() => finish(error('helper_timeout', 'Helper did not acknowledge readiness')), timeoutMs);
      child.on('message', onMessage); child.once('error', onError); child.once('disconnect', onDisconnect); signal?.addEventListener('abort', onAbort, {once:true});
      exitPromise.then(() => finish(error('helper_exited', 'Helper exited before readiness')));
      if (signal?.aborted) return onAbort();
      try { child.send({protocol, type:'prepare', nonce, controlPath, spec}, err => { if (err) onError(); }); } catch { onError(); }
    });
    signal?.addEventListener('abort', abortAfterReady, {once:true});
    if (signal?.aborted || exited) { await cancel(); throw error(signal?.aborted ? 'aborted' : 'helper_exited', 'Helper stopped before handoff'); }
    // An unexpected exit after readiness must release admission and clean up;
    // after parent exit the child owns the capsule and sees IPC disconnect.
    exitPromise.then(async () => {
      signal?.removeEventListener('abort', abortAfterReady);
      // Cancellation owns cleanup while its durable revocation is being written.
      if (!cancellation) { await releaseOnce(); await cleanup(); }
    }).catch(() => {});
    child.unref(); child.channel?.unref();
    return {get ready() { return ready && !exited && child.connected && !signal?.aborted; }, cancel};
  } catch (failure) {
    if (child && !exited) {
      await durableJsonAsync(controlPath, {protocol, nonce, state:'cancelled'});
      // The helper only receives cancellation over its owned channel; never kill by PID.
      try { if (child.connected) child.send({protocol, type:'cancel', nonce}, () => {}); } catch {}
      let timer;
      const result = await Promise.race([exitPromise, new Promise(r => { timer = timers.setTimeout(() => r(null), cancelTimeoutMs); })]);
      timers.clearTimeout(timer); await releaseOnce();
      if (!result) throw error('ownership_unknown', 'Helper did not confirm cessation; capsule retained');
    }
    await releaseOnce(); await cleanup(); throw failure;
  }
}
