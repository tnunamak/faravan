import './helpers/no-browser.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createClient, ClientError } from '../lib/v1/client.mjs';
import { problemForError } from '../lib/v1/cli.mjs';
import {
  canonicalize, digest, digestBytes, privateKeyFromSeed, signEnvelope,
  verifyEnvelope, verifyRequestProof, createInvite, encodeInviteLink,
  verifyEnrollmentProof, createEnrollmentProof
} from '../lib/protocol/index.mjs';

// These repeated-byte keys are explicitly TEST-ONLY, with no real identity.
const vectors = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = vectors.keys.map(k => privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const ids = vectors.keys.map(k => k.fingerprint);
const pubs = vectors.keys.map(k => k.public_key);
const circle = vectors.objects.job.envelope.payload.circle;
const now = Date.parse('2026-10-09T12:02:00Z') / 1000;
const roster = vectors.objects.roster.envelope;
const job = vectors.objects.job.envelope;
const jobDigest = digest(job.payload);
const base = '/v1/circles/' + circle;
const jobPath = base + '/jobs/' + jobDigest.slice(7);
const candidate = Buffer.from('--- a/test\n+++ b/test\n');
const transcript = Buffer.from('{"test":true}\n');
const ref = (bytes, media_type) => ({ digest: digestBytes(bytes), bytes: bytes.length, media_type });
const clone = value => structuredClone(value);
const payload = () => ({
  ...clone(vectors.objects.result.envelope.payload),
  candidate: ref(candidate, 'text/x-diff'),
  transcript: ref(transcript, 'application/x-ndjson')
});
const attempt = (overrides = {}) => ({
  attempt_id: vectors.objects.result.envelope.payload.attempt_id,
  job_digest: jobDigest, generation: 1, holder: ids[1], state: 'completed',
  claimed_at: '2026-10-09T12:00:10Z', lease_expires_at: '2026-10-09T12:02:10Z',
  execution_started_at: '2026-10-09T12:00:10Z',
  reason: null, compute_stopped: true, stopped_at: '2026-10-09T12:01:00Z', ...overrides
});
const view = (overrides = {}) => ({
  job_digest: jobDigest, job, state: 'queued', attempts_started: 0,
  current_attempt: null, result_digest: null, ...overrides
});
const advertisement = {
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'],
  egress: ['provider-only'], enforced_limits: Object.keys(job.payload.requirements.limits),
  max_limits: job.payload.requirements.limits
};
function json(res, value, status = 200, headers = {}) {
  const bytes = Buffer.from(canonicalize(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, ...headers });
  res.end(bytes);
}
function problem(res, status, code, headers = {}, retryable = status >= 500 || status === 429) {
  json(res, { type: 'urn:faravan:problem:' + code, title: code, status, code,
    retryable, outcome: 'not_applied' }, status, { 'content-type': 'application/problem+json', ...headers });
}
function blob(res, bytes, mediaType = 'text/x-diff') {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length,
    'content-disposition': 'attachment', 'x-content-type-options': 'nosniff',
    ...(mediaType === null ? {} : { 'faravan-media-type': mediaType }) });
  res.end(bytes);
}
async function fixture(t, handler, options = {}) {
  const requests = [], nonces = new Set(), serverErrors = [];
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const proof = JSON.parse(Buffer.from(req.headers['faravan-proof'], 'base64url').toString());
      const keyIndex = ids.indexOf(proof.payload.key_id);
      assert.notEqual(keyIndex, -1);
      const verified = await verifyRequestProof(req.headers['faravan-proof'], {
        publicKey: pubs[keyIndex], now: () => now,
        expected: {
          circle, key_id: ids[keyIndex], roster_epoch: options.epoch ?? 7,
          method: req.method, target: origin + req.url,
          body_digest: digestBytes(body), content_length: body.length,
          content_type: req.headers['content-type'] ?? '',
          artifact_media_type: req.headers['faravan-media-type'] ?? '',
          idempotency_key: req.headers['idempotency-key'] ?? ''
        },
        consumeNonce: async (key, nonce) => {
          const value = key + ':' + nonce;
          if (nonces.has(value)) return false;
          nonces.add(value); return true;
        }
      });
      assert.equal(verified.ok, true, JSON.stringify(verified));
      assert.equal(proof.payload.created, now);
      if (body.length && req.headers['content-type'] === 'application/json') {
        assert.equal(body.toString(), canonicalize(JSON.parse(body.toString())));
      }
      const record = { req, res, body, proof, url: new URL(origin + req.url) };
      requests.push(record);
      await handler(record, requests);
    } catch (error) {
      serverErrors.push(error);
      if (!res.headersSent) problem(res, 400, 'invalid_request');
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(serverErrors, [], serverErrors.map(e => e.stack).join('\n'));
  });
  let snapshot = options.snapshot ?? { current: clone(roster), history: [],
    highestAcceptedEpoch: 7, highestAcceptedDigest: digest(roster.payload) };
  let randomCounter = 0;
  const sleeps = [], saved = [];
  const client = createClient({
    origin, circle, deviceKey: keys[options.keyIndex ?? 0], pinnedRootFingerprint: ids[2],
    rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; saved.push(value); } },
    fetch: globalThis.fetch, clock: () => now,
    random: n => { const bytes = Buffer.alloc(n); bytes.writeUInt32BE(++randomCounter, n - 4); return bytes; },
    sleep: async (ms, signal) => { signal?.throwIfAborted(); sleeps.push(ms); },
    ...options.client
  });
  return { client, requests, sleeps, saved, origin, snapshot: () => snapshot };
}

test('v1 client signs every request and submit returns at publish ACK without polling', async t => {
  const f = await fixture(t, ({ req, res, body }) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, base + '/jobs');
    assert.equal(req.headers['idempotency-key'], 'publish-once');
    const signed = JSON.parse(body);
    assert.equal(verifyEnvelope('job', signed, pubs[0]).ok, true);
    json(res, view(), 201);
  });
  assert.deepEqual(await f.client.submitJob(clone(job.payload), { idempotencyKey: 'publish-once' }),
    { jobDigest, operationKey: 'publish-once' });
  assert.equal(f.requests.length, 1);
});

test('v1 client keeps stop-request reads optional when an older host lacks the capability', async t => {
  const f=await fixture(t,({req,res})=>{
    assert.equal(req.url,base+'/capabilities');
    json(res,{capabilities:[]});
  });
  const running=attempt({state:'active',compute_stopped:false,stopped_at:null});
  assert.equal(await f.client.getStopRequest(running),null);
  assert.equal(f.requests.length,1,'an older host never receives the new route');
});

test('v1 client dropped connection retry preserves body/key and changes proof nonce', async t => {
  const f = await fixture(t, ({ req, res }, requests) => {
    if (requests.length === 1) return req.socket.destroy();
    json(res, view(), 201);
  });
  await f.client.submitJob(clone(job.payload), { idempotencyKey: 'lost-ack' });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  assert.equal(f.requests[1].req.headers['idempotency-key'], 'lost-ack');
  assert.notEqual(f.requests[0].proof.payload.nonce, f.requests[1].proof.payload.nonce);
  assert.equal(f.sleeps.length, 1);
});

test('v1 client never retries 409 even when the server claims retryable', async t => {
  const f = await fixture(t, ({ res }) => problem(res, 409, 'idempotency_conflict', {}, true));
  await assert.rejects(f.client.submitJob(clone(job.payload), { idempotencyKey: 'conflict' }), error => {
    assert.ok(error instanceof ClientError);
    assert.equal(error.status, 409); assert.equal(error.code, 'idempotency_conflict');
    assert.equal(error.retryable, false); assert.equal(error.problem.code, 'idempotency_conflict');
    return true;
  });
  assert.equal(f.requests.length, 1); assert.equal(f.sleeps.length, 0);
});

for (const status of [429, 503]) {
  test('v1 client honors Retry-After on ' + status, async t => {
    const f = await fixture(t, ({ res }, requests) => requests.length === 1
      ? problem(res, status, status === 429 ? 'rate_limited' : 'unavailable', { 'retry-after': '2' })
      : json(res, view()));
    await f.client.getJob(jobDigest);
    assert.equal(f.requests.length, 2); assert.equal(f.sleeps.length, 1);
    assert.ok(f.sleeps[0] >= 2000);
  });
}

test('rate-limit backoff deadline is not a host outage', async t => {
  const controller = new AbortController();
  const deadline = new DOMException('Local deadline', 'TimeoutError');
  const f = await fixture(t, ({ res }) => problem(res, 429, 'rate_limited', { 'retry-after': '2' }), { client: {
    sleep: async (ms, signal) => {
      assert.ok(ms >= 2000);
      assert.equal(signal, controller.signal);
      controller.abort(deadline);
      throw signal.reason;
    }
  } });
  let escaped;
  await assert.rejects(f.client.getJob(jobDigest, { signal: controller.signal }), error => {
    escaped = error; return true;
  });
  assert.equal(f.requests.length, 1);
  assert.ok(escaped instanceof ClientError);
  assert.equal(escaped.code, 'rate_limited');
  assert.equal(escaped.retryAfterSeconds, 2);
  const formatted = problemForError(escaped);
  assert.equal(formatted.code, 'rate_limited');
  assert.doesNotMatch(formatted.message, /not responding/i);
});

