import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {onboardingVM, FIRST_TASKS} from './onboarding.mjs';
import {setupVM} from './view-models.mjs';
const storedPass = {id:'test-run',state:'passed',at:'2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',
  configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
import {Setup, LendingChecks} from './setup.jsx';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

test('setup_unknown_intent_does_not_assert_lending_off', () => {
  for (const ready of [false, true]) {
    const readiness = {ready, checks: ready ? checks : dockerOut};
    const base = props(readiness);
    const home = withLendingProjection(base.data.home, {intent:'unknown', execution:'idle'});
    const out = renderFixture(Setup, {...base, data:{...base.data, home}});
    assert.match(out, /<h1[^>]*>Lending status unavailable<\/h1>/);
    assert.ok(renderedText(out).includes("Faravan can't confirm whether lending is on. Do not rely on lending being off until this computer’s status loads again."));
    assert.doesNotMatch(renderedText(out), /No friends’ jobs run until you turn lending on/);
    const off = withLendingProjection(base.data.home, {intent:'off', execution:'idle', admission:'blocked', admissionReason:'off', intentState:null});
    assert.match(renderedText(renderFixture(Setup, {...base, data:{...base.data, home:off}})), /No friends’ jobs run until you turn lending on/);
  }
});

import {OnboardingEntry} from './onboarding.jsx';
import {Connection} from './shared.jsx';
import {h} from 'preact';

// U9 render tests: the setup checklist as a string, no browser.
const circles = [{id:'weekend', origin:'https://circle.test', name:'Weekend projects', enrollment:{state:'approved'}, rosterMembershipVerified:true}];
const agents = [{id:'codex', useForLending:true, installed:true, signedIn:true, run:{}}];
const lendingReady = {agents:[{id:'codex',hasReading:true,checks:[{id:'signed_in',state:'pass'}]}]};
const checks = [{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:true}];
const dockerOut = [{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:false}];
const props = (readiness, extra = {}) => ({
  api:{}, agents, circles, circle:'weekend', mutate: async () => ({}), refresh() {},
  lending:{circle:'weekend', limits:{dailyJobs:3, dailyMinutes:60}},
  data:{readiness, agents, lendingReadiness:lendingReady, home:{lending:{limits:{dailyJobs:3, dailyMinutes:60}}}, devices:{name:'Ana’s MacBook Pro'}}, ...extra,
});
const page = (readiness, extra) => renderFixture(Setup, props(readiness, extra));


test('phone_raw_repair_command_remains_available', () => {
  const readiness={ready:false,checks:[...checks,{name:'kvm_access',ok:false,remedy:'sudo usermod -aG kvm $USER && newgrp kvm'}]};
  const out=page(readiness,{phone:true});
  assert.match(renderedText(out),/sudo usermod -aG kvm \$USER && newgrp kvm/);
  assert.match(out,/aria-label="Copy command"/);
  assert.match(renderedText(out),/Copy this command and run it in a terminal on the computer running Faravan\./);
});

test('unknown_nonconversion_check_shows_explanation_and_fix', () => {
  for(const state of ['unknown','pending']) {
    const out=renderFixture(LendingChecks,{agent:{hasReading:true,checks:[
      {id:'account',state,line:'Account could not be confirmed.',fix:'Refresh the account.'},
      {id:'job_control',state},
    ]}});
    assert.match(renderedText(out),/Account could not be confirmed\. Refresh the account\./);
    assert.match(renderedText(out),/Not confirmed\. Check lending again, or open Lending for details\./);
  }
});

test('inconclusive_existing_reading_is_not_labelled_unchecked', () => {
  const readiness={ready:true,checks};
  for(const hasReading of [true,false]) {
    const data={...props(readiness).data,lendingReadiness:{agents:[{id:'codex',hasReading,checks:[{id:'account',state:'unknown'}]}]}};
    const out=page(readiness,{data});
    const row=out.match(/<li[^>]*data-blocker="agent:codex"[^>]*>(.*?)<\/li>/s)?.[0];
    assert.ok(row);
    assert.doesNotMatch(row,/>Done<|>Ready</);
    if(hasReading) {
      assert.match(row,/>Not confirmed</);
      assert.doesNotMatch(row,/Not checked yet|Waiting for the first reading/);
    } else {
      assert.match(row,/>Not checked yet</);
      assert.match(row,/Lending checks are not confirmed\. Check again or open Lending for the recovery steps\./);
      assert.match(out,/>Check lending again</);
      assert.match(out,/href="#\/lend"[^>]*>Open Lending/);
    }
  }
});

test('setup_retry_and_limits_actions_name_their_targets: limits', () => {
  const out=page({ready:true,checks});
  assert.match(out,/href="#\/lend\/limits"[^>]*>Review lending limits →</);
  assert.doesNotMatch(out,/>Change these</);
});

test('every step done: redesigned ready headline, checks in order, an active turn-on button', () => {
  const out = page({ready:true, checks});
  assertDomOrder(out, ['Your computer is ready', 'data-blocker="docker_installed"', 'data-blocker="docker_signin"', 'data-blocker="agent:codex"', 'Last step']);
  assert.match(out, /class="btn btn-primary btn-block"/);
  assert.match(renderedText(out), /This computer is ready to lend with Codex\. Review your settings, then turn on lending\./);
  assert.doesNotMatch(renderedText(out), /Lending stays on until you turn it off\./);
  assert.doesNotMatch(out, /aria-disabled="true"/);
  assertNoBannedWords(out);
});

test('F3 stopped Docker never launches an unverified host and keeps manual verification', () => {
  const stopped=[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false},{name:'docker_login',ok:false}];
  for (const phone of [false, true]) {
    const out=page({ready:false,checks:stopped},{phone});
    assertDomOrder(out,['class="setup-current"','id="setup-check-details"','class="setup-send-job btn btn-secondary"']);
    assert.doesNotMatch(out,/docker-desktop:|Checking automatically/);
    assert.match(renderedText(out),/Docker Sandboxes isn’t ready\./);
    assert.doesNotMatch(renderedText(out),/open Docker Sandboxes/);
    assert.match(out,/>Check again</);
  }
});

