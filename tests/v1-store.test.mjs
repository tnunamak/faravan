import './helpers/no-browser.mjs';
import {currentAdvertisement,accountHeartbeat,selectionForJob,currentReceipt} from './helpers/current-job-advertisement.mjs';
import {invitationRevocation} from '../lib/v1/invitation-revoke.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';
import { jobStatusLabel, adaptLegacyJob } from '../lib/v1/state-projection.mjs';
import { jobStatusContract } from '../lib/v1/status-contract.mjs';
import { opById } from '../lib/v1/ops/registry.mjs';
import { MEMBER_CAPABILITIES } from '../lib/v1/versions.mjs';

// All keys are public TEST-ONLY fixtures; no enrollment, network, provider or model calls.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = [...golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex'))),
  p.privateKeyFromSeed(Buffer.alloc(32, 5)), p.privateKeyFromSeed(Buffer.alloc(32, 6))];
const pub = keys.map(p.exportPublicKey);
const fp = pub.map(p.fingerprint);
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k,v]) => [k,v.envelope]));
const circle = vectors.job.payload.circle;
const origin = 'https://coordinator.example';
const base = origin + '/v1/circles/' + circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const segment = digest => digest.slice(7);
const advertisement = currentAdvertisement({
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'],
  egress: ['provider-only'], enforced_limits: Object.keys(vectors.job.payload.requirements.limits),
  max_limits: vectors.job.payload.requirements.limits,
});
const code = (fn, expected) => assert.throws(fn,
  error => error instanceof p.ProtocolError && error.code === expected,
  'expected ProtocolError ' + expected);
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-test-'));
  let now = start, sequence = 0;
  const options = { path: join(dir, 'store.sqlite'), circle, origin, rootFingerprint: fp[2],
    initialRoster: vectors.roster, clock: () => now,
    idGenerator: () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + (++sequence).toString(16).padStart(12, '0'),
    ...extra };
  let store = openV1Store(options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = {
    get store() { return store; }, options, get now() { return now; }, epoch: 7,
    advance(seconds) { now += seconds; },
    reopen() { store.close(); store = openV1Store(options); },
    ctx(device, method, route, body, overrides = {}) {
      return { proof: p.buildRequestProof({
        circle, roster_epoch: f.epoch, method, target: base + route,
        body: method === 'GET' ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body)),
        content_type: method === 'GET' ? '' : 'application/json', artifact_media_type: '',
        idempotency_key: method === 'POST' ? randomUUID() : '',
        created: now, nonce: randomBytes(16).toString('base64url'), ...overrides,
      }, keys[device]) };
    },
    reserve(ref, device = 0, transport = false, job) {
      const route = '/artifacts/' + segment(ref.digest);
      const ctx = { proof: p.buildRequestProof({ circle, roster_epoch: f.epoch, method: 'PUT',
        target: base + route, body_digest: ref.digest, content_length: ref.bytes,
        content_type: 'application/octet-stream', artifact_media_type: ref.media_type,
        idempotency_key: '', created: now, nonce: randomBytes(16).toString('base64url') }, keys[device]) };
      return store.reserveArtifact(fp[device], ref, { ...ctx, transport, ...(job ? { job } : {}) });
    },
    // The transport upload path: reserve, then install the bytes. `job` binds the upload to the job it delivers.
    finish(ref, device = 0, job, install = () => {}) {
      const reservation = f.reserve(ref, device, true, job);
      return store.finishArtifactUpload(fp[device], reservation.reservation_id, ref, install,
        reservation.owner_token, { verifiedInput: true, ...(job ? { job } : {}) });
    },
    // The existence probe a lender sends before it uploads a result file.
    head(ref, device = 0, job) {
      const route = '/artifacts/' + segment(ref.digest);
      return store.getArtifact(fp[device], ref.digest, { ...f.ctx(device, 'GET', route, null, { method: 'HEAD' }), ...(job ? { job } : {}) }, 'HEAD');
    },
    deleteJob(digest, device = 0) {
      return store.deleteJob(fp[device], digest, f.ctx(device, 'POST', '/jobs/' + segment(digest) + '/delete', {}));
    },
    upload(ref, device = 0) {
      const reservation = f.reserve(ref, device);
      return f.commit(reservation.reservation_id, ref, device);
    },
    commit(id, ref, device = 0, overrides = {}) {
      return store.commitArtifact(fp[device], id, ref,
        f.ctx(device, 'POST', '/artifact-reservations/' + id + '/commit', ref, overrides));
    },
    job(overrides = {}, device = 0) {
      return p.signEnvelope('job', { ...vectors.job.payload, author: fp[device],
        roster_epoch: f.epoch, intent_id: randomUUID(), created_at: iso(now),
        expires_at: iso(now + 3600), ...overrides }, keys[device]);
    },
    publish(job = f.job(), device = 0, overrides = {}) {
      return store.publishJob(job, f.ctx(device, 'POST', '/jobs', job, overrides));
    },
    claim(digest, device = 1, lease = 120, overrides = {}, ad = advertisement) {
      f.advertise(device);
      const body = { advertisement: ad, lease_seconds: lease };
      return store.claimJob(fp[device], digest, ad,
        f.ctx(device, 'POST', '/jobs/' + segment(digest) + '/claim', body, overrides), lease);
    },
    advertise(device = 1) {
      const body = accountHeartbeat(advertisement);
      return store.heartbeat(fp[device],body,f.ctx(device,'POST','/heartbeat',body));
    },
    claimNext(device, ad, context, lease) {
      f.advertise(fp.indexOf(device));
      return store.claimNext(device,ad,context,lease);
    },
    requestStart(attempt, device = 1, overrides = {}) {
      const body = { generation: attempt.generation };
      return store.start(fp[device], attempt.attempt_id, attempt.generation,
        f.ctx(device, 'POST', '/attempts/' + attempt.attempt_id + '/start', body, overrides));
    },
    start(attempt, device = 1, overrides = {}) {
      f.requestStart(attempt,device,overrides);
      const body={generation:attempt.generation},route='/attempts/'+attempt.attempt_id+'/observed-start';
      return store.observeExecutionStart(fp[device],attempt.attempt_id,attempt.generation,f.ctx(device,'POST',route,body));
    },
    get(digest, device = 0) {
      return store.getJob(fp[device], digest, f.ctx(device, 'GET', '/jobs/' + segment(digest)));
    },
    attempt(id, device = 0) {
      return store.getAttempt(fp[device], id, f.ctx(device, 'GET', '/attempts/' + id));
    },
    result(job, attempt, overrides = {}, device = 1) {
      return p.signEnvelope('result', { ...vectors.result.payload,
        job_digest: p.digest(job.payload), attempt_id: attempt.attempt_id, generation: attempt.generation,
        executor: fp[device], roster_epoch: f.epoch, submitted_at: iso(now), ...overrides, receipt:currentReceipt(overrides.receipt??vectors.result.payload.receipt,attempt.selection) }, keys[device]);
    },
    complete(result, device = 1, overrides = {}) {
      return store.complete(result, f.ctx(device, 'POST',
        '/attempts/' + result.payload.attempt_id + '/complete', result, overrides));
    },
    end(kind, attempt, device = 1, reason = 'test-only stop') {
      const body = { generation: attempt.generation, reason };
      return store[kind](fp[device], attempt.attempt_id, attempt.generation, reason,
        f.ctx(device, 'POST', '/attempts/' + attempt.attempt_id + '/' + kind, body));
    },
    cancel(job, overrides = {}, device = 0) {
      const envelope = p.signEnvelope('cancellation', { schema: 'faravan.cancellation.v1', circle,
        job_digest: p.digest(job.payload), author: fp[device], roster_epoch: f.epoch,
        created_at: iso(now), reason: 'test-only cancellation', ...overrides }, keys[device]);
      return store.cancel(envelope, f.ctx(device, 'POST',
        '/jobs/' + segment(envelope.payload.job_digest) + '/cancel', envelope));
    },
    roster(members = vectors.roster.payload.members, epoch = f.epoch + 1, overrides = {}) {
      return p.signEnvelope('roster', { ...vectors.roster.payload, epoch, members, ...overrides }, keys[2]);
    },
    install(roster, device = 0) {
      const outcome = store.installRoster(roster, f.ctx(device, 'PUT', '/roster', roster, { roster_epoch: roster.payload.epoch }));
      f.epoch = roster.payload.epoch;
      return outcome;
    },
    quotas(device = 0) {
      return store.getQuotas(fp[device], f.ctx(device, 'GET', '/quotas'));
    },
    list(limit = 2, cursor = null, device = 0) {
      const route = '/jobs?limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      return store.listJobs(fp[device], { limit, cursor, accepts:['run_request_v1'] }, f.ctx(device, 'GET', route));
    },
  };
  return f;
}
function inputs(f) {
  f.upload(vectors.job.payload.source.artifact);
  f.upload(vectors.job.payload.prompt);
}

test('jobs.wait settles a cancelled released attempt that never started, but waits on running or unknown cessation', async t => {
  const f=fixture(t);inputs(f);
  const sent=f.job(),digest=p.digest(sent.payload);f.publish(sent);
  const attempt=f.claim(digest).attempt;
  f.end('release',attempt,1,JSON.stringify({code:'refresh_failed'}));
  const released=f.get(digest);
  assert.equal(released.state,'queued');assert.equal(released.attempts_started,0);
  assert.equal(released.current_attempt.state,'released');
  assert.equal(released.current_attempt.execution_started_at,null);
  assert.equal(released.current_attempt.execution_observed_at,null);
  f.cancel(sent);
  const cancelled=f.get(digest);
  assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.attempts_started,0);
  assert.equal(cancelled.current_attempt.state,'released');

  const wait=async view=>opById('jobs.wait').handler({call:async id=>{
    assert.equal(id,'jobs.get');return {...view,status:jobStatusLabel(view)};
  }},{digest,timeout_seconds:0});
  const completed=await wait(cancelled);
  assert.equal(completed.done,true);
  assert.equal(completed.job.status,'Cancelled');

  const running={...cancelled,attempts_started:1,current_attempt:{...cancelled.current_attempt,
    state:'cancelled',execution_started_at:iso(f.now),execution_observed_at:iso(f.now),compute_stopped:false}};
  const stillStopping=await wait(running);
  assert.equal(stillStopping.done,false);
  assert.equal(stillStopping.job.status,'Stopping');
  const unknown={...cancelled};delete unknown.current_attempt;
  const unknownWait=await wait(unknown);
  assert.equal(unknownWait.done,false);
  assert.equal(unknownWait.job.status,'Stopping');
});

function outputs(f) {
  f.upload(vectors.result.payload.candidate, 1);
  f.upload(vectors.result.payload.transcript, 1);
}

test('v1 happy path preserves signed inputs, renewal, result and original acknowledgement', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload), published = f.publish(job);
  assert.equal(published.state, 'queued'); assert.equal(published.attempts_started, 0);
  assert.deepEqual(published.job, job);
  const claim = f.claim(digest), a = claim.attempt;
  assert.equal(a.generation, 1); assert.equal(a.holder, fp[1]); assert.equal(a.state, 'active');
  assert.equal(claim.job.attempts_started, 0);
  assert.equal(a.execution_started_at, null);
  code(() => f.complete(f.result(job, a)), 'conflict');
  const started = f.start(a);
  assert.equal(started.execution_started_at, iso(f.now));
  assert.deepEqual(f.start(a), started, 'start with a fresh key is still counted exactly once');
  assert.equal(f.get(digest).attempts_started, 1);
  f.advance(10);
  const body = { generation: a.generation, lease_seconds: 120 };
  const renewed = f.store.renew(fp[1], a.attempt_id, a.generation,
    f.ctx(1, 'POST', '/attempts/' + a.attempt_id + '/renew', body), 120);
  assert.equal(renewed.generation, a.generation);
  assert.ok(Date.parse(renewed.lease_expires_at) >= Date.parse(a.lease_expires_at));
  const result = f.result(job, a), ack = f.complete(result);
  assert.equal(ack.status, 'result-accepted'); assert.equal(ack.result_digest, p.digest(result.payload));
  assert.equal(f.get(digest).state, 'result-accepted');
  assert.deepEqual(f.store.getResult(fp[0], digest, f.ctx(0, 'GET', '/jobs/' + segment(digest) + '/result')), result);
  f.advance(86401);
  assert.deepEqual(f.complete(result), ack, 'retained exact result acknowledgement outlives lease and key window');
  assert.deepEqual(f.publish(job), published, 'retained publish acknowledgement never reruns job');
  code(() => f.complete(f.result(job, a, { submitted_at: iso(f.now) })), 'conflict');
});

// Launch fence. A start the coordinator authorized but never saw begin may still be
// running, so its job must not go back to the queue until the holder proves the run
// is gone (POST /stopped, sent only after cleanup proof) or reports that it ran.
function thirdMember() {
  const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
  return {key_id:fp[3],public_key:golden.keys[3].public_key,joined_epoch:vectors.roster.payload.epoch};
}
function secondLender(f) {f.install(f.roster([...vectors.roster.payload.members,thirdMember()]));}
const reportStopped=(f,attempt,device=1)=>{
  const body={generation:attempt.generation,stopped_at:iso(f.now)};
  return f.store.stopped(fp[device],attempt.attempt_id,attempt.generation,body.stopped_at,
    f.ctx(device,'POST','/attempts/'+attempt.attempt_id+'/stopped',body));
};
const observeLate=(f,attempt,device=1)=>{
  const body={generation:attempt.generation},route='/attempts/'+attempt.attempt_id+'/observed-start';
  return f.store.observeExecutionStart(fp[device],attempt.attempt_id,attempt.generation,f.ctx(device,'POST',route,body));
};
const renewOld=(f,attempt)=>f.store.renew(fp[1],attempt.attempt_id,attempt.generation,
  f.ctx(1,'POST','/attempts/'+attempt.attempt_id+'/renew',{generation:attempt.generation,lease_seconds:120}),120);

test('launch fence repro: an authorized, unobserved start whose lease expires cannot be claimed for a second run',t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  assert.equal(f.attempt(first.attempt_id).execution_observed_at,null,'authorized, never observed');
  f.advance(30);
  assert.equal(f.get(digest).state,'claimed','the first run may still be going');
  code(()=>f.claim(digest,3),'conflict');
  code(()=>f.claim(digest,1),'conflict');
});

for(const how of ['release','fail','revoke'])test('launch fence: an unknown launch is not requeued after '+how,t=>{
  const f=fixture(t);inputs(f);
  const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  if(how==='revoke')f.install(f.roster([vectors.roster.payload.members[0]]));else f.end(how,first);
  assert.equal(f.get(digest).state,'claimed');
  const held=f.attempt(first.attempt_id);
  assert.notEqual(held.state,'active');assert.equal(held.execution_observed_at,null);assert.equal(held.compute_stopped,false);
  if(how!=='revoke')code(()=>f.claim(digest,1),'conflict');
  f.advance(600);
  assert.equal(f.get(digest).state,'claimed','without proof it stays held while the first run may still be going');
});

for(const how of ['lease','release','fail'])test('launch fence: a stop report proves the run is gone and requeues without spending budget after '+how,t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  code(()=>reportStopped(f,first),'conflict');
  if(how==='lease')f.advance(30);else f.end(how,first);
  assert.equal(f.get(digest).state,'claimed');
  code(()=>reportStopped(f,first,0),'forbidden');
  const stopped=reportStopped(f,first);
  assert.equal(stopped.compute_stopped,true);
  assert.equal(f.get(digest).state,'queued');assert.equal(f.get(digest).attempts_started,0);
  assert.deepEqual(reportStopped(f,first),stopped,'a repeated stop report changes nothing');
  const second=f.claim(digest,3).attempt;
  assert.notEqual(second.attempt_id,first.attempt_id);
  code(()=>renewOld(f,first),'stale_attempt');
});

test('launch fence: the old attempt loses its authority with lease_fenced',t=>{
  const f=fixture(t);inputs(f);outputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.advance(30);
  code(()=>renewOld(f,first),'lease_fenced');
  code(()=>f.requestStart(first),'lease_fenced');
  // Cleanup calls answer lease_expired, which lenders before the fence already accept.
  code(()=>f.end('release',first),'lease_expired');
  code(()=>f.end('fail',first),'lease_expired');
  code(()=>f.store.requestStop(fp[1],first.attempt_id,first.generation,
    f.ctx(1,'POST','/attempts/'+first.attempt_id+'/stop-request',{generation:first.generation})),'lease_expired');
  code(()=>f.complete(f.result(job,first)),'lease_fenced');
  assert.equal(f.get(digest).state,'claimed');
});

test('launch fence: a late observation keeps late result delivery for a run that did happen',t=>{
  const f=fixture(t);inputs(f);outputs(f);
  const job=f.job({max_attempts:3}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.advance(30);
  const observed=observeLate(f,first);
  assert.ok(observed.execution_observed_at);
  const view=f.get(digest);
  assert.equal(view.state,'failed','an observed run never requeues by itself (T21)');
  assert.equal(view.attempts_started,1);
  code(()=>f.claim(digest,1),'retry_exhausted');
  assert.equal(f.complete(f.result(job,first)).status,'result-accepted');
});

test('launch fence: a released run that is observed later fails the job and is not requeued',t=>{
  const f=fixture(t);inputs(f);outputs(f);
  const job=f.job({max_attempts:3}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.end('release',first);
  observeLate(f,first);
  assert.equal(f.get(digest).state,'failed');assert.equal(f.get(digest).attempts_started,1);
  code(()=>f.complete(f.result(job,first)),'job_terminal');
  assert.equal(reportStopped(f,first).compute_stopped,true);
  assert.equal(f.get(digest).state,'failed','a stop after the observation does not requeue');
});

test('launch fence survives a coordinator restart and is resolved only through proof',t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.advance(30);
  const held=f.attempt(first.attempt_id);
  f.reopen();f.advance(60);f.reopen();
  assert.equal(f.get(digest).state,'claimed');
  assert.deepEqual(f.attempt(first.attempt_id),held,'the fence is stable across restarts');
  code(()=>f.claim(digest,3),'conflict');code(()=>renewOld(f,first),'lease_fenced');
  reportStopped(f,first);f.reopen();
  assert.equal(f.get(digest).state,'queued');
  assert.ok(f.claim(digest,3).attempt);
});

// The fence ends when the first run must have ended: lease end + the job's wall limit + the longest lease (300 s).
const fenceBound=(attempt,job)=>Date.parse(attempt.lease_expires_at)/1000+job.payload.requirements.limits.wall_seconds+300;
const claimNext3=f=>f.claimNext(fp[3],advertisement,f.ctx(3,'POST','/jobs/claim-next',{advertisement,lease_seconds:30}),30);

for(const how of ['lease','release','fail','revoke'])test('launch fence: a held job requeues without spending a try at its time bound, after '+how,t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  if(how==='revoke')f.install(f.roster([vectors.roster.payload.members[0],thirdMember()]));
  else if(how!=='lease')f.end(how,first);
  const bound=fenceBound(first,job);
  f.advance(bound-1-f.now);
  assert.equal(f.get(digest).state,'claimed','held before the bound');
  assert.equal(claimNext3(f),null);code(()=>f.claim(digest,3),'conflict');
  f.advance(1);
  const view=f.get(digest);
  assert.equal(view.state,'queued','requeued at the bound');assert.equal(view.attempts_started,0,'no try spent');
  assert.equal(claimNext3(f).job.job_digest,digest,'another lender takes it from the offers');
});

