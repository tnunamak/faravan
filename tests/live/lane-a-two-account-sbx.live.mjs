// Live probe, not part of the suite (run it by name). Real Docker Sandboxes (the app-owned sbx home),
// real production DockerSbxBackend, in-process owner + lender + coordinator. The provider is synthetic:
// accountTransportFetch answers instead of any real provider, and both accounts are test-owned keys.
// The candidate runs from a checkout, so the app-owned daemon unit (bound to the installed runtime) would be refused as not owned; the probe sets FARAVAN_SBX_DAEMON_GATE=off, which skips that identity check and never restarts the daemon.
// Required env: LANEA_SBX_HOME (the app-owned sbx home) and LANEA_SCRATCH (disk-backed scratch); the test fixture clears FARAVAN_* variables, so it sets them itself.
import './real-path-first.mjs';
import '../helpers/no-browser.mjs';
import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {promisify} from 'node:util';
import {execFile as execFileCb} from 'node:child_process';
const execFile=promisify(execFileCb);
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from '../helpers/v1-app-fixture.mjs';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {stageGuestRuntime} from '../../lib/guest-runtime.mjs';

const SCRIPT=[
  'mkdir -p faravan-output',
  'code=$(curl -s -m 30 -o faravan-output/provider-reply.json -w "%{http_code}" -H "Authorization: Bearer $JOB_KEY" -H "content-type: application/json"'+
    ' -d "{\\"model\\":\\"$2\\",\\"effort\\":\\"$4\\"}" "$BASE_URL/responses")',
  'printf "status=%s\\nbase=%s\\nmodel=%s\\neffort=%s\\n" "$code" "$BASE_URL" "$2" "$4" > faravan-output/guest-report.txt',
  'test "$code" = 200'].join('\n');
