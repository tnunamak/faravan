import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './api.mjs';
import {ResultWorkspace} from './result-workspace.jsx';
import {renderFixture} from './render.test-helper.mjs';
const data={format:'diff',files:[{path:'a.js',status:'modified'}],diffstat:{files:1,insertions:1,deletions:1},diff:'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n'};
test('diff defaults to wrapping and exposes a soft-wrap choice without losing file stats',()=>{
 const html=renderFixture(ResultWorkspace,{data});
 assert.match(html,/review-wrap/);assert.match(html,/<input[^>]+checked[^>]*\/>Soft wrap/);
 assert.match(html,/\+1/);assert.match(html,/−1/);
});
test('result refusal uses only registered copy without exposing HTTP status',async()=>{
 const message='This result is still being unpacked. Try again in a moment.';
 const api=createApi('fixture',async()=>new Response(JSON.stringify({code:'result_unavailable',message}),{status:409}));
 await assert.rejects(api.get('jobs/x/changes'),error=>/Check the job’s current state/.test(error.message) && error.serverMessage===undefined);
});
test('missing human message provides recovery without raw status',async()=>{
 const api=createApi('fixture',async()=>new Response(JSON.stringify({code:'result_unavailable'}),{status:409}));
 await assert.rejects(api.get('jobs/x/changes'),error=>!error.message.includes('409') && /Check the job’s current state/.test(error.message));
});
test('copying a shortened message downloads the complete original',async()=>{
 const {copyOutputMessage}=await import('./result-reader.jsx');
 const copied=[],paths=[];
 const saved=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});
 try {
  await copyOutputMessage({download:async path=>{paths.push(path);return {blob:new Blob(['Full message'])};}},{markdown:'Full…',truncated:true,url:'/api/jobs/x/message'});
  assert.deepEqual(paths,['jobs/x/message']);assert.deepEqual(copied,['Full message']);
 } finally {if(saved)Object.defineProperty(globalThis,'navigator',saved);else delete globalThis.navigator;}
});

import {BorrowerVerdict, saveBorrowerOutcome} from './jobs.jsx';
import {readFileSync} from 'node:fs';
test('borrower verdicts persist and clear through the server outcome endpoint',async()=>{
 const calls=[], saved={verdict:'used',updatedAt:'server-time'};
 const api={post:async(path,body)=>{calls.push([path,body]);return {borrowerOutcome:body.outcome===null?null:saved};}};
 for(const verdict of ['used','needs-more-work','unused']) {
  assert.equal(await saveBorrowerOutcome(api,'jobs/job','circle',verdict),saved);
  assert.deepEqual(calls.at(-1),['jobs/job/outcome',{circle:'circle',outcome:{verdict}}]);
 }
 assert.equal(await saveBorrowerOutcome(api,'jobs/job','circle',null),null);
 assert.deepEqual(calls.at(-1),['jobs/job/outcome',{circle:'circle',outcome:null}]);
 await assert.rejects(saveBorrowerOutcome({post:async()=>{throw new Error('result_not_delivered');}},'jobs/job','circle','used'),/result_not_delivered/);
});
test('result verdict shows the saved choice, alternatives and clear without implying download is use',()=>{
 for(const [verdict,label] of [['used','Used it'],['needs-more-work','Needs more work'],['unused','Didn’t use it']]) {
  const html=renderFixture(BorrowerVerdict,{api:{},base:'jobs/job',circle:'circle',outcome:{verdict}});
  assert.match(html,/aria-label="Did this result help\?"/);
  assert.ok(html.includes('Saved: '+label+'. Choose another to change it.'));
  assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
  assert.match(html,/Clear choice/);
 }
 const empty=renderFixture(BorrowerVerdict,{api:{},base:'jobs/job',circle:'circle',outcome:null});
 assert.match(empty,/No choice saved yet/);assert.doesNotMatch(empty,/Clear choice/);
 const source=readFileSync(new URL('./jobs.jsx',import.meta.url),'utf8');
 assert.match(source,/page\.result && facts\.own && job\.canSetBorrowerOutcome === true && <BorrowerVerdict/);
 assert.match(source,/outcome=\{job\.borrowerOutcome\}/);
 assert.match(source,/void state\.reload\(\); void refresh\?\.\(\)/);
});

