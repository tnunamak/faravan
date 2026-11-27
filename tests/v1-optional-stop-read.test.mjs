import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {appFixture,api,waitFor,bounded} from './helpers/offers-jobs-fixture.mjs';
import {jobStatusVM,jobVM} from '../ui/v1/src/view-models.mjs';
import {adaptLegacyJob} from '../lib/v1/state-projection.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Jobs-list regressions use only a fake coordinator client; no lender execution is needed.
async function stopListFixture(t,getStopRequest) {
  const home=await mkdtemp(join(tmpdir(),'faravan-stop-list-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const digest='sha256:'+'a'.repeat(64),circle={id:'test-circle',name:'Test'};
  const attempt={attempt_id:'test-attempt',job_digest:digest,generation:1,holder:'lender',
    state:'completed',execution_started_at:'2026-10-31T10:00:00Z',compute_stopped:true};
  const job={job_digest:digest,state:'result-accepted',current_attempt:attempt,
    result_digest:'sha256:'+'b'.repeat(64),job:{payload:{author:'owner',circle:circle.id}}};
  const stop={attempt_id:attempt.attempt_id,job_digest:digest,generation:1,requested_at:'2026-10-31T10:01:00Z'};
  let reads=0;
  const client={async *listJobs(){yield structuredClone(job);},async getJob(){return structuredClone(job);},
    async getStopRequest(value,opts){reads++;return getStopRequest?getStopRequest(value,opts,stop):structuredClone(stop);}};
  const device={keyId:'owner',selectCircle:async()=>circle,client:async()=>client,
    intentStore:()=>({list:async()=>[]})};
  return {operations:createJobOperations({device,home}),job,stop,circle,reads:()=>reads};
}

test('list preserves early-stop evidence and reuses completed-attempt reads',async t=>{
  const f=await stopListFixture(t);
  const [row]=await f.operations.list({circle:f.circle.id});
  assert.deepEqual(row.stopRequest,f.stop);
  assert.equal(adaptLegacyJob(row).evidence.sharedStopRequestedAt,f.stop.requested_at);
  assert.equal(jobVM(row,'sent').listWord,'Stopped early · ready to review');
  assert.deepEqual((await f.operations.list({circle:f.circle.id}))[0].stopRequest,f.stop);
  assert.equal(f.reads(),1,'a completed attempt is read only once');
  f.job.current_attempt.generation=2;f.stop.generation=2;
  assert.equal((await f.operations.list({circle:f.circle.id}))[0].stopRequest.generation,2);
  assert.equal(f.reads(),2,'a new generation cannot inherit old evidence');

  const warm=await stopListFixture(t);
  await warm.operations.get({digest:warm.job.job_digest,circle:warm.circle.id});
  assert.deepEqual((await warm.operations.list({circle:warm.circle.id}))[0].stopRequest,warm.stop);
  assert.equal(warm.reads(),1,'list reuses the matching Stop already read by get');

  const absent=await stopListFixture(t,()=>null);
  await absent.operations.list();await absent.operations.list();
  assert.equal(absent.reads(),1,'a successful immutable null read is also cached');

  let requested=false;
  const active=await stopListFixture(t,(_attempt,_opts,stop)=>requested?stop:null);
  active.job.state='claimed';
  active.job.current_attempt.state='active';active.job.current_attempt.compute_stopped=false;
  assert.equal((await active.operations.list())[0].stopRequest,undefined);
  requested=true;
  assert.deepEqual((await active.operations.list())[0].stopRequest,active.stop);
  assert.equal(active.reads(),2,'active attempts refresh so a later Stop is not hidden');
});

test('list keeps the result row when an optional stop read is unavailable',async t=>{
  const f=await stopListFixture(t,()=>{throw Object.assign(new Error('unavailable'),{status:503});});
  const [row]=await f.operations.list({circle:f.circle.id});
  assert.equal(f.reads(),1,'list attempted the optional stop read');
  assert.equal(row.job_digest,f.job.job_digest);
  assert.equal(row.state,'result-accepted');
  assert.equal(row.stopRequest,undefined);
  assert.equal(row.stopRequestReadUnavailable,undefined);
  assert.equal(jobVM(row,'sent').listWord,'Ready to review');
});

async function openJobEvents(app) {
  const controller=new AbortController();
  const response=await fetch(app.origin+'/api/events?after=0',{headers:{'x-faravan-session-token':app.token},signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader();
  let pending='';
  return {
    async waitFor(predicate,timeoutMs) {
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline) {
        let timer;
        const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,deadline-Date.now()));});
        const chunk=await Promise.race([reader.read().then(result=>({result})),timeout]);
        clearTimeout(timer);
        if(chunk===null){controller.abort();assert.fail('No matching requester job event within '+timeoutMs+' ms');}
        const {done,value}=chunk.result;
        assert.equal(done,false,'requester event stream closed');
        pending+=Buffer.from(value).toString('utf8');
        let boundary;
        while((boundary=pending.indexOf('\n\n'))>=0) {
          const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
          const data=/^data: (.+)$/m.exec(frame);
          if(data) {const event=JSON.parse(data[1]);if(predicate(event))return event;}
        }
      }
      assert.fail('No matching requester job event within '+timeoutMs+' ms');
    },
    async close() {controller.abort();await reader.cancel().catch(()=>{});},
  };
}

