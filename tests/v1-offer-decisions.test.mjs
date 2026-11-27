import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';
import {appFixture,api,waitFor,adapters} from './helpers/offers-jobs-fixture.mjs';

// Decision receipts with offers (D1): every acceptance is recorded with its decider and the rule that granted it before
// the circle sees a claim, and a failed audit write means nothing is claimed. Synthetic fixtures only; no sandbox or model.
function launch(f,onDecision) {
  const c=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:()=>assert.fail('a standing rule must not ask'),onDecision,onEvent:e=>f.events.push(e)});
  const loop=lender.start(c.signal);f.stop=async()=>{c.abort();await loop;};return lender;
}
function offers(f) {
  let claimed=false;
  f.client.capabilities=async()=>({capabilities:['offers_v1']});
  f.client.listOffers=async function*(){if(!claimed)yield {job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null};};
  f.client.claimJob=async(_digest,ad,opts)=>{claimed=true;f.namedClaims=(f.namedClaims??0)+1;return f.client.claimNext(ad,{...opts,waitSeconds:0});};
}
const scope=f=>({id:'scope-1',circle:f.job.payload.circle,people:[f.job.payload.author],agents:['claude-code-subscription'],
  maxWallSeconds:120,dailyJobs:2,weeklyJobs:10,dailyMinutes:30,weeklyMinutes:60,expiresAt:f.clock.now()+86400000});

test('a standing-rule offer acceptance records the granting rule before the claim',async t=>{
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);
  const rule=scope(f);f.policy.standingRules=[rule];const decisions=[];
  launch(f,async entry=>{decisions.push({entry:structuredClone(entry),claimsBefore:f.namedClaims??0,calls:f.calls.length});});
  await until(()=>f.events.some(e=>e.status==='finished'),'automatic job finished');
  assert.equal(decisions.length,1,'one receipt for one acceptance');
  const [{entry,claimsBefore,calls}]=decisions;
  assert.equal(claimsBefore,0,'recorded before the circle sees a claim');assert.equal(calls,0,'recorded before any source or sandbox');
  assert.equal(entry.jobDigest,f.jobDigest);assert.equal(entry.requester,f.job.payload.author);assert.equal(entry.circle,f.job.payload.circle);
  assert.deepEqual(entry.rule,rule,'the receipt holds the rule that actually granted the job');
  assert.equal(typeof entry.id,'string');assert.ok(entry.id.length>0);
  assert.equal(entry.at,f.clock.now());
});

test('an audit write failure prevents the automatic claim',async t=>{
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);
  f.policy.standingRules=[scope(f)];let attempts=0;
  launch(f,async()=>{attempts++;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
  await until(()=>attempts>0&&f.events.some(e=>e.reason==='audit_unavailable'),'audit failure reported');
  f.clock.advance(5000);await until(()=>attempts>1,'tried again later');
  assert.equal(f.namedClaims??0,0,'nothing is claimed without a receipt');
  assert.equal(f.count('/jobs/claim-next'),0);assert.equal(f.calls.length,0);
  assert.equal(f.saved()?.claimPending??null,null,'no claim intent survives a failed receipt');
});

test('an uncertain automatic claim is retried under the same decision identity',async t=>{
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);
  f.policy.standingRules=[scope(f)];const ids=[];const claim=f.client.claimJob;let calls=0;
  f.client.claimJob=async(...args)=>{if(++calls===1)throw Object.assign(new Error('offline'),{code:'network_error'});return claim(...args);};
  launch(f,async entry=>{ids.push(entry.id);});
  await until(()=>calls===1,'first claim uncertain');f.clock.advance(1000);
  await until(()=>f.events.some(e=>e.status==='finished'),'retried claim finished');
  assert.ok(ids.length>=1);assert.equal(new Set(ids).size,1,'a retry is the same decision, not a new one');
});

test('older-host fallback records the standing rule against the claimed attempt before preparing',async t=>{
  const f=await lenderFixture(t,{harness:'claude-code-subscription',policy:{mode:'auto'}});
  const rule=scope(f);f.policy.standingRules=[rule];const decisions=[];
  launch(f,async entry=>{decisions.push({entry:structuredClone(entry),calls:f.calls.length});});
  await until(()=>f.events.some(e=>e.status==='finished'),'fallback job finished');
  assert.equal(decisions.length,1);assert.equal(decisions[0].calls,0,'before any sandbox or source');
  assert.equal(decisions[0].entry.id,f.attempt().attempt_id,'the claimed attempt is the stable identity');
  assert.deepEqual(decisions[0].entry.rule,rule);
});

