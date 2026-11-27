import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDescriptor, reduceRun, GATES, GATE_FIELDS, BLOCKED_CODES} from '../packaging/journey/two-computer.mjs';

const hash = n => n.toString(16).padStart(64, '0');
function fixture() {
  const machine = (machineId, os) => ({machineId, os, arch: 'arm64', userIdentity: 'test-user',
    installIdentity: os + '-preview', installDestination: '/' + os + '/preview', channel: 's9',
    dataRoot: '/' + os + '/data', guiSession: 'session-1', accountCapability: 'approved-test',
    resourceLimits: {job: 1, total: 4}, processIncarnation: os + '-process-1',
    accountingInstanceId: os + '-account', accountingWindowId: os + '-window',
    accountingResources: ['tokens', 'requests']});
  const d = {runId: 'run-1', harnessCommit: 'a'.repeat(40), artifacts: {linux: hash(1), darwin: hash(2)},
    machines: [machine('mac', 'darwin'), machine('linux', 'linux')],
    writeAudit: {complete: true, forbiddenWrites: []},
    directions: {
      A: {owner: 'mac', friend: 'linux', circleId: 'circle-a', firstJob: {digest: hash(3), attemptId: 'a-first'}, stopJob: {digest: hash(4), attemptId: 'a-stop'}},
      B: {owner: 'linux', friend: 'mac', circleId: 'circle-b', firstJob: {digest: hash(5), attemptId: 'b-first'}, stopJob: {digest: hash(6), attemptId: 'b-stop'}},
    }};
  const steps = [];
  for (const direction of ['A', 'B']) for (const gate of GATES) for (const role of ['owner', 'friend']) {
    const map = d.directions[direction], m = d.machines.find(m => m.machineId === map[role]);
    const job = map[gate === 'stop' ? 'stopJob' : 'firstJob'];
    const s = {id: direction + '-' + gate + '-' + role, runId: d.runId, harnessCommit: d.harnessCommit,
      direction, role, machineId: m.machineId, artifactDigest: d.artifacts[m.os], mode: 'live',
      gate, status: 'pass', processIncarnation: m.processIncarnation, sequence: steps.length * 10,
      startedAt: 1, endedAt: 2, prerequisites: prerequisiteIds(direction, gate, role),
      evidence: Object.fromEntries(GATE_FIELDS[gate].map(k => [k, true])),
      circleId: map.circleId, attemptId: job.attemptId, jobDigest: job.digest};
    if (gate === 'accounting') s.accounting = {missingFields: [], records: m.accountingResources.map(resourceId => ({
      resourceId, machineId: m.machineId, direction, circleId: map.circleId,
      attemptId: map.firstJob.attemptId, jobDigest: map.firstJob.digest,
      instanceId: m.accountingInstanceId, windowId: m.accountingWindowId,
      before: 10, after: 12, charge: 2, cap: 100,
      conversion: {numerator: 1, denominator: 1, source: 'fixture'},
    }))};
    if (gate === 'stop') {
      const owner = d.machines.find(m => m.machineId === map.owner);
      const ownerClick = role === 'owner' ? {sequence: s.sequence, machineId: owner.machineId,
        processIncarnation: owner.processIncarnation, circleId: map.circleId,
        jobDigest: map.stopJob.digest, attemptId: map.stopJob.attemptId} :
        steps.find(step => step.direction === direction && step.gate === 'stop' && step.role === 'owner').stopClick;
      s.stopClick = ownerClick;
      s.observations = ['native', 'sandbox'].map(sourceKind => ({runId: d.runId, direction,
        machineId: owner.machineId, artifactDigest: d.artifacts[owner.os], mode: 'live',
        processIncarnation: owner.processIncarnation, circleId: map.circleId,
        jobDigest: map.stopJob.digest, attemptId: map.stopJob.attemptId,
        observedSequence: ownerClick.sequence + 1, verdict: 'ceased', sourceKind}));
    }
    steps.push(s);
  }
  return {d, steps};
}
function prerequisiteIds(direction, gate, role) {
  const key = (g, r, d = direction) => `${d}-${g}-${r}`;
  const both = (g, d = direction) => ['owner', 'friend'].map(r => key(g, r, d));
  if (gate === 'artifact_install') return direction === 'B' ? both('preservation_teardown', 'A') : [];
  if (gate === 'native_open') return [key('artifact_install', role)];
  if (gate === 'os_profile') return [key('native_open', role)];
  if (gate === 'setup') return [key('os_profile', role)];
  if (gate === 'circle') return role === 'owner' ? [key('setup', 'owner')] : [key('setup', 'friend'), key('circle', 'owner')];
  if (gate === 'lend_first_job') return both('circle');
  if (gate === 'stop') return role === 'owner' ? both('lend_first_job') : [...both('lend_first_job'), key('stop', 'owner')];
  if (gate === 'accounting') return both('stop');
  if (gate === 'preservation_teardown') return role === 'owner' ? both('accounting') : [...both('accounting'), key('preservation_teardown', 'owner')];
  return [];
}
function fails(mutator) {
  const f = fixture(); mutator(f);
  assert.notEqual(reduceRun(f.d, f.steps).s9Pass, true);
}
test('complete two-direction live receipt passes without mutating input', () => {
  const {d, steps} = fixture(), before = JSON.stringify({d, steps});
  assert.equal(validateDescriptor(d).ok, true);
  const r = reduceRun(d, steps);
  assert.equal(r.contractStatus, 'complete'); assert.equal(r.s9Pass, true);
  assert.equal(r.directions.A.pass, true); assert.equal(r.directions.B.pass, true);
  assert.equal(JSON.stringify({d, steps}), before);
});
test('every mandatory evidence item on either role and direction is required', () => {
  const {steps} = fixture();
  for (let i = 0; i < steps.length; i++) for (const key of Object.keys(steps[i].evidence))
    fails(f => { delete f.steps[i].evidence[key]; });
});
test('every gate/role is mandatory; one direction cannot qualify', () => {
  for (let i = 0; i < fixture().steps.length; i++) fails(f => { f.steps.splice(i, 1); });
  fails(f => { f.steps = f.steps.filter(s => s.direction === 'A'); });
});
test('machine IDs, platform roles and swapped directions are immutable', () => {
  fails(f => { f.d.machines[1].machineId = 'mac'; });
  fails(f => { f.d.directions.A.friend = 'mac'; });
  fails(f => { f.d.directions.B = structuredClone(f.d.directions.A); });
  fails(f => { f.d.machines[0].os = 'linux'; });
});
test('malformed descriptors and records fail closed without throwing', () => {
  for (const d of [null, {}, [], 42, 'bad']) {
    const r = reduceRun(d, []); assert.equal(r.contractStatus, 'incomplete'); assert.equal(r.s9Pass, null);
  }
  for (const s of [null, {}, [], 42, 'bad']) fails(f => { f.steps.push(s); });
  fails(f => { f.steps[0].prerequisites = 42; });
  fails(f => { f.steps = null; });
});
test('each machine metadata field and valid digest/commit is required', () => {
  for (const key of Object.keys(fixture().d.machines[0])) fails(f => { delete f.d.machines[0][key]; });
  fails(f => { f.d.artifacts.darwin = 'version-1'; });
  fails(f => { f.d.harnessCommit = 'abcdef'; });
});
test('secrets and URL queries are rejected recursively without leaking values', () => {
  for (const key of ['accessToken', 'invitation', 'clientSecret', 'PASSWORD']) {
    const {d} = fixture(); d.extra = {[key]: 'never-echo-this'};
    const r = validateDescriptor(d); assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes('never-echo-this'), false);
  }
  fails(f => { f.d.url = 'https://example.test/?private=1'; });
  fails(f => { f.d.endpointUrl = '/relative?private=1'; });
  fails(f => { f.steps[0].extra = {url: 'https://example.test/?private=1'}; });
  const named = fixture();
  const diagnosticKey = 'user-supplied-diagnostic-leak-123';
  named.d.extra = {[diagnosticKey]: 'https://example.test/?private=1'};
  assert.equal(JSON.stringify(validateDescriptor(named.d)).includes(diagnosticKey), false);
  const {d} = fixture(); d.loop = d; assert.equal(validateDescriptor(d).ok, false);
});
test('foreign run, harness, direction, machine and artifact cannot pass', () => {
  for (const [key, value] of Object.entries({runId: 'old', harnessCommit: 'b'.repeat(40), direction: 'C',
    machineId: 'other', artifactDigest: hash(99), role: 'stranger'})) fails(f => { f.steps[0][key] = value; });
  fails(f => { f.steps[0].direction = 'B'; });
  for (const direction of ['__proto__', 'constructor', 'toString']) fails(f => { f.steps[0].direction = direction; });
});
test('synthetic or absent mode, unknown status, not-run, blocked and fail cannot pass', () => {
  for (const mode of ['synthetic', undefined]) fails(f => { f.steps[0].mode = mode; });
  for (const status of ['passed', undefined, 'not_run', 'blocked', 'fail']) fails(f => { f.steps[0].status = status; });
  for (const blockedCode of BLOCKED_CODES) {
    const {d, steps} = fixture(); steps[0].status = 'blocked'; steps[0].blockedCode = blockedCode;
    const r = reduceRun(d, steps); assert.notEqual(r.s9Pass, true); assert.equal(r.directions.A.blocked.length, 1);
  }
});
test('stale readiness, attempt, circle and job are rejected', () => {
  fails(f => { f.steps[0].processIncarnation = 'previous-process'; });
  for (const gate of ['lend_first_job', 'stop', 'accounting']) for (const key of ['attemptId', 'circleId', 'jobDigest'])
    fails(f => { f.steps.find(s => s.gate === gate)[key] = 'previous'; });
});
test('stop requires native AND sandbox cessation on the same owner attempt', () => {
  for (const verdict of ['active', 'unknown', undefined]) fails(f => { f.steps.find(s => s.gate === 'stop').observations[0].verdict = verdict; });
  fails(f => { f.steps.find(s => s.gate === 'stop').observations = []; });
  fails(f => { f.steps.find(s => s.gate === 'stop').observations.pop(); });
  for (const [key, value] of Object.entries({runId: 'old', direction: 'B', machineId: 'linux',
    artifactDigest: hash(99), mode: 'synthetic', attemptId: 'old', sourceKind: 'linux-proc-only'}))
    fails(f => { f.steps.find(s => s.gate === 'stop').observations[0][key] = value; });
  fails(f => { const s = f.steps.find(s => s.gate === 'stop'); s.observations.push({...s.observations[0], verdict: 'active'}); });
});
test('Stop sub-observations bind process, circle, job, and observation-after-click', () => {
  for (const [key, value] of Object.entries({processIncarnation: 'old-process', circleId: 'old-circle', jobDigest: hash(88)})) {
    const f = fixture(), stop = f.steps.find(s => s.gate === 'stop');
    stop.observations[0][key] = value;
    const r = reduceRun(f.d, f.steps);
    assert.match(r.problems.join(' '), /foreign cessation observation/);
  }
  const f = fixture(), stop = f.steps.find(s => s.gate === 'stop');
  stop.observations[0].observedSequence = stop.stopClick.sequence;
  assert.match(reduceRun(f.d, f.steps).problems.join(' '), /pre-click cessation observation/);
});
test('a completed forbidden-write audit vetoes otherwise green evidence', () => {
  const {d, steps} = fixture();
  d.writeAudit.forbiddenWrites.push({scope: 'outside_run'});
  const r = reduceRun(d, steps);
  assert.equal(r.contractStatus, 'complete');
  assert.equal(r.writeAuditPass, false);
  assert.equal(r.s9Pass, false);
});
test('operational pass is unavailable without a complete ordered prerequisite graph', () => {
  const empty = fixture();
  for (const step of empty.steps) step.prerequisites = [];
  const emptyResult = reduceRun(empty.d, empty.steps);
  assert.equal(emptyResult.contractStatus, 'incomplete');
  assert.equal(emptyResult.s9Pass, null);

  const reversed = fixture();
  for (const step of reversed.steps) step.prerequisites = [];
  for (const step of reversed.steps) step.sequence = step.direction === 'B'
    ? step.sequence : step.sequence + 100;
  const reversedResult = reduceRun(reversed.d, reversed.steps);
  assert.equal(reversedResult.contractStatus, 'incomplete');
  assert.equal(reversedResult.s9Pass, null);

  const teardown = fixture();
  for (const step of teardown.steps) step.prerequisites = [];
  teardown.steps.find(s => s.direction === 'B' && s.gate === 'artifact_install').prerequisites = [];
  assert.equal(reduceRun(teardown.d, teardown.steps).s9Pass, null);
});
test('accounting rejects missing, malformed, or cross-instance records', () => {
  for (const mutate of [
    f => { f.steps.find(s => s.gate === 'accounting').accounting.records = []; },
    f => { f.steps.find(s => s.gate === 'accounting').accounting.records.pop(); },
    f => { f.steps.find(s => s.gate === 'accounting').accounting.records[0].before = 'unknown'; },
    f => { f.steps.find(s => s.gate === 'accounting').accounting.records[0].instanceId = 'other-account'; },
  ]) {
    const f = fixture(); mutate(f);
    const r = reduceRun(f.d, f.steps);
    assert.equal(r.contractStatus, 'incomplete');
    assert.equal(r.s9Pass, null);
  }
});
test('Intel x64 Mac descriptors are rejected', () => {
  const {d} = fixture(); d.machines.find(m => m.os === 'darwin').arch = 'x64';
  assert.equal(validateDescriptor(d).ok, false);
  const r = reduceRun(d, fixture().steps);
  assert.equal(r.contractStatus, 'incomplete');
  assert.equal(r.s9Pass, null);
});
test('failed/duplicate evidence cannot be replaced by a later green receipt', () => {
  fails(f => { f.steps.push(structuredClone(f.steps[0])); });
  fails(f => { const s = structuredClone(f.steps[0]); s.id = 'retry'; s.sequence = 100; s.status = 'fail'; f.steps.unshift(s); });
});
test('prerequisites must have passed in this direction at an earlier controller sequence', () => {
  fails(f => { f.steps.find(s => s.gate === 'native_open').prerequisites = []; });
  fails(f => { f.steps[0].prerequisites = ['missing']; });
  fails(f => { f.steps.at(-1).prerequisites = [f.steps[0].id]; });
  const {d, steps} = fixture();
  assert.equal(reduceRun(d, steps).s9Pass, true);
});

