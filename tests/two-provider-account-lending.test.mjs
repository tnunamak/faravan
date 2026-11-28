import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

test('one lender claims and starts Claude and Codex jobs on their enrolled accounts',{timeout:180000},async t=>{
 const f=await appFixture(t),{owner,lender,circle,realHeartbeats,realRequests}=await f.realConnect({lenderOptions:{syntheticAccounts:['claude','codex']}});
 const accounts=(await api(lender.app,'/api/accounts')).accounts;
 assert.equal(accounts.length,2);
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:5,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
 for(const harness of ['claude-code-subscription','codex'])await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId).at(-1)?.body.accounts?.length===2,'both enrolled accounts in heartbeat',30000);
 for(const [harness,providerId] of [['claude-code-subscription','claude'],['codex','codex']]){
  const sent=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:circle.id,noSource:true,result:{kind:'message'},prompt:'Return a synthetic greeting',harness}});
  const path='/api/jobs/'+encodeURIComponent(sent.jobDigest)+'?circle='+circle.id;
  let job;
  try {job=await waitFor(async()=>{const job=await api(owner.app,path);return job.state==='result-accepted'&&job;},providerId+' starts and completes',30000);}
  catch(error){const job=await api(owner.app,path);t.diagnostic(JSON.stringify({state:job.state,attempt:job.current_attempt,requests:realRequests.filter(row=>row.status>=400),calls:lender.backend.calls.map(row=>row[0])}));throw error;}

  assert.equal(job.current_attempt.selection.providerId,providerId);
  assert.equal(job.current_attempt.selection.accountId,accounts.find(row=>row.providerId===providerId).id);
  assert.ok(job.current_attempt.execution_observed_at,'execution really started');
 }
});