test('launch fence: the time bound survives a coordinator restart',t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.advance(30);
  assert.equal(f.get(digest).state,'claimed');
  const bound=fenceBound(first,job);
  f.reopen();f.advance(bound-1-f.now);f.reopen();
  assert.equal(f.get(digest).state,'claimed','held before the bound after a restart');
  assert.equal(claimNext3(f),null);
  f.advance(1);f.reopen();
  assert.equal(f.get(digest).state,'queued','requeued at the bound after a restart');
  assert.equal(claimNext3(f).job.job_digest,digest);
});


for(const freed of ['stop report','time bound'])for(const max of [1,2])test('launch fence: a late observation after the '+freed+' spends a try without reviving the old try, max_attempts '+max,t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:max}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  if(freed==='stop report'){f.advance(30);reportStopped(f,first);}else f.advance(fenceBound(first,job)-f.now);
  assert.equal(f.get(digest).state,'queued');assert.equal(f.get(digest).attempts_started,0);
  observeLate(f,first);
  const view=f.get(digest);
  assert.equal(view.attempts_started,1,'the try did begin, so it counts');
  assert.throws(()=>renewOld(f,first),e=>['job_terminal','stale_attempt','lease_fenced'].includes(e.code),'the old try gets no authority back');
  if(max===1) {
    assert.equal(view.state,'failed','no try is left for a second run');
    code(()=>f.claim(digest,3),'retry_exhausted');
  } else {
    assert.equal(view.state,'queued');
    const second=f.claim(digest,3).attempt;f.requestStart(second,3);
    assert.equal(f.get(digest).current_attempt.attempt_id,second.attempt_id);
  }
});

test('launch fence: a stored wall limit outside the schema holds the fence until the deadline',t=>{
  const f=fixture(t);inputs(f);secondLender(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  for(const value of [null,'"600"',-1,1e300]) {
    db.prepare("UPDATE jobs SET data=json_set(data,'$.signed.payload.requirements.limits.wall_seconds',json(?)) WHERE id=?").run(String(value),digest);
    f.reopen();
    f.advance(Math.max(0,fenceBound(first,job)-f.now));
    assert.equal(f.get(digest).state,'claimed',String(value));
    code(()=>f.claim(digest,3),'conflict');
    const ready=db.prepare('SELECT ready FROM job_queue WHERE id=?').get(digest).ready;
    assert.ok(Number.isFinite(ready),'queue ready time is a number, not '+ready);
  }
  f.advance(3600);
  assert.equal(f.get(digest).state,'expired');
});

for(const how of ['lease','release'])test('launch fence: the borrower sees a held job wait for the lender to confirm the last try stopped, after '+how,t=>{
  const f=fixture(t);inputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);
  const observedAt=new Date(f.now*1000).toISOString();
  const preparing=adaptLegacyJob(f.get(digest),{observedAt});
  assert.equal(preparing.evidence.waitingExplanation,'A computer took this job and is getting ready.');
  if(how==='lease')f.advance(30);else f.end(how,first);
  const view=f.get(digest),held=adaptLegacyJob(view,{observedAt});
  assert.equal(held.phase,'waiting');
  assert.equal(held.evidence.waitingExplanation,'Waiting for the lender to confirm the last try stopped.');
  assert.deepEqual(held.actionHints,['cancel']);
  const contract=jobStatusContract({...view,jobProjection:held},{now:f.now*1000});
  assert.equal(contract.explanation,'Waiting for the lender to confirm the last try stopped.');
  assert.deepEqual(contract.allowedActions,['cancel']);
  reportStopped(f,first);
  assert.equal(adaptLegacyJob(f.get(digest),{observedAt}).evidence.waitingExplanation,'Waiting for someone to run it.');
});

test('launch fence: cancelling a fenced job ends it and still reports that compute is not proven stopped',t=>{
  const f=fixture(t);inputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.requestStart(first);f.advance(30);
  const ack=f.cancel(job);
  assert.equal(ack.compute_stopped,false);
  assert.equal(f.get(digest).state,'cancelled');
  assert.equal(reportStopped(f,first).compute_stopped,true);
  assert.equal(f.get(digest).state,'cancelled');
});

test('launch fence leaves claims that never asked to start unchanged',t=>{
  const f=fixture(t);inputs(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const first=f.claim(digest,1,30).attempt;f.end('release',first);
  assert.equal(f.get(digest).state,'queued');
  const second=f.claim(digest,1,30).attempt;f.advance(30);
  assert.equal(f.get(digest).state,'queued');
  assert.equal(f.attempt(second.attempt_id).state,'expired');
});

for(const how of ['lease','release','fail'])test('start request without launch preserves attempt budget after '+how+' and a stop report',t=>{
  const f=fixture(t);inputs(f);
  const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest,1,30).attempt;f.requestStart(attempt);
  assert.equal(f.get(digest).attempts_started,0,'a request is not a launch');
  if(how==='lease')f.advance(30);else f.end(how,attempt);
  assert.equal(f.get(digest).state,'claimed','launch fence');reportStopped(f,attempt);
  assert.equal(f.get(digest).state,'queued');
  assert.equal(f.get(digest).attempts_started,0);
  assert.ok(f.claim(digest).attempt,'another attempt can be claimed');
});

test('revoking the holder after a start request holds the job without spending an attempt',t=>{
  const f=fixture(t);inputs(f);const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  assert.equal(f.get(digest).state,'claimed','a revoked holder cannot prove its run stopped');assert.equal(f.get(digest).attempts_started,0);
});

test('a declined start request requeues after its stop report without charging and excludes its lender',t=>{
  const f=fixture(t);inputs(f);const job=f.job({max_attempts:1}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);
  f.end('release',attempt,1,JSON.stringify({code:'approval_denied'}));
  assert.equal(f.get(digest).state,'claimed');reportStopped(f,attempt);
  assert.equal(f.get(digest).state,'queued');assert.equal(f.get(digest).attempts_started,0);
  code(()=>f.claim(digest),'forbidden');
});

test('a launch observation counts once even if delivered after release and restart',t=>{
  const f=fixture(t);inputs(f);const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);f.end('release',attempt);
  const body={generation:attempt.generation},route='/attempts/'+attempt.attempt_id+'/observed-start';
  const observe=()=>f.store.observeExecutionStart(fp[1],attempt.attempt_id,attempt.generation,f.ctx(1,'POST',route,body));
  observe();observe();assert.equal(f.get(digest).attempts_started,1);f.reopen();
  observe();assert.equal(f.get(digest).attempts_started,1);assert.equal(f.get(digest).state,'failed','an observed run is never requeued (T21)');
});

test('upgrade recalculates old start-request accounting',t=>{
  const f=fixture(t);inputs(f);const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);
  const db=new DatabaseSync(f.options.path),row=JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
  row.attempts_started=1;db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row),digest);
  db.prepare("DELETE FROM circle WHERE id='observed_attempt_accounting_v1'").run();db.close();f.reopen();
  assert.equal(f.get(digest).attempts_started,0);
});

test('legacy attempts keep their counted start when their observation is reported',t=>{
  const f=fixture(t);inputs(f);const job=f.job({max_attempts:2}),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);
  const db=new DatabaseSync(f.options.path),a=JSON.parse(db.prepare('SELECT data FROM attempts WHERE id=?').get(attempt.attempt_id).data);
  const row=JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
  delete a.execution_observed_at;row.attempts_started=1;
  db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(a),attempt.attempt_id);
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row),digest);
  db.prepare("DELETE FROM circle WHERE id='observed_attempt_accounting_v1'").run();db.close();f.reopen();
  const body={generation:attempt.generation},route='/attempts/'+attempt.attempt_id+'/observed-start';
  f.store.observeExecutionStart(fp[1],attempt.attempt_id,attempt.generation,f.ctx(1,'POST',route,body));
  assert.equal(f.get(digest).attempts_started,1);
});

test('v1 lease expiry before the agent started reclaims the job, increments generation and permanently fences old completion', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const old = f.claim(digest, 1, 30).attempt;
  f.advance(30);
  const current = f.claim(digest).attempt;
  assert.equal(current.generation, old.generation + 1); assert.notEqual(current.attempt_id, old.attempt_id);
  assert.equal(f.attempt(old.attempt_id).state, 'expired');
  code(() => f.complete(f.result(job, old)), 'stale_attempt');
  code(() => f.complete(f.result(job, current, { generation: old.generation })), 'stale_attempt');
  code(() => f.start(old), 'stale_attempt');
  code(() => f.start({ ...current, generation: old.generation }), 'stale_attempt');
  assert.equal(f.get(digest).attempts_started, 0, 'a stale start must not consume the current execution budget');
  f.start(current);
  assert.equal(f.get(digest).attempts_started, 1);
  assert.equal(f.complete(f.result(job, current)).status, 'result-accepted');
});

test('v1 lease expiry fences another execution but accepts delivery from the original attempt', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job({ max_attempts: 3 }), digest = p.digest(job.payload); f.publish(job);
  const old = f.claim(digest, 1, 30).attempt;
  f.start(old);
  f.advance(30);
  assert.equal(f.get(digest).state, 'failed', 'attempts were left, but a started attempt may have run in part');
  assert.equal(f.get(digest).attempts_started, 1);
  assert.equal(f.attempt(old.attempt_id).state, 'expired');
  assert.equal(f.attempt(old.attempt_id).reason, 'lease_expired');
  code(() => f.claim(digest), 'retry_exhausted');
  assert.equal(f.complete(f.result(job, old)).status,'result-accepted');
});

for (const [name, finish] of [
  ['cancelled', (f, job) => f.cancel(job)],
  ['released', (f, job, attempt) => f.end('release', attempt)],
  ['expired lease', f => f.advance(121)],
  ['completed', (f, job, attempt) => f.complete(f.result(job, attempt))],
]) test('late launch observation preserves terminal authority: ' + name, t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const attempt = f.claim(digest).attempt; f.requestStart(attempt);
  finish(f, job, attempt);
  const before = f.get(digest), body = {generation: attempt.generation};
  const observe = () => f.store.observeExecutionStart(fp[1], attempt.attempt_id, attempt.generation,
    f.ctx(1, 'POST', '/attempts/' + attempt.attempt_id + '/observed-start', body));
  const observed = observe();
  assert.ok(observed.execution_observed_at);
  assert.equal(observe().execution_observed_at, observed.execution_observed_at);
  // A fenced launch (released, or its lease lost) that reports it ran ends as failed (T21).
  assert.equal(f.get(digest).state, before.state === 'claimed' ? 'failed' : before.state);
  f.reopen();
  assert.equal(f.attempt(attempt.attempt_id).execution_observed_at, observed.execution_observed_at);
  assert.throws(() => f.start(attempt), 'observation must not restore execution authority');
});

test('late launch observation retains the original time and authenticates the attempt holder', t => {
  const f=fixture(t);inputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest).attempt;f.requestStart(attempt);
  const observedAt=iso(f.now);f.advance(10);f.cancel(job);
  const body={generation:attempt.generation,observed_at:observedAt};
  const route='/attempts/'+attempt.attempt_id+'/observed-start';
  code(()=>f.store.observeExecutionStart(fp[0],attempt.attempt_id,attempt.generation,f.ctx(0,'POST',route,body),observedAt),'forbidden');
  const observed=f.store.observeExecutionStart(fp[1],attempt.attempt_id,attempt.generation,f.ctx(1,'POST',route,body),observedAt);
  assert.equal(observed.execution_observed_at,observedAt);
  f.reopen();assert.equal(f.attempt(attempt.attempt_id).execution_observed_at,observedAt);
});

test('historical observation cannot change a superseding attempt', t => {
  const f=fixture(t);inputs(f);
  const job=f.job({max_attempts:3}),digest=p.digest(job.payload);f.publish(job);
  const old=f.claim(digest,1,30).attempt;f.advance(30);const current=f.claim(digest).attempt;
  // A historical row can predate the current replay fence; exercise its identity independently.
  const db=new DatabaseSync(f.options.path);
  const row=JSON.parse(db.prepare('SELECT data FROM attempts WHERE id=?').get(old.attempt_id).data);
  row.execution_started_at=old.claimed_at;
  db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(row),old.attempt_id);db.close();
  const body={generation:old.generation},route='/attempts/'+old.attempt_id+'/observed-start';
  const observed=f.store.observeExecutionStart(fp[1],old.attempt_id,old.generation,f.ctx(1,'POST',route,body));
  assert.ok(observed.execution_observed_at);
  assert.equal(f.get(digest).current_attempt.attempt_id,current.attempt_id);
  assert.equal(f.get(digest).current_attempt.execution_observed_at,null);
  code(()=>f.start(old),'stale_attempt');
});

test('v1 cancellation fences completion immediately; cessation is a separate monotonic report', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const a = f.claim(digest).attempt;
  f.start(a);
  const ack = f.cancel(job);
  assert.equal(ack.authority_revoked, true); assert.equal(ack.compute_stopped, false);
  assert.equal(f.get(digest).state, 'cancelled');
  code(() => f.complete(f.result(job, a)), 'job_terminal');
  const stopped_at = iso(f.now), body = { generation: a.generation, stopped_at };
  const stopped = f.store.stopped(fp[1], a.attempt_id, a.generation, stopped_at,
    f.ctx(1, 'POST', '/attempts/' + a.attempt_id + '/stopped', body));
  assert.equal(stopped.compute_stopped, true);
  assert.deepEqual(f.cancel(job), ack, 'cancellation replay keeps original cessation observation');
  code(() => f.cancel(job, { reason: 'different reason' }), 'conflict');
});

test('late completion never restores execution permission', t => {
  const f=fixture(t);inputs(f);outputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const attempt=f.claim(digest,1,30).attempt;f.start(attempt);f.advance(31);
  code(()=>f.start(attempt),'job_terminal');
  assert.equal(f.complete(f.result(job,attempt)).status,'result-accepted');
  code(()=>f.start(attempt),'job_terminal');
  assert.equal(f.get(digest).attempts_started,1);
});

test('late completion remains fenced by cancellation and removed executor authority', t => {
  const f=fixture(t);inputs(f);outputs(f);
  const cancelled=f.job();f.publish(cancelled);
  const first=f.claim(p.digest(cancelled.payload),1,30).attempt;f.start(first);f.cancel(cancelled);f.advance(31);
  code(()=>f.complete(f.result(cancelled,first)),'job_terminal');
  const job=f.job();f.publish(job);
  const attempt=f.claim(p.digest(job.payload),1,30).attempt;f.start(attempt);f.advance(31);
  assert.equal(f.get(p.digest(job.payload)).state,'failed');
  const result=f.result(job,attempt);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  code(()=>f.complete(result),'forbidden');
});

test('late completion remains fenced when the author is removed after expiry', t => {
  const f=fixture(t);inputs(f);outputs(f);
  f.upload(vectors.job.payload.prompt,1);f.upload(vectors.job.payload.source.artifact,1);
  const job=f.job({},1),digest=p.digest(job.payload);f.publish(job,1);
  const attempt=f.claim(digest,0,30).attempt;f.start(attempt,0);f.advance(31);
  assert.equal(f.get(digest).state,'failed');
  const result=f.result(job,attempt,{},0);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  code(()=>f.complete(result,0),'job_terminal');
});

test('v1 completion wins before a subsequent cancel', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(); f.publish(job);
  const a = f.claim(p.digest(job.payload)).attempt;
  f.start(a);
  f.complete(f.result(job, a));
  code(() => f.cancel(job), 'job_terminal');
});

test('v1 only an attempt that never started goes back to the queue, and it does not use the budget (T21)', t => {
  const f = fixture(t); inputs(f);
  const job = f.job({ max_attempts: 3 }), digest = p.digest(job.payload);
  f.publish(job);
  // Releases and lost leases before the agent started requeue, however many times, without counting.
  for (let n = 0; n < 4; n++) {
    assert.equal(f.end('release', f.claim(digest).attempt).state, 'released');
    assert.equal(f.get(digest).state, 'queued');
  }
  f.claim(digest, 1, 30); f.advance(30);
  assert.equal(f.get(digest).state, 'queued');
  assert.equal(f.get(digest).attempts_started, 0);
  // Once the agent started, release and fail both end the job.
  assert.equal(f.end('release', f.start(f.claim(digest).attempt)).state, 'released');
  assert.equal(f.get(digest).state, 'failed'); assert.equal(f.get(digest).attempts_started, 1);
  code(() => f.claim(digest), 'retry_exhausted');
  const second = f.job({ max_attempts: 3 }), other = p.digest(second.payload); f.publish(second);
  assert.equal(f.end('fail', f.start(f.claim(other).attempt)).state, 'failed');
  assert.equal(f.get(other).state, 'failed'); assert.equal(f.get(other).attempts_started, 1);
  code(() => f.claim(other), 'retry_exhausted');
});

test('v1 hard job deadline and minimum lease block claims without consuming budget', t => {
  const f = fixture(t); inputs(f);
  const job = f.job({ expires_at: iso(f.now + 31) }), digest = p.digest(job.payload); f.publish(job);
  f.advance(2); code(() => f.claim(digest), 'job_expired');
  assert.equal(f.get(digest).attempts_started, 0);
  f.advance(29); assert.equal(f.get(digest).state, 'expired');
});

test('v1 roster replacement fences removed holder and cancels removed author atomically', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const kept = f.job(), removed = f.job({}, 1);
  f.publish(kept); f.publish(removed, 1);
  const a = f.claim(p.digest(kept.payload)).attempt;
  f.install(f.roster([vectors.roster.payload.members[0]]));
  assert.equal(f.get(p.digest(kept.payload)).state, 'queued');
  assert.equal(f.attempt(a.attempt_id).state, 'cancelled');
  assert.equal(f.get(p.digest(removed.payload)).state, 'cancelled');
  code(() => f.complete(f.result(kept, a)), 'forbidden');
  code(() => f.get(p.digest(kept.payload), 1), 'forbidden');
});

test('v1 revoked device cannot replay its previously accepted result', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(); f.publish(job); const a = f.claim(p.digest(job.payload)).attempt;
  f.start(a);
  const result = f.result(job, a); f.complete(result);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  code(() => f.complete(result), 'forbidden');
});

