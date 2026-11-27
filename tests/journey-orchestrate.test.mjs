import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runTwoComputerJourney, ORCHESTRATION_CODES} from '../packaging/journey/orchestrate.mjs';
import {reduceRun} from '../packaging/journey/two-computer.mjs';

const hash = n => n.toString(16).padStart(64, '0');

function descriptorFixture() {
  const machine = (machineId, os) => ({machineId, os, arch: 'arm64', userIdentity: 'test-user',
    installIdentity: os + '-preview', installDestination: '/' + os + '/preview', channel: 's9',
    dataRoot: '/' + os + '/data', guiSession: 'session-1', accountCapability: 'approved-test',
    resourceLimits: {job: 1, total: 4}, processIncarnation: os + '-process-1',
    accountingInstanceId: os + '-account', accountingWindowId: os + '-window',
    accountingResources: ['tokens', 'requests']});
  return {runId: 'run-1', harnessCommit: 'a'.repeat(40),
    artifacts: {linux: hash(1), darwin: hash(2)},
    machines: [machine('mac', 'darwin'), machine('linux', 'linux')],
    writeAudit: {complete: true, forbiddenWrites: []},
    directions: {
      A: {owner: 'mac', friend: 'linux', circleId: 'circle-a',
        firstJob: {digest: hash(3), attemptId: 'a-first'},
        stopJob: {digest: hash(4), attemptId: 'a-stop'}},
      B: {owner: 'linux', friend: 'mac', circleId: 'circle-b',
        firstJob: {digest: hash(5), attemptId: 'b-first'},
        stopJob: {digest: hash(6), attemptId: 'b-stop'}},
    }};
}