test('a person cancelling a rate-limit backoff still leaves as a cancellation', async t => {
  const controller = new AbortController();
  const f = await fixture(t, ({ res }) => problem(res, 429, 'rate_limited', { 'retry-after': '2' }), { client: {
    sleep: async (ms, signal) => { controller.abort(); throw signal.reason; }
  } });
  await assert.rejects(f.client.getJob(jobDigest, { signal: controller.signal }), error => error?.name === 'AbortError');
  assert.equal(f.requests.length, 1);
});
// Judge r8 O2: a host that is still busy after the last try says when to ask again; that wait leaves with the error,
// so the app can pass it to the page instead of the page guessing a longer backoff.
test('v1 client reports the host’s last Retry-After on a final 429', async t => {
  const f = await fixture(t, ({ res }) => problem(res, 429, 'rate_limited', { 'retry-after': '3' }), { client: { retry: { maxAttempts: 2 } } });
  await assert.rejects(f.client.getJob(jobDigest), error => error.status === 429 && error.retryAfterSeconds === 3);
});
// A host that refuses the connection gives no status. The client reports it as a retryable network failure, which the
// app's failed-resume retry accepts.
test('v1 client reports a refused connection as a retryable network_error with no status', async t => {
  const refused = (url, init) => globalThis.fetch(String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, 'http://127.0.0.1:1'), init);
  const f = await fixture(t, () => assert.fail('the host is never reached'), { client: { fetch: refused, retry: { maxAttempts: 2 } } });
  await assert.rejects(f.client.getJob(jobDigest), error => error.code === 'network_error' && error.status === 0 && error.retryable === true);
});
// Judge r9 O-B: a person's own action (here Delete) refused by a busy host (429, not applied) waits as the host asks
// and tries again with the same idempotency key, within a bounded budget, instead of failing after four quick tries.
const deleting = (refuse, retry) => ({ res, req }) => req.url.endsWith('/capabilities') ? json(res, { capabilities: ['retention_v1'] })
  : req.method === 'POST' && refuse() ? refuse.problem(res) : json(res, { job_digest: jobDigest, deleted: true, at: '2026-10-22T10:00:00Z' });
const busy = (times, headers = {}) => Object.assign(() => times-- > 0, { problem: res => problem(res, 429, 'rate_limited', headers) });
test('v1 client retries a busy host for a person action within a bounded wait, with one idempotency key', async t => {
  const f = await fixture(t, deleting(busy(6, { 'retry-after': '1' })), { client: { retry: { maxAttempts: 4 } } });
  await f.client.deleteJob(jobDigest);
  const posts = f.requests.filter(r => r.req.method === 'POST');
  assert.equal(posts.length, 7, 'six refusals, then the delete lands');
  assert.equal(new Set(posts.map(r => r.req.headers['idempotency-key'])).size, 1, 'the same operation key every time');
  assert.ok(f.sleeps.every(ms => ms >= 1000), 'each wait honours Retry-After');
});
test('v1 client stops retrying a busy host for a person action after the bounded wait', async t => {
  const f = await fixture(t, deleting(busy(Infinity, { 'retry-after': '8' })), { client: { retry: { maxAttempts: 2, writeBusyBudgetMs: 20000 } } });
  await assert.rejects(f.client.deleteJob(jobDigest), error => error.status === 429);
  assert.deepEqual(f.sleeps, [8000, 8000], 'two waits fit the 20 s budget; a third would not');
});
test('v1 client counts every busy-write wait against the budget, even before the last attempt', async t => {
  const f = await fixture(t, deleting(busy(Infinity, { 'retry-after': '20' })), { client: { retry: { maxAttempts: 4 } } });
  await assert.rejects(f.client.deleteJob(jobDigest), error => error.status === 429);
  assert.deepEqual(f.sleeps, [20000], 'one 20 s wait uses the whole budget');
});
test('v1 client ends a busy-write retry with no Retry-After and no backoff', async t => {
  const f = await fixture(t, deleting(busy(Infinity)), { client: { retry: { maxAttempts: 2, baseMs: 0, writeBusyBudgetMs: 1000 } } });
  await assert.rejects(f.client.deleteJob(jobDigest), error => error.status === 429);
  assert.deepEqual(f.sleeps, [250, 250, 250, 250], 'each wait counts at least 250 ms');
});
test('v1 client keeps normal attempts for a background write refused by a busy host', async t => {
  const f = await fixture(t, ({ res }) => problem(res, 429, 'rate_limited', { 'retry-after': '1' }), { client: { retry: { maxAttempts: 2 } } });
  await assert.rejects(f.client.heartbeat({ capabilities: [] }), error => error.status === 429);
  assert.equal(f.requests.filter(r => r.req.method === 'POST').length, 2, 'a heartbeat waits for its own next beat');
});
test('v1 client caps retry count and preserves unknown network outcome', async t => {
  const f = await fixture(t, ({ req }) => req.socket.destroy(), {
    client: { retry: { maxAttempts: 3, baseMs: 10, capMs: 15 } }
  });
  await assert.rejects(f.client.submitJob(clone(job.payload), { idempotencyKey: 'unknown' }), error => {
    assert.ok(error instanceof ClientError); assert.equal(error.outcome, 'unknown');
    assert.equal(error.operationKey, 'unknown'); assert.equal(error.retryable, true); return true;
  });
  assert.equal(f.requests.length, 3); assert.equal(f.sleeps.length, 2);
  assert.ok(f.sleeps.every(ms => ms >= 0 && ms <= 15));
  assert.ok(f.requests.every(r => r.body.equals(f.requests[0].body)));
});

test('v1 client marks an unreadable successful submit acknowledgement unknown with its key', async t => {
  let accepted=false;
  const rawFetch=globalThis.fetch,key='malformed-ack-1023';
  const f=await fixture(t,({req,res})=>{
    assert.equal(req.method,'POST');assert.equal(req.url,base+'/jobs');
    accepted=true;json(res,view(),201);
  },{client:{retry:{maxAttempts:1},fetch:async(input,init)=>{
    const response=await rawFetch(input,init);
    if(init.method==='POST'&&new URL(input).pathname.endsWith('/jobs')){
      await response.arrayBuffer();
      return new Response('{',{status:201,headers:{'content-type':'application/json'}});
    }
    return response;
  }}});

  await assert.rejects(f.client.submitJob(clone(job.payload),{idempotencyKey:key}),error=>{
    assert.equal(error.outcome,'unknown');assert.equal(error.operationKey,key);return true;
  });
  assert.equal(accepted,true,'the host acknowledged after accepting, but the client could not read it');
});

test('v1 client claim-next long poll is abortable and never silently returns empty', async t => {
  const controller = new AbortController();
  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const f = await fixture(t, ({ req, body }) => {
    assert.equal(req.url, base + '/jobs/claim-next');
    const request = JSON.parse(body);
    assert.equal(request.wait_seconds, 30); assert.deepEqual(request.advertisement, advertisement);
    received();
  });
  const pending = f.client.claimNext(advertisement, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'aborted');
  assert.equal(f.requests.length, 1);
});

test('v1 client waitForJob aborts its bounded GET polling wait', async t => {
  const controller = new AbortController();
  let entered;
  const sleeping = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, ({ res }) => json(res, view()), { client: {
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  } });
  const pending = f.client.waitForJob(jobDigest, { signal: controller.signal, timeoutMs: 5000, pollMs: 10 });
  await sleeping; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'aborted');
  assert.equal(f.requests.length, 1);
});

async function resultFixture(t, { mutate, signer = 1, attemptOverrides, candidateBytes = candidate,
  transcriptBytes = transcript, client, snapshot, viewOverrides, jobEnvelope = job } = {}) {
  const resultJobDigest = digest(jobEnvelope.payload), resultJobPath = base + '/jobs/' + resultJobDigest.slice(7);
  const p = payload(); p.job_digest = resultJobDigest; mutate?.(p);
  const signed = signEnvelope('result', p, keys[signer]);
  const accepted = attempt({ job_digest: resultJobDigest, ...attemptOverrides });
  const f = await fixture(t, ({ req, res }) => {
    if (req.url === resultJobPath) return json(res, view({ job_digest: resultJobDigest, job: jobEnvelope,
      state: 'result-accepted', attempts_started: 1,
      current_attempt: accepted, result_digest: digest(p), ...viewOverrides }));
    if (req.url === resultJobPath + '/result') return json(res, signed);
    if (req.url === base + '/artifacts/' + p.candidate.digest.slice(7)) return blob(res, candidateBytes);
    if (req.url === base + '/artifacts/' + p.transcript.digest.slice(7)) return blob(res, transcriptBytes);
    if (req.url === base + '/roster') return json(res, snapshot?.current ?? roster);
    assert.fail('Unexpected request: ' + req.url);
  }, { client, snapshot });
  return { ...f, jobDigest: resultJobDigest, retainedAttempt: attempt({ job_digest: resultJobDigest }) };
}
test('v1 client returns candidate only after verifying both artifacts and returns verified transcript', async t => {
  const f = await resultFixture(t);
  assert.deepEqual(await f.client.fetchResult(jobDigest, { attempt: attempt() }), candidate);
  assert.ok(f.requests.some(r => r.req.url.endsWith(digestBytes(transcript).slice(7))));
  assert.deepEqual(await f.client.fetchTranscript(jobDigest, { attempt: attempt() }), transcript);
});
test('v1 client exposes a verified receipt without downloading code, and refuses a mismatched retained attempt', async t => {
  const f = await resultFixture(t);
  const metadata = await f.client.fetchReceipt(jobDigest, {attempt:attempt()});
  assert.deepEqual(metadata.receipt, payload().receipt);
  assert.deepEqual(metadata.checks, []);
  assert.ok(!f.requests.some(r => r.req.url.includes('/artifacts/')), 'receipt inspection downloads no code');
  await assert.rejects(f.client.fetchReceipt(jobDigest, {attempt:attempt({generation:2})}), error => error instanceof ClientError);
});
const badResults = [
  ['non-member', { signer: 3, mutate: p => { p.executor = ids[3]; }, attemptOverrides: { holder: ids[3] } }],
  ['non-holder', { attemptOverrides: { holder: ids[0] } }],
  ['executor differs from signer', { mutate: p => { p.executor = ids[0]; } }],
  ['different job', { mutate: p => { p.job_digest = 'sha256:' + 'f'.repeat(64); } }],
  ['different attempt', { attemptOverrides: { attempt_id: '55555555-5555-4555-8555-555555555555' } }],
  ['stale generation', { attemptOverrides: { generation: 2 } }],
  ['wrong candidate size', { mutate: p => { p.candidate.bytes += 1; } }],
  ['wrong candidate digest', { candidateBytes: Buffer.from('corrupt candidate!!!\n') }],
  ['wrong transcript size', { mutate: p => { p.transcript.bytes += 1; } }],
  ['wrong transcript digest', { transcriptBytes: Buffer.from('{"test":evil}\n') }],
  ['not accepted', { viewOverrides: { state: 'claimed', result_digest: null } }],
  ['accepted digest mismatch', { viewOverrides: { result_digest: 'sha256:' + 'e'.repeat(64) } }]
];
for (const [name, options] of badResults) {
  test('v1 client rejects result with ' + name, async t => {
    const f = await resultFixture(t, options);
    await assert.rejects(f.client.fetchResult(jobDigest, { attempt: attempt() }), error => error instanceof ClientError);
  });
}
test('v1 client bounds transcript reads before returning candidate', async t => {
  const f = await resultFixture(t, { client: { maxTranscriptBytes: 4 } });
  await assert.rejects(f.client.fetchResult(jobDigest, { attempt: attempt() }), error => error instanceof ClientError);
});
test('v1 client accepts root-pinned historical signer after removal from current roster', async t => {
  const current = signEnvelope('roster', { ...clone(roster.payload), epoch: 8,
    members: [clone(roster.payload.members[0])] }, keys[2]);
  const snapshot = { current, history: [clone(roster)], highestAcceptedEpoch: 8,
    highestAcceptedDigest: digest(current.payload) };
  // This fixture expects the current proof epoch even though the result used epoch 7.
  const p = payload(), signed = signEnvelope('result', p, keys[1]);
  const f = await fixture(t, ({ req, res }) => {
    if (req.url === jobPath) return json(res, view({ state: 'result-accepted', attempts_started: 1,
      current_attempt: attempt(), result_digest: digest(p) }));
    if (req.url === jobPath + '/result') return json(res, signed);
    if (req.url.endsWith(p.candidate.digest.slice(7))) return blob(res, candidate);
    if (req.url.endsWith(p.transcript.digest.slice(7))) return blob(res, transcript);
    assert.fail(req.url);
  }, { snapshot, epoch: 8 });
  assert.deepEqual(await f.client.fetchResult(jobDigest, { attempt: attempt() }), candidate);
});

