// Local fallbacks for operations that must not start the app they inspect or quit.
// Keep these reads independent of app startup and provider credentials.
import {readFileSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {readLaunchFailure, launchFailureSummary} from '../launch-status.mjs';
import {setResidentQuit} from '../resident-intent.mjs';

/** The normal status.get operation schema, with saved failure evidence inside lending. */
export function offlineOperationStatus(home, {unreachable = false} = {}) {
  const failure = readLaunchFailure(home);
  if (!failure) return null;
  const summary = launchFailureSummary(failure);
  const unknown = unreachable || !appIsAbsent(home);
  return {summary, headline:summary.headline,
    blockers:[{kind:'app_start_failed', message:summary.reason}],
    lending:{app_running:unknown ? null : false, enabled:unknown ? null : false, start_failure:failure}};
}

function appIsAbsent(home) {
  const file = join(home, 'v1', 'app.json');
  let record;
  try {
    const entry = lstatSync(file);
    if (!entry.isFile()) return false;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return false; }
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  if (record !== undefined) {
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return false;
    try { process.kill(record.pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return true;
}

/** Called only after operation input/confirmation checks and failed app discovery.
 * A live or unverified app must accept its authenticated shutdown itself. A failed
 * request is not proof of absence and must never bypass a running job's refusal.
 */
export function quitOfflineApp(home, {signal} = {}) {
  if (signal?.aborted || !appIsAbsent(home)) return false;
  if (signal?.aborted) return false;
  setResidentQuit(true, home);
  return true;
}
