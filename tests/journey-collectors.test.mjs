import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinuxCollector, createMacCollector, createCollector, COLLECTOR_OP_KINDS} from '../packaging/journey/collectors.mjs';
import {judgeNothingRunning, pointsFor, cumulativeProviderGate} from '../packaging/journey/evidence.mjs';

// All command-runner inputs are injected fakes. No test connects to a real
// machine, reads a real credential store, or runs a real app process.
const HOST = 'host-linux-1';
const MAC_HOST = 'host-mac-1';
const SANDBOX = 'sbx-1';
const ATTEMPT = 'attempt-1';
const MARKER = '/faravan/run-1/sbx';

function collectorOptions(overrides = {}) {
  return {run: async () => ({ok: false, error: 'unused'}), hostId: HOST, sandboxId: SANDBOX,
    attemptId: ATTEMPT, processMarker: MARKER, ...overrides};
}

function runnerFor(handlers) {
  const seen = [];
  const run = async op => {
    seen.push(op);
    const handler = handlers[op.kind];
    if (!handler) return {ok: false, error: `no fake handler for ${op.kind}`};
    return handler(op);
  };
  return {run, seen};
}

const ok = stdout => ({ok: true, stdout});
const failed = error => ({ok: false, error});

const PS_CEASED = '  101 /usr/bin/node /opt/faravan/launcher.js\n  202 /usr/bin/other --flag\n';
const PS_ACTIVE = '  101 /usr/bin/node /opt/faravan/launcher.js\n  303 /usr/bin/node /faravan/run-1/sbx/app.js --serve\n  202 /usr/bin/other --flag\n';
const PS_ACTIVE_WITH_SECRET = '  303 /usr/bin/node /faravan/run-1/sbx/app.js --token tok-planted-secret\n';

function sandboxListStdout(entries) {
  return JSON.stringify(entries);
}

function accountingStdout(entries) {
  return JSON.stringify(entries);
}

const goodResource = (overrides = {}) => ({id: 'claude-code', instance: 'inst-1', kappa_micro: 1_000_000,
  spent_micro: 100, baseline_used_micro: 0, aggregate_used_micro: 50, aggregate_observed_at: 1000,
  initial_micro: 1000, ...overrides});

const goodGateRow = (overrides = {}) => ({id: 'claude-code', instance: 'inst-1', meterDeltaMicro: 10,
  kappaMicro: 1_000_000, observedAt: Date.now(), ...overrides});

const expectedLinux = {platform: 'linux', hostId: HOST, sandboxId: SANDBOX, attemptId: ATTEMPT};
const expectedMac = {platform: 'darwin', hostId: MAC_HOST, sandboxId: SANDBOX, attemptId: ATTEMPT};

// Each observation carries its kind and the run's bindings, as the collectors emit them; a test's own
// fields go on top, so a wrong sandbox or host still reads as that mismatch. Missing bindings are covered
// in journey-collectors-revise.test.mjs.
const bind = (kind, observation) => observation && typeof observation === 'object'
  ? {kind, ...expectedLinux, ...observation} : observation;
function boundJudgement(overrides = {}) {
  const observations = {
    scan: {platform: 'linux', hostId: HOST, sandboxId: SANDBOX, result: 'ceased', reason: 'no run-owned process in the process table', pids: []},
    host: {result: 'match', observedHostId: HOST},
    sandboxes: {result: 'found', sandboxes: [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'stopped'}]},
  };
  for (const key of Object.keys(observations)) if (key in overrides) observations[key] = overrides[key];
  return judgeNothingRunning({attemptState: 'stopped', lendingCurrent: 'other-attempt', attemptId: ATTEMPT,
    appProof: true, live: true, expected: expectedLinux, ...overrides,
    scan: bind('process', observations.scan), host: bind('host-identity', observations.host),
    sandboxes: bind('sandbox-list', observations.sandboxes)});
}

test('linux collector reports active with pids when the run-owned process is listed', async () => {
  const {run} = runnerFor({'process-table': () => ok(PS_ACTIVE)});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectProcess();
  assert.equal(observation.platform, 'linux');
  assert.equal(observation.result, 'active');
  assert.deepEqual(observation.pids, [303]);
  assert.equal(observation.hostId, HOST);
  assert.equal(observation.sandboxId, SANDBOX);
  assert.equal(observation.attemptId, ATTEMPT);
  assert.equal(typeof observation.observedAt, 'number');
});

