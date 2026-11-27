import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-lifecycle-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {classifyHostFailure} from '../lib/v1/host-failure.mjs';
import {createClient, clientFailure} from '../lib/v1/client.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {createAuthorityClient} from '../lib/v1/authority-client.mjs';

test('jobs-list internal errors retain only the first repository lib frame', {timeout:120000}, async t=>{
  const f=await appFixture(t);
  const {lender,circle}=await f.connect({});
  const original=lender.app.device.client.bind(lender.app.device);
  t.after(()=>{lender.app.device.client=original;});
  const error=new Error('private message /home/ana/token=secret');
  error.stack='Error: private message /home/ana/token=secret\n'+
    '    at outside (/home/ana/private.mjs:1:2)\n'+
    '    at read ('+new URL('../lib/v1/client.mjs',import.meta.url).href+':123:45)\n'+
    '    at serve ('+new URL('../lib/v1/app.mjs',import.meta.url).href+':456:7)';
  lender.app.device.client=async()=>{throw error;};
  const answer=await api(lender.app,'/api/jobs?circle='+circle.id,{status:409});
  assert.equal(answer.code,'internal_error');
  const file=join(lender.home,'v1','lending-errors.jsonl');
  const row=await waitFor(async()=>{
    const lines=(await readFile(file,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
    return lines.find(row=>row.ref===answer.error_id);
  },'source diagnostic');
  assert.equal(row.source,'lib/v1/client.mjs:123');
  assert.doesNotMatch(JSON.stringify(row),/\/home\/|private message|token=secret|:45/);
});

test('closing an authority client during a jobs-list read does not abort that read', {timeout:120000}, async t=>{
  const f=await appFixture(t);
  const {lender,circle}=await f.connect({});
  const original=lender.app.device.client.bind(lender.app.device);
  const real=await original(circle.id);
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const store={async *listJobs(opts){entered();await gate;yield* real.listJobs(opts);}};
  const client=createAuthorityClient({ownKeyId:lender.app.device.keyId,incumbent:()=>store,member:()=>store,
    routes:{read:async()=>({}),write:async()=>{}}});
  lender.app.device.client=async()=>client;
  t.after(()=>{release();lender.app.device.client=original;client.close();});
  const response=api(lender.app,'/api/jobs?circle='+circle.id,{status:null,raw:true});
  await started;
  client.close();release();
  const answer=await response;
  assert.equal(answer.status,200);
  assert.deepEqual(await answer.json(),[]);
  const log=await readFile(join(lender.home,'v1','lending-errors.jsonl'),'utf8').catch(()=>'');
  assert.doesNotMatch(log,/GET \/api\/jobs/);
});

// Synthetic transport only: bootstrap avoids a roster fixture, not the actual request/retry pipeline.
const responseClient = ({fetch, sleep = async () => {}, maxAttempts = 2}) => createClient({
  origin: 'https://fixture.invalid', circle: '11111111-1111-4111-8111-111111111111',
  deviceKey: generateKeyPairSync('ed25519').privateKey,
  pinnedRootFingerprint: 'sha256:' + '1'.repeat(64),
  rosterCache: {get: async () => null, set: async () => {}},
  fetch, sleep, retry: {maxAttempts, baseMs: 0, capMs: 0},
});
const responsePost = (client, signal) => client.heartbeat({}, {
  bootstrap: true, idempotencyKey: 'synthetic-response-operation', signal,
});
const caught = async promise => {
  try { await promise; } catch (error) { return error; }
  assert.fail('expected failure');
};
const busyResponse = () => new Response(JSON.stringify({
  code: 'service_busy', detail: 'private-response-detail', outcome: 'not_applied',
}), {status: 503, headers: {'content-type': 'application/problem+json', 'retry-after': '120'}});

for (const deadline of [false, true]) test('actual client preserves received response through both mappings: ' + (deadline ? 'retry deadline' : 'attempt exhaustion'), async () => {
  const controller = new AbortController(); let calls = 0, sleeps = 0;
  const client = responseClient({
    fetch: async (_url, options) => {
      calls++; assert.equal(options.method, 'POST');
      assert.equal(options.headers['Idempotency-Key'], 'synthetic-response-operation');
      return busyResponse();
    },
    sleep: async ms => {
      sleeps++; assert.equal(ms, 120000);
      if (deadline) { controller.abort(new DOMException('deadline', 'TimeoutError')); throw controller.signal.reason; }
    },
  });
  const error = await caught(responsePost(client, controller.signal));
  assert.equal(error.code, 'service_busy'); assert.equal(error.retryAfterSeconds, 120);
  assert.equal(calls, deadline ? 1 : 2); assert.equal(sleeps, 1);
  const expected = {status: 503, code: 'service_busy', outcome: 'not_applied',
    operationKey: 'synthetic-response-operation', retryAfterSeconds: 120};
  assert.deepEqual(error.receivedResponse, expected);
  const classified = classifyHostFailure(error);
  assert.equal(classified.code, 'circle_unreachable'); assert.equal(classified.status, 409);
  assert.equal(classified.retryable, true); assert.equal(classified.cause, error);
  assert.deepEqual(classified.receivedResponse, expected);
  assert.deepEqual(clientFailure(classified), {code: 'network_error', status: 409, retryable: true, receivedResponse: expected});
  assert.deepEqual(clientFailure(error), {code: 'network_error', status: 503, retryable: true, receivedResponse: expected});
  assert.ok(!JSON.stringify(clientFailure(classified)).includes('private-response-detail'));
  assert.ok(!Object.hasOwn(clientFailure(classified), 'cause'));
});

test('actual client retains typed refusal and malformed response policy', async () => {
  const refused = await caught(responsePost(responseClient({fetch: async () => new Response(
    JSON.stringify({code: 'forbidden', outcome: 'not_applied'}), {status: 403, headers: {'content-type': 'application/problem+json'}},
  )})));
  assert.equal(classifyHostFailure(refused), refused);
  assert.deepEqual(clientFailure(refused), {code: 'forbidden', status: 403, retryable: false,
    receivedResponse: {status: 403, code: 'forbidden', outcome: 'not_applied', operationKey: 'synthetic-response-operation'}});
  const malformed = await caught(responsePost(responseClient({fetch: async () => new Response('{', {
    status: 200, headers: {'content-type': 'application/json'},
  })})));
  assert.equal(classifyHostFailure(malformed), malformed);
  assert.equal(malformed.responseReceived, true);
  assert.equal(malformed.retryable, false);
});

test('actual client transport causes and cancellation keep their precedence', async () => {
  for (const code of ['ECONNREFUSED', 'CERT_HAS_EXPIRED']) {
    const cause = Object.assign(new Error('private-transport-detail'), {code});
    const error = await caught(responsePost(responseClient({fetch: async () => { throw cause; }, maxAttempts: 1})));
    assert.equal(error.code, 'network_error'); assert.equal(error.cause, cause);
    const classified = classifyHostFailure(error);
    assert.equal(classified.code, 'circle_unreachable'); assert.equal(classified.cause, error);
    assert.equal(Object.hasOwn(classified, 'receivedResponse'), false);
    assert.equal(Object.hasOwn(clientFailure(classified), 'receivedResponse'), false);
  }
  const controller = new AbortController(), reason = new Error('person stopped');
  const error = await caught(responsePost(responseClient({
    fetch: async () => busyResponse(),
    sleep: async () => { controller.abort(reason); throw reason; },
  }), controller.signal));
  assert.equal(error, reason);
  assert.equal(classifyHostFailure(error, {callerSignal: controller.signal}).code, 'cancelled');
  const unknown = new Error('unknown wrapper', {cause: new TypeError('nested')});
  assert.equal(classifyHostFailure(unknown), unknown);
});

test('generic gateway statuses retain outward policy and unsafe retry delays are not copied', async () => {
  for (const status of [502, 503, 504]) {
    const error = await caught(responsePost(responseClient({fetch: async () => new Response('gateway', {
      status, headers: {'retry-after': '9'.repeat(400)},
    }), maxAttempts: 1})));
    assert.equal(error.code, 'http_error');
    assert.equal(error.receivedResponse.status, status);
    assert.equal(Object.hasOwn(error.receivedResponse, 'retryAfterSeconds'), false);
    const summary = clientFailure(classifyHostFailure(error));
    assert.equal(summary.code, 'network_error'); assert.equal(summary.status, 409);
    assert.equal(summary.retryable, true); assert.equal(summary.receivedResponse.code, 'http_error');
  }
});

test('received-response summary copies only bounded typed fields', async () => {
  const error = await caught(responsePost(responseClient({fetch: async () => busyResponse(), maxAttempts: 1})));
  error.receivedResponse = {...error.receivedResponse, code: 'x'.repeat(65), outcome: 'invented',
    operationKey: 'not a key', retryAfterSeconds: Infinity, detail: 'private', cause: new Error('private')};
  assert.deepEqual(clientFailure(classifyHostFailure(error)).receivedResponse, {status: 503});
  error.receivedResponse.status = 999;
  assert.equal(Object.hasOwn(clientFailure(classifyHostFailure(error)), 'receivedResponse'), false);
});


const signedIn = {providers: [{harness_id: 'codex', installed: true, signedIn: true}]};
const cold = () => [{spec: legacyProxyHarness('codex')}];
const lendingOn = async (app, circle) => {
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
};
const settingsOf = async app => JSON.parse(await readFile(join(app.home, 'v1', 'app-settings.json'), 'utf8'));
const bad = (status) => ctx => { ctx.res.writeHead(status); ctx.res.end(); return true; };
const modes = {
  refused: () => args => { args.req.socket.destroy(); return true; },
  'never answering': () => () => new Promise(() => {}),
  'a 502 from the gateway': () => bad(502),
};

// A circle host that sleeps is the normal case for a home computer. Resume must say so quickly, keep the person's
// intent, and start lending by itself when the host is back, with no second call.
for (const [label, make] of Object.entries(modes)) test(`Resume with a host that is ${label} answers circle_unreachable at once, then lending starts when the host is back`, {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  let down = true;
  const reachable = f.override, failing = make();
  const seen = [];
  f.override = async args => { if (down) seen.push(String(args.req.url)); return down ? failing(args) : reachable(args); };
  // Each retry-worker host init has its own short deadline here, so a host that never answers is abandoned and retried.
  const cold1 = await f.start('lender', {adapters: cold(), identityProbe: async () => signedIn, blockerRecheckMs: 300, hostProfileMs: 300, hostInitMs: 1500});
  const began = Date.now();
  const answer = await api(cold1.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}, status: 409});
  assert.ok(Date.now() - began < 1000, 'answered within one second: ' + (Date.now() - began));
  assert.equal(answer.code, 'circle_unreachable');
  assert.equal(answer.intent, 'on');assert.equal(answer.held, true);
  const saved = await settingsOf(cold1);
  assert.equal(saved.intent, 'on');assert.equal(saved.paused, false);assert.equal(saved.pause_until, null);assert.equal(saved.enabled, false);
  assert.equal(saved.activeCircle, circle.id);
  assert.equal((await api(cold1.app, '/api/lending')).enabled, false, 'execution is held');
  const status = await api(cold1.app, '/api/status');
  assert.equal(status.intent.on, true);assert.notEqual(status.intent.state, 'paused');
  down = false;
  // While the host was down, no job was claimed and nothing was reserved.
  assert.deepEqual(seen.filter(url => /claim|reserve|offer/.test(url)), [], 'no claim or reservation before host init succeeds');
  await waitFor(async () => (await api(cold1.app, '/api/lending')).enabled === true, 'lending starts with nobody acting', 60000);
  await waitFor(async () => (await api(cold1.app, '/api/status')).intent?.state === 'ready', 'ready', 60000);
  assert.equal((await settingsOf(cold1)).activeCircle, circle.id, 'the selected circle never changes');
});

