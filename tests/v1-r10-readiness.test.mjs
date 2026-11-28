import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalize} from '../lib/protocol/index.mjs';
import {appFixture,api,waitFor} from './helpers/triage-small-app-fixture.mjs';

const jobInput=(circle,prompt='Readiness job')=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt,harness:'codex',send_anyway:true});
async function lending(f,options={}){
  const {owner,lender,circle}=await f.connect(options);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,dailyMinutes:60,maxWallSeconds:1200}});
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
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  // Ask mode: an arriving offer becomes a Run it card.
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the next offer reaches the lender',15000);
  assert.equal(card.jobDigest??card.job_digest??jobDigest,jobDigest);
  assert.notEqual((await api(lender.app,'/api/lending')).status,'paused');
});
test('control: a lending lender takes the next job',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await lending(f);
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
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
  await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the next offer reaches the restarted lender',15000);
});

// Readiness describes the advertised range; each offer is checked against that range.
async function watchReadiness(t,app){
  const controller=new AbortController();
  const response=await fetch(app.origin+'/api/events?after=0',{headers:{'x-faravan-session-token':app.token,accept:'text/event-stream'},signal:controller.signal});
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  const pump=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}}catch{}})();
  t.after(async()=>{controller.abort();await pump;});
  const events=()=>text.split('\n').filter(line=>line.startsWith('data:')).flatMap(line=>{
    try{const event=JSON.parse(line.slice(5));return event.type==='readiness'?[event.data]:[];}catch{return [];}
  });
  await new Promise(resolve=>setTimeout(resolve,1500));
  return events;
}
function relayPresence(f,lender){
  const base=f.override;let hb,heartbeatAt;
  f.override=async ctx=>{
    if(ctx.route==='/heartbeat'){
      const proof=JSON.parse(Buffer.from(ctx.req.headers['faravan-proof'],'base64url')).payload;
      if(proof.key_id===lender.app.device.keyId){hb=ctx.body;heartbeatAt=new Date(proof.created*1000).toISOString();}
    }
    if(ctx.route!=='/presence')return base(ctx);
    const devices=hb?[{device:lender.app.device.keyId,deviceName:'Synthetic lender',online:true,source:'heartbeat',last_heartbeat_at:heartbeatAt,
      intent:hb.intent,execution:hb.execution,blockers:hb.blockers,agents:hb.agents,budget:hb.budget,capabilities:hb.capabilities,
      account_offers:(hb.accounts??[]).flatMap(a=>a.models.filter(m=>m.enabled).map(m=>({providerId:a.providerId,modelId:m.id,effortIds:m.efforts.map(e=>e.id)})))}]:[];
    const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices,persons:[]}));
    ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
  };
  return ()=>hb;
}
test('R3: a smaller daily allowance stays ready, advertises ten minutes and refuses a twenty-minute offer',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await lending(f,{heartbeatMs:100});
  const lenderHeartbeat=relayPresence(f,lender);
  const ads=[],base=f.override;
  f.override=async ctx=>{if(ctx.body?.advertisement)ads.push(ctx.body.advertisement);return base(ctx);};
  await waitFor(()=>lender.app.lendingAdmission()===null,'initial readiness',15000);
  const events=await watchReadiness(t,lender.app),settled=events().length;
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyMinutes:10}});
  assert.equal(lender.app.lendingAdmission(),null);
  assert.equal((await api(lender.app,'/api/status')).lendingProjection.admission,'allowed');
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const refused=await waitFor(async()=>{const s=await api(lender.app,'/api/lending');return s.heldOffers?.find(o=>o.id===jobDigest);},'the per-offer refusal',15000);
  assert.equal(refused.reason,'daily_limit');
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
  assert.equal(f.jobs.get(jobDigest).current_attempt??null,null);
  await waitFor(()=>lenderHeartbeat()?.budget?.minutes_left_today===10,'the circle hears ten minutes remain',15000);
  const borrower=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
  assert.equal(borrower.statusContract.reasonCode,'daily_limit',JSON.stringify({presence:borrower.presence,status:borrower.statusContract}));
  assert.match(borrower.statusContract.explanation,/done for today/);
  assert.equal(events().length,settled,'a smaller positive allowance and idle polling do not change readiness');
  // A smaller offer behind the refused one still reaches review and uses the reduced advertisement.
  const small=structuredClone(f.jobs.get(jobDigest).job.payload);
  small.intent_id=randomUUID();small.requirements.limits.wall_seconds=60;
  const submitted=await (await owner.app.device.client(circle.id)).submitJob(small);
  const smallDigest=submitted.job_digest??submitted.jobDigest;
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(c=>c.jobDigest===smallDigest),'the one-minute offer reaches review',15000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>ads.some(ad=>ad.max_limits.wall_seconds===600),'the signed ten-minute advertisement',15000);
  assert.equal(ads.at(-1).max_limits.wall_seconds,600);
  await waitFor(()=>f.jobs.get(smallDigest)?.state==='result-accepted','the smaller offer completes',15000);
  await waitFor(()=>lender.app.lendingAdmission()===null,'ready again after the smaller offer',15000);
});

test('readiness events report exhausted daily allowance once and restoration once',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await lending(f);
  await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review',15000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(async()=>{const s=await api(lender.app,'/api/status');return s.today.jobs===1&&s.lendingProjection.execution==='idle'&&lender.app.lendingAdmission()===null;},'one completed job',15000);
  const events=await watchReadiness(t,lender.app),settled=events().length;
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(events().length,settled,'idle polling is not readiness news');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:1}});
  await waitFor(()=>events().length===settled+1,'one not-ready event',5000);
  assert.deepEqual(events().at(-1),{seq:events().at(-1).seq,ready:false,reason:'daily_limit'});
  assert.equal(lender.app.lendingAdmission(),'daily_limit');
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(events().length,settled+1);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:2}});
  await waitFor(()=>events().length===settled+2,'one restored-ready event',5000);
  assert.deepEqual(events().at(-1),{seq:events().at(-1).seq,ready:true,reason:null});
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(events().length,settled+2);
});

test('readiness events report account disable and re-enable separately',{timeout:90000},async t=>{
  const f=await appFixture(t),{lender}=await lending(f);
  await waitFor(()=>lender.app.lendingAdmission()===null,'initial readiness',15000);
  const events=await watchReadiness(t,lender.app),settled=events().length;
  const accounts=await api(lender.app,'/api/accounts'),account=accounts.accounts[0];
  await api(lender.app,'/api/accounts/'+account.id+'/settings',{method:'POST',body:{expectedRevision:accounts.revision,enabled:false}});
  await waitFor(()=>events().length===settled+1,'one account-disabled event',5000);
  assert.equal(events().at(-1).ready,false);assert.equal(events().at(-1).reason,'lending_off');
  const updated=await api(lender.app,'/api/accounts');
  await api(lender.app,'/api/accounts/'+account.id+'/settings',{method:'POST',body:{expectedRevision:updated.revision,enabled:true}});
  await waitFor(()=>events().length===settled+2,'one account-enabled event',5000);
  assert.equal(events().at(-1).ready,true);assert.equal(events().at(-1).reason,null);
  await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(events().length,settled+2);
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
 const sent=await api(lender.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle,'Active execution survives host observation')});
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
