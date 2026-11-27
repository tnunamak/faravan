import {click, createFakeApi, mount, teardown} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Circle} from './circles.jsx';

afterEach(teardown);
for(const enabled of [false,true])test('circle settings can '+(enabled?'revoke':'allow')+' agent sends',async()=>{
  const circle={id:'friends',name:'Friends',owned:true,origin:'https://example.test'},calls=[];
  const view=await mount(h(Circle,{id:circle.id,circles:[circle],api:createFakeApi(),
    data:{devices:{fingerprint:'self',circles:[]}},lending:{agentBorrowing:{friends:enabled}},
    mutate:async(...args)=>calls.push(args)}));
  await click(view.button('Settings'));
  assert.match(view.container.textContent,/Agents running as you may send jobs to this circle without asking. They can send only what you committed./);
  assert.match(view.container.textContent,/Turning this off stops new sends. Jobs already sent keep running./);
  await click(view.button(enabled?'Ask each time':'Allow agents to send to this circle'));
  assert.deepEqual(calls,[['circles/friends/agent-borrowing',{enabled:!enabled}]]);
});
