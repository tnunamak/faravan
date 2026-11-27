import {enableFixtureModel} from '../helpers/account-model-fixture.mjs';
import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createLendingLedger,createLendingLaunch} from '../../lib/v1/lending-launch.mjs';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {createHostProviderRegistry,loadHostProviders} from '../../lib/v1/providers/host-registry.mjs';
import {createAccountStore} from '../../lib/v1/accounts.mjs';
import {createAccountBroker} from '../../lib/v1/account-broker.mjs';
import {createAccountTransport,serveAccountProxy} from '../../lib/v1/account-transport.mjs';
import {createAccountsApi} from '../../lib/v1/accounts-http.mjs';
import {resolveSelection} from '../../lib/v1/run-request.mjs';
import {getHarnessAdapter,resolveHarness} from '../../lib/harnesses/index.mjs';
import {createImageArgs,loadImagePins} from '../../lib/sbx-image-pins.mjs';
import {spawn} from 'node:child_process';
import {attachGuestBrokerTunnel,accountProxyRequestListener,GUEST_RELAY_SOURCE} from '../../lib/v1/guest-broker-tunnel.mjs';
import {appFixture,api} from '../helpers/v1-app-fixture.mjs';

// Owned, synthetic fixtures only: no provider credential, network or CLI file is read.
const piData={descriptor:{schemaVersion:1,id:'pi',label:'Self-hosted pi',signInKind:'local_harness',refreshKind:'none',
  usageKind:'none',maxConcurrentJobs:1,nativeUnits:[],
  models:[{id:'local-small',label:'Local small',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'},
    {id:'local-large',label:'Local large',enabled:true,rank:1,pareto:null,efforts:[],defaultEffort:null}],
  destinations:[{origin:'http://127.0.0.1:43123',pathPrefixes:['/v1'],methods:['POST']}]},
  identity:'pi-host-subject',command:'pi',args:['--print'],modelFlag:'--model',effortFlag:'--thinking',
  keyEnv:'PI_API_KEY',baseUrlEnv:'PI_BASE_URL'};

test('production initialization registers configured pi data next to native subscriptions',async t=>{
  const f=await appFixture(t);const home=await f.home('pi-app');
  await mkdir(join(home,'v1'),{recursive:true});
  await writeFile(join(home,'v1','account-providers.json'),JSON.stringify([piData]));
  const {app}=await f.start('pi-app',{home});
  const listed=await api(app,'/api/accounts');
  assert.deepEqual(listed.providers.map(p=>p.id).sort(),['claude','codex','pi']);
  const pi=listed.providers.find(p=>p.id==='pi');
  assert.deepEqual(pi.models.map(m=>m.id),['local-small','local-large']);
  // A local harness has no secret to type: one enrollment, and it is signed in.
  const flow=await api(app,'/api/accounts',{method:'POST',body:{providerId:'pi',label:'pi',operationId:'enroll-pi'}});
  const done=await api(app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{}});
  assert.equal(done.ok,true,JSON.stringify(done));
  assert.equal(done.value.authState,'signed_in');
});

test('a data entry that tries to smuggle a credential or a remote destination for pi is refused',()=>{
  const attempt=change=>()=>createHostProviderRegistry({configurations:[{...piData,...change}],proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:{}});
  assert.throws(attempt({identity:''}),/invalid_provider_configuration/);
  assert.throws(attempt({command:''}),/invalid_provider_configuration/);
  assert.throws(attempt({keyEnv:'lower'}),/invalid_provider_configuration/);
  assert.throws(attempt({descriptor:{...piData.descriptor,destinations:[{origin:'https://remote.invalid',pathPrefixes:['/v1'],methods:['POST']}]}}),/invalid_provider_configuration/);
  assert.equal(createHostProviderRegistry({configurations:[piData],proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:{}}).getProvider('pi').ok,true);
});

test('pi run spec carries model, effort, only the job key and the guest broker origin',()=>{
  const registry=createHostProviderRegistry({configurations:[piData],proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:{}});
  const adapter=registry.getProvider('pi').value,selection={accountId:'a',providerId:'pi',modelId:'local-small',effortId:'high'};
  const amount={unit:'tokens',value:1},receipt={schemaVersion:1},enforcement={amount};
  const run=adapter.makeRun({selection,jobKey:'GUEST_KEY',job:{selection,promptText:'prompt'},receipt,enforcement});
  assert.equal(run.ok,true,JSON.stringify(run));
  assert.deepEqual(run.value.args,['--print','--model','local-small','--thinking','high','prompt']);
  assert.deepEqual(run.value.env,{PI_API_KEY:'GUEST_KEY',PI_BASE_URL:'https://broker.invalid/api/account-proxy/pi'});
  assert.deepEqual(run.value.proxy,{providerId:'pi',origin:'https://broker.invalid'});
  assert.equal(adapter.makeRun({selection:{...selection,modelId:'local-large',effortId:'high'},jobKey:'k',job:{selection,promptText:'p'},receipt,enforcement}).ok,false);
  assert.equal(adapter.makeRun({selection:{...selection,modelId:'unlisted'},jobKey:'k',job:{selection,promptText:'p'},receipt,enforcement}).ok,false);
  assert.equal(loadHostProviders('/nonexistent/account-providers.json').length,0);
});

