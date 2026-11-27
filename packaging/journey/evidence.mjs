// Evidence readers for the S6 smoke, used identically in synthetic and live mode. They read app-written state files and
// /proc metadata only. They never open credential stores and never print environment values.
import fs from 'node:fs';
import {join} from 'node:path';

export const MICRO = 1000000;
const ACTIVE = new Set(['queued', 'claimed', 'preparing', 'running', 'accepted', 'starting']);
// Sandbox-list states that show a sandbox is no longer running anything.
const STOPPED_SANDBOX = new Set(['stopped', 'exited']);

export function agentModelMatches(agents, agentId, model) {
  return Array.isArray(agents) && agents.some(agent => agent?.id === agentId && agent.run?.model === model);
}

// The app's burn conversion (lib/v1/lending-pace50-source.mjs, convertUsage): ceil(kappa_micro * units_micro / MICRO) per
// reserved resource. The cap is a USD amount in micro units, so this is the cap in the app's quota micro-points.
export function convertUsd(usdMicro, kappaMicro) {
  return Number((BigInt(kappaMicro) * BigInt(usdMicro) + BigInt(MICRO - 1)) / BigInt(MICRO));
}

// The pace50 attempt the app wrote for one job digest, from <faravan home>/v1/lending-pace50-state.json.
export function readPace50Attempts(faravanHome, jobDigest) {
  const file = join(faravanHome, 'v1', 'lending-pace50-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return {attempts: [], file, missing: [`${file} (${error.code ?? error.message})`]}; }
  const sourceAttempts = Array.isArray(state.attempts) ? state.attempts : [];
  const malformed = sourceAttempts.flatMap((attempt, index) => attempt && typeof attempt === 'object' ? [] : [`${file} attempts[${index}] malformed`]);
  const attempts = sourceAttempts.filter(a => a && typeof a === 'object' && a.job_id === jobDigest);
  const missing = [...malformed, ...(!attempts.length ? [`lending-pace50-state.json attempts[job_id=${jobDigest}]`] : [])];
  return {attempts, file, missing};
}

export function readPace50Attempt(faravanHome, jobDigest) {
  const result = readPace50Attempts(faravanHome, jobDigest);
  return {attempt: result.attempts.at(-1) ?? null, file: result.file, missing: result.missing};
}

// Per reserved resource: the points the app charged this job (spent_micro), the provider meter delta on that resource
// (aggregate_used_micro minus baseline_used_micro, both as the app recorded them), and the cap converted at its kappa.
// Any absent field is named in `missing`; nothing is defaulted.
export function pointsFor(attempt, capUsdMicro) {
  const rows = [], missing = [];
  if (!attempt) return {rows, missing: ['attempt']};
  if (!Array.isArray(attempt.resources) || attempt.resources.length === 0) return {rows, missing: ['attempt.resources']};
  for (const [index, r] of attempt.resources.entries()) {
    const at = `attempt.resources[${typeof r?.id === 'string' ? r.id : index}]`;
    if (!r || typeof r !== 'object') { missing.push(`${at} malformed`); continue; }
    const absent = ['kappa_micro', 'spent_micro', 'baseline_used_micro', 'aggregate_used_micro', 'aggregate_observed_at', 'initial_micro']
      .filter(f => !Number.isSafeInteger(r[f]));
    if (typeof r.id !== 'string' || !r.id) absent.unshift('id');
    if (absent.length) { missing.push(...absent.map(f => `${at}.${f}`)); continue; }
    if (r.kappa_micro <= 0 || r.spent_micro < 0 || r.initial_micro < 0 || r.spent_micro > r.initial_micro ||
        r.baseline_used_micro < 0 || r.aggregate_used_micro < r.baseline_used_micro ||
        (r.instance != null && (typeof r.instance !== 'string' || !r.instance))) {
      missing.push(`${at} has malformed or regressed counters`);
      continue;
    }
    rows.push({id: r.id, instance: r.instance ?? null, kappaMicro: r.kappa_micro, capMicro: convertUsd(capUsdMicro, r.kappa_micro),
      spentMicro: r.spent_micro, meterDeltaMicro: r.aggregate_used_micro - r.baseline_used_micro,
      observedAt: r.aggregate_observed_at,
      reservedMicro: r.initial_micro});
  }
  return {rows, missing};
}

export function breachesFor(rows, label) {
  return rows.flatMap(r => [
    r.spentMicro > r.capMicro ? `${label}: ${r.id} spent_micro ${r.spentMicro} > cap ${r.capMicro}` : null,
    r.meterDeltaMicro > r.capMicro ? `${label}: ${r.id} meter delta ${r.meterDeltaMicro} > cap ${r.capMicro}` : null,
  ].filter(Boolean));
}

export function sumPointsAsUsdMicro(rows, field) {
  let usdMicro = 0;
  const missing = [];
  for (const row of rows) {
    const points = row[field];
    if (!Number.isSafeInteger(points) || points < 0 || !Number.isSafeInteger(row.kappaMicro) || row.kappaMicro <= 0) {
      missing.push(`${row.id}: malformed ${field} or conversion rate`);
      continue;
    }
    usdMicro += Number((BigInt(points) * BigInt(MICRO) + BigInt(row.kappaMicro - 1)) / BigInt(row.kappaMicro));
  }
  if (!Number.isSafeInteger(usdMicro)) missing.push(`cumulative ${field} USD total overflow`);
  return {usdMicro, missing};
}

// Reconcile provider deltas in quota points. A resource's identity includes its instance and
// every reading must use the same conversion rate before point deltas can be added. A resource's
// instance must not change within one attempt's readings (same label and attempt ID): a change
// there means the readings are not the same meter, so the gate fails instead of summing across
// instances. Different attempts or jobs may use different instances; those stay separate totals.
export function cumulativeProviderGate(jobRows, totalCapUsdMicro, now = Date.now(), maxAgeMs = 60_000) {
  const totals = new Map(), missing = [], breaches = [];
  const instancesById = new Map();
  for (const {label, rows, missing: rowMissing = []} of jobRows) {
    missing.push(...rowMissing.map(field => `${label}: ${field}`));
    for (const row of rows ?? []) {
      const key = JSON.stringify([row.id, row.instance ?? null]);
      if (!Number.isSafeInteger(row.meterDeltaMicro) || row.meterDeltaMicro < 0 ||
          !Number.isSafeInteger(row.kappaMicro) || row.kappaMicro <= 0 ||
          !Number.isSafeInteger(row.observedAt) || row.observedAt > now || now - row.observedAt > maxAgeMs) {
        missing.push(`${label}: ${row.id} has malformed provider accounting`);
        continue;
      }
      const meterKey = JSON.stringify([label, row.attemptId ?? null, row.id]);
      const seenInstances = instancesById.get(meterKey) ?? new Set();
      if (seenInstances.size && !seenInstances.has(key)) {
        missing.push(`${label}: ${row.id} resource instance changed during the run`);
        continue;
      }
      seenInstances.add(key);
      instancesById.set(meterKey, seenInstances);
      const current = totals.get(key) ?? {id: row.id, instance: row.instance ?? null, kappaMicro: row.kappaMicro, deltaMicro: 0};
      if (current.kappaMicro !== row.kappaMicro) {
        missing.push(`${label}: ${row.id} conversion rate changed during the run`);
        continue;
      }
      current.deltaMicro += row.meterDeltaMicro;
      if (!Number.isSafeInteger(current.deltaMicro)) missing.push(`${label}: ${row.id} cumulative provider delta overflow`);
      totals.set(key, current);
    }
  }
  if (!jobRows.length || !jobRows.some(job => Array.isArray(job.rows) && job.rows.length > 0))
    missing.push('provider accounting observations');
  const providerTotals = new Map();
  for (const row of totals.values()) {
    const provider = JSON.stringify([row.id, row.instance ?? null]);
    const usdMicro = Number((BigInt(row.deltaMicro) * BigInt(MICRO) + BigInt(row.kappaMicro - 1)) / BigInt(row.kappaMicro));
    providerTotals.set(provider, usdMicro);
  }
  const totalUsdMicro = [...providerTotals.values()].reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(totalUsdMicro)) missing.push('cumulative provider USD total overflow');
  if (totalUsdMicro > totalCapUsdMicro) breaches.push(`cumulative provider charge ${totalUsdMicro} USD micro > total cap ${totalCapUsdMicro}`);
  return {totals: [...totals.values()], providerTotals: Object.fromEntries(providerTotals), totalUsdMicro, missing, breaches,
    pass: missing.length === 0 && breaches.length === 0};
}