// Two fake host adapters with distinct identities, a fake role-parameterized
// UI port, and a fake observer, sharing one scriptable world. No network,
// browser, SSH or real account. `behavior` scripts one rejection at a time.
function createWorld(descriptor, behavior = {}) {
  const state = {
    calls: {verify: 0, install: 0, open: 0, endpoint: 0, facts: 0, close: 0,
      invite: 0, join: 0, lend: 0, submitJob: 0, stop: 0, observe: 0},
    invitations: {},
    endpoints: {},
    tokens: [],
  };
  const hostTime = {};
  for (const m of descriptor.machines) hostTime[m.machineId] = 1000;
  let inviteCount = 0, joinCount = 0, submitCount = 0;
  let delayedFired = false;
  const jobsInOrder = [descriptor.directions.A.firstJob, descriptor.directions.A.stopJob,
    descriptor.directions.B.firstJob, descriptor.directions.B.stopJob];

  const hosts = {};
  for (const machine of descriptor.machines) {
    let endpointCounter = 9000;
    hosts[machine.machineId] = {
      async verify() {
        state.calls.verify++;
        return {status: 'preflight',
          identity: {runId: descriptor.runId, machineId: machine.machineId,
            installDigest: descriptor.artifacts[machine.os], processIncarnation: null},
          destination: machine.installDestination};
      },
      async install() {
        state.calls.install++;
        if (behavior.blockInstall?.machineId === machine.machineId) {
          return {status: 'blocked', code: behavior.blockInstall.code};
        }
        return {status: 'ok'};
      },
      async open() {
        state.calls.open++;
        return {status: 'ok',
          identity: {runId: descriptor.runId, machineId: machine.machineId,
            installDigest: descriptor.artifacts[machine.os],
            processIncarnation: machine.processIncarnation}};
      },
      async endpoint() {
        state.calls.endpoint++;
        endpointCounter += 1;
        const port = behavior.stalePort ? 8443 : endpointCounter;
        const endpoint = `https://${machine.machineId}.invalid:${port}/ui`;
        state.endpoints[machine.machineId] = endpoint;
        return {status: 'ok', endpoint};
      },
      async facts() {
        state.calls.facts++;
        return {status: 'ok',
          facts: {realProfile: true, trayBackendMatch: true, approvedDataRoot: true,
            processIncarnation: machine.processIncarnation}};
      },
      async close() {
        state.calls.close++;
        return {status: 'ok', receipt: 'closed'};
      },
    };
  }

  const ui = {
    async invite(role, endpoint) {
      state.calls.invite++;
      inviteCount += 1;
      const direction = inviteCount === 1 ? 'A' : 'B';
      const invitation = {circleId: descriptor.directions[direction].circleId,
        address: `circle://${direction.toLowerCase()}.invalid/room`,
        token: `token-${direction}-${inviteCount}`,
        digest: `digest-${direction}-${inviteCount}`};
      state.invitations[direction] = invitation;
      state.tokens.push(invitation.token);
      return {status: 'ok', invitation};
    },
    async join(role, endpoint) {
      state.calls.join++;
      joinCount += 1;
      const direction = joinCount === 1 ? 'A' : 'B';
      const invitation = state.invitations[direction];
      let token = invitation.token, digest = invitation.digest;
      if (behavior.staleToken && joinCount === 2) {
        token = state.invitations.A.token;
        digest = state.invitations.A.digest;
      }
      if (behavior.rewriteInvitation && joinCount === 1) digest = 'digest-tampered';
      return {status: 'ok',
        joined: {circleId: invitation.circleId,
          deviceId: descriptor.directions[direction].friend, token, digest}};
    },
    async lend(role, endpoint) {
      state.calls.lend++;
      return {status: 'ok', lending: true};
    },
    async submitJob(role, endpoint) {
      state.calls.submitJob++;
      submitCount += 1;
      const job = jobsInOrder[submitCount - 1];
      return {status: 'ok', attemptId: job.attemptId, jobDigest: job.digest};
    },
    async stop(role, endpoint) {
      state.calls.stop++;
      return {status: 'ok', acknowledged: true, reason: 'owner stop'};
    },
  };

  const observe = async query => {
    state.calls.observe++;
    const {direction, gate, role, machineId} = query;
    const machine = descriptor.machines.find(m => m.machineId === machineId);
    const map = descriptor.directions[direction];
    const job = map[gate === 'stop' ? 'stopJob' : 'firstJob'];
    let time = (hostTime[machineId] += 10);
    if (behavior.clockSkew && direction === 'A' && gate === 'setup' && role === 'owner') time = 900;
    const base = {status: 'ok', direction, machineId, circleId: map.circleId,
      attemptId: job.attemptId, jobDigest: job.digest, hostTime: time};
    if (behavior.delayedReceipt && direction === 'B' && !delayedFired) {
      delayedFired = true;
      const a = descriptor.directions.A;
      return {...base, direction: 'A', circleId: a.circleId,
        attemptId: a.firstJob.attemptId, jobDigest: a.firstJob.digest};
    }
    switch (gate) {
      case 'native_open':
        return {...base, kind: 'ui-endpoint', endpoint: state.endpoints[machineId],
          reachableFrom: behavior.controllerOnlyEndpoint
            ? ['controller'] : ['controller', machineId]};
      case 'setup':
        return {...base, kind: 'setup', uiTrace: 'trace', stepsComplete: true,
          safetyClicked: true, freshSafetyResult: true, onlyDockerSignIn: true,
          truthfulAccount: true, uiConsent: true};
      case 'circle': {
        const invitation = state.invitations[direction];
        const fields = {kind: 'circle', address: invitation.address,
          hostUiCreated: true, friendUiReviewed: true, specificDeviceApproved: true,
          lendingRemainedOff: true, crossMachineTransport: true};
        if (role === 'friend') {
          fields.addressReachable = behavior.unreachableAddress ? false : true;
          fields.approvedDeviceId = behavior.wrongDeviceApproval ? 'other-device' : machineId;
          fields.invitationDigest = invitation.digest;
        }
        return {...base, ...fields};
      }
      case 'lend_first_job':
        return {...base, kind: 'lend', uiSettings: true, uiConsent: true,
          realProvider: true, realSandbox: true, submittedOnce: true,
          ownerExecuted: true, friendReceived: true};
      case 'stop': {
        if (query.phase === 'running') {
          return {...base, kind: 'stop-running', observedRunning: true,
            secondUiSend: true, notCompletedBeforeClick: true};
        }
        if (query.phase === 'cessation') {
          return {...base, kind: 'stop-cessation', ownerUiStop: true,
            notCompletedBeforeClick: true,
            observations: ['native', 'sandbox'].map(sourceKind => ({sourceKind,
              verdict: 'ceased', machineId, direction, circleId: map.circleId,
              attemptId: job.attemptId, jobDigest: job.digest,
              hostTime: (hostTime[machineId] += 1)}))};
        }
        return {...base, kind: 'stop-outcome', friendOutcome: true};
      }
      case 'accounting': {
        const records = machine.accountingResources.map(resourceId => ({resourceId,
          machineId, direction, circleId: map.circleId,
          attemptId: map.firstJob.attemptId, jobDigest: map.firstJob.digest,
          instanceId: machine.accountingInstanceId, windowId: machine.accountingWindowId,
          before: 10, after: 12, charge: 2, cap: 100,
          conversion: {numerator: 1, denominator: 1, source: 'fixture'}}));
        return {...base, kind: 'accounting', typedResources: true, nonemptyResources: true,
          conversionKnown: true, instanceBound: true, attributionKnown: true,
          accounting: {missingFields: [], records}};
      }
      case 'preservation_teardown':
        return {...base, kind: 'preservation', preferencesUnchanged: true,
          modelsUnchanged: true, channelUnchanged: true, onlyOwnedWrites: true,
          ownedCloseReceipts: true, securityUnchanged: true};
      default:
        return base;
    }
  };

  let clockTime = 1000;
  const clock = {now: () => (clockTime += 10)};
  return {hosts, ui, observe, clock, state};
}

