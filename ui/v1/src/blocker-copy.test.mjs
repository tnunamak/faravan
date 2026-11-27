import test from 'node:test';
import assert from 'node:assert/strict';
import {Setup} from './setup.jsx';
import {Lend} from './lend.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {formatLendingProjection} from '../../../lib/v1/lending-summary.mjs';
import {signInView, progressView} from './signin.mjs';

// One message per blocker state, true to what the app knows (checkpoint copy contract).
// Each test renders the real screen from the readiness facts the app returns on Linux.
const circles = [{id:'weekend', origin:'https://circle.test', name:'Weekend projects', enrollment:{state:'approved'}, rosterMembershipVerified:true}];
const lent = [{id:'codex', useForLending:true, installed:true, signedIn:true, run:{}}];
const ok = name => ({name, ok:true});
const BASE = [ok('sbx_install'), ok('sbx_daemon'), ok('docker_login')];
const swap = (name, over) => BASE.map(check => check.name === name ? {...check, ...over} : check);
const homeFor = reason => withLendingProjection({lending:{enabled:true, circle:'weekend', limits:{}}},
  {intent:'on', admission:'blocked', admissionReason:reason});
const setup = (checks, {agents = lent, reason = 'sandbox_not_ready'} = {}) => {
  const home = homeFor(reason);
  return withoutMaskMarkers(renderFixture(Setup, {api:{}, agents, circles, circle:'weekend', mutate:async () => ({}), refresh() {}, lending:home.lending,
    data:{readiness:{ready:false, checks}, agents, lendingReadiness:{agents:[]}, home, devices:{name:'This computer'}, status:home}}));
};
const lend = (checks, {agents = lent, reason = 'sandbox_not_ready', home = homeFor(reason), lending = home.lending} = {}) => withoutMaskMarkers(renderFixture(Lend, {api:{}, agents, lending, circles, circle:'weekend',
  selected:circles[0], members:[], refresh() {}, setDialog() {}, setCircle() {}, mutate:async () => ({}),
  data:{readiness:{ready:false, checks}, home:{state:'blocked', ...home}, approvals:[], activity:[]}}));
const cardOf = out => {
  const card = /<article class="setup-current"[^]*?<\/article>/.exec(out)?.[0];
  assert.ok(card, 'Setup shows one current step');
  return renderedText(card.replace(/<h2[^]*?<\/h2>/, '')).replace(/ Borrow instead — Send a job$/, '');
};
const lendHero = out => renderedText(out).replace(/ Agents you lend.*$/, '');

// The same phrases are never allowed on any blocker screen: they are contradictory, wrong for Linux, or send the person
// to the screen they are on.
const NEVER = [/fixes this by itself/i, /try again from (Lending|Setup)/i, /open Docker Sandboxes/i, /Check Docker\b/i, /(?<![Rr]e)Start Docker Sandboxes/i,
  /\b(verdict|receipt|attempt|settled|lease|\x73parekin)\b/i, /checks below/i];
