// TESTS NOT RUN by Dot. Synthetic golden-vector keys only; no actual enrollment or agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createClient,ClientError} from '../../lib/v1/client.mjs';
import {canonicalize,digest,digestBytes,privateKeyFromSeed,signEnvelope,verifyEnvelope,verifyRequestProof} from '../../lib/protocol/index.mjs';
// These repeated-byte keys are explicitly TEST-ONLY, with no real identity.
const vectors = JSON.parse(readFileSync(new URL('../../docs/protocol/vectors/golden.json', import.meta.url)));
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

const signedResult = p => {
  // These are real schema/profile and cryptographic checks, not client verifier replacements.
  const envelope=signEnvelope('result',p,keys[1]);
  assert.equal(verifyEnvelope('result',envelope,pubs[1]).ok,true,'synthetic result must independently validate');
  return envelope;
};
async function resultFixture(t,{mutate=()=>{},acceptedOverrides={},candidateBytes=candidate,
  transcriptBytes=transcript,client={},intercept=()=>false}={}) {
  let result=payload();mutate(result);
  let envelope=signedResult(result);
  let accepted=attempt(acceptedOverrides);
  const f=await fixture(t,async record=>{
    const {req,res}=record;
    if(await intercept(record))return;
    if(req.url===jobPath)return json(res,view({state:'result-accepted',attempts_started:1,
      current_attempt:accepted,result_digest:digest(result)}));
    if(req.url===jobPath+'/result')return json(res,envelope);
    if(req.url===base+'/artifacts/'+result.candidate.digest.slice(7))return blob(res,candidateBytes);
    if(req.url===base+'/artifacts/'+result.transcript.digest.slice(7))return blob(res,transcriptBytes,'application/x-ndjson');
    if(req.url===base+'/roster')return json(res,roster);
    assert.fail('Unexpected fixture route: '+req.url);
  },{client});
  return {...f,retainedAttempt:attempt(),signed:()=>clone(envelope),replace(mutate,overrides={}){
    result=payload();mutate(result);envelope=signedResult(result);accepted=attempt(overrides);
  }};
}
const artifactRequests=f=>f.requests.filter(r=>r.req.url.includes('/artifacts/'));
const errorCode=code=>error=>error instanceof ClientError&&error.code===code;

test('positive: actual candidate, metadata and transcript preserve signed authority',async t=>{
  const f=await resultFixture(t),retained=attempt(),before=clone(retained),signedBefore=f.signed();
  assert.equal(verifyEnvelope('job',job,pubs[0]).ok,true);
  assert.equal(verifyEnvelope('roster',roster,pubs[2]).ok,true);
  const result=await f.client.fetchResult(jobDigest,{attempt:retained,includeMetadata:true});
  assert.deepEqual(Object.keys(result).sort(),['bytes','candidate','job','receipt'].sort());
  assert.deepEqual(result.bytes,candidate);assert.deepEqual(result.candidate,payload().candidate);
  assert.deepEqual(result.receipt,payload().receipt);assert.deepEqual(result.job,job.payload);
  assert.deepEqual(artifactRequests(f).map(r=>r.req.url),[
    base+'/artifacts/'+digestBytes(candidate).slice(7),base+'/artifacts/'+digestBytes(transcript).slice(7)]);
  // fetchTranscript remains a verified Buffer even when includeMetadata is supplied.
  assert.deepEqual(await f.client.fetchTranscript(jobDigest,{attempt:retained,includeMetadata:true}),transcript);
  assert.deepEqual(retained,before);assert.deepEqual(f.signed(),signedBefore);
  result.bytes.fill(0);result.receipt.model='caller-local-change';result.job.requirements.harness=[];
  const repeated=await f.client.fetchResult(jobDigest,{attempt:retained,includeMetadata:true});
  assert.deepEqual(repeated.bytes,candidate);assert.deepEqual(repeated.receipt,payload().receipt);
  assert.deepEqual(repeated.job,job.payload);assert.deepEqual(f.signed(),signedBefore);
  assert.deepEqual(retained,before);
});

const corruption=[
  ['candidate digest',{candidateBytes:Buffer.alloc(candidate.length,120)},'digest_mismatch',['fetchResult']],
  ['candidate size',{mutate:p=>p.candidate.bytes++},'size_mismatch',['fetchResult']],
  ['transcript digest',{transcriptBytes:Buffer.alloc(transcript.length,120)},'digest_mismatch',['fetchResult','fetchTranscript']],
  ['transcript size',{mutate:p=>p.transcript.bytes++},'size_mismatch',['fetchResult','fetchTranscript']]
];
for(const [label,options,code,methods]of corruption)for(const method of methods)
test(method+' rejects '+label+' rather than returning unverified bytes',async t=>{
  const f=await resultFixture(t,options);
  await assert.rejects(f.client[method](jobDigest,{attempt:f.retainedAttempt,includeMetadata:true}),errorCode(code));
  if(label.startsWith('transcript')&&method==='fetchResult')
    assert.equal(artifactRequests(f).length,2,'candidate verification must not bypass transcript verification');
});

