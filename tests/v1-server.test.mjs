import './helpers/no-browser.mjs';
import {currentAdvertisement,accountHeartbeat,selectionForJob,currentReceipt} from './helpers/current-job-advertisement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { open as openFile, unlink as unlinkFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';
import { consumeRequest, createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { startCoordinator } from '../lib/coordinator.mjs';

for(const dimension of ['bytes','inodes'])test('SEC-3 physical '+dimension+' headroom is shared by in-flight uploads and released after abort',async t=>{
  const unit=16384n;
  const capacity={bsize:unit,bavail:10n,files:1000n,ffree:2n};
  const f=await fixture(t,{limits:{minFreeDiskBytes:dimension==='bytes'?Number(6n*unit):0,minFreeInodes:dimension==='inodes'?1:0},
    uploadIO:{statfsSync:()=>capacity}});
  const first=ref(Buffer.from('a')),options=f.signed(0,'PUT',artifactRoute(first),Buffer.from('a'),{mediaType:'text/plain'});
  const held=httpRequest(f.origin+base+artifactRoute(first),{method:'PUT',headers:options.headers},res=>res.resume());
  held.on('error',()=>{});t.after(()=>held.destroy());held.flushHeaders();
  await eventually(()=>f.handler.pendingRequests===1&&readdirSync(f.blobDir).some(name=>name.startsWith('.upload-')),'upload never acquired headroom');
  const second=ref(Buffer.from('b'));
  await problem(await f.raw(1,'PUT',artifactRoute(second),Buffer.from('b'),{mediaType:'text/plain'}),429,'rate_limited');
  assert.equal((await f.quota()).circle.uploads,1,'headroom rejection did not allocate another reservation');
  held.destroy();await eventually(()=>f.handler.pendingRequests===0,'aborted physical reservation leaked');
  const retry=await f.raw(1,'PUT',artifactRoute(second),Buffer.from('b'),{mediaType:'text/plain'});
  assert.equal(retry.status,200);await retry.arrayBuffer();
  assert.equal((await f.raw(1,'GET',artifactRoute(second))).status,200);
});

test('SEC-3 grace collector removes actual orphan files and retains pinned job files across handler restart',async t=>{
  const f=await fixture(t,{quotas:{unreferencedArtifactGraceSeconds:60}}),client=f.client(0);
  const payload=await f.job(client),job=p.signEnvelope('job',payload,keys[0]);
  assert.equal((await f.raw(0,'POST','/jobs',job)).status,201);
  const unreferenced=await client.uploadArtifact(Buffer.from('unreferenced'),'text/plain');
  assert.ok(existsSync(join(f.blobDir,unreferenced.digest.slice(7))));
  f.advance(61);await f.quota();
  assert.equal(existsSync(join(f.blobDir,unreferenced.digest.slice(7))),false);
  assert.ok(existsSync(join(f.blobDir,payload.prompt.digest.slice(7))));
  f.restartHandler();
  assert.equal((await f.raw(0,'GET',artifactRoute(payload.prompt))).status,200);
});

// Hermetic loopback transport only. Keys and alleged execution receipts are TEST-ONLY;
// these tests never invoke a provider, harness, browser, real enrollment or model.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pubs = keys.map(p.exportPublicKey), ids = pubs.map(p.fingerprint);
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k, v]) => [k, v.envelope]));
const circle = vectors.job.payload.circle;
const base = '/v1/circles/' + circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const ad = currentAdvertisement({
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'],
  egress: ['provider-only'], enforced_limits: Object.keys(vectors.job.payload.requirements.limits),
  max_limits: vectors.job.payload.requirements.limits,
});
const sourceBytes = Buffer.from('test-only compressed source fixture');
const promptBytes = Buffer.from('test-only prompt');
const candidate = Buffer.from('--- a/test\n+++ b/test\n');
const transcript = Buffer.from('{"test":true}\n');
const artifactRoute = ref => '/artifacts/' + ref.digest.slice(7);
const ref = (bytes, media_type = 'text/plain') => ({ digest: p.digestBytes(bytes), bytes: bytes.length, media_type });
function diskFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? diskFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
}
async function eventually(check, message) {
  for (let n = 0; n < 100; n++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-http-'));
  const blobDir = join(dir, 'blobs'), requests = [], errors = [];
  let handler, store, now = start;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const roster = options.initialRoster ?? vectors.roster;
  store = openV1Store({ path: join(dir, 'store.sqlite'), origin, circle,
    rootFingerprint: ids[2], initialRoster: roster, clock: () => now,
    ...(options.quotas ? { quotas: options.quotas } : {}),
    ...(options.versions ? { faravanVersion: options.versions.faravan, minMember: options.versions.minMember } : {}) });
  const httpStore = options.versionPolicy === undefined ? store : new Proxy(store, {
    get(target, name) { return name === 'versionPolicy' ? () => options.versionPolicy : target[name]; }
  });
  handler = createV1Handler({ store: httpStore, blobDir, clock: () => now, limits: options.limits, uploadIO: options.uploadIO, downloadIO: options.downloadIO, pollTiming: options.pollTiming });
  t.after(async () => {
    handler.close?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(errors, [], errors.map(e => e.stack).join('\n'));
  });
  const f = { dir, blobDir, store, handler, server, origin, requests, epoch: roster.payload.epoch,
    get now() { return now; }, advance(n) { now += n; },
    restartHandler() {
      handler.close();
      handler = createV1Handler({ store: httpStore, blobDir, clock: () => now, limits: options.limits, uploadIO: options.uploadIO, downloadIO: options.downloadIO, pollTiming: options.pollTiming });
      f.handler = handler;
    },
    client(index, bootstrap = false, extra = {}) {
      let snapshot = bootstrap ? { current: null, history: [], highestAcceptedEpoch: 0 } :
        { current: roster, history: [], highestAcceptedEpoch: roster.payload.epoch,
          highestAcceptedDigest: p.digest(roster.payload) };
      const client=createClient({ origin, circle, deviceKey: keys[index], pinnedRootFingerprint: ids[2],
        rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; } },
        clock: () => now, retry: { maxAttempts: 1 }, ...extra });
      if(extra.accountClaims!==false){const claim=client.claimNext;client.claimNext=async(...args)=>{await client.heartbeat(accountHeartbeat(ad));return claim(...args);};}
      return client;
    },
    signed(index, method, route, body, options = {}) {
      const bytes = body === undefined ? Buffer.alloc(0) :
        body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(p.canonicalize(body));
      const contentType = ['GET', 'HEAD'].includes(method) ? '' :
        options.mediaType ? 'application/octet-stream' : 'application/json';
      const key = method === 'POST' ? options.idempotencyKey ?? randomUUID() : '';
      const proof = p.buildRequestProof({ circle, roster_epoch: options.epoch ?? f.epoch,
        method, target: origin + base + route, body: bytes, content_type: contentType,
        artifact_media_type: options.mediaType ?? '', idempotency_key: key,
        created: now, nonce: randomBytes(24).toString('base64url'), ...options.proof }, keys[index]);
      const headers = { 'Faravan-Proof': proof, 'Faravan-Client-Capabilities':'run_request_v1' };
      if (contentType) headers['Content-Type'] = contentType;
      if (!['GET', 'HEAD'].includes(method)) headers['Content-Length'] = String(options.length ?? bytes.length);
      if (options.mediaType) headers['Faravan-Media-Type'] = options.mediaType;
      if (key) headers['Idempotency-Key'] = key;
      return { method, headers, ...(!['GET', 'HEAD'].includes(method) ? { body: bytes } : {}) };
    },
    raw(index, method, route, body, options) {
      return fetch(origin + base + route, f.signed(index, method, route, body, options));
    },
    async quota(index = 0) { return (await f.raw(index, 'GET', '/quotas')).json(); },
    async job(client, overrides = {}) {

      const source = { kind: 'archive', artifact: await client.uploadArtifact(sourceBytes, 'application/gzip') };
      const prompt = await client.uploadArtifact(promptBytes, 'text/plain');
      return { ...structuredClone(vectors.job.payload), source, prompt, roster_epoch: f.epoch,
        intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600), ...overrides };
    },
  };
  return f;
}
async function problem(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  const value = await response.json();
  assert.equal(value.status, status); assert.equal(value.code, code);
  assert.equal(value.outcome, 'not_applied'); assert.equal(typeof value.retryable, 'boolean');
  return value;
}


test('v1 historical roster HTTP reads require current membership and return the exact epoch', async t => {
  const f = await fixture(t);
  const next = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 8 }, keys[2]);
  assert.equal((await f.raw(0, 'PUT', '/roster', next, { epoch: 8 })).status, 200);
  f.epoch = 8;
  const response = await f.raw(0, 'GET', '/rosters/7');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), vectors.roster);
  await problem(await f.raw(3, 'GET', '/rosters/7'), 403, 'forbidden');
  await problem(await f.raw(0, 'GET', '/rosters/999'), 404, 'not_found');
});

test('v1 JSON forged proofs and oversized signed lengths fail before the body arrives', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { maxBodyBytes: 1024 } });
  async function headersOnly(options) {
    let req;
    const response = await Promise.race([
      new Promise((resolve, reject) => {
        req = httpRequest(f.origin + base + '/jobs', { method: 'POST', headers: options.headers }, resolve);
        req.on('error', error => { if (!req.destroyed) reject(error); });
        req.flushHeaders();
      }), delay(10000).then(() => null),
    ]);
    req.destroy();
    assert.ok(response, 'headers must be rejected without waiting for body bytes');
    response.resume(); return response.statusCode;
  }
  const forged = f.signed(0, 'POST', '/jobs', { padding: 'x'.repeat(100) });
  const envelope = p.strictParse(Buffer.from(forged.headers['Faravan-Proof'], 'base64url'));
  const signature = Buffer.from(envelope.signature.value, 'base64url'); signature[32] ^= 1;
  envelope.signature.value = signature.toString('base64url');
  forged.headers['Faravan-Proof'] = Buffer.from(p.canonicalize(envelope)).toString('base64url');
  assert.equal(await headersOnly(forged), 401);
  const oversized = f.signed(0, 'POST', '/jobs', { padding: 'x'.repeat(1025) });
  delete oversized.headers['Content-Length']; oversized.headers['Transfer-Encoding'] = 'chunked';
  assert.equal(await headersOnly(oversized), 413);
});

test('v1 unauthenticated global failure limit expires without blocking a valid enrollment', async t => {
  const f = await fixture(t, { limits: { unauthenticatedFailures: 2, bootstrapWindowSeconds: 60 }, quotas:{nonceRows:4} });
  const send = () => fetch(f.origin + base + '/enrollments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await problem(await send(), 401, 'unauthenticated');
  await problem(await send(), 401, 'unauthenticated');
  for(let i=0;i<35;i++)await problem(await send(),429,'rate_limited');
  const invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],created_at:iso(f.now),expires_at:iso(f.now+3600)},keys[2]);
  assert.equal((await f.raw(0,'POST','/invites',invite)).status,200);
  const body={invite,device_public_key:pubs[3],enrollment_proof:p.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:pubs[3]},keys[3])};
  for(let i=0;i<12;i++)await problem(await f.raw(3,'POST','/enrollments',{...body,enrollment_proof:{}},{epoch:0}),429,'rate_limited');
  assert.equal((await f.raw(3,'POST','/enrollments',body,{epoch:0})).status,202);
  for(let i=0;i<12;i++)await problem(await f.raw(3,'POST','/enrollments',{...body,enrollment_proof:{}},{epoch:0}),429,'rate_limited');
  assert.equal((await f.raw(0,'GET','/roster')).status,200,'invalid proofs for an existing enrollment must not poison member nonces');
  f.advance(61);
  await problem(await send(), 401, 'unauthenticated');
});

test('v1 long polls enforce per-device and global caps and release capacity on disconnect', { timeout: 5000 }, async t => {
  const f = await fixture(t, { limits: { maxPollsPerDevice: 1, maxPolls: 2 } });
  const body = { advertisement: ad, lease_seconds: 120, wait_seconds: 30 };
  const controllers = [];
  const startPoll = index => {
    const controller = new AbortController(); controllers.push(controller);
    return fetch(f.origin + base + '/jobs/claim-next', { ...f.signed(index, 'POST', '/jobs/claim-next', body), signal: controller.signal }).catch(() => null);
  };
  t.after(() => controllers.forEach(controller => controller.abort()));
  const first = startPoll(1);
  await eventually(() => f.handler.pendingPolls === 1, 'first poll not opened');
  const capped = await Promise.race([f.raw(1, 'POST', '/jobs/claim-next', body), delay(10000).then(() => null)]);
  assert.ok(capped, 'second poll from same device must fail promptly');
  await problem(capped, 429, 'rate_limited');
  const second = startPoll(0);
  await eventually(() => f.handler.pendingPolls === 2, 'second device poll not opened');
  await problem(await f.raw(0, 'POST', '/jobs/claim-next', body), 429, 'rate_limited');
  controllers[0].abort(); await first;
  await eventually(() => f.handler.pendingPolls === 1, 'disconnect did not release poll slot');
  const replacement = startPoll(1);
  await eventually(() => f.handler.pendingPolls === 2, 'freed poll slot was not reusable');
  controllers.forEach(controller => controller.abort()); await Promise.all([second, replacement]);
  await eventually(() => f.handler.pendingPolls === 0, 'polls leaked after disconnect');
});

test('v1 global poll cap applies across different devices', { timeout: 3000 }, async t => {
  const f = await fixture(t, { limits: { maxPolls: 1, maxPollsPerDevice: 2 } });
  const body = { advertisement: ad, wait_seconds: 30 };
  const controller = new AbortController(); t.after(() => controller.abort());
  const pending = fetch(f.origin + base + '/jobs/claim-next', { ...f.signed(1,'POST','/jobs/claim-next',body), signal:controller.signal }).catch(() => null);
  await eventually(() => f.handler.pendingPolls === 1, 'poll did not open');
  const response = await Promise.race([f.raw(0,'POST','/jobs/claim-next',body),delay(500).then(()=>null)]);
  assert.ok(response, 'global cap must reject another member promptly');
  await problem(response,429,'rate_limited');
  controller.abort(); await pending;
});

for (const limits of [{maxRequests:1,maxRequestsPerSource:64},{maxRequests:64,maxRequestsPerSource:1}]) {
  test('v1 unfinished enrollment bodies preserve member request capacity ' + JSON.stringify(limits), {timeout:3000}, async t => {
    const f = await fixture(t,{limits});
    const options = f.signed(3,'POST','/enrollments',{ padding: 'x'.repeat(100) },{epoch:0});
    const req = httpRequest(f.origin + base + '/enrollments',{method:'POST',headers:options.headers});
    req.on('error',()=>{});t.after(()=>req.destroy());req.flushHeaders();
    await eventually(()=>f.requests.length===1,'unfinished request did not arrive');
    assert.equal((await f.raw(0,'GET','/quotas')).status,200);
    req.destroy();
    await eventually(async()=> (await f.raw(0,'GET','/quotas')).status===200,'aborted request leaked concurrency slot');
  });
}

test('v1 JSON timeout releases bounded request capacity', {timeout:3000}, async t => {
  const f = await fixture(t,{limits:{maxRequests:1,jsonTimeoutMs:40,enrollmentTimeoutMs:40}});
  const options = f.signed(3,'POST','/enrollments',{padding:'waiting'},{epoch:0});
  let req;
  const response = await new Promise((resolve,reject)=>{
    req=httpRequest(f.origin+base+'/enrollments',{method:'POST',headers:options.headers},resolve);
    req.on('error',reject);req.flushHeaders();
  });
  t.after(()=>req.destroy());
  assert.equal(response.statusCode,400);response.resume();
  assert.equal((await f.raw(0,'GET','/quotas')).status,200,'timed-out body must release request slot');
});

test('v1 enrollment retry after a lost response reuses its idempotency key and host result', async t => {
  const initialRoster = p.signEnvelope('roster', { ...vectors.roster.payload,
    members: vectors.roster.payload.members.filter(m => m.key_id === ids[0]) }, keys[2]);
  const f = await fixture(t, { initialRoster });
  const owner = f.client(0), candidate = f.client(1, true);
  const invite = p.createInvite({ circle, coordinator: f.origin, invite_id: randomUUID(),
    invite_public_key: pubs[3], created_at: iso(f.now), expires_at: iso(f.now + 3600) }, keys[2]);
  assert.equal((await f.raw(0, 'POST', '/invites', invite)).status, 200);
  const link = p.encodeInviteLink(invite, Buffer.from(golden.keys[3].seed_hex, 'hex'));
  const idempotencyKey = 'join-outage-recovery';
  let loseFirstResponse = true;
  const flakyCandidate = f.client(1, true, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (loseFirstResponse && new URL(url).pathname.endsWith('/enrollments') && init.method === 'POST') {
      loseFirstResponse = false;
      await response.arrayBuffer();
      throw new TypeError('simulated response loss after host commit');
    }
    return response;
  } });
  await assert.rejects(flakyCandidate.enroll(link, { idempotencyKey }), error =>
    error.code === 'network_error' && error.outcome === 'unknown' && error.operationKey === idempotencyKey);
  const hostRowsAfterLostResponse = [];
  for await (const row of owner.listEnrollments()) hostRowsAfterLostResponse.push(row);
  assert.equal(hostRowsAfterLostResponse.length, 1, 'host committed the enrollment before the response was lost');

  const retried = await candidate.enroll(link, { idempotencyKey });
  assert.equal(retried.state, 'pending');
  assert.equal(retried.enrollment_id, hostRowsAfterLostResponse[0].enrollment_id,
    'same-key retry returns the host result already committed');
  const hostRowsAfterRetry = [];
  for await (const row of owner.listEnrollments()) hostRowsAfterRetry.push(row);
  assert.equal(hostRowsAfterRetry.length, 1, 'same-key retry does not create a duplicate enrollment');
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.url.endsWith('/enrollments')).length, 2);
});

test('v1 chunked JSON cannot stream beyond the authenticated declared length', {timeout:3000}, async t => {
  const f=await fixture(t),options=f.signed(0,'POST','/jobs',{padding:'bounded'});
  delete options.headers['Content-Length'];options.headers['Transfer-Encoding']='chunked';
  let req;
  const response=await new Promise((resolve,reject)=>{
    req=httpRequest(f.origin+base+'/jobs',{method:'POST',headers:options.headers},resolve);
    req.on('error',reject);req.write(Buffer.concat([options.body,Buffer.alloc(1024)]));
  });
  t.after(()=>req.destroy());
  assert.equal(response.statusCode,413);response.resume();
});

