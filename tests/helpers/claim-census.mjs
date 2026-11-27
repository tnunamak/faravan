import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DockerSbxBackend,SBX_RUN_OPTIONS} from '../../lib/docker-backend.mjs';
import {lenderFixture} from './v1-lender-fixture.mjs';
import {instrumentLender,withClaimAwaits} from './claim-awaits.mjs';

const ok=stdout=>({code:0,stdout:stdout??'',stderr:''});
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
const rows=[
  {id:1,name:'new blind claim',blind:true},
  {id:2,name:'automatic offer',auto:true},
  {id:3,name:'approved offer'},
  {id:4,name:'automatic owner fallback',auto:true,owner:true},
  {id:5,name:'approved owner fallback',owner:true},
  {id:6,name:'rotated kept acceptance',history:'rotated'},
  {id:7,name:'confirmed acceptance restored',history:'confirmed'},
  {id:8,name:'new key after confirmed expiry',history:'replacement'},
  {id:9,name:'unsent named startup',history:'unsent'},
  {id:10,name:'unsent blind startup',history:'unsent',blind:true},
  {id:11,name:'live uncertain named',history:'live'},
  {id:12,name:'live uncertain blind',history:'live',blind:true},
  {id:13,name:'sent named startup',history:'uncertain'},
  {id:14,name:'sent blind startup',history:'uncertain',blind:true},
  {id:15,name:'known response with failed local persistence',history:'settlement',auto:true},
  {id:16,name:'known rejection with held cleanup',history:'rejected'},
  {id:17,name:'known expiry with failed verification',history:'expired'},
];