const gitInput=(circle,harness='codex')=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Decision receipt test',harness});
// The view marks app-made rules with appOwned; receipts and saved bytes do not carry it.
const rules=f=>api(f,'/api/lending').then(v=>v.standingRules.map(({appOwned,...rule})=>rule));

test('automatic mode records the rule it creates and the rule it revokes, by id',{timeout:120000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await api(lender.app,'/api/devices',{method:'POST',body:{name:'Lending desk',ownerName:'Ana'}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  const [granted]=await rules(lender.app);assert.ok(granted);
  let log=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule');
  assert.equal(log.length,1);assert.equal(log[0].decision,'create');assert.equal(log[0].id!==granted.id,true,'receipt ids are distinct from rule ids');
  assert.deepEqual(log[0].rule,granted,'the receipt is the saved rule');
  assert.deepEqual(log[0].decider,{deviceKey:lender.app.device.keyId,deviceName:'Lending desk',person:'Ana'});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  assert.deepEqual(await rules(lender.app),[]);
  log=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule');
  assert.equal(log.length,2);assert.equal(log[1].decision,'revoke');assert.deepEqual(log[1].rule,granted);
});

test('editing standing rules records create, update and revoke before saving',{timeout:120000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const base={circle:circle.id,people:[lender.app.device.keyId],agents:['codex'],maxWallSeconds:600,dailyJobs:2,weeklyJobs:5,dailyMinutes:30,weeklyMinutes:90,expiresAt:Date.now()+86400000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[{...base,id:'a'},{...base,id:'b'}]}});
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[{...base,id:'a',dailyJobs:3}]}});
  const log=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule');
  assert.deepEqual(log.map(e=>[e.decision,e.rule.id]),[['create','a'],['create','b'],['update','a'],['revoke','b']]);
  assert.equal(log[2].rule.dailyJobs,3);assert.equal(log[2].previous.dailyJobs,2);
  assert.ok(log.every(e=>e.decider.deviceKey===lender.app.device.keyId&&e.source==='manual'));
  // An unchanged save is not a decision.
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[{...base,id:'a',dailyJobs:3}]}});
  assert.equal((await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule').length,4);
});

test('a failed audit write leaves standing rules unchanged',{timeout:120000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const rule={id:'a',circle:circle.id,people:[lender.app.device.keyId],agents:['codex'],maxWallSeconds:600,dailyJobs:2,weeklyJobs:5,dailyMinutes:30,weeklyMinutes:90,expiresAt:Date.now()+86400000};
  await mkdir(join(lender.home,'v1','decisions.json'));
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule]},status:409});
  assert.deepEqual(await rules(lender.app),[]);
});

test('an automatic acceptance names the saved rule that granted it',{timeout:120000},async t=>{
  const realNow=Date.now.bind(Date);let offset=0;const reset=realNow()+86400000;
  const harness='claude-code-subscription';
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({adapters:adapters().map(a=>({...a,spec:legacyProxyHarness(harness)})),
    quotaReader:async()=>({provider:'claude',remaining:100,observedAt:Date.now()}),lendingNow:()=>realNow()+offset,
    lendingReadings:async()=>({windows:[{window_id:'seven_day',window_minutes:10080,state:'open',used_pct:5,observed_at:realNow()+offset,resets_at:reset}]})});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  const [granted]=await rules(lender.app);
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle,harness)});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  // Continuous lending starts on day one; there is no ten-minute allowance warmup.
  const row=await waitFor(async()=>(await api(lender.app,'/api/decisions')).events.find(e=>e.jobDigest===sent.jobDigest&&e.kind==='job'),'automatic receipt');
  assert.equal(row.source,'standing-rule');assert.equal(row.decision,'accept');assert.equal(row.rule.id,granted.id);
  assert.deepEqual(row.rule,granted);assert.equal(row.decider.deviceKey,lender.app.device.keyId);
  await waitFor(()=>f.jobs.get(sent.jobDigest).state==='result-accepted','job ran').catch(async error=>{
    const state=await api(lender.app,'/api/lending');
    throw new Error(error.message+': '+JSON.stringify({reason:f.jobs.get(sent.jobDigest).current_attempt?.reason,status:state.status,policyReason:state.reason}),{cause:error});
  });
  assert.equal((await api(lender.app,'/api/decisions')).events.filter(e=>e.jobDigest===sent.jobDigest).length,1,'one receipt for one acceptance');
});