test('v1 HTTP client enrolls, approves, long-polls, renews, completes and verifies result bytes',
  { timeout: 10000 }, async t => {
    const initialRoster = p.signEnvelope('roster', { ...vectors.roster.payload,
      members: vectors.roster.payload.members.filter(m => m.key_id === ids[0]) }, keys[2]);
    const f = await fixture(t, { initialRoster });
    const borrower = f.client(0), lender = f.client(1, true);
    const invite = p.createInvite({ circle, coordinator: f.origin, invite_id: randomUUID(),
      invite_public_key: pubs[3], created_at: iso(f.now), expires_at: iso(f.now + 3600) }, keys[2]);
    assert.equal((await f.raw(0, 'POST', '/invites', invite)).status, 200);
    const pending = await lender.enroll(p.encodeInviteLink(invite, Buffer.from(golden.keys[3].seed_hex, 'hex')));
    assert.equal(pending.state, 'pending');
    await problem(await f.raw(1, 'GET', '/quotas'), 403, 'forbidden');
    const next = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 8,
      members: [...initialRoster.payload.members, { key_id: ids[1], public_key: pubs[1], joined_epoch: 8 }] }, keys[2]);
    assert.equal((await f.raw(0, 'PUT', '/roster', next, { epoch: 8 })).status, 200);
    f.epoch = 8;
    assert.equal((await lender.getEnrollment(pending.enrollment_id)).state, 'approved');
    await borrower.refreshRoster();
    const payload = await f.job(borrower);
    const claimPromise = lender.claimNext(ad, { waitSeconds: 30 });
    await eventually(() => f.requests.some(r => r.url.endsWith('/claim-next')), 'long poll did not arrive');
    await delay(30);
    const publishedAt = performance.now();
    const submitted = await borrower.submitJob(payload);
    const claim = await claimPromise;
    assert.ok(performance.now() - publishedAt < 2000, 'new work must wake well before 30s poll maximum');
    assert.equal(claim.job_digest, submitted.jobDigest);
    assert.equal(claim.attempt.holder, ids[1]);
    assert.equal(claim.attempt.execution_started_at, null);
    assert.equal((await borrower.getJob(submitted.jobDigest)).attempts_started, 0);
    const started = await lender.startAttempt(claim.attempt);
    assert.equal(started.execution_started_at, iso(f.now));
    assert.deepEqual(await lender.startAttempt(claim.attempt), started);
    await lender.observeExecutionStart(claim.attempt);
    const observed = await borrower.getJob(submitted.jobDigest);
    assert.equal(observed.attempts_started, 1);
    const attempt = structuredClone(observed.current_attempt);
    f.advance(10);
    const renewed = await lender.renew(claim.attempt);
    assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(claim.attempt.lease_expires_at));
    const outputs = await lender.uploadResultArtifacts({ candidate, transcript });
    const result = { ...structuredClone(vectors.result.payload), ...outputs,
      executor: ids[1], roster_epoch: f.epoch, job_digest: submitted.jobDigest,
      attempt_id: renewed.attempt_id, generation: renewed.generation, submitted_at: iso(f.now),
      receipt: { ...currentReceipt(vectors.result.payload.receipt,selectionForJob(payload,ad)), source: payload.source,
        started_at: iso(start), finished_at: iso(f.now), duration_ms: 10000 } };
    const waiting = borrower.waitForJob(submitted.jobDigest, { timeoutMs: 2000, pollMs: 10 });
    assert.equal((await lender.completeAttempt(renewed, result)).status, 'result-accepted');
    assert.equal((await waiting).state, 'result-accepted');
    assert.deepEqual(await borrower.fetchResult(submitted.jobDigest, { attempt }), candidate);
    assert.deepEqual(await borrower.fetchTranscript(submitted.jobDigest, { attempt }), transcript);
    const before = f.requests.filter(r => r.method === 'PUT').length;
    assert.deepEqual(await borrower.uploadArtifact(candidate, 'text/x-diff'), outputs.candidate);
    assert.equal(f.requests.filter(r => r.method === 'PUT').length, before);
    assert.ok(f.requests.some(r => r.method === 'HEAD'), 'advertised HEAD avoids redundant download');
  });

test('a stopped attempt keeps its original receipt after the job is claimed again', async t => {
  const roster = p.signEnvelope('roster', {...vectors.roster.payload, members: [...vectors.roster.payload.members,
    {key_id: ids[3], public_key: pubs[3], joined_epoch: vectors.roster.payload.epoch}]}, keys[2]);
  const f = await fixture(t, {initialRoster: roster});
  const borrower = f.client(0), lender = f.client(1), replacement = f.client(3);
  const payload = await f.job(borrower, {max_attempts: 1});
  const {jobDigest} = await borrower.submitJob(payload);
  const {attempt} = await lender.claimNext(ad, {waitSeconds: 0});
  await lender.startAttempt(attempt);
  await lender.release(attempt, '{"code":"cleanup_pending"}');
  const route = '/attempts/' + attempt.attempt_id;
  const readAttempt = () => borrower.getAttempt(attempt);
  const before = await readAttempt();
  assert.equal(before.job_digest, jobDigest);
  assert.equal(before.attempt_id, attempt.attempt_id);
  assert.equal(before.generation, attempt.generation);
  assert.equal(before.holder, ids[1]);
  assert.equal(before.state, 'released');
  assert.equal(before.compute_stopped, false);
  assert.equal(before.stopped_at, null);
  assert.equal((await borrower.getJob(jobDigest)).state, 'claimed');

  const stoppedAt = iso(f.now);
  const idempotencyKey = randomUUID();
  const acknowledged = await lender.stopped(attempt, {stoppedAt, idempotencyKey});
  const committed = {...before, compute_stopped: true, stopped_at: stoppedAt};
  assert.deepEqual(acknowledged, committed);
  assert.deepEqual(await readAttempt(), committed);

  const next = await replacement.claimNext(ad, {waitSeconds: 0});
  assert.equal(next.job_digest, jobDigest);
  assert.notEqual(next.attempt.attempt_id, attempt.attempt_id);
  assert.ok(next.attempt.generation > attempt.generation);
  assert.equal((await borrower.getJob(jobDigest)).current_attempt.attempt_id, next.attempt.attempt_id);
  assert.deepEqual(await readAttempt(), committed);
  const {readOriginalStopAttempt}=await import('../packaging/journey/evidence.mjs');
  const device={jobReadClient:async (_circle,digest)=>{
    assert.equal(digest,jobDigest);
    return borrower;
  }};
  const expected={circle:roster.payload.circle,digest:jobDigest,attemptId:attempt.attempt_id,generation:attempt.generation};
  assert.deepEqual(await readOriginalStopAttempt(device,expected), {
    attempt_id:attempt.attempt_id,job_digest:jobDigest,generation:attempt.generation,
    state:'released',compute_stopped:true,stopped_at:stoppedAt,
  });
  assert.equal(await readOriginalStopAttempt(device,{...expected,generation:next.attempt.generation}),null);
  await assert.rejects(borrower.getAttempt({...attempt,generation:next.attempt.generation}), {code:'stale_attempt'});
  await assert.rejects(borrower.getAttempt({...attempt,job_digest:'sha256:'+'f'.repeat(64)}), {code:'wrong_job_digest'});

  f.advance(1);
  assert.deepEqual(await lender.stopped(attempt, {stoppedAt, idempotencyKey}), committed);
  await problem(await f.raw(1, 'POST', route + '/stopped', {
    generation: attempt.generation, stopped_at: iso(f.now),
  }, {idempotencyKey}), 409, 'idempotency_conflict');
  assert.deepEqual(await readAttempt(), committed);
});

test('v1 HTTP errors preserve nonce, membership, conflict and generation fences', async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  const payload = await f.job(borrower), submitted = await borrower.submitJob(payload, { idempotencyKey: 'once' });
  await assert.rejects(borrower.submitJob({ ...payload, intent_id: randomUUID() }, { idempotencyKey: 'once' }),
    e => e.status === 409 && e.code === 'idempotency_conflict');
  const signed = f.signed(0, 'GET', '/quotas');
  assert.equal((await fetch(f.origin + base + '/quotas', signed)).status, 200);
  await problem(await fetch(f.origin + base + '/quotas', signed), 401, 'replay');
  await problem(await f.raw(3, 'GET', '/quotas'), 403, 'forbidden');
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  const route = '/jobs/' + submitted.jobDigest.slice(7) + '/claim';
  await problem(await f.raw(1, 'POST', route, { advertisement: ad, lease_seconds: 120 }), 409, 'conflict');
  await problem(await f.raw(1, 'POST', '/attempts/' + claim.attempt.attempt_id + '/renew',
    { generation: claim.attempt.generation + 1, lease_seconds: 120 }), 409, 'stale_attempt');
  await problem(await f.raw(0, 'GET', '/quotas', undefined, { epoch: 6 }), 409, 'roster_stale');
});

test('submit accepts once when every host response is dropped and a same-key retry reconciles it', async t => {
  const f = await fixture(t), key = 'burst-send-1023', seenKeys = [];
  let dropped = 4;
  const rawFetch = globalThis.fetch;
  const borrower = f.client(0, false, {
    retry:{maxAttempts:4,baseMs:0,capMs:0},
    fetch:async (input, init) => {
      const response = await rawFetch(input, init);
      if (init.method === 'POST' && new URL(input).pathname.endsWith('/jobs')) {
        seenKeys.push(init.headers['Idempotency-Key']);
        if (dropped-- > 0) {
          await response.arrayBuffer();
          throw new TypeError('response dropped after host acceptance');
        }
      }
      return response;
    },
  });
  const payload = await f.job(borrower);
  const unknown = await borrower.submitJob(payload, {idempotencyKey:key}).then(() => null, error => error);

  assert.equal(unknown?.outcome, 'unknown');
  assert.equal(unknown?.operationKey, key);
  assert.equal(seenKeys.length, 4, 'all four accepted/replayed POST responses were dropped');
  assert.deepEqual(seenKeys, Array(4).fill(key), 'every attempt uses the same host idempotency key');

  const reconciled = await f.client(0).submitJob(payload, {idempotencyKey:unknown.operationKey});
  assert.equal(reconciled.jobDigest, p.digest(payload));
  const jobs = [];
  for await (const job of f.client(0).listJobs()) jobs.push(job);
  assert.equal(jobs.length, 1, 'the host stores one job for all retries with this key');
});

test('production SQLite coordinator dedupes a send when all four accepted responses are dropped', {timeout:30000}, async t => {
  const dir=mkdtempSync(join(tmpdir(),'faravan-prod-idem-'));
  const probe=createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port, dbPath=join(dir,'coordinator.sqlite'), blobDir=join(dir,'blobs');
  const now=Math.floor(Date.now()/1000), roster=p.signEnvelope('roster',{...vectors.roster.payload,
    issued_at:iso(now-60),valid_until:iso(now+7*86400)},keys[2]);
  const provisioned=openV1Store({path:dbPath,origin,circle,rootFingerprint:ids[2],initialRoster:roster});
  provisioned.close();
  const coordinator=await startCoordinator({port,v1:{dbPath,blobDir,origin}});
  t.after(async()=>{coordinator.closeAllConnections();await new Promise(resolve=>coordinator.close(resolve));rmSync(dir,{recursive:true,force:true});});

  const key='production-sqlite-send-1023',seenKeys=[];
  let dropped=4;
  const client=createClient({origin,circle,deviceKey:keys[0],pinnedRootFingerprint:ids[2],
    rosterCache:{get:async()=>({current:roster,history:[],highestAcceptedEpoch:roster.payload.epoch,
      highestAcceptedDigest:p.digest(roster.payload)}),set:async()=>{}},
    retry:{maxAttempts:4,baseMs:0,capMs:0},
    fetch:async(input,init)=>{
      const response=await fetch(input,init);
      if(init.method==='POST'&&new URL(input).pathname.endsWith('/jobs')){
        seenKeys.push(init.headers['Idempotency-Key']);
        if(dropped-->0){await response.arrayBuffer();throw new TypeError('response dropped after SQLite commit');}
      }
      return response;
    }});
  const source=await client.uploadArtifact(sourceBytes,'application/gzip');
  const prompt=await client.uploadArtifact(promptBytes,'text/plain');
  const payload={...vectors.job.payload,circle,author:ids[0],roster_epoch:roster.payload.epoch,
    source:{kind:'archive',artifact:source},prompt,intent_id:randomUUID(),created_at:iso(now),expires_at:iso(now+3600)};
  const unknown=await client.submitJob(payload,{idempotencyKey:key}).then(()=>null,error=>error);

  assert.equal(unknown?.outcome,'unknown',JSON.stringify({code:unknown?.code,status:unknown?.status,
    problem:unknown?.problem,seenKeys}));
  assert.equal(unknown?.operationKey,key);
  assert.deepEqual(seenKeys,Array(4).fill(key),'each request reaches the production coordinator with the same key');
  assert.equal((await client.submitJob(payload,{idempotencyKey:unknown.operationKey})).jobDigest,p.digest(payload));
  const jobs=[];for await(const item of client.listJobs())jobs.push(item);
  assert.equal(jobs.length,1,'the production SQLite store returns the original job for a same-key retry');
});

test('ambiguous host submission errors return the same operation key for REST reconciliation', async t => {
  const f=await fixture(t),client=f.client(0),key='host-unknown-key-1023',payload=await f.job(client);
  const signed=p.signEnvelope('job',payload,keys[0]),publish=f.store.publishJob;
  let dropAcknowledgement=true;
  f.store.publishJob=(...args)=>{
    const result=publish(...args);
    if(dropAcknowledgement){dropAcknowledgement=false;throw new p.ProtocolError('internal_error');}
    return result;
  };
  t.after(()=>{f.store.publishJob=publish;});

  const unknown=await f.raw(0,'POST','/jobs',signed,{idempotencyKey:key});
  assert.equal(unknown.status,500);
  const problem=await unknown.json();
  assert.equal(problem.outcome,'unknown');
  assert.equal(problem.operationKey,key);
  f.store.publishJob=publish;
  const replay=await f.raw(0,'POST','/jobs',signed,{idempotencyKey:problem.operationKey});
  assert.equal(replay.status,201);
  assert.equal((await replay.json()).job_digest,p.digest(payload));
  const jobs=[];for await(const job of client.listJobs())jobs.push(job);
  assert.equal(jobs.length,1);
});

test('v1 HTTP HEAD missing blobs is authorized and bodyless', async t => {
  const f = await fixture(t), route = artifactRoute(ref(Buffer.from('missing')));
  const response = await f.raw(0, 'HEAD', route);
  assert.equal(response.status, 404); assert.equal(await response.text(), '');
  assert.equal((await f.raw(3, 'HEAD', route)).status, 403);
});

test('v1 HTTP digest mismatch removes temp/blob data and rolls back reservation/quota', async t => {
  const f = await fixture(t, { quotas: { deviceBytes: 100, circleBytes: 100, maxArtifactBytes: 100, concurrentUploads: 1 } });
  const bytes = Buffer.from('wrong'), expected = ref(Buffer.from('right'));
  await problem(await f.raw(0, 'PUT', artifactRoute(expected), bytes, {
    mediaType: 'text/plain', proof: { body_digest: expected.digest, content_length: bytes.length },
  }), 400, 'digest_mismatch');
  assert.deepEqual(diskFiles(f.blobDir), []);
  const quota = await f.quota();
  assert.equal(quota.device.reserved_bytes, 0); assert.equal(quota.device.uploads, 0);
  assert.equal(quota.device.retained_bytes, 0); assert.equal(quota.circle.retained_bytes, 0);
  const good = await f.client(0).uploadArtifact(Buffer.from('right'), 'text/plain');
  assert.deepEqual(good, expected);
});

test('v1 HTTP rejects oversized declared JSON before any body is sent', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const options = f.signed(0, 'POST', '/jobs', {}, { length: 262145 });
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(f.origin + base + '/jobs', { method: 'POST', headers: options.headers }, resolve);
    req.on('error', reject);
    t.after(() => req.destroy());
    req.flushHeaders(); // Intentionally never send the claimed body.
  });
  assert.equal(response.statusCode, 413); response.resume();
});

test('v1 HTTP aborted upload releases its reservation and removes partial file', { timeout: 5000 }, async t => {
  let wrote, aborted, partialPath;
  const written = new Promise(resolve => { wrote = resolve; });
  const cleaned = new Promise(resolve => { aborted = resolve; });
  const f = await fixture(t, { uploadIO: {
    async open(path, ...args) {
      const file = await openFile(path, ...args);
      if (args[0] === 'wx') {
        partialPath = path;
        const write = file.write.bind(file);
        file.write = async (...values) => {
          const result = await write(...values);
          wrote();
          return result;
        };
      }
      return file;
    },
  } });
  const abort = f.store.abortArtifactUpload;
  f.store.abortArtifactUpload = (...args) => {
    const result = abort(...args);
    aborted();
    return result;
  };
  const bytes = Buffer.alloc(1024, 7), expected = ref(bytes);
  const options = f.signed(0, 'PUT', artifactRoute(expected), bytes, { mediaType: 'text/plain' });
  const req = httpRequest(f.origin + base + artifactRoute(expected), { method: 'PUT', headers: options.headers });
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.write(bytes.subarray(0, 32));
  await written; // Abort only after the consumer has written actual partial bytes.
  assert.equal((await f.quota()).device.reserved_bytes, bytes.length, 'upload must reserve declared bytes');
  assert.deepEqual(readFileSync(partialPath), bytes.subarray(0, 32));
  req.destroy();
  await cleaned; // The server unlinks the partial file before aborting the reservation.
  const quota = await f.quota();
  assert.equal(quota.device.reserved_bytes, 0, 'disconnect leaked reservation');
  assert.equal(quota.device.uploads, 0);
  assert.deepEqual(diskFiles(f.blobDir), []);
});

test('v1 HTTP disconnected long poll cannot claim a later job', { timeout: 5000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  const controller = new AbortController();
  const polling = lender.claimNext(ad, { signal: controller.signal, waitSeconds: 30 });
  const rejected = assert.rejects(polling, e => e.name === 'AbortError' || e.code === 'aborted');
  await eventually(() => f.requests.some(r => r.url.endsWith('/claim-next')), 'long poll did not arrive');
  await eventually(() => f.handler.pendingPolls === 1, 'long poll was not registered');
  controller.abort(); await rejected;
  await eventually(() => f.handler.pendingPolls === 0, 'disconnect leaked a poll listener/timer');
  const submitted = await borrower.submitJob(await f.job(borrower));
  await delay(30);
  assert.equal((await borrower.getJob(submitted.jobDigest)).attempts_started, 0);
  assert.equal((await lender.claimNext(ad, { waitSeconds: 0 })).job_digest, submitted.jobDigest);
});
test('v1 HTTP streamed JSON is capped before end-of-stream, without trusting Content-Length',
  { timeout: 3000 }, async t => {
    const f = await fixture(t, { limits: { maxBodyBytes: 128 } });
    const bytes = Buffer.from(p.canonicalize({ padding: 'x'.repeat(1024) }));
    const options = f.signed(0, 'POST', '/jobs', bytes);
    delete options.headers['Content-Length'];
    options.headers['Transfer-Encoding'] = 'chunked';
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(f.origin + base + '/jobs', { method: 'POST', headers: options.headers }, resolve);
      req.on('error', reject); t.after(() => req.destroy());
      req.write(bytes.subarray(0, 256)); // No end() and no remaining bytes.
    });
    assert.equal(response.statusCode, 413); response.resume();
  });

test('v1 HTTP oversized artifact declaration is rejected before quota allocation or stream read',
  { timeout: 3000 }, async t => {
    const f = await fixture(t, { limits: { maxArtifactBytes: 128 } });
    let reservations = 0;
    const reserve = f.store.reserveArtifact;
    f.store.reserveArtifact = (...args) => { reservations++; return reserve(...args); };
    const bytes = Buffer.alloc(256), expected = ref(bytes);
    const options = f.signed(0, 'PUT', artifactRoute(expected), bytes, { mediaType: 'text/plain' });
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(f.origin + base + artifactRoute(expected),
        { method: 'PUT', headers: options.headers }, resolve);
      req.on('error', reject); t.after(() => req.destroy()); req.flushHeaders();
    });
    assert.equal(response.statusCode, 413); response.resume();
    assert.equal(reservations, 0);
    assert.deepEqual(diskFiles(f.blobDir), []);
    assert.equal((await f.quota()).device.reserved_bytes, 0);
  });