test('an unavailable optional stop read preserves the running job and reports uncertainty',{timeout:60000},async t=>{
  const f=await appFixture(t,{hold:true});
  const {owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic optional stop-read regression',harness:'codex'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'backend execution');

  const endpoint='/api/jobs/'+job.jobDigest+'?circle='+circle.id;
  const baseline=await api(owner.app,endpoint);
  assert.equal(baseline.jobProjection.phase,'running');
  assert.equal(baseline.current_attempt.compute_stopped,false);
  const operations=createJobOperations({device:owner.app.device,home:owner.home});
  const previous=f.override;
  let injected=0;
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){
      injected++;
      record.res.writeHead(503,{'content-type':'application/problem+json'});
      record.res.end(JSON.stringify({type:'urn:faravan:problem:unavailable',title:'unavailable',
        code:'unavailable',status:503,retryable:false,outcome:'not_applied'}));
      return true;
    }
    return previous(record);
  };

  const client=await owner.app.device.client(circle.id);
  const direct=await client.getJob(job.jobDigest);
  assert.equal(direct.current_attempt.compute_stopped,false,'the authoritative job remains active');
  assert.equal(typeof direct.current_attempt.execution_started_at,'string');

  const warmResponse=await fetch(owner.app.origin+endpoint,{headers:{'x-faravan-session-token':owner.app.token}});
  const warm=await warmResponse.json();
  assert.equal(warmResponse.status,200);
  assert.equal(warm.savedReason??null,null,'a failed optional read must not select the saved-unreachable response');
  assert.equal(warm.jobProjection.phase,'running');
  assert.equal(warm.jobProjection.evidence.sharedStopRequestUnavailable,true);
  assert.equal(warm.jobProjection.evidence.sharedStopRequestedAt,null);
  assert.equal(warm.current_attempt.compute_stopped,false);
  assert.match(warm.statusContract.explanation,/stop request may be pending/i);
  assert.deepEqual(warm.statusContract.allowedActions,[]);

  const coldResponse=await fetch(owner.app.origin+endpoint+'&freshReview=cold',{headers:{'x-faravan-session-token':owner.app.token}});
  const cold=await coldResponse.json();
  assert.equal(coldResponse.status,200,'a cold app read must keep the successful job observation');
  assert.equal(cold.jobProjection.evidence.sharedStopRequestUnavailable,true);

  const projected=await operations.get({digest:job.jobDigest,circle:circle.id});
  assert.equal(projected.state,'claimed');
  assert.equal(projected.stopRequestReadUnavailable,true);
  assert.equal(projected.current_attempt.compute_stopped,false);
  assert.ok(injected>=4,'the app and ordinary operation read the optional route');

  f.override=previous;
  const recovered=await api(owner.app,endpoint);
  assert.equal(recovered.jobProjection.phase,'running');
  assert.equal(recovered.jobProjection.evidence.sharedStopRequestUnavailable,undefined,
    'a successful no-marker read is distinct from an unavailable read');

  // Authorization and returned marker validation remain hard failures at the operations boundary.
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){
      record.res.writeHead(401,{'content-type':'application/problem+json'});
      record.res.end(JSON.stringify({type:'urn:faravan:problem:unauthorized',title:'unauthorized',
        code:'unauthorized',status:401,retryable:false,outcome:'not_applied'}));
      return true;
    }
    return previous(record);
  };
  await assert.rejects(operations.get({digest:job.jobDigest,circle:circle.id}),error=>error.status===401,
    'an authorization failure must not be converted to unknown metadata');

  const mismatchedAttemptId=baseline.current_attempt.attempt_id==='00000000-0000-4000-8000-000000000000'
    ?'00000000-0000-4000-8000-000000000001':'00000000-0000-4000-8000-000000000000';
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){
      record.res.writeHead(200,{'content-type':'application/json'});
      record.res.end(JSON.stringify({attempt_id:mismatchedAttemptId,
        generation:baseline.current_attempt.generation,job_digest:job.jobDigest,
        requested_at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}));
      return true;
    }
    return previous(record);
  };
  await assert.rejects(operations.get({digest:job.jobDigest,circle:circle.id}),error=>error.code==='invalid_response',
    'a mismatched marker must remain a protocol failure');

  // A caller cancelling the optional request still cancels the whole read.
  let held=0;
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){held++;return true;}
    return previous(record);
  };
  const controller=new AbortController();
  const aborted=operations.get({digest:job.jobDigest,circle:circle.id},{signal:controller.signal});
  await waitFor(()=>held===1,'optional stop read is held');
  controller.abort(new DOMException('Synthetic caller cancellation','AbortError'));
  await assert.rejects(aborted,error=>error.name==='AbortError','caller abort must propagate');
  f.override=previous;
});

