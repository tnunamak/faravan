// H2: while this computer hosts a circle and is on power, hold an idle-sleep assertion, so friends can reach it.
// Linux: `systemd-inhibit` around a foreground stdin reader owned by the host's sole writer. macOS: `caffeinate -i -w <pid>`.
// Nothing here is a promise about the lid or the battery: on battery, or when the person switches it off, the
// assertion is released and the computer sleeps as it normally would. A sleep that happened anyway shows up as a
// gap between ticks, which the host page reports as "the computer was asleep".
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// The inhibitor can own a shell and its sleep child. Stop their private group, and wait for
// all of it to leave before a graceful host shutdown reports completion.
async function stopHelper(child) {
  // No data is written. Destroy synchronously, including the process-exit fallback.
  child.stdin?.destroy();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) { child.kill('SIGTERM'); return; }
  const signal = value => { try { process.kill(-child.pid, value); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  if (!signal('SIGTERM')) return;
  const started = performance.now();
  let forced = false;
  while (signal(0)) {
    const elapsed = performance.now() - started;
    if (elapsed > 2000) throw new Error('The keep-awake helper did not stop.');
    if (!forced && elapsed > 1000) { signal('SIGKILL'); forced = true; }
    await delay(10);
  }
}

/** true on power, false on battery, null when it cannot tell (a desktop has no battery: treated as on power). */
export function readPower({ platform = process.platform, run = null, powerSupplyDir = '/sys/class/power_supply' } = {}) {
  if (platform === 'linux') {
    try {
      const rows = fs.readdirSync(powerSupplyDir).map(name => {
        const read = file => { try { return fs.readFileSync(`${powerSupplyDir}/${name}/${file}`, 'utf8').trim(); } catch { return null; } };
        return { type: read('type'), online: read('online') };
      });
      const mains = rows.filter(row => row.type === 'Mains' || row.type === 'USB');
      if (mains.some(row => row.online === '1')) return true;
      if (rows.some(row => !row.type)) return null;
      if (mains.length) return mains.every(row => row.online === '0') ? false : null;
      return rows.some(row => row.type === 'Battery') ? null : true; // no mains entry and no battery: a desktop
    } catch { return null; }
  }
  if (platform === 'darwin' && typeof run === 'function') {
    try { const out = String(run('pmset', ['-g', 'batt'])); return /AC Power/i.test(out) ? true : /Battery Power/i.test(out) ? false : null; } catch { return null; }
  }
  return null;
}

export function inhibitorCommand(platform, pid) {
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(pid)]];
  if (platform === 'linux') return ['systemd-inhibit', ['--what=idle:sleep', '--who=Faravan', '--why=Hosting a Faravan circle', '--mode=block',
    'sh', '-c', 'while IFS= read -r line; do :; done']];
  return null;
}

/**
 * @param enabled   () => boolean: the person's switch (on by default)
 * @param power     () => true|false|null
 * @returns {tick(), state(), stop()}; stop() resolves when the helper group is gone.
 * tick() is called every few seconds by the host process.
 */
export function createKeepAwake({ platform = process.platform, pid = process.pid, spawn = nodeSpawn, enabled = () => true, power = () => readPower({ platform, run: (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 3000 }) }),
  now = Date.now, tickMs = 5000, wakeGapMs = 30000 } = {}) {
  let child = null, since = null, lastTick = now(), lastWake = null, unsupported = false;
  let stopping = null, stopFailure = null, sealed = false, terminalStop = null;
  const stopChild = () => {
    if (stopping) return stopping;
    if (!child) return Promise.resolve();
    const stopped = child;
    // Publish the pending fence before invoking kill, which may emit exit synchronously.
    let resolveStop;
    const stoppedGroup = new Promise(resolve => { resolveStop = resolve; });
    stopping = stoppedGroup.then(() => {
      if (child === stopped) { child = null; since = null; }
      stopping = null;
    }, error => {
      stopFailure = error;
      // Retain the child and rejected promise: release has not been confirmed.
      throw error;
    });
    void stopping.catch(() => {});
    // Signal immediately as well: the process-exit fallback cannot run later microtasks.
    resolveStop(stopHelper(stopped));
    return stopping;
  };
  const stop = () => {
    sealed = true; // Seal admission synchronously, including already queued ticks.
    terminalStop ??= stopChild();
    return terminalStop;
  };
  const reason = () => {
    if (stopFailure) return 'stop_failed';
    if (stopping) return 'stopping';
    if (sealed) return 'stopped';
    if (unsupported) return 'unsupported';
    if (!enabled()) return 'off_by_choice';
    const powered = power();
    if (powered === false) return 'on_battery';
    if (powered !== true) return 'power_unknown';
    return child ? 'on' : 'starting';
  };
  function tick() {
    const at = now();
    // The timer is paused while the computer sleeps: a long gap since the last tick is a sleep, however long it lasted.
    if (at - lastTick > wakeGapMs) lastWake = { at: new Date(at).toISOString(), gap_seconds: Math.round((at - lastTick) / 1000) };
    lastTick = at;
    if (sealed || stopping || stopFailure) return;
    const want = enabled() && power() === true && !unsupported;
    if (!want) { stopChild(); return; }
    if (child) return;
    const command = inhibitorCommand(platform, pid);
    if (!command) { unsupported = true; return; }
    try {
      // Standard stdin survives the inhibitor -> watched-command boundary. Only this
      // coordinator owns the write end; neither child nor shell inherits a writer.
      const started = spawn(command[0], command[1], {
        stdio: platform === 'linux' ? ['pipe', 'ignore', 'ignore'] : 'ignore', detached: true,
      });
      child = started; since = new Date(at).toISOString();
      started.once?.('error', () => {
        started.stdin?.destroy();
        if (child !== started) return;
        unsupported = true;
        if (Number.isSafeInteger(started.pid) && started.pid > 0) stopChild();
        else { child = null; since = null; }
      });
      started.once?.('exit', () => {
        started.stdin?.destroy();
        if (child === started) stopChild();
      });
      started.unref?.();
      if (platform === 'linux') {
        const writer = started.stdin;
        if (!writer || writer.destroyed || typeof writer.destroy !== 'function' || typeof writer.unref !== 'function') {
          unsupported = true;
          stopChild(); // No PID-only fallback, even when pipe creation is unavailable.
          return;
        }
        writer.once('error', () => {
          if (child === started) { unsupported = true; stopChild(); }
        });
        writer.unref(); // Keeping the assertion must not keep the coordinator alive.
      }
      if (sealed) stopChild(); // An injected spawn can synchronously reenter stop().
    } catch {
      unsupported = true;
      if (child) stopChild();
    }
  }
  return { tick, stop, tickMs,
    state: () => ({ enabled: enabled(), active: child !== null, reason: reason(), since, last_wake: lastWake }) };
}
