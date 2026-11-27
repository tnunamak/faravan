import test from 'node:test';
import assert from 'node:assert/strict';
import {Setup, Actions} from './setup.jsx';
import {setupVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {LENDING_ON_COPY} from './safety-copy.mjs';

// r7 O6 (Docker Sandboxes missing must say a terminal is needed, link Docker, show the command) and M3 (no duplicated settings card).
const storedPass = {id:'test-run',state: 'passed', at: '2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',
  configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
const circles = [{id: 'weekend', origin: 'https://circle.test', name: 'Weekend projects', enrollment: {state: 'approved'}, rosterMembershipVerified:true}];
const agents = [{id: 'codex', useForLending: true, installed: true, signedIn: true, run: {}}];
const okChecks = [{name: 'sbx_install', ok: true}, {name: 'sbx_daemon', ok: true}, {name: 'docker_login', ok: true}];
const MAC = 'brew trust docker/tap && brew install docker/tap/sbx';
const missing = remedy => ({ready: false, checks: [{name: 'sbx_install', ok: false, label: 'Docker Sandboxes is not installed.', remedy}, {name: 'sbx_daemon', ok: null}, {name: 'docker_login', ok: true}]});
const limits = {dailyJobs: 3, dailyMinutes: 60};
const page = (readiness, {platform = 'mac',phone = false} = {}) => renderFixture(Setup, {
  api: {}, agents, circles, circle: 'weekend', mutate: async () => ({}), refresh() {}, phone,
  lending: {circle: 'weekend', limits},
  data: {readiness, agents, lendingReadiness: {agents: [{id: 'codex', checks: [{id: 'signed_in', state: 'pass'}]}]}, home: {desktop: {platform},lending: {limits}}, devices: {name: 'Ana’s MacBook Pro'}},
});

test('Mac sandbox installation is one button with no terminal command', () => {
  const out = page(missing(MAC));
  const text = renderedText(out);
  assert.match(text, /Install the sandbox/);
  assert.match(text, /downloads the sandbox from Docker/);
  assert.doesNotMatch(text, /brew trust|open a terminal/);
  assert.doesNotMatch(out, /aria-label="Copy install command"/);
});

test('Docker missing: the install link follows the platform', () => {
  assert.match(page(missing('curl x | sudo sh'), {platform: 'linux'}), /install\/#install-on-ubuntu"/);
  assert.match(page(missing(''), {platform: 'other'}), /href="https:\/\/docs\.docker\.com\/ai\/sandboxes\/install\/"/);
});

test('Mac installation on a device uses the host app button too', () => {
  const out = page(missing(MAC), {phone: true});
  assert.match(renderedText(out), /Install the sandbox/);
  assert.doesNotMatch(renderedText(out), /brew trust/);
  assert.doesNotMatch(out, /aria-label="Copy install command"/);
});

test('setupVM keeps the install facts on the Docker step and leaves other steps alone', () => {
  const vm = setupVM({readiness: missing(MAC), agents, status: {desktop: {platform: 'mac'},lending: {}}, circle: circles[0]});
  const row = vm.steps.find(s => s.id === 'sandboxes');
  assert.equal(row.dockerInstall.command, MAC);
  assert.equal(row.dockerInstall.link.href, 'https://docs.docker.com/ai/sandboxes/install/#install-on-macos');
  assert.deepEqual(vm.steps.map(s => s.title), ['Install the sandbox', 'Sign in to Docker', 'Sign in to your agent', 'Check']);
});

test('M3: while steps are open the summary card does not repeat Lending settings', () => {
  const out = page(missing(MAC));
  const text = renderedText(out);
  assert.doesNotMatch(text, /Lends Codex|asks you before each job|Change these|Review lending limits/);
  assert.match(text, /Finish the steps that need you to turn lending on\./);
});

test('M3: when ready the card still shows the rules and the link to change them', () => {
  const text = renderedText(page({ready: true, checks: okChecks}));
  assert.match(text, /Last step/);
  assert.match(text, /asks you before each job/);
  assert.match(text, /Review lending limits/);
  assert.doesNotMatch(text, /Change these/);
});
test('the lending-on explanation names the account, sandbox intent, and provider/log access', () => {
 const text=renderedText(page({ready:true,checks:okChecks}));
 assert.ok(text.includes(LENDING_ON_COPY));
 assert.match(text,/What lending means/);
});

for(const phone of [false,true])test('a KVM terminal step keeps every command, phone='+phone,()=>{
 const remedy='sudo usermod -aG kvm $USER && newgrp kvm';
 const out=page({ready:false,checks:[...okChecks,{name:'kvm_access',ok:false,remedy}]},{platform:'linux',phone});
 const text=renderedText(out);
 assert.match(text,/needs a terminal/);
 assert.match(text,/sudo usermod -aG kvm \$USER && newgrp kvm/);
 if(phone)assert.match(text,/Copy this command and run it in a terminal on the computer running Faravan/);
});
test('a failed safety check never removes its terminal remedy',()=>{
 const remedy='sbx policy init deny-all';
 const out=page({ready:false,checks:[...okChecks,{name:'network_policy',ok:false,label:'Network policy missing',remedy}]},{platform:'linux'});
 assert.match(renderedText(out),/sbx policy init deny-all/);
 assert.match(renderedText(out),/needs a terminal/);
 assert.match(out,/<code>sbx policy init deny-all<\/code>/);
});
test('while a step still needs the person, the side card does not take the primary button',()=>{
 const on=renderFixture(Setup,{api:{},agents,circles,circle:'weekend',mutate:async()=>({}),refresh(){},phone:false,lending:{circle:'weekend',limits,enabled:true,mode:'ask'},
  data:{readiness:missing(MAC),agents,home:{desktop:{platform:'mac'},lending:{limits,enabled:true,circle:'weekend'},intent:{on:true}},devices:{name:'Ana’s MacBook Pro'}}});
 assert.match(on,/Open Lending/);assert.doesNotMatch(on,/btn-primary[^>]*href="#\/lend"/);
});

// Item 7 (1102 review): when in-app sign-in is unavailable, the step sends the person to Lending through a real link.
test('an agent without in-app sign-in links to Lending for the manual steps', () => {
  const out = renderFixture(Actions, {api: {}, refresh() {}, step: {title: 'Codex', actions: ['agent-signin'], agent: {id: 'codex', name: 'Codex', signInSupported: false}}});
  assert.match(out, /Sign-in is unavailable in this app for Codex\. <a href="#\/lend">Open Lending<\/a> for the manual steps\./);
});