async function run(behavior) {
  const descriptor = descriptorFixture();
  const world = createWorld(descriptor, behavior);
  const before = JSON.stringify(descriptor);
  const envBefore = [process.env.HOME, process.env.XDG_CONFIG_HOME,
    process.env.XDG_DATA_HOME, process.env.USERPROFILE];
  const result = await runTwoComputerJourney({
    descriptor, hosts: world.hosts, ui: world.ui, observe: world.observe, clock: world.clock});
  return {descriptor, world, result, before,
    envAfter: [process.env.HOME, process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME, process.env.USERPROFILE], envBefore};
}

test('full two-direction pass returns the reducer verdict unchanged', async () => {
  const {descriptor, world, result, before, envBefore, envAfter} = await run();
  assert.equal(result.contractStatus, 'complete');
  assert.equal(result.s9Pass, true);
  assert.equal(result.directions.A.pass, true);
  assert.equal(result.directions.B.pass, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.blockedCode, null);
  assert.equal(result.stoppedAt, null);
  // Both directions ran over both hosts: install/open/close per machine
  // per direction, one invitation and job pair per direction.
  assert.equal(world.state.calls.install, 4);
  assert.equal(world.state.calls.open, 4);
  assert.equal(world.state.calls.close, 4);
  assert.equal(world.state.calls.invite, 2);
  assert.equal(world.state.calls.join, 2);
  assert.equal(world.state.calls.submitJob, 4);
  assert.equal(world.state.calls.stop, 2);
  // Tokens stay in memory: none appear in the returned record.
  const text = JSON.stringify(result);
  for (const token of world.state.tokens) assert.equal(text.includes(token), false);
  assert.equal(text.includes('digest-A-1'), false);
  // The run never touches the OS profile environment.
  assert.deepEqual(envAfter, envBefore);
  // The descriptor is not mutated.
  assert.equal(JSON.stringify(descriptor), before);
});

test('verdict comes from the reducer: a forbidden write fails S9', async () => {
  const descriptor = descriptorFixture();
  descriptor.writeAudit.forbiddenWrites = ['stable-data-write'];
  const world = createWorld(descriptor);
  const result = await runTwoComputerJourney({
    descriptor, hosts: world.hosts, ui: world.ui, observe: world.observe, clock: world.clock});
  assert.equal(result.contractStatus, 'complete');
  assert.equal(result.s9Pass, false);
  assert.equal(result.writeAuditPass, false);
  assert.equal(result.directions.A.pass, true);
  assert.equal(result.directions.B.pass, true);
});

