import './helpers/no-browser.mjs';
import {fixtureAccounts,accountHeartbeat} from './helpers/run-request-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {canonicalize} from '../lib/protocol/index.mjs';
import {appFixture,api,waitFor} from './helpers/offers-jobs-fixture.mjs';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {adaptLegacyJob} from '../lib/v1/state-projection.mjs';
import {jobStatusContract} from '../lib/v1/status-contract.mjs';

const jobInput=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt:'Projection fixture',harness:'codex',send_anyway:true});
const semanticProjection=value=>({...value,times:{...value.times,observedAt:null}});
async function claimQueuedJob(client,f,jobDigest) {
  const requirements=f.jobs.get(jobDigest).job.payload.requirements;
  await client.heartbeat(accountHeartbeat(fixtureAccounts()));
  return client.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1','run_request_v1'],accounts:fixtureAccounts(),
    egress:['internet','provider-only'],enforced_limits:Object.keys(requirements.limits),max_limits:requirements.limits},{waitSeconds:0});
}

test('create, list, and detail return the same authoritative job projection', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const created=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const path='/api/jobs/'+encodeURIComponent(created.jobDigest)+'?circle='+encodeURIComponent(circle.id);
  const listed=(await api(owner.app,'/api/jobs?circle='+encodeURIComponent(circle.id)))
    .find(job=>job.job_digest===created.jobDigest);
  const detail=await api(owner.app,path);
  assert.equal(created.jobProjection.phase,'waiting');
  assert.deepEqual(semanticProjection(listed.jobProjection),semanticProjection(created.jobProjection));
  assert.deepEqual(semanticProjection(detail.jobProjection),semanticProjection(created.jobProjection));
  assert.equal(detail.statusContract.lifecycle,'waiting');
  assert.equal(detail.statusContract.reasonCode,detail.jobProjection.reasonCode);

  const status=await api(lender.app,'/api/status');
  assert.equal(status.lendingProjection.kind,'lending');
  assert.equal(status.lendingProjection.intent,'off');
  assert.equal(status.lendingProjection.admission,'blocked');
  assert.equal(status.lendingProjection.execution,'idle');
  const membership=(await api(lender.app,'/api/devices')).circles.find(row=>row.circle===circle.id);
  assert.equal(membership.membershipProjection.phase,'approved');
});

test('a start-request acknowledgement remains nonrunning until backend launch is observed', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const baseOverride=f.override;
  f.override=async context=>{
    if(context.route!=='/presence')return baseOverride(context);
    const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
    const devices=[lender.app.device.keyId,owner.app.device.keyId].map((keyId,index)=>({device:keyId,person:keyId,
      online:true,source:'heartbeat',last_heartbeat_at:now,last_poll_at:null,intent:{state:'ready',reason:null,until:null},
      execution:{state:'idle',stops_by:null},blockers:[],agents:[],budget:null,schedule:null,
      capabilities:index===0?['progress_v1','offers_v1']:['offers_v1'],versions:null,member_capabilities:[],last_capabilities_at:null}));
    const body={now,online_seconds:90,devices,persons:devices.map(device=>({person:device.person,online:true,
      able:true,status:'ready',devices:[device.device]}))};
    const bytes=Buffer.from(canonicalize(body));
    context.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});
    context.res.end(bytes);return true;
  };
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const client=await lender.app.device.client(circle.id);
  const claim=await claimQueuedJob(client,f,jobDigest);
  const presence=await client.fetchPresence();
  const holder=presence.devices.find(device=>device.device===lender.app.device.keyId);
  assert.equal(holder?.online,true);
  assert.ok(holder?.capabilities.includes('offers_v1'));
  const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  const reserved=await api(owner.app,path);
  assert.equal(reserved.jobProjection.phase,'approved');
  assert.equal(reserved.statusContract.lifecycle,'approved');
  assert.notEqual(reserved.jobProjection.phase,'running');

  await assert.rejects(client.observeExecutionStart(claim.attempt),{code:'conflict'});
  await client.startAttempt(claim.attempt);
  const acknowledged=await api(owner.app,path);
  assert.equal(acknowledged.jobProjection.phase,'approved','the durable start-request fence is not execution evidence');
  await client.observeExecutionStart(claim.attempt);
  const running=await api(owner.app,path);
  assert.equal(running.jobProjection.phase,'running');
  assert.equal(running.statusContract.lifecycle,'running');
});

