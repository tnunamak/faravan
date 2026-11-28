import './helpers/no-browser.mjs';
import {fixtureAccounts,accountHeartbeat} from './helpers/run-request-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { HOST_CAPABILITIES } from '../lib/v1/versions.mjs';

// Frozen audience: a job signed with payload.audience.device_keys is visible only to those devices.
// A device that joins the circle later cannot list, read, claim or download anything that belongs only to it.
// All keys are public TEST-ONLY fixtures; no network beyond loopback, no provider or model calls.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pub = keys.map(p.exportPublicKey), fp = pub.map(p.fingerprint);
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k, v]) => [k, v.envelope]));
const circle = vectors.job.payload.circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const segment = digest => digest.slice(7);
// keys[0] author, keys[1] lender (both in the initial roster), keys[2] root, keys[3] joins later.
const AUTHOR = 0, LENDER = 1, ROOT = 2, LATER = 3;
const advertisement = {
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output','run_request_v1'], accounts:fixtureAccounts(),
  egress: ['provider-only'], enforced_limits: Object.keys(vectors.job.payload.requirements.limits),
  max_limits: vectors.job.payload.requirements.limits,
};
const snapshot = () => ({ device_keys: vectors.roster.payload.members.map(m => m.key_id) });
const code = (fn, expected) => assert.throws(fn,
  error => error instanceof p.ProtocolError && error.code === expected, 'expected ProtocolError ' + expected);
const ref = (label, media_type = 'text/plain') => {
  const bytes = Buffer.from('test-only ' + label);
  return { digest: p.digestBytes(bytes), bytes: bytes.length, media_type };
};

function storeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-audience-'));
  const origin = 'https://coordinator.example', base = origin + '/v1/circles/' + circle;
  let now = start, sequence = 0, epoch = 7;
  const store = openV1Store({ path: join(dir, 'store.sqlite'), circle, origin, rootFingerprint: fp[ROOT],
    initialRoster: vectors.roster, clock: () => now,
    idGenerator: () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + (++sequence).toString(16).padStart(12, '0') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = {
    store, get now() { return now; }, advance(n) { now += n; },
    ctx(device, method, route, body) {
      const read = method === 'GET' || method === 'HEAD';
      return { proof: p.buildRequestProof({ circle, roster_epoch: epoch, method, target: base + route,
        body: read ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body)),
        content_type: read ? '' : 'application/json', artifact_media_type: '',
        idempotency_key: method === 'POST' ? randomUUID() : '', created: now,
        nonce: randomBytes(16).toString('base64url') }, keys[device]) };
    },
    upload(r, device = AUTHOR) {
      const route = '/artifacts/' + segment(r.digest);
      const reservation = store.reserveArtifact(fp[device], r, { proof: p.buildRequestProof({ circle, roster_epoch: epoch,
        method: 'PUT', target: base + route, body_digest: r.digest, content_length: r.bytes,
        content_type: 'application/octet-stream', artifact_media_type: r.media_type, idempotency_key: '',
        created: now, nonce: randomBytes(16).toString('base64url') }, keys[device]) });
      const commit = '/artifact-reservations/' + reservation.reservation_id + '/commit';
      return store.commitArtifact(fp[device], reservation.reservation_id, r, f.ctx(device, 'POST', commit, r));
    },
    job(overrides = {}, device = AUTHOR) {
      return p.signEnvelope('job', { ...vectors.job.payload, author: fp[device], roster_epoch: epoch,
        intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600), ...overrides }, keys[device]);
    },
    publish(job, device = AUTHOR) { return store.publishJob(job, f.ctx(device, 'POST', '/jobs', job)); },
    join(device = LATER) {
      const members = [...vectors.roster.payload.members, { key_id: fp[device], public_key: pub[device], joined_epoch: epoch + 1 }];
      const roster = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: epoch + 1, members }, keys[ROOT]);
      const ctx = { proof: p.buildRequestProof({ circle, roster_epoch: epoch + 1, method: 'PUT', target: base + '/roster',
        body: Buffer.from(p.canonicalize(roster)), content_type: 'application/json', artifact_media_type: '',
        idempotency_key: '', created: now, nonce: randomBytes(16).toString('base64url') }, keys[AUTHOR]) };
      store.installRoster(roster, ctx); epoch += 1;
    },
    claim(digest, device = LENDER) {
      const heartbeat=accountHeartbeat(advertisement.accounts);
      store.heartbeat(fp[device],heartbeat,f.ctx(device,'POST','/heartbeat',heartbeat));
      const body = { advertisement, lease_seconds: 120 };
      return store.claimJob(fp[device], digest, advertisement, f.ctx(device, 'POST', '/jobs/' + segment(digest) + '/claim', body), 120);
    },
    claimNext(device) {
      const heartbeat=accountHeartbeat(advertisement.accounts);
      store.heartbeat(fp[device],heartbeat,f.ctx(device,'POST','/heartbeat',heartbeat));
      return store.claimNext(fp[device], advertisement, f.ctx(device, 'POST', '/jobs/claim-next', { advertisement, lease_seconds: 120 }), 120);
    },
    start(a, device = LENDER) {
      return store.start(fp[device], a.attempt_id, a.generation, f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/start', { generation: a.generation }));
    },
    complete(job, a, device = LENDER) {
      const result = p.signEnvelope('result', { ...vectors.result.payload, job_digest: p.digest(job.payload),
        attempt_id: a.attempt_id, generation: a.generation, executor: fp[device], roster_epoch: epoch,
        submitted_at: iso(now),receipt:{...vectors.result.payload.receipt,selection:a.selection,model:a.selection.modelId,
          capabilities_applied:[...vectors.result.payload.receipt.capabilities_applied,'run_request_v1']} }, keys[device]);
      return store.complete(result, f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/complete', result));
    },
    progress(digest, a, device = LENDER) {
      const body = { attempt: a.attempt_id, step: 'test-only step', kind: 'step' };
      return store.postProgress(fp[device], digest, body, f.ctx(device, 'POST', '/jobs/' + segment(digest) + '/progress', body));
    },
    reads(device, digest) {
      const s = segment(digest);
      return {
        get: () => store.getJob(fp[device], digest, f.ctx(device, 'GET', '/jobs/' + s)),
        result: () => store.getResult(fp[device], digest, f.ctx(device, 'GET', '/jobs/' + s + '/result')),
        progress: () => store.getProgress(fp[device], digest, {}, f.ctx(device, 'GET', '/jobs/' + s + '/progress')),
        retention: () => store.getRetention(fp[device], digest, f.ctx(device, 'GET', '/jobs/' + s + '/retention')),
        remove: () => store.deleteJob(fp[device], digest, f.ctx(device, 'POST', '/jobs/' + s + '/delete', {})),
        attempt: id => store.getAttempt(fp[device], id, f.ctx(device, 'GET', '/attempts/' + id)),
        artifact: (d, method = 'GET') => store.getArtifact(fp[device], d, f.ctx(device, method, '/artifacts/' + segment(d)), method),
        list: () => store.listJobs(fp[device], { limit: 50, accepts:['run_request_v1','results_v1'] }, f.ctx(device, 'GET', '/jobs?limit=50')).items.map(i => i.job_digest),
        offers: () => {
          const poll = store.openOffersPoll(fp[device], { limit: 50, accepts:['run_request_v1','results_v1'] }, { ...f.ctx(device, 'GET', '/offers?limit=50'), route: '/offers?limit=50', bodyBytes: Buffer.alloc(0) });
          try { return poll.poll().items.map(i => i.job_digest); } finally { poll.close(); }
        },
        cancel: () => {
          const c = p.signEnvelope('cancellation', { schema: 'faravan.cancellation.v1', circle, job_digest: digest,
            author: fp[device], roster_epoch: epoch, created_at: iso(now), reason: 'test-only' }, keys[device]);
          return store.cancel(c, f.ctx(device, 'POST', '/jobs/' + s + '/cancel', c));
        },
      };
    },
  };
  return f;
}
function inputs(f) {
  f.upload(vectors.job.payload.source.artifact);
  f.upload(vectors.job.payload.prompt);
  f.upload(vectors.result.payload.candidate, LENDER);
  f.upload(vectors.result.payload.transcript, LENDER);
}