test('prerequisites must complete observations before dependent steps begin', () => {
  const {d, steps} = fixture();
  for (const stop of steps.filter(s => s.gate === 'stop')) {
    for (const observation of stop.observations) observation.observedSequence = 145;
  }
  const result = reduceRun(d, steps);
  assert.notEqual(result.s9Pass, true);
  assert.match(result.problems.join(' '), /prerequisite.*completed/);
});

test('incidental attempt binding on any gate cannot reference an unrelated job', () => {
  fails(f => { f.steps[0].attemptId = 'foreign'; });
  fails(f => { f.steps[0].circleId = 'foreign'; });
});

test('hostile JSON discriminators and unknown evidence fields fail closed', () => {
  for (const key of ['direction', 'role', 'gate']) fails(f => { f.steps[0][key] = {toString: null, valueOf: null}; });
  for (const value of [false, true, 'unknown']) fails(f => { f.steps[0].evidence.unrecognizedFlag = value; });
});

test('excessively deep JSON fails closed without stack exhaustion', () => {
  const deep = JSON.parse('{"x":'.repeat(10000) + '0' + '}'.repeat(10000));
  assert.equal(validateDescriptor(deep).ok, false);
  fails(f => { f.steps[0].extra = deep; });
});

import {readFileSync} from 'node:fs';
import {reduceEvidenceContract, summarizeBuild, REQUIRED_CASE_IDS} from '../packaging/journey/build-summary.mjs';