test('an audit failure on Run it leaves the offer unclaimed',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer');assert.equal(card.offer,true);
  await mkdir(join(lender.home,'v1','decisions.json'));
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(f.jobs.get(sent.jobDigest).state,'queued','no claim without a receipt');
  assert.ok((await api(lender.app,'/api/approvals')).some(c=>c.id===card.id),'the offer stays open to decide again');
});

test('accept and skip racing on one card leave one receipt that matches the outcome',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer');
  const outcomes=await Promise.allSettled(['skip','accept'].map(d=>api(lender.app,'/api/approvals/'+card.id+'/'+d,{method:'POST',body:{}})));
  const rows=(await api(lender.app,'/api/decisions')).events.filter(e=>e.jobDigest===sent.jobDigest);
  assert.equal(rows.length,1);
  const winner=rows[0].decision;
  assert.equal(outcomes[winner==='skip'?0:1].status,'fulfilled');
  if(winner==='accept')await waitFor(()=>f.jobs.get(sent.jobDigest).state!=='queued','accepted offer claimed');
  else {await new Promise(resolve=>setTimeout(resolve,300));assert.equal(f.jobs.get(sent.jobDigest).state,'queued','a skipped offer is never claimed');}
});

// Review round 2: a receipt is the permission decision; a follow-up with applied:false marks one that never took effect.
function heldDecisions() {
  const held={gate:null,entered:null,enteredRelease:null,open(){
    let release;this.gate=new Promise(r=>{release=r;});this.entered=new Promise(r=>{this.enteredRelease=r;});return release;
  }};
  held.factory=directory=>{const {createDecisionLog}=held.module;const log=createDecisionLog(directory);
    return {...log,async record(row){if(held.gate&&!row.id.endsWith(':not-applied')){held.enteredRelease();await held.gate;}return log.record(row);}};};
  return held;
}
const settled=(log,id)=>log.events.filter(e=>e.id===id||e.supersedes===id);

test('a review card closed while its receipt is written is not accepted',{timeout:120000},async t=>{
  const held=heldDecisions();held.module=await import('../lib/v1/decision-log.mjs');
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({decisionLog:held.factory});
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer');
  const release=held.open();
  try {
    const accepting=api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{},status:409});
    await held.entered;
    await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
    release();
    assert.equal((await accepting).code,'approval_changed');
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(f.jobs.get(sent.jobDigest).state,'queued');
    const rows=settled(await api(lender.app,'/api/decisions'),card.id);
    assert.deepEqual(rows.map(r=>[r.decision,r.applied??null]),[['accept',null],['accept',false]],'the permission receipt is followed by its real outcome');
    assert.equal(rows[1].reason,'approval_changed');
  } finally {release();}
});

test('a standing-rule change that fails to save is marked not applied and changes nothing',{timeout:120000},async t=>{
  const {rm}=await import('node:fs/promises');
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const file=join(lender.home,'v1','app-settings.json');await rm(file);await mkdir(file);
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'},status:409});
  const view=await api(lender.app,'/api/lending');
  assert.equal(view.mode,'ask');assert.deepEqual(view.standingRules,[]);
  const log=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule');
  assert.deepEqual(log.map(e=>[e.decision,e.applied??null]),[['create',null],['create',false]]);
  assert.equal(log[1].supersedes,log[0].id);
});

test('limit and requester-cap edits that change automatic lending are recorded',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3}});
  assert.equal((await api(lender.app,'/api/decisions')).events.length,0,'without a standing rule a limit grants nothing');
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:9,idleOnly:false}});
  await api(lender.app,'/api/lending/requester-limits',{method:'POST',body:{circle:circle.id,keyId:owner.app.device.keyId,limits:{dailyJobs:1}}});
  const log=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='standing_rule');
  const limits=log.find(e=>e.rule.id==='lending-limits');
  assert.equal(limits.decision,'update');assert.equal(limits.rule.limits.dailyJobs,9);assert.equal(limits.previous.limits.dailyJobs,3);
  const cap=log.find(e=>e.rule.id==='requester-limit:'+circle.id+':'+owner.app.device.keyId);
  assert.equal(cap.decision,'update');assert.deepEqual(cap.rule.limits,{dailyJobs:1,dailyMinutes:null});
});