test('protocol: audience is an optional signed field that must name its author', () => {
  const payload = { ...vectors.job.payload };
  const sign = audience => p.signEnvelope('job', { ...payload, audience }, keys[AUTHOR]);
  const signed = sign(snapshot());
  assert.ok(p.verifyEnvelope('job', signed, pub[AUTHOR]).ok);
  assert.deepEqual(signed.payload.audience, snapshot());
  assert.notEqual(p.digest(signed.payload), p.digest(vectors.job.payload), 'the audience is covered by the signature');
  assert.ok(p.verifyEnvelope('job', vectors.job, pub[AUTHOR]).ok, 'a job without an audience is unchanged');
  for (const bad of [
    { device_keys: [fp[LENDER]] },                       // author missing
    { device_keys: [fp[AUTHOR], fp[AUTHOR]] },           // duplicate
    { device_keys: [] },
    { device_keys: ['sha256:XYZ'] },
    { device_keys: [fp[AUTHOR]], extra: true },
    { members: [fp[AUTHOR]] },
    [fp[AUTHOR]],
  ]) code(() => sign(bad), 'invalid_request');
  // A tampered audience no longer verifies.
  const tampered = structuredClone(signed); tampered.payload.audience.device_keys.push(fp[LATER]);
  assert.equal(p.verifyEnvelope('job', tampered, pub[AUTHOR]).code, 'invalid_signature');
  assert.equal(p.audienceAllows(signed.payload, fp[LENDER]), true);
  assert.equal(p.audienceAllows(signed.payload, fp[LATER]), false);
  assert.equal(p.audienceAllows(vectors.job.payload, fp[LATER]), true, 'no audience means everyone in the circle');
  assert.ok(HOST_CAPABILITIES.includes('frozen_audience_v1'));
});

test('publish validates every audience key against the roster the job was signed at', t => {
  const f = storeFixture(t); inputs(f);
  code(() => f.publish(f.job({ audience: { device_keys: [fp[AUTHOR], fp[LATER]] } })), 'invalid_request');
  const subset = f.job({ audience: { device_keys: [fp[AUTHOR]] } });
  assert.equal(f.publish(subset).state, 'queued', 'a subset of the roster is allowed');
  code(() => f.claim(p.digest(subset.payload)), 'not_found');
});

test('a later joiner cannot list, read, claim, cancel, delete or download a frozen job', t => {
  const f = storeFixture(t); inputs(f);
  const job = f.job({ audience: snapshot() }), digest = p.digest(job.payload);
  f.publish(job);
  f.join(LATER);
  const later = f.reads(LATER, digest), author = f.reads(AUTHOR, digest), lender = f.reads(LENDER, digest);
  assert.deepEqual(later.list(), [], 'not listed');
  code(later.get, 'not_found'); code(later.retention, 'not_found');
  code(() => f.claim(digest, LATER), 'not_found');
  assert.equal(f.claimNext(LATER), null, 'claim-next skips it');
  for (const d of [vectors.job.payload.prompt.digest, vectors.job.payload.source.artifact.digest])
    for (const method of ['GET', 'HEAD']) code(() => later.artifact(d, method), 'not_found');
  code(later.cancel, 'not_found');

  // Snapshot members keep full access.
  assert.deepEqual(author.list(), [digest]); assert.deepEqual(lender.list(), [digest]);
  assert.equal(lender.artifact(vectors.job.payload.prompt.digest).digest, vectors.job.payload.prompt.digest);
  const { attempt } = f.claim(digest, LENDER);
  f.start(attempt); f.progress(digest, attempt);
  code(() => later.attempt(attempt.attempt_id), 'not_found');
  code(later.progress, 'not_found');
  assert.equal(author.progress().entries.length, 1);
  f.complete(job, attempt);
  code(later.result, 'not_found');
  for (const d of [vectors.result.payload.candidate.digest, vectors.result.payload.transcript.digest])
    for (const method of ['GET', 'HEAD']) code(() => later.artifact(d, method), 'not_found');
  assert.equal(author.result().payload.job_digest, digest);
  assert.equal(author.artifact(vectors.result.payload.candidate.digest).digest, vectors.result.payload.candidate.digest);
  code(later.remove, 'not_found');
  assert.equal(author.remove().deleted, true);
  code(later.remove, 'not_found', 'the tombstone keeps the audience');
});

test('an unfrozen job keeps today\'s behaviour for a later joiner', t => {
  const f = storeFixture(t); inputs(f);
  const job = f.job(), digest = p.digest(job.payload);
  f.publish(job); f.join(LATER);
  const later = f.reads(LATER, digest);
  assert.deepEqual(later.list(), [digest]);
  assert.equal(later.get().job_digest, digest);
  assert.equal(later.artifact(vectors.job.payload.prompt.digest).digest, vectors.job.payload.prompt.digest);
  assert.equal(f.claim(digest, LATER).attempt.holder, fp[LATER]);
});