test('v1 roster pin, rollback, same-epoch identity and expiry fail closed', t => {
  const f = fixture(t); inputs(f);
  assert.deepEqual(f.install(vectors.roster), f.install(vectors.roster));
  code(() => f.install(f.roster([vectors.roster.payload.members[0]], 6)), 'roster_stale');
  code(() => f.install(f.roster(undefined, 7, { valid_until: iso(start + 86400) })), 'roster_stale');
  const wrongRoot = p.signEnvelope('roster', { ...vectors.roster.payload, root_public_key: pub[3], epoch: 8 }, keys[3]);
  code(() => f.install(wrongRoot), 'invalid_request');
  const job = f.job(); f.publish(job);
  f.advance(Date.parse(vectors.roster.payload.valid_until) / 1000 - f.now);
  code(() => f.claim(p.digest(job.payload)), 'roster_expired');
  code(() => f.publish(f.job()), 'roster_expired');
});

test('v1 idempotency replays original outcome, rejects different body/endpoint, and authenticates nonce first', t => {
  const f = fixture(t); inputs(f);
  const job = f.job(), key = 'same-intent', digest = p.digest(job.payload);
  const proof = f.ctx(0, 'POST', '/jobs', job, { idempotency_key: key });
  const first = f.store.publishJob(job, proof);
  code(() => f.store.publishJob(job, proof), 'replay');
  assert.deepEqual(f.publish(job, 0, { idempotency_key: key }), first);
  code(() => f.publish(f.job(), 0, { idempotency_key: key }), 'idempotency_conflict');
  code(() => f.claim(digest, 0, 120, { idempotency_key: key }), 'idempotency_conflict');
  const claim = f.claim(digest, 1, 30, { idempotency_key: key });
  f.advance(30);
  assert.deepEqual(f.claim(digest, 1, 30, { idempotency_key: key }), claim);
  assert.equal(f.get(digest).attempts_started, 0);
  assert.equal(f.attempt(claim.attempt.attempt_id).state, 'expired');
});

test('v1 absent artifacts roll back failed publication and failed completion, permitting exact retries', t => {
  const f = fixture(t);
  const job = f.job(), key = 'retry-missing-input', digest = p.digest(job.payload);
  code(() => f.publish(job, 0, { idempotency_key: key }), 'artifact_missing');
  code(() => f.get(digest), 'not_found');
  inputs(f); f.publish(job, 0, { idempotency_key: key });
  const a = f.claim(digest).attempt, result = f.result(job, a);
  f.start(a);
  code(() => f.complete(result, 1, { idempotency_key: 'retry-missing-output' }), 'artifact_missing');
  assert.equal(f.get(digest).state, 'claimed');
  outputs(f);
  assert.equal(f.complete(result, 1, { idempotency_key: 'retry-missing-output' }).status, 'result-accepted');
});

test('v1 capabilities, signer/author and holder bindings prevent unauthorized transitions', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const wrong = p.signEnvelope('job', { ...f.job().payload, author: fp[1] }, keys[0]);
  code(() => f.publish(wrong), 'forbidden');
  const job = f.job(); f.publish(job); const digest = p.digest(job.payload);
  code(() => f.claim(digest, 1, 120, {}, { ...advertisement, models: [], accounts:[] }), 'requirements_unsupported');
  assert.equal(f.get(digest).attempts_started, 0);
  const a = f.claim(digest).attempt;
  code(() => f.complete(f.result(job, a, {}, 0), 0), 'forbidden');
  assert.equal(f.get(digest).state, 'claimed');
});

test('v1 invitation is consumed once, bound to a key, pending until roster approval', t => {
  const f = fixture(t);
  const invite = p.createInvite({ circle, coordinator: origin, invite_id: randomUUID(),
    invite_public_key: pub[3], created_at: iso(f.now), expires_at: iso(f.now + 3600) }, keys[2]);
  f.store.registerInvite(invite, f.ctx(0, 'POST', '/invites', invite));
  const body = device => ({ invite, device_public_key: pub[device],
    enrollment_proof: p.createEnrollmentProof({ circle, invite_id: invite.payload.invite_id,
      device_public_key: pub[device] }, keys[3]) });
  const enroll = device => f.store.createEnrollment(body(device),
    f.ctx(device, 'POST', '/enrollments', body(device), { roster_epoch: 0 }));
  const first = enroll(4);
  assert.equal(first.state, 'pending');
  assert.deepEqual(enroll(4), first);
  code(() => enroll(5), 'enrollment_conflict');
  code(() => f.publish(f.job({}, 4), 4), 'forbidden');
  f.install(f.roster([...vectors.roster.payload.members, { key_id: fp[4], public_key: pub[4], joined_epoch: 8 }]));
  const enrollment = f.store.getEnrollment(fp[4], first.enrollment_id,
    f.ctx(4, 'GET', '/enrollments/' + first.enrollment_id));
  assert.equal(enrollment.state, 'approved');
});

test('v1 artifact quota reserves before commit; failed verification and duplicate finalize cannot double-charge', t => {
  const f = fixture(t, { quotas: { deviceBytes: 100, circleBytes: 150, maxArtifactBytes: 100, concurrentUploads: 1 } });
  const ref = { digest: 'sha256:' + '9'.repeat(64), bytes: 80, media_type: 'text/plain' };
  const reservation = f.reserve(ref);
  assert.equal(f.quotas().device.reserved_bytes, 80); assert.equal(f.quotas().device.uploads, 1);
  code(() => f.reserve({ ...ref, digest: 'sha256:' + '8'.repeat(64) }), 'quota_exceeded');
  code(() => f.commit(reservation.reservation_id, { ...ref, bytes: 81 }), 'size_mismatch');
  assert.equal(f.quotas().device.reserved_bytes, 0, 'failed verification releases reservation');
  const retry = f.reserve(ref);
  f.commit(retry.reservation_id, ref, 0, { idempotency_key: 'finalize-once' });
  assert.deepEqual(f.commit(retry.reservation_id, ref, 0, { idempotency_key: 'finalize-once' }), ref);
  assert.equal(f.quotas().device.retained_bytes, 80); assert.equal(f.quotas().device.reserved_bytes, 0);
  code(() => f.reserve({ ...ref, digest: 'sha256:' + '7'.repeat(64), bytes: 21 }), 'quota_exceeded');
  code(() => f.reserve({ ...ref, digest: 'sha256:' + '6'.repeat(64), bytes: 71 }, 1), 'quota_exceeded');
});

test('v1 bounded authenticated pagination is stable across same-second insertions', t => {
  const f = fixture(t); inputs(f);
  const digests = Array.from({ length: 5 }, () => f.publish().job_digest).sort();
  const first = f.list();
  assert.equal(first.items.length, 2); assert.ok(first.next_cursor);
  const inserted = f.publish().job_digest;
  const found = first.items.map(j => j.job_digest);
  let cursor = first.next_cursor;
  while (cursor) { const page = f.list(2, cursor); assert.ok(page.items.length <= 2);
    found.push(...page.items.map(j => j.job_digest)); cursor = page.next_cursor; }
  assert.deepEqual(found, digests); assert.equal(found.includes(inserted), false);
  code(() => f.list(3, first.next_cursor), 'cursor_invalid');
  code(() => f.list(2, first.next_cursor, 1), 'cursor_invalid');
  code(() => f.list(2, first.next_cursor.slice(0, -1) + '!'), 'cursor_invalid');
  f.advance(901); code(() => f.list(2, first.next_cursor), 'cursor_invalid');
});

test('v1 close/reopen durability retains committed state and acknowledgements (not crash injection)', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), published = f.publish(job), a = f.claim(published.job_digest).attempt;
  f.reopen();
  assert.equal(f.get(published.job_digest).current_attempt.attempt_id, a.attempt_id);
  assert.equal(f.get(published.job_digest).attempts_started, 0);
  assert.equal(f.attempt(a.attempt_id).execution_started_at, null);
  const started = f.start(a);
  f.reopen();
  assert.deepEqual(f.attempt(a.attempt_id), started);
  assert.deepEqual(f.start(a), started);
  assert.equal(f.get(published.job_digest).attempts_started, 1);
  const result = f.result(job, a), ack = f.complete(result);
  f.reopen();
  assert.deepEqual(f.complete(result), ack);
  assert.deepEqual(f.publish(job), published);
  assert.equal(f.get(published.job_digest).state, 'result-accepted');
});

test('v1 stop request is durable, holder-authenticated, attempt-bound, and separate from cessation', t => {
  const f = fixture(t); inputs(f);
  const job = f.job(), digest = f.publish(job).job_digest;
  const attempt = f.start(f.claim(digest).attempt);
  const route = '/attempts/' + attempt.attempt_id + '/stop-request';
  const body = {generation: attempt.generation};
  const holderContext = f.ctx(1, 'POST', route, body, {idempotency_key:'stop-request-once'});
  const request = f.store.requestStop(fp[1], attempt.attempt_id, attempt.generation, holderContext);

  assert.deepEqual(request, {attempt_id:attempt.attempt_id,job_digest:digest,generation:attempt.generation,
    requested_at:iso(f.now)});
  assert.equal(f.attempt(attempt.attempt_id).compute_stopped, false);
  code(() => f.store.requestStop(fp[0], attempt.attempt_id, attempt.generation,
    f.ctx(0, 'POST', route, body, {idempotency_key:'spoofed-stop-request'})), 'forbidden');

  f.reopen();
  assert.deepEqual(f.store.getStopRequest(fp[0], attempt.attempt_id,
    f.ctx(0, 'GET', route)), request, 'the requester reads the durable fact through the coordinator');
  assert.deepEqual(f.store.requestStop(fp[1], attempt.attempt_id, attempt.generation,
    f.ctx(1, 'POST', route, body, {idempotency_key:'stop-request-once'})), request,
    'retry with the same idempotency key replays the acknowledgement');

  f.end('release', attempt);
  assert.equal(f.attempt(attempt.attempt_id).compute_stopped, false,
    'terminal state still does not assert that the process stopped');
  assert.deepEqual(f.store.getStopRequest(fp[0], attempt.attempt_id,
    f.ctx(0, 'GET', route)), request, 'the intent remains readable after a late terminal transition');
  code(() => f.store.requestStop(fp[1], attempt.attempt_id, attempt.generation,
    f.ctx(1, 'POST', route, body, {idempotency_key:'late-new-stop-request'})), 'job_terminal');
});

/** Eight worker_threads execute only local hermetic test code, never task/model workers. */
async function raceClaims(t, f, digest, sameKey = false, terminal = null) {
  const barrier = new SharedArrayBuffer(4);
  const workers = [], outcomes = [], ready = [];
  const script = `
    const { parentPort, workerData: d } = require('node:worker_threads');
    (async () => {
      const p = await import(d.protocolURL);
      const { openV1Store } = await import(d.storeURL);
      const { randomBytes } = require('node:crypto');
      const key = p.privateKeyFromSeed(Buffer.from(d.seed, 'hex'));
      const store = openV1Store({path:d.path,circle:d.circle,origin:d.origin,
        rootFingerprint:d.rootFingerprint,clock:()=>d.now});
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(d.barrier),0,0);
      try {
        const body=d.terminal?.body??{advertisement:d.advertisement,lease_seconds:120};
        const route=d.terminal?.route??('/jobs/'+d.digest.slice(7)+'/claim');
        const proof=p.buildRequestProof({circle:d.circle,roster_epoch:7,method:'POST',
          target:d.origin+'/v1/circles/'+d.circle+route,
          body:Buffer.from(p.canonicalize(body)),content_type:'application/json',
          artifact_media_type:'',idempotency_key:d.key,created:d.now,
          nonce:randomBytes(16).toString('base64url')},key);
        const result=d.terminal?store[d.terminal.kind](body,{proof}):
          store.claimJob(d.device,d.digest,d.advertisement,{proof},120);
        parentPort.postMessage({ok:true,result});
      } catch(e) { parentPort.postMessage({ok:false,code:e.code,message:e.message}); }
      finally { store.close(); }
    })().catch(e=>{parentPort.postMessage({fatal:e.stack});process.exitCode=1;});
  `;
  f.advertise(1);
  const count = terminal ? 2 : 8;
  for (let i = 0; i < count; i++) {
    const worker = new Worker(script, { eval: true, workerData: {
      protocolURL: new URL('../lib/protocol/index.mjs', import.meta.url).href,
      storeURL: new URL('../lib/v1/store.mjs', import.meta.url).href,
      path: f.options.path, circle, origin, rootFingerprint: fp[2], now: f.now,
      seed: golden.keys[terminal && i === 1 ? 0 : 1].seed_hex,
      device: fp[terminal && i === 1 ? 0 : 1], digest, advertisement, barrier,
      terminal: terminal ? terminal[i] : null,
      key: sameKey ? 'simultaneous-same-intent' : 'simultaneous-' + i,
    } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => { if (message.ready) resolve();
        if (message.fatal) reject(new Error(message.fatal)); });
      worker.on('exit', code => { if (code) reject(new Error('worker exit ' + code)); });
    }));
    outcomes.push(new Promise((resolve, reject) => {
      let result;
      worker.on('error', reject);
      worker.on('message', message => { if (message.fatal) reject(new Error(message.fatal));
        if (typeof message.ok === 'boolean') result = message; });
      worker.on('exit', code => code || !result ? reject(new Error('worker failed: ' + code)) : resolve(result));
    }));
  }
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  // Release only after every distinct SQLite connection is open.
  await Promise.all(ready);
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, count);
  return Promise.all(outcomes);
}

test('v1 eight simultaneous separate SQLite connections yield exactly one claimed attempt',
  { timeout: 10000 }, async t => {
    const f = fixture(t); inputs(f);
    const digest = f.publish().job_digest;
    const results = await raceClaims(t, f, digest);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.deepEqual(results.filter(r => !r.ok).map(r => r.code), Array(7).fill('conflict'));
    const job = f.get(digest);
    assert.equal(job.attempts_started, 0); assert.equal(job.current_attempt.generation, 1);
    assert.equal(job.current_attempt.attempt_id, results.find(r => r.ok).result.attempt.attempt_id);
    assert.equal(job.current_attempt.execution_started_at, null);
    f.start(job.current_attempt);
    assert.equal(f.get(digest).attempts_started, 1);
  });

test('v1 eight simultaneous identical idempotency keys join the same committed claim',
  { timeout: 10000 }, async t => {
    const f = fixture(t); inputs(f);
    const digest = f.publish().job_digest;
    const results = await raceClaims(t, f, digest, true);
    for (const result of results) { assert.equal(result.ok, true, result.message);
      assert.deepEqual(result.result, results[0].result); }
    assert.equal(f.get(digest).attempts_started, 0);
    assert.equal(f.get(digest).current_attempt.generation, 1);
    const started = f.start(results[0].result.attempt);
    for (const result of results) assert.deepEqual(f.start(result.result.attempt), started);
    assert.equal(f.get(digest).attempts_started, 1);
  });

test('v1 claim-next retains no-work and selects oldest eligible immutable job', t => {
  const f = fixture(t); inputs(f);
  const body = { advertisement, lease_seconds: 120 };
  const next = key => f.claimNext(fp[1], advertisement,
    f.ctx(1, 'POST', '/jobs/claim-next', body, { idempotency_key: key }), 120);
  assert.equal(next('empty-poll'), null);
  const first = f.publish(), second = f.publish();
  assert.equal(next('empty-poll'), null, 'new work does not change a retained no-work response');
  const claim = next('new-poll');
  assert.equal(claim.job.job_digest, [first.job_digest, second.job_digest].sort()[0]);
});

test('v1 lease bounds and strict expiry prevent renewal from reviving authority', t => {
  const f = fixture(t); inputs(f);
  const digest = f.publish().job_digest;
  for (const duration of [0, 29, 301]) code(() => f.claim(digest, 1, duration), 'invalid_request');
  assert.equal(f.get(digest).attempts_started, 0);
  const a = f.claim(digest, 1, 30).attempt;
  f.advance(30);
  const body = { generation: a.generation, lease_seconds: 120 };
  code(() => f.store.renew(fp[1], a.attempt_id, a.generation,
    f.ctx(1, 'POST', '/attempts/' + a.attempt_id + '/renew', body), 120), 'lease_expired');
  assert.equal(f.get(digest).state, 'queued');
});

test('v1 expired invitation cannot create an enrollment', t => {
  const f = fixture(t);
  const invite = p.createInvite({ circle, coordinator: origin, invite_id: randomUUID(),
    invite_public_key: pub[3], created_at: iso(f.now), expires_at: iso(f.now + 30) }, keys[2]);
  f.store.registerInvite(invite, f.ctx(0, 'POST', '/invites', invite));
  const body = { invite, device_public_key: pub[4], enrollment_proof: p.createEnrollmentProof({
    circle, invite_id: invite.payload.invite_id, device_public_key: pub[4] }, keys[3]) };
  f.advance(30);
  code(() => f.store.createEnrollment(body, f.ctx(4, 'POST', '/enrollments', body,
    { roster_epoch: 0 })), 'enrollment_expired');
});

test('v1 duplicate artifact uploads charge retained storage only to the first uploader', t => {
  const f = fixture(t);
  const ref = vectors.job.payload.prompt;
  f.upload(ref, 0); f.upload(ref, 1);
  assert.equal(f.quotas(0).device.retained_bytes, ref.bytes);
  assert.equal(f.quotas(1).device.retained_bytes, 0);
  assert.equal(f.quotas().circle.retained_bytes, ref.bytes);
  code(() => f.reserve({ ...ref, media_type: 'text/x-diff' }, 1), 'conflict');
  assert.equal(f.quotas(1).device.reserved_bytes, 0);
});

test('v1 proposed unexpired root-signed roster recovers an expired installed roster', t => {
  const f = fixture(t);
  f.advance(Date.parse(vectors.roster.payload.valid_until) / 1000 - f.now);
  f.install(f.roster(undefined, 8, { issued_at: iso(f.now), valid_until: iso(f.now + 86400) }));
  inputs(f);
  assert.equal(f.publish().state, 'queued');
});

test('v1 simultaneous complete/cancel connections serialize to one terminal outcome',
  { timeout: 10000 }, async t => {
    const f = fixture(t); inputs(f); outputs(f);
    const job = f.job(), digest = p.digest(job.payload); f.publish(job);
    const attempt = f.claim(digest).attempt;
    f.start(attempt);
    const result = f.result(job, attempt);
    const cancel = p.signEnvelope('cancellation', { schema: 'faravan.cancellation.v1',
      circle, job_digest: digest, author: fp[0], roster_epoch: 7,
      created_at: iso(f.now), reason: 'test-only competing cancellation' }, keys[0]);
    const outcomes = await raceClaims(t, f, digest, false, [
      { kind: 'complete', route: '/attempts/' + attempt.attempt_id + '/complete', body: result },
      { kind: 'cancel', route: '/jobs/' + segment(digest) + '/cancel', body: cancel },
    ]);
    assert.equal(outcomes.filter(r => r.ok).length, 1);
    assert.equal(outcomes.find(r => !r.ok).code, 'job_terminal');
    assert.equal(f.get(digest).state, outcomes[0].ok ? 'result-accepted' : 'cancelled');
    assert.equal(f.attempt(attempt.attempt_id).state, outcomes[0].ok ? 'completed' : 'cancelled');
  });