test('a step that needs you disables the button and says when it opens', () => {
  const out = page({ready:false, checks:dockerOut});
  assert.doesNotMatch(out, /aria-disabled="true"/);
  assert.match(renderedText(out), /Finish the steps that need you to turn lending on\./);
  assert.match(renderedText(out), /Docker Sandboxes needs a free Docker account/);
  assert.match(withoutMaskMarkers(out), /class="signin"/, 'the Docker sign-in control sits in the row');
});

test('Setup content has one title and no nested main or redundant app link', () => {
  const out = page({ready:true, checks});
  assert.equal((out.match(/<h1/g) || []).length, 1);
  assert.doesNotMatch(out, /class="sidebar"|class="tabbar"/);
  assert.doesNotMatch(out, /Open Faravan|<main/);
});

test('each state is a word for screen readers, not only a colour', () => {
  const text = renderedText(page({ready:false, checks:[{name:'sbx_install', ok:false, label:'Not installed.'}, {name:'docker_login', ok:true}]}));
  assert.match(text, /Docker Sandboxes Needs you/);
  assert.doesNotMatch(text, /Sandbox safety test/);
});

test('an unconfirmed Docker sign-in is one row with a real Check again and no sign-in card', () => {
  const unconfirmed = {ready:true, checks:[{name:'sbx_install', ok:true}, {name:'docker_runtime', ok:true}, {name:'docker_login', ok:true, signinVerified:false}]};
  const out = withHome({}, unconfirmed);
  const text = renderedText(out);
  assert.match(text, /Faravan could not confirm the Docker sign-in\./);
  assert.match(text, /Check again/);
  assert.doesNotMatch(text, /Signed in/);
  assert.doesNotMatch(out, /class="signin/, 'no sign-in card beside an unconfirmed row');
  assert.doesNotMatch(text, /Not checked yet\. Run a quick check/);
});

// U20: the failure and platform states.
const withHome = (home, readiness = {ready:true, checks}) => page(readiness, {data:{readiness, agents, home:{lending:{},...home}, devices:{name:'Ana’s MacBook Pro'}}});

test('Docker account: sign-in control, a link to create an account, and Check again', () => {
  const out = withHome({}, {ready:false, checks:dockerOut});
  assertDomOrder(withoutMaskMarkers(out), ['class="signin"', '>Create a Docker account<', '>Check again<']);
  const link = out.match(/<a [^>]*href="https:\/\/hub\.docker\.com\/signup"[^>]*>/)[0];
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
});

test('Linux kvm: the command is shown with a named copy button', () => {
  const out = withHome({}, {ready:false, checks:[{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'kvm_access', ok:false, remedy:'sudo usermod -aG kvm $USER && newgrp kvm'}, {name:'docker_login', ok:true}]});
  assert.match(renderedText(out), /\$ sudo usermod -aG kvm \$USER/);
  assert.match(renderedText(out), /&& newgrp kvm/);
  assert.match(out, /aria-label="Copy command"/);
  assert.match(renderedText(out), /Run this, then log out and back in\./);
});

test('a failed limits check names the blocker and the recovery action', () => {
 const out=page({ready:false,checks:[...checks,{name:'v1_limits',ok:false,label:'Job limits could not be enforced.',remedy:'Check Docker Sandboxes and try again.'}]});
 assert.match(renderedText(out),/Job limits could not be enforced/);
 assert.doesNotMatch(renderedText(out),/Run the test/);
});

test('a missing agent shows how to install it', () => {
  const out = page({ready:true, checks}, {agents:[{id:'codex', useForLending:true, installed:false}], data:{readiness:{ready:true, checks}, agents:[{id:'codex', installed:false}], home:{lending:{}}}});
  const text = renderedText(out);
  assert.match(text, /Codex Needs you/);
  assert.match(text, /Not installed\./);
  assert.match(out, /<summary>How to install Codex<\/summary>/);
});

test('an unsupported computer gets the reason and Send a job, no checklist', () => {
  const out = withHome({desktop:{platform:'macos', lendable:false}});
  assert.match(renderedText(out), /This Mac can’t lend/);
  assert.match(out, /href="#\/jobs\/new"[^>]*>Send a job</);
  assert.match(withoutMaskMarkers(out), /<code>faravan apply<\/code>/);
  assert.doesNotMatch(out, /data-blocker=/);
});

test('Windows cannot enter a pin or lending checklist in the MVP', () => {
  const out = withHome({desktop:{platform:'windows', pinPrompt:true, pinSettingsUri:'ms-settings:taskbar'}});
  assert.match(renderedText(out), /This computer can’t lend/);
  assert.doesNotMatch(out, /taskbar|Hypervisor|data-blocker=/);
});

// A tester, live, right after their Docker sign-in was reset: three "needs you" rows (one with a shell command, one saying no
// agent was signed in) where one was real.
test('Docker signed out, Codex signed in before: one action, the rest wait for the Docker sign-in, no command text', () => {
  const policy = [...dockerOut.slice(0, 2), {name:'network_policy', ok:false, label:'The sandbox network policy could not be verified.', remedy:'sbx policy init deny-all (or run: faravan doctor --fix-policy)'}, dockerOut[2]];
  const stale = [{id:'claude-code-subscription', useForLending:true, installed:true, signedIn:null, run:{}}, {id:'codex', useForLending:true, installed:true, signedIn:null, signInState:'Check failed', run:{}}];
  const out = page({ready:false, checks:policy}, {agents:stale, data:{readiness:{ready:false, checks:policy}, agents:stale, home:{lending:{}}, devices:{name:'Ana’s MacBook Pro'}}});
  const text = renderedText(out);
  assert.equal((text.match(/Needs you/g) || []).length, 1, 'one row needs you');
  assert.match(text, /Docker sign-in Needs you/);
  assert.equal((text.match(/Waits for the Docker sign-in\./g) || []).length, 2, 'both agents wait');
  assert.equal((withoutMaskMarkers(out).match(/class="signin"/g) || []).length, 1, 'one sign-in control');
  assert.doesNotMatch(text, /sbx |faravan doctor|--fix-policy|No coding agent is signed in|could not be verified/);
  assert.doesNotMatch(withoutMaskMarkers(out), /class="cmd"/, 'no command block');
});

test('lending intent on shows Open Lending, never turn on or a stale joined notice', () => {
  const home=withLendingProjection({lending:{enabled:true,circle:'weekend'},intent:{on:true,state:'blocked',reason:'docker_signed_out'}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});
  const out=page({ready:false,checks:dockerOut},{lending:{enabled:true,circle:'weekend'},data:{...props({ready:false,checks:dockerOut}).data,readiness:{ready:false,checks:dockerOut},agents,home,devices:{name:'Ana’s MacBook Pro'}}});
  assert.match(out, /<h1[^>]*>Lending stopped: sign in to Docker<\/h1>/);
  assert.equal((withoutMaskMarkers(out).match(/class="signin"/g) || []).length, 1, 'hard sign-out keeps exactly one sign-in action');
  assert.doesNotMatch(renderedText(out), /ready to lend|…\./);
  assert.match(renderedText(out),/Lending settings for Weekend projects/);
  assert.match(out,/href="#\/lend"[^>]*>Open Lending</);
  assert.doesNotMatch(renderedText(out),/turn on lending|You joined|Open Faravan/i);
  assert.doesNotMatch(out,/data-blocker="circle"/);
  assert.match(out,/class="setup-current"[^>]*data-blocker="docker_signin"/);
});

test('saved lending on stays incomplete until lending checks arrive', () => {
  const home=withLendingProjection({lending:{enabled:true,circle:'weekend'},intent:{on:true,state:'ready'},lendingPolicy:{accounts:[{provider:'claude',decision:{availability:{admitted:true}}},{provider:'codex',decision:{availability:{admitted:true}}}]}},{intent:'on',intentState:'ready',admission:'allowed'});
  const out=page({ready:true,checks},{lending:{enabled:true,circle:'weekend'},data:{readiness:{ready:true,checks},agents,home,devices:{name:'Ana’s MacBook Pro'}}});
  assert.match(out,/<h1[^>]*>Getting this computer ready to lend<\/h1>/);
  assert.match(renderedText(out),/Lending settings for Weekend projects/);
  assert.match(out,/href="#\/lend"[^>]*>Open Lending</);
  assert.doesNotMatch(renderedText(out),/Turn on lending|You joined|Open Faravan/i);
  assert.doesNotMatch(out,/<button[^>]*class="btn btn-primary btn-block"/, 'the turn-on button is gone');
});








test('Setup shows the MVP agents without API-key or later-adapter rows', () => {
 const all=[...agents,{id:'claude-code-api-key',installed:true,signedIn:true},{id:'gemini',installed:true,signedIn:true}];
 const out=page({ready:true,checks},{agents:all,data:{...props({ready:true,checks}).data,agents:all}});
 assert.doesNotMatch(renderedText(out),/API key|Gemini/);
});


test('lending checks show compact marks and actionable failures', () => {
  const out = renderFixture(LendingChecks, {agent:{hasReading:true,checks:[
    {id:'signed_in',state:'pass',line:'The agent is signed in.',fix:null},
    {id:'subscription',state:'fail',line:'The subscription is unavailable.',fix:'Check billing.'},
    {id:'account',state:'unknown',line:'Account unknown.',fix:'Check again.'},
  ]}});
  assertDomOrder(out, ['Signed in', 'Plan', 'The subscription is unavailable.', 'Check billing.', '<b>Account</b>']);
  assert.match(renderedText(out),/Account unknown\. Check again\./);
});
test('account details remain readable without a first usage reading', () => {
  const check={id:'signed_in',state:'pass',line:'Signed in.',fix:null};
  const pending=renderedText(renderFixture(LendingChecks,{agent:{hasReading:false,checks:[check,{id:'account',state:'unknown'}]}}));
  assert.match(pending,/Not confirmed/);
  assert.doesNotMatch(pending,/Waiting for the first reading/);
  const passed=renderFixture(LendingChecks,{agent:{hasReading:true,checks:[check]}});
  assert.match(passed,/<summary[^>]*>Account details<\/summary>/);
});

test('the agent row cannot say Done or Ready with incomplete lending checks', () => {
  const readiness={ready:true,checks};
  const checksFor=state=>[{id:'signed_in',state:'pass',line:'Signed in.',fix:null},
    {id:'subscription',state,line:'No subscription.',fix:'Check your plan.'}];
  for (const state of ['fail','unknown']) {
    const data={...props(readiness).data,lendingReadiness:{agents:[{id:'codex',hasReading:state==='fail',checks:checksFor(state)}]}};
    const out=page(readiness,{data});
    const row=out.match(/<li[^>]*data-blocker="agent:codex"[^>]*>(.*?)<\/li>/s)?.[0];
    assert.ok(row);
    assert.doesNotMatch(row,/>Done<|>Ready</);
    assert.match(row,state==='fail'?/Check this account/:/>Not checked yet</);
    if (state === 'unknown') {
      assert.match(row,/Lending checks are not confirmed\. Check again or open Lending for the recovery steps\./);
      assert.match(out,/>Check lending again</);
      assert.match(out,/href="#\/lend"[^>]*>Open Lending/);
      assert.doesNotMatch(row,/Waiting for the first reading/);
    }
  }
});

test('setup row titles have no trailing separator', () => {
  const out=page({ready:true,checks});
  assert.doesNotMatch(out,/<h3>[^<]*<\/h3><span aria-hidden="true"> · <\/span>/);
});

test('unknown job control cannot show an all-passing checklist', () => {
  const out=renderFixture(LendingChecks,{agent:{hasReading:true,checks:[
    {id:'signed_in',state:'pass',line:'The agent is signed in.',fix:null},
    {id:'job_control',state:'unknown',line:'Job controls could not be confirmed.',fix:'Check the sandbox setup and try again.'},
  ]}});
  assert.match(out,/Job control/);
  assert.match(out,/aria-label="Not confirmed"/);
  assert.doesNotMatch(out,/All checks passed/);
});

test('stopped Docker keeps its host instructions when restart detail changes', () => {
  const stopped = [{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false},{name:'docker_login',ok:false}];
  for (const detail of ['Restart Docker Sandboxes after the update.', 'The sandbox service is stopped.']) {
    const blocker = {key:'docker_running',label:'Docker Sandboxes',status:'blocked',detail,
      detail_code:'not_running',action:'Restart Docker Sandboxes',headline:'Docker Sandboxes needs to restart'};
    const out = withHome({lending_blockers:{
      items:[blocker],first:blocker,needsYou:[blocker],canLend:false,headline:blocker.headline,
    }}, {ready:false,checks:stopped});
    assert.doesNotMatch(out, /docker-desktop:/);
    assert.match(renderedText(out), new RegExp(detail.replace('.', '\\.')));
    assert.doesNotMatch(renderedText(out), /open Docker Sandboxes/);
    assert.match(out, />Check again</);
  }
});

test('missing or unknown Docker does not get the stopped-Docker shortcut', () => {
  for (const ok of [false, null]) {
    const out = page({ready:false,checks:[{name:'sbx_install',ok}]});
    assert.doesNotMatch(out, /href="docker-desktop:\/\/"/);
  }
});

test('unsupported Mac copy does not invent an Intel processor', () => {
  for (const desktop of [{platform:'macos',lendable:false}, {platform:'mac',lendable:false,arch:'arm64'}]) {
    const text = renderedText(withHome({desktop}));
    assert.match(text, /This Mac can’t lend/);
    assert.match(text, /This Mac does not currently meet the lending requirements\./);
    assert.doesNotMatch(text, /Intel/);
    assert.match(text, /Apple silicon Macs \(M1 or newer\) and Ubuntu 24\.04 or later/);
  }
});

test('fresh Home names question and writing work without changing its actions or suggestions', () => {
  const entry = onboardingVM().entry;
  assert.equal(entry.text, 'Ask a friend’s agent for help with a question, writing, or a coding task, then review what comes back before you use it. Join a circle with an invitation, or start one and invite people.');
  assert.deepEqual(entry.actions.map(action => action.id), ['join','start','lending','example']);
  assert.deepEqual(FIRST_TASKS.map(task => task.label), ['Explain this project','Add tests for one function','Fix a failing test']);
});

test('Setup names the missing circle and keeps Open Circles', () => {
  const vm = setupVM({readiness:{ready:true,checks},agents,status:{lending:{}},circle:null});
  const row = vm.steps.find(step => step.id === 'circle');
  assert.equal(row.detail, 'You haven’t joined or started a circle yet. Open Circles to get started.');
  assert.equal(row.state, 'need');
  assert.deepEqual(row.link, {label:'Open Circles',href:'#/circles'});
});

test('onboarding progress documentation describes its unchanged hiding predicate', async () => {
  const source = await readFile(new URL('./onboarding.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('The progress card is hidden once a result is available or this computer has moved into lending; useful-result tracking remains separate.'));
  assert.ok(source.includes('const progress = useful || lenderOnly || hasResult || lenderWork || !current ? null'));
});

test('F1 fresh entry offers secondary lending without reversing borrowing-first', () => {
  const entry=onboardingVM().entry;
  assert.equal(entry.actions.find(action=>action.id==='join').primary,true);
  assert.deepEqual(entry.actions.find(action=>action.id==='lending'),{id:'lending',label:'Set up lending',href:'#/setup'});
  const out=renderFixture(OnboardingEntry,{entry});
  assert.match(out,/class="btn btn-secondary"[^>]*href="#\/setup"[^>]*>Set up lending</);
});

test('F2 missing Docker offers a primary installation guide without demanding a terminal', () => {
  const out=page({ready:false,checks:[{name:'sbx_install',ok:false}]});
  assert.match(renderedText(out),/Install Docker Sandboxes on the computer running Faravan/);
  assert.match(out,/<h2[^>]*>Prepare Docker Sandboxes for friends’ jobs<\/h2>/);
  assert.match(out,/class="btn btn-primary"[^>]*href="https:\/\/docs.docker.com\/ai\/sandboxes\/install\//);
  assert.match(renderedText(out),/Open Docker installation instructions/);
  assert.doesNotMatch(renderedText(out),/This step needs a terminal/);
  assert.match(out,/>Check again</);
});

test('F2 supplied install command is an explicitly named copy action even on a phone', () => {
  const out=page({ready:false,checks:[{name:'sbx_install',ok:false,remedy:'brew install docker'}]},{phone:true});
  assert.match(renderedText(out),/On the computer running Faravan, open a terminal and run this command/);
  assert.match(out,/aria-label="Copy install command"/);
  assert.match(renderedText(out),/brew install docker/);
});

test('F3 offline or stale setup does not promise automatic confirmation', () => {
  const readiness={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false}]};
  for (const connection of [{offline:true,stale:false},{offline:false,stale:true}]) {
    const Wrapped=()=>h(Connection.Provider,{value:connection},h(Setup,props(readiness,{automaticRefreshActive:true})));
    const out=renderFixture(Wrapped,{});
    assert.match(renderedText(out),/Faravan can’t confirm changes until this page reconnects/);
    assert.doesNotMatch(out,/checks again automatically|Checking automatically/);
  }
});

test('F3 automatic-refresh copy requires an explicit active signal and connection', () => {
  const readiness={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false}]};
  const out=page(readiness,{automaticRefreshActive:true});
  assert.match(renderedText(out),/Faravan checks again automatically while this page is connected/);
});

