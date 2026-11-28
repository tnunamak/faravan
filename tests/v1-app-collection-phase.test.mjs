import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/offers-jobs-fixture.mjs';

test('result collection does not reacquire agent launch authority', {timeout:60000}, async t => {
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const start=lender.backend.start.bind(lender.backend),collection=[];
  let agentSignal;
  lender.backend.start=async (handle,options={})=>{
    if(options.onExecutionStarted)agentSignal=options.signal;
    if(handle._entrypoint.startsWith('mkdir -p .wf-result'))collection.push({handle,options,bookkeeping:handle._bookkeeping});
    return start(handle,options);
  };
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Collect one result',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(async()=>{
    const job=await api(owner.app,'/api/jobs/'+sent.jobDigest+'?circle='+encodeURIComponent(circle.id));
    return job.state==='result-accepted';
  },'collected result',30000);
  assert.equal(collection.length,1);
  assert.equal(typeof agentSignal?.aborted,'boolean');
  assert.equal(collection[0].bookkeeping,true);
  assert.equal(collection[0].options.signal,agentSignal,'collection retains job cancellation');
  assert.equal(collection[0].options.onExecutionStarted,undefined,'a collection command must not install a new guard');
  assert.equal(collection[0].options.onLaunchDurable,undefined,'collection cannot obtain another launch acknowledgement');
  assert.equal(collection[0].options.lendingBudget,undefined);
});
