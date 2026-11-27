import {act, click, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {AgentCard} from './lend.jsx';
import {BlockerAction, focusAgentList} from './blockers.jsx';
import {agentRowVM} from './view-models.mjs';

// Lend page regressions (fix/ui-trial-1027): the "Choose agents" fix, the Claude Code card's status, and its model picker.
beforeEach(() => { resetPage('#/lend'); installClock(); });
afterEach(teardown);

const claudeId = 'claude-code-subscription';
const signedOutSnapshot = {status: 'blocked', detail: 'Signed out.', action: 'Sign in to Claude Code', headline: 'Lending stopped: Claude Code is signed out'};

test('fresh sign-in evidence replaces a stale "Signed out." snapshot: one status, no sign-in form', () => {
  const row = agentRowVM({id: claudeId, installed: true, signedIn: true, signInSupported: true, useForLending: true}, signedOutSnapshot);
  assert.equal(row.word, 'Ready');
  assert.equal(row.state, 'ready');
  assert.equal(row.canSignIn, false);
  assert.deepEqual(row.sub.slice(0, 2), ['Signed in', 'ready']);
});

test('a signed-out agent still shows its sign-in when the snapshot agrees', () => {
  const row = agentRowVM({id: claudeId, installed: true, signedIn: false, signInSupported: true, useForLending: true}, signedOutSnapshot);
  assert.equal(row.word, 'Signed out');
  assert.equal(row.canSignIn, true);
});

test('an unready lending proxy offers in-app sign-in and does not offer its lend switch', async () => {
  const targets = [];
  const agent = {id:'codex-lending',canonical_id:'codex',installed:true,signedIn:false,proxySignedIn:false,
    useForLending:false,auth_strategy:'docker-native-oauth',credential_in_guest:false,
    signInSupported:true,lendingSignInSupported:true,canChoose:false,run:{}};
  const api = {post:async path=>{targets.push(path);return {flowId:'synthetic-flow',status:'awaiting_browser',url:'https://example.test/login'};},
    get:async()=>({flowId:'synthetic-flow',status:'awaiting_browser',url:'https://example.test/login'})};
  const view = await mount(h(AgentCard, {agent,api,mutate:async()=>{},refresh(){},blocker:null}));
  assert.equal(view.$('[role="switch"]'),null);
  const originalOpen=window.open;
  window.open=()=>null;
  try {
    await click(view.button('Sign in to Codex'));
    assert.deepEqual(targets,['signin/codex-lending']);
  } finally {
    window.open=originalOpen;
    await view.unmount();
  }
});

test('turning an agent on starts its check at once, without a Check press', async () => {
  const calls = [];
  // The save answers with every agent, as the server does; the card confirms its own row from that list.
  const mutate = async (path, body) => { calls.push([path, body]); return path === 'agents/refresh' ? [] : [{id: claudeId, useForLending: body.useForLending}]; };
  const agent = {id: claudeId, installed: true, signedIn: null, useForLending: false, run: {}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() {}, blocker: null}));
  await click(view.$('[role="switch"]'));
  assert.deepEqual(calls, [['agents/' + claudeId, {useForLending: true}], ['agents/refresh', {agents: [claudeId]}]]);
  await view.unmount();
});

test('turning an agent off does not start a check', async () => {
  const calls = [];
  const mutate = async (path, body) => { calls.push([path, body]); return [{id: claudeId, useForLending: body.useForLending}]; };
  const agent = {id: claudeId, installed: true, signedIn: true, useForLending: true, run: {}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() {}, blocker: null}));
  await click(view.$('[role="switch"]'));
  assert.deepEqual(calls, [['agents/' + claudeId, {useForLending: false}]]);
  await view.unmount();
});