// Final review: a grant is published only after it is saved; a Pause during an automatic receipt write stops the claim;
// a partial multi-receipt failure marks the receipts already written. Deterministic latches, synthetic fixtures only.
const latch=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const claudeAgents={adapters:adapters().map(a=>({...a,spec:legacyProxyHarness('claude-code-subscription')})),
  quotaReader:async()=>({provider:'claude',remaining:100,observedAt:Date.now()})};
async function readyToLend(lender,circle,harness='claude-code-subscription') {
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
}

test('a rule whose settings save is still pending or fails never grants a claim',{timeout:60000},async t=>{
  const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module');
  const f=await appFixture(t),{owner,lender,circle}=await f.connect(claudeAgents);await readyToLend(lender,circle);
  const entered=latch(),gate=latch(),originalOpen=fs.open;let intercept=true;
  fs.open=async function(path,...args){
    if(intercept&&String(path).startsWith(join(lender.home,'v1','app-settings.json.'))){intercept=false;entered.resolve();await gate.promise;throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});}
    return originalOpen.call(this,path,...args);
  };syncBuiltinESMExports();
  t.after(()=>{gate.resolve();fs.open=originalOpen;syncBuiltinESMExports();});
  const saving=api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'},status:409});
  await entered.promise;
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle,'claude-code-subscription')});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'the job is offered for review, not taken under the unsaved rule',15000);
  assert.equal(card.jobDigest,sent.jobDigest);assert.equal(f.jobs.get(sent.jobDigest).state,'queued');
  gate.resolve();await saving;fs.open=originalOpen;syncBuiltinESMExports();
  const view=await api(lender.app,'/api/lending');assert.equal(view.mode,'ask');assert.deepEqual(view.standingRules,[]);assert.equal(view.enabled,true);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(f.jobs.get(sent.jobDigest).state,'queued','no automatic claim after the failed save either');
  const rows=(await api(lender.app,'/api/decisions')).events;
  assert.equal(rows.filter(e=>e.kind==='job').length,0);
  const created=rows.find(e=>e.kind==='standing_rule'&&!e.supersedes);assert.equal(rows.find(e=>e.supersedes===created.id).applied,false);
});

test('Off during a pending rule save stays off after the save fails',{timeout:60000},async t=>{
  const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module');
  const f=await appFixture(t),{lender,circle}=await f.connect(claudeAgents);await readyToLend(lender,circle);
  const entered=latch(),gate=latch(),originalOpen=fs.open;let intercept=true;
  fs.open=async function(path,...args){
    if(intercept&&String(path).startsWith(join(lender.home,'v1','app-settings.json.'))){intercept=false;entered.resolve();await gate.promise;throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});}
    return originalOpen.call(this,path,...args);
  };syncBuiltinESMExports();
  t.after(()=>{gate.resolve();fs.open=originalOpen;syncBuiltinESMExports();});
  const saving=api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'},status:409});
  await entered.promise;const off=api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).enabled===false,'Off takes effect at once');
  gate.resolve();await saving;await off;fs.open=originalOpen;syncBuiltinESMExports();
  const view=await api(lender.app,'/api/lending');assert.equal(view.enabled,false);assert.equal(view.mode,'ask');
  const {readFile}=await import('node:fs/promises');
  const saved=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.equal(saved.enabled,false);assert.deepEqual(saved.standingRules??[],[]);
});

test('a Pause while the automatic receipt is written stops the claim and marks the receipt not applied',{timeout:30000},async t=>{
  const f=await lenderFixture(t,{offers:true,harness:'claude-code-subscription'});offers(f);
  f.policy.standingRules=[scope(f)];const entered=latch(),gate=latch(),outcomes=[];
  const c=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:()=>assert.fail('automatic path'),onDecision:async()=>{entered.resolve();await gate.promise;},
    onDecisionNotApplied:async entry=>{outcomes.push(entry);},onEvent:e=>f.events.push(e)});
  const loop=lender.start(c.signal);f.stop=async()=>{gate.resolve();c.abort();await loop;};
  await entered.promise;assert.equal(f.namedClaims??0,0);
  f.policy.enabled=false;lender.pause();gate.resolve();
  await until(()=>outcomes.length===1,'not-applied outcome');
  f.clock.advance(5000);await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(f.namedClaims??0,0,'nothing is claimed after Pause');assert.equal(f.saved()?.claimPending??null,null);
  assert.equal(outcomes[0].reason,'paused');assert.equal(outcomes[0].jobDigest,f.jobDigest);
});

