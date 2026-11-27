import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/offers-jobs-fixture.mjs';
import {canonicalize} from '../lib/protocol/index.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {problemForError} from '../lib/v1/cli.mjs';

test('Pause holds open modern offers without hiding them on Resume or restart',{timeout:120000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const submit=prompt=>api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt,harness:'codex'}});
 const first=await submit('First waiting offer'),second=await submit('Second waiting offer');
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 // Ask is the owner's explicit choice. Without one, an upgraded install adopts the Automatic default at its next start.
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const cards=await waitFor(async()=>{const rows=await api(lender.app,'/api/approvals');return rows.length===2?rows:null;},'two waiting offers');
 await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
 const stored=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));
 for(const job of [first,second])assert.ok(!(stored.hiddenOffers??[]).some(row=>row.jobDigest===job.jobDigest),'Pause does not hide an offer');
 assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
 await lender.app.close();
 const restarted=await f.start('lender');
 // Resume answers within one second: 200 when the start finished, or 202 resume_pending (saved) when the disk is slow.
 // Both are the same intent, so wait for lending to be on rather than for one answer.
 const answered=await fetch(restarted.app.origin+'/api/lending/resume',{method:'POST',headers:{'x-faravan-session-token':restarted.app.token,'content-type':'application/json'},body:JSON.stringify({circle:circle.id})});
 assert.ok([200,202].includes(answered.status),'resume answered '+answered.status);
 const body=await answered.json();
 if(answered.status===202) {
  assert.equal(typeof body.saved,'boolean');
  assert.deepEqual(body,{...problemForError({code:'resume_pending'}),state:'pending',saved:body.saved});
 } else {
  assert.deepEqual({enabled:body.enabled,lending_on:body.lending_on,circle:body.circle,intent:body.intent,paused:body.paused,pause_until:body.pause_until,mode:body.mode},
   {enabled:true,lending_on:true,circle:circle.id,intent:'on',paused:false,pause_until:null,mode:'ask'});
  assert.ok(Array.isArray(body.standingRules));assert.ok(Array.isArray(body.requesterLimits));
  assert.equal(typeof body.limits,'object');assert.ok(body.limits!==null);
  assert.equal(typeof body.configVersion,'number');assert.equal(body.priorRole,'starting assumption');
  assert.equal(typeof body.status,'string');assert.equal(Object.hasOwn(body,'code'),false);
 }
 await waitFor(async()=>(await api(restarted.app,'/api/lending')).enabled===true||null,'lending is on after Resume');
 await waitFor(async()=>{const rows=await api(restarted.app,'/api/approvals');return cards.every(old=>rows.some(row=>row.jobDigest===old.jobDigest));},'offers return after restart');
});

for(const [label,capabilities,started,online,deciding,source='heartbeat'] of [
 ['an older lender is deciding',['progress_v1'],false,true,true],
 ['a new lender is preparing',['progress_v1','offers_v1'],false,true,false],
 ['an older lender has started',['progress_v1'],true,true,false],
 ['an offline older holder is unknown',['progress_v1'],false,false,false],
 ['a fresh poll leaves an older holder unknown',['progress_v1'],false,true,false,'poll'],
 ['a fresh poll does not approve a modern holder',['progress_v1','offers_v1'],false,true,false,'poll'],
])test('borrower offer facts: '+label,{timeout:30000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const base=f.override;
 f.override=async ctx=>{
  if(ctx.route!=='/presence')return base(ctx);
  const at=Date.now();
  const devices=[{device:lender.app.device.keyId,online,source,last_poll_at:new Date(at).toISOString(),
    last_heartbeat_at:new Date(at-(source==='poll'?300000:0)).toISOString(),intent:{state:'ready'},capabilities},
   {device:owner.app.device.keyId,online:true,source:'heartbeat',last_heartbeat_at:new Date(at).toISOString(),
    intent:{state:'ready'},capabilities:['offers_v1']},
   {device:'offline',online:false,intent:{state:'ready'},capabilities:[]}];
  const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices,persons:[]}));
  ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
 };
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic request',harness:'codex',send_anyway:true}});
 const limits=f.jobs.get(jobDigest).job.payload.requirements.limits;
 await (await lender.app.device.client(circle.id)).claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1'],egress:['internet','provider-only'],enforced_limits:Object.keys(limits),max_limits:limits},{waitSeconds:0});
 if(started){const at=new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
  Object.assign(f.jobs.get(jobDigest).current_attempt,{execution_started_at:at,execution_observed_at:at});}
 const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
 const available=online&&source==='heartbeat';
 const approval=available&&capabilities.includes('offers_v1')?'approved':'pending';
 if(started)assert.equal(view.offerWaiting,undefined,'a started job no longer needs waiting offer facts');
 else assert.deepEqual(view.offerWaiting,{readyCount:available?1:0,dailyLimitCount:0,dailyLimitDevices:[],dailyLimitNames:[],deciding:deciding?lender.app.device.keyId:null,approval});
 assert.equal(view.approval,started?'approved':approval,'execution proves consent even for an older lender');
});

