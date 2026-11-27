import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
const codexRow = async app => (await api(app, '/api/agents'))[0];
const idle = () => new Promise(resolve => setTimeout(resolve, 300));

// A lender whose codex proxy identity probe is slow: the probe is held until the test answers it, the way a cold
// identity sandbox takes minutes. Nothing is proven yet, so the owner identity has no evidence either.
async function lenderWithHeldProbe(t) {
  const held = [];
  // Registered before the fixture's cleanup: a probe still held at teardown answers "no answer" so the app can close.
  t.after(() => { for (const pending of held.splice(0)) pending.answer(null); });
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({
    adapters: [{...native, installed: true, signedIn: false}],
    signInProbeTimeoutMs: 100,
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: ({harnessNames}) => new Promise((resolve, reject) => held.push({
      // null means "no answer": the probe returned no provider row.
      answer: value => resolve(value === null ? null : {providers: [{harness_id: harnessNames[0], installed: true, signedIn: value}]}),
      reject,
    })),
  });
  return {f, owner, lender, circle, held};
}
const answer = (held, value) => {
  const pending = held.shift();
  if (value instanceof Error) pending.reject(value);
  else pending.answer(value);
};
// Admission is the claim the person sees: the lender holds the job in an approval card (mode ask), so nothing has run.
const admitted = async (lender, digest) => JSON.stringify(await api(lender.app, '/api/approvals')).includes(digest);
const submitCodexJob = (owner, circle, prompt) => api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness: 'codex'}});

test('lending On returns while the proxy probe is still pending, and claims nothing until it answers', {timeout: 120000}, async t => {
  const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
  const started = Date.now();
  const on = await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.ok(Date.now() - started < 15000, 'On does not wait for a probe that is still pending');
  assert.equal(on.enabled, true);
  await waitFor(() => held.length === 1, 'the held proxy probe');
  const row = await waitFor(async () => {
    const r = await codexRow(lender.app);
    return r.signInState === 'Checking' ? r : null;
  }, 'Checking while the proxy probe is pending');
  assert.equal(row.signInReason, 'proxy_unconfirmed');
  assert.equal(row.proxySignedIn, null);
  const submitted = await submitCodexJob(owner, circle, 'Synthetic held-probe claim test.');
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false, 'no job is admitted while the proxy is unknown');
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'prepare' || kind === 'run'), false);
  assert.equal(held.length, 1, 'the probe is single-flight: one pending check, not one per call');
});

test('a late sign-in starts claiming by itself, with no second On or Resume', {timeout: 120000}, async t => {
  const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
  // The person chooses Codex, then presses On; both happen before the slow probe answers, and nothing happens after.
  // Choosing the agent waits for the same probe (the agent-choice lane), so it finishes only when the answer comes.
  const chosen = api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await waitFor(() => held.length === 1, 'the held proxy probe');
  const started = Date.now();
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.ok(Date.now() - started < 15000, 'On does not wait for the pending probe or the pending choice');
  assert.equal(held.length, 1, 'On joins the same single-flight probe');
  const submitted = await submitCodexJob(owner, circle, 'Synthetic late sign-in test.');
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false, 'nothing is admitted before the answer');
  answer(held, true);
  await chosen;
  const row = await waitFor(async () => {
    const r = await codexRow(lender.app);
    return r.proxySignedIn === true ? r : null;
  }, 'proxy signed in after the late answer');
  assert.equal(row.signInState, 'Signed in');
  assert.notEqual(row.signInState, 'Checking');
  // The identity change wakes the lender, which claims the queued job with no further On or Resume.
  await waitFor(() => admitted(lender, submitted.jobDigest), 'the lender admits the queued job', 20000);
  assert.equal((await api(lender.app, '/api/lending')).enabled, true);
});

test('a late sign-out shows the sign-in blocker and claims nothing', {timeout: 120000}, async t => {
  const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await waitFor(() => held.length === 1, 'the held proxy probe');
  const submitted = await submitCodexJob(owner, circle, 'Synthetic late sign-out test.');
  answer(held, false);
  const row = await waitFor(async () => {
    const r = await codexRow(lender.app);
    return r.signInState === 'Sign-in needed' ? r : null;
  }, 'the sign-in blocker after the late sign-out');
  assert.equal(row.proxySignedIn, false);
  assert.match(row.remedy, /Sign in to Docker to lend Codex/);
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false);
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'prepare' || kind === 'run'), false);
});

for (const [label, outcome] of [['throws', new Error('probe failed')], ['returns no answer', null]]) {
  test(`a late probe that ${label} leaves Checking for Can't check, and claims nothing`, {timeout: 120000}, async t => {
    const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
    await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
    await waitFor(() => held.length === 1, 'the held proxy probe');
    const submitted = await submitCodexJob(owner, circle, 'Synthetic unknown-answer test.');
    answer(held, outcome);
    const row = await waitFor(async () => {
      const r = await codexRow(lender.app);
      return r.signInState === "Can't check" ? r : null;
    }, "Can't check after an unknown answer");
    assert.equal(row.signInReason, 'proxy_unconfirmed');
    assert.equal(row.proxySignedIn, null);
    await idle();
    assert.equal(await admitted(lender, submitted.jobDigest), false);
    assert.equal(lender.backend.calls.some(([kind]) => kind === 'prepare' || kind === 'run'), false);
  });
}

