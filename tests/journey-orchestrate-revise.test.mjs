import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runTwoComputerJourney, ORCHESTRATION_CODES} from '../packaging/journey/orchestrate.mjs';

// pr93 revise tests: the pr93-review.md counterexamples, each of which
// passed on the pre-fix orchestrator and must now stop the run, plus a
// clean control that still passes. The world below is the authored
// descriptorFixture/createWorld from tests/journey-orchestrate.test.mjs
// with extra `behavior` flags that script one review input at a time. All
// executed ports, observations, jobs and machines are synthetic; no
// browser, SSH, provider, real install or real journey runs.

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
        if (behavior.preflightInstall) {
          return {status: 'preflight', installed: false, approvedSource: false,
            installedManifest: false, installMode: false, destinationOwned: false};
        }
        return {status: 'ok'};
      },
      async open() {
        state.calls.open++;
        if (behavior.falseNativeOpen) {
          return {status: 'ok',
            identity: {runId: descriptor.runId, machineId: machine.machineId,
              installDigest: descriptor.artifacts[machine.os],
              processIncarnation: machine.processIncarnation},
            normalLaunch: false, canonicalPath: false, listenerOwned: false,
            sessionBound: false, nativeTray: false, nativeBrowser: false,
            freshReadiness: false};
        }
        return {status: 'ok',
          identity: {runId: descriptor.runId, machineId: machine.machineId,
            installDigest: descriptor.artifacts[machine.os],
            processIncarnation: machine.processIncarnation}};
      },
      async endpoint() {
        state.calls.endpoint++;
        endpointCounter += 1;
        if (behavior.fragmentEndpoint) {
          const endpoint = `https://${machine.machineId}.invalid:8443/ui#direction-${endpointCounter - 9000}`;
          state.endpoints[machine.machineId] = endpoint;
          return {status: 'ok', endpoint};
        }
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
      if (behavior.reuseInvitationBothSides && direction === 'B') {
        invitation.token = state.invitations.A.token;
        invitation.digest = state.invitations.A.digest;
      }
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
      if (behavior.omitApprovalDevices) {
        return {status: 'ok',
          joined: {circleId: invitation.circleId, token, digest}};
      }
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
      case 'native_open': {
        const snap = {...base, kind: 'ui-endpoint', endpoint: state.endpoints[machineId],
          reachableFrom: behavior.controllerOnlyEndpoint
            ? ['controller'] : ['controller', machineId]};
        if (behavior.falseNativeOpen) {
          Object.assign(snap, {normalLaunch: false, canonicalPath: false,
            listenerOwned: false, sessionBound: false, nativeTray: false,
            nativeBrowser: false, freshReadiness: false});
        }
        return snap;
      }
      case 'setup': {
        const snap = {...base, kind: 'setup', uiTrace: 'trace', stepsComplete: true,
          safetyClicked: true, freshSafetyResult: true, onlyDockerSignIn: true,
          truthfulAccount: true, uiConsent: true};
        if (behavior.foreignSetup && direction === 'A' && role === 'owner') {
          snap[behavior.foreignSetup.field] = behavior.foreignSetup.value;
        }
        if (behavior.stringSetup && direction === 'A' && role === 'owner') {
          Object.assign(snap, {stepsComplete: 'false', safetyClicked: 'not observed',
            freshSafetyResult: 'false', onlyDockerSignIn: 'false',
            truthfulAccount: 'false', uiConsent: 'false'});
        }
        if (behavior.omitSetupKind && direction === 'A' && role === 'owner') {
          delete snap.kind;
        }
        return snap;
      }
      case 'circle': {
        const invitation = state.invitations[direction];
        const fields = {kind: 'circle', address: invitation.address,
          hostUiCreated: true, friendUiReviewed: true, specificDeviceApproved: true,
          lendingRemainedOff: true, crossMachineTransport: true};
        if (role === 'friend') {
          fields.addressReachable = behavior.unreachableAddress ? false : true;
          if (!behavior.omitApprovalDevices) {
            fields.approvedDeviceId = behavior.wrongDeviceApproval ? 'other-device' : machineId;
          }
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
            observations: ['native', 'sandbox'].map(sourceKind => {
              const observation = {sourceKind,
                verdict: 'ceased', machineId, direction, circleId: map.circleId,
                attemptId: job.attemptId, jobDigest: job.digest,
                hostTime: (hostTime[machineId] += 1)};
              if (behavior.foreignStop) {
                Object.assign(observation, {runId: 'old-run', machineId: 'other-machine',
                  processIncarnation: 'old-process', artifactDigest: 'f'.repeat(64),
                  mode: 'synthetic', observedSequence: -100});
              }
              if (behavior.staleStopSequence) observation.observedSequence = -100;
              if (behavior.fullStopIdentities) {
                // Valid supplied sequences: just above this direction's Stop
                // click sequence (A click 12, B click 32) and below the
                // friend stop step, so the reducer's ordering holds.
                Object.assign(observation, {runId: descriptor.runId,
                  artifactDigest: descriptor.artifacts[machine.os], mode: 'live',
                  processIncarnation: machine.processIncarnation,
                  observedSequence: direction === 'A' ? 13 : 33});
              }
              return observation;
            })};
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
  const result = await runTwoComputerJourney({
    descriptor, hosts: world.hosts, ui: world.ui, observe: world.observe, clock: world.clock});
  return {descriptor, world, result};
}

// The run stopped at the expected gate without passing: no complete
// contract, no S9 pass, and (for a failed step) no blocked code.
function assertStopped(result, direction, gate, role, blockedCode = null) {
  assert.equal(result.contractStatus, 'incomplete');
  assert.equal(result.s9Pass, null);
  assert.equal(result.blockedCode, blockedCode);
  assert.deepEqual(result.stoppedAt, {direction, gate, role});
}

test('clean control: a correct two-computer run still passes', async () => {
  const {result} = await run();
  assert.equal(result.contractStatus, 'complete');
  assert.equal(result.s9Pass, true);
  assert.equal(result.directions.A.pass, true);
  assert.equal(result.directions.B.pass, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.blockedCode, null);
  assert.equal(result.stoppedAt, null);
});

test('clean control: stop observations carrying full valid identities still pass', async () => {
  const {result} = await run({fullStopIdentities: true});
  assert.equal(result.contractStatus, 'complete');
  assert.equal(result.s9Pass, true);
  assert.deepEqual(result.problems, []);
});

// F1: one foreign identity field on a setup snapshot stops the run.
const foreignSetupCases = [
  ['machineId', 'other-machine'],
  ['runId', 'old-run'],
  ['processIncarnation', 'old-process'],
  ['artifactDigest', 'f'.repeat(64)],
  ['kind', 'not-setup'],
  ['mode', 'synthetic'],
];
for (const [field, value] of foreignSetupCases) {
  test(`F1: setup snapshot with foreign ${field} is rejected`, async () => {
    const {result} = await run({foreignSetup: {field, value}});
    assertStopped(result, 'A', 'setup', 'owner');
  });
}

test('F1: setup snapshot without a kind is rejected', async () => {
  const {result} = await run({omitSetupKind: true});
  assertStopped(result, 'A', 'setup', 'owner');
});

test('F1: stop observations with foreign identities and a pre-click sequence are rejected', async () => {
  const {result} = await run({foreignStop: true});
  assertStopped(result, 'A', 'stop', 'owner');
});

test('F1: stop observations with an observedSequence before the click are rejected', async () => {
  const {result} = await run({staleStopSequence: true});
  assertStopped(result, 'A', 'stop', 'owner');
});

test('F1: missing approval device bindings are rejected', async () => {
  const {result} = await run({omitApprovalDevices: true});
  assertStopped(result, 'A', 'circle', 'owner', ORCHESTRATION_CODES.approvalWrongDevice);
});

test('F2: a preflight-only install with explicitly false install fields is rejected', async () => {
  const {result} = await run({preflightInstall: true});
  assertStopped(result, 'A', 'artifact_install', 'owner');
});

test('F2: explicitly false native-open evidence is rejected', async () => {
  const {result} = await run({falseNativeOpen: true});
  assertStopped(result, 'A', 'native_open', 'owner');
});

test('F3: strings meaning false do not attest setup booleans', async () => {
  const {result} = await run({stringSetup: true});
  assertStopped(result, 'A', 'setup', 'owner');
});

test('F4: invitation and join reusing the earlier direction token and digest are rejected', async () => {
  const {result} = await run({reuseInvitationBothSides: true});
  assertStopped(result, 'B', 'circle', 'owner', ORCHESTRATION_CODES.staleToken);
});

test('F5: the same endpoint under a different fragment is still a stale port', async () => {
  const {result} = await run({fragmentEndpoint: true});
  assertStopped(result, 'B', 'native_open', 'owner', ORCHESTRATION_CODES.stalePort);
});
