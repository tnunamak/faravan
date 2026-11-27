import test from 'node:test';
import assert from 'node:assert/strict';
const storedPass = {id:'test-run',state:'passed',at:'2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
import {Home} from './home.jsx';
import {Lend} from './lend.jsx';
import {Setup} from './setup.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// UAT 2026-10-19: Setup said "Docker account: Signed in, Sandbox check: done" while Lending said "Docker sign-in: Not
// signed in" and "Lending stopped". One truth across Home, Lending and Setup, built from the same facts.
const circle = {id:'c1', name:'Weekend projects', origin:'http://x', owned:true};
const agents = [{id:'claude-code-subscription', useForLending:true, installed:true, signedIn:true, run:{}}, {id:'codex', useForLending:true, installed:true, signedIn:true, run:{}}];
const checks = (login = true, extra = []) => [{name:'sbx_install', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:login}, ...extra];
const latch = withLendingProjection({intent:{on:false,state:'off', reason:'stopped_by_lender'}, state:'off', reason:'stopped_by_lender', needs_you:[{kind:'safety_check_failed'}]},
  {intent:'off',intentState:'off',admission:'blocked',admissionReason:'stopped_by_lender'});
const screens = (readiness, status = {}, ag = agents) => {
  const lending = {enabled:false, circle:'c1', mode:'ask', status:'idle', limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60}};
  const home = {lending,attention:[],circles:[circle],...status};
  const props = {api:{get: async () => []}, circles:[circle], agents:ag, lending, circle:'c1', selected:circle, members:[], mutate: async () => ({}), refresh() {}, setDialog() {}, setCircle() {},
    data:{home, lendingReadiness:{agents:ag.map(a=>({id:a.id,checks:[{id:'signed_in',state:'pass'}]}))}, approvals:[], activity:[], devices:{name:'Ana’s MacBook', circles:[]}, readiness, agents:ag}};
  return {home:renderFixture(Home, props), lend:renderFixture(Lend, props), setup:renderFixture(Setup, props)};
};
// The Docker sign-in row, as each screen draws it: 'ok' | 'need' | 'waits' | 'now'.
const lendRow = html => html.match(/data-blocker="docker_signin" data-state="(\w+)"/)?.[1];
const setupRow = html => ({ok:'ok',blocked:'need',waits:'waits',unknown:'now'})[html.match(/data-blocker="docker_signin" data-state="(\w+)"/)?.[1]];

test('Docker signed out for real: Lending and Setup both say it needs you, Home says lending is stopped', () => {
  const s = screens({ready:false, checks:checks(false)}, latch);
  assert.deepEqual([lendRow(s.lend), setupRow(s.setup)], ['blocked', 'need']);
  assert.match(renderedText(s.lend), /Lending is off/);
  assert.match(renderedText(s.home), /Lending is off/);
  assert.match(renderedText(s.setup), /Docker sign-in Needs you/);
});

test('the UAT state: the saved failure is left over, the live checks all pass — no screen says Docker is signed out', () => {
  const s = screens({ready:true, checks:checks(true), protection:{observed_at:'2026-10-19T23:28:00Z'}}, latch);
  assert.ok([undefined,'ok'].includes(lendRow(s.lend)), 'Lending folds passed computer checks');
  assert.equal(setupRow(s.setup),'ok');
  for (const [name, html] of Object.entries(s)) {
    assert.doesNotMatch(renderedText(html), /Not signed in|sign in to Docker|Lending stopped|safety test failed|Failed at/, name);
  }
  assert.match(renderedText(s.lend), /Lending is off No new jobs start until you turn lending back on after the earlier check stopped it\./);
  assert.match(s.lend, /aria-label="Lending"/, 'the hero switch clears the saved stop');
  assert.match(renderedText(s.setup), /Turn on lending/);
  assert.doesNotMatch(s.setup, /Turn on lending[^]*?aria-disabled="true"/, 'Setup’s turn-on is enabled');
});

test('a failed job limit check names the same blocker on Lending and Setup',()=>{
 const failing={name:'v1_limits',ok:false,label:'Some required job limits lack enforcement evidence.'};
 const s=screens({ready:false,checks:checks(true,[failing])},{});
 for(const name of ['lend','setup'])assert.match(renderedText(s[name]),/Some required job limits lack enforcement evidence/);
 for(const name of ['lend','setup'])assert.doesNotMatch(renderedText(s[name]),/Run the test/);
});

test('everything fine: all three screens agree there is nothing to fix', () => {
  const s = screens({ready:true, checks:checks(true)}, {intent:{state:'ready'}, lending:{enabled:true, circle:'c1', limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60}}});
  assert.equal(setupRow(s.setup), 'ok');
  assert.ok([undefined, 'ok'].includes(lendRow(s.lend)), 'Lending shows the Docker row done or not at all');
  for (const html of [s.lend, s.setup]) assert.doesNotMatch(renderedText(html), /needs you|Needs you|Lending stopped|isn’t signed in/i);
});