test('v1 client identical completion acknowledgement is success after lost ACK', async t => {
  const p = payload();
  const claimed = attempt({ state: 'active', execution_started_at: null, compute_stopped: false, stopped_at: null });
  const started = { ...claimed, execution_started_at: '2026-10-09T12:00:10Z' };
  const ack = { job_digest: jobDigest, result_digest: digest(p), attempt_id: attempt().attempt_id,
    generation: 1, accepted_at: '2026-10-09T12:01:02Z', status: 'result-accepted' };
  const f = await fixture(t, ({ req, res, body }, requests) => {
    if (req.url === base + '/attempts/' + claimed.attempt_id + '/start') {
      assert.equal(req.method, 'POST');
      assert.deepEqual(JSON.parse(body), { generation: claimed.generation });
      return json(res, started);
    }
    if (req.url === base + '/attempts/' + claimed.attempt_id) {
      assert.equal(req.method, 'GET'); return json(res, started);
    }
    assert.equal(req.url, base + '/attempts/' + attempt().attempt_id + '/complete');
    assert.equal(verifyEnvelope('result', JSON.parse(body), pubs[1]).ok, true);
    if (requests.filter(r => r.req.url.endsWith('/complete')).length === 1) return req.socket.destroy();
    json(res, ack);
  }, { keyIndex: 1 });
  assert.deepEqual(await f.client.startAttempt(claimed, { idempotencyKey: 'start-once' }), started);
  assert.deepEqual(await f.client.completeAttempt(started, p, { idempotencyKey: 'complete-once' }), ack);
  const completions = f.requests.filter(r => r.req.url.endsWith('/complete'));
  assert.equal(f.requests.length, 4); assert.equal(completions.length, 2);
  assert.deepEqual(completions[0].body, completions[1].body);
  assert.equal(completions[1].req.headers['idempotency-key'], 'complete-once');
  assert.notEqual(completions[0].proof.payload.nonce, completions[1].proof.payload.nonce);
});

test('v1 client rejects roster rollback without persisting it', async t => {
  const old = signEnvelope('roster', { ...clone(roster.payload), epoch: 6,
    members: [clone(roster.payload.members[0])] }, keys[2]);
  const f = await fixture(t, ({ req, res }) => {
    assert.equal(req.url, base + '/roster'); json(res, old);
  });
  await assert.rejects(f.client.refreshRoster(), error => error instanceof ClientError && error.code === 'roster_stale');
  assert.equal(f.saved.length, 0); assert.equal(f.snapshot().highestAcceptedEpoch, 7);
});

test('v1 client enrollment uses invite proof and epoch-zero new-device request proof without secret leakage', async t => {
  let invite;
  const enrollment = { enrollment_id: '66666666-6666-4666-8666-666666666666',
    state: 'pending', device_key_id: ids[0], roster: null };
  const f = await fixture(t, ({ req, res, body, proof }) => {
    assert.equal(proof.payload.roster_epoch, 0);
    if (req.method === 'GET') return json(res, enrollment);
    assert.equal(req.url, base + '/enrollments');
    const data = JSON.parse(body);
    assert.deepEqual(Object.keys(data).sort(), ['device_public_key', 'enrollment_proof', 'invite']);
    assert.deepEqual(data.invite, invite); assert.equal(data.device_public_key, pubs[0]);
    assert.equal(verifyEnrollmentProof(data.enrollment_proof, { invitePublicKey: pubs[3],
      circle, invite_id: invite.payload.invite_id, device_public_key: pubs[0] }).ok, true);
    assert.ok(!body.toString().includes('invite_private_seed'));
    assert.ok(!req.url.includes('#'));
    json(res, enrollment, 202);
  }, { epoch: 0, snapshot: { current: null, history: [], highestAcceptedEpoch: 0 } });
  invite = createInvite({ circle, coordinator: f.origin, invite_id: vectors.objects.invite.envelope.payload.invite_id,
    invite_public_key: pubs[3], created_at: '2026-10-09T12:00:00Z', expires_at: '2026-10-09T13:00:00Z' }, keys[2]);
  const link = encodeInviteLink(invite, Buffer.from(vectors.keys[3].seed_hex, 'hex'));
  assert.deepEqual(await f.client.enroll(link, { idempotencyKey: 'enroll-test' }), enrollment);
  assert.deepEqual(await f.client.getEnrollment(enrollment.enrollment_id), enrollment);
});

test('v1 client pagination signs opaque cursor and stops at null cursor', async t => {
  const cursor = 'opaque+/=token';
  const f = await fixture(t, ({ res, url }, requests) => {
    assert.equal(url.pathname, base + '/jobs'); assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('cursor'), requests.length === 1 ? null : cursor);
    json(res, { items: requests.length === 1 ? [view()] : [], next_cursor: requests.length === 1 ? cursor : null });
  });
  const values = [];
  for await (const item of f.client.listJobs({ limit: 1 })) values.push(item);
  assert.deepEqual(values, [view()]); assert.equal(f.requests.length, 2);
});
test('v1 client rejects a page larger than the requested limit', async t => {
  const f = await fixture(t, ({ res }) => json(res, { items: [view(), view()], next_cursor: 'again' }));
  await assert.rejects(async () => { for await (const unused of f.client.listJobs({ limit: 1 })) void unused; },
    error => error instanceof ClientError);
  assert.equal(f.requests.length, 1);
});

test('v1 client artifact upload is content addressed and skips existing bytes', async t => {
  let stored = false;
  const expected = ref(candidate, 'text/x-diff');
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.url === base + '/capabilities') return json(res, { artifact_head: false });
    assert.equal(req.url, base + '/artifacts/' + expected.digest.slice(7));
    if (req.method === 'GET') return stored ? blob(res, candidate) : problem(res, 404, 'not_found');
    assert.equal(req.method, 'PUT'); assert.deepEqual(body, candidate);
    assert.equal(req.headers['faravan-media-type'], 'text/x-diff');
    assert.equal(Number(req.headers['content-length']), candidate.length);
    stored = true; json(res, expected);
  });
  assert.deepEqual(await f.client.uploadArtifact(candidate, 'text/x-diff'), expected);
  assert.deepEqual(await f.client.uploadArtifact(candidate, 'text/x-diff'), expected);
  assert.equal(f.requests.filter(r => r.req.method === 'PUT').length, 1);
});
test('v1 client rejects oversized control response', async t => {
  const f = await fixture(t, ({ res }) => json(res, { padding: 'x'.repeat(262145) }));
  await assert.rejects(f.client.getJob(jobDigest), error => error instanceof ClientError);
  assert.equal(f.requests.length, 1);
});

