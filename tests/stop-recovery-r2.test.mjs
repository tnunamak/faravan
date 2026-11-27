import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {fileSbx, receiptBackend, receiptedHandle} from './helpers/sandbox-receipt-fixture.mjs';
import {deferred, until} from './helpers/v1-lender-fixture.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client:f.client, backend:f.backend, adapters:f.adapters, policy:f.policy,
    clock:f.clock, approve:async () => true, onEvent:e => f.events.push(e)});
  const task = lender.start(controller.signal).catch(e => {
    if (e.name !== 'AbortError' && e.code !== 'aborted') throw e;
  });
  f.stop = async () => {controller.abort(); await task;};
  return lender;
}
const runs = f => f.calls.filter(([kind]) => kind === 'run').length;

for (const restart of [false, true])
test(`deleted completed job releases stopped-report recovery (restart=${restart})`, {timeout:15000}, async t => {
  let lose = true;
  const f = await realLenderFixture(t, {intercept(req) {
    if (lose && req.url.endsWith('/stopped')) {req.socket.destroy(); return true;}
    return false;
  }});
  launch(f);
  await until(() => f.events.some(e => e.reason === 'stop_report_pending'), 'stopped report retained', 5000);
  await f.owner.deleteJob(f.jobDigest);
  const next = await f.submit();
  lose = false;
  if (restart) {await f.stop(); launch(f);} else f.clock.advance(1000);
  await until(() => runs(f) === 2, 'next job starts after definitive missing report', 5000);
  await until(() => f.events.filter(e => e.status === 'finished').length === 2, 'second completion', 5000);
  await f.stop();
  assert.equal(f.saved().stoppedPending, null);
  assert.equal((await f.owner.getJob(next)).state, 'result-accepted');
});

test('persistent malformed completion ACK parks retained output and runs the next job', {timeout:15000}, async t => {
  let first = null;
  const f = await realLenderFixture(t, {intercept(req, res) {
    if (!req.url.endsWith('/complete')) return false;
    first ??= req.url;
    if (req.url !== first) return false;
    const head = res.writeHead, end = res.end;
    res.writeHead = function(status, headers) {
      return head.call(this, status, Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-length')));
    };
    res.end = function(bytes, ...args) {return end.call(this, this.statusCode === 200 ? '{}' : bytes, ...args);};
    return false;
  }});
  launch(f);
  await until(() => f.events.some(e => e.reason === 'invalid_response'), 'unknown ACK retained', 5000);
  const intent = structuredClone(f.saved().resultPending);
  const next = await f.submit();
  for (let i = 0; i < 5 && runs(f) < 2; i++) {
    // Under load the next job may start after the check above; wait for either, never for an idle that will not come.
    await until(() => runs(f) >= 2 || f.clock.pending().includes(1000), 'retry idle or next job', 5000);
    if (runs(f) >= 2) break;
    f.clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await until(() => runs(f) === 2, 'next job after bounded unknown ACKs', 1000);
  await until(() => f.events.some(e => e.status === 'finished'), 'second result delivered', 5000);
  await f.stop();
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
  assert.equal((await f.owner.getJob(next)).state, 'result-accepted');
  assert.deepEqual(f.saved().rejectedResult.intent.payload, intent.payload);
  assert.equal(f.saved().lastResultOutcome.outcome, 'unknown');
  assert.ok(f.events.some(e => e.status === 'result-unconfirmed'));
  assert.equal(f.events.some(e => e.status === 'failed'), false);
  assert.ok(f.realRequests.filter(q => q.url === first).every(q => q.key === intent.idempotencyKey));
});

test('throwing measurement sink during finish preserves delivery and leaves quota exposure unresolved', {timeout:15000}, async t => {
  const f = await realLenderFixture(t, {run:{model:'gpt-6-sol'}, guardTokens:{input:100,output:10,cached_input:0,cache_write:0,reasoning_output:0}});
  let failing = false, writes = 0;
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start:f.clock.now()});
  const runtime = createLendingRuntime({directory:join(f.root, 'quota'), now:() => f.clock.now(),
    settings:() => ({intent:'on', limits:{lendingPolicy:normalizeLendingPolicy({providerConsent:{codex:true}}),
      dailyJobs:10, dailyMinutes:60, maxWallSeconds:300, idleOnly:false}}),
    backend:{}, presence:() => false, lastActiveAt:() => null, selfKey:() => null,
    pace50:{account:'synthetic-account', account_week_id:'synthetic-week-1',
    source,
    measurementHistory:{record() {if (failing) {writes++; throw new Error('measurement disk write failed');} return 'synthetic-row';}}}});
  f.policy.lendingRuntime = runtime;
  const collect = f.backend.collectDeclaredOutputs;
  f.backend.collectDeclaredOutputs = async (...args) => {const out = await collect(...args); failing = true; source.state.used.weekly += 2_000_000; source.state.used.short += 2_000_000; return out;};
  launch(f);
  await until(() => f.events.some(e => ['finished','failed','declined','reserve','paused'].includes(e.status)), 'finished work delivered', 5000);
  await f.stop();
  assert.ok(writes > 0, JSON.stringify(f.events));
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
  assert.equal(f.events.some(e => e.status === 'failed'), false);
  const attempt=runtime.pace50.state().attempts[0];
  assert.equal(attempt.hold_closed,false);
  assert.ok(attempt.resources.every(r=>r.held_micro+r.unrepresented_micro===r.initial_micro&&r.released_micro===0));
  assert.equal(runtime.candidate.measurementStatus().failedWrites, writes);
});

