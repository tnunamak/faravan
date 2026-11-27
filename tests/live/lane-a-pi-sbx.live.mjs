// Live probe, not part of the suite (run it by name). One real pi job in a real Docker Sandbox created from the repo's
// kits/wf-pi (pi unpacked from the kit's own payload: the sandbox has no registry access), through the app, lender,
// coordinator, broker and the guest-loopback tunnel, to a loopback OpenAI-compatible server that stands in for a self-hosted model.
// Required env: LANEA_SBX_HOME, LANEA_SCRATCH, LANEA_GUEST_RUNTIME_ROOT (see lane-a-two-account-sbx.live.mjs, which also explains the gate).
// The kit's payload must be built first: scripts/build-pi-payload.sh kits/wf-pi/files/home/.faravan/pi-payload.tgz
// STATUS: passes (result-accepted, one pi job on the borrowed pi:0 account through the broker tunnel; see the commit message for the receipts).
// A pass here is the evidence that pi runs through the broker tunnel.
import './real-path-first.mjs';
import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {appFixture,api,waitFor} from '../helpers/v1-app-fixture.mjs';
import {startApp} from '../../lib/v1/app.mjs';
import * as piAdapter from '../../lib/harnesses/pi.adapter.mjs';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {stageGuestRuntime} from '../../lib/guest-runtime.mjs';

test('one real pi job in a real sandbox reaches a loopback model server through the broker tunnel',{timeout:900000},async t=>{
  for(const name of ['LANEA_SBX_HOME','LANEA_SCRATCH','LANEA_GUEST_RUNTIME_ROOT'])assert.ok(process.env[name],name);
  process.env.FARAVAN_SBX_HOME=process.env.LANEA_SBX_HOME;process.env.FARAVAN_SCRATCH_ROOT=process.env.LANEA_SCRATCH;
  process.env.FARAVAN_SBX_DAEMON_GATE='off';process.env.PATH=globalThis.__liveRealPath;delete process.env.FARAVAN_SBX_BIN;
  delete process.env.FARAVAN_GUEST_BROKER_ORIGIN;
  const seen=[];
  const model=http.createServer((request,response)=>{let body='';request.on('data',c=>body+=c);request.on('end',()=>{
    seen.push({method:request.method,url:request.url,authorization:request.headers.authorization??null,body:body?JSON.parse(body):null});
    const chunk=(delta,finish=null,extra={})=>'data: '+JSON.stringify({id:'chatcmpl-live',object:'chat.completion.chunk',created:0,model:'local-small',choices:[{index:0,delta,finish_reason:finish}],...extra})+'\n\n';
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.end(chunk({role:'assistant',content:'pong'})+chunk({},'stop',{usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}})+'data: [DONE]\n\n');});});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>model.close());
  const origin='http://127.0.0.1:'+model.address().port;
  const configuration={descriptor:{schemaVersion:1,id:'pi',label:'Self-hosted pi',signInKind:'local_harness',refreshKind:'none',usageKind:'none',maxConcurrentJobs:1,nativeUnits:[],
    models:[{id:'local-small',label:'Local small',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
    destinations:[{origin,pathPrefixes:['/v1'],methods:['POST']}]},
    harnessId:'pi',identity:'pi-live-subject',command:'faravan-pi',args:['--print','--mode','json'],modelFlag:'--model',effortFlag:'--thinking',
    keyEnv:'PI_API_KEY',modelsEnv:'FARAVAN_PI_MODELS'};
  const f=await appFixture(t);
  const backend=new DockerSbxBackend({guestRuntime:options=>stageGuestRuntime({...options,root:process.env.LANEA_GUEST_RUNTIME_ROOT})});
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{backend,startApp:o=>startApp({...o,adapters:[...o.adapters,{spec:piAdapter.spec,installed:true,signedIn:true,models:['local-small'],capabilities:[]}]}),accountProviderConfigurations:[configuration]}});
  const flow=await api(lender.app,'/api/accounts',{method:'POST',body:{providerId:'pi',label:'pi',operationId:'enroll-pi'}});
  const account=(await api(lender.app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{}})).value;
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  // Lending needs one enabled native agent to start; the pi account is offered next to it.
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/agents/pi',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const client=await owner.app.device.client(circle.id);
  await waitFor(()=>realHeartbeats.filter(r=>r.device===lender.app.device.keyId).at(-1)?.body.accounts?.some(i=>i.accountId===account.id),'published pi account',60000);
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Reply with the single word pong.',noSource:true,harness:'pi',
    result:{kind:'files'},runRequest:{schemaVersion:1,models:[{providerId:'pi',modelId:'local-small'}],effortId:'high'}}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval',60000).catch(async error=>{
    const show=async(label,path)=>console.log(label,JSON.stringify(await api(lender.app,path).catch(e=>String(e))).slice(0,2500));
    await show('LOG','/api/lending/log');await show('JOB','/api/jobs/'+(submitted.value?.id??submitted.id??''));await show('DECISIONS','/api/lending/decisions');await show('AGENTS','/api/agents');await show('READINESS','/api/readiness');throw error;});
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  const view=await waitFor(async()=>{const v=await client.getJob(submitted.jobDigest).catch(e=>e?.code==='rate_limited'?null:Promise.reject(e));
    return v&&['result-accepted','failed','declined','cancelled'].includes(v.state)?v:null;},'job end',420000).catch(async error=>{
    await new Promise(r=>setTimeout(r,60000));
    console.log('JOBVIEW',JSON.stringify(await client.getJob(submitted.jobDigest).catch(e=>String(e))).slice(0,1500));
    console.log('OWNERJOB',JSON.stringify(await api(owner.app,'/api/jobs/'+submitted.jobDigest).catch(e=>String(e))).slice(0,1500));
    console.log('DECISIONS',JSON.stringify((await api(lender.app,'/api/lending/decisions').catch(e=>({e:String(e)}))).accountStates));
    console.log('LOGC',JSON.stringify(((await api(lender.app,'/api/lending/log').catch(e=>[])) ).map?.(r=>[r.at,r.code,r.phase,r.message?.slice(0,60)]).reverse()));
    console.log('RUNFAIL',JSON.stringify((await api(lender.app,'/api/lending/log').catch(e=>[])).filter?.(r=>r.phase==='run').map(r=>r.details)));
    console.log('UPSTREAM',JSON.stringify(seen.map(s=>({method:s.method,url:s.url,model:s.body?.model}))));throw error;});
  console.log('JOB',JSON.stringify({state:view.state,attempt:view.current_attempt,digest:submitted.jobDigest}));
  console.log('LOG',JSON.stringify(await api(lender.app,'/api/lending/log')).slice(0,1500));
  console.log('UPSTREAM',JSON.stringify(seen.map(s=>({method:s.method,url:s.url,model:s.body?.model,reasoning:s.body?.reasoning_effort,stream:s.body?.stream,authorizationIsJobKey:/^Bearer /.test(s.authorization??'')}))));
  assert.equal(view.state,'result-accepted');
  assert.ok(seen.length>=1,'the loopback model server was reached through the broker');
  assert.equal(seen[0].url,'/v1/chat/completions');assert.equal(seen[0].body.model,'local-small');
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
});