test('v1 close/reopen preserves pending reservations until explicit owner-scoped recovery', t => {
  const f = fixture(t);
  const ref = vectors.job.payload.prompt, first = f.reserve(ref), other = f.reserve(ref, 1);
  f.reopen();
  const reservations = f.store.listArtifactReservations(fp[0],
    f.ctx(0, 'GET', '/artifact-reservations'));
  assert.equal(reservations.length, 1); assert.equal(reservations[0].reservation_id, first.reservation_id);
  assert.equal(f.quotas().device.reserved_bytes, ref.bytes);
  const recover = ids => f.store.recoverArtifactReservations(fp[0], ids,
    f.ctx(0, 'POST', '/artifact-reservations/recover', { reservation_ids: ids }));
  code(() => recover([first.reservation_id, other.reservation_id]), 'forbidden');
  assert.equal(f.quotas().device.reserved_bytes, ref.bytes, 'mixed-owner recovery rolls back as a unit');
  assert.deepEqual(recover([first.reservation_id]), { released: 1 });
  assert.equal(f.quotas().device.reserved_bytes, 0); assert.equal(f.quotas().device.uploads, 0);
  assert.equal(f.quotas(1).device.reserved_bytes, ref.bytes);
});

test('v1 receipt output and duration inconsistencies roll back completion', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const a = f.claim(digest).attempt;
  f.start(a);
  const receipt = structuredClone(vectors.result.payload.receipt);
  const undersized = { ...receipt, limits_applied: { ...receipt.limits_applied, output_bytes: 619 } };
  code(() => f.complete(f.result(job, a, { receipt: undersized })), 'requirements_unsupported');
  assert.equal(f.get(digest).state, 'claimed');
  const tooLong = { ...receipt, duration_ms: receipt.limits_applied.wall_seconds * 1000 + 1 };
  code(() => f.complete(f.result(job, a, { receipt: tooLong })), 'requirements_unsupported');
  assert.equal(f.get(digest).state, 'claimed');
  assert.equal(f.complete(f.result(job, a)).status, 'result-accepted');
});

test('v1 competing artifact metadata reservations release quota after conflicting finalize', t => {
  const f = fixture(t);
  const plain = vectors.job.payload.prompt, diff = { ...plain, media_type: 'text/x-diff' };
  const first = f.reserve(plain), second = f.reserve(diff);
  assert.equal(f.quotas().device.uploads, 2);
  assert.equal(f.quotas().device.reserved_bytes, plain.bytes * 2);
  f.commit(first.reservation_id, plain);
  code(() => f.commit(second.reservation_id, diff), 'conflict');
  const quota = f.quotas();
  assert.equal(quota.device.reserved_bytes, 0); assert.equal(quota.device.uploads, 0);
  assert.equal(quota.circle.reserved_bytes, 0); assert.equal(quota.circle.uploads, 0);
  assert.equal(quota.device.retained_bytes, plain.bytes); assert.equal(quota.circle.retained_bytes, plain.bytes);
  assert.deepEqual(f.store.listArtifactReservations(fp[0], f.ctx(0, 'GET', '/artifact-reservations')), []);
});

test('v1 roster revocation releases removed-uploader reservations without losing retained metadata', t => {
  const f = fixture(t);
  f.upload(vectors.job.payload.prompt, 1);
  const ref = vectors.result.payload.candidate;
  f.reserve(ref, 1);
  const retained = f.reserve(ref, 0);
  assert.equal(f.quotas().circle.reserved_bytes, ref.bytes * 2);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  const quota = f.quotas();
  assert.equal(quota.circle.reserved_bytes, ref.bytes);
  assert.equal(quota.circle.uploads, 1);
  assert.equal(quota.circle.retained_bytes, vectors.job.payload.prompt.bytes);
  assert.equal(quota.device.reserved_bytes, ref.bytes);
  assert.equal(quota.device.uploads, 1);
  code(() => f.quotas(1), 'forbidden');
  f.commit(retained.reservation_id, ref);
  assert.equal(f.quotas().circle.reserved_bytes, 0);
  assert.equal(f.quotas().circle.uploads, 0);
});

test('v1 historical roster fetch uses current membership and permits stale proof epochs', t => {
  const f=fixture(t);
  const old=vectors.roster, current=f.roster();f.install(current);
  const read=(device,epoch,proofEpoch=f.epoch)=>f.store.getHistoricalRoster(fp[device],epoch,
    f.ctx(device,'GET','/rosters/'+epoch,null,{roster_epoch:proofEpoch}));
  assert.deepEqual(read(1,7,7),old);
  assert.deepEqual(read(1,8),current);
  code(()=>read(1,9),'not_found');
  f.install(f.roster(current.payload.members.filter(m=>m.key_id!==fp[1])));
  code(()=>read(1,7,7),'forbidden');
});

test('v1 nonces expire only after inclusive proof window, stay bounded, and purge transactionally', t => {
  const f=fixture(t,{quotas:{noncesPerDevice:3}});
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  const ctx=f.ctx(0,'GET','/roster',null,{created:f.now+60});
  f.store.getRoster(fp[0],ctx);
  assert.equal(db.prepare('SELECT expires FROM nonces').get().expires,f.now+361);
  f.advance(360);
  code(()=>f.store.getRoster(fp[0],ctx),'replay');
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,1);
  f.advance(1);f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,1);
  for(let i=0;i<2;i++)f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  code(()=>f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')),'rate_limited');
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,3);
  f.advance(301);f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,1);
});

test('v1 global nonce row cap applies across devices and expired rows release capacity', t => {
  const f=fixture(t,{quotas:{nonceRows:2,noncesPerDevice:10}});
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  f.store.getRoster(fp[1],f.ctx(1,'GET','/roster'));
  code(()=>f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')),'rate_limited');
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,2);
  f.advance(301);
  f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,1);
});

test('v1 unknown bootstrap invites create no durable nonce or rate rows', t => {
  const f=fixture(t),db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  const body={invite:vectors.invite,device_public_key:pub[3],enrollment_proof:{}};
  for(let i=0;i<12;i++)code(()=>f.store.createEnrollment(body,
    f.ctx(3,'POST','/enrollments',body,{roster_epoch:0})),'not_found');
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM bootstrap_rates').get().n,0);
});

test('v1 invalid enrollment proofs never spend the valid invite budget', t => {
  const f=fixture(t,{quotas:{nonceRows:4}}),db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  const invite=p.createInvite({circle,coordinator:origin,invite_id:randomUUID(),invite_public_key:pub[3],created_at:iso(f.now),expires_at:iso(f.now+3600)},keys[2]);
  f.store.registerInvite(invite,f.ctx(0,'POST','/invites',invite));
  const body={invite,device_public_key:pub[3],enrollment_proof:{}};
  for(let i=0;i<35;i++)assert.throws(()=>f.store.createEnrollment(body,f.ctx(3,'POST','/enrollments',body,{roster_epoch:0})));
  assert.equal(db.prepare('SELECT count(*) n FROM bootstrap_rates').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,1,'only the member publication may consume a nonce');
  body.enrollment_proof=p.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:pub[3]},keys[3]);
  assert.equal(f.store.createEnrollment(body,f.ctx(3,'POST','/enrollments',body,{roster_epoch:0})).state,'pending');
  assert.equal(db.prepare('SELECT count FROM bootstrap_rates').get().count,1);
});

test('v1 indexed claim queue skips terminal and incompatible jobs and tracks renewed leases', t => {
  const f=fixture(t);inputs(f);
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  for(let i=0;i<8;i++)f.publish(f.job({runRequest:{...vectors.job.payload.runRequest,models:[{providerId:'codex',modelId:'unavailable-model'}]}}));
  const terminal=f.job();f.publish(terminal);f.cancel(terminal);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const body={advertisement,lease_seconds:30};
  const claim=f.claimNext(fp[1],advertisement,f.ctx(1,'POST','/jobs/claim-next',body),30);
  assert.equal(claim.job.job_digest,digest);
  assert.equal(db.prepare('SELECT count(*) n FROM job_queue').get().n,9);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM job_queue WHERE egress=? AND ready<=? AND expiry>=?').all('provider-only',f.now,f.now+30);
  assert.ok(plan.some(row=>/SEARCH .*job_queue.*job_queue_eligible/.test(row.detail)));
  const source=readFileSync(new URL('../lib/v1/store.mjs',import.meta.url),'utf8');
  const sql=source.match(/return db\.prepare\(\x60(SELECT q\.id[\s\S]*?)\x60\)\.all/)[1];
  const actualPlan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(JSON.stringify(advertisement.egress),f.now,f.now+30,JSON.stringify(advertisement.harnesses),JSON.stringify(advertisement.models),JSON.stringify(advertisement.capabilities),JSON.stringify(advertisement.enforced_limits),JSON.stringify(advertisement.max_limits));
  assert.ok(actualPlan.some(row=>/SEARCH q USING INDEX job_queue_eligible/.test(row.detail)),JSON.stringify(actualPlan));
  assert.ok(actualPlan.every(row=>!/^SCAN q(?:$| )/.test(row.detail)),JSON.stringify(actualPlan));
  f.advance(20);
  const a=claim.attempt,renew={generation:a.generation,lease_seconds:120};
  f.store.renew(fp[1],a.attempt_id,a.generation,f.ctx(1,'POST','/attempts/'+a.attempt_id+'/renew',renew),120);
  f.advance(11);
  db.exec('CREATE TABLE observed_job_writes (id TEXT); CREATE TRIGGER observe_job_writes AFTER UPDATE ON jobs BEGIN INSERT INTO observed_job_writes VALUES (NEW.id); END');
  assert.equal(f.claimNext(fp[1],advertisement,f.ctx(1,'POST','/jobs/claim-next',body),30),null);
  assert.equal(db.prepare('SELECT count(*) n FROM observed_job_writes').get().n,0,'empty poll must not rewrite unchanged or terminal jobs');
  f.advance(110);
  assert.equal(f.claimNext(fp[1],advertisement,f.ctx(1,'POST','/jobs/claim-next',body),30).job.job_digest,digest);
});

test('v1 circle job quota and terminal retention keep durable replay tombstones', t => {
  const f=fixture(t,{quotas:{circleJobs:1,terminalRetentionSeconds:30*86400}});inputs(f);
  const job=f.job(),ack=f.publish(job);f.cancel(job);
  code(()=>f.publish(f.job()),'quota_exceeded');
  assert.deepEqual(f.publish(job),ack);
  f.advance(29*86400);
  f.install(f.roster(undefined,undefined,{issued_at:iso(f.now),valid_until:iso(f.now+86400)}));
  code(()=>f.publish(f.job()),'quota_exceeded'); // day 29: the job and its files are still kept
  f.advance(86400+1);
  f.install(f.roster(undefined,undefined,{issued_at:iso(f.now),valid_until:iso(f.now+86400)}));
  // The cancelled job's files went with it (P17a), so a new job must upload its inputs again.
  const next=f.job();code(()=>f.publish(next),'artifact_missing');
  inputs(f);assert.equal(f.publish(next).state,'queued');
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM job_tombstones').get().n,1);
  assert.deepEqual(f.publish(job),ack);
  f.reopen();assert.deepEqual(f.publish(job),ack);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1);
});

test('v1 retained job allocation leaves room for another author after cancellation and removal', t => {
  const f=fixture(t,{quotas:{circleJobs:3,deviceJobs:1}});inputs(f);
  f.upload(vectors.job.payload.prompt,1);f.upload(vectors.job.payload.source.artifact,1);
  const offender=f.job({},1),ack=f.publish(offender,1);
  code(()=>f.publish(f.job({},1),1),'quota_exceeded');
  f.cancel(offender,{},1);
  code(()=>f.publish(f.job({},1),1),'quota_exceeded');
  assert.deepEqual(f.publish(offender,1),ack,'retry does not consume another slot');
  f.install(f.roster([vectors.roster.payload.members[0]]));
  assert.equal(f.publish(f.job()).state,'queued');
  f.reopen();code(()=>f.publish(f.job()),'quota_exceeded');
});

test('v1 full retained allocation reclaims a removed author job when another member submits', t => {
  const f=fixture(t,{quotas:{circleJobs:3,deviceJobs:2}});inputs(f);
  f.upload(vectors.job.payload.prompt,1);f.upload(vectors.job.payload.source.artifact,1);
  const removed=f.job({},1),other=f.job({},1),kept=f.job();
  f.publish(removed,1);f.publish(other,1);f.publish(kept);f.cancel(removed,{},1);
  f.install(f.roster([vectors.roster.payload.members[0]]));
  assert.equal(f.publish(f.job()).state,'queued');
  assert.equal(f.get(p.digest(kept.payload)).state,'queued');
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,3);
  assert.equal(db.prepare('SELECT count(*) n FROM job_tombstones').get().n,1);
});

test('v1 publication bounds the signed job lifetime', t => {
  const f=fixture(t,{quotas:{maxJobLifetimeSeconds:3600}});inputs(f);
  code(()=>f.publish(f.job({expires_at:iso(f.now+3601)})),'invalid_request');
  code(()=>f.publish(f.job({created_at:iso(f.now+60),expires_at:iso(f.now+3660)})),'invalid_request');
  assert.equal(f.publish(f.job()).state,'queued');
});

test('v1 capacity recovery preserves artifacts needed by the incoming job', t => {
  const f=fixture(t,{quotas:{circleJobs:2,deviceJobs:1}});inputs(f);
  const newcomer={key_id:fp[3],public_key:pub[3],joined_epoch:8};
  f.install(f.roster([...vectors.roster.payload.members,newcomer]));
  f.upload(vectors.job.payload.prompt,1);f.upload(vectors.job.payload.source.artifact,1);
  f.upload(vectors.job.payload.prompt,3);f.upload(vectors.job.payload.source.artifact,3);
  f.publish(f.job({},1),1);
  const prompt={digest:p.digestBytes(Buffer.from('other prompt')),bytes:12,media_type:'text/plain'};
  const source={digest:p.digestBytes(Buffer.from('other source')),bytes:12,media_type:'application/gzip'};
  f.upload(prompt);f.upload(source);f.publish(f.job({prompt,source:{kind:'archive',artifact:source}}));
  f.install(f.roster([vectors.roster.payload.members[0],newcomer]));
  assert.equal(f.publish(f.job({},3),3).state,'queued');
});

test('v1 completion accepts a historical signed result under a fresh current-member proof', t => {
  const f=fixture(t);inputs(f);outputs(f);
  const job=f.job();f.publish(job);const attempt=f.claim(p.digest(job.payload)).attempt;f.start(attempt);
  const result=f.result(job,attempt);
  f.install(f.roster());
  assert.equal(f.complete(result).status,'result-accepted');
});

test('v1 retained result and cancellation acknowledgements survive body collection and reopen', t => {
  const f=fixture(t,{quotas:{terminalRetentionSeconds:30*86400}});inputs(f);outputs(f);
  const completed=f.job();const publishAck=f.publish(completed);
  const a=f.claim(p.digest(completed.payload)).attempt;f.start(a);
  const result=f.result(completed,a),resultAck=f.complete(result);
  const cancelled=f.job();f.publish(cancelled);
  const cancellation=p.signEnvelope('cancellation',{schema:'faravan.cancellation.v1',circle,
    job_digest:p.digest(cancelled.payload),author:fp[0],roster_epoch:f.epoch,created_at:iso(f.now),reason:'retention test'},keys[0]);
  const cancel=()=>f.store.cancel(cancellation,f.ctx(0,'POST','/jobs/'+segment(cancellation.payload.job_digest)+'/cancel',cancellation));
  const cancellationAck=cancel();f.advance(30*86400+1);
  f.install(f.roster(undefined,undefined,{issued_at:iso(f.now),valid_until:iso(f.now+86400)}));
  f.store.getRoster(fp[0],f.ctx(0,'GET','/roster'));
  f.reopen();
  assert.deepEqual(f.publish(completed),publishAck);
  assert.deepEqual(f.complete(result),resultAck);
  assert.deepEqual(cancel(),cancellationAck);
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM results').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM attempts').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM cancellations').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM job_tombstones').get().n,2);
});

test('v1 job pages stop at the UTF-8 byte cap and preserve snapshot traversal', t => {
  const f = fixture(t); inputs(f);
  const requirements = { ...vectors.job.payload.requirements,
    harness: Array.from({ length: 36 }, (_, i) => i + 'é'.repeat(2040)) };
  const digests = Array.from({ length: 3 }, () => f.publish(f.job({ requirements })).job_digest).sort();
  const found = []; let cursor = null, pages = 0;
  do {
    const page = f.list(100, cursor);
    assert.ok(Buffer.byteLength(p.canonicalize(page)) <= 262144);
    assert.equal(page.items.length, 1);
    found.push(...page.items.map(j => j.job_digest)); cursor = page.next_cursor;
    if (++pages === 1) f.publish(f.job({ requirements }));
    assert.ok(pages <= 3, 'byte pagination must advance');
  } while (cursor);
  assert.deepEqual(found, digests);
});

test('v1 oversized JobView publication rolls back before committing the job', t => {
  const f = fixture(t); inputs(f);
  const requirements = { ...vectors.job.payload.requirements,
    harness: Array.from({ length: 64 }, (_, i) => i === 63 ? 'z' : String(i).padStart(3, '0') + 'x'.repeat(4093)) };
  let job = f.job({ requirements });
  const padding = 262144 - Buffer.byteLength(p.canonicalize(job));
  assert.ok(padding > 0 && padding < 4096);
  requirements.harness[63] += 'x'.repeat(padding);
  job = p.signEnvelope('job', { ...job.payload, requirements }, keys[0]);
  assert.equal(Buffer.byteLength(p.canonicalize(job)), 262144);
  code(() => f.publish(job), 'payload_too_large');
  code(() => f.get(p.digest(job.payload)), 'not_found');
  assert.deepEqual(f.list().items, []);
});

test('v1 artifact installation and COMMIT failures preserve unknown outcome classification', t => {
  const f = fixture(t), ref = { digest: 'sha256:' + 'd'.repeat(64), bytes: 1, media_type: 'text/plain' };
  let reservation = f.reserve(ref);
  code(() => f.store.finishArtifactUpload(fp[0], reservation.reservation_id, ref,
    () => { throw new Error('test-only installation failure'); }), 'internal_error');
  assert.equal(f.quotas().device.reserved_bytes, 1);
  const exec = DatabaseSync.prototype.exec;
  for (const committed of [false, true]) {
    const injected = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
      if (sql === 'COMMIT') {
        if (committed) exec.call(this, sql);
        throw new Error('test-only COMMIT failure');
      }
      return exec.call(this, sql);
    });
    try { code(() => f.store.finishArtifactUpload(fp[0], reservation.reservation_id, ref, () => {}), 'internal_error'); }
    finally { injected.mock.restore(); }
    assert.equal(f.quotas().device.retained_bytes, committed ? 1 : 0);
    assert.equal(f.quotas().device.reserved_bytes, committed ? 0 : 1);
  }
});