test('v1 coordinator mount authenticates proofs and ignores bearer credentials', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-mount-'));
  const origin = 'https://coordinator.example', dbPath = join(dir, 'v1.sqlite');
  const now = Math.floor(Date.now() / 1000);
  const roster = p.signEnvelope('roster', { ...vectors.roster.payload,
    issued_at: iso(now - 1), valid_until: iso(now + 86400) }, keys[2]);
  const provisioned = openV1Store({ path: dbPath, origin, circle, rootFingerprint: ids[2],
    initialRoster: roster });
  provisioned.close();
  const server = await startCoordinator({ port: 0,
    v1: { dbPath, blobDir: join(dir, 'v1-blobs'), origin } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const bound = 'http://127.0.0.1:' + server.address().port;
  const bearer = { authorization: 'Bearer test-only-v0-token' };
  assert.equal((await fetch(bound + '/roster', { headers: bearer })).status, 404);
  await problem(await fetch(bound + base + '/capabilities', { headers: bearer }), 401, 'unauthenticated');
  const proof = p.buildRequestProof({ circle, roster_epoch: 7, method: 'GET',
    target: origin + base + '/capabilities', body: Buffer.alloc(0), content_type: '',
    artifact_media_type: '', idempotency_key: '', created: now,
    nonce: randomBytes(24).toString('base64url') }, keys[0]);
  const response = await fetch(bound + base + '/capabilities', { headers: {
    'Faravan-Proof': proof, host: 'untrusted.example', 'x-forwarded-host': 'untrusted.example' } });
  assert.equal(response.status, 200);
  assert.equal((await fetch(bound + '/roster', { headers: { 'Faravan-Proof': proof } })).status, 404);
});


test('v1 local CLI provisions an epoch-one circle without network enrollment or v0 credentials',
  { timeout: 5000 }, t => {
    const home = mkdtempSync(join(tmpdir(), 'faravan-v1-provision-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const now = Math.floor(Date.now() / 1000), origin = 'https://coordinator.example';
    const roster = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 1,
      issued_at: iso(now - 1), valid_until: iso(now + 86400),
      members: vectors.roster.payload.members.map(m => ({ ...m, joined_epoch: 1 })) }, keys[2]);
    const provisioning = { circle_id: circle, origin, root_fingerprint: ids[2], roster };
    const input = join(home, 'provision.json');
    // Pretty-printed on purpose: the CLI must accept a non-canonical file.
    const pretty = JSON.stringify(provisioning, null, 2);
    assert.notEqual(pretty, p.canonicalize(provisioning));
    assert.throws(() => p.strictParse(pretty), /noncanonical/);
    writeFileSync(input, pretty, { mode: 0o600 });
    const args = [new URL('../bin/faravan-coordinator', import.meta.url).pathname, '--v1-provision', input];
    const env = { PATH: process.env.PATH, HOME: home, FARAVAN_COORDINATOR_HOME: home };
    execFileSync(process.execPath, args, { env, timeout: 3000, stdio: 'pipe' });
    const path = join(home, 'v1', 'coordinator.sqlite');
    assert.equal(existsSync(path), true);
    const store = openV1Store({ path, origin, circle, rootFingerprint: ids[2] });
    assert.equal(store.configuration().epoch, 1); store.close();
    // Provisioning is one-shot: a second invocation may not replace an existing circle.
    assert.throws(() => execFileSync(process.execPath, args, { env, timeout: 3000, stdio: 'pipe' }));
    const unchanged = openV1Store({ path, origin, circle, rootFingerprint: ids[2] });
    assert.equal(unchanged.configuration().epoch, 1); unchanged.close();
  });


for (const lanMode of [false, true]) {
  test('generated offline circle provisioning file is accepted by the local CLI (' +
    (lanMode ? 'LAN' : 'HTTPS') + ')', { timeout: 5000 }, async t => {
    const { openDevice } = await import('../lib/v1/device.mjs');
    const home = mkdtempSync(join(tmpdir(), 'faravan-generated-provision-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const device = await openDevice({ home: join(home, 'device'), origin: null, ensureDefault: false,
      fetch: async () => { throw new Error('test must not use network'); } });
    const origin = lanMode ? 'http://test-only.local:8787' : 'https://coordinator.example';
    const created = await device.createCircle(origin, { name: 'Test-only offline circle',
      publish: false, lanMode });
    const json = readFileSync(created.provisioningPath, 'utf8');
    const serverHome = join(home, 'server');
    const args = [new URL('../bin/faravan-coordinator', import.meta.url).pathname,
      '--v1-provision', created.provisioningPath];
    const env = { PATH: process.env.PATH, HOME: home, FARAVAN_COORDINATOR_HOME: serverHome };
    const result = JSON.parse(execFileSync(process.execPath, args, { env, timeout: 3000, encoding: 'utf8' }));
    assert.equal(result.status, 'provisioned');
    assert.equal(result.circle_id, created.id);
    const store = openV1Store({ path: join(serverHome, 'v1', 'coordinator.sqlite'),
      circle: created.id, origin, rootFingerprint: created.pinnedRootFingerprint });
    try { assert.equal(store.configuration().lanMode, lanMode); } finally { store.close(); }
  });
}

test('v1 unprovisioned circle returns explicit 404 without creating a network-provisioned store', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-empty-')), dbPath = join(dir, 'absent.sqlite');
  const server = await startCoordinator({ port: 0,
    v1: { dbPath, blobDir: join(dir, 'blobs'), origin: 'https://coordinator.example' } });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const bound = 'http://127.0.0.1:' + server.address().port;
  await problem(await fetch(bound + base + '/capabilities'), 404, 'circle_not_provisioned');
  await problem(await fetch(bound + base + '/roster', { method: 'PUT', headers: {
    'Content-Type': 'application/json' }, body: p.canonicalize(vectors.roster) }), 404, 'circle_not_provisioned');
  assert.equal(existsSync(dbPath), false, 'HTTP must never allocate an initial circle');
  assert.equal((await fetch(bound + '/roster', { headers: {
    authorization: 'Bearer test-only-v0-token' } })).status, 404);
});


test('v1 unknown circle returns circle_not_provisioned without disclosing configured membership', async t => {
  const f = await fixture(t);
  const other = '/v1/circles/99999999-9999-4999-8999-999999999999/capabilities';
  await problem(await fetch(f.origin + other), 404, 'circle_not_provisioned');
});

test('v1 long-poll timeout retains a no-work acknowledgement even after later publication',
  { timeout: 5000 }, async t => {
    let now = 0, nextTimer = 0, scheduled;
    const timers = new Map();
    const opened = new Promise(resolve => { scheduled = resolve; });
    const pollTiming = {
      now: () => now,
      setTimeout(wake, ms) {
        const id = ++nextTimer;
        timers.set(id, { wake, due: now + ms });
        scheduled();
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    };
    const f = await fixture(t, { pollTiming }), borrower = f.client(0), lender = f.client(1);
    const idempotencyKey = 'empty-poll-replay', body = {
      advertisement: ad, lease_seconds: 120, wait_seconds: 1,
    };
    const pending = f.raw(1, 'POST', '/jobs/claim-next', body, { idempotencyKey });
    await opened;
    assert.equal(f.handler.pendingPolls, 1);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].due, 1000, 'poll must schedule its requested duration');
    now = 999;
    [...timers.values()][0].wake(); // An early wake must not finalize the no-work acknowledgement.
    assert.equal(f.handler.pendingPolls, 1, 'a no-work poll must wait for its requested duration');
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].due, 1000);
    now = 1000;
    [...timers.values()][0].wake();
    assert.equal(f.handler.pendingPolls, 0, 'poll must finish at its requested deadline');
    assert.equal(timers.size, 0);
    const first = await pending;
    assert.equal(first.status, 204); assert.equal(await first.text(), '');
    assert.equal(f.handler.pendingPolls, 0);
    const submitted = await borrower.submitJob(await f.job(borrower));
    const timersBeforeReplay = nextTimer;
    const replay = await f.raw(1, 'POST', '/jobs/claim-next', body, { idempotencyKey });
    assert.equal(replay.status, 204); assert.equal(await replay.text(), '');
    assert.equal(nextTimer, timersBeforeReplay, 'retained no-work replay must not schedule another wait');
    assert.equal(timers.size, 0);
    assert.equal(f.handler.pendingPolls, 0);
    assert.equal((await borrower.getJob(submitted.jobDigest)).attempts_started, 0);
    assert.equal((await lender.claimNext(ad, { waitSeconds: 0 })).job_digest, submitted.jobDigest);
  });


for (const terminal of ['end', 'aborted']) {
  for (const lateError of [false, true]) {
    test('v1 stream ' + terminal + ' awaits final write ' + (lateError ? 'rejection' : 'completion'),
      { timeout: 3000 }, async () => {
        const request = Object.assign(new EventEmitter(), { pause() {}, resume() {} });
        let enter, release, rejectWrite, outcome = 'pending';
        const entered = new Promise(resolve => { enter = resolve; });
        const write = new Promise((resolve, reject) => { release = resolve; rejectWrite = reject; });
        const pending = consumeRequest(request, 100, async chunk => {
          assert.equal(chunk.toString(), 'last'); enter(); await write;
        }, 1000);
        const observed = pending.then(value => { outcome = 'resolved'; return { value }; },
          error => { outcome = 'rejected'; return { error }; });
        request.emit('data', Buffer.from('last')); await entered;
        request.emit(terminal); await tick();
        assert.equal(outcome, 'pending', 'terminal stream event cannot outrun final async file write');
        const writeError = new Error('test-only final write failure');
        if (lateError) rejectWrite(writeError); else release();
        const result = await observed;
        if (lateError) assert.equal(result.error, writeError, 'late file errors must never become success');
        else if (terminal === 'end') assert.equal(result.value, 4);
        else assert.equal(result.error.code, 'invalid_request');
        for (const event of ['data', 'end', 'error', 'aborted']) assert.equal(request.listenerCount(event), 0);
      });
  }
}

test('v1 HTTP owner SIGKILL permits restart while a live owner still blocks recovery', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.handler.close();
  const script = `
    const { openV1Store } = await import(${JSON.stringify(new URL('../lib/v1/store.mjs', import.meta.url).href)});
    const { createV1Handler } = await import(${JSON.stringify(new URL('../lib/v1/server.mjs', import.meta.url).href)});
    const { createServer } = await import('node:http');
    const store = openV1Store({path:${JSON.stringify(join(f.dir, 'store.sqlite'))},clock:()=>${f.now}});
    const handler = createV1Handler({store,blobDir:${JSON.stringify(f.blobDir)},clock:()=>${f.now}});
    createServer(handler).listen(0,'127.0.0.1',()=>process.stdout.write('ready\\n'));
  `;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', code => reject(new Error('child did not become ready: ' + code + ' ' + stderr)));
    child.once('error', reject);
  });
  assert.throws(() => createV1Handler({store:f.store,blobDir:f.blobDir,clock:()=>f.now}), e => e.code === 'conflict');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const pendingPath = join(f.blobDir, '.upload-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  writeFileSync(pendingPath, 'crash-left temporary bytes');
  const recovered = createV1Handler({store:f.store,blobDir:f.blobDir,clock:()=>f.now});
  try {
    assert.equal(existsSync(pendingPath), false, 'dead-owner recovery must remove transport temporary files');
    assert.throws(() => createV1Handler({store:f.store,blobDir:f.blobDir,clock:()=>f.now}), e => e.code === 'conflict');
  } finally { recovered.close(); }
});

test('v1 existing owner lock fails closed without deleting recovery data or a replacement lock', async t => {
  const f = await fixture(t), lockPath = f.blobDir + '.http-owner';
  const activeToken = readdirSync(lockPath + '.owners-v1');
  assert.throws(() => createV1Handler({ store: f.store, blobDir: f.blobDir + '/', clock: () => f.now }),
    error => error.code === 'conflict', 'trailing-slash aliases must share the same ownership lock');
  assert.deepEqual(readdirSync(lockPath + '.owners-v1'), activeToken);
  f.handler.close();
  const stale = '2147483647:test-only-stale-owner';
  writeFileSync(lockPath, stale);
  const pendingPath = join(f.blobDir, '.upload-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  writeFileSync(pendingPath, 'test-only pending bytes');
  let recoveries = 0;
  const recover = f.store.recoverTransportUploads;
  f.store.recoverTransportUploads = (...args) => { recoveries++; return recover(...args); };
  assert.throws(() => createV1Handler({ store: f.store, blobDir: f.blobDir, clock: () => f.now }),
    error => error.code === 'conflict');
  assert.equal(recoveries, 0, 'a contender may not recover another owner reservations');
  assert.equal(readFileSync(lockPath, 'utf8'), stale);
  assert.equal(readFileSync(pendingPath, 'utf8'), 'test-only pending bytes');
  f.handler.close();
  assert.equal(readFileSync(lockPath, 'utf8'), stale, 'old handler close must not remove another token');
});

function currentInitialRoster(origin, lanMode = false) {
  const now = Math.floor(Date.now() / 1000);
  return p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 1,
    coordinator: origin, ...(lanMode ? { lan_mode: true } : {}),
    issued_at: iso(now - 1), valid_until: iso(now + 86400),
    members: vectors.roster.payload.members.map(member => ({ ...member, joined_epoch: 1 })) }, keys[2]);
}

test('v1-only starts without v0 settings, exposes no legacy routes, and picks up local provisioning', async t => {
  const { provisionV1Store } = await import('../lib/v1/store.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-only-'));
  const dataDir = join(dir, 'v0'), dbPath = join(dir, 'v1.sqlite');
  const origin = 'https://coordinator.example';
  const server = await startCoordinator({ dataDir, port: 0,
    v1: { dbPath, blobDir: join(dir, 'blobs'), origin } });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const bound = 'http://127.0.0.1:' + server.address().port;
  await problem(await fetch(bound + base + '/capabilities'), 404, 'circle_not_provisioned');
  assert.equal(existsSync(dbPath), false);
  for (const route of ['/', '/tasks', '/tasks/next', '/requests', '/activity', '/roster',
    '/artifacts/' + 'a'.repeat(64)]) {
    for (const headers of [{}, { authorization: 'Bearer test-only-ignored' }]) {
      const response = await fetch(bound + route, { headers });
      assert.equal(response.status, 404, route);
      assert.deepEqual(await response.json(), { error: 'not found' });
    }
  }
  assert.equal(existsSync(join(dataDir, 'coordinator.sqlite')), false, 'no legacy database');
  provisionV1Store({ path: dbPath, provisioning: {
    circle_id: circle, origin, root_fingerprint: ids[2], roster: currentInitialRoster(origin),
  } });
  const proof = p.buildRequestProof({ circle, roster_epoch: 1, method: 'GET',
    target: origin + base + '/capabilities', body: Buffer.alloc(0), content_type: '',
    artifact_media_type: '', idempotency_key: '', created: Math.floor(Date.now() / 1000),
    nonce: randomBytes(24).toString('base64url') }, keys[0]);
  const response = await fetch(bound + base + '/capabilities', { headers: { 'Faravan-Proof': proof } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).circle, circle);
  await problem(await fetch(bound + base + '/capabilities',
    { headers: { 'Faravan-Proof': proof } }), 401, 'replay');
});

test('v1-only rejects incomplete legacy credentials and public HTTP origins', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { dataDir: dir, port: 0, v1: {
    dbPath: join(dir, 'absent.sqlite'), blobDir: join(dir, 'blobs'), origin: 'https://coordinator.example',
  } };
  await assert.rejects(startCoordinator({ ...options, token: 'test-only' }), /roster/);
  await assert.rejects(startCoordinator({ ...options, roster: new Map([['key', 'test-only']]) }), /token/);
  await assert.rejects(startCoordinator({ ...options, v1: { ...options.v1, origin: 'http://example.com' } }), /origin/);
  assert.equal(existsSync(join(dir, 'coordinator.sqlite')), false);
});

test('LAN provisioning requires signed opt-in and exact origin and persists across reopen', async t => {
  const { provisionV1Store } = await import('../lib/v1/store.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-lan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = 'http://10.23.50.10:8787';
  const signed = currentInitialRoster(origin, true);
  const provisioning = { circle_id: circle, origin, root_fingerprint: ids[2],
    lan_mode: true, roster: signed };
  for (const [name, invalid] of [
    ['unsigned-flag', { ...provisioning, roster: currentInitialRoster('https://coordinator.example') }],
    ['missing-flag', { ...provisioning, lan_mode: false }],
    ['other-origin', { ...provisioning, origin: 'http://10.23.50.11:8787' }],
    ['public-http', { ...provisioning, origin: 'http://example.com' }],
  ]) {
    const path = join(dir, name + '.sqlite');
    assert.throws(() => provisionV1Store({ path, provisioning: invalid }));
    assert.equal(existsSync(path), false, name + ' must fail before creating store');
  }
  const path = join(dir, 'valid.sqlite');
  provisionV1Store({ path, provisioning });
  const store = openV1Store({ path, origin });
  assert.equal(store.configuration().lanMode, true);
  assert.equal(store.configuration().origin, origin);
  store.close();
  assert.throws(() => openV1Store({ path, origin, lanMode: false }), error => error.code === 'conflict');
});

test('LAN server still verifies signatures and rejects request replay over loopback transport', async t => {
  const { provisionV1Store } = await import('../lib/v1/store.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-lan-http-'));
  const origin = 'http://test-only.local:8787', dbPath = join(dir, 'v1.sqlite');
  provisionV1Store({ path: dbPath, provisioning: { circle_id: circle, origin,
    root_fingerprint: ids[2], lan_mode: true, roster: currentInitialRoster(origin, true) } });
  const server = await startCoordinator({ dataDir: join(dir, 'unused-v0'), port: 0,
    v1: { dbPath, blobDir: join(dir, 'blobs'), origin } });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const bound = 'http://127.0.0.1:' + server.address().port + base + '/capabilities';
  await problem(await fetch(bound), 401, 'unauthenticated');
  const proof = p.buildRequestProof({ circle, roster_epoch: 1, method: 'GET',
    target: origin + base + '/capabilities', body: Buffer.alloc(0), content_type: '',
    artifact_media_type: '', idempotency_key: '', created: Math.floor(Date.now() / 1000),
    nonce: randomBytes(24).toString('base64url') }, keys[0], { lanMode: true });
  assert.equal((await fetch(bound, { headers: { 'Faravan-Proof': proof } })).status, 200);
  await problem(await fetch(bound, { headers: { 'Faravan-Proof': proof } }), 401, 'replay');

  // Exercise JSON preflight too: LAN metadata must not become an unexpected
  // field in the independently constructed request-proof expectations.
  const now = Math.floor(Date.now() / 1000);
  const send = (method, route, value, keyIndex = 0, epoch = 1) => {
    const body = Buffer.from(p.canonicalize(value));
    const idempotency = method === 'POST' ? randomUUID() : '';
    const proof = p.buildRequestProof({ circle, roster_epoch: epoch, method,
      target: origin + base + route, body, content_type: 'application/json',
      artifact_media_type: '', idempotency_key: idempotency, created: now,
      nonce: randomBytes(24).toString('base64url') }, keys[keyIndex], { lanMode: true });
    return fetch('http://127.0.0.1:' + server.address().port + base + route, {
      method, body, headers: { 'Content-Type': 'application/json', 'Faravan-Proof': proof,
        ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
    });
  };
  const initial = currentInitialRoster(origin, true);
  const updated = p.signEnvelope('roster', { ...initial.payload, epoch: 2 }, keys[2]);
  assert.equal((await send('PUT', '/roster', updated, 0, 2)).status, 200);
  const invite = p.createInvite({ circle, coordinator: origin, invite_id: randomUUID(),
    invite_public_key: pubs[3], created_at: iso(now), expires_at: iso(now + 3600),
    lan_mode: true, display_name: 'Test-only LAN circle' }, keys[2]);
  assert.equal((await send('POST', '/invites', invite, 0, 2)).status, 200);
  const enrollment = { invite, device_public_key: pubs[3],
    enrollment_proof: p.createEnrollmentProof({ circle, invite_id: invite.payload.invite_id,
      device_public_key: pubs[3] }, keys[3]) };
  assert.equal((await send('POST', '/enrollments', enrollment, 3, 0)).status, 202);
});

for (const managed of [false, true]) {
  test('v1 coordinator CLI starts without v0 credentials (' + (managed ? 'host config' : 'environment') + ')',
    { timeout: 5000 }, async t => {
      const { spawn } = await import('node:child_process');
      const home = mkdtempSync(join(tmpdir(), 'faravan-v1-cli-server-'));
      const origin = 'https://coordinator.example';
      const env = { PATH: process.env.PATH, HOME: home, FARAVAN_COORDINATOR_HOME: home,
        FARAVAN_COORDINATOR_PORT: '0' };
      const args = [new URL('../bin/faravan-coordinator', import.meta.url).pathname];
      if (managed) {
        const configFile = join(home, 'host.json');
        writeFileSync(configFile, JSON.stringify({ protocol_version: 1, port: 0,
          v1_origin: origin, data_dir: join(home, 'tasks'), status_path: join(home, 'status.json'),
          reachability: { kind: 'url', publicUrl: origin } }), { mode: 0o600 });
        args.push('--host-config', configFile);
      } else {
        env.FARAVAN_COORDINATOR_V1 = '1'; env.FARAVAN_COORDINATOR_V1_ORIGIN = origin;
      }
      const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
        }
        rmSync(home, { recursive: true, force: true });
      });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      const status = await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('\n')) {
            try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
          }
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error('CLI exited: ' + code + ' ' + stderr)));
      });
      assert.equal(status.status, 'listening');
      assert.equal(status.protocol_version, 1);
      assert.equal(status.pid, child.pid);
      assert.ok(status.port > 0);
      const bound = 'http://127.0.0.1:' + status.port;
      await problem(await fetch(bound + base + '/capabilities'), 404, 'circle_not_provisioned');
      assert.equal((await fetch(bound + '/roster')).status, 404);
      assert.equal(existsSync(join(home, 'tasks', 'coordinator.sqlite')), false);
    });
}