test('running status reaches both installs within two seconds of the recorded execution start',{timeout:30000},async t=>{
 const f=await appFixture(t),host=await f.start('host',{pollMs:60_000});
 let borrower=await f.start('borrower',{pollMs:60_000}),lender=await f.start('lender',{pollMs:60_000});
 await f.provisionFromHome('host');
 const circle=await api(host.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Synthetic friends'}});
 for(const member of [borrower,lender]){
  const {invite}=await api(host.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await api(member.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(host.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await member.app.device.refreshRoster(circle.id);
 }
 await borrower.app.close();await lender.app.close();
 borrower=await f.start('borrower',{pollMs:60_000});lender=await f.start('lender',{pollMs:60_000});
 const {jobDigest}=await api(borrower.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic running status',harness:'codex',send_anyway:true}});
 const limits=f.jobs.get(jobDigest).job.payload.requirements.limits,client=await lender.app.device.client(circle.id);
 const claim=await client.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1'],
  egress:['internet','provider-only'],enforced_limits:Object.keys(limits),max_limits:limits},{waitSeconds:0});
 const started=await client.startAttempt(claim.attempt),observed=await client.observeExecutionStart(claim.attempt),startedAt=Date.parse(observed.execution_observed_at);
 let presenceCalls=0;const presenceTimes=[],traceStart=f.networkTrace.length,dispatch=f.override;
 f.override=async context=>{
  if(context.route==='/presence'){
   presenceCalls++;const read={device:context.req.headers['x-test-device'],startedAt:Date.now(),recordedExecutionStartedAt:f.jobs.get(jobDigest).current_attempt.execution_started_at};presenceTimes.push(read);
   await new Promise(resolve=>setTimeout(resolve,2300));
   read.finishedAt=Date.now();
  }
  return dispatch(context);
 };
 const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id;
 const reads=await Promise.all([{role:'borrower',app:borrower.app},{role:'lender',app:lender.app}].map(async({role,app})=>{
  const requestedAt=Date.now();
  const view=await api(app,path);
  const completedAt=Date.now();
  return {role,view,requestedAt,completedAt,latencyMs:completedAt-startedAt};
 }));
 for(const {role,view} of reads){
  assert.equal(view.current_attempt.execution_started_at,started.execution_started_at,role+' reads the durable start-request fence');
  assert.equal(view.current_attempt.execution_observed_at,observed.execution_observed_at,role+' reads backend launch evidence');
  assert.equal(view.statusContract.lifecycle,'running',role+' status read reports Running');
 }
 const slow=reads.filter(({latencyMs})=>latencyMs>2000).map(({role,latencyMs})=>({role,latencyMs}));
 const trace=f.networkTrace.slice(traceStart).map(({device,method,route,status})=>({device,method,route,status}));
 assert.deepEqual(slow,[],`status latency after execution_started_at exceeded 2000 ms: ${JSON.stringify({reads:reads.map(({role,requestedAt,completedAt,latencyMs})=>({role,requestedAt,completedAt,latencyMs})),presenceTimes,trace})}`);
 assert.equal(presenceCalls,0,'started-job status reads do not wait for coordinator presence');
 t.diagnostic(`Running status arrived from the recorded start in ${reads.map(({role,latencyMs})=>role+': '+latencyMs+' ms').join(', ')}.`);
});

for(const source of ['heartbeat','poll'])test('borrower offer facts use only a current heartbeat for today’s limit: '+source,{timeout:30000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 f.override=async ctx=>{
  if(ctx.route!=='/presence')return false;
  const devices=[
   {device:lender.app.device.keyId,online:true,source,last_poll_at:new Date().toISOString(),
    last_heartbeat_at:new Date(Date.now()-(source==='poll'?300000:0)).toISOString(),
    intent:{state:'resting',reason:'daily_limit'},capabilities:['offers_v1']},
   {device:owner.app.device.keyId,online:true,intent:{state:'ready'},capabilities:['offers_v1']},
   {device:'offline-limited',online:false,intent:{state:'resting',reason:'daily_limit'},capabilities:[]},
  ];
  const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices,persons:[]}));
  ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
 };
 await api(owner.app,'/api/circles/'+circle.id+'/petnames',{method:'POST',body:{keyId:lender.app.device.keyId,label:'Known lender'}});
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic limit explanation',harness:'codex',send_anyway:true}});
 const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
 const limited=source==='heartbeat';
 assert.deepEqual(view.offerWaiting,{readyCount:0,dailyLimitCount:limited?1:0,
  dailyLimitDevices:limited?[lender.app.device.keyId]:[],dailyLimitNames:limited?['Known lender']:[],deciding:null,approval:null});
 assert.equal(view.approval,null,'an unclaimed job has no approval');
});

