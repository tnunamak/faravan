// Two-direction circle/job orchestration for the S9 two-computer journey.
//
// Pure state machine over injected ports. It runs direction A (Mac owner,
// Linux friend), then direction B with the roles swapped, builds the run
// record that reduceRun in ./two-computer.mjs accepts, and returns that
// reducer's verdict unchanged, plus two extra fields:
//
//   blockedCode: the exact code of the step the run stopped at, or null.
//   stoppedAt:   {direction, gate, role} of that step, or null.
//
// The run stops at the first blocked or failed step and never retries
// through another path. There is no "force lend", "approve through API" or
// "repair setup" port: a port that returns {status: 'blocked', code} ends
// the run with that code, and a port that errors or returns an unexpected
// shape ends the run with a failed step.
//
// Ports (all injected; no network, browser, SSH or real account here):
// - descriptor: the run descriptor validated by validateDescriptor.
// - hosts: machineId -> host adapter with the createHostAdapter interface
//   (verify, install, open, endpoint, facts, close). A result of
//   {status: 'ok' | 'preflight', ...} attests the gate's evidence; a
//   result of {status: 'blocked', code} stops the run with that code.
// - ui: role-parameterized UI-action port: invite, join, lend, submitJob,
//   stop, each taking (role, endpoint) and returning the same status shape.
// - observe(query): returns typed snapshots for a gate. A snapshot is
//   {status: 'ok' | 'blocked' | 'fail', code?, kind, ...fields}. The
//   query is {direction, gate, role, machineId, sequence, phase?}.
// - clock: {now()} returning a finite millisecond timestamp.
//
// Ordering is by controller sequence only. Host timestamps carried by
// snapshots (hostTime) are never used for ordering; a snapshot whose host
// clock runs backwards for the same machine is rejected with
// clock_skew_ordering. Invitation tokens live only in memory (local
// variables) and never enter the returned record: step records carry no
// token, invitation or digest field.
//
// Rejections detected by the orchestrator itself (not merely reported by
// a port):
// - circle_transport_unreachable: the advertised circle address is not
//   reachable from the friend machine.
// - ui_endpoint_controller_only: the handed-off UI endpoint is reachable
//   only from the controller, not from its own host machine.
// - invitation_rewritten: the invitation the friend joined with differs
//   from the one the owner issued.
// - approval_wrong_device: the approved device is not the friend machine,
//   or the approval never names a device at all.
// - receipt_from_earlier_direction: a snapshot, job or receipt belonging
//   to the other direction arrives during this direction.
// - stale_token: a join presents a token issued in an earlier direction.
// - stale_port: a host hands off the same endpoint it used in the earlier
//   direction.
// - clock_skew_ordering: a host clock runs backwards for the same machine.
// A blocked host adapter stops the run with that adapter's exact code.
//
// Evidence rules (pr93 revise): every observed identity field is compared
// to the expected binding and the run stops on any mismatch; snapshots must
// carry their gate's kind and the queried machine, and approval must name
// the friend device. `preflight` is a verification-only status: install,
// open and every other port call require `ok`. A gate field attested by a
// snapshot must be the boolean true, except setup's uiTrace, which a
// non-empty trace string attests; any other string (including 'false' or
// 'not observed') is not an attestation. Install/open gate fields carried
// by a port result or endpoint observation must be strictly true when
// present; a present false value stops the run. Invitation tokens and
// digests are checked against every earlier direction independently of
// whether the two sides agree. Endpoint identity is compared with the URL
// fragment stripped, so the same listener under a different fragment is
// still the same endpoint. Stop observations keep the raw observed
// identities and order; a supplied observedSequence must be after the Stop
// click, and a missing one is assigned from controller sequence.
//
// Environment note: this module never reads, sets or forwards HOME,
// XDG_* or USERPROFILE. It performs no environment mutation at all.
//
// Known gap (port, not implementation): the ui port has no "stop lending"
// or "close circle" action, so preservation/teardown is the host close
// plus a preservation observation; lending-off and circle-close through
// the UI are not exercised here.

import {reduceRun, validateDescriptor, GATE_FIELDS} from './two-computer.mjs';

export const ORCHESTRATION_CODES = Object.freeze({
  circleTransportUnreachable: 'circle_transport_unreachable',
  uiEndpointControllerOnly: 'ui_endpoint_controller_only',
  invitationRewritten: 'invitation_rewritten',
  approvalWrongDevice: 'approval_wrong_device',
  receiptFromEarlierDirection: 'receipt_from_earlier_direction',
  staleToken: 'stale_token',
  stalePort: 'stale_port',
  clockSkewOrdering: 'clock_skew_ordering',
  missingEvidence: 'missing_evidence',
});

