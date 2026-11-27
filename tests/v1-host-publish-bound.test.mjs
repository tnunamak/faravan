import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {acquireProcessLock, profileWriterLockPath} from '../lib/v1/lock.mjs';
import {ensureV1HostState,hostV1} from '../lib/v1/host.mjs';
import * as p from '../lib/protocol/index.mjs';
import {realCoordinator} from './helpers/v1-short-invite.mjs';

// Timers and the origin are both controlled here: no test waits on a real clock.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function manualTimers() {
  const armed = deferred(), timers = [];
  let next = 1;
  return {
    armed: armed.promise,
    setTimeout(run, ms) {
      const id = next++;
      timers.push({id, run, live: true, ms});
      armed.resolve();
      return id;
    },
    clearTimeout(id) {
      for (const timer of timers) if (timer.id === id) timer.live = false;
    },
    fire() {
      for (const timer of timers) if (timer.live) { timer.live = false; timer.run(); }
    },
    // Only the earliest bound still waiting, so a later publication's bound stays armed.
    fireOldest() {
      const timer = timers.find(item => item.live);
      if (timer) { timer.live = false; timer.run(); }
    },
  };
}

// A route that never answers, like an origin that accepts no requests. It ignores the signal on purpose.
function unreachable(seen, reached = deferred()) {
  return (url, options) => {
    seen.push(options?.signal);
    reached.resolve();
    return new Promise(() => {});
  };
}

const ownerLock = (home, circleId) => join(home, 'v1', 'owner-' + circleId + '.lock');

test('a publish that never answers does not hold the owner lock past its bound', {timeout: 20000}, async t => {
  const c = await realCoordinator(t, {name: 'Bounded'});
  const home = join(c.dir, 'owner');
  const timers = manualTimers(), seen = [], reached = deferred();
  const device = await c.device('owner', {fetch: unreachable(seen, reached), timers, publishTimeoutMs: 10000});

  const pending = device.createCircle(c.origin, {name: 'Bounded'});
  await Promise.all([timers.armed, reached.promise]);
  // While the publish is in flight, the lock is held: that is the window the bound limits.
  await assert.rejects(acquireProcessLock(ownerLock(home, c.circle.id), {timeoutMs: 0}), {code: 'lock_busy'});

  timers.fire();
  const result = await pending;
  assert.equal(result.id, c.circle.id);
  assert.equal(result.publicationPending, true, 'the circle is kept and marked as not yet published');
  assert.ok(seen.length > 0 && seen.every(signal => !signal || signal.aborted), 'the abandoned request is aborted');

  const release = await acquireProcessLock(ownerLock(home, c.circle.id), {timeoutMs: 0});
  release();
});

test('after a timed-out publish, a retry publishes the same circle', {timeout: 20000}, async t => {
  const c = await realCoordinator(t, {name: 'Retry'});
  const timers = manualTimers(), seen = [];
  let online = false;
  const fetch = (url, options) => online ? c.traced(url, options) : unreachable(seen)(url, options);
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});

  const pending = device.createCircle(c.origin, {name: 'Retry'});
  await timers.armed;
  timers.fire();
  assert.equal((await pending).publicationPending, true);

  online = true;
  const retried = await device.createCircle(c.origin, {name: 'Retry'});
  assert.equal(retried.publicationPending, false);
  assert.equal(retried.id, c.circle.id);
});

test('resuming a circle after a timed-out publish creates no second circle', {timeout: 20000}, async t => {
  const c = await realCoordinator(t, {name: 'Resume'});
  const timers = manualTimers(), seen = [];
  let online = false;
  const fetch = (url, options) => online ? c.traced(url, options) : unreachable(seen)(url, options);
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});
  const before = (await device.listCircles()).length;

  const pending = device.createCircle(c.origin, {name: 'Resume'});
  await timers.armed;
  timers.fire();
  await pending;

  online = true;
  const resumed = await device.createCircle(c.origin, {name: 'Resume'});
  assert.equal(resumed.id, c.circle.id);
  assert.equal((await device.listCircles()).length, before, 'no new circle is recorded');
});