test('v1 claim poll rejects an explicit null lease without claiming a job', t => {
  const f = fixture(t); inputs(f); const published = f.publish();
  const body = { advertisement, lease_seconds: null };
  code(() => f.store.openClaimPoll(fp[1], body, f.ctx(1, 'POST', '/jobs/claim-next', body)), 'invalid_request');
  assert.equal(f.get(published.job_digest).current_attempt, null);
});

test('v1 quotas expose only documented limits and retain private configuration limits', t => {
  const f = fixture(t), configuration = f.store.configuration();
  const expected = Object.fromEntries(['deviceBytes', 'circleBytes', 'maxArtifactBytes', 'concurrentUploads']
    .map(key => [key, configuration.limits[key]]));
  assert.deepEqual(f.quotas().limits, expected);
  assert.equal(f.store.configuration().limits.circleJobs, 10000);
  assert.equal(f.store.configuration().limits.noncesPerDevice, 2048);
});

test('v1 early POST authentication remains bound to the original request identity', t => {
  const f = fixture(t); inputs(f); const job = f.job();
  const ctx = { ...f.ctx(0, 'POST', '/jobs', job), route: '/jobs' };
  assert.deepEqual(f.store.openPostRequest(fp[0], job, ctx), { replayed: false, result: null });
  code(() => f.store.publishJob(f.job(), ctx), 'invalid_signature');
  code(() => f.store.publishJob(job, ctx), 'replay');
  const accepted = { ...f.ctx(0, 'POST', '/jobs', job), route: '/jobs' };
  f.store.openPostRequest(fp[0], job, accepted);
  assert.equal(f.store.publishJob(job, accepted).job_digest, p.digest(job.payload));
  code(() => f.store.publishJob(job, accepted), 'replay');
  const replay = { ...f.ctx(0, 'POST', '/jobs', job), route: '/jobs' };
  f.store.openPostRequest(fp[0], job, replay);
  const roster = f.roster(vectors.roster.payload.members.filter(m => m.key_id !== fp[0]));
  f.store.installRoster(roster, f.ctx(1, 'PUT', '/roster', roster, { roster_epoch: roster.payload.epoch }));
  code(() => f.store.publishJob(job, replay), 'forbidden');
});

test('v1 transport upload commit is fenced by its persisted roster epoch', t => {
  for (const removed of [false, true]) {
    const f = fixture(t), ref = vectors.job.payload.prompt;
    const reservation = f.reserve(ref, 1, true);
    const members = removed ? [vectors.roster.payload.members[0]] : vectors.roster.payload.members;
    f.install(f.roster(members));
    f.reopen();
    let installed = 0;
    code(() => f.store.finishArtifactUpload(fp[1], reservation.reservation_id, ref, () => installed++, reservation.owner_token),
      removed ? 'forbidden' : 'roster_stale');
    assert.equal(installed, 0, 'stale uploads never install bytes');
    assert.equal(f.quotas().circle.retained_bytes, 0);
    assert.equal(f.quotas().circle.reserved_bytes, ref.bytes, 'revocation cannot release a live upload');
    f.store.abortArtifactUpload(fp[1], reservation.reservation_id, undefined, reservation.owner_token);
    assert.equal(f.quotas().circle.reserved_bytes, 0);
    assert.equal(f.quotas().circle.uploads, 0);
    const fresh = f.reserve(ref, 0, true);
    assert.deepEqual(f.store.finishArtifactUpload(fp[0], fresh.reservation_id, ref, () => installed++, fresh.owner_token), ref);
    assert.equal(installed, 1, 'same-epoch uploads still commit');
    assert.equal(f.quotas().circle.retained_bytes, ref.bytes);
  }
});

test('v1 claim entry points reject malformed advertisement lists', t => {
  const f = fixture(t); inputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  for (const change of [
    { harnesses: [] }, { models: ['example-model', 'example-model'] },
    { capabilities: ['patch-output', ''] }, { egress: ['provider-only', 'unknown'] },
    { enforced_limits: [...advertisement.enforced_limits, 'unknown'] },
  ]) {
    const ad = { ...advertisement, ...change }, body = { advertisement: ad, lease_seconds: 120 };
    code(() => f.claim(digest, 1, 120, {}, ad), 'requirements_unsupported');
    code(() => f.claimNext(fp[1], ad, f.ctx(1, 'POST', '/jobs/claim-next', body), 120), 'requirements_unsupported');
    code(() => f.store.openClaimPoll(fp[1], body, f.ctx(1, 'POST', '/jobs/claim-next', body)), 'requirements_unsupported');
    assert.equal(f.get(digest).state, 'queued');
  }
  assert.equal(f.claim(digest).attempt.state, 'active');
});

test('v1 end-attempt reasons count Unicode code points at the 4096 boundary', t => {
  for (const kind of ['release', 'fail']) {
    const f = fixture(t); inputs(f);
    const job = f.job(), digest = p.digest(job.payload); f.publish(job);
    const attempt = f.claim(digest).attempt;
    code(() => f.end(kind, attempt, 1, '😀'.repeat(4097)), 'invalid_request');
    assert.equal(f.attempt(attempt.attempt_id).state, 'active');
    const ended = f.end(kind, attempt, 1, '😀'.repeat(4096));
    assert.equal(ended.reason, '😀'.repeat(4096));
  }
});

test('v1 stopped_at rejects extended years and noncanonical wire timestamps', t => {
  const f = fixture(t); inputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const attempt = f.claim(digest).attempt; f.end('release', attempt);
  const stop = stopped_at => f.store.stopped(fp[1], attempt.attempt_id, attempt.generation, stopped_at,
    f.ctx(1, 'POST', '/attempts/' + attempt.attempt_id + '/stopped', { generation: attempt.generation, stopped_at }));
  for (const value of ['-000001-01-01T00:00:00Z', '+001999-01-01T00:00:00Z',
    '2026-02-30T00:00:00Z', iso(f.now).replace('Z', '.000Z'), iso(f.now).replace('Z', '+00:00'), iso(f.now + 61)]) {
    code(() => stop(value), 'invalid_request');
    assert.equal(f.attempt(attempt.attempt_id).compute_stopped, false);
  }
  assert.equal(stop(iso(f.now)).stopped_at, iso(f.now));
});

test('v1 expired invite retries preserve exact durable publication identity', t => {
  const f = fixture(t);
  const make = () => p.createInvite({ circle, coordinator: origin, invite_id: randomUUID(),
    invite_public_key: pub[3], created_at: iso(f.now), expires_at: iso(f.now + 30) }, keys[2]);
  const bare = make(), signed = make(), unpublished = make();
  const publication = { code: 'abcdefghij', envelope: signed, invite_binding: p.createInviteBinding(signed, keys[3]) };
  const register = body => f.store.registerInvite(body, f.ctx(0, 'POST', '/invites', body));
  const bareAck = register(bare), publishedAck = register(publication);
  f.advance(30); f.reopen();
  assert.deepEqual(register(bare), bareAck, 'fresh idempotency key returns retained bare invite');
  assert.deepEqual(register(publication), publishedAck, 'fresh idempotency key returns retained publication');
  code(() => f.store.resolveInvite(publication.code), 'enrollment_expired');
  code(() => register(unpublished), 'enrollment_expired');
  code(() => register({ ...publication, code: 'abcdefghik' }), 'enrollment_conflict');
  code(() => register({ ...publication, invite_binding: { ...publication.invite_binding, value: 'A'.repeat(86) } }), 'enrollment_conflict');
  const changed = p.signEnvelope('invite', { ...signed.payload, owner_name: 'Changed owner' }, keys[2]);
  code(() => register({ ...publication, envelope: changed, invite_binding: p.createInviteBinding(changed, keys[3]) }), 'enrollment_conflict');
  code(() => register({ code: 'abcdefghil', envelope: bare, invite_binding: p.createInviteBinding(bare, keys[3]) }), 'enrollment_expired');
  const enrollment = { invite: signed, device_public_key: pub[4], enrollment_proof: p.createEnrollmentProof({
    circle, invite_id: signed.payload.invite_id, device_public_key: pub[4] }, keys[3]) };
  code(() => f.store.createEnrollment(enrollment, f.ctx(4, 'POST', '/enrollments', enrollment, { roster_epoch: 0 })), 'enrollment_expired');
});

test('v1 uncertain installed artifact reservations remain charged until verified cleanup', t => {
  const f = fixture(t), artifact = vectors.job.payload.prompt;
  const reservation = f.reserve(artifact, 1, true);
  code(() => f.store.finishArtifactUpload(fp[1], reservation.reservation_id, artifact,
    () => { throw new Error('test-only failure after installation'); }, reservation.owner_token), 'internal_error');
  f.store.abortArtifactUpload(fp[1], reservation.reservation_id, undefined, reservation.owner_token);
  assert.equal(f.quotas(1).device.reserved_bytes, artifact.bytes);
  assert.equal(f.quotas(1).device.uploads, 1);
  f.reopen(); f.store.recoverTransportUploads();
  assert.equal(f.quotas(1).device.reserved_bytes, artifact.bytes, 'restart must retain uncertain accounting');
  f.install(f.roster(vectors.roster.payload.members.filter(m => m.key_id !== fp[1])));
  assert.equal(f.quotas().circle.reserved_bytes, artifact.bytes, 'revocation cannot uncharge retained bytes');
  code(() => f.store.abortArtifactUpload(fp[1], reservation.reservation_id,
    () => { throw new Error('test-only cleanup failure'); }, reservation.owner_token), 'invalid_request');
  assert.equal(f.quotas().circle.reserved_bytes, artifact.bytes);
  let cleaned = 0;
  f.store.abortArtifactUpload(fp[1], reservation.reservation_id, actual => {
    assert.deepEqual(actual, artifact); cleaned++; return true;
  }, reservation.owner_token);
  assert.equal(cleaned, 1);
  assert.equal(f.quotas().circle.reserved_bytes, 0);
  assert.equal(f.quotas().circle.uploads, 0);
});

test('v1 completion reconciles required and preferred enforcement evidence', async t => {
  const limitNames = { cpu: 'cpu', memory_bytes: 'memory', wall_seconds: 'wall',
    output_bytes: 'output', disk_bytes: 'storage' };
  const names = Object.values(limitNames);
  const cases = [
    { name: 'implicit required rejects unenforced', unenforced: true, reject: true },
    { name: 'explicit required rejects unenforced', mode: 'required', unenforced: true, reject: true },
    { name: 'implicit required rejects explicit lack', enforced: 'missing', reject: true },
    { name: 'explicit required rejects explicit lack', mode: 'required', enforced: 'missing', reject: true },
    { name: 'required rejects contradiction', mode: 'required', enforced: 'all', unenforced: true, reject: true },
    { name: 'preferred rejects contradiction', mode: 'preferred', enforced: 'all', unenforced: true, reject: true },
    { name: 'preferred requires unenforced evidence', mode: 'preferred', enforced: 'missing', reject: true },
    { name: 'preferred accepts unenforced', mode: 'preferred', enforced: 'missing', unenforced: true },
    { name: 'preferred accepts enforced', mode: 'preferred', enforced: 'all' },
    { name: 'implicit required accepts omissions' },
    { name: 'explicit required accepts omissions', mode: 'required' },
    { name: 'preferred accepts omissions', mode: 'preferred' },
  ];
  for (const [key, name] of Object.entries(limitNames)) for (const scenario of cases) {
    await t.test(key + ': ' + scenario.name, t => {
      const f = fixture(t); inputs(f); outputs(f);
      const requirements = structuredClone(vectors.job.payload.requirements);
      delete requirements.limit_modes;
      if (scenario.mode) requirements.limit_modes = { [key]: scenario.mode };
      const job = f.job({ requirements }), digest = p.digest(job.payload);
      f.publish(job); const attempt = f.claim(digest).attempt; f.start(attempt);
      const receipt = structuredClone(vectors.result.payload.receipt);
      delete receipt.enforced_limits; delete receipt.unenforced;
      if (scenario.enforced) receipt.enforced_limits = scenario.enforced === 'all'
        ? [...names] : names.filter(value => value !== name);
      if (scenario.unenforced) receipt.unenforced = [name];
      const result = f.result(job, attempt, { receipt });
      if (scenario.reject) {
        code(() => f.complete(result), 'requirements_unsupported');
        const view = f.get(digest);
        assert.equal(view.state, 'claimed'); assert.equal(view.result_digest, null);
        assert.equal(view.current_attempt.state, 'active');
        code(() => f.store.getResult(fp[0], digest,
          f.ctx(0, 'GET', '/jobs/' + segment(digest) + '/result')), 'conflict');
        assert.equal(f.complete(f.result(job, attempt, { receipt: {
          ...receipt, enforced_limits: [...names], unenforced: [],
        } })).status, 'result-accepted');
      } else {
        const ack = f.complete(result);
        assert.equal(ack.status, 'result-accepted');
        assert.equal(ack.result_digest, p.digest(result.payload));
        assert.equal(f.attempt(attempt.attempt_id).state, 'completed');
      }
    });
  }
});

test('v1 publication reserves future readback beyond its immediate acknowledgement', t => {
  const f = fixture(t); inputs(f);
  const baseline = f.publish(), job = f.job(), digest = p.digest(job.payload);
  const cap = Buffer.byteLength(p.canonicalize(baseline));
  assert.ok(Buffer.byteLength(p.canonicalize(job)) < cap);
  code(() => f.store.publishJob(job, { ...f.ctx(0, 'POST', '/jobs', job), maxResponseBytes: cap }),
    'payload_too_large');
  code(() => f.get(digest), 'not_found');
  assert.equal(f.publish(job).job_digest, digest, 'rejection does not commit publication identity');
});

test('v1 legacy claim entry points preserve readable JobView and page atomically', t => {
  const f = fixture(t); inputs(f);
  const first = f.publish(), sample = f.claim(first.job_digest);
  const cap = Buffer.byteLength(p.canonicalize({ job_digest: first.job_digest, job: first.job, attempt: sample.attempt }));
  const next = f.publish(), digest = next.job_digest;
  const body = { advertisement, lease_seconds: 120 };
  const ctx = route => ({ ...f.ctx(1, 'POST', route, body), maxResponseBytes: cap });
  for (const invoke of [
    () => f.store.claimJob(fp[1], digest, advertisement, ctx('/jobs/' + segment(digest) + '/claim'), 120),
    () => f.claimNext(fp[1], advertisement, ctx('/jobs/claim-next'), 120),
    () => f.store.openClaimPoll(fp[1], body, ctx('/jobs/claim-next')),
  ]) {
    code(invoke, 'payload_too_large');
    assert.equal(f.get(digest).state, 'queued');
    assert.equal(f.get(digest).current_attempt, null);
  }
});

test('v1 result admission caps its later readback rather than only the acknowledgement', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const attempt = f.claim(digest).attempt; f.start(attempt);
  const result = f.result(job, attempt), cap = Buffer.byteLength(p.canonicalize(result)) - 1;
  code(() => f.store.complete(result, { ...f.ctx(1, 'POST',
    '/attempts/' + attempt.attempt_id + '/complete', result), maxResponseBytes: cap }), 'payload_too_large');
  assert.equal(f.get(digest).state, 'claimed');
  assert.equal(f.get(digest).result_digest, null);
  assert.equal(f.complete(result).status, 'result-accepted');
});

test('v1 hard response cap reserves escaped terminal reason growth at admission', t => {
  const f = fixture(t); inputs(f);
  const requirements = { ...vectors.job.payload.requirements,
    harness: Array.from({ length: 60 }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(4093)) };
  const job = f.job({ requirements }), digest = p.digest(job.payload);
  const immediate = { job_digest: digest, job, state: 'queued', attempts_started: 0, current_attempt: null, result_digest: null };
  assert.ok(Buffer.byteLength(p.canonicalize(immediate)) < 262144);
  code(() => f.publish(job), 'payload_too_large');
  code(() => f.get(digest), 'not_found');
  assert.deepEqual(f.list().items, []);
});

test('v1 publication byte reservation survives maximum attempt growth and cursor pages', t => {
  const f = fixture(t); inputs(f);
  const bytes = value => Buffer.byteLength(p.canonicalize(value));
  const job = f.job(), digest = p.digest(job.payload), uuid = '00000000-0000-0000-0000-000000000000';
  const date = '9999-12-31T23:59:59Z', hash = 'sha256:' + '0'.repeat(64), reason = '\u0000'.repeat(4096);
  const future = { job_digest: digest, job, state: 'result-accepted', attempts_started: job.payload.max_attempts ?? 3,
    current_attempt: { attempt_id: uuid, job_digest: digest, generation: Number.MAX_SAFE_INTEGER, holder: hash, state: 'cancelled',
      claimed_at: date, lease_expires_at: date, execution_started_at: date, selection:{providerId:'codex',accountId:'\u0000'.repeat(256),modelId:'example-model',effortId:'\u0000'.repeat(256)}, reason, compute_stopped: false, stopped_at: date }, result_digest: hash };
  const cap = bytes({ items: [future], next_cursor: uuid });
  assert.equal(bytes(reason), 24578);
  const ctx = (device, method, route, body) => ({ ...f.ctx(device, method, route, body), maxResponseBytes: cap });
  assert.equal(f.store.publishJob(job, ctx(0, 'POST', '/jobs', job)).job_digest, digest);
  const rejected = f.job();
  code(() => f.store.publishJob(rejected, { ...ctx(0, 'POST', '/jobs', rejected), maxResponseBytes: cap - 1 }), 'payload_too_large');
  code(() => f.get(p.digest(rejected.payload)), 'not_found');
  const other = f.job(); f.store.publishJob(other, ctx(0, 'POST', '/jobs', other));
  const db = new DatabaseSync(f.options.path);
  try {
    const row = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
    row.generation = Number.MAX_SAFE_INTEGER - 1;
    db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), digest);
  } finally { db.close(); }
  const claimBody = { advertisement, lease_seconds: 120 };
  f.advertise(1);
  const a = f.store.claimJob(fp[1], digest, advertisement, ctx(1, 'POST', '/jobs/' + segment(digest) + '/claim', claimBody), 120).attempt;
  assert.equal(a.generation, Number.MAX_SAFE_INTEGER);
  const attemptRoute = '/attempts/' + a.attempt_id;
  f.store.start(fp[1], a.attempt_id, a.generation, ctx(1, 'POST', attemptRoute + '/start', { generation: a.generation }));
  const cancellation = p.signEnvelope('cancellation', { schema: 'faravan.cancellation.v1', circle, job_digest: digest, author: fp[0],
    roster_epoch: f.epoch, created_at: iso(f.now), reason }, keys[0]);
  f.store.cancel(cancellation, ctx(0, 'POST', '/jobs/' + segment(digest) + '/cancel', cancellation));
  const stopped_at = iso(f.now);
  f.store.stopped(fp[1], a.attempt_id, a.generation, stopped_at, ctx(1, 'POST', attemptRoute + '/stopped', { generation: a.generation, stopped_at }));
  const view = f.store.getJob(fp[0], digest, ctx(0, 'GET', '/jobs/' + segment(digest)));
  assert.equal(view.current_attempt.reason, reason); assert.equal(view.current_attempt.stopped_at, stopped_at); assert.ok(bytes(view) <= cap);
  let cursor = null, count = 0;
  do {
    const route = '/jobs?limit=1' + (cursor ? '&cursor=' + cursor : '');
    const page = f.store.listJobs(fp[0], { limit: 1, cursor, accepts:['run_request_v1'] }, ctx(0, 'GET', route));
    assert.ok(bytes(page) <= cap); assert.equal(page.items.length, 1);
    count += page.items.length; cursor = page.next_cursor;
    if (count === 1) assert.equal(cursor.length, 36);
  } while (cursor);
  assert.equal(count, 2);
});