test('v1 client rejects repeated opaque cursors instead of looping', async t => {
  const f = await fixture(t, ({ res }) => json(res, { items: [], next_cursor: 'same' }));
  await assert.rejects(async () => { for await (const item of f.client.listJobs()) void item; },
    error => error instanceof ClientError && error.code === 'cursor_cycle');
  assert.equal(f.requests.length, 2);
});
for (const kind of ['candidate', 'transcript']) {
  test('v1 client checks ' + kind + ' sha256 independently of matching size', async t => {
    const bytes = Buffer.from(kind === 'candidate' ? candidate : transcript);
    bytes[0] ^= 1;
    const f = await resultFixture(t, { [kind + 'Bytes']: bytes });
    await assert.rejects(f.client.fetchResult(jobDigest, { attempt: attempt() }),
      error => error instanceof ClientError && error.code === 'digest_mismatch');
  });
}
test('v1 client rejects same-epoch roster equivocation without overwriting cache', async t => {
  const fork = signEnvelope('roster', { ...clone(roster.payload),
    valid_until: '2026-10-15T11:00:00Z' }, keys[2]);
  const f = await fixture(t, ({ res }) => json(res, fork));
  await assert.rejects(f.client.refreshRoster(), error => error.code === 'roster_stale');
  assert.equal(f.saved.length, 0);
});
test('v1 client enforces independently pinned roster root', async t => {
  const wrong = signEnvelope('roster', { ...clone(roster.payload), root_public_key: pubs[3] }, keys[3]);
  const f = await fixture(t, ({ res }) => json(res, wrong));
  await assert.rejects(f.client.refreshRoster(), error => error.code === 'root_mismatch');
  assert.equal(f.saved.length, 0);
});
test('v1 client persists a verified roster advance and retains accepted history', async t => {
  const next = signEnvelope('roster', { ...clone(roster.payload), epoch: 8 }, keys[2]);
  const f = await fixture(t, ({ res }) => json(res, next));
  await f.client.refreshRoster();
  assert.equal(f.saved.length, 1);
  assert.equal(f.snapshot().highestAcceptedEpoch, 8);
  assert.equal(f.snapshot().highestAcceptedDigest, digest(next.payload));
  assert.deepEqual(f.snapshot().current, next);
  assert.ok(f.snapshot().history.some(r => digest(r.payload) === digest(roster.payload)));
});
test('v1 client lender operations bind holder, generation and reason', async t => {
  const active = attempt({ state: 'active', compute_stopped: false, stopped_at: null });
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.method === 'GET') {
      assert.equal(req.url, base + '/attempts/' + active.attempt_id); return json(res, active);
    }
    const operation = req.url.split('/').at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, base + '/attempts/' + active.attempt_id + '/' + operation);
    const data = JSON.parse(body);
    assert.equal(data.generation, 1);
    if (operation === 'start') assert.deepEqual(data, { generation: active.generation });
    else if (operation === 'renew') assert.equal(data.lease_seconds, 120);
    else assert.equal(data.reason, operation === 'fail' ? 'test failure' : 'test release');
    json(res, active);
  }, { keyIndex: 1 });
  assert.deepEqual(await f.client.startAttempt({ ...active, execution_started_at: null }), active);
  assert.deepEqual(await f.client.renew(active), active);
  assert.deepEqual(await f.client.release(active, 'test release'), active);
  assert.deepEqual(await f.client.fail(active, 'test failure'), active);
  assert.equal(f.requests.length, 5);
  await assert.rejects(f.client.startAttempt({ ...active, holder: ids[0] }), error => error.code === 'executor_mismatch');
  await assert.rejects(f.client.renew({ ...active, holder: ids[0] }), error => error.code === 'executor_mismatch');
  assert.equal(f.requests.length, 5);
});
test('v1 client distinguishes no eligible claim from unavailable and reconciles successful claim lease', async t => {
  const active = attempt({ state: 'active', execution_started_at: null, compute_stopped: false, stopped_at: null });
  const claim = { job_digest: jobDigest, job, attempt: active };
  const f = await fixture(t, ({ req, res }, requests) => {
    if (requests.length === 1) { res.writeHead(204); return res.end(); }
    if (req.method === 'POST') return json(res, claim);
    assert.equal(req.url, base + '/attempts/' + active.attempt_id); json(res, active);
  }, { keyIndex: 1 });
  assert.equal(await f.client.claimNext(advertisement), null);
  assert.deepEqual(await f.client.claimNext(advertisement), claim);
  assert.equal(f.requests.length, 3);
  assert.notEqual(f.requests[0].req.headers['idempotency-key'], f.requests[1].req.headers['idempotency-key']);
});
test('v1 client rejects a replayed claim whose authoritative lease expired', async t => {
  const active = attempt({ state: 'active', execution_started_at: null, compute_stopped: false, stopped_at: null });
  const f = await fixture(t, ({ req, res }) => req.method === 'POST'
    ? json(res, { job_digest: jobDigest, job, attempt: active })
    : json(res, { ...active, state: 'expired' }), { keyIndex: 1 });
  await assert.rejects(f.client.claimNext(advertisement), error => error.code === 'lease_expired');
  assert.equal(f.requests.length, 2);
});
test('v1 client signs cancellation without claiming compute has stopped', async t => {
  const ack = { job_digest: jobDigest, cancellation_digest: null,
    requested_at: '2026-10-09T12:02:00Z', authority_revoked: true, compute_stopped: false,
    attempt: attempt({ state: 'cancelled', compute_stopped: false, stopped_at: null }) };
  const f = await fixture(t, ({ req, res, body }) => {
    assert.equal(req.url, jobPath + '/cancel');
    const envelope = JSON.parse(body);
    const verified = verifyEnvelope('cancellation', envelope, pubs[0]);
    assert.equal(verified.ok, true); assert.equal(verified.payload.job_digest, jobDigest);
    assert.equal(verified.payload.reason, 'stop test');
    ack.cancellation_digest = verified.digest; json(res, ack);
  });
  assert.deepEqual(await f.client.cancelJob(jobDigest, { reason: 'stop test', idempotencyKey: 'cancel-test' }), ack);
  assert.equal(f.requests.length, 1);
});
test('v1 client uploads both result artifacts with their respective media types', async t => {
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.method === 'GET') return problem(res, 404, 'not_found');
    assert.equal(req.method, 'PUT');
    const expected = body.equals(candidate) ? ref(candidate, 'text/x-diff') : ref(transcript, 'application/x-ndjson');
    assert.equal(req.headers['faravan-media-type'], expected.media_type);
    assert.equal(req.url, base + '/artifacts/' + expected.digest.slice(7)); json(res, expected);
  });
  assert.deepEqual(await f.client.uploadResultArtifacts({ candidate, transcript }),
    { candidate: ref(candidate, 'text/x-diff'), transcript: ref(transcript, 'application/x-ndjson') });
  assert.equal(f.requests.filter(r => r.req.method === 'PUT').length, 2);
});
test('v1 client uploads both result artifacts with separate recovery signals and an ordinary signal control', async () => {
  const outputs = { candidate: ref(candidate, 'text/x-diff'), transcript: ref(transcript, 'application/x-ndjson') };
  const calls = [];
  const client = createClient({
    origin: 'http://127.0.0.1:30123', circle, deviceKey: keys[0], pinnedRootFingerprint: ids[2],
    rosterCache: { get: async () => ({ current: clone(roster), history: [],
      highestAcceptedEpoch: 7, highestAcceptedDigest: digest(roster.payload) }), set: async () => {} },
    clock: () => now,
    fetch: async (url, { method, headers, body, signal }) => {
      const path = new URL(url).pathname;
      if (path === base + '/capabilities') return new Response(null, { status: 404 });
      calls.push({ method, path, job: headers['Faravan-Job'], media: headers['Faravan-Media-Type'], signal });
      if (method === 'GET') return new Response(null, { status: 404 });
      assert.equal(method, 'PUT');
      const output = body.equals(candidate) ? outputs.candidate : outputs.transcript;
      return new Response(canonicalize(output), {headers:{'content-type':'application/json'}});
    }
  });
  const ordinary = new AbortController().signal;
  const bounded = [new AbortController().signal, new AbortController().signal];
  let invocations = 0;
  const inputs = { candidate, transcript, job: jobDigest };
  assert.deepEqual(await client.uploadResultArtifacts(inputs, { signal: ordinary }), outputs);
  assert.deepEqual(await client.uploadResultArtifacts(inputs, {
    signal: ordinary,
    withArtifactRequest: send => send(bounded[invocations++])
  }), outputs);
  assert.equal(invocations, 2);
  const expectedCalls = signals => Object.values(outputs).flatMap(({ digest, media_type }, index) => {
    const shared = { path: base + '/artifacts/' + digest.slice(7), job: jobDigest.slice(7), signal: signals[index] };
    return [{ ...shared, method: 'GET', media: undefined }, { ...shared, method: 'PUT', media: media_type }];
  });
  assert.deepEqual(calls, [...expectedCalls([ordinary, ordinary]), ...expectedCalls(bounded)]);
});

test('v1 client follows no redirects and sends no proof to redirect destination', async t => {
  const f = await fixture(t, ({ res }) => {
    res.writeHead(307, { location: base + '/redirected' }); res.end();
  });
  await assert.rejects(f.client.getJob(jobDigest), error => error instanceof ClientError);
  assert.equal(f.requests.length, 1);
});


test('v1 client advertised HEAD checks metadata without downloading existing bytes', async t => {
  let stored = false;
  const expected = ref(candidate, 'text/x-diff');
  const f = await fixture(t, ({ req, res, body }) => {
    if (req.url === base + '/capabilities') return json(res, { artifact_head: true });
    assert.equal(req.url, base + '/artifacts/' + expected.digest.slice(7));
    if (req.method === 'HEAD') {
      assert.equal(body.length, 0);
      if (!stored) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-length': candidate.length, 'faravan-media-type': 'text/x-diff' });
      return res.end();
    }
    assert.equal(req.method, 'PUT'); assert.deepEqual(body, candidate);
    stored = true; json(res, expected);
  });
  assert.deepEqual(await f.client.uploadArtifact(candidate, 'text/x-diff'), expected);
  assert.deepEqual(await f.client.uploadArtifact(candidate, 'text/x-diff'), expected);
  assert.deepEqual(f.requests.map(r => [r.req.method, r.req.url.split('/').at(-1)]), [
    ['GET', 'capabilities'], ['HEAD', expected.digest.slice(7)], ['PUT', expected.digest.slice(7)],
    ['HEAD', expected.digest.slice(7)],
  ]);
});

test('v1 client legacy capabilities 404 preserves verified GET upload fallback', async t => {
  const expected = ref(candidate, 'text/x-diff');
  const f = await fixture(t, ({ req, res }) => {
    if (req.url === base + '/capabilities') return problem(res, 404, 'not_found');
    assert.equal(req.method, 'GET'); assert.equal(req.url, base + '/artifacts/' + expected.digest.slice(7));
    blob(res, candidate);
  });
  assert.deepEqual(await f.client.uploadArtifact(candidate, 'text/x-diff'), expected);
  assert.equal(f.requests.length, 2);
});