// Compare only durable accounting and identity fields. Receipt metadata may change on read.
export function stableSpendLedger(ledger) {
  const jobs = Array.isArray(ledger?.jobs) ? ledger.jobs.map(job => ({digest: job.digest, state: job.state})).sort((a, b) => String(a.digest).localeCompare(String(b.digest))) : null;
  const spend = ledger?.spend;
  if (!jobs || !Array.isArray(spend)) return null;
  return {jobs, spend: spend.map(row => ({digest: row.digest, attemptId: row.attemptId, resource: row.resource,
    instance: row.instance ?? null, kappaMicro: row.kappaMicro, baselineMicro: row.baselineMicro,
    aggregateMicro: row.aggregateMicro, spentMicro: row.spentMicro, reservedMicro: row.reservedMicro}))
    .sort((a, b) => `${a.digest}:${a.attemptId}:${a.resource}:${a.instance}`.localeCompare(`${b.digest}:${b.attemptId}:${b.resource}:${b.instance}`))};
}

export function compareSpendLedger(before, after) {
  const a = stableSpendLedger(before), b = stableSpendLedger(after);
  if (!a || !b || a.jobs.length !== b.jobs.length || a.spend.length !== b.spend.length) return false;
  const fieldsMatch = (left, right, fields) => fields.every(field => left[field] === right[field]);
  if (!a.jobs.every((row, index) => fieldsMatch(row, b.jobs[index], ['digest', 'state']))) return false;
  const spendFields = ['digest', 'attemptId', 'resource', 'instance', 'kappaMicro', 'baselineMicro',
    'aggregateMicro', 'spentMicro', 'reservedMicro'];
  return a.spend.every((row, index) => fieldsMatch(row, b.spend[index], spendFields));
}

