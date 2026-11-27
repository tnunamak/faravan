import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {join} from 'node:path';
import {createLender, TEMPORARY_HOLD_REOFFER_MS} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {NATIVE_SETTLEMENT_DELAY_MS} from '../lib/v1/lender-pace50.mjs';
import {isPassingDecline} from '../lib/v1/failures.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {discover} from '../scripts/run-tests.mjs';

// Wall time is only an I/O watchdog. All product deadlines use the fixture clock;
// setImmediate yields to the real HTTP server and filesystem without sleeping.
async function observed(check, label) {
  const watchdog = AbortSignal.timeout(30_000);
  while (!await check()) {
    assert.equal(watchdog.aborted, false, `I/O did not settle: ${label}`);
    await setImmediate();
  }
}

test('lending walk: two computers, one borrower, lagging meters and recovery', {timeout:120_000}, async t => {
  let runtime;
  t.after(() => runtime?.close());
  const f = await realLenderFixture(t, {members:true, offers:true, publish:false,
    rosterValidUntil:'2026-10-20T00:00:00Z', run:{model:'gpt-6-sol'},
    mutateJob:job => { job.expires_at = '2026-10-16T00:00:00Z'; }});
  const ordinaryRuntime = f.policy.lendingRuntime;
  const submitted = [];
  const submit = f.submit;
  f.submit = async () => { const digest = await submit(); submitted.push(digest); return digest; };
  const machines = [];
  // Disable coordinator long polls: those use real timers, not the lender clock.
  function machine(client, policy) {
    for (const method of ['listOffers', 'claimNext']) {
      if (!client[method]) continue;
      const send = client[method].bind(client);
      client[method] = method === 'claimNext'
        ? (ad, options) => send(ad, {...options, waitSeconds:0})
        : options => send({...options, waitSeconds:0});
    }
    const claims = new Map();
    for (const method of ['claimJob', 'claimNext']) {
      const send = client[method].bind(client);
      client[method] = async (...args) => {
        const claim = await send(...args);
        if (claim) claims.set(claim.attempt.attempt_id, claim.job_digest);
        return claim;
      };
    }
    let controller, loop, lender;
    const m = {policy, events:[],
      start() {
        controller = new AbortController();
        lender = createLender({client, backend:f.backend, adapters:f.adapters, policy, clock:f.clock,
          approve:async()=>true, onEvent:e => m.events.push({...e, jobDigest:claims.get(e.current), at:f.clock.now()})});
        loop = lender.start(controller.signal);
        return lender;
      },
      async stop() { if (loop) { controller.abort(); await loop; loop = null; } },
      get lender() { return lender; }};
    machines.push(m);
    return m;
  }
  const a = machine(f.client, f.policy);
  let otherSaved = null;
  const b = machine(f.clientFor(3), {...f.policy,
    storage:{get:async()=>otherSaved, set:async v => { otherSaved = structuredClone(v); }}});
  f.stop = () => Promise.all(machines.map(m => m.stop()));
  const poll = f.policy.pollMs;
  const lease = f.policy.leaseSeconds * 1000;
  // Advance only at an idle poll boundary. Never advance through unfinished HTTP
  // work, which would manufacture lease expiry on a slow CI machine.
  async function within(check, bound, label) {
    const end = f.clock.now() + bound;
    const idle = () => machines.every(m => !m.lender?.snapshot.current) && f.clock.pending().length > 0;
    while (!await check()) {
      await observed(async () => await check() || idle(), label);
      if (await check()) break;
      assert.ok(f.clock.now() < end, `${label}: missed ${bound} ms simulated deadline`);
      f.clock.advance(Math.min(...f.clock.pending(), poll, end - f.clock.now()));
      await setImmediate();
    }
  }
  async function finished(digest) {
    await within(() => machines.some(m => m.events.some(e => e.status === 'finished' && e.jobDigest === digest)),
      lease, 'borrower receives result');
    await observed(() => !f.saved()?.pending && !f.saved()?.acceptedClaim, 'lender clears journal');
    const view = await f.owner.getJob(digest);
    assert.equal(view.attempts_started, 1);
    assert.ok((await f.owner.fetchResult(digest, {attempt:view.current_attempt})).length, 'borrower downloads the verified result');
    return view;
  }
  async function step(name, options, action) {
    await t.test(name, options, async st => {
      try { await action(st); }
      finally {
        await f.stop();
        for (const digest of submitted) {
          if ((await f.owner.getJob(digest)).state === 'queued') await f.owner.cancelJob(digest);
        }
      }
    });
  }
  const source = createSyntheticPace50Source({start:f.clock.now(),
    override:({base}) => ({...base, resources:base.resources.map(r => ({...r,
      conversion:'native_window', kappa_micro:null, kappa_lower_micro:null}))})});
  const objective = source.objectiveInputFor;
  source.objectiveInputFor = args => ({...objective(args), strategy:'fixed_share',
    strategyParams:{fixedSharePct:20, keepPct:0, perJobPct:2}});
  runtime = createLendingRuntime({directory:join(f.root, 'native-walk'), backend:{},
    settings:()=>({intent:'on', limits:{lendingPolicy:{providerConsent:{codex:true}}}}),
    presence:()=>false, now:f.clock.now,
    pace50:{account:'synthetic-account', account_week_id:'synthetic-week-1', source,
      ownerSettings:{limit:()=>({state:'set', maxJobUsd:2})}}});
  f.policy.lendingRuntime = runtime;
  f.policy.userActive = async () => false;

  await step('1. lend on delivers the first tiny job to its borrower', {}, async () => {
    const job = await f.submit();
    a.start();
    const view = await finished(job);
    assert.equal(view.current_attempt.state, 'completed');
    assert.ok(f.calls.some(([kind]) => kind === 'run'));
    assert.ok(f.realRequests.some(r => r.url.endsWith('/complete')));
  });

  await step('2. second native job is refused while the first unresolved hold stands', {
  }, async () => {
    assert.equal(runtime.pace50.state().attempts.length, 1, 'step 1 created a real native reservation');
    const unchanged = structuredClone(source.state.used);
    const reset = Math.min(...(await source.observe({provider:'codex', now:f.clock.now()})).resources.map(r => r.resets_at));
    f.clock.advance(NATIVE_SETTLEMENT_DELAY_MS + poll);
    await runtime.candidate.probeHeld();
    const second = await runtime.candidate.reserve({attemptId:'second-before-reset',jobId:'second-before-reset',
      provider:'codex',model:'gpt-6-sol',job:f.job.payload,automatic:true,ownerAbsent:true});
    assert.equal(second.ok,false,JSON.stringify(second));
    assert.equal(runtime.pace50.state().attempts.length,1,'the refused job creates no reservation');
    assert.equal(f.calls.filter(([kind]) => kind === 'run').length,1,'the second job never launches');
    assert.ok(runtime.pace50.state().attempts[0].resources.every(r => r.held_micro+r.unrepresented_micro===r.initial_micro));
    assert.ok(f.clock.now() < reset, 'no window reset was used');
    assert.deepEqual(source.state.used, unchanged, 'provider readings never rose');
  });
  // Remaining steps exercise scheduling independently of the known native hold.
  f.policy.lendingRuntime = ordinaryRuntime;

  await step('3. structural passing declines respect the re-offer floor', {}, async () => {
    // resources_incomplete is passing but cannot become runnable every three seconds.
    const reason = 'resources_incomplete';
    assert.equal(isPassingDecline(reason), true);
    const gate = ordinaryRuntime.candidate.gate;
    ordinaryRuntime.candidate.gate = async ({jobId}) => jobId ? reason : null;
    try {
      const job = await f.submit();
      a.start();
      await within(() => a.events.some(e => e.reason === reason), lease, 'first structural decline');
      await observed(() => !f.saved()?.declinePending, 'decline acknowledged');
      const first = f.saved().declined.find(row => row.jobDigest === job);
      const initialExpiry = first.expiresAt;
      const firstAt = f.clock.now();
      // Observe actual reclaims, not just the saved exclusion timestamp.
      const count = () => a.events.filter(e => e.status === 'declined' && e.reason === reason).length;
      const before = count();
      await within(() => f.clock.now() >= firstAt + TEMPORARY_HOLD_REOFFER_MS - poll,
        TEMPORARY_HOLD_REOFFER_MS, 'simulate the re-offer floor');
      assert.equal(count(), before, 'same structural refusal must not be reclaimed inside the floor');
      assert.ok(initialExpiry - firstAt >= TEMPORARY_HOLD_REOFFER_MS,
        `structural decline excluded for ${initialExpiry - firstAt} ms; floor ${TEMPORARY_HOLD_REOFFER_MS}`);
    } finally { ordinaryRuntime.candidate.gate = gate; }
  });

  // Cross the daily counter boundary without waiting in wall time.
  async function newDay() {
    await f.stop();
    f.clock.advance(24 * 60 * 60 * 1000);
  }
  await step('4. Stop ceases running compute and the borrower sees it', {}, async () => {
    // A controllable fake run supports Stop without invoking any real agent.
    const start = f.backend.start;
    let running;
    f.backend.start = async (handle, options) => {
      let launched = false;
      const result = await start(handle, {...options, onExecutionStarted:() => {
        launched = true; options.onExecutionStarted?.();
      }});
      if (!launched) return result;
      running = true;
      await new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), {once:true});
      });
    };
    try {
      const job = await f.submit(); a.start();
      await within(() => running, lease, 'fake run starts');
      await a.lender.stopCurrentJob(a.lender.snapshot.current);
      await within(() => a.events.some(e => e.stopCompletion?.jobDigest === job), lease, 'borrower sees cessation');
      const view = await f.owner.getJob(job);
      assert.equal(view.current_attempt.compute_stopped, true);
      assert.notEqual(view.current_attempt.state, 'active');
      assert.ok(f.calls.some(([kind]) => kind === 'cancel'));
    } finally { await a.stop(); f.backend.start = start; }
  });

  await step('5. restart mid-job settles the old attempt and lending resumes', {}, async () => {
    await newDay();
    const start = f.backend.start, destroy = f.backend.destroy;
    let running = false;
    f.backend.start = async (handle, options) => {
      let launched = false;
      const result = await start(handle, {...options, onExecutionStarted:() => {
        launched = true; options.onExecutionStarted?.();
      }});
      if (!launched) return result;
      running = true;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
    };
    f.backend.destroy = async () => ({removed:false});
    try {
      const job = await f.submit(); a.start();
      await within(() => running, lease, 'run before restart');
      await a.stop();
      assert.ok(f.saved().pending, 'loss of cleanup proof survives app exit');
      f.backend.start = start; f.backend.destroy = destroy;
      f.backend.reconcilePending = async pending => ({attemptId:pending.attemptId, removed:true, scratch_removed:true});
      a.start();
      await within(() => !f.saved()?.pending && !f.saved()?.stoppedPending && !f.saved()?.declinePending,
        lease, 'restart reconciles compute');
      const view = await f.owner.getJob(job);
      assert.equal(view.current_attempt.compute_stopped, true);
      assert.notEqual(view.current_attempt.state, 'active');
      await finished(await f.submit());
    } finally { await a.stop(); f.backend.start = start; f.backend.destroy = destroy; }
  });

  await step('6. another lender runs a declined job', {}, async () => {
    await newDay();
    const gate = ordinaryRuntime.candidate.gate;
    ordinaryRuntime.candidate.gate = async ({jobId}) => jobId ? 'resources_incomplete' : null;
    const job = await f.submit();
    try {
      a.start();
      await within(() => a.events.some(e => e.reason === 'resources_incomplete' && e.jobDigest === job),
        lease, 'lender A declines');
      await a.stop();
      ordinaryRuntime.candidate.gate = gate;
      b.start();
      const view = await finished(job);
      assert.ok(view.current_attempt.holder);
      assert.ok(b.events.some(e => e.status === 'finished' && e.jobDigest === job));
    } finally { ordinaryRuntime.candidate.gate = gate; }
  });

  await step('7. clearing a blocker resumes lending without app restart', {}, async () => {
    let blocked = true;
    a.policy.hold = () => blocked ? 'sandbox_not_ready' : null;
    const job = await f.submit(); a.start();
    await within(() => a.events.some(e => e.reason === 'sandbox_not_ready'), lease, 'blocker shown');
    assert.equal((await f.owner.getJob(job)).attempts_started, 0);
    blocked = false;
    await finished(job);
    assert.equal(a.policy.enabled, true);
  });
});