test('a late sign-out after the person chose Codex and pressed On fails the choice, shows the blocker, and claims nothing', {timeout: 120000}, async t => {
  const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
  const chosen = api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}}).then(() => null, error => error);
  await waitFor(() => held.length === 1, 'the held proxy probe');
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const submitted = await submitCodexJob(owner, circle, 'Synthetic choice then sign-out test.');
  answer(held, false);
  const failure = await chosen;
  assert.match(String(failure?.message), /agent_not_ready/, 'the choice still needs a fresh signed-in proof');
  const row = await waitFor(async () => {
    const r = await codexRow(lender.app);
    return r.signInState === 'Sign-in needed' ? r : null;
  }, 'the sign-in blocker after the late sign-out');
  assert.match(row.remedy, /Sign in to Docker to lend Codex/);
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false, 'nothing is admitted');
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'prepare' || kind === 'run'), false);
});

test('a choice made before the probe answers completes on the late sign-in, and the queued job is admitted with no further On', {timeout: 120000}, async t => {
  const {owner, lender, circle, held} = await lenderWithHeldProbe(t);
  const chosen = api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await waitFor(() => held.length === 1, 'the held proxy probe');
  const on = await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.equal(on.enabled, true);
  const submitted = await submitCodexJob(owner, circle, 'Synthetic choose-then-On test.');
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false, 'nothing is admitted before the answer');
  answer(held, true);
  await chosen;
  await waitFor(() => admitted(lender, submitted.jobDigest), 'the lender admits the queued job', 20000);
  assert.equal((await api(lender.app, '/api/lending')).enabled, true);
});

test('a lender that starts with Codex already chosen: On returns within the deadline, and claims after a late sign-in', {timeout: 120000}, async t => {
  const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
  const f = await appFixture(t);
  // First run: the probe answers at once, so the choice and the saved settings are real, not seeded.
  const {owner, lender, circle} = await f.connect({adapters: [{...native, installed: true, signedIn: false}],
    lendingSignInProbe: async () => ({signedIn: true, secretPresent: true}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: async ({harnessNames}) => ({providers: [{harness_id: harnessNames[0], installed: true, signedIn: true}]})});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await lender.app.close();
  // Restart on the same home with the first probe held. The saved choice is what starts the probe.
  const held = [];
  t.after(() => { for (const pending of held.splice(0)) pending.answer(null); });
  const restarted = await f.start('lender', {adapters: [{...native, installed: true, signedIn: false}], signInProbeTimeoutMs: 100,
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: ({harnessNames}) => new Promise((resolve, reject) => held.push({
      answer: value => resolve(value === null ? null : {providers: [{harness_id: harnessNames[0], installed: true, signedIn: value}]}), reject}))});
  const started = Date.now();
  const on = await api(restarted.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.ok(Date.now() - started < 15000, 'On returns within the deadline while the probe is held');
  assert.equal(on.intent, 'on');
  await waitFor(() => held.length === 1, 'the held proxy probe after restart');
  const submitted = await submitCodexJob(owner, circle, 'Synthetic already-chosen test.');
  await idle();
  assert.equal(await admitted(restarted, submitted.jobDigest), false, 'nothing is admitted before the answer');
  answer(held, true);
  await waitFor(() => admitted(restarted, submitted.jobDigest), 'the lender admits the queued job after the late sign-in', 20000);
});

// Both probes held: the proxy probe (lendingIdentityProbe) and the native sandbox probe (identityProbe). Nothing answers
// until the test does, the way a cold identity sandbox takes minutes.
async function lenderWithHeldProbes(t) {
  const proxyHeld = [], nativeHeld = [];
  let nativeCalls = 0, proxyCalls = 0;
  t.after(() => {
    for (const pending of proxyHeld.splice(0)) pending.answer(null);
    for (const pending of nativeHeld.splice(0)) pending.answer({providers: []});
  });
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({
    adapters: [{...native, installed: true, signedIn: false}],
    signInProbeTimeoutMs: 100,
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    lendingStoreBackedAgents: [], lendingIdentityProbe: ({harnessNames}) => new Promise((resolve, reject) => {
      proxyCalls++;
      proxyHeld.push({answer: value => resolve(value === null ? null : {providers: [{harness_id: harnessNames[0], installed: true, signedIn: value}]}), reject});
    }),
    identityProbe: ({harnessNames}) => new Promise(resolve => {
      nativeCalls++;
      nativeHeld.push({answer: value => resolve(value), reject: () => resolve({providers: []})});
    }),
  });
  return {f, owner, lender, circle, proxyHeld, nativeHeld, counts: () => ({proxyCalls, nativeCalls})};
}

test('a background pass does not hold On behind the native probe while the proxy probe is still pending', {timeout: 120000}, async t => {
  const {owner, lender, circle, proxyHeld, nativeHeld} = await lenderWithHeldProbes(t);
  await api(lender.app, '/api/agents'); // starts a background pass for codex
  await waitFor(() => proxyHeld.length === 1, 'the held proxy probe');
  await idle(); // the pass reaches its deadline while the proxy is still pending
  const started = Date.now();
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.ok(Date.now() - started < 15000, 'On returns within the deadline, not behind the native probe');
  const submitted = await submitCodexJob(owner, circle, 'Synthetic background-pass test.');
  await idle();
  assert.equal(await admitted(lender, submitted.jobDigest), false, 'nothing is claimed while the proxy is unknown');
  assert.equal(nativeHeld.length, 0, 'no native probe starts while the proxy probe is still pending');
});

test('while a proxy probe is pending, repeated agent reads start no new pass and no native probe', {timeout: 120000}, async t => {
  const {lender, proxyHeld, counts} = await lenderWithHeldProbes(t);
  for (let read = 0; read < 4; read++) {
    await api(lender.app, '/api/agents');
    await idle();
  }
  await waitFor(() => proxyHeld.length === 1, 'the held proxy probe');
  assert.equal(counts().proxyCalls, 1, 'one proxy probe, however many reads');
  assert.equal(counts().nativeCalls, 0, 'no native probe while the proxy probe is pending');
});
