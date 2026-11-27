import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { HOST_CAPABILITIES } from '../lib/v1/versions.mjs';

// Coordinator GET /offers (host capability offers_v1) and the client's listOffers/claimJob. Real store + HTTP handler + client,
// TEST-ONLY golden keys; nothing here starts a provider, sandbox or browser.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pubs = keys.map(p.exportPublicKey), ids = pubs.map(p.fingerprint);
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k, v]) => [k, v.envelope]));
const circle = vectors.job.payload.circle;
const base = '/v1/circles/' + circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const ad = {
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'], egress: ['provider-only'],
  enforced_limits: Object.keys(vectors.job.payload.requirements.limits), max_limits: vectors.job.payload.requirements.limits,
};
const sourceBytes = Buffer.from('test-only compressed source fixture'), promptBytes = Buffer.from('test-only prompt');
async function eventually(check, message) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };

// Members: 0 borrower, 1 and 3 lenders.
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-v1-offers-'));
  const requests = [], errors = [];
  let handler, store, now = start;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const roster = p.signEnvelope('roster', { ...vectors.roster.payload, members: [
    ...vectors.roster.payload.members.filter(m => m.key_id === ids[0] || m.key_id === ids[1]),
    { key_id: ids[3], public_key: pubs[3], joined_epoch: vectors.roster.payload.epoch }] }, keys[2]);
  store = openV1Store({ path: join(dir, 'store.sqlite'), origin, circle, rootFingerprint: ids[2], initialRoster: roster, clock: () => now });
  handler = createV1Handler({ store, blobDir: join(dir, 'blobs'), clock: () => now });
  t.after(async () => {
    handler.close?.(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(errors, [], errors.map(e => e.stack).join('\n'));
  });
  const f = { origin, requests, epoch: roster.payload.epoch,
    restart() {
      handler.close();store.close();
      store=openV1Store({path:join(dir,'store.sqlite'),origin,circle,rootFingerprint:ids[2],clock:()=>now});
      handler=createV1Handler({store,blobDir:join(dir,'blobs'),clock:()=>now});
    },
    get now() { return now; }, advance(n) { now += n; },
    client(index, extra = {}) {
      let snapshot = { current: roster, history: [], highestAcceptedEpoch: roster.payload.epoch, highestAcceptedDigest: p.digest(roster.payload) };
      return createClient({ origin, circle, deviceKey: keys[index], pinnedRootFingerprint: ids[2],
        rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; } },
        clock: () => now, retry: { maxAttempts: 1 }, ...extra });
    },
    raw(index, method, route, body, epoch = f.epoch, headers = {}) {
      const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body));
      const read = method === 'GET', key = method === 'POST' ? randomUUID() : '';
      const proof = p.buildRequestProof({ circle, roster_epoch: epoch, method, target: origin + base + route, body: bytes,
        content_type: read ? '' : 'application/json', artifact_media_type: '', idempotency_key: key, created: now,
        nonce: randomBytes(24).toString('base64url') }, keys[index]);
      return fetch(origin + base + route, { method, headers: { 'Faravan-Proof': proof, ...headers,
        ...(read ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), ...(key ? { 'Idempotency-Key': key } : {}) }) },
        ...(read ? {} : { body: bytes }) });
    },
    // One new queued job, published at the fixture's current clock second.
    async publish(borrower) {
      const source = { kind: 'archive', artifact: await borrower.uploadArtifact(sourceBytes, 'application/gzip') };
      const prompt = await borrower.uploadArtifact(promptBytes, 'text/plain');
      const payload = { ...structuredClone(vectors.job.payload), source, prompt, roster_epoch: f.epoch,
        intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600) };
      return (await borrower.submitJob(payload)).jobDigest;
    },
  };
  return f;
}

test('offers_v1 is declared in the host capabilities', async t => {
  assert.ok(HOST_CAPABILITIES.includes('offers_v1'));
  const f = await fixture(t);
  assert.ok((await f.client(1).capabilities()).capabilities.includes('offers_v1'));
});

