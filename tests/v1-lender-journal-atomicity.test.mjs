import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {lenderFixture,deferred,until} from './helpers/v1-lender-fixture.mjs';
import {journalLender} from './helpers/lender-journal.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const cases=[
  {kind:'legacy normalization',state:undefined,target:(next,old)=>next.claimPending&&old.claimPending?.state===undefined},
  {kind:'transmission checkpoint',state:'created-unsent',target:next=>next.claimPending?.state==='sent-uncertain'},
  {kind:'fresh-check refusal',state:'created-unsent',refuse:true,target:next=>next.claimPending?.state==='created-unsent'&&next.claimPending.request},
  {kind:'confirmed lease expiry',state:'confirmed',expired:true,target:next=>next.claimPending?.state==='expired-unstarted'},
  {kind:'confirmed reply',state:'created-unsent',target:next=>next.claimPending?.state==='confirmed'},
  {kind:'rejected reply',state:'created-unsent',reply:'rejected',target:next=>next.claimPending?.state==='rejected'},
  {kind:'expired reply',state:'created-unsent',reply:'expired',target:next=>next.claimPending?.state==='expired-unstarted'},
  {kind:'changed-rule release handoff',state:'confirmed',target:next=>next.claimPending===null&&next.claimedPending&&!next.declinePending},
  {kind:'rejected-claim release handoff',state:'rejected',target:next=>next.claimPending===null&&next.declinePending?.rejectedClaim},
  {kind:'terminal claim cleanup',state:'dropped',claimed:true,target:next=>next.claimPending===null&&next.lastClaimOutcome},
  {kind:'expired-key replacement',state:'expired-unstarted',target:(next,old)=>next.claimPending&&next.claimPending.idempotencyKey!==old.claimPending?.idempotencyKey},
  {kind:'retained acceptance resume',state:'confirmed',accepted:true,target:next=>next.claimPending&&next.acceptedClaim===null},
  {kind:'ordinary acceptance handoff',state:'confirmed',manual:true,target:next=>next.claimPending===null&&next.acceptedClaim},
  {kind:'decline metadata',state:'confirmed',manual:true,decline:true,target:next=>next.declinePending},
  {kind:'explicit Stop revocation',state:'confirmed',manual:true,stop:true,target:next=>next.declinePending?.stoppedByLender},
];