test('default npm test discovers the lending walk as a merge gate', () => {
  assert.ok(discover().some(job => job.name === 'journey-lending-walk.test.mjs'));
});


// Independent controls use ordinary fixture readiness, not the cold/null-observation path.
// Only the HTTP transport, synthetic backend and explicit fixture approval are involved.
async function coldJobControl(t, approve) {
  const f = await realLenderFixture(t, {offers:true, publish:false});
  const claims = [], claimCalls = [];
  for (const method of ['listOffers', 'claimNext']) {
    if (!f.client[method]) continue;
    const send = f.client[method].bind(f.client);
    f.client[method] = method === 'claimNext'
      ? (ad, options) => send(ad, {...options, waitSeconds:0})
      : options => send({...options, waitSeconds:0});
  }
  for (const method of ['claimJob', 'claimNext']) {
    const send = f.client[method].bind(f.client);
    f.client[method] = async (...args) => {
      claimCalls.push(method);
      const claim = await send(...args);
      if (claim) claims.push({job:claim.job_digest, attempt:claim.attempt.attempt_id});
      return claim;
    };
  }
  const controller = new AbortController();
  let loop;
  const events = [], polls = [];
  const lender = createLender({client:f.client, backend:f.backend, adapters:f.adapters,
    policy:{...f.policy, mode:'ask'}, clock:f.clock, approve,
    onEvent:event => events.push(event), onPoll:result => polls.push(result)});
  f.stop = async () => { controller.abort(); await loop; };
  return {f, claims, claimCalls, events, polls, lender,
    start() { loop = lender.start(controller.signal); },
    launches:() => f.calls.filter(([kind]) => kind === 'run').length};
}

