import {advance, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Lend} from './lend.jsx';
import {projectLendingState, transitionalLendingProjection} from '../../../lib/v1/state-projection.mjs';
import {effectiveState} from '../../../lib/v1/lending-state.mjs';
import {lendingSummary} from '../../../lib/v1/lending-summary.mjs';

// Judge r9 O-E: on a phone, Lending said "Stopping … job" with no way to open that job. The link is named like the
// desktop sidebar's link and goes to the job page of the attempt that is stopping.
beforeEach(()=>resetPage('#/lend'));
afterEach(teardown);
const digest='sha256:'+'ab'.repeat(32);
const circle={id:'weekend',name:'Weekend projects',origin:'http://x'};
const agents=[{id:'codex',useForLending:true,installed:true,signedIn:true,run:{},product:{}}];
const lending={enabled:true,circle:'weekend',mode:'ask',status:'idle',paused:false,current:null,
  limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30}};
// The producer's own tuple for a pending stop: lending on, execution stopping on attempt-1.
const stopping=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'stopping',job:'attempt-1'}},dailyLimitReached:false});
const data=jobs=>({readiness:{ready:true,checks:[]},approvals:[],activity:[],jobs,
  home:{state:'ready',lending,execution:{person:'Alex Example'},lendingProjection:stopping}});
const props=jobs=>({api:{get:async()=>({enabled:true})},agents,lending,circles:[circle],circle:'weekend',selected:circle,members:[],refresh(){},setDialog(){},setCircle(){},
  mutate:async()=>({}),data:data(jobs)});
const stoppingLinks=()=>[...document.querySelectorAll('a')].filter(a=>/^Stopping .+ job/.test(a.textContent.trim()));

test('at 390 px a stopping job links to its job page, named like the sidebar link',async()=>{
  window.happyDOM.setWindowSize({width:390,height:844});
  await mount(h(Lend,props([{job_digest:digest,circle:{id:'weekend',name:'Weekend projects'},current_attempt:{attempt_id:'attempt-1',holder:'device-key'}}])));
  assert.match(document.querySelector('h2.headline').textContent,/^Stopping .+ job$/);
  const links=stoppingLinks();
  assert.equal(links.length,1,'one link to the job being stopped');
  assert.equal(links[0].getAttribute('href'),'#/job/'+encodeURIComponent(digest)+'/weekend');
});

test('no job link when the stopping job is missing from the job list',async()=>{
  window.happyDOM.setWindowSize({width:390,height:844});
  await mount(h(Lend,props([])));
  assert.match(document.querySelector('h2.headline').textContent,/^Stopping .+ job$/);
  assert.deepEqual(stoppingLinks().map(a=>a.getAttribute('href')),[]);
});

test('F5: missing stopping job retains a status refresh without claiming cessation',async()=>{
 let refreshed=0;
 const view=await mount(h(Lend,{...props([]),refresh:async()=>{refreshed++;}}));
 assert.match(document.body.textContent,/Stop requested\. Confirmation is still pending\./);
 const action=view.button('Check stop status');
 await click(action);assert.equal(refreshed,1);
 assert.match(document.querySelector('h2.headline').textContent,/^Stopping/);
 assert.doesNotMatch(document.querySelector('h2.headline').textContent,/Job stopped/);
 await view.unmount();
});

test('F5: stop recovery preserves unverified and report-pending evidence and disappears after confirmed idle',async()=>{
 for(const reason of ['cessation_unverified','stop_report_pending']){
  const p=props([]);
  p.data.home.lendingProjection={...stopping,admission:'blocked',admissionReason:reason};
  const view=await mount(h(Lend,p));
  assert.ok(view.button('Check stop status'));
  assert.match(document.body.textContent,/This computer is finishing sandbox cleanup/);
  assert.match(document.querySelector('h2.headline').textContent,/Stopping Alex Example’s job/);
  assert.doesNotMatch(document.body.textContent,/Stop requested\. Confirmation is still pending\./,
   'generic pending text must not contradict specialized producer evidence');
  await view.unmount();
 }
 const p=props([]);
 p.data.home.lendingProjection=projectLendingState({effective:{intent:{on:false,state:'off'},execution:{state:'idle'}},dailyLimitReached:false});
 const view=await mount(h(Lend,p));
 assert.equal(document.querySelector('h2.headline').textContent,'Lending is off');
 assert.ok(![...document.querySelectorAll('button')].some(b=>b.textContent==='Check stop status'));
 await view.unmount();
});

