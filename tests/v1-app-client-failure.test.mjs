import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {clientFailure} from '../lib/v1/client.mjs';
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const slice=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const failure=()=>Object.assign(new Error('offline'),{code:'http_error',status:502,retryable:true});
function fixture(){
 const c={clientFailure,settings:{intent:'on',enabled:false,paused:false,pause_until:null,activeCircle:'circle'},
  closed:false,quitting:false,safetyEpoch:0,safetyIntentEpoch:0,stopReceipt:null,stopFlights:new Map(),
  lender:null,backgroundCheck:null,resumeFailed:null,timedResume:null,agentCheckTimeoutMs:1000,
  options:{blockerRecheckMs:15000},time:1000,machineHold:()=>null,updateAdmissionHeld:()=>false,
  serialize:work=>Promise.resolve().then(work),lenderEvidence:async()=>({due:false}),events:[],
  save:async()=>{},projectMembership:()=>({phase:'approved'}),applyJoinMode:async()=>{},
  device:{listCircles:async()=>[]},stopIdleLender:async()=>{},policy:null,clearTimeout:()=>{}};
 c.now=()=>c.time;c.performance={now:()=>c.time};c.emit=(...args)=>c.events.push(args);
 runInNewContext(slice('  function autoResume','  function schedulePauseEnd')+'\nthis.controls={autoResume,retryFailedResume};',c);
 c.startLending=async()=>{throw failure();};return c;
}
test('a timed HTTP failure records an unreachable host and remains retryable',async()=>{
 const c=fixture();c.settings.pause_until=100;
 await assert.rejects(c.controls.autoResume('circle',{pauseUntil:100}));await c.backgroundCheck;
 assert.equal(c.timedResume.code,'network_error');assert.equal(c.resumeFailed.code,'network_error');
 assert.deepEqual(structuredClone(c.events[0]),['lending',{status:'resume-failed',reason:'network_error'}]);
 let starts=0;c.startLending=async()=>{starts++;};c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,1);
});
test('a recovered capped retry starts the next outage at the base delay',async()=>{
 const c=fixture();await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 for(let i=0;i<8;i++){c.controls.retryFailedResume();await c.backgroundCheck;c.time+=300000;}
 assert.equal(runInNewContext('resumeRetryDelay',c),300000);
 c.startLending=async()=>{};c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(runInNewContext('resumeRetryAt',c),0);assert.equal(runInNewContext('resumeRetryDelay',c),0);
 c.startLending=async()=>{throw failure();};await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(runInNewContext('resumeRetryDelay',c),15000);
});
test('failed circle adoption retains HTTP retry information and recovers automatically',async()=>{
 const c=fixture();c.settings.activeCircle=null;
 const adopt=runInNewContext(slice('  async function adoptJoinedCircle(circle) {','  // The person whose job')+'\nadoptJoinedCircle',c);
 await adopt({id:'joined',origin:'https://circle.test',name:'Friends'});
 assert.equal(c.resumeFailed.code,'network_error');assert.equal(c.resumeFailed.status,502);
 let starts=0;c.startLending=async()=>{starts++;c.settings.enabled=true;};
 c.controls.retryFailedResume();await c.backgroundCheck;assert.equal(starts,1);assert.equal(c.resumeFailed,null);
});
for(const status of [502,503])test(`approval claim HTTP ${status} does not report the card closed`,async()=>{
 const events=[],pending={card:{id:'card',identity:{},jobDigest:'job',offer:true},
  claimResult:Promise.resolve({accepted:false,code:'http_error',status,retryable:true}),finish:()=>{}};
 const c={clientFailure,approvals:new Map([['card',pending]]),checkApprovalAcceptance:async()=>({}),
  recordJobDecision:async()=>({}),emit:(...args)=>events.push(args),jobTaker:async()=>{throw Error('must not query the sick host');}};
 const apply=runInNewContext(slice('  async function applyApproval(id,verb,pending,actor) {','  // Who holds a job this computer lost:')+'\napplyApproval',c);
 await assert.rejects(apply('card','accept',pending),{code:'network_error',status,retryable:true});
 assert.equal(events.some(([,card])=>card.state==='closed'),false);
});
test('running lender HTTP refusal never enters automatic recovery',async()=>{
 const c=fixture();c.endedBy={code:'circle_unreachable',status:403,retryable:false};c.pool={};c.lender=c.pool;
 c.poolController={signal:{aborted:false}};c.selected={name:'Friends'};c.lendingView=()=>({});c.nudgeHeartbeat=()=>{};
 runInNewContext('(()=>{'+slice('        if(lender!==pool||closed||poolController.signal.aborted)return;','      });\n    settle();')+'})()',c);
 let starts=0;c.startLending=async()=>{starts++;};c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,0);
});
test('Off clears pending backoff and a later On starts with the base delay',async()=>{
 const c=fixture();await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 c.controls.retryFailedResume();await c.backgroundCheck;
 assert.ok(runInNewContext('resumeRetryAt',c)>c.time);
 Object.assign(c,{parts:['api','lending','off'],cancelResumes:()=>{},policy:null,approvals:new Map(),lendingRuntime:{},
  schedulePauseEnd:()=>{},paceEventId:()=> 'off-event',lendingView:()=>({}),readinessChanged:()=>{},closeReadingSandboxes:async()=>{}});
 const begin="            if(['off','pause'].includes(parts[2])) {";
 const end=source.indexOf("          if(parts[1]==='approvals'",source.indexOf(begin));
 const route=source.slice(source.indexOf(begin),source.lastIndexOf('\n          }',end));
 const off=runInNewContext('(async function(input){'+route+'})',c);
 await off({});
 assert.equal(c.resumeFailed,null);assert.equal(runInNewContext('resumeRetryAt',c),0);
 assert.equal(runInNewContext('resumeRetryDelay',c),0);
 let starts=0;c.startLending=async()=>{starts++;throw failure();};
 for(let i=0;i<3;i++){c.time+=15000;c.controls.retryFailedResume();await c.backgroundCheck;}
 assert.equal(starts,0,'Off suppresses all automatic starts');
 c.settings.intent='on';await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,2,'the new outage is immediately eligible for recovery');
 assert.equal(runInNewContext('resumeRetryDelay',c),15000);
});
for(const kind of ['manual resume','fresh pool'])test(`${kind} clears old backoff only after a successful start`,async()=>{
 const c=fixture();runInNewContext('resumeRetryAt=300000;resumeRetryDelay=300000;',c);
 c.resumeFailed={code:'network_error'};c.lenderStoppedJob=null;
 c.startLendingAttempt=async()=>({enabled:true});
 const start=runInNewContext(slice('  async function startLending(circle,options={}) {','  async function resumeDurableCandidate')+'\nstartLending',c);
 await start('circle',{resume:kind==='manual resume'});
 assert.equal(c.resumeFailed,null);assert.equal(runInNewContext('resumeRetryAt',c),0);
 assert.equal(runInNewContext('resumeRetryDelay',c),0);
});
test('a local update hold is retried after normalization through automatic resume',async()=>{
 const c=fixture();c.startLending=async()=>{throw Object.assign(new Error('updating'),{code:'update_in_progress',status:409});};
 await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 let starts=0;c.startLending=async()=>{starts++;};c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,1);
});
test('explicit timed resume uses an unreachable-host failure marker',async()=>{
 const c=fixture();c.settings.pause_until=100;c.startLendingAttempt=async()=>{throw failure();};
 const start=runInNewContext(slice('  async function startLending(circle,options={}) {','  async function resumeDurableCandidate')+'\nstartLending',c);
 await assert.rejects(start('circle',{resume:true}),{code:'http_error'});
 assert.equal(c.timedResume.state,'failed');assert.equal(c.timedResume.code,'network_error');
 assert.equal(c.settings.pause_until,100);
});

