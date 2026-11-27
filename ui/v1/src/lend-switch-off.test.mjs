import {mount,resetPage,teardown,click} from './mounted.test-helper.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {LendingCard} from './lend.jsx';
import {lendPageVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// r8 integration: turning the switch off is Off, never "paused until you resume". Only the Pause dialog's
// "Until I resume" choice (POST lending/pause with no end) pauses; the switch's off asks for lending/off.
beforeEach(()=>resetPage('#/home'));
afterEach(teardown);
const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}];
const lending={enabled:true,circle:'shared',status:'idle'};
test('the Lending switch turned off asks for Off, not an open-ended pause',async()=>{
 const page=lendPageVM(withLendingProjection({intent:{on:true,state:'ready'},lending,lendingPolicy:{accounts:[{provider:'codex',decision:{availability:{admitted:true}}}]}},{intent:'on',intentState:'ready'}),{agents,readiness:{ready:true,checks:[]}});
 const calls=[];
 const view=await mount(h(LendingCard,{vm:page,device:'Ana’s computer',circle:'shared',lending,agents,api:{},mutate:async(path,body)=>{calls.push([path,body]);return {};},setDialog(){},refresh(){}}));
 const toggle=document.querySelector('[role=switch]');
 assert.ok(toggle,'a ready lender shows the switch');
 await click(toggle);
 assert.deepEqual(calls.map(([path])=>path),['lending/off']);
});

test('F1: Review and timed or indefinite pause keep a direct Off action', async () => {
 const {Lend}=await import('./lend.jsx');
 const cases=[
  {state:'ready',approvals:[{id:'request-1'}]},
  {state:'blocked',reason:'agent_signed_out',approvals:[{id:'request-1'}]},
  {state:'paused',until:'2099-01-01T00:00:00Z',approvals:[]},
  {state:'paused',approvals:[]},
 ];
 for(const item of cases){
  const calls=[];
  const local={...lending,paused:item.state==='paused',pausedUntil:item.until};
  const home={state:item.state,reason:item.reason,lending:local};
  const view=await mount(h(Lend,{api:{get:async()=>({enabled:true})},agents,lending:local,
   data:{home,readiness:{ready:true,checks:[]},approvals:item.approvals,activity:[]},
   circle:'shared',circles:[],members:[],refresh(){},setCircle(){},setDialog(){throw Error('Off must not open a dialog');},
   mutate:async(path,body)=>{calls.push([path,body]);return {};} }));
  const off=view.button('Turn lending off');
  assert.ok(off,'owner can turn lending off directly in '+item.state);
  assert.equal(off.tagName,'BUTTON');
  assert.equal(off.disabled,false);
  off.focus();assert.equal(document.activeElement,off);
  await click(off);
  assert.deepEqual(calls.map(([path])=>path),['lending/off']);
  await view.unmount();
 }
});