test('a local disk error is internal_error with one error_id in the answer and one redacted log record, never circle_unreachable', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  const cold1 = await f.start('lender', {adapters: cold(), identityProbe: async () => signedIn});
  const listCircles = cold1.app.device.listCircles.bind(cold1.app.device);
  cold1.app.device.listCircles = async () => { throw new Error('disk /secret/path token=abc123'); };
  let answer;
  try { answer = await api(cold1.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}, status: 409}); }
  finally { cold1.app.device.listCircles = listCircles; }
  assert.equal(answer.code, 'internal_error');
  assert.match(answer.error_id, /^[A-Za-z0-9-]{6,}$/);
  assert.ok(!JSON.stringify(answer).includes('abc123') && !JSON.stringify(answer).includes('/secret'));
  await waitFor(async () => (await readFile(join(cold1.home, 'v1', 'lending-errors.jsonl'), 'utf8').catch(() => '')).includes(answer.error_id), 'the log record');
  const log = await readFile(join(cold1.home, 'v1', 'lending-errors.jsonl'), 'utf8');
  assert.equal(log.split(answer.error_id).length - 1, 1, 'written once');
  assert.ok(!log.includes('abc123') && !log.includes('/secret'));
  assert.match(log, /"condition":"Error"/);
});

// Classification happens where the host call ends, by where the failure came from, never by its shape alone.
test('host failures are classified by origin: deadline and transport are unreachable, a person cancel is cancelled, local errors pass through', () => {
  const user = reason => { const c = new AbortController(); c.abort(reason); return c.signal; };
  const timeout = new DOMException('late', 'TimeoutError'), abort = new DOMException('stop', 'AbortError');
  assert.equal(timeout.code, 23);assert.equal(abort.code, 20);
  assert.equal(classifyHostFailure(timeout).code, 'circle_unreachable');
  assert.equal(classifyHostFailure(abort).code, 'circle_unreachable');
  assert.equal(classifyHostFailure(new TypeError('fetch failed')).code, 'circle_unreachable');
  assert.equal(classifyHostFailure(Object.assign(new Error('x'), {code: 'network_error'})).code, 'circle_unreachable');
  for (const status of [502, 503, 504]) assert.equal(classifyHostFailure(Object.assign(new Error('x'), {code: 'http_error', status})).code, 'circle_unreachable');
  // A person's own abort stays cancelled, whatever the reason object is.
  for (const reason of [new Error('boom'), 'a string', new DOMException('quit', 'AbortError'), {code: 'cancelled'}]) {
    const signal = user(reason);
    assert.equal(classifyHostFailure(signal.reason, {callerSignal: signal}).code, 'cancelled', String(reason));
  }
  // The same DOMException with no person signal is a host deadline.
  assert.equal(classifyHostFailure(new DOMException('late', 'TimeoutError'), {callerSignal: new AbortController().signal}).code, 'circle_unreachable');
  // A host that answered keeps its own code, and a local error is left for the caller.
  const refusal = Object.assign(new Error('x'), {code: 'forbidden', status: 403});
  assert.equal(classifyHostFailure(refusal), refusal);
  const disk = new Error('disk');
  assert.equal(classifyHostFailure(disk), disk);
  const malformed = Object.assign(new Error('x'), {code: 'invalid_response'});
  assert.equal(classifyHostFailure(malformed), malformed);
});

