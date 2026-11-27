import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {judgeNothingRunning, judgeOwnerStop, readPreparedStopIdentity, judgeRecordedStopRemoval, observeInstalledHostInvite} from '../packaging/journey/evidence.mjs';


test('installed Host invite receipt carries only independently observed identity and agreement', () => {
  const sourceSha = '1'.repeat(40), artifactSha256 = '2'.repeat(64);
  const verifiedPublicOrigin = 'https://published.example.invalid:8443';
  const circleId = '01234567-89ab-4def-8123-0123456789ab';
  const rootFingerprint = 'sha256:' + '3'.repeat(64);
  const canary = 'private-invite-fragment-or-release-input';
  const hostedCircle = {id: circleId, origin: verifiedPublicOrigin, pinnedRootFingerprint: rootFingerprint, raw: canary};
  const verifiedInvite = {coordinator: verifiedPublicOrigin, circle: circleId, root_fingerprint: rootFingerprint,
    invite_id: canary, link: 'https://never-retain.example.invalid/#' + canary};
  const input = {sourceSha, artifactSha256, verifiedPublicOrigin, hostedCircle, verifiedInvite, archivePath: canary};
  const receipt = observeInstalledHostInvite(input);
  assert.deepEqual(receipt, {
    observation: {sourceSha, artifactSha256, verifiedPublicOrigin, circleId, rootFingerprint,
      originAgrees: true, circleAgrees: true, rootAgrees: true},
    reason: null,
  });
  const unequal = observeInstalledHostInvite({...input, verifiedInvite: {...verifiedInvite,
    coordinator: 'https://wrong-origin.example.invalid', circle: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    root_fingerprint: 'sha256:' + '4'.repeat(64)}});
  assert.deepEqual(unequal, {
    observation: {...receipt.observation, originAgrees: false, circleAgrees: false, rootAgrees: false},
    reason: 'Verified invite does not match the hosted circle.',
  });
  for (const origin of [
    'http://published.example.invalid', 'https://' + canary + '@published.example.invalid',
    verifiedPublicOrigin + '/', verifiedPublicOrigin + '/' + canary,
    verifiedPublicOrigin + '?' + canary, verifiedPublicOrigin + '#' + canary,
  ]) {
    assert.deepEqual(observeInstalledHostInvite({...input, verifiedPublicOrigin: origin}), {
      observation: null, reason: 'Verified public Host identity unavailable.',
    });
    assert.deepEqual(observeInstalledHostInvite({...input, verifiedInvite: {...verifiedInvite, coordinator: origin}}), {
      observation: null, reason: 'Verified invite identity unavailable.',
    });
  }
  for (const incomplete of [{sourceSha: canary}, {artifactSha256: canary}, {artifactSha256: undefined}]) {
    const refusal = observeInstalledHostInvite({...input, ...incomplete});
    assert.deepEqual(refusal, {observation: null, reason: 'Installed release identity unavailable.'});
    assert.ok(!JSON.stringify(refusal).includes(canary));
  }
  assert.deepEqual(observeInstalledHostInvite({...input, verifiedInvite: undefined}), {
    observation: null, reason: 'Verified invite identity unavailable.',
  });
  for (const result of [receipt, unequal]) {
    const json = JSON.stringify(result);
    assert.ok(!json.includes(canary) && !json.includes('never-retain') && !json.includes('wrong-origin'));
    assert.ok(!json.includes('ffffffff-ffff') && !json.includes('sha256:' + '4'.repeat(64)));
  }
});
test('a positive sandbox scan keeps contradictory app cessation evidence unresolved', () => {
  const result = judgeNothingRunning({
    attemptState: 'stopped', lendingCurrent: null, attemptId: 'attempt-1',
    appProof: true, scan: {pids: [1234]}, runsUnchanged: true, live: true,
  });

  assert.equal(result.pass, false);
  assert.equal(result.source, null);
  assert.equal(result.disagreement, 'sbx scan still lists pids 1234');
  assert.deepEqual(result.missing, ['unresolved app/process scan conflict: sbx scan still lists pids 1234']);
});

const stopRecord = {event_id: 'attempt-1:owner-stop', requested_at: 1, durable_intent_recorded: true};
const graceful = {ownerAttemptState: 'completed', attemptId: 'attempt-1', ownerStop: stopRecord, receiptError: undefined,
  receiptUnavailable: false, transcriptHasStopCopy: true, friendReasonCode: null};
const hard = {ownerAttemptState: 'stopped', attemptId: 'attempt-1', ownerStop: stopRecord, meterRuns: [],
  receiptError: '{"code":"result_unavailable"}', receiptUnavailable: true, transcriptHasStopCopy: false, friendReasonCode: 'stopped_by_lender'};

test('a live graceful owner stop passes without a synthetic meter record', () => {
  const result = judgeOwnerStop({...graceful, live: true, meterRuns: []});
  assert.deepEqual(result, {pass: true, path: 'graceful', missing: []});
});

