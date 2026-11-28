import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {deferred, until} from './helpers/v1-lender-fixture.mjs';

async function launchFixture(t, {beforeStart = false, replay = false, configure, fixtureOptions = {}} = {}) {
  const state = {acknowledgments: 0, invocations: 0, reply: null};
  const f = await realLenderFixture(t, {...fixtureOptions, agent: async () => {state.invocations++;}});
  const latch = deferred(), reached = deferred();
  const start = f.backend.start.bind(f.backend);
  // Model the backend's launch secret: only a successful durable callback opens it.
  f.backend.start = async (handle, opts = {}) => {
    if (!opts.onLaunchDurable) return start(handle, opts);
    reached.resolve();
    await latch.promise;
    await opts.onLaunchDurable();
    state.acknowledgments++;
    return start(handle, {...opts, onLaunchDurable: undefined});
  };
  if (beforeStart) {
    const mark = f.client.startAttempt.bind(f.client);
    f.client.startAttempt = async (...args) => {reached.resolve(); await latch.promise; return mark(...args);};
  }
  const observe = f.client.observeExecutionStart.bind(f.client);
  f.client.observeExecutionStart = async (...args) => {
    state.reply = await observe(...args);
    if (replay && !state.lostReply) {
      state.lostReply = state.reply;
      await f.owner.cancelJob(f.jobDigest);
      throw Object.assign(new Error('reply lost'), {retryable: true, status: 503});
    }
    return state.reply;
  };
  configure?.(f);
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters,
    policy: f.policy, clock: f.clock, approve: async () => true,
    onEvent: e => f.events.push(e)});
  const loop = lender.start(controller.signal);
  f.stop = async () => {controller.abort(); latch.resolve(); await loop;};
  await reached.promise;
  state.renewals = f.realRequests.filter(r => r.url.endsWith('/renew')).length;
  return Object.assign(f, {state, latch});
}

async function finish(f) {
  f.latch.resolve();
  await until(() => f.calls.some(([kind]) => kind === 'destroy'), 'execution cleanup');
  // Let the real HTTP settlement finish without advancing the renew timer.
  await until(() => f.saved()?.pending == null, 'attempt settlement');
  assert.equal(f.realRequests.filter(r => r.url.endsWith('/renew')).length, f.state.renewals);
}

test('cancel after start and before observed-start never opens the launch latch', {timeout: 30000}, async t => {
  const f = await launchFixture(t);
  assert.ok((await f.owner.getJob(f.jobDigest)).current_attempt.execution_started_at);
  assert.equal((await f.owner.cancelJob(f.jobDigest)).authority_revoked, true);
  await finish(f);
  assert.equal(f.state.reply.state, 'cancelled');
  assert.equal(f.state.acknowledgments, 0);
  assert.equal(f.state.invocations, 0);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'cancelled');
});

test('an active observed-start opens the launch latch exactly once', {timeout: 30000}, async t => {
  const f = await launchFixture(t);
  await finish(f);
  assert.equal(f.state.reply.state, 'active');
  assert.equal(f.state.acknowledgments, 1);
  assert.equal(f.state.invocations, 1);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
});

test('cancel before start is refused before launch', {timeout: 30000}, async t => {
  const f = await launchFixture(t, {beforeStart: true});
  await f.owner.cancelJob(f.jobDigest);
  await finish(f);
  assert.equal(f.state.reply, null);
  assert.equal(f.state.acknowledgments, 0);
  assert.equal(f.state.invocations, 0);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'cancelled');
});

test('cancelled observed-start still records history and counts the attempt', {timeout: 30000}, async t => {
  const f = await launchFixture(t);
  await f.owner.cancelJob(f.jobDigest);
  await finish(f);
  const job = await f.owner.getJob(f.jobDigest);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.current_attempt.state, 'cancelled');
  assert.equal(typeof job.current_attempt.execution_observed_at, 'string');
  assert.equal(job.attempts_started, 1);
});

test('a denied launch refunds daily and requester reservations after cleanup', {timeout: 30000}, async t => {
  const f = await launchFixture(t);
  await f.owner.cancelJob(f.jobDigest);
  f.clock.advance(2000);
  await finish(f);
  assert.equal(f.saved().jobs, 0);
  assert.ok(f.saves.some(s => s.pending?.agentStartDenied === true));
  assert.equal(f.saved().milliseconds, 0);
  for (const row of Object.values(f.saved().requesters ?? {})) {
    assert.equal(row.jobs, 0);
    assert.equal(row.milliseconds, 0);
  }
});

