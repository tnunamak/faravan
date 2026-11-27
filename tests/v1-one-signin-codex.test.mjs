import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
import {answerCurl,setScoped} from './helpers/scoped-answer.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';
import {createLentCodexCredential} from '../lib/v1/lent-claude-credential.mjs';
import {faravanSigninLine} from '../lib/v1/blockers.mjs';
const CODEX_UPDATE_SIGNIN_LINE=faravanSigninLine('codex');

const ACCESS='eyJ-codex-access-'+'a'.repeat(64),REFRESH='rt-codex-refresh-'+'r'.repeat(64);
const HOUR=3600e3;
const testOptions={timeout:90000};

// A store that holds Faravan's Codex sign-in (or none), and a refresher that rotates it when asked.
function fakeStore({signedIn=true,expiresAt=Date.now()+8*HOUR}={}){
  const state={signedIn,expiresAt,reads:0,refreshes:0,refreshOk:true,newExpiry:Date.now()+8*HOUR};
  const store={
    async credential(key){
      state.reads++;assert.equal(key,'codex');
      if(!state.signedIn)throw Object.assign(new Error('x'),{code:'usage_credential_unavailable',reason:'not_signed_in'});
      return {accountKey:key,provider:'codex',kind:'oauth',generation:'g'+state.refreshes,digest:'d'+state.refreshes,bearer:ACCESS,refresh:REFRESH,expiresAt:state.expiresAt};
    },
  };
  const refresher={async refresh(key,{force}={}){
    assert.equal(key,'codex');assert.equal(force,true);state.refreshes++;
    if(!state.refreshOk)return {ok:false,reason:'refresh_unavailable'};
    state.expiresAt=state.newExpiry;return {ok:true,refreshed:true};
  }};
  return {state,store,refresher};
}

test('a lease hands over the access token only, and does not refresh a token that outlives the job',async()=>{
  const {state,store,refresher}=fakeStore();
  const lease=await createLentCodexCredential({store,refresher}).lease({wallSeconds:1200});
  assert.equal(lease.value,ACCESS);
  assert.equal(JSON.stringify(lease).includes(REFRESH),false,'the refresh token never leaves the store');
  assert.equal(state.refreshes,0);
});

test('a token that expires before the job ends is refreshed first, then leased',async()=>{
  const {state,store,refresher}=fakeStore({expiresAt:Date.now()+5*60e3});
  const lease=await createLentCodexCredential({store,refresher}).lease({wallSeconds:1800});
  assert.equal(state.refreshes,1);
  assert.ok(lease.expiresAt>=Date.now()+1800e3,'the leased token outlives the job');
  assert.equal(lease.generation,'g1','the lease reads the refreshed generation');
});

test('a failed refresh, or a fresh token that is still too short, refuses the lease and reports a fault',async()=>{
  for(const mode of ['refresh_fails','still_short']){
    const {state,store,refresher}=fakeStore({expiresAt:Date.now()+60e3});
    if(mode==='refresh_fails')state.refreshOk=false;else state.newExpiry=Date.now()+10*60e3;
    const outcomes=[];
    await assert.rejects(createLentCodexCredential({store,refresher,onOutcome:code=>outcomes.push(code)}).lease({wallSeconds:3600}),
      error=>error.code==='claude_account_unavailable'&&!String(error.message).includes(ACCESS));
    assert.deepEqual(outcomes,['claude_account_unavailable'],mode);
  }
});

test('an empty store refuses the lease as signed out',async()=>{
  const {store,refresher}=fakeStore({signedIn:false});
  await assert.rejects(createLentCodexCredential({store,refresher}).lease({wallSeconds:60}),error=>error.code==='agent_signed_out');
});