test('v1 uncertain artifact retry reuses one charge and excludes concurrent reuse', t => {
  const artifact = vectors.job.payload.prompt;
  const f = fixture(t, { quotas: { deviceBytes: artifact.bytes, circleBytes: artifact.bytes, concurrentUploads: 1 } });
  const initial = f.reserve(artifact, 0, true);
  code(() => f.store.finishArtifactUpload(fp[0], initial.reservation_id, artifact, () => {
    const db = new DatabaseSync(f.options.path);
    try { assert.equal(JSON.parse(db.prepare('SELECT data FROM reservations WHERE id=?').get(initial.reservation_id).data).install_pending, true); }
    finally { db.close(); }
    throw new Error('test-only uncertain installation');
  }, initial.owner_token), 'internal_error');
  f.store.abortArtifactUpload(fp[0], initial.reservation_id, undefined, initial.owner_token);
  const retried = f.reserve(artifact, 0, true);
  assert.equal(retried.reservation_id, initial.reservation_id);
  assert.equal(retried.adopted_uncertain_retry, true,
    'the adopted signal is scoped to this device and exact reservation digest');
  code(() => f.reserve(artifact, 0, true), 'quota_exceeded');
  code(() => f.store.releaseArtifactReservation(fp[0], initial.reservation_id,
    f.ctx(0, 'POST', '/artifact-reservations/' + initial.reservation_id + '/release', {})), 'conflict');
  assert.equal(f.quotas().circle.reserved_bytes, artifact.bytes);
  f.store.abortArtifactUpload(fp[0], retried.reservation_id, () => false, retried.owner_token);
  const next = f.reserve(artifact, 0, true);
  assert.equal(next.reservation_id, initial.reservation_id);
  f.store.finishArtifactUpload(fp[0], next.reservation_id, artifact, () => {}, next.owner_token);
  assert.equal(f.quotas().circle.retained_bytes, artifact.bytes);
  assert.equal(f.quotas().circle.reserved_bytes, 0); assert.equal(f.quotas().circle.uploads, 0);
});

test('v1 frozen artifact proof and uncertain reservations stay bound to their devices', t => {
  const artifact = vectors.job.payload.prompt;
  const f = fixture(t, { quotas: { deviceBytes: 10_000_000, circleBytes: 10_000_000, concurrentUploads: 1 } });
  f.upload(artifact, 0);
  f.upload(vectors.job.payload.source.artifact, 0);
  f.publish(f.job({ audience: { device_keys: [fp[0]] } }));
  f.reserve(artifact, 1, true);
  assert.equal(f.store.requiresArtifactProof(fp[1], artifact.digest), true,
    'the other device still needs proof for an artifact outside its readable audience');

  // A separate, not-yet-retained artifact leaves a genuinely adoptable uncertain reservation.
  // Already-retained bytes would let reconciliation settle that reservation immediately.
  const retryStore = fixture(t, { quotas: { deviceBytes: 10_000_000, circleBytes: 10_000_000, concurrentUploads: 1 } });
  const pending = retryStore.reserve(artifact, 0, true);
  code(() => retryStore.store.finishArtifactUpload(fp[0], pending.reservation_id, artifact,
    () => { throw new Error('test-only uncertain install'); }, pending.owner_token, {verifiedInput:true}), 'internal_error');
  retryStore.store.abortArtifactUpload(fp[0], pending.reservation_id, undefined, pending.owner_token);
  const otherDevice = retryStore.reserve(artifact, 1, true);
  assert.notEqual(otherDevice.reservation_id, pending.reservation_id,
    'another device cannot adopt the existing uncertain reservation');
  assert.equal(Object.hasOwn(otherDevice, 'adopted_uncertain_retry'), false,
    'another device does not adopt the existing uncertain reservation');
  const ownerRetry = retryStore.reserve(artifact, 0, true);
  assert.equal(ownerRetry.reservation_id, pending.reservation_id);
  assert.equal(ownerRetry.adopted_uncertain_retry, true,
    'the same pending reservation is adoptable only by its owner');
});

test('v1 upload ownership fences unwinding requests and stale aborts', t => {
  const artifact = vectors.job.payload.prompt;
  const f = fixture(t, { quotas: { deviceBytes: artifact.bytes, circleBytes: artifact.bytes, concurrentUploads: 1 } });
  const initial = f.reserve(artifact, 0, true);
  code(() => f.store.finishArtifactUpload(fp[0], initial.reservation_id, artifact,
    () => { throw new Error('test-only rename failure'); }, initial.owner_token), 'internal_error');
  // The installation has thrown, but its request is still awaiting temporary cleanup.
  code(() => f.reserve(artifact, 0, true), 'quota_exceeded');
  f.store.abortArtifactUpload(fp[0], initial.reservation_id, undefined, initial.owner_token);
  const retry = f.reserve(artifact, 0, true);
  assert.equal(retry.reservation_id, initial.reservation_id);
  assert.equal(typeof retry.owner_token, 'string');
  assert.notEqual(retry.owner_token, initial.owner_token);
  let staleCleanup = 0, staleInstall = 0;
  f.store.abortArtifactUpload(fp[0], initial.reservation_id, () => { staleCleanup++; return true; }, initial.owner_token);
  assert.equal(staleCleanup, 0, 'stale request cannot delete the current owner files');
  code(() => f.store.finishArtifactUpload(fp[0], initial.reservation_id, artifact,
    () => staleInstall++, initial.owner_token), 'conflict');
  assert.equal(staleInstall, 0);
  code(() => f.reserve(artifact, 0, true), 'quota_exceeded');
  assert.equal(f.quotas().circle.reserved_bytes, artifact.bytes);
  f.store.finishArtifactUpload(fp[0], retry.reservation_id, artifact, () => {}, retry.owner_token);
  assert.equal(f.quotas().circle.retained_bytes, artifact.bytes);
  assert.equal(f.quotas().circle.reserved_bytes, 0);
  assert.equal(f.quotas().circle.uploads, 0);
});

test('v1 durable duplicate settles inactive pending charges but preserves live streams', async t => {
  for (const otherDevice of [0, 1]) await t.test('successful uploader ' + otherDevice, t => {
    const artifact = vectors.job.payload.prompt, bytes = artifact.bytes;
    const f = fixture(t, { quotas: { deviceBytes: 4 * bytes, circleBytes: 4 * bytes, concurrentUploads: 4 } });
    const ended = f.reserve(artifact, 0, true);
    const winner = f.reserve(artifact, otherDevice, true);
    const live = f.reserve(artifact, 0, true);
    code(() => f.store.finishArtifactUpload(fp[0], ended.reservation_id, artifact,
      () => { throw new Error('test-only failure after installation'); }, ended.owner_token), 'internal_error');
    f.store.abortArtifactUpload(fp[0], ended.reservation_id, undefined, ended.owner_token);
    assert.equal(f.quotas().circle.reserved_bytes, 3 * bytes);
    f.store.finishArtifactUpload(fp[otherDevice], winner.reservation_id, artifact, () => {}, winner.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: bytes, uploads: 1 });
    const remaining = f.store.listArtifactReservations(fp[0], f.ctx(0, 'GET', '/artifact-reservations'));
    assert.deepEqual(remaining.map(r => r.reservation_id), [live.reservation_id]);
    f.store.abortArtifactUpload(fp[0], live.reservation_id, undefined, live.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: 0, uploads: 0 });
    const other = { ...artifact, digest: 'sha256:' + 'f'.repeat(64) };
    const admitted = f.reserve(other, 0, true);
    f.store.abortArtifactUpload(fp[0], admitted.reservation_id, undefined, admitted.owner_token);
  });
});

test('v1 ended upload owners reconcile unknown reservation and failed abort transactions', async t => {
  const artifact = vectors.job.payload.prompt, bytes = artifact.bytes;
  for (const committed of [false, true]) await t.test('unknown reserve COMMIT, applied first=' + committed, t => {
    const f = fixture(t, { quotas: { deviceBytes: bytes, circleBytes: bytes, concurrentUploads: 1 } });
    const exec = DatabaseSync.prototype.exec; let injected = false;
    const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
      if (sql === 'COMMIT' && !injected) {
        injected = true;
        if (committed) exec.call(this, sql);
        throw new Error('test-only reserve COMMIT acknowledgement failure');
      }
      return exec.call(this, sql);
    });
    try { code(() => f.reserve(artifact, 0, true), 'internal_error'); }
    finally { fault.mock.restore(); }
    assert.deepEqual(f.quotas().circle, { retained_bytes: 0, reserved_bytes: 0, uploads: 0 });
    const retry = f.reserve(artifact, 0, true);
    f.store.abortArtifactUpload(fp[0], retry.reservation_id, undefined, retry.owner_token);
  });
  for (const sqlFailure of ['BEGIN IMMEDIATE', 'COMMIT']) for (const temporaryRemoved of [false, true])
    await t.test('abort ' + sqlFailure + ', temporary removed=' + temporaryRemoved, t => {
      const f = fixture(t, { quotas: { deviceBytes: bytes, circleBytes: bytes, concurrentUploads: 1 } });
      let cleanupSucceeded = false;
      f.store.recoverTransportUploads(undefined, () => cleanupSucceeded);
      const reservation = f.reserve(artifact, 0, true);
      f.store.trackArtifactUpload(fp[0], reservation.reservation_id, reservation.owner_token, '.upload-' + randomUUID());
      const exec = DatabaseSync.prototype.exec; let injected = false;
      const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
        if (sql === sqlFailure && !injected) {
          injected = true; throw new Error('test-only abort transaction failure');
        }
        return exec.call(this, sql);
      });
      try { code(() => f.store.abortArtifactUpload(fp[0], reservation.reservation_id, undefined,
        reservation.owner_token, temporaryRemoved), 'invalid_request'); }
      finally { fault.mock.restore(); }
      assert.deepEqual(f.quotas().circle, { retained_bytes: 0,
        reserved_bytes: temporaryRemoved ? 0 : bytes, uploads: temporaryRemoved ? 0 : 1 });
      cleanupSucceeded = true;
      assert.deepEqual(f.quotas().circle, { retained_bytes: 0, reserved_bytes: 0, uploads: 0 });
    });
});

test('v1 durable digest and size settle inactive media conflicts but preserve live conflicts', async t => {
  for (const otherDevice of [0, 1]) await t.test('successful uploader ' + otherDevice, t => {
    const plain = { ...vectors.job.payload.prompt, media_type: 'text/plain' }, bytes = plain.bytes;
    const diff = { ...plain, media_type: 'text/x-diff' };
    const f = fixture(t, { quotas: { deviceBytes: 4 * bytes, circleBytes: 4 * bytes, concurrentUploads: 4 } });
    const ended = f.reserve(plain, 0, true);
    const winner = f.reserve(diff, otherDevice, true);
    const live = f.reserve(plain, 0, true);
    for (const reservation of [ended, live]) code(() =>
      f.store.finishArtifactUpload(fp[0], reservation.reservation_id, plain,
        () => { throw new Error('test-only unknown installed outcome'); }, reservation.owner_token), 'internal_error');
    f.store.abortArtifactUpload(fp[0], ended.reservation_id, undefined, ended.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: 0, reserved_bytes: 3 * bytes, uploads: 3 });
    f.store.finishArtifactUpload(fp[otherDevice], winner.reservation_id, diff, () => {}, winner.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: bytes, uploads: 1 });
    assert.deepEqual(f.store.listArtifactReservations(fp[0], f.ctx(0, 'GET', '/artifact-reservations'))
      .map(r => r.reservation_id), [live.reservation_id]);
    let installs = 0;
    code(() => f.store.finishArtifactUpload(fp[0], live.reservation_id, plain,
      () => installs++, live.owner_token), 'conflict');
    assert.equal(installs, 0, 'a live request keeps strict media-type validation');
    code(() => f.reserve(plain, 0, true), 'conflict');
    f.store.abortArtifactUpload(fp[0], live.reservation_id, undefined, live.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: 0, uploads: 0 });
    f.reopen();
    f.store.recoverTransportUploads(() => false);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: 0, uploads: 0 });
    assert.deepEqual(f.store.getArtifact(fp[otherDevice], diff.digest, f.ctx(otherDevice, 'GET', '/artifacts/' + segment(diff.digest))), diff);
  });
});

test('v1 media-independent settlement still requires equal size and removed temporaries', async t => {
  for (const blocker of ['size', 'temporary']) await t.test(blocker, t => {
    const retained = { ...vectors.job.payload.prompt, media_type: 'text/x-diff' }, bytes = retained.bytes;
    const pending = { ...retained, media_type: 'text/plain', bytes: bytes + (blocker === 'size' ? 1 : 0) };
    const f = fixture(t, { quotas: { deviceBytes: 4 * bytes, circleBytes: 4 * bytes, concurrentUploads: 4 } });
    const ended = f.reserve(pending, 0, true), winner = f.reserve(retained, 1, true);
    if (blocker === 'temporary') f.store.trackArtifactUpload(fp[0], ended.reservation_id,
      ended.owner_token, '.upload-' + randomUUID());
    code(() => f.store.finishArtifactUpload(fp[0], ended.reservation_id, pending,
      () => { throw new Error('test-only unknown installed outcome'); }, ended.owner_token), 'internal_error');
    f.store.abortArtifactUpload(fp[0], ended.reservation_id, undefined, ended.owner_token);
    f.store.finishArtifactUpload(fp[1], winner.reservation_id, retained, () => {}, winner.owner_token);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: pending.bytes, uploads: 1 });
    f.reopen();
    f.store.recoverTransportUploads(() => false, () => false);
    assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: pending.bytes, uploads: 1 });
    if (blocker === 'temporary') {
      f.store.recoverTransportUploads(() => false, () => true);
      assert.deepEqual(f.quotas().circle, { retained_bytes: bytes, reserved_bytes: 0, uploads: 0 });
    }
  });
});


for(const quotas of [
  {idempotencyRowsPerDevice:4}, {idempotencyRows:4},
  {idempotencyBytesPerDevice:6000}, {idempotencyBytes:6000},
]) {
  test('idempotency cache bounds duplicate job responses '+JSON.stringify(quotas), t => {
    const f=fixture(t,{quotas});inputs(f);
    const job=f.job(),key=randomUUID(),ack=f.publish(job,0,{idempotency_key:key});
    const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
    const retained=db.prepare('SELECT data FROM quota_counters ORDER BY id').all();
    let capped=false;
    for(let n=0;n<20;n++) {
      try{assert.deepEqual(f.publish(job),ack);}
      catch(error){assert.equal(error.code,'quota_exceeded');capped=true;break;}
    }
    assert.ok(capped,'duplicate publications must reach metadata budget');
    assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1);
    assert.deepEqual(db.prepare('SELECT data FROM quota_counters ORDER BY id').all(),retained,'artifact accounting is unchanged');
    assert.deepEqual(f.publish(job,0,{idempotency_key:key}),ack,'admitted keys still replay at capacity');
    code(()=>f.publish(f.job()),'quota_exceeded');
    assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1,'rejected cache admission must roll back a new job');
    f.reopen();
    assert.deepEqual(f.publish(job,0,{idempotency_key:key}),ack,'replay survives restart');
    code(()=>f.publish(job),'quota_exceeded');
    f.advance(86401);
    assert.equal(f.publish(f.job()).state,'queued','expiry frees cache budget');
    const actual=db.prepare('SELECT count(*) rows,coalesce(sum(length(CAST(response AS BLOB))),0) bytes FROM idempotency').get();
    assert.deepEqual({...db.prepare("SELECT rows,bytes FROM idempotency_usage WHERE device='' ").get()},{...actual});
  });
}

test('cache accounting backfill scans once per version, not on every open', t => {
  const f=fixture(t,{quotas:{idempotencyRows:3}});inputs(f);
  f.publish(f.job(),0,{idempotency_key:randomUUID()});
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  assert.ok(db.prepare("SELECT 1 FROM circle WHERE id='idempotency_usage_v1'").get(),'first open records the marker');
  // Triggers keep the counters exact after the scan; a marked store must not rescan.
  db.prepare("UPDATE idempotency_usage SET rows=99 WHERE device=''").run();
  f.reopen();
  assert.equal(db.prepare("SELECT rows FROM idempotency_usage WHERE device=''").get().rows,99);
});

test('cache accounting backfills existing keys on upgrade and preserves their replay', t => {
  const f=fixture(t,{quotas:{idempotencyRows:3}});inputs(f);
  const job=f.job(),key=randomUUID(),ack=f.publish(job,0,{idempotency_key:key});
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  // Simulate a database written before cache accounting existed.
  db.exec('DROP TRIGGER idempotency_usage_insert; DROP TRIGGER idempotency_usage_delete; DROP TRIGGER idempotency_usage_update; DROP TABLE idempotency_usage;');
  db.prepare("DELETE FROM circle WHERE id='idempotency_usage_v1'").run();
  f.reopen();
  assert.equal(db.prepare("SELECT rows FROM idempotency_usage WHERE device='' ").get().rows,3);
  assert.deepEqual(f.publish(job,0,{idempotency_key:key}),ack);
  code(()=>f.publish(job),'quota_exceeded');
});

test('typed results: completion must answer the signed requested result kind', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const tree = { digest: 'sha256:' + '5'.repeat(64), bytes: 120, media_type: 'application/gzip' };
  f.upload(tree, 1);
  const ad = { ...advertisement, capabilities: [...advertisement.capabilities, 'results_v1'] };
  const typedReceipt = source => ({ ...vectors.result.payload.receipt, source, capabilities_applied: ['results_v1','run_request_v1'], candidate_format: 'tree' });
  const run = (jobOverrides, resultOverrides) => {
    const job = f.job(jobOverrides), digest = p.digest(job.payload); f.publish(job);
    const a = f.claim(digest, 1, 120, {}, ad).attempt; f.start(a);
    return { job, a, digest, result: overrides => f.result(job, a, { ...resultOverrides(job), ...overrides }) };
  };
  const message = { source: { kind: 'none' }, result: { kind: 'message' },
    requirements: { ...vectors.job.payload.requirements, capabilities: ['results_v1','run_request_v1'] } };
  const typed = job => ({ candidate: tree, receipt: typedReceipt(job.payload.source) });
  const wrong = run(message, typed);
  code(() => f.complete(wrong.result({ output: { kind: 'files' } })), 'requirements_unsupported');
  code(() => f.complete(wrong.result({})), 'requirements_unsupported');
  assert.equal(f.get(wrong.digest).state, 'claimed', 'a mismatched result never becomes the accepted result');
  assert.equal(f.complete(wrong.result({ output: { kind: 'message' } })).status, 'result-accepted');
  const legacy = run({}, job => ({ candidate: tree, receipt: { ...typedReceipt(job.payload.source), capabilities_applied: ['patch-output'] } }));
  code(() => f.complete(legacy.result({ output: { kind: 'message' } })), 'requirements_unsupported');
});