for(const automatic of [false,true])for(const retryable of [true,false])test(`${automatic?'automatic resume':'explicit On'} preserves a loop failure published during the final save (${retryable?'retryable':'refused'})`,async()=>{
 const c=fixture();let rejectLoop,releaseSave,saveStarted;
 const saving=new Promise(resolve=>{saveStarted=resolve;});
 const saved=new Promise(resolve=>{releaseSave=resolve;});
 c.save=()=>{saveStarted();return saved;};
 c.pool={start:()=>new Promise((resolve,reject)=>{rejectLoop=reject;})};
 Object.assign(c,{lender:c.pool,controller:{signal:{aborted:false}},selected:{id:'circle',name:'Friends'},
  recovery:false,recoveringStop:false,epoch:0,settle:()=>{},heartbeat:{beat:async()=>{}},
  lendingView:()=>({enabled:c.settings.enabled}),nudgeHeartbeat:()=>{},lenderStoppedJob:null});
 c.poolController=c.controller;c.settings.enabled=false;
 const tail=slice('    let endedBy=null;','  // The rule the app made for a circle');
 c.startLendingAttempt=runInNewContext('(async function(circle,{resume=false,auto=false}={}){settings.enabled=true;'+tail.slice(0,tail.lastIndexOf('  }'))+'})',c);
 c.startLending=runInNewContext(slice('  async function startLending(circle,options={}) {','  async function resumeDurableCandidate')+'\nstartLending',c);
 const starting=automatic?c.controls.autoResume('circle'):c.startLending('circle');
 await saving;
 rejectLoop(retryable?failure():{code:'http_error',status:403,retryable:false});
 await c.loop;
 const published=c.resumeFailed;
 assert.equal(published.code,retryable?'network_error':'lender_stopped');
 releaseSave();await starting;await c.backgroundCheck;
 assert.equal(c.resumeFailed,published,'successful save must preserve the newer loop failure');
 assert.equal(c.settings.intent,'on');assert.equal(c.settings.enabled,false);assert.equal(c.lender,null);
 let starts=0;c.startLending=async()=>{starts++;throw failure();};
 c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,retryable?1:0);
 if(retryable){assert.equal(runInNewContext('resumeRetryDelay',c),15000);assert.ok(runInNewContext('resumeRetryAt',c)>c.time);}
});