// Replace every 200 reply to a matching request with an unreadable body.
const unreadableReply = (res) => {
  const head = res.writeHead, end = res.end;
  res.writeHead = function(status, headers) {
    return head.call(this, status, Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-length')));
  };
  res.end = function(bytes, ...args) {return end.call(this, this.statusCode === 200 ? '{}' : bytes, ...args);};
};

test('a persistently unreadable stopped-report reply is bounded and the next job runs', {timeout:15000}, async t => {
  let stops = 0;
  const f = await realLenderFixture(t, {intercept(req, res) {
    if (req.url.endsWith('/stopped')) {stops++; unreadableReply(res);}
    return false;
  }});
  launch(f);
  await until(() => f.events.some(e => e.reason === 'stop_report_pending'), 'stopped report retained', 5000);
  const next = await f.submit();
  for (let i = 0; i < 6 && runs(f) < 2; i++) {
    // Under load the next job may start after the check above; wait for either, never for an idle that will not come.
    await until(() => runs(f) >= 2 || f.clock.pending().includes(1000), 'retry idle or next job', 5000);
    if (runs(f) >= 2) break;
    f.clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await until(() => runs(f) === 2, 'next job after bounded unreadable replies', 1000);
  await until(() => f.events.filter(e => e.status === 'finished').length === 2, 'second completion', 5000);
  await f.stop();
  assert.ok(stops <= 8, `stopped reports sent: ${stops}`);
  assert.equal((await f.owner.getJob(next)).state, 'result-accepted');
  assert.equal(f.events.some(e => e.status === 'failed'), false);
});

test('a refusal that can clear keeps the stopped report until it is recorded', {timeout:15000}, async t => {
  let refuse = true, refused = 0;
  const f = await realLenderFixture(t, {intercept(req, res) {
    if (!refuse || !req.url.endsWith('/stopped')) return false;
    refused++;
    res.writeHead(409, {'content-type':'application/problem+json'});
    res.end(JSON.stringify({type:'about:blank', title:'Conflict', status:409, code:'conflict'}));
    return true;
  }});
  launch(f);
  await until(() => f.events.some(e => e.reason === 'stop_report_pending'), 'stopped report retained', 5000);
  for (let i = 0; i < 4; i++) {
    await until(() => f.clock.pending().includes(1000), 'retry idle', 5000);
    f.clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(refused >= 4, `refusals seen: ${refused}`);
  assert.notEqual(f.saved().stoppedPending, null, 'a conflict does not drop the report');
  refuse = false;
  await until(() => f.clock.pending().includes(1000), 'retry idle', 5000);
  f.clock.advance(1000);
  await until(() => f.saved().stoppedPending === null, 'report recorded once the refusal clears', 5000);
  await f.stop();
});


for(const matchIncarnation of [true,false])
test(`Stop records cleanup and release before replaying the exact lost stopped acknowledgement (matching incarnation=${matchIncarnation})`, {timeout:45000}, async t => {
  const removal = deferred();
  t.after(() => removal.resolve());
  let reports = 0;
  let lostReportStatus;
  let acknowledgedReportStatus;
  let releaseStatus;
  let proofAtRelease;
  let removalAtRelease;
  const f = await realLenderFixture(t, {hold:true, intercept(req, res) {
    if (req.url.endsWith('/release')) {
      proofAtRelease = structuredClone(f.saved().pending?.cessationVerified);
      removalAtRelease = structuredClone(f.saved().pending?.removalObservation);
      res.once('finish', () => { releaseStatus = res.statusCode; });
    }
    if (!req.url.endsWith('/stopped')) return false;
    if (++reports === 1) {
      // Let the real coordinator commit the report before dropping its response.
      res.writeHead = function(status) { this.statusCode = status; return this; };
      res.end = function() { lostReportStatus = this.statusCode; req.socket.destroy(); return this; };
    } else {
      res.once('finish', () => { acknowledgedReportStatus = res.statusCode; });
    }
    return false;
  }});
  const sbx = fileSbx(join(f.root, 'stop-inventory'));
  const cleanup = receiptBackend(f.root, sbx);
  const foreign = 'wf-ffffffffffffffff';
  await sbx.run(['create', '--name', foreign]);
  const prepare = f.backend.prepare;
  f.backend.sandboxOwnership = () => cleanup.sandboxOwnership();
  f.backend.prepare = async spec => {
    const execution = await prepare(spec);
    const handle = await receiptedHandle(cleanup, {job_id: spec.job_id, ...cleanup.sandboxOwnership()});
    await sbx.run(['create', '--name', handle.sandbox_id]);
    return {...execution, ...handle};
  };
  f.backend.requestStop = async () => ({delivered:false});
  let removalWitness;
  f.backend.destroy = async handle => {
    f.calls.push(['destroy']);
    await removal.promise;
    const {owner_scope, sbx_home, jobId, sandboxId, attempt} = f.saved().pending;
    const before = sbx.read();
    const cursor = sbx.calls().length;
    const receipt = await cleanup.destroy(handle);
    removalWitness = {
      owner_scope, sbx_home, jobId, sandboxId, attempt, incarnation:handle._cleanupId, before, after: sbx.read(), receipt,
      commands: sbx.calls().slice(cursor).filter(([op]) => op === 'ls' || op === 'rm'),
    };
    return matchIncarnation ? receipt : {...receipt,removal_observation:{
      ...receipt.removal_observation,create_incarnation:'another-incarnation',
    }};
  };
  const lender = launch(f);
  await until(() => f.events.some(event => event.status === 'running'), 'lender observed agent launch');
  const before = await f.owner.getJob(f.jobDigest);
  const attempt = before.current_attempt;
  assert.equal(attempt.state, 'active');
  assert.equal(before.attempts_started, 1);
  await lender.stopCurrentJob(attempt.attempt_id);

  const removals = () => f.calls.filter(([kind]) => kind === 'destroy').length;
  await until(() => removals() === 1, 'backend removal requested');
  assert.equal(f.saved().pending.cessationVerified, undefined);
  assert.equal(lender.cessation().proven, false);
  assert.equal(f.realRequests.some(request => /\/(?:release|stopped)$/.test(request.url)), false);
  removal.resolve();

  await until(() => f.events.some(event => event.reason === 'stop_report_pending'), 'retryable failure retained');
  assert.equal(lostReportStatus, 200, 'the coordinator accepted the report whose reply was lost');
  const saved = structuredClone(f.saved().pending);
  assert.equal(releaseStatus, 200);
  assert.equal(saved.stopReleased, true);
  assert.deepEqual(saved.cessationVerified, {
    sbx_home:f.backend.sandboxOwnership().sbx_home, attemptId:attempt.attempt_id,
    jobDigest:f.jobDigest, generation:attempt.generation,
  });
  assert.deepEqual(proofAtRelease, saved.cessationVerified);
  assert.deepEqual(removalAtRelease, saved.removalObservation);
  const {owner_scope, sbx_home, jobId, sandboxId, attempt: removedAttempt, incarnation, before: listed, after: remaining, receipt, commands} = removalWitness;
  assert.equal(owner_scope, cleanup.sandboxOwnership().owner_scope);
  assert.equal(sbx_home, receipt.sbx_home);
  assert.equal(jobId, receipt.job_id);
  assert.equal(sandboxId, receipt.sandbox_id);
  assert.equal(removedAttempt.job_digest, f.jobDigest);
  assert.equal(removedAttempt.attempt_id, attempt.attempt_id);
  assert.equal(removedAttempt.generation, attempt.generation);
  assert.equal(receipt.removed, true);
  assert.equal(receipt.removal_observation?.create_incarnation, incarnation);
  assert.deepEqual(removalAtRelease, matchIncarnation ? {
    attemptId:attempt.attempt_id, jobDigest:f.jobDigest, generation:attempt.generation,
    sandboxId, jobId, ownerScope:owner_scope,
    runtimeId: saved.sbx_runtime.id,
    ...receipt.removal_observation,
  } : undefined);
  const beforeAt = Date.parse(receipt.removal_observation.before_at);
  const afterAt = Date.parse(receipt.removal_observation.after_at);
  assert.ok(Number.isFinite(beforeAt) && beforeAt <= afterAt && afterAt <= Date.parse(receipt.at));
  assert.ok(listed.includes(sandboxId));
  assert.deepEqual(remaining, [foreign]);
  assert.deepEqual(commands.slice(0, 3), [['ls','--json'], ['rm','--force',sandboxId], ['ls','--json']]);
  assert.deepEqual(commands.filter(args => args[0] === 'rm'), [['rm','--force',sandboxId]]);

  const committed = (await f.owner.getJob(f.jobDigest)).current_attempt;
  assert.equal(committed.attempt_id, attempt.attempt_id);
  assert.equal(committed.generation, attempt.generation);
  assert.equal(committed.state, 'released');
  assert.equal(committed.compute_stopped, true);
  assert.equal(committed.stopped_at, saved.stoppedAt);
  await f.stop();

  f.policy.enabled = false;
  f.policy.recoveryOnly = true;
  launch(f);
  await until(() => f.saved().pending === null, 'acknowledged recovery cleared the journal');
  assert.equal(acknowledgedReportStatus, 200);
  assert.equal(f.saved().lastRecovery.attemptId,attempt.attempt_id);
  assert.deepEqual(f.saved().lastRecovery.removalObservation,removalAtRelease);
  const requests = f.realRequests.filter(request => request.url.endsWith('/stopped'));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, saved.stopReportKey);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(f.realRequests.filter(request => request.url.endsWith('/release')).length, 1);
  const after = await f.owner.getJob(f.jobDigest);
  assert.equal(after.attempts_started, 1);
  assert.deepEqual(after.current_attempt, committed);
  assert.equal(runs(f), 1);
  assert.equal(removals(), 1);
  assert.equal(f.saved().jobs, 1);
  await f.stop();
});