test('explicit decline survives coordinator restart, takes no lease, and leaves the job open to another lender', async t => {
  const f=await fixture(t),borrower=f.client(0),lender=f.client(1),other=f.client(3);
  const digest=await f.publish(borrower),key=randomUUID();
  const ack=await lender.declineJob(digest,{idempotencyKey:key});
  assert.deepEqual(ack,{job_digest:digest,declined:true});
  assert.equal(f.requests.filter(row=>row.method==='POST'&&row.url.endsWith('/decline')).length,1);
  assert.deepEqual(await lender.declineJob(digest,{idempotencyKey:key}),ack,'a lost acknowledgement replays the same decision');
  f.restart();
  const job=await borrower.getJob(digest);
  assert.equal(job.state,'queued');assert.equal(job.current_attempt,null);assert.equal(job.attempts_started,0);
  assert.deepEqual(await collect(lender.listOffers({waitSeconds:0})),[]);
  await assert.rejects(lender.claimJob(digest,ad),{code:'forbidden'});
  assert.equal(await lender.claimNext(ad,{waitSeconds:0}),null,'legacy claim-next also respects a decline');
  assert.deepEqual((await collect(other.listOffers({waitSeconds:0}))).map(row=>row.job_digest),[digest]);
  assert.equal((await other.claimJob(digest,ad)).attempt.holder,ids[3]);
  assert.equal((await lender.declineJob(digest)).declined,true,'a recorded decline remains successful after another lender claims');
});

test('borrower observes an anonymous decline and its watch wakes', async t => {
  const f=await fixture(t),borrower=f.client(0),lender=f.client(1),digest=await f.publish(borrower);
  const initial=await borrower.getJob(digest);
  assert.equal(initial.declined_count,0);
  const old=await (await f.raw(0,'GET','/jobs/'+digest.slice(7))).json();
  assert.equal(Object.hasOwn(old,'declined_count'),false,'older clients receive the original closed shape');
  const revision=await borrower.waitForJobChange(digest,{after:null,waitSeconds:1});
  const waiting=borrower.waitForJobChange(digest,{after:revision.revision,waitSeconds:10});
  await eventually(()=>f.requests.filter(r=>r.url.includes('/watch')).length>=2,'watch did not arrive');
  await lender.declineJob(digest);
  const changed=await waiting;
  assert.notEqual(changed.revision,revision.revision);
  const job=await borrower.getJob(digest);
  assert.equal(job.declined_count,1);
  assert.equal((await collect(borrower.listJobs()))[0].declined_count,1);
  assert.equal(JSON.stringify(job).includes(ids[1]),false);
  await lender.declineJob(digest);
  assert.equal((await borrower.getJob(digest)).declined_count,1);
  f.restart();
  assert.equal((await borrower.getJob(digest)).declined_count,1,'the anonymous count survives a host restart');
});

test('job list and detail agree on comma-spaced client capabilities', async t => {
  const f=await fixture(t),digest=await f.publish(f.client(0));
  await f.client(1).declineJob(digest);
  for(const value of ['results_v1, decline_count_v1','  decline_count_v1  ','unknown_v1, decline_count_v1, invalid-token']){
    const headers={'Faravan-Client-Capabilities':value};
    const list=await (await f.raw(0,'GET','/jobs?limit=50',undefined,f.epoch,headers)).json();
    const detail=await (await f.raw(0,'GET','/jobs/'+digest.slice(7),undefined,f.epoch,headers)).json();
    assert.equal(list.items[0].declined_count,1,value);
    assert.equal(detail.declined_count,1,value);
  }
  const unknown={'Faravan-Client-Capabilities':'unknown_v1, invalid-token'};
  const unsupported=await (await f.raw(0,'GET','/jobs/'+digest.slice(7),undefined,f.epoch,unknown)).json();
  assert.equal(Object.hasOwn(unsupported,'declined_count'),false);
  const old=await (await f.raw(0,'GET','/jobs/'+digest.slice(7))).json();
  assert.equal(Object.hasOwn(old,'declined_count'),false);
});

test('a decline arriving after a claim does not exclude the lender from a later offer', async t => {
  const f=await fixture(t),borrower=f.client(0),lender=f.client(1),other=f.client(3),digest=await f.publish(borrower);
  const claim=await other.claimJob(digest,ad);
  assert.deepEqual(await lender.declineJob(digest),{job_digest:digest,declined:false});
  const response=await f.raw(3,'POST','/attempts/'+claim.attempt.attempt_id+'/release',
    {generation:claim.attempt.generation,reason:'approval_denied'});
  assert.equal(response.status,200);
  assert.deepEqual((await collect(lender.listOffers({waitSeconds:0}))).map(row=>row.job_digest),[digest]);
});