test('F6 requires saved agent consent and confirmed lending evidence before the switch', () => {
  const readiness={ready:true,checks};
  for (const selected of [true,false]) {
    const chosen=[{...agents[0],useForLending:selected}];
    const data={...props(readiness).data,agents:chosen,lendingReadiness:selected?null:lendingReady};
    const out=page(readiness,{agents:chosen,data});
    assert.doesNotMatch(out,/class="btn btn-primary btn-block"/);
    assert.doesNotMatch(renderedText(out),/Everything passed|Your computer is ready/);
    assert.match(renderedText(out),selected?/Checking whether this computer can lend/:/No agent is chosen to lend/);
  }
});

test('F6 one confirmed selected agent satisfies required checks while another is optional', () => {
  const readiness={ready:true,checks};
  const chosen=[...agents,{id:'claude-code-subscription',useForLending:true,installed:true,signedIn:null,signInState:'Check failed'}];
  const data={...props(readiness).data,agents:chosen,lendingReadiness:lendingReady};
  const out=page(readiness,{agents:chosen,data});
  assert.match(renderedText(out),/This computer is ready to lend with Codex/);
  assert.match(renderedText(out),/4 of 4 required checks complete/);
  assert.match(renderedText(out),/Claude Code: Open Lending to finish its checks/);
  assert.match(renderedText(out),/Claude Code · Optional/);
  assert.match(out,/class="btn btn-primary btn-block"/);
});