test('a shared content-addressed artifact is readable only through a job the device may see', t => {
  const f = storeFixture(t); inputs(f);
  const secretSource = ref('frozen-only source', 'application/gzip'); f.upload(secretSource);
  const frozen = f.job({ audience: snapshot(), source: { kind: 'archive', artifact: secretSource } });
  f.publish(frozen); f.join(LATER);
  const later = f.reads(LATER, p.digest(frozen.payload));
  const prompt = vectors.job.payload.prompt.digest;
  code(() => later.artifact(prompt), 'not_found');
  // The author later sends an ordinary job with the same prompt bytes: the prompt is now readable, the frozen source is not.
  f.publish(f.job());
  assert.equal(later.artifact(prompt).digest, prompt);
  assert.equal(later.artifact(prompt, 'HEAD').digest, prompt);
  code(() => later.artifact(secretSource.digest), 'not_found');
  code(() => later.artifact(secretSource.digest, 'HEAD'), 'not_found');
  // Knowing a digest does not grant access to an unpublished upload.
  const loose = ref('unreferenced'); f.upload(loose, LENDER);
  code(() => later.artifact(loose.digest), 'not_found');
  code(() => later.artifact(loose.digest, 'HEAD'), 'not_found');
  code(() => f.publish(f.job({prompt:loose}, LATER), LATER), 'not_found');
  assert.equal(f.reads(LENDER,p.digest(frozen.payload)).artifact(loose.digest).digest,loose.digest);
  f.upload(loose,LATER);
  assert.equal(later.artifact(loose.digest).digest,loose.digest,'uploading bytes proves possession');
});

test('unpublished result artifacts stay private after failed completion until a visible result references them', t => {
  const f=storeFixture(t);inputs(f);
  const job=f.job(),digest=p.digest(job.payload);f.publish(job);
  const author=f.reads(AUTHOR,digest),lender=f.reads(LENDER,digest),output=vectors.result.payload.candidate.digest;
  code(()=>author.artifact(output),'not_found');code(()=>author.artifact(output,'HEAD'),'not_found');
  assert.equal(lender.artifact(output).digest,output);
  const {attempt}=f.claim(digest);
  code(()=>f.complete(job,attempt),'conflict');
  code(()=>author.artifact(output),'not_found');
  f.start(attempt);f.complete(job,attempt);
  assert.equal(author.artifact(output).digest,output);
});

test('HTTP: GET and HEAD of a frozen job\'s artifacts return 404 to a later joiner and bytes to members', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-audience-http-'));
  let now = start, handler;
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port, base = '/v1/circles/' + circle;
  const store = openV1Store({ path: join(dir, 'store.sqlite'), origin, circle, rootFingerprint: fp[ROOT],
    initialRoster: vectors.roster, clock: () => now });
  handler = createV1Handler({ store, blobDir: join(dir, 'blobs'), clock: () => now });
  t.after(async () => { handler.close?.(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let epoch = 7;
  const raw = (index, method, route, body) => {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body));
    const read = method === 'GET' || method === 'HEAD', key = method === 'POST' ? randomUUID() : '';
    const proof = p.buildRequestProof({ circle, roster_epoch: method === 'PUT' ? body.payload.epoch : epoch, method,
      target: origin + base + route, body: bytes, content_type: read ? '' : 'application/json', artifact_media_type: '',
      idempotency_key: key, created: now, nonce: randomBytes(24).toString('base64url') }, keys[index]);
    const headers = { 'Faravan-Proof': proof, ...(read ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }),
      ...(key ? { 'Idempotency-Key': key } : {}) };
    return fetch(origin + base + route, { method, headers, ...(read ? {} : { body: bytes }) });
  };
  const client = createClient({ origin, circle, deviceKey: keys[AUTHOR], pinnedRootFingerprint: fp[ROOT],
    rosterCache: (() => { let s = { current: vectors.roster, history: [], highestAcceptedEpoch: 7, highestAcceptedDigest: p.digest(vectors.roster.payload) };
      return { get: async () => s, set: async v => { s = v; } }; })(), clock: () => now, retry: { maxAttempts: 1 } });
  const promptBytes = Buffer.from('test-only frozen prompt');
  const source = { kind: 'archive', artifact: await client.uploadArtifact(Buffer.from('test-only frozen source'), 'application/gzip') };
  const prompt = await client.uploadArtifact(promptBytes, 'text/plain');
  const job = p.signEnvelope('job', { ...vectors.job.payload, source, prompt, audience: snapshot(), roster_epoch: epoch,
    intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600) }, keys[AUTHOR]);
  assert.equal((await raw(LENDER,'GET','/artifacts/'+segment(prompt.digest))).status,404);
  assert.equal((await raw(LENDER,'HEAD','/artifacts/'+segment(prompt.digest))).status,404);
  const stolen=p.signEnvelope('job',{...job.payload,author:fp[LENDER],intent_id:randomUUID()},keys[LENDER]);
  assert.equal((await raw(LENDER,'POST','/jobs',stolen)).status,404,'unpublished bytes cannot be pinned by digest');
  assert.equal((await raw(AUTHOR, 'POST', '/jobs', job)).status, 201);
  const members = [...vectors.roster.payload.members, { key_id: fp[LATER], public_key: pub[LATER], joined_epoch: 8 }];
  const roster = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: 8, members }, keys[ROOT]);
  assert.equal((await raw(AUTHOR, 'PUT', '/roster', roster)).status, 200); epoch = 8;
  for (const r of [prompt, source.artifact]) {
    const route = '/artifacts/' + segment(r.digest);
    for (const method of ['GET', 'HEAD']) {
      const denied = await raw(LATER, method, route); assert.equal(denied.status, 404, method + ' ' + route); await denied.arrayBuffer();
    }
    const allowed = await raw(LENDER, 'GET', route); assert.equal(allowed.status, 200);
    assert.equal(Buffer.from(await allowed.arrayBuffer()).length, r.bytes);
  }
  const jobRoute = '/jobs/' + segment(p.digest(job.payload));
  const denied = await raw(LATER, 'GET', jobRoute); assert.equal(denied.status, 404); await denied.arrayBuffer();
  const listed = await (await raw(LATER, 'GET', '/jobs')).json(); assert.deepEqual(listed.items, []);
  assert.ok((await (await raw(LATER, 'GET', '/capabilities')).json()).capabilities.includes('frozen_audience_v1'));
  // A digest/length claim cannot prove possession: the duplicate fast path must still verify this sender's bytes.
  const put=async bytes=>{
    const proof=p.buildRequestProof({circle,roster_epoch:epoch,method:'PUT',target:origin+base+'/artifacts/'+segment(prompt.digest),
      body_digest:prompt.digest,content_length:prompt.bytes,content_type:'application/octet-stream',artifact_media_type:'text/plain',
      idempotency_key:'',created:now,nonce:randomBytes(24).toString('base64url')},keys[LATER]);
    return fetch(origin+base+'/artifacts/'+segment(prompt.digest),{method:'PUT',headers:{'Faravan-Proof':proof,'Content-Type':'application/octet-stream',
      'Content-Length':String(prompt.bytes),'Faravan-Media-Type':'text/plain'},body:bytes});
  };
  const invalid=await put(Buffer.alloc(prompt.bytes,120));assert.notEqual(invalid.status,200);await invalid.arrayBuffer();
  const stillDenied=await raw(LATER,'GET','/artifacts/'+segment(prompt.digest));assert.equal(stillDenied.status,404);await stillDenied.arrayBuffer();
  const valid=await put(promptBytes);assert.equal(valid.status,200);await valid.arrayBuffer();
  const possessed=await raw(LATER,'GET','/artifacts/'+segment(prompt.digest));assert.equal(possessed.status,200);
  assert.deepEqual(Buffer.from(await possessed.arrayBuffer()),promptBytes);

});