test('a bare start request does not prove borrower approval',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const baseOverride=f.override;
  f.override=async context=>{
    if(context.route!=='/presence')return baseOverride(context);
    const now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
    const devices=[lender.app.device.keyId,owner.app.device.keyId].map(device=>({device,person:device,online:true,source:'heartbeat',
      last_heartbeat_at:now,last_poll_at:null,intent:{state:'ready',reason:null,until:null},execution:{state:'idle',stops_by:null},
      blockers:[],agents:[],budget:null,schedule:null,capabilities:[],versions:null,member_capabilities:[],last_capabilities_at:null}));
    const bytes=Buffer.from(canonicalize({now,online_seconds:90,devices,persons:[]}));
    context.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});context.res.end(bytes);return true;
  };
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const client=await lender.app.device.client(circle.id),claim=await claimQueuedJob(client,f,jobDigest);
  await client.startAttempt(claim.attempt);
  const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  const pending=await api(owner.app,path);
  assert.equal(pending.jobProjection.phase,'approval_pending');
  await client.observeExecutionStart(claim.attempt);
  assert.equal((await api(owner.app,path)).jobProjection.phase,'running');
});

test('a holder can report the original launch time after release through HTTP', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.realConnect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const client=await lender.app.device.client(circle.id),ownerClient=await owner.app.device.client(circle.id);
  const requirements=(await ownerClient.getJob(jobDigest)).job.payload.requirements;
  await client.heartbeat(accountHeartbeat(fixtureAccounts()));
  const claim=await client.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1','run_request_v1'],accounts:fixtureAccounts(),
    egress:['internet','provider-only'],enforced_limits:Object.keys(requirements.limits),max_limits:requirements.limits},{waitSeconds:0});
  await client.startAttempt(claim.attempt);
  const at=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
  await client.release(claim.attempt,'test release');
  const observed=await client.observeExecutionStart(claim.attempt,{observedAt:at});
  assert.equal(observed.execution_observed_at,at);
  assert.equal(observed.state,'released');
});

test('queued detail that is claimed and started during its presence read shows the newer running state', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const baseOverride=f.override;let releasePresence=()=>{},enterPresence;
  const presenceGate=new Promise(resolve=>{releasePresence=resolve;});
  const presenceEntered=new Promise(resolve=>{enterPresence=resolve;});
  let gated=false;
  f.override=async context=>{
    if(context.route==='/presence'&&!gated){gated=true;enterPresence();await presenceGate;}
    return baseOverride(context);
  };
  const client=await lender.app.device.client(circle.id),path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  let pending;
  try {
    pending=api(owner.app,path);
    await presenceEntered;
    const claim=await claimQueuedJob(client,f,jobDigest);
    await client.startAttempt(claim.attempt);
    await client.observeExecutionStart(claim.attempt);
    releasePresence();
    const detail=await pending;
    // Judge r9 and its dot review: a job that moved while this read was assembled is read again, so the page shows
    // the state the host already reported (running), never the older one and never "Status unavailable".
    assert.equal(detail.jobProjection.phase,'running');
    assert.equal(detail.jobProjection.observation,undefined);
    assert.equal(detail.state,'claimed');
  } finally {releasePresence();await pending?.catch(()=>{});}
});

test('claimed detail whose generation changes during the borrower outcome read shows the newer attempt', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const client=await lender.app.device.client(circle.id),first=await claimQueuedJob(client,f,jobDigest);
  const outcomesFile=join(owner.home,'v1','borrower-outcomes.json');
  execFileSync('mkfifo',[outcomesFile]);
  const writer=spawn(process.execPath,['-e',
    // Before answering the held read, the writer puts an ordinary file in the FIFO's place, so no later read of this
    // path can block on a FIFO with no writer (that kept the test process alive after its last test).
    "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');process.stdout.write('open\\n');process.stdin.once('data',()=>{fs.writeFileSync(process.argv[1]+'.tmp','{}');fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);fs.writeSync(fd,'{}');fs.closeSync(fd);});",
    outcomesFile],{stdio:['pipe','pipe','inherit']});
  let pending,releaseWriter=()=>{if(writer.exitCode===null)writer.stdin.end('write');};
  const writerOpened=new Promise((resolve,reject)=>{
    writer.stdout.once('data',resolve);writer.once('error',reject);
    writer.once('exit',code=>{if(code!==0)reject(new Error('outcome FIFO writer exited '+code));});
  });
  const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  try {
    pending=api(owner.app,path);
    await writerOpened;
    await client.release(first.attempt,'released');
    const next=await claimQueuedJob(client,f,jobDigest);
    await client.startAttempt(next.attempt);
    await client.observeExecutionStart(next.attempt);
    releaseWriter();
    const detail=await pending;
    assert.equal(detail.jobProjection.phase,'running');
    assert.equal(detail.jobProjection.version.attemptId,next.attempt.attempt_id,'the projection is of the newer attempt');
    assert.equal(detail.current_attempt.attempt_id,next.attempt.attempt_id,'the view and its projection are the same read');
  } finally {
    releaseWriter();
    await pending?.catch(()=>{});
    if(writer.exitCode===null)writer.kill();
  }
});

