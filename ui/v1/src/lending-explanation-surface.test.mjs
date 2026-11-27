import test from 'node:test';
import assert from 'node:assert/strict';
import {objectiveExplanationVM} from './lending-policy-view.mjs';
import {needsPerJobApproval} from './lending-policy-view.mjs';
import {ObjectiveExplanation, ProtectionChooser} from './lending-policy-view.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {statusView} from './helpers.mjs';
import {EXPLAINER, LINES, REASON_LINE} from '../../../lib/v1/lending-status-copy.mjs';
import {certifiedKappa} from '../../../lib/v1/lending-pace50-source.mjs';
import {initialObservationFixture} from '../../../tests/helpers/initial-observation-fixture.mjs';

// The explanation uses the server's admission and basis, with owner-facing language.
const account = decision => ({id: 'claude', label: 'Claude', decision});
const objective = protectionSource => ({admission: 'held', reasonCode: 'identity_unknown',
  reasonText: 'Holding because the account is not verified.', protectionSource});

test('the explanation names own-week protection without exposing engine labels', () => {
  const [row] = objectiveExplanationVM({accounts: [account({strategy: 'automatic', reason: 'identity_unknown', objective: objective('history')})]});
  assert.equal(row.line, 'Holding — Faravan could not confirm which account is signed in to this agent. It clears on its own when the next allowance reading confirms it.');
  assert.doesNotMatch(row.line, /needs you/i);
  assert.equal(row.basisLine, 'Risk target based on your own weeks.');
  assert.equal(row.basisExplainer, EXPLAINER);
  assert.equal(row.reasonCode, 'identity_unknown');
  assert.doesNotMatch(JSON.stringify(row), /Protection source|Strategy:/);
});

test('a different signed-in account is named as the owner\'s to fix, apart from an unconfirmed one', () => {
  const [row] = objectiveExplanationVM({accounts: [account({strategy: 'automatic', reason: 'identity_mismatch',
    objective: {admission: 'held', reasonCode: 'identity_mismatch', reasonText: 'Holding.', protectionSource: null}})]});
  assert.equal(row.line, LINES[REASON_LINE.identity_mismatch]);
  assert.match(row.line, /a different account is signed in to this agent than the one enrolled for lending\. This needs you:/);
  assert.equal(row.reasonCode, 'identity_mismatch');
});

test('a saved provider failure gives a plain explanation without changing the held decision', () => {
  const probe = {reason:'provider_error',status_class:'5xx'};
  const snapshot = {accounts:[account({admitted:false,reason:'refresh_failed',probe,
    status:{line:'Holding — recent usage could not be measured.'},
    objective:{admission:'held',reasonCode:'refresh_failed',reasonText:'Holding — recent usage could not be measured.'}})]};
  const [row] = objectiveExplanationVM(snapshot);
  assert.equal(row.admitted,false);
  assert.match(row.line,/provider returned a server error \(5xx\)/i);
  assert.doesNotMatch(row.line,/provider_error|refresh_failed/);
  assert.match(renderedText(renderFixture(ObjectiveExplanation,{snapshot})),/provider returned a server error \(5xx\)/i);
});

test('real weekly spare-capacity hold names the governing weekly reset in the rendered explanation', async t => {
  const now=Date.parse('2026-10-30T00:00:00Z');
  const weeklyReset=Date.parse('2026-10-31T07:00:00Z');
  const shortReset=Date.parse('2026-10-30T01:30:00Z');
  const f=await initialObservationFixture(t,{startAt:now,weeklyResetAt:weeklyReset,shortResetAt:shortReset,
    weeklyUtilization:98,shortUtilization:4,maxJobUsd:2,
    // This account's own measurement, at the shipped Max 20x rate.
    kappaForUsage:({provider,window,model,account_id})=>({...certifiedKappa({provider,plan:'max20',window,model}),
      binding:{account_sha256_16:account_id}})});
  await f.candidate.observe(f.args); // Populate the cache through the background path.
  const refused=await f.reserve();
  const decision=f.candidate.lastJobDecisionFor('claude');
  assert.equal(refused.ok,false);
  assert.equal(decision.reason,'exceeds_spare');
  assert.equal(decision.objective.reasonCode,'objective_exceeds_spare');
  assert.equal(decision.objective.resetsAt[decision.objective.bindingWindow],new Date(weeklyReset).toISOString());
  assert.notEqual(decision.objective.resetsAt[decision.objective.bindingWindow],new Date(shortReset).toISOString());
  assert.equal(f.adapter.state().attempts.length,0);

  const snapshot={now,zone:'America/Chicago',accounts:[account(decision)]};
  const text=renderedText(renderFixture(ObjectiveExplanation,{snapshot}));
  assert.match(text,/Not enough spare capacity now\./);
  assert.match(text,/weekly allowance resets Sat at 2 AM\./);
  assert.doesNotMatch(text,/ready to lend|will admit|refresh failed/i);
});

