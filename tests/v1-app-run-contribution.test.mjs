import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/triage-small-app-fixture.mjs';

// Each send is its own draft, as the app page sends it. The same words without a draft id would follow the first
// job, which a lender stop puts back in the queue.
const jobInput=(circle,draft_id)=>({circle:circle.id,git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40),prompt:'Synthetic friend task.',harness:'codex',draft_id});

async function lend(app,circle) {
  await api(app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
}

async function accept(app) {
  const card=await waitFor(async()=>(await api(app,'/api/approvals'))[0],'friend job approval');
  await api(app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
}

test('friend run count includes confirmed stops and nonzero executions',{timeout:120000},async t=>{
  const options={hold:true},f=await appFixture(t,options),{owner,lender,circle}=await f.connect();
  await lend(lender.app,circle);

  const stopped=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle,'contribution-stopped-01')});
  await accept(lender.app);
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'first execution entered backend');
  const attemptId=(await api(lender.app,'/api/lending')).current;
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  await waitFor(()=>f.jobs.get(stopped.jobDigest).current_attempt.compute_stopped,'first sandbox cessation confirmed');

  const afterStop=await waitFor(async()=>{
    const summary=await api(lender.app,'/api/contributions');
    const row=summary.windows[7].rows.find(item=>item.keyId===owner.app.device.keyId);
    // The run is recorded when it starts; the stop is recorded after the sandbox is confirmed stopped. Wait for both.
    return row?.run===1&&row.stopped===1?row:null;
  },'stopped friend execution counted');
  assert.equal(afterStop.stopped,1);
  assert.equal(afterStop.delivered,0);

  options.hold=false;
  options.runError=Object.assign(new Error('synthetic nonzero agent exit'),{code:'entrypoint_start_failed'});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).current===null,'stopped execution cleanup settles');
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const nonzero=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle,'contribution-nonzero-01')});
  await accept(lender.app);
  await waitFor(()=>f.jobs.get(nonzero.jobDigest).state==='failed','nonzero execution reaches terminal state');
  const afterNonzero=await waitFor(async()=>{
    const summary=await api(lender.app,'/api/contributions');
    const row=summary.windows[7].rows.find(item=>item.keyId===owner.app.device.keyId);
    // The run is recorded when it starts; the failure is recorded after the job is failed. Wait for both.
    return row?.run===2&&row.failed===1?{summary,row}:null;
  },'nonzero friend execution counted');
  assert.equal(afterNonzero.row.failed,1);
  assert.equal(afterNonzero.row.delivered,0,'run observations do not pretend failed work was delivered');
  assert.equal(afterNonzero.summary.windows[7].jobs,0,'delivered-job total remains separate from run count');
});
