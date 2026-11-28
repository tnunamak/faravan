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

// Screen check 11-28: a circle row ran its meta line into the job-history notice ("2 computersCould not reach…").
test('an unreachable host notice is separated from the circle row meta line',async()=>{
  const circle={id:'c1',name:'Weekend projects',origin:'http://host',personCount:2,joinInfo:{ownerName:'Maya'}};
  const api=createFakeApi({hosting:{hosted:false}});
  const view=await mount(h(Circles,{
    circles:[circle],api,revision:0,takeJoinLink:()=> '',refresh:async()=>{},mutate:async()=>({}),
    data:{circles:[circle],devices:{circles:[{circle:'c1',members:[{key_id:'a'},{key_id:'b'}]}]},
      jobCircleCoverage:[{circleId:'c1',state:'unavailable',reason:'unreachable'}],uncheckedJobCircles:[]},
  }));
  const row=document.querySelector('ul[aria-label="Your circles"] li').textContent;
  assert.match(row,/2 computers /,'the row shows its computer count');
  assert.match(row,/did not answer/,'the unreachable-host notice is in the row');
  const at=row.indexOf('Maya’s computer, which hosts this circle');
  assert.ok(at>0,'the notice names the host');
  assert.match(row[at-1],/\s/,'a space separates the meta line from the notice');
  assert.ok(view.text().includes('Weekend projects'));
});
