import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinuxCollector, createMacCollector} from '../packaging/journey/collectors.mjs';
import {judgeNothingRunning} from '../packaging/journey/evidence.mjs';

// Synthetic runners only: no command execution, network, credentials or real host state.
const factories = {linux: createLinuxCollector, darwin: createMacCollector};
const bindings = ['attemptId', 'platform', 'hostId', 'sandboxId'];
const expectedFor = platform => ({platform, hostId: 'synthetic-host', sandboxId: 'synthetic-sandbox', attemptId: 'synthetic-attempt'});
const marker = '/synthetic/run-owned-process';
const methods = ['collectProcess', 'collectSandboxes', 'collectHost', 'collectAccounting'];
const slots = ['scan', 'host', 'sandboxes'];
const absent = Symbol('delete field');

async function collected(platform, overrides = {}, outputs = {}) {
  const expected = {...expectedFor(platform), ...overrides};
  const stdout = {
    'process-table': '101 /synthetic/unrelated-process\n',
    'sandbox-list': JSON.stringify([{sandboxId: expected.sandboxId, attemptId: expected.attemptId, state: 'stopped'}]),
    'host-identity': expected.hostId + '\n',
    accounting: '[]',
    ...outputs,
  };
  const collector = factories[platform]({...expected, processMarker: marker,
    run: async op => ({ok: true, stdout: stdout[op.kind]})});
  const all = await collector.collectAll();
  return {scan: all.process, host: all.host, sandboxes: all.sandboxes};
}

function judge(platform, evidence, overrides = {}) {
  return judgeNothingRunning({attemptState: 'stopped', lendingCurrent: null,
    attemptId: expectedFor(platform).attemptId, appProof: true, runsUnchanged: true, live: true,
    expected: expectedFor(platform), ...evidence, ...overrides});
}

function changed(evidence, slot, field, value) {
  const copy = {...evidence, [slot]: {...evidence[slot]}};
  if (value === absent) delete copy[slot][field];
  else copy[slot][field] = value;
  return copy;
}

function unknown(platform, evidence, overrides, label) {
  let verdict;
  assert.doesNotThrow(() => { verdict = judge(platform, evidence, overrides); }, label);
  assert.equal(verdict.pass, null, label);
  assert.ok(verdict.missing.length > 0, label);
}