test('pi records the served model only from a finished OpenAI-compatible reply naming one model',()=>{
  const adapter=createHostProviderRegistry({configurations:[piData],proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:{}}).getProvider('pi').value;
  const chunk=(model,finish=null)=>'data: '+JSON.stringify({object:'chat.completion.chunk',model,choices:[{index:0,delta:{content:'x'},finish_reason:finish}]})+'\n\n';
  const sse=(...frames)=>({contentType:'text/event-stream',body:frames.join('')});
  assert.deepEqual(adapter.parseExecutionResponse(sse(chunk('local-small'),chunk('local-small','stop'),'data: [DONE]\n\n')),{model:'local-small'});
  assert.deepEqual(adapter.parseExecutionResponse({contentType:'application/json; charset=utf-8',
    body:JSON.stringify({object:'chat.completion',model:'local-small',choices:[{finish_reason:'stop'}]})}),{model:'local-small'});
  for(const bad of [sse(chunk('local-small'),'data: [DONE]\n\n'),sse(chunk('local-small','stop')),
    sse(chunk('local-small'),chunk('local-large','stop'),'data: [DONE]\n\n'),sse('data: {"object":"other"}\n\n','data: [DONE]\n\n'),
    {contentType:'text/plain',body:'x'},{contentType:'application/json',body:'not json'}])
    assert.equal(adapter.parseExecutionResponse(bad),null);
});

test('host configuration selects the pi harness and its guest image; the guest holds no provider credential',()=>{
  const registry=createHostProviderRegistry({configurations:[{...piData,harnessId:'pi'}],proxyOrigin:()=> 'https://broker.invalid',nativeDrivers:{}});
  const adapter=registry.getProvider('pi').value;
  assert.equal(adapter.harnessId,'pi');
  const harness=getHarnessAdapter(adapter.harnessId);
  assert.ok(harness,'pi is a registered harness');
  assert.equal(resolveHarness('pi').image,'wf-pi');
  // The spec says the only guest secret is the per-job key, and nothing opens a provider route.
  assert.equal(harness.spec.auth_strategy,'guest-env-api-key');
  assert.deepEqual(harness.spec.provider_domains,['account-broker.invalid']);
  assert.equal(harness.spec.egress_provider_hosts,undefined);
  // Run env: exactly the job key and the broker endpoint, with model and effort in the command.
  const selection={accountId:'a',providerId:'pi',modelId:'local-small',effortId:'high'};
  const run=adapter.makeRun({selection,jobKey:'GUEST_KEY',job:{selection,promptText:'prompt'},receipt:{schemaVersion:1},enforcement:{amount:{unit:'tokens',value:1}}}).value;
  assert.deepEqual(Object.keys(run.env).sort(),['PI_API_KEY','PI_BASE_URL']);
  assert.equal(run.env.PI_API_KEY,'GUEST_KEY');
  assert.equal(run.args.at(run.args.indexOf('--model')+1),'local-small');
  assert.equal(run.args.at(run.args.indexOf('--thinking')+1),'high');
  assert.doesNotMatch(JSON.stringify(run),/ACCESS_|REFRESH_|sk-/);
  // The guest is a local kit that pins its own base by digest: creation names the kit, never a floating tag.
  assert.deepEqual(createImageArgs('wf-pi',loadImagePins()),{flags:[],positional:'wf-pi'});
});

// ---- Real HTTP guest -> production proxy -> broker -> host-held OAuth, two same-provider accounts, restart ----

