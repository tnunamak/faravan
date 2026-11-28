import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {sandboxes} from './helpers/v1-pool-fakes.mjs';
import {installServingMember} from './helpers/serving-member-fixture.mjs';

// Both stores and the app's lending pool are real. The provider and sandbox processes are synthetic.
test('an incumbent outage stalls only ordinary work: designated work runs at the member store, nothing runs twice, stop stays exact',{timeout:360000},async t=>{
 const f=await appFixture(t),sbx=sandboxes(t);
 const connected=await f.realConnect({lenderOptions:{syntheticAccounts:['claude','codex'],backend:sbx.backend}});
 const {owner,lender,circle,incumbent,realRequests,realHeartbeats}=connected;
 await installServingMember({f,...connected});
 const memberRequests=[];
 lender.app.memberListener.server.prependListener('request',req=>memberRequests.push({route:req.url,method:req.method}));
 const coordinator=await owner.app.device.client(circle.id),member=await owner.app.device.memberClient(circle.id,lender.app.device.keyId);
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:8,dailyMinutes:120,maxWallSeconds:1200,idleOnly:false,
  lendingPolicy:{accountSlots:1,machineSlots:2}}});
 for(const harness of ['claude-code-subscription','codex'])await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId).at(-1)?.body.accounts?.length===2,'both accounts advertised at the incumbent',30000);
 const templates=new Map();
 const publish=async(designated,prompt)=>{
  const authority=designated?member:coordinator,other=designated?coordinator:member;
  let digest,payload;
  if(templates.has(designated)){
   // Reuse the product-built request, but send this new intent to the authority under test.
   // Automatic destination selection may otherwise choose the other serving member when this provider is busy.
   payload=structuredClone(templates.get(designated));payload.intent_id=randomUUID();
   payload.created_at=new Date().toISOString().replace(/\.\d+Z$/,'Z');
   payload.expires_at=new Date(Date.now()+86400000).toISOString().replace(/\.\d+Z$/,'Z');
   payload.prompt=await authority.uploadArtifact(Buffer.from(prompt),'text/plain');
   digest=(await authority.submitJob(payload)).jobDigest;
  }else{
   digest=(await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,
    noSource:true,result:{kind:'message'},prompt,harness:designated?'codex':'claude-code-subscription',
    ...(designated?{designated_member:lender.app.device.keyId}:{})}})).jobDigest;
   payload=(await authority.getJob(digest)).job.payload;templates.set(designated,payload);
  }
  await other.uploadArtifact(await authority.fetchArtifact(payload.prompt),'text/plain');
  assert.equal((await other.submitJob(payload)).jobDigest,digest,'both authorities retain the unchanged signed job');
  return digest;
 };
 const ordinary=await publish(false,'Ordinary one'),designated=await publish(true,'Designated one');
 try{await waitFor(()=>sbx.runs.length===2,'both providers execute at their own authorities',45000);}
 catch(error){t.diagnostic(JSON.stringify({ordinary:(await coordinator.getJob(ordinary)).current_attempt,designated:(await member.getJob(designated)).current_attempt,runs:sbx.runs,accounts:(await api(lender.app,'/api/lending')).accountStates.map(({account,status,reason})=>({account,status,reason})),errors:realRequests.filter(row=>row.status>=400)}));throw error;}

 const ordinaryAttempt=(await coordinator.getJob(ordinary)).current_attempt,designatedAttempt=(await member.getJob(designated)).current_attempt;
 assert.equal(ordinaryAttempt.selection.providerId,'claude');assert.equal(designatedAttempt.selection.providerId,'codex');
 assert.notEqual(ordinaryAttempt.selection.accountId,designatedAttempt.selection.accountId);
 const state=()=>api(lender.app,'/api/lending');
 assert.equal((await state()).currentJobs.length,2);
 const ordinaryLater=await publish(false,'Ordinary two'),designatedLater=await publish(true,'Designated two');
 incumbent.down();
 t.after(()=>incumbent.up());
 const handleFor=digest=>[...sbx.live.values()].find(row=>row.handle.job_id===digest);
 const ordinarySandbox=handleFor(ordinary),designatedSandbox=handleFor(designated);
 assert.ok(ordinarySandbox&&designatedSandbox);
 designatedSandbox.run.resolve();
 await waitFor(async()=>(await member.getJob(designated)).state==='result-accepted','member completion while incumbent is down',45000);
 await waitFor(()=>sbx.runs.length===3,'freed Codex account takes the next designated job during outage',60000);
 const laterAttempt=(await member.getJob(designatedLater)).current_attempt;
 await waitFor(async()=>(await member.getJob(designatedLater)).current_attempt.execution_observed_at,'later member execution is observed',15000);
 await waitFor(async()=>(await state()).accountStates.some(row=>row.current===laterAttempt.attempt_id&&row.status==='running'),'the pool observes the later agent running',15000);
 assert.ok(!sbx.gone.has(ordinarySandbox.handle.sandbox_id),'ordinary execution stays alive');
 assert.equal((await state()).currentJobs.length,2);
 assert.ok(!realRequests.some(row=>row.method==='POST'&&row.route.endsWith('/jobs/'+designated.slice(7)+'/claim')),'incumbent never claims designated work');
 const memberClaims=memberRequests.filter(row=>row.method==='POST'&&row.route.endsWith('/claim')).map(row=>row.route);
 assert.ok(memberClaims.every(route=>[designated,designatedLater].some(digest=>route.includes('/jobs/'+digest.slice(7)+'/'))),'member claims only designated work');
 await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
 await api(lender.app,'/api/lending/stop',{method:'POST',body:{confirmed:true,attemptId:laterAttempt.attempt_id}});
 await waitFor(async()=>(await state()).currentJobs.length===1,'only the designated attempt stops',30000);
 assert.equal((await state()).currentJobs[0].attemptId,ordinaryAttempt.attempt_id);
 incumbent.up();
 assert.equal((await coordinator.getJob(ordinaryLater)).attempts_started,0,'ordinary queued work was not moved to the member');
 assert.equal((await member.getJob(ordinaryLater)).attempts_started,0,'the member retained ordinary work without dispatching it');
 assert.equal((await coordinator.getJob(designated)).attempts_started,0,'the incumbent retained designated work without dispatching it');
 await api(lender.app,'/api/lending/stop',{method:'POST',body:{confirmed:true,attemptId:ordinaryAttempt.attempt_id}});
 await waitFor(async()=>(await state()).currentJobs.length===0,'ordinary attempt stops at incumbent',30000);
 assert.equal(sbx.runs.length,3,'each accepted attempt executes once');
 const counters=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));
 assert.equal(counters.pending,null);
 assert.equal(Object.values(counters.accounts).reduce((sum,row)=>sum+row.jobs,0),counters.jobs,'one counter totals both authorities');
 assert.equal((await member.getJob(designatedLater)).current_attempt.compute_stopped,true);
 assert.equal((await coordinator.getJob(ordinary)).current_attempt.compute_stopped,true);
});