const configuration={
  descriptor:{schemaVersion:1,id:'codex',label:'Synthetic key service',signInKind:'api_key',refreshKind:'none',
    usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
    models:[{id:'example-model',label:'Example',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
    destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'sh',args:['-c',SCRIPT,'probe'],modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL'};

test('two real sandbox jobs on two enrolled accounts through app, lender and coordinator',{timeout:900000},async t=>{
  assert.ok(process.env.LANEA_SBX_HOME,'LANEA_SBX_HOME');process.env.FARAVAN_SBX_HOME=process.env.LANEA_SBX_HOME;process.env.FARAVAN_SCRATCH_ROOT=process.env.LANEA_SCRATCH;process.env.FARAVAN_SBX_DAEMON_GATE='off';process.env.PATH=globalThis.__liveRealPath;delete process.env.FARAVAN_SBX_BIN;
  delete process.env.FARAVAN_GUEST_BROKER_ORIGIN;
  const f=await appFixture(t);const upstream=[];
  // A checkout has no built guest-runtime/; the installed runtime ships the verified one (sha256 checked against its manifest).
  assert.ok(process.env.LANEA_GUEST_RUNTIME_ROOT,'LANEA_GUEST_RUNTIME_ROOT');
  const backend=new DockerSbxBackend({guestRuntime:options=>stageGuestRuntime({...options,root:process.env.LANEA_GUEST_RUNTIME_ROOT})});
  const connected=await f.realConnect({lenderOptions:{backend,accountProviderConfigurations:[configuration],
    accountTransportFetch:async(url,options)=>{
      if(options.method==='GET')return Response.json({subject:options.headers.authorization==='Bearer TEST_OWNED_KEY_A'?'subject-a':'subject-b'});
      upstream.push({url,authorization:options.headers.authorization,body:JSON.parse(Buffer.from(options.body).toString())});
      return Response.json({id:'resp_'+upstream.length,object:'response',status:'completed',model:'example-model'});}}});
  const {owner,lender,circle,realHeartbeats}=connected;
  const enroll=async(key,op)=>{const flow=await api(lender.app,'/api/accounts',{method:'POST',body:{providerId:'codex',label:op,operationId:op}});
    return (await api(lender.app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:key}})).value;};
  const a=await enroll('TEST_OWNED_KEY_A','enroll-a'),b=await enroll('TEST_OWNED_KEY_B','enroll-b');
  assert.notEqual(a.id,b.id);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const client=await owner.app.device.client(circle.id);
  const report={origin:null,jobs:[]};
  for(const [index,account] of [a,b].entries()){
    if(index){const settings=await api(lender.app,'/api/accounts');
      await api(lender.app,'/api/accounts/'+b.id+'/settings',{method:'POST',body:{expectedRevision:settings.revision,accountOrder:[b.id,a.id]}});}
    const order=index?[b.id,a.id]:[a.id,b.id];
    await waitFor(()=>JSON.stringify(realHeartbeats.filter(r=>r.device===lender.app.device.keyId).at(-1)?.body.accounts?.map(i=>i.accountId))===JSON.stringify(order),'published account order',60000);
    const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Live probe '+index,noSource:true,harness:'codex',
      result:{kind:'files'},runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'}}});
    const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval',60000).catch(async error=>{
      const show=async(label,path)=>console.log(label,JSON.stringify(await api(lender.app,path).catch(e=>String(e))).slice(0,2500));
      await show('LOG','/api/lending/log');await show('AGENTS','/api/agents');await show('READINESS','/api/readiness');await show('STATUS','/api/status');
      console.log('JOBVIEW',JSON.stringify(await client.getJob(submitted.jobDigest)).slice(0,1500));throw error;});
    await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
    const view=await waitFor(async()=>{const v=await client.getJob(submitted.jobDigest).catch(e=>e?.code==='rate_limited'?null:Promise.reject(e));
      if(!v)return null;if(['result-accepted','failed','declined','cancelled'].includes(v.state))return v;return null;},'job end',420000);
    console.log('JOB',index,JSON.stringify({state:view.state,attempt:view.current_attempt,digest:submitted.jobDigest}));
    console.log('LOG',JSON.stringify(await api(lender.app,'/api/lending/log')).slice(0,1500));
    assert.equal(view.state,'result-accepted');
    const result=await waitFor(()=>client.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt}).catch(e=>e?.code==='rate_limited'?null:Promise.reject(e)),'result',60000);
    console.log('RECEIPT',JSON.stringify(result.receipt));
    assert.deepEqual(result.receipt.selection,{providerId:'codex',accountId:account.id,modelId:'example-model',effortId:'high'});
  }
  console.log('UPSTREAM',JSON.stringify(upstream.map(u=>({auth:u.authorization,body:u.body}))));
  assert.deepEqual(upstream.map(u=>u.authorization),['Bearer TEST_OWNED_KEY_A','Bearer TEST_OWNED_KEY_B']);
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  // Idle census: with no job running, no sandbox, no sbx child and no relay process may remain for either account.
  await new Promise(r=>setTimeout(r,5000));
  const rows=(await execFile('/usr/bin/sbx',['ls','--format','json'],{env:sbxEnv(process.env.LANEA_SBX_HOME)})).stdout;
  const live=descendants(process.pid).filter(p=>/(^|\/)sbx( |$)|faravan-relay|18437/.test(p.cmd));
  console.log('CENSUS',JSON.stringify({sandboxes:JSON.parse(rows),sbxOrRelayDescendants:live}));
  assert.deepEqual(JSON.parse(rows),[]);assert.deepEqual(live,[]);
});

function descendants(root){
  const all=readdirSync('/proc').filter(n=>/^\d+$/.test(n)).map(n=>{try{
    const stat=readFileSync('/proc/'+n+'/stat','utf8'),ppid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
    return {pid:Number(n),ppid,cmd:readFileSync('/proc/'+n+'/cmdline','utf8').replaceAll('\0',' ').trim()};}catch{return null;}}).filter(Boolean);
  const out=[],seen=new Set([root]);
  for(let grew=true;grew;){grew=false;for(const p of all)if(!seen.has(p.pid)&&seen.has(p.ppid)){seen.add(p.pid);out.push(p);grew=true;}}
  return out;
}
const sbxEnv=home=>({PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:home+'/.config',XDG_DATA_HOME:home+'/.local/share',XDG_STATE_HOME:home+'/.local/state',XDG_CACHE_HOME:home+'/.cache',DBUS_SESSION_BUS_ADDRESS:'unix:path='+home+'/no-session-bus'});