test('v1 HTTP idempotency conflicts precede endpoint body validation and consume the nonce', async t => {
  const f = await fixture(t), client = f.client(0), idempotencyKey = 'cross-endpoint-validation';
  const job = p.signEnvelope('job', await f.job(client), keys[0]);
  const published = await f.raw(0, 'POST', '/jobs', job, { idempotencyKey });
  assert.equal(published.status, 201); const original = await published.json();
  const attempt = '/attempts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const [route, body] of [
    [attempt + '/start', { generation: 1, extra: true }],
    [attempt + '/complete', { payload: { attempt_id: 'wrong' } }],
    ['/jobs/' + 'a'.repeat(64) + '/cancel', { payload: { job_digest: 'wrong' } }],
    ['/jobs/claim-next', { advertisement: ad, wait_seconds: null }],
    ['/invites', { code: 'bad', envelope: null }],
    ['/enrollments', { extra: true }],
  ]) {
    const signed = f.signed(0, 'POST', route, body, { idempotencyKey });
    await problem(await fetch(f.origin + base + route, signed), 409, 'idempotency_conflict');
    await problem(await fetch(f.origin + base + route, signed), 401, 'replay');
  }
  const retry = await f.raw(0, 'POST', '/jobs', job, { idempotencyKey });
  assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), original);
  const invalid = f.signed(0, 'POST', attempt + '/start', { generation: 1, extra: true });
  await problem(await fetch(f.origin + base + attempt + '/start', invalid), 400, 'invalid_request');
  await problem(await fetch(f.origin + base + attempt + '/start', invalid), 401, 'replay');
});

test('v1 HTTP null optional durations are invalid while omitted durations still default', async t => {
  const f = await fixture(t), borrower = f.client(0);
  const job = p.signEnvelope('job', await f.job(borrower), keys[0]);
  assert.equal((await f.raw(0, 'POST', '/jobs', job)).status, 201);
  const claimRoute = '/jobs/' + p.digest(job.payload).slice(7) + '/claim';
  for (const route of [claimRoute, '/jobs/claim-next']) {
    for (const field of ['lease_seconds', 'wait_seconds']) {
      await problem(await f.raw(1, 'POST', route, { advertisement: ad, [field]: null }), 400, 'invalid_request');
    }
  }
  await f.client(1).heartbeat(accountHeartbeat(ad));
  const claimed = await f.raw(1, 'POST', claimRoute, { advertisement: ad });
  assert.equal(claimed.status, 200); const { attempt } = await claimed.json();
  assert.equal(Date.parse(attempt.lease_expires_at) / 1000 - f.now, 120);
  const route = '/attempts/' + attempt.attempt_id + '/renew';
  await problem(await f.raw(1, 'POST', route, { generation: attempt.generation, lease_seconds: null }), 400, 'invalid_request');
  assert.equal((await f.raw(1, 'POST', route, { generation: attempt.generation })).status, 200);
});

test('v1 HTTP bad invite bindings return invalid_request for signature and key mismatch', async t => {
  const f = await fixture(t);
  const invite = p.createInvite({ circle, coordinator: f.origin, invite_id: randomUUID(),
    invite_public_key: pubs[3], created_at: iso(f.now), expires_at: iso(f.now + 3600) }, keys[2]);
  const binding = p.createInviteBinding(invite, keys[3]);
  const value = Buffer.from(binding.value, 'base64url'); value[32] ^= 1;
  for (const invalid of [{ ...binding, value: value.toString('base64url') }, { ...binding, key_id: ids[0] }]) {
    await problem(await f.raw(0, 'POST', '/invites', { code: 'abcdefghij', envelope: invite, invite_binding: invalid }),
      400, 'invalid_request');
  }
  assert.equal((await f.raw(0, 'POST', '/invites', { code: 'abcdefghij', envelope: invite, invite_binding: binding })).status, 200);
});

test('v1 HTTP unknown artifact commit outcome keeps installed bytes for reconciliation', async t => {
  const f = await fixture(t), bytes = Buffer.from('test-only uncertain commit'), artifact = ref(bytes);
  const finish = f.store.finishArtifactUpload;
  f.store.finishArtifactUpload = (...args) => {
    finish(...args);
    throw new p.ProtocolError('internal_error'); // Commit succeeded, acknowledgement was lost.
  };
  t.after(() => { f.store.finishArtifactUpload = finish; });
  const response = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(response.status, 500);
  const value = await response.json(); assert.equal(value.code, 'internal_error'); assert.equal(value.outcome, 'unknown');
  assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes);
  const retrieved = await f.raw(0, 'GET', artifactRoute(artifact));
  assert.equal(retrieved.status, 200); assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), bytes);
});

test('v1 HTTP response byte limits bound pages and reject oversized control replies', async t => {
  const f = await fixture(t), borrower = f.client(0);
  const requirements = { ...vectors.job.payload.requirements,
    harness: Array.from({ length: 36 }, (_, i) => i + 'é'.repeat(2040)) };
  for (let i = 0; i < 2; i++) {
    const job = p.signEnvelope('job', await f.job(borrower, { requirements }), keys[0]);
    assert.equal((await f.raw(0, 'POST', '/jobs', job)).status, 201);
  }
  const page = await f.raw(0, 'GET', '/jobs?limit=100'); assert.equal(page.status, 200);
  const bytes = Buffer.from(await page.arrayBuffer()); assert.ok(bytes.length <= 262144);
  const value = JSON.parse(bytes); assert.equal(value.items.length, 1); assert.ok(value.next_cursor);
  const quotas = await f.quota();
  assert.deepEqual(Object.keys(quotas.limits).sort(), ['circleBytes', 'concurrentUploads', 'deviceBytes', 'maxArtifactBytes']);
  f.store.getQuotas = () => ({ padding: 'é'.repeat(140000) });
  await problem(await f.raw(0, 'GET', '/quotas'), 413, 'payload_too_large');
});

test('v1 HTTP encoded endpoint conflicts authenticate and consume the nonce first', async t => {
  const f = await fixture(t), idempotencyKey = 'encoded-endpoint-conflict';
  const job = p.signEnvelope('job', await f.job(f.client(0)), keys[0]);
  assert.equal((await f.raw(0, 'POST', '/jobs', job, { idempotencyKey })).status, 201);
  const signed = f.signed(0, 'POST', '/%78', {}, { idempotencyKey });
  await problem(await fetch(f.origin + base + '/%78', signed), 409, 'idempotency_conflict');
  await problem(await fetch(f.origin + base + '/%78', signed), 401, 'replay');
  const fresh = f.signed(0, 'POST', '/%78', {});
  await problem(await fetch(f.origin + base + '/%78', fresh), 400, 'invalid_request');
  await problem(await fetch(f.origin + base + '/%78', fresh), 401, 'replay');
});

test('v1 HTTP restart removes uncommitted installed bytes before releasing their charge', async t => {
  const bytes = Buffer.from('test-only rollback after installed artifact'), artifact = ref(bytes);
  const f = await fixture(t, { quotas: {
    deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1,
  } });
  const finish = f.store.finishArtifactUpload;
  f.store.finishArtifactUpload = (device, id, actual, install, ownerToken, options) =>
    finish(device, id, actual, () => { install(); throw new Error('test-only post-rename failure'); }, ownerToken, options);
  const response = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(response.status, 500); assert.equal((await response.json()).outcome, 'unknown');
  assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes,
    'the injected failure must occur after permanent installation');
  f.store.finishArtifactUpload = finish;
  assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes);
  let quotas = await f.quota();
  assert.equal(quotas.circle.reserved_bytes, bytes.length);
  assert.equal(quotas.circle.retained_bytes, 0);
  assert.equal(quotas.circle.uploads, 1);
  f.restartHandler();
  quotas = await f.quota();
  assert.equal(quotas.circle.reserved_bytes, 0, 'restart reclaims the abandoned reservation');
  assert.equal(existsSync(join(f.blobDir, artifact.digest.slice(7))),false);
  const retried = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(retried.status, 200); assert.deepEqual(await retried.json(), artifact);
  quotas = await f.quota();
  assert.equal(quotas.circle.reserved_bytes, 0);
  assert.equal(quotas.circle.uploads, 0);
  assert.equal(quotas.circle.retained_bytes, bytes.length);
  const retrieved = await f.raw(0, 'GET', artifactRoute(artifact));
  assert.equal(retrieved.status, 200); assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), bytes);
});

test('v1 HTTP rename failure cannot expose an upload still awaiting cleanup to retry', { timeout: 5000 }, async t => {
  const bytes = Buffer.from('test-only unwinding upload'), artifact = ref(bytes);
  let cleanupStarted, releaseCleanup, unlinkCount = 0;
  const started = new Promise(resolve => { cleanupStarted = resolve; });
  const gate = new Promise(resolve => { releaseCleanup = resolve; });
  t.after(() => releaseCleanup());
  const f = await fixture(t, { quotas: { deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1 },
    uploadIO: {
      renameSync() { throw new Error('test-only rename failure'); },
      async unlink(path) {
        if (++unlinkCount === 1) { cleanupStarted(); await gate; }
        return unlinkFile(path);
      },
    },
  });
  const first = f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  await started;
  try {
    await problem(await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type }),
      429, 'quota_exceeded');
    assert.equal((await f.quota()).circle.reserved_bytes, bytes.length);
    assert.equal(readdirSync(f.blobDir).filter(name => name.startsWith('.upload-')).length, 1);
  } finally { releaseCleanup(); }
  assert.equal((await first).status, 500);
});

test('v1 HTTP failed temporary unlink stays charged until maintenance cleanup succeeds', async t => {
  for (const failure of ['write', 'sync']) await t.test(failure, async t => {
    const bytes = Buffer.from('test-only failed temporary cleanup'), artifact = ref(bytes);
    let failCleanup = true, cleanupAttempts = 0;
    const f = await fixture(t, { quotas: { deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1 },
      uploadIO: {
        async open(...args) {
          const file = await openFile(...args), original = file[failure].bind(file);
          file[failure] = async (...values) => {
            await original(...values);
            throw new Error('test-only ' + failure + ' failure after bytes reached disk');
          };
          return file;
        },
        async unlink(path) {
          cleanupAttempts++;
          if (failCleanup) throw new Error('test-only temporary unlink failure');
          return unlinkFile(path);
        },
        unlinkSync(path) {
          cleanupAttempts++;
          if (failCleanup) throw new Error('test-only maintenance unlink failure');
          rmSync(path);
        },
      },
    });
    const response = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).outcome, 'unknown');
    const temporary = readdirSync(f.blobDir).filter(name => name.startsWith('.upload-'));
    assert.equal(temporary.length, 1);
    assert.deepEqual(readFileSync(join(f.blobDir, temporary[0])), bytes);
    assert.deepEqual((await f.quota()).circle, { retained_bytes: 0, reserved_bytes: bytes.length, uploads: 1 });
    await problem(await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type }),
      429, 'quota_exceeded');
    assert.ok(cleanupAttempts >= 2, 'ordinary maintenance retries failed cleanup');
    failCleanup = false;
    assert.deepEqual((await f.quota()).circle, { retained_bytes: 0, reserved_bytes: 0, uploads: 0 });
    assert.equal(existsSync(join(f.blobDir, temporary[0])), false);
  });
});

test('v1 HTTP uncertain retry verifies a blob whose restart cleanup failed without a second charged copy', { timeout: 5000 }, async t => {
  const bytes = Buffer.from('test-only no second copy during retry'), artifact = ref(bytes);
  let retrying = false, entered, release, request, temporaryOpens = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); request?.destroy(); });
  const f = await fixture(t, { quotas: {
    deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1,
  }, uploadIO: {
    unlinkSync(path) {
      if(String(path).endsWith(artifact.digest.slice(7)))throw Object.assign(new Error('injected cleanup failure'),{code:'EACCES'});
      return unlinkSync(path);
    },
    async open(path, flags, ...rest) {
      const file = await openFile(path, flags, ...rest);
      if (retrying) {
        if (flags === 'r') { entered(); await gate; }
        else {
          temporaryOpens++;
          const write = file.write.bind(file);
          file.write = async (...args) => {
            const result = await write(...args);
            entered(); await gate; return result;
          };
        }
      }
      return file;
    },
  } });
  const finish = f.store.finishArtifactUpload;
  f.store.finishArtifactUpload = (device, id, actual, install, ownerToken, options) =>
    finish(device, id, actual, () => { install(); throw new Error('test-only post-rename failure'); }, ownerToken, options);
  const first = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(first.status, 500); assert.equal((await first.json()).outcome, 'unknown');
  assert.deepEqual(readdirSync(f.blobDir), [artifact.digest.slice(7)], 'the injected failure must occur after permanent installation');
  f.store.finishArtifactUpload = finish;
  f.restartHandler();
  retrying = true;
  const signed = f.signed(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  const response = new Promise(resolve => {
    request = httpRequest(f.origin + base + artifactRoute(artifact),
      { method: 'PUT', headers: signed.headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      });
    request.on('error', error => resolve({ error }));
    // Never complete the body: reconciliation must succeed using the installed blob alone.
    request.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
  });
  await started;
  try {
    const quota = await f.quota();
    assert.deepEqual(quota.circle, { retained_bytes: 0, reserved_bytes: bytes.length, uploads: 1 });
    assert.deepEqual(quota.device, quota.circle);
    const files = readdirSync(f.blobDir);
    const diskBytes = files.reduce((sum, name) => sum + readFileSync(join(f.blobDir, name)).length, 0);
    assert.equal(diskBytes, quota.circle.retained_bytes + quota.circle.reserved_bytes,
      'every byte on disk during retry must remain charged');
    assert.deepEqual(files, [artifact.digest.slice(7)], 'retry must not create a second temporary copy');
    assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes);
    release();
    const retried = await response;
    assert.equal(retried.status, 200); assert.deepEqual(JSON.parse(retried.body), artifact);
    assert.equal(temporaryOpens, 0);
    assert.deepEqual((await f.quota()).circle, { retained_bytes: bytes.length, reserved_bytes: 0, uploads: 0 });
  } finally { release(); request.destroy(); }
});

test('v1 HTTP uncertain retry rejects wrong size or SHA-256 without streaming', async t => {
  for (const corruption of ['size', 'digest']) await t.test(corruption, async t => {
    const bytes = Buffer.from('test-only verify existing bytes'), artifact = ref(bytes);
    let temporaryOpens = 0;
    const f = await fixture(t, { quotas: {
      deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1,
    }, uploadIO: { async open(path, flags, ...rest) {
      if (flags === 'wx') temporaryOpens++;
      return openFile(path, flags, ...rest);
    } } });
    const finish = f.store.finishArtifactUpload;
    f.store.finishArtifactUpload = (device, id, actual, install, ownerToken, options) =>
      finish(device, id, actual, () => { install(); throw new Error('test-only post-rename failure'); }, ownerToken, options);
    const first = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
    assert.equal(first.status, 500); await first.json();
    assert.deepEqual(readdirSync(f.blobDir), [artifact.digest.slice(7)], 'the injected failure must occur after permanent installation');
    assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes);
    f.store.finishArtifactUpload = finish;
    const path = join(f.blobDir, artifact.digest.slice(7));
    const corrupt = corruption === 'size' ? bytes.subarray(1) : Buffer.alloc(bytes.length, 120);
    writeFileSync(path, corrupt);
    const retry = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
    assert.equal(retry.status, 500); assert.equal((await retry.json()).outcome, 'unknown');
    assert.equal(temporaryOpens, 1, 'verification failure must not open a replacement stream');
    assert.deepEqual(readdirSync(f.blobDir), [artifact.digest.slice(7)]);
    assert.deepEqual(readFileSync(path), corrupt);
    assert.deepEqual((await f.quota()).circle, { retained_bytes: 0, reserved_bytes: bytes.length, uploads: 1 });
    writeFileSync(path, bytes);
    const repaired = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
    assert.equal(repaired.status, 200); assert.deepEqual(await repaired.json(), artifact);
    assert.equal(temporaryOpens, 1);
    assert.deepEqual((await f.quota()).circle, { retained_bytes: bytes.length, reserved_bytes: 0, uploads: 0 });
  });
});