test('a second failed receipt marks the receipts already written as not applied',{timeout:60000},async t=>{
  let count=0;const decisionLog=directory=>{const {createDecisionLog}=held.module;const log=createDecisionLog(directory);return {...log,async record(row){if(row.kind==='standing_rule'&&!row.supersedes&&++count===2)throw Object.assign(new Error('synthetic second audit failure'),{code:'ENOSPC'});return log.record(row);}};};
  const held={module:await import('../lib/v1/decision-log.mjs')};
  const f=await appFixture(t),{lender,circle}=await f.connect({decisionLog});
  const base={circle:circle.id,people:[lender.app.device.keyId],agents:['codex'],maxWallSeconds:600,dailyJobs:2,weeklyJobs:5,dailyMinutes:30,weeklyMinutes:90,expiresAt:Date.now()+86400000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[{...base,id:'a'},{...base,id:'b'}]},status:409});
  assert.deepEqual(await rules(lender.app),[]);
  const rows=(await api(lender.app,'/api/decisions')).events;
  assert.deepEqual(rows.map(r=>[r.rule.id,r.applied??null]),[['a',null],['a',false]]);assert.equal(rows[1].reason,'audit_failed');
  // Across batches: a mode change whose limit receipt fails marks the rule receipt written before it.
  count=0; // the mode's create is write 1 and succeeds; the limits update is write 2 and fails
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:5,mode:'auto',circle:circle.id},status:409});
  const later=(await api(lender.app,'/api/decisions')).events.slice(2);
  const created=later.find(e=>e.decision==='create'&&!e.supersedes);assert.ok(created);
  assert.equal(later.find(e=>e.supersedes===created.id)?.applied,false);
  assert.equal((await api(lender.app,'/api/lending')).mode,'ask');
});

test('Off during a rule save that succeeds is still off on disk, and Off answers only once it is saved',{timeout:60000},async t=>{
  const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module');
  const {readFile}=await import('node:fs/promises');
  const f=await appFixture(t),{lender,circle}=await f.connect(claudeAgents);await readyToLend(lender,circle);
  const entered=latch(),gate=latch(),originalOpen=fs.open;let intercept=true;
  fs.open=async function(path,...args){
    if(intercept&&String(path).startsWith(join(lender.home,'v1','app-settings.json.'))){intercept=false;entered.resolve();await gate.promise;}
    return originalOpen.call(this,path,...args);
  };syncBuiltinESMExports();
  t.after(()=>{gate.resolve();fs.open=originalOpen;syncBuiltinESMExports();});
  const saving=api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await entered.promise;let offAnswered=false;
  const off=api(lender.app,'/api/lending/off',{method:'POST',body:{}}).then(value=>{offAnswered=true;return value;});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).enabled===false,'Off takes effect at once');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(offAnswered,false,'Off does not report success before its state is on disk');
  gate.resolve();await saving;await off;fs.open=originalOpen;syncBuiltinESMExports();
  const saved=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.equal(saved.enabled,false,'the earlier rule save never overwrites a completed Off');
  assert.equal(saved.modes[circle.id],'auto');assert.equal(saved.standingRules.length,1);
  const view=await api(lender.app,'/api/lending');assert.equal(view.enabled,false);assert.equal(view.mode,'auto');
});

