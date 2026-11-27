import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

test('lending intent before a join adopts the joined circle and can resume', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  const lender = await f.start('newcomer');
  await f.provisionFromHome('owner');
  const pseudo = (await api(lender.app, '/api/circles')).find(circle => circle.name === 'My devices');
  assert.ok(pseudo);
  await api(lender.app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  await api(lender.app, '/api/agents/refresh', {method:'POST',body:{}});
  const before = await api(lender.app, '/api/lending/on', {method:'POST',body:{}});
  assert.equal(before.circle, null);
  assert.equal(before.enabled, false);
  assert.equal((await api(lender.app, '/api/home')).intent.on, true);

  const circle = await api(owner.app, '/api/circles', {method:'POST',body:{origin:f.origin,name:'Weekend projects'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/join', {method:'POST',body:{link:invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method:'POST',body:{}});
  assert.equal((await api(lender.app, '/api/lending')).circle, circle.id);
  const resumed = await api(lender.app, '/api/lending/resume', {method:'POST',body:{circle:pseudo.id}});
  assert.equal(resumed.circle, circle.id);
  assert.equal(resumed.enabled, true);
  // Resume acceptance is not a barrier for the separately observed home readiness.
  await waitFor(async () => (await api(lender.app, '/api/home')).intent.state === 'ready',
    'joined-circle lending is ready after resume', 60000);
  assert.equal((await api(lender.app, '/api/home')).intent.state, 'ready');
});

test('a saved legacy My devices target cannot resume there and adopts the real circle', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  const lender = await f.start('newcomer');
  await f.provisionFromHome('owner');
  const pseudo = (await api(lender.app, '/api/circles')).find(circle=>circle.name==='My devices');
  await api(lender.app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  await api(lender.app, '/api/agents/refresh', {method:'POST',body:{}});
  await lender.app.close();
  const file=join(lender.home,'v1','app-settings.json');
  const settings=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...settings,intent:'on',enabled:true,activeCircle:pseudo.id}));
  const legacy=await f.start('newcomer');
  await waitFor(async()=>(await api(legacy.app,'/api/lending')).circle===null,'legacy target cleared');

  const circle = await api(owner.app, '/api/circles', {method:'POST',body:{origin:f.origin,name:'Weekend projects'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST',body:{}});
  await api(legacy.app, '/api/circles/join', {method:'POST',body:{link:invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST',body:{}});
  await api(legacy.app, '/api/circles/' + circle.id + '/check', {method:'POST',body:{}});
  const joined = await api(legacy.app, '/api/lending');
  assert.equal(joined.circle, circle.id);
  assert.equal(joined.enabled, true, 'approved join starts previously requested lending');
  assert.notEqual((await api(legacy.app, '/api/home')).intent.state, 'paused');
  const resumed = await api(legacy.app, '/api/lending/resume', {method:'POST',body:{circle:pseudo.id}});
  assert.equal(resumed.circle, circle.id);
  assert.equal(resumed.enabled, true);
});

test('startup clears a legacy My devices target instead of choosing among joined circles', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  const lender = await f.start('newcomer');
  await f.provisionFromHome('owner');
  const pseudo = (await api(lender.app, '/api/circles')).find(circle=>circle.name==='My devices');
  for (const name of ['Circle A','Circle B']) {
    const circle = await api(owner.app, '/api/circles', {method:'POST',body:{origin:f.origin,name}});
    const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST',body:{}});
    await api(lender.app, '/api/circles/join', {method:'POST',body:{link:invite}});
    await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST',body:{}});
    await api(lender.app, '/api/circles/' + circle.id + '/check', {method:'POST',body:{}});
  }
  await lender.app.close();
  const file=join(lender.home,'v1','app-settings.json');
  const settings=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...settings,intent:'on',enabled:true,activeCircle:pseudo.id}));

  const restarted=await f.start('newcomer');
  await waitFor(async()=>(await api(restarted.app,'/api/lending')).circle===null,'legacy target cleared');
  await waitFor(async()=>(await api(restarted.app,'/api/home')).intent.reason==='lending_not_started',
    'resume recovery shown for an already joined circle');
  const conflict=await api(restarted.app,'/api/lending/resume',
    {method:'POST',body:{circle:pseudo.id},status:409});
  assert.deepEqual({code:conflict.code,message:conflict.message},{
    code:'circle_ambiguous',message:'Choose the circle you want to lend to, then try again.'});
});

// r8 review P1: a pause with no end keeps intent on, so joining a circle must not resume lending behind the person's back.
test('joining a circle does not resume lending that the person paused', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  const lender = await f.start('newcomer');
  await f.provisionFromHome('owner');
  await api(lender.app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  await api(lender.app, '/api/agents/refresh', {method:'POST',body:{}});
  await api(lender.app, '/api/lending/on', {method:'POST',body:{}});
  await api(lender.app, '/api/lending/pause', {method:'POST',body:{}});

  const circle = await api(owner.app, '/api/circles', {method:'POST',body:{origin:f.origin,name:'Weekend projects'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/join', {method:'POST',body:{link:invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method:'POST',body:{}});
  const status = await api(lender.app, '/api/status');
  assert.equal(status.state, 'paused');
  assert.equal((await api(lender.app, '/api/lending')).enabled, false);
  const resumed = await api(lender.app, '/api/lending/resume', {method:'POST',body:{circle:circle.id}});
  assert.equal(resumed.enabled, true);
});

test('Stop cancels an automatic job, leaves lending off across restart, and fresh allowance gates the explicit On', {timeout:120000}, async t => {
  const realNow=Date.now.bind(Date); let allowanceOffset=0, readings=0, probes=0, readGate=null, readEntered=false;
  const allowanceNow=()=>realNow()+allowanceOffset;
  const harness='claude-code-subscription', reset=realNow()+86400000;
  const agents=()=>[{spec:legacyProxyHarness(harness),installed:true,signedIn:true,
    harnessVersion:'synthetic-only',models:['example-model'],capabilities:[]}];
  const source=createSyntheticPace50Source({start:realNow(),resets:{weekly:7*86400000,short:5*3600000}});
  const observe=source.observe.bind(source);
  source.observe=async input=>{readings++;if(readGate){readEntered=true;await readGate;}return observe(input);};
  const common={adapters:agents(),
    lendingPace50:{source,account_week_id:'synthetic-week-1'},
    quotaReader:async()=>({provider:'claude',remaining:100,observedAt:allowanceNow()}),
    lendingNow:allowanceNow};
  const held={hold:true}, f=await appFixture(t,held);
  const {owner,lender,circle}=await f.connect(common);
  await api(lender.app,'/api/agents/'+harness+'/run',{method:'POST',body:{model:'claude-haiku-5-5',effort:null}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:4,dailyMinutes:80,
    maxWallSeconds:1200,idleOnly:false,lendingPolicy:{strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30},
      providerConsent:{claude:true},accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
  const rule={id:'stop-restart-on',circle:circle.id,people:[owner.app.device.keyId],agents:[harness],
    maxWallSeconds:1200,dailyJobs:4,weeklyJobs:12,dailyMinutes:80,weeklyMinutes:240,expiresAt:realNow()+86400000};
  await api(lender.app,'/api/lending/rules',{method:'POST',body:{rules:[rule]}});
  const frozen=await api(lender.app,'/api/lending');
  const settingsFile=join(lender.home,'v1','app-settings.json');
  const savedBefore=JSON.parse(await readFile(settingsFile,'utf8'));
  const submit=prompt=>api(owner.app,'/api/jobs',{method:'POST',body:{
    circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt,harness}});
  const first=await submit('Held automatic job to stop');
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  // The continuous M1 rule can lend on day one from its declared prior; no whole-window warmup applies.
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'actual held automatic execution',30000);
  const attempt=f.jobs.get(first.jobDigest).current_attempt;
  assert.ok(attempt?.execution_started_at);
  assert.notEqual(f.jobs.get(first.jobDigest).state,'result-accepted');
  const second=await submit('Queued job while stopped');
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{confirmed:true,attemptId:attempt.attempt_id}});
  await waitFor(()=>attempt.compute_stopped&&lender.backend.calls.some(([kind])=>kind==='destroy'),
    'actual cancellation and reported cessation',20000);
  assert.ok(lender.backend.calls.some(([kind])=>kind==='cancel'));
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.notEqual(f.jobs.get(first.jobDigest).state,'result-accepted');
  await waitFor(async()=>{const view=await api(lender.app,'/api/lending'),saved=JSON.parse(await readFile(settingsFile,'utf8'));return view.counters?.pending===null&&!view.current&&saved.intent==='off'?view:null;},'Stop recovery cleared with lending off');
  const stopped=JSON.parse(await readFile(settingsFile,'utf8'));
  assert.equal(stopped.intent,'off'); assert.equal(stopped.enabled,false);
  assert.deepEqual(stopped.standingRules,savedBefore.standingRules);
  assert.deepEqual(stopped.limits,savedBefore.limits);
  await lender.app.close();
  held.hold=false;
  const restarted=await f.start('lender',{...common,adapters:[{spec:legacyProxyHarness(harness)}],
    identityProbe:async()=>{probes++;return {providers:[{harness_id:harness,installed:true,signedIn:true}]};}});
  await api(restarted.app,'/api/agents/refresh',{method:'POST',body:{}});
  await api(restarted.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.ok(probes>0,'fresh agent evidence exists after restart');
  const resumed=await api(restarted.app,'/api/lending');
  assert.equal((await api(restarted.app,'/api/home')).intent.on,false,'a restart does not turn lending back on after Stop');
  assert.equal(f.jobs.get(second.jobDigest).state,'queued');
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,0);
  assert.deepEqual(resumed.standingRules,frozen.standingRules);
  const disk=JSON.parse(await readFile(settingsFile,'utf8'));
  assert.equal(disk.intent,'off');
  // A stopped reservation remains conservatively charged; wait out the real hourly allowance cap.
  allowanceOffset+=3600001;
  const readsBefore=readings;
  let releaseRead; readGate=new Promise(resolve=>{releaseRead=resolve;}); t.after(()=>releaseRead());
  const turningOn=api(restarted.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>readEntered&&readings>readsBefore,'fresh allowance read gates explicit On',20000);
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,0);
  releaseRead(); readGate=null; await turningOn;
  // Persisted owner intent needs fresh readings, not an invented new ten-minute delay.
  await waitFor(()=>f.jobs.get(second.jobDigest).state==='result-accepted','queued job only executes after explicit On',30000).catch(async error=>{throw new Error(error.message+': '+JSON.stringify({view:await api(restarted.app,'/api/lending'),job:f.jobs.get(second.jobDigest),calls:restarted.backend.calls.map(([kind])=>kind),readings}),{cause:error});});
  allowanceOffset+=3600001;
  const third=await submit('New authorized job after explicit On');
  await waitFor(()=>f.jobs.get(third.jobDigest).state==='result-accepted','new borrower job completes',30000);
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,2);
  const final=JSON.parse(await readFile(settingsFile,'utf8'));
  assert.deepEqual(final.standingRules,savedBefore.standingRules);
  assert.deepEqual(final.limits,savedBefore.limits);
});

test('a fresh install lends automatically: lending on, Auto in the first circle it joins, both providers consented', async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  const lender = await f.start('newcomer', {freshLending:'automatic'});
  await f.provisionFromHome('owner');
  await api(lender.app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  await api(lender.app, '/api/agents/refresh', {method:'POST',body:{}});
  assert.equal((await api(lender.app, '/api/home')).intent.on, true);
  const fresh = await api(lender.app, '/api/lending');
  assert.deepEqual(fresh.limits.lendingPolicy.providerConsent, {claude:true, codex:true});
  const circle = await api(owner.app, '/api/circles', {method:'POST',body:{origin:f.origin,name:'Weekend projects'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/join', {method:'POST',body:{link:invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST',body:{}});
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method:'POST',body:{}});
  const lending = await api(lender.app, '/api/lending');
  assert.equal(lending.circle, circle.id);
  assert.equal(lending.enabled, true);
  assert.equal(lending.mode, 'auto', 'joining needs no Auto click');
  const rule = lending.standingRules.find(r => r.circle === circle.id);
  assert.ok(rule?.people.includes(owner.app.device.keyId), 'the circle owner is covered by the install rule');
  const receipts = JSON.parse(await readFile(join(lender.home, 'v1', 'decisions.json'), 'utf8')).events
    .filter(r => r.kind === 'standing_rule' && r.rule?.id === rule.id);
  // D9: a later verified roster read may renew the app rule in place; nothing else touches it.
  assert.deepEqual(receipts.map(r => [r.decision, r.source])[0], ['create', 'install_default']);
  assert.ok(receipts.slice(1).every(r => r.decision === 'update' && r.source === 'roster_renewal'));
  // The owner's own choice still wins: Ask replaces the install rule.
  await api(lender.app, '/api/lending/mode', {method:'POST',body:{circle:circle.id,mode:'ask'}});
  assert.equal((await api(lender.app, '/api/lending')).mode, 'ask');
});

test('an existing install keeps its saved choices: no consent or Auto is added on upgrade', async t => {
  const f = await appFixture(t);
  const first = await f.start('existing');
  await first.app.close();
  const restarted = await f.start('existing', {freshLending:'automatic'});
  const lending = await api(restarted.app, '/api/lending');
  assert.equal(lending.intent, 'off');
  assert.deepEqual(lending.limits.lendingPolicy.providerConsent, {});
});

test('retired qualification latch no longer pauses saved On, while explicit Off survives restart', {timeout:60000}, async t=>{
  const f=await appFixture(t), first=await f.start('retired-qualification');
  await first.app.close();
  const file=join(first.home,'v1','app-settings.json');
  const saved=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...saved,intent:'on',enabled:false,paused:true,pause_until:null,isolationFailure:'synthetic qualification failure'}));
  const restarted=await f.start('retired-qualification');
  const status=await api(restarted.app,'/api/status');
  assert.ok(!status.lending_blockers.items.some(row=>row.key==='isolation_check'));
  const migrated=JSON.parse(await readFile(file,'utf8'));
  assert.equal(migrated.isolationFailure,undefined);
  assert.equal(migrated.paused,false);
  await api(restarted.app,'/api/lending/off',{method:'POST',body:{}});
  await restarted.app.close();
  const off=await f.start('retired-qualification');
  assert.equal((await api(off.app,'/api/home')).intent.on,false);
});