function controlHeartbeat(seq = 0) {
  return {...accountHeartbeat(advertisement),boot:'test-boot',seq};
}
function heartbeat(f, body = controlHeartbeat(), device = 1, overrides = {}) {
  return f.store.heartbeat(fp[device], body, f.ctx(device, 'POST', '/heartbeat', body, overrides));
}
function emptyPoll(f, key = randomUUID(), device = 1) {
  const body = {advertisement, lease_seconds:120};
  return f.store.claimNext(fp[device], advertisement,
    f.ctx(device, 'POST', '/jobs/claim-next', body, {idempotency_key:key}), 120);
}
test('claim-next polls report reachability without renewing readiness', t => {
  const f = fixture(t);
  const read = () => f.store.getPresence(fp[0], f.ctx(0, 'GET', '/presence'));
  const lender = presence => presence.devices.find(device => device.device === fp[1]);
  const explain = presence => jobStatusContract({state:'queued', presence}, {id:fp[0], now:f.now * 1000}).explanation;
  heartbeat(f, {...controlHeartbeat(), intent:{state:'blocked', reason:'cleanup_pending'}});
  const held = read();
  assert.equal(lender(held).source, 'heartbeat');
  assert.match(explain(held), /waiting for cleanup/);

  f.advance(90);
  assert.equal(emptyPoll(f), null);
  const polled = read();
  assert.equal(lender(polled).online, true);
  assert.equal(lender(polled).source, 'poll');
  assert.equal(lender(polled).last_heartbeat_at, lender(held).last_heartbeat_at);
  assert.equal(lender(polled).last_poll_at, iso(f.now));
  assert.match(explain(polled), /status is unconfirmed/);
  assert.doesNotMatch(explain(polled), /waiting for cleanup|is ready|isn't lending/);

  heartbeat(f, controlHeartbeat(1));
  const ready = read();
  assert.equal(lender(ready).source, 'heartbeat');
  assert.equal(lender(ready).last_heartbeat_at, iso(f.now));
  assert.match(explain(ready), /1 computer is ready/);

  f.advance(90);
  assert.equal(emptyPoll(f), null);
  const staleReady = explain(read());
  assert.doesNotMatch(staleReady, /is ready/);
  assert.match(staleReady, /lending status is unconfirmed/);
});

function cacheUsage(db, table, device = '') {
  const actual = device
    ? db.prepare('SELECT count(*) rows,coalesce(sum(length(CAST(response AS BLOB))),0) bytes FROM ' + table + ' WHERE device=?').get(device)
    : db.prepare('SELECT count(*) rows,coalesce(sum(length(CAST(response AS BLOB))),0) bytes FROM ' + table).get();
  const stored = db.prepare('SELECT rows,bytes FROM ' + table + '_usage WHERE device=?').get(device) ?? {rows:0,bytes:0};
  assert.deepEqual({...stored}, {...actual}, 'transactional accounting matches retained rows and UTF-8 bytes');
  return actual;
}

test('control-plane heartbeats and no-work polls stay bounded through a full lender day', t => {
  const f = fixture(t, {quotas:{idempotencyRowsPerDevice:4, idempotencyBytesPerDevice:128}});
  // A fake clock traverses a complete day. Tiny mutation limits expose accidental
  // shared charging immediately; no real server, lender, provider or timer runs.
  for (let tick = 0; tick <= 86400; tick += 600) {
    heartbeat(f, controlHeartbeat(tick));
    assert.equal(emptyPoll(f), null);
    f.advance(600);
  }
  const db = new DatabaseSync(f.options.path); t.after(() => db.close());
  assert.equal(cacheUsage(db, 'idempotency').rows, 0);
  assert.equal(cacheUsage(db, 'control_idempotency', fp[1]).rows, 288);
  assert.ok(cacheUsage(db, 'control_idempotency').bytes <= f.store.configuration().limits.controlIdempotencyBytes);
});

test('control-plane traffic leaves mutation quota and successful claim retention intact', t => {
  const f = fixture(t, {quotas:{idempotencyRows:4}}); inputs(f);
  const job = f.job(), digest = p.digest(job.payload); f.publish(job);
  const body = {advertisement, lease_seconds:120}, key = 'successful-claim';
  const claim = () => f.store.claimNext(fp[1], advertisement,
    f.ctx(1, 'POST', '/jobs/claim-next', body, {idempotency_key:key}), 120);
  f.advertise(1);
  const accepted = claim();
  assert.equal(accepted.job.job_digest, digest);
  heartbeat(f);
  assert.equal(emptyPoll(f), null);
  code(() => f.start(accepted.attempt), 'quota_exceeded');
  assert.equal(f.attempt(accepted.attempt.attempt_id).execution_started_at, null, 'rejected mutation rolls back');
  const db = new DatabaseSync(f.options.path); t.after(() => db.close());
  assert.equal(cacheUsage(db, 'idempotency').rows, 4);
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 3);
  f.advance(601);
  assert.deepEqual(claim(), accepted, 'successful claim is a daily mutation, not a short-lived empty poll');
  assert.equal(cacheUsage(db, 'idempotency').rows, 4);
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 3);
});

test('control-plane keys preserve nonce, payload and cross-endpoint replay fences across restart', t => {
  assert.equal(controlHeartbeat(7).seq,7,'the fixture preserves the requested heartbeat sequence');
  const f = fixture(t); inputs(f);
  f.upload(vectors.job.payload.prompt,1);f.upload(vectors.job.payload.source.artifact,1);
  const hb = controlHeartbeat(), key = 'control-key', ctx = f.ctx(1, 'POST', '/heartbeat', hb, {idempotency_key:key});
  const first = f.store.heartbeat(fp[1], hb, ctx);
  code(() => f.store.heartbeat(fp[1], hb, ctx), 'replay');
  code(() => heartbeat(f, controlHeartbeat(1), 1, {idempotency_key:key}), 'idempotency_conflict');
  code(() => emptyPoll(f, key), 'idempotency_conflict');
  const job = f.job({}, 1);
  code(() => f.publish(job, 1, {idempotency_key:key}), 'idempotency_conflict');
  const mutationKey = 'mutation-key', published = f.publish(job, 1, {idempotency_key:mutationKey});
  code(() => heartbeat(f, hb, 1, {idempotency_key:mutationKey}), 'idempotency_conflict');
  f.advance(5); f.reopen();
  assert.deepEqual(heartbeat(f, hb, 1, {idempotency_key:key}), first, 'returns original receipt after restart');
  assert.deepEqual(f.publish(job, 1, {idempotency_key:mutationKey}), published);
  const db = new DatabaseSync(f.options.path); t.after(() => db.close());
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 1);
  assert.equal(cacheUsage(db, 'control_idempotency', fp[1]).rows, 1);
});

for (const quotas of [
  {controlIdempotencyRowsPerDevice:2}, {controlIdempotencyRows:2},
  {controlIdempotencyBytesPerDevice:140}, {controlIdempotencyBytes:140},
]) {
  test('control-plane cache has finite abuse bounds ' + JSON.stringify(quotas), t => {
    const f = fixture(t, {quotas}), body = controlHeartbeat(), key = 'bounded-heartbeat';
    const ack = heartbeat(f, body, 1, {idempotency_key:key});
    let capped = false;
    for (let n = 1; n <= 10; n++) {
      try { heartbeat(f, controlHeartbeat(n)); }
      catch (error) { assert.equal(error.code, 'quota_exceeded'); capped = true; break; }
    }
    assert.ok(capped, 'new control keys must reach a finite row or byte limit');
    assert.deepEqual(heartbeat(f, body, 1, {idempotency_key:key}), ack, 'known keys replay at capacity');
    const db = new DatabaseSync(f.options.path); t.after(() => db.close());
    const retained = cacheUsage(db, 'control_idempotency');
    assert.equal(cacheUsage(db, 'idempotency').rows, 0);
    f.reopen();
    assert.deepEqual(cacheUsage(db, 'control_idempotency'), retained);
    assert.deepEqual(heartbeat(f, body, 1, {idempotency_key:key}), ack);
    f.advance(86399);
    assert.deepEqual(heartbeat(f, body, 1, {idempotency_key:key}), ack, 'retain until the boundary');
    f.advance(1);
    assert.notDeepEqual(heartbeat(f, body, 1, {idempotency_key:key}), ack, 'expiry releases capacity at 86400 seconds');
    assert.equal(cacheUsage(db, 'control_idempotency').rows, 1);
  });
}

test('control-plane global limits span devices without starving user mutations', t => {
  const f = fixture(t, {quotas:{controlIdempotencyRows:2, controlIdempotencyRowsPerDevice:2}});
  heartbeat(f, controlHeartbeat(), 0);
  heartbeat(f, controlHeartbeat(), 1);
  code(() => heartbeat(f, controlHeartbeat(1), 1), 'quota_exceeded');
  inputs(f);
  assert.equal(f.publish(f.job()).state, 'queued');
});

test('control-plane long-poll caches only final no-work and replays before newly queued work', t => {
  const f = fixture(t), body = {advertisement, lease_seconds:120}, key = 'no-work';
  const ctx = {...f.ctx(1, 'POST', '/jobs/claim-next', body, {idempotency_key:key}), route:'/jobs/claim-next'};
  assert.equal(f.store.openPostRequest(fp[1], body, ctx).replayed, false);
  const poll = f.store.openClaimPoll(fp[1], body, ctx);
  assert.equal(poll.initial, null);
  const db = new DatabaseSync(f.options.path); t.after(() => db.close());
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 0, 'pending poll creates no cached no-work');
  assert.equal(poll.poll(true), null); poll.close();
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 1);
  inputs(f); const job = f.job(); f.publish(job);
  f.reopen();
  const retry = {...f.ctx(1, 'POST', '/jobs/claim-next', body, {idempotency_key:key}), route:'/jobs/claim-next'};
  assert.deepEqual(f.store.openPostRequest(fp[1], body, retry), {replayed:true, result:null});
  assert.equal(emptyPoll(f, key), null, 'no-work replay does not claim the later job');
  f.advance(600);
  assert.equal(emptyPoll(f,key),null,'no-work replies retain the full protocol day');
  f.advance(85800);const next=f.job();f.publish(next);f.advertise(1);
  assert.equal(emptyPoll(f, key).job.job_digest, p.digest(next.payload), 'expired no-work key may make a fresh claim');
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 1, 'the fresh account advertisement remains cached');
  assert.equal(cacheUsage(db, 'idempotency').rows, 2);
});

test('control-plane usage is rebuilt after restart without discarding legacy mutation keys', t => {
  const f = fixture(t); inputs(f);
  const job = f.job(), key = 'legacy-mutation', ack = f.publish(job, 0, {idempotency_key:key});
  const hb = controlHeartbeat(), receipt = heartbeat(f, hb, 1, {idempotency_key:'control'});
  const db = new DatabaseSync(f.options.path); t.after(() => db.close());
  db.exec('DELETE FROM control_idempotency_usage');
  f.reopen();
  assert.equal(cacheUsage(db, 'control_idempotency').rows, 1);
  assert.deepEqual(heartbeat(f, hb, 1, {idempotency_key:'control'}), receipt);
  assert.deepEqual(f.publish(job, 0, {idempotency_key:key}), ack);
  assert.equal(cacheUsage(db, 'idempotency').rows, 3);
});

test('control-plane quota separation preserves the protocol day-long no-work replay',t=>{
 const f=fixture(t),key='day-long-no-work';assert.equal(emptyPoll(f,key),null);
 inputs(f);f.publish(f.job());f.advance(601);
 assert.equal(emptyPoll(f,key),null,'a retried empty poll must not acquire work inside the advertised 24-hour replay window');
});

test('SEC-3 object limits include pending reservations, duplicates and restart',t=>{
  const f=fixture(t,{quotas:{deviceArtifacts:2,circleArtifacts:3}});
  const a={digest:p.digestBytes(Buffer.from('a')),bytes:1,media_type:'text/plain'};
  const b={digest:p.digestBytes(Buffer.from('b')),bytes:1,media_type:'text/plain'};
  const c={digest:p.digestBytes(Buffer.from('c')),bytes:1,media_type:'text/plain'};
  const first=f.reserve(a),second=f.reserve(b),third=f.reserve(c,1);
  code(()=>f.reserve(c),'quota_exceeded');code(()=>f.reserve(a,1),'quota_exceeded');
  f.reopen();code(()=>f.reserve(c),'quota_exceeded');
  f.commit(first.reservation_id,a);
  f.store.releaseArtifactReservation(fp[0],second.reservation_id,f.ctx(0,'POST','/artifact-reservations/'+second.reservation_id+'/release',{}));
  const duplicate=f.reserve(a);f.commit(duplicate.reservation_id,a);
  const db=new DatabaseSync(f.options.path);
  assert.deepEqual({...db.prepare("SELECT retained,reserved FROM artifact_counts WHERE device='' ").get()},{retained:1,reserved:1});db.close();
  f.commit(third.reservation_id,c,1);f.reopen();
  assert.equal(f.quotas().circle.retained_bytes,2);
  const next=f.reserve(b);code(()=>f.reserve(b,1),'quota_exceeded');
  f.commit(next.reservation_id,b);
});

test('SEC-3 legacy artifact-count migration includes existing files and reservations once',t=>{
  const f=fixture(t,{quotas:{deviceArtifacts:2,circleArtifacts:2}});
  const first={digest:p.digestBytes(Buffer.from('old-file')),bytes:8,media_type:'text/plain'};
  const second={digest:p.digestBytes(Buffer.from('old-reservation')),bytes:15,media_type:'text/plain'};
  f.upload(first);const pending=f.reserve(second);
  const db=new DatabaseSync(f.options.path);
  db.exec("DELETE FROM artifact_counts; DELETE FROM circle WHERE id='artifact_counts_v1';");db.close();
  f.reopen();code(()=>f.reserve(first),'quota_exceeded');f.commit(pending.reservation_id,second);
  f.reopen();
  const counts=new DatabaseSync(f.options.path);
  assert.deepEqual({...counts.prepare("SELECT retained,reserved FROM artifact_counts WHERE device='' ").get()},{retained:2,reserved:0});counts.close();
  code(()=>f.reserve(first),'quota_exceeded');
});

test('SEC-3 grace collection removes unreferenced uploads, protects pending digests and pinned job files',t=>{
  const f=fixture(t,{quotas:{unreferencedArtifactGraceSeconds:60}}),removed=[];
  f.store.setBlobRemover(name=>removed.push(name));inputs(f);f.publish(f.job());
  const orphan={digest:p.digestBytes(Buffer.from('orphan')),bytes:6,media_type:'text/plain'};
  f.upload(orphan);const pending=f.reserve(orphan);
  f.advance(61);f.quotas();assert.deepEqual(removed,[],'pending duplicate protects its existing blob');
  f.store.releaseArtifactReservation(fp[0],pending.reservation_id,f.ctx(0,'POST','/artifact-reservations/'+pending.reservation_id+'/release',{}));
  f.quotas();assert.deepEqual(removed,[orphan.digest.slice(7)]);
  code(()=>f.store.getArtifact(fp[0],orphan.digest,f.ctx(0,'GET','/artifacts/'+orphan.digest.slice(7))),'not_found');
  const pinned=vectors.job.payload.prompt;
  assert.deepEqual(f.store.getArtifact(fp[0],pinned.digest,f.ctx(0,'GET','/artifacts/'+pinned.digest.slice(7))),pinned);
  f.reopen();assert.equal(f.quotas().circle.retained_bytes,vectors.job.payload.prompt.bytes+vectors.job.payload.source.artifact.bytes);
});

test('SEC-3 failed garbage deletion cannot unlink a digest reuploaded before retry',t=>{
  const f=fixture(t,{quotas:{unreferencedArtifactGraceSeconds:60}});
  const artifact={digest:p.digestBytes(Buffer.from('reclaimed')),bytes:9,media_type:'text/plain'};
  f.upload(artifact);let failed=0,deleted=0;
  f.store.setBlobRemover(()=>{failed++;throw new Error('test-only removal failure');});
  f.advance(61);f.quotas();assert.ok(failed>0);
  const reservation=f.reserve(artifact);
  f.store.setBlobRemover(()=>deleted++);
  assert.equal(deleted,0,'an in-flight reservation has reclaimed the pending garbage name');
  f.commit(reservation.reservation_id,artifact);f.quotas();assert.equal(deleted,0);
  assert.deepEqual(f.store.getArtifact(fp[0],artifact.digest,f.ctx(0,'GET','/artifacts/'+artifact.digest.slice(7))),artifact);
});

test('SEC-3 authentication rollback leaves no deferred garbage work',t=>{
  const f=fixture(t,{quotas:{unreferencedArtifactGraceSeconds:60}});
  f.upload({digest:p.digestBytes(Buffer.from('rollback')),bytes:8,media_type:'text/plain'});f.advance(61);
  for(let n=0;n<3;n++)code(()=>f.store.getQuotas(fp[0],f.ctx(1,'GET','/quotas')),'forbidden');
  const prepare=DatabaseSync.prototype.prepare;let reads=0;
  DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT data FROM artifacts WHERE id=?')reads++;return prepare.call(this,sql);};
  try{f.store.setBlobRemover(()=>assert.fail('rolled-back artifact is still owned'));}
  finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(reads,0,'failed authentication must discard its scheduled garbage rather than retain duplicate cleanup work');
});

test('SEC-3 reservation-protected oldest artifacts cannot starve grace collection',t=>{
  const f=fixture(t,{quotas:{unreferencedArtifactGraceSeconds:60,concurrentUploads:256}}),db=new DatabaseSync(f.options.path);
  try{
    db.exec('BEGIN');let bytes=0;
    for(let n=0;n<128;n++){
      const content=Buffer.from('protected-'+n),ref={digest:p.digestBytes(content),bytes:content.length,media_type:'text/plain'};
      const id='bbbbbbbb-bbbb-4bbb-8bbb-'+n.toString(16).padStart(12,'0');bytes+=ref.bytes;
      db.prepare('INSERT INTO artifacts(id,data) VALUES(?,?)').run(ref.digest,JSON.stringify({ref,uploader:fp[0],created:f.now-120,pinned:false}));
      db.prepare('INSERT INTO reservations(id,data) VALUES(?,?)').run(id,JSON.stringify({reservation_id:id,device:fp[0],ref,roster_epoch:f.epoch,created:f.now}));
    }
    for(const id of ['circle','device:'+fp[0]])db.prepare('INSERT INTO quota_counters(id,data) VALUES(?,?)')
      .run(id,JSON.stringify({retained_bytes:bytes,reserved_bytes:bytes,uploads:128}));
    db.exec('COMMIT');
  }finally{db.close();}
  const eligible={digest:p.digestBytes(Buffer.from('eligible')),bytes:8,media_type:'text/plain'};
  f.upload(eligible);f.advance(61);f.quotas();
  code(()=>f.store.getArtifact(fp[0],eligible.digest,f.ctx(0,'GET','/artifacts/'+eligible.digest.slice(7))),'not_found');
});

