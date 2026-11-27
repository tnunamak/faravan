import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dockerFacts} from '../lib/v1/docker-state.mjs';
import {createDeadlineRecoveryGate} from '../lib/v1/deadline-recovery-gate.mjs';

// Run the real lexical UI functions with controlled dependencies, not a second cache implementation.
// This deliberately avoids starting the app, timers, Docker, jobs, or identity probes.
const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const section=(from,to)=>{
  const start=source.indexOf(from),end=source.indexOf(to,start);
  assert.ok(start>=0&&end>start,'app function boundaries must remain available');
  return source.slice(start,end);
};
const ui=section('  async function checkDocker(', '  const SIGNED_OUT_REMEDY=')+
  section('  let blockerCheck=null,', '  // The app never sends a person')+
  section('  async function readiness(', '  // One path for every answer to a review card');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(options={}) {
  let time=100000,publicationCount=0,repairs=0,activeJob=false;
  const calls=[],pending=[];
  const healthy=(requirements={egress:'restricted'})=>({
    source:'read-only-preflight',backend_id:'docker-sbx',observed_at:new Date(time).toISOString(),
    sandbox_ready:true,version_gate:{ok:true},egress:{requested:requirements.egress,enforceable:true,source_enforceable:true},
    limits:{enforced:Object.keys(requirements.limits??{}),satisfied:true},satisfied:true,
    preflight:{version:'1.0.0',checks:[{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]},
  });
  const backend={
    protectionSummary(requirements,context) {
      calls.push({requirements,context});
      return new Promise((resolve,reject)=>pending.push({resolve,reject,requirements}));
    },
    async recoverHealth(){repairs++;return null;},
  };
  const factory=new Function('backend','options','now','publish','active','createDeadlineRecoveryGate','dockerFacts',`
    const JOB_DEFAULTS={limits:{},limit_modes:{},egress:'restricted'};
    const refreshAbort=new AbortController();
    const statusCheckNow=now;
    const deadlineRecovery=createDeadlineRecoveryGate({backend,signal:refreshAbort.signal});
    let dockerSignedOut=false,dockerCheckedAt=0,observedSbxVersion=null;
    const closed=false,settings={enabled:false},directory='unused',boundaryRecords=[];
    const lender={getState:()=>({current:active()?'fixture-job':null})},signin={busy:false},sandboxHealth={restarted(){}};
    const noteChecks=checks=>{publish();dockerCheckedAt=now();dockerSignedOut=checks.some(c=>c.name==='docker_login'&&!c.ok);};
    const safeLine=value=>typeof value==='string'?value:'';
    const appRemedy=()=>'',boundaryVerified=()=>null,refreshTestCache=async()=>{};
    const dockerProblem=()=>({}),normalizeSbxVersion=value=>value;
    const createSupportReadinessCache=()=>({record(){}}),atomic=()=>{},join=()=>'',emit=()=>{};
    const setupProgress={reconcile:async()=>false},resumeHook={remove:async()=>{}},retestAfterVersionChange=()=>{},retestAfterDiskWait=()=>{};
    const adapterEntries=async()=>[{spec:{harness_id:'fixture',egress_provider_hosts:['provider.invalid']}}];
    ${ui}
    return {checkDocker,refreshReadiness,cachedReadiness,jobReadiness};
  `);
  const app=factory(backend,options,()=>time,()=>publicationCount++,()=>activeJob,createDeadlineRecoveryGate,dockerFacts);
  return {...app,calls,setActive:value=>{activeJob=value;},advance:ms=>{time+=ms;},publications:()=>publicationCount,repairs:()=>repairs,
    settle(patch={}){const next=pending.shift();assert.ok(next,'expected a pending probe');next.resolve({...healthy(next.requirements),...patch});},
    reject(){const next=pending.shift();assert.ok(next);next.reject(Error('probe unavailable'));},
  };
}

test('Docker and readiness UI callers share one read-only observation and publication',async()=>{
  const h=harness();
  const reads=[h.checkDocker(),h.checkDocker(),h.refreshReadiness({observation:true})];
  await flush();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].context.observation,true);
  h.settle();await Promise.all(reads);
  assert.equal(h.publications(),1);
  assert.equal(h.repairs(),0);
  h.advance(1000);
  const report=await h.refreshReadiness({observation:true});
  assert.equal(h.calls.length,1);
  assert.equal(Date.parse(report.observed_at),100000,'reuse must not stamp evidence now');
  h.advance(15000);
  await h.checkDocker();
  assert.equal(h.calls.length,1,'UI traffic on an idle machine keeps sixty-second freshness');
  h.advance(45000);
  const blocked=h.checkDocker();await flush();
  h.settle({sandbox_ready:false,satisfied:false,preflight:{checks:[{name:'sbx_daemon',ok:false}]}});
  await blocked;
  assert.equal(h.repairs(),0,'a failing Docker read must also remain read-only');
});

