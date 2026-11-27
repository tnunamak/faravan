// Pure receipt contract, not a host observer or physical S9 certificate.
// Evidence fields attest claims from collectors. The reducer validates their bindings and order.
// A later retry needs a new descriptor; duplicate receipts cannot replace an earlier result.
export const STATUSES = Object.freeze(['pass', 'fail', 'blocked', 'not_run']);
export const BLOCKED_CODES = Object.freeze([
  'macos_launch_requires_additional_approval', 'circle_transport_unreachable',
  'missing_input', 'gui_session_unavailable', 'native_observation_unavailable',
  'endpoint_discovery_unavailable', 'cessation_evidence_unavailable',
  'provider_not_ready', 'admission_blocked', 'additional_human_step_required',
  'preservation_unverified', 'cleanup_blocked', 'missing_evidence',
]);
const fields = {
  artifact_install: ['approvedSource', 'installedManifest', 'installMode', 'destinationOwned'],
  native_open: ['normalLaunch', 'canonicalPath', 'listenerOwned', 'sessionBound', 'nativeTray', 'nativeBrowser', 'freshReadiness'],
  os_profile: ['realProfile', 'trayBackendMatch', 'approvedDataRoot'],
  setup: ['uiTrace', 'stepsComplete', 'safetyClicked', 'freshSafetyResult', 'onlyDockerSignIn', 'truthfulAccount', 'uiConsent'],
  circle: ['hostUiCreated', 'friendUiReviewed', 'specificDeviceApproved', 'lendingRemainedOff', 'crossMachineTransport'],
  lend_first_job: ['uiSettings', 'uiConsent', 'realProvider', 'realSandbox', 'submittedOnce', 'ownerExecuted', 'friendReceived'],
  stop: ['secondUiSend', 'observedRunning', 'ownerUiStop', 'acknowledged', 'ownerStopReason', 'friendOutcome', 'notCompletedBeforeClick'],
  accounting: ['typedResources', 'nonemptyResources', 'conversionKnown', 'instanceBound', 'attributionKnown'],
  preservation_teardown: ['preferencesUnchanged', 'modelsUnchanged', 'channelUnchanged', 'onlyOwnedWrites', 'ownedCloseReceipts', 'securityUnchanged'],
};
for (const value of Object.values(fields)) Object.freeze(value);
export const GATE_FIELDS = Object.freeze(fields);
export const GATES = Object.freeze(Object.keys(fields));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const roles = Object.freeze(['owner', 'friend']);
const stepKey = (direction, gate, role) => `${direction}:${gate}:${role}`;

// Diagnostics describe the kind of defect, never caller-controlled keys or values.
function privateProblems(value, seen = new Set(), depth = 0) {
  if (depth > 64) return ['input nesting exceeds 64'];
  if (typeof value === 'string') return /[a-z][a-z0-9+.-]*:\/\/[^\s]*\?/i.test(value) ? ['URL query forbidden'] : [];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return ['cyclic or reused input object forbidden'];
  seen.add(value);
  const problems = [];
  for (const [key, child] of Object.entries(value)) {
    if (/token|invitation|secret|password/i.test(key)) problems.push('secret-named field forbidden');
    else if (/url/i.test(key) && typeof child === 'string' && child.includes('?')) problems.push('URL query forbidden');
    else problems.push(...privateProblems(child, seen, depth + 1));
  }
  return problems;
}