test('queued snapshot held inside borrower outcomes survives an unstarted claim honestly', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const client=await lender.app.device.client(circle.id);
  const outcomesFile=join(owner.home,'v1','borrower-outcomes.json');
  execFileSync('mkfifo',[outcomesFile]);
  const writer=spawn(process.execPath,['-e',
    // Before answering the held read, the writer puts an ordinary file in the FIFO's place, so no later read of this
    // path can block on a FIFO with no writer (that kept the test process alive after its last test).
    "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');process.stdout.write('open\\n');process.stdin.once('data',()=>{fs.writeFileSync(process.argv[1]+'.tmp','{}');fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);fs.writeSync(fd,'{}');fs.closeSync(fd);});",
    outcomesFile],{stdio:['pipe','pipe','inherit']});
  let pending,releaseWriter=()=>{if(writer.exitCode===null)writer.stdin.end('write');};
  const writerOpened=new Promise((resolve,reject)=>{
    writer.stdout.once('data',resolve);writer.once('error',reject);
    writer.once('exit',code=>{if(code!==0)reject(new Error('outcome FIFO writer exited '+code));});
  });
  const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  try {
    pending=api(owner.app,path);
    await writerOpened;
    const next=await claimQueuedJob(client,f,jobDigest);
    releaseWriter();
    const detail=await pending;
    assert.notEqual(detail.jobProjection.phase,'unknown','queued producer snapshot lost: '+JSON.stringify({projection:detail.jobProjection,state:detail.state,approval:detail.approval}));
    assert.equal(detail.jobProjection.phase,'waiting');
    // Since 0b6622b8 an unstarted claim is itself a consistent waiting phase: the view may show the queued snapshot
    // (transitional) or the claim, but never a started or unknown job.
    if(detail.state==='queued'){
      assert.equal(detail.jobProjection.observation.state,'transitional');
      assert.equal(detail.current_attempt,null);
      assert.equal(detail.jobProjection.version.generation,null);
    } else {
      assert.equal(detail.state,'claimed');
      assert.equal(detail.current_attempt?.attempt_id,next.attempt.attempt_id,'a claimed view shows the claim it was made from');
      assert.equal(detail.current_attempt.execution_started_at??null,null);
    }
    assert.equal(detail.borrowerCircle,circle.id);
    assert.equal(detail.approval,null);
    assert.equal(detail.canSetBorrowerOutcome,false);
    assert.equal(detail.jobProjection.version.jobDigest,jobDigest);
    assert.equal(detail.jobProjection.version.attemptId,detail.current_attempt?.attempt_id??null,'base fields and projection identify the same observation');
    if(detail.jobProjection.observation)assert.deepEqual(detail.jobProjection.actionHints,[]);
  } finally {
    releaseWriter();
    await pending?.catch(()=>{});
    if(writer.exitCode===null)writer.kill();
  }
});

test('cancel acknowledgement includes a best-effort current job projection', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const result=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/cancel',{method:'POST',body:{circle:circle.id}});
  assert.equal(result.authority_revoked,true);
  assert.equal(result.jobProjection.kind,'job');
  assert.ok(['stopped','stopping','unknown'].includes(result.jobProjection.phase));

  const second=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  const baseOverride=f.override;
  f.override=async context=>{
    if(context.route==='/jobs/'+second.jobDigest.slice(7)&&context.req.method==='GET'){
      context.res.writeHead(503,{'content-type':'application/problem+json'});context.res.end('{}');return true;
    }
    return baseOverride(context);
  };
  const acknowledged=await api(owner.app,'/api/jobs/'+encodeURIComponent(second.jobDigest)+'/cancel',{method:'POST',body:{circle:circle.id}});
  assert.equal(acknowledged.authority_revoked,true);
  assert.equal(acknowledged.jobProjection.phase,'unknown');
  assert.equal(acknowledged.jobProjection.reasonCode,'observation_unavailable');
});