test('v1 HTTP failed rename retries by streaming when the permanent blob is absent', async t => {
  const bytes = Buffer.from('test-only retry absent blob'), artifact = ref(bytes);
  let renames = 0, temporaryOpens = 0;
  const f = await fixture(t, { quotas: {
    deviceBytes: bytes.length, circleBytes: bytes.length, concurrentUploads: 1,
  }, uploadIO: {
    async open(path, flags, ...rest) {
      if (flags === 'wx') temporaryOpens++;
      return openFile(path, flags, ...rest);
    },
    renameSync(from, to) {
      if (++renames === 1) throw new Error('test-only failed rename');
      return renameSync(from, to);
    },
  } });
  const failed = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(failed.status, 500); await failed.json();
  assert.deepEqual(readdirSync(f.blobDir), []);
  assert.deepEqual((await f.quota()).circle, { retained_bytes: 0, reserved_bytes: 0, uploads: 0 });
  const retry = await f.raw(0, 'PUT', artifactRoute(artifact), bytes, { mediaType: artifact.media_type });
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), artifact);
  assert.equal(temporaryOpens, 2); assert.equal(renames, 2);
  assert.deepEqual(readFileSync(join(f.blobDir, artifact.digest.slice(7))), bytes);
  assert.deepEqual((await f.quota()).circle, { retained_bytes: bytes.length, reserved_bytes: 0, uploads: 0 });
});

// openapi.yaml deliberately uses JSON, the dependency-free subset of YAML 1.2.
// Do not silently grow this into a permissive, partial YAML implementation.
function parseOpenApiJson(text) {
  const value = JSON.parse(text);
  // JSON.parse otherwise silently accepts duplicate mapping keys, which YAML
  // forbids. Tokenize only after the native parser has checked JSON grammar.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/g);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '{') stack.push(new Set());
    else if (tokens[i] === '[') stack.push(null);
    else if (tokens[i] === '}' || tokens[i] === ']') stack.pop();
    else if (tokens[i].startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(tokens[i]), keys = stack.at(-1);
      assert.ok(keys && !keys.has(key), `duplicate JSON mapping key ${key}`); keys.add(key);
    } else if (/^-?[0-9]/.test(tokens[i])) assert.ok(Number.isFinite(Number(tokens[i])), 'finite JSON number');
  }
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'OpenAPI document is an object');
  return value;
}
const openApiMethods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkOpenApi(document) {
  assert.match(document.openapi, /^3\.1\.\d+$/, 'OpenAPI 3.1 version');
  assert.ok(object(document.info), 'info object');
  for (const key of ['title', 'version']) assert.ok(typeof document.info[key] === 'string' && document.info[key], `info.${key}`);
  assert.ok(object(document.paths) && Object.keys(document.paths).length, 'nonempty paths object');
  assert.ok(object(document.components), 'components object');
  const resolve = value => {
    if (!value?.$ref) return value;
    assert.match(value.$ref, /^#\/components\//, 'only local component references are used');
    let target = document;
    for (const encoded of value.$ref.slice(2).split('/')) {
      assert.doesNotMatch(encoded, /~(?![01])/);
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      assert.ok(object(target) && Object.hasOwn(target, key), `unresolved reference ${value.$ref}`);
      target = target[key];
    }
    assert.ok(object(target), `reference object ${value.$ref}`);
    return target;
  };
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '$ref')) resolve(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(document);
  const ids = new Set(), operations = new Map();
  for (const [path, item] of Object.entries(document.paths)) {
    assert.match(path, /^\//); assert.ok(object(item), `path item ${path}`);
    assert.ok(!/[{}]/.test(path.replace(/\{[^/{}]+\}/g, '')), `path template ${path}`);
    for (const [method, operation] of Object.entries(item)) {
      if (['summary', 'description', 'servers', 'parameters', '$ref'].includes(method) || method.startsWith('x-')) continue;
      assert.ok(openApiMethods.includes(method), `operation method ${method}`);
      assert.ok(object(operation), `operation ${method} ${path}`);
      assert.ok(typeof operation.operationId === 'string' && operation.operationId, 'operationId');
      assert.ok(!ids.has(operation.operationId), `duplicate operationId ${operation.operationId}`); ids.add(operation.operationId);
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(resolve);
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      for (const name of names) assert.equal(parameters.filter(p => p.in === 'path' && p.name === name && p.required === true).length, 1, `required path parameter ${name}`);
      for (const parameter of parameters) {
        assert.ok(object(parameter) && typeof parameter.name === 'string');
        assert.ok(['path', 'query', 'header', 'cookie'].includes(parameter.in));
        if (parameter.in === 'path') assert.ok(names.includes(parameter.name) && parameter.required === true, 'declared path parameter is present and required');
        assert.ok(object(parameter.schema) || object(parameter.content), 'parameter schema or content');
      }
      assert.ok(object(operation.responses) && Object.keys(operation.responses).length, 'responses object');
      for (const [status, reference] of Object.entries(operation.responses)) {
        assert.match(status, /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/);
        const response = resolve(reference);
        assert.ok(object(response) && typeof response.description === 'string', 'response description');
        if (response.content !== undefined) {
          assert.ok(object(response.content), 'response content');
          for (const [media, value] of Object.entries(response.content)) {
            assert.match(media, /^[^/\s]+\/[^/\s]+$/); assert.ok(object(value));
            if (value.schema !== undefined) assert.ok(object(value.schema) || typeof value.schema === 'boolean', 'media schema');
          }
        }
      }
      if (operation.requestBody) {
        const body = resolve(operation.requestBody);
        assert.ok(object(body.content) && Object.keys(body.content).length, 'request body content');
      }
      for (const requirement of operation.security ?? document.security ?? []) {
        assert.ok(object(requirement));
        for (const [name, scopes] of Object.entries(requirement)) {
          assert.ok(Object.hasOwn(document.components.securitySchemes ?? {}, name), `security scheme ${name}`);
          assert.ok(Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string'));
        }
      }
      const key = `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`;
      assert.ok(!operations.has(key), `ambiguous path template ${key}`); operations.set(key, operation);
    }
  }
  return { operations, resolve };
}

// Expand the finite route-regexp vocabulary actually used by this server. A new
// regexp construct fails closed until this extractor and its tests support it.
function routeSamples(pattern) {
  assert.ok(pattern.startsWith('^') && pattern.endsWith('$'), `anchored route regexp: ${pattern}`);
  const alternatives = pattern.slice(1, -1).replaceAll('\\/', '/');
  const optional = alternatives.match(/\(\?:\/\(([^()]+)\)\)\?$/);
  if (optional) {
    const prefix = alternatives.slice(0, optional.index);
    return ['', ...optional[1].split('|').map(action => '/' + action)].flatMap(suffix => routeSamples('^' + prefix + suffix + '$'));
  }
  let template = '', sample = '', remaining = alternatives;
  while (remaining) {
    const dynamic = remaining.match(/^\(([^()]+)\)/) ?? remaining.match(/^(\[[^\]]+\](?:\{\d+\}|[+*])?)/);
    if (dynamic) {
      const expression = dynamic[1];
      assert.ok(expression.includes('['), `unsupported route group ${expression}`);
      let value;
      if (new RegExp('^(?:' + expression + ')$').test(p.digestBytes(Buffer.alloc(0)).slice(7))) value = p.digestBytes(Buffer.alloc(0)).slice(7);
      else value = expression.replace(/\[([^\]]+)\](?:\{(\d+)\}|([+*]))?/g, (_, chars, count) => chars[0].repeat(count ? Number(count) : 1));
      assert.match(value, new RegExp('^(?:' + expression + ')$'));
      assert.doesNotMatch(value, /[\[\]{}()*+?|\\]/, 'unsupported route regexp');
      template += '{}'; sample += value; remaining = remaining.slice(dynamic[0].length);
    } else {
      assert.match(remaining[0], /[a-zA-Z0-9/_-]/, `unsupported route regexp ${remaining}`);
      template += remaining[0]; sample += remaining[0]; remaining = remaining.slice(1);
    }
  }
  assert.match(sample, new RegExp(pattern));
  return [{ template, sample }];
}
function serverRouteCandidates(source) {
  const prefix = source.match(/const prefix='([^']+)'\+config\.circle;/)?.[1];
  assert.ok(prefix, 'circle prefix must be derived from the server');
  const constants = new Map([...source.matchAll(/const ([A-Z]+)='([^']+)';/g)].map(match => [match[1], match[2]]));
  const routes = new Map();
  const add = (template, sample, circleRoute) => {
    const path = circleRoute ? prefix + circle + sample : sample;
    routes.set(path, { path, template: (circleRoute ? prefix + '{}' : '') + template });
  };
  for (const match of source.matchAll(/\b(raw|route)==='(\/[^']*)'/g)) add(match[2], match[2], match[1] === 'route');
  for (const match of source.matchAll(/new RegExp\((.+?)\)\.exec\(route\)/g)) {
    let expression = '', rest = match[1];
    while (rest) {
      const token = rest.match(/^(?:'([^']*)'|([A-Z]+))(\+|$)/);
      assert.ok(token, `unsupported RegExp expression ${rest}`);
      expression += token[1] ?? constants.get(token[2]);
      assert.ok(token[1] !== undefined || constants.has(token[2]), 'known regexp constant');
      rest = rest.slice(token[0].length);
    }
    for (const candidate of routeSamples(expression)) add(candidate.template, candidate.sample, true);
  }
  const literals = [...source.matchAll(/\/((?:\\.|[^/\n\\])+)\/\.(exec|test)\((route|raw)\)/g)];
  for (const match of literals) {
    if (!match[1].startsWith('^')) continue; // The percent/invalid-byte guards are not routes.
    for (const candidate of routeSamples(match[1])) add(candidate.template, candidate.sample, match[3] === 'route');
  }
  for (const match of source.matchAll(/raw\.startsWith\('(\/[^']+\/)'\)/g)) {
    // A prefix-routed public code is validated by the protocol's exported regexp.
    assert.ok(source.includes("raw.slice('" + match[1] + "'.length)"));
    const code = 'a'.repeat(10); assert.match(code, p.INVITE_CODE_PATTERN);
    add(match[1] + '{}', match[1] + code, false);
  }
  assert.ok(routes.size > 0);
  return [...routes.values()];
}
function transportErrorStatuses(source) {
  const table = source.match(/const STATUS=Object\.fromEntries\(\[([\s\S]*?)\]\.flatMap/);
  assert.ok(table, 'derive the complete transport error mapping from server code');
  const codes = [...table[1].matchAll(/\[(\d{3}),'([^']+)'\]/g)].map(match => Number(match[1]));
  assert.ok(codes.length && codes.every(status => status >= 400 && status <= 599));
  assert.equal(table[1].replace(/\[\d{3},'[^']+'\]/g, '').replace(/[\s,]/g, ''), '', 'no unparsed status mappings');
  return new Set(codes);
}

const openApiSource = () => readFileSync(new URL('../docs/protocol/openapi.yaml', import.meta.url), 'utf8');
const v1ServerSource = () => readFileSync(new URL('../lib/v1/server.mjs', import.meta.url), 'utf8');

test('OpenAPI JSON-subset reader accepts nested YAML-compatible JSON and rejects unsupported syntax', () => {
  assert.deepEqual(parseOpenApiJson('{"text":"colon: hash# \\u263a", "nested":[true,false,null,1,{"$ref":"#/components/schemas/A"}]}'),
    { text: 'colon: hash# ☺', nested: [true, false, null, 1, { $ref: '#/components/schemas/A' }] });
  assert.deepEqual(parseOpenApiJson('{"a":{"same":1},"b":{"same":2}}'), { a: { same: 1 }, b: { same: 2 } });
  for (const text of ['openapi: 3.1.0', '{"x":1,}', '{"x":NaN}', '{"x":undefined}', '{/* comment */}', '{} {}', 'null', '[]', '{"x":1,"x":2}', '{"nested":{"x":1,"\\u0078":2}}', '{"x":1e999}'])
    assert.throws(() => parseOpenApiJson(text), undefined, text);
});

test('OpenAPI 3.1 structure, path parameters, security and local component references resolve', () => {
  const document = parseOpenApiJson(openApiSource()); checkOpenApi(document);
  const invalid = mutate => { const copy = structuredClone(document); mutate(copy); assert.throws(() => checkOpenApi(copy)); };
  invalid(d => { d.openapi = '3.0.3'; }); invalid(d => { delete d.info.title; });
  invalid(d => { d.paths['/join'].get.responses['200'].$ref = '#/components/schemas/Missing'; });
  invalid(d => { d.paths['/join'].get.responses['200'].$ref = 'https://example.test/schema'; });
  invalid(d => { d.paths['/i/{code}'].get.parameters[0].required = false; });
  invalid(d => { delete d.paths['/join'].get.responses['200'].description; });
  invalid(d => { d.paths['/join'].get.responses['600'] = { description: 'invalid status' }; });
  invalid(d => { d.paths['/join'].get.security = [{ Missing: [] }]; });
  invalid(d => { d.paths['/i/{code}'].get.operationId = d.paths['/join'].get.operationId; });
});

test('OpenAPI route extraction follows server literals, regexps and added routes without a copied inventory', () => {
  assert.deepEqual(routeSamples('^/things/([0-9a-f]{64})(?:/(start|finish))?$').map(row => row.template), ['/things/{}', '/things/{}/start', '/things/{}/finish']);
  assert.deepEqual(routeSamples('^/number/([1-9][0-9]*)$').map(row => row.template), ['/number/{}']);
  assert.throws(() => routeSamples('^/unsupported/(.*)$'));
  const source = v1ServerSource();
  const added = serverRouteCandidates(source + "\nif(method==='DELETE'&&route==='/future-route'){}\n");
  assert.ok(added.some(row => row.template.endsWith('/future-route')));
  assert.ok(serverRouteCandidates(source).some(row => row.template === '/i/{}'));
  assert.ok(serverRouteCandidates(source).some(row => row.template.endsWith('/artifacts/{}')));
  assert.ok(transportErrorStatuses(source + '').has(413));
  assert.ok(transportErrorStatuses(source.replace("[400,'", "[418,'")).has(418));
});

// Error responses deliberately cover the entire transport mapping on each
// operation. This is a conservative envelope, not a claim that every store
// failure is reachable on every route. It includes middleware and future store
// errors that a happy-path-only set of probes could otherwise miss.
test('OpenAPI documents every transport problem status explicitly for every operation', () => {
  const { operations, resolve } = checkOpenApi(parseOpenApiJson(openApiSource()));
  const errors = transportErrorStatuses(v1ServerSource());
  for (const [key, operation] of operations) for (const status of errors) {
    assert.ok(Object.hasOwn(operation.responses, status), `${key}: explicit ${status} response (default is insufficient)`);
    const response = resolve(operation.responses[status]);
    assert.ok(response.content?.['application/problem+json']?.schema, `${key}: ${status} problem+json schema`);
  }
});

// Probe the real HTTP handler with an inert store, so route discovery does not
// depend on membership, database fixtures or OpenAPI's own operation inventory.
// Store calls are observed, never executed; this test covers dispatch/transport,
// while the preceding server tests cover real authentication and store behavior.
test('OpenAPI operations and success statuses match code-derived HTTP routes in both directions', async t => {
  const source = v1ServerSource(), candidates = serverRouteCandidates(source);
  const { operations } = checkOpenApi(parseOpenApiJson(openApiSource()));
  const dir = mkdtempSync(join(tmpdir(), 'faravan-openapi-'));
  let handler, calls = [], noWork = false;
  const server = createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const empty = ref(Buffer.alloc(0));
  const result = { enrollment_id: circle, state: 'pending', device: ids[0], roster: null };
  const store = new Proxy({}, { get(_, name) {
    if (name === 'configuration') return () => ({ origin, circle, limits: { maxArtifactBytes: 262144 } });
    if (name === 'recoverTransportUploads' || name === 'preflightRequest') return () => {};
    if (name === 'openPostRequest') return () => null;
    return (...args) => {
      calls.push(name);
      if (name === 'openOffersPoll') return { poll: () => ({ items: [], next_cursor: null, revision: 0 }), close() {} };
      if (name === 'openClaimPoll') return { initial: noWork ? null : result, replayed: false, poll: () => null, close() {} };
      if (name === 'reserveArtifact') return { reservation_id: circle, owner_token: circle };
      if (name === 'finishArtifactUpload') { args[3](); return empty; }
      if (name === 'getArtifact') return empty;
      return { ...result };
    };
  } });
  handler = createV1Handler({ store, blobDir: join(dir, 'blobs'), clock: () => start });
  writeFileSync(join(dir, 'blobs', empty.digest.slice(7)), Buffer.alloc(0));
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const bodies = [null, {}];
  for (const match of source.matchAll(/exact\(body,\[([^\]]*)\]/g)) {
    const body = {};
    for (const name of [...match[1].matchAll(/'([^']+)'/g)].map(match => match[1])) body[name] = name === 'generation' ? 1 : {};
    bodies.push(body);
  }
  bodies.push({ payload: { job_digest: empty.digest, attempt_id: circle } });
  // UUID regexps use zeros; substitute that value for the endpoint-specific guard.
  for (const candidate of candidates) if (/\/attempts\//.test(candidate.path)) bodies.push({ payload: { attempt_id: candidate.path.split('/attempts/')[1].split('/')[0] } });
  const methods = new Set([...openApiMethods.map(method => method.toUpperCase()), ...[...source.matchAll(/method==='([A-Z]+)'/g)].map(match => match[1]), ...[...operations.keys()].map(key => key.split(' ')[0])]);
  const observed = new Map();
  async function probe(candidate, method, body) {
    const read = method === 'GET' || method === 'HEAD';
    const artifact = method === 'PUT' && candidate.template.endsWith('/artifacts/{}');
    const bytes = read || artifact ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body));
    const contentType = read ? '' : artifact ? 'application/octet-stream' : 'application/json';
    const mediaType = artifact ? empty.media_type : '', idem = method === 'POST' ? 'conformance' : '';
    const payload = { method, target: origin + candidate.path, circle, key_id: ids[0], content_type: contentType,
      artifact_media_type: mediaType, idempotency_key: idem, content_length: bytes.length, body_digest: p.digestBytes(bytes) };
    const headers = { 'Faravan-Proof': Buffer.from(p.canonicalize({ payload })).toString('base64url') };
    if (!read) headers['Content-Length'] = String(bytes.length);
    if (contentType) headers['Content-Type'] = contentType;
    if (mediaType) headers['Faravan-Media-Type'] = mediaType;
    if (idem) headers['Idempotency-Key'] = idem;
    calls = [];
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(origin + candidate.path, { method, headers }, response => {
        response.resume(); response.on('end', () => resolve(response)); response.on('error', reject);
      }); request.on('error', reject); request.end(read ? undefined : bytes);
    });
    const key = `${method} ${candidate.template}`;
    // Static HTML has no store call. Other registered operations must reach the
    // inert store; middleware alone must not count an unknown route as handled.
    const handled = calls.length > 0 || response.statusCode === 200 && response.headers['content-type']?.startsWith('text/html');
    if (handled) {
      assert.ok(operations.has(key), `server operation missing from OpenAPI: ${key}`);
      const operation = operations.get(key);
      assert.ok(Object.hasOwn(operation.responses, response.statusCode), `${key}: undocumented observed status ${response.statusCode}`);
      if (!observed.has(key)) observed.set(key, new Set()); observed.get(key).add(response.statusCode);
      if (response.statusCode >= 400) assert.match(response.headers['content-type'], /^application\/problem\+json/);
    }
    return handled && response.statusCode < 400;
  }
  for (const candidate of candidates) for (const method of methods) {
    for (const body of method === 'POST' || method === 'PUT' ? bodies : [null]) if (await probe(candidate, method, body)) break;
  }
  assert.deepEqual([...observed.keys()].sort(), [...operations.keys()].sort(), 'every OpenAPI operation is handled and every server route is documented');
  // Exercise the alternate no-work success of any store-backed claim poll.
  noWork = true;
  for (const candidate of candidates) for (const body of bodies) {
    if (!object(body) || !Object.hasOwn(body, 'advertisement')) continue;
    await probe(candidate, 'POST', body);
  }
  const verifyCoverage = (actual, documented) => {
    assert.deepEqual([...actual.keys()].sort(), [...documented.keys()].sort(), 'route coverage is bidirectional');
    for (const [key, operation] of documented) {
      const success = Object.keys(operation.responses).filter(status => /^2\d\d$/.test(status)).map(Number);
      assert.ok(success.length, `${key}: documented success`);
      for (const status of success) assert.ok(actual.get(key)?.has(status), `${key}: documented success ${status} is actually emitted`);
      for (const status of actual.get(key)) assert.ok(Object.hasOwn(operation.responses, status), `${key}: observed status ${status} is documented`);
    }
  };
  verifyCoverage(observed, operations);
  // Negative controls prove that the comparison cannot pass by merely probing
  // whichever operations happen to remain in the document.
  const first = operations.keys().next().value;
  const missingServerRoute = new Map(observed); missingServerRoute.delete(first);
  assert.throws(() => verifyCoverage(missingServerRoute, operations));
  const missingDocumentRoute = new Map(operations); missingDocumentRoute.delete(first);
  assert.throws(() => verifyCoverage(observed, missingDocumentRoute));
  const extraDocumentRoute = new Map(operations); extraDocumentRoute.set('GET /not-implemented', operations.get(first));
  assert.throws(() => verifyCoverage(observed, extraDocumentRoute));
  const wrongStatus = new Map(observed); wrongStatus.set(first, new Set([299]));
  assert.throws(() => verifyCoverage(wrongStatus, operations));
  t.diagnostic(`Compared ${observed.size} operations using ${candidates.length} code-derived path candidates; all documented success codes were observed.`);
});

test('v1 progress channel: the lender posts coarse steps, only the author and the lender read them, 404 for others',
  { timeout: 10000 }, async t => {
    const initialRoster = p.signEnvelope('roster', { ...vectors.roster.payload,
      members: [...vectors.roster.payload.members, { key_id: ids[3], public_key: pubs[3], joined_epoch: 7 }] }, keys[2]);
    const f = await fixture(t, { initialRoster });
    const author = f.client(0), lender = f.client(1), other = f.client(3);
    const submitted = await author.submitJob(await f.job(author));
    const claim = await lender.claimNext(ad, { waitSeconds: 0 });
    const attempt = await lender.startAttempt(claim.attempt);
    const digest = submitted.jobDigest;
    assert.deepEqual((await author.fetchProgress(digest)).entries, []);
    const first = await lender.postProgress(attempt, { step: 'Reading src/app.js' });
    assert.deepEqual({ ...first, at: undefined }, { job: digest, attempt: attempt.attempt_id, seq: 1, at: undefined, step: 'Reading src/app.js', kind: 'step' });
    assert.equal(first.at, iso(f.now));
    // The step is visible to the author at once (well inside the 20 s target).
    const seen = await author.fetchProgress(digest);
    assert.deepEqual(seen.entries, [first]); assert.equal(seen.next_after, 1);
    assert.deepEqual((await lender.fetchProgress(digest)).entries, [first]);
    f.advance(15);
    await lender.postProgress(attempt, { step: 'Editing src/app.js' });
    assert.deepEqual((await author.fetchProgress(digest, { after: 1 })).entries.map(e => e.seq), [2]);
    // A circle member who is neither the author nor a lender of this job gets 404, with no hint the job exists.
    await assert.rejects(other.fetchProgress(digest), e => e.status === 404 && e.code === 'not_found');
    await assert.rejects(other.fetchProgress('sha256:' + '0'.repeat(64)), e => e.status === 404);
    // The author cannot write steps; only the attempt holder can.
    await assert.rejects(author.postProgress(attempt, { step: 'forged' }), e => e.code === 'executor_mismatch');
    await problem(await f.raw(0, 'POST', '/jobs/' + digest.slice(7) + '/progress', { attempt: attempt.attempt_id, step: 'forged', kind: 'step' }), 403, 'forbidden');
    await problem(await f.raw(3, 'POST', '/jobs/' + digest.slice(7) + '/progress', { attempt: attempt.attempt_id, step: 'forged', kind: 'step' }), 403, 'forbidden');
    // Shape limits: step length, extra fields, control characters, bad kind.
    f.advance(15);
    for (const body of [{ attempt: attempt.attempt_id, step: 'x'.repeat(121), kind: 'step' },
      { attempt: attempt.attempt_id, step: '', kind: 'step' }, { attempt: attempt.attempt_id, step: 'a\nb', kind: 'step' },
      { attempt: attempt.attempt_id, step: 'ok', kind: 'other' }, { attempt: attempt.attempt_id, step: 'ok', kind: 'step', extra: 1 }])
      assert.equal((await f.raw(1, 'POST', '/jobs/' + digest.slice(7) + '/progress', body)).status, 400);
    // A step sent less than 10 s after the last is refused; the closing entry is exempt.
    await lender.postProgress(attempt, { step: 'Running a command' });
    await assert.rejects(lender.postProgress(attempt, { step: 'Running a command' }), e => e.code === 'rate_limited');
    assert.equal((await lender.postProgress(attempt, { step: 'Finished', kind: 'done' })).kind, 'done');
    // Bad cursors and stray query names are rejected.
    for (const q of ['?after=-1', '?after=x', '?limit=3']) {
      const response = await f.raw(0, 'GET', '/jobs/' + digest.slice(7) + '/progress' + q);
      assert.equal(response.status, 400, q);
    }
  });

test('v1 progress channel stores at most 40 entries per attempt and ends with the job', { timeout: 20000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const submitted = await author.submitJob(await f.job(author));
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  const attempt = await lender.startAttempt(claim.attempt);
  for (let n = 1; n <= 40; n++) { await lender.postProgress(attempt, { step: 'step ' + n }); f.advance(10); await lender.renew(claim.attempt); }
  await assert.rejects(lender.postProgress(attempt, { step: 'one too many', kind: 'done' }), e => e.code === 'quota_exceeded');
  const page = await author.fetchProgress(submitted.jobDigest);
  assert.equal(page.entries.length, 40); assert.equal(page.next_after, 40);
  assert.deepEqual(page.entries.map(e => e.seq), Array.from({ length: 40 }, (_, i) => i + 1));
});


test('v1 runtime stages share the progress channel, privacy, rate and count limits', { timeout: 20000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const submitted = await author.submitJob(await f.job(author));
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  const attempt = await lender.startAttempt(claim.attempt);
  const route = '/jobs/' + submitted.jobDigest.slice(7) + '/progress';
  const send = (stage, elapsed_s, extra = {}) => f.raw(1, 'POST', route,
    { attempt: attempt.attempt_id, stage, elapsed_s, ...extra });
  const stages = ['preparing', 'agent', 'checks', 'screenshots', 'sending'];
  for (const [i, stage] of stages.entries()) {
    const response = await send(stage, i * 10);
    assert.equal(response.status, 200);
    const entry = await response.json();
    assert.deepEqual(entry, { job: submitted.jobDigest, attempt: attempt.attempt_id,
      seq: i + 1, at: iso(f.now), stage, elapsed_s: i * 10 });
    await problem(await send('agent', i * 10), 429, 'rate_limited');
    await assert.rejects(lender.postProgress(attempt, { step: 'Reading src/app.js' }),
      e => e.code === 'rate_limited');
    f.advance(10);
  }
  const page = await (await f.raw(0, 'GET', route)).json();
  assert.deepEqual(page.entries.map(e => e.stage), stages);
  assert.equal(page.next_after, 5);
  assert.deepEqual((await (await f.raw(1, 'GET', route + '?after=3')).json()).entries,
    page.entries.slice(3));
  await problem(await f.raw(0, 'POST', route,
    { attempt: attempt.attempt_id, stage: 'agent', elapsed_s: 50 }), 403, 'forbidden');
  for (const body of [
    { stage: 'unknown', elapsed_s: 0 }, { stage: 'agent', elapsed_s: -1 },
    { stage: 'agent', elapsed_s: '1' }, { stage: 'agent' }, { elapsed_s: 1 },
    { stage: 'agent', elapsed_s: 1, step: 'mixed' },
    { stage: 'agent', elapsed_s: 1, kind: 'done' },
    { stage: 'agent', elapsed_s: 1, extra: true },
  ]) await problem(await f.raw(1, 'POST', route, { attempt: attempt.attempt_id, ...body }), 400, 'invalid_request');
  await lender.postProgress(attempt, { step: 'Reading src/app.js' });
  await problem(await send('agent', 50), 429, 'rate_limited');
  // The 40-entry cap is shared by stages, legacy steps and closing entries.
  for (let n = 7; n <= 40; n++) {
    f.advance(10); await lender.renew(claim.attempt);
    assert.equal((await send('agent', n * 10)).status, 200);
  }
  f.advance(10);
  await problem(await send('sending', 400), 429, 'quota_exceeded');
  await assert.rejects(lender.postProgress(attempt, { step: 'Finished', kind: 'done' }),
    e => e.code === 'quota_exceeded');
  assert.equal((await (await f.raw(0, 'GET', route)).json()).entries.length, 40);
});

test('v1 runtime stages require an active attempt; legacy closing entries stay compatible', async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const submitted = await author.submitJob(await f.job(author));
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  const attempt = await lender.startAttempt(claim.attempt);
  const route = '/jobs/' + submitted.jobDigest.slice(7) + '/progress';
  const body = { attempt: attempt.attempt_id, stage: 'preparing', elapsed_s: 0 };
  const options = { idempotencyKey: randomUUID() };
  const first = await (await f.raw(1, 'POST', route, body, options)).json();
  assert.deepEqual(await (await f.raw(1, 'POST', route, body, options)).json(), first);
  // Expiry reliably ends the attempt without exercising runtime execution.
  f.advance(121);
  await problem(await f.raw(1, 'POST', route, { ...body, stage: 'sending', elapsed_s: 121 }), 409, 'stale_attempt');
  assert.equal((await lender.postProgress(attempt, { step: 'Stopped', kind: 'fail' })).kind, 'fail');
});
const hb = (seq, extra = {}) => ({ seq, intent: { state: 'ready', reason: null, until: null }, execution: { state: 'idle', stops_by: null },
  blockers: [], agents: [{ adapter: 'codex', readiness: 'ready', models: ['example-model'], per_job_max_minutes: 20 }],
  budget: { jobs_left_today: 2, minutes_left_today: 40, resets_at: null, time_zone: 'UTC' }, schedule: null,
  capabilities: ['progress_v1'], versions: { faravan: null, protocol: '1', sbx: null }, ...extra });

test('v1 presence: heartbeat online for 90 s by server time, blocked and paused devices stay visible, old lenders fall back to polls',
  { timeout: 10000 }, async t => {
    const f = await fixture(t), author = f.client(0), lender = f.client(1,false,{accountClaims:false});
    const find = async id => (await author.fetchPresence()).devices.find(d => d.device === id);
    // Nobody has reported: both members are listed, offline, with no capabilities.
    let page = await author.fetchPresence();
    assert.deepEqual(page.devices.map(d => [d.online, d.source, d.capabilities]), [[false, 'none', []], [false, 'none', []]]);
    assert.equal(page.online_seconds, 90);
    await lender.heartbeat(hb(0, { intent: { state: 'blocked', reason: 'agent_not_ready', until: null }, blockers: [{ kind: 'agent_signed_out', agent: 'codex' }] }));
    let d = await find(ids[1]);
    assert.equal(d.online, true); assert.equal(d.source, 'heartbeat'); assert.equal(d.intent.state, 'blocked');
    assert.deepEqual(d.blockers, [{ kind: 'agent_signed_out', agent: 'codex' }]); assert.deepEqual(d.capabilities, ['progress_v1']);
    assert.equal(d.last_heartbeat_at, iso(f.now));
    const person = (await author.fetchPresence()).persons.find(x => x.person === ids[1]);
    assert.equal(person.online, true); assert.equal(person.able, false, 'blocked is online but not able');
    f.advance(89); assert.equal((await find(ids[1])).online, true);
    f.advance(1); d = await find(ids[1]);
    assert.equal(d.online, false, 'offline at 90 s by the server clock'); assert.equal(d.intent.state, 'blocked', 'the last reason stays visible');
    assert.deepEqual(d.capabilities, [], 'a stale heartbeat claims no capabilities');
    await lender.heartbeat(hb(1));
    assert.equal((await author.fetchPresence()).persons.find(x => x.person === ids[1]).able, true);
    // An older heartbeat never replaces a newer one.
    await lender.heartbeat(hb(0, { intent: { state: 'off', reason: null, until: null } }));
    assert.equal((await find(ids[1])).intent.state, 'ready');
    // An older lender never heartbeats: its claim-next poll makes it online with no capabilities.
    f.advance(200);
    await author.submitJob(await f.job(author));
    await lender.claimNext(ad, { waitSeconds: 0 });
    d = await find(ids[1]);
    assert.equal(d.source === 'poll' || d.source === 'heartbeat', true);
    f.advance(100);
    assert.equal((await find(ids[1])).online, false);
  });

test('v1 presence: a restarted lender (new boot, seq back at 0) replaces the stored heartbeat; the same boot stays ordered', { timeout: 10000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1,false,{accountClaims:false});
  const find = async () => (await author.fetchPresence()).devices.find(d => d.device === ids[1]);
  await lender.heartbeat(hb(2880, { boot: 'bootAAAAAAAA1', intent: { state: 'ready', reason: null, until: null } }));
  // Same boot, older seq: acknowledged, not stored.
  await lender.heartbeat(hb(5, { boot: 'bootAAAAAAAA1', intent: { state: 'off', reason: null, until: null } }));
  assert.equal((await find()).intent.state, 'ready');
  // The lender restarts: new boot, seq 0. It must not be ignored until it climbs back to 2880.
  f.advance(30);
  await lender.heartbeat(hb(0, { boot: 'bootBBBBBBBB2', intent: { state: 'paused', reason: 'paused', until: null }, capabilities: [] }));
  let d = await find();
  assert.equal(d.intent.state, 'paused'); assert.equal(d.last_heartbeat_at, iso(f.now)); assert.deepEqual(d.capabilities, []);
  // Within the new boot the usual order holds.
  await lender.heartbeat(hb(1, { boot: 'bootBBBBBBBB2', intent: { state: 'ready', reason: null, until: null } }));
  await lender.heartbeat(hb(0, { boot: 'bootBBBBBBBB2', intent: { state: 'blocked', reason: 'x', until: null } }));
  assert.equal((await find()).intent.state, 'ready');
  // A malformed boot is rejected.
  for (const boot of ['', 'short', 'has space in it!', 7, 'x'.repeat(41)])
    assert.equal((await f.raw(1, 'POST', '/heartbeat', hb(2, { boot }))).status, 400, String(boot));
});

