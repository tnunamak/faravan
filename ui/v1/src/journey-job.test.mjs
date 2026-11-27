import {mount,resetPage,teardown,createFakeApi,installClock,click,flush} from './mounted.test-helper.mjs';
import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job,Jobs} from './jobs.jsx';
import {JobHead,AppliedCard} from './job-view.jsx';
import {ResultProperties} from './result-properties.jsx';
import {jobStatusVM,jobPeopleVM,jobVM,appliedLineVM,applyPreviewVM} from './view-models.mjs';
import {checkLineVM} from './check-line.mjs';
import {renderFixture,renderedText} from './render.test-helper.mjs';

beforeEach(()=>{resetPage('#/job/j/c');installClock();});
afterEach(teardown);
const circle={id:'c',name:'Weekend projects',origin:'http://fixture'};
const roster=names=>[{key_id:'owner',device_name:'sandpiper',personName:names?'Alex Example':''},{key_id:'friend',device_name:'kestrel',personName:names?'Maya Okafor':''}];
const devices=(viewer,names)=>({fingerprint:viewer,ownerName:names?(viewer==='owner'?'Alex Example':'Maya Okafor'):'',circles:[{circle:'c',members:roster(names)}]});
const record=(viewer,holder,state='running')=>({job_digest:'j',circle,state,current_attempt:{holder,execution_started_at:'2026-10-20T14:59:00Z'},historyIdentity:{author:holder==='owner'?'friend':'owner',deviceName:holder==='owner'?'kestrel':'sandpiper'},...(viewer!==holder?{local:{prompt:'Write a poem',title:'Write a poem'}}:{})});
const patch={format:'diff',diff:'',files:[],receipt:{harness:'codex'}};
async function jobView(job,identity,extra={}){
 const api=createFakeApi({'jobs/j':job,'jobs/j/progress':{entries:[]},'jobs/j/transcript':{text:JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Writing the poem.'}]}}),live:job.state==='running'},'jobs/j/prompt':{text:'Write a poem'},'jobs/j/changes':patch,'jobs/j/retention':{deletable:true},...extra});
 let dialog;
 const props={id:'j',requestedCircle:'c',api,circle:'c',circles:[circle],data:{devices:identity,jobs:[]},revision:0,draft:{},mutate:async()=>{},setDialog:value=>{dialog=value;},members:[],refresh:async()=>{}};
 const view=await mount(h(Job,props));for(let n=0;n<4;n++)await api.release();
 return {view,api,props,get dialog(){return dialog;}};
}

for(const viewer of ['owner','friend'])for(const own of [true,false])for(const names of [true,false]){
 test(`journey person matrix: ${viewer}, ${own?'own':'other'} computer, person ${names?'known':'unknown'}`,async()=>{
  const holder=own?viewer:viewer==='owner'?'friend':'owner',job=record(viewer,holder),identity=devices(viewer,names);
  const {view}=await jobView(job,identity);
  if(names)assert.doesNotMatch(view.text(),/sandpiper|kestrel/);
  // F1: without explicit freshness, the mounted feed must not repeat a present-execution claim.
  assert.doesNotMatch(view.text(),/Your (?:Codex|agent) is running|’s agent is working/);
  assert.match(view.text(),/Last agent update unavailable · Last visible output unavailable/);
  // Keep the original identity contract independently of the freshness-gated rendering.
  const people=jobPeopleVM(job,identity);
  const status=jobStatusVM(job,{role:own?'ran':'sent',...people});
  if(own)assert.match(status.headline,/Your (?:Codex|agent) is running/);
  else if(names)assert.match(status.headline,new RegExp((holder==='owner'?'Alex Example':'Maya Okafor')+'’s agent is working'));
 });
}
// Every state a person passes through, for every viewer: a device name never stands where a person's name is known.
for(const state of ['running','cancelled','result-accepted'])for(const viewer of ['owner','friend'])for(const own of [true,false])
 test(`no device names where people are known: ${state}, ${viewer}, ${own?'own':'other'} computer`,async()=>{
  const holder=own?viewer:viewer==='owner'?'friend':'owner';
  const job={...record(viewer,holder,state),...(state==='cancelled'?{runTiming:{stopRequestedAt:new Date(Date.now()-5000).toISOString()},compute_stopped:false}:{}),...(state==='result-accepted'?{result_digest:'r'}:{})};
  const {view}=await jobView(job,devices(viewer,true));
  if(state !== 'result-accepted')assert.doesNotMatch(view.text(),/sandpiper|kestrel/);
  else assert.match(view.text(),new RegExp(holder==='owner'?'sandpiper':'kestrel'));
  if(!own&&state==='running')assert.match(view.text(),/Stopping asks (?:Alex Example|Maya Okafor)’s computer/);
  if(own&&state!=='result-accepted')assert.doesNotMatch(view.text(),/(?:Alex Example|Maya Okafor)’s (?:agent|computer)/,'your own computer is never described in the third person');
 });
test('people resolve for a job with no identity and no device list yet',()=>{
 assert.deepEqual(jobPeopleVM({historyIdentity:null,current_attempt:null},null,undefined),{requester:'',lender:'',lenderDevice:'',ownRequest:false,ownRun:false});
 assert.equal(jobPeopleVM({local:{title:'x'}},{},[]).ownRequest,true);
});
test('a lender title uses the roster person before the device fallback',()=>{
 const job=record('friend','friend');
 assert.equal(jobVM(job,'ran',{devices:devices('friend',true)}).title,'Job for Alex Example');
});
test('stop copy names the sender and addresses the running viewer',()=>{
 const job={...record('friend','friend','cancelled'),runTiming:{stopRequestedAt:'2026-10-20T14:59:30Z'},compute_stopped:false};
 const vm=jobStatusVM(job,{role:'ran',lender:'Maya Okafor',requester:'Alex Example',now:Date.parse('2026-10-20T15:00:00Z')});
 assert.equal(vm.headline,'Alex Example asked to stop this job');assert.match(vm.text,/^Your computer hasn’t confirmed yet\./);
 assert.doesNotMatch(vm.headline,/kestrel|sandpiper/);
});
test('a delivered poem names the requester without project instructions',async()=>{
 const {view}=await jobView({...record('friend','friend','result-accepted'),result_digest:'r'},devices('friend',true),{'jobs/j/changes':{format:'message',message:{markdown:'Grey waves\nSad birds',url:'/message'},files:[]}});
 assert.doesNotMatch(view.text(),/Sent to Alex Example|Nothing more to do/);
 assert.doesNotMatch(view.text(),/sandpiper|add it to their project/);
 assert.match(view.text(),/Alex Example can read it and keep a copy/);assert.doesNotMatch(view.text(),/back with Tessa/);
});
test('a failed No-project job shows its recorded cause from the transcript',async()=>{
 const job={...record('owner','friend','failed'),current_attempt:{holder:'friend',state:'failed',execution_started_at:'2026-10-20T14:59:00Z',reason:{code:'execution_failed',phase:'run'}}};
 const cause='The worker could not open the requested input file in the No-project folder.';
 const transcript=JSON.stringify({type:'result',is_error:true,result:cause});
 const {view,api}=await jobView(job,devices('owner',true),{'jobs/j/transcript':{text:transcript,live:false}});
 assert.equal(api.count(path=>path.includes('/transcript')),1,'the failed job reads the recorded transcript');
 assert.match(view.text(),/Failure details/);
 assert.match(view.text(),/worker could not open the requested input file/);
});
test('properties says Ran on / Your computer only once',()=>{
 const text=renderedText(renderFixture(ResultProperties,{ownRun:true}));
 assert.match(text,/Ran on Your computer/);assert.doesNotMatch(text,/Ran on Ran on/);
});
test('branch confirmation states the outcome and gives separate desktop and phone instructions',()=>{
 const applied={branch:'faravan/poem',repo:'/home/sam/weekend-app'};
 assert.equal(appliedLineVM(applied).heading,'Added as branch faravan/poem');
 const html=renderFixture(AppliedCard,{applied});
 assert.match(html,/role="status"/);assert.match(html,/The branch is on your computer, in weekend-app\. Switch to it there\./);
 assert.match(html,/Copy command/);assert.match(html,/git switch/);
});
test('Delete navigates without waiting for a refresh and confirms on Jobs',async()=>{
 let finishRefresh;
 const current=await jobView({...record('owner','friend','cancelled'),current_attempt:null},devices('owner',true));
 await current.view.rerender(h(Job,{...current.props,refresh:()=>new Promise(resolve=>{finishRefresh=resolve;})}));
 await click(current.view.button('Delete this job…'));
 const deleting=current.dialog.onConfirm();await flush();
 assert.equal(location.hash,'#/jobs');
 await current.view.unmount();
 const jobs=await mount(h(Jobs,{api:current.api,circles:[circle],data:{jobs:[],devices:devices('owner',true)}}));
 assert.match(jobs.text(),/Job deleted/);
 finishRefresh?.();await deleting;
});
test('branch preview shows a familiar folder name and no internal job identifier',()=>{
 const vm=applyPreviewVM({repo:'/home/sam/code/weekend-app',branch:'faravan/result',files:1},{lender:'Maya Okafor',digest:'sha256:abcdef'});
 assert.equal(vm.adds.find(part=>part.strong&&part.text.includes('weekend-app')).text,'weekend-app');
 assert.doesNotMatch(vm.commit,/abcdef|job [a-f0-9]/);assert.match(vm.commit,/Maya Okafor/);
});
test('check caption gives the limitation without repeating the observed command',()=>{
 const vm=checkLineVM({cmd:'npm test',exit:0,observed_by:'sandbox'});
 assert.doesNotMatch(vm.note,/Faravan ran|npm test/);assert.match(vm.note,/agent could change/);
});
test('the document title follows the job status on the same open page',async()=>{
 const view=await mount(h(JobHead,{vm:{pill:{kind:'run',word:'Working'}},title:'Write a poem'}));
 assert.match(document.title,/Working/);
 await view.rerender(h(JobHead,{vm:{pill:{kind:'on',word:'Ready to review'}},title:'Write a poem'}));
 assert.match(document.title,/Ready to review/);assert.doesNotMatch(document.title,/Working/);
});
for(const viewer of ['owner','friend'])test('own job uses your agent and your job on '+viewer,async()=>{
 const job={...record(viewer,viewer),local:{title:'Write a poem',prompt:'Write a poem'}};
 const {view}=await jobView(job,devices(viewer,true));
 assert.doesNotMatch(view.text(),/Your agent is running your job|sandpiper|kestrel/);
 assert.match(view.text(),/Last agent update unavailable · Last visible output unavailable/);
 assert.equal(jobStatusVM(job,{ownRun:true,ownRequest:true}).headline,'Your agent is running your job');
});
test('a deleted job link gives a truthful way back instead of Refresh status',async()=>{
 const api=createFakeApi({});
 const view=await mount(h(Job,{id:'j',requestedCircle:'c',api,data:{devices:{}},circles:[circle],draft:{},members:[]}));
 await api.fail(/jobs\/j/,Object.assign(new Error('This item is no longer available. Refresh status.'),{status:404}));
 assert.match(view.text(),/This item is no longer available/);
 assert.match(view.text(),/Back to Jobs/);assert.doesNotMatch(view.text(),/Refresh status/);
});
test('the Job deleted notice survives a Jobs list that is still loading or failed to load',async()=>{
 sessionStorage.setItem('faravan-job-deleted','Job deleted');
 const jobs=await mount(h(Jobs,{api:createFakeApi({}),circles:[circle],data:{jobs:undefined,devices:devices('owner',true)},errors:{jobs:Object.assign(new Error('x'),{status:500})}}));
 assert.match(jobs.text(),/Job deleted/);assert.match(jobs.text(),/Jobs didn’t load/);
 assert.equal(sessionStorage.getItem('faravan-job-deleted'),null);
});