test('journal transitions survive a failed write followed by a queued unrelated write and restart',{timeout:180000},async suite=>{
  const createLender=await journalLender(suite);
  for(const row of cases)await suite.test(row.kind,{timeout:15000},async t=>{
    const f=await lenderFixture(t),report=f.backend.lenderCapabilities();
    const attempt=f.attempt(),expired={...attempt,claimed_at:new Date(f.clock.now()-121000).toISOString(),lease_expires_at:new Date(f.clock.now()-1000).toISOString()};
    const advertisement={harnesses:['codex'],models:['example-model'],capabilities:[],egress:report.egress,
      enforced_limits:report.enforced_limits,max_limits:report.max_limits};
    const claim={job_digest:f.jobDigest,job:f.job,attempt:row.expired?expired:attempt,accepted:true,automatic:false,acceptedHarness:'codex'};
    const intent={jobDigest:f.jobDigest,job:f.job,advertisement,leaseSeconds:120,idempotencyKey:'accepted-claim',
      ...(row.state?{state:row.state}:{}),acceptedAt:f.clock.now(),ruleId:row.manual?null:'removed-rule'};
    if(row.state==='confirmed')intent.claimResult=structuredClone(claim);
    if(['rejected','expired-unstarted'].includes(row.state))intent.claimError={code:row.state==='rejected'?'conflict':'lease_expired',status:409,
      ...(row.state==='rejected'?{claimRejected:true}:{}),committedAttempt:row.state==='rejected'?attempt:expired};
    const base={day:'2026-10-09',jobs:0,milliseconds:0,pending:null,hiddenOffers:[],ruleUsage:[],
      observationPending:[{idempotencyKey:'unrelated-observation'}],
      ...(row.accepted?{acceptedClaim:{intent,claim}}:{claimPending:intent}),...(row.claimed?{claimedPending:attempt}:{})};
    await f.policy.storage.set(base);
    f.policy.storage.get=async()=>structuredClone(f.saved());
    delete f.client.observeExecutionStart;
    f.client.claimNext=async()=>null; // A lost named claim must not be rescued by an unrelated blind claim.
    f.client.getJob=async()=>({job_digest:f.jobDigest,job:f.job,state:'queued',current_attempt:expired});
    f.override=async({route,res})=>{
      if(route==='/jobs/'+f.jobDigest.slice(7)+'/claim'){f.json(res,{job_digest:f.jobDigest,job:f.job,attempt});return true;}
      return false;
    };
    const realClaim=f.client.claimJob.bind(f.client),realRelease=f.client.release.bind(f.client),releases=[],sends=[];
    let phase='first',lender,controller,loop,hit=false,dirty=false,frame=null,queued;
    const acknowledged=deferred();
    f.client.claimJob=async(...args)=>{
      sends.push({phase,key:args[2].idempotencyKey});
      const result=await realClaim(...args);
      if(phase==='first'&&row.reply)throw Object.assign(new Error(row.reply),{code:row.reply==='rejected'?'conflict':'lease_expired',status:409,
        ...(row.reply==='rejected'?{claimRejected:true}:{}),committedAttempt:row.reply==='rejected'?attempt:expired});
      return result;
    };
    f.client.release=async(...args)=>{const result=await realRelease(...args);releases.push(args[0].attempt_id);return result;};
    const capabilities=f.backend.lenderCapabilities;
    let stopping=false;
    f.backend.lenderCapabilities=async options=>{
      if(phase==='first'&&row.stop&&!options&&lender?.snapshot.current&&!lender.journalForTest().pending&&!stopping){
        stopping=true;await lender.stopCurrentJob(attempt.attempt_id).catch(()=>{});
      }
      return phase==='first'&&row.refuse&&!options?{...report,available:false}:capabilities(options);
    };
    if(row.decline)f.policy.maxWallSeconds=60;
    const set=f.policy.storage.set;
    f.policy.storage.set=async value=>{
      if(!hit&&row.target(value,f.saved())){
        hit=true;dirty=!isDeepStrictEqual(lender.journalForTest(),f.saved());
        queued=lender.persistForTest(saved=>({...saved,observationPending:[]}),{observationWrite:true}).then(async()=>{
          frame=structuredClone(f.saved());acknowledged.resolve();await turn();await turn();controller.abort();
        });
        await turn();throw Object.assign(new Error('injected journal write failure'),{code:'EIO'});
      }
      await set(value);
    };
    const start=()=>{
      controller=new AbortController();
      lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,
        approve:async()=>true,onEvent:event=>f.events.push(event)});
      loop=lender.start(controller.signal);loop.catch(()=>{});
      f.stop=async()=>{controller.abort();lender.reconfigure();await loop.catch(()=>{});};
      return loop;
    };
    const first=start();await until(()=>hit,'target transition reached');
    await acknowledged.promise;await queued;await first.catch(()=>{});
    const crash=structuredClone(f.saved());
    if(row.stop||row.manual)f.policy.enabled=false;
    phase='restart';const restarted=start();
    for(let n=0;n<1000&&!releases.includes(attempt.attempt_id)&&!f.result;n++){await tick();lender.reconfigure();}
    controller.abort();lender.reconfigure();await restarted.catch(()=>{});
    const owner=value=>Boolean(value?.claimedPending?.attempt_id===attempt.attempt_id||value?.pending?.attemptId===attempt.attempt_id||
      value?.declinePending?.attempt?.attempt_id===attempt.attempt_id||value?.resultPending?.attempt?.attempt_id===attempt.attempt_id||
      value?.acceptedClaim?.claim?.attempt?.attempt_id===attempt.attempt_id||
      ['confirmed','rejected','expired-unstarted'].includes(value?.claimPending?.state)&&
      (value.claimPending.claimResult?.attempt?.attempt_id===attempt.attempt_id||value.claimPending.claimError?.committedAttempt?.attempt_id===attempt.attempt_id));
    const work=value=>Boolean(value?.claimPending?.jobDigest===f.jobDigest&&!['dropped','replaced'].includes(value.claimPending.state)||value?.acceptedClaim?.intent?.jobDigest===f.jobDigest);
    const details=JSON.stringify({kind:row.kind,dirty,frameState:frame?.claimPending?.state,crashState:crash?.claimPending?.state,releases,sends,
      events:f.events.slice(-4).map(({status,reason})=>({status,reason}))});
    assert.equal(dirty,false,'committed journal changed before its write: '+details);
    assert.ok(owner(frame)||work(frame)||releases.length||f.result,'acknowledgment erased recovery ownership: '+details);
    assert.ok(owner(crash)||work(crash)||releases.length||f.result,'crash snapshot erased recovery ownership: '+details);
    assert.ok(releases.includes(attempt.attempt_id)||f.result,'restart could not settle the accepted attempt: '+details);
    if(row.stop){assert.equal(frame.claimPending,null);assert.equal(frame.acceptedClaim,null);assert.ok(frame.pending||frame.declinePending,'Stop must retain a durable recovery owner');}
  });
});