export function validateDescriptor(d) {
  const problems = privateProblems(d);
  const require = (ok, message) => { if (!ok) problems.push(message); };
  if (!object(d)) return {ok: false, problems: [...problems, 'descriptor object required']};
  require(text(d.runId), 'runId required');
  require(typeof d.harnessCommit === 'string' && /^[a-f0-9]{40}$/.test(d.harnessCommit), 'full harnessCommit required');
  require(object(d.artifacts) && digest(d.artifacts.linux) && digest(d.artifacts.darwin), 'platform SHA-256 artifacts required');
  const audit = d.writeAudit;
  require(object(audit) && audit.complete === true && Array.isArray(audit.forbiddenWrites), 'complete forbidden-write audit required');
  const machines = Array.isArray(d.machines) ? d.machines : [];
  require(machines.length === 2, 'exactly two machines required');
  require(new Set(machines.map(m => m?.machineId)).size === 2, 'distinct machine IDs required');
  require(new Set(machines.map(m => m?.os)).size === 2 && machines.every(m => ['linux', 'darwin'].includes(m?.os)), 'one linux and one darwin required');
  for (const m of machines) {
    if (!object(m)) { problems.push('machine object required'); continue; }
    for (const key of ['machineId', 'arch', 'userIdentity', 'installIdentity', 'installDestination', 'channel', 'dataRoot',
      'guiSession', 'accountCapability', 'processIncarnation', 'accountingInstanceId', 'accountingWindowId'])
      require(text(m[key]), 'required machine metadata missing');
    require(Array.isArray(m.accountingResources) && m.accountingResources.length > 0 &&
      m.accountingResources.every(text) && new Set(m.accountingResources).size === m.accountingResources.length,
    'distinct expected accounting resources required');
    require(object(m.resourceLimits) && Object.keys(m.resourceLimits).length > 0 &&
      Object.values(m.resourceLimits).every(n => Number.isFinite(n) && n > 0), 'positive finite resourceLimits required');
    if (m.os === 'darwin') require(m.arch === 'arm64', 'S9 Mac must be Apple silicon');
  }
  const ids = machines.map(m => m?.machineId), attempts = [], jobs = [], circles = [];
  for (const direction of ['A', 'B']) {
    const map = d.directions?.[direction];
    if (!object(map)) { problems.push('direction role mapping required'); continue; }
    require(ids.includes(map.owner) && ids.includes(map.friend) && map.owner !== map.friend, 'distinct known role machines required');
    require(text(map.circleId), 'direction circle required'); circles.push(map.circleId);
    for (const kind of ['firstJob', 'stopJob']) {
      require(text(map[kind]?.attemptId) && digest(map[kind]?.digest), 'direction job binding required');
      attempts.push(map[kind]?.attemptId); jobs.push(map[kind]?.digest);
    }
  }
  const a = d.directions?.A, b = d.directions?.B;
  require(a?.owner === b?.friend && a?.friend === b?.owner, 'A/B roles must be swapped');
  require(machines.find(m => m?.machineId === a?.owner)?.os === 'darwin', 'A owner must be darwin');
  require(new Set(attempts).size === 4 && new Set(jobs).size === 4, 'four distinct jobs and attempts required');
  require(new Set(circles).size === 2, 'distinct direction circles required');
  return {ok: problems.length === 0, problems};
}

function prerequisiteKeys(direction, gate, role) {
  const key = (g, r, d = direction) => stepKey(d, g, r);
  const both = (g, d = direction) => roles.map(r => key(g, r, d));
  if (gate === 'artifact_install') return direction === 'B' ? both('preservation_teardown', 'A') : [];
  if (gate === 'native_open') return [key('artifact_install', role)];
  if (gate === 'os_profile') return [key('native_open', role)];
  if (gate === 'setup') return [key('os_profile', role)];
  if (gate === 'circle') return role === 'owner'
    ? [key('setup', 'owner')]
    : [key('setup', 'friend'), key('circle', 'owner')];
  if (gate === 'lend_first_job') return both('circle');
  if (gate === 'stop') return role === 'owner'
    ? both('lend_first_job')
    : [...both('lend_first_job'), key('stop', 'owner')];
  if (gate === 'accounting') return both('stop');
  if (gate === 'preservation_teardown') return role === 'owner'
    ? both('accounting')
    : [...both('accounting'), key('preservation_teardown', 'owner')];
  return [];
}

function completionSequence(step) {
  return (step.observations ?? []).reduce((latest, observation) =>
    Number.isSafeInteger(observation?.observedSequence) ? Math.max(latest, observation.observedSequence) : latest,
  step.sequence);
}

function validateAccounting(snapshot, machine, direction, mapping) {
  const problems = [];
  if (!object(snapshot) || !Array.isArray(snapshot.records) || snapshot.records.length === 0 ||
      !Array.isArray(snapshot.missingFields) || snapshot.missingFields.length !== 0)
    return ['typed nonempty accounting snapshot required'];
  const job = mapping.firstJob;
  const seen = new Set();
  for (const record of snapshot.records) {
    const valid = object(record) && text(record.resourceId) &&
      record.machineId === machine.machineId && record.direction === direction &&
      record.circleId === mapping.circleId && record.attemptId === job.attemptId && record.jobDigest === job.digest &&
      record.instanceId === machine.accountingInstanceId && record.windowId === machine.accountingWindowId &&
      ['before', 'after', 'charge', 'cap'].every(k => Number.isFinite(record[k]) && record[k] >= 0) &&
      record.after >= record.before && record.cap > 0 && machine.accountingResources.includes(record.resourceId) &&
      object(record.conversion) && Number.isFinite(record.conversion.numerator) && record.conversion.numerator > 0 &&
      Number.isFinite(record.conversion.denominator) && record.conversion.denominator > 0 && text(record.conversion.source);
    if (!valid) problems.push('malformed or foreign accounting record');
    else {
      const resourceKey = `${record.resourceId}:${record.instanceId}:${record.windowId}`;
      if (seen.has(resourceKey)) problems.push('duplicate accounting resource record');
      seen.add(resourceKey);
    }
  }
  for (const resourceId of machine.accountingResources) {
    if (!seen.has(`${resourceId}:${machine.accountingInstanceId}:${machine.accountingWindowId}`))
      problems.push('expected accounting resource record missing');
  }
  return problems;
}