// Inputs are independent observations: installed source, verified archive bytes,
// an already verified exact-target Host route, and an already verified invite.
// This helper joins them; it does not verify a provider, signature, or artifact.
export function observeInstalledHostInvite({
  sourceSha, artifactSha256, verifiedPublicOrigin, hostedCircle, verifiedInvite,
} = {}) {
  const digest = /^[a-f0-9]{64}$/;
  const gitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const circle = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const fingerprint = /^sha256:[a-f0-9]{64}$/;
  const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);
  const httpsOrigin = value => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && value === url.origin;
    } catch { return false; }
  };
  const circleId = hostedCircle?.id;
  const rootFingerprint = hostedCircle?.pinnedRootFingerprint;
  if (!valid(gitSha, sourceSha) || !valid(digest, artifactSha256)) {
    return {observation: null, reason: 'Installed release identity unavailable.'};
  }
  if (!httpsOrigin(verifiedPublicOrigin) || hostedCircle?.origin !== verifiedPublicOrigin ||
      !valid(circle, circleId) || !valid(fingerprint, rootFingerprint)) {
    return {observation: null, reason: 'Verified public Host identity unavailable.'};
  }
  const coordinator = verifiedInvite?.coordinator;
  const inviteCircle = verifiedInvite?.circle;
  const inviteRoot = verifiedInvite?.root_fingerprint;
  if (!httpsOrigin(coordinator) || !valid(circle, inviteCircle) || !valid(fingerprint, inviteRoot)) {
    return {observation: null, reason: 'Verified invite identity unavailable.'};
  }
  const originAgrees = coordinator === verifiedPublicOrigin;
  const circleAgrees = inviteCircle === circleId;
  const rootAgrees = inviteRoot === rootFingerprint;
  return {
    observation: {sourceSha, artifactSha256, verifiedPublicOrigin, circleId, rootFingerprint,
      originAgrees, circleAgrees, rootAgrees},
    reason: originAgrees && circleAgrees && rootAgrees ? null : 'Verified invite does not match the hosted circle.',
  };
}