test('F6 a failed readiness fetch invalidates even a previously passing snapshot', () => {
  const vm=setupVM({readiness:{ready:true,checks},agents,status:{lending:{}},
    circle:circles[0],lendingReadiness:lendingReady,lendingReadinessError:true});
  assert.equal(vm.ready,false);
  assert.equal(vm.readinessNote,'Couldn’t confirm lending checks. Try again.');
  assert.equal(vm.done,3);
  assert.equal(vm.required,4);
  assert.equal(vm.steps.find(step=>step.id==='agent:codex').confirmed,false);
});

test('known required prerequisites stay actionable while lending evidence loads', () => {
  const vm=setupVM({readiness:{ready:false,checks:[{name:'sbx_install',ok:false}]},
    agents,status:{lending:{}},circle:circles[0]});
  assert.equal(vm.lead,'One step needs you.');
  assert.equal(vm.ready,false);
  assert.equal(vm.readinessNote,'');
  assert.equal(vm.steps.find(step=>step.primary).id,'sandboxes');
});

test('Review F2 online stopped Docker offers manual verification without a reconnect claim', () => {
  const readiness={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false}]};
  const Wrapped=()=>h(Connection.Provider,{value:{offline:false,stale:false}},h(Setup,props(readiness,{automaticRefreshActive:false})));
  const out=renderFixture(Wrapped,{});
  assert.doesNotMatch(renderedText(out),/until this page reconnects/);
  assert.match(out,/>Check again</);
});