test('cold job control: explicit Ask holds the exact offer until approval, then launches once',
  {timeout:60_000}, async t => {
    let review, approve;
    const answer = new Promise(resolve => { approve = resolve; });
    const c = await coldJobControl(t, value => { review = value; return answer; });
    const {f} = c;
    const digest = await f.submit();
    c.start();
    await observed(() => review, 'exact offer reaches Ask');
    assert.equal(review.jobDigest, digest);
    assert.equal(review.offer, true, 'real coordinator uses pre-claim offer approval');
    assert.equal(review.harness, 'codex');
    // Give the pending approval multiple poll intervals; nothing may claim or launch.
    for (let i = 0; i < 3; i++) {
      f.clock.advance(f.policy.pollMs);
      await setImmediate();
      assert.equal((await f.owner.getJob(digest)).attempts_started, 0);
      assert.deepEqual(c.claimCalls, []);
      assert.deepEqual(c.claims, []);
      assert.equal(c.launches(), 0);
      assert.equal(review.signal.aborted, false);
    }
    approve(true); // The same fixture review's actual response, not a policy bypass.
    await observed(() => c.events.some(e => e.status === 'finished'), 'approved job finishes');
    await observed(() => !f.saved()?.pending && !f.saved()?.acceptedClaim, 'approved job settles');
    await f.stop();
    const view = await f.owner.getJob(digest);
    assert.equal(view.attempts_started, 1);
    assert.equal(view.current_attempt.state, 'completed');
    assert.equal(c.claimCalls.length, 1);
    assert.deepEqual(c.claims, [{job:digest, attempt:view.current_attempt.attempt_id}]);
    assert.equal(c.launches(), 1);
    assert.ok((await f.owner.fetchResult(digest, {attempt:view.current_attempt})).length);
  });