export function installedDataHome(channelText) {
  const fields = Object.fromEntries(String(channelText).trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
  }));
  return fields.channel && fields.data_home ? fields.data_home : null;
}

export function desktopLauncher(desktopText) {
  const exec = String(desktopText).split(/\r?\n/).find(line => line.startsWith('Exec='))?.slice(5).trim();
  if (!exec || /[%]/.test(exec)) return null;
  const [binary, ...args] = exec.split(/\s+/);
  return binary.startsWith('/') ? {binary, args} : null;
}

// Owner-home sbx processes through the app's own /proc scanner (lib/docker-backend.mjs inspectIdentitySandboxes), keyed
// on the owner's sbx HOME. Returns pids only; the scanner's environment copies are dropped here and never printed.
// pids: null when the scan is not trustworthy (a matching process could not be read).
export async function sandboxScan(docker, sbxHome) {
  const found = await docker.inspectIdentitySandboxes({home: sbxHome});
  return {pids: found === null ? null : found.map(f => f.pid), sbxHome};
}

// Decides nothingRunningAfterStop from what the app exposes first, then from the sbx process scan.
// app proof: the pace50 attempt's process_state is 'ceased' and cessation_proven is true.
//
// The optional `expected` argument binds the decision to one run
// ({platform, hostId, sandboxId, attemptId}, as the S9 collectors report it), with the
// collector observations `host` (collectHost) and `sandboxes` (collectSandboxes). On the
// bound path every native observation must be present, known and bound to this run:
//   - evidence for the wrong platform, host, sandbox or attempt fails;
//   - an unknown native result cannot pass (pass is null, never true);
//   - app proof is required: an empty process scan alone does not pass.
// Without `expected` the legacy scan shape ({pids, sbxHome}) keeps its existing
// semantics for the current callers: app proof still passes when the scan is
// unreadable. The S9 unknown-cannot-pass rule lives on the bound path, where
// the collector reports 'unknown' explicitly.
export function judgeNothingRunning({attemptState, lendingCurrent, attemptId, appProof, scan, runsUnchanged, live,
  expected, host, sandboxes}) {
  const missing = [];
  if (attemptState === undefined || attemptState === null) missing.push('owner jobs.get current_attempt.state');
  if (lendingCurrent === undefined) missing.push('lending.get.current');
  if (missing.length) return {pass: null, source: null, missing};
  if (ACTIVE.has(attemptState)) return {pass: false, source: `app: owner attempt state ${attemptState}`, missing: []};
  if (lendingCurrent === attemptId) return {pass: false, source: 'app: lending.get.current is this attempt', missing: []};
  if (!live && !runsUnchanged) return {pass: false, source: 'synthetic run counter changed after the Stop', missing: []};
  if (expected !== undefined) {
    try { return judgeBoundCessation({attemptId, appProof, scan, host, sandboxes, expected}); }
    catch { return {pass: null, source: null, missing: ['bound cessation evidence is malformed']}; }
  }
  const scanPids = scan?.pids ?? null;
  const disagreement = appProof && Array.isArray(scanPids) && scanPids.length > 0 ? `sbx scan still lists pids ${scanPids.join(',')}` : null;
  if (disagreement) return {pass: false, source: null, disagreement, missing: [`unresolved app/process scan conflict: ${disagreement}`]};
  // Legacy path: unchanged semantics for the existing callers.
  if (appProof) return {pass: true, source: 'app: pace50 attempt process_state ceased and cessation_proven', disagreement, missing: []};
  if (scanPids === null) return {pass: null, source: null, missing: ['sbx process scan (/proc unreadable, or a matching process unreadable)']};
  if (scanPids.length === 0) return {pass: true, source: 'sbx process scan: no containerd-shim process for this sbx home', disagreement, missing: []};
  return {pass: false, source: `sbx process scan: ${scanPids.length} process(es) for this sbx home, pids ${scanPids.join(',')}`, disagreement, missing: []};
}