// A blocked local lane says nothing about the host. Resume answers resume_pending (never circle_unreachable), the
// intent is saved, and lending is ready once the lane frees, with no second call.
test('Resume with a healthy host and a blocked local lane answers resume_pending, then lending is ready with no second call', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  // An agent check holds the mutation lane. The settings writer stays free, so the intent still saves.
  let blockNext = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const cold1 = await f.start('lender', {adapters: async () => { if (blockNext) { blockNext = false; await gate; } return cold(); }, identityProbe: async () => signedIn});
  blockNext = true;
  const blocker = api(cold1.app, '/api/agents/refresh', {method: 'POST', body: {}});
  await new Promise(resolve => setTimeout(resolve, 200));
  const began = Date.now();
  const answer = await api(cold1.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}, status: 202});
  assert.ok(Date.now() - began < 1000);
  assert.equal(answer.state, 'pending');assert.equal(answer.code, 'resume_pending');assert.equal(answer.saved, true);
  const saved = await settingsOf(cold1);
  assert.equal(saved.intent, 'on');assert.equal(saved.paused, false);
  release();
  await blocker;
  await waitFor(async () => (await api(cold1.app, '/api/lending')).enabled === true, 'lending starts with no second call', 60000);
  await waitFor(async () => (await api(cold1.app, '/api/status')).intent?.state === 'ready', 'ready', 60000);
});

