import {click, mount, resetPage, teardown, installClock} from './mounted.test-helper.mjs';
import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Home} from './home.jsx';
beforeEach(()=>{resetPage('#/');installClock();});
afterEach(teardown);
for(const [label,path,body] of [
  ['Lend automatically','lending/mode',{circle:'c1',mode:'auto'}],
  ['Keep asking','lending/mode',{circle:'c1',mode:'ask'}],
  ['Not now','lending/prompts/dismiss',{circle:'c1'}],
])test('Home sends '+label+' through the shared API',async()=>{
  const calls=[],circle={id:'c1',name:'Friends',origin:'http://fixture',owned:true};
  const lending={enabled:false,circle:'c1',mode:'ask',status:'off',limits:{timeZone:'UTC',dailyJobs:4,dailyMinutes:80}};
  const home={lending,intent:{on:false,state:'off'},lendingPrompts:[{circle:'c1',name:'Friends'}]};
  const view=await mount(h(Home,{api:{get:async()=>[]},circles:[circle],agents:[{id:'codex',useForLending:true}],lending,circle:'c1',members:[],refresh(){},setDialog(){},
    mutate:async(path,body)=>{calls.push([path,body]);return {};},
    data:{home,circles:[circle],agents:[],jobs:[],approvals:[],activity:[],devices:{name:'PC',fingerprint:'own',circles:[{circle:'c1',members:[{}, {}, {}]}]},readiness:{ready:true,checks:[]}}}));
  assert.ok(view.text().includes('Let jobs from Friends use your Codex on this computer'));
  assert.ok(view.text().includes('4 jobs; 80 minutes a day'));
  assert.ok(view.text().includes('your subscription allowance.'));
  assert.ok(view.text().includes('Not now shows this card next launch.'));
  assert.equal(view.$('a[href="#/lend/limits"]').textContent,'Review limits');
  const button=view.$$('button').find(b=>b.textContent===label);
  assert.ok(button,'choice is visible');await click(button);
  assert.deepEqual(calls,[[path,body]]);
});
