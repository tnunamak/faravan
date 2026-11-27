import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-lifecycle-fixture.mjs';

// O4 (judge r8): a lender that reaches its daily cap must tell the circle at once. With only the 30 s
// interval, a waiting borrower read "1 computer is ready" from the heartbeat sent before the cap.
test('O4 a lender that reaches its daily cap reports it to the circle without waiting for the interval',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({heartbeatMs:600000});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:1,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic friend task.',harness:'codex'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'friend approval card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>f.jobs.get(sent.jobDigest).state==='result-accepted','friend result',30000);
  const finished=Date.now();
  const capped=await waitFor(()=>(f.heartbeats??[]).find(hb=>hb.intent?.state==='resting'&&hb.intent.reason==='daily_limit'),'capped heartbeat',10000);
  assert.ok(Date.now()-finished<10000);
  assert.equal(capped.budget.jobs_left_today,0);
});
