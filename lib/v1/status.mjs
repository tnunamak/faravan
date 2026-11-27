import {sandboxRemediationLines} from '../sandbox-remediation.mjs';
// `faravan status`: this device, its circles, lending state and recent jobs.
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parse, statusLabel, waitingLine, problemForError, problemText, exitCodeForError } from './cli.mjs';
import { configHome } from '../local-state.mjs';
import { openDevice } from './device.mjs';
import { shortId } from './job-id.mjs';
import { readDiskReport, withFreeReading, diskLines } from '../disk-report.mjs';
import {readLaunchFailure, launchFailureSummary, applyLaunchFailureStatus} from './launch-status.mjs';

// Free space on the drive that holds the sandbox store; null when it cannot be read.
const defaultStoreFree = async () => { try { return await (await import('../docker-backend.mjs')).storeFreeBytes(); } catch { return null; } };

import {probeFailureCopy} from './lending-status-copy.mjs';

const RECENT_JOBS = 5;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

const isLendingStatus = body => body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.enabled === 'boolean';
async function readApp(path, home, fetchImpl, validate = () => true) {
  const unreadable = reason => ({unreadable: true, reason});
  let record;
  try { record = JSON.parse(await readFile(join(home, 'v1', 'app.json'), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : unreadable('could not read the app record: ' + error.message); }
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.token !== 'string' || !record.token) return unreadable('the app record is malformed');
  if (!alive(record.pid)) return null;
  try {
    const response = await fetchImpl('http://127.0.0.1:' + record.port + path, {
      headers: {'x-faravan-session-token': record.token}, signal: AbortSignal.timeout(2000), redirect: 'error'});
    if (!response.ok) return unreadable('the app answered with HTTP ' + response.status);
    const body = await response.json();
    return validate(body) ? body : unreadable('the app answered without a lending status');
  } catch (error) { return unreadable('the app did not answer: ' + (error?.message || error?.name || 'unknown error')); }
}
export const readLending = (home, fetchImpl = globalThis.fetch) => readApp('/api/lending', home, fetchImpl, isLendingStatus);
/** The one lending answer the app, the CLI and the MCP status tool share: {phase, headline, reason, action}, or null. */
export async function readSummary(home, fetchImpl = globalThis.fetch) {
  const status = await readApp('/api/status', home, fetchImpl);
  if (status && !status.unreadable) return status.summary ?? null;
  const failure = readLaunchFailure(home);
  if (!failure) return null;
  const lending = await readLending(home, fetchImpl);
  return lending && !lending.unreadable ? null : launchFailureSummary(failure);
}
const nextStep = action => action ? 'Next:        ' + action.label + ' (' + action.op + ')' : null;
export function lendingLabel(lending) {
  if (!lending) return 'Not running';
  if (lending.unreadable) return 'Could not read lending status: ' + lending.reason;
  // Off and Pause both disable admission; the saved owner intent distinguishes them.
  if (lending.intent === 'off') return 'Lending off';
  if (lending.intent === 'on') {
    if (Number.isFinite(lending.pause_until) && lending.pause_until > Date.now())
      return 'Paused until ' + new Date(lending.pause_until).toISOString();
    if (lending.paused) return 'Paused until resumed';
    if (!lending.enabled) return 'Lending on · finish setup before jobs can start';
  }
  // Preserve the legacy contract for older daemons without the intent field.
  if (lending.status === 'awaiting-approval') return lending.enabled ? 'Waiting for review' : 'Lending off';
  if (lending.current) return 'Running a job';
  if (Number.isFinite(lending.pause_until) && lending.pause_until > Date.now())
    return 'Paused until ' + new Date(lending.pause_until).toISOString();
  if (lending.paused) return 'Paused until resumed';
  if (!lending.enabled) return 'Lending off';
  return 'Lending on';
}
/** The lending copy the app shows, from the same status read (/api/lending): the dial, each account's line, its basis and the explainer. */
export function lendingStatusLines(lending) {
  const lines = lending && !lending.enabled && lending.status === 'awaiting-approval' ? ['Review:      Waiting for review'] : [];
  if (lending?.current && lending.status !== 'awaiting-approval') lines.push('Execution:   Running a job');
  lines.push(...sandboxRemediationLines(lending?.remediation));
  const objective = lending?.objective;
  if (!objective) return lines;
  const accounts = (objective.accounts ?? []).filter(account => account.decision?.status);
  if (objective.dial) lines.push('Dial:        ' + objective.dial.label + '. ' + objective.dial.description);
  for (const account of accounts) {
    const status = account.decision.status;
    lines.push('  ' + account.label.padEnd(8) + status.line);
    const history = account.decision.lastJobStatus;
    if (history?.line && status.id !== 'last_job_held' && history.line !== status.line) lines.push('           ' + history.line);
    const failure = probeFailureCopy(account.probe_outcome);
    if (failure) lines.push('           ' + failure.line);
    if (status.basis) lines.push('           ' + status.basis.line);
    if (status.statement) lines.push('           Starting assumption: ' + status.statement);
  }
  if (accounts.some(account => account.decision.status.explainer)) {
    lines.push(objective.dial.explainer, objective.dial.limit.sentence, objective.dial.limit.adjacent);
  }
  return lines;
}
async function recentJobs(d, circle) {
  const views = [], client = await d.client(circle.id);
  for await (const view of client.listJobs({})) views.push(view);
  let presence;
  if(views.some(v=>v.state==='queued') && typeof client.fetchPresence==='function') {
    try { presence=await client.fetchPresence(); } catch { /* Presence can be unavailable independently. */ }
  }
  views.sort((a, b) => String(b.job?.payload?.created_at ?? '').localeCompare(String(a.job?.payload?.created_at ?? '')));
  return views.slice(0, RECENT_JOBS).map(v => ({job_digest: v.job_digest, status: statusLabel(v), circle: circle.name,
    ...(v.state==='queued'?{waiting:waitingLine({...v,presence},{id:d.keyId})}:{})}));
}

export async function showStatus(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  const json = argv.includes('--json');
  try {
    const {position} = parse(argv, []);
    if (position.length) { const e = new Error(); e.code = 'invalid_request'; throw e; }
    const d = options.device ?? await openDevice(options);
    const circles = await d.listCircles();
    const home = options.home ?? configHome();
    const lending = await readLending(home, options.fetch);
    const appStatus = await readApp('/api/status', home, options.fetch ?? globalThis.fetch);
    const summary = appStatus && !appStatus.unreadable ? appStatus.summary ?? null : null;
    const cleanupItems=(appStatus?.cleanup?.items??[]).filter(item=>typeof item.message==='string');
    const cleanupNames=new Set(cleanupItems.map(item=>item.name).filter(Boolean));
    const displayedLending=lending&&cleanupItems.length?{...lending,remediation:(lending.remediation??[]).filter(row=>!cleanupNames.has(row.name))}:lending;
    const liveApp = Boolean(lending && !lending.unreadable || appStatus && !appStatus.unreadable);
    const jobs = [], unreachable = [];
    for (const circle of circles.filter(c => c.origin)) {
      try { jobs.push(...await recentJobs(d, circle)); } catch { unreachable.push(circle.name); }
    }
    const reading = await (options.storeFree ?? defaultStoreFree)();
    const result = {device: {name: hostname(), key_id: d.keyId},
      circles: circles.map(c => ({id: c.id, name: c.name, origin: c.origin ?? null, owned: c.owned === true, unreachable: unreachable.includes(c.name)})),
      lending: applyLaunchFailureStatus({app_running: lending?.unreadable ? null : lending !== null, status: lending?.unreadable ? lendingLabel(lending) : summary?.headline ?? lendingLabel(lending), summary, enabled: lending?.unreadable ? null : lending?.enabled ?? false,
        ...(lending?.unreadable ? {read_error: lending.reason} : {}),
        starting_assumption: lending?.priorVersion ?? null,
        ...(cleanupItems.length?{cleanup_items:cleanupItems}:{}),
        status_lines:[...lendingStatusLines(displayedLending),...cleanupItems.map(item=>item.message)]}, liveApp ? null : readLaunchFailure(home), {liveApp}),
      jobs, disk: withFreeReading(readDiskReport(home, { ledgerFile: options.diskLedgerFile ?? (await import('../docker-backend.mjs')).sbxDiskLedgerFile() }), reading ?? null)};
    if (json) { stdout.write(JSON.stringify(result) + '\n'); return 0; }
    const out = ['This device: ' + result.device.name + ' (' + shortId(d.keyId) + ')',
      'Lending:     ' + result.lending.status + (lending === null ? '  (start the app with: faravan app)' : ''),
      ...(result.lending.summary && (!lending?.unreadable || result.lending.start_failure)
        ? ['Why:         ' + result.lending.summary.reason, nextStep(result.lending.summary.action)].filter(Boolean) : []),
      ...result.lending.status_lines,
      ...diskLines(result.disk),
      'Circles:'];
    for (const c of result.circles) out.push('  ' + c.name.padEnd(Math.max(16, c.name.length + 2)) + (c.origin ? c.origin + (c.owned ? '  (you host it)' : '') + (c.unreachable ? '  (Circle unavailable)' : '') : 'this computer only'));
    out.push(jobs.length ? 'Recent jobs:' : 'Recent jobs: none yet. Try: faravan run "<prompt>"');
    for (const j of jobs) out.push('  ' + shortId(j.job_digest) + '  ' + j.status.padEnd(10) + j.circle + (j.waiting ? '\n    ' + j.waiting : ''));
    stdout.write(out.join('\n') + '\n');
    return 0;
  } catch (error) {
    const problem = problemForError(error);
    if (json) stdout.write(JSON.stringify(problem) + '\n'); else stderr.write('faravan: ' + problemText(problem) + '\n');
    return exitCodeForError(error);
  }
}