test('forced Docker checks wait behind weak observations and coalesce a distinct full probe',async()=>{
  const h=harness(),weak=h.checkDocker();
  await flush();
  const full=h.checkDocker({force:true}),alsoFull=h.refreshReadiness();
  await flush();
  assert.equal(h.calls.length,1,'strong callers must wait, not bypass the shared lane');
  h.settle();await weak;await flush();
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].context.observation,false);
  const alsoWeak=h.checkDocker();await flush();
  assert.equal(h.calls.length,2,'a strong flight serves a weak reader');
  h.settle();await Promise.all([full,alsoFull,alsoWeak]);
  assert.equal(h.publications(),2);
});

test('healthy quiet maintenance uses 60 seconds while active reads and failures retain 15 seconds',async()=>{
  const h=harness(),first=h.cachedReadiness(false,{idle:true});
  await flush();h.settle();await first;
  for(let i=0;i<3;i++){h.advance(15000);h.cachedReadiness(false,{idle:true});await flush();}
  assert.equal(h.calls.length,1,'quiet lending-off or lending-on uses the same idle policy');
  h.advance(15000);h.cachedReadiness(false,{idle:true});await flush();
  assert.equal(h.calls.length,2);
  h.settle();await flush();
  h.setActive(true);
  h.advance(15000);h.cachedReadiness();await flush();
  assert.equal(h.calls.length,3,'a running job preserves fast freshness');
  h.reject();await flush();
  h.setActive(false);
  h.advance(14999);h.cachedReadiness(false,{idle:true});await flush();
  assert.equal(h.calls.length,3);
  h.advance(1);h.cachedReadiness(false,{idle:true});await flush();
  assert.equal(h.calls.length,4,'a failed observation never earns healthy idle freshness');
  h.settle();await flush();
});

test('fresh Docker observations satisfy maintenance age without re-observation or restamping',async()=>{
  const h=harness(),first=h.checkDocker();
  await flush();h.settle();await first;
  h.advance(20000);
  const read=h.cachedReadiness(false,{idle:true});
  await flush();
  assert.equal(h.calls.length,1);
  assert.equal(Date.parse((await read).observed_at),100000);
  await flush();
  h.advance(40000);h.cachedReadiness(false,{idle:true});await flush();
  assert.equal(h.calls.length,2,'age is measured from the real shared observation');
  h.settle();await flush();
});

test('idle override is separate and legacy cache overrides still apply',async()=>{
  const h=harness({readinessCacheMs:10,readinessIdleMs:40}),first=h.cachedReadiness(false,{idle:true});
  await flush();h.settle();await first;
  h.advance(10);h.cachedReadiness(false,{idle:true});await flush();
  assert.equal(h.calls.length,1,'separate idle override wins over legacy active override');
  h.setActive(true);
  h.cachedReadiness();await flush();assert.equal(h.calls.length,2);
  h.settle();await flush();
  const legacy=harness({readinessCacheMs:10}),start=legacy.cachedReadiness(false,{idle:true});
  await flush();legacy.settle();await start;await flush();
  legacy.advance(10);legacy.cachedReadiness(false,{idle:true});await flush();
  assert.equal(legacy.calls.length,2,'legacy override also controls idle when no idle override is supplied');
  legacy.settle();await flush();
});

test('shared UI cache never supplies per-job requirement/source evidence and clears after failure',async()=>{
  const h=harness(),reads=[h.checkDocker(),h.refreshReadiness({observation:true})];
  await flush();assert.equal(h.calls.length,1);
  h.reject();await Promise.all(reads);
  const full=h.checkDocker({force:true});await flush();
  assert.equal(h.calls.length,2,'failed probe must release ownership');
  h.settle();await full;
  const requirements={limits:{memory_mb:64},egress:'none'},source={kind:'git',url:'https://example.invalid/repo'};
  const jobs=[h.jobReadiness({requirements,source},'fixture'),h.jobReadiness({requirements,source},'fixture')];
  await flush();
  assert.equal(h.calls.length,4,'each job still probes independently');
  for(const call of h.calls.slice(2)){
    assert.equal(call.requirements,requirements);
    assert.equal(call.context.source,source);
    assert.deepEqual(call.context.providerHosts,['provider.invalid']);
    assert.notEqual(call.context.observation,true);
  }
  h.settle();h.settle();await Promise.all(jobs);
});
