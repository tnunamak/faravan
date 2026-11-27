import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('real backend observes through the app timer without timed diagnose', {timeout:15000}, async t=>{
  const {DockerSbxBackend,SBX_RUN_OPTIONS}=await import('../lib/docker-backend.mjs');
  const f=await appFixture(t), backend=syntheticBackend(f.root),calls=[];
  let now=0;
  const native=new DockerSbxBackend({monotonic:()=>now,guestRuntime:async()=>({node:process.execPath}),hostDisk:{free:async()=>({free:20*1024**3})}});
  let version='0.51.0';
  const nativeOptions={platformName:'darwin',sbxHomePath:'/Users/a/.wfsbx',userHome:'/Users/a',
    realpathPath:()=>'/Users/a/Library/Keychains',runCommand:async (_command,args)=>{
      calls.push(args.join(' '));
      if(args[0]==='version')return {code:0,stdout:'sbx version '+version};
      if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy\nDocker authentication healthy'};
      if(args.join(' ')==='run --help')return {code:0,stdout:SBX_RUN_OPTIONS.join('\n')};
      if(args.join(' ')==='policy ls')return {code:0,stdout:'deny-all'};
      if(args.join(' ')==='ls -q')return {code:0,stdout:''};
      throw Error('unexpected command');
    }};
  const unknown=await native.protectionSummary({egress:'internet',limits:{}},{...nativeOptions,observation:true});
  assert.equal(unknown.satisfied,false,'observation with no diagnostics stays unknown');
  assert.equal(calls.filter(c=>c==='diagnose').length,0);
  backend.protectionSummary=(requirements,context)=>native.protectionSummary(requirements,{...nativeOptions,...context});
  const {app}=await f.start('native-observation',{backend,blockerRecheckMs:40,readinessCacheMs:40});
  const first=await api(app,'/api/readiness?refresh=true');
  const diagnosed=first.protection.diagnostics_observed_at;
  const diagnoses=calls.filter(c=>c==='diagnose').length;
  assert.ok(diagnoses>=1,'startup or manual check diagnoses');
  const policyReads=calls.filter(c=>c==='policy ls').length;
  now=60000;
  await sleep(200);
  assert.ok(calls.filter(c=>c==='policy ls').length>policyReads,'timer observed native state');
  assert.equal(calls.filter(c=>c==='diagnose').length,diagnoses,'timer never diagnoses');
  const cached=await api(app,'/api/readiness');
  assert.equal(cached.protection.diagnostics_observed_at,diagnosed,'observation preserves diagnostic time');
  await api(app,'/api/readiness?refresh=true');
  assert.equal(calls.filter(c=>c==='diagnose').length,diagnoses+1,'explicit refresh diagnoses afresh');
  version='0.51.1';
  // Replacing an executable invalidates its cached version/help. A fresh check also re-reads both.
  native._binaryReadKey=null;now+=60000;
  const changed=await native.protectionSummary({egress:'internet',limits:{}},{...nativeOptions,observation:true});
  assert.equal(changed.satisfied,false,'diagnostics from an older version do not establish readiness');
  assert.equal(calls.filter(c=>c==='diagnose').length,diagnoses+1);
});

test('an actual running job keeps observation polling without a visible window', {timeout:60000}, async t=>{
  const {waitFor,appFixture:jobFixture}=await import('./helpers/offers-jobs-fixture.mjs');
  const f=await jobFixture(t,{hold:true}),backend=syntheticBackend(f.root,{hold:true});
  let observations=0;const summary=backend.protectionSummary;
  backend.protectionSummary=async(...args)=>{if(args[1]?.observation)observations++;return summary(...args);};
  const {owner,lender,circle}=await f.connect({backend,blockerRecheckMs:40,readinessCacheMs:40});
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Polling fixture',harness:'codex'}});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card');
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  await waitFor(()=>backend.calls.some(([kind])=>kind==='run'),'running job');
  const before=observations;
  await sleep(220);
  assert.ok(observations>before,'running job polls with no window lease');
  assert.ok(observations-before<=8,'polling is bounded');
  backend.release();
});