test('v1 presence: a poll alone is online with source poll; malformed heartbeats are rejected', { timeout: 10000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1,false,{accountClaims:false});
  await author.submitJob(await f.job(author));
  await lender.claimNext(ad, { waitSeconds: 0 });
  const d = (await author.fetchPresence()).devices.find(x => x.device === ids[1]);
  assert.deepEqual([d.online, d.source, d.capabilities, d.intent], [true, 'poll', [], null]);
  assert.equal((await author.fetchPresence()).persons.find(x => x.person === ids[1]).able, true);
  const post = body => f.raw(1, 'POST', '/heartbeat', body);
  for (const bad of [{}, { ...hb(0), extra: 1 }, hb(0, { intent: { state: 'sleepy' } }), hb(0, { capabilities: ['Bad Name'] }),
    hb(0, { capabilities: ['a', 'a'] }), hb(0, { agents: Array.from({ length: 9 }, () => hb(0).agents[0]) }), hb(-1), hb(0, { blockers: [{ kind: 'x\ny' }] })])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await post(hb(0))).status, 200);
});

// P22: versions between the host and its members.
test('v1 capabilities tell members the host version, its oldest member, and what it can do', { timeout: 20000 }, async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.10.0' } });
  const host = await f.client(0).capabilities();
  assert.deepEqual([host.faravan, host.min_member, host.protocol], ['0.12.1', '0.10.0', '1.0']);
  for (const name of ['heartbeat_v1', 'presence_v1', 'progress_v1', 'leave_v1', 'network_requirements_v1']) assert.ok(host.capabilities.includes(name), name);
  // Unset or unreadable versions are null, never guessed.
  const bare = await fixture(t, { versions: { faravan: 'nightly', minMember: undefined } });
  const unknown = await bare.client(0).capabilities();
  assert.deepEqual([unknown.faravan, unknown.min_member], [null, null]);
});

test('an older host (no P22 fields) reads as unknown, never as supporting a new field', { timeout: 20000 }, async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.10.0' } });
  // The same host as an older build would answer: only what protocol 1.0 had.
  const oldFetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!new URL(url).pathname.endsWith('/capabilities')) return response;
    const body = await response.json();
    for (const field of ['faravan', 'min_member', 'capabilities']) delete body[field];
    const headers = new Headers(response.headers); headers.delete('content-length');
    return new Response(p.canonicalize(body), { status: response.status, headers });
  };
  const member = f.client(0, false, { fetch: oldFetch, clientVersion: '0.12.1' });
  const profile = await member.capabilities();
  assert.deepEqual([profile.faravan, profile.min_member, profile.capabilities], [null, null, []]);
  assert.equal(await member.hostSupports('progress_v1'), false);
  assert.equal(await member.hostSupports('network_requirements_v1'), false);
  // A job with S5.4's `network` field is refused before it is sent: an old host would reject the whole job.
  const base = await f.job(member);
  const payload = { ...base, requirements: { ...base.requirements, network: 'provider+registries', registries: ['npm'] } };
  const before = f.requests.length;
  const refused = await member.submitJob(payload).then(() => null, error => error);
  assert.equal(refused?.code, 'host_too_old');
  assert.equal(f.requests.slice(before).some(r => r.method === 'POST' && /\/jobs$/.test(r.url)), false, 'nothing was posted');
});

// T21 (BUILD-PLAN v4, S3.1c): after the agent started, nothing puts the job back in the queue by itself.
async function claimed(t) {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  const submitted = await borrower.submitJob(await f.job(borrower));
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  return { f, borrower, lender, claim, digest: submitted.jobDigest };
}
const reasonCode = reason => JSON.parse(reason).code;

test('a lease that runs out before the agent started puts the job back in the queue; after it started, the job ends as failed', { timeout: 20000 }, async t => {
  const before = await claimed(t);
  before.f.advance(121); // never started
  const requeued = await before.borrower.getJob(before.digest);
  assert.equal(requeued.state, 'queued');
  assert.ok(await before.lender.claimNext(ad, { waitSeconds: 0 }), 'another claim can take it');

  const after = await claimed(t);
  await after.lender.startAttempt(after.claim.attempt);
  await after.lender.observeExecutionStart(after.claim.attempt);
  after.f.advance(121);
  const ended = await after.borrower.getJob(after.digest);
  assert.equal(ended.state, 'failed', 'it may have run in part: it is not run again by itself');
  assert.equal(ended.current_attempt.reason, 'lease_expired', 'the borrower reads why from the attempt');
  assert.equal(await after.lender.claimNext(ad, { waitSeconds: 0 }), null, 'nobody can claim it');
});

