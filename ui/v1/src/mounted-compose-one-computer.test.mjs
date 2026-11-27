import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';
import {circleAgents, noAgentReason} from './compose-model.mjs';

// One person with one computer: it hosts the circle and lends in it. Send a job must offer this computer's agents,
// say why when there is no agent, and never hide a required project behind a closed row.
const START = Date.UTC(2026, 10, 1, 15, 0, 0);
const CIRCLE = {id:'circle-tessa',name:'Tessa',origin:'http://127.0.0.1:9',membershipProjection:{
  schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown',
}};
const REPO = {path:'/home/sam/code/SillyTavern',name:'SillyTavern',is_git:true};
const INFO = {path:REPO.path,name:'SillyTavern',kind:'git',branch:'main',head:'8d01e4a'+'b'.repeat(33),files:12,changed:[],changed_count:0};
const SELF = {keyId:'self-key',self:true,label:'Tessa’s MacBook',agents:[{adapter:'claude-code-subscription',readiness:'ready'},{adapter:'codex',readiness:'ready'}]};
const compose = lenders => ({circle:CIRCLE.id,name:'Tessa',hosted:true,networked:true,presence:'ok',host:{label:'Tessa’s MacBook',reachable:true},lenders,offers:[]});

beforeEach(() => { resetPage('#/jobs/new'); installClock(START); localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes'); });
afterEach(teardown);

function api({lenders, suggest}) {
  const fake = createFakeApi(), inspected = [];
  fake.get = async path => path === 'folders?path=' ? {home:'/home/sam'} : path === 'folders/suggest' ? suggest
    : path.endsWith('/compose') ? compose(lenders) : {};
  fake.post = async (path, body) => { if (path === 'repo/inspect') { inspected.push(body.path); return INFO; } return {}; };
  fake.inspected = inspected;
  return fake;
}
const open = async a => { const page = await mount(h(Compose, {circles:[CIRCLE],circle:CIRCLE.id,api:a,refresh:()=>{},setCircle:()=>{}})); for (let i = 0; i < 5; i++) await flush(); return page; };
const options = page => [...page.$('#cmp-agent').options].map(o => o.textContent);

test('an agent this computer offers is marked available on this computer, also when a friend offers it too', () => {
  assert.deepEqual(circleAgents({lenders:[SELF]}).map(a => [a.id, a.here]), [['claude-code', true], ['codex', true]]);
  const other = {keyId:'other', self:false, agents:[{adapter:'codex', readiness:'ready'}]};
  for (const lenders of [[SELF, other], [other, SELF]]) {
    assert.deepEqual(circleAgents({lenders}).map(a => [a.id, a.here]).sort(), [['claude-code', true], ['codex', true]],
      'the order of the lenders does not drop the mark');
  }
  assert.deepEqual(circleAgents({lenders:[other]}).map(a => [a.id, a.here]), [['codex', false]]);
  assert.equal(noAgentReason({lenders:[SELF]}, 'Tessa'), null);
  assert.equal(noAgentReason({lenders:null}, 'Tessa'), null, 'unknown lenders have their own banner');
});

test('the Agent option says the agent is available here, not that the job runs here', async () => {
  const other = {keyId:'other', self:false, label:'Ana’s MacBook', agents:[{adapter:'codex', readiness:'ready'}]};
  const page = await open(api({lenders:[other, SELF], suggest:{recent:[REPO], repos:[REPO], truncated:false}}));
  assert.deepEqual(options(page), ['Let the lender choose', 'Codex · available on this computer', 'Claude Code · available on this computer']);
});

test('the empty-list reason names the circle as a circle, never as a person', () => {
  for (const lenders of [[], [{...SELF, agents:[]}]]) {
    const {why} = noAgentReason({lenders}, 'Tessa');
    assert.match(why, /in the circle “Tessa”/);
    assert.doesNotMatch(why, /in Tessa\b/);
  }
  assert.match(noAgentReason({lenders:[]}).why, /No computer in this circle is lending/);
  assert.deepEqual(noAgentReason({lenders:[]}, 'Tessa').actions.map(a => a.label), ['Lend from this computer', 'Invite someone']);
});

test('lenders with no ready agent: the reason promises a wait only for “Let the lender choose”', () => {
  const r = noAgentReason({lenders:[{...SELF, state:'ready', agents:[{adapter:'codex', readiness:'signed_out'}]}]}, 'Tessa');
  assert.equal(r.why, 'No computer lending in the circle “Tessa” has an agent ready right now, so no agent can take this job.');
  assert.equal(r.next, 'With Agent on “Let the lender choose”, you can still send, and the job waits for a computer to take it. To run it on this computer, open Lend and choose an agent, or sign it in.');
  assert.doesNotMatch(r.next, /If you send now|set up an agent/);
});

test('lenders that are paused or outside their hours are not counted as lending', () => {
  for (const state of ['paused', 'outside', 'resting', 'blocked', 'update']) {
    const r = noAgentReason({lenders:[{...SELF, state, agents:[]}, {keyId:'b', self:false, state:'outside', agents:[]}]}, 'Tessa');
    assert.equal(r.why, 'Every computer that lends in the circle “Tessa” is paused, outside its hours or not taking jobs right now, so no agent can take this job.', state);
  }
  const mixed = noAgentReason({lenders:[{...SELF, state:'paused', agents:[]}, {keyId:'b', self:false, state:'starting', agents:[]}]}, 'Tessa');
  assert.match(mixed.why, /^No computer lending in the circle “Tessa” has an agent ready/);
});

test('one computer that lends in its own circle can pick its own agents, and the only project is chosen for it', async () => {
  const a = api({lenders:[SELF], suggest:{recent:[], repos:[REPO], truncated:false}});
  const page = await open(a);
  assert.deepEqual(options(page), ['Let the lender choose', 'Claude Code · available on this computer', 'Codex · available on this computer']);
  assert.equal(page.$('#cmp-agent-empty'), null);
  assert.deepEqual(a.inspected, [REPO.path], 'the only project found is chosen');
  assert.equal(page.$('#cmp-project .cmp-setting-value').textContent, 'SillyTavern');
  assert.equal(page.$('#cmp-project').open, false, 'a chosen project shows as a summary that can be changed');
  assert.equal(page.$('#cmp-project-needed'), null);
});

test('with no lender at all, the Agent list says why and what to do', async () => {
  const page = await open(api({lenders:[], suggest:{recent:[REPO], repos:[REPO], truncated:false}}));
  const reason = page.$('#cmp-agent-empty');
  assert.ok(reason, 'never a silent empty list');
  assert.equal(reason.querySelector('p').textContent,
    'No computer in the circle “Tessa” is lending right now, this one included, so no agent can take this job. Turn on lending here to run it on this computer, or add your other computer or invite someone.');
  assert.deepEqual([...reason.querySelectorAll('a')].map(l => [l.textContent.trim(), l.getAttribute('href')]),
    [['Lend from this computer', '#/lend'], ['Invite someone', '#/circles']]);
  assert.equal(page.$('#cmp-agent').getAttribute('aria-describedby'), 'cmp-agent-empty');
});

test('a paused lender with no ready agent shows the paused reason, and a pending read shows none', async () => {
  const page = await open(api({lenders:[{...SELF, state:'paused', agents:[]}], suggest:{recent:[REPO], repos:[REPO], truncated:false}}));
  assert.match(page.$('#cmp-agent-empty p').textContent, /^Every computer that lends in the circle “Tessa” is paused, outside its hours or not taking jobs right now/);
  const unknown = await open(api({lenders:null, suggest:{recent:[REPO], repos:[REPO], truncated:false}}));
  assert.equal(unknown.$('#cmp-agent-empty'), null, 'an unknown reading makes no claim');
});

test('with no obvious project, the Project row opens and says a choice is needed', async () => {
  const a = api({lenders:[SELF], suggest:{recent:[], repos:[REPO, {...REPO, path:'/home/sam/code/other', name:'other'}], truncated:false}});
  const page = await open(a);
  assert.deepEqual(a.inspected, [], 'two projects: none is chosen for the person');
  assert.equal(page.$('#cmp-project').open, true);
  assert.equal(page.$('#cmp-project-needed').textContent, 'Choose the project to send, or choose No project to send only your prompt.');
});
