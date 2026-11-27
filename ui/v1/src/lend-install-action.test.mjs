import {click, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {AgentCard} from './lend.jsx';
import {BlockerAction} from './blockers.jsx';

// "Install Codex" on the Lend page must not link to the page it is on: it opens that agent's install steps.
beforeEach(() => resetPage('#/lend'));
afterEach(teardown);

const item = {key: 'agent', agent: 'codex', label: 'Codex', status: 'blocked', detail: 'Not installed.', action: 'Install Codex', headline: 'Lending stopped: Codex isn’t installed'};
const agent = {id: 'codex', installed: false, signedIn: null, useForLending: true, run: {}};

test('Install on the Lend page opens the agent’s install details and keeps the hash', async () => {
  const view = await mount(h('div', null,
    h('section', {id: 'lend-agents'}, h(AgentCard, {agent, api: {}, blocker: item, refresh() {}, mutate: async () => ({})})),
    h(BlockerAction, {item, primary: true, api: {}, agents: [agent], mutate: async () => ({}), refresh() {}, surface: 'lend'})));
  const details = document.querySelector('#lend-agents details[data-agent-id="codex"]');
  assert.ok(details, 'the card has its details');
  assert.equal(details.open, false);
  await click(view.button('Install Codex'));
  assert.equal(details.open, true, 'the install steps are open');
  assert.equal(location.hash, '#/lend');
  assert.equal(document.querySelector('a[href="#/lend"]'), null, 'no link to the current page');
  await view.unmount();
});
