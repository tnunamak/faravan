import {click, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Lend} from './lend.jsx';
import {lendingStatus} from '../../../lib/v1/lending-status-copy.mjs';
import {statusView} from './helpers.mjs';

beforeEach(() => {resetPage('#/lend'); installClock();});
afterEach(teardown);

test('identity status helpers name the agent and offer its sign-in for both hold kinds', () => {
  for (const reason of ['identity_unknown', 'identity_mismatch']) {
    const view = statusView(reason, {detail:{provider:'claude'}});
    assert.match(view.message, /Claude Code/);
    assert.equal(view.remedy, 'Sign in to Claude Code');
  }
});

test('Lend identity holds show one working same-card sign-in for the affected lending agent', async () => {
  for (const [provider, id, name, proxy] of [['claude','claude-code-subscription','Claude Code',false], ['codex','codex','Codex',false], ['codex','codex','Codex',true]]) {
    for (const reason of ['identity_unknown','identity_mismatch']) {
      const calls = [];
      const lending = {enabled:true,circle:'friends',status:'idle',mode:'ask',limits:{}};
      const current = {admitted:false,reason,status:lendingStatus({reason})};
      const api = {
        get:async () => ({enabled:true}),
        post:async path => {calls.push(path); return {flowId:'synthetic-flow',status:'awaiting_browser',url:'https://example.test/login'};},
      };
      const view = await mount(h(Lend, {api, lending,
        agents:[{id,installed:true,signedIn:true,useForLending:true,signInSupported:true,run:{},
          ...(proxy ? {lendingSignInTarget:'codex-lending',lendingSignInSupported:true,proxySignedIn:true} : {})}],
        circles:[],circle:'friends',members:[],refresh(){},setDialog(){},setCircle(){},mutate:async()=>({}),
        data:{readiness:{ready:true,checks:[]},home:{state:'ready',lending,
          lendingPolicy:{accounts:[{provider,decision:{availability:current}}]}},approvals:[]},
      }));
      const hero = view.$('.hero');
      assert.match(hero.textContent, new RegExp(name));
      assert.match(hero.textContent, reason === 'identity_unknown' ? /could not confirm/ : /different account/);
      const buttons = [...hero.querySelectorAll('button')].filter(button => button.textContent === 'Sign in to ' + name);
      assert.equal(buttons.length, 1, 'the hold and its one sign-in control share a card');
      assert.deepEqual(calls, [], 'rendering never starts sign-in');
      const originalOpen = window.open; window.open = () => null;
      try {
        await click(buttons[0]);
        assert.deepEqual(calls, ['signin/' + (proxy ? 'codex-lending' : id)]);
      } finally {
        window.open = originalOpen;
        await view.unmount();
      }
    }
  }
});

test('identity action uses only the selected supported agent while lending is idle and on', async () => {
  const {lendPageVM} = await import('./view-models.mjs');
  const {withLendingProjection} = await import('./lending-projection.fixture.mjs');
  const reason = 'identity_mismatch';
  const status = {lending:{enabled:true,status:'idle',circle:'friends'},
    lendingPolicy:{accounts:[{provider:'codex',decision:{admitted:false,reason,status:lendingStatus({reason})}}]}};
  const agent = {id:'codex',installed:true,signedIn:true,useForLending:true,signInSupported:true};
  const view = (agents, projection = {}) => lendPageVM(withLendingProjection(status, projection), {agents});
  assert.equal(view([agent]).identityHold.target, 'codex');
  assert.equal(view([{...agent,signInSupported:false}]).identityHold.target, null);
  assert.equal(view([{...agent,installed:false}]).identityHold.target, null);
  for (const agents of [[], [{...agent,useForLending:false}], [{...agent,id:'claude-code-subscription'}]]) {
    assert.equal(view(agents).identityHold, null);
  }
  for (const projection of [{intent:'off'}, {intent:'paused'}, {execution:'running',executionJob:'synthetic-job'},
    {execution:'finishing',executionJob:'synthetic-job'}, {execution:'stopping',executionJob:'synthetic-job'}]) {
    assert.equal(view([agent], projection).identityHold, null);
  }
});
