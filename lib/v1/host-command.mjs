import { opError } from './ops/errors.mjs';

/** A refusal that carries a reason code arrives as one `host_error` JSON line. Other failures carry no code. */
export function hostRefusalFromLine(line) {
  if (!line.includes('"type":"host_error"')) return null;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  return typeof parsed?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(parsed.code)
    ? {code: parsed.code, message: String(parsed.message ?? '')} : null;
}

// `faravan host` owns hosting (tunnels, the coordinator service, prompts). The operation runs it without a terminal
// and waits for its one JSON line. A source-checkout host keeps running in the background, logging beside its config.
export async function hostCommand(ctx, args, type, {launchId} = {}) {
  const {coordinatorHome} = await import('../host.mjs');
  const {dirname, join} = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'faravan');
  let dir = ctx.coordinatorHome;
  // Two committed homes for this app's circles: refuse, naming both, rather than pick one (lib/host.mjs).
  try { dir ??= coordinatorHome(ctx.home ? {appHome: ctx.home} : {}); }
  catch (error) { throw error.code === 'host_home_conflict' ? opError(error.code, 409, error.message) : error; }
  return spawnHostOperation({dir, home: ctx.home, bin, runtime: process.execPath, args, type, launchId, spawnProcess: ctx.spawnProcess});
}

/**
 * Starts the circle host from the install at installDir, with that install's bin and runtime, so the coordinator it
 * starts runs from that install. Resolves with the host_ready result, once the coordinator can serve. A failed start reports whether its owned coordinator cleanup could be verified (see stopLaunch).
 */
export async function startHostFromInstall({installDir, runtime, home, coordinatorHome: dir, args = [], launchId, spawnProcess, timeoutMs, stopWaitMs, now, sleep}) {
  const {join} = await import('node:path');
  return spawnHostOperation({dir, home, bin: join(installDir, 'bin', 'faravan'), runtime, args, type: 'host_ready', launchId, spawnProcess, timeoutMs, stopWaitMs, now, sleep});
}