for(const action of ['pause','off'])test('app '+action+' during preparation stops the start and resumes accepted work without another card',{timeout:60000},async t=>{
 let release;const boot=new Promise(resolve=>{release=resolve;});
 const f=await appFixture(t),{owner,lender,circle}=await f.connect({heartbeatMs:100});
 const prepare=lender.backend.prepare;let preparing=false;
 lender.backend.prepare=async(...args)=>{preparing=true;await boot;return prepare(...args);};
 try {
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Pause-safe synthetic task',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review');
  const reviewStatus=await api(lender.app,'/api/status'),reviewHome=await api(lender.app,'/api/home');
  assert.notEqual(reviewStatus.lendingProjection.execution,'running');assert.notEqual(reviewStatus.lendingProjection.execution,'finishing');
  assert.notEqual(reviewHome.execution?.state,'running');assert.notEqual(reviewHome.execution?.state,'finishing');
  const reviewHeartbeat=await waitFor(()=>f.heartbeats?.findLast(body=>body.execution?.state==='idle'),'idle heartbeat during open approval');
  assert.notEqual(reviewHeartbeat.execution.state,'running');assert.notEqual(reviewHeartbeat.execution.state,'finishing');
  assert.equal((await api(owner.app,'/api/notifications')).notifications.some(row=>row.kind==='started'),false);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});await waitFor(()=>preparing,'delayed preparation');
  const status=await api(lender.app,'/api/status'),home=await api(lender.app,'/api/home');
  assert.notEqual(status.lendingProjection.execution,'running');assert.notEqual(status.lendingProjection.execution,'finishing');
  assert.notEqual(home.execution?.state,'running');assert.notEqual(home.execution?.state,'finishing');
  const heartbeat=await waitFor(()=>f.heartbeats?.findLast(body=>body.execution?.state==='idle'),'idle heartbeat during preparation');
  assert.notEqual(heartbeat.execution.state,'running');assert.notEqual(heartbeat.execution.state,'finishing');
  const alerts=await api(owner.app,'/api/notifications');assert.equal(alerts.notifications.some(row=>row.kind==='started'),false);
  await api(lender.app,'/api/lending/'+action,{method:'POST',body:{}});release();
  await waitFor(async()=>lender.backend.calls.some(([kind])=>kind==='destroy')&&!(await api(lender.app,'/api/lending')).current,'preparation removed');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.jobs.get(jobDigest).attempts_started,0);
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>f.jobs.get(jobDigest).state==='result-accepted','accepted work resumes',30000);
  assert.deepEqual(await api(lender.app,'/api/approvals'),[]);assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,1);
 }finally {release();}
});

