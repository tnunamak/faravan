import {mount,resetPage,teardown,createFakeApi,installClock,click} from './mounted.test-helper.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Circles} from './circles.jsx';

beforeEach(()=>{resetPage('#/circles');installClock();});
afterEach(teardown);

test('a host outage after invitation review tells the joiner to review and retry the same link',async()=>{
  let attempts=0;
  const api=createFakeApi({
    hosting:{hosted:false},
    'circles/join-preview':{name:'Weekend projects',origin:'http://host',ownerName:'Maya',lanMode:false,expiresAt:'2026-10-21T00:00:00Z',maxUses:1},
  });
  const view=await mount(h(Circles,{
    circles:[],data:{circles:[],devices:{circles:[]}},api,revision:0,
    takeJoinLink:()=> 'fixture-invitation',refresh:async()=>{},
    mutate:async()=>{attempts++;throw Object.assign(new Error('host offline'),{code:'invite_unreachable',status:502});},
  }));
  assert.ok(view.button('Join circle'),'the link was reviewed before the outage');
  await click(view.button('Join circle'));
  assert.match(view.text(),/The circle server isn’t answering/);
  assert.match(view.text(),/You haven’t joined yet/);
  assert.ok(view.button('Review invitation'),'the same invitation can be reviewed for a retry');
  assert.equal(attempts,1);
  assert.doesNotMatch(view.text(),/invitation was made|create another one|Invitations tab/);
});

test('automatic preview timeout stays a review error without a creation fallback', async () => {
  const api=createFakeApi({hosting:{hosted:false}});
  api.post=async()=>{throw Object.assign(new Error('host unavailable'),{code:'timeout'});};
  const view=await mount(h(Circles,{circles:[],data:{circles:[],devices:{circles:[]}},api,revision:0,
    takeJoinLink:()=> 'fixture-invitation',refresh:async()=>{},mutate:async()=>assert.fail('preview must not join')}));
  assert.match(view.text(),/You haven’t submitted a join request from this review/);
  assert.doesNotMatch(view.text(),/invitation was made|create another one|Invitations tab/);
  await click(view.button('Review invitation'));
  assert.match(view.text(),/You haven’t submitted a join request from this review/);
  assert.doesNotMatch(view.text(),/invitation was made|create another one|Invitations tab/);
});