test('a member joining after an explicit people save does not inherit frozen consent', {timeout:120000}, async t=>{
  const realNow=Date.now.bind(Date);let offset=0;const reset=realNow()+86400000;
  const harness='claude-code-subscription';
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({
    ...claudeAgents,lendingNow:()=>realNow()+offset,
    lendingReadings:async()=>({windows:[{window_id:'seven_day',window_minutes:10080,state:'open',used_pct:5,observed_at:realNow()+offset,resets_at:reset}]})
  });
  const runCount=()=>lender.backend.calls.filter(c=>c[0]==='run').length;
  const finished=async sent=>waitFor(()=>f.jobs.get(sent.jobDigest)?.state==='result-accepted','useful signed job '+sent.jobDigest,15000)
    .catch(async e=>{const view=await api(lender.app,'/api/lending');throw new Error(e.message+' STATE '+JSON.stringify({job:{state:f.jobs.get(sent.jobDigest)?.state,attempts:f.jobs.get(sent.jobDigest)?.attempts_started,attempt:f.jobs.get(sent.jobDigest)?.current_attempt},lending:Object.fromEntries(Object.entries(view).filter(([,v])=>v===null||typeof v!=='object')),approvals:(await api(lender.app,'/api/approvals')).map(a=>({jobDigest:a.jobDigest,requester:a.requester,offer:a.offer})),decisions:(await api(lender.app,'/api/decisions')).events.map(e=>({kind:e.kind,decision:e.decision,jobDigest:e.jobDigest,source:e.source})),phases:lender.phases,runs:runCount(),failures:f.failures.map(e=>e.message)}),{cause:e});});
  // Use the full weekly share so the second job exercises frozen consent without a strategy ceiling blocking it.
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:8,dailyMinutes:180,maxWallSeconds:1200,idleOnly:false,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:100,keepPct:0},providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const first=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle,harness),prompt:'Original member manual positive'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(c=>c.jobDigest===first.jobDigest),'first explicit approval',15000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await finished(first);assert.equal(runCount(),1);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await waitFor(async()=>{try {await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});return true;}catch(e){if(e.message.includes('lending_busy'))return false;throw e;}},'completed first job releases lending before freezing consent',15000);
  // Explicit saved people keep their scope; circle-wide Automatic is covered separately.
  // A changed rule becomes the person's own (D8); an unchanged whole-form save would keep it app-owned and following.
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:(await rules(lender.app)).map(rule=>({...rule,dailyJobs:rule.dailyJobs-1}))}});
  const frozen=structuredClone(await rules(lender.app));
  assert.equal(frozen.length,1);
  const beforeJoin=(await lender.app.device.rosterCache(circle.id).get()).current;
  assert.deepEqual([...frozen[0].people].sort(),beforeJoin.payload.members.map(m=>m.key_id).sort());
  assert.deepEqual(frozen[0].agents,[harness]);assert.ok(frozen[0].expiresAt>realNow());
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const newcomer=await f.start('after-on-member',{pollMs:250});
  assert.ok(!frozen[0].people.includes(newcomer.app.device.keyId));
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(newcomer.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  const pending=await api(owner.app,'/api/circles/'+circle.id+'/approvals');
  assert.equal(pending.length,1,'new membership was not enrolled before automatic On');
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  const fresh=await api(newcomer.app,'/api/jobs',{method:'POST',body:{...gitInput(circle,harness),prompt:'New member must wait'}});
  const review=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(c=>c.jobDigest===fresh.jobDigest),'new member manual review',15000)
    .catch(e=>{throw new Error(e.message+' FAILURES '+JSON.stringify([...new Set(f.failures.map(e=>e.message))]),{cause:e});});
  assert.equal(review.offer,true);
  const roster=(await lender.app.device.rosterCache(circle.id).get()).current;
  assert.ok(roster.payload.members.some(m=>m.key_id===newcomer.app.device.keyId),'actual signed roster includes newcomer');
  assert.deepEqual(await rules(lender.app),frozen,'joining preserves exact people, expiry and all saved rule fields');
  const proofOf=r=>JSON.parse(Buffer.from(r.headers['faravan-proof'],'base64url'));
  const traffic=f.rawRequests.filter(r=>r.headers['x-test-device']==='lender');
  let recovered;
  for(let i=0;i<traffic.length&&!recovered;i++) {
    const stale=traffic[i];
    if(stale.status!==409||proofOf(stale).payload.roster_epoch!==beforeJoin.payload.epoch)continue;
    const refresh=traffic.slice(i+1).find(r=>r.method==='GET'&&r.url.endsWith('/roster')&&r.status===200&&
      proofOf(r).payload.roster_epoch===beforeJoin.payload.epoch);
    if(!refresh)continue;
    const retry=traffic.slice(traffic.indexOf(refresh)+1).find(r=>r.url===stale.url&&r.method===stale.method&&r.status===200&&
      proofOf(r).payload.roster_epoch===roster.payload.epoch);
    if(retry)recovered={stale,refresh,retry};
  }
  assert.ok(recovered,'the running lender recovered from its stale request, without a manual refresh');
  assert.equal(recovered.retry.body,recovered.stale.body,'retry preserves the immutable request body');
  assert.equal(recovered.retry.headers['idempotency-key'],recovered.stale.headers['idempotency-key']);
  assert.notEqual(proofOf(recovered.retry).payload.nonce,proofOf(recovered.stale).payload.nonce,'retry is freshly signed');
  assert.equal(f.jobs.get(fresh.jobDigest).state,'queued');assert.equal(f.jobs.get(fresh.jobDigest).attempts_started,0);
  assert.equal(f.jobs.get(fresh.jobDigest).current_attempt,null);
  assert.equal(runCount(),1,'new member did not reach backend');
  const again=await api(owner.app,'/api/jobs',{method:'POST',body:{...gitInput(circle,harness),prompt:'Original member after roster change'}});
  offset+=600001;
  await finished(again);assert.equal(runCount(),2,'unrelated permitted work still completes');
  assert.equal(f.jobs.get(fresh.jobDigest).state,'queued');assert.equal(f.jobs.get(fresh.jobDigest).attempts_started,0);
  assert.equal(f.jobs.get(fresh.jobDigest).current_attempt,null,'newcomer never acquired an attempt/reservation');
  assert.equal(f.requests.filter(r=>r.route==='/jobs/'+fresh.jobDigest.slice(7)+'/claim').length,0);
  assert.deepEqual(await rules(lender.app),frozen,'allowance observation did not renew or widen consent');
  const decisions=(await api(lender.app,'/api/decisions')).events.filter(e=>e.kind==='job');
  assert.equal(decisions.filter(e=>e.jobDigest===fresh.jobDigest&&e.decision==='accept').length,0);
  assert.equal(decisions.filter(e=>e.jobDigest===again.jobDigest&&e.source==='standing-rule'&&e.rule.id===frozen[0].id).length,1);
  t.diagnostic(JSON.stringify({runs:runCount(),newAttempts:f.jobs.get(fresh.jobDigest).attempts_started,manualOffer:review.offer,people:frozen[0].people.length,expiry:frozen[0].expiresAt,recovery:[recovered.stale,recovered.refresh,recovered.retry].map(r=>({route:r.url,status:r.status,epoch:proofOf(r).payload.roster_epoch}))}));
});