test('linux collector reports ceased with no pids when the run-owned process is gone', async () => {
  const {run} = runnerFor({'process-table': () => ok(PS_CEASED)});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectProcess();
  assert.equal(observation.result, 'ceased');
  assert.deepEqual(observation.pids, []);
});

test('linux collector reports unknown when the process-table command fails', async () => {
  const {run} = runnerFor({'process-table': () => failed('ssh: connection refused')});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectProcess();
  assert.equal(observation.result, 'unknown');
  assert.deepEqual(observation.pids, []);
  assert.match(observation.reason, /process-table observation failed/);
});

test('linux collector reports unknown on unparseable process-table output', async () => {
  const {run} = runnerFor({'process-table': () => ok('PID COMMAND\nnot-a-pid /bin/true\n')});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectProcess();
  assert.equal(observation.result, 'unknown');
});

test('mac collector stamps darwin and parses its process table', async () => {
  const {run} = runnerFor({'process-table': () => ok(PS_ACTIVE)});
  const collector = createMacCollector({...collectorOptions(), hostId: MAC_HOST, run});
  const observation = await collector.collectProcess();
  assert.equal(observation.platform, 'darwin');
  assert.equal(observation.hostId, MAC_HOST);
  assert.equal(observation.result, 'active');
  assert.deepEqual(observation.pids, [303]);
});

test('sandbox list is found for the run sandbox and attempt, absent for a different sandbox', async () => {
  const listed = [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'running'},
    {sandboxId: 'sbx-2', attemptId: 'attempt-9', state: 'running'}];
  const {run} = runnerFor({'sandbox-list': () => ok(sandboxListStdout(listed))});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const found = await collector.collectSandboxes();
  assert.equal(found.result, 'found');
  assert.deepEqual(found.sandboxes, [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'running'}]);

  const otherOnly = runnerFor({'sandbox-list': () => ok(sandboxListStdout(
    [{sandboxId: 'sbx-2', attemptId: 'attempt-9', state: 'running'}]))});
  const wrongSandbox = createLinuxCollector({...collectorOptions(), run: otherOnly.run});
  const absent = await wrongSandbox.collectSandboxes();
  assert.equal(absent.result, 'absent');
  assert.deepEqual(absent.sandboxes, []);
});

test('sandbox list is unknown on malformed JSON or a malformed entry', async () => {
  const badJson = runnerFor({'sandbox-list': () => ok('not json')});
  const collector = createLinuxCollector({...collectorOptions(), run: badJson.run});
  assert.equal((await collector.collectSandboxes()).result, 'unknown');
  const badEntry = runnerFor({'sandbox-list': () => ok(sandboxListStdout([{sandboxId: SANDBOX}]))});
  const collector2 = createLinuxCollector({...collectorOptions(), run: badEntry.run});
  assert.equal((await collector2.collectSandboxes()).result, 'unknown');
});

test('host identity matches the expected host, mismatches another host, unknown on empty output', async () => {
  const match = runnerFor({'host-identity': () => ok(`${HOST}\n`)});
  const collector = createLinuxCollector({...collectorOptions(), run: match.run});
  const matched = await collector.collectHost();
  assert.equal(matched.result, 'match');
  assert.equal(matched.observedHostId, HOST);

  const mismatch = runnerFor({'host-identity': () => ok('some-other-host\n')});
  const collector2 = createLinuxCollector({...collectorOptions(), run: mismatch.run});
  assert.equal((await collector2.collectHost()).result, 'mismatch');

  const empty = runnerFor({'host-identity': () => ok('\n')});
  const collector3 = createLinuxCollector({...collectorOptions(), run: empty.run});
  const unknown = await collector3.collectHost();
  assert.equal(unknown.result, 'unknown');
  assert.equal(unknown.observedHostId, null);
});

test('accounting emits only allowlisted fields; env values, credentials and file contents never appear', async () => {
  const planted = {...goodResource(), env: {AWS_SECRET_ACCESS_KEY: 'SECRET-planted-env'},
    credentials: 'tok-planted-credential', fileContents: 'file-planted-content', token: 'tok-planted-token'};
  const {run} = runnerFor({'accounting': () => ok(accountingStdout([planted]))});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectAccounting();
  assert.equal(observation.result, 'ok');
  assert.deepEqual(observation.resources, [goodResource()]);
  const dumped = JSON.stringify(observation);
  for (const secret of ['SECRET-planted-env', 'tok-planted-credential', 'file-planted-content', 'tok-planted-token']) {
    assert.doesNotMatch(dumped, new RegExp(secret));
  }

  const processRunner = runnerFor({'process-table': () => ok(PS_ACTIVE_WITH_SECRET)});
  const processCollector = createLinuxCollector({...collectorOptions(), run: processRunner.run});
  const processObservation = await processCollector.collectProcess();
  assert.equal(processObservation.result, 'active');
  assert.doesNotMatch(JSON.stringify(processObservation), /tok-planted-secret/);
});