for(const state of ['running','finishing']){
 test('F4: at 390 px '+state+' keeps the matching job reachable',async()=>{
  window.happyDOM.setWindowSize({width:390,height:844});
  const p=props([
   {job_digest:'other-job',current_attempt:{attempt_id:'other-attempt'}},
   {job_digest:digest,circle:{id:'team/with space'},current_attempt:{attempt_id:'attempt-1'}}
  ]);
  p.data.home.lendingProjection={...stopping,execution:state,evidence:{...stopping.evidence,executionState:state}};
  const view=await mount(h(Lend,p));
  const links=[...document.querySelectorAll('.exec a')];
  assert.equal(links.length,1);
  assert.match(links[0].textContent,/^Open job/);
  assert.equal(links[0].getAttribute('href'),'#/job/'+encodeURIComponent(digest)+'/'+encodeURIComponent('team/with space'));
  assert.doesNotMatch(document.querySelector('.hero').textContent,/delivered|delivery succeeded|ready to review/i);
  assert.ok(![...document.querySelectorAll('a')].some(a=>a.textContent.startsWith('View finished jobs')));
  await view.unmount();
 });
}

test('the phone keeps the same job reachable while status refreshes and the job finishes', async () => {
  window.happyDOM.setWindowSize({width:390,height:844});
  const p=props([{job_digest:digest,circle,current_attempt:{attempt_id:'attempt-1'}}]);
  const projection = state => projectLendingState({dailyLimitReached:false,effective:{
    intent:{on:true,state:'ready'},execution:{state,job:'attempt-1'},
  }});
  const render = (lendingProjection, person) => h(Lend,{...p,data:{...p.data,home:{...p.data.home,
    lending:{...p.lending,enabled:false,status:'off'},lendingProjection,execution:{person},
  }}});
  const running=projection('running');
  const view=await mount(render(running,'Alex'));
  const jobLink = () => view.$('.exec a')?.getAttribute('href');
  const href='#/job/'+encodeURIComponent(digest)+'/weekend';
  assert.equal(jobLink(),href);
  const refreshing=transitionalLendingProjection(running);
  assert.equal(refreshing.admission,'blocked');
  assert.equal(refreshing.admissionReason,'readiness_changed');
  await view.rerender(render(refreshing,'Alex'));
  assert.equal(jobLink(),href);
  assert.match(view.$('.headline').textContent,/^Running/);
  assert.equal(view.button('Stop Alex’s job…')?.disabled,false);
  await view.rerender(render(projection('finishing')));
  assert.equal(jobLink(),href);
  assert.equal(view.$('.headline').textContent,'Finishing a job');
});

test('F4: after execution is idle Lending links to history without claiming delivery',async()=>{
 const p=props([]);
 p.data.jobs=[{state:'failed',job_digest:'f'.repeat(64)}];
 p.data.home.lendingProjection=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false});
 const view=await mount(h(Lend,p));
 const links=[...document.querySelectorAll('a')].filter(a=>a.textContent.startsWith('View finished jobs'));
 assert.equal(links.length,1);
 assert.equal(links[0].getAttribute('href'),'#/jobs');
 assert.equal(document.querySelector('.exec'),null);
 assert.doesNotMatch(document.querySelector('.hero').textContent,/delivered|delivery succeeded|ready to review/i);
 await view.unmount();
});

test('legacy recovery shows its exact command on the Lending page without executing it',async()=>{
 const command="env HOME='/synthetic sandbox' sbx rm --force wf-0123456789abcdef",p=props([]);
 p.lending={...p.lending,remediation:[{name:'wf-0123456789abcdef',home:'/synthetic sandbox',command}]};
 p.data.home.lendingProjection={...stopping,admission:'blocked',admissionReason:'cessation_unverified'};
 const view=await mount(h(Lend,p));
 assert.ok(document.body.textContent.includes(command));
 assert.match(document.body.textContent,/only if this install created the job/);
 assert.equal([...document.querySelectorAll('button')].some(button=>button.textContent.includes(command)),false);
 await view.unmount();
});