// ---- The host path, and publications whose bound expired while their write or delete waited ----

const settle = () => new Promise(resolve => setTimeout(resolve, 100));

// How a publication ended, read later without waiting for it. The handler is attached now, so a late rejection is never unhandled.
function ended(promise) {
  const outcome = promise.then(value => ({value}), error => ({error}));
  return (ms = 2000) => Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve({running: true}), ms))]);
}

// The origin accepts a publication: it returns the same envelope it was sent.
const echoed = body => new Response(String(body), {status: 200, headers: {'content-type': 'application/json'}});

// The origin refuses a publication it did not apply.
const refused = () => new Response(p.canonicalize({type: 'urn:faravan:problem:invalid_request', title: 'invalid request',
  status: 400, code: 'invalid_request', retryable: false, outcome: 'not_applied'}),
{status: 400, headers: {'content-type': 'application/problem+json'}});

// The roster publication intent on disk, or null when none is pending.
async function pendingIntent(home, circleId) {
  try {
    const intents = JSON.parse(await readFile(join(home, 'v1', 'circles', circleId, 'intents.json'), 'utf8'));
    return intents['roster-publication'] ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Every hosting step except the roster publication is a seam, so only the publication can hang.
function hostSeams(c, device) {
  return {
    openDevice: async () => device,
    portInUse: async () => false,
    provision: async () => {},
    startServer: async () => ({stop: async () => {}}),
    waitReady: async () => ({protocol_version: 1, status: 'listening', public_url: c.origin}),
  };
}

test('a host publication that never answers ends at its bound and releases the host lock; a retry keeps the same circle', {timeout: 30000}, async t => {
  const clock = {t: Math.floor(Date.now() / 1000)};
  const c = await realCoordinator(t, {name: 'Host bound', clock: () => clock.t});
  const home = join(c.dir, 'host');
  const {config,paths}=ensureV1HostState({home,port:Number(new URL(c.origin).port),name:'Host bound'});
  await writeFile(paths.config,JSON.stringify({...config,reachability:{kind:'url',publicUrl:c.origin}}));
  const timers = manualTimers(), reached = deferred();
  let online = false;
  const fetch = (url, options) => online || options?.method !== 'PUT' ? c.traced(url, options) : unreachable([], reached)(url, options);
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});
  const seams = hostSeams(c, device);
  clock.t += 4 * 86400; // past the roster midpoint, so the host publishes a new epoch

  const first = hostV1({home, name: 'Host bound'}, seams);
  const firstEnded = ended(first);
  await reached.promise;
  timers.fire();
  assert.equal((await firstEnded()).error?.code, 'network_error', 'the host publication ends at its bound');
  const release = await acquireProcessLock(join(home, 'host-v1'), {timeoutMs: 0});
  release();

  online = true;
  const retried = await hostV1({home, name: 'Host bound'}, seams);
  assert.equal(retried.status, 'ready');
  assert.equal(retried.circle.id, c.circle.id, 'the retry keeps the circle the first attempt created');
});