test('Review F3 Linux stopped Docker preserves the supplied remedy and restart recovery', () => {
  for(const cause of [undefined,'daemon_restart_required']) {
    const remedy='Use the verified host service recovery instructions.';
    const readiness={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false,cause,remedy,...(cause?{automatic:false}:{})},{name:'docker_login',ok:true}]};
    const data={...props(readiness).data,home:{...props(readiness).data.home,desktop:{platform:'linux'}}};
    const out=page(readiness,{data});
    assert.match(renderedText(out),/Use the verified host service recovery instructions/);
    assert.doesNotMatch(renderedText(out),/from Applications/);
    assert.match(out,/>Check again</);
    if(cause) assert.match(out,/>Restart Docker Sandboxes</);
  }
});

test('Review F4 pending and unconfirmed membership do not ask the owner to join again', () => {
  for(const state of ['pending','rejected','expired']) {
    const waitingCircle={...circles[0],rosterMembershipVerified:false,enrollment:{state}};
    const vm=setupVM({readiness:{ready:true,checks},agents,status:{lending:{}},
      circle:waitingCircle,lendingReadiness:lendingReady});
    const row=vm.steps.find(s=>s.id==='circle');
    assert.equal(row.state,'need');
    assert.doesNotMatch(row.detail,/Join a circle to lend/);
    assert.equal(row.link.href,'#/circles');
    if(state==='pending') assert.match(row.detail,/waiting|approv|turn/i);
  }
});