test('fixture roster recovery preserves membership, signature and nonce admission', {timeout:60000}, async t=>{
  const {readFile}=await import('node:fs/promises');
  const {createPrivateKey,randomBytes,randomUUID}=await import('node:crypto');
  const p=await import('../lib/protocol/index.mjs');
  const {boundedFetch}=await import('./helpers/v1-app-fixture.mjs');
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const c=f.circles.get(circle.id),epoch=c.roster.payload.epoch;
  const key=async actor=>createPrivateKey(await readFile(join(actor.home,'v1','device.pem')));
  const lenderKey=await key(lender);
  const template=f.requests[0].proof.payload;
  const make=(route,{rosterEpoch=epoch,privateKey=lenderKey,nonce=randomBytes(24).toString('base64url'),patch={}}={})=>{
    const payload={...template,key_id:p.fingerprint(p.exportPublicKey(privateKey)),roster_epoch:rosterEpoch,
      method:'GET',target:f.origin+'/v1/circles/'+circle.id+route,body_digest:p.digestBytes(Buffer.alloc(0)),
      content_length:0,content_type:'',artifact_media_type:'',idempotency_key:'',
      created:Math.floor(Date.now()/1000),nonce,...patch};
    return {route,payload,signed:p.signEnvelope('request',payload,privateKey)};
  };
  const send=async proof=>{
    const response=await boundedFetch(f.origin+'/v1/circles/'+circle.id+proof.route,{headers:{
      'faravan-proof':Buffer.from(p.canonicalize(proof.signed)).toString('base64url')}});
    return {response,body:await response.json()};
  };
  const admitted=proof=>f.requests.some(r=>r.proof.payload.nonce===proof.payload.nonce&&r.proof.payload.key_id===proof.payload.key_id);
  const invalid=proof=>({...proof,signed:{...proof.signed,signature:{...proof.signed.signature,
    value:Buffer.alloc(64).toString('base64url')}}});
  const stale=make('/offers',{rosterEpoch:epoch-1});
  const denied=await send(stale);
  assert.equal(denied.response.status,409);
  assert.equal(denied.response.headers.get('content-type'),'application/problem+json');
  assert.equal(denied.response.headers.get('retry-after'),null);
  assert.deepEqual(denied.body,{type:'urn:faravan:problem:roster_stale',title:'roster stale',
    status:409,code:'roster_stale',retryable:false,outcome:'not_applied'});
  assert.equal(admitted(stale),false,'stale ordinary request is never admitted');
  const recovery=make('/roster',{rosterEpoch:epoch-1,nonce:stale.payload.nonce});
  const recovered=await send(recovery);
  assert.equal(recovered.response.status,200,'stale rejection did not consume its nonce');
  assert.deepEqual(recovered.body,c.roster,'a current member receives the actual signed roster');
  assert.equal(p.verifyRoster(recovered.body,{circle:circle.id,rootFingerprint:p.fingerprint(c.roster.payload.root_public_key),
    now:()=>Math.floor(Date.now()/1000)}).ok,true);
  const replay=await send(recovery);assert.equal(replay.response.status,401);assert.equal(replay.body.code,'replay');
  const fresh=make('/offers'),bad=await send(invalid(fresh));
  assert.equal(bad.response.status,400);assert.equal(bad.body.code,'invalid_request');assert.equal(admitted(fresh),false);
  assert.equal((await send(fresh)).response.status,200,'invalid signature did not consume the valid proof nonce');
  const duplicate=await send(fresh);assert.equal(duplicate.response.status,401);assert.equal(duplicate.body.code,'replay');
  // A malformed stale request can get the same preflight hint as production, but no recovery or retry is admitted.
  for(const proof of [make('/offers',{rosterEpoch:epoch-1}),make('/roster',{rosterEpoch:epoch-1}),make('/offers')]) {
    const result=await send(invalid(proof));
    assert.equal(result.response.status,proof.route==='/offers'&&proof.payload.roster_epoch<epoch?409:400);
    assert.equal(admitted(proof),false);
  }
  assert.equal((await send(make('/roster',{rosterEpoch:epoch+1}))).response.status,409,'future epochs cannot recover');
  for(const patch of [{circle:randomUUID()},{target:f.origin+'/wrong-target'},{created:Math.floor(Date.now()/1000)-301}]) {
    const proof=make('/offers',{patch}),result=await send(proof);assert.equal(result.response.ok,false);assert.equal(admitted(proof),false);
  }
  const outsider=await f.start('unknown-member',{pollMs:250}),outsiderKey=await key(outsider);
  const unknown=make('/roster',{privateKey:outsiderKey,rosterEpoch:epoch-1});
  assert.equal((await send(unknown)).response.status,403);assert.equal(admitted(unknown),false);
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(outsider.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  assert.ok(c.enrollments.some(e=>e.device_key_id===outsider.app.device.keyId));
  const pending=make('/roster',{privateKey:outsiderKey,rosterEpoch:epoch-1});
  assert.equal((await send(pending)).response.status,403,'a known enrollment is not current membership');
  assert.equal(admitted(pending),false);
  // Only this isolated control changes fixture state: a root-signed roster excludes a formerly admitted device.
  const original=c.roster,rootKey=createPrivateKey(await readFile(join(owner.home,'v1','roots',circle.id+'.pem')));
  c.roster=p.signEnvelope('roster',{...original.payload,epoch:epoch+1,
    members:original.payload.members.filter(m=>m.key_id!==lender.app.device.keyId)},rootKey);
  try {
    assert.equal(p.verifyRoster(c.roster,{circle:circle.id,rootFingerprint:p.fingerprint(original.payload.root_public_key),
      now:()=>Math.floor(Date.now()/1000)}).ok,true);
    const revoked=make('/roster',{rosterEpoch:epoch});
    assert.equal((await send(revoked)).response.status,403,'revoked devices cannot recover from an old roster');
    assert.equal(admitted(revoked),false);
  } finally {c.roster=original;}
  t.diagnostic('409 stale -> signed old-epoch roster recovery -> fresh admission; invalid signatures, replay, future epochs, wrong bindings, unknown/pending/revoked members rejected');
});