// A background read that the coordinator never answers must not hold the owner's shutdown: closing cancels it.
test('owner shutdown does not wait for a stop read the coordinator never answers',{timeout:90000},async t=>{
  const f=await appFixture(t,{hold:true});
  const {owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  // Install before launch: observed-start can notify the owner's poll before backend.start returns.
  const previous=f.override;
  let held=0;
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){held++;return true;}
    return previous(record);
  };
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic shutdown regression',harness:'codex'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'backend execution');
  // The owner's own poll issues this read; the coordinator never answers it.
  await waitFor(()=>held>=1,'a background stop read is held',30000);
  await bounded(owner.app.close(),'owner close with an open stop read',15000);
});

// The requester's card must not offer Stop while the shared stop status is unknown; this computer keeps its own Stop.
test('an unknown stop status withholds the requester\'s Stop, and this computer keeps its own Stop',{timeout:90000},async t=>{
  const f=await appFixture(t,{hold:true});
  const {owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic stop-affordance regression',harness:'codex'}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'backend execution');
  const previous=f.override;
  f.override=async record=>{
    if(record.req.method==='GET'&&record.route.endsWith('/stop-request')){
      record.res.writeHead(503,{'content-type':'application/problem+json'});
      record.res.end(JSON.stringify({type:'urn:faravan:problem:unavailable',title:'unavailable',
        code:'unavailable',status:503,retryable:false,outcome:'not_applied'}));
      return true;
    }
    return previous(record);
  };
  const endpoint='/api/jobs/'+job.jobDigest+'?circle='+circle.id;
  const requesterJob=await api(owner.app,endpoint);
  assert.equal(requesterJob.jobProjection.evidence.sharedStopRequestUnavailable,true);
  assert.deepEqual(requesterJob.statusContract.allowedActions,[]);
  const requester=jobStatusVM(requesterJob,{role:'sent'});
  assert.equal(requester.canStop,false,'the requester cannot stop a job whose stop status it could not check');
  assert.match(requester.note,/stop request may be pending/i);
  const lenderJob=await api(lender.app,endpoint);
  const local=jobStatusVM(lenderJob,{role:'ran'});
  assert.equal(local.canStop,true,'this computer keeps its own emergency Stop');
  f.override=previous;
});

// A running job whose backend cancellation is held: the attempt stays active until the test releases the barrier.
async function heldRun(t,{ownerPollMs=250,replayAfterSubmit=false}={}) {
  const f=await appFixture(t,{hold:true});
  const {owner,lender,circle}=await f.connect({}, {pollMs:ownerPollMs});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const submission={circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic shared Stop regression',harness:'codex',
    ...(replayAfterSubmit?{draft_id:'replay-12345678'}:{})};
  const job=await api(owner.app,'/api/jobs',{method:'POST',body:submission});
  if(replayAfterSubmit) {
    const replay=await api(owner.app,'/api/jobs',{method:'POST',body:submission});
    assert.equal(replay.jobDigest,job.jobDigest);
    assert.equal(replay.replayed,true);
  }
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>lender.backend.calls.some(([kind])=>kind==='run'),'backend execution').catch(async error=>{
    const status=await api(lender.app,'/api/lending');
    throw new Error(error.message+': '+JSON.stringify({status,attempt:f.jobs.get(job.jobDigest).current_attempt,
      phases:lender.phases,calls:lender.backend.calls.map(([kind])=>kind)}),{cause:error});
  });
  const endpoint='/api/jobs/'+job.jobDigest+'?circle='+circle.id;
  const attempt=(await api(owner.app,endpoint)).current_attempt;
  const originalCancel=lender.backend.cancel.bind(lender.backend);
  let releaseCancel,cancelEntered=0;
  const barrier=new Promise(resolve=>{releaseCancel=resolve;});
  lender.backend.cancel=async(...args)=>{cancelEntered++;await barrier;return originalCancel(...args);};
  return {f,owner,lender,circle,job,endpoint,attempt,releaseCancel,cancelEntered:()=>cancelEntered};
}
const staleStopOutage={type:'urn:faravan:problem:unavailable',title:'unavailable',code:'unavailable',status:503,retryable:false,outcome:'not_applied'};