const DIRECTIONS = ['A', 'B'];
const ROLES = ['owner', 'friend'];

// Gate fields attested by a non-empty string rather than the boolean true.
// Currently only setup's uiTrace: the trace reference itself is the
// attestation. Every other gate field requires the boolean true.
const TRACE_FIELDS = new Set(['uiTrace']);

// The closed kind envelope for each observed snapshot. Stop snapshots vary
// by phase; observations nested inside a snapshot carry no kind of their
// own and are checked on identity only.
const SNAPSHOT_KINDS = {
  native_open: 'ui-endpoint',
  setup: 'setup',
  circle: 'circle',
  lend_first_job: 'lend',
  accounting: 'accounting',
  preservation_teardown: 'preservation',
};
const STOP_KINDS = {
  running: 'stop-running',
  cessation: 'stop-cessation',
  outcome: 'stop-outcome',
};

// Endpoint identity ignores the URL fragment: a fragment does not change
// the network listener or port, so the same endpoint under a different
// fragment is still the same endpoint (pr93 F5).
const canonicalEndpoint = value =>
  (typeof value === 'string' ? value.split('#')[0] : value);

class StopJourney extends Error {
  constructor({direction, gate, role, startedAt, status, code}) {
    super(code ?? status);
    this.direction = direction;
    this.gate = gate;
    this.role = role;
    this.startedAt = startedAt;
    this.status = status;
    this.code = code ?? null;
  }
}

const otherDirection = direction => (direction === 'A' ? 'B' : 'A');

