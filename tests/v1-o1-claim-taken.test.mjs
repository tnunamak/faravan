import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appFixture,api,waitFor,adapters} from './helpers/v1-app-fixture.mjs';

// Judge r8 O1: the sender's own computer claims the job about a second before this lender presses Run it.
// The answer names who took it, so the page can say nothing ran here, instead of a generic "Try again".
const claudeAgents={adapters:adapters().map(a=>({...a,spec:legacyProxyHarness('claude-code-subscription')})),
  quotaReader:async()=>({provider:'claude',remaining:100,observedAt:Date.now()})};
const instant=()=>new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');

test('O1: Run it after the sender’s own computer took the job answers job_taken with the taker, not a retryable error',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect(claudeAgents);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Claim race',harness:'claude-code-subscription'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the job is offered for review',15000);
  // The sender's own computer wins the claim first.
  const view=f.jobs.get(sent.jobDigest);
  Object.assign(view,{state:'claimed',current_attempt:{attempt_id:randomUUID(),job_digest:view.job_digest,generation:1,holder:owner.app.device.keyId,
    state:'active',claimed_at:instant(),lease_expires_at:new Date(Math.floor(Date.now()/1000)*1000+120000).toISOString().replace('.000Z','Z'),
    reason:null,compute_stopped:false,stopped_at:null,execution_started_at:null}});
  const refused=await api(lender.app,'/api/approvals/'+encodeURIComponent(card.id)+'/accept',{method:'POST',body:{},status:409});
  assert.equal(refused.code,'job_taken','a lost claim is its own answer, not a generic conflict');
  assert.equal(refused.taker?.sender,true,'the sender’s own computer holds the job');
  const events=(await api(lender.app,'/api/activity')).filter?.(e=>e.type==='approval'&&e.data?.state==='taken')??[];
  if(events.length)assert.equal(events.at(-1).data.taker?.sender,true,'the activity record names the same taker');
});

// Dot review P1: a job that is queued again still names its last, expired attempt's holder. A claim that fails then
// was not lost to that computer, so the answer keeps its own reason instead of "taken".
test('O1: a failed claim on a queued job with an old attempt is not reported as taken',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect(claudeAgents);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Retry race',harness:'claude-code-subscription'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the job is offered for review',15000);
  const view=f.jobs.get(sent.jobDigest);
  // Queued again after the owner's computer let its attempt expire; the old attempt still names it. The host then
  // refuses this claim for its own reason (not a conflict).
  Object.assign(view,{state:'queued',current_attempt:{attempt_id:randomUUID(),job_digest:view.job_digest,generation:1,holder:owner.app.device.keyId,
    state:'expired',claimed_at:instant(),lease_expires_at:instant(),reason:'lease_expired',compute_stopped:false,stopped_at:null,execution_started_at:null}});
  const previous=f.override;
  f.override=async context=>{
    if(/^\/jobs\/[0-9a-f]{64}\/claim$/.test(context.route)){context.res.writeHead(409,{'content-type':'application/problem+json'});context.res.end('{"code":"requirements_unsupported"}');return true;}
    return previous?.(context)??false;
  };
  const refused=await api(lender.app,'/api/approvals/'+encodeURIComponent(card.id)+'/accept',{method:'POST',body:{},status:409});
  assert.notEqual(refused.code,'job_taken','an expired attempt is not evidence that its computer took the job');
});