for(const method of ['fetchResult','fetchTranscript']){
  for(const [label,change,code]of [
    ['attempt id',a=>{a.attempt_id='55555555-5555-4555-8555-555555555555';},'stale_attempt'],
    ['generation',a=>{a.generation=2;},'stale_attempt'],
    ['holder',a=>{a.holder=ids[0];},'executor_mismatch'],
    ['job',a=>{a.job_digest='sha256:'+'f'.repeat(64);},'wrong_job_digest']
  ])test(method+' binds independently retained '+label,async t=>{
    const f=await resultFixture(t),retained=attempt();change(retained);
    const before=clone(retained);
    await assert.rejects(f.client[method](jobDigest,{attempt:retained}),errorCode(code));
    assert.equal(artifactRequests(f).length,0);assert.deepEqual(retained,before);
  });
  test(method+' refuses signed result substitution even when coordinator agrees',async t=>{
    const f=await resultFixture(t,{mutate:p=>{p.generation=2;},acceptedOverrides:{generation:2}});
    await assert.rejects(f.client[method](jobDigest,{attempt:f.retainedAttempt}),errorCode('stale_attempt'));
    assert.equal(artifactRequests(f).length,0);
  });
  for(const [label,mutate,code]of [
    ['attempt id',p=>{p.attempt_id='55555555-5555-4555-8555-555555555555';},'stale_attempt'],
    ['executor',p=>{p.executor=ids[0];},'executor_mismatch']
  ])test(method+' checks signed '+label+' after coordinator retained binding',async t=>{
    const f=await resultFixture(t,{mutate});
    await assert.rejects(f.client[method](jobDigest,{attempt:f.retainedAttempt}),errorCode(code));
    assert.equal(artifactRequests(f).length,0);
  });
  test(method+' refuses signed result for a different job',async t=>{
    const f=await resultFixture(t,{mutate:p=>{p.job_digest='sha256:'+'e'.repeat(64);}});
    await assert.rejects(f.client[method](jobDigest,{attempt:f.retainedAttempt}),errorCode('wrong_job_digest'));
    assert.equal(artifactRequests(f).length,0);
  });
  for(const field of ['harness','model'])test(method+' rejects independently valid signed incompatible '+field,async t=>{
    const f=await resultFixture(t,{mutate:p=>{p.receipt[field]='fixture-other-'+field;}});
    assert.equal(verifyEnvelope('result',f.signed(),pubs[1]).ok,true);
    const allowed=field==='harness'?job.payload.requirements.harness:job.payload.requirements.model.any_of;
    assert.ok(!allowed.includes(f.signed().payload.receipt[field]));
    await assert.rejects(f.client[method](jobDigest,{attempt:f.retainedAttempt}),errorCode('requirements_mismatch'));
    assert.equal(artifactRequests(f).length,0);
  });
  test(method+' retry after interrupted read re-verifies retained generation',async t=>{
    let interrupt=true;
    const f=await resultFixture(t,{client:{retry:{maxAttempts:1}},intercept:({req})=>{
      if(interrupt&&req.url===jobPath+'/result'){req.socket.destroy();return true;}return false;
    }});
    const retained=f.retainedAttempt,before=clone(retained);
    await assert.rejects(f.client[method](jobDigest,{attempt:retained}),errorCode('network_error'));
    interrupt=false;f.replace(p=>{p.generation=2;},{generation:2});
    await assert.rejects(f.client[method](jobDigest,{attempt:retained}),errorCode('stale_attempt'));
    assert.equal(artifactRequests(f).length,0);
    f.replace(()=>{});
    assert.deepEqual(await f.client[method](jobDigest,{attempt:retained}),method==='fetchResult'?candidate:transcript);
    assert.deepEqual(retained,before);
    const resultRequests=f.requests.filter(r=>r.req.url===jobPath+'/result');
    assert.equal(resultRequests.length,2);
    assert.notEqual(resultRequests[0].proof.payload.nonce,resultRequests[1].proof.payload.nonce);
  });
}

test('metadata preserves optional signed checks and labels their non-independent context',async t=>{
  const check={cmd:'npm test',exit:0,timed_out:false,parser:null,summary:'',observed_by:'sandbox',changed_test_files:[]};
  const f=await resultFixture(t,{mutate:p=>{p.checks=[clone(check)];}});
  const result=await f.client.fetchResult(jobDigest,{attempt:f.retainedAttempt,includeMetadata:true});
  assert.deepEqual(result.checks,[check]);
  assert.deepEqual(result.check_context,{independent:false,agent_mutable_workspace:true,
    note:"Faravan ran npm test after the agent; the agent could change the project's test files and tools."});
  assert.equal(Object.hasOwn(result,'output'),false,'legacy vector has no typed output');
  assert.deepEqual(result.receipt,payload().receipt);
  assert.deepEqual(result.job,job.payload);
});