test('the model is chosen from the agent’s models; another id is typed only after "Another model…"', async () => {
  const calls = [];
  const mutate = async (path, body) => { calls.push([path, body]); return {}; };
  const agent = {id: claudeId, installed: true, signedIn: true, useForLending: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'], run: {}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() {}, blocker: null}));
  const select = view.$('select');
  assert.deepEqual([...select.querySelectorAll('option')].map(o => o.value), ['', 'claude-sonnet-5-5', 'claude-opus-5-5', '__other__']);
  assert.equal(view.$('input[maxlength="80"]'), null, 'no free-text model field until "Another model…"');
  select.value = 'claude-opus-5-5';
  await act(() => { select.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await flush();
  await click(view.button('Save'));
  assert.deepEqual(calls.at(-1), ['agents/' + claudeId + '/run', {model: 'claude-opus-5-5', effort: null}]);
  await view.unmount();
});

test('a saved model the list does not name stays visible and editable', async () => {
  const agent = {id: claudeId, installed: true, signedIn: true, useForLending: true, models: ['claude-sonnet-5-5'], run: {model: 'my-custom-model'}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate: async () => ({}), refresh() {}, blocker: null}));
  assert.equal(view.$('select').value, '__other__');
  assert.equal(view.$('input[maxlength="80"]').value, 'my-custom-model');
  await view.unmount();
});

test('"Choose agents" on the Lend page moves focus to the agent list instead of doing nothing', async () => {
  const item = {key: 'agent', label: 'Coding agents', status: 'blocked', detail: 'No agent is chosen to lend.', action: 'Choose agents', headline: 'Choose an agent to lend'};
  const view = await mount(h('div', null,
    h(BlockerAction, {item, primary: true, api: {}, agents: [], mutate: async () => ({}), refresh() {}}),
    h('section', {id: 'lend-agents'}, h('button', {role: 'switch', 'aria-label': 'Lend with Claude Code', type: 'button'}, ''))));
  const link = view.button('Choose agents');
  assert.equal(link.getAttribute('href'), '#/lend');
  await click(link);
  assert.equal(document.activeElement, view.$('[role="switch"]'), 'focus lands on the first agent switch');
  assert.equal(location.hash, '#/lend', 'the page stays on Lend');
  await view.unmount();
});

test('"Choose agents" follows the link when the agent list is not on this page', async () => {
  const item = {key: 'agent', label: 'Coding agents', status: 'blocked', detail: 'No agent is chosen to lend.', action: 'Choose agents', headline: 'Choose an agent to lend'};
  const view = await mount(h(BlockerAction, {item, primary: true, api: {}, agents: [], mutate: async () => ({}), refresh() {}}));
  assert.equal(focusAgentList(document), false);
  await click(view.button('Choose agents'));
  assert.equal(location.hash, '#/lend', 'the link still navigates to Lend');
  await view.unmount();
});

test('F2: an unchecked agent announces checking until returned evidence, never selection as readiness', async () => {
 const {Notices}=await import('./shared.jsx');
 for(const signedIn of [false,true]){
  const messages=[];let resolveCheck;
  const pending=new Promise(resolve=>{resolveCheck=resolve;});
  const agent={id:claudeId,installed:true,signedIn:null,useForLending:false,run:{}};
  const view=await mount(h(Notices.Provider,{value:{set:value=>messages.push(value)}},
   h(AgentCard,{agent,api:{},blocker:null,refresh(){},
    mutate:async path=>path==='agents/refresh'?pending:[{id:claudeId,useForLending:true}]})));
  await click(view.$('[role="switch"]'));
  assert.equal(messages.at(-1),'Claude Code is chosen for lending.');
  assert.ok(messages.every(message=>!/is ready to lend/.test(message)));
  await act(async()=>{resolveCheck([{...agent,signedIn,useForLending:true}]);await pending;});
  await flush();
  assert.ok(messages.length>=2,'returned check evidence replaces the pending notice');
  assert.ok(messages.every(message=>!/is ready to lend when lending is on/.test(message)),
   'selection alone must never produce a readiness success');
  await view.unmount();
 }
});

// The test Mac 11-01: the switch stayed off with no message while Faravan checked the agent, so it looked dead.
test('a switch shows the choice at once as pending, says what Faravan waits for, and ignores repeat taps', async () => {
  const calls = [];
  let answer;
  const mutate = (path, body) => { calls.push([path, body]); return path === 'agents/refresh' ? Promise.resolve([]) : new Promise(resolve => { answer = resolve; }); };
  const agent = {id: claudeId, installed: true, signedIn: null, useForLending: false, run: {}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() {}, blocker: null}));
  const sw = view.$('[role="switch"]');
  await click(sw);
  assert.equal(sw.getAttribute('aria-checked'), 'true', 'the switch shows on while Faravan answers');
  assert.equal(sw.getAttribute('aria-busy'), 'true');
  assert.match(view.text(), /Checking that Claude Code is signed in for lending\. This starts a sandbox and takes about a minute\./);
  // The switch also names its own busy state, so the card's line is one of its descriptions.
  assert.ok(sw.getAttribute('aria-describedby').split(' ').includes(view.$('[id$="-choosing"]').id), 'the card line names the wait');
  await click(sw);
  assert.equal(calls.length, 1, 'a second tap waits for the first answer');
  await act(async () => { answer([{id: claudeId, useForLending: true}]); });
  await flush();
  assert.equal(sw.getAttribute('aria-busy'), null);
  assert.doesNotMatch(view.text(), /Checking that Claude Code is signed in/);
  await view.unmount();
});

test('a failed choice returns the switch to its saved state', async () => {
  const agent = {id: claudeId, installed: true, signedIn: true, useForLending: false, run: {}};
  const view = await mount(h(AgentCard, {agent, api: {}, mutate: async () => { throw Object.assign(new Error('agent_not_ready'), {code: 'agent_not_ready'}); }, refresh() {}, blocker: null}));
  await click(view.$('[role="switch"]'));
  assert.equal(view.$('[role="switch"]').getAttribute('aria-checked'), 'false');
  assert.equal(view.$('[role="switch"]').getAttribute('aria-busy'), null);
  await view.unmount();
});