for (const [bytes, media, code] of [
  [candidate.length - 1, 'text/x-diff', 'size_mismatch'],
  [candidate.length + 1, 'text/x-diff', 'payload_too_large'],
  [candidate.length, 'text/plain', 'artifact_mismatch'],
]) {
  test('v1 client rejects incorrect HEAD metadata: ' + code, async t => {
    const f = await fixture(t, ({ req, res }) => {
      if (req.url === base + '/capabilities') return json(res, { artifact_head: true });
      assert.equal(req.method, 'HEAD');
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-length': bytes, 'faravan-media-type': media }); res.end();
    });
    await assert.rejects(f.client.uploadArtifact(candidate, 'text/x-diff'), error => error.code === code);
    assert.equal(f.requests.filter(r => r.req.method === 'PUT').length, 0);
  });
}
const receiptLimitNames = ['cpu', 'memory', 'wall', 'output', 'storage', 'processes', 'network_bytes'];
const unknownReceiptUsage = () => ({ input_tokens: null, output_tokens: null, total_tokens: null });
const receiptTargets = count => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  ['target-' + i + '.example.invalid', ['allowed', 'denied', 'unknown'][i % 3]]));

for (const [name, evidence] of [
  ['optional evidence omitted', {}],
  ['empty bounded evidence', { egress_evidence: {}, enforced_limits: [], unenforced: [] }],
  ['32 egress targets and all seven unique limit names', {
    egress_evidence: receiptTargets(32), enforced_limits: receiptLimitNames, unenforced: receiptLimitNames
  }],
  ['unknown usage remains null', { usage: unknownReceiptUsage() }],
  ['known zero usage remains zero', { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }],
  ['independently known usage preserves nulls', { usage: { input_tokens: 12, output_tokens: null, total_tokens: null } }],
  ['maximum safe integer usage', { usage: {
    input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER,
    total_tokens: Number.MAX_SAFE_INTEGER
  } }]
]) {
  test('v1 result receipt accepts ' + name, { timeout: 2000 }, () => {
    const p = payload();
    Object.assign(p.receipt, clone(evidence));
    const signed = signEnvelope('result', p, keys[1]);
    const verified = verifyEnvelope('result', signed, pubs[1]);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.deepEqual(verified.payload.receipt, p.receipt);
    assert.equal(verified.payload.receipt.self_reported, true);
    for (const field of ['egress_evidence', 'enforced_limits', 'unenforced', 'usage']) {
      assert.equal(Object.hasOwn(verified.payload.receipt, field), Object.hasOwn(evidence, field));
    }
  });
}

const invalidReceiptEvidence = [
  ['33 egress targets', { egress_evidence: receiptTargets(33) }],
  ['unknown egress verdict', { egress_evidence: { 'target.example.invalid': 'blocked' } }],
  ['null egress verdict', { egress_evidence: { 'target.example.invalid': null } }],
  ['object egress verdict', { egress_evidence: { 'target.example.invalid': { allowed: true } } }],
  ['array egress evidence', { egress_evidence: [] }],
  ['null egress evidence', { egress_evidence: null }],
  ['null usage object', { usage: null }],
  ['array usage object', { usage: [] }],
  ['extra usage member', { usage: { ...unknownReceiptUsage(), cached_tokens: 0 } }],
  ['empty usage object', { usage: {} }]
];
for (const field of ['enforced_limits', 'unenforced']) {
  invalidReceiptEvidence.push(
    ['duplicate ' + field, { [field]: ['cpu', 'cpu'] }],
    ['unknown ' + field, { [field]: ['disk'] }],
    ['too many ' + field, { [field]: [...receiptLimitNames, 'cpu'] }],
    ['non-array ' + field, { [field]: 'cpu' }],
    ['null ' + field, { [field]: null }]
  );
}
for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
  const missing = unknownReceiptUsage(); delete missing[field];
  invalidReceiptEvidence.push(['missing ' + field, { usage: missing }]);
  for (const [name, value] of [
    ['negative', -1], ['fractional', 0.5], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['numeric string', '0'], ['boolean', false], ['negative zero', -0],
    ['NaN', NaN], ['infinity', Infinity]
  ]) invalidReceiptEvidence.push([name + ' ' + field, { usage: { ...unknownReceiptUsage(), [field]: value } }]);
}
for (const [name, evidence] of invalidReceiptEvidence) {
  test('v1 result receipt rejects ' + name, { timeout: 2000 }, () => {
    const p = payload();
    Object.assign(p.receipt, clone(evidence));
    assert.throws(() => signEnvelope('result', p, keys[1]), name);
  });
}

test('v1 client fetches a result with bounded self-reported receipt evidence', { timeout: 2000 }, async t => {
  const f = await resultFixture(t, { mutate: p => Object.assign(p.receipt, {
    egress_evidence: receiptTargets(32), enforced_limits: receiptLimitNames,
    unenforced: [], usage: { input_tokens: null, output_tokens: 0, total_tokens: null }
  }) });
  assert.deepEqual(await f.client.fetchResult(jobDigest, { attempt: attempt() }), candidate);
  assert.ok(f.requests.some(r => r.req.url.endsWith(digestBytes(transcript).slice(7))));
});

for (const code of ['roster_stale', 'roster_unknown']) {
  test('v1 client refreshes ' + code + ' only once even with one request attempt', async t => {
    const f = await fixture(t, ({ req, res }) => req.url === base + '/roster'
      ? json(res, roster) : problem(res, 409, code), { client: { retry: { maxAttempts: 1 } } });
    await assert.rejects(f.client.getJob(jobDigest), error => error.code === code);
    assert.deepEqual(f.requests.map(r => r.req.url), [jobPath, base + '/roster', jobPath]);
    assert.notEqual(f.requests[0].proof.payload.nonce, f.requests[2].proof.payload.nonce);
  });
}

test('v1 client obtains missing historical epoch without rolling back the current pin', async t => {
  const current = signEnvelope('roster', { ...clone(roster.payload), epoch: 9 }, keys[2]);
  const f = await fixture(t, ({ req, res }) => {
    if (req.url === base + '/rosters/7') return json(res, roster);
    assert.equal(req.url, jobPath); return json(res, view());
  }, { epoch: 9, snapshot: { current, history: [], highestAcceptedEpoch: 9, highestAcceptedDigest: digest(current.payload) } });
  await f.client.getJob(jobDigest);
  await f.client.getJob(jobDigest);
  assert.equal(f.requests.filter(r => r.req.url === base + '/rosters/7').length, 1);
  assert.equal(f.snapshot().highestAcceptedEpoch, 9);
  assert.equal(f.snapshot().highestAcceptedDigest, digest(current.payload));
  assert.deepEqual(f.snapshot().current, current);
  assert.deepEqual(f.snapshot().history, [roster]);
});

for (const corruption of ['root', 'epoch']) {
  test('v1 client rejects historical roster with wrong ' + corruption + ' before caching', async t => {
    const current = signEnvelope('roster', { ...clone(roster.payload), epoch: 9 }, keys[2]);
    const bad = corruption === 'root'
      ? signEnvelope('roster', { ...clone(roster.payload), root_public_key: pubs[3] }, keys[3])
      : signEnvelope('roster', { ...clone(roster.payload), epoch: 8 }, keys[2]);
    const f = await fixture(t, ({ req, res }) => req.url === base + '/rosters/7'
      ? json(res, bad) : json(res, view()), { epoch: 9,
      snapshot: { current, history: [], highestAcceptedEpoch: 9, highestAcceptedDigest: digest(current.payload) } });
    await assert.rejects(f.client.getJob(jobDigest), error => error.code === (corruption === 'root' ? 'root_mismatch' : 'roster_mismatch'));
    assert.equal(f.saved.length, 0);
  });
}

test('v1 client exposes only reconciled claim identifiers on local rejection', async t => {
  const active = attempt({ state: 'active', execution_started_at: null, compute_stopped: false, stopped_at: null });
  const bad = clone(job); bad.payload.author = ids[1];
  const f = await fixture(t, ({ req, res }) => req.method === 'POST'
    ? json(res, { job_digest: jobDigest, job: bad, attempt: active }) : json(res, active), { keyIndex: 1 });
  await assert.rejects(f.client.claimNext(advertisement), error => {
    assert.equal(error.claimRejected, true);
    assert.deepEqual(error.committedAttempt, active);
    return true;
  });
  assert.equal(f.requests.length, 2);
});

test('v1 client never exposes foreign claim identifiers for cleanup', async t => {
  const foreign = attempt({ state: 'active', holder: ids[0] });
  const f = await fixture(t, ({ res }) => json(res, { job_digest: jobDigest, job, attempt: foreign }), { keyIndex: 1 });
  await assert.rejects(f.client.claimNext(advertisement), error => {
    assert.equal(error.claimRejected, true);
    assert.equal(error.committedAttempt, undefined);
    assert.equal(error.code, 'executor_mismatch'); return true;
  });
  assert.equal(f.requests.length, 1);
});

test('v1 client preserves pending claim when reconciliation has a transient failure', async t => {
  const active = attempt({ state: 'active', execution_started_at: null, compute_stopped: false, stopped_at: null });
  const f = await fixture(t, ({ req, res }) => req.method === 'POST'
    ? json(res, { job_digest: jobDigest, job, attempt: active }) : problem(res, 503, 'unavailable'),
  { keyIndex: 1, client: { retry: { maxAttempts: 1 } } });
  await assert.rejects(f.client.claimNext(advertisement), error => {
    assert.equal(error.claimRejected, undefined); assert.equal(error.committedAttempt, undefined);
    assert.equal(error.retryable, true); return true;
  });
});