// Review fixes: the whole phase before the answer shares the one-second clock.
const coldPaused = async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  const app = await f.start('lender');
  return {f, circle, app};
};
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return {promise, release}; };
const resume = (app, circle, status) => api(app.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}, status});

test('a held circle list answers resume_pending saved:false within one second, and Resume completes when the list returns', {timeout: 180000}, async t => {
  const {circle, app} = await coldPaused(t);
  const list = app.app.device.listCircles.bind(app.app.device), hold = gate();
  app.app.device.listCircles = async (...args) => { await hold.promise; return list(...args); };
  const began = Date.now();
  const answer = await resume(app, circle, 202);
  assert.ok(Date.now() - began < 1000, 'answered in ' + (Date.now() - began));
  assert.equal(answer.code, 'resume_pending');assert.equal(answer.saved, false);
  hold.release();
  await waitFor(async () => (await api(app.app, '/api/lending')).enabled === true, 'lending starts after the list returns', 60000);
});

test('a held counter read answers resume_pending saved:false within one second', {timeout: 180000}, async t => {
  const {circle, app} = await coldPaused(t);
  const file = join(app.home, 'v1', 'app-counters.json');
  const {execFileSync} = await import('node:child_process');
  const {rm, open} = await import('node:fs/promises');
  await rm(file, {force: true});
  execFileSync('mkfifo', [file]);
  const began = Date.now();
  let answer;
  try { answer = await resume(app, circle, 202); }
  finally {
    // Release the blocked read: open the pipe for writing and close it.
    const handle = await open(file, 'w');await handle.close();
  }
  assert.ok(Date.now() - began < 1000, 'answered in ' + (Date.now() - began));
  assert.equal(answer.code, 'resume_pending');assert.equal(answer.saved, false);
  await rm(file, {force: true});
});

