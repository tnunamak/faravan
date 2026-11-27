import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-lifecycle-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

const signedIn = {providers: [{harness_id: 'codex', installed: true, signedIn: true}]};
const cold = () => [{spec: legacyProxyHarness('codex')}];

// Each lending-on action mints one trigger; the first pool start of that generation consumes it, and nothing else
// (a repeated On, a lender that restarts) starts another stop check.
test('one stop-check trigger per intent generation: On, Off then On, Pause then Resume give three', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  let starts = 0, parks = 0;
  const fake = {start() { starts++; }, disableRenewal() { parks++; }, retry() {}, async ensure() { return {ok: true}; }, async view() { return {state: 'valid', line: null}; }, running: false, close() {}};
  const {lender: first, circle} = await f.connect({});
  await api(first.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(first.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(first.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(first.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await first.app.close();
  const lender = await f.start('lender', {adapters: cold(), identityProbe: async () => signedIn, stopCheckCoordinator: fake});
  const on = async () => { await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}}); };
  // A restart with intent on is generation one.
  await waitFor(async () => starts === 1, 'restart resumes lending', 30000);
  assert.equal(starts, 1);
  await on();
  assert.equal(starts, 1, 'a repeated On is not a new trigger');
  await api(lender.app, '/api/lending/off', {method: 'POST', body: {}});
  assert.equal(parks, 1, 'Off disarms renewal');
  await on();
  await waitFor(async () => starts === 2, 'second generation', 20000);
  await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
  assert.equal(parks, 2, 'Pause disarms renewal');
  await api(lender.app, '/api/lending/resume', {method: 'POST', body: {circle: circle.id}});
  await waitFor(async () => starts === 3, 'third generation', 20000);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(starts, 3);
});

// An explicit On is accepted before the host answers. Its one check belongs to that intent, whichever start first
// reaches a running pool.
test('On while the host is down, then a restart with the host back: exactly one stop check for the intent', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  let starts = 0;
  const fake = {start() { starts++; }, retry() {}, async ensure() { return {ok: true}; }, async view() { return {state: 'valid', line: null}; }, running: false, close() {}};
  const {lender: first, circle} = await f.connect({});
  await api(first.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(first.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(first.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await first.app.close();
  let down = true;
  const reachable = f.override;
  f.override = async args => { if (down) { args.req.socket.destroy(); return true; } return reachable(args); };
  const opts = {adapters: cold(), identityProbe: async () => signedIn, stopCheckCoordinator: fake, blockerRecheckMs: 300, hostProfileMs: 300};
  const lender = await f.start('lender', opts);
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}, status: 409});
  assert.equal(starts, 0, 'no check while the host has not answered');
  await lender.app.close();
  down = false;
  const again = await f.start('lender', opts);
  await waitFor(async () => (await api(again.app, '/api/lending')).enabled === true, 'lending starts after the restart', 60000);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(starts, 1, 'exactly one check for that intent');
});

// R2 at app level: no claim, pool or check before host init succeeds; then one pool and one check start. A claimed job joining
// that check is covered at the gate (v1-stop-evidence-admission): the app fixtures use a synthetic evidence source, and the join
// runs only for a real one.
test('queued job: zero claims before host init is released, then exactly one pool and one check start', {timeout: 180000}, async t => {
  const jobs = await import('./helpers/offers-jobs-fixture.mjs');
  const f = await jobs.appFixture(t), {owner, lender: first, circle} = await f.connect();
  let starts = 0;
  const fake = {start() { starts++; }, retry() {}, async ensure() { return {ok: true}; }, async view() { return {state: 'valid', line: null}; }, running: false, close() {}};
  await jobs.api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Queued before init', harness: 'codex'}});
  await jobs.api(first.app, '/api/lending/limits', {method: 'POST', body: {maxWallSeconds: 1200, idleOnly: false}});
  await jobs.api(first.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await jobs.api(first.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await first.app.close();
  let held = true, claims = 0, release;
  const open = new Promise(resolve => { release = resolve; });
  const reachable = f.override;
  f.override = async args => {
    if (args.route === '/roster' && held) await open;
    if (args.route === '/jobs/claim-next' || /\/claim$/.test(args.route)) claims++;
    return reachable(args);
  };
  let pools = 0;
  const lender = await f.start('lender', {stopCheckCoordinator: fake, onLendingPoolStart: () => { pools++; }});
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(claims, 0, 'no claim while host init is pending');
  assert.equal(pools, 0);
  assert.equal(starts, 0);
  held = false; release();
  await jobs.waitFor(async () => pools === 1 || null, 'one pool starts after host init is released', 60000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(pools, 1, 'one pool');
  assert.equal(starts, 1, 'one check start, never a second');
});