test('a cached active observation cannot authorize launch after committed cancel', {timeout: 30000}, async t => {
  const f = await launchFixture(t, {replay: true});
  f.latch.resolve();
  await until(() => f.state.lostReply, 'active response lost after cancellation');
  assert.equal(f.state.lostReply.state, 'active');
  await until(() => f.clock.pending().includes(250), 'observation retry scheduled');
  f.clock.advance(250);
  await finish(f);
  assert.equal(f.state.acknowledgments, 0);
  assert.equal(f.state.invocations, 0);
  assert.equal(f.state.reply.state, 'cancelled');
});

test('cancel during observation refunds reservations when normal renewal aborts launch', {timeout: 30000}, async t => {
  const observing = deferred(), response = deferred();
  t.after(() => response.resolve());
  const f = await launchFixture(t, {configure(f) {
    f.client.observeExecutionStart = async () => {observing.resolve(); return response.promise;};
  }});
  f.latch.resolve();
  await observing.promise;
  await f.owner.cancelJob(f.jobDigest);
  f.clock.advance(30000);
  await until(() => f.saved()?.pending == null, 'cancelled renewal settlement');
  assert.ok(f.realRequests.filter(r => r.url.endsWith('/renew')).length > f.state.renewals);
  assert.equal(f.state.invocations, 0);
  assert.equal(f.state.acknowledgments, 0);
  assert.equal(f.saved().jobs, 0);
  assert.equal(f.saved().milliseconds, 0);
  for (const row of Object.values(f.saved().requesters ?? {})) {
    assert.equal(row.jobs, 0);
    assert.equal(row.milliseconds, 0);
  }
});

test('a newer renewal survives delayed observation journal persistence', {timeout: 30000}, async t => {
  const clearing = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await launchFixture(t, {
    fixtureOptions: {mutateJob: job => {job.requirements.limits.wall_seconds = 300;}},
    configure(f) {
      const set = f.policy.storage.set;
      f.policy.storage.set = async value => {
        if (f.saved()?.observationPending?.length && value.observationPending?.length === 0) {
          clearing.resolve(); await release.promise;
        }
        await set(value);
      };
    }
  });
  f.latch.resolve();
  await clearing.promise;
  const oldExpiry = Date.parse(f.state.reply.lease_expires_at);
  for (let n = 0; n < 4; n++) {
    f.clock.advance(30000);
    await until(() => f.clock.pending().includes(30000), 'successful renewal rearmed');
  }
  assert.ok(f.clock.now() >= oldExpiry);
  release.resolve();
  await until(() => f.saved()?.pending == null, 'renewed attempt settlement');
  assert.equal(f.state.acknowledgments, 1);
  assert.equal(f.state.invocations, 1);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'result-accepted');
});

for (const denied of [false, true]) test(`restart ${denied ? 'refunds durable denial' : 'keeps ambiguous launch charged'}`, {timeout: 30000}, async t => {
  const observing = deferred(), response = deferred();
  t.after(() => response.resolve());
  const f = await launchFixture(t, {configure(f) {
    f.client.observeExecutionStart = async () => {observing.resolve(); return response.promise;};
  }});
  f.latch.resolve();
  await observing.promise;
  // A crash at this checkpoint has an observation intent, but no proof of whether
  // the callback later returned and the backend wrote its secret.
  const crash = structuredClone(f.saved());
  assert.equal(crash.pending.executionStartRequested, true);
  assert.equal(crash.pending.agentStartDenied, undefined);
  assert.equal(crash.observationPending.length, 1);
  await f.owner.cancelJob(f.jobDigest);
  await f.stop();
  if (denied) crash.pending.agentStartDenied = true;
  await f.policy.storage.set(crash);
  f.policy.enabled = false;
  f.backend.reconcilePending = async pending => ({removed: true, attemptId: pending.attemptId});
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters,
    policy: f.policy, clock: f.clock, approve: async () => true});
  const loop = lender.start(controller.signal);
  f.stop = async () => {controller.abort(); await loop;};
  await until(() => f.saved()?.pending == null, 'restart reconciliation');
  assert.equal(f.state.invocations, 0);
  assert.equal(f.saved().jobs, denied ? 0 : crash.jobs);
  assert.equal(f.saved().milliseconds, denied ? 0 : crash.milliseconds);
  for (const [key, row] of Object.entries(f.saved().requesters ?? {})) {
    assert.equal(row.jobs, denied ? 0 : crash.requesters[key].jobs);
    assert.equal(row.milliseconds, denied ? 0 : crash.requesters[key].milliseconds);
  }
});