// StepRecord includes immutable run/machine bindings, a controller sequence and the exact prerequisite IDs.
// Stop receipts include stopClick:{sequence,machineId,processIncarnation,circleId,jobDigest,attemptId} and
// observations with the same bindings plus observedSequence. Accounting receipts carry typed records.
// contractStatus is incomplete until every receipt and evidence contract is present and valid; s9Pass is then boolean.
export function reduceRun(descriptor, steps) {
  const validation = validateDescriptor(descriptor), problems = [...validation.problems];
  const directions = Object.fromEntries(['A', 'B'].map(d => [d, {pass: false, missing: [], failed: [], blocked: []}]));
  const rows = Array.isArray(steps) ? steps : [];
  if (!Array.isArray(steps)) problems.push('steps array required');
  if (!validation.ok) return {
    contractStatus: 'incomplete', s9Pass: null, directions, problems,
  };

  const stepIds = new Map();
  for (const row of rows) {
    if (!object(row) || !['A', 'B'].includes(row.direction) || !roles.includes(row.role) || !GATES.includes(row.gate) || !text(row.id)) continue;
    const key = stepKey(row.direction, row.gate, row.role);
    if (!stepIds.has(key)) stepIds.set(key, row.id);
  }
  const seen = new Set(), accepted = new Map(), sequences = new Set();
  const ordered = [...rows].sort((a, b) => (Number.isSafeInteger(a?.sequence) ? a.sequence : Number.MAX_SAFE_INTEGER) -
    (Number.isSafeInteger(b?.sequence) ? b.sequence : Number.MAX_SAFE_INTEGER));
  for (const s of ordered) {
    const errors = privateProblems(s);
    if (!object(s) || !['A', 'B'].includes(s.direction) || !roles.includes(s.role) || !GATES.includes(s.gate)) {
      problems.push('unrecognized step direction/role/gate'); continue;
    }
    const dir = directions[s.direction], key = s.gate + ':' + s.role;
    const mapping = descriptor.directions[s.direction];
    const machine = descriptor.machines.find(m => m.machineId === mapping[s.role]);
    const require = (ok, message) => { if (!ok) errors.push(message); };
    require(text(s.id) && !seen.has(s.id), 'unique step id required'); seen.add(s.id);
    require(s.runId === descriptor.runId && s.harnessCommit === descriptor.harnessCommit, 'foreign run/harness');
    require(machine && s.machineId === machine.machineId && s.artifactDigest === descriptor.artifacts?.[machine.os], 'machine/artifact mismatch');
    require(s.mode === 'live', 'live mode required');
    require(STATUSES.includes(s.status), 'unknown status');
    require(Number.isSafeInteger(s.sequence) && s.sequence >= 0 && !sequences.has(s.sequence), 'unique controller sequence required');
    sequences.add(s.sequence);
    require(Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt) && s.startedAt >= 0 && s.endedAt >= s.startedAt, 'bounded local times required');
    require(Array.isArray(s.prerequisites), 'prerequisites required');
    const expectedIds = prerequisiteKeys(s.direction, s.gate, s.role).map(k => stepIds.get(k));
    require(expectedIds.every(Boolean) && Array.isArray(s.prerequisites) &&
      s.prerequisites.length === expectedIds.length && expectedIds.every(id => s.prerequisites.includes(id)), 'required prerequisite graph missing or incorrect');
    for (const id of Array.isArray(s.prerequisites) ? s.prerequisites : []) {
      const prior = accepted.get(id);
      require(prior && completionSequence(prior) < s.sequence && (prior.direction === s.direction ||
        s.direction === 'B' && prior.direction === 'A' && prior.gate === 'preservation_teardown'),
      'prerequisite missing, failed, foreign, or not completed before dependent step');
    }
    require(s.processIncarnation === machine?.processIncarnation, 'stale process/readiness');
    if (s.circleId !== undefined || ['circle', 'lend_first_job', 'stop', 'accounting'].includes(s.gate)) require(s.circleId === mapping.circleId, 'foreign circle');
    if (!['lend_first_job', 'stop', 'accounting'].includes(s.gate) && (s.attemptId !== undefined || s.jobDigest !== undefined)) {
      require([mapping.firstJob, mapping.stopJob].some(j => j.attemptId === s.attemptId && j.digest === s.jobDigest), 'foreign incidental attempt or job');
    }
    if (['lend_first_job', 'stop', 'accounting'].includes(s.gate)) {
      const job = mapping[s.gate === 'stop' ? 'stopJob' : 'firstJob'];
      require(s.attemptId === job?.attemptId && s.jobDigest === job?.digest, 'foreign/stale attempt or job');
    }
    require(s.observations === undefined || s.gate === 'stop', 'observations only allowed on Stop');
    if (s.status === 'pass') {
      require(object(s.evidence) && GATE_FIELDS[s.gate].every(k => s.evidence[k] === true) &&
        Object.keys(s.evidence).every(k => GATE_FIELDS[s.gate].includes(k)), 'missing mandatory gate evidence');
      if (s.gate === 'stop') {
        const owner = descriptor.machines.find(m => m.machineId === mapping.owner);
        const ownerStop = stepIds.get(stepKey(s.direction, 'stop', 'owner'));
        const ownerStopRow = rows.find(row => row?.id === ownerStop);
        const click = s.stopClick;
        require(object(click) && Number.isSafeInteger(click.sequence) && click.sequence === ownerStopRow?.sequence &&
          click.machineId === owner?.machineId && click.processIncarnation === owner?.processIncarnation &&
          click.circleId === mapping.circleId && click.jobDigest === mapping.stopJob.digest &&
          click.attemptId === mapping.stopJob.attemptId && s.sequence >= click.sequence, 'owner Stop click binding required');
        require(object(ownerStopRow?.stopClick) && object(click) &&
          ['sequence', 'machineId', 'processIncarnation', 'circleId', 'jobDigest', 'attemptId'].every(k => click[k] === ownerStopRow.stopClick[k]), 'Stop click differs from owner receipt');
        const observations = Array.isArray(s.observations) ? s.observations : [];
        require(observations.length > 0, 'cessation observations required');
        for (const observation of observations) {
          require(observation?.runId === descriptor.runId && observation?.direction === s.direction &&
            observation?.machineId === owner?.machineId && observation?.artifactDigest === descriptor.artifacts?.[owner?.os] &&
            observation?.mode === 'live' && observation?.processIncarnation === owner?.processIncarnation &&
            observation?.circleId === mapping.circleId && observation?.jobDigest === mapping.stopJob.digest &&
            observation?.attemptId === mapping.stopJob.attemptId, 'foreign cessation observation');
          require(Number.isSafeInteger(observation?.observedSequence) && observation.observedSequence > click?.sequence &&
            observation?.verdict === 'ceased' && ['native', 'sandbox'].includes(observation?.sourceKind), 'active, unknown, or pre-click cessation observation');
        }
        require(observations.some(o => o?.sourceKind === 'sandbox') && observations.some(o => o?.sourceKind === 'native'), 'native AND sandbox cessation required');
      }
      if (s.gate === 'accounting') {
        errors.push(...validateAccounting(s.accounting, machine, s.direction, mapping));
      }
    }
    if (s.status === 'blocked') require(BLOCKED_CODES.includes(s.blockedCode), 'unknown blocked code');
    if (dir._seen?.has(key)) errors.push('duplicate gate/role receipt');
    (dir._seen ??= new Set()).add(key);
    if (errors.length) { dir.failed.push(key); problems.push(...errors.map(e => s.direction + '/' + key + ': ' + e)); }
    else if (s.status === 'fail') dir.failed.push(key);
    else if (s.status !== 'pass') dir.blocked.push(key);
    else { (dir._passed ??= new Set()).add(key); accepted.set(s.id, s); }
  }
  for (const dir of Object.values(directions)) {
    for (const gate of GATES) for (const role of roles) if (!dir._passed?.has(gate + ':' + role)) dir.missing.push(gate + ':' + role);
    dir.pass = validation.ok && !dir.missing.length && !dir.failed.length && !dir.blocked.length;
  }
  const receiptCount = GATES.length * roles.length;
  const contractComplete = problems.length === 0 && Object.values(directions).every(dir => dir._seen?.size === receiptCount);
  for (const dir of Object.values(directions)) { delete dir._seen; delete dir._passed; }
  const noForbiddenWrites = descriptor.writeAudit.forbiddenWrites.length === 0;
  return {
    contractStatus: contractComplete ? 'complete' : 'incomplete',
    s9Pass: contractComplete ? noForbiddenWrites && directions.A.pass && directions.B.pass : null,
    writeAuditPass: noForbiddenWrites,
    directions,
    problems,
  };
}
