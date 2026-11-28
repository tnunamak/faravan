import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';

import {createLender} from "../lib/v1/lender.mjs";

import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';

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
  const lender = createLender({...f.runOptions,client:f.client, backend:f.backend, adapters:f.adapters,
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
      e.reason === 'start_failed'), 'specific sandbox-start refusal');
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