test('Claude policy evidence uses the Docker readiness observation without another capability probe', {timeout:60000}, async t=>{
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  const {legacyProxyHarness}=await import('./helpers/legacy-proxy-harness.mjs');
  const f=await appFixture(t),synthetic=syntheticBackend(f.root);
  const backend=Object.assign(new DockerSbxBackend({guestRuntime:async()=>({node:process.execPath}),hostDisk:{free:async()=>({free:20*1024**3})}}),synthetic);
  let capabilityCalls=0,runs=0;
  backend.probeCapabilities=async()=>{capabilityCalls++;return {available:true,backend_id:'docker-sbx',version:'sbx version 0.51.0'};};
  backend.protectionSummary=async(...args)=>{
    const report=await synthetic.protectionSummary(...args);
    return {...report,backend_id:'docker-sbx',preflight:{...report.preflight,version:'sbx version 0.51.0'}};
  };
  const adapter=()=>[{spec:legacyProxyHarness('claude-code-subscription'),installed:true,signedIn:true,
    harnessVersion:'synthetic-only',models:['claude-haiku-5-5'],capabilities:[]}];
  const body={five_hour:{utilization:5,resets_at:new Date(Date.now()+5*3600000).toISOString()},
    seven_day:{utilization:10,resets_at:new Date(Date.now()+7*86400000).toISOString()},extra_usage:{is_enabled:false}};
  const runner=async()=>{runs++;return {exitCode:0,stdout:JSON.stringify({faravan_probe:1,status:200,body,
    identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'},
    guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
    executor:{backend_id:'docker-sbx',sbx_version:'sbx version 0.51.0'},stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};};
  const {lender,circle}=await f.connect({backend,adapters:adapter,lendingProbeRunner:runner,
    lendingExpectedIdentity:()=>({email_sha256_16:'aaaabbbbccccdddd'})});
  const ready=await api(lender.app,'/api/readiness?refresh=true');
  assert.equal(ready.protection.satisfied,true);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,idleOnly:false,lendingPolicy:{accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  assert.ok(runs>0,'real policy source consumed a synthetic provider reading');
  assert.equal(capabilityCalls,0,'policy evidence did not run another capability preflight');
});

test('ordinary Docker observations follow fresh daemon outage and recovery without diagnose', async()=>{
  const {DockerSbxBackend,SBX_RUN_OPTIONS}=await import('../lib/docker-backend.mjs');
  let now=0;
  const native=new DockerSbxBackend({monotonic:()=>now,guestRuntime:async()=>({node:process.execPath}),hostDisk:{free:async()=>({free:20*1024**3})}});
  const commands=[];let state='up';
  const options={platformName:'darwin',sbxHomePath:'/Users/a/.wfsbx',userHome:'/Users/a',realpathPath:()=>'/Users/a/Library/Keychains',
    runCommand:async(_command,args)=>{
      const cmd=args.join(' ');commands.push(cmd);
      if(cmd==='version')return {code:0,stdout:'sbx version 0.51.0'};
      if(cmd==='diagnose')return {code:0,stdout:'Daemon healthy\nDocker authentication healthy'};
      if(cmd==='run --help')return {code:0,stdout:SBX_RUN_OPTIONS.join('\n')};
      if(cmd==='policy ls')return {code:0,stdout:'deny-all'};
      if(cmd==='ls -q')return state==='up'?{code:0,stdout:''}:state==='down'?{code:1,stderr:'cannot connect to daemon: connection refused'}:{code:1,stderr:'unrecognized failure'};
      throw Error('unexpected command');
    }};
  const requirements={egress:'internet',limits:{}};
  assert.equal((await native.protectionSummary(requirements,options)).satisfied,true);
  const count=commands.filter(cmd=>cmd==='diagnose').length;
  state='down';
  const down=await native.protectionSummary(requirements,{...options,observation:true});
  assert.equal(down.preflight.checks.find(c=>c.name==='sbx_daemon').ok,false);
  assert.match(down.preflight.checks.find(c=>c.name==='sbx_daemon').diagnostics,/connection refused/);
  assert.equal(down.satisfied,false);
  state='unknown';
  now+=15000;
  assert.equal((await native.protectionSummary(requirements,{...options,observation:true})).satisfied,false,'unknown must not be ready');
  state='up';
  now+=15000;
  const recovered=await native.protectionSummary(requirements,{...options,observation:true});
  assert.equal(recovered.preflight.checks.find(c=>c.name==='sbx_daemon').ok,true);
  assert.equal(recovered.satisfied,true);
  assert.equal(commands.filter(cmd=>cmd==='diagnose').length,count,'observations never diagnose');
});
