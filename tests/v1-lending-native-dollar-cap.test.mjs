import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';

// A dollar cap on a native-window (cold) account (1101 round 4). With no measured rate the points hold and the live meter guard
// are the limit, so a job's max_list_usd must not be converted to points. Before the fix, the objective priced the request's
// owner harm with a null rate and threw, so the lending status preview (which builds its job with budget_v1.max_list_usd) and
// every CLI job with a dollar cap were refused as objective_evidence_invalid. Synthetic evidence only: no provider, browser,
// network or Docker.
const NOW = Date.parse('2026-10-09T12:02:00Z');
const MICRO = 1_000_000;
// Haiku's worst call ($1.32) fits under a $5 cap; Codex has no worst-call allowance.
const MODEL = {claude: 'claude-haiku-5-5', codex: 'gpt-6-sol'};
const toNative = ({base}) => ({...base, resources: base.resources.map(r => ({...r, conversion: 'native_window', kappa_micro: null,
  kappa_lower_micro: null}))});

function runtimeFor(t, {native = true, maxJobUsd = 10} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-dollar-cap-'));
  const source = createSyntheticPace50Source({start: NOW, used: {weekly: 0, short: 0},
    ...(native ? {override: toNative} : {kappa: {weekly: 100_000, short: 100_000}})});
  // The worst call is the production one (app.mjs objective builder): Claude's call headroom for the model, zero for Codex,
  // which runs under the guard's native credit cap. The synthetic source's fixed $1.32 would make a cheap status model too small.
  const objectiveInputFor = async args => {
    const objective = await source.objectiveInputFor(args);
    const model = args.request?.model;
    objective.job.worstCallUsdMicro = args.request?.provider === 'claude' ? Math.ceil(claudeCallHeadroomUsd(model) * MICRO) : 0;
    return objective;
  };
  // Auto mode: the status preview is automatic, as the app's Lend page asks for it.
  const runtime = createLendingRuntime({directory, now: () => NOW, presence: () => false,
    settings: () => ({enabled: true, intent: 'on', activeCircle: 'c', modes: {c: 'auto'},
      limits: {lendingPolicy: {providerConsent: {claude: true, codex: true}, accountPlans: {claude: 'max20', codex: 'pro'}}}}),
    pace50: {source, objectiveInputFor, account: 'synthetic-account', account_week_id: 'synthetic-week-1',
      contextFor: () => ({consent: true, ownerAbsent: true}), ownerSettings: {limit: () => ({state: 'set', maxJobUsd})}}});
  t.after(async () => { await runtime.close?.(); fs.rmSync(directory, {recursive: true, force: true}); });
  return runtime;
}
const capped = usd => ({budget_v1: {max_list_usd: usd}, requirements: {capabilities: ['budget_v1'], limits: {wall_seconds: 600}},
  expires_at: new Date(NOW + 3600e3).toISOString()});

test('the lending status preview of a cold account in Auto mode reads ready to lend, not an invalid-evidence hold', async t => {
  for (const provider of ['claude', 'codex']) {
    const runtime = runtimeFor(t);
    const status = await runtime.refreshCapacity(provider);
    assert.notEqual(status.reason, 'objective_evidence_invalid', `${provider}: the preview did not throw`);
    assert.equal(status.admitted, true, `${provider}: ${JSON.stringify(status.reason)}`);
    assert.equal(status.objective?.reasonCode, 'objective_lend_native');
    const view = (await runtime.view()).accounts.find(a => a.provider === provider);
    assert.equal(view.decision.availability.status.id, 'learning_ready', `${provider}: ${view.decision.availability.status.line}`);
  }
});

test('a cold-account job with its own max_list_usd is admitted under the points hold, and the cap only narrows the dollar budget',
  async t => {
    for (const provider of ['claude', 'codex']) {
      const held = [];
      // The job's cap below the owner's $10 sets the native dollar budget; a cap above it does not widen it.
      for (const [usd, gross] of [[5, 5], [50, 10]]) {
        const runtime = runtimeFor(t);
        const out = await runtime.candidate.reserve({attemptId: `a-${provider}-${usd}`, jobId: `j-${usd}`, provider,
          model: MODEL[provider], job: capped(usd), automatic: true, ownerAbsent: true});
        assert.equal(out.ok, true, `${provider} $${usd}: ${out.policyReason}`);
        const objective = runtime.candidate.lastJobDecisionFor(provider).objective;
        assert.equal(objective.reasonCode, 'objective_lend_native');
        assert.equal(objective.maximumExposureUsd, gross, `${provider} $${usd}: the dollar budget is the smaller cap`);
        const attempt = runtime.pace50.state().attempts.at(-1);
        assert.ok(attempt.resources.every(r => r.kappa_micro === null && r.held_micro > 0), 'held in points, with no rate');
        held.push(attempt.resources.map(r => [r.id, r.held_micro]));
        if (provider === 'claude')
          assert.equal(out.maxBudgetUsd, objective.nativeMaxBudgetUsd, 'Claude --max-budget-usd is the capped native budget');
      }
      // The points hold comes from the window's spare points, not from the dollar cap, so a larger cap holds no more.
      assert.deepEqual(held[1], held[0], `${provider}: the dollar cap never changes the points hold`);
    }
  });

test('a dollar-mode account with a measured rate prices max_list_usd as before', async t => {
  const runtime = runtimeFor(t, {native: false});
  const out = await runtime.candidate.reserve({attemptId: 'a-dollar', jobId: 'j-dollar', provider: 'claude', model: MODEL.claude,
    job: capped(5), automatic: true, ownerAbsent: true});
  assert.equal(out.ok, true, out.policyReason);
  const objective = runtime.candidate.lastJobDecisionFor('claude').objective;
  const attempt = runtime.pace50.state().attempts.at(-1);
  // Pinned from 39b821d9: kappa 0.1 points per USD turns the $5 cap into 0.5 points per window, and the Claude budget is
  // the cap less the worst call. The fix leaves every one of these unchanged.
  assert.deepEqual(attempt.resources.map(r => [r.id, r.kappa_micro, r.held_micro]),
    [['seven_day', 100_000, 500_000], ['five_hour', 100_000, 500_000]]);
  assert.equal(out.maxBudgetUsd, 3.68);
  assert.equal(objective.maximumExposureUsd, 5);
  assert.equal(objective.expectedOwnerHarm, 0);
  assert.equal(objective.reasonCode, 'objective_lend');
  assert.equal(objective.conversion, undefined, 'a dollar-mode decision carries no native conversion');
});
