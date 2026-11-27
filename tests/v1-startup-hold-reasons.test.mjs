import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime, publicProtectionSource} from '../lib/v1/lending-runtime.mjs';
import {EXPLAINER, LINES} from '../lib/v1/lending-status-copy.mjs';

// The startup lane's hold reasons, at the candidate and the status surface. With no trusted source the build holds
// refresh_failed by name. An unverified identity names its hold before any job arrives. The status surface names the
// protection source as history or model (null until known) and the owner's strategy id. Synthetic inputs; no provider calls.

const NOW = Date.UTC(2026, 9, 23, 12);
const WEEK = 'acct:weekly:2026-10-19';
const ACCOUNT = 'f12e3786d2837824';
const HAIKU = 'claude-haiku-5-5';
const noopEffects = {
  arm_cessation_deadline: async () => () => {},
  launch_chunk: async () => {},
  open_short_window: async () => {},
  cancel_pending_attempt: async () => {},
  request_cessation: async () => {},
  request_fresh_complete_reconciliation: async () => {},
};
const contextFor = () => ({plan: 'max20', protectionPosition: 'balanced', consent: true});
const job = () => ({requirements: {limits: {wall_seconds: 60}}, expires_at: new Date(NOW + 3600_000).toISOString(),
  budget_v1: {max_list_usd: 3}});

test('a candidate with no trusted source holds refresh_failed by name, not a generic builder failure', {timeout: 60000}, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'startup-no-source-'));
  const opened = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK,
    contextFor, effects: noopEffects});
  t.after(async () => {
    await opened.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const out = await opened.candidate.preview({attemptId: 'attempt-1', jobId: 'job-1', job: job(), provider: 'claude',
    model: HAIKU, automatic: true, ownerAbsent: true});
  assert.equal(out.admitted, false);
  assert.equal(out.reason, 'refresh_failed');
  const decision = opened.candidate.decisionFor('claude');
  assert.equal(decision.reason, 'refresh_failed');
  assert.equal(decision.objective.reasonCode, 'refresh_failed');
  assert.match(decision.objective.reasonText, /recent usage could not be measured/);
});

test('an unverified identity names identity_unknown in the decision before any job arrives', async () => {
  const opened = createPace50Candidate({directory: null, now: () => NOW, account: '  ', account_week_id: WEEK, contextFor});
  const decision = opened.candidate.decisionFor('claude');
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'identity_unknown');
  assert.equal(decision.objective.reasonCode, 'identity_unknown');
  assert.equal(decision.objective.reasonText, 'Holding — Faravan could not confirm which account is signed in to this agent. '
    + 'It clears on its own when the next allowance reading confirms it.');
  assert.equal(decision.objective.protectionSource, 'unknown', 'the candidate keeps its own vocabulary; the surface maps it');
});

test('the status surface names the protection source as history or model, and null until one is known', () => {
  assert.equal(publicProtectionSource('weekly_upper_band'), 'history');
  assert.equal(publicProtectionSource('weekly_band_unbounded'), 'history');
  assert.equal(publicProtectionSource({seven_day:'history', five_hour:'history'}), 'history');
  assert.equal(publicProtectionSource({seven_day:'history', five_hour:'history', extra:'strategy'}), null,
    'mixed or non-history source rows stay unknown');
  assert.equal(publicProtectionSource('model'), 'model');
  assert.equal(publicProtectionSource({seven_day:'strategy', five_hour:'strategy'}), null);
  assert.equal(publicProtectionSource('learning_no_finite_band'), null, 'learning has no finite protection yet');
  assert.equal(publicProtectionSource('unknown'), null);
  assert.equal(publicProtectionSource(undefined), null);
});

test('the runtime view carries the owner strategy id, the named hold and the public protection source', {timeout: 60000}, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'startup-view-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const runtime = createLendingRuntime({directory, backend: {}, now: () => NOW, presence: () => false,
    settings: () => ({enabled: true, intent: 'on', limits: {lendingPolicy: {strategy: 'fixed_share', providerConsent: {claude: true},
      accountPlans: {claude: 'max20'}}}}),
    pace50: {account: '  ', account_week_id: WEEK, contextFor}});
  const view = await runtime.view();
  const claude = view.accounts.find(account => account.id === 'claude');
  assert.equal(claude.decision.strategy, 'fixed_share', 'the strategy id is the owner\'s saved choice');
  assert.equal(claude.decision.reason, 'identity_unknown');
  assert.equal(claude.decision.objective.reasonCode, 'identity_unknown');
  assert.equal(claude.decision.objective.protectionSource, null);
  // The status line is the reviewed copy for the identity hold, and the dial ships with its explainer.
  assert.equal(claude.decision.status.line, LINES.identity);
  assert.equal(view.dial.label, 'Keep more for me');
  assert.equal(view.dial.explainer, EXPLAINER);
});
