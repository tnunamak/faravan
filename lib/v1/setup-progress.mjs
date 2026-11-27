import {durableJsonAsync} from '../durable-write.mjs';
// Setup that has to survive a restart or a log-out (D8). Two steps need one: turning on the Windows
// Hypervisor Platform (a restart) and joining the Linux `kvm` group (a new login). The app saves which
// step the person is on; when the computer comes back, the app says so and the setup screen resumes at that
// exact step (`setup.win-resume`). Everything that touches the machine is injected.
import {readFile, rm} from 'node:fs/promises';

export const STEPS = Object.freeze({
  hypervisor: {reason: 'restart', check: 'hypervisor_platform'},
  kvm: {reason: 'logout', check: 'kvm_access'},
});

/** A value that changes when the computer restarts. Null when it cannot be read: the step then stays "waiting" until its check passes. */
export async function readBootId({platform = process.platform, readFileImpl = readFile, run} = {}) {
  try {
    if (platform === 'linux') return (await readFileImpl('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null;
    if (platform === 'darwin') return (await run('sysctl', ['-n', 'kern.boottime']))?.trim() || null;
    if (platform === 'win32') return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString("o")']))?.trim() || null;
  } catch { /* unknown boot: see above */ }
  return null;
}

/**
 * file: where progress lives. instance: an id for this run of the app (a log-out ends the run, so a new
 * one means a new session). bootId: async () => value that changes at restart.
 */
export function createSetupProgress({file, instance, bootId = async () => null, now = Date.now}) {
  async function load() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      return STEPS[value?.step] && value.reason === STEPS[value.step].reason && Number.isFinite(value.markedAt) ? value : null;
    } catch { return null; }
  }
  async function save(value) {
    await durableJsonAsync(file,value);
  }
  return {
    /** The person is on this step and has to restart or log out. */
    async mark(step) {
      if (!STEPS[step]) { const error = new Error('invalid_request'); error.code = 'invalid_request'; throw error; }
      const record = {step, reason: STEPS[step].reason, markedAt: now(), boot: await bootId(), instance};
      await save(record);
      return record;
    },
    async clear() { await rm(file, {force: true}); },
    /** null, or {step, reason, state: 'waiting' | 'returned', since}. */
    async view() {
      const record = await load();
      if (!record) return null;
      const restarted = record.reason === 'restart' && record.boot !== null && (await bootId()) !== null && (await bootId()) !== record.boot;
      const relogged = record.reason === 'logout' && record.instance !== instance;
      return {step: record.step, reason: record.reason, state: restarted || relogged ? 'returned' : 'waiting', since: new Date(record.markedAt).toISOString()};
    },
    /** Drop the saved step once its own check passes: nothing is left to resume. Returns true when it did. */
    async reconcile(checks) {
      const record = await load();
      if (!record) return false;
      const check = (checks ?? []).find(c => c.name === STEPS[record.step].check);
      if (check?.ok === true) { await rm(file, {force: true}); return true; }
      return false;
    },
  };
}