test('a generic refresh failure does not say the account has run out of quota', () => {
  const snapshot={accounts:[account({admitted:false,reason:'refresh_failed',
    status:{line:'Holding — recent usage could not be measured.'},
    objective:{admission:'held',reasonCode:'refresh_failed',reasonText:'Holding — recent usage could not be measured.'}})]};
  const text=renderedText(renderFixture(ObjectiveExplanation,{snapshot}));
  assert.match(text,/recent usage could not be measured/i);
  assert.doesNotMatch(text,/not enough spare|weekly allowance resets|exhausted/i);
});

test('a single objective keeps the approval qualifier in Ask mode and drops it in Auto with consent', () => {
  const snapshot = {objective:{admission:'allowed', reasonText:'Ready to lend.'}};
  const render = (mode, consent) => renderedText(renderFixture(ObjectiveExplanation, {snapshot,
    approvalRequired:provider => needsPerJobApproval(mode, consent, provider)}));
  assert.match(render('ask', {claude:true}), /You approve each job before it starts\./);
  assert.doesNotMatch(render('auto', {claude:true}), /You approve each job before it starts\./);
  assert.match(render('auto', {claude:false}), /You approve each job before it starts\./);
});

test('the own-weeks protection basis immediately includes its chance explainer', () => {
  const snapshot = {accounts:[account({admitted:true, status:{}, objective:{...objective('history'),
    admission:'allowed', reasonText:'Ready.'}})]};
  const out = renderedText(renderFixture(ObjectiveExplanation, {snapshot}));
  const basisAt = out.indexOf('Risk target based on your own weeks.');
  const explainerAt = out.indexOf(EXPLAINER);
  assert.ok(basisAt >= 0);
  assert.ok(explainerAt > basisAt, 'the chance explanation follows the protection basis');
});

test('a model basis links to the named starting assumption', () => {
  const [row] = objectiveExplanationVM({accounts: [account({strategy: 'fixed_share', objective: objective('model')})]});
  assert.equal(row.basisLine, 'Using an initial usage estimate. Your lending limits still apply.');
  assert.equal(row.href, '#starting-assumption');
  assert.equal(row.linkLabel, 'Starting assumption for new users');
});

test('an unknown source does not invent a protection basis', () => {
  const [row] = objectiveExplanationVM({accounts: [account({strategy: 'mystery', objective: objective(null)})]});
  assert.equal(row.basisLine, null);
  assert.equal(row.href, null);
  assert.doesNotMatch(JSON.stringify(row), /Protection source|Strategy unavailable/);
});

test('the fresh projection owns the explanation when the last job disagrees', () => {
  const current = {admitted:false, reason:'owner_settings_unreadable', objective:{admission:'held',
    reasonCode:'owner_settings_unreadable', reasonText:'Holding — the saved owner setting cannot be read.'},
    status:{line:'Holding — the saved owner setting cannot be read.'}};
  const lastJob = {admitted:true, reason:'objective_lend', objective:{admission:'allowed',
    reasonCode:'objective_lend', reasonText:'Ready to lend to a friend when a job arrives.'},
    status:{line:'Ready to lend to a friend when a job arrives.'}};
  const [row] = objectiveExplanationVM({accounts:[account({...lastJob, availability:current})]});
  assert.equal(row.admitted, false);
  assert.equal(row.reasonCode, 'owner_settings_unreadable');
  assert.equal(row.line, current.status.line);
});