async function realClientFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'v1-client-reliability-'));
  let time = now, handler;
  const requests = [], failures = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, proof: JSON.parse(Buffer.from(req.headers['faravan-proof'], 'base64url')),
      key: req.headers['idempotency-key'] });
    Promise.resolve(handler(req, res)).catch(error => { failures.push(error); res.destroy(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const store = openV1Store({ path: join(dir, 'store.sqlite'), origin, circle,
    rootFingerprint: ids[2], initialRoster: roster, clock: () => time });
  handler = createV1Handler({ store, blobDir: join(dir, 'blobs'), clock: () => time });
  t.after(async () => {
    handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true }); assert.deepEqual(failures, []);
  });
  const f = { requests, store, epoch: 7, advance: seconds => { time += seconds; },
    iso: () => new Date(time * 1000).toISOString().replace('.000Z', 'Z'),
    client(index, current = roster) {
      let snapshot = { current, history: [], highestAcceptedEpoch: current.payload.epoch,
        highestAcceptedDigest: digest(current.payload) };
      return createClient({ origin, circle, deviceKey: keys[index], pinnedRootFingerprint: ids[2],
        rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; } },
        clock: () => time, retry: { maxAttempts: 1 } });
    },
    async publish(client) {
      const source = { kind: 'archive', artifact: await client.uploadArtifact(Buffer.from('test source'), 'application/gzip') };
      const prompt = await client.uploadArtifact(Buffer.from('test prompt'), 'text/plain');
      const payload = { ...clone(job.payload), source, prompt, roster_epoch: f.epoch, intent_id: randomUUID(),
        created_at: f.iso(), expires_at: new Date((time + 3600) * 1000).toISOString().replace('.000Z', 'Z') };
      const published = await client.submitJob(payload);
      return { ...published, payload };
    },
    async bump(client, epoch) {
      const next = signEnvelope('roster', { ...clone(roster.payload), epoch }, keys[2]);
      await client.publishRoster(next); f.epoch = epoch; return next;
    }
  };
  return f;
}

test('v1 real HTTP client heals stale proofs and skipped epochs for claims and result reads', async t => {
  const f = await realClientFixture(t), owner = f.client(0), offline = f.client(1);
  await f.bump(owner, 8);
  const submitted = await f.publish(owner);
  const ninth = await f.bump(owner, 9);
  const claim = await offline.claimNext(advertisement, { idempotencyKey: 'offline-claim', waitSeconds: 0 });
  assert.equal(claim.job_digest, submitted.jobDigest);
  const polls = f.requests.filter(r => r.url === base + '/jobs/claim-next');
  assert.equal(polls.length, 2);
  assert.equal(polls[0].key, polls[1].key);
  assert.equal(polls[0].proof.payload.body_digest,polls[1].proof.payload.body_digest);
  assert.equal(polls[0].proof.payload.content_length,polls[1].proof.payload.content_length);
  assert.deepEqual(polls.map(r => r.proof.payload.roster_epoch), [7, 9]);
  assert.ok(f.requests.some(r => r.url === base + '/rosters/8'));
  const started = await offline.startAttempt(claim.attempt);
  const outputs = await offline.uploadResultArtifacts({ candidate, transcript });
  const result = { ...payload(), ...outputs, job_digest: submitted.jobDigest,
    attempt_id: started.attempt_id, generation: started.generation, roster_epoch: 8, submitted_at: f.iso(),
    receipt: { ...payload().receipt, source: submitted.payload.source, started_at: f.iso(),
      finished_at: f.iso(), duration_ms: 0 } };
  // A pending result made before the bump keeps its original signed epoch/body.
  assert.equal((await offline.completeAttempt(started, result, { idempotencyKey: 'old-epoch-result' })).status, 'result-accepted');
  const returningBorrower = f.client(0, ninth);
  assert.deepEqual(await returningBorrower.fetchResult(submitted.jobDigest, { attempt: started }), candidate);
  assert.deepEqual(await returningBorrower.fetchTranscript(submitted.jobDigest, { attempt: started }), transcript);
});

test('v1 real HTTP client exposes expired committed claim and a fresh key reaches new work', async t => {
  const f = await realClientFixture(t), owner = f.client(0), lender = f.client(1);
  const first = await f.publish(owner);
  f.advance(1); // Distinct publication times; same-second ties sort by digest.
  const second = await f.publish(owner);
  const claim = await lender.claimNext(advertisement, { idempotencyKey: 'crash-left-claim', waitSeconds: 0 });
  assert.equal(claim.job_digest, first.jobDigest);
  f.advance(301);
  await assert.rejects(lender.claimNext(advertisement, { idempotencyKey: 'crash-left-claim', waitSeconds: 0 }), error => {
    assert.equal(error.code, 'lease_expired'); assert.equal(error.claimRejected, true);
    assert.equal(error.committedAttempt.attempt_id, claim.attempt.attempt_id);
    assert.equal(error.committedAttempt.state, 'expired'); return true;
  });
  const next = await lender.claimNext(advertisement, { idempotencyKey: 'fresh-claim', waitSeconds: 0, exclude: [first.jobDigest] });
  assert.equal(next.job_digest, second.jobDigest);
});

test('v1 real HTTP client refreshes an expired local roster before signing normal requests', async t => {
  const f = await realClientFixture(t), owner = f.client(0), offline = f.client(1);
  f.advance(8 * 86400);
  const next = signEnvelope('roster', { ...clone(roster.payload), epoch: 8, issued_at: f.iso(),
    valid_until: new Date(Date.parse(f.iso()) + 7 * 86400000).toISOString().replace('.000Z', 'Z') }, keys[2]);
  await owner.publishRoster(next);
  const values = [];
  for await (const item of offline.listJobs()) values.push(item);
  assert.deepEqual(values, []);
  assert.equal(f.requests.filter(r => r.method === 'GET' && r.url === base + '/roster').length, 1);
});

for (const method of ['fetchResult', 'fetchTranscript']) {
  test('v1 client ' + method + ' requires an independently retained attempt before any request', async t => {
    const f = await resultFixture(t);
    for (const options of [undefined, {}, { attempt: null }, { attempt: false }]) {
      await assert.rejects(f.client[method](jobDigest, options),
        error => error instanceof ClientError && error.code === 'attempt_required');
    }
    assert.equal(f.requests.length, 0);
  });
  test('v1 client ' + method + ' rejects a coordinator-consistent substituted attempt', async t => {
    const f = await resultFixture(t, { mutate: p => { p.generation = 2; }, attemptOverrides: { generation: 2 } });
    await assert.rejects(f.client[method](jobDigest, { attempt: attempt() }),
      error => error instanceof ClientError && error.code === 'stale_attempt');
    assert.ok(f.requests.every(r => !r.req.url.includes('/artifacts/')));
  });
  test('v1 client ' + method + ' snapshots the retained binding before asynchronous reads', async t => {
    const retained = attempt();
    const f = await resultFixture(t, {
      mutate: p => { p.generation = 2; }, attemptOverrides: { generation: 2 },
      client: { fetch: (...args) => { retained.generation = 2; return globalThis.fetch(...args); } }
    });
    await assert.rejects(f.client[method](jobDigest, { attempt: retained }),
      error => error instanceof ClientError && error.code === 'stale_attempt');
    assert.ok(f.requests.every(r => !r.req.url.includes('/artifacts/')));
  });
}

for (const value of [false, 0, '']) {
  test('v1 client rejects non-null falsy current_attempt ' + JSON.stringify(value), async t => {
    const f = await fixture(t, ({ res }) => json(res, view({ current_attempt: value })));
    await assert.rejects(f.client.getJob(jobDigest), error => error instanceof ClientError);
  });
}
for (const field of ['claimed_at', 'lease_expires_at', 'execution_started_at', 'stopped_at']) {
  for (const value of [7, '', 'not-a-time', '2026-10-09', '2026-10-09T12:00:10.000Z',
    '2026-10-09T12:00:10+00:00', '2026-02-30T12:00:10Z', '-000001-01-01T00:00:00Z',
    '2026-10-09T12:00:60Z']) {
    test('v1 client rejects noncanonical Attempt ' + field + ' ' + JSON.stringify(value), async t => {
      const f = await fixture(t, ({ res }) => json(res, view({ current_attempt: attempt({ [field]: value }) })));
      await assert.rejects(f.client.getJob(jobDigest), error => error instanceof ClientError);
    });
  }
}
for (const value of [false, 1, '', 'x'.repeat(4097), '😀'.repeat(4097)]) {
  test('v1 client rejects invalid Attempt reason type/length ' + typeof value + '/' + String(value).length, async t => {
    const f = await fixture(t, ({ res }) => json(res, view({ current_attempt: attempt({ reason: value }) })));
    await assert.rejects(f.client.getJob(jobDigest), error => error instanceof ClientError);
  });
}
test('v1 client accepts canonical Attempt timestamps, nullable fields and code-point reason bound', async t => {
  const expected = view({ current_attempt: attempt({ claimed_at: '2024-02-29T12:00:10Z',
    execution_started_at: null, stopped_at: null, reason: '😀'.repeat(4096) }) });
  const f = await fixture(t, ({ res }) => json(res, expected));
  assert.deepEqual(await f.client.getJob(jobDigest), expected);
});

const receiptLimits = { cpu: 'cpu', memory_bytes: 'memory', wall_seconds: 'wall',
  output_bytes: 'output', disk_bytes: 'storage' };