test('explicit Stop during preparation revokes accepted consent and Resume cannot run it',{timeout:60000},async t=>{
 let release;const boot=new Promise(resolve=>{release=resolve;});
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();const prepare=lender.backend.prepare;let preparing=false;
 lender.backend.prepare=async(...args)=>{preparing=true;await boot;return prepare(...args);};
 try {
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Explicitly stopped task',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review');await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>preparing,'delayed preparation');const attemptId=(await api(lender.app,'/api/lending')).current;
  await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}});
  const durable=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));
  assert.equal(durable.acceptedClaim,null);assert.equal(durable.pending.stopReason,'stopped_by_lender');
  assert.ok(durable.hiddenOffers.some(row=>row.jobDigest===jobDigest));release();
  await waitFor(async()=>lender.backend.calls.some(([kind])=>kind==='destroy')&&!(await api(lender.app,'/api/lending')).current,'stopped preparation removed');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.jobs.get(jobDigest).attempts_started,0);
  const stopped=await api(lender.app,'/api/lending');assert.equal(stopped.counters.acceptedClaim,null);assert.ok(stopped.counters.hiddenOffers.some(row=>row.jobDigest===jobDigest));
  await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).status==='idle','resumed lending stays idle');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);assert.deepEqual(await api(lender.app,'/api/approvals'),[]);
 }finally {release();}
});

test('Quit during accepted preparation preserves consent and the next app start finishes the work',{timeout:120000},async t=>{
 let release;const boot=new Promise(resolve=>{release=resolve;});
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();const prepare=lender.backend.prepare;let preparing=false;
 lender.backend.prepare=async(...args)=>{preparing=true;await boot;return prepare(...args);};
 try {
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Resume after Quit',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review');await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});await waitFor(()=>preparing,'delayed preparation');
  let outcome;const quitting=api(lender.app,'/api/shutdown',{method:'POST',body:{},status:202}).then(value=>{outcome={value};},error=>{outcome={error};});
  await waitFor(async()=>outcome||!(await api(lender.app,'/api/lending')).enabled,'Quit fences preparation');if(outcome?.error)throw outcome.error;
  release();await quitting;if(outcome.error)throw outcome.error;await lender.app.close();
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.jobs.get(jobDigest).attempts_started,0);
  const saved=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));assert.ok(saved.acceptedClaim);assert.ok(!saved.hiddenOffers?.some(row=>row.jobDigest===jobDigest));
  const restarted=await f.start('lender');await waitFor(()=>f.jobs.get(jobDigest).state==='result-accepted','accepted work finishes after restart',30000);
  assert.equal(restarted.backend.calls.filter(([kind])=>kind==='run').length,1);assert.deepEqual(await api(restarted.app,'/api/approvals'),[]);
 }finally {release();}
});

for(const action of ['stop','shutdown'])test('explicit '+action+' revokes an accepted job before a sandbox reservation exists',{timeout:120000},async t=>{
 let release;const admission=new Promise(resolve=>{release=resolve;});
 const f=await appFixture(t),{owner,lender,circle}=await f.connect(),admit=lender.backend.admitJob;let checking=false;
 lender.backend.admitJob=async(...args)=>{checking=true;await admission;return admit(...args);};
 try {
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Stop before sandbox admission',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'offer review');await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});await waitFor(()=>checking,'admission pending before reservation');
  const before=await api(lender.app,'/api/lending');assert.equal(before.counters.pending,null);assert.ok(before.counters.acceptedClaim);
  await api(lender.app,action==='stop'?'/api/lending/stop':'/api/shutdown',{method:'POST',body:{attemptId:before.current,confirmed:true},status:action==='stop'?200:202});
  const durable=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));assert.equal(durable.acceptedClaim,null);assert.ok(durable.hiddenOffers.some(row=>row.jobDigest===jobDigest));release();
  let current=lender;
  if(action==='shutdown'){await lender.app.close();current=await f.start('lender');}
  else await waitFor(async()=>!(await api(lender.app,'/api/lending')).current,'stopped before preparation');
  await waitFor(async()=>{const state=await api(current.app,'/api/lending');return state.counters&&!state.current&&!state.counters.pending&&!state.counters.declinePending;},'durable stop release settled');
  await api(current.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});await waitFor(async()=>(await api(current.app,'/api/lending')).status==='idle','resumed after explicit stop');
  assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);assert.equal(current.backend.calls.filter(([kind])=>kind==='run').length,0);assert.equal(f.jobs.get(jobDigest).attempts_started,0);assert.deepEqual(await api(current.app,'/api/approvals'),[]);
 }finally {release();}
});