function prerequisiteKeys(direction, gate, role) {
  const key = (g, r, d = direction) => `${d}:${g}:${r}`;
  const both = (g, d = direction) => ['owner', 'friend'].map(r => key(g, r, d));
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

export async function runTwoComputerJourney({descriptor, hosts, ui, observe, clock}) {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError('descriptor required');
  if (!hosts || typeof hosts !== 'object') throw new TypeError('hosts required');
  if (!ui || typeof ui !== 'object') throw new TypeError('ui required');
  if (typeof observe !== 'function') throw new TypeError('observe required');
  for (const name of ['invite', 'join', 'lend', 'submitJob', 'stop']) {
    if (typeof ui[name] !== 'function') throw new TypeError(`ui.${name} required`);
  }

  const now = () => {
    const t = clock && typeof clock.now === 'function' ? clock.now() : Date.now();
    return Number.isFinite(t) ? t : Date.now();
  };

  const validation = validateDescriptor(descriptor);
  if (!validation.ok) {
    const verdict = reduceRun(descriptor, []);
    return {...verdict, blockedCode: null, stoppedAt: null};
  }
  for (const machine of descriptor.machines) {
    const host = hosts[machine.machineId];
    if (!host || !['verify', 'install', 'open', 'endpoint', 'facts', 'close']
      .every(name => typeof host[name] === 'function')) {
      throw new TypeError(`host adapter missing for ${machine.machineId}`);
    }
  }

  const steps = [];
  const stepIds = new Map();
  let sequence = 0;
  const nextSeq = () => sequence++;
  const hostTimes = new Map();
  const endpointsByMachine = new Map();
  const tokensByDirection = new Map();
  const digestsByDirection = new Map();

  const machineFor = (direction, role) =>
    descriptor.machines.find(m => m.machineId === descriptor.directions[direction][role]);

  const block = (direction, gate, role, startedAt, code) =>
    new StopJourney({direction, gate, role, startedAt, status: 'blocked', code});
  const fail = (direction, gate, role, startedAt) =>
    new StopJourney({direction, gate, role, startedAt, status: 'fail', code: null});

  // A port call that throws is a failed step, never a reason to retry.
  async function attempt(fn) {
    try {
      return await fn();
    } catch {
      return {status: 'fail'};
    }
  }

  // Every observed identity field is compared to the expected binding and
  // the run stops on any mismatch (pr93 F1). Fields the authored fixture
  // never carries (runId, artifactDigest, processIncarnation, mode) are
  // checked when present; kind and machineId are part of the closed
  // envelope and are always required on snapshots (expectedKind null skips
  // the kind check for observations nested inside a snapshot, which carry
  // no kind of their own). Nothing here is repaired from expectation: a
  // mismatched value fails the step instead of being rebound.
  function checkBindings(value, direction, gate, role, startedAt, expectedKind = null,
    expectedMachineId = null) {
    if (!value || typeof value !== 'object') return;
    if (value.direction !== undefined && value.direction !== direction) {
      if (value.direction === otherDirection(direction)) {
        throw block(direction, gate, role, startedAt, ORCHESTRATION_CODES.receiptFromEarlierDirection);
      }
      throw fail(direction, gate, role, startedAt);
    }
    const map = descriptor.directions[direction];
    const other = descriptor.directions[otherDirection(direction)];
    // The expected machine is the machine that was queried, not the
    // context role: several gates observe the friend side under the
    // owner's step context.
    const expectedMachine = (expectedMachineId !== null
      ? descriptor.machines.find(m => m.machineId === expectedMachineId)
      : undefined) ?? machineFor(direction, role);
    if (value.machineId !== expectedMachine.machineId) {
      throw fail(direction, gate, role, startedAt);
    }
    if (value.runId !== undefined && value.runId !== descriptor.runId) {
      throw fail(direction, gate, role, startedAt);
    }
    if (value.artifactDigest !== undefined &&
        value.artifactDigest !== descriptor.artifacts[expectedMachine.os]) {
      throw fail(direction, gate, role, startedAt);
    }
    if (value.processIncarnation !== undefined &&
        value.processIncarnation !== expectedMachine.processIncarnation) {
      throw fail(direction, gate, role, startedAt);
    }
    if (value.mode !== undefined && value.mode !== 'live') {
      throw fail(direction, gate, role, startedAt);
    }
    if (expectedKind !== null && value.kind !== expectedKind) {
      throw fail(direction, gate, role, startedAt);
    }
    if (value.circleId !== undefined && value.circleId !== map.circleId) {
      if (value.circleId === other.circleId) {
        throw block(direction, gate, role, startedAt, ORCHESTRATION_CODES.receiptFromEarlierDirection);
      }
      throw fail(direction, gate, role, startedAt);
    }
    if (value.attemptId !== undefined || value.jobDigest !== undefined) {
      const mine = [map.firstJob, map.stopJob]
        .some(job => job.attemptId === value.attemptId && job.digest === value.jobDigest);
      const theirs = [other.firstJob, other.stopJob]
        .some(job => job.attemptId === value.attemptId && job.digest === value.jobDigest);
      if (!mine) {
        if (theirs) {
          throw block(direction, gate, role, startedAt, ORCHESTRATION_CODES.receiptFromEarlierDirection);
        }
        throw fail(direction, gate, role, startedAt);
      }
    }
  }

  function checkHostTime(machineId, hostTime, direction, gate, role, startedAt) {
    if (!Number.isFinite(hostTime)) return;
    const last = hostTimes.get(machineId);
    if (last !== undefined && hostTime < last) {
      throw block(direction, gate, role, startedAt, ORCHESTRATION_CODES.clockSkewOrdering);
    }
    hostTimes.set(machineId, hostTime);
  }

  async function observeChecked(query, context) {
    const {direction, gate, role, startedAt} = context;
    const snapshot = await attempt(() => observe(query));
    if (!snapshot || typeof snapshot !== 'object') throw fail(direction, gate, role, startedAt);
    const expectedKind = gate === 'stop'
      ? STOP_KINDS[query.phase] ?? null
      : SNAPSHOT_KINDS[gate] ?? null;
    checkBindings(snapshot, direction, gate, role, startedAt, expectedKind, query.machineId);
    checkHostTime(query.machineId, snapshot.hostTime, direction, gate, role, startedAt);
    if (Array.isArray(snapshot.observations)) {
      for (const observation of snapshot.observations) {
        checkBindings(observation, direction, gate, role, startedAt, null, query.machineId);
        checkHostTime(
          observation.machineId ?? query.machineId, observation.hostTime,
          direction, gate, role, startedAt);
      }
    }
    return snapshot;
  }

  function newStep(direction, gate, role, startedAt) {
    const machine = machineFor(direction, role);
    const map = descriptor.directions[direction];
    const job = map[gate === 'stop' ? 'stopJob' : 'firstJob'];
    return {
      id: `${descriptor.runId}:${direction}:${gate}:${role}`,
      runId: descriptor.runId,
      harnessCommit: descriptor.harnessCommit,
      direction,
      role,
      machineId: machine.machineId,
      artifactDigest: descriptor.artifacts[machine.os],
      mode: 'live',
      gate,
      processIncarnation: machine.processIncarnation,
      sequence: nextSeq(),
      startedAt,
      endedAt: startedAt,
      prerequisites: prerequisiteKeys(direction, gate, role).map(k => stepIds.get(k)),
      circleId: map.circleId,
      attemptId: job.attemptId,
      jobDigest: job.digest,
    };
  }

  function completeStep(step, status, extra = {}) {
    step.status = status;
    if (status === 'pass') {
      step.evidence = Object.fromEntries(GATE_FIELDS[step.gate].map(k => [k, true]));
    }
    Object.assign(step, extra);
    step.endedAt = now();
    steps.push(step);
    stepIds.set(`${step.direction}:${step.gate}:${step.role}`, step.id);
    return step;
  }

  // A port result of {status: 'blocked', code} stops the run with that
  // exact code; anything other than ok is a failed step. `preflight` is a
  // verification-only status (pr93 F2): it attests hash/existence checks,
  // not a completed install or launch, so only host.verify may return it.
  function requireOk(result, direction, gate, role, startedAt, {allowPreflight = false} = {}) {
    if (result && result.status === 'blocked') {
      if (typeof result.code === 'string' && result.code.length > 0) {
        throw block(direction, gate, role, startedAt, result.code);
      }
      throw fail(direction, gate, role, startedAt);
    }
    if (!result || result.status !== 'ok' && !(allowPreflight && result.status === 'preflight')) {
      throw fail(direction, gate, role, startedAt);
    }
    return result;
  }

  function requireSnapshotOk(snapshot, direction, gate, role, startedAt) {
    if (snapshot.status === 'blocked') {
      if (typeof snapshot.code === 'string' && snapshot.code.length > 0) {
        throw block(direction, gate, role, startedAt, snapshot.code);
      }
      throw fail(direction, gate, role, startedAt);
    }
    if (snapshot.status !== 'ok') throw fail(direction, gate, role, startedAt);
    return snapshot;
  }

  // A gate field is attested only by the boolean true, except the fields in
  // TRACE_FIELDS, which a non-empty string (the trace reference itself)
  // attests (pr93 F3). Any other string — including 'false' or
  // 'not observed' — is not an attestation, and neither is a missing or
  // false value. Receipt fields therefore come only from matching observed
  // fields; a missing or false observation stays false and blocks.
  function requireEvidenceFields(sources, gate, direction, role, startedAt) {
    for (const field of GATE_FIELDS[gate]) {
      const attested = sources.some(source => source &&
        (source[field] === true ||
          (TRACE_FIELDS.has(field) && typeof source[field] === 'string' &&
            source[field].trim().length > 0)));
      if (!attested) {
        throw fail(direction, gate, role, startedAt);
      }
    }
  }

  // Install/open gate fields carried by a port result or endpoint
  // observation must be strictly true when present (pr93 F2/F3): an
  // explicitly false (or string) install/open fact stops the run instead
  // of being overwritten by an all-true receipt. Fields the port does not
  // report at all are attested by the port's `ok` status itself.
  function requireObservedGateFields(sources, gate, direction, role, startedAt) {
    for (const field of GATE_FIELDS[gate]) {
      for (const source of sources) {
        if (source && source[field] !== undefined && source[field] !== true) {
          throw fail(direction, gate, role, startedAt);
        }
      }
    }
  }

  async function runDirection(direction) {
    const map = descriptor.directions[direction];
    const other = descriptor.directions[otherDirection(direction)];
    const ownerMachine = machineFor(direction, 'owner');
    const friendMachine = machineFor(direction, 'friend');
    const ownerHost = hosts[ownerMachine.machineId];
    const friendHost = hosts[friendMachine.machineId];
    const endpoints = {};

    // Per-role host bring-up: install, open, profile, setup.
    for (const role of ROLES) {
      const machine = machineFor(direction, role);
      const host = hosts[machine.machineId];

      const installAt = now();
      const verified = requireOk(
        await attempt(() => host.verify()), direction, 'artifact_install', role, installAt,
        {allowPreflight: true});
      if (verified.identity?.machineId !== machine.machineId ||
          verified.identity?.installDigest !== descriptor.artifacts[machine.os]) {
        throw fail(direction, 'artifact_install', role, installAt);
      }
      // A preflight-only install is not a completed install (pr93 F2):
      // install requires status 'ok', and any install gate field the
      // result carries must be strictly true.
      const installed = requireOk(
        await attempt(() => host.install()), direction, 'artifact_install', role, installAt);
      requireObservedGateFields(
        [verified, installed], 'artifact_install', direction, role, installAt);
      completeStep(newStep(direction, 'artifact_install', role, installAt), 'pass');

      const openAt = now();
      const opened = requireOk(
        await attempt(() => host.open()), direction, 'native_open', role, openAt);
      if (opened.identity?.processIncarnation !== machine.processIncarnation) {
        throw fail(direction, 'native_open', role, openAt);
      }
      const endpointResult = requireOk(
        await attempt(() => host.endpoint()), direction, 'native_open', role, openAt);
      if (typeof endpointResult.endpoint !== 'string' || endpointResult.endpoint.length === 0) {
        throw fail(direction, 'native_open', role, openAt);
      }
      const endpoint = endpointResult.endpoint;
      const previousEndpoint = endpointsByMachine.get(machine.machineId);
      if (previousEndpoint !== undefined &&
          canonicalEndpoint(previousEndpoint) === canonicalEndpoint(endpoint)) {
        throw block(direction, 'native_open', role, openAt, ORCHESTRATION_CODES.stalePort);
      }
      endpoints[role] = endpoint;
      endpointsByMachine.set(machine.machineId, endpoint);
      const endpointSnap = requireSnapshotOk(await observeChecked(
        {direction, gate: 'native_open', role, machineId: machine.machineId, sequence},
        {direction, gate: 'native_open', role, startedAt: openAt}),
      direction, 'native_open', role, openAt);
      if (endpointSnap.endpoint !== undefined &&
          canonicalEndpoint(endpointSnap.endpoint) !== canonicalEndpoint(endpoint)) {
        throw block(direction, 'native_open', role, openAt, ORCHESTRATION_CODES.stalePort);
      }
      // Native-open gate fields carried by the open result or the endpoint
      // observation must be strictly true when present (pr93 F2): an
      // explicitly false native fact stops the run.
      requireObservedGateFields(
        [opened, endpointResult, endpointSnap], 'native_open', direction, role, openAt);
      if (!Array.isArray(endpointSnap.reachableFrom) ||
          !endpointSnap.reachableFrom.includes(machine.machineId)) {
        throw block(direction, 'native_open', role, openAt, ORCHESTRATION_CODES.uiEndpointControllerOnly);
      }
      completeStep(newStep(direction, 'native_open', role, openAt), 'pass');

      const profileAt = now();
      const factsResult = requireOk(
        await attempt(() => host.facts()), direction, 'os_profile', role, profileAt);
      const facts = factsResult.facts ?? factsResult;
      for (const field of GATE_FIELDS.os_profile) {
        if (facts[field] !== true) throw fail(direction, 'os_profile', role, profileAt);
      }
      if (facts.processIncarnation !== undefined &&
          facts.processIncarnation !== machine.processIncarnation) {
        throw fail(direction, 'os_profile', role, profileAt);
      }
      completeStep(newStep(direction, 'os_profile', role, profileAt), 'pass');

      const setupAt = now();
      const setupSnap = requireSnapshotOk(await observeChecked(
        {direction, gate: 'setup', role, machineId: machine.machineId, sequence},
        {direction, gate: 'setup', role, startedAt: setupAt}),
      direction, 'setup', role, setupAt);
      requireEvidenceFields([setupSnap], 'setup', direction, role, setupAt);
      completeStep(newStep(direction, 'setup', role, setupAt), 'pass');
    }

    // Circle: invite on the owner UI, join on the friend UI, then observe
    // both sides. The owner circle step is recorded only once the whole
    // exchange validates, because its evidence (friend review, specific
    // device approval) is the exchange itself; a failed exchange blocks
    // the owner step with the exchange's exact code.
    const circleAt = now();
    const invited = requireOk(
      await attempt(() => ui.invite('owner', endpoints.owner)),
      direction, 'circle', 'owner', circleAt);
    const invitation = invited.invitation;
    if (!invitation || typeof invitation !== 'object' || invitation.circleId !== map.circleId) {
      throw fail(direction, 'circle', 'owner', circleAt);
    }
    const joined = requireOk(
      await attempt(() => ui.join('friend', endpoints.friend)),
      direction, 'circle', 'owner', circleAt);
    if (!joined.joined || typeof joined.joined !== 'object' ||
        joined.joined.circleId !== map.circleId) {
      throw fail(direction, 'circle', 'owner', circleAt);
    }
    // Tokens stay in memory; only their (in)equality is ever compared.
    // The invitation must carry token and digest evidence, and the join
    // must echo them. Either side reusing an earlier direction's token or
    // digest is stale whether or not the two sides agree (pr93 F4): the
    // reuse check runs independently of the equality check below.
    if (typeof invitation.token !== 'string' || invitation.token.length === 0 ||
        typeof invitation.digest !== 'string' || invitation.digest.length === 0 ||
        typeof joined.joined.token !== 'string' || joined.joined.token.length === 0 ||
        typeof joined.joined.digest !== 'string' || joined.joined.digest.length === 0) {
      throw fail(direction, 'circle', 'owner', circleAt);
    }
    if ([...tokensByDirection.values()].includes(invitation.token) ||
        [...tokensByDirection.values()].includes(joined.joined.token) ||
        [...digestsByDirection.values()].includes(invitation.digest) ||
        [...digestsByDirection.values()].includes(joined.joined.digest)) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.staleToken);
    }
    if (joined.joined.token !== invitation.token) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.invitationRewritten);
    }
    if (joined.joined.digest !== invitation.digest) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.invitationRewritten);
    }
    // The approval must name the friend device (pr93 F1): a join that
    // never names a device is not an approval of this device.
    if (joined.joined.deviceId !== friendMachine.machineId) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.approvalWrongDevice);
    }
    const ownerCircleSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'circle', role: 'owner', machineId: ownerMachine.machineId, sequence},
      {direction, gate: 'circle', role: 'owner', startedAt: circleAt}),
    direction, 'circle', 'owner', circleAt);
    const friendCircleSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'circle', role: 'friend', machineId: friendMachine.machineId, sequence},
      {direction, gate: 'circle', role: 'owner', startedAt: circleAt}),
    direction, 'circle', 'owner', circleAt);
    if (friendCircleSnap.address !== undefined && invitation.address !== undefined &&
        friendCircleSnap.address !== invitation.address) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.invitationRewritten);
    }
    if (friendCircleSnap.addressReachable !== true) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.circleTransportUnreachable);
    }
    // The friend-side approval must name the friend device (pr93 F1): a
    // missing approvedDeviceId is not an approval of this device.
    if (friendCircleSnap.approvedDeviceId !== friendMachine.machineId) {
      throw block(direction, 'circle', 'owner', circleAt, ORCHESTRATION_CODES.approvalWrongDevice);
    }
    requireEvidenceFields(
      [ownerCircleSnap, friendCircleSnap], 'circle', direction, 'owner', circleAt);
    tokensByDirection.set(direction, invitation.token);
    digestsByDirection.set(direction, invitation.digest);
    completeStep(newStep(direction, 'circle', 'owner', circleAt), 'pass');
    completeStep(newStep(direction, 'circle', 'friend', circleAt), 'pass');

    // Lend and first job: lend on through the owner UI, submit one friend
    // job, observe both sides.
    const lendAt = now();
    requireOk(await attempt(() => ui.lend('owner', endpoints.owner)),
      direction, 'lend_first_job', 'owner', lendAt);
    const firstJob = requireOk(
      await attempt(() => ui.submitJob('friend', endpoints.friend)),
      direction, 'lend_first_job', 'owner', lendAt);
    if (firstJob.attemptId !== map.firstJob.attemptId ||
        firstJob.jobDigest !== map.firstJob.digest) {
      const fromEarlier = [other.firstJob, other.stopJob].some(job =>
        job.attemptId === firstJob.attemptId && job.digest === firstJob.jobDigest);
      if (fromEarlier) {
        throw block(direction, 'lend_first_job', 'owner', lendAt,
          ORCHESTRATION_CODES.receiptFromEarlierDirection);
      }
      throw fail(direction, 'lend_first_job', 'owner', lendAt);
    }
    const ownerLendSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'lend_first_job', role: 'owner', machineId: ownerMachine.machineId, sequence},
      {direction, gate: 'lend_first_job', role: 'owner', startedAt: lendAt}),
    direction, 'lend_first_job', 'owner', lendAt);
    const friendLendSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'lend_first_job', role: 'friend', machineId: friendMachine.machineId, sequence},
      {direction, gate: 'lend_first_job', role: 'owner', startedAt: lendAt}),
    direction, 'lend_first_job', 'owner', lendAt);
    requireEvidenceFields(
      [ownerLendSnap, friendLendSnap], 'lend_first_job', direction, 'owner', lendAt);
    completeStep(newStep(direction, 'lend_first_job', 'owner', lendAt), 'pass');
    completeStep(newStep(direction, 'lend_first_job', 'friend', lendAt), 'pass');

    // Stop: submit a second (stop) job, observe it running, Stop through
    // the owner UI, then observe native and sandbox cessation and the
    // friend outcome. Both stop steps carry the same stopClick and the
    // same observations; observation order is controller sequence only.
    const stopAt = now();
    const stopJob = requireOk(
      await attempt(() => ui.submitJob('friend', endpoints.friend)),
      direction, 'stop', 'owner', stopAt);
    if (stopJob.attemptId !== map.stopJob.attemptId ||
        stopJob.jobDigest !== map.stopJob.digest) {
      const fromEarlier = [other.firstJob, other.stopJob].some(job =>
        job.attemptId === stopJob.attemptId && job.digest === stopJob.jobDigest);
      if (fromEarlier) {
        throw block(direction, 'stop', 'owner', stopAt, ORCHESTRATION_CODES.receiptFromEarlierDirection);
      }
      throw fail(direction, 'stop', 'owner', stopAt);
    }
    const runningSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'stop', role: 'owner', machineId: ownerMachine.machineId,
        sequence, phase: 'running'},
      {direction, gate: 'stop', role: 'owner', startedAt: stopAt}),
    direction, 'stop', 'owner', stopAt);
    const stopped = requireOk(
      await attempt(() => ui.stop('owner', endpoints.owner)),
      direction, 'stop', 'owner', stopAt);
    const cessationSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'stop', role: 'owner', machineId: ownerMachine.machineId,
        sequence, phase: 'cessation'},
      {direction, gate: 'stop', role: 'owner', startedAt: stopAt}),
    direction, 'stop', 'owner', stopAt);
    const outcomeSnap = requireSnapshotOk(await observeChecked(
      {direction, gate: 'stop', role: 'friend', machineId: friendMachine.machineId,
        sequence, phase: 'outcome'},
      {direction, gate: 'stop', role: 'owner', startedAt: stopAt}),
    direction, 'stop', 'owner', stopAt);
    const stopFacts = {
      secondUiSend: runningSnap.secondUiSend === true,
      observedRunning: runningSnap.observedRunning === true,
      ownerUiStop: cessationSnap.ownerUiStop === true,
      acknowledged: stopped.acknowledged === true,
      ownerStopReason: typeof stopped.reason === 'string' && stopped.reason.trim().length > 0,
      friendOutcome: outcomeSnap.friendOutcome === true,
      notCompletedBeforeClick: runningSnap.notCompletedBeforeClick === true ||
        cessationSnap.notCompletedBeforeClick === true,
    };
    requireEvidenceFields([stopFacts], 'stop', direction, 'owner', stopAt);
    const rawObservations = Array.isArray(cessationSnap.observations)
      ? cessationSnap.observations : [];
    if (!rawObservations.some(o => o?.sourceKind === 'native') ||
        !rawObservations.some(o => o?.sourceKind === 'sandbox') ||
        rawObservations.some(o => o?.verdict !== 'ceased' ||
          !['native', 'sandbox'].includes(o?.sourceKind))) {
      throw fail(direction, 'stop', 'owner', stopAt);
    }
    const ownerStopStep = newStep(direction, 'stop', 'owner', stopAt);
    const stopClick = {
      sequence: ownerStopStep.sequence,
      machineId: ownerMachine.machineId,
      processIncarnation: ownerMachine.processIncarnation,
      circleId: map.circleId,
      jobDigest: map.stopJob.digest,
      attemptId: map.stopJob.attemptId,
    };
    // Stop observations keep the raw observed identities and order (pr93
    // F1): a supplied identity is never replaced with the expected one.
    // Fields the observation did not carry are filled from the step's own
    // bindings (already validated when present by observeChecked); a
    // supplied observedSequence must be after the Stop click, and a missing
    // one is assigned from controller sequence.
    for (const observation of rawObservations) {
      if (observation?.observedSequence !== undefined &&
          (!Number.isSafeInteger(observation.observedSequence) ||
            observation.observedSequence <= stopClick.sequence)) {
        throw fail(direction, 'stop', 'owner', stopAt);
      }
    }
    const observations = rawObservations.map(observation => {
      // One controller sequence is reserved per observation, as before, so
      // steps created after the observations still sort after them; the
      // emitted observedSequence itself is the source's value when the
      // observation supplied one.
      const reservedSequence = nextSeq();
      return {
        runId: observation.runId ?? descriptor.runId,
        direction: observation.direction ?? direction,
        machineId: observation.machineId ?? ownerMachine.machineId,
        artifactDigest: observation.artifactDigest ?? descriptor.artifacts[ownerMachine.os],
        mode: observation.mode ?? 'live',
        processIncarnation: observation.processIncarnation ?? ownerMachine.processIncarnation,
        circleId: observation.circleId ?? map.circleId,
        jobDigest: observation.jobDigest ?? map.stopJob.digest,
        attemptId: observation.attemptId ?? map.stopJob.attemptId,
        observedSequence: Number.isSafeInteger(observation.observedSequence)
          ? observation.observedSequence : reservedSequence,
        verdict: 'ceased',
        sourceKind: observation.sourceKind,
      };
    });
    completeStep(ownerStopStep, 'pass', {stopClick, observations});
    const friendStopStep = newStep(direction, 'stop', 'friend', stopAt);
    completeStep(friendStopStep, 'pass', {stopClick, observations});

    // Accounting: typed per-resource records bound to this direction's
    // first job, instance and window.
    for (const role of ROLES) {
      const machine = machineFor(direction, role);
      const accountingAt = now();
      const snap = requireSnapshotOk(await observeChecked(
        {direction, gate: 'accounting', role, machineId: machine.machineId, sequence},
        {direction, gate: 'accounting', role, startedAt: accountingAt}),
      direction, 'accounting', role, accountingAt);
      const accounting = snap.accounting;
      if (!accounting || !Array.isArray(accounting.records) || accounting.records.length === 0 ||
          !Array.isArray(accounting.missingFields) || accounting.missingFields.length !== 0) {
        throw block(direction, 'accounting', role, accountingAt, ORCHESTRATION_CODES.missingEvidence);
      }
      const seenResources = new Set();
      for (const record of accounting.records) {
        if (!record || typeof record !== 'object' ||
            record.machineId !== machine.machineId || record.direction !== direction ||
            record.circleId !== map.circleId ||
            record.attemptId !== map.firstJob.attemptId ||
            record.jobDigest !== map.firstJob.digest ||
            record.instanceId !== machine.accountingInstanceId ||
            record.windowId !== machine.accountingWindowId ||
            !machine.accountingResources.includes(record.resourceId) ||
            seenResources.has(record.resourceId)) {
          throw fail(direction, 'accounting', role, accountingAt);
        }
        seenResources.add(record.resourceId);
      }
      for (const resourceId of machine.accountingResources) {
        if (!seenResources.has(resourceId)) throw fail(direction, 'accounting', role, accountingAt);
      }
      requireEvidenceFields([snap], 'accounting', direction, role, accountingAt);
      completeStep(newStep(direction, 'accounting', role, accountingAt), 'pass', {accounting});
    }

    // Preservation and teardown: run-owned close plus a preservation
    // observation. The ui port has no lend-off or circle-close action.
    for (const role of ROLES) {
      const machine = machineFor(direction, role);
      const host = hosts[machine.machineId];
      const teardownAt = now();
      requireOk(await attempt(() => host.close()),
        direction, 'preservation_teardown', role, teardownAt);
      const snap = requireSnapshotOk(await observeChecked(
        {direction, gate: 'preservation_teardown', role, machineId: machine.machineId, sequence},
        {direction, gate: 'preservation_teardown', role, startedAt: teardownAt}),
      direction, 'preservation_teardown', role, teardownAt);
      requireEvidenceFields([snap], 'preservation_teardown', direction, role, teardownAt);
      completeStep(newStep(direction, 'preservation_teardown', role, teardownAt), 'pass');
    }
  }

  let stopped = null;
  try {
    for (const direction of DIRECTIONS) await runDirection(direction);
  } catch (error) {
    if (!(error instanceof StopJourney)) throw error;
    stopped = error;
    const step = newStep(stopped.direction, stopped.gate, stopped.role, stopped.startedAt);
    step.status = stopped.status;
    if (stopped.status === 'blocked') step.blockedCode = stopped.code;
    step.endedAt = now();
    steps.push(step);
    stepIds.set(
      `${step.direction}:${step.gate}:${step.role}`, step.id);
  }

  const verdict = reduceRun(descriptor, steps);
  return {
    ...verdict,
    blockedCode: stopped?.status === 'blocked' ? stopped.code : null,
    stoppedAt: stopped
      ? {direction: stopped.direction, gate: stopped.gate, role: stopped.role}
      : null,
  };
}