// Bound S9 cessation decision. Validate every envelope before interpreting its
// result, including an absent sandbox list. The legacy scan path above is separate.
function judgeBoundCessation({attemptId, appProof, scan, host, sandboxes, expected}) {
  const missing = [], mismatches = [];
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = value => typeof value === 'string' && value.trim().length > 0;
  const bindings = ['platform', 'hostId', 'sandboxId', 'attemptId'];
  if (!record(expected)) return {pass: null, source: null, missing: ['expected run identity is malformed']};
  for (const field of bindings) {
    if (!identity(expected[field])) missing.push(`expected ${field} is missing or empty, so cessation evidence cannot be bound to this run`);
  }
  if (missing.length) return {pass: null, source: null, missing};
  if (expected.platform !== 'linux' && expected.platform !== 'darwin') {
    return {pass: null, source: null, missing: ['expected platform is unsupported']};
  }
  if (expected.attemptId !== attemptId) {
    mismatches.push('attempt mismatch: requested attempt is not the expected run');
  }
  for (const [observation, kind, label] of [[scan, 'process', 'native process'],
    [host, 'host-identity', 'host identity'], [sandboxes, 'sandbox-list', 'sandbox-list']]) {
    if (!record(observation)) {
      missing.push(`${label} observation is missing or malformed`);
      continue;
    }
    if (observation.kind !== kind) missing.push(`${label} observation has missing or invalid kind`);
    for (const field of bindings) {
      if (!identity(observation[field])) missing.push(`${label} evidence has no ${field} binding`);
      else if (observation[field] !== expected[field]) {
        const name = {hostId: 'host', sandboxId: 'sandbox', attemptId: 'attempt', platform: 'platform'}[field];
        mismatches.push(field === 'platform' && kind === 'process'
          ? `platform mismatch: ${observation.platform} process-table evidence cannot satisfy a ${expected.platform} step`
          : `${name} mismatch: ${label} evidence has a different ${field} binding`);
      }
    }
  }
  if (mismatches.length) return {pass: false, source: null, missing: mismatches};
  if (missing.length) return {pass: null, source: null, missing};

  // Do not use status aliases, coerce payloads, or format unvalidated PIDs.
  if (!['ceased', 'active', 'unknown'].includes(scan.result)) missing.push('native process observation has an invalid result');
  if (!Array.isArray(scan.pids) || !Array.from(scan.pids).every(pid => Number.isSafeInteger(pid) && pid > 0)) {
    missing.push('native process observation has malformed pids');
  } else if ((scan.result === 'ceased' && scan.pids.length !== 0) ||
      (scan.result === 'active' && scan.pids.length === 0)) {
    missing.push('native process observation result disagrees with pids');
  }
  if (!['match', 'mismatch', 'unknown'].includes(host.result)) missing.push('host identity observation has an invalid result');
  if (host.result !== 'unknown' && !identity(host.observedHostId)) missing.push('host identity observation has malformed observedHostId');
  if (!['found', 'absent', 'unknown'].includes(sandboxes.result)) missing.push('sandbox-list observation has an invalid result');
  if (sandboxes.result !== 'unknown') {
    if (!Array.isArray(sandboxes.sandboxes)) missing.push('sandbox-list observation has malformed sandboxes');
    else if ((sandboxes.result === 'found' && sandboxes.sandboxes.length === 0) ||
        (sandboxes.result === 'absent' && sandboxes.sandboxes.length !== 0)) {
      missing.push('sandbox-list observation result disagrees with sandboxes');
    } else {
      for (const entry of sandboxes.sandboxes) {
        if (!record(entry) || !identity(entry.sandboxId) || !identity(entry.attemptId) ||
            (entry.state !== null && typeof entry.state !== 'string')) {
          missing.push('sandbox-list observation has a malformed entry');
        }
      }
    }
  }
  if (scan.result === 'unknown') missing.push('native process observation unknown');
  if (host.result === 'unknown') missing.push('host identity observation unknown');
  if (sandboxes.result === 'unknown') missing.push('sandbox-list observation unknown');
  if (missing.length) return {pass: null, source: null, missing};

  if (host.result === 'mismatch' || host.observedHostId !== expected.hostId) {
    return {pass: false, source: null, missing: ['host mismatch: observed host is not the expected host']};
  }
  for (const entry of sandboxes.sandboxes) {
    if (entry.sandboxId !== expected.sandboxId || entry.attemptId !== expected.attemptId) {
      return {pass: false, source: null, missing: ['sandbox mismatch: listed sandbox or attempt is not the expected run']};
    }
    if (entry.state === 'running') return {pass: false, source: `sandbox list: sandbox ${entry.sandboxId} is still running`, missing: []};
    if (!STOPPED_SANDBOX.has(entry.state)) missing.push(`sandbox ${entry.sandboxId} is listed with state ${entry.state ?? 'unknown'}`);
  }
  if (scan.result === 'active') {
    const disagreement = appProof ? `sbx scan still lists pids ${scan.pids.join(',')}` : null;
    if (disagreement) return {pass: false, source: null, disagreement, missing: [`unresolved app/process scan conflict: ${disagreement}`]};
    return {pass: false, source: `native process scan: ${scan.pids.length} run-owned process(es) still listed`, missing: []};
  }
  if (!appProof) missing.push('app cessation proof is missing: pace50 attempt process_state is not ceased with cessation_proven');
  if (missing.length) return {pass: null, source: null, missing};
  return {pass: true, source: 'app: pace50 attempt process_state ceased and cessation_proven; bound native process, host and sandbox observations agree',
    disagreement: null, missing: []};
}