test('a synthetic graceful owner stop needs the meter to record the owner stop', () => {
  assert.equal(judgeOwnerStop({...graceful, live: false, meterRuns: [{stop: 'owner'}]}).path, 'graceful');
  const unseen = judgeOwnerStop({...graceful, live: false, meterRuns: [{stop: null}]});
  assert.equal(unseen.pass, false);
});

test('a hard owner stop passes in both modes', () => {
  assert.equal(judgeOwnerStop({...hard, live: true}).path, 'hard');
  assert.equal(judgeOwnerStop({...hard, live: false}).path, 'hard');
});

test('an owner stop fails without the app record, a terminal attempt or a whole path', () => {
  for (const live of [true, false]) {
    const runs = [{stop: 'owner'}];
    assert.equal(judgeOwnerStop({...graceful, live, meterRuns: runs, ownerStop: null}).pass, false, 'no durable owner-stop record');
    assert.equal(judgeOwnerStop({...graceful, live, meterRuns: runs, ownerStop: {...stopRecord, event_id: 'other:owner-stop'}}).pass, false,
      'a record for another attempt');
    assert.equal(judgeOwnerStop({...graceful, live, meterRuns: runs, ownerAttemptState: 'running'}).pass, false, 'attempt still running');
    assert.equal(judgeOwnerStop({...graceful, live, meterRuns: runs, transcriptHasStopCopy: false}).pass, false, 'friend never told');
    assert.equal(judgeOwnerStop({...graceful, live, meterRuns: runs, receiptError: 'boom'}).pass, false, 'partial work without a receipt');
    assert.equal(judgeOwnerStop({...hard, live, friendReasonCode: null}).pass, false, 'hard stop without the friend reason');
  }
});