test('metadata tombstone quotas roll back admission and survive reopen',t=>{
  const f=fixture(t,{quotas:{circleMetadataRows:4,circleMetadataBytes:1048576}});
  const revoke=()=>{const body=invitationRevocation({circle,origin,epoch:f.epoch,inviteId:randomUUID(),now:f.now,rootKey:keys[2]});return ()=>f.store.revokeInvite(body,f.ctx(0,'POST','/invites/revoke',body));};
  revoke()();revoke()();
  code(revoke(),'quota_exceeded');
  const fresh=p.signEnvelope('invite',{...vectors.invite.payload,created_at:iso(f.now),expires_at:iso(f.now+3600)},keys[2]);
  code(()=>f.store.registerInvite(fresh,f.ctx(0,'POST','/invites',fresh)),'quota_exceeded');
  f.reopen();code(revoke(),'quota_exceeded');
});
test('metadata byte budget rejects an oversized roster without changing the current epoch',t=>{
  const f=fixture(t,{quotas:{circleMetadataBytes:2500}});
  heartbeat(f,{...controlHeartbeat(),capabilities:['run_request_v1','circle_profile_v1']});
  const next=p.signEnvelope('roster',{...vectors.roster.payload,epoch:8,profile:{name:'x'.repeat(256),purpose:'x'.repeat(256)}},keys[2]);
  code(()=>f.store.installRoster(next,f.ctx(0,'PUT','/roster',next,{roster_epoch:8})),'quota_exceeded');
  assert.equal(f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')).payload.epoch,7);
});
test('unreferenced roster history is collected while current replay fence survives reopen',t=>{
  const f=fixture(t,{quotas:{rosterHistoryRows:2,circleMetadataRows:3}});
  for(let epoch=8;epoch<=12;epoch++){
    const signed=p.signEnvelope('roster',{...vectors.roster.payload,epoch},keys[2]);
    f.store.installRoster(signed,f.ctx(0,'PUT','/roster',signed,{roster_epoch:epoch}));f.epoch=epoch;
  }
  f.reopen();
  code(()=>f.store.getHistoricalRoster(fp[0],7,f.ctx(0,'GET','/rosters/7')),'not_found');
  assert.equal(f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')).payload.epoch,12);
  code(()=>f.store.installRoster(vectors.roster,f.ctx(0,'PUT','/roster',vectors.roster,{roster_epoch:7})),'roster_stale');
});

test('invitation spam leaves room for repeated owner governance publications',t=>{
  const f=fixture(t,{quotas:{circleMetadataRows:4}});
  for(let i=0;i<2;i++){
    const body=invitationRevocation({circle,origin,epoch:f.epoch,inviteId:randomUUID(),now:f.now,rootKey:keys[2]});
    f.store.revokeInvite(body,f.ctx(0,'POST','/invites/revoke',body));
  }
  for(let epoch=8;epoch<=12;epoch++){
    const signed=p.signEnvelope('roster',{...vectors.roster.payload,epoch},keys[2]);
    assert.doesNotThrow(()=>f.store.installRoster(signed,f.ctx(0,'PUT','/roster',signed,{roster_epoch:epoch})));
    f.epoch=epoch;
  }
  assert.equal(f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')).payload.epoch,12);
});
test('an older over-budget ledger starts and serves reads while rejecting growth',async t=>{
  const f=fixture(t,{quotas:{circleMetadataRows:50}});
  for(let i=0;i<5;i++){
    const body=invitationRevocation({circle,origin,epoch:f.epoch,inviteId:randomUUID(),now:f.now,rootKey:keys[2]});
    f.store.revokeInvite(body,f.ctx(0,'POST','/invites/revoke',body));
  }
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.options.path);
  const config=JSON.parse(db.prepare("SELECT data FROM circle WHERE id='config'").get().data);config.limits.circleMetadataRows=3;
  db.prepare("UPDATE circle SET data=? WHERE id='config'").run(JSON.stringify(config));db.close();
  assert.doesNotThrow(()=>f.reopen());
  assert.equal(f.store.getRoster(fp[0],f.ctx(0,'GET','/roster')).payload.epoch,7);
  const body=invitationRevocation({circle,origin,epoch:f.epoch,inviteId:randomUUID(),now:f.now,rootKey:keys[2]});
  code(()=>f.store.revokeInvite(body,f.ctx(0,'POST','/invites/revoke',body)),'quota_exceeded');
});

test('roster collection preserves signing epochs while an attempt can still complete',t=>{
  const f=fixture(t,{quotas:{rosterHistoryRows:2}});inputs(f);outputs(f);
  const job=f.job();f.publish(job);const {attempt}=f.claim(p.digest(job.payload));f.start(attempt);
  let result;
  for(let epoch=8;epoch<=12;epoch++){
    const signed=p.signEnvelope('roster',{...vectors.roster.payload,epoch},keys[2]);
    f.store.installRoster(signed,f.ctx(0,'PUT','/roster',signed,{roster_epoch:epoch}));f.epoch=epoch;
    if(epoch===8)result=f.result(job,attempt);
  }
  assert.equal(f.complete(result).status,'result-accepted');
});

test('busy circles collect pre-claim history but keep every active signing epoch',t=>{
  const f=fixture(t,{quotas:{rosterHistoryRows:2,circleMetadataRows:12}});inputs(f);outputs(f);
  const publishEpoch=epoch=>{const signed=p.signEnvelope('roster',{...vectors.roster.payload,epoch},keys[2]);f.store.installRoster(signed,f.ctx(0,'PUT','/roster',signed,{roster_epoch:epoch}));f.epoch=epoch;};
  for(let epoch=8;epoch<=12;epoch++)publishEpoch(epoch);
  const job=f.job();f.publish(job);const {attempt}=f.claim(p.digest(job.payload));f.start(attempt);
  const earlier=f.result(job,attempt);f.reopen();
  for(let epoch=13;epoch<=16;epoch++)publishEpoch(epoch);
  code(()=>f.store.getHistoricalRoster(fp[0],11,f.ctx(0,'GET','/rosters/11')),'not_found');
  for(let epoch=12;epoch<=16;epoch++)assert.equal(f.store.getHistoricalRoster(fp[0],epoch,f.ctx(0,'GET','/rosters/'+epoch)).payload.epoch,epoch);
  const invite=p.signEnvelope('invite',{...vectors.invite.payload,created_at:iso(f.now),expires_at:iso(f.now+3600)},keys[2]);
  assert.doesNotThrow(()=>f.store.registerInvite(invite,f.ctx(0,'POST','/invites',invite)));
  assert.equal(f.complete(earlier).status,'result-accepted');
});

// Judge r9 O-B: a person's own actions keep their share of the device's nonce budget. Background reads stop at the
// reserve (one eighth, at most 256); a write still goes through.
test('v1 reads stop at the write reserve so a write still has nonce room', t => {
  const f=fixture(t,{quotas:{noncesPerDevice:16}});
  for(let i=0;i<14;i++)f.store.getRoster(fp[1],f.ctx(1,'GET','/roster'));
  code(()=>f.store.getRoster(fp[1],f.ctx(1,'GET','/roster')),'rate_limited');
  const db=new DatabaseSync(f.options.path);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM nonces').get().n,14,'reads stopped two short of the device budget');
  assert.doesNotThrow(()=>heartbeat(f),'the write still has room');
});

test('step progress is rejected after its execution permission expires', t => {
  const f = fixture(t);
  const job = f.job(); inputs(f);
  const digest = f.publish(job).job_digest;
  const a = f.claim(digest).attempt; f.start(a);
  f.advance(121);
  const body = {attempt:a.attempt_id, step:'Still working', kind:'step'};
  code(() => f.store.postProgress(fp[1], digest, body,
    f.ctx(1, 'POST', '/jobs/' + segment(digest) + '/progress', body)), 'stale_attempt');
});

// A finished result names its files by digest. Until the coordinator accepts or refuses that result, the files must outlive
// everything else that can retire a blob: deleting another job that shares them, and the grace collector.
function startedJob(f, device = 1, lease = 120) {
  const job = f.job(), digest = p.digest(job.payload);
  f.publish(job);
  const attempt = f.claim(digest, device, lease).attempt;
  f.start(attempt, device);
  return {job, digest, attempt};
}
const resultFiles = () => [vectors.result.payload.candidate, vectors.result.payload.transcript];

test('delivery hold: deleting another job that shares the result files keeps them for the job still delivering', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const first = startedJob(f);
  f.complete(f.result(first.job, first.attempt));
  const second = startedJob(f);
  for (const ref of resultFiles()) f.head(ref, 1, second.digest);
  f.deleteJob(first.digest);
  const ack = f.complete(f.result(second.job, second.attempt));
  assert.equal(ack.status, 'result-accepted');
});

test('delivery hold: grace collection keeps the files of a job that is still delivering', t => {
  const f = fixture(t, {quotas: {unreferencedArtifactGraceSeconds: 60}}), removed = [];
  f.store.setBlobRemover(name => removed.push(name)); inputs(f);
  const run = startedJob(f, 1, 300);
  for (const ref of resultFiles()) f.finish(ref, 1, run.digest);
  f.advance(61); f.quotas();
  assert.deepEqual(removed, [], 'no file of the open job is removed');
  assert.equal(f.complete(f.result(run.job, run.attempt)).status, 'result-accepted');
});

test('delivery hold: the hold ends with the job, then grace collection reclaims the files', t => {
  const f = fixture(t, {quotas: {unreferencedArtifactGraceSeconds: 60}}), removed = [];
  f.store.setBlobRemover(name => removed.push(name)); inputs(f);
  const run = startedJob(f, 1, 300);
  for (const ref of resultFiles()) f.finish(ref, 1, run.digest);
  f.cancel(run.job);
  f.advance(61); f.quotas();
  assert.deepEqual(removed.sort(), resultFiles().map(ref => segment(ref.digest)).sort());
});

test('delivery hold: a file shared with a deleted job is reclaimed once the delivering job ends without a result', t => {
  const f = fixture(t, {quotas: {unreferencedArtifactGraceSeconds: 60}}), removed = [];
  f.store.setBlobRemover(name => removed.push(name)); inputs(f); outputs(f);
  const first = startedJob(f);
  f.complete(f.result(first.job, first.attempt));
  const second = startedJob(f);
  for (const ref of resultFiles()) f.head(ref, 1, second.digest);
  f.deleteJob(first.digest);
  assert.deepEqual(removed, [], 'kept while the second job delivers');
  f.cancel(second.job);
  f.advance(61); f.quotas();
  assert.deepEqual(removed.sort(), resultFiles().map(ref => segment(ref.digest)).sort());
});

test('delivery hold: an upload bound to a job that is finished, deleted or not the sender\'s is refused', t => {
  const f = fixture(t); inputs(f); outputs(f);
  const done = startedJob(f);
  f.complete(f.result(done.job, done.attempt));
  const [candidate, transcript] = resultFiles();
  code(() => f.reserve(transcript, 1, true, done.digest), 'job_terminal');
  code(() => f.head(candidate, 1, done.digest), 'job_terminal');
  const open = startedJob(f);
  f.deleteJob(done.digest);
  code(() => f.reserve(transcript, 1, true, done.digest), 'job_terminal');
  code(() => f.reserve(transcript, 0, true, open.digest), 'job_terminal');
  code(() => f.reserve(transcript, 1, true, 'sha256:' + '0'.repeat(64)), 'job_terminal');
});

test('delivery hold: a job that ends between reserve and install gets no new bytes', t => {
  const f = fixture(t); inputs(f);
  const run = startedJob(f);
  const ref = resultFiles()[1];
  const reservation = f.reserve(ref, 1, true, run.digest);
  f.cancel(run.job);
  let installed = false;
  code(() => f.store.finishArtifactUpload(fp[1], reservation.reservation_id, ref, () => {installed = true;},
    reservation.owner_token, {verifiedInput: true, job: run.digest}), 'job_terminal');
  assert.equal(installed, false, 'the bytes were not installed');
  code(() => f.store.getArtifact(fp[1], ref.digest, f.ctx(1, 'GET', '/artifacts/' + segment(ref.digest))), 'not_found');
});

for (const reason of ['isolation_check_failed', 'approval_denied']) test(`upgrade preserves old declined_by (${reason})`, t => {
  const f = fixture(t);
  inputs(f);
  const signed = f.job(), digest = p.digest(signed.payload);
  f.publish(signed);
  const {attempt} = f.claim(digest);
  f.end('release', attempt, 1, JSON.stringify({code: reason}));
  const db = new DatabaseSync(f.options.path);
  const row = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
  row.declined_by = [fp[1]];
  delete row.declined_by_version;
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), digest);
  db.close();
  f.reopen();
  code(() => f.claim(digest), 'forbidden');
});

test('upgrade preserves an old offer Decline after an earlier sandbox_not_ready release', t => {
  const f = fixture(t); inputs(f);
  const signed = f.job(), digest = p.digest(signed.payload);
  f.publish(signed);
  const {attempt} = f.claim(digest);
  f.end('release', attempt, 1, JSON.stringify({code: 'sandbox_not_ready'}));
  f.store.declineJob(fp[1], digest, f.ctx(1, 'POST', '/jobs/' + segment(digest) + '/decline', {}));
  const db = new DatabaseSync(f.options.path);
  const row = JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);
  delete row.declined_by_version;
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), digest);
  db.close();
  f.reopen();
  code(() => f.claim(digest), 'forbidden');
});

// Owner-offline topology: a store serving a member's recorded origin is reached by a carrier that is
// not the owner. The roster root key (keys[2]) is not any member's device key; the author (4) is
// distinct from the owner (0) and the carrier (1).
const AUTHOR = 4;
const memberEntry = (device, extra = {}) => ({ key_id: fp[device], public_key: pub[device], joined_epoch: 8, ...extra });
const retentionFor = (f, digest) => [0, 1, AUTHOR].map(device => f.store.getRetention(fp[device], digest,
  f.ctx(device, 'GET', '/jobs/' + segment(digest) + '/retention')).deletable);
function cancelledAuthorJob(f) {
  f.upload(vectors.job.payload.source.artifact, AUTHOR); f.upload(vectors.job.payload.prompt, AUTHOR);
  const job = f.job({}, AUTHOR), digest = p.digest(job.payload);
  f.publish(job, AUTHOR); f.cancel(job, {}, AUTHOR);
  return digest;
}

test('a member-carried legacy refresh keeps the independent owner and never promotes the carrier', t => {
  const f = fixture(t);
  const members = origin => [memberEntry(0), memberEntry(1, origin ? { origin } : {}), memberEntry(AUTHOR)];
  f.install(f.roster(members(), 8), 0);
  const digest = cancelledAuthorJob(f);
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'owner-carried publication on an ordinary store records the owner');
  // The next epoch records member 1's serving origin (this store's own origin) and member 1 carries it.
  f.install(f.roster(members(origin), 9), 1);
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'the member carrier gains no owner access');
  f.reopen();
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'owner custody survives reopen');
  f.install(f.roster(members(origin), 10), 1);
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'a further member-carried refresh still keeps it');
  assert.equal(f.store.getRoster(fp[0], f.ctx(0, 'GET', '/roster')).payload.epoch, 10);
});

test('a member-carried legacy refresh with no prior owner witness leaves ownership unknown', t => {
  const f = fixture(t);
  f.install(f.roster([memberEntry(0), memberEntry(1, { origin }), memberEntry(AUTHOR)], 8), 1);
  const digest = cancelledAuthorJob(f);
  assert.deepEqual(retentionFor(f, digest), [false, false, true], 'neither the carrier nor a guessed owner gets access; only the author');
  f.reopen();
  assert.deepEqual(retentionFor(f, digest), [false, false, true], 'unknown stays unknown after reopen');
});

test('a governed member-carried refresh keeps the chain owner and fences a moved member origin', t => {
  const f = fixture(t);
  const incumbent = 'https://incumbent.example';
  const authority_chain = [p.createAuthorityGenesis({ circle, coordinator: incumbent,
    owner: { key_id: fp[0], public_key: pub[0] }, issued_at: f.now }, keys[2])];
  // With a chain the owner device signs the roster; the carrier stays the member that serves this origin.
  const governed = (epoch, entry) => p.signEnvelope('roster', { ...vectors.roster.payload, epoch,
    members: [memberEntry(0), entry, memberEntry(AUTHOR)], coordinator: incumbent, authority_chain }, keys[0]);
  f.install(f.roster([memberEntry(0), memberEntry(1), memberEntry(AUTHOR)], 8), 0);
  const capabilities = [...MEMBER_CAPABILITIES];
  for (const device of [0, 1, AUTHOR]) f.store.heartbeat(fp[device], { capabilities },
    f.ctx(device, 'POST', '/heartbeat', { capabilities }));
  f.install(governed(9, memberEntry(1, { origin })), 1);
  const digest = cancelledAuthorJob(f);
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'the signed chain names the owner, not the carrier');
  f.reopen();
  f.install(governed(10, memberEntry(1, { origin })), 1);
  assert.deepEqual(retentionFor(f, digest), [true, false, true], 'an unchanged-chain refresh keeps it across reopen');
  code(() => f.install(governed(11, memberEntry(1, { origin: 'https://moved.example' })), 1), 'conflict');
  assert.equal(f.store.getRoster(fp[0], f.ctx(0, 'GET', '/roster')).payload.epoch, 10, 'a roster that moved the member origin is not installed here');
});

for(const reason of ['cannot_run_here','readiness_changed','cleanup_pending','no_spare'])test('timed give-back has no coordinator start penalty: '+reason,t=>{
 const f=fixture(t);inputs(f);
 const job=f.job(),digest=p.digest(job.payload);f.publish(job);
 const first=f.claim(digest).attempt;
 const until=(f.now+120)*1000;
 f.end('release',first,1,JSON.stringify({code:reason,until}));
 const db=new DatabaseSync(f.options.path);
 const row=JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(digest).data);db.close();
 assert.equal(row.start_failures??0,0);assert.ok(!row.declined_by?.includes(fp[1]));
 assert.equal(f.get(digest).state,'queued');
 assert.equal(JSON.parse(f.attempt(first.attempt_id).reason).until,until);
 assert.notEqual(f.claim(digest).attempt.attempt_id,first.attempt_id,'same lender remains eligible at coordinator');
});
