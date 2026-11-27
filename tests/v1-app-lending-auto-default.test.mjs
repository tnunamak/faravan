import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

const create=(f,app,name)=>api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name}});
const disk=home=>join(home,'v1','app-settings.json');
const saved=async home=>JSON.parse(await readFile(disk(home),'utf8'));
async function joinCircle(owner,friend,circle) {
  const {invite}=await api(owner,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(friend,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await friend.device.refreshRoster(circle.id);
}

test('fresh install second created circle gets automatic and its member rule',async t=>{
  const f=await appFixture(t),owner=await f.start('owner',{freshLending:'automatic'});
  await f.provisionFromHome('owner');
  await create(f,owner.app,'First');
  const second=await create(f,owner.app,'Second');
  const settings=await saved(owner.home);
  assert.equal(settings.modes[second.id],'auto');
  const rule=settings.standingRules.find(r=>r.circle===second.id);
  assert.ok(rule.people.includes(owner.app.device.keyId));
  assert.equal((await api(owner.app,'/api/status')).circles.find(c=>c.id===second.id).lendingMode,'auto');
});

test('restart grants no rule to unconfigured circles, preserves choices and is idempotent',async t=>{
  const f=await appFixture(t),{owner,lender,circle:chosen}=await f.connect();
  const implicit=await create(f,owner.app,'Untouched');
  const automatic=await create(f,owner.app,'Chosen automatic');
  const ruled=await create(f,owner.app,'Saved rule');
  await joinCircle(owner.app,lender.app,implicit);
  await f.provisionFromHome('lender');
  const joined=await create(f,lender.app,'Joined');
  await joinCircle(lender.app,owner.app,joined);
  await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:chosen.id,mode:'ask'}});
  assert.equal((await saved(owner.home)).modes[chosen.id],'ask','saving Ask is explicit');
  await owner.app.close();
  const old=await saved(owner.home);
  const rule={id:'chosen-rule',circle:ruled.id,people:[lender.app.device.keyId],agents:['codex'],maxWallSeconds:600,
    dailyJobs:1,weeklyJobs:2,dailyMinutes:10,weeklyMinutes:20,schedule:null,expiresAt:Date.now()+86400000};
  old.modes={[chosen.id]:'ask',[automatic.id]:'auto'};old.standingRules=[rule];delete old.joinMode;delete old.pendingJoinedDefaults;old.intent='off';
  await writeFile(disk(owner.home),JSON.stringify(old));
  const upgraded=await f.start('owner');
  const after=await saved(owner.home);
  assert.equal(after.modes[implicit.id],undefined);
  assert.equal(after.standingRules.filter(r=>r.circle===implicit.id).length,0);
  assert.ok((await api(upgraded.app,'/api/status')).lendingPrompts.some(p=>p.circle===implicit.id));
  assert.equal(after.modes[chosen.id],'ask');
  assert.equal(after.modes[automatic.id],'auto');
  assert.equal(after.modes[joined.id],undefined);
  assert.equal(after.modes[ruled.id],undefined);
  assert.deepEqual(after.standingRules.find(r=>r.id===rule.id),rule);
  assert.equal(after.standingRules.filter(r=>![implicit.id,joined.id].includes(r.circle)).length,1);
  assert.equal((await api(upgraded.app,'/api/status')).circles.find(c=>c.id===joined.id).lendingMode,'auto');
  await upgraded.app.close();
  const beforeRestart=await saved(owner.home);
  const again=await f.start('owner');
  const afterRestart=await saved(owner.home);
  for(const key of ['modes','standingRules','pendingDefaultRules','configVersion'])assert.deepEqual(afterRestart[key],beforeRestart[key],key);
  const later=await create(f,again.app,'Created after upgrade');
  const laterSettings=await saved(owner.home);
  assert.equal(laterSettings.modes[later.id],'auto');
  assert.ok(laterSettings.standingRules.some(rule=>rule.circle===later.id));
  await again.app.close();
});