test('accounting is unknown on a malformed entry and ok with an empty list', async () => {
  const malformed = runnerFor({'accounting': () => ok(accountingStdout([goodResource({kappa_micro: 'fast'})]))});
  const collector = createLinuxCollector({...collectorOptions(), run: malformed.run});
  const unknown = await collector.collectAccounting();
  assert.equal(unknown.result, 'unknown');
  assert.deepEqual(unknown.resources, []);

  const empty = runnerFor({'accounting': () => ok('[]')});
  const collector2 = createLinuxCollector({...collectorOptions(), run: empty.run});
  const emptyObservation = await collector2.collectAccounting();
  assert.equal(emptyObservation.result, 'ok');
  assert.deepEqual(emptyObservation.resources, []);
});

test('collectors only ever issue allowlisted ops carrying only the run ids', async () => {
  const {run, seen} = runnerFor({
    'process-table': () => ok(PS_CEASED),
    'sandbox-list': () => ok(sandboxListStdout([{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'stopped'}])),
    'host-identity': () => ok(`${HOST}\n`),
    'accounting': () => ok(accountingStdout([goodResource()])),
  });
  const collector = createLinuxCollector({...collectorOptions(), run});
  await collector.collectAll();
  assert.deepEqual(seen.map(op => op.kind).sort(), [...COLLECTOR_OP_KINDS].sort());
  for (const op of seen) {
    assert.ok(COLLECTOR_OP_KINDS.includes(op.kind));
    if (op.kind === 'sandbox-list' || op.kind === 'accounting') {
      assert.deepEqual(Object.keys(op).sort(), ['attemptId', 'kind', 'sandboxId']);
      assert.equal(op.sandboxId, SANDBOX);
      assert.equal(op.attemptId, ATTEMPT);
    } else {
      assert.deepEqual(Object.keys(op), ['kind']);
    }
  }
});

test('collectAll returns all four observations and isolates a failing op', async () => {
  const {run} = runnerFor({
    'process-table': () => failed('ps unavailable'),
    'sandbox-list': () => ok(sandboxListStdout([{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'stopped'}])),
    'host-identity': () => ok(`${HOST}\n`),
    'accounting': () => ok(accountingStdout([goodResource()])),
  });
  const collector = createLinuxCollector({...collectorOptions(), run});
  const all = await collector.collectAll();
  assert.equal(all.platform, 'linux');
  assert.equal(all.process.result, 'unknown');
  assert.equal(all.sandboxes.result, 'found');
  assert.equal(all.host.result, 'match');
  assert.equal(all.accounting.result, 'ok');
});

test('collector construction rejects a missing identity or runner', () => {
  assert.throws(() => createLinuxCollector({...collectorOptions(), hostId: ''}), /hostId/);
  assert.throws(() => createLinuxCollector({...collectorOptions(), sandboxId: '  '}), /sandboxId/);
  assert.throws(() => createLinuxCollector({...collectorOptions(), attemptId: ''}), /attemptId/);
  assert.throws(() => createLinuxCollector({...collectorOptions(), processMarker: ''}), /processMarker/);
  assert.throws(() => createLinuxCollector({...collectorOptions(), run: 'not-a-function'}), /run function/);
  assert.throws(() => createCollector('windows', collectorOptions()), /unknown collector platform/);
});

test('app ceased but an active scan still shows it fails', () => {
  const verdict = judgeNothingRunning({attemptState: 'stopped', lendingCurrent: 'other-attempt', attemptId: ATTEMPT,
    appProof: true, scan: {pids: [123]}, live: true});
  assert.equal(verdict.pass, false);
  assert.match(verdict.missing.join(' '), /unresolved app\/process scan conflict/);
  assert.match(verdict.disagreement, /pids 123/);
});