test('daily cap blocks admission, Off closes new lending, and Stop publishes cessation', {timeout:90000}, async t=>{
  const f=await appFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const first=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:1,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const firstCard=await waitFor(async()=>(await api(lender.app,'/api/approvals')).find(card=>card.jobDigest===first.jobDigest),'first approval');
  await api(lender.app,'/api/approvals/'+firstCard.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.filter(([kind])=>kind==='run').length===1,'first run');
  const activeStatus=await waitFor(async()=>{const view=await api(lender.app,'/api/status');return view.lendingProjection.execution==='running'&&view;},'the held account run is observed',15000);
  assert.equal(activeStatus.lendingProjection.admission,'blocked');
  assert.equal(activeStatus.lendingProjection.admissionReason,'daily_limit');
  assert.equal(activeStatus.lendingProjection.execution,'running');
  assert.equal(activeStatus.lendingProjection.executionJob,activeStatus.lending.current);

  let releaseIdentity=()=>{},enterIdentity;
  const identityGate=new Promise(resolve=>{releaseIdentity=resolve;});
  const identityEntered=new Promise(resolve=>{enterIdentity=resolve;});
  const memberNames=lender.app.device.memberNames.bind(lender.app.device);
  lender.app.device.memberNames=async(...args)=>{enterIdentity();await identityGate;return memberNames(...args);};
  let incomplete,pendingStatus;
  try {
    pendingStatus=api(lender.app,'/api/status');
    await identityEntered;
    await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
    releaseIdentity();
    incomplete=await pendingStatus;
  } finally {releaseIdentity();lender.app.device.memberNames=memberNames;await pendingStatus?.catch(()=>{});}
  // Judge r9: a change during the read is read again from the newest facts, never shown as "unavailable".
  assert.equal(incomplete.lendingProjection.intent,'off','the Off made during the read is what the response shows');
  assert.notEqual(incomplete.lendingProjection.admission,'allowed');
  assert.ok(['running','finishing','stopping','idle'].includes(incomplete.lendingProjection.execution),
    'the latest response shows the run or its completed stop: '+JSON.stringify({projection:incomplete.lendingProjection,
      lending:{status:incomplete.lending?.status,current:incomplete.lending?.current,
        accountStates:incomplete.lending?.accountStates?.map(({account,status,current,reason})=>({account,status,current,reason}))},
      currentJob:incomplete.currentJob}));
  if(incomplete.lendingProjection.execution==='idle')
    assert.equal(f.jobs.get(first.jobDigest).current_attempt.compute_stopped,true,
      'idle requires confirmed cessation even if the terminal event has already advanced to paused');
  else assert.equal(incomplete.lendingProjection.executionJob,activeStatus.lending.current,
    'the active execution keeps its attempt through the Off read: '+JSON.stringify({projection:incomplete.lendingProjection,
      lending:{status:incomplete.lending?.status,current:incomplete.lending?.current,
        accountStates:incomplete.lending?.accountStates?.map(({account,status,current,reason,stopping})=>({account,status,current,reason,stopping}))},
      currentJob:incomplete.currentJob}));
  assert.equal(incomplete.currentJob,incomplete.lendingProjection.executionJob,
    'the top-level current job follows the coherent execution projection');
  lender.app.device.memberNames=memberNames;

  if(incomplete.lendingProjection.execution!=='idle')await api(lender.app,'/api/lending/stop',{method:'POST',body:{confirmed:true,attemptId:activeStatus.lending.current}});
  const status=await waitFor(async()=>{
    const view=await api(lender.app,'/api/status');
    return view.lendingProjection.execution==='idle'&&view;
  },'Stop completes its stopped report',30000);
  assert.equal(status.lendingProjection.intent,'off');
  assert.equal(status.lendingProjection.admission,'blocked');
  assert.equal(status.lendingProjection.admissionReason,'daily_limit');
  assert.equal(status.lendingProjection.execution,'idle');
  assert.equal(status.currentJob,null);
  const stoppedAttempt=f.jobs.get(first.jobDigest)?.current_attempt;
  assert.equal(stoppedAttempt?.state,'released','Off releases the cancelled attempt');
  assert.equal(stoppedAttempt?.compute_stopped,true,'Off waits for backend cleanup before releasing it');
  assert.ok(stoppedAttempt?.stopped_at,'Off publishes the cleanup time');
});