test('Review F5 unsupported Apple silicon or unknown Mac never invents Intel', () => {
  for(const desktop of [{platform:'mac',lendable:false,arch:'arm64'},{platform:'macos',lendable:false}]) {
    const vm=setupVM({status:{desktop}});
    assert.equal(vm.kind,'unsupported');
    assert.doesNotMatch(vm.lead,/Intel/);
    assert.match(vm.lead,/does not currently meet the lending requirements/);
    assert.equal(vm.card.action.href,'#/circles'); // no circle yet: Circles before Send a job
  }
});

test('Setup details route opens both disclosures while normal Setup stays collapsed', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    // Initial deep link, ordinary Setup, then route navigation back to details.
    for (const hash of ['#/setup/details', '#/setup', '#/setup/details']) {
      Object.defineProperty(globalThis, 'location', {configurable:true, value:{hash, search:''}});
      const out = withHome({}, {ready:false,checks:[...checks,{name:'v1_limits',ok:false,label:'Safety check needs attention.'}]});
      for (const id of ['setup-check-details', 'setup-safety-details']) {
        const tag = out.match(new RegExp('<details[^>]*id="' + id + '"[^>]*>'))?.[0];
        assert.ok(tag, id + ' is rendered');
        if (hash === '#/setup/details') assert.match(tag, /\sopen(?:[\s=>])/, id + ' opens for details');
        else assert.doesNotMatch(tag, /\sopen(?:[\s=>])/, id + ' keeps the collapsed default');
      }
      assert.match(out, /<summary>Details<\/summary>/);
      assert.doesNotMatch(out, />Run the test</);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else delete globalThis.location;
  }
});