test('a held settings commit answers resume_pending saved:false within one second', {timeout: 180000}, async t => {
  const {circle, app} = await coldPaused(t);
  const select = app.app.device.selectCircle.bind(app.app.device), hold = gate();
  let blockNext = true;
  app.app.device.selectCircle = async (...args) => { if (blockNext) { blockNext = false; await hold.promise; } return select(...args); };
  // A mode save holds the settings writer.
  const blocker = api(app.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await new Promise(resolve => setTimeout(resolve, 200));
  const began = Date.now();
  const answer = await resume(app, circle, 202);
  assert.ok(Date.now() - began < 1000);
  assert.equal(answer.code, 'resume_pending');assert.equal(answer.saved, false);
  hold.release();await blocker;
});

test('a host that answers null to the capabilities read is a malformed reply, not an unreachable host', {timeout: 180000}, async t => {
  const {f, circle, app} = await coldPaused(t);
  const reachable = f.override;
  f.override = async args => {
    if (args.req.url?.includes('/capabilities')) { args.res.writeHead(200, {'content-type': 'application/json'}); args.res.end('null'); return true; }
    return reachable(args);
  };
  const answer = await resume(app, circle, 409);
  assert.equal(answer.code, 'invalid_response');
});

test('a local TypeError after the host answered stays internal_error with an error_id, not circle_unreachable', {timeout: 180000}, async t => {
  const {circle, app} = await coldPaused(t);
  // The first read is Resume's own; the second is the start's, after the host has answered.
  const list = app.app.device.listCircles.bind(app.app.device);
  let calls = 0;
  app.app.device.listCircles = async (...args) => { if (++calls > 1) throw new TypeError('local bug'); return list(...args); };
  let answer;
  try { answer = await resume(app, circle, 409); } finally { app.app.device.listCircles = list; }
  assert.equal(answer.code, 'internal_error');assert.ok(answer.error_id);
});

test('Off while the host probe is waiting cancels Resume: the answer is cancelled and Off stays Off', {timeout: 180000}, async t => {
  const {f, circle, app} = await coldPaused(t);
  const reachable = f.override;
  f.override = async args => args.req.url?.includes('/capabilities') ? new Promise(() => {}) : reachable(args);
  const pending = resume(app, circle, 409);
  await new Promise(resolve => setTimeout(resolve, 150));
  await api(app.app, '/api/lending/off', {method: 'POST', body: {}});
  const answer = await pending;
  assert.equal(answer.code, 'cancelled');
  assert.equal((await settingsOf(app)).intent, 'off');
});

test('host init has one deadline and an abort; a late answer from a call that ignored the abort changes nothing', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  const app = await f.start('lender', {hostInitMs: 400, blockerRecheckMs: 300, hostProfileMs: 300});
  const real = app.app.device.client.bind(app.app.device);
  let first = true, signalSeen, releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  app.app.device.client = async (id, opts = {}) => {
    if (!new Error().stack.includes('initHost')) return real(id, opts);
    if (first) { first = false; signalSeen = opts.signal; await late; return real(id, opts); }
    throw Object.assign(new Error('offline'), {code: 'http_error', status: 502, retryable: true});
  };
  await api(app.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}, status: 409});
  await waitFor(async () => signalSeen?.aborted === true, 'the host call is aborted at its deadline', 20000);
  assert.equal(signalSeen.reason.name, 'TimeoutError');
  releaseLate(); // the call that ignored the abort now answers
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await api(app.app, '/api/lending')).enabled, false, 'a late answer starts no pool');
  assert.equal((await settingsOf(app)).enabled, false);
});

