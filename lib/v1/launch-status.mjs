// Startup diagnostics shared by the launcher and ordinary status readers.
// Keep this module independent of app startup and provider credentials.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const START_FAILURE_REASONS = Object.freeze({
  launch_lock_held: 'Another Faravan process is still starting or stopping.',
  app_unavailable: 'The Faravan app did not answer.',
  app_start_failed: 'Faravan could not finish starting.',
  sandbox_start_failed: 'The protected workspace could not start.',
  sandbox_ready_timeout: 'The protected workspace did not become ready in time.',
  sandbox_credential_store_failed: 'Faravan could not prepare sign-in for the protected workspace.',
  cessation_unverified: 'Faravan could not confirm that the earlier protected workspace stopped.',
  policy_unenforceable: 'The protected workspace could not apply the required safety settings.',
  host_disk_low: 'This computer does not have enough free disk space to start Faravan.',
  host_disk_unreadable: 'Faravan could not check the free disk space on this computer.',
  wall_timeout: 'Faravan took too long to start.',
});

export function launchFailure(error) {
  let kind = 'Error', code = 'app_start_failed';
  try {
    if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError'].includes(error?.name)) kind = error.name;
    if (typeof error?.code === 'string' && Object.hasOwn(START_FAILURE_REASONS, error.code)) code = error.code;
  } catch {}
  return {code, kind};
}

function safeFailureRecord(row) {
  if (row?.version !== 1 || typeof row.code !== 'string' || !Object.hasOwn(START_FAILURE_REASONS, row.code) ||
      !Number.isSafeInteger(row.at) || row.at < 0) return null;
  return {version: 1, ...launchFailure({code: row.code, name: row.kind}), at: row.at};
}

export function readLaunchFailure(home) {
  try { return safeFailureRecord(JSON.parse(readFileSync(join(home, 'v1', 'start-failure.json'), 'utf8'))); }
  catch { return null; }
}

/** The same summary shape as a live lending status, using fixed words only. */
export function launchFailureSummary(failure) {
  const row = safeFailureRecord(failure);
  if (!row) return null;
  return {phase: 'waiting', kind: 'hold', headline: 'Faravan could not start', label: 'Needs attention',
    reason: START_FAILURE_REASONS[row.code], action: null};
}

/** Preserve the ordinary status schema; a saved failure is extra offline evidence, never a live override. */
export function applyLaunchFailureStatus(lending, failure, {liveApp = lending?.app_running === true} = {}) {
  const row = safeFailureRecord(failure);
  if (liveApp || !row) return lending;
  const summary = launchFailureSummary(row);
  return {...lending, status: summary.headline, summary, start_failure: row,
    ...(Object.hasOwn(lending, 'read_error') ? {read_error: 'The app did not answer.'} : {})};
}