for (const [limit, name] of Object.entries(receiptLimits)) {
  test('v1 client rejects explicitly unenforced required ' + limit, async t => {
    const f = await resultFixture(t, { mutate: p => { p.receipt.unenforced = [name]; } });
    await assert.rejects(f.client.fetchResult(jobDigest, { attempt: f.retainedAttempt }),
      error => error instanceof ClientError && error.code === 'requirements_mismatch');
    assert.ok(f.requests.every(r => !r.req.url.includes('/artifacts/')));
  });
  test('v1 client rejects an explicit enforced list missing required ' + limit, async t => {
    const f = await resultFixture(t, { mutate: p => {
      p.receipt.enforced_limits = Object.values(receiptLimits).filter(value => value !== name);
    } });
    await assert.rejects(f.client.fetchResult(jobDigest, { attempt: f.retainedAttempt }),
      error => error instanceof ClientError && error.code === 'requirements_mismatch');
  });
  test('v1 client permits explicitly unenforced preferred ' + limit, async t => {
    const jobPayload = clone(job.payload);
    jobPayload.requirements.limit_modes = { [limit]: 'preferred' };
    const f = await resultFixture(t, { jobEnvelope: signEnvelope('job', jobPayload, keys[0]), mutate: p => {
      p.receipt.enforced_limits = Object.values(receiptLimits).filter(value => value !== name);
      p.receipt.unenforced = [name];
    } });
    assert.deepEqual(await f.client.fetchResult(f.jobDigest, { attempt: f.retainedAttempt }), candidate);
  });
}
test('v1 client rejects an unreported preferred-limit enforcement gap', async t => {
  const jobPayload = clone(job.payload);
  jobPayload.requirements.limit_modes = { disk_bytes: 'preferred' };
  const f = await resultFixture(t, { jobEnvelope: signEnvelope('job', jobPayload, keys[0]), mutate: p => {
    p.receipt.enforced_limits = ['cpu', 'memory', 'wall', 'output'];
  } });
  await assert.rejects(f.client.fetchResult(f.jobDigest, { attempt: f.retainedAttempt }),
    error => error instanceof ClientError && error.code === 'requirements_mismatch');
});
test('v1 client rejects contradictory preferred-limit receipt evidence', async t => {
  const jobPayload = clone(job.payload);
  jobPayload.requirements.limit_modes = { disk_bytes: 'preferred' };
  const f = await resultFixture(t, { jobEnvelope: signEnvelope('job', jobPayload, keys[0]), mutate: p => {
    p.receipt.enforced_limits = Object.values(receiptLimits); p.receipt.unenforced = ['storage'];
  } });
  await assert.rejects(f.client.fetchResult(f.jobDigest, { attempt: f.retainedAttempt }),
    error => error instanceof ClientError && error.code === 'requirements_mismatch');
});
for (const [name, mutate] of [
  ['applied output ceiling', p => { p.receipt.limits_applied.output_bytes = candidate.length + transcript.length - 1; }],
  ['applied wall ceiling', p => { p.receipt.limits_applied.wall_seconds = 1; p.receipt.duration_ms = 1001; }]
]) {
  for (const method of ['fetchResult', 'fetchTranscript']) {
    test('v1 client ' + method + ' rejects result exceeding ' + name, async t => {
      const f = await resultFixture(t, { mutate });
      await assert.rejects(f.client[method](jobDigest, { attempt: f.retainedAttempt }),
        error => error instanceof ClientError && error.code === 'requirements_mismatch');
      assert.ok(f.requests.every(r => !r.req.url.includes('/artifacts/')));
    });
  }
}
test('v1 client accepts result exactly at both applied receipt ceilings without optional evidence', async t => {
  const f = await resultFixture(t, { mutate: p => {
    delete p.receipt.enforced_limits; delete p.receipt.unenforced;
    p.receipt.limits_applied.output_bytes = candidate.length + transcript.length;
    p.receipt.limits_applied.wall_seconds = 1; p.receipt.duration_ms = 1000;
  } });
  assert.deepEqual(await f.client.fetchResult(jobDigest, { attempt: f.retainedAttempt }), candidate);
});

function enrollmentItem(id, state = 'pending') {
  const invite_id = '66666666-6666-4666-8666-666666666666';
  return { enrollment_id: id, state, invite_id, device_public_key: pubs[0],
    enrollment_proof: createEnrollmentProof({ circle, invite_id, device_public_key: pubs[0] }, keys[3]),
    created_at: '2026-10-09T12:00:10Z' };
}
test('v1 client enrollment pagination preserves current states from an earlier pending snapshot', async t => {
  const items = ['pending', 'approved', 'rejected', 'expired'].map((state, index) =>
    enrollmentItem('77777777-7777-4777-8777-77777777777' + index, state));
  const f = await fixture(t, ({ res, url }, requests) => {
    const index = requests.length - 1;
    assert.equal(url.pathname, base + '/enrollments');
    assert.equal(url.searchParams.get('state'), 'pending');
    assert.equal(url.searchParams.get('cursor'), index ? 'page-' + index : null);
    json(res, { items: [items[index]], next_cursor: index === items.length - 1 ? null : 'page-' + (index + 1) });
  });
  const actual = [];
  for await (const item of f.client.listEnrollments({ limit: 1 })) actual.push(item);
  assert.deepEqual(actual, items); assert.equal(f.requests.length, 4);
});
test('v1 client still rejects unknown enrollment states', async t => {
  const f = await fixture(t, ({ res }) => json(res, {
    items: [enrollmentItem('77777777-7777-4777-8777-777777777777', 'unknown')], next_cursor: null
  }));
  await assert.rejects(async () => { for await (const item of f.client.listEnrollments()) void item; },
    error => error instanceof ClientError);
});
for (const mediaType of ['text/plain', null]) {
  test('v1 client legacy GET probe rejects stored media type ' + mediaType, async t => {
    const f = await fixture(t, ({ req, res }) => {
      if (req.url === base + '/capabilities') return problem(res, 404, 'not_found');
      assert.equal(req.method, 'GET');
      blob(res, candidate, mediaType);
    });
    await assert.rejects(f.client.uploadArtifact(candidate, 'text/x-diff'),
      error => error instanceof ClientError && error.code === 'artifact_mismatch');
    assert.equal(f.requests.filter(r => r.req.method === 'PUT').length, 0);
  });
}

for(const method of ['release','fail']) {
  test('v1 client '+method+' accepts 4096 astral code points in an outbound reason',async t=>{
    const active=attempt({state:'active',holder:ids[1]}),reason='😀'.repeat(4096);
    const f=await fixture(t,({req,res,body})=>{
      assert.equal(req.method,'POST');assert.deepEqual(JSON.parse(body),{generation:active.generation,reason});
      json(res,{...active,state:method==='release'?'released':'failed',reason});
    },{keyIndex:1});
    assert.equal((await f.client[method](active,reason)).reason,reason);assert.equal(f.requests.length,1);
  });
  for(const reason of ['', 'x'.repeat(4097), '😀'.repeat(4097)]) {
    test('v1 client '+method+' rejects out-of-bounds outbound reason '+reason.length+' UTF-16 units',async t=>{
      const f=await fixture(t,()=>{throw new Error('must reject before transport');},{keyIndex:1});
      await assert.rejects(f.client[method](attempt({holder:ids[1]}),reason),{code:'invalid_request'});
      assert.equal(f.requests.length,0);
    });
  }
}

const requestedCheck={cmd:'npm test',exit:0,timed_out:false,parser:null,summary:'',observed_by:'sandbox',changed_test_files:[]};
for(const [label,checks,code] of [
  ['omitted',undefined,'verification_missing'],
  ['empty',[],'verification_missing'],
  ['different command',[{...requestedCheck,cmd:'true'}],'verification_mismatch'],
  ['different whitespace',[{...requestedCheck,cmd:'npm test '}],'verification_mismatch'],
  ['requested passing check',[requestedCheck],null],
  ['requested failing check',[{...requestedCheck,exit:1}],null],
  ['requested timed-out check',[{...requestedCheck,exit:null,timed_out:true}],null],
])for(const method of ['fetchReceipt','fetchResult','fetchTranscript'])
test('requested check binding: '+label+' via '+method,async t=>{
  const jobPayload=clone(job.payload);jobPayload.verify={cmd:'npm test'};
  jobPayload.requirements.capabilities=[...new Set([...jobPayload.requirements.capabilities,'verify_v1'])];
  jobPayload.requirements.limits.wall_seconds=Math.max(300,jobPayload.requirements.limits.wall_seconds);
  const f=await resultFixture(t,{jobEnvelope:signEnvelope('job',jobPayload,keys[0]),mutate:result=>{
    result.receipt.capabilities_applied=[...new Set([...result.receipt.capabilities_applied,'verify_v1'])];
    if(checks!==undefined)result.checks=structuredClone(checks);
  }});
  if(code) {
    await assert.rejects(f.client[method](f.jobDigest,{attempt:f.retainedAttempt}),error=>error instanceof ClientError&&error.code===code);
    assert.ok(f.requests.every(r=>!r.req.url.includes('/artifacts/')),'reject before downloading returned files');
  } else {
    const value=await f.client[method](f.jobDigest,{attempt:f.retainedAttempt});
    if(method==='fetchReceipt')assert.deepEqual(value.checks,checks);
    else assert.deepEqual(value,method==='fetchResult'?candidate:transcript);
  }
});

test('verified check metadata explains the agent-mutable workspace without rewriting signed checks',async t=>{
  const check={...requestedCheck,exit:1};
  const f=await resultFixture(t,{mutate:result=>{result.checks=[check];}});
  const receipt=await f.client.fetchReceipt(f.jobDigest,{attempt:f.retainedAttempt});
  assert.deepEqual(receipt.checks,[check]);
  assert.deepEqual(receipt.check_context,{independent:false,agent_mutable_workspace:true,
    note:"Faravan ran npm test after the agent; the agent could change the project's test files and tools."});
  const result=await f.client.fetchResult(f.jobDigest,{attempt:f.retainedAttempt,includeMetadata:true});
  assert.deepEqual(result.checks,[check]);assert.deepEqual(result.check_context,receipt.check_context);
});

test('a result without a check carries no check provenance notice',async t=>{
  const f=await resultFixture(t);
  for(const method of ['fetchReceipt','fetchResult']) {
    const result=await f.client[method](f.jobDigest,{attempt:f.retainedAttempt,includeMetadata:true});
    assert.equal(Object.hasOwn(result,'check_context'),false);
  }
});