async function scenario(t,createLender,row,target=null,stale=false,statistics=null){
  const f=await lenderFixture(t,{offers:!row.blind,authorIndex:row.owner?1:0,policy:{mode:row.auto?'auto':'ask'}});
  f.policy.storage.acquire=async()=>async()=>{};
  f.backend.reconcileOwnedSandboxes=async()=>({removed:true});
  const host={up:true},trace=[],history=new Map(),planned=new Map(),boundaries=[],controller={current:null};
  let collect=false,killHit=false,goal=false,violation=null,stage='setup',key=null,snapshot=null;
  let reply='success',failWrite=false,releaseHeld=false,verifyFails=false;
  const realNext=f.client.claimNext.bind(f.client),realJob=f.client.claimJob.bind(f.client),baseReport=f.backend.lenderCapabilities();
  const coordinator=new Map();
  f.override=async({route,req,res})=>{
    const known=[...coordinator.values()].find(value=>route.startsWith('/attempts/'+value.attempt.attempt_id));
    if(known&&known.attempt.attempt_id!==f.attempt().attempt_id){
      const suffix=route.slice(('/attempts/'+known.attempt.attempt_id).length);
      if(suffix==='/stop-request'){f.json(res,null);return true;}
      if(suffix==='/release'||suffix==='/fail')known.attempt={...known.attempt,state:suffix==='/release'?'released':'failed'};
      if(suffix==='/stopped')known.attempt={...known.attempt,compute_stopped:true,stopped_at:new Date(f.clock.now()).toISOString()};
      if(suffix==='/start')known.attempt={...known.attempt,execution_started_at:new Date(f.clock.now()).toISOString()};
      f.json(res,known.attempt);return true;
    }
    if(route!=='/jobs/claim-next'&&route!=='/jobs/'+f.jobDigest.slice(7)+'/claim')return false;
    const id=req.headers['idempotency-key'];
    if(row.empty&&stage==='target'){f.json(res,null);return true;}
    if(!coordinator.has(id))coordinator.set(id,{job_digest:f.jobDigest,job:f.job,attempt:{...f.attempt(),
      ...(coordinator.size?{attempt_id:randomUUID(),generation:coordinator.size+1}:{})}});
    f.json(res,coordinator.get(id));return true;
  };
  const native=new DockerSbxBackend({monotonic:f.clock.now,storage:{available:async()=>true}});
  native._hostDiskCheck=async()=>({name:'host_disk',ok:true});
  const options={platformName:'linux',runCommand:async(command,args)=>{
    if(args[0]==='version')return ok('sbx version v0.51.0');
    if(args[0]==='diagnose')return host.up?ok('Daemon healthy\nDocker authentication healthy'):{code:1,stderr:'daemon connection refused'};
    if(args.join(' ')==='ls -q')return host.up?ok():{code:1,stderr:'daemon connection refused'};
    if(args.join(' ')==='run --help')return ok(SBX_RUN_OPTIONS.join('\n'));
    if(command==='dpkg-query')return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if(command==='docker')return ok('28.0.0');
    if(command==='containerd')return ok('containerd v2.1.0');
    return ok();
  }};
  const readNative=async context=>{
    const before=native._observationCache;
    const result=await native.lenderCapabilities({...options,...context});
    const event={probe:context?.observation?'observation':'full',up:host.up,available:result.available,
      ...(context?.observation?{cached:before===native._observationCache}:{}),
      ...(!result.available?{failed:result.preflight.checks.filter(check=>!check.ok).map(check=>check.name)}:{})};
    if(statistics&&killHit&&!host.up&&context?.observation){
      if(event.cached&&result.available)statistics.cachedSuccess++;
      if(!event.cached&&!result.available)statistics.freshFailure++;
    }
    const previous=trace.at(-1);
    if(previous&&JSON.stringify({...previous,repeats:undefined})===JSON.stringify(event))previous.repeats=(previous.repeats??1)+1;
    else trace.push(event);
    return result;
  };
  assert.equal((await readNative()).available,true);
  assert.equal((await readNative({observation:true,idle:true})).available,true);
  f.backend.lenderCapabilities=async context=>{
    const result=await readNative(context);
    return {...baseReport,available:result.available,preflight:result.preflight};
  };
  f.policy.quota=()=>({provider:'codex',remaining:100,observedAt:f.clock.now()});
  if(!row.blind){
    f.client.capabilities=async()=>({capabilities:['offers_v1']});
    f.client.listOffers=async function*(){yield {job_digest:f.jobDigest,job:f.job,state:'queued',published_at:'2026-10-09T12:00:00Z',current_attempt:null};};
  }
  if(row.owner){
    f.policy.ownKeyId=f.job.payload.author;
    f.adapters.forEach(a=>{a.spec={...a.spec,auth_strategy:'provider-file-generation'};});
  }
  const attempt={...f.attempt(),execution_started_at:null};
  f.client.getJob=async()=>{
    if(verifyFails){verifyFails=false;throw Object.assign(new Error('view unavailable'),{code:'network_error'});}
    return {job_digest:f.jobDigest,job:f.job,state:'queued',current_attempt:attempt};
  };
  const pendingAwaits=new Set();let killedIdleCycles=0;
  const isIdle=label=>/\bidle\(|\bfailureWait\(/.test(label);
  const context={boundary(label,phase){
    if(phase==='pending')pendingAwaits.add(label);else pendingAwaits.delete(label);
    if(!collect)return;
    const point={label,phase};boundaries.push(point);
    if(target&&!killHit&&target.label===label&&target.phase===phase){
      killHit=true;host.up=false;if(stale)f.clock.advance(65000);
      trace.push({kill:point,stale});
    }
    if(killHit&&phase==='pending'&&/\bidle\(/.test(label))killedIdleCycles++;
  }};
  const transport=async(endpoint,digest,advertisement,settings)=>{
    if(settings.signal?.aborted)throw settings.signal.reason;
    const tuple={endpoint,digest,advertisement:structuredClone(advertisement),key:settings.idempotencyKey,leaseSeconds:settings.leaseSeconds,waitSeconds:settings.waitSeconds,exclude:settings.exclude};
    if(planned.has(tuple.key))assert.deepEqual(tuple,planned.get(tuple.key),'accepted request changed before send');
    const old=history.get(tuple.key),exempt=old?.outcome==='unknown'&&old.sends>0;
    if(collect&&((old&&old.outcome!=='unknown')||(!exempt&&!host.up)))violation??={tuple,old,host:host.up};
    if(old)assert.deepEqual(tuple,old.tuple,'claim replay changed the exact request');
    const record=old??{tuple,sends:0,outcome:'unknown'};record.sends++;history.set(tuple.key,record);
    trace.push({send:tuple.key,stage,up:host.up,previous:old?.outcome??null});
    key=tuple.key;
    const realClaim=()=>endpoint==='job'?realJob(digest,advertisement,settings):realNext(advertisement,settings);
    if(stage==='unsent')throw new Error('unsent capture unexpectedly sent');
    if(stage==='uncertain'){
      record.value=await realClaim();
      return new Promise((_,reject)=>settings.signal.addEventListener('abort',()=>reject(Object.assign(new Error('reply lost'),{code:'network_error'})),{once:true}));
    }
    if(stage==='live-first'){
      record.value=await realClaim();
      stage='target';collect=true;record.outcome='unknown';
      throw Object.assign(new Error('reply lost'),{code:'network_error'});
    }
    if(collect&&(['unsent','uncertain','live','rotated'].includes(row.history)||!row.history)){
      goal=true;collect=false;controller.current.abort();return null;
    }
    if(reply==='expired'){
      record.outcome='expired-unstarted';reply='replacement';
      throw Object.assign(new Error('expired'),{code:'lease_expired',status:409,committedAttempt:attempt});
    }
    if(reply==='rejected'){
      record.outcome='rejected';reply='success';
      throw Object.assign(new Error('rejected'),{code:'conflict',status:409,claimRejected:true});
    }
    if(reply==='replacement'){
      goal=true;collect=false;controller.current.abort();return null;
    }
    const value=await realClaim();record.value=value;
    record.outcome='confirmed';
    if(stage==='target'&&row.history==='settlement')failWrite=true;
    if(stage==='target'&&row.changedRule)f.policy.standingRules=[];
    return value;
  };
  f.client.claimNext=(advertisement,settings)=>transport('next',null,advertisement,settings);
  f.client.claimJob=(digest,advertisement,settings)=>transport('job',digest,advertisement,settings);
  const originalSet=f.policy.storage.set;
  f.policy.storage.set=async value=>{
    if(failWrite){failWrite=false;throw Object.assign(new Error('local write failed'),{code:'EIO'});}
    await originalSet(value);
    if(value?.claimPending){
      const intent=value.claimPending,request=intent.request??intent;
      const tuple={endpoint:request.jobDigest?'job':'next',digest:request.jobDigest??null,advertisement:structuredClone(request.advertisement),key:intent.idempotencyKey,
        leaseSeconds:request.leaseSeconds??120,waitSeconds:request.jobDigest?undefined:request.waitSeconds??30,exclude:request.exclude};
      if(planned.has(tuple.key))assert.deepEqual(tuple,planned.get(tuple.key),'durable request changed');
      planned.set(tuple.key,tuple);
    }
    if(stage==='unsent'&&value.claimPending&&(!row.checkpoint||value.claimPending.state===undefined||value.claimPending.state==='sent-uncertain')){
      snapshot=structuredClone(value);controller.current.abort();throw new Error('capture before first send');
    }
    if(stage==='confirmed'&&value.claimedPending&&!value.claimPending){snapshot=structuredClone(value);controller.current.abort();throw new Error('capture after confirmation');}
    if(stage==='unstarted'&&!snapshot&&value.pending?.executionStartRequested===false){snapshot=structuredClone(value);controller.current.abort();throw new Error('capture before execution request');}
    if(stage==='rotating'&&value.acceptedClaim?.intent.idempotencyKey!==key&&value.acceptedClaim){snapshot=structuredClone(value);controller.current.abort();throw new Error('capture rotated acceptance');}
    if(stage==='target'&&['confirmed','settlement','rejected'].includes(row.history)&&!value.claimPending){goal=true;collect=false;controller.current.abort();}
  };
  const candidate=f.policy.lendingRuntime.candidate;
  const start=()=>{
    const c=new AbortController();controller.current=c;
    const lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,approve:async()=>true,credentialValues:()=>[],onEvent:event=>f.events.push(event)});
    const loop=withClaimAwaits(context,()=>lender.start(c.signal));
    loop.catch(()=>{});
    f.stop=async()=>{c.abort();await loop.catch(()=>{});};
    return {c,lender,loop};
  };
  const drive=async(run,predicate,max=250)=>{
    for(let i=0;i<max*12&&!predicate();i++){await tick();advanceIdle();}
    assert.ok(predicate(),JSON.stringify({row:row.id,stage,goal,key,tail:trace.slice(-12),events:f.events.slice(-3)}));
    return run;
  };
  const advanceIdle=()=>{
    // Real HTTP latency must not advance logical time or manufacture watcher/deadline races.
    if([...pendingAwaits].some(isIdle)){
      const timers=f.clock.pending();if(timers.length)f.clock.advance(Math.max(1,Math.min(...timers)));
    }
  };
  try{
    if(['unsent','uncertain','confirmed','rotated','replacement','expired','settlement','rejected'].includes(row.history)){
      stage=['unsent','uncertain'].includes(row.history)?row.history:'confirmed';
      if(['replacement','expired'].includes(row.history))stage='uncertain';
      let run=start();
      if(stage==='uncertain'){
        await drive(run,()=>[...history.values()].some(record=>record.value));await tick();snapshot=structuredClone(f.saved());run.c.abort();
      }else await drive(run,()=>snapshot!==null);
      await run.loop.catch(()=>{});
      assert.ok(snapshot,'history must come from a real durable write');
      if(row.history==='rotated'){
        await originalSet(snapshot);stage=row.recovery?'unstarted':'rotating';snapshot=null;
        run=start();
        const prepare=f.backend.prepare;
        if(!row.recovery)f.backend.prepare=async(...args)=>{void run.lender.pause();return prepare(...args);};
        await drive(run,()=>snapshot!==null);await run.loop.catch(()=>{});f.backend.prepare=prepare;
        if(row.recovery){
          await originalSet(snapshot);snapshot=null;stage='rotating';
          f.backend.reconcilePending=async pending=>({removed:true,attemptId:pending.attemptId,sbx_home:pending.sbx_home});
          run=start();await drive(run,()=>snapshot!==null);await run.loop.catch(()=>{});
        }
      }
      if(['settlement','rejected'].includes(row.history)){
        const previous=structuredClone(snapshot.claimedPending);
        stage='unsent';snapshot=null;await originalSet(null);run=start();await drive(run,()=>snapshot!==null);await run.loop.catch(()=>{});
        snapshot.claimedPending=previous;
        candidate.adapter={state:()=>({attempts:releaseHeld?[{id:previous.attempt_id,process_state:'running'}]:[]})};
        candidate.release=async()=>{releaseHeld=false;return {applied:true};};
        releaseHeld=row.history==='rejected'||row.changedRule;reply=row.history==='rejected'?'rejected':'success';
        if(releaseHeld){let first=true;candidate.release=async()=>{if(first){first=false;return {applied:false};}releaseHeld=false;return {applied:true};};}
      }
      await originalSet(snapshot);
      if(['replacement','expired'].includes(row.history)){reply='expired';verifyFails=row.history==='expired';}
    }
    stage=row.history==='live'?'live-first':'target';collect=stage==='target';goal=false;
    const run=start();
    for(let i=0;i<3000&&!goal&&!violation;i++){
      await tick();advanceIdle();
      if(killHit&&killedIdleCycles>=3)break;
    }
    if(target&&killHit&&!goal&&!violation){
      host.up=true;
      assert.equal((await readNative()).available,true,'explicit recovery reproves diagnostics');
      f.clock.advance(15000);
      for(let i=0;i<3000&&!goal&&!violation;i++){await tick();advanceIdle();}
      assert.ok(goal,JSON.stringify({row:row.id,target,reason:'unsent work did not recover',trace,
        events:f.events.slice(-4).map(event=>({status:event.status,reason:event.reason,pendingState:event.counters?.claimPending?.state,key:event.counters?.claimPending?.idempotencyKey}))}));
    }
    run.c.abort();await run.loop.catch(()=>{});
    assert.equal(violation,null,JSON.stringify({row:row.id,target,history:[...history],violation,trace}));
    if(target)assert.ok(killHit,JSON.stringify({row:row.id,target,reason:'barrier not reached'}));
    else assert.ok(goal,JSON.stringify({row:row.id,reason:'healthy expected sink not reached',trace,events:f.events.slice(-4)}));
    return boundaries;
  }finally{await f.stop?.();}
}

export async function claimCensus(t){
  const createLender=await instrumentLender(t);
  const statistics={cachedSuccess:0,freshFailure:0};
  for(const entry of rows)await t.test(`${entry.id}: ${entry.name}`,{timeout:180000},async group=>{
    const variants=entry.id===6?[{name:'pre-start pause'},{name:'unstarted recovery',recovery:true}]:
      [9,10].includes(entry.id)?[{name:'created intent restored'},{name:'write-ahead checkpoint restored',checkpoint:true}]:
      entry.id===15?[{name:'known success'},{name:'changed rule with cleanup hold',changedRule:true},{name:'known empty response',blind:true,auto:false,empty:true}]:
      entry.id===16?[{name:'named rejection'},{name:'blind rejection',blind:true}]:[{name:'entry'}];
    for(const variant of variants)await group.test(variant.name,async child=>{
    const row={...entry,...variant};
    const run=async(target=null,stale=false)=>child.test(target?`${target.label} ${target.phase} ${stale?'expired observation':'cached success'}`:'healthy',async leaf=>scenario(leaf,createLender,row,target,stale,statistics));
    let points;
    await child.test('healthy trace',async leaf=>{points=await scenario(leaf,createLender,row);});
    assert.ok(points,'healthy control must reach its sink');
    const unique=[...new Map(points.map(point=>[JSON.stringify(point),point])).values()];
    assert.ok(unique.length>0,'the entry must exercise awaited dependencies');
    for(const point of unique)for(const stale of [false,true])await run(point,stale);
    child.diagnostic(`${unique.length} await boundaries, both observation states`);
    });
  });
  assert.ok(statistics.cachedSuccess>0,'outage cases must consume some cached healthy observations');
  assert.ok(statistics.freshFailure>0,'outage cases must also consume explicit failed observations');
  t.diagnostic(JSON.stringify(statistics));
}