test('Stop recovery preserves a failure published while durable resume is pending',async()=>{
 const c=fixture();let release;
 Object.assign(c,{policy:{},pendingAttempts:()=>[],resumeDurableCandidate:()=>new Promise(resolve=>{release=resolve;}),
  lendingView:()=>({}),readinessChanged:()=>{},lender:{getState:()=>({}),resume:()=>{}}});
 const resume=runInNewContext(slice('  async function resumeAfterStopRecovery','  // Owner Stop requests')+'\nresumeAfterStopRecovery',c);
 const recovering=resume({attemptId:'attempt'});
 await Promise.resolve();await Promise.resolve();
 const published={code:'network_error'};c.resumeFailed=published;
 release();await recovering;
 assert.equal(c.resumeFailed,published);
});
test('circle adoption preserves a failure published by the new pool',async()=>{
 const c=fixture();c.settings.activeCircle=null;
 const published={code:'network_error'};
 c.startLending=async()=>{c.resumeFailed=published;};
 const adopt=runInNewContext(slice('  async function adoptJoinedCircle(circle) {','  // The person whose job')+'\nadoptJoinedCircle',c);
 await adopt({id:'joined',origin:'https://circle.test',name:'Friends'});
 assert.equal(c.resumeFailed,published);
});
test('the retry worker waits 15, 30, 60, 120, 240 then 300 s between attempts on an injected clock, never earlier',async()=>{
 const c=fixture();let mono=5000;c.options.monotonic=()=>mono;
 c.performance={now:()=>1};
 await assert.rejects(c.controls.autoResume('circle'));await c.backgroundCheck;
 let starts=0;c.startLending=async()=>{starts++;throw failure();};
 const gaps=[];let last=null;
 for(let step=0;step<400&&gaps.length<7;step++){
  const before=starts;c.controls.retryFailedResume();await c.backgroundCheck;
  if(starts>before){if(last!==null)gaps.push(mono-last);last=mono;}
  mono+=5000;
 }
 assert.deepEqual(gaps,[15000,30000,60000,120000,240000,300000,300000]);
 const before=starts;mono=last+299999;c.controls.retryFailedResume();await c.backgroundCheck;
 assert.equal(starts,before,'one millisecond early is still too early');
});