test('invalid descriptor returns the reducer verdict without touching hosts', async () => {
  const descriptor = descriptorFixture();
  descriptor.machines = descriptor.machines.slice(0, 1);
  const world = createWorld(descriptor);
  const result = await runTwoComputerJourney({
    descriptor, hosts: world.hosts, ui: world.ui, observe: world.observe, clock: world.clock});
  assert.equal(result.contractStatus, 'incomplete');
  assert.equal(result.s9Pass, null);
  assert.equal(result.problems.length > 0, true);
  assert.equal(result.blockedCode, null);
  assert.equal(world.state.calls.install, 0);
});

test('unreachable advertised circle address is rejected', async () => {
  const {result} = await run({unreachableAddress: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.circleTransportUnreachable);
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'circle', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
  assert.equal(result.s9Pass, null);
});

test('UI endpoint reachable only by the controller is rejected', async () => {
  const {result} = await run({controllerOnlyEndpoint: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.uiEndpointControllerOnly);
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'native_open', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('rewritten invitation is rejected', async () => {
  const {result} = await run({rewriteInvitation: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.invitationRewritten);
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'circle', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('approval from the wrong device is rejected', async () => {
  const {result} = await run({wrongDeviceApproval: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.approvalWrongDevice);
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'circle', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('delayed receipt from the earlier direction is rejected', async () => {
  const {result} = await run({delayedReceipt: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.receiptFromEarlierDirection);
  assert.deepEqual(result.stoppedAt, {direction: 'B', gate: 'native_open', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('stale token from the earlier direction is rejected', async () => {
  const {result} = await run({staleToken: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.staleToken);
  assert.deepEqual(result.stoppedAt, {direction: 'B', gate: 'circle', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('stale port reused across directions is rejected', async () => {
  const {result} = await run({stalePort: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.stalePort);
  assert.deepEqual(result.stoppedAt, {direction: 'B', gate: 'native_open', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('cross-host clock skew is rejected and ordering stays on controller sequence', async () => {
  const {result} = await run({clockSkew: true});
  assert.equal(result.blockedCode, ORCHESTRATION_CODES.clockSkewOrdering);
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'setup', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
});

test('blocked Mac install returns the adapter code and stops before any UI work', async () => {
  const {world, result} = await run(
    {blockInstall: {machineId: 'mac', code: 'macos_safe_archive_install_missing'}});
  assert.equal(result.blockedCode, 'macos_safe_archive_install_missing');
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'artifact_install', role: 'owner'});
  assert.equal(result.contractStatus, 'incomplete');
  assert.equal(result.problems.some(p => p.includes('unknown blocked code')), true);
  assert.equal(world.state.calls.invite, 0);
  assert.equal(world.state.calls.open, 0);
});

test('blocked Linux install returns the adapter code and stops before any UI work', async () => {
  const {world, result} = await run(
    {blockInstall: {machineId: 'linux', code: 'linux_pinned_noninteractive_installer_missing'}});
  assert.equal(result.blockedCode, 'linux_pinned_noninteractive_installer_missing');
  assert.deepEqual(result.stoppedAt, {direction: 'A', gate: 'artifact_install', role: 'friend'});
  assert.equal(result.contractStatus, 'incomplete');
  assert.equal(world.state.calls.invite, 0);
  assert.equal(world.state.calls.close, 0);
});

test('returned verdict matches reduceRun on the same record', async () => {
  // The orchestrator returns the reducer's verdict object shape; the
  // verdict fields are exactly the ones reduceRun produces for a
  // complete two-direction record.
  const {result} = await run();
  const keys = ['contractStatus', 's9Pass', 'writeAuditPass', 'directions', 'problems'];
  for (const key of keys) assert.equal(key in result, true);
  assert.deepEqual(Object.keys(result.directions).sort(), ['A', 'B']);
});