test('explicit automatic answer runs matching member offers and reviews work outside the rule',async t=>{
  const harness='claude-code-subscription',source=createSyntheticPace50Source({start:Date.now(),
    resets:{weekly:7*86400000,short:5*3600000}});
  const common={adapters:[{spec:legacyProxyHarness(harness),installed:true,signedIn:true,
    harnessVersion:'synthetic-only',models:['example-model'],capabilities:[]}],
    lendingPace50:{source,account_week_id:'synthetic-week-1'}};
  const held={hold:true},f=await appFixture(t,held),{owner,lender,circle}=await f.connect({},common);
  await api(owner.app,'/api/agents/'+harness+'/run',{method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(owner.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(owner.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,maxWallSeconds:1200,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},
      providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await owner.app.close();
  const old=await saved(owner.home);old.modes={};old.standingRules=[];delete old.joinMode;
  await writeFile(disk(owner.home),JSON.stringify(old));
  const upgraded=await f.start('owner',common);
  assert.equal((await saved(owner.home)).modes[circle.id],undefined,'restart grants no permission');
  await api(upgraded.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  assert.deepEqual((await api(upgraded.app,'/api/status')).lendingPrompts,[]);
  assert.ok((await api(upgraded.app,'/api/decisions')).events.some(e=>e.rule?.mode==='auto'&&e.circle===circle.id));
  const submit=(app,prompt)=>api(app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt,harness}});
  const inside=await submit(lender.app,'Covered member');
  await api(upgraded.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>upgraded.backend.calls.some(([kind])=>kind==='run'),'automatic execution',30000);
  assert.deepEqual(await api(upgraded.app,'/api/approvals'),[]);
  const runningRule=(await saved(owner.home)).standingRules.find(rule=>rule.circle===circle.id);
  const duringJob=await create(f,upgraded.app,'Created while lending');
  const duringSettings=await saved(owner.home);
  assert.equal(duringSettings.modes[duringJob.id],'auto');
  assert.ok(duringSettings.standingRules.some(rule=>rule.circle===duringJob.id));
  assert.deepEqual(duringSettings.standingRules.find(rule=>rule.circle===circle.id),runningRule);
  const stillRunning=await api(upgraded.app,'/api/lending');
  assert.equal(stillRunning.circle,circle.id);
  assert.ok(stillRunning.current);
  held.hold=false;upgraded.backend.release();
  await waitFor(()=>f.jobs.get(inside.jobDigest).state==='result-accepted','automatic completion',30000);
  assert.equal(upgraded.backend.calls.filter(([kind])=>kind==='run').length,1);
  // Explicit named-person choices replace the circle-wide mode permission. An unchanged save keeps the app's rule (D8), so the
  // person edits it: it becomes their own rule and no longer covers a member who joins later.
  await api(upgraded.app,'/api/lending/rules',{method:'POST',body:{rules:[{...runningRule,maxWallSeconds:1100}]}});
  const newcomer=await f.start('newcomer');
  await joinCircle(upgraded.app,newcomer.app,circle);
  const outside=await submit(newcomer.app,'Member outside saved rule');
  await waitFor(async()=>(await api(upgraded.app,'/api/approvals')).some(card=>card.jobDigest===outside.jobDigest||card.job_digest===outside.jobDigest),
    'approval card outside rule',30000);
  assert.equal(f.jobs.get(outside.jobDigest).state,'queued');
  assert.equal(upgraded.backend.calls.filter(([kind])=>kind==='run').length,1);
});

test('resuming an unconfigured joined circle needs explicit permission', {timeout:120000}, async t=>{
  const harness='claude-code-subscription',source=createSyntheticPace50Source({start:Date.now(),
    resets:{weekly:7*86400000,short:5*3600000}});
  const common={adapters:[{spec:legacyProxyHarness(harness),installed:true,signedIn:true,
    harnessVersion:'synthetic-only',models:['example-model'],capabilities:[]}],
    lendingPace50:{source,account_week_id:'synthetic-week-1'}};
  const held={hold:true},f=await appFixture(t,held);
  const {owner,lender,circle,realRequests}=await f.realConnect({lenderOptions:common});
  await api(lender.app,'/api/agents/'+harness+'/run',{method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{idleOnly:false,maxWallSeconds:1200,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},
      providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await lender.app.close();
  const old=await saved(lender.home);
  old.intent='on';old.activeCircle=circle.id;old.modes={};old.standingRules=[];
  delete old.appRuleIds;delete old.joinMode;delete old.pendingJoinedDefaults;
  await writeFile(disk(lender.home),JSON.stringify(old));
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Permission migration causal witness',harness,send_anyway:true}});
  const requestStart=realRequests.length;
  const up=await f.start('lender',common),key=up.app.device.keyId;
  const requests=()=>realRequests.slice(requestStart).filter(r=>r.device===key);
  // This exact job's approval proves the real lender consumed the offer scan.
  // A delay or an idle setup state cannot satisfy this barrier.
  await waitFor(async()=>(await api(up.app,'/api/approvals')).some(card=>
    card.jobDigest===job.jobDigest||card.job_digest===job.jobDigest),'unconfigured offer reviewed',30000);
  assert.ok(requests().some(r=>r.status===200),'completed real coordinator contact after resume');
  // The exact approval above, not a guessed URL or contact alone, proves offer evaluation.
  const before=await saved(lender.home);
  assert.equal(before.intent,'on');
  assert.equal(before.modes[circle.id],undefined);
  assert.ok(!before.standingRules.some(r=>r.circle===circle.id));
  assert.ok(!requests().some(r=>r.route.includes('/claim')),
    'no claim request, hence no durable coordinator claim without permission');
  assert.equal(up.backend.calls.filter(([kind])=>kind==='run').length,0);
  await api(up.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  assert.equal((await saved(lender.home)).modes[circle.id],'ask','intentional Ask remains available');
  assert.ok(!requests().some(r=>r.route.includes('/claim')),
    'choosing Ask is not approval of the pending job');
  assert.equal(up.backend.calls.filter(([kind])=>kind==='run').length,0);
  await api(up.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(up.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>up.backend.calls.some(([kind])=>kind==='run'),'authorized execution',30000);
  const claim=await waitFor(()=>requests().find(r=>r.status===200&&
    /\/(?:claim|claim-next)$/.test(new URL(r.route,'http://fixture').pathname)&&
    r.response?.job_digest===job.jobDigest),'same job successfully claimed',30000);
  const attemptId=claim.response.attempt.attempt_id;
  assert.equal(up.backend.calls.filter(([kind])=>kind==='run').length,1);
  held.hold=false;up.backend.release();
  await waitFor(()=>requests().some(r=>r.status===200&&
    new URL(r.route,'http://fixture').pathname.endsWith('/attempts/'+attemptId+'/complete')&&
    r.response?.job_digest===job.jobDigest),'same-job authorized completion',30000);
  assert.equal(up.backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal(requests().filter(r=>r.status===200&&
    /\/(?:claim|claim-next)$/.test(new URL(r.route,'http://fixture').pathname)&&
    r.response?.job_digest===job.jobDigest).length,1,'one successful exact-job claim');
  assert.equal(requests().filter(r=>r.status===200&&
    new URL(r.route,'http://fixture').pathname.endsWith('/attempts/'+attemptId+'/complete')&&
    r.response?.job_digest===job.jobDigest).length,1,'one successful exact-attempt completion');
});

async function ambiguous(t) {
  const f=await appFixture(t),{owner,circle}=await f.connect();
  await owner.app.close();
  const old=await saved(owner.home);old.modes={};old.standingRules=[];delete old.joinMode;
  await writeFile(disk(owner.home),JSON.stringify(old));
  return {f,owner,circle};
}
test('an unconfigured circle accepts an audited explicit Ask and stays Ask',async t=>{
  const {f,owner,circle}=await ambiguous(t);
  let app=(await f.start('owner')).app;
  for(let i=0;i<2;i++)assert.ok((await api(app,'/api/status')).lendingPrompts.some(p=>p.circle===circle.id));
  assert.equal((await saved(owner.home)).modes[circle.id],undefined);
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  assert.equal((await saved(owner.home)).modes[circle.id],'ask');
  assert.ok((await api(app,'/api/decisions')).events.some(e=>e.rule?.mode==='ask'&&e.circle===circle.id));
  await app.close();app=(await f.start('owner')).app;
  assert.deepEqual((await api(app,'/api/status')).lendingPrompts,[]);
});
test('explicit automatic answer survives restart without returning the prompt',async t=>{
  const {f,circle}=await ambiguous(t);
  let app=(await f.start('owner')).app;
  await api(app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await app.close();app=(await f.start('owner')).app;
  assert.deepEqual((await api(app,'/api/status')).lendingPrompts,[]);
  assert.equal((await api(app,'/api/status')).circles.find(c=>c.id===circle.id).lendingMode,'auto');
});
for(const scenario of ['startup','create'])test(scenario+' at 100 rules stays available and asks',async t=>{
  const {f,owner,circle}=await ambiguous(t);
  const old=await saved(owner.home);
  if(scenario==='create')old.modes[circle.id]='ask';
  old.standingRules=Array.from({length:100},(_,i)=>({id:'full-'+i,circle:'other-'+i,people:[owner.app.device.keyId],agents:[],maxWallSeconds:600,
    dailyJobs:1,weeklyJobs:7,dailyMinutes:10,weeklyMinutes:70,schedule:null,expiresAt:Date.now()+86400000}));
  await writeFile(disk(owner.home),JSON.stringify(old));
  const {app}=await f.start('owner');
  const target=scenario==='create'?await create(f,app,'At capacity'):circle;
  const status=await api(app,'/api/status');
  assert.equal((await saved(owner.home)).modes[target.id],undefined);
  assert.ok(status.lendingPrompts.some(p=>p.circle===target.id));
  assert.equal(status.circles.find(c=>c.id===target.id).lendingMode,'ask',
    'an unset circle at the rule cap reports Ask, not Automatic');
  assert.equal((await saved(owner.home)).standingRules.length,100);
  if(scenario==='startup'){
    const beforeRestart=await saved(owner.home);
    assert.ok(!beforeRestart.standingRules.some(r=>r.circle===target.id));
    await app.close();
    const again=await f.start('owner');
    const afterRestart=await saved(owner.home);
    assert.equal(afterRestart.modes[target.id],undefined);
    assert.ok(!afterRestart.standingRules.some(r=>r.circle===target.id));
    for(const key of ['modes','standingRules','pendingDefaultRules','configVersion'])
      assert.deepEqual(afterRestart[key],beforeRestart[key],key);
    const restartedStatus=await api(again.app,'/api/status');
    assert.equal(restartedStatus.circles.find(c=>c.id===target.id).lendingMode,'ask');
    assert.ok(restartedStatus.lendingPrompts.some(p=>p.circle===target.id));
  }
});
test('empty rules save on an unconfigured circle records Ask without granting a rule',async t=>{
  const {f,owner,circle}=await ambiguous(t),{app}=await f.start('owner');
  await api(app,'/api/lending/rules',{method:'POST',body:{rules:[]}});
  assert.equal((await saved(owner.home)).modes[circle.id],'ask');
  assert.deepEqual((await api(app,'/api/status')).lendingPrompts,[]);
});
// D8 (Lead ruling 11-11, replaces "removing the last rule saves Ask"): deleting the app's own rule while the circle is Automatic
// makes the default again. Only an explicit Ask stops it.
test('removing the app rule keeps Automatic and makes the default again; explicit Ask stays Ask',async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  await api(owner.app,'/api/lending/rules',{method:'POST',body:{rules:[]}});
  const afterDelete=await saved(owner.home);
  assert.equal(afterDelete.modes[circle.id],'auto');
  assert.equal(afterDelete.standingRules.filter(r=>r.id===afterDelete.appRuleIds[circle.id]).length,1);
  await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(owner.app,'/api/lending/rules',{method:'POST',body:{rules:[]}});
  assert.equal((await saved(owner.home)).modes[circle.id],'ask');
});

test('a restart with no modes map creates no rule or notice',async t=>{
  const {f,owner,circle}=await ambiguous(t);
  const old=await saved(owner.home);delete old.modes;
  await writeFile(disk(owner.home),JSON.stringify(old));
  const {app}=await f.start('owner');
  const status=await api(app,'/api/status');
  assert.equal(status.circles.find(c=>c.id===circle.id).lendingMode,'auto');
  assert.equal(Object.hasOwn(status,'automaticNotices'),false);
  assert.equal((await saved(owner.home)).modes[circle.id],undefined);
  assert.ok(!(await saved(owner.home)).standingRules.some(r=>r.circle===circle.id));
});

test('adopting an existing owned circle does not grant a fresh-join rule',async t=>{
  const {f,owner,circle}=await ambiguous(t);
  const local=(await owner.app.device.listCircles()).find(c=>!c.origin);
  assert.ok(local,'fixture retains the local device circle');
  const old=await saved(owner.home);old.joinMode='auto';old.activeCircle=local.id;old.intent='on';
  await writeFile(disk(owner.home),JSON.stringify(old));
  const {app}=await f.start('owner');
  await api(app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const status=await api(app,'/api/status');
  assert.equal(status.circles.find(c=>c.id===circle.id).lendingMode,'auto');
  assert.equal(Object.hasOwn(status,'automaticNotices'),false);
  assert.equal((await saved(owner.home)).modes[circle.id],undefined);
  assert.ok(!(await saved(owner.home)).standingRules.some(r=>r.circle===circle.id));
});

test('creating by an existing circle name adds no second rule or notice',async t=>{
  const {f,owner,circle}=await ambiguous(t),{app}=await f.start('owner');
  const reused=await create(f,app,circle.name);
  assert.equal(reused.id,circle.id,'the create endpoint reused the existing circle');
  const status=await api(app,'/api/status');
  assert.equal(status.circles.find(c=>c.id===circle.id).lendingMode,'auto');
  assert.equal(Object.hasOwn(status,'automaticNotices'),false);
  assert.ok(!(await saved(owner.home)).standingRules.some(r=>r.circle===circle.id));
});

test('a newly joined circle becomes automatic without raising saved budgets or limits',async t=>{
  const harness='claude-code-subscription',f=await appFixture(t);
  const owner=await f.start('owner'),lender=await f.start('lender',{adapters:[{
    spec:legacyProxyHarness(harness),installed:true,signedIn:true,harnessVersion:'synthetic-only',
    models:['claude-haiku-5-5'],capabilities:[]}]});
  await f.provisionFromHome('owner');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:2,dailyMinutes:17,maxWallSeconds:600,idleOnly:false}});
  await api(lender.app,'/api/lending/owner-settings',{method:'POST',body:{maxJobUsd:0.01,reason:'Keep the saved budget'}});
  const limits=(await saved(lender.home)).limits;
  const circle=await create(f,owner.app,'Joined after upgrade');
  await joinCircle(owner.app,lender.app,circle);
  await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const state=await saved(lender.home),rule=state.standingRules.find(r=>r.circle===circle.id);
  assert.equal(state.modes[circle.id],'auto');
  assert.deepEqual(state.limits,limits);
  assert.equal(rule.dailyJobs,2);assert.equal(rule.dailyMinutes,17);assert.equal(rule.maxWallSeconds,600);
  assert.equal((await api(lender.app,'/api/lending/owner-settings')).values.maxJobUsd,0.01);
  const agent=(await api(lender.app,'/api/agents')).find(a=>a.id===harness);
  assert.ok(!agent.lendable_models.includes('claude-haiku-5-5'),'the saved budget still excludes a model whose call cannot fit');
  assert.deepEqual((await api(lender.app,'/api/status')).lendingPrompts,[]);
});

test('a joined circle with saved Ask stays Ask after rejoining and restart',async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal((await saved(lender.home)).modes[circle.id],'auto');
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await lender.app.close();
  const restarted=await f.start('lender');
  await joinCircle(owner.app,restarted.app,circle);
  await api(restarted.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal((await saved(lender.home)).modes[circle.id],'ask');
  assert.ok(!(await saved(lender.home)).standingRules.some(r=>r.circle===circle.id));
  assert.deepEqual((await api(restarted.app,'/api/status')).lendingPrompts,[]);
});

test('a rules save for a pending joined circle wins over its new-join default after restart',async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),lender=await f.start('lender');
  await f.provisionFromHome('owner');
  const circle=await create(f,owner.app,'Pending join');
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[]}});
  assert.equal((await saved(lender.home)).modes[circle.id],'ask');
  await lender.app.close();
  const restarted=await f.start('lender');
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await api(restarted.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal((await saved(lender.home)).modes[circle.id],'ask');
  assert.deepEqual((await api(restarted.app,'/api/status')).lendingPrompts,[]);
});

test('a new join at 100 rules stays on Ask and offers the choice after approval',async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),lender=await f.start('lender');
  await f.provisionFromHome('owner');
  await lender.app.close();
  const old=await saved(lender.home);
  old.standingRules=Array.from({length:100},(_,i)=>({id:'full-'+i,circle:'other-'+i,people:[owner.app.device.keyId],agents:[],maxWallSeconds:600,
    dailyJobs:1,weeklyJobs:7,dailyMinutes:10,weeklyMinutes:70,schedule:null,expiresAt:Date.now()+86400000}));
  await writeFile(disk(lender.home),JSON.stringify(old));
  const restarted=await f.start('lender'),circle=await create(f,owner.app,'Joined at capacity');
  await joinCircle(owner.app,restarted.app,circle);
  await api(restarted.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const status=await api(restarted.app,'/api/status');
  assert.equal(status.circles.find(c=>c.id===circle.id).lendingMode,'ask');
  assert.ok(status.lendingPrompts.some(p=>p.circle===circle.id&&p.atRuleLimit));
});