test('lender Stop reaches the requester as stopping within two seconds through job news',{timeout:120000},async t=>{
  const {f,owner,lender,job,attempt,releaseCancel}=await heldRun(t,{ownerPollMs:60_000});
  const events=await openJobEvents(owner.app);
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    const acknowledgedAt=Date.now();
    const event=await events.waitFor(value=>value.type==='job'&&value.data?.job_digest===job.jobDigest&&value.data?.jobProjection?.phase==='stopping',2000);
    const latencyMs=Date.now()-acknowledgedAt;
    assert.ok(latencyMs<=2000,`requester learned Stop after ${latencyMs} ms`);
    assert.equal(event.data.statusContract.lifecycle,'stop_requested');
    assert.equal(jobStatusVM(event.data,{role:'sent'}).canStop,false,'requester does not offer a duplicate Stop');
    assert.ok(f.networkTrace.some(read=>read.device==='owner'&&read.route.endsWith('/watch')),
      'requester status changes arrive through the coordinator job watch');
    t.diagnostic(`Requester showed stopping ${latencyMs} ms after the lender Stop acknowledgement.`);
  } finally {await events.close();releaseCancel();}
});

test('a replayed submission keeps its requester watch for a later lender Stop',{timeout:120000},async t=>{
  const {owner,lender,job,attempt,releaseCancel}=await heldRun(t,{ownerPollMs:60_000,replayAfterSubmit:true});
  const events=await openJobEvents(owner.app);
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    const event=await events.waitFor(value=>value.type==='job'&&value.data?.job_digest===job.jobDigest&&value.data?.jobProjection?.phase==='stopping',2000);
    assert.equal(event.data.statusContract.lifecycle,'stop_requested');
    assert.equal(jobStatusVM(event.data,{role:'sent'}).canStop,false,'the replayed requester receives Stop news');
  } finally {await events.close();releaseCancel();}
});

// Judge r13 R13-1: the coordinator already has the Stop, but this computer's optional read of it is down. A watch
// re-armed on this computer's own revision (which lacks the Stop) returns at once, so the requester would spin on the
// coordinator. It must retry the read with backoff instead, then deliver the Stop when the read recovers.
test('a stop-read outage does not re-arm the requester watch, then delivers the Stop when the read recovers',{timeout:120000},async t=>{
  const {f,owner,lender,job,attempt,releaseCancel}=await heldRun(t,{ownerPollMs:60_000});
  const events=await openJobEvents(owner.app);
  const previous=f.override;let outageUntil=0,rearmedDuringOutage=0;
  const fromOwner=record=>record.req.headers['x-test-device']==='owner';
  f.override=async record=>{
    const outage=Date.now()<outageUntil&&fromOwner(record)&&record.req.method==='GET';
    if(outage&&/\/watch$/.test(record.route))rearmedDuringOutage++;
    if(outage&&record.route.endsWith('/stop-request')) {
      record.res.writeHead(503,{'content-type':'application/problem+json'});
      record.res.end(JSON.stringify(staleStopOutage));
      return true;
    }
    return previous(record);
  };
  try {
    outageUntil=Date.now()+3000;
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,outageUntil-Date.now())));
    assert.ok(rearmedDuringOutage<=1,`the requester re-armed its job watch ${rearmedDuringOutage} times during a 3 s stop-read outage; it must retry the read instead`);
    const event=await events.waitFor(value=>value.type==='job'&&value.data?.job_digest===job.jobDigest&&value.data?.jobProjection?.phase==='stopping',2000);
    const latencyMs=Date.now()-outageUntil;
    assert.ok(latencyMs<=2000,`requester learned Stop ${latencyMs} ms after the stop read recovered`);
    assert.equal(event.data.statusContract.lifecycle,'stop_requested');
  } finally {await events.close();releaseCancel();}
});