for (const authority of ['cancelled', 'expired', 'compute-stopped', 'other-holder', 'other-attempt', 'active']) {
  test(`old-host probe with ${authority} authority ${authority === 'active' ? 'allows' : 'denies and refunds'} launch`, {timeout: 30000}, async t => {
    let probing = false, probes = 0, probe;
    const f = await launchFixture(t, {fixtureOptions: {intercept(req, res) {
      if (req.url.endsWith('/observed-start')) {
        probing = true;
        res.writeHead(404, {'content-type': 'application/json'});
        res.end(JSON.stringify({code: 'not_found'}));
        return true;
      }
      if (probing && req.method === 'GET' && req.url.includes('/attempts/')) {
        probes++;
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(probe));
        return true;
      }
      return false;
    }}});
    if (authority === 'cancelled') await f.owner.cancelJob(f.jobDigest);
    probe = structuredClone((await f.owner.getJob(f.jobDigest)).current_attempt);
    if (authority === 'expired') probe.lease_expires_at = new Date(f.clock.now() - 1000).toISOString().replace('.000Z', 'Z');
    if (authority === 'compute-stopped') probe.compute_stopped = true;
    if (authority === 'other-holder') probe.holder = 'sha256:' + '0'.repeat(64);
    if (authority === 'other-attempt') probe.attempt_id = '00000000-0000-4000-8000-000000000000';
    await finish(f);
    assert.equal(probing, true);
    assert.ok(probes > 0);
    const launches = authority === 'active' ? 1 : 0;
    assert.equal(f.state.invocations, launches);
    assert.equal(f.state.acknowledgments, launches);
    assert.equal(f.saved().jobs, launches);
    if (!launches) {
      assert.ok(f.saves.some(s => s.pending?.agentStartDenied === true));
      assert.equal(f.saved().milliseconds, 0);
      for (const row of Object.values(f.saved().requesters ?? {})) {
        assert.equal(row.jobs, 0);
        assert.equal(row.milliseconds, 0);
      }
    }
  });
}

for (const renewed of [true, false]) {
  test(`delayed old-host probe ${renewed ? 'allows a newer renewal' : 'denies expiry without renewal'}`, {timeout: 30000}, async t => {
    const probing = deferred();
    let oldHost = false, delayed, snapshot, probes = 0;
    t.after(() => delayed?.end(JSON.stringify(snapshot)));
    const f = await launchFixture(t, {fixtureOptions: {
      mutateJob: job => {job.requirements.limits.wall_seconds = 300;},
      intercept(req, res) {
        if (req.url.endsWith('/observed-start')) {
          oldHost = true;
          res.writeHead(404, {'content-type': 'application/json'});
          res.end(JSON.stringify({code: 'not_found'}));
          return true;
        }
        if (oldHost && req.method === 'GET' && req.url.includes('/attempts/')) {
          probes++;
          // The first response keeps the snapshot taken before renewal.
          if (probes === 1) {delayed = res; probing.resolve(); return true;}
          // With no renewal, fresh authority is still expired.
          if (!renewed) {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify(snapshot));
            return true;
          }
        }
        return false;
      }
    }});
    snapshot = structuredClone((await f.owner.getJob(f.jobDigest)).current_attempt);
    if (!renewed) snapshot.lease_expires_at = new Date(f.clock.now() + 1000).toISOString().replace('.000Z', 'Z');
    f.latch.resolve();
    await probing.promise;
    if (renewed) {
      for (let n = 0; n < 4; n++) {
        f.clock.advance(30000);
        await until(() => f.clock.pending().includes(30000), 'successful renewal rearmed');
      }
      assert.ok(f.realRequests.filter(r => r.url.endsWith('/renew')).length > f.state.renewals);
    } else {
      f.clock.advance(2000);
      assert.equal(f.realRequests.filter(r => r.url.endsWith('/renew')).length, f.state.renewals);
    }
    assert.ok(f.clock.now() >= Date.parse(snapshot.lease_expires_at));
    delayed.writeHead(200, {'content-type': 'application/json'});
    delayed.end(JSON.stringify(snapshot));
    await until(() => f.saved()?.pending == null, 'delayed probe settlement');
    assert.equal(f.state.acknowledgments, renewed ? 1 : 0);
    assert.equal(f.state.invocations, renewed ? 1 : 0);
    assert.equal(f.saved().jobs, renewed ? 1 : 0);
    if (!renewed) assert.ok(f.saves.some(s => s.pending?.agentStartDenied === true));
  });
}