function nativeWorld(){
  let time=Date.now(),logins=0,refreshes=0;const upstream=[],usageReads=[];
  const drivers=Object.fromEntries(['claude','codex'].map(id=>[id,{getModels:()=>[{id:'native-model',name:'Native',reasoning:true}],
    auth:{oauth:{async login(interaction){logins++;interaction.notify({type:'auth_url',url:'https://controlled.invalid/'+id});
      const answer=await interaction.prompt({type:'manual_code',message:'Owned login'});
      return {type:'oauth',access:'ACCESS_'+answer,refresh:'REFRESH_'+answer,expires:time+600000,accountId:'subject-'+answer};},
    async refresh(c){refreshes++;return {...c,access:c.access+'_R',expires:time+600000};}}}}]));
  const send=async(url,options)=>{
    if(url.endsWith('/usage')){usageReads.push(url);
      return Response.json(url.includes('anthropic')?{extra_usage:{is_enabled:false},seven_day:{utilization:12,resets_at:new Date(time+86400000).toISOString()}}
        :{plan_type:'pro',rate_limit:{allowed:true,limit_reached:false,secondary_window:{limit_window_seconds:604800,used_percent:14,reset_at:Math.floor((time+86400000)/1000)}}});}
    if(options.method==='GET')return Response.json({account:{uuid:'subject-'+options.headers.authorization.replace('Bearer ACCESS_','').replace('_R','')}});
    upstream.push({url,authorization:options.headers.authorization,body:JSON.parse(Buffer.from(options.body).toString())});
    return Response.json({id:'resp',model:'native-model'});
  };
  return {drivers,send,upstream,usageReads,now:()=>time,advance:ms=>{time+=ms;},logins:()=>logins,refreshes:()=>refreshes};
}
async function productionStack(t,directory,world,{proxyOrigin}={}){
  let origin;
  const providers=createHostProviderRegistry({proxyOrigin:()=>proxyOrigin?.()??origin,nativeDrivers:world.drivers,fetch:world.send,clock:world.now,configurations:[]});
  const store=createAccountStore({directory});
  const broker=createAccountBroker({store,providers,clock:world.now,proxy:createAccountTransport({fetch:world.send}),
    authority:{verify:async()=>({ok:true,value:{expiresAtMs:world.now()+60000,fence:1}})}});
  t.after(()=>broker.close());
  const server=createServer((req,res)=>{
    const m=/^\/api\/account-proxy\/([^/]+)/.exec(req.url);
    if(!m){res.writeHead(404);return res.end();}
    serveAccountProxy({req,res,providerId:m[1],providers,broker}).catch(()=>{res.writeHead(500);res.end();});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {providers,store,broker,origin,api:createAccountsApi({broker,store,providers})};
}
async function enroll(stack,providerId,answer,{lend=false}={}){
  const flow=await stack.api.handle({method:'POST',parts:['api','accounts'],input:{providerId,label:answer,operationId:'enroll-'+providerId+answer}});
  const account=(await stack.api.handle({method:'POST',parts:['api','accounts','flows',flow.body.value.flowId,'complete'],input:{answer}})).body.value;
  if(lend)await enableFixtureModel(stack.store,account.id,'native-model');
  return account;
}
test('lender filters persist and fence a prepared selection before start', async t=>{
  const world=nativeWorld(), directory=await mkdtemp(join(tmpdir(),'faravan-model-filters-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const getModels=world.drivers.codex.getModels.bind(world.drivers.codex);
  world.drivers.codex.getModels=()=>getModels().flatMap(model=>[model,{...model,id:'second-live-model'}]);
  let stack=await productionStack(t,directory,world);
  const a=await enroll(stack,'codex','first'), b=await enroll(stack,'codex','second');
  const named={providerId:'codex',modelId:'native-model'};
  const choose=(models,effortId)=>resolveSelection({runRequest:{schemaVersion:1,models,effortId},accounts:stack.api.advertise()});
  const change=async (account,settings)=>{
    const {revision}=await stack.api.snapshot();
    const response=await stack.api.handle({method:'POST',parts:['api','accounts',account.id,'settings'],
      input:{expectedRevision:revision,...settings}});
    assert.equal(response.status,200,JSON.stringify(response.body));
  };
  const model=(modelId,enabled,effortIds=null)=>({modelPreference:{modelId,enabled,effortIds}});
  assert.deepEqual(stack.api.advertise(),[]);
  await change(a,model('native-model',true,['low']));
  await change(b,model('native-model',true,['high']));
  assert.equal(choose([named],'high').value.accountId,b.id);
  assert.equal(choose('any',null).value.accountId,a.id);
  await change(a,model('second-live-model',true));
  await change(a,{modelOrder:['second-live-model','native-model']});
  assert.equal(choose('any',null).value.modelId,'second-live-model');
  await stack.broker.close();
  stack=await productionStack(t,directory,world);
  assert.equal(choose('any',null).value.modelId,'second-live-model');
  const selection=choose([named],'high').value;
  const leaseProof={schemaVersion:1,signedEnvelope:'{}'};
  const key=await stack.broker.issueJobKey({selection,jobId:'model-policy',attemptId:'model-policy-attempt',leaseProof});
  assert.equal(key.ok,true,JSON.stringify(key));
  await change(b,{paretoOnly:true});
  assert.equal(choose([named],'high').code,'effort_unavailable');
  const start=await stack.broker.renewJobKey({keyId:key.value.keyId,leaseProof,forStart:true});
  assert.equal(start.error.code,'model_unavailable');
  assert.equal((await stack.api.snapshot()).accounts.find(row=>row.id===b.id).paretoOnly,true);
  const {revision}=await stack.api.snapshot();
  const invalid=await stack.api.handle({method:'POST',parts:['api','accounts',a.id,'settings'],
    input:{expectedRevision:revision,modelOrder:['native-model'],modelPreference:{modelId:'native-model',enabled:true,effortIds:['removed-effort']}}});
  assert.equal(invalid.status,400);
  assert.equal(choose('any',null).value.modelId,'second-live-model','invalid write leaves ordering intact');
});


for(const changeKind of ['model-off','effort-off','unchanged'])test(
  'composed account settings fence the last dispatch boundary: '+changeKind,{timeout:30000},async t=>{
  const world=nativeWorld(),directory=await mkdtemp(join(tmpdir(),'faravan-dispatch-settings-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const stack=await productionStack(t,join(directory,'accounts'),world);
  const account=await enroll(stack,'codex','dispatch');
  const change=async preference=>{
    const before=await stack.api.snapshot();
    const response=await stack.api.handle({method:'POST',parts:['api','accounts',account.id,'settings'],
      input:{expectedRevision:before.revision,modelPreference:preference}});
    assert.equal(response.status,200);
    assert.equal(response.body.ok,true);
    assert.equal((await stack.api.snapshot()).revision,before.revision+1);
  };
  await change({modelId:'native-model',enabled:true,effortIds:['low','high']});
  const selection=resolveSelection({runRequest:{schemaVersion:1,
    models:[{providerId:'codex',modelId:'native-model'}],effortId:'high'},accounts:stack.api.advertise()}).value;
  assert.deepEqual(selection,{providerId:'codex',accountId:account.id,modelId:'native-model',effortId:'high'});
  // Same production mapping as app.mjs createAccountExecution: the real API's
  // account-store revision participates, not a fixture-owned revision counter.
  const policy={schemaVersion:1,strategy:'automatic',strategyParams:{},protectionPosition:'keep_more_for_me'};
  const enabled=true;
  const settings=async()=>({...policy,revision:parseInt(createHash('sha256').update(JSON.stringify({
    policy,enabled,accounts:stack.store.read().settingsRevision??0})).digest('hex').slice(0,12),16),enabled});
  const journal={directory:join(directory,'launch')};
  const ledger=createLendingLedger({journal,settings});
  const events=[],startedRuns=[];
  const backend={
    prepare:async({selection:chosen,run})=>{
      assert.deepEqual(chosen,selection);
      assert.equal(run.receipt.accountId,account.id);
      return {ok:true,value:{sandboxId:'owned-synthetic-sandbox'}};
    },
    start:async input=>{startedRuns.push(input);return {ok:true,value:{kind:'started',atMs:world.now()}};},
    stop:async()=>{events.push('stop');return {ceasedAtMs:world.now()};},
    remove:async({sandboxId})=>{assert.equal(sandboxId,'owned-synthetic-sandbox');events.push('remove');return {ok:true};},
  };
  let reached,proceed;
  const atHandoff=new Promise(resolve=>{reached=resolve;});
  const handoff=new Promise(resolve=>{proceed=resolve;});
  t.after(()=>proceed());
  const broker={
    issueJobKey:input=>stack.broker.issueJobKey(input),
    revokeJobKey:async id=>{events.push('revoke');return stack.broker.revokeJobKey(id);},
    renewJobKey:async input=>{
      const result=await stack.broker.renewJobKey(input);
      if(input.forStart){reached(result);await handoff;}
      return result;
    },
  };
  const coordinator={
    reconcile:async()=>({ok:true,value:{kind:'owned'}}),
    release:async({attempt})=>{assert.equal(attempt.attemptId,'dispatch-attempt');events.push('release');return {ok:true,value:{kind:'released'}};},
  };
  const launch=createLendingLaunch({journal,settings,ledger,broker,providers:stack.providers,backend,coordinator,clock:world.now});
  const amount={unit:'window_micro_points',byResource:[{id:'seven_day',instance:'week-sentinel',amount:10000000}]};
  const settingsRevision=(await settings()).revision;
  const receipt={schemaVersion:1,accountId:account.id,jobId:'dispatch-job',attemptId:'dispatch-attempt',
    policyVersion:'objective/m1',quotedLedgerRevision:0,settingsRevision,evaluatedAtMs:world.now(),amount,mode:'observed'};
  const request={attempt:{attemptId:receipt.attemptId,jobId:receipt.jobId,generation:1,
      leaseProof:{schemaVersion:1,signedEnvelope:'{}'}},selection,receipt,
    enforcement:{amount,wallLimitMs:60000,stopOnBudget:true,metering:'estimated',limitations:['synthetic']},
    job:{id:receipt.jobId,selection,promptText:'Owned synthetic dispatch witness'},
    operationId:'prepare-dispatch',signal:new AbortController().signal};
  const prepared=await launch.prepareLend(request);
  assert.equal(prepared.ok,true,JSON.stringify(prepared.error));
  assert.deepEqual(prepared.value.selection,selection);
  assert.equal((await ledger.snapshot(account.id)).resources[0].reserved,10000000);
  const startInput={attemptId:receipt.attemptId,operationId:'start-dispatch',signal:request.signal};
  const pendingStart=launch.startLend(startInput);
  const renewed=await Promise.race([atHandoff,pendingStart.then(()=>{throw new Error('launch ended before broker handoff');})]);
  assert.equal(renewed.ok,true,'real broker accepted the exact selection before mutation');
  assert.equal(startedRuns.length,0);
  if(changeKind!=='unchanged'){
    await change({modelId:'native-model',enabled:changeKind!=='model-off',
      effortIds:changeKind==='effort-off'?['low']:['low','high']});
    assert.notEqual((await settings()).revision,settingsRevision);
  }
  proceed();
  const result=await pendingStart;
  if(changeKind==='unchanged'){
    assert.equal(result.value.kind,'started');
    assert.equal(startedRuns.length,1);
    assert.deepEqual(startedRuns[0].run.receipt,receipt);
    assert.deepEqual(events,[]);
    const running=await launch.pending();
    await change({modelId:'native-model',enabled:false,effortIds:['low','high']});
    // Saved preferences govern new dispatch, not revocation of an already running attempt.
    assert.deepEqual(await launch.pending(),running);
    assert.deepEqual(await launch.startLend(startInput),result);
    assert.equal(startedRuns.length,1);
    assert.deepEqual(events,[]);
  }else{
    assert.equal(result.error.code,'settings_conflict');
    assert.equal(startedRuns.length,0);
    assert.deepEqual(events,['revoke','remove','release']);
    assert.deepEqual(await launch.pending(),[]);
    const released=await ledger.snapshot(account.id);
    assert.equal(released.resources.length,1);
    assert.equal(released.resources[0].reserved,0);
    assert.equal(released.attempts.find(row=>row.attemptId===receipt.attemptId).state,'ceased');
    assert.equal((await launch.startLend(startInput)).ok,false);
    assert.equal(startedRuns.length,0);
  }
  assert.equal(world.upstream.length,0,'no provider execution calls');
});

const guest=(origin,providerId,key,body)=>fetch(origin+'/api/account-proxy/'+providerId+(providerId==='codex'?'/responses':'/v1/messages'),
  {method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body)});

for(const providerId of ['codex','claude'])test(providerId+': one sign-in per account serves successive jobs across restart; guest sees only its job key',{timeout:60000},async t=>{
  const world=nativeWorld(),directory=await mkdtemp(join(tmpdir(),'faravan-prod-accounts-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let stack=await productionStack(t,directory,world);
  const a=await enroll(stack,providerId,'one',{lend:true}),b=await enroll(stack,providerId,'two',{lend:true});
  assert.notEqual(a.id,b.id);assert.equal(world.logins(),2);
  const selection=account=>({providerId,accountId:account.id,modelId:'native-model',effortId:'high'});
  const body=providerId==='codex'?{model:'native-model',reasoning:{effort:'high'}}:{model:'native-model',output_config:{effort:'high'}};
  const issue=(s,account,job)=>s.broker.issueJobKey({selection:selection(account),jobId:job,attemptId:'attempt-'+job,leaseProof:{schemaVersion:1,signedEnvelope:'{}'}});
  const wait=async fn=>{for(let i=0;i<50;i++){const r=await fn();if(r.status!==403)return r;await new Promise(r=>setTimeout(r,20));}return fn();};
  const ka=await issue(stack,a,'job-1');assert.equal(ka.ok,true,JSON.stringify(ka));
  await stack.broker.getAccountUsage(a.id).requestRead({reason:'admission'});
  const first=await wait(()=>guest(stack.origin,providerId,ka.value.key,body));assert.equal(first.status,200,await first.text());
  assert.equal(world.upstream.at(-1).authorization,'Bearer ACCESS_one');
  // One shared reader: the admission read, the guest call and a status read cost one provider fetch.
  await stack.broker.getAccountUsage(a.id).requestRead({reason:'status'});
  assert.equal(world.usageReads.length,1);
  assert.doesNotMatch(JSON.stringify(world.upstream.at(-1)),new RegExp(ka.value.key));
  // Wrong account / wrong model / wrong effort cannot ride this key.
  for(const bad of [{...body,model:'other'},providerId==='codex'?{model:'native-model',reasoning:{effort:'low'}}:{model:'native-model',output_config:{effort:'low'}}]){
    const refused=await guest(stack.origin,providerId,ka.value.key,bad);assert.equal(refused.status,403);}
  assert.equal(world.upstream.length,1);
  assert.equal((await guest(stack.origin,providerId,'not-a-job-key',body)).status,403);
  assert.equal((await guest(stack.origin,providerId,a.id,body)).status,403,'an account id is not a key');
  await stack.broker.revokeJobKey(ka.value.keyId);
  assert.equal((await guest(stack.origin,providerId,ka.value.key,body)).status,403);
  // Restart: a new store, broker and listener over the same directory. No second login.
  await stack.broker.close();
  stack=await productionStack(t,directory,world);
  assert.equal((await stack.broker.list()).length,2);assert.equal(world.logins(),2);
  const kb=await issue(stack,b,'job-2');assert.equal(kb.ok,true,JSON.stringify(kb));
  await stack.broker.getAccountUsage(b.id).requestRead({reason:'admission'});
  const second=await wait(()=>guest(stack.origin,providerId,kb.value.key,body));assert.equal(second.status,200,await second.text());
  assert.equal(world.upstream.at(-1).authorization,'Bearer ACCESS_two');
  assert.equal(world.upstream.length,2);assert.equal(world.logins(),2,'no second sign-in for either account');
  // The host alone refreshes, once per account and independent of any provider CLI file.
  world.advance(550000);
  const key2=await issue(stack,a,'job-3');await stack.broker.getAccountUsage(a.id).requestRead({reason:'admission'});
  const third=await wait(()=>guest(stack.origin,providerId,key2.value.key,body));assert.equal(third.status,200,await third.text());
  assert.equal(world.upstream.at(-1).authorization,'Bearer ACCESS_one_R');assert.equal(world.refreshes(),1);
});

// ---- The guest must be able to reach the broker, or the account is not offered ----
import {syntheticBackend,waitFor} from '../helpers/v1-app-fixture.mjs';
import {guestBrokerOriginProblem} from '../../lib/docker-backend.mjs';

test('the sandbox accepts only an https broker origin without credentials or a path',()=>{
  assert.equal(guestBrokerOriginProblem('https://broker.example.invalid'),null);
  assert.equal(guestBrokerOriginProblem('https://broker.example.invalid:8443'),null);
  for(const bad of ['http://127.0.0.1:4100','https://user:pw@broker.example.invalid','https://broker.example.invalid/path','not a url',undefined])
    assert.ok(guestBrokerOriginProblem(bad),String(bad));
});

const keyService={descriptor:{schemaVersion:1,id:'codex',label:'Configured key service',signInKind:'api_key',refreshKind:'none',
  usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
  models:[{id:'example-model',label:'Example',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
  destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],modelFlag:'-m',effortFlag:'--effort',
  keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL'};
for(const [label,guestOrigin,offered] of [['default loopback origin',undefined,false],['guest-reachable https origin','https://broker.example.invalid',true]])
  test('a lender with an enrolled account advertises it only when the sandbox can reach the broker: '+label,{timeout:90000},async t=>{
    const f=await appFixture(t),backend=syntheticBackend(f.root);
    backend.prepareAccountRun=async spec=>backend.prepare(spec);
    backend.acceptsAccountBrokerOrigin=origin=>guestBrokerOriginProblem(origin)===null;
    const {lender,circle}=await f.connect({backend,accountProviderConfigurations:[keyService],
      accountTransportFetch:async()=>Response.json({subject:'subject-a'}),...(guestOrigin?{accountGuestProxyOrigin:guestOrigin}:{})});
    const flow=await api(lender.app,'/api/accounts',{method:'POST',body:{providerId:'codex',label:'a',operationId:'enroll-a'}});
    const enrolled=await api(lender.app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:'CONTROLLED_KEY_A'}});
    assert.equal(enrolled.ok,true);
    const {revision}=await api(lender.app,'/api/accounts');
    const settings=await api(lender.app,'/api/accounts/'+enrolled.value.id+'/settings',{method:'POST',
      body:{expectedRevision:revision,modelPreference:{modelId:'example-model',enabled:true,effortIds:null}}});
    assert.equal(settings.ok,true);
    await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
    await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
    const heard=await waitFor(()=>f.heartbeats?.filter(h=>h.agents).at(-1),'a lender heartbeat',30000);
    if(!offered){
      // Nothing a job could launch on: no account is offered, so no job is claimed that must fail at launch.
      await new Promise(resolve=>setTimeout(resolve,1000));
      assert.equal(f.heartbeats.some(h=>h.accounts?.length),false);assert.ok(heard);
    } else {
      const beat=await waitFor(()=>f.heartbeats?.filter(h=>h.accounts?.length).at(-1),'a heartbeat that offers the account',30000);
      assert.equal(beat.accounts[0].providerId,'codex');
    }
    await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  });

// ---- Real HTTP streaming through the production proxy ----
import {request as httpRequest} from 'node:http';
function streamingWorld(){
  const world=nativeWorld(),gates=[];let mode=null;const original=world.send;
  world.send=async(url,options)=>{
    if(mode&&options.method==='POST'){
      const encoder=new TextEncoder(),gate=Promise.withResolvers();gates.push(gate);
      const chunks=mode.chunks;
      return new Response(new ReadableStream({async start(c){
        c.enqueue(encoder.encode(chunks[0]));await gate.promise;
        for(const rest of chunks.slice(1))c.enqueue(encoder.encode(rest));c.close();}}),
        {status:200,headers:{'content-type':'text/event-stream'}});
    }
    return original(url,options);
  };
  world.stream=value=>{mode=value;};world.gates=gates;
  return world;
}
const sse=event=>'data: '+JSON.stringify(event)+'\n\n';
async function openGuest(origin,key,body){
  const request=httpRequest(origin+'/api/account-proxy/codex/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'}});
  const received=[];const done=Promise.withResolvers(),first=Promise.withResolvers();
  request.on('response',response=>{response.on('data',chunk=>{received.push(chunk.toString());first.resolve();});
    response.on('end',()=>done.resolve({status:response.statusCode,text:received.join(''),complete:true}));
    response.on('error',error=>done.resolve({status:response.statusCode,text:received.join(''),complete:false,error}));
    response.on('aborted',()=>done.resolve({status:response.statusCode,text:received.join(''),complete:false}));});
  request.on('error',error=>{first.resolve();done.resolve({status:0,text:'',complete:false,error});});
  request.end(JSON.stringify(body));
  return {first:first.promise,done:done.promise,received};
}
const codexBody={model:'native-model',reasoning:{effort:'high'}};
async function streamingStack(t){
  const world=streamingWorld(),directory=await mkdtemp(join(tmpdir(),'faravan-stream-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const stack=await productionStack(t,directory,world),account=await enroll(stack,'codex','one',{lend:true});
  const key=await stack.broker.issueJobKey({selection:{providerId:'codex',accountId:account.id,modelId:'native-model',effortId:'high'},
    jobId:'job-s',attemptId:'attempt-s',leaseProof:{schemaVersion:1,signedEnvelope:'{}'}});
  await stack.broker.getAccountUsage(account.id).requestRead({reason:'admission'});
  return {world,stack,account,key:key.value.key};
}
test('a guest reads the first streamed bytes before the provider finishes, and the served model is recorded at the end',{timeout:30000},async t=>{
  const {world,stack,account,key}=await streamingStack(t);
  const completed=sse({type:'response.completed',response:{object:'response',id:'r1',status:'completed',model:'native-model'}});
  world.stream({chunks:[sse({type:'response.output_text.delta',delta:'hi'}),completed]});
  const guest=await openGuest(stack.origin,key,codexBody);
  await Promise.race([guest.first,new Promise((_,reject)=>setTimeout(()=>reject(Error('first chunk was buffered until the end')),5000))]);
  assert.match(guest.received.join(''),/output_text\.delta/);
  assert.doesNotMatch(guest.received.join(''),/response\.completed/);
  world.gates[0].resolve();
  const result=await guest.done;assert.equal(result.complete,true);assert.match(result.text,/response\.completed/);
  const operations=Object.values(stack.store.get(account.id).dispatchOperations);
  assert.deepEqual(operations.map(op=>op.observedModel),['native-model']);
});
test('a streamed reply that carries the host token is cut before those bytes reach the guest',{timeout:30000},async t=>{
  const {world,stack,key}=await streamingStack(t);
  world.stream({chunks:['data: {"x":"ACCESS_',"one\"}\n\n"]});
  const guest=await openGuest(stack.origin,key,codexBody);
  await Promise.race([guest.first.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,300))]);
  world.gates[0].resolve();
  const result=await guest.done;
  assert.equal(result.complete,false);assert.doesNotMatch(result.text,/ACCESS_one/);
});
test('revoking the key ends an open stream',{timeout:30000},async t=>{
  const {world,stack,key}=await streamingStack(t);
  world.stream({chunks:[sse({type:'response.output_text.delta',delta:'hi'}),sse({type:'late'})]});
  const guest=await openGuest(stack.origin,key,codexBody);await guest.first;
  const keyId=Object.keys(Object.values(stack.store.read().records)[0].guestKeys)[0];
  await stack.broker.revokeJobKey(keyId);world.gates[0].resolve();
  const result=await guest.done;assert.equal(result.complete,false);assert.doesNotMatch(result.text,/late/);
});

// ---- The clean-install route: a guest-loopback relay over the host-controlled exec channel ----
// The relay runs as a real subprocess standing in for `sbx exec -i <sandbox> node -e ...`.

async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const {port}=s.address();await new Promise(r=>s.close(r));return port;}
async function openTunnel(t,handler){
  const port=await freePort();
  const child=spawn(process.execPath,['-e',GUEST_RELAY_SOURCE,String(port)],{stdio:['pipe','pipe','ignore']});
  const tunnel=attachGuestBrokerTunnel({child,handler});
  t.after(()=>tunnel.close());
  await tunnel.ready;
  return {tunnel,child,origin:'http://127.0.0.1:'+port};
}

test('a guest process reaches the host broker through the tunnel with no hostname, and only with its own key',{timeout:60000},async t=>{
  const world=nativeWorld(),directory=await mkdtemp(join(tmpdir(),'faravan-tunnel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const stack=await productionStack(t,directory,world);
  const a=await enroll(stack,'codex','one',{lend:true}),b=await enroll(stack,'codex','two',{lend:true});
  const selection=account=>({providerId:'codex',accountId:account.id,modelId:'native-model',effortId:'high'});
  const body={model:'native-model',reasoning:{effort:'high'}};
  const issue=(account,job)=>stack.broker.issueJobKey({selection:selection(account),jobId:job,attemptId:'attempt-'+job,leaseProof:{schemaVersion:1,signedEnvelope:'{}'}});
  const ka=await issue(a,'job-t1'),kb=await issue(b,'job-t2');
  await stack.broker.getAccountUsage(a.id).requestRead({reason:'admission'});
  const {tunnel,child,origin}=await openTunnel(t,accountProxyRequestListener({providerId:'codex',providers:stack.providers,broker:stack.broker}));
  const wait=async fn=>{for(let i=0;i<50;i++){const r=await fn();if(r.status!==403)return r;await new Promise(r=>setTimeout(r,20));}return fn();};
  const post=(key,path='/api/account-proxy/codex/responses',payload=body)=>fetch(origin+path,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload)});
  const ok=await wait(()=>post(ka.value.key));assert.equal(ok.status,200,await ok.text());
  assert.equal(world.upstream.at(-1).authorization,'Bearer ACCESS_one');
  assert.doesNotMatch(JSON.stringify(world.upstream.at(-1)),new RegExp(ka.value.key));
  // Wrong key, wrong provider path, wrong model and an account id are all refused; nothing new reaches the provider.
  assert.equal((await post('not-a-job-key')).status,403);
  assert.equal((await post(a.id)).status,403);
  assert.equal((await post(ka.value.key,'/api/account-proxy/claude/v1/messages')).status,403);
  assert.equal((await post(ka.value.key,undefined,{...body,model:'other'})).status,403);
  assert.equal(world.upstream.length,1);
  // Two guests at once over one tunnel are independent connections.
  await stack.broker.getAccountUsage(b.id).requestRead({reason:'admission'});
  const [one,two]=await Promise.all([post(ka.value.key),wait(()=>post(kb.value.key))]);
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.deepEqual(world.upstream.slice(-2).map(u=>u.authorization).sort(),['Bearer ACCESS_one','Bearer ACCESS_two']);
  // Revoking the key ends access through the same route.
  await stack.broker.revokeJobKey(ka.value.keyId);
  assert.equal((await post(ka.value.key)).status,403);
  // Teardown closes the listener and ends the relay process.
  const exited=once(child,'close');tunnel.close();await exited;
  await assert.rejects(post(kb.value.key));
});

test('the tunnel streams, preserves large bodies and drops its connections when closed',{timeout:30000},async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {tunnel,origin}=await openTunnel(t,async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    if(req.url==='/echo'){res.end(Buffer.concat(chunks));return;}
    res.writeHead(200,{'content-type':'text/plain'});res.write('first');await gate;res.end('second');
  });
  const big=Buffer.alloc(300000,7);
  const echoed=Buffer.from(await (await fetch(origin+'/echo',{method:'POST',body:big})).arrayBuffer());
  assert.equal(echoed.length,big.length);assert.ok(echoed.equals(big));
  const response=await fetch(origin+'/stream');const reader=response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'first','first bytes arrive before the reply ends');
  release();let rest='';for(;;){const r=await reader.read();if(r.done)break;rest+=Buffer.from(r.value).toString();}
  assert.equal(rest,'second');
  const open=fetch(origin+'/hang-never',{method:'POST',body:big}).catch(e=>e);
  tunnel.close();assert.equal(tunnel.connections,0);void open;
});


test('aged native reading survives failed refresh and a real signed Auto launch',{timeout:90000},async t=>{
  const f=await appFixture(t),world=nativeWorld(),ageMs=25*60000;
  const home=await f.home('lender'),directory=join(home,'v1','accounts');
  world.advance(-ageMs);
  // Keep credential rotation independent of the deliberately old usage observation.
  const login=world.drivers.codex.auth.oauth.login;
  world.drivers.codex.auth.oauth.login=async interaction=>({
    ...await login(interaction),expires:world.now()+2*60*60000,
  });
  let liveApp,failReads=false,failedReads=0;
  const send=world.send;
  world.send=async(url,options)=>{
    if(failReads&&url.endsWith('/usage')){failedReads++;throw new Error('synthetic usage outage');}
    const response=await send(url,options);
    if(options.method==='POST')return Response.json({
      id:'aged-response',object:'response',status:'completed',model:'native-model',
    });
    return response;
  };
  const seed=await productionStack(t,directory,world,{proxyOrigin:()=>liveApp?.origin});
  const account=await enroll(seed,'codex','aged-owner',{lend:true});
  const seeded=await seed.broker.getAccountUsage(account.id).requestRead({reason:'admission'});
  assert.equal(seeded.state,'ready');
  assert.equal(seeded.reading.accountId,account.id);
  assert.equal(seeded.reading.observedAtMs,world.now());
  const originalReading=structuredClone(seeded.reading);
  const originalGeneration=seed.store.get(account.id).generation;
  await seed.broker.close(); // Seeding authority never claims or issues this job's key.
  world.advance(Date.now()-world.now());
  failReads=true;
  const backend=syntheticBackend(f.root);
  backend.prepareAccountRun=async spec=>{
    const h=await backend.prepare(spec);
    h.job_id=spec.job_id;h.sandbox_id='aged-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  const start=backend.start.bind(backend);
  let proxyReplies=0;
  backend.start=async(h,options)=>{
    // Synthetic workspace preparation also uses start. Only the bound account run talks to the broker.
    if (!h._entrypoint.startsWith('env ')) return start(h,options);
    const key=/OPENAI_API_KEY=([^']+)/.exec(h._entrypoint)?.[1];
    const base=/OPENAI_BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
    assert.ok(key&&base,'native provider must supply guest key and proxy origin');
    assert.equal(new URL(base).origin,liveApp.origin);
    const response=await guest(liveApp.origin,'codex',key,codexBody);
    assert.equal(response.status,200,'owned broker accepted the synthetic bound request');
    assert.equal((await response.json()).id,'aged-response');
    proxyReplies++;
    h._entrypoint='completed-aged-provider';
    return start(h,options);
  };
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{
    backend,accountProviders:seed.providers,accountTransportFetch:world.send,
  }});
  liveApp=lender.app;
  assert.equal(lender.home,home);
  const persisted=()=>createAccountStore({directory}).get(account.id);
  assert.equal(persisted().generation,originalGeneration);
  assert.deepEqual(persisted().usage.reading,originalReading);
  assert.equal(world.logins(),1,'same persisted account, no re-enrollment');
  const journalPath=join(home,'v1','account-launch','lending.json');
  const journal=()=>{
    try{return JSON.parse(readFileSync(journalPath,'utf8'));}
    catch(error){if(error.code==='ENOENT')return {launches:{}};throw error;}
  };
  assert.deepEqual(Object.keys(journal().launches),[]);
  await api(liveApp,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(liveApp,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  const mode=await api(liveApp,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  assert.ok(mode.standingRules.some(rule=>rule.circle===circle.id));
  await api(liveApp,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(()=>failedReads>0&&persisted().usage.state==='unavailable','failed live usage refresh',30000);
  assert.deepEqual(persisted().usage.reading,originalReading,'failure retains original observation, not a fresh timestamp');
  await waitFor(()=>realHeartbeats.filter(row=>row.device===liveApp.device.keyId)
    .at(-1)?.body.accounts?.some(row=>row.accountId===account.id),'published aged account',30000).catch(async error=>{
    console.error('AGED ADMISSION',JSON.stringify(await api(liveApp,'/api/lending/log')));
    throw error;
  });
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{
    circle:circle.id,prompt:'Aged automatic signed account job',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex',
    runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'native-model'}],effortId:'high'},
  }});
  const client=await owner.app.device.client(circle.id);
  const view=await waitFor(async()=>{
    assert.deepEqual(await api(liveApp,'/api/approvals'),[]);
    const current=await client.getJob(submitted.jobDigest);
    return current.state==='result-accepted'?current:null;
  },'aged signed result without review',30000).catch(async error=>{
    console.error('AGED ADMISSION',JSON.stringify(await api(liveApp,'/api/lending/log')));
    console.error('AGED JOB',JSON.stringify(await client.getJob(submitted.jobDigest)));
    throw error; // A funding hold is evidence, never a fabricated successful launch.
  });
  const launch=journal().launches[view.current_attempt.attempt_id];
  assert.ok(launch);
  assert.equal(launch.receipt.mode,'aged');
  assert.equal(launch.receipt.jobId,submitted.jobDigest);
  assert.equal(launch.receipt.accountId,account.id);
  assert.equal(Object.keys(journal().launches).length,1);
  const result=await client.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
  assert.deepEqual(result.receipt.selection,{providerId:'codex',accountId:account.id,modelId:'native-model',effortId:'high'});
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,1);
  assert.equal(proxyReplies,1);assert.equal(world.upstream.length,1);
  assert.equal(world.refreshes(),0);assert.equal(persisted().generation,originalGeneration);
  assert.equal(persisted().usage.reading.observedAtMs,originalReading.observedAtMs);
  assert.ok(Date.now()-originalReading.observedAtMs>=ageMs);
  await api(liveApp,'/api/lending/off',{method:'POST',body:{}});
});