test('the journey joins the saved removal to its captured identity and exact stopped attempt', async t=>{
  const home=await mkdtemp(join(tmpdir(),'fv-stop-removal-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'v1'));
  const save=row=>writeFile(join(home,'v1','app-counters.json'),JSON.stringify({accounts:{worker:row}}));
  const attempt={attempt_id:'original',job_digest:'job',generation:1};
  const pending={attemptId:attempt.attempt_id,attempt,sandboxId:'owned-sandbox',jobId:'local-job',
    owner_scope:'owner',sandboxIncarnation:'create-1',sbx_runtime:{id:'runtime'}};
  await save({pending});
  const expected=readPreparedStopIdentity(home,attempt);
  assert.deepEqual(expected,{attemptId:'original',jobDigest:'job',generation:1,sandboxId:'owned-sandbox',
    jobId:'local-job',ownerScope:'owner',runtimeId:'runtime',create_incarnation:'create-1'});

  const stopped={...attempt,state:'released',compute_stopped:true,stopped_at:'2026-11-20T00:00:02Z'};
  const witness={...expected,before_at:'2026-11-20T00:00:00.100Z',after_at:'2026-11-20T00:00:01.200Z',
    privateField:'never include this field in evidence'};
  await save({pending:null,lastRecovery:{attemptId:'original',removed:true,removalObservation:witness}});
  assert.deepEqual(judgeRecordedStopRemoval(home,expected,stopped),{status:'removed',pass:true});
  for(const other of [{...stopped,attempt_id:'replacement',generation:2},
    {...stopped,compute_stopped:false},{...stopped,state:'active'},null]){
    assert.deepEqual(judgeRecordedStopRemoval(home,expected,other),{status:'unknown',pass:false});
  }
  await save({lastRecovery:{attemptId:'original',removed:true,
    removalObservation:{...witness,create_incarnation:'different'}}});
  assert.deepEqual(judgeRecordedStopRemoval(home,expected,stopped),{status:'wrong-incarnation',pass:false});
  await save({lastRecovery:{attemptId:'original',removed:true,
    removalObservation:{...witness,before_at:{toString:null,valueOf:null}}}});
  assert.deepEqual(judgeRecordedStopRemoval(home,expected,stopped),{status:'unknown',pass:false});
  await save({lastRecovery:{attemptId:'original',removed:true}});
  assert.deepEqual(judgeRecordedStopRemoval(home,expected,stopped),{status:'unknown',pass:false});
});

const legacyStopped = Object.freeze({
  attemptState: 'stopped', lendingCurrent: null, attemptId: 'attempt-1',
  appProof: true, scan: Object.freeze({pids: Object.freeze([])}), runsUnchanged: true,
});
const legacyAppPass = {
  pass: true, source: 'app: pace50 attempt process_state ceased and cessation_proven',
  disagreement: null, missing: [],
};

for (const live of [true, false]) {
  test(`legacy cessation has a positive app-proof path (live=${live})`, () => {
    const input = Object.freeze({...legacyStopped, live});
    const before = structuredClone(input);
    assert.deepEqual(judgeNothingRunning(input), legacyAppPass);
    assert.deepEqual(input, before);
  });

  test(`legacy clean process scan remains sufficient without app proof (live=${live})`, () => {
    assert.deepEqual(judgeNothingRunning({...legacyStopped, live, appProof: false}), {
      pass: true, source: 'sbx process scan: no containerd-shim process for this sbx home',
      disagreement: null, missing: [],
    });
  });
}

test('only synthetic legacy cessation depends on the synthetic run counter', () => {
  assert.deepEqual(judgeNothingRunning({...legacyStopped, live: false}), legacyAppPass);
  assert.deepEqual(judgeNothingRunning({...legacyStopped, live: false, runsUnchanged: false}), {
    pass: false, source: 'synthetic run counter changed after the Stop', missing: [],
  });
  assert.deepEqual(judgeNothingRunning({...legacyStopped, live: true, runsUnchanged: false}), legacyAppPass);
});

// These are decision fixtures, not evidence of a physical/native cessation run.
const expectedRun = Object.freeze({
  platform: 'linux', hostId: 'host-1', sandboxId: 'sandbox-1', attemptId: 'attempt-1',
});
const boundStopped = Object.freeze({
  ...legacyStopped, expected: expectedRun,
  scan: Object.freeze({...expectedRun, kind: 'process', result: 'ceased', pids: Object.freeze([])}),
  host: Object.freeze({...expectedRun, kind: 'host-identity', result: 'match', observedHostId: 'host-1'}),
  sandboxes: Object.freeze({...expectedRun, kind: 'sandbox-list', result: 'absent', sandboxes: Object.freeze([])}),
});
const boundPass = {
  pass: true,
  source: 'app: pace50 attempt process_state ceased and cessation_proven; bound native process, host and sandbox observations agree',
  disagreement: null, missing: [],
};

test('only synthetic bound cessation depends on the synthetic run counter', () => {
  assert.deepEqual(judgeNothingRunning({...boundStopped, live: false}), boundPass);
  assert.deepEqual(judgeNothingRunning({...boundStopped, live: false, runsUnchanged: false}), {
    pass: false, source: 'synthetic run counter changed after the Stop', missing: [],
  });
  assert.deepEqual(judgeNothingRunning({...boundStopped, live: true, runsUnchanged: false}), boundPass);
});

for (const live of [true, false]) {
  test(`bound cessation passes with complete matching evidence (live=${live})`, () => {
    const input = Object.freeze({...boundStopped, live});
    const before = structuredClone(input);
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(input, before);
  });

  test(`bound cessation rejects a different observed host (live=${live})`, () => {
    const input = {...boundStopped, live};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(judgeNothingRunning({...input, host: {...input.host, observedHostId: 'host-2'}}), {
      pass: false, source: null, missing: ['host mismatch: observed host is not the expected host'],
    });
  });

  test(`bound cessation rejects a different listed sandbox (live=${live})`, () => {
    const entry = {sandboxId: expectedRun.sandboxId, attemptId: expectedRun.attemptId, state: 'stopped'};
    const sandboxes = {...boundStopped.sandboxes, result: 'found', sandboxes: [entry]};
    const input = {...boundStopped, live, sandboxes};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(judgeNothingRunning({...input,
      sandboxes: {...sandboxes, sandboxes: [{...entry, sandboxId: 'sandbox-2'}]},
    }), {
      pass: false, source: null, missing: ['sandbox mismatch: listed sandbox or attempt is not the expected run'],
    });
    assert.deepEqual(judgeNothingRunning({...input,
      sandboxes: {...sandboxes, sandboxes: [{...entry, attemptId: 'attempt-2'}]},
    }), {
      pass: false, source: null, missing: ['sandbox mismatch: listed sandbox or attempt is not the expected run'],
    }, 'matching listed sandbox must also carry the requested attempt');
  });

  test(`bound cessation rejects evidence from another requested attempt (live=${live})`, () => {
    const input = {...boundStopped, live};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    // Change the requested run only; every evidence envelope still belongs to attempt-1.
    assert.deepEqual(judgeNothingRunning({...input, attemptId: 'attempt-2',
      expected: {...expectedRun, attemptId: 'attempt-2'}}), {
      pass: false, source: null, missing: [
        'attempt mismatch: native process evidence has a different attemptId binding',
        'attempt mismatch: host identity evidence has a different attemptId binding',
        'attempt mismatch: sandbox-list evidence has a different attemptId binding',
      ],
    });
  });

  test(`bound cessation needs app proof even with clean native observations (live=${live})`, () => {
    const input = {...boundStopped, live};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(judgeNothingRunning({...input, appProof: false}), {
      pass: null, source: null,
      missing: ['app cessation proof is missing: pace50 attempt process_state is not ceased with cessation_proven'],
    });
  });

  test(`bound unknown process observation remains unresolved (live=${live})`, () => {
    const input = {...boundStopped, live};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(judgeNothingRunning({...input, scan: {...input.scan, result: 'unknown'}}), {
      pass: null, source: null, missing: ['native process observation unknown'],
    });
  });

  test(`bound active scan conflicts with app cessation proof (live=${live})`, () => {
    const input = {...boundStopped, live};
    assert.deepEqual(judgeNothingRunning(input), boundPass);
    assert.deepEqual(judgeNothingRunning({...input, scan: {...input.scan, result: 'active', pids: [1234]}}), {
      pass: false, source: null, disagreement: 'sbx scan still lists pids 1234',
      missing: ['unresolved app/process scan conflict: sbx scan still lists pids 1234'],
    });
  });
}