// Closing the requester app aborts its parked coordinator watch and releases the server listener.
test('owner shutdown cancels a parked job watch',{timeout:90000},async t=>{
  const {f,owner,job,releaseCancel}=await heldRun(t);
  try {
    await waitFor(()=>f.jobWatches.get(job.jobDigest)?.size>0,'requester is parked on job news',15000);
    await bounded(owner.app.close(),'owner close with a parked job watch',10000);
    assert.equal(f.jobWatches.has(job.jobDigest),false,'closing the app aborts its coordinator watch');
  } finally {
    releaseCancel();
  }
});

// A Stop verified by a successful read stays known through an optional outage, and recovers from the same attempt.
test('a verified shared Stop stays known through an optional outage, then recovers',{timeout:120000},async t=>{
  const {f,owner,lender,endpoint,attempt,releaseCancel,cancelEntered}=await heldRun(t);
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    await waitFor(()=>cancelEntered()>0,'local cancellation held before cessation');
    const known=await api(owner.app,endpoint);
    assert.equal(known.jobProjection.phase,'stopping');
    const previous=f.override;let failed=0;
    f.override=async record=>{
      if(record.req.method==='GET'&&record.route.endsWith('/stop-request')) {
        failed++;
        record.res.writeHead(503,{'content-type':'application/problem+json'});
        record.res.end(JSON.stringify(staleStopOutage));return true;
      }
      return previous(record);
    };
    try {
      const during=await api(owner.app,endpoint);
      assert.ok(failed>0,'the optional stop read failed during the outage');
      assert.equal(during.jobProjection.phase,'stopping','an optional outage must not erase a verified Stop');
      assert.equal(during.jobProjection.evidence.sharedStopRequestedAt,known.jobProjection.evidence.sharedStopRequestedAt);
      assert.equal(jobStatusVM(during,{role:'sent',lender:'Lender'}).canStop,false,'the requester still cannot start a second Stop');
    } finally {f.override=previous;}
    const recovered=await api(owner.app,endpoint);
    assert.equal(recovered.jobProjection.phase,'stopping');
    assert.equal(recovered.jobProjection.evidence.sharedStopRequestUnavailable,undefined);
  } finally {releaseCancel();}
});