test('legacy approval_denied release records a decline for the releasing lender', async t => {
  const f=await fixture(t),borrower=f.client(0),lender=f.client(1),other=f.client(3),digest=await f.publish(borrower);
  const claim=await lender.claimJob(digest,ad);
  await lender.release(claim.attempt,JSON.stringify({code:'approval_denied'}));
  assert.equal((await borrower.getJob(digest)).declined_count,1);
  assert.deepEqual(await collect(lender.listOffers({waitSeconds:0})),[]);
  await assert.rejects(lender.claimJob(digest,ad),{code:'forbidden'});
  assert.equal(await lender.claimNext(ad,{waitSeconds:0}),null);
  assert.equal((await other.claimJob(digest,ad)).job_digest,digest);
});

test('decline refuses invalid bodies and a host without the capability without sending a decline', async t => {
  const f=await fixture(t),digest=await f.publish(f.client(0));
  assert.equal((await f.raw(1,'POST','/jobs/'+digest.slice(7)+'/decline',{other:true})).status,400);
  let declineRequests=0;
  const lender=f.client(1,{fetch:async(url,init)=>{
    if(String(url).endsWith('/capabilities'))return new Response(JSON.stringify({capabilities:['offers_v1']}),
      {status:200,headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/decline'))declineRequests++;
    return fetch(url,init);
  }});
  await assert.rejects(lender.declineJob(digest),{code:'host_too_old'});
  assert.equal(declineRequests,0);
});

test('GET /offers lists queued jobs only, oldest-queued first, with server published_at, across pages', { timeout: 20000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  const a = await f.publish(borrower); f.advance(1);
  const b = await f.publish(borrower); f.advance(1);
  const c = await f.publish(borrower); f.advance(1);
  const d = await f.publish(borrower);
  await lender.claimJob(b, ad); // b is taken: no longer an offer
  const one = await collect(lender.listOffers({ limit: 1, waitSeconds: 0 }));
  assert.deepEqual(one.map(v => v.job_digest), [a, c, d], 'queued only, oldest first, paged one at a time');
  assert.deepEqual(one.map(v => v.published_at), [iso(start), iso(start + 2), iso(start + 3)]);
  assert.ok(one.every(v => v.state === 'queued' && v.current_attempt === null));
  const wide = await collect(lender.listOffers({ limit: 100, waitSeconds: 0 }));
  assert.deepEqual(wide.map(v => v.job_digest), [a, c, d]);
  // Raw page contract: three pages of two never repeat or skip.
  const first = await (await f.raw(1, 'GET', '/offers?limit=2')).json();
  assert.deepEqual(Object.keys(first).sort(), ['items', 'next_cursor', 'revision']);
  assert.deepEqual(first.items.map(i => i.job_digest), [a, c]);
  assert.equal(typeof first.next_cursor, 'string');
  const second = await (await f.raw(1, 'GET', '/offers?limit=2&cursor=' + encodeURIComponent(first.next_cursor))).json();
  assert.deepEqual(second.items.map(i => i.job_digest), [d]);
  assert.equal(second.next_cursor, null);
  // Old clients are unaffected: GET /jobs still lists every job, taken ones included, with the unchanged JobView shape.
  const all = await collect(lender.listJobs());
  assert.equal(all.length, 4);
  assert.ok(all.every(v => !('published_at' in v)));
});

test('GET /offers rejects out-of-range paging and wait parameters', async t => {
  const f = await fixture(t);
  for (const query of ['limit=0', 'limit=101', 'wait=31', 'wait=-1', 'cursor=bogus', 'since=x', 'other=1']) {
    assert.equal((await f.raw(1, 'GET', '/offers?' + query)).status, 400, query);
  }
  assert.equal((await f.raw(1, 'GET', '/offers?limit=100&wait=0')).status, 200);
});

test('a scan spends one request per page and one nonce, never a history rescan', { timeout: 20000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  for (let n = 0; n < 5; n++) { await f.publish(borrower); f.advance(1); }
  const before = f.requests.length;
  assert.equal((await collect(lender.listOffers({ limit: 2, waitSeconds: 0 }))).length, 5);
  const used = f.requests.slice(before).filter(r => r.url.includes('/offers'));
  assert.equal(used.length, 3);
});

test('long poll wakes on publish', { timeout: 15000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1);
  const waiting = collect(lender.listOffers({ waitSeconds: 10 }));
  await eventually(() => f.requests.some(r => r.url.includes('/offers')), 'poll did not arrive');
  await delay(30);
  const began = performance.now();
  const digest = await f.publish(borrower);
  const seen = await waiting;
  assert.ok(performance.now() - began < 3000, 'must wake well before the 10 s wait');
  assert.deepEqual(seen.map(v => v.job_digest), [digest]);
});

test('long poll wakes on release and on fail-before-start, and on an offer being taken', { timeout: 30000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1), watcher = f.client(3);
  const digest = await f.publish(borrower);
  for (const action of ['release', 'fail']) {
    const claim = await lender.claimJob(digest, ad);
    let revision;
    assert.deepEqual(await collect(watcher.listOffers({ waitSeconds: 0, onRevision: r => { revision = r; } })), []);
    const waiting = collect(watcher.listOffers({ waitSeconds: 10, since: revision }));
    await eventually(() => f.requests.filter(r => r.url.includes('/offers')).length >= 2 + (action === 'fail' ? 2 : 0), 'poll did not arrive');
    await delay(30);
    const response = await f.raw(1, 'POST', '/attempts/' + claim.attempt.attempt_id + '/' + action,
      { generation: claim.attempt.generation, reason: 'sandbox_failed' });
    assert.equal(response.status, 200, action);
    const seen = await waiting;
    assert.deepEqual(seen.map(v => v.job_digest), [digest], 'the job is open again after ' + action);
    assert.equal(seen[0].state, 'queued');
    if (action === 'release') f.advance(1);
  }
});

