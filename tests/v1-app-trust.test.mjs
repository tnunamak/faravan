import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor,adapters} from './helpers/v1-app-fixture.mjs';
import {observeAgentEvidence} from '../lib/v1/app.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const gitInput=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Decision receipt test',harness:'codex'});
test('explicit decline records its own decision and approval state',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,declining:lender,circle}=await f.realConnect();
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...gitInput(circle),send_anyway:true}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  assert.equal(card.offer,true);
  await api(lender.app,'/api/approvals/'+card.id+'/decline',{method:'POST',body:{}});
  const borrowerView=await api(owner.app,'/api/jobs/'+encodeURIComponent(sent.jobDigest));
  assert.equal(borrowerView.declined_count,1,'the requester app receives the anonymous signal');
  await waitFor(async()=>(await api(owner.app,'/api/activity?after=0')).some(e=>e.type==='job'&&e.data.job_digest===sent.jobDigest&&e.data.declined_count===1),'requester job change',15000);
  const log=await api(lender.app,'/api/decisions');
  assert.ok(log.events.some(e=>e.jobDigest===sent.jobDigest&&e.decision==='decline'));
  const events=await api(lender.app,'/api/activity?after=0');
  assert.ok(events.some(e=>e.type==='approval'&&e.data.id===card.id&&e.data.state==='declined'));
  await lender.app.close();
  const restarted=await f.start('declining');
  const saved=(await api(restarted.app,'/api/decisions')).events.find(e=>e.jobDigest===sent.jobDigest);
  assert.equal(saved.decision,'decline');
});

for(const decision of ['accept','skip'])test('local '+decision+' records the owner, device, job and time before responding',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/devices',{method:'POST',body:{name:'Review laptop',ownerName:'Sam'}});
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  const before=Date.now();
  await api(lender.app,'/api/approvals/'+card.id+'/'+decision,{method:'POST',body:{}});
  const log=await api(lender.app,'/api/decisions');
  const row=log.events.find(e=>e.jobDigest===sent.jobDigest&&e.decision===decision);
  assert.ok(row,'explicit decision is durably recorded');
  assert.deepEqual(row.decider,{deviceKey:lender.app.device.keyId,deviceName:'Review laptop',person:'Sam'});
  assert.equal(row.source,'manual');assert.equal(row.circle,circle.id);
  assert.ok(row.at>=before&&row.at<=Date.now());
  assert.equal(typeof row.configVersion,'number');
});

test('confirmed missing credential overrides a prior successful sign-in immediately',()=>{
  const prior=observeAgentEvidence({}, {signedIn:true,installed:true},'job',100);
  const missing=observeAgentEvidence(prior,{signedIn:false,credentialMissing:true},'sandbox-store',200);
  assert.equal(missing.signedIn,false);assert.equal(missing.checkFailed,false);
  assert.ok(missing.evidence.some(e=>e.fact==='signed_in'&&e.value===false&&e.source==='sandbox-store'));
});

test('freeze audience refuses an old host before uploading prompt or source',{timeout:120000},async t=>{
  const f=await appFixture(t);f.hostCapabilities={capabilities:[]};
  const {owner,circle}=await f.connect();
  const uploads=()=>f.requests.filter(r=>r.method==='PUT'||r.route?.includes('artifact-reservations')).length;
  const before=uploads();
  const response=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...gitInput(circle),freeze_audience:true},status:409});
  assert.equal(response.code,'host_too_old');assert.equal(uploads(),before);
});

test('automatic lending records the policy and decider for each acceptance',{timeout:120000},async t=>{
  const now=Date.now(),source=createSyntheticPace50Source({start:now});
  const harness='claude-code-subscription';
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({syntheticAccounts:'claude'});
  await api(lender.app,'/api/agents/'+harness+'/run',{method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false,
    lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...gitInput(circle),harness}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const row=await waitFor(async()=>{const log=await api(lender.app,'/api/decisions');return log.events.find(e=>e.jobDigest===sent.jobDigest&&e.source==='standing-rule');},'automatic decision receipt');
  assert.equal(row.decision,'accept');assert.equal(row.decider.deviceKey,lender.app.device.keyId);assert.ok(row.rule);
});

test('changing automatic lending records its grant and configured owner',{timeout:120000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  const grant=(await api(lender.app,'/api/decisions')).events.find(e=>e.kind==='standing_rule');
  assert.ok(grant);assert.equal(grant.decider.deviceKey,lender.app.device.keyId);
  assert.equal(grant.circle,circle.id);assert.equal(grant.source,'manual');assert.ok(grant.rule);
});

test('an audit write failure cannot enable automatic lending',{timeout:120000},async t=>{
  const {mkdir,readFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await mkdir(join(lender.home,'v1','decisions.json'));
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'},status:409});
  const settings=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.notEqual(settings.modes[circle.id],'auto');
});

test('frozen submit signs the current devices and a draft cannot broaden them',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const input={...gitInput(circle),freeze_audience:true,draft_id:'frozen-draft-0001'};
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:input});
  const payload=f.jobs.get(sent.jobDigest).job.payload;
  const roster=(await owner.app.device.rosterCache(circle.id).get()).current.payload;
  assert.deepEqual(payload.audience.device_keys,roster.members.map(m=>m.key_id).sort());
  const replay=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:input});assert.equal(replay.jobDigest,sent.jobDigest);
  const changed=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{...input,freeze_audience:false},status:409});assert.equal(changed.code,'draft_changed');
});

test('a refused combined limits and mode save leaves every limit unchanged',{timeout:120000},async t=>{
  const {mkdir,readFile}=await import('node:fs/promises');const {join}=await import('node:path');
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,idleOnly:true}});
  await mkdir(join(lender.home,'v1','decisions.json'));
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:9,idleOnly:false,mode:'auto',circle:circle.id},status:409});
  assert.equal((await api(lender.app,'/api/lending')).limits.dailyJobs,3);
  await api(lender.app,'/api/devices',{method:'POST',body:{name:'Changed'}});
  const saved=JSON.parse(await readFile(join(lender.home,'v1','app-settings.json'),'utf8'));
  assert.equal(saved.limits.dailyJobs,3);assert.equal(saved.limits.idleOnly,true);
});

test('concurrent duplicate declines share one decision and never invalidate its receipt',{timeout:120000},async t=>{
  const {createDecisionLog}=await import('../lib/v1/decision-log.mjs');
  let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  let records=0;
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({decisionLog:directory=>{
    const log=createDecisionLog(directory);
    return {...log,record:async row=>{if(row.kind==='job'&&row.decision==='skip'&&!row.supersedes){records++;entered();await held;}return log.record(row);}};
  }});
  t.after(()=>release());
  const sent=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:gitInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  // Use the fixture API's configured session token, then hold the first durable write.
  const first=api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  await started;
  let arrived;const secondRead=new Promise(resolve=>{arrived=resolve;});
  const observe=req=>{if(req.url==='/api/approvals/'+card.id+'/skip')req.once('end',()=>setImmediate(arrived));};
  lender.app.server.on('request',observe);t.after(()=>lender.app.server.off('request',observe));
  const second=api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  await secondRead;release();
  const outcomes=await Promise.allSettled([first,second]);
  assert.equal(outcomes.every(row=>row.status==='fulfilled'),true,JSON.stringify(outcomes));
  assert.deepEqual(outcomes[0].value,outcomes[1].value);
  assert.equal(records,1,'one receipt owns the decision');
  const log=await api(lender.app,'/api/decisions');
  assert.equal(log.events.some(row=>row.jobDigest===sent.jobDigest&&row.applied===false),false);
});