test('a later member cannot launder a protected artifact through a new public job',t=>{
  const f=storeFixture(t);inputs(f);
  const frozen=f.job({audience:snapshot()});f.publish(frozen);f.join(LATER);
  const {audience,...publicPayload}=frozen.payload;
  const forged=p.signEnvelope('job',{...publicPayload,author:fp[LATER],roster_epoch:8,intent_id:randomUUID()},keys[LATER]);
  code(()=>f.publish(forged,LATER),'not_found');
});

test('a later member can send identical bytes after completing their own verified upload',t=>{
  const f=storeFixture(t);inputs(f);f.publish(f.job({audience:snapshot()}));f.join(LATER);
  f.upload(vectors.job.payload.prompt,LATER);f.upload(vectors.job.payload.source.artifact,LATER);
  const own=f.job({},LATER);assert.equal(f.publish(own,LATER).state,'queued');
});

test('GET /offers never lists a frozen job to a later joiner', t => {
  const f = storeFixture(t); inputs(f);
  const frozen = f.job({ audience: snapshot() }), open = f.job();
  f.publish(frozen); f.publish(open);
  f.join(LATER);
  const frozenDigest = p.digest(frozen.payload), openDigest = p.digest(open.payload);
  assert.deepEqual(f.reads(LATER, frozenDigest).offers(), [openDigest], 'a later joiner sees only the unfrozen offer');
  assert.deepEqual(new Set(f.reads(LENDER, frozenDigest).offers()), new Set([frozenDigest, openDigest]), 'snapshot members see both');
  code(() => f.claim(frozenDigest, LATER), 'not_found');
});

test('an orphan blob requires sender bytes even when its digest has no artifact row',t=>{
  const f=storeFixture(t);
  assert.equal(f.store.requiresArtifactProof(fp[AUTHOR],ref('orphan bytes').digest),true);
});