// The acceptance scenario: a paused lender, the circle host offline, one Resume, and nobody acts again.
const offlineHost = async (t, {restart = false} = {}) => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({});
  await lendingOn(lender.app, circle);
  await waitFor(async () => (await api(lender.app, '/api/status')).state === 'ready', 'lending ready');
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  await lender.app.close();
  const state = {down: true, pools: 0};
  const reachable = f.override;
  f.override = async args => { if (state.down) { args.req.socket.destroy(); return true; } return reachable(args); };
  const open = () => f.start('lender', {adapters: cold(), identityProbe: async () => signedIn, blockerRecheckMs: 300, hostProfileMs: 300, onLendingPoolStart: () => { state.pools++; }});
  return {f, circle, state, open};
};

test('acceptance: offline Resume, host returns, lending starts by itself with one lender and the same circle', {timeout: 180000}, async t => {
  const {circle, state, open} = await offlineHost(t);
  const app = await open();
  const began = Date.now();
  const answer = await resume(app, circle, 409);
  assert.ok(Date.now() - began < 1000);
  assert.equal(answer.code, 'circle_unreachable');
  assert.equal(state.pools, 0, 'no lender while the host is away');
  state.down = false;
  await waitFor(async () => state.pools >= 1 && (await api(app.app, '/api/lending')).enabled === true, 'lending starts', 60000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(state.pools, 1, 'exactly one lender loop');
  const view = await api(app.app, '/api/lending');
  assert.equal(view.circle, circle.id);
});

for (const action of ['off', 'pause']) test(`acceptance: ${action} sent while the host is offline still wins when the host returns`, {timeout: 180000}, async t => {
  const {circle, state, open} = await offlineHost(t);
  const app = await open();
  await resume(app, circle, 409);
  await api(app.app, '/api/lending/' + action, {method: 'POST', body: {}});
  state.down = false;
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(state.pools, 0, 'a late host answer starts nothing');
  assert.equal((await api(app.app, '/api/lending')).enabled, false);
  assert.equal((await settingsOf(app)).intent, action === 'off' ? 'off' : 'paused');
});

test('acceptance: restart after an offline Resume keeps intent and starts once the host answers', {timeout: 180000}, async t => {
  const {circle, state, open} = await offlineHost(t);
  const app = await open();
  await resume(app, circle, 409);
  await app.app.close();
  const restarted = await open();
  assert.equal((await settingsOf(restarted)).intent, 'on');
  assert.equal(state.pools, 0);
  state.down = false;
  await waitFor(async () => state.pools >= 1 && (await api(restarted.app, '/api/lending')).enabled === true, 'lending starts after restart', 60000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(state.pools, 1);
});

test('a local error while the client is set up, with a healthy host, is internal_error with an error_id, never circle_unreachable', {timeout: 180000}, async t => {
  const {circle, app} = await coldPaused(t);
  // A null intents file makes the circle's own local read throw a TypeError before any host call.
  await writeFile(join(app.home, 'v1', 'circles', circle.id, 'intents.json'), 'null');
  const answer = await resume(app, circle, 409);
  assert.equal(answer.code, 'internal_error');
  assert.ok(answer.error_id);
});

for (const [name, act] of [
  ['Pause', app => api(app.app, '/api/lending/pause', {method: 'POST', body: {}})],
  ['Quit', app => api(app.app, '/api/shutdown', {method: 'POST', body: {}, status: 202})],
]) test(`${name} while the host probe is waiting cancels Resume: the answer is cancelled`, {timeout: 180000}, async t => {
  const {f, circle, app} = await coldPaused(t);
  const reachable = f.override;
  f.override = async args => args.req.url?.includes('/capabilities') ? new Promise(() => {}) : reachable(args);
  const pending = resume(app, circle, 409);
  await new Promise(resolve => setTimeout(resolve, 150));
  await act(app);
  assert.equal((await pending).code, 'cancelled');
});


for (const ending of ['reset', 'transport-deadline', 'wait-deadline']) test('response history survives later '+ending, async () => {
  let calls=0, sleeps=0;
  const controller=new AbortController();
  const cause=ending==='transport-deadline'?new DOMException('private-timeout','TimeoutError'):
    Object.assign(new Error('private-reset'),{code:'ECONNRESET'});
  const client=responseClient({
    maxAttempts:ending==='wait-deadline'?3:2,
    fetch:async (_url,options)=>{
      calls++;
      assert.equal(options.headers['Idempotency-Key'],calls<=2?'synthetic-response-operation':'unrelated-operation');
      if(calls===1)return busyResponse();
      throw cause;
    },
    sleep:async ms=>{
      sleeps++;
      if(sleeps===1){assert.equal(ms,120000);return;}
      if(ending==='wait-deadline'&&sleeps===2){
        assert.equal(ms,0);
        controller.abort(new DOMException('private-wait','TimeoutError'));
        throw controller.signal.reason;
      }
    },
  });
  const error=await caught(responsePost(client,controller.signal));
  const expected={status:503,code:'service_busy',outcome:'not_applied',
    operationKey:'synthetic-response-operation',retryAfterSeconds:120};
  assert.equal(calls,2);assert.equal(sleeps,ending==='wait-deadline'?2:1);
  assert.equal(error.code,'network_error');assert.equal(error.status,0);
  assert.equal(error.retryable,true);assert.equal(error.outcome,'unknown');
  assert.equal(error.operationKey,'synthetic-response-operation');assert.equal(error.cause,cause);
  assert.equal(Object.hasOwn(error,'retryAfterSeconds'),false);
  assert.deepEqual(error.receivedResponse,expected);
  assert.deepEqual(clientFailure(error),{code:'network_error',status:0,retryable:true,receivedResponse:expected});
  const classified=classifyHostFailure(error);
  assert.equal(classified.code,'circle_unreachable');assert.equal(classified.status,409);
  assert.equal(classified.retryable,true);assert.equal(classified.cause,error);
  assert.deepEqual(classified.receivedResponse,expected);
  const summary=clientFailure(classified);
  assert.deepEqual(summary,{code:'network_error',status:409,retryable:true,receivedResponse:expected});
  assert.doesNotMatch(JSON.stringify(summary),/private-|detail|headers|cause/);
  const later=await caught(client.heartbeat({}, {bootstrap:true,idempotencyKey:'unrelated-operation'}));
  assert.equal(later.outcome,'unknown');assert.equal(later.operationKey,'unrelated-operation');
  for(const value of [later,classifyHostFailure(later),clientFailure(later)])
    assert.equal(Object.hasOwn(value,'receivedResponse'),false);
});
test('response history retains the latest concrete response',async()=>{
  let calls=0;const waits=[];
  const client=responseClient({maxAttempts:3,sleep:async ms=>{waits.push(ms);},fetch:async()=>{
    calls++;if(calls===1)return busyResponse();
    // Canonical property order is required by the real client's strict parser.
    if(calls===2)return new Response('{"code":"gateway_busy","detail":"private-latest","outcome":"unknown"}',
      {status:504,headers:{'content-type':'application/problem+json','retry-after':'7'}});
    throw Object.assign(new Error('private-reset'),{code:'ECONNRESET'});
  }});
  const error=await caught(responsePost(client));
  assert.equal(error.outcome,'unknown');assert.equal(error.code,'network_error');
  assert.deepEqual(waits,[120000,7000]);
  const expected={status:504,code:'gateway_busy',outcome:'unknown',
    operationKey:'synthetic-response-operation',retryAfterSeconds:7};
  assert.deepEqual(error.receivedResponse,expected);
  assert.deepEqual(clientFailure(classifyHostFailure(error)).receivedResponse,expected);
});
test('response history never replaces caller cancellation identity',async()=>{
  for(const reason of [new Error('private-stop'),new DOMException('private-stop','AbortError'),'private-string']){
    const controller=new AbortController();let calls=0;
    const client=responseClient({fetch:async()=>{
      if(++calls===1)return busyResponse();
      controller.abort(reason);throw reason;
    }});
    const error=await caught(responsePost(client,controller.signal));
    assert.equal(error,reason);assert.equal(calls,2);
    const classified=classifyHostFailure(error,{callerSignal:controller.signal});
    assert.equal(classified.code,'cancelled');
    assert.equal(Object.hasOwn(classified,'receivedResponse'),false);
  }
});

test('actual aborted pending transport preserves historical response only for a deadline',async()=>{
  const controller=new AbortController(),deadline=Object.freeze(new DOMException('private-actual-deadline','TimeoutError'));
  let entered,removeListener=()=>{};const started=new Promise(resolve=>{entered=resolve;});
  let calls=0,sleeps=0;const keys=[];
  const client=responseClient({maxAttempts:4,
    fetch:async(_url,options)=>{
      calls++;keys.push(options.headers['Idempotency-Key']);
      if(calls===1)return busyResponse();
      assert.equal(calls,2,'deadline must not start a third transmission');
      assert.equal(options.signal,controller.signal);
      return new Promise((resolve,reject)=>{
        const stop=()=>{removeListener();reject(options.signal.reason);};
        removeListener=()=>options.signal.removeEventListener('abort',stop);
        options.signal.addEventListener('abort',stop,{once:true});
        entered();
      });
    },
    sleep:async(ms,signal)=>{sleeps++;assert.equal(sleeps,1);assert.equal(ms,120000);assert.equal(signal,controller.signal);assert.equal(signal.aborted,false);},
  });
  const pending=caught(responsePost(client,controller.signal));
  try{
    await started;
    assert.equal(controller.signal.aborted,false);assert.equal(calls,2);
    controller.abort(deadline);
    const error=await pending;
    assert.equal(calls,2);assert.equal(sleeps,1);
    assert.deepEqual(keys,['synthetic-response-operation','synthetic-response-operation']);
    assert.notEqual(error,deadline);assert.equal(error.cause,deadline);
    assert.equal(error.code,'network_error');assert.equal(error.status,0);
    assert.equal(error.retryable,true);assert.equal(error.outcome,'unknown');
    assert.equal(error.operationKey,'synthetic-response-operation');
    assert.equal(Object.hasOwn(error,'retryAfterSeconds'),false);
    const history={status:503,code:'service_busy',outcome:'not_applied',operationKey:'synthetic-response-operation',retryAfterSeconds:120};
    assert.deepEqual(error.receivedResponse,history);
    assert.deepEqual(clientFailure(error),{code:'network_error',status:0,retryable:true,receivedResponse:history});
    const classified=classifyHostFailure(error);
    assert.equal(classified.code,'circle_unreachable');assert.equal(classified.cause,error);
    assert.deepEqual(classified.receivedResponse,history);
    const summary=clientFailure(classified);
    assert.deepEqual(summary,{code:'network_error',status:409,retryable:true,receivedResponse:history});
    assert.doesNotMatch(JSON.stringify(summary),/private-|detail|headers|cause/);
    assert.equal(Object.hasOwn(deadline,'receivedResponse'),false);
  }finally{
    if(!controller.signal.aborted)controller.abort(deadline);
    removeListener();await pending;
  }
});
test('actual transport deadline without received history keeps the original reason',async()=>{
  const controller=new AbortController(),deadline=new DOMException('private-no-history','TimeoutError');
  let entered,removeListener=()=>{};const started=new Promise(resolve=>{entered=resolve;});
  let calls=0;
  const client=responseClient({fetch:async(_url,{signal})=>{
    calls++;assert.equal(signal,controller.signal);
    return new Promise((resolve,reject)=>{
      const stop=()=>{removeListener();reject(signal.reason);};
      removeListener=()=>signal.removeEventListener('abort',stop);
      signal.addEventListener('abort',stop,{once:true});entered();
    });
  },sleep:async()=>assert.fail('no retry after caller signal deadline')});
  const pending=caught(responsePost(client,controller.signal));
  try{
    await started;controller.abort(deadline);
    assert.equal(await pending,deadline);assert.equal(calls,1);
    assert.equal(Object.hasOwn(deadline,'receivedResponse'),false);
    assert.equal(Object.hasOwn(clientFailure(classifyHostFailure(deadline)),'receivedResponse'),false);
  }finally{
    if(!controller.signal.aborted)controller.abort(deadline);
    removeListener();await pending;
  }
});
