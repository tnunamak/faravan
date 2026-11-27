import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, waitFor, adapters} from './helpers/v1-app-fixture.mjs';

// Item 1 of the startup lane: a normal startApp runs the durable objective engine on the trusted default source, and the
// meter readings that the app is given are the readings that source judges. Synthetic readings only; no provider calls.
const harness = 'claude-code-subscription';

function meterReadings(now, resetsAt) {
  return async () => ({windows: [{window_id: 'seven_day', window_minutes: 10080, state: 'open', used_pct: 5,
    observed_at: now(), resets_at: resetsAt}]});
}

async function askToLend(owner, lender, circle) {
  const ownerLimits = await api(lender.app, '/api/lending/owner-settings');
  const sourceTestCap = Math.max(20, ...ownerLimits.minimums.map(row => row.minimumMaxJobUsd)) + 1;
  await api(lender.app, '/api/lending/owner-settings', {method:'POST', body:{maxJobUsd:sourceTestCap,
    reason:'test the source hold beyond the worst-call budget guard'}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy: {providerConsent: {claude: true}, accountPlans: {claude: 'max20'}}}});
  await api(lender.app, '/api/agents/' + harness, {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  const sent = await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id,
    git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'startup wiring', harness}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  return sent;
}

const claudeDecision = lender => async () => {
  const view = await api(lender.app, '/api/lending');
  const decision = view.objective?.accounts?.find(account => account.id === 'claude')?.decision;
  return decision && decision.reason !== 'objective_evidence_unknown' ? decision : null;
};

test('fixture meter readings reach the trusted default source, so the engine judges them', {timeout: 120000}, async t => {
  const realNow = Date.now.bind(Date);
  const reset = realNow() + 86400000;
  const f = await appFixture(t);
  const refreshes = [];
  const {owner, lender, circle} = await f.connect({
    adapters: adapters().map(a => ({...a, spec:legacyProxyHarness(harness)})),
    quotaReader: async () => ({provider: 'claude', remaining: 100, observedAt: realNow()}),
    lendingReadings: Object.assign(meterReadings(realNow, reset), {requestRefresh: provider => refreshes.push(provider)}),
  });
  assert.equal(existsSync(join(lender.home, 'v1', 'lending-pace50-state.json')), true, 'the durable engine is constructed at startup');
  await askToLend(owner, lender, circle);
  await waitFor(() => refreshes.includes('claude'), 'the source asking for a reading from this run', 20000);
  const row = await waitFor(async () => {
    const view = await api(lender.app, '/api/lending');
    return view.objective?.accounts?.find(account => account.id === 'claude')?.decision ?? null;
  }, 'the engine decision for claude', 20000);
  // The source saw the fixture's saved readings, but none came from this run, so it waits for a fresh reading instead of
  // judging identity from old windows. A missing reading would say refresh_failed.
  assert.equal(row.reason, 'objective_evidence_unknown');
  assert.equal(row.objective?.reasonCode, 'objective_evidence_unknown');
  assert.equal(f.jobs.size > 0 && [...f.jobs.values()].every(job => job.state === 'queued'), true, 'nothing was admitted');
});

test('with no meter readings the trusted source holds with its named refresh reason, never a generic state', {timeout: 120000}, async t => {
  const realNow = Date.now.bind(Date);
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({
    adapters: adapters().map(a => ({...a, spec:legacyProxyHarness(harness)})),
    quotaReader: async () => ({provider: 'claude', remaining: 100, observedAt: realNow()}),
  });
  await askToLend(owner, lender, circle);
  const row = await waitFor(claudeDecision(lender), 'the engine decision for claude', 20000);
  assert.equal(row.reason, 'refresh_failed');
  assert.notEqual(row.reason, 'quota_unknown');
});
