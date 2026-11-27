// Read-only evidence collectors for the S9 two-computer journey (step 4 of
// docs/design/S9-TWO-COMPUTER-JOURNEY.md). A collector gathers only four
// things about one run, on one host, through an injected command runner:
//
//   - whether the run-owned app process has ceased (process-table scan),
//   - the sandbox list for the run's sandbox and attempt IDs,
//   - the host identity,
//   - the job's accounting fields.
//
// The runner is supplied by the later driver: it maps each op to local exec
// or to `tailscale ssh` on the target host. The collector never sees argv,
// never issues a command of its own choosing, and never connects to a real
// machine: it only ever emits one of the four allowlisted ops below, carrying
// only the run's own sandbox, attempt and host IDs. There is no general
// remote shell here and no arbitrary path reader.
//
// The runner contract: run(op) returns (or resolves to)
//   {ok: true, stdout: string}   on success, or
//   {ok: false, error: string}   when the command could not run.
// A runner that throws is treated the same as {ok: false}.
//
// Every observation is a typed, fail-closed value: `result` is one of
// 'ceased' | 'active' | 'unknown' (process), 'found' | 'absent' | 'unknown'
// (sandbox list), 'match' | 'mismatch' | 'unknown' (host), or
// 'ok' | 'unknown' (accounting). Unparseable or incomplete runner output is
// 'unknown', never a silent pass. Observations carry the platform, the
// expected host/sandbox/attempt IDs and an observation time, so the
// evidence.mjs reduction can reject evidence bound to the wrong run.
//
// Nothing a collector emits contains environment values, credentials or file
// contents: process-table lines are reduced to matching PIDs, sandbox entries
// to {sandboxId, attemptId, state}, the host observation to one trimmed line,
// and accounting entries to the eight allowlisted numeric/identity fields.
// Any other field in runner output is dropped, never forwarded.
//
// Per-platform driver mapping (the driver owns the actual argv; the
// collectors only define the op and parse the documented output shape):
//   - Linux process-table: `ps -eo pid=,args=` (no header; one `pid args`
//     line per process). The run-owned process is identified by
//     processMarker, e.g. the run's sbx home path; a bare process name is
//     never enough, because it could match an unrelated process.
//   - macOS process-table: `ps -ax -o pid=,command=` (same line shape).
//     A Mac step must be satisfied by Mac evidence: a Linux process-table
//     observation carries platform 'linux' and the reduction rejects it for
//     a 'darwin' step. Host process absence alone never proves Docker VM
//     work ended on a Mac; the sandbox-list observation is the reviewed
//     product/backend observation tied to the sandbox/attempt, and the
//     driver must back it with one, not with a Linux /proc scan.

export const COLLECTOR_OP_KINDS = ['process-table', 'sandbox-list', 'host-identity', 'accounting'];

const ACCOUNTING_FIELDS = ['kappa_micro', 'spent_micro', 'baseline_used_micro', 'aggregate_used_micro',
  'aggregate_observed_at', 'initial_micro'];

function requireIdentity(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`collector requires a non-empty string ${name}`);
  return value;
}

function baseObservation(collector, kind) {
  return {kind, platform: collector.platform, hostId: collector.hostId, sandboxId: collector.sandboxId,
    attemptId: collector.attemptId, observedAt: Date.now()};
}

async function callRunner(collector, op) {
  try {
    const result = await collector.run(op);
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      return {ok: false, error: 'runner returned a malformed result'};
    }
    // Runner diagnostics can contain command lines, output or credentials.
    // Only collector-owned, bounded reasons may cross the observation boundary.
    if (!result.ok) return {ok: false, error: 'runner failed'};
    if (typeof result.stdout !== 'string') return {ok: false, error: 'runner returned non-string stdout'};
    return {ok: true, stdout: result.stdout};
  } catch {
    return {ok: false, error: 'runner threw'};
  }
}

function parseProcessTable(stdout) {
  const pids = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!match) return {ok: false, reason: 'unparseable process-table line'};
    pids.push({pid: Number(match[1]), args: match[2]});
  }
  return {ok: true, rows: pids};
}

function parseSandboxList(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { return {ok: false, reason: 'sandbox list is not JSON'}; }
  if (!Array.isArray(parsed)) return {ok: false, reason: 'sandbox list is not an array'};
  const entries = [];
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.sandboxId !== 'string' || !entry.sandboxId ||
        typeof entry.attemptId !== 'string' || !entry.attemptId ||
        (entry.state !== undefined && typeof entry.state !== 'string')) {
      return {ok: false, reason: `malformed sandbox-list entry ${index}`};
    }
    entries.push({sandboxId: entry.sandboxId, attemptId: entry.attemptId, state: entry.state ?? null});
  }
  return {ok: true, entries};
}

function parseAccounting(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { return {ok: false, reason: 'accounting output is not JSON'}; }
  if (!Array.isArray(parsed)) return {ok: false, reason: 'accounting output is not an array'};
  const resources = [];
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id ||
        (entry.instance !== undefined && entry.instance !== null &&
          (typeof entry.instance !== 'string' || !entry.instance)) ||
        ACCOUNTING_FIELDS.some(field => !Number.isSafeInteger(entry[field]))) {
      return {ok: false, reason: `malformed accounting entry ${index}`};
    }
    // Emit only the allowlisted fields, in the same shape evidence.mjs
    // pointsFor consumes. Anything else the runner returned (environment
    // values, credentials, file contents) is dropped here.
    resources.push({id: entry.id, instance: entry.instance ?? null,
      kappa_micro: entry.kappa_micro, spent_micro: entry.spent_micro,
      baseline_used_micro: entry.baseline_used_micro, aggregate_used_micro: entry.aggregate_used_micro,
      aggregate_observed_at: entry.aggregate_observed_at, initial_micro: entry.initial_micro});
  }
  return {ok: true, resources};
}