// The server's named evidence holds (lib/v1/lender-pace50.mjs SEAM_UNKNOWN). Each must read as its own status, not as an unknown one.
const NAMED_HOLDS = ['account_busy', 'probe_deferred', 'refresh_failed', 'identity_unknown', 'account_week_mapping_unknown', 'epoch_unknown', 'resources_incomplete',
  'funding_unknown', 'executor_unknown', 'stop_bound_unknown', 'conversion_unknown', 'history_unknown', 'queue_unknown',
  'owner_scenarios_unknown', 'friend_value_unknown', 'objective_evidence_unknown'];

// Each named hold shows the reviewed status line for its reason, the same string the server's status carries.
test('every named evidence hold shows the reviewed status line for its reason', () => {
  for (const reason of NAMED_HOLDS) {
    const view = statusView(reason);
    assert.equal(view.label, LINES[REASON_LINE[reason]], reason);
    assert.equal(view.message, view.label, reason);
  }
});


test('model-only account and top-level explanations use the candid estimate wording', () => {
  const modelObjective = {admission:'allowed', reasonText:'Ready.', protectionSource:'model'};
  for (const snapshot of [
    {accounts:[account({objective:modelObjective})]},
    {objective:modelObjective},
  ]) {
    const text = renderedText(renderFixture(ObjectiveExplanation, {snapshot}));
    assert.ok(text.includes('Using an initial usage estimate. Your lending limits still apply.'));
    assert.doesNotMatch(text, /Protecting you/);
    assert.ok(text.includes('Starting assumption for new users'));
  }
});

test('closed lending chooser details make no measured owner-impact promise', () => {
  const html = renderFixture(ProtectionChooser, {p:{protectionPosition:'balanced'}, setP:()=>{}, errors:{}});
  const visibleAndAccessible = html.split('<details')[0];
  const text = renderedText(visibleAndAccessible);
  assert.match(text, /Choose a lending setting\. Your limits cap lending, not its effect on your own use\./);
  assert.match(html, /aria-describedby=\"protection-model-targets\"/);
  assert.match(text, /Risk targets are model targets, not measured rates\./);
  assert.doesNotMatch(text, /Choose the chance that your own use needs|how often|weekly-share cap/i);
  assert.match(html, /<details class="dial-how">/);
  assert.match(html, /<details class="dial-assumption"/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('Codex limit detail uses the same hold copy on status badges and the Lend explanation', () => {
  const detail = {fundingReason:'limit_reached'};
  const status = {id:'funding', line:LINES.codex_limit, recovery:{who:'automatic', when:'the limit resets'}};
  const view = statusView('funding_unknown', {detail});
  assert.equal(view.label, LINES.codex_limit);
  assert.equal(view.message, LINES.codex_limit);
  assert.equal(view.remedy, 'Wait for the limit to reset');
  const [row] = objectiveExplanationVM({accounts:[{id:'codex', provider:'codex', decision:{
    admitted:false, reason:'funding_unknown', detail, status,
    objective:{admission:'held', reasonCode:'funding_unknown', reasonText:status.line},
  }}]});
  assert.equal(row.line, LINES.codex_limit);
  assert.doesNotMatch(row.line, /plan and billing/);
});

test('Home and Lend show the limit as an automatic wait', async () => {
  const {lendPageVM, lendingVerdictVM} = await import('./view-models.mjs');
  const {withLendingProjection} = await import('./lending-projection.fixture.mjs');
  const current = {admitted:false, reason:'funding_unknown', detail:{fundingReason:'limit_reached'},
    status:{id:'funding', line:LINES.codex_limit, recovery:{who:'automatic', when:'the limit resets'}},
    objective:{admission:'held', reasonCode:'funding_unknown', reasonText:LINES.codex_limit}};
  const status = withLendingProjection({lending:{enabled:true, status:'idle', circle:'friends'},
    lendingPolicy:{accounts:[{provider:'codex', decision:{...current, availability:current}}]}});
  const agents = [{id:'codex', installed:true, signedIn:true, useForLending:true, signInSupported:true}];
  for (const vm of [lendPageVM(status, {agents}), lendingVerdictVM(status, null, 'UTC', agents)]) {
    assert.equal(vm.reason, 'Codex: ' + LINES.codex_limit);
    assert.equal(vm.ownerHold, false);
  }
});
