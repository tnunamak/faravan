import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {fileSbx,receiptBackend} from './helpers/sandbox-receipt-fixture.mjs';
import {SBX_RUN_OPTIONS} from '../lib/docker-backend.mjs';

// HOST MUST RUN: real app, backend and cleanup journal; every command is a fake.
for(const refusalAt of ['create','preflight','timer'])test(`first automatic readiness records Docker sign-out at ${refusalAt} without cleanup debt`,{timeout:30000},async t=>{
  const f=await appFixture(t),home=await f.home('signed-out');
  for(const [key,value] of Object.entries({FARAVAN_SBX_HOME:process.env.HOME,FARAVAN_SCRATCH_ROOT:join(f.root,'scratch')})){
    const old=process.env[key];process.env[key]=value;mkdirSync(value,{recursive:true});
    t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
  }
  const sbx=fileSbx(join(f.root,'inventory'),{create:async()=>({code:1,stderr:'not signed in to docker',materialize:false})});
  let available=refusalAt!=='timer',listingFails=false,tick,at=Date.now();
  const run=async args=>{
    if(listingFails&&args[0]==='ls'&&args[1]==='--json')return {code:1,stdout:'',stderr:'fixture disconnected after restart'};
    if(!available&&args[0]==='ls'&&args[1]==='-q')return {code:1,stdout:'',stderr:'Docker login service unavailable: sign-in could not be refreshed'};
    if(args[0]==='version')return {code:0,stdout:'sbx version 0.51.0',stderr:''};
    if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy',stderr:''};
    if(args[0]==='run'&&args[1]==='--help')return {code:0,stdout:SBX_RUN_OPTIONS.join('\n'),stderr:''};
    if(refusalAt==='preflight'&&args[0]==='ls'&&args[1]==='-q')return {code:1,stdout:'',stderr:'not signed in to docker'};
    const result=await sbx.run(args);
    return args[0]==='create'?{...result,exited:true}:result;
  };
  const backend=receiptBackend(f.root,{run},{home,cleanupDirectory:join(home,'v1','sandbox-cleanup'),
    guestRuntime:async()=>({dir:'/fake/runtime',node:'/fake/runtime/node',sha256:'0'.repeat(64)}),
    monotonic:()=>at,autoRepair:false,storage:{available:async()=>false,supported:async()=>false,release:async()=>{}}});
  // Inject the host preflight transport too: constructor runCommand covers sandbox commands only.
  const preflightOptions={platformName:'darwin',realpathPath:()=>'/fake/keychains',runCommand:(_command,args)=>run(args)};
  for(const method of ['probeCapabilities','recoverHealth']){
    const original=backend[method].bind(backend);backend[method]=options=>original({...options,...preflightOptions});
  }
  const capabilities=backend.lenderCapabilities.bind(backend);
  let readings=0;
  backend.lenderCapabilities=async options=>{
    const report=await capabilities({...options,...preflightOptions});
    readings++;return report;
  };
  const {app}=await f.start('signed-out',{backend,freshLending:'automatic',clock:{now:()=>at},
    setInterval:callback=>{tick=callback;return {unref(){}};}});
  if(refusalAt==='timer'){
    await waitFor(async()=>(await api(app,'/api/readiness')).checks.some(c=>c.name==='docker_login'&&c.cause==='docker_signin_refresh_unavailable'),'startup saw temporary sign-in service failure');
    assert.equal(sbx.created().length,0);
    available=true;at=Date.now()+16000;tick(); // The installed periodic callback, no Check again.
  }
  await waitFor(()=>backend.signInRefused()&&!backend.signInConfirming(),'automatic refusal and confirmation cleanup',10000);
  assert.ok(readings>0);
  const status=await api(app,'/api/status');
  const publicStatus=await api(app,'/api/ops/status.blockers',{method:'POST',body:{}}); // Display read only; never Check again.
  assert.ok(status.blockers.some(row=>row.kind==='docker_signed_out'),JSON.stringify(status.blockers));
  const blocker=publicStatus.blockers.find(row=>row.kind==='docker_signed_out');
  assert.equal(blocker.fix.op,'signin.start');assert.deepEqual(blocker.fix.input,{target:'docker'});
  assert.equal(backend.signInRefused(),true,'refusal is durably recorded');
  assert.deepEqual(sbx.read(),[]);
  assert.equal(backend.cleanupStatus().compute_cleanup_pending,0);
  assert.equal(backend.cleanupStatus().state,'clear');
  const restarted=receiptBackend(f.root,{run},{home,cleanupDirectory:join(home,'v1','sandbox-cleanup')});
  assert.equal(restarted.signInRefused(),true,'a new backend reads the saved refusal');
  assert.equal(restarted.cleanupStatus().state,'clear','no cleanup debt survives restart');
  listingFails=true;
  assert.equal((await restarted.runSbx(['ls','--json'])).code,1);
  await restarted.recoverSandboxDeadlines();await restarted.reapCleanup();
  assert.equal(restarted.cleanupStatus().state,'clear','failed later inventory cannot revive a refused create');
  assert.equal(restarted.deadlineRecoveryHold(),null);
  assert.equal(status.blockers.some(row=>row.kind==='cleanup_pending'),false);
  assert.equal(status.intent.on,true,'automatic readiness keeps the lending intent');
  assert.equal(status.blockers.some(row=>row.kind==='cessation_unverified'),false);
  assert.notEqual(status.reason,'cessation_unverified');
  const lending=await api(app,'/api/lending');
  assert.notEqual(lending.reason,'cessation_unverified');
  assert.equal(lending.paused,false);
  const log=join(home,'v1','lending-errors.jsonl');
  if(existsSync(log))assert.doesNotMatch(readFileSync(log,'utf8'),/cessation_unverified/);
  if(refusalAt!=='preflight')assert.equal(sbx.created().length,1,'one automatic confirmation, no user action');
  else assert.equal(sbx.created().length,0,'preflight refusal needs no workspace');
  const count=sbx.created().length,before=readings;
  at=Date.now()+31*60000;tick();
  await waitFor(()=>readings>before,'periodic read after refusal');
  assert.equal(sbx.created().length,count,'a recorded refusal stops automatic attempts');
});

