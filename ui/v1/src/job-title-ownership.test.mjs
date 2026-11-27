import {mount,resetPage,teardown,createFakeApi,installClock,flush} from './mounted.test-helper.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job} from './jobs.jsx';
import {JobHead} from './job-view.jsx';
import {App} from './main.jsx';

// r8 O16: the tab title belongs to whatever the page shows, in every state. It never keeps the previous job's words.
beforeEach(()=>{resetPage('#/job/b/c');installClock();document.title='Write a poem · Working · Faravan';});
afterEach(teardown);
const circle={id:'c',name:'Weekend projects',origin:'http://fixture'};
const jobProps=api=>({id:'b',requestedCircle:'c',api,data:{devices:{}},circles:[circle],draft:{},members:[]});

test('a job that is still loading owns the title instead of the previous job',async()=>{
 const api=createFakeApi({});
 await mount(h(Job,jobProps(api)));
 assert.equal(document.title,'Loading job · Faravan');
});
test('a job that failed to load owns the title, for a missing job and for an unreachable host',async()=>{
 for(const error of [Object.assign(new Error('This item is no longer available.'),{status:404}),Object.assign(new Error('x'),{status:500})]){
  document.title='Write a poem · Working · Faravan';
  const api=createFakeApi({});
  const view=await mount(h(Job,jobProps(api)));
  await api.fail(/jobs\/b/,error);
  assert.doesNotMatch(document.title,/Working|Write a poem/);
  assert.match(document.title,/^.+ · Faravan$/);
  assert.notEqual(document.title,'Loading job · Faravan');
  assert.ok(view.text().includes(document.title.replace(' · Faravan','')),'the title names what the page says: '+document.title);
  view.unmount?.();
 }
});
test('the title follows Working, then Loading result, then Ready while the global list lags',async()=>{
 const view=await mount(h(JobHead,{vm:{pill:{kind:'run',word:'Working'}},title:'Write a poem'}));
 assert.equal(document.title,'Write a poem · Working · Faravan');
 await view.rerender(h(JobHead,{vm:{loading:true,pill:{kind:'off',word:'Working'}},title:'Write a poem'}));
 assert.equal(document.title,'Write a poem · Loading result · Faravan');
 await view.rerender(h(JobHead,{vm:{pill:{kind:'on',word:'Ready to review'}},title:'Write a poem'}));
 assert.equal(document.title,'Write a poem · Ready to review · Faravan');
});
test('leaving a job page for another page resets the title even before approvals have loaded',async()=>{
 const api=createFakeApi({});
 await mount(h(App,{api,takeJoinLink:()=>''}));
 assert.equal(document.title,'Loading job · Faravan');
 location.hash='#/circles';window.dispatchEvent(new Event('hashchange'));await flush();
 assert.equal(document.title,'Faravan');
});