// Dot reviews of the state projection: Home samples the lending state, then awaits the readiness facts while it builds
// the projection. A fact that changes inside that window must not leave the response claiming the old "allowed".
// The window is held open at Home's own circle read inside the projection (the second device.listCircles call), and
// is always released, so a failing assertion cannot leave the app waiting.
async function holdProjection(t,lender,change) {
  const listCircles=lender.app.device.listCircles.bind(lender.app.device);
  let calls=0,release=()=>{},entered;
  const arrived=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  t.after(()=>{release();lender.app.device.listCircles=listCircles;});
  lender.app.device.listCircles=async(...args)=>{if(++calls===2){entered();await held;}return listCircles(...args);};
  try {
    const pending=api(lender.app,'/api/status');
    await arrived;await change();release();
    return await pending;
  } finally {release();lender.app.device.listCircles=listCircles;}
}
async function allowedLender(t,options={}) {
  const f=await appFixture(t),{lender,circle}=await f.connect(typeof options==='function'?options(f):options);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(async()=>(await api(lender.app,'/api/status')).lendingProjection.admission==='allowed','allowed before the change',20000);
  return {f,lender};
}

test('disabling the only lent agent while Home builds its projection is not returned as the old allowed projection',{timeout:90000},async t=>{
  const {lender}=await allowedLender(t);
  const during=await holdProjection(t,lender,()=>api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:false}}));
  assert.notEqual(during.lendingProjection.admission,'allowed','the agent choice is read with the facts it is combined with');
});

// Dot review round 7: the circle's heartbeat is one coherent observation too. A readiness fact that changes while the
// heartbeat snapshot is built (held here inside its circle read, after the safety test was sampled) must not reach
// the circle as the old "ready".
test('a heartbeat built across a readiness change does not advertise the old ready state',{timeout:90000},async t=>{
  let block=false;
  const {f,lender}=await allowedLender(t,f=>{
    const backend=syntheticBackend(f.root),summary=backend.protectionSummary.bind(backend);
    backend.protectionSummary=async(...args)=>{const report=await summary(...args);if(block)report.preflight.checks.push({name:'network_policy',ok:false,detail:'Network rules unavailable.'});return report;};
    return {backend,heartbeatMs:300};
  });
  await waitFor(()=>f.heartbeats?.some(body=>body.intent?.state==='ready'),'a ready heartbeat first',20000);
  const listCircles=lender.app.device.listCircles.bind(lender.app.device);
  let release=()=>{},entered,armed=true;
  const arrived=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  t.after(()=>{release();lender.app.device.listCircles=listCircles;});
  lender.app.device.listCircles=async(...args)=>{
    const stack=new Error().stack;
    if(armed&&stack.includes('heartbeatSnapshot')&&stack.includes('circleState')){armed=false;entered();await held;}
    return listCircles(...args);
  };
  await arrived;
  const before=f.heartbeats.length;
  block=true;
  await api(lender.app,'/api/readiness?refresh=true');
  release();
  const next=await waitFor(()=>f.heartbeats.length>before&&f.heartbeats[before],'the held heartbeat is sent',20000);
  lender.app.device.listCircles=listCircles;
  assert.notEqual(next.intent?.state,'ready','the heartbeat built across the change does not say ready');
});

// Judge r9 O-D: while a stop is in progress the lending facts keep moving. Home reads them again instead of
// returning "Status unavailable"; the stop shows (or its outcome), never an unknown lending state.
test('a stop issued while Home builds its projection reads as stopping or stopped, never unavailable',{timeout:90000},async t=>{
  const f=await appFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running');
  const attemptId=(await api(lender.app,'/api/status')).lending.current;
  const during=await holdProjection(t,lender,()=>api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}}));
  assert.notEqual(during.lendingProjection.intent,'unknown');
  assert.notEqual(during.lendingProjection.execution,'unknown');
  assert.notEqual(during.lendingProjection.admission,'allowed');
});