async function automaticFailureWorld(t,{pending=false,firstTimeout=false}={}) {
  const f=await appFixture(t),home=await f.home('automatic-failure');
  for(const [key,value] of Object.entries({FARAVAN_SBX_HOME:process.env.HOME,FARAVAN_SCRATCH_ROOT:join(f.root,'scratch')})){
    const old=process.env[key];process.env[key]=value;mkdirSync(value,{recursive:true});
    t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
  }
  let at=Date.now(),tick,completed=0,endedAt=at;
  const sbx=fileSbx(join(f.root,'inventory'),{create:async()=>({code:1,stderr:'fixture create failed',materialize:!pending})});
  const run=async args=>{
    if(args[0]==='version')return {code:0,stdout:'sbx version 0.51.0',stderr:''};
    if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy',stderr:''};
    if(args[0]==='run'&&args[1]==='--help')return {code:0,stdout:SBX_RUN_OPTIONS.join('\n'),stderr:''};
    const result=await sbx.run(args);
    return args[0]==='create'?{...result,exited:true}:result;
  };
  const backend=receiptBackend(f.root,{run},{home,cleanupDirectory:join(home,'v1','sandbox-cleanup'),
    guestRuntime:async()=>({dir:'/fake/runtime',node:'/fake/runtime/node',sha256:'0'.repeat(64)}),
    monotonic:()=>at,autoRepair:false,storage:{available:async()=>false,supported:async()=>false,release:async()=>{}}});
  const preflightOptions={platformName:'darwin',realpathPath:()=>'/fake/keychains',runCommand:(_command,args)=>run(args)};
  for(const method of ['probeCapabilities','recoverHealth','lenderCapabilities']){
    const original=backend[method].bind(backend);
    backend[method]=async options=>{
      const report=await original({...options,...preflightOptions});
      if(report.preflight)report.preflight.probed_at=new Date(at).toISOString();
      return report;
    };
  }
  const workspace=backend.testWorkspace.bind(backend);
  backend.testWorkspace=async options=>{
    // Time spent in the attempt must not count toward its retry interval.
    at+=5000;
    try{
      const result=await workspace(options);
      return firstTimeout&&completed===0?{...result,cause:'timeout'}:result;
    }finally{completed++;endedAt=at;}
  };
  const {app}=await f.start('automatic-failure',{backend,freshLending:'automatic',clock:{now:()=>at},readinessCacheMs:15000,
    signin:{startDocker:async()=>({status:'complete',waitForCompletion:async()=>({status:'complete'}),cancel(){}})},
    setInterval:callback=>{tick=callback;return {unref(){}};}});
  await waitFor(()=>completed===1&&!backend.signInConfirming(),'initial automatic failure');
  async function advanceTo(value){
    at=value;tick();
    await waitFor(async()=>{
      const report=await api(app,'/api/readiness');
      return report.observed_at===new Date(at).toISOString()&&!backend.signInConfirming();
    },'periodic readiness settled',10000);
  }
  return {app,backend,sbx,advanceTo,get endedAt(){return endedAt;},get completed(){return completed;}};
}