// ---- the production prepare, against a fake sbx ------------------------------------------------------------------
test('a lent Codex job gets the access token in its own sandbox; a failed push or lease starts nothing',async t=>{
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  const {createSbxPolicy,sbxRunner}=await import('./helpers/sbx-policy-model.mjs');
  const {seedSandboxOwner}=await import('./helpers/sandbox-owner.mjs');
  const home=await mkdtemp(join(tmpdir(),'faravan-onesignin-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const old={bin:process.env.FARAVAN_SBX_BIN,home:process.env.FARAVAN_SBX_HOME,root:process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_BIN=process.execPath;process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;seedSandboxOwner();
  t.after(()=>{for(const [k,v] of [['FARAVAN_SBX_BIN',old.bin],['FARAVAN_SBX_HOME',old.home],['FARAVAN_SCRATCH_ROOT',old.root]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const calls=[],secrets=[],policy=createSbxPolicy({globalRules:[]});let globalLogin=false,failSet=false,dropRow=false;
  const listing=()=>JSON.stringify({secrets:secrets.map(({token,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0});
  const runner=sbxRunner(policy,async(args,options)=>{
    calls.push({args,input:options?.input});
    if(args[0]==='secret'&&args[1]==='ls')return {code:0,stdout:listing()};
    if(args[0]==='version')return {code:0,stdout:'test-version'};
    if(args[0]==='secret'&&args[1]==='set'){
      if(failSet)return {code:1,stdout:'',stderr:''};
      if(!dropRow)setScoped(secrets,args,options.input);
    }
    const answered=answerCurl(args,secrets,{real:ACCESS,globalLogin});if(answered)return answered;
    if(args[0]==='rm'){const name=args.at(-1);for(let n=secrets.length-1;n>=0;n--)if(secrets[n].scope===name)secrets.splice(n,1);}
    return {code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''};
  },{kitAllow:[],secretResult:{code:0,get stdout(){return listing();}}});
  const backend=new DockerSbxBackend({home,runCommand:(args,options)=>{options?.beforeSpawn?.();return runner.run(args,options);}});
  const leases=[],leaseReports=[],reports=[];let leaseError=null,leased=ACCESS;
  backend.setLentCodexCredential({
    async lease({wallSeconds,report=true}){leases.push(wallSeconds);leaseReports.push(report);if(leaseError)throw leaseError;return {value:leased,generation:'g1',digest:'d1',lifetimeSeconds:28000};},
    report:code=>reports.push(code)});
  const job={job_id:'test-lent',image:'codex',entrypoint:'true',execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
    resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:16384,network_bytes:1048576,max_processes:32},inputs:[],output_manifest:[],
    egress:'provider-only',provider_hosts:['chatgpt.com'],required_limits:['cpu','memory','wall','output']};

  const handle=await backend.prepare(job);
  assert.deepEqual(leases,[60],"the lease is asked for the job's own run time");
  const set=calls.find(c=>c.args[0]==='secret'&&c.args[1]==='set');
  assert.deepEqual(set.args.slice(0,2),['secret','set']);assert.equal(set.args[2],'openai','the built-in openai service carries it');
  assert.equal(set.args[set.args.indexOf('--sandbox')+1],handle.sandbox_id,'the value is scoped to this sandbox');
  assert.equal(set.input,ACCESS);
  assert.equal(calls.some(c=>c.args[0]==='create'&&c.args.includes('--kit')&&c.args.some(a=>/codex-account|faravan-codex/.test(a))),false,'no custom kit');
  assert.equal(JSON.stringify(calls).includes('CODEX_ACCESS_TOKEN'),false);
  assert.equal(JSON.stringify(calls.map(c=>c.args)).includes(ACCESS),false,'the value goes on stdin, never argv');
  assert.equal(JSON.stringify(calls).includes(REFRESH),false);
  assert.deepEqual(reports,[null],'a good push clears any earlier fault');
  // The scoped value is proven before any job command: a control value is refused, then the real one is accepted.
  const probes=calls.filter(c=>c.args[0]==='exec'&&c.args.includes('curl'));
  assert.equal(probes.length,2,'two probes ask the provider route');
  assert.equal(handle._execution.scoped_check,'account_200_control_401');
  assert.equal(handle._execution.token_lifetime_seconds,28000,'the receipt records the token life left at admission');
  assert.equal(JSON.stringify(handle._execution).includes(ACCESS),false);
  await backend.destroy(handle);assert.equal(secrets.length,0);

  // The computer's old global login answers both values: the scoped value is not what answers, so nothing starts.
  const refusals=async(label)=>{
    reports.length=0;const start=calls.length;
    await assert.rejects(backend.prepare(job),error=>error.code==='claude_account_unavailable',label);
    assert.equal(reports.at(-1),'claude_account_unavailable',label);
    assert.equal(calls.slice(start).some(c=>c.args[0]==='exec'&&!c.args.includes('curl')&&!c.args.includes('true')),false,label+': no job command ran');
    await backend.reapCleanup().catch(()=>{});assert.equal(secrets.length,0,label+': the scoped value is removed');
  };
  globalLogin=true;await refusals('global login answers');globalLogin=false;
  leased='not-the-real-value';await refusals('real value refused');leased=ACCESS;

  // An owner's own job never takes the lent path. It only asks the one holder to renew the sign-in, without a lending report.
  const ownerStart=calls.length;leases.length=0;leaseReports.length=0;
  const ownerHandle=await backend.prepare({...job,execution_scope:'owner',auth_strategy:'provider-file-generation'}).catch(()=>null);
  assert.deepEqual(leases,[60]);assert.deepEqual(leaseReports,[false]);assert.equal(calls.slice(ownerStart).some(c=>c.args[0]==='secret'&&c.args[1]==='set'&&c.args[2]==='openai'),false);
  if(ownerHandle)await backend.destroy(ownerHandle);

  // A push that fails: no guest command runs, the fault is reported, and nothing falls back to another sign-in.
  failSet=true;reports.length=0;const before=calls.length;
  await assert.rejects(backend.prepare(job));
  assert.equal(calls.slice(before).some(c=>c.args[0]==='exec'),false);
  assert.equal(reports.length,1);assert.notEqual(reports[0],null);
  failSet=false;await backend.reapCleanup().catch(()=>{});

  // The scoped row is not listed after the set: the computer's global login would answer, so nothing starts.
  dropRow=true;reports.length=0;const beforeDrop=calls.length;
  await assert.rejects(backend.prepare(job),error=>error.code==='claude_account_unavailable');
  assert.equal(calls.slice(beforeDrop).some(c=>c.args[0]==='exec'),false);
  assert.equal(reports.length,1);assert.notEqual(reports[0],null);
  dropRow=false;await backend.reapCleanup().catch(()=>{});

  // A lease that is refused (store empty or token too short): no sandbox is created at all.
  leaseError=Object.assign(new Error('x'),{code:'claude_account_unavailable'});
  const leaseStart=calls.length;
  await assert.rejects(backend.prepare(job),error=>error.code==='claude_account_unavailable'&&error.cleanup_receipt?.removed===true);
  assert.equal(calls.slice(leaseStart).some(c=>c.args[0]==='create'),false);
  leaseError=Object.assign(new Error('x'),{code:'agent_signed_out'});
  await assert.rejects(backend.prepare(job),error=>error.code==='agent_signed_out');
});

// ---- the app: an upgrade from .73, and a fresh install -------------------------------------------------------------
const claudeId='codex';
const claudeAdapter=()=>({...HARNESS_ADAPTERS.find(a=>a.spec.harness_id===claudeId),installed:true,signedIn:true,models:['example-model']});
function fakeFlow(onComplete){
  let finish;const done=new Promise(resolve=>{finish=resolve;});
  return {url:'https://login.example.test/device',code:'ABCD-1234',status:'awaiting-browser',acceptsCode:false,
    waitForCompletion:async()=>{const r=await done;if(r.status==='complete')onComplete();return r;},cancel(){finish({status:'failed'});},complete:()=>finish({status:'complete'})};
}
async function startClaudeApp(t,{store,signin}){
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const {app}=await f.start('owner',{backend,adapters:[claudeAdapter()],lendingUsageStore:store,
    // The .73 sign-in: the Docker credential proxy still holds a Claude login. It must not count as Faravan's sign-in.
    lendingSignInProbe:async()=>({signedIn:true,secretPresent:true}),
    lendingIdentityProbe:async({harnessNames})=>({providers:harnessNames.map(id=>({harness_id:id,installed:true,signedIn:true}))}),
    identityProbe:async({harnessNames})=>({providers:harnessNames.map(id=>({harness_id:id,installed:true,signedIn:true}))}),
    signin});
  return {app,backend};
}
const viewOf=async app=>(await api(app,'/api/agents')).find(a=>a.id===claudeId);
const refresh=app=>api(app,'/api/agents/refresh',{method:'POST',body:{agents:[claudeId]}});

test('upgrade from .73: lent Codex with an empty Faravan store shows one blocker, not Signed in; one sign-in fixes it',testOptions,async t=>{
  const fs=fakeStore({signedIn:true});
  const flows=[];
  const {app}=await startClaudeApp(t,{store:fs.store,signin:{startProvider:async spec=>{
    flows.push(spec);const flow=fakeFlow(()=>{fs.state.signedIn=true;});flow.complete();return flow;
  }}});
  await refresh(app);
  await api(app,'/api/agents/'+claudeId+'-lending',{method:'POST',body:{useForLending:true}});
  assert.equal((await viewOf(app)).useForLending,true);
  // The computer becomes a .73-shaped home: the proxy is signed in, the Faravan store is empty.
  fs.state.signedIn=false;await refresh(app);
  const row=await viewOf(app);
  assert.equal(row.signedIn,false);assert.notEqual(row.signInState,'Signed in');
  assert.equal(row.proxySignedIn,false);assert.equal(row.useForLending,true,'the lending choice is kept');
  assert.equal(row.remedy,CODEX_UPDATE_SIGNIN_LINE);
  assert.equal(row.lendingSignInTarget,claudeId,"the button targets Faravan's own sign-in");
  const model=(await api(app,'/api/status')).lending_blockers;
  const items=model.items.filter(i=>i.agent===claudeId);
  assert.equal(items.length,1);
  assert.equal(items[0].status,'blocked');assert.equal(items[0].detail,CODEX_UPDATE_SIGNIN_LINE);assert.equal(items[0].action,'Sign in');
  assert.equal(model.canLend,false,'Automatic is held while the store is empty');

  // The one sign-in: Faravan's own (a provider-file-generation flow), through the plain target.
  const started=await api(app,'/api/signin/'+claudeId,{method:'POST',body:{}});
  assert.equal(started.status,'awaiting_browser');
  assert.equal(flows.at(-1).auth_strategy,'provider-file-generation');
  await waitFor(async()=>(await viewOf(app)).signedIn===true,'the sign-in publishes a generation and the row reads signed in');
  const after=await viewOf(app);
  assert.equal(after.proxySignedIn,true);assert.equal(after.signInState,'Signed in');
  const items2=(await api(app,'/api/status')).lending_blockers.items.filter(i=>i.agent===claudeId);
  assert.equal(items2.length,1);assert.equal(items2[0].status,'ok');
});

test('a plain sign-in for Codex is Faravan\'s own, never the Docker proxy login, from Setup or the blocker',testOptions,async t=>{
  const fs=fakeStore({signedIn:false});
  const specs=[];
  const {app}=await startClaudeApp(t,{store:fs.store,signin:{startProvider:async spec=>{specs.push(spec);return fakeFlow(()=>{})}}});
  for(const target of [claudeId,claudeId+'-lending']){
    const flow=await api(app,'/api/signin/'+target,{method:'POST',body:{}});
    assert.equal(flow.status,'awaiting_browser',target);
    await api(app,'/api/signin/'+flow.flowId,{method:'DELETE'}).catch(()=>{});
  }
  assert.ok(specs.length>=1);
  for(const spec of specs){assert.equal(spec.auth_strategy,'provider-file-generation');assert.equal(spec.credential_in_guest,true);}
});

test('fresh install: one Faravan sign-in makes Codex signed in for lending and for the allowance reading',testOptions,async t=>{
  const fs=fakeStore({signedIn:false});
  const {app}=await startClaudeApp(t,{store:fs.store,signin:{startProvider:async()=>{const flow=fakeFlow(()=>{fs.state.signedIn=true;});flow.complete();return flow;}}});
  await refresh(app);
  assert.equal((await viewOf(app)).signedIn,false);
  await api(app,'/api/signin/'+claudeId,{method:'POST',body:{}});
  await waitFor(async()=>(await viewOf(app)).signedIn===true,'signed in after the one sign-in');
  // The same store entry answers both: the lending row and the reading's credential lookup.
  const reads=fs.state.reads;
  assert.equal((await api(app,'/api/agents/'+claudeId+'-lending',{method:'POST',body:{useForLending:true}})).find(a=>a.id===claudeId).useForLending,true);
  assert.ok(fs.state.reads>=reads,'lending was chosen from the store, not the proxy');
  assert.equal(await fs.store.credential('codex').then(c=>c.bearer),ACCESS);
});

test('the app gives the backend the same store, and a failed hand-off shows one blocker that a sign-in clears',testOptions,async t=>{
  const fs=fakeStore({signedIn:true});
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  let provider=null;backend.setLentCodexCredential=p=>{provider=p;};
  const {app}=await f.start('owner',{backend,adapters:[claudeAdapter()],lendingUsageStore:fs.store,
    lendingSignInProbe:async()=>({signedIn:false}),
    lendingIdentityProbe:async({harnessNames})=>({providers:harnessNames.map(id=>({harness_id:id,installed:true,signedIn:false}))}),
    identityProbe:async({harnessNames})=>({providers:harnessNames.map(id=>({harness_id:id,installed:true,signedIn:true}))}),
    signin:{startProvider:async()=>{const flow=fakeFlow(()=>{});flow.complete();return flow;}}});
  await waitFor(()=>provider!==null,'the lending wiring installs the lease');
  await refresh(app);
  await api(app,'/api/agents/'+claudeId+'-lending',{method:'POST',body:{useForLending:true}});
  assert.equal((await viewOf(app)).signedIn,true,'the Docker proxy is signed out, and Faravan\'s sign-in is what counts');
  const lease=await provider.lease({wallSeconds:600});
  assert.equal(lease.value,ACCESS);
  const blockerFor=async()=>(await api(app,'/api/status')).lending_blockers.items.filter(i=>i.agent===claudeId);
  assert.equal((await blockerFor())[0].status,'ok');
  provider.report('claude_account_unavailable');
  await waitFor(async()=>(await blockerFor())[0].status==='blocked','a failed hand-off blocks');
  const [item]=await blockerFor();
  assert.equal(item.action,'Sign in');assert.match(item.detail,/Sign in to Codex again/);
  provider.report(null);
  await waitFor(async()=>(await blockerFor())[0].status==='ok','a good hand-off clears it');
});
