import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionLog } from '../lib/v1/decision-log.mjs';
import { appFixture, api, waitFor } from './helpers/offers-jobs-fixture.mjs';

const jobInput = circle => ({circle:circle.id,git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40),prompt:'Synthetic own task.',harness:'codex'});
async function lend(app,circle) {
  await api(app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
}
const approvalEvents = async app => (await api(app,'/api/activity?after=0')).filter(e=>e.type==='approval');

test('ask mode accepts its own signed job without a pending card and records auto: own job', {timeout:60000}, async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const sent=await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await lend(lender.app,circle);
  await waitFor(()=>f.jobs.get(sent.jobDigest).state==='result-accepted','own signed result',30000);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  const events=await approvalEvents(lender.app);
  assert.deepEqual(events.map(e=>e.data.state),['accepting','accepted'],'consent is followed by the named claim acknowledgement, without a pending card');
  assert.ok(events.every(e=>e.data.auto==='own job'&&e.data.jobDigest===sent.jobDigest));
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
  const receipt=(await api(lender.app,'/api/decisions')).events.find(row=>row.jobDigest===sent.jobDigest);
  assert.equal(receipt.source,'own-job');
  assert.equal(receipt.surface,'local-api');
  assert.equal(receipt.decider.deviceKey,lender.app.device.keyId);
});

test('ask mode still waits for another member to be approved', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await lend(lender.app,circle);
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'other member approval');
  assert.equal(card.requester,owner.app.device.keyId);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.equal((await approvalEvents(lender.app)).some(e=>e.data.auto==='own job'),false);
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('own job falls back to pending review when acceptance protection is not ready', {timeout:60000}, async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const summary=lender.backend.protectionSummary;
  let jobChecks=0;
  lender.backend.protectionSummary=async(req,context)=>{
    const report=await summary(req,context);
    if(context?.source&&++jobChecks>=2)return {...report,sandbox_ready:false,satisfied:false};
    return report;
  };
  await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await lend(lender.app,circle);
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'unsafe own job review');
  assert.equal(card.requester,lender.app.device.keyId);
  assert.equal(card.protection.satisfied,false);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.equal((await approvalEvents(lender.app)).some(e=>e.data.auto==='own job'),false);
  const denied=await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
  assert.equal(denied.code,'protection_not_ready');
  await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
});

test('own job cannot auto-accept after its acceptance check outlasts the deadline', {timeout:60000}, async t=>{
  let offset=0;
  const f=await appFixture(t),{lender,circle}=await f.connect({clock:{now:()=>Date.now()+offset}});
  const summary=lender.backend.protectionSummary;
  let jobChecks=0;
  lender.backend.protectionSummary=async(req,context)=>{
    const report=await summary(req,context);
    if(context?.source&&++jobChecks===2)offset=Date.parse([...f.jobs.values()][0].job.payload.expires_at)-Date.now()+1;
    return report;
  };
  const original=await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  const payload={...f.jobs.get(original.jobDigest).job.payload,expires_at:new Date(Math.floor(Date.now()/1000)*1000+60000).toISOString().replace('.000Z','Z')};
  f.jobs.delete(original.jobDigest);
  const sent=await (await lender.app.device.client(circle.id)).submitJob(payload);
  await lend(lender.app,circle);
  await waitFor(async()=>(await api(lender.app,'/api/activity')).some(e=>e.type==='lending'&&e.data.status==='hidden'),'expired offer closes locally');
  assert.equal(f.jobs.get(sent.jobDigest).current_attempt,null,'expiry during preflight never claims the offer');
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  assert.equal((await approvalEvents(lender.app)).some(e=>e.data.auto==='own job'),false);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
});