export function createCollector(platform, options) {
  if (platform !== 'linux' && platform !== 'darwin') throw new TypeError(`unknown collector platform ${platform}`);
  if (!options || typeof options !== 'object') throw new TypeError('collector requires an options object');
  if (typeof options.run !== 'function') throw new TypeError('collector requires a run function');
  const collector = {
    platform,
    run: options.run,
    hostId: requireIdentity('hostId', options.hostId),
    sandboxId: requireIdentity('sandboxId', options.sandboxId),
    attemptId: requireIdentity('attemptId', options.attemptId),
    processMarker: requireIdentity('processMarker', options.processMarker),
  };

  async function collectProcess() {
    const observation = {...baseObservation(collector, 'process'), result: 'unknown', reason: '', pids: []};
    const ran = await callRunner(collector, {kind: 'process-table'});
    if (!ran.ok) { observation.reason = `process-table observation failed: ${ran.error}`; return observation; }
    const parsed = parseProcessTable(ran.stdout);
    if (!parsed.ok) { observation.reason = parsed.reason; return observation; }
    const matching = parsed.rows.filter(row => row.args.includes(collector.processMarker));
    const pids = [...new Set(matching.map(row => row.pid))].sort((a, b) => a - b);
    observation.pids = pids;
    if (pids.length) {
      observation.result = 'active';
      observation.reason = `run-owned process still listed: pids ${pids.join(',')}`;
    } else {
      observation.result = 'ceased';
      observation.reason = 'no run-owned process in the process table';
    }
    return observation;
  }

  async function collectSandboxes() {
    const observation = {...baseObservation(collector, 'sandbox-list'), result: 'unknown', reason: '', sandboxes: []};
    const ran = await callRunner(collector, {kind: 'sandbox-list', sandboxId: collector.sandboxId, attemptId: collector.attemptId});
    if (!ran.ok) { observation.reason = `sandbox-list observation failed: ${ran.error}`; return observation; }
    const parsed = parseSandboxList(ran.stdout);
    if (!parsed.ok) { observation.reason = parsed.reason; return observation; }
    // Only the run's own sandbox and attempt are ever reported. A list for
    // a different sandbox yields 'absent', never a passing observation.
    observation.sandboxes = parsed.entries.filter(entry =>
      entry.sandboxId === collector.sandboxId && entry.attemptId === collector.attemptId);
    if (observation.sandboxes.length) {
      observation.result = 'found';
      observation.reason = `sandbox ${collector.sandboxId} attempt ${collector.attemptId} is listed`;
    } else {
      observation.result = 'absent';
      observation.reason = `sandbox ${collector.sandboxId} attempt ${collector.attemptId} is not listed`;
    }
    return observation;
  }

  async function collectHost() {
    const observation = {...baseObservation(collector, 'host-identity'), result: 'unknown', reason: '', observedHostId: null};
    const ran = await callRunner(collector, {kind: 'host-identity'});
    if (!ran.ok) { observation.reason = `host-identity observation failed: ${ran.error}`; return observation; }
    const lines = ran.stdout.split('\n').filter(line => line.trim() !== '');
    if (lines.length !== 1 || !lines[0].trim()) {
      observation.reason = 'host identity is not a single non-empty line';
      return observation;
    }
    observation.observedHostId = lines[0].trim();
    if (observation.observedHostId === collector.hostId) {
      observation.result = 'match';
      observation.reason = `observed host ${observation.observedHostId} matches the expected host`;
    } else {
      observation.result = 'mismatch';
      observation.reason = `observed host ${observation.observedHostId} is not expected host ${collector.hostId}`;
    }
    return observation;
  }

  async function collectAccounting() {
    const observation = {...baseObservation(collector, 'accounting'), result: 'unknown', reason: '', resources: []};
    const ran = await callRunner(collector, {kind: 'accounting', sandboxId: collector.sandboxId, attemptId: collector.attemptId});
    if (!ran.ok) { observation.reason = `accounting observation failed: ${ran.error}`; return observation; }
    const parsed = parseAccounting(ran.stdout);
    if (!parsed.ok) { observation.reason = parsed.reason; return observation; }
    observation.resources = parsed.resources;
    observation.result = 'ok';
    observation.reason = parsed.resources.length
      ? `${parsed.resources.length} accounting resource(s) observed`
      : 'no accounting resources listed';
    return observation;
  }

  async function collectAll() {
    const [process, sandboxes, host, accounting] = await Promise.all([
      collectProcess(), collectSandboxes(), collectHost(), collectAccounting(),
    ]);
    return {...baseObservation(collector, 'evidence'), process, sandboxes, host, accounting};
  }

  return {platform: collector.platform, hostId: collector.hostId, sandboxId: collector.sandboxId,
    attemptId: collector.attemptId, collectProcess, collectSandboxes, collectHost, collectAccounting, collectAll};
}

export function createLinuxCollector(options) {
  return createCollector('linux', options);
}

export function createMacCollector(options) {
  return createCollector('darwin', options);
}