test('long poll with since wakes when another lender takes the offer', { timeout: 15000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lender = f.client(1), watcher = f.client(3);
  const digest = await f.publish(borrower);
  let revision;
  assert.deepEqual((await collect(watcher.listOffers({ waitSeconds: 0, onRevision: r => { revision = r; } }))).map(v => v.job_digest), [digest]);
  const waiting = collect(watcher.listOffers({ waitSeconds: 10, since: revision }));
  await eventually(() => f.requests.filter(r => r.url.includes('/offers')).length >= 2, 'poll did not arrive');
  await delay(30);
  await lender.claimJob(digest, ad);
  assert.deepEqual(await waiting, []);
});

test('long poll with no event returns an empty page at its deadline', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const began = performance.now();
  assert.deepEqual(await collect(f.client(1).listOffers({ waitSeconds: 1 })), []);
  assert.ok(performance.now() - began >= 900);
});

test('long poll stops when the caller aborts', { timeout: 15000 }, async t => {
  const f = await fixture(t), lender = f.client(1), controller = new AbortController();
  const waiting = collect(lender.listOffers({ waitSeconds: 10, signal: controller.signal }));
  await eventually(() => f.requests.some(r => r.url.includes('/offers')), 'poll did not arrive');
  controller.abort();
  await assert.rejects(waiting);
});

test('claimJob returns the same verified shape as claimNext and the race has exactly one winner', { timeout: 20000 }, async t => {
  const f = await fixture(t), borrower = f.client(0), lenderA = f.client(1), lenderB = f.client(3);
  const named = await f.publish(borrower);
  const viaNamed = await lenderA.claimJob(named, ad, { leaseSeconds: 60 });
  assert.deepEqual(Object.keys(viaNamed).sort(), ['attempt', 'job', 'job_digest']);
  assert.equal(viaNamed.job_digest, named);
  assert.equal(viaNamed.attempt.holder, ids[1]);
  assert.equal(viaNamed.attempt.execution_started_at, null);
  await f.publish(borrower);
  const viaNext = await lenderB.claimNext(ad, { waitSeconds: 0 });
  assert.deepEqual(Object.keys(viaNext).sort(), Object.keys(viaNamed).sort());
  await assert.rejects(lenderB.claimJob(named, ad), error => error.code === 'conflict');
  await assert.rejects(lenderA.claimJob('sha256:' + '0'.repeat(64), ad), error => error.code === 'not_found');
});