for (const phase of ['before start', 'between start and check']) {
  test(`coordinator cancellation ${phase} refunds every local allowance once`, {timeout: 30000}, async t => {
    let f, started = false;
    f = await launchFixture(t, {beforeStart: true, fixtureOptions: {
      harness: 'claude-code-subscription', policy: {mode: 'auto'},
      intercept(req, res) {
        if (phase !== 'between start and check') return false;
        if (req.url.endsWith('/start')) started = true;
        if (started && req.method === 'GET' && req.url.includes('/attempts/')) {
          started = false;
          void (async () => {
            await f.owner.cancelJob(f.jobDigest);
            const job = await f.owner.getJob(f.jobDigest);
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify(job.current_attempt));
          })();
          return true;
        }
        return false;
      }
    }});
    assert.equal(f.saved().jobs, 1);
    assert.equal(f.saved().ruleUsage.length, 1);
    if (phase === 'before start') await f.owner.cancelJob(f.jobDigest);
    f.clock.advance(2000);
    await finish(f);
    const check = () => {
      assert.equal(f.state.invocations, 0);
      assert.equal(f.state.acknowledgments, 0);
      assert.equal(f.saved().jobs, 0);
      assert.equal(f.saved().milliseconds, 0);
      assert.deepEqual(f.saved().ruleUsage.map(row => [row.ms, row.ran]), [[0, false]]);
      for (const row of Object.values(f.saved().requesters ?? {})) {
        assert.equal(row.jobs, 0);
        assert.equal(row.milliseconds, 0);
      }
    };
    check();
    await f.stop();
    f.policy.enabled = false;
    const controller = new AbortController();
    const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters,
      policy: f.policy, clock: f.clock, approve: async () => false});
    const loop = lender.start(controller.signal);
    f.stop = async () => {controller.abort(); await loop;};
    await until(() => lender.getState().status === 'paused', 'restart reads refunded counters');
    check();
  });
}

for (const refusal of ['stale reply', 'invalid reply', 'abort', 'denial save failure']) {
  test(`pre-dispatch ${refusal} records a refundable denial`, {timeout: 30000}, async t => {
    let failedSave = false;
    const f = await launchFixture(t, {beforeStart: true, configure(f) {
      const start = f.client.startAttempt;
      f.client.startAttempt = async (...args) => {
        const reply = await start(...args);
        if (refusal === 'abort') {f.clock.advance(120000); return reply;}
        if (refusal === 'invalid reply') throw Object.assign(new Error('invalid response'), {code: 'invalid_response'});
        return {...reply, attempt_id: '00000000-0000-4000-8000-000000000000'};
      };
      if (refusal === 'denial save failure') {
        const set = f.policy.storage.set;
        f.policy.storage.set = async value => {
          if (value.pending?.agentStartDenied && !failedSave) {
            failedSave = true;
            throw Object.assign(new Error('disk unavailable'), {code: 'EIO'});
          }
          return set(value);
        };
      }
    }});
    f.clock.advance(2000);
    await finish(f);
    assert.equal(f.state.invocations, 0);
    assert.equal(f.saved().jobs, 0);
    assert.equal(f.saved().milliseconds, 0);
    assert.ok(f.saves.some(s => s.pending?.agentStartDenied === true));
    for (const row of Object.values(f.saved().requesters ?? {})) {
      assert.equal(row.jobs, 0);
      assert.equal(row.milliseconds, 0);
    }
    if (refusal === 'denial save failure') assert.equal(failedSave, true);
  });
}

test('unknown adapter checks do not veto an account job',async t=>{
  const f=await realLenderFixture(t);
  const adapters=f.adapters.map(a=>({...a,signedIn:null,automaticChecksStopped:true}));
  const controller=new AbortController();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters,policy:f.policy,clock:f.clock,approve:async()=>true});
  const loop=lender.start(controller.signal);
  f.stop=async()=>{controller.abort();await loop;};
  await until(()=>f.calls.some(c=>c[0]==='run'),'the account job starts');
  assert.equal(f.calls.filter(c=>c[0]==='run').length,1);
  assert.equal(f.events.some(e=>e.reason==='account_signed_out'||e.reason==='sandbox_cannot_start'),false);
});