// Review 11-01: a cached sign-in is per agent, not per account, so choosing a lending agent always checks it again.
test('choosing a signed-in lending agent still says it checks the sign-in, and a signed-out answer reloads its card', async () => {
  let answer, refreshed = 0;
  const agent = {id: 'codex-lending', canonical_id: 'codex', installed: true, signedIn: true, proxySignedIn: true, useForLending: false,
    lendingSignInTarget: 'codex-lending', lendingSignInSupported: true, canChoose: true, run: {}};
  const mutate = () => new Promise((resolve, reject) => { answer = reject; });
  const view = await mount(h(AgentCard, {agent, api: {}, mutate, refresh() { refreshed++; }, blocker: null}));
  await click(view.$('[role="switch"]'));
  assert.match(view.text(), /Checking that Codex is signed in for lending\. This starts a sandbox and takes about a minute\./);
  await act(async () => { answer(Object.assign(new Error('agent_not_ready'), {code: 'agent_not_ready'})); });
  await flush();
  assert.equal(view.$('[role="switch"]').getAttribute('aria-checked'), 'false');
  assert.equal(refreshed, 1, 'the card reloads so its signed-out state and sign-in appear');
  await view.unmount();
});

test('the pending line names the wait: a quick save, or a sandbox sign-in check', async () => {
  const {agentChoiceNote} = await import('./lend.jsx');
  assert.equal(agentChoiceNote('Claude Code', true, true), 'Turning on Claude Code…');
  assert.equal(agentChoiceNote('Claude Code', true, false), 'Checking that Claude Code is signed in for lending. This starts a sandbox and takes about a minute.');
  assert.equal(agentChoiceNote('Codex', false, true), 'Turning off Codex…');
});

// The test Mac 11-01: choosing an agent reran the sandbox safety test with no reason, and its switch looked dead meanwhile.







// Batch 9 (B): the owner can always stop lending, even while the sandbox safety test runs. Turning on waits for it.


// Review 11-01 (P2-1): a blocked checklist row is not a failure. Only a run whose typed state is 'failed' says so.
test('a click on the agent card: optimistic and busy, one write, an answer that claims only the choice, a refusal that reverts', async () => {
  const {Notices} = await import('./shared.jsx');
  const messages = [], writes = [];
  let answer;
  const mutate = (path, body) => { writes.push([path, body]); return new Promise((resolve, reject) => { answer = {resolve, reject}; }); };
  const off = {id: 'codex-lending', canonical_id: 'codex', installed: true, signedIn: true, proxySignedIn: true, useForLending: false,
    lendingSignInTarget: 'codex-lending', lendingSignInSupported: true, canChoose: true, run: {}};
  let refreshed = 0;
  const card = (agent, blocker) => h(Notices.Provider, {value: {set: value => messages.push(value)}},
    h(AgentCard, {agent,api: {},mutate,refresh() { refreshed++; },blocker}));
  const view = await mount(card(off,null));
  const sw = () => view.$('[role="switch"]');
  await click(sw());
  assert.deepEqual([sw().getAttribute('aria-checked'), sw().getAttribute('aria-busy')], ['true', 'true'], 'optimistic and busy before the answer');
  assert.match(view.$('[id$="-choosing"]').textContent, /Checking that Codex is signed in for lending/);
  await click(sw());
  assert.equal(writes.length, 1, 'a second click does not write while the first is pending');
  await view.rerender(card({...off,useForLending:true},{key:'agent',agent:'codex',status:'ok',detail:'Signed in.'}));
  await act(async () => { answer.resolve([{...off, useForLending: true}]); });
  await flush();
  assert.equal(messages.at(-1), 'Codex is chosen for lending.', 'the answer confirms the choice, not readiness');
  assert.ok(messages.every(message => !/ready to lend|is ready/.test(message)), 'signed in is never announced as able to lend');
  // Codex is off again on the server; a new choice is refused, and the switch goes back.
  await view.rerender(card(off,null));
  await click(sw());
  await act(async () => { answer.reject(Object.assign(new Error('agent_not_ready'), {code: 'agent_not_ready'})); });
  await flush();
  assert.equal(sw().getAttribute('aria-checked'), 'false', 'a refused choice puts the switch back');
  assert.equal(sw().getAttribute('aria-busy'), null);
  assert.equal(messages.at(-1), 'Codex isn’t signed in for lending. Sign it in, then turn it on.', 'the recovery step shows');
  assert.equal(refreshed, 1, 'the card reloads so its sign-in appears');
  await view.unmount();
});