test('verdict acknowledgement survives stale polls and clear, but never crosses API/job/circle identity',async()=>{
 const {createBorrowerVerdictSession}=await import('./jobs.jsx');
 const session=createBorrowerVerdictSession(),responses=[];
 const api={post:()=>new Promise(resolve=>responses.push(resolve))};
 const target=session.target(api,'jobs/one','circle');
 const saving=session.save(target,'used');
 assert.equal(target.pending,true);
 assert.equal(await session.save(target,'unused'),false,'same-tick duplicate must not post');
 assert.equal(session.read(target,{verdict:'unused'}).verdict,'unused','no optimistic save');
 responses.shift()({borrowerOutcome:{verdict:'used'}});
 assert.equal(await saving,true);
 assert.equal(session.read(target,{verdict:'unused'}).verdict,'used','old poll cannot undo acknowledgement');
 assert.equal(session.read(target,{verdict:'used'}).verdict,'used');
 const clearing=session.save(target,null);responses.shift()({borrowerOutcome:null});assert.equal(await clearing,true);
 assert.equal(session.read(target,{verdict:'used'}),null,'old poll cannot undo clear');
 assert.equal(session.read(target,null),null);
 for(const [nextApi,nextBase,nextCircle] of [[{},'jobs/one','circle'],[api,'jobs/two','circle'],[api,'jobs/one','other']]){
  const old=session.target(api,'jobs/one','circle'),pending=session.save(old,'used');
  const next=session.target(nextApi,nextBase,nextCircle);
  responses.shift()({borrowerOutcome:{verdict:'used'}});
  assert.equal(await pending,false);assert.equal(session.read(next,null),null);
 }
 const mounted=session.target(api,'jobs/one','circle'),late=session.save(mounted,'used');
 session.invalidate(mounted);responses.shift()({borrowerOutcome:{verdict:'used'}});
 assert.equal(await late,false,'unmounted control cannot apply a late response');
});

import {h} from 'preact';
import {mount, click, teardown, resetPage} from './mounted.test-helper.mjs';
test('mounted: clicking a verdict posts the outcome and the saved choice shows',async t=>{
 t.after(teardown);resetPage();
 const calls=[];let changed=0;
 const api={post:async(path,body)=>{calls.push([path,body]);return {borrowerOutcome:body.outcome===null?null:{verdict:body.outcome.verdict,updatedAt:'t'}};}};
 const view=await mount(h(BorrowerVerdict,{api,base:'jobs/job-1',circle:'circle-1',outcome:null,onChanged:()=>{changed++;}}));
 assert.match(view.text(),/No choice saved yet/);
 await click(view.button('Used it'));
 assert.deepEqual(calls,[['jobs/job-1/outcome',{circle:'circle-1',outcome:{verdict:'used'}}]]);
 assert.equal(changed,1);
 assert.match(view.text(),/Saved: Used it\. Choose another to change it\./);
 assert.equal(view.button('Used it').getAttribute('aria-pressed'),'true');
 await click(view.button('Needs more work'));
 assert.deepEqual(calls.at(-1),['jobs/job-1/outcome',{circle:'circle-1',outcome:{verdict:'needs-more-work'}}]);
 assert.match(view.text(),/Saved: Needs more work/);
 await click(view.button('Clear choice'));
 assert.deepEqual(calls.at(-1),['jobs/job-1/outcome',{circle:'circle-1',outcome:null}]);
 assert.match(view.text(),/No choice saved yet/);
});
test('mounted: a failed verdict save shows the error and no saved choice',async t=>{
 t.after(teardown);resetPage();
 const api={post:async()=>{throw new Error('result_not_delivered');}};
 const view=await mount(h(BorrowerVerdict,{api,base:'jobs/job-1',circle:'circle-1',outcome:null}));
 await click(view.button('Didn’t use it'));
 assert.ok(view.$('[role="alert"]'),'an error is shown');
 assert.match(view.text(),/No choice saved yet/);
});
