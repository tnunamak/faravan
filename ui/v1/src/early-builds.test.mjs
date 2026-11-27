import {mount,flush,act,teardown,resetPage} from './mounted.test-helper.mjs';
import test,{afterEach,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {EarlyBuilds} from './early-builds.jsx';
beforeEach(()=>resetPage('#/setup'));afterEach(teardown);
test('mounted switch reads saved preference and only confirms after persistence',async()=>{
  let save,body;
  const api={get:async()=>({earlyBuilds:false,canSelfUpdate:true}),post:(_path,input)=>{body=input;return new Promise(resolve=>{save=resolve;});}};
  const view=await mount(h(EarlyBuilds,{api}));await flush();
  const control=()=>view.$('input[type=checkbox]');assert.equal(control().checked,false);
  await act(async()=>{control().checked=true;control().dispatchEvent(new Event('change',{bubbles:true}));});
  assert.deepEqual(body,{earlyBuilds:true});assert.equal(control().disabled,true);
  await act(async()=>save({earlyBuilds:true}));await flush();
  assert.equal(control().checked,true);assert.match(view.text(),/Restart Faravan/);
});
test('failed save retains last confirmed preference and allows retry',async()=>{
  const api={get:async()=>({earlyBuilds:false,canSelfUpdate:true}),post:async()=>{throw Error('offline');}};
  const view=await mount(h(EarlyBuilds,{api}));await flush();
  await act(async()=>{const input=view.$('input');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
  assert.equal(view.$('input').checked,false);assert.equal(view.$('input').disabled,false);
  assert.match(view.text(),/could not be saved/);
});

test('package-managed install shows one sentence and no early-build switch',async()=>{
  const api={get:async()=>({earlyBuilds:false,canSelfUpdate:false})};
  const view=await mount(h(EarlyBuilds,{api}));await flush();
  assert.ok(!view.$('input'),'package-managed install has no switch');
  assert.equal(view.text().trim(),'This install updates through your package manager.');
});