export async function spawnHostOperation({dir, home, bin, runtime, args, type, launchId, spawnProcess, timeoutMs = 120000, stopWaitMs = 15000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const approved = launchId !== undefined;
  if (approved && (type !== 'host_ready' || typeof launchId !== 'string' || launchId.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(launchId)))
    throw Object.assign(new Error('Invalid host launch approval'), {code:'invalid_launch_id', status:400});
  const {spawn} = await import('node:child_process');
  const {openSync, closeSync, readFileSync, mkdirSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {randomUUID} = await import('node:crypto');
  mkdirSync(dir, {recursive:true, mode:0o700});
  const token = randomUUID();
  const out = join(dir, 'host-op-' + token + '.out'), err = join(dir, 'host-op.log');
  const output=openSync(out,'w',0o600),errors=openSync(err,'a',0o600);
  let child;
  try {child = (spawnProcess ?? spawn)(runtime, [bin, 'host', ...args, '--json', ...(approved ? ['--approved-launch-stdin'] : [])], {detached:true,
    stdio:[approved ? 'pipe' : 'ignore', output, errors], env:{...process.env, FARAVAN_HOST_LAUNCH_TOKEN:token, ...(home ? {FARAVAN_HOME:home} : {}), FARAVAN_COORDINATOR_HOME:dir, FARAVAN_NO_BROWSER:'1'}});}
  finally {closeSync(output);closeSync(errors);}
  const launch = {exited: false, neverStarted: false, spawnError:null};
  child.once('exit', () => { launch.exited = true; });
  // A launch that never started has no pid and emits only 'error'. For a live child, 'error' means a signal failed, not an exit.
  child.on('error', error => { if (child.pid === undefined) { launch.exited = true; launch.neverStarted = true; launch.spawnError=error; } });
  child.unref();
  let refused = false;
  let written = !approved, pipeError;
  const failPipe = error => {
    // Keep stable I/O failure codes, never arbitrary child or stream text.
    const code = ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE',
      'ERR_STREAM_WRITE_AFTER_END', 'ENOTCONN', 'EIO', 'ECONNRESET'].includes(error?.code)
      ? error.code : 'host_launch_input_failed';
    pipeError ??= Object.assign(new Error('Could not send host launch approval'), {code, status:409});
  };
  // The expected result beats a refusal. A refusal is thrown with its own code.
  const scan = (allowResult = true) => {
    const lines = readFileSync(out, 'utf8').split('\n');
    const safeLines = approved ? lines.map(l => l.replaceAll(launchId, '[redacted]')) : lines;
    const line = safeLines.find(l => l.includes('"type":"' + type + '"'));
    if (allowResult && line) { const {schema_version:_v, type:_t, ...result} = JSON.parse(line); return {result}; }
    const refusal = safeLines.map(hostRefusalFromLine).find(Boolean);
    if (refusal) {
      refused = true;
      // A stop that left hosting running names the program still serving the circle, so its message crosses the local API.
      if (refusal.code === 'host_still_running') throw opError(refusal.code, 409, refusal.message);
      throw Object.assign(new Error(refusal.message), {code:refusal.code, status:409});
    }
    return null;
  };
  try {
    if (approved) {
      if (!child.stdin) throw Object.assign(new Error('Host launch approval pipe is unavailable'), {code:'host_launch_input_failed', status:409});
      child.stdin.on('error', failPipe);
      try { child.stdin.end(launchId, error => { if (error) failPipe(error); else written = true; }); }
      catch (error) { failPipe(error); }
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const exited = launch.exited; // read before the scan, so output written before the exit is not missed
      const found = written || exited || pipeError ? scan(written && !pipeError) : null;
      if (pipeError) throw pipeError;
      if (found) return found.result;
      if (exited) throw Object.assign(new Error('faravan host failed; see ' + err), {code:launch.spawnError?.code??'host_failed', status:409});
      await sleep(200);
    }
    // Output written after the last read, before the deadline, still counts.
    const exited = launch.exited;
    const late = scan(written && !pipeError);
    if (pipeError) throw pipeError;
    if (late) return late.result;
    if (exited) throw Object.assign(new Error('faravan host failed; see ' + err), {code:launch.spawnError?.code??'host_failed', status:409});
    throw Object.assign(new Error('faravan host did not get ready in time; see ' + err), {code:'timeout', status:504});
  } catch (error) {
    if (approved && !written) child.stdin?.destroy();
    try {
      await stopLaunch(child, launch, stopWaitMs, error, () => readFileSync(out, 'utf8').split('\n').some(line => {
        try { const ack = JSON.parse(line); return ack.type === 'host_launch_stopped' && ack.token === token; } catch { return false; }
      }), type === 'host_ready');
    } catch (cleanup) {
      // A refusal keeps its reason for the owner. Its unverified cleanup goes with it, so an updater still treats it as unverified.
      if (refused && cleanup.code === 'launcher_unverified') throw Object.assign(error, {cleanup_verified: false});
      throw cleanup;
    }
    throw error;
  }
}

/**
 * Only a token-bound acknowledgement after owned coordinator cleanup proves a TERM exit safe.
 * KILL never proves cleanup, even if an acknowledgement was racing it. Never signal a PID/file or group.
 */
async function stopLaunch(child, launch, waitMs, cause, acknowledged, ownsCoordinator = true) {
  let killed = false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (launch.exited) break;
    if (signal === 'SIGKILL') killed = true;
    try { child.kill(signal); } catch { /* the wait below decides whether it exited */ }
    if (await untilExited(launch, waitMs)) break;
  }
  if (!launch.exited)
    throw Object.assign(new Error('a faravan host launch did not exit after it was stopped, so it may still be running'), {code:'launcher_running', status:409, cause});
  // A command that only stops hosting starts no coordinator, so it has no cleanup to prove. Its own failure is the answer; a
  // missing launcher acknowledgement would replace that failure with a false claim about a launcher.
  if (!ownsCoordinator) return;
  let verified = false;
  try { verified = acknowledged(); } catch { /* unreadable proof is not proof */ }
  if (launch.neverStarted || (!killed && verified)) return;
  throw Object.assign(new Error('the host launcher exited without verified coordinator cleanup; leave the new install in place'), {code:'launcher_unverified', status:409, cause});
}

async function untilExited(launch, ms) {
  const deadline = Date.now() + ms;
  while (!launch.exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return launch.exited;
}