// Teammate-journey regressions stay in this allow-listed render test file.
import {ComposeBody} from './compose.jsx';
import {AppliedCard} from './job-view.jsx';
import {EditorLinks} from './result-actions.jsx';

test('missing agent consent points directly to the Lending selection', () => {
  const readiness={ready:true,checks}, chosen=[{...agents[0],useForLending:false}];
  const out=page(readiness,{agents:chosen,data:{...props(readiness).data,agents:chosen}});
  assert.match(out,/href="#\/lend"[^>]*>Choose an agent in Lending</);
});

test('terminal and Docker blockers offer borrowing inside the current step', () => {
  for (const readiness of [
    {ready:false,checks:[{name:'sbx_install',ok:false}]},
    {ready:false,checks:[...checks,{name:'kvm_access',ok:false,remedy:'sudo usermod -aG kvm $USER'}]},
  ]) {
    const out=page(readiness);
    const current=out.match(/<article class="setup-current"[\s\S]*?<\/article>/)?.[0];
    assert.ok(current);
    assert.match(current,/href="#\/new"[^>]*>Borrow instead — Send a job</);
  }
});

test('post-agent check help names returned source and fresh dependencies', () => {
  const out=renderFixture(ComposeBody,{vm:{state:'compose.empty',send:{label:'Send job',disabled:true}},draft:{sourceKind:'folder',prompt:'',path:''}});
  assert.match(renderedText(out),/Runs on the returned source in a fresh sandbox; include dependency installation if needed\./);
  assert.match(renderedText(out),/Leave it blank to skip the check/);
});