// An outage reuses a Stop verified for the same attempt only; a newer generation and an authorization failure get no reuse.
test('an optional outage reuses a verified Stop only for the same attempt, and an authorization failure stays a failure',{timeout:120000},async t=>{
  const {owner,lender,circle,job,attempt,releaseCancel,cancelEntered}=await heldRun(t);
  const originalClient=owner.app.device.client,previousClient=originalClient.bind(owner.app.device);
  let mode='normal';
  owner.app.device.client=async(...args)=>{
    const client=await previousClient(...args);
    return new Proxy(client,{get(target,key){
      if(key==='getJob')return async(digest,opts={})=>{
        const view=await target.getJob(digest,opts);
        return mode==='newer'&&view.current_attempt?{...view,current_attempt:{...view.current_attempt,generation:view.current_attempt.generation+1}}:view;
      };
      if(key==='getStopRequest')return async(attemptView,opts={})=>{
        if(mode==='outage'||mode==='newer')throw Object.assign(new Error('unavailable'),{status:503,code:'unavailable'});
        if(mode==='auth')throw Object.assign(new Error('unauthorized'),{status:401,code:'unauthorized'});
        return target.getStopRequest(attemptView,opts);
      };
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
  };
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    await waitFor(()=>cancelEntered()>0,'local cancellation held before cessation');
    const operations=createJobOperations({device:owner.app.device,home:owner.home});
    const digest=job.jobDigest;
    mode='normal';
    const known=await operations.get({digest,circle:circle.id});
    assert.ok(known.stopRequest,'the Stop is verified by a successful read');
    mode='outage';
    const same=await operations.get({digest,circle:circle.id});
    assert.ok(same.stopRequest,'an outage reuses the Stop verified for this same attempt');
    assert.equal(same.stopRequestReadUnavailable,true);
    mode='newer';
    const newer=await operations.get({digest,circle:circle.id});
    assert.equal(newer.stopRequest,undefined,'a newer attempt generation never inherits an old Stop');
    mode='auth';
    await assert.rejects(operations.get({digest,circle:circle.id}),error=>error.status===401,'an authorization failure is not availability');
  } finally {
    mode='normal';
    owner.app.device.client=originalClient;
    releaseCancel();
  }
});

// A Stop the lender started is not worded as the requester's own request; this computer keeps its local wording.
test('a Stop the lender issued is not reported as the requester\'s own request',{timeout:120000},async t=>{
  const {owner,lender,endpoint,attempt,releaseCancel,cancelEntered}=await heldRun(t);
  try {
    await api(lender.app,'/api/lending/stop',{method:'POST',body:{attemptId:attempt.attempt_id,confirmed:true}});
    await waitFor(()=>cancelEntered()>0,'local cancellation held before cessation');
    const requester=jobStatusVM(await api(owner.app,endpoint),{role:'sent',lender:'Lender'});
    assert.doesNotMatch(requester.headline,/^You asked /,'the lender started this Stop; the requester did not');
    assert.equal(requester.headline,'Stop requested for your job','neutral wording when the actor is not the requester');
    const local=jobStatusVM(await api(lender.app,endpoint),{role:'ran',lender:'Lender'});
    assert.match(local.headline,/^Stopping /,'this computer keeps its own local Stop wording');
  } finally {releaseCancel();}
});

// A Stop the requester sent itself still reads as the requester's own request.
test('a Stop the requester itself sent still reads as the requester\'s own request',{timeout:120000},async t=>{
  const {owner,circle,job,endpoint,releaseCancel}=await heldRun(t);
  try {
    await api(owner.app,'/api/jobs/'+job.jobDigest+'/cancel',{method:'POST',body:{circle:circle.id}});
    const requester=jobStatusVM(await api(owner.app,endpoint),{role:'sent',lender:'Lender'});
    assert.equal(requester.headline,'You asked Lender’s computer to stop');
  } finally {releaseCancel();}
});

for(const phase of ['initial','coherence'])test('close aborts ordinary detail '+phase+' outgoing Stop read',{timeout:90000},async t=>{
  const {f,owner,job,endpoint,releaseCancel}=await heldRun(t,{ownerPollMs:60_000});
  const previous=f.override;
  let stopReads=0,heldResponse=null,outgoingClosed=false;
  let detail;
  try {
    await waitFor(()=>f.jobWatches.get(job.jobDigest)?.size>0,'background watch is parked before the ordinary detail read',15000);
    f.override=async record=>{
      if(record.req.headers['x-test-device']==='owner'&&record.req.method==='GET'&&record.route.endsWith('/stop-request')){
        stopReads++;
        if(phase==='coherence'&&stopReads===1){
          // The first job read succeeds but optional Stop metadata is unavailable, so the app must reread for coherence.
          record.res.writeHead(503,{'content-type':'application/problem+json'});
          record.res.end(JSON.stringify(staleStopOutage));return true;
        }
        heldResponse=record.res;
        record.res.once('close',()=>{if(!record.res.writableEnded)outgoingClosed=true;});
        return true;
      }
      return previous(record);
    };
    // Catch immediately: shutdown intentionally closes this incoming HTTP connection too.
    detail=fetch(owner.app.origin+endpoint,{headers:{'x-faravan-session-token':owner.app.token}})
      .then(async response=>({status:response.status,body:await response.text()})).catch(error=>({error}));
    await waitFor(()=>heldResponse!==null,'ordinary detail optional Stop request is held');
    assert.equal(stopReads,phase==='coherence'?2:1,'the intended initial or coherence read reached the coordinator');
    await bounded(owner.app.close(),'close with ordinary detail '+phase+' Stop read',15000);
    await waitFor(()=>outgoingClosed,'shutdown aborts the outgoing held Stop request',2000);
    assert.equal(outgoingClosed,true,'closing the incoming app socket alone is not cancellation of the outgoing read');
  } finally {
    f.override=previous;
    heldResponse?.destroy();
    await detail;
    releaseCancel();
  }
});

test('ordinary detail healthy read still returns the active job without stop uncertainty',{timeout:90000},async t=>{
  const {owner,endpoint,releaseCancel}=await heldRun(t,{ownerPollMs:60_000});
  try {
    const job=await api(owner.app,endpoint);
    assert.equal(job.jobProjection.phase,'running');
    assert.equal(job.current_attempt.compute_stopped,false);
    assert.equal(job.jobProjection.evidence.sharedStopRequestUnavailable,undefined);
  } finally {releaseCancel();}
});