for (const platform of Object.keys(factories)) {
  test(`${platform}: absence from a different platform cannot satisfy the sandbox envelope`, async () => {
    const good = await collected(platform, {}, {'sandbox-list': '[]'});
    assert.equal(judge(platform, good).pass, true);
    const other = await collected(platform === 'linux' ? 'darwin' : 'linux', {}, {'sandbox-list': '[]'});
    assert.equal(other.sandboxes.result, 'absent');
    assert.equal(judge(platform, {...good, sandboxes: other.sandboxes}).pass, false);
    // The binding still fails when the payload is omitted; it is checked first.
    const noList = {...other.sandboxes};
    delete noList.sandboxes;
    assert.equal(judge(platform, {...good, sandboxes: noList}).pass, false);
  });

  test(`${platform}: absence from a different host cannot satisfy the sandbox envelope`, async () => {
    const good = await collected(platform, {}, {'sandbox-list': '[]'});
    assert.equal(judge(platform, good).pass, true);
    const other = await collected(platform, {hostId: 'different-synthetic-host'}, {'sandbox-list': '[]'});
    assert.equal(judge(platform, {...good, sandboxes: other.sandboxes}).pass, false);
    const noList = {...other.sandboxes};
    delete noList.sandboxes;
    assert.equal(judge(platform, {...good, sandboxes: noList}).pass, false);
  });

  test(`${platform}: process evidence collected for an old attempt fails`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    const old = await collected(platform, {attemptId: 'old-synthetic-attempt'});
    assert.equal(old.scan.result, 'ceased');
    assert.equal(judge(platform, {...good, scan: old.scan}).pass, false);
    for (const field of ['platform', 'hostId', 'sandboxId']) {
      const value = field === 'platform' ? (platform === 'linux' ? 'darwin' : 'linux') : 'different-synthetic-binding';
      assert.equal(judge(platform, changed(good, 'scan', field, value)).pass, false);
    }
  });

  for (const slot of slots) {
    test(`${platform}: ${slot} requires every nonempty identity binding`, async () => {
      const good = await collected(platform);
      assert.equal(judge(platform, good).pass, true);
      for (const field of bindings) {
        for (const value of [absent, undefined, null, '', ' \t ', 42, {}, []]) {
          unknown(platform, changed(good, slot, field, value), {}, `${slot}.${field} ${String(value)}`);
        }
      }
    });

    test(`${platform}: ${slot} requires its own observation kind`, async () => {
      const good = await collected(platform);
      assert.equal(judge(platform, good).pass, true);
      for (const value of [absent, null, '', 'evidence', 'accounting', {}, []]) {
        unknown(platform, changed(good, slot, 'kind', value), {}, `${slot}.kind ${String(value)}`);
      }
    });
  }

  for (const slot of ['host', 'sandboxes']) {
    for (const field of bindings) {
      test(`${platform}: ${slot} rejects a different ${field} before trusting its result`, async () => {
        const good = await collected(platform, {}, {'sandbox-list': '[]'});
        assert.equal(judge(platform, good).pass, true);
        const value = field === 'platform' ? (platform === 'linux' ? 'darwin' : 'linux') : 'different-synthetic-binding';
        assert.equal(judge(platform, changed(good, slot, field, value)).pass, false);
        // Missing kind cannot conceal a definite run-identity mismatch.
        const bad = changed(good, slot, field, value);
        delete bad[slot].kind;
        assert.equal(judge(platform, bad).pass, false);
      });
    }
  }

  test(`${platform}: malformed expected identity is unknown without throwing`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    unknown(platform, good, {appProof: false}, 'app proof remains required');
    for (const slot of slots) {
      for (const value of [undefined, null, [], 7, 'not-an-observation']) {
        unknown(platform, {...good, [slot]: value}, {}, `malformed ${slot}`);
      }
      const throwing = {...good[slot]};
      Object.defineProperty(throwing, 'kind', {get() { throw new Error('HARMLESS-MALFORMED-ACCESSOR'); }});
      unknown(platform, {...good, [slot]: throwing}, {}, `throwing ${slot} accessor`);
    }
    for (const expected of [null, [], 'bad', 7, true, {}]) {
      unknown(platform, good, {expected}, 'malformed expected identity');
    }
    for (const field of bindings) {
      for (const value of [undefined, null, '', ' \t ', 7, []]) {
        unknown(platform, good, {expected: {...expectedFor(platform), [field]: value}}, `expected.${field}`);
      }
    }
  });

  test(`${platform}: process payload must be a valid PID array consistent with its result`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    const payloads = ['', {}, 5, undefined, null, ['123'], [0], [-1], [1.5], [NaN],
      [Infinity], [Number.MAX_SAFE_INTEGER + 1], [null], [undefined], [Symbol('harmless-pid')], new Array(1)];
    for (const pids of payloads) unknown(platform, changed(good, 'scan', 'pids', pids), {}, 'malformed pids');
    // A ceased label with even a valid positive PID is malformed, not known cessation.
    unknown(platform, changed(good, 'scan', 'pids', [123]), {}, 'ceased with a PID');
    for (const pid of ['0', '9007199254740992']) {
      const malformed = await collected(platform, {}, {'process-table': `${pid} ${marker}/app\n`});
      unknown(platform, malformed, {}, 'invalid PID from the real collector');
    }
    const active = await collected(platform, {}, {'process-table': `123 ${marker}/app\n`});
    assert.equal(judge(platform, active).pass, false);
    unknown(platform, changed(active, 'scan', 'pids', []), {}, 'active without PIDs');
  });

  test(`${platform}: only typed known results are accepted, with no process status fallback`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    for (const slot of slots) {
      for (const result of [absent, undefined, null, '', 'unrecognized', 5, {}, []]) {
        const bad = changed(good, slot, 'result', result);
        if (slot === 'scan') bad.scan.status = 'ceased';
        unknown(platform, bad, {}, `${slot} result is invalid`);
      }
      unknown(platform, changed(good, slot, 'result', 'unknown'), {}, `${slot} result is unknown`);
    }
  });

  test(`${platform}: sandbox payloads are typed, nonthrowing and consistent with found or absent`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    for (const sandboxes of [undefined, null, {}, '', 'not-an-array', 7, [], [null], [undefined],
      [7], ['entry'], [[]], [{}], [{sandboxId: 'synthetic-sandbox', attemptId: 'synthetic-attempt', state: 7}]]) {
      unknown(platform, changed(good, 'sandboxes', 'sandboxes', sandboxes), {}, 'malformed found payload');
    }
    const missing = changed(good, 'sandboxes', 'sandboxes', absent);
    unknown(platform, missing, {}, 'found without list');
    for (const field of ['sandboxId', 'attemptId']) {
      for (const value of [undefined, null, '', ' \t ', 5, {}]) {
        const entry = {...good.sandboxes.sandboxes[0], [field]: value};
        unknown(platform, changed(good, 'sandboxes', 'sandboxes', [entry]), {}, `entry.${field}`);
      }
    }
    const empty = await collected(platform, {}, {'sandbox-list': '[]'});
    assert.equal(judge(platform, empty).pass, true);
    for (const sandboxes of [undefined, null, {}, good.sandboxes.sandboxes]) {
      unknown(platform, changed(empty, 'sandboxes', 'sandboxes', sandboxes), {}, 'malformed absent payload');
    }
    const running = await collected(platform, {}, {'sandbox-list': JSON.stringify([
      {sandboxId: 'synthetic-sandbox', attemptId: 'synthetic-attempt', state: 'running'}])});
    assert.equal(judge(platform, running).pass, false);
    const unknownState = changed(good, 'sandboxes', 'sandboxes', [{...good.sandboxes.sandboxes[0], state: null}]);
    unknown(platform, unknownState, {}, 'unknown sandbox state');
  });

  test(`${platform}: incomplete observed host identity is malformed, not a known mismatch`, async () => {
    const good = await collected(platform);
    assert.equal(judge(platform, good).pass, true);
    for (const value of [undefined, null, '', ' \t ', 7, {}, []]) {
      unknown(platform, changed(good, 'host', 'observedHostId', value), {}, 'malformed observedHostId');
    }
    const wrong = await collected(platform, {}, {'host-identity': 'different-synthetic-host\n'});
    assert.equal(judge(platform, wrong).pass, false);
  });

  for (const method of methods) {
    for (const failure of ['returned', 'thrown']) {
      test(`${platform}: ${method} ${failure} runner failure never forwards diagnostics`, async () => {
        const good = await collected(platform);
        assert.equal(judge(platform, good).pass, true);
        const canary = 'HARMLESS-SYNTHETIC-RUNNER-CANARY';
        const diagnostics = (canary + ' /synthetic/command --argument\n').repeat(100);
        const run = async () => {
          if (failure === 'thrown') throw new Error(diagnostics);
          return {ok: false, error: diagnostics, stdout: diagnostics, stderr: diagnostics, command: diagnostics};
        };
        const collector = factories[platform]({...expectedFor(platform), processMarker: marker, run});
        const observation = await collector[method]();
        assert.equal(observation.result, 'unknown');
        assert.ok(!JSON.stringify(observation).includes(canary));
        assert.match(observation.reason, /observation failed: runner (failed|threw)$/);
        assert.ok(observation.reason.length < 100);
        const all = await collector.collectAll();
        assert.ok(!JSON.stringify(all).includes(canary));
        for (const key of ['process', 'sandboxes', 'host', 'accounting']) {
          assert.equal(all[key].result, 'unknown');
          assert.ok(all[key].reason.length < 100);
        }
      });
    }
  }
}