test('an unknown native result cannot pass', async () => {
  // The S9 rule lives on the bound path: a collector observation of
  // 'unknown' leaves the decision unknown even with app proof. The legacy
  // path keeps its existing semantics for the current callers (app proof
  // still passes an unreadable scan); the bound path is where the new
  // collectors are judged.
  const legacy = judgeNothingRunning({attemptState: 'stopped', lendingCurrent: 'other-attempt', attemptId: ATTEMPT,
    appProof: true, scan: {pids: null}, live: true});
  assert.equal(legacy.pass, true);

  // Collector shape, end to end: a failing runner yields an unknown
  // observation, and the bound decision stays unknown.
  const {run} = runnerFor({'process-table': () => failed('ps unavailable')});
  const collector = createLinuxCollector({...collectorOptions(), run});
  const observation = await collector.collectProcess();
  assert.equal(observation.result, 'unknown');
  const bound = boundJudgement({scan: observation, host: {result: 'match', observedHostId: HOST},
    sandboxes: {result: 'found', sandboxes: [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'stopped'}]}});
  assert.equal(bound.pass, null);
  assert.match(bound.missing.join(' '), /native process observation unknown/);
});

test('a wrong sandbox, attempt or host fails', () => {
  const wrongSandbox = boundJudgement({scan: {platform: 'linux', hostId: HOST, sandboxId: 'sbx-2',
    result: 'ceased', reason: '', pids: []}});
  assert.equal(wrongSandbox.pass, false);
  assert.match(wrongSandbox.missing.join(' '), /sandbox mismatch/);

  const wrongAttempt = boundJudgement({attemptId: 'attempt-2'});
  assert.equal(wrongAttempt.pass, false);
  assert.match(wrongAttempt.missing.join(' '), /attempt mismatch/);

  const wrongHostScan = boundJudgement({scan: {platform: 'linux', hostId: 'host-other', sandboxId: SANDBOX,
    result: 'ceased', reason: '', pids: []}});
  assert.equal(wrongHostScan.pass, false);
  assert.match(wrongHostScan.missing.join(' '), /host mismatch/);

  const wrongHostObserved = boundJudgement({host: {result: 'mismatch', observedHostId: 'host-other'}});
  assert.equal(wrongHostObserved.pass, false);
  assert.match(wrongHostObserved.missing.join(' '), /host mismatch/);

  const wrongSandboxListed = boundJudgement({sandboxes: {result: 'found',
    sandboxes: [{sandboxId: 'sbx-2', attemptId: ATTEMPT, state: 'running'}]}});
  assert.equal(wrongSandboxListed.pass, false);
  assert.match(wrongSandboxListed.missing.join(' '), /sandbox mismatch/);
});

test('a sandbox still listed as running, or in an unknown state, cannot pass', () => {
  const running = boundJudgement({sandboxes: {result: 'found',
    sandboxes: [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'running'}]}});
  assert.equal(running.pass, false);
  assert.match(running.source, /still running/);
  const unknownState = boundJudgement({sandboxes: {result: 'found',
    sandboxes: [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: null}]}});
  assert.equal(unknownState.pass, null);
  assert.match(unknownState.missing.join(' '), /listed with state unknown/);
  assert.equal(boundJudgement({}).pass, true);
});

test('linux process-table evidence cannot satisfy a mac step', () => {
  const verdict = judgeNothingRunning({attemptState: 'stopped', lendingCurrent: 'other-attempt', attemptId: ATTEMPT,
    appProof: true,
    scan: {platform: 'linux', hostId: MAC_HOST, sandboxId: SANDBOX, result: 'ceased', reason: '', pids: []},
    live: true, expected: expectedMac,
    host: {result: 'match', observedHostId: MAC_HOST},
    sandboxes: {result: 'found', sandboxes: [{sandboxId: SANDBOX, attemptId: ATTEMPT, state: 'stopped'}]}});
  assert.equal(verdict.pass, false);
  assert.match(verdict.missing.join(' '), /linux process-table evidence cannot satisfy a darwin step/);
});

test('bound happy path passes when app proof and all native observations agree', () => {
  const verdict = boundJudgement();
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.missing, []);
});