const clean = (text, label) => { for (const rule of NEVER) assert.doesNotMatch(text, rule, label + ': ' + rule); };
// A person already in Setup or Lending is never sent there.
const noSelfLink = (out, route) => assert.doesNotMatch(out, route === 'setup' ? /href="#\/setup"/ : /href="#\/lend"/, 'no link to the current screen');
const buttons = out => [...out.matchAll(/<(?:button|a)\b[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([^]*?)<\/(?:button|a)>/g)].map(match => renderedText(match[1]));

test('sandbox service not running and Faravan is starting it: one true message, no button, no manual step', () => {
  const checks = swap('sbx_daemon', {ok:false, label:'The sandbox service is not running yet.', remedy:''});
  const out = setup(checks), card = cardOf(out);
  assert.equal(card, 'The sandbox service isn’t running. Faravan is starting it.');
  assert.equal(buttons(/class="setup-current"[^]*?<\/article>/.exec(out)[0]).filter(label => label === 'Check again').length, 0, 'nothing for the person to press');
  assert.doesNotMatch(renderedText(out), /Fix the step that needs you/, 'no step needs the person, so the lead must not say so');
  assert.match(renderedText(out), /Lending can’t start here Your lending choice is saved\. Faravan is getting this computer ready\./);
  noSelfLink(out, 'setup');
  clean(renderedText(out), 'setup');
  const page = lend(checks);
  assert.match(renderedText(page), /Docker Sandboxes[^.]*The sandbox service isn’t running\. Faravan is starting it\./);
  assert.doesNotMatch(renderedText(page), /Docker Sandboxes · Needs you/);
  assert.equal(buttons(page).filter(label => /Start|Check again|Install/.test(label)).length, 0, 'no start button for a service the app starts');
  noSelfLink(page, 'lend'); clean(renderedText(page), 'lend');
});

test('sandbox service cannot be confirmed: says so once and offers Check again', () => {
  for (const extra of [{unknown:true}, {unknown:true, automatic:true}]) {
    const checks = swap('sbx_daemon', {ok:false, label:'The sandbox service could not be verified.', remedy:'Choose Check again.', ...extra});
    const out = setup(checks), card = cardOf(out);
    assert.match(card, /^Faravan can’t confirm the sandbox service is running\. Check again$/);
    assert.deepEqual(buttons(/class="setup-current"[^]*?<\/article>/.exec(out)[0]).filter(label => /Check/.test(label)), ['Check again']);
    clean(renderedText(out), 'setup');
    const page = lend(checks);
    assert.match(lendHero(page), /Check again What lending needs, in order Docker Sandboxes · Needs you Faravan can’t confirm the sandbox service is running\./);
    noSelfLink(page, 'lend'); clean(renderedText(page), 'lend');
  }
});

test('sandbox service failed to start: names the cause and the Settings path', () => {
  const checks = swap('sbx_daemon', {ok:false, repair:'support', automatic:false, label:'Docker Sandboxes could not start the sandbox service. Open Settings to save a support report.', remedy:'Open Settings'});
  const out = setup(checks), card = cardOf(out);
  assert.match(card, /^Docker Sandboxes could not start the sandbox service\. Open Settings to save a support report\. Open Settings Check again$/);
  assert.match(out, /href="#\/settings\/data"[^>]*>Open Settings</);
  const page = lend(checks);
  assert.match(page, /href="#\/settings\/data"[^>]*>Open Settings</);
  clean(renderedText(out), 'setup'); clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('sandbox service needs a terminal step only the owner can run: the command is shown once', () => {
  const checks = swap('sbx_daemon', {ok:false, repair:'owner_repair', automatic:false, label:'The sandbox service belongs to another account.', remedy:'faravan sandbox repair-owner --yes'});
  const out = setup(checks), card = cardOf(out);
  assert.equal((card.match(/faravan sandbox repair-owner --yes/g) ?? []).length, 1);
  assert.match(card, /^The sandbox service belongs to another account\./);
  const page = lend(checks);
  assert.equal((renderedText(page).match(/faravan sandbox repair-owner --yes/g) ?? []).length, 1);
  clean(renderedText(out), 'setup'); clean(renderedText(page), 'lend');
});

test('sandbox service needs a restart: one restart button, no start instruction', () => {
  const checks = swap('sbx_daemon', {ok:false, cause:'daemon_restart_required', automatic:false, label:'Docker Sandboxes needs to restart to finish its update.', remedy:'Restart Docker Sandboxes'});
  const out = setup(checks), card = cardOf(out);
  assert.match(card, /^Docker Sandboxes needs to restart to finish its update\. Restart Docker Sandboxes Check again$/);
  clean(renderedText(out), 'setup');
  const page = lend(checks);
  assert.equal(buttons(page).filter(label => label === 'Restart Docker Sandboxes').length, 1);
  clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('Docker Sandboxes not installed: one install flow on Setup, one Install button on Lending', () => {
  const checks = swap('sbx_install', {ok:false, label:'Not installed.', remedy:'Install Docker Sandboxes.'});
  const out = setup(checks), card = cardOf(out);
  assert.match(card, /^Not installed\. On the computer running Faravan, open a terminal and run this command/);
  assert.equal(buttons(/class="setup-current"[^]*?<\/article>/.exec(out)[0]).filter(label => label === 'Check again').length, 1);
  clean(renderedText(out), 'setup'); noSelfLink(out, 'setup');
  const page = lend(checks);
  assert.deepEqual(buttons(page).filter(label => /Install/.test(label)), ['Install Docker Sandboxes']);
  assert.match(page, /href="#\/setup"[^>]*>Install Docker Sandboxes</, 'the install steps are on Setup, not on this page');
  clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('Docker signed out: one Sign in control, nothing sends the person back to Setup', () => {
  const checks = swap('docker_login', {ok:false, label:'The sandbox service isn’t signed in to Docker yet.', remedy:'Choose Sign in to Docker.'});
  const out = setup(checks);
  assert.match(cardOf(out), /^Not signed in\. Docker Sandboxes needs a free Docker account/);
  assert.equal(buttons(/class="setup-current"[^]*?<\/article>/.exec(out)[0]).filter(label => label === 'Sign in to Docker').length, 1);
  noSelfLink(out, 'setup'); clean(renderedText(out), 'setup');
  const page = lend(checks);
  assert.match(lendHero(page), /Docker sign-in · Needs you Not signed in\./);
  assert.ok(buttons(page).includes('Sign in to Docker'));
  clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('network rules wait for the Docker sign-in: a waiting row with no action of its own', () => {
  const checks = [ok('sbx_install'), ok('sbx_daemon'), {name:'docker_login', ok:false, label:'x', remedy:'Choose Sign in to Docker.'},
    {name:'network_policy', ok:false, automatic:true, waitsFor:'docker_login', label:'Waits for the Docker sign-in.', remedy:'Waits for the Docker sign-in.'}];
  const page = lend(checks);
  assert.match(lendHero(page), /Sandbox network rules · Waiting Faravan sets up the network rules after Docker sign-in\./);
  assert.equal(buttons(page).filter(label => /network/i.test(label)).length, 0);
  clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
  const out = setup(checks);
  assert.match(cardOf(out), /^Not signed in\./, 'the one thing to do is the Docker sign-in');
  clean(renderedText(out), 'setup');
});

test('network rules need a retry: exactly one Retry network setup instruction', () => {
  const checks = [...BASE, {name:'network_policy', ok:false, label:'The sandbox network policy could not be verified.', remedy:'Retry network setup'}];
  const out = setup(checks), card = cardOf(out);
  assert.equal((card.match(/Retry network setup/g) ?? []).length, 1, card);
  const page = lend(checks);
  assert.equal(buttons(page).filter(label => label === 'Retry network setup').length >= 1, true);
  clean(renderedText(out), 'setup'); clean(renderedText(page), 'lend'); noSelfLink(page, 'lend'); noSelfLink(out, 'setup');
});

test('a requirement whose remedy is a sentence shows it once and offers Check again, never a link to the page it is on', () => {
  const checks = [...BASE, {name:'sbx_version', ok:false, label:'Update Docker Sandboxes', remedy:'Update Docker Sandboxes to 0.49.1 or newer.'}];
  const out = setup(checks), card = cardOf(out);
  assert.equal((card.match(/Update Docker Sandboxes to 0\.49\.1 or newer\./g) ?? []).length, 1, card);
  assert.doesNotMatch(/class="setup-current"[^]*?<\/article>/.exec(out)[0], /href="#\/setup"/);
  const page = lend(checks);
  assert.equal((renderedText(page).match(/Update Docker Sandboxes to 0\.49\.1 or newer\./g) ?? []).length, 1);
  assert.ok(!buttons(page).some(label => /\.$/.test(label)), 'buttons are not sentences: ' + buttons(page));
  clean(renderedText(out), 'setup'); clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('disk low: one explanation and Check again', () => {
  const checks = [...BASE, {name:'host_disk', ok:false, reason:'host_disk_low', label:'This computer is low on disk space.', remedy:'Free at least 8 GiB.'}];
  const out = setup(checks), card = cardOf(out);
  assert.match(card, /^This computer is low on disk space\. Free at least 8 GiB\. Check again$/);
  const page = lend(checks);
  assert.deepEqual(buttons(page).filter(label => label === 'Check again').length >= 1, true);
  clean(renderedText(out), 'setup'); clean(renderedText(page), 'lend'); noSelfLink(page, 'lend');
});

test('no agent chosen: Setup links to Lending, Lending moves to its own list without a link to itself', () => {
  const unchosen = [{id:'codex', useForLending:false, installed:true, signedIn:true, run:{}}];
  const out = setup(BASE, {agents:unchosen, reason:'agent_not_chosen'});
  assert.match(renderedText(out), /Choose an agent in Lending/);
  const page = lend(BASE, {agents:unchosen, reason:'agent_not_chosen'});
  assert.ok(buttons(page).includes('Choose agents'), buttons(page).join('|'));
  noSelfLink(page, 'lend'); clean(renderedText(page), 'lend');
});

test('agent signed out: Lending signs in on the spot; no instruction sends the person to Lending', () => {
  const out = lend(BASE, {agents:[{...lent[0], signedIn:false, signInSupported:true}], reason:'agent_signed_out'});
  assert.match(renderedText(out), /Sign in to Codex|Sign in/);
  noSelfLink(out, 'lend'); clean(renderedText(out), 'lend');
  assert.doesNotMatch(renderedText(out), /Open Lending|Return to Lending/);
});

test('account near its limit: says what is held and why, offers one allowance action, nothing automatic is promised', () => {
  const summary = formatLendingProjection({schemaVersion:2, kind:'lending', intent:'on', admission:'blocked', admissionReason:'quota_reserve', execution:'idle', executionJob:null,
    evidence:{intentState:'ready', dailyLimitReached:false, executionState:'idle'}, version:'fixture'});
  assert.equal(summary.reason, 'Your remaining allowance is being kept for you.');
  assert.equal(summary.remedy, 'View allowance');
  clean(summary.reason, 'quota');
});

test('lending off: one fact and one way back, nothing sends the person to the page they are on', () => {
  const off = withLendingProjection({lending:{enabled:false, circle:'weekend', limits:{}}}, {intent:'off', admission:'blocked', admissionReason:'off', intentState:null});
  const page = lend(BASE, {home:off, lending:off.lending});
  assert.match(renderedText(page), /Lending is off No new jobs start on this computer\./);
  noSelfLink(page, 'lend'); clean(renderedText(page), 'lend');
});

test('a blocked state the app cannot name says so and points at the one place that explains it', () => {
  for (const reason of ['some_new_reason', 'lending_not_started']) {
    const summary = formatLendingProjection({schemaVersion:2, kind:'lending', intent:'on', admission:'blocked', admissionReason:reason, execution:'idle', executionJob:null,
      evidence:{intentState:'ready', dailyLimitReached:false, executionState:'idle'}, version:'fixture'});
    clean(summary.reason, reason);
    assert.doesNotMatch(summary.reason, /below/, 'the summary appears on screens with no list below it');
  }
  const summary = formatLendingProjection({schemaVersion:2, kind:'lending', intent:'on', admission:'blocked', admissionReason:'some_new_reason', execution:'idle', executionJob:null,
    evidence:{intentState:'ready', dailyLimitReached:false, executionState:'idle'}, version:'fixture'});
  assert.equal(summary.reason, 'Lending on this computer waits for the blocked step. You can still send jobs to another lender.');
});

// Docker sign-in in progress and every sign-in error: the inline panel has its own Start sign-in again button, so its
// copy never sends the person to Lending or Setup, and never tells them to check software this app starts itself.
test('sign-in in progress: one instruction, with the buttons that exist', () => {
  const waiting = signInView({status:'awaiting_browser', url:'https://login.example.test/x', code:'AB-12'});
  assert.equal(waiting.heading, 'Finish sign-in in your browser. Faravan notices when you’re done.');
  assert.deepEqual(waiting.actions, ['open', 'cancel']);
  const starting = signInView({status:'starting', stage:'backend_health'});
  assert.equal(starting.heading, 'Preparing sign-in…');
  assert.deepEqual(starting.actions, ['cancel']);
});

const STAGES = ['backend_health', 'identity_drain', 'adapter_resolution', 'docker_guard', 'capabilities', 'sandbox_prepare', 'provider_url'];
const REASONS = ['startup_failed', 'wall_timeout', 'sandbox_not_ready', 'sandbox_start_failed', 'sandbox_ready_timeout', 'sandbox_credential_store_failed',
  'policy_unenforceable', 'host_disk_low', 'storage_unenforceable', 'signin_timeout'];
const REASON_ONLY = ['credential_mutation_busy', 'credential_scope_unenforceable', 'completion_failed', 'guest_not_authenticated', 'completion_timeout'];
const AGAIN = /(hoose Start sign-in again\.|Save support archive in Settings → Data and send it to support\.)$/;
const flows = [];
for (const stage of STAGES) for (const reasonCode of REASONS) for (const status of ['failed', 'timed_out']) flows.push({status, stage, reasonCode, target:'codex'});
for (const reasonCode of REASON_ONLY) flows.push({status:'failed', reasonCode, target:'codex'});
flows.push({status:'timed_out', target:'codex'}, {status:'failed', target:'codex'}, {status:'failed', reasonCode:'credential_scope_unenforceable', condition:'other_sandbox_lease',
  message:'Another background check holds the credential lock. Wait a moment, then choose Start sign-in again.', target:'codex'});

test('every inline sign-in failure names its cause and one existing next step', () => {
  const seen = new Set();
  for (const flow of flows) {
    const view = signInView(flow, ''), label = JSON.stringify(flow);
    assert.deepEqual(view.actions, ['retry'], label);
    clean(view.body, label);
    assert.doesNotMatch(view.body, /from Lending|Return to Lending|Contact support|Check available disk/, label);
    if (flow.status === 'failed' && flow.stage || flow.status === 'timed_out' && flow.stage || flow.reasonCode) assert.match(view.body, AGAIN, label + ' -> ' + view.body);
    assert.equal((view.body.match(/\b(Choose|Wait|Free|Save)\b/g) ?? []).length <= 2, true, 'at most one wait-then-act step: ' + view.body);
    seen.add(view.body);
  }
  assert.ok(seen.size > 15, 'distinct causes are not collapsed: ' + seen.size);
});

test('the sign-in page that opens in its own tab still says where to go back to, and the Docker one says Setup', () => {
  for (const flow of flows) {
    for (const target of ['codex', 'docker']) {
      const view = progressView({target, flow:{...flow, target}});
      clean(view.status, JSON.stringify(flow));
      assert.doesNotMatch(view.status, /Check Docker|Contact support/);
      assert.ok(view.recovery.name === (target === 'docker' ? 'Setup' : 'Lending'));
    }
  }
});