test('releasing or failing an attempt that started ends the job; releasing one that did not start requeues it', { timeout: 30000 }, async t => {
  const notStarted = await claimed(t);
  await notStarted.lender.release(notStarted.claim.attempt, JSON.stringify({ code: 'sandbox_not_ready' }));
  assert.equal((await notStarted.borrower.getJob(notStarted.digest)).state, 'queued');

  for (const [verb, code] of [['release', 'stopped_by_lender'], ['fail', 'execution_failed']]) {
    const run = await claimed(t);
    const started = await run.lender.startAttempt(run.claim.attempt);
    await run.lender.observeExecutionStart(run.claim.attempt);
    await run.lender[verb](started, JSON.stringify({ code }));
    const view = await run.borrower.getJob(run.digest);
    assert.equal(view.state, 'failed', verb + ' after start ends the job');
    assert.equal(reasonCode(view.current_attempt.reason), code);
    assert.equal(await run.lender.claimNext(ad, { waitSeconds: 0 }), null, verb + ': it is not offered again');
  }
});

// P17a: the host deletes a finished job's request, code, result, receipt and progress 30 days later, files included.
async function finish(f, author, lender, overrides = {}) {
  const payload = await f.job(author, overrides);
  const submitted = await author.submitJob(payload);
  const claim = await lender.claimNext(ad, { waitSeconds: 0 });
  const started = await lender.startAttempt(claim.attempt);
  const outputs = await lender.uploadResultArtifacts({ candidate, transcript });
  const result = { ...structuredClone(vectors.result.payload), ...outputs, executor: ids[1], roster_epoch: f.epoch, job_digest: submitted.jobDigest,
    attempt_id: started.attempt_id, generation: started.generation, submitted_at: iso(f.now),
    receipt: { ...currentReceipt(vectors.result.payload.receipt,selectionForJob(payload,ad)), source: payload.source, started_at: iso(f.now - 10), finished_at: iso(f.now), duration_ms: 10000 } };
  assert.equal((await lender.completeAttempt(started, result)).status, 'result-accepted');
  return { digest: submitted.jobDigest, payload, outputs };
}
// The roster is valid for a week and its owner keeps renewing it; a test that jumps ahead renews it the same way, through the owner device.
async function renewRoster(f, clients, publisher = 0) {
  const epoch = f.epoch + 1;
  const next = p.signEnvelope('roster', { ...vectors.roster.payload, epoch, issued_at: iso(f.now), valid_until: iso(f.now + 7 * 86400) }, keys[2]);
  assert.equal((await f.raw(publisher, 'PUT', '/roster', next, { epoch })).status, 200);
  f.epoch = epoch;
  for (const client of clients) await client.refreshRoster();
}
async function advanceDays(f, days, clients, publisher = 0) {
  for (let left = days * 86400; left > 0;) { const step = Math.min(left, 5 * 86400); f.advance(step); left -= step; await renewRoster(f, clients, publisher); }
}
const blobs = f => readdirSync(f.blobDir).filter(name => /^[0-9a-f]{64}$/.test(name)).sort();
const hex = ref => ref.digest.slice(7);

test('30 days after a job ends its rows and its files are gone, the quota is given back, and the answers stay 404', { timeout: 30000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const before = await f.quota(0);
  const job = await finish(f, author, lender);
  const files = [job.payload.source.artifact, job.payload.prompt, job.outputs.candidate, job.outputs.transcript].map(hex);
  for (const name of files) assert.ok(blobs(f).includes(name), 'stored: ' + name.slice(0, 8));
  assert.notDeepEqual(await f.quota(0), before, 'the job holds quota');
  await advanceDays(f, 29, [author, lender]);
  assert.equal((await author.getJob(job.digest)).state, 'result-accepted', 'day 29: still kept');
  f.advance(86400 + 120); // day 30 and two minutes
  await renewRoster(f, [author, lender]);
  await author.fetchPresence();
  assert.deepEqual(blobs(f).filter(name => files.includes(name)), [], 'the files of the job are gone from disk');
  await problem(await f.raw(0, 'GET', '/jobs/' + job.digest.slice(7)), 404, 'not_found');
  for (const name of files) await problem(await f.raw(0, 'GET', '/artifacts/' + name), 404, 'not_found');
  assert.deepEqual(await f.quota(0), before, 'what the job held is given back');
});

test('an artifact two jobs share stays until the last of them is gone', { timeout: 30000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const first = await finish(f, author, lender);
  f.advance(3 * 86400); await renewRoster(f, [author, lender]);
  const second = await finish(f, author, lender, { intent_id: randomUUID() });
  const shared = hex(first.payload.source.artifact);
  assert.equal(shared, hex(second.payload.source.artifact), 'both jobs use the same source file');
  await advanceDays(f, 27, [author, lender]); // day 30 for the first job, day 27 for the second
  f.advance(120); await renewRoster(f, [author, lender]);
  await author.fetchPresence();
  assert.equal(await author.getJob(first.digest).then(() => 'kept', error => error.code), 'not_found', 'the first job is past 30 days');
  assert.ok(blobs(f).includes(shared), 'the second job still needs the shared file');
  assert.ok(!blobs(f).includes(hex(first.outputs.candidate)) || hex(first.outputs.candidate) === hex(second.outputs.candidate));
  await advanceDays(f, 4, [author, lender]);
  await author.fetchPresence();
  assert.ok(!blobs(f).includes(shared), 'and now nobody does');
  assert.equal(await author.getJob(second.digest).then(() => 'kept', error => error.code), 'not_found');
});

test('the author deletes a finished job now; a running one, and someone else\'s, cannot be', { timeout: 30000 }, async t => {
  const f = await fixture(t), author = f.client(0), lender = f.client(1);
  const running = await author.submitJob(await f.job(author));
  await assert.rejects(author.deleteJob(running.jobDigest), error => error.code === 'conflict', 'a running job is cancelled first');
  await lender.claimNext(ad, { waitSeconds: 0 });
  const job = await finish(f, author, lender, { intent_id: randomUUID() });
  await assert.rejects(lender.deleteJob(job.digest), error => error.code === 'forbidden', 'a lender may not delete the borrower\'s job');
  await problem(await f.raw(3, 'POST', '/jobs/' + job.digest.slice(7) + '/delete', {}), 403, 'forbidden');
  const retention = await author.jobRetention(job.digest);
  assert.deepEqual([retention.state, retention.deletable], ['result-accepted', true]);
  assert.equal(Date.parse(retention.retained_until) - Date.parse(retention.ended_at), 30 * 86400 * 1000, 'kept for 30 days from the end');
  assert.equal((await lender.jobRetention(job.digest)).deletable, false);
  const gone = [job.outputs.candidate, job.outputs.transcript].map(hex);
  assert.equal((await author.deleteJob(job.digest)).deleted, true);
  assert.deepEqual(blobs(f).filter(name => gone.includes(name)), [], 'the job\'s own files are gone at once');
  assert.ok(blobs(f).includes(hex(job.payload.prompt)), 'the prompt the running job also uses stays');
  await problem(await f.raw(0, 'GET', '/jobs/' + job.digest.slice(7)), 404, 'not_found');
  assert.equal((await author.deleteJob(job.digest)).deleted, true, 'deleting it again says the same thing');
});

test('the circle\'s owner device may delete a member\'s finished job', { timeout: 30000 }, async t => {
  // Jobs in this fixture are authored by device 0 and run by device 1; device 1 also publishes the roster, which makes it the owner device.
  const f = await fixture(t), author = f.client(0), owner = f.client(1);
  await renewRoster(f, [author, owner], 1);
  const job = await finish(f, author, owner);
  assert.equal((await owner.jobRetention(job.digest)).deletable, true);
  assert.equal((await author.jobRetention(job.digest)).deletable, true, 'its author can too');
  assert.equal((await owner.deleteJob(job.digest)).deleted, true);
  assert.equal(await author.getJob(job.digest).then(() => 'kept', error => error.code), 'not_found');
});

test('privacy M3: existing clients can retry submission and claims after Delete', { timeout: 30000 }, async t => {
  const f=await fixture(t),author=f.client(0),lender=f.client(1);
  const payload=await f.job(author),submitKey=randomUUID(),claimKey=randomUUID();
  const submitted=await author.submitJob(payload,{idempotencyKey:submitKey});
  await lender.claimNext(ad,{waitSeconds:0,idempotencyKey:claimKey});
  await author.cancelJob(submitted.jobDigest);
  const deleted=await author.deleteJob(submitted.jobDigest);
  assert.deepEqual(await author.submitJob(payload,{idempotencyKey:submitKey}),submitted);
  assert.equal((await author.submitJob(payload)).jobDigest,submitted.jobDigest);
  await assert.rejects(lender.claimNext(ad,{waitSeconds:0,idempotencyKey:claimKey}),e=>e.code==='job_terminal'&&e.status===409);
  await assert.rejects(lender.claimNext(ad,{waitSeconds:0,idempotencyKey:claimKey}),e=>e.code==='job_terminal'&&e.status===409);
  assert.deepEqual(await author.deleteJob(submitted.jobDigest),deleted);
});

test('a host restart removes files no row owns, and keeps those a row does', { timeout: 30000 }, async t => {
  const f = await fixture(t), author = f.client(0);
  const kept = await author.uploadArtifact(sourceBytes, 'application/gzip');
  const orphan = 'ab'.repeat(32);
  writeFileSync(join(f.blobDir, orphan), 'left behind by a crash');
  f.restartHandler();
  assert.ok(!blobs(f).includes(orphan), 'the orphan is removed');
  assert.ok(blobs(f).includes(hex(kept)), 'an uploaded artifact is kept');
});

test('an older member never sees the new routes: retention needs the host\'s retention_v1', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const member = f.client(0, false, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!new URL(url).pathname.endsWith('/capabilities')) return response;
    const body = await response.json(); body.capabilities = body.capabilities.filter(c => c !== 'retention_v1');
    const headers = new Headers(response.headers); headers.delete('content-length');
    return new Response(p.canonicalize(body), { status: response.status, headers });
  } });
  await assert.rejects(member.deleteJob('sha256:' + 'a'.repeat(64)), error => error.code === 'host_too_old');
  await assert.rejects(member.jobRetention('sha256:' + 'a'.repeat(64)), error => error.code === 'host_too_old');
});

test('64 stalled nonmember roster bodies leave member heartbeat capacity available', {timeout:5000}, async t => {
  const f=await fixture(t,{limits:{maxRequests:64,maxRequestsPerSource:64,rosterRecoveryTimeoutMs:2000}});
  const pending=[];
  t.after(()=>pending.forEach(req=>req.destroy()));
  for(let i=0;i<64;i++) {
    const options=f.signed(3,'PUT','/roster',{padding:'waiting'});
    const req=httpRequest(f.origin+base+'/roster',{method:'PUT',headers:options.headers},res=>res.resume());
    req.on('error',()=>{});pending.push(req);req.flushHeaders();
  }
  await eventually(()=>f.requests.length===64,'all stalled bodies must reach coordinator');
  assert.equal((await f.raw(0,'POST','/heartbeat',hb(1))).status,200);
  assert.equal((await f.raw(0,'GET','/roster')).status,200);
  assert.equal(f.handler.pendingRosterRecoveries,2);
  pending.forEach(req=>req.destroy());
  await eventually(()=>f.handler.pendingRosterRecoveries===0,'abort must release recovery capacity');
  const proposed=p.signEnvelope('roster',{...vectors.roster.payload,epoch:8,
    members:[...vectors.roster.payload.members,{key_id:ids[3],public_key:pubs[3],joined_epoch:8}]},keys[2]);
  assert.equal((await f.raw(3,'PUT','/roster',proposed,{epoch:8})).status,200,'newly proposed member can recover roster');
});

test('nonmember roster rejects malformed proofs and oversized bodies before reading; timeout releases recovery capacity', {timeout:3000}, async t => {
  const f=await fixture(t,{limits:{rosterRecoveryTimeoutMs:40,maxRosterRecoveryBytes:2048}});
  const send=async options=>{
    let req;
    const response=await new Promise((resolve,reject)=>{
      req=httpRequest(f.origin+base+'/roster',{method:'PUT',headers:options.headers},resolve);
      req.on('error',reject);req.flushHeaders();
    });
    req.destroy();response.resume();return response.statusCode;
  };
  const malformed=f.signed(3,'PUT','/roster',{padding:'waiting'});
  const wrapper=p.strictParse(p.decodeBase64url(malformed.headers['Faravan-Proof']));
  delete wrapper.signature;
  malformed.headers['Faravan-Proof']=Buffer.from(p.canonicalize(wrapper)).toString('base64url');
  assert.equal(await send(malformed),401);
  const badDigest=f.signed(3,'PUT','/roster',{padding:'waiting'});
  const digestWrapper=p.strictParse(p.decodeBase64url(badDigest.headers['Faravan-Proof']));
  digestWrapper.payload.body_digest=[digestWrapper.payload.body_digest];
  badDigest.headers['Faravan-Proof']=Buffer.from(p.canonicalize(digestWrapper)).toString('base64url');
  assert.equal(await send(badDigest),401,'array-valued digest is a malformed envelope');
  assert.equal(await send(f.signed(3,'PUT','/roster',{padding:'x'.repeat(2048)})),413);
  assert.equal(await send(f.signed(3,'PUT','/roster',{padding:'waiting'})),400);
  assert.equal(f.handler.pendingRosterRecoveries,0);
  assert.equal((await f.raw(0,'GET','/roster')).status,200);
});


test('64 stalled enrollment bodies cannot occupy member request slots', {timeout:5000}, async t => {
  const f=await fixture(t,{limits:{maxRequests:64,maxRequestsPerSource:64}}),pending=[];
  t.after(()=>pending.forEach(req=>req.destroy()));
  for(let i=0;i<64;i++){
    const options=f.signed(3,'POST','/enrollments',{padding:'waiting'},{epoch:0});
    const req=httpRequest(f.origin+base+'/enrollments',{method:'POST',headers:options.headers},res=>res.resume());
    req.on('error',()=>{});pending.push(req);req.flushHeaders();
  }
  await eventually(()=>f.requests.length===64,'stalled enrollments never arrived');
  assert.equal((await f.raw(0,'POST','/heartbeat',hb(1))).status,200);
  assert.equal((await f.raw(0,'GET','/roster')).status,200);
  assert.equal(f.handler.pendingEnrollmentBodies,2);
  pending.forEach(req=>req.destroy());
  await eventually(()=>f.handler.pendingEnrollmentBodies===0,'abort leaked enrollment body allowance');
});

test('missing enrollment signature is rejected before its body arrives', {timeout:2000}, async t => {
  const f=await fixture(t),options=f.signed(3,'POST','/enrollments',{padding:'waiting'},{epoch:0});
  const envelope=p.strictParse(p.decodeBase64url(options.headers['Faravan-Proof']));delete envelope.signature;
  options.headers['Faravan-Proof']=Buffer.from(p.canonicalize(envelope)).toString('base64url');
  let req;
  const res=await new Promise((resolve,reject)=>{
    req=httpRequest(f.origin+base+'/enrollments',{method:'POST',headers:options.headers},resolve);
    req.on('error',reject);req.flushHeaders();
  });
  req.destroy();res.resume();assert.equal(res.statusCode,401);
});


test('download admission configuration rejects nonfinite or empty limits', async t => {
  const f=await fixture(t);f.handler.close();
  for(const limits of [{maxDownloads:0},{maxDownloadsPerDevice:NaN},{downloadTimeoutMs:Infinity}]){
    assert.throws(()=>createV1Handler({store:f.store,blobDir:f.blobDir,limits}),error=>error.code==='invalid_request');
  }
});


for(const mode of ['device','global','request']) {
  test('paused artifact downloads enforce '+mode+' cap until abort', {timeout:5000}, async t => {
    const limits={maxDownloads:mode==='global'?2:8,maxDownloadsPerDevice:mode==='device'?1:8,
      maxRequests:mode==='request'?2:256,maxRequestsPerSource:64};
    const f=await fixture(t,{limits}),requests=[];
    const artifact=await f.client(0).uploadArtifact(Buffer.alloc(8*1024*1024,42),'text/plain');
    t.after(()=>requests.forEach(req=>req.destroy()));
    const start=async index=>{
      const options=f.signed(index,'GET',artifactRoute(artifact));
      return new Promise((resolve,reject)=>{
        const req=httpRequest(f.origin+base+artifactRoute(artifact),{method:'GET',headers:options.headers},res=>{res.pause();resolve({req,res});});
        requests.push(req);req.on('error',reject);req.end();
      });
    };
    const first=await start(0);assert.equal(first.res.statusCode,200);
    let second;
    if(mode==='global'){
      await f.client(1).uploadArtifact(Buffer.alloc(8*1024*1024,42),'text/plain');
      second=await start(1);assert.equal(second.res.statusCode,200);
    }
    const capped=await start(0);capped.res.resume();
    assert.equal(capped.res.statusCode,429);
    assert.equal(f.handler.pendingDownloads,mode==='global'?2:1);
    if(mode==='request')assert.equal((await f.raw(0,'GET','/quotas')).status,200,'request cap reserves a short read');
    first.req.destroy();
    await eventually(()=>f.handler.pendingDownloads===(mode==='global'?1:0),'abort must release transfer slot');
    const replacement=await start(0);assert.equal(replacement.res.statusCode,200);
    replacement.req.destroy();second?.req.destroy();
    await eventually(()=>f.handler.pendingDownloads===0,'download slots leaked');
    assert.equal((await f.raw(0,'GET','/quotas')).status,200);
  });
}

test('artifact download deadline releases a paused stream and admission', {timeout:3000}, async t => {
  const f=await fixture(t,{limits:{maxDownloads:1,downloadTimeoutMs:60}});
  const artifact=await f.client(0).uploadArtifact(Buffer.alloc(8*1024*1024,43),'text/plain');
  const options=f.signed(0,'GET',artifactRoute(artifact));let req;
  const res=await new Promise((resolve,reject)=>{
    req=httpRequest(f.origin+base+artifactRoute(artifact),{headers:options.headers},resolve);
    req.on('error',reject);req.end();
  });
  t.after(()=>req.destroy());res.pause();
  await eventually(()=>f.handler.pendingDownloads===0,'deadline must release paused download');
  assert.equal((await f.raw(0,'GET','/quotas')).status,200);
});


test('download stream errors close descriptors and release every transfer slot', async t => {
  const streams=[];
  const f=await fixture(t,{limits:{maxDownloads:1,maxDownloadsPerDevice:1},downloadIO:{createReadStream(path){
    const stream=createReadStream(path);streams.push(stream);
    process.nextTick(()=>stream.destroy(new Error('test-only read failure')));return stream;
  }}});
  const artifact=await f.client(0).uploadArtifact(Buffer.from('read failure fixture'),'text/plain');
  for(let n=0;n<2;n++) {
    await assert.rejects(async()=>{const res=await f.raw(0,'GET',artifactRoute(artifact));await res.arrayBuffer();});
    await eventually(()=>f.handler.pendingDownloads===0&&streams.every(stream=>stream.closed),'read error leaked file descriptor or slot');
  }
  assert.equal((await f.raw(0,'HEAD',artifactRoute(artifact))).status,200);
  await unlinkFile(join(f.blobDir,artifact.digest.slice(7)));
  await problem(await f.raw(0,'GET',artifactRoute(artifact)),404,'not_found');
  assert.equal(f.handler.pendingDownloads,0,'missing disk blob must release reserved slot');
});