// Judge r9 O-E: while this computer's own stop of a job it runs is pending, the job page reads stopping (no fresh
// Stop), the same state Lending and Home show, instead of "Running · Live".
test('a stop this lender issued shows the job as stopping before the host records it',{timeout:90000},async t=>{
  const f=await appFixture(t,{hold:true}),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'running');
  const path='/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id);
  await waitFor(async()=>(await api(lender.app,path)).jobProjection.phase==='running','running projection');
  await waitFor(async()=>(await api(lender.app,'/api/status')).currentJob!==null,'local execution observation');
  let release=()=>{};const held=new Promise(resolve=>{release=resolve;});
  const cancel=lender.backend.cancel.bind(lender.backend);
  lender.backend.cancel=async(...args)=>{await held;return cancel(...args);};
  t.after(()=>{release();lender.backend.cancel=cancel;});
  const attemptId=(await api(lender.app,'/api/status')).lending.current;
  const stopping=api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId,confirmed:true}}).catch(()=>{});
  try {
    const job=await waitFor(async()=>{const j=await api(lender.app,path);return j.jobProjection.phase==='stopping'?j:null;},'stopping job projection',15000);
    assert.equal(job.jobProjection.evidence.localStopRequested,true);
    assert.equal(job.status,'Stopping','the job response label matches its stopping projection');
    assert.deepEqual(job.jobProjection.actionHints,[],'no fresh Stop while the stop is pending');
  } finally {release();await stopping;}
});
for(const [label,result] of [
  ['empty',{message:'',files:[]}],
  ['non-empty',{message:'Work so far.',files:[{path:'answer.txt'}]}],
]) {
  test('a finished '+label+' result keeps the lender stop explanation and remains reviewable',()=>{
    const job={state:'result-accepted',job_digest:'sha256:'+'1'.repeat(64),result_digest:'sha256:'+'2'.repeat(64),result,
      current_attempt:{attempt_id:'attempt-1',generation:1,state:'finished',
        execution_started_at:'2026-10-31T00:00:00Z',execution_observed_at:'2026-10-31T00:00:00Z',compute_stopped:false},
      stopRequest:{attempt_id:'attempt-1',generation:1,job_digest:'sha256:'+'1'.repeat(64),requested_at:'2026-10-31T00:00:08Z'}};
    const jobProjection=adaptLegacyJob(job);
    const status=jobStatusContract({...job,jobProjection});
    assert.equal(status.explanation,'The person lending stopped this job early. This is the work done until then.');
    assert.equal(jobProjection.evidence.sharedStopRequestedAt,job.stopRequest.requested_at);
    assert.equal(jobProjection.phase,'result_accepted');
    assert.equal(jobProjection.result.available,true);
    assert.equal(status.lifecycle,'ready');
    assert.deepEqual(status.allowedActions,['review']);
    assert.deepEqual(jobProjection.actionHints,['review']);

    const normal={...job,stopRequest:null};
    const normalProjection=adaptLegacyJob(normal);
    assert.equal(jobStatusContract({...normal,jobProjection:normalProjection}).explanation,'The result is ready to review.');
    assert.equal(normalProjection.evidence.sharedStopRequestedAt,null);
    assert.deepEqual(normalProjection.result,jobProjection.result);

    for(const mismatch of [{attempt_id:'older-attempt'},{generation:0},{job_digest:'sha256:'+'3'.repeat(64)}]) {
      const unrelated={...job,stopRequest:{...job.stopRequest,...mismatch}};
      assert.equal(jobStatusContract(unrelated).explanation,'The result is ready to review.',
        'a stop request for a different attempt, generation, or job is not terminal evidence');
    }
  });
}

// A finished job reads its attempt's stop request only to explain an early stop. If that read fails, the job stays
// reviewable exactly as before; the outage must not turn a finished job into an uncertain one.
test('a failed stop-history read keeps a finished job reviewable',{timeout:20000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:jobInput(circle)});
  await f.complete(jobDigest,'owner',{});
  const previous=f.override;let injected=0;
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){
      injected++;
      record.res.writeHead(503,{'content-type':'application/problem+json'});
      record.res.end(JSON.stringify({type:'urn:faravan:problem:unavailable',title:'unavailable',code:'unavailable',status:503,retryable:false,outcome:'not_applied'}));
      return true;
    }
    return previous(record);
  };
  const job=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+encodeURIComponent(circle.id));
  assert.ok(injected>0,'the finished job asked for its stop history');
  assert.equal(job.jobProjection.phase,'result_accepted');
  assert.deepEqual(job.jobProjection.actionHints,['review']);
  assert.equal(job.jobProjection.evidence.sharedStopRequestUnavailable,undefined);
  assert.equal(job.stopRequestReadUnavailable,undefined);
});