// Typed results (results_v1): the signed output kind is bound to the signed job's requested result.
function typedJob(change={}) {
  const payload=clone(job.payload);
  payload.source={kind:'none'};payload.result={kind:'message'};payload.requirements.capabilities=['results_v1'];
  Object.assign(payload,change);
  return signEnvelope('job',payload,keys[0]);
}
const typedResult=(output={kind:'message'})=>result=>{
  result.candidate=ref(candidate,'application/gzip');
  result.receipt={...result.receipt,source:{kind:'none'},capabilities_applied:['results_v1'],candidate_format:'tree'};
  if(output!==null)result.output=output;
};
test('fetchReceipt and fetchResult expose the signed output kind of a typed result',async t=>{
  const f=await resultFixture(t,{jobEnvelope:typedJob(),mutate:typedResult()});
  const receipt=await f.client.fetchReceipt(f.jobDigest,{attempt:f.retainedAttempt});
  assert.deepEqual(receipt.output,{kind:'message'});
  assert.ok(!f.requests.some(r=>r.req.url.includes('/artifacts/')),'the output kind needs no download');
  const result=await f.client.fetchResult(f.jobDigest,{attempt:f.retainedAttempt,includeMetadata:true});
  assert.deepEqual(result.output,{kind:'message'});
  assert.deepEqual(result.bytes,candidate);
});
test('a legacy result exposes no output',async t=>{
  const f=await resultFixture(t);
  assert.equal(Object.hasOwn(await f.client.fetchReceipt(f.jobDigest,{attempt:f.retainedAttempt}),'output'),false);
  assert.equal(Object.hasOwn(await f.client.fetchResult(f.jobDigest,{attempt:f.retainedAttempt,includeMetadata:true}),'output'),false);
});
for(const [label,options] of [
  ['files output for a message job',{jobEnvelope:typedJob(),mutate:typedResult({kind:'files'})}],
  ['missing output for a message job',{jobEnvelope:typedJob(),mutate:typedResult(null)}],
  ['output on a legacy job',{mutate:result=>{const {source,capabilities_applied}=result.receipt;typedResult()(result);Object.assign(result.receipt,{source,capabilities_applied});}}],
])for(const method of ['fetchReceipt','fetchResult'])
test('result kind binding refuses '+label+' via '+method,async t=>{
  const f=await resultFixture(t,options);
  await assert.rejects(f.client[method](f.jobDigest,{attempt:f.retainedAttempt}),error=>error instanceof ClientError&&error.code==='result_kind_mismatch');
  assert.ok(f.requests.every(r=>!r.req.url.includes('/artifacts/')),'reject before downloading returned files');
});
test('submitJob sends a typed-result job only to a host that says results_v1',async t=>{
  for(const [capabilities,code] of [[[],'host_too_old'],[['results_v1'],null]]) {
    const typed=typedJob().payload;typed.roster_epoch=7;
    const f=await fixture(t,({req,res,body})=>{
      if(req.url===base+'/capabilities')return json(res,{artifact_head:false,faravan:null,min_member:null,capabilities});
      assert.equal(req.method,'POST');
      return json(res,view({job_digest:digest(typed),job:JSON.parse(body)}));
    });
    if(code)await assert.rejects(f.client.submitJob(typed,{idempotencyKey:'typed-1'}),{code});
    else assert.equal((await f.client.submitJob(typed,{idempotencyKey:'typed-1'})).jobDigest,digest(typed));
    assert.equal(f.requests.filter(r=>r.req.method==='POST').length,code?0:1);
  }
});
test('v1 client reports an explicit or unknown version on reads, mutations, and retries', async t => {
  for (const clientVersion of [undefined, null, '0.12.1']) {
    const expected = clientVersion ?? 'unknown';
    const f = await fixture(t, ({ req, res }, requests) => {
      assert.equal(req.headers['faravan-version'], expected);
      if (requests.length === 1) return req.socket.destroy();
      json(res, view(), req.method === 'POST' ? 201 : 200);
    }, { client: { clientVersion } });
    await f.client.getJob(jobDigest);
    await f.client.submitJob(clone(job.payload), { idempotencyKey: 'version-report' });
    assert.equal(f.requests.length, 3);
  }
});

test('v1 client rejects unreadable version options before making a request', () => {
  for (const clientVersion of ['nightly', '0.12', '0.12.1-beta', '1.0.0\r\nX-Test: yes',
    '9007199254740992.0.0', 12, {}]) {
    assert.throws(() => createClient({
      origin: 'http://127.0.0.1:1234', circle, deviceKey: keys[0], pinnedRootFingerprint: ids[2],
      rosterCache: { get: async () => null, set: async () => {} }, clientVersion
    }), error => error instanceof ClientError && error.code === 'invalid_request');
  }
});

test('v1 client preserves precise update-required details without retries', async t => {
  const f = await fixture(t, ({ res }) => json(res, {
    type: 'urn:faravan:problem:client_update_required', title: 'client update required',
    status: 409, code: 'client_update_required', retryable: false, outcome: 'not_applied',
    min_member: '0.12.0', client_version: '0.10.0',
    detail: 'Update Faravan to 0.12.0 or newer before making changes.'
  }, 409, { 'content-type': 'application/problem+json' }), { client: { clientVersion: '0.10.0' } });
  await assert.rejects(f.client.submitJob(clone(job.payload)), error => {
    assert.equal(error.code, 'client_update_required'); assert.equal(error.status, 409);
    assert.equal(error.retryable, false); assert.equal(error.outcome, 'not_applied');
    assert.equal(error.problem.min_member, '0.12.0'); assert.equal(error.problem.client_version, '0.10.0');
    return true;
  });
  assert.equal(f.requests.length, 1); assert.equal(f.sleeps.length, 0);
});

test('parent-linked jobs refuse a host without parent_link_v1 before a signed job is posted',async t=>{
 const f=await fixture(t,({req,res})=>{assert.equal(req.url,base+'/capabilities');json(res,{capabilities:[]});});
 const payload=clone(job.payload);payload.parent={job_digest:'sha256:'+'a'.repeat(64),result_digest:'sha256:'+'b'.repeat(64)};payload.requirements.capabilities.push('parent_link_v1');
 await assert.rejects(f.client.submitJob(payload,{idempotencyKey:'parent-once'}),e=>e.code==='host_too_old');
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].req.method,'GET');
});

test('a host that predates the automatic choice is not sent which choices a lender can make',async t=>{
 let support=false;const beats=[];
 const f=await fixture(t,({req,res,body})=>{
   if(req.url===base+'/capabilities')return json(res,{capabilities:support?['budget_v1','model_effort_pairs_v1','auto_run_v1']:['budget_v1','model_effort_pairs_v1']});
   if(req.url===base+'/heartbeat'){beats.push(JSON.parse(body));return json(res,{received_at:'2026-10-09T12:02:00Z',online_seconds:90});}
   assert.fail('unexpected request '+req.url);
 });
 const body={agents:[{adapter:'codex',model_efforts:[{model:'example-model',effort:'low'}],auto_run_intents:['cheapest']}],capabilities:['model_effort_pairs_v1','auto_run_v1']};
 await f.client.heartbeat(body);
 assert.equal(Object.hasOwn(beats[0].agents[0],'auto_run_intents'),false);assert.deepEqual(beats[0].capabilities,['model_effort_pairs_v1']);
 assert.equal(beats[0].agents[0].model_efforts.length,1,'the pairs themselves still go to a host that knows them');
 support=true;await f.client.capabilities({refresh:true});await f.client.heartbeat(body);
 assert.deepEqual(beats[1],body);
});

test('skipped check context never claims the command ran',async t=>{
 const f=await resultFixture(t,{mutate:result=>{result.checks=[{...requestedCheck,exit:null,skipped:'The fresh check workspace could not start.'}];}});
 const view=await f.client.fetchReceipt(f.jobDigest,{attempt:f.retainedAttempt});
 assert.equal(view.check_context.note,"The check didn't run, so nothing was verified.");
});

test('pair negotiation refuses explicit effort on old hosts and refreshes heartbeat shape',async t=>{
 let support=false;const beats=[];
 const f=await fixture(t,({req,res,body})=>{
   if(req.url===base+'/capabilities')return json(res,{capabilities:support?['budget_v1','model_effort_pairs_v1']:['budget_v1']});
   if(req.url===base+'/heartbeat'){beats.push(JSON.parse(body));return json(res,{received_at:'2026-10-09T12:02:00Z',online_seconds:90});}
   assert.fail('unexpected request '+req.url);
 });
 const payload=clone(job.payload);payload.requirements.capabilities=[...new Set([...payload.requirements.capabilities,'budget_v1'])];payload.budget_v1={max_list_usd:2,effort:'low'};
 await assert.rejects(f.client.submitJob(payload),{code:'host_too_old'});
 const body={agents:[{adapter:'codex',model_efforts:[{model:'example-model',effort:'low'}]}],capabilities:['model_effort_pairs_v1']};
 await f.client.heartbeat(body);
 assert.equal(Object.hasOwn(beats[0].agents[0],'model_efforts'),false);assert.deepEqual(beats[0].capabilities,[]);
 support=true;await f.client.heartbeat(body);assert.equal(Object.hasOwn(beats[1].agents[0],'model_efforts'),false);
 await f.client.capabilities({refresh:true});await f.client.heartbeat(body);
 assert.deepEqual(beats[2],body);assert.equal(f.requests.filter(r=>r.req.url===base+'/jobs').length,0);
});

// D9 T4: only a fetched, verified and cached roster may report a fresh read; every failure reports nothing.
test('a roster read reports a fresh verified roster only after it is accepted and cached', async t => {
  const next = signEnvelope('roster', { ...clone(roster.payload), epoch: 8 }, keys[2]);
  const seen = [];
  const f = await fixture(t, ({ res }) => json(res, next), { client: { onRosterFetched: value => seen.push(value) } });
  await f.client.refreshRoster();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].circle, circle);
  assert.equal(seen[0].fetchedAt, now * 1000);
  assert.equal(seen[0].rosterDigest, digest(next.payload));
  assert.deepEqual(seen[0].members.map(m => m.key_id), next.payload.members.map(m => m.key_id));
});

for (const [name, handler, extra] of [
  ['a failed fetch', ({ res }) => problem(res, 400, 'invalid_request'), {}],
  ['a bad signature', ({ res }) => { const bad = signEnvelope('roster', { ...clone(roster.payload), epoch: 8 }, keys[2]); bad.payload.epoch = 9; json(res, bad); }, {}],
  ['a cache write that is rejected', ({ res }) => json(res, signEnvelope('roster', { ...clone(roster.payload), epoch: 8 }, keys[2])),
    { rosterCache: { get: async () => ({ current: clone(roster), history: [], highestAcceptedEpoch: 7, highestAcceptedDigest: digest(roster.payload) }),
      set: async () => { throw new Error('disk full'); } } }]
]) {
  test('D9 T4: ' + name + ' reports no fresh roster', async t => {
    const seen = [];
    const f = await fixture(t, handler, { client: { onRosterFetched: value => seen.push(value), ...extra } });
    await assert.rejects(f.client.refreshRoster());
    assert.deepEqual(seen, []);
  });
}