test('Lend keeps the same Stop action and offers one retry after an expired timed Resume fails', async () => {
 const now=Date.UTC(2026,10,20,16,0,40),deadline=now+35_000;
 installClock(now);
 const attemptId='attempt-1',person='Alex',stopLabel='Stop Alex’s job…';
 const jobs=[{job_digest:digest,circle,current_attempt:{attempt_id:attemptId}}];
 const api=createFakeApi({'lending/history-learning':{enabled:false}});
 const p=props(jobs);
 let confirm;
 const snapshot=({pauseUntil=null,resuming=false,resumeError=null,active=true}={})=>{
  const evidence=[{id:'codex',name:'Codex',enabled:true,installed:true,signedIn:true}];
  const lendingPolicy={accounts:[{provider:'codex',decision:{availability:{admitted:true}}}]};
  const effective=effectiveState({intent:'on',pause_until:pauseUntil,now:Date.now(),resuming,resumeError,
   agents:evidence,blocking:{docker:{installed:true,running:true,signedIn:true},circle:{reachable:true},agents:evidence},
   current:active?attemptId:null,launched:active,person:active?person:null});
  if(effective.intent.state==='ready')effective.admission={reason:active?'busy':null};
  const lendingProjection=projectLendingState({effective,dailyLimitReached:false});
  const summary=lendingSummary(lendingProjection,{person:effective.execution.person,blockers:effective.lending_blockers,
   until:effective.intent.until,now:Date.now(),lendingAccounts:lendingPolicy.accounts,selectedAgents:['codex']});
  return {...effective,lendingProjection,summary,lendingPolicy,
   lending:{...lending,enabled:effective.intent.state==='ready',pause_until:pauseUntil,current:effective.execution.job??null}};
 };
 const vnode=home=>h(Lend,{...p,api,lending:home.lending,data:{...p.data,home},
  mutate:(path,body)=>api.post(path,body),setDialog:dialog=>{confirm=dialog.onConfirm;}});
 const view=await mount(vnode(snapshot()));
 await api.answer('lending/history-learning');
 const reason=()=>view.$('.lstate p.t-2').textContent;
 const resumeButtons=()=>view.$$('.hero button').filter(button=>button.textContent.trim()==='Resume now');
 const assertJob=headline=>{
  assert.equal(view.$('h2.headline').textContent,headline);
  assert.equal(view.$('.exec a')?.getAttribute('href'),'#/job/'+encodeURIComponent(digest)+'/weekend');
  const stop=view.button(stopLabel);
  assert.ok(stop);
  assert.equal(stop.disabled||stop.getAttribute('aria-disabled')==='true',false);
 };
 assertJob('Running Alex’s job');
 const timed=snapshot({pauseUntil:deadline});
 await view.rerender(vnode(timed));
 assert.match(reason(),/Paused until 10:01 AM/,'a future deadline is still visible');
 await advance(35_000,30_000);

 const pending=snapshot({pauseUntil:deadline,resuming:true});
 await view.rerender(vnode(pending));
 assert.equal(pending.intent.resuming,true);
 assert.equal(pending.lendingProjection.admission,'blocked');
 assert.equal(pending.lendingProjection.executionJob,attemptId);
 assertJob('Finishing Alex’s job');
 assert.equal(reason(),'Paused. No new jobs start.','the fresh read outranks the previous UI clock tick');
 assert.doesNotMatch(view.text(),/Ready for requests|Paused until/i);
 await advance(25_000,25_000);
 await view.rerender(vnode(timed));
 assert.equal(reason(),'Paused. No new jobs start.','the old summary ages out while admission stays blocked');

 const fail=snapshot({pauseUntil:deadline,resumeError:'network_error'});
 await view.rerender(vnode(fail));
 assert.equal(fail.lendingProjection.admission,'blocked');
 assert.equal(fail.lendingProjection.admissionReason,'conditions_unavailable');
 assertJob('Finishing Alex’s job');
 assert.equal(reason(),'Lending could not resume. No new jobs start.');
 assert.doesNotMatch(view.text(),/Ready for requests|Paused until/i);
 await click(view.button(stopLabel));
 await confirm();
 assert.deepEqual(api.postsOf('lending/stop'),[{path:'lending/stop',body:{attemptId,confirmed:true}}]);

 const failedWrite=Promise.withResolvers();
 api.table['lending/resume']=failedWrite.promise;
 assert.equal(resumeButtons().length,1);
 await click(resumeButtons()[0]);
 failedWrite.reject(Object.assign(new Error('fixture host unavailable'),{code:'network_error',status:409}));
 await flush();
 const [retry,...duplicates]=resumeButtons();
 assert.ok(retry);
 assert.equal(duplicates.length,0);
 assert.equal(retry.getAttribute('aria-disabled'),null);
 assert.match(retry.closest('.action').querySelector('.feedback').textContent,/hosting this circle cannot be reached/);

 const retryWrite=Promise.withResolvers();
 api.table['lending/resume']=retryWrite.promise;
 await click(retry);
 assert.deepEqual(api.postsOf('lending/resume'),Array.from({length:2},()=>({path:'lending/resume',body:{circle:circle.id}})));
 await view.rerender(vnode(pending));
 const recovered=snapshot();
 retryWrite.resolve(recovered.lending);
 await flush();
 assertJob('Finishing Alex’s job');
 await view.rerender(vnode(recovered));
 assert.equal(recovered.lendingProjection.admissionReason,'busy');
 assertJob('Running Alex’s job');
 assert.doesNotMatch(view.text(),/Ready for requests/);
 await view.rerender(vnode(snapshot({active:false})));
 assert.equal(view.$('h2.headline').textContent,'Ready for requests');
 assert.equal(view.$('.exec'),null);
 assert.equal(resumeButtons().length,0);
});