test('cold job control: explicit Ask No hides the exact offer without claiming or launching',
  {timeout:60_000}, async t => {
    let review, decline;
    const reviews = [];
    const answer = new Promise(resolve => { decline = resolve; });
    const c = await coldJobControl(t, value => {
      review = value; reviews.push(value.jobDigest); return answer;
    });
    const {f} = c;
    const digest = await f.submit();
    c.start();
    await observed(() => review, 'exact offer reaches Ask No');
    assert.equal(review.jobDigest, digest);
    assert.equal(review.offer, true);
    assert.equal(review.harness, 'codex');
    assert.equal(typeof review.claimResult?.then, 'function');
    assert.equal((await f.owner.getJob(digest)).attempts_started, 0);
    assert.deepEqual(c.claimCalls, []);
    assert.deepEqual(c.claims, []);
    assert.equal(c.launches(), 0);

    // This is the actual approval callback result. claimResult resolves only
    // after revokeConsent and hideOffer have completed, not merely after a yield.
    const claimResult = review.claimResult;
    decline(false);
    assert.deepEqual(await claimResult, {accepted:false, code:'hidden'});
    const idlePoll = () => !c.lender.snapshot.current &&
      f.clock.pending().length === 1 && f.clock.pending()[0] === f.policy.pollMs;
    await observed(() => review.signal.aborted && idlePoll(),
      'No review is closed and the lender reaches its idle poll');
    const before = c.polls.length;
    f.clock.advance(f.policy.pollMs);
    // Observe a completed real offer read AND the next idle boundary, so the
    // negative assertions cannot race the post-refusal selection pass.
    await observed(() => c.polls.length > before && idlePoll(),
      'post-No offer poll completes without selecting the hidden job');
    assert.deepEqual(c.polls.at(-1), {rateLimited:false}, 'the post-No poll succeeds');
    assert.deepEqual(reviews, [digest], 'the hidden offer is not reviewed again');
    assert.equal((await f.owner.getJob(digest)).attempts_started, 0);
    assert.deepEqual(c.claimCalls, []);
    assert.deepEqual(c.claims, []);
    assert.equal(c.launches(), 0);
    await f.stop();
    assert.equal((await f.owner.getJob(digest)).attempts_started, 0);
    assert.deepEqual(c.claimCalls, []);
    assert.deepEqual(c.claims, []);
    assert.equal(c.launches(), 0);
  });