const sameAttempt = (attempt, identity) => attempt?.attempt_id === identity.attemptId &&
  attempt?.job_digest === identity.jobDigest && attempt?.generation === identity.generation;
const removalScopeFields = ['sandboxId', 'jobId', 'ownerScope', 'runtimeId', 'create_incarnation'];
const removalId = value => typeof value === 'string' && value.length <= 256 && value.trim().length > 0;
const completeRemovalScope = identity => ['attemptId', 'jobDigest', ...removalScopeFields].every(key => removalId(identity[key])) &&
  Number.isSafeInteger(identity.generation) && identity.generation >= 1;
const removalTime = value => typeof value === 'string' ? Date.parse(value) : NaN;

function stopCounterRows(home) {
  try {
    const counters = JSON.parse(fs.readFileSync(join(home, 'v1', 'app-counters.json'), 'utf8'));
    const rows = Object.values(counters.accounts ?? {});
    return rows.length ? rows : [counters];
  } catch {
    return [];
  }
}

// Capture the exact sandbox binding while the original signed attempt is running.
export function readPreparedStopIdentity(home, attempt) {
  const identity = {attemptId: attempt?.attempt_id, jobDigest: attempt?.job_digest, generation: attempt?.generation};
  if (!removalId(identity.attemptId) || !removalId(identity.jobDigest) || !Number.isSafeInteger(identity.generation) || identity.generation < 1) return null;
  const pending = stopCounterRows(home).map(row => row?.pending).filter(entry =>
    entry?.attemptId === identity.attemptId && sameAttempt(entry.attempt, identity));
  if (pending.length !== 1) return null;
  const [row] = pending;
  const scope = {...identity, sandboxId: row.sandboxId, jobId: row.jobId, ownerScope: row.owner_scope,
    runtimeId: row.sbx_runtime?.id, create_incarnation: row.sandboxIncarnation};
  return completeRemovalScope(scope) ? scope : null;
}

