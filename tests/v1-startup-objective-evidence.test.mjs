import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {defaultOwnerMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';

// Normal startup builds the objective evidence through the production builder, with no builder injected. The owner's scenarios
// and the job's value come from a demand model configured on the deployment. The stub below stands in for the continuous model
// that the M1 compose step plugs in. Synthetic readings and history only; no provider calls.
const claudeAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];

// The synthetic readings and history, without the synthetic builder: the builder under test is the production one.
function completeSource() {
  const {objectiveInputFor, ...source} = createSyntheticPace50Source({start: Date.now(), override: ({base}) => ({...base,
    account_week_id: `${base.identity.account_id}:weekly:${base.resources.find(r => r.kind === 'weekly').resets_at}`})});
  return source;
}

// A stub demand model: it records what the production builder asked it, and answers with owner scenarios and a job value.
// The owner value is zero here only because this is a stub; the real model supplies the value from measured use.
function stubDemandModel() {
  const asked = [];
  return {asked, ownerEvidence: async evidence => {
    asked.push(evidence);
    const need = Object.fromEntries(evidence.input.windows.map(window => [window.id, 0]));
    return {owner: {scenarios: [{probability: 1, attempts: [{need, value: 0, atomic: false}]}]},
      job: {friendValue: 100, estimateUsdMicro: 3000000}};
  }};
}

async function askForWork(f, owner, lender, circle) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: {url: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40)}, prompt: 'Synthetic objective evidence.', harness: 'claude-code-subscription'}});
}

// Automatic lending runs a job only with the lender's saved Claude consent (the consent control). askForWork does not save it;
// the Limits page saves it with the same lending/limits request, so the two Automatic tests below save it first.
const grantClaudeConsent = lender => api(lender.app, '/api/lending/limits', {method: 'POST',
  body: {lendingPolicy: {providerConsent: {claude: true}}}});

// askForWork turns the lending controls on, but an availability decision can be made before the last setting lands.
// Every test here passes settled: true to wait past that early 'controls' hold.
const claudeDecision = (lender, {settled = false} = {}) => waitFor(async () => {
  const view = await api(lender.app, '/api/lending');
  const row = view.objective?.accounts?.find(account => account.provider === 'claude')?.decision;
  return row?.reason && row.reason !== 'objective_evidence_unknown' && !(settled && row.reason === 'controls') ? row : null;
}, 'the objective decision for claude', 60000);

// The fluid rule's judgment of the owner's job is lastJobDecision. The availability row can be read before the job is judged,
// while Claude's usage is still unmeasured (usage_unknown), so the positive assertions read the job's own judgment.
const claudeJobDecision = lender => waitFor(async () => {
  const view = await api(lender.app, '/api/lending');
  return view.objective?.accounts?.find(account => account.provider === 'claude')?.decision?.lastJobDecision ?? null;
}, 'the claude job decision', 60000);

// The fluid rule (fluid_lend) admitted the owner's job at the allowed objective_lend reason.
function assertFluidRuleAdmitted(job) {
  assert.equal(job.admitted, true, 'the fluid rule admitted the job');
  assert.equal(job.reason, 'objective_lend');
  assert.equal(job.objective.admission, 'allowed');
  assert.equal(job.objective.reasonCode, 'objective_lend');
  assert.equal(job.objective.ruleReasonCode, 'fluid_lend');
}

test('normal startup builds objective evidence from the demand model, with no builder injected, under the default owner cap', {timeout: 180000}, async t => {
  const demand = stubDemandModel();
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({adapters: claudeAdapters, lendingPace50: {source: completeSource()},
    demandModel: demand, lendingQueueReader: async () => ({known: true, laterBurnCapacityMicro: 0})});
  await grantClaudeConsent(lender);
  await askForWork(f, owner, lender, circle);
  const decision = await claudeDecision(lender, {settled: true});
  assert.ok(demand.asked.length > 0, 'the production builder asked the demand model for the owner evidence');
  // An unset owner limit is the documented default for the model each request judges (worst call + $4, at least $4), never null.
  // Status checks and the job may judge different models, and they can reach the demand model in either order.
  for (const {request} of demand.asked)
    assert.equal(request.owner_max_job_usd_micro, Math.ceil(defaultOwnerMaxJobUsdForModel('claude', request.model) * 1e6),
      `the default cap for ${request.model}`);
  assert.notEqual(decision.reason, 'owner_scenarios_unknown', 'the owner scenarios came from the model');
  assert.notEqual(decision.reason, 'friend_value_unknown', 'the job value came from the model');
  assertFluidRuleAdmitted(await claudeJobDecision(lender));
});

test('the Automatic fluid rule judges a request with no signed budget at the owner cap instead of holding it', {timeout: 180000}, async t => {
  // The app's own send paths (the Send page and jobs.submit) sign no budget, so holding such a job would hold every one.
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({adapters: claudeAdapters, lendingPace50: {source: completeSource()},
    lendingQueueReader: async () => ({known: true, laterBurnCapacityMicro: 0})});
  await grantClaudeConsent(lender);
  await askForWork(f, owner, lender, circle);
  const decision = await claudeDecision(lender, {settled: true});
  assert.notEqual(decision.reason, 'friend_value_unknown');
  assertFluidRuleAdmitted(await claudeJobDecision(lender));
});

test('the legacy rule still holds an Automatic request with no signed useful-value budget', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({adapters: claudeAdapters, lendingPace50: {source: completeSource()},
    lendingRule: 'legacy', lendingQueueReader: async () => ({known: true, laterBurnCapacityMicro: 0})});
  await askForWork(f, owner, lender, circle);
  const decision = await claudeDecision(lender, {settled: true});
  assert.equal(decision.reason, 'friend_value_unknown');
});

test('automatic typed policies also hold when a request has no signed useful-value budget', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({adapters: claudeAdapters, lendingPace50: {source: completeSource()},
    lendingQueueReader: async () => ({known: true, laterBurnCapacityMicro: 0})});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {lendingPolicy: {
    strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30}}}});
  await askForWork(f, owner, lender, circle);
  const decision = await claudeDecision(lender, {settled: true});
  assert.equal(decision.strategy, 'fixed_share');
  assert.equal(decision.reason, 'friend_value_unknown');
});