test('cold job control: verified sandbox-start refusal reaches its exact cause without a launch',
  {timeout:60_000}, async t => {
    const reviews = [];
    const c = await coldJobControl(t, review => { reviews.push(review.jobDigest); return true; });
    const {f} = c;
    const start = f.backend.start.bind(f.backend);
    let refusals = 0;
    f.backend.start = async (handle, options = {}) => {
      // The lender supplies this callback only at the agent launch boundary,
      // after ordinary readiness, consent, claim and start admission succeeded.
      if (typeof options.onLaunchDurable === 'function') {
        refusals++;
        throw Object.assign(new Error('Synthetic verified sandbox start refusal'),
          {code:'sandbox_start_failed'});
      }
      return start(handle, options);
    };
    const digest = await f.submit();
    c.start();
    await observed(() => c.events.some(e => e.status === 'failed' &&
      e.reason === 'sandbox_start_failed'), 'specific sandbox-start refusal');
    await observed(() => !f.saved()?.pending && !f.saved()?.acceptedClaim, 'refused start settles');
    await f.stop();
    const view = await f.owner.getJob(digest);
    assert.deepEqual(reviews, [digest]);
    assert.equal(c.claimCalls.length, 1);
    assert.deepEqual(c.claims, [{job:digest, attempt:view.current_attempt.attempt_id}]);
    assert.equal(view.attempts_started, 0);
    assert.equal(view.current_attempt.state, 'failed');
    assert.equal(refusals, 1, 'the backend start boundary was actually reached');
    assert.equal(c.launches(), 0);
    assert.equal(c.events.filter(e => e.status === 'running').length, 0);
    assert.equal(c.events.filter(e => e.status === 'finished').length, 0);
    assert.ok(f.calls.some(([kind]) => kind === 'prepare'));
    assert.ok(f.calls.some(([kind]) => kind === 'destroy'));
  });