test('added branch keeps switch command and adds review checklist and safe editor links', () => {
  const applied={branch:'faravan/result',repo:'/home/sam/project'};
  const out=renderFixture(AppliedCard,{applied}), text=renderedText(out);
  assert.match(text,/git switch/);
  assert.match(text,/opening the editor does not switch branches/);
  assert.match(text,/Review the changes, including tests and configuration/);
  assert.match(text,/Run your own tests in a disposable environment before merging/);
  const links=renderFixture(EditorLinks,{repo:applied.repo});
  assert.ok(links.length>0);
  assert.ok(out.includes(links),'reuse the existing safe link mapping, not a guessed editor URL');
  const absent=renderFixture(AppliedCard,{applied:{branch:applied.branch}});
  assert.doesNotMatch(absent,/class="result-editor/);
});

test('Setup names the same proxy-ready agents as Lending',()=>{
 const chosen=[...agents,{id:'claude-code-subscription',installed:true,useForLending:true,signedIn:false,proxySignedIn:true,lendingSignInTarget:'claude-code-subscription-lending',lendingSignInSupported:true}];
 const readiness={ready:true,checks};
 const data={...props(readiness).data,agents:chosen,lendingReadiness:{agents:[...lendingReady.agents,{id:'claude-code-subscription',checks:[{id:'signed_in',state:'pass'}]}]}};
 const out=page(readiness,{agents:chosen,data});
 assert.match(renderedText(out),/ready to lend with Claude Code and Codex|ready to lend with Codex and Claude Code/);
 assert.doesNotMatch(renderedText(out),/Other agents aren’t ready/);
 assert.match(out,/class="setup-send-job btn btn-secondary" href="#\/jobs\/new"/);
});

test('a Setup blocker that carries a Claude sign-in action renders without throwing', () => {
  const claude = {id:'claude-code-subscription', useForLending:true, installed:true, signedIn:false, signInSupported:false, run:{}};
  const blocker = {key:'readiness_requirement', agent:claude.id, label:'Claude', status:'blocked',
    detail:'Signed out.', detail_code:'signed_out', action:'Sign in to Claude',
    headline:'Claude needs you to sign in'};
  const readiness = {ready:false, checks};
  const home = {lending:{}, lending_blockers:{items:[blocker], first:blocker, needsYou:[blocker], canLend:false, headline:blocker.headline}};
  const out = page(readiness, {agents:[claude], data:{readiness, agents:[claude], home, devices:{name:'Ana’s MacBook Pro'}}});
  assert.match(out, /<article class="setup-current" data-blocker="agent:claude-code-subscription"/);
});

test('a missing usage reading shows an estimate note without a qualification prompt',()=>{
  const out=renderFixture(LendingChecks,{agent:{hasReading:false,checks:[
    {id:'signed_in',state:'pass',line:'Signed in.',fix:null},
    {id:'usage_estimate',state:'pass',note:'No aggregate reading is available. Lending uses the starting estimate.'},
  ]}});
  assert.match(renderedText(out),/No aggregate reading is available/);
  assert.doesNotMatch(out,/Waiting for the first reading|All checks passed/);
});

import {dockerInstallVM} from './setup-install.mjs';

test('Docker install anchors require an own primitive platform name', () => {
  const cases = [
    ['mac', 'https://docs.docker.com/ai/sandboxes/install/#install-on-macos'],
    ['macos', 'https://docs.docker.com/ai/sandboxes/install/#install-on-macos'],
    ['windows', 'https://docs.docker.com/ai/sandboxes/install/#install-on-windows'],
    ['linux', 'https://docs.docker.com/ai/sandboxes/install/#install-on-ubuntu'],
    ...['toString', '__proto__', 'constructor', 'hasOwnProperty', 'unknown', '', 'darwin',
      undefined, null, 7, {toString() {throw new Error('must not coerce platform');}}]
      .map(platform => [platform, 'https://docs.docker.com/ai/sandboxes/install/']),
  ];
  for (const [platform, expected] of cases) {
    const input = Object.freeze({platform, remedy: '  brew install docker  '});
    const vm = dockerInstallVM(input);
    assert.equal(vm.link.href, expected);
    assert.equal(typeof vm.link.href, 'string');
    assert.doesNotMatch(vm.link.href, /function|native code|\[object/);
    assert.equal(vm.command, 'brew install docker');
    assert.equal(vm.terminal, 'On the computer running Faravan, open a terminal and run this command to install Docker Sandboxes.');
    assert.equal(vm.explain, 'Installs Docker Sandboxes, the tool Faravan uses to run jobs in a sandbox.');
    assert.equal(vm.phone, 'Do this on the computer, not on this device.');
    assert.equal(vm.after, 'Return here after installation. Faravan will check again while this page is connected.');
    assert.equal(vm.link.label, 'Open Docker installation instructions');
    assert.equal(input.platform, platform);
  }
  assert.equal(dockerInstallVM().link.href, 'https://docs.docker.com/ai/sandboxes/install/');
  assert.equal(dockerInstallVM().command, '');
  assert.equal(dockerInstallVM().terminal, 'Install Docker Sandboxes on the computer running Faravan.');
});

test('Setup renders literal Docker guide anchors and preserves Windows unsupported policy', () => {
  const readiness = {ready:false, checks:[{name:'sbx_install',ok:false}]};
  const cases = [
    ['mac', 'https://docs.docker.com/ai/sandboxes/install/#install-on-macos'],
    ['macos', 'https://docs.docker.com/ai/sandboxes/install/#install-on-macos'],
    ['linux', 'https://docs.docker.com/ai/sandboxes/install/#install-on-ubuntu'],
    ...['toString', '__proto__', 'constructor', 'hasOwnProperty', 'unknown', '', 'darwin',
      undefined, null, {toString() {throw new Error('must not coerce platform');}}]
      .map(platform => [platform, 'https://docs.docker.com/ai/sandboxes/install/']),
  ];
  for (const [platform, expected] of cases) {
    const base = props(readiness);
    const out = renderFixture(Setup, {...base, data:{...base.data,
      home:{...base.data.home, desktop:{platform}}}});
    const link = out.match(/<a [^>]*href="([^"]+)"[^>]*>Open Docker installation instructions/);
    if (platform === 'mac' || platform === 'macos') {
      assert.equal(link, null);
      assert.match(renderedText(out), /Install the sandbox/);
      continue;
    }
    assert.ok(link);
    assert.equal(link[1], expected);
    assert.doesNotMatch(link[1], /function|native code|\[object/);
    assert.match(out, /data-blocker="docker_installed"/);
  }
  const base = props(readiness);
  const out = renderFixture(Setup, {...base, data:{...base.data,
    home:{...base.data.home, desktop:{platform:'windows'}}}});
  assert.match(renderedText(out), /This computer can’t lend/);
  assert.doesNotMatch(out, /data-blocker=|Open Docker installation instructions/);
});