for (const [label, firstClaim, secondClaim] of [
  ['named claim vs claim-next', (c, d) => c.claimJob(d, ad), (c) => c.claimNext(ad, { waitSeconds: 0 })],
  ['named claim vs named claim', (c, d) => c.claimJob(d, ad), (c, d) => c.claimJob(d, ad)],
  ['claim-next vs claim-next', (c) => c.claimNext(ad, { waitSeconds: 0 }), (c) => c.claimNext(ad, { waitSeconds: 0 })],
]) {
  test(`mixed old and new lenders race one job: exactly one winner (${label})`, { timeout: 20000 }, async t => {
    const f = await fixture(t), borrower = f.client(0), lenderA = f.client(1), lenderB = f.client(3);
    const digest = await f.publish(borrower);
    const results = await Promise.allSettled([firstClaim(lenderA, digest), secondClaim(lenderB, digest)]);
    const won = results.filter(r => r.status === 'fulfilled' && r.value !== null);
    assert.equal(won.length, 1, JSON.stringify(results.map(r => r.status === 'fulfilled' ? (r.value && r.value.job_digest) : r.reason.code)));
    assert.equal(won[0].value.job_digest, digest);
    for (const loser of results.filter(r => r !== won[0])) {
      if (loser.status === 'rejected') assert.equal(loser.reason.code, 'conflict');
    }
    assert.deepEqual(await collect(lenderA.listOffers({ waitSeconds: 0 })), [], 'a taken job is no longer an offer');
    assert.equal((await borrower.getJob(digest)).state, 'claimed');
  });
}

test('a host without offers_v1 is reported as host_too_old so callers fall back to listJobs', async t => {
  const f = await fixture(t);
  const old = f.client(1, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/capabilities')) return response;
    const body = await response.json(); body.capabilities = body.capabilities.filter(c => c !== 'offers_v1');
    return new Response(p.canonicalize(body), { status: response.status, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(collect(old.listOffers({ waitSeconds: 0 })), error => error.code === 'host_too_old');
  assert.ok(!f.requests.some(r => r.url.includes('/offers')), 'no /offers request to a host that lacks it');
});

test('immutable job verification is cached by envelope bytes: no repeat roster reads, and a tampered envelope is never trusted from the cache', { timeout: 20000 }, async t => {
  const f = await fixture(t), borrower = f.client(0);
  const digests = [];
  for (let n = 0; n < 3; n++) { digests.push(await f.publish(borrower)); f.advance(1); }
  // A newer roster makes the jobs' signing epoch historical for a reader that starts with no roster history.
  const next = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: f.epoch + 1, members: [
    ...vectors.roster.payload.members.filter(m => m.key_id === ids[0] || m.key_id === ids[1]),
    { key_id: ids[3], public_key: pubs[3], joined_epoch: vectors.roster.payload.epoch }] }, keys[2]);
  assert.equal((await f.raw(0, 'PUT', '/roster', next, f.epoch + 1)).status, 200);
  f.epoch += 1;
  let snapshot = { current: null, history: [], highestAcceptedEpoch: 0 }, tamper = false;
  const reader = createClient({ origin: f.origin, circle, deviceKey: keys[1], pinnedRootFingerprint: ids[2],
    rosterCache: { get: async () => snapshot, set: async value => { snapshot = value; } },
    clock: () => f.now, retry: { maxAttempts: 1 },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!tamper || !/\/jobs\?/.test(String(url))) return response;
      const body = await response.json(); body.items[0].job.payload.max_attempts = 9;
      return new Response(p.canonicalize(body), { status: response.status, headers: { 'content-type': 'application/json' } });
    } });
  await reader.refreshRoster();
  const historical = () => f.requests.filter(r => r.url.includes('/rosters/')).length;
  const before = historical();
  assert.equal((await collect(reader.listJobs())).length, 3);
  const afterFirst = historical();
  assert.ok(afterFirst > before, 'the first scan reads the historical roster');
  assert.equal((await collect(reader.listJobs())).length, 3);
  assert.equal(historical(), afterFirst, 'the second scan reads no roster');
  tamper = true;
  await assert.rejects(collect(reader.listJobs()), error => ['invalid_signature', 'wrong_job_digest', 'invalid_request'].includes(error.code));
});

test('a passing release and two named claims still authorize only one run',async t=>{
 const f=await fixture(t),borrower=f.client(0),lender=f.client(1),other=f.client(3),digest=await f.publish(borrower);
 const first=await lender.claimJob(digest,ad);
 await lender.release(first.attempt,JSON.stringify({code:'resources_incomplete'}));
 assert.deepEqual((await collect(lender.listOffers({waitSeconds:0}))).map(v=>v.job_digest),[digest]);
 const raced=await Promise.allSettled([lender.claimJob(digest,ad),other.claimJob(digest,ad)]);
 assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
 const index=raced.findIndex(r=>r.status==='fulfilled'),winner=index===0?lender:other,claim=raced[index].value;
 await winner.startAttempt(claim.attempt);
 await winner.observeExecutionStart(claim.attempt);
 await assert.rejects(lender.startAttempt(first.attempt));
 assert.equal((await borrower.getJob(digest)).attempts_started,1);
});