for(const paused of [false,true])test('Not now fences '+(paused?'an in-flight':'a failed and retried')+' joined default',async t=>{
  let failAudit=true,entered,release;
  const enteredAudit=new Promise(resolve=>{entered=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const f=await appFixture(t),owner=await f.start('owner');
  const lender=await f.start('lender',{autoApprove:paused,approvalPollMs:50,decisionLog:()=>({async record(row){
    if(row.source!=='install_default'||row.supersedes)return;
    if(failAudit)throw new Error('synthetic audit unavailable');
    if(paused){entered();await barrier;}
  }})});
  await f.provisionFromHome('owner');
  const circle=await create(f,owner.app,'Dismissed join');
  await joinCircle(owner.app,lender.app,circle);
  const check=()=>api(lender.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  await check();
  assert.ok((await api(lender.app,'/api/status')).lendingPrompts.some(p=>p.circle===circle.id));
  if(paused){
    failAudit=false;
    // A background sweep is independent of the HTTP mutation queue.
    await enteredAudit;
  }
  await api(lender.app,'/api/lending/prompts/dismiss',{method:'POST',body:{circle:circle.id}});
  failAudit=false;release();
  for(let i=0;i<3;i++)await check();
  const state=await saved(lender.home);
  assert.equal(state.modes[circle.id],undefined);
  assert.ok(!state.standingRules.some(r=>r.circle===circle.id));
  assert.equal(state.pendingJoinedDefaults[circle.id],undefined);
  assert.deepEqual((await api(lender.app,'/api/status')).lendingPrompts,[]);
  await lender.app.close();
  // Restart is not a new join or a new owner grant.
  const again=await f.start('lender');
  assert.equal((await saved(lender.home)).modes[circle.id],undefined);
  assert.ok(!(await saved(lender.home)).standingRules.some(r=>r.circle===circle.id));
  assert.equal(Object.hasOwn(await api(again.app,'/api/status'),'automaticNotices'),false);
});

test('a mode-created Automatic rule follows new approved members without changing its limits or expiry',async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),friend=await f.start('new-friend');
  await f.provisionFromHome('owner');
  const circle=await create(f,owner.app,'Automatic members');
  await api(owner.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  const before=(await saved(owner.home)).standingRules.find(r=>r.circle===circle.id);
  await joinCircle(owner.app,friend.app,circle);
  // D9: members follow a fresh verified read (the owner's own publish is not one), which any circle check performs.
  await api(owner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  const after=(await saved(owner.home)).standingRules.find(r=>r.circle===circle.id);
  assert.ok(after.people.includes(friend.app.device.keyId));
  // D9: a fresh verified read renews the app rule in place; every other field is untouched.
  assert.ok(after.expiresAt>=before.expiresAt);
  assert.deepEqual({...after,people:before.people,expiresAt:before.expiresAt},before);
  const explicit={...after,people:[owner.app.device.keyId]};
  await api(owner.app,'/api/lending/rules',{method:'POST',body:{rules:[explicit]}});
  const savedRule=(await saved(owner.home)).standingRules.find(r=>r.id===before.id);
  assert.equal(savedRule.peopleScope,undefined,'saving named people ends automatic roster expansion');
  assert.deepEqual(savedRule.people,[owner.app.device.keyId]);
});