test('automatic Docker confirmation backs off from completion through twenty ticks and doubles to four hours',{timeout:60000},async t=>{
  const w=await automaticFailureWorld(t),minute=60000,firstEnd=w.endedAt;
  assert.equal(w.backend.cleanupStatus().state,'clear');
  for(let i=1;i<=20;i++){
    await w.advanceTo(firstEnd+i*minute/2);
    assert.equal(w.sbx.created().length,1,'no new automatic create on timer tick '+i);
  }
  assert.equal(w.sbx.created().length,1,'twenty timer ticks spanning ten minutes create only once');
  await w.advanceTo(firstEnd+30*minute-1);
  assert.equal(w.sbx.created().length,1,'the first delay is measured from completion');
  await w.advanceTo(firstEnd+30*minute+15000);
  assert.equal(w.sbx.created().length,2,'one retry after thirty minutes');
  for(const delay of [60,120,240,240]){
    const end=w.endedAt,count=w.sbx.created().length;
    await w.advanceTo(end+delay*minute-1);assert.equal(w.sbx.created().length,count);
    await w.advanceTo(end+delay*minute+15000);assert.equal(w.sbx.created().length,count+1);
  }
});

test('an automatic workspace timeout gets a bounded retry without a click',{timeout:30000},async t=>{
  const w=await automaticFailureWorld(t,{firstTimeout:true}),firstEnd=w.endedAt;
  assert.equal(w.backend.cleanupStatus().state,'clear');
  await w.advanceTo(firstEnd+59_999);
  assert.equal(w.sbx.created().length,1);
  const report=await api(w.app,'/api/readiness');
  assert.equal(report.checks.find(c=>c.name==='docker_login').checking,true,'the first timeout is still being checked');
  await w.advanceTo(firstEnd+75_000);
  assert.equal(w.sbx.created().length,2);
});

test('pending cleanup from an automatic confirmation prevents another attempt after backoff',{timeout:30000},async t=>{
  const w=await automaticFailureWorld(t,{pending:true});
  assert.equal(w.backend.cleanupStatus().compute_cleanup_pending,1);
  await w.advanceTo(w.endedAt+31*60000);
  assert.equal(w.sbx.created().length,1,'a pending prior create prevents another confirmation');
  assert.equal(w.backend.cleanupStatus().compute_cleanup_pending,1);
  await api(w.app,'/api/readiness?refresh=true');
  assert.equal(w.sbx.created().length,2,'an explicit check still bypasses the automatic cleanup gate');
});

test('Check again bypasses automatic backoff and resets it to thirty minutes',{timeout:30000},async t=>{
  const w=await automaticFailureWorld(t);
  await w.advanceTo(w.endedAt+31*60000);assert.equal(w.sbx.created().length,2);
  await api(w.app,'/api/readiness?refresh=true');
  assert.equal(w.sbx.created().length,3,'the explicit check runs during the sixty-minute delay');
  const manualEnd=w.endedAt;
  await w.advanceTo(manualEnd+29*60000);assert.equal(w.sbx.created().length,3);
  await w.advanceTo(manualEnd+31*60000);assert.equal(w.sbx.created().length,4,'manual check resets the delay');
});

test('Docker sign-in completion bypasses automatic backoff and resets it',{timeout:30000},async t=>{
  const w=await automaticFailureWorld(t);
  await w.advanceTo(w.endedAt+31*60000);assert.equal(w.sbx.created().length,2);
  await api(w.app,'/api/signin/docker',{method:'POST',body:{}});
  await waitFor(()=>w.completed===3&&!w.backend.signInConfirming(),'confirmation after Docker sign-in');
  assert.equal(w.sbx.created().length,3);
  const signedInEnd=w.endedAt;
  await w.advanceTo(signedInEnd+29*60000);assert.equal(w.sbx.created().length,3);
  await w.advanceTo(signedInEnd+31*60000);assert.equal(w.sbx.created().length,4);
});
