import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// A lender that was on before a restart must take its own quota reading again, with no job arriving first.
// Until a reading exists the status reads "Waiting for a current quota reading", which clears only when a job is checked.
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1'});
const codexDecision = async app => (await api(app, '/api/lending')).objective.accounts.find(a => a.provider === 'codex')?.decision;

test('a lender that restarts with lending on takes a current quota reading without a job', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({shutdownProofMs: 2000, lendingPace50: evidence()});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy: {providerConsent: {codex: true}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await lender.app.close();

  // No job is ever submitted. The restarted lender must reach a reading by itself.
  const restarted = await f.start('lender', {shutdownProofMs: 2000, lendingPace50: evidence()});
  await waitFor(async () => {
    const decision = await codexDecision(restarted.app);
    return decision !== undefined && decision.reason !== 'objective_evidence_unknown';
  }, 'a current codex reading after restart, with no job', 30000);
  assert.notEqual((await codexDecision(restarted.app)).reason, 'objective_evidence_unknown');
});