test('turning lending off during the own-job acceptance check prevents acceptance', {timeout:60000}, async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const summary=lender.backend.protectionSummary;
  let jobChecks=0,release,checking=false,finishedCheck=false;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  lender.backend.protectionSummary=async(req,context)=>{
    const report=await summary(req,context);
    if(context?.source&&++jobChecks===2){checking=true;await held;finishedCheck=true;}
    return report;
  };
  const sent=await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await lend(lender.app,circle);
  await waitFor(()=>checking,'held own job acceptance');
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  release();
  await waitFor(()=>finishedCheck,'cancelled own job check returns');
  assert.equal(f.jobs.get(sent.jobDigest).current_attempt,null,'turning lending off never claims an unaccepted offer');
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  assert.equal((await approvalEvents(lender.app)).some(e=>e.data.auto==='own job'),false);
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
});

// The audit row is written before acceptance is announced. Whatever the lender does while that write is in flight
// must be honoured: an acceptance that no longer matches the lender's current choice is never announced or claimed.
for(const [name,change] of [
  ['lending is turned off',lender=>api(lender.app,'/api/lending/off',{method:'POST',body:{}})],
  ['lending is paused',lender=>api(lender.app,'/api/lending/pause',{method:'POST',body:{}})]
])test('own job is not accepted when '+name+' during the audit write',{timeout:60000},async t=>{
  let release,writing=false;
  const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const decisionLog=directory=>{const log=createDecisionLog(directory);
    return {...log,async record(row){if(row.source==='own-job'&&!row.supersedes){writing=true;await held;}return log.record(row);}};};
  const f=await appFixture(t),{lender,circle}=await f.connect({decisionLog});
  const sent=await api(lender.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await lend(lender.app,circle);
  await waitFor(()=>writing,'own job audit write held');
  await change(lender);
  release();
  const rows=await waitFor(async()=>{const list=(await api(lender.app,'/api/decisions')).events.filter(row=>row.jobDigest===sent.jobDigest);
    return list.some(row=>row.supersedes)?list:null;},'audit row marked not applied');
  assert.equal(rows.find(row=>row.supersedes).applied,false,'the audit row records that the acceptance did not take effect');
  assert.equal((await approvalEvents(lender.app)).some(e=>e.data.auto==='own job'),false,'no acceptance is announced');
  assert.equal(f.jobs.get(sent.jobDigest).current_attempt,null,'the offer is never claimed');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
});

for(const own of [true,false])test('running sidebar binds signed identity, not identical display names: '+own,{timeout:60000},async t=>{
 const {machineVM,lendPageVM,lendingVM}=await import('../ui/v1/src/view-models.mjs');
 const f=await appFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
 // Equal display labels only; signed requester keys and the real producer stay intact.
 const names=lender.app.device.memberNames.bind(lender.app.device);
 lender.app.device.memberNames=async(...args)=>{const result=new Map(await names(...args));
   result.set(owner.app.device.keyId,'Maya Okafor');result.set(lender.app.device.keyId,'Maya Okafor');return result;};
 const release=()=>lender.backend.release();t.after(release);
 const sent=await api(own?lender.app:owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
 await lend(lender.app,circle);
 if(!own) {
   const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'foreign same-name approval');
   assert.equal(card.requester,owner.app.device.keyId);
   await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
 }
 await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'actual synthetic execution held');
 const home=await waitFor(async()=>{const h=await api(lender.app,'/api/home');return h.execution?.state==='running'?h:null;},'running home');
 assert.equal(home.execution.own,own);
 assert.equal(home.execution.person,'Maya Okafor');
 assert.equal(home.runningJob.own,own);
 const expected=own?'Running your job':'Running Maya Okafor’s job';
 assert.equal(machineVM(home,{name:'Laptop'}).line,expected);
 assert.equal(lendPageVM(home).headline,expected);
 assert.equal(lendingVM(home).headline,expected);
 const status=await api(lender.app,'/api/status');
 assert.equal(machineVM(status,{name:'Laptop'}).line,expected);
 assert.equal(machineVM(status,{name:'Laptop'},{unavailable:{code:'stale'}}).line,'Status needs an update');
 release();
 await waitFor(()=>f.jobs.get(sent.jobDigest).state==='result-accepted','held job completes',30000);
 assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
});