// A publishes a newer epoch and is abandoned while its intent delete waits for the intent lock. Meanwhile a retry
// of the same publication has written its own intent. A's late delete must leave that write alone.
async function abandonedDeleteLeavesNewerWrite(t, name, answerFirst) {
  const clock = {t: Math.floor(Date.now() / 1000)};
  const c = await realCoordinator(t, {name, clock: () => clock.t});
  const home = join(c.dir, 'owner');
  const timers = manualTimers(), puts = [];
  const fetch = (url, options) => {
    if (options?.method !== 'PUT') return c.traced(url, options);
    const put = {answer: deferred(), body: options.body};
    puts.push(put);
    return put.answer.promise;
  };
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});
  clock.t += 4 * 86400; // past the roster midpoint, so the first publication signs a new epoch

  const first = device.publishRoster(c.circle.id);
  const firstEnded = ended(first);
  await settle();
  assert.equal(puts.length, 1, 'the first publication is in flight');
  const newer = device.publishRoster(c.circle.id); // a retry: it writes its own intent while the first is in flight
  const newerEnded = ended(newer);
  await settle();
  assert.equal(puts.length, 2, 'the newer write is in flight');

  const blocker = await acquireProcessLock(profileWriterLockPath(home), {timeoutMs: 0});
  try {
    puts[0].answer.resolve(answerFirst(puts[0].body)); // the first publication ends while the lock is held, so its delete waits
    await settle();
    timers.fireOldest(); // its bound expires while that delete waits
  } finally {
    blocker();
  }
  await settle();
  assert.ok(await pendingIntent(home, c.circle.id), 'the newer write keeps its intent when the abandoned publication finishes');
  assert.equal((await firstEnded()).error?.code, 'network_error', 'the first publication was abandoned at its bound');
  assert.equal((await newerEnded()).running, true, 'the newer publication is still waiting on its answer');
}

test('an abandoned publication whose accepted answer arrives while its delete waits leaves a newer write intact', {timeout: 30000}, async t => {
  await abandonedDeleteLeavesNewerWrite(t, 'Overlap accepted', body => echoed(body));
});

test('an abandoned publication whose refusal arrives while its delete waits leaves a newer write intact', {timeout: 30000}, async t => {
  await abandonedDeleteLeavesNewerWrite(t, 'Overlap refused', () => refused());
});

test('an abandoned publication whose intent write waits past its bound writes no intent', {timeout: 30000}, async t => {
  const c = await realCoordinator(t, {name: 'Fence'});
  const home = join(c.dir, 'owner');
  const timers = manualTimers();
  // A publication that is never answered keeps any later write observable as a pending intent.
  const fetch = (url, options) => options?.method === 'PUT' ? new Promise(() => {}) : c.traced(url, options);
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});

  const blocker = await acquireProcessLock(profileWriterLockPath(home), {timeoutMs: 0});
  const publication = device.publishRoster(c.circle.id);
  const publicationEnded = ended(publication);
  try {
    await settle(); // the publication reaches its intent write and waits for the held lock
    timers.fireOldest(); // its bound expires while the write waits
  } finally {
    blocker(); // the write may now run
  }
  await settle();
  assert.equal(await pendingIntent(home, c.circle.id), null, 'an abandoned publication writes no intent after its bound');
  assert.equal((await publicationEnded()).error?.code, 'network_error', 'the publication ended at its bound');
});

test('an owner edit that resumes a pending publication ends at its bound and releases the owner lock', {timeout: 30000}, async t => {
  const c = await realCoordinator(t, {name: 'Pending edit'});
  const home = join(c.dir, 'owner');
  const timers = manualTimers();
  let puts = 0;
  const reached = [deferred(), deferred()];
  // Every publication hangs; reads still reach the origin.
  const fetch = (url, options) => options?.method === 'PUT' ? unreachable([], reached[puts++])(url, options) : c.traced(url, options);
  const device = await c.device('owner', {fetch, timers, publishTimeoutMs: 10000});

  const created = device.createCircle(c.origin, {name: 'Pending edit'});
  await reached[0].promise;
  timers.fire();
  assert.equal((await created).publicationPending, true, 'the publication stays pending');
  assert.ok(await pendingIntent(home, c.circle.id));

  // The edit takes the owner lock, then refreshes the roster, which resumes the pending publication with no caller signal.
  const edit = device.setCircleLifecycle(c.circle.id, 'archived');
  const editEnded = ended(edit);
  await reached[1].promise;
  await settle();
  timers.fire();
  assert.equal((await editEnded()).error?.code, 'network_error', 'the resumed publication ends at its bound');
  const release = await acquireProcessLock(ownerLock(home, c.circle.id), {timeoutMs: 0});
  release();
});