function buildEvidenceFixture() {
  const requiredIds = ['fixture-install', 'fixture-send'];
  const catalog = requiredIds.map(id => ({id, platforms: Object.fromEntries(['linux', 'macos'].map(platform =>
    [platform, {status: 'BUILT', testId: id + '-test', fidelity: 'unit'}]))}));
  const build = {buildId: 'build-current', artifacts: {linux: hash(101), macos: hash(102)}};
  const evidence = ['linux', 'macos'].flatMap(platform => requiredIds.map(id => ({
    id, platform, buildId: build.buildId, artifactDigest: build.artifacts[platform],
    testId: id + '-test', fidelity: 'unit', collected: true,
    runs: [{ordinal: 1, status: 'pass'}],
  })));
  return {catalog, requiredIds, build, evidence};
}
const summarizeFixture = f => reduceEvidenceContract(f.catalog, f.requiredIds, f.build, f.evidence);

test('build summary: a complete fixture is ready and input is unchanged', () => {
  const f = buildEvidenceFixture(), before = JSON.stringify(f);
  const result = summarizeFixture(f);
  assert.equal(result.ready, true);
  for (const platform of ['linux', 'macos']) {
    assert.deepEqual(result.platforms[platform].collected, f.requiredIds);
    assert.deepEqual(result.platforms[platform].executed, f.requiredIds);
    assert.deepEqual(result.platforms[platform].NOT_RUN, []);
    assert.deepEqual(result.platforms[platform].NOT_BUILT, []);
  }
  assert.equal(JSON.stringify(f), before);
});
test('build summary: a missing case is named and is not ready', () => {
  const f = buildEvidenceFixture(); f.evidence.shift();
  const result = summarizeFixture(f);
  assert.equal(result.ready, false);
  assert.deepEqual(result.platforms.linux.NOT_RUN, ['fixture-install']);
});
test('build summary: a retried pass retains the first failure', () => {
  const f = buildEvidenceFixture();
  f.evidence[0].runs = [{ordinal: 1, status: 'fail'}, {ordinal: 2, status: 'pass'}];
  const result = summarizeFixture(f);
  assert.equal(result.ready, false);
  assert.deepEqual(result.platforms.linux.firstTryFailures, ['fixture-install']);
  assert.deepEqual(result.platforms.linux.retriedPasses, ['fixture-install']);
});
test('build summary: older artifact or build evidence names the missing case', () => {
  for (const [field, value] of [['artifactDigest', hash(99)], ['buildId', 'older-build']]) {
    const f = buildEvidenceFixture(); f.evidence[0][field] = value;
    const result = summarizeFixture(f);
    assert.equal(result.ready, false);
    assert.deepEqual(result.platforms.linux.NOT_RUN, ['fixture-install']);
  }
});
test('build summary: an empty run names every required case on both platforms', () => {
  const f = buildEvidenceFixture(); f.evidence = [];
  const result = summarizeFixture(f);
  assert.equal(result.ready, false);
  for (const platform of ['linux', 'macos']) assert.deepEqual(result.platforms[platform].NOT_RUN, f.requiredIds);
});
test('build summary: collection alone does not mean execution', () => {
  const f = buildEvidenceFixture(); f.evidence[0].runs = [];
  const result = summarizeFixture(f);
  assert.equal(result.ready, false);
  assert.ok(result.platforms.linux.collected.includes('fixture-install'));
  assert.ok(!result.platforms.linux.executed.includes('fixture-install'));
  assert.ok(result.platforms.linux.NOT_RUN.includes('fixture-install'));
});
test('build summary: duplicate, unknown and malformed evidence fails closed', () => {
  for (const mutate of [
    f => f.evidence.push(structuredClone(f.evidence[0])),
    f => { f.evidence[0].id = 'unknown-case'; },
    f => { f.evidence[0].platform = 'darwin'; },
    f => { f.evidence[0].runs = [{ordinal: 2, status: 'pass'}]; },
    f => { f.evidence[0].runs[0].status = 'unknown'; },
    f => { f.evidence[0].testId = 'other-test'; },
    f => { f.evidence[0].fidelity = 'installed two hosts'; },
    f => { f.evidence[0].collected = false; },
    f => { f.evidence[0].extra = 'unrecognized'; },
    f => { f.evidence = null; },
  ]) {
    const f = buildEvidenceFixture(); mutate(f);
    assert.equal(summarizeFixture(f).ready, false);
  }
});
test('build summary: missing, duplicate and empty requirements cannot pass', () => {
  for (const mutate of [
    f => { f.requiredIds = []; },
    f => { f.requiredIds.push(f.requiredIds[0]); },
    f => { f.catalog.pop(); },
    f => { f.catalog.push(structuredClone(f.catalog[0])); },
    f => { f.build.artifacts.macos = ''; },
    f => { f.build.buildId = ''; },
  ]) {
    const f = buildEvidenceFixture(); mutate(f);
    assert.equal(summarizeFixture(f).ready, false);
  }
});
test('build summary: missing implementations remain NOT_BUILT even with green data', () => {
  const f = buildEvidenceFixture();
  f.catalog[0].platforms.linux = {status: 'NOT_BUILT', reason: 'No scenario implementation'};
  const result = summarizeFixture(f);
  assert.equal(result.ready, false);
  assert.deepEqual(result.platforms.linux.NOT_BUILT, ['fixture-install']);
});
test('build summary: production policy cannot shrink requirements or promote missing proof', () => {
  const f = buildEvidenceFixture();
  const catalog = JSON.parse(readFileSync(new URL('../packaging/journey/journey-catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.cases.map(row => row.id), REQUIRED_CASE_IDS);
  const result = summarizeBuild(f.build, []);
  assert.equal(result.ready, false);
  for (const platform of ['linux', 'macos']) {
    for (const id of REQUIRED_CASE_IDS.filter(id => id.startsWith('P')))
      assert.ok(result.platforms[platform].NOT_BUILT.includes(id));
  }
  // Extra arguments are not an input route for replacing the production catalog.
  assert.equal(summarizeBuild(f.build, f.evidence, f.catalog, f.requiredIds).ready, false);
});

test('build summary: every retry blocks readiness, including two green runs', () => {
  for (const statuses of [['pass', 'pass'], ['pass', 'fail'], ['fail', 'fail']]) {
    const f = buildEvidenceFixture();
    f.evidence[0].runs = statuses.map((status, index) => ({ordinal: index + 1, status}));
    const result = summarizeFixture(f);
    assert.equal(result.ready, false);
    assert.deepEqual(result.platforms.linux.retried, ['fixture-install']);
  }
});
test('build summary: green data for every production ID cannot invent missing proofs', () => {
  const f = buildEvidenceFixture();
  const evidence = ['linux', 'macos'].flatMap(platform => REQUIRED_CASE_IDS.map(id => ({
    id, platform, buildId: f.build.buildId, artifactDigest: f.build.artifacts[platform],
    testId: id + '-invented-test', fidelity: 'installed two hosts', collected: true,
    runs: [{ordinal: 1, status: 'pass'}],
  })));
  const result = summarizeBuild(f.build, evidence);
  assert.equal(result.ready, false);
  assert.ok(result.platforms.linux.NOT_BUILT.includes('P5'));
  assert.deepEqual(result.platforms.macos.NOT_BUILT, REQUIRED_CASE_IDS);
});