test('bound path cannot pass without app proof or with a missing native observation', () => {
  const noAppProof = boundJudgement({appProof: false});
  assert.equal(noAppProof.pass, null);
  assert.match(noAppProof.missing.join(' '), /app cessation proof is missing/);

  const noHost = boundJudgement({host: undefined});
  assert.equal(noHost.pass, null);
  assert.match(noHost.missing.join(' '), /host identity observation is missing/);

  const unknownHost = boundJudgement({host: {result: 'unknown', observedHostId: null, reason: 'host-identity observation failed: refused'}});
  assert.equal(unknownHost.pass, null);
  assert.match(unknownHost.missing.join(' '), /host identity observation unknown/);

  const noSandboxes = boundJudgement({sandboxes: undefined});
  assert.equal(noSandboxes.pass, null);
  assert.match(noSandboxes.missing.join(' '), /sandbox-list observation is missing/);
});

test('legacy app proof with an empty scan still passes for existing callers', () => {
  const verdict = judgeNothingRunning({attemptState: 'stopped', lendingCurrent: 'other-attempt', attemptId: ATTEMPT,
    appProof: true, scan: {pids: [], sbxHome: '/faravan/run-1/sbx'}, live: true});
  assert.equal(verdict.pass, true);
});

test('pointsFor names missing accounting fields and fails on empty resources or an empty instance', () => {
  const missingKappa = pointsFor({resources: [goodResource({kappa_micro: undefined})]}, 1_000_000);
  assert.deepEqual(missingKappa.rows, []);
  assert.match(missingKappa.missing.join(' '), /kappa_micro/);

  const empty = pointsFor({resources: []}, 1_000_000);
  assert.deepEqual(empty.rows, []);
  assert.match(empty.missing.join(' '), /attempt\.resources/);

  const emptyInstance = pointsFor({resources: [goodResource({instance: ''})]}, 1_000_000);
  assert.deepEqual(emptyInstance.rows, []);
  assert.match(emptyInstance.missing.join(' '), /malformed or regressed counters/);

  const valid = pointsFor({resources: [goodResource()]}, 1_000_000);
  assert.deepEqual(valid.missing, []);
  assert.equal(valid.rows.length, 1);
  assert.equal(valid.rows[0].instance, 'inst-1');
});

test('cumulativeProviderGate fails on missing or empty accounting fields', () => {
  const noJobs = cumulativeProviderGate([], 1_000_000);
  assert.equal(noJobs.pass, false);
  assert.match(noJobs.missing.join(' '), /provider accounting observations/);

  const emptyRows = cumulativeProviderGate([{label: 'after', rows: [], missing: []}], 1_000_000);
  assert.equal(emptyRows.pass, false);
  assert.match(emptyRows.missing.join(' '), /provider accounting observations/);

  const missingFields = cumulativeProviderGate([{label: 'after', rows: [], missing: ['attempt.resources[claude-code].kappa_micro']}], 1_000_000);
  assert.equal(missingFields.pass, false);
  assert.match(missingFields.missing.join(' '), /kappa_micro/);
});

test('cumulativeProviderGate fails when one attempt resource instance changes', () => {
  const verdict = cumulativeProviderGate([{label: 'after',
    rows: [goodGateRow({instance: 'inst-1'}), goodGateRow({instance: 'inst-2'})]}], 1_000_000);
  assert.equal(verdict.pass, false);
  assert.match(verdict.missing.join(' '), /claude-code resource instance changed/);

  const sameAttempt = cumulativeProviderGate([{label: 'after', rows: [
    goodGateRow({attemptId: 'attempt-1', instance: 'inst-1'}),
    goodGateRow({attemptId: 'attempt-1', instance: 'inst-2'})]}], 1_000_000);
  assert.equal(sameAttempt.pass, false);
  assert.match(sameAttempt.missing.join(' '), /claude-code resource instance changed/);
});

test('cumulativeProviderGate keeps separate totals for different instances across attempts', () => {
  // The caller's total gate passes one entry per (digest, attemptId,
  // resource, instance); different attempts legitimately use different
  // instances of the same resource and must stay separate totals, not fail.
  const verdict = cumulativeProviderGate([
    {label: 'job 1', rows: [goodGateRow({attemptId: 'attempt-1', instance: 'inst-1'})]},
    {label: 'job 2', rows: [goodGateRow({attemptId: 'attempt-2', instance: 'inst-2'})]},
  ], 1_000_000);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.totals.length, 2);
});

test('cumulativeProviderGate still passes a stable complete reading', () => {
  const verdict = cumulativeProviderGate([{label: 'after', rows: [goodGateRow()]}], 1_000_000);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.missing, []);
  assert.deepEqual(verdict.breaches, []);
});