// A redundant On or Resume (a second click, or an agent calling it to be safe) used to start a new safety epoch. An
// offer whose card was still being prepared then failed its epoch check and was hidden as if the person had passed on it.
test('a redundant On and Resume keep an offer whose card is still being prepared',{timeout:60000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 // Hold the card's preflight (the job readiness read) until the redundant calls have returned.
 const summary=lender.backend.protectionSummary,held=[];let preflights=0;
 lender.backend.protectionSummary=async(requirements,context={})=>{
  if(context.source){preflights++;await new Promise(resolve=>held.push(resolve));}
  return summary(requirements,context);
 };
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Offer under review',harness:'codex'}});
 await waitFor(async()=>held.length>0&&(await api(lender.app,'/api/lending')).status==='offer','card preflight in progress',20000);
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await api(lender.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id}});
 const originalPreflights=preflights;
 lender.backend.protectionSummary=async(...args)=>{if(args[1]?.source)preflights++;return summary(...args);};
 for(const resolve of held.splice(0))resolve();
 const cards=await waitFor(async()=>{const rows=await api(lender.app,'/api/approvals');return rows.some(row=>row.jobDigest===jobDigest)?rows:null;},'the card is shown',20000);
 assert.equal(cards.filter(row=>row.jobDigest===jobDigest).length,1);
 assert.equal(preflights,originalPreflights,'the original preflight survives redundant calls');
 const diagnostics=await readFile(join(lender.home,'v1','lending-errors.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
 assert.ok(!diagnostics.includes('approval_changed'),'redundant calls do not invalidate approval');
 const stored=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));
 assert.ok(!(stored.hiddenOffers??[]).some(row=>row.jobDigest===jobDigest),'a redundant On or Resume does not hide the offer');
});

test('tightening then relaxing a requester cap returns the unanswered offer', {timeout:60000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const other=await f.start('other');
 const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
 await api(other.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
 await lender.app.device.refreshRoster(circle.id);
 const second=await api(other.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Offer B stays open',harness:'codex'}});
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Offer with a changing cap',harness:'codex'}});
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{maxWallSeconds:1200,idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 const card=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(row=>row.jobDigest===jobDigest),'open offer');
 const bCard=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(row=>row.jobDigest===second.jobDigest),'B card');
 const cap=limits=>api(lender.app,'/api/lending/requester-limits',{method:'POST',body:{circle:circle.id,keyId:owner.app.device.keyId,limits}});
 await cap({dailyMinutes:1});
 await waitFor(async()=>!(await api(lender.app,'/api/approvals')).some(row=>row.id===card.id),'card closes under cap');
 assert.ok((await api(lender.app,'/api/approvals')).some(row=>row.id===bCard.id),'B stays open under cap');
 await cap(null);
 await waitFor(async()=>(await api(lender.app,'/api/approvals')).some(row=>row.jobDigest===jobDigest&&row.id!==card.id),'offer returns after cap removed');
 assert.ok((await api(lender.app,'/api/approvals')).some(row=>row.id===bCard.id),'B keeps the same card');
 for(const digest of [jobDigest,second.jobDigest])assert.equal(f.jobs.get(digest).current_attempt,null,'no claim');
 const stored=JSON.parse(await readFile(join(lender.home,'v1','app-counters.json'),'utf8'));
 assert.ok(!(stored.hiddenOffers??[]).some(row=>row.jobDigest===jobDigest));
 assert.equal(lender.backend.calls.filter(([kind])=>kind==='run').length,0);
});