test('finished downloads release the per-device allowance for the next response', async t => {
  const f=await fixture(t,{limits:{maxDownloads:1,maxDownloadsPerDevice:1}});
  const bytes=Buffer.from('completed response'),artifact=await f.client(0).uploadArtifact(bytes,'text/plain');
  for(let n=0;n<2;n++){
    const res=await f.raw(0,'GET',artifactRoute(artifact));assert.equal(res.status,200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);
    await eventually(()=>f.handler.pendingDownloads===0,'finish must release download slot');
  }
});

for(const mode of ['abort','deadline','shutdown']) {
  test('download '+mode+' releases admission while filesystem stat is pending', {timeout:3000}, async t => {
    let resolveStat,opens=0;
    const f=await fixture(t,{limits:{maxDownloads:1,downloadTimeoutMs:80},downloadIO:{
      stat:()=>new Promise(resolve=>{resolveStat=resolve;}),
      createReadStream(path){opens++;return createReadStream(path);}
    }});
    const artifact=await f.client(0).uploadArtifact(Buffer.from('pending stat fixture'),'text/plain');
    const options=f.signed(0,'GET',artifactRoute(artifact));
    const req=httpRequest(f.origin+base+artifactRoute(artifact),{headers:options.headers},res=>res.resume());
    req.on('error',()=>{});t.after(()=>req.destroy());req.end();
    await eventually(()=>f.handler.pendingDownloads===1,'download never reserved');
    if(mode==='abort')req.destroy();
    if(mode==='shutdown')f.handler.close();
    await eventually(()=>f.handler.pendingDownloads===0,'pending stat retained download admission');
    resolveStat({isFile:()=>true,size:artifact.bytes});await tick();await tick();
    assert.equal(opens,0,'cancelled stat completion must not open a late stream');
    if(mode==='shutdown')f.restartHandler();
    assert.equal((await f.raw(0,'GET','/quotas')).status,200);
  });
}

test('download keeps an error consumer through asynchronous stream destruction', async t => {
  const bytes=Buffer.from('late stream close error');let stream;
  const f=await fixture(t,{downloadIO:{createReadStream(){
    stream=new Readable({read(){this.push(bytes);this.push(null);},destroy(error,callback){setImmediate(()=>callback(new Error('test-only close failure')));}});
    return stream;
  }}});
  const artifact=await f.client(0).uploadArtifact(bytes,'text/plain');
  const response=await f.raw(0,'GET',artifactRoute(artifact));
  await response.arrayBuffer().catch(()=>{});
  await eventually(()=>stream.closed&&f.handler.pendingDownloads===0,'stream destruction must release capacity');
});

test('removal prevents a download waiting on stat from sending headers or opening a stream',async t=>{
  const lookups=[];let opens=0;
  const f=await fixture(t,{downloadIO:{stat:()=>new Promise(resolve=>{lookups.push(resolve);}),
    createReadStream(path){opens++;return createReadStream(path);}}});
  const artifact=await f.client(1).uploadArtifact(Buffer.from('removed during stat'),'text/plain');
  await f.client(0).uploadArtifact(Buffer.from('removed during stat'),'text/plain');
  const pending=f.raw(1,'GET',artifactRoute(artifact)).then(async response=>({status:response.status,body:await response.text()}),()=>({aborted:true}));
  await eventually(()=>lookups.length===1,'GET stat never started');
  const head=f.raw(1,'HEAD',artifactRoute(artifact)).then(r=>({status:r.status}),()=>({aborted:true}));
  await eventually(()=>lookups.length===2,'HEAD stat never started');
  const owner=f.raw(0,'GET',artifactRoute(artifact)).then(async r=>({status:r.status,body:await r.text()}));
  await eventually(()=>lookups.length===3,'owner stat never started');
  const next=p.signEnvelope('roster',{...vectors.roster.payload,epoch:8,members:[vectors.roster.payload.members[0]]},keys[2]);
  assert.equal((await f.raw(0,'PUT','/roster',next,{epoch:8})).status,200);f.epoch=8;
  lookups[0]({isFile:()=>true,size:artifact.bytes});lookups[1]({isFile:()=>true,size:artifact.bytes});
  const outcome=await pending;
  assert.notEqual(outcome.status,200);assert.notEqual((await head).status,200);assert.equal(opens,0);
  lookups[2]({isFile:()=>true,size:artifact.bytes});
  assert.deepEqual(await owner,{status:200,body:'removed during stat'});
  await eventually(()=>f.handler.pendingDownloads===0,'revoked stat leaked download admission');
  await problem(await f.raw(1,'GET',artifactRoute(artifact)),403,'forbidden');
  assert.equal((await f.raw(1,'HEAD',artifactRoute(artifact))).status,403);
});

test('removal closes only the removed device stream and releases its transfer slots',async t=>{
  const streams=[];
  const f=await fixture(t,{downloadIO:{createReadStream(){const stream=new Readable({read(){}});streams.push(stream);return stream;}}});
  const artifact=await f.client(0).uploadArtifact(Buffer.from('shared published input'),'text/plain');
  await f.client(1).uploadArtifact(Buffer.from('shared published input'),'text/plain');
  const removed=f.raw(1,'GET',artifactRoute(artifact)).then(async r=>{await r.arrayBuffer();},()=>{}).catch(()=>{});
  await eventually(()=>streams.length===1,'removed member stream never opened');
  const kept=f.raw(0,'GET',artifactRoute(artifact)).then(async r=>Buffer.from(await r.arrayBuffer()));
  await eventually(()=>streams.length===2,'owner stream never opened');
  const next=p.signEnvelope('roster',{...vectors.roster.payload,epoch:8,members:[vectors.roster.payload.members[0]]},keys[2]);
  assert.equal((await f.raw(0,'PUT','/roster',next,{epoch:8})).status,200);f.epoch=8;
  const wasDestroyed=streams[0].destroyed;
  streams[0].destroy();streams[1].push(Buffer.from('shared published input'));streams[1].push(null);
  await removed;assert.deepEqual(await kept,Buffer.from('shared published input'));
  assert.equal(wasDestroyed,true,'removal must destroy the admitted stream');
  await eventually(()=>f.handler.pendingDownloads===0,'revocation leaked transfer slots');
});

['readable','unreadable','rejected'].forEach(outcome=>test('roster '+outcome+' outcome reconciles admitted downloads after a COMMIT acknowledgement error',async t=>{
  const streams=[],bytes=Buffer.from('test-only removal commit acknowledgement');
  const f=await fixture(t,{downloadIO:{createReadStream(){const stream=new Readable({read(){}});streams.push(stream);return stream;}}});
  const artifact=await f.client(0).uploadArtifact(bytes,'text/plain');await f.client(1).uploadArtifact(bytes,'text/plain');
  const read=index=>f.raw(index,'GET',artifactRoute(artifact)).then(async response=>({status:response.status,body:Buffer.from(await response.arrayBuffer())})).catch(()=>({aborted:true}));
  const removed=read(1);await eventually(()=>streams.length===1,'member download did not open');
  const owner=read(0);await eventually(()=>streams.length===2,'owner download did not open');
  const next=p.signEnvelope('roster',{...vectors.roster.payload,epoch:8,members:[vectors.roster.payload.members[0]]},keys[2]);
  if(outcome==='rejected')next.payload.epoch=9; // invalidate only the roster signature, not the transport proof
  const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;
  let armed=outcome!=='rejected',unreadable=false,committed=false;
  const fault=t.mock.method(DatabaseSync.prototype,'exec',function(sql){
    const result=exec.call(this,sql);
    if(armed&&sql==='COMMIT'){
      armed=false;committed=true;unreadable=outcome==='unreadable';
      throw new Error('test-only lost COMMIT acknowledgement');
    }
    return result;
  });
  const readFault=t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
    if(unreadable&&sql==='SELECT data FROM circle WHERE id=?')throw new Error('test-only unreadable durable membership');
    return prepare.call(this,sql);
  });
  const response=await f.raw(0,'PUT','/roster',next,{epoch:8});
  fault.mock.restore();readFault.mock.restore();
  assert.equal(response.status,outcome==='rejected'?401:500);await response.arrayBuffer();
  assert.equal(committed,outcome!=='rejected');
  if(committed)f.epoch=8;
  const memberDestroyed=streams[0].destroyed,ownerDestroyed=streams[1].destroyed;
  // Settle both readers before assertions, including when the security check fails.
  if(outcome==='rejected'){streams[0].push(bytes);streams[0].push(null);}else streams[0].destroy();
  if(outcome==='unreadable')streams[1].destroy();else{streams[1].push(bytes);streams[1].push(null);}
  const memberResult=await removed,ownerResult=await owner;
  assert.equal((await f.raw(1,'HEAD',artifactRoute(artifact))).status,committed?403:200,'new requests observe the durable membership');
  assert.equal(memberDestroyed,committed,'committed removal cancels the admitted reader; rejection does not');
  assert.equal(ownerDestroyed,outcome==='unreadable','unreadable membership cancels conservatively within this circle');
  if(outcome==='rejected')assert.deepEqual(memberResult,{status:200,body:bytes});
  if(outcome!=='unreadable')assert.deepEqual(ownerResult,{status:200,body:bytes});
  await eventually(()=>f.handler.pendingDownloads===0,'uncertain removal leaked download admission');
}));

test('cache quota rejection of job deletion preserves retained artifact files', async t => {
  const f=await fixture(t,{quotas:{idempotencyRowsPerDevice:2}}),author=f.client(0);
  const payload=await f.job(author),published=await author.submitJob(payload);
  await author.cancelJob(published.jobDigest);
  const before=readdirSync(f.blobDir).sort();
  await assert.rejects(author.deleteJob(published.jobDigest),error=>error.code==='quota_exceeded');
  assert.deepEqual(readdirSync(f.blobDir).sort(),before,'rolled-back deletion must not unlink live files');
  assert.equal((await f.raw(0,'GET',artifactRoute(payload.prompt))).status,200);
});

function withClientVersion(f, index, method, route, body, clientVersion, options = {}) {
  const init = f.signed(index, method, route, body, options);
  if (clientVersion !== undefined) init.headers['Faravan-Version'] = clientVersion;
  return fetch(f.origin + base + route, init);
}

test('v1 configured minimum rejects unknown, old, and unreadable mutation versions before changes', async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.12.0' } });
  const minimum = '0.12.0';
  const before = readdirSync(f.blobDir);
  for (const version of [undefined, 'unknown', '0.11.99', 'nightly', '0.12.0-beta', '9007199254740992.0.0']) {
    for (const [method, route, body, options] of [
      ['POST', '/jobs', vectors.job],
      ['POST', '/jobs/claim-next', { advertisement: ad, wait_seconds: 0 }],
      ['POST', '/heartbeat', {}],
      ['PUT', '/artifacts/' + ref(candidate).digest.slice(7), candidate, { mediaType: 'text/plain' }]
    ]) {
      const response = await withClientVersion(f, 0, method, route, body, version, options);
      const error = await problem(response, 409, 'client_update_required');
      assert.equal(error.min_member, minimum);
      assert.equal(error.client_version, /^\d+\.\d+\.\d+$/.test(version ?? '') && version !== '9007199254740992.0.0' ? version : null);
      assert.equal(error.retryable, false);
      assert.equal(error.detail, 'Update Faravan to 0.12.0 or newer before making changes.');
    }
  }
  assert.deepEqual(readdirSync(f.blobDir), before, 'blocked artifact uploads create no files');
  const jobs = await (await f.raw(0, 'GET', '/jobs')).json();
  assert.deepEqual(jobs.items, [], 'blocked publishing creates no jobs');
  assert.equal((await f.raw(0, 'HEAD', artifactRoute(ref(candidate)))).status, 404);
});

test('v1 configured minimum preserves discovery, reads, and enrollment without a client version', async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.12.0' } });
  assert.equal((await f.client(0).capabilities()).min_member, '0.12.0');
  for (const route of ['/roster', '/presence', '/quotas', '/jobs']) {
    assert.equal((await f.raw(0, 'GET', route)).status, 200, route);
  }
  const updated = f.client(0, false, { clientVersion: '0.12.0' });
  const artifact = await updated.uploadArtifact(candidate, 'text/x-diff');
  assert.equal((await f.raw(0, 'HEAD', artifactRoute(artifact))).status, 200);
  assert.equal((await f.raw(0, 'GET', artifactRoute(artifact))).status, 200);
  const invite = p.createInvite({ circle, coordinator: f.origin, invite_id: randomUUID(),
    invite_public_key: pubs[3], created_at: iso(f.now), expires_at: iso(f.now + 3600) }, keys[2]);
  await updated.registerInvite(invite);
  const body = { invite, device_public_key: pubs[3], enrollment_proof: p.createEnrollmentProof({
    circle, invite_id: invite.payload.invite_id, device_public_key: pubs[3] }, keys[3]) };
  const enrollment = await f.raw(3, 'POST', '/enrollments', body, { epoch: 0 });
  assert.equal(enrollment.status, 202);
  const pending = await enrollment.json();
  assert.equal((await f.raw(3, 'GET', '/enrollments/' + pending.enrollment_id, undefined, { epoch: 0 })).status, 200);
});

test('v1 minimum is inclusive, newer versions pass, and blocked requests do not poison idempotency', async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.12.0' } });
  const body = { advertisement: ad, wait_seconds: 0 }, options = { idempotencyKey: 'version-retry' };
  await problem(await withClientVersion(f, 1, 'POST', '/jobs/claim-next', body, '0.11.9', options), 409, 'client_update_required');
  for (const version of ['0.12.0', '0.12.1', '0.13.0', '1.0.0']) {
    assert.equal((await withClientVersion(f, 1, 'POST', '/jobs/claim-next', body, version, options)).status, 204, version);
  }
  await problem(await withClientVersion(f, 1, 'POST', '/jobs/claim-next', body, undefined, options), 409, 'client_update_required');
  await problem(await withClientVersion(f, 0, 'PUT', '/roster', vectors.roster, '0.11.9'), 409, 'client_update_required');
  assert.equal(f.store.configuration().epoch, 7);
  assert.equal((await withClientVersion(f, 0, 'PUT', '/roster', vectors.roster, '0.12.0')).status, 200);
  // Recovery cannot be version-gated until body authentication; keep that bootstrap route compatible.
  const next = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 8,
    members: [...vectors.roster.payload.members, { key_id: ids[3], public_key: pubs[3], joined_epoch: 8 }] }, keys[2]);
  assert.equal((await withClientVersion(f, 3, 'PUT', '/roster', next, undefined, { epoch: 8 })).status, 200);
});

test('v1 no configured minimum preserves legacy mutations with absent or unreadable headers', async t => {
  const f = await fixture(t);
  for (const version of [undefined, 'unknown', 'nightly', '0.0.1']) {
    assert.equal((await withClientVersion(f, 1, 'POST', '/jobs/claim-next',
      { advertisement: ad, wait_seconds: 0 }, version)).status, 204);
    assert.equal((await withClientVersion(f, 0, 'PUT', artifactRoute(ref(candidate)),
      candidate, version, { mediaType: 'text/plain' })).status, 200);
  }
});

test('v1 update-required errors follow authentication and preserve precise client details', async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.12.0' } });
  const body = { advertisement: ad, wait_seconds: 0 };
  await problem(await f.raw(3, 'POST', '/jobs/claim-next', body), 403, 'forbidden');
  const forged = f.signed(0, 'POST', '/jobs/claim-next', body);
  const envelope = p.strictParse(Buffer.from(forged.headers['Faravan-Proof'], 'base64url'));
  const signature = Buffer.from(envelope.signature.value, 'base64url'); signature[32] ^= 1;
  envelope.signature.value = signature.toString('base64url');
  forged.headers['Faravan-Proof'] = Buffer.from(p.canonicalize(envelope)).toString('base64url');
  await problem(await fetch(f.origin + base + '/jobs/claim-next', forged), 401, 'invalid_signature');
  await assert.rejects(f.client(1).claimNext(ad, { waitSeconds: 0 }), error => {
    assert.equal(error.code, 'client_update_required'); assert.equal(error.status, 409);
    assert.equal(error.retryable, false); assert.equal(error.outcome, 'not_applied');
    assert.equal(error.problem.min_member, '0.12.0'); assert.equal(error.problem.client_version, null);
    return true;
  });
});

test('v1 handler reads the store runtime version policy', async t => {
  const f = await fixture(t, { versions: { faravan: '0.12.1', minMember: '0.10.0' },
    versionPolicy: { faravanVersion: '0.12.1', minMember: '0.12.0' } });
  const body = { advertisement: ad, wait_seconds: 0 };
  const rejected = await problem(await withClientVersion(f, 1, 'POST', '/jobs/claim-next', body, '0.11.0'), 409, 'client_update_required');
  assert.equal(rejected.min_member, '0.12.0');
  assert.equal((await withClientVersion(f, 1, 'POST', '/jobs/claim-next', body, '0.12.0')).status, 204);
});

test('v1 handler rejects an unreadable configured minimum rather than silently disabling it', async t => {
  const f = await fixture(t);
  const invalid = new Proxy(f.store, { get(target, name) {
    return name === 'versionPolicy' ? () => ({ minMember: 'nightly' }) : target[name];
  } });
  assert.throws(() => createV1Handler({ store: invalid, blobDir: join(f.dir, 'invalid-policy') }),
    error => error.code === 'invalid_request');
  assert.throws(() => createV1Handler({ store: { ...f.store, versionPolicy: undefined },
    blobDir: join(f.dir, 'invalid-fallback'), minMember: '9007199254740992.0.0' }),
    error => error.code === 'invalid_request');
});

test('four open job watches leave room for offers and claim polls from the same device',async t=>{
  const f=await fixture(t),client=f.client(0),jobs=[];
  for(let n=0;n<4;n++)jobs.push((await client.submitJob(await f.job(client))).jobDigest);
  const offers=await (await f.raw(0,'GET','/offers')).json();
  const routes=[];
  for(const digest of jobs){
    const route='/jobs/'+digest.slice(7)+'/watch?wait=30';
    const first=await (await f.raw(0,'GET',route)).json();
    routes.push(route+'&after='+encodeURIComponent(first.revision));
  }
  const stop=new AbortController(),waiting=[];
  const begin=(method,route,body)=>{
    const pending=fetch(f.origin+base+route,{...f.signed(0,method,route,body),signal:stop.signal})
      .then(async response=>({status:response.status,body:await response.text()})).catch(()=>null);
    waiting.push(pending);return pending;
  };
  try {
    routes.forEach(route=>begin('GET',route));
    await eventually(()=>f.handler.pendingPolls===4,'four watches did not stay open');
    await problem(await f.raw(0,'GET',routes[0]),429,'rate_limited');
    begin('GET','/offers?wait=30&since='+offers.revision);
    await eventually(()=>f.handler.pendingPolls===5,'offers poll was blocked by job watches');
    begin('POST','/jobs/claim-next',{advertisement:ad,wait_seconds:30,exclude:jobs});
    await eventually(()=>f.handler.pendingPolls===6,'claim poll was blocked by job watches');
  } finally {stop.abort();await Promise.all(waiting);}
  await eventually(()=>f.handler.pendingPolls===0,'closed polls retained admission');
});