export function judgeRecordedStopRemoval(home, expected, originalAttempt) {
  const unknown = {status: 'unknown', pass: false};
  if (!expected || !completeRemovalScope(expected) || !sameAttempt(originalAttempt, expected) ||
      originalAttempt.compute_stopped !== true ||
      !['completed', 'released', 'failed', 'expired', 'cancelled'].includes(originalAttempt.state) ||
      !Number.isFinite(removalTime(originalAttempt.stopped_at))) return unknown;

  const recovery = stopCounterRows(home).map(row => row?.lastRecovery).filter(row =>
    row?.attemptId === expected.attemptId && row.removed === true);
  if (recovery.length !== 1) return unknown;
  const witness = recovery[0].removalObservation;
  if (!witness || !completeRemovalScope(witness) ||
      !['attemptId', 'jobDigest', 'generation', 'sandboxId', 'jobId', 'ownerScope', 'runtimeId']
        .every(key => witness[key] === expected[key])) return unknown;
  if (witness.create_incarnation !== expected.create_incarnation) return {status: 'wrong-incarnation', pass: false};
  const before = removalTime(witness.before_at), after = removalTime(witness.after_at);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before >= after) return unknown;
  return {status: 'removed', pass: true};
}

// Read through the running app's device and keep only the original attempt receipt.
export async function readOriginalStopAttempt(device,{circle,digest,attemptId,generation}) {
  try {
    const client=await device.jobReadClient(circle,digest);
    const {attempt_id,job_digest,state,compute_stopped,stopped_at}=await client.getAttempt(
      {attempt_id:attemptId,job_digest:digest,generation},{signal:AbortSignal.timeout(5000)});
    return {attempt_id,job_digest,generation,state,compute_stopped,stopped_at};
  } catch {
    return null;
  }
}

// Whether the owner's Stop ended job 2, by one of the two whole paths the product has. Both need the attempt to be
// terminal and the app's durable owner-stop record for this attempt (lender-pace50.mjs owner_stop event).
// - graceful: the guard reached the run, so the partial work comes back with its receipt and the friend transcript has
//   the stop copy. Synthetic mode also needs the fixture meter to record that the backend got the owner's stop request.
//   Live mode has no such meter record; the durable record and the friend-visible copy are the evidence.
// - hard: the run was killed, so the receipt request answers result_unavailable and the friend's reason is
//   stopped_by_lender.
export function judgeOwnerStop({live, ownerAttemptState, attemptId, ownerStop, meterRuns, receiptError, receiptUnavailable,
  transcriptHasStopCopy, friendReasonCode}) {
  const missing = [];
  const terminal = ['stopped', 'completed'].includes(ownerAttemptState);
  if (!terminal) missing.push(`owner attempt state is ${ownerAttemptState ?? 'unknown'}, not stopped or completed`);
  const recorded = typeof attemptId === 'string' && ownerStop?.event_id === `${attemptId}:owner-stop` &&
    ownerStop?.durable_intent_recorded === true;
  if (!recorded) missing.push('lending-pace50-state.json attempt owner_stop record for this attempt');
  const backendGotStop = live || meterRuns?.[0]?.stop === 'owner';
  const graceful = backendGotStop && !receiptError && transcriptHasStopCopy === true;
  const hard = receiptUnavailable === true && friendReasonCode === 'stopped_by_lender';
  if (!graceful && !hard) missing.push(live
    ? 'neither a receipt with the friend stop copy nor result_unavailable with reason stopped_by_lender'
    : 'neither a meter stop:owner run with a receipt and the friend stop copy nor result_unavailable with reason stopped_by_lender');
  const pass = terminal && recorded && (graceful || hard);
  return {pass, path: pass ? (graceful ? 'graceful' : 'hard') : null, missing};
}
