import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {appFixture,api,syntheticBackend,waitFor} from '../helpers/v1-app-fixture.mjs';
import {attachGuestBrokerTunnel,GUEST_RELAY_SOURCE} from '../../lib/v1/guest-broker-tunnel.mjs';
import {DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {TUNNEL_ORIGIN} from '../../lib/v1/guest-broker-tunnel.mjs';

// Owned fixtures only. The backend double stands where DockerSbxBackend does: it names its tunnel
// origin, refuses to open a broker host, and opens the host end of a real relay process (the
// process that `sbx exec -i <sandbox> node -e ...` would run in the guest).
const configuration={
  descriptor:{schemaVersion:1,id:'codex',label:'Configured key service',signInKind:'api_key',refreshKind:'none',
    usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],
    models:[{id:'example-model',label:'Example',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
    destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL'};

test('DockerSbxBackend names a private tunnel origin and opens no broker host for it',async()=>{
  const backend=Object.create(DockerSbxBackend.prototype);
  assert.equal(backend.accountTunnelOrigin(),TUNNEL_ORIGIN);
  assert.equal(backend.acceptsAccountBrokerOrigin(TUNNEL_ORIGIN),true);
  assert.equal(backend.acceptsAccountBrokerOrigin('https://broker.example'),true);
  for(const bad of ['http://127.0.0.1:8080','http://10.23.1.5:7000','http://broker.example','http://127.0.0.1:18438'])
    assert.equal(backend.acceptsAccountBrokerOrigin(bad),false,bad);
  let options;backend.prepare=async(_job,value)=>{options=value;return {};};
  const attempt={signedEnvelope:'{}'};
  const call=origin=>backend.prepareAccountRun({job_id:'j'},{selection:{accountId:'a',providerId:'codex'},attempt:{jobId:'j',attemptId:'t',generation:1,leaseProof:{signedEnvelope:'{}'}},brokerOrigin:origin});
  void attempt;
  await call(TUNNEL_ORIGIN);
  assert.deepEqual(options.brokerHosts,[]);assert.equal(options.providerAccess,false);assert.equal(options.brokerOnly,true);
  await call('https://broker.example');assert.deepEqual(options.brokerHosts,['broker.example']);
  await assert.rejects(call('http://127.0.0.1:18438'),/HTTPS broker origin/);
});

test('a clean install with no hostname configured runs a broker-backed job through the private tunnel',{timeout:150000},async t=>{
  const f=await appFixture(t);const upstream=[];
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tunnelOrigin='http://127.0.0.1:'+port;
  const backend=syntheticBackend(f.root);const tunnels={opened:0,closed:0,live:0};
  backend.accountTunnelOrigin=()=>tunnelOrigin;
  backend.acceptsAccountBrokerOrigin=origin=>origin===tunnelOrigin;
  let prepared;
  backend.prepareAccountRun=async(spec,value)=>{
    prepared=value.brokerOrigin;
    const h=await backend.prepare(spec);h.job_id=spec.job_id;h.sandbox_id='tunnel-'+randomUUID();h._cleanupId=randomUUID();return h;
  };
  backend.openAccountTunnel=async(_handle,{handler,signal})=>{
    const child=spawn(process.execPath,['-e',GUEST_RELAY_SOURCE,String(port)],{stdio:['pipe','pipe','ignore']});
    const tunnel=attachGuestBrokerTunnel({child,handler,signal});
    await tunnel.ready;tunnels.opened++;tunnels.live++;
    return {close(){if(tunnels.live){tunnels.live--;tunnels.closed++;}tunnel.close();}};
  };
  backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
  const originalStart=backend.start.bind(backend);let guestSaw;
  backend.start=async(h,opts)=>{
    if(h._entrypoint.startsWith('env ')){
      guestSaw=h._entrypoint;
      const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)[1],base=/BASE_URL=([^']+)/.exec(h._entrypoint)[1];
      assert.equal(tunnels.live,1,'the tunnel is open while the agent runs');
      assert.ok(base.startsWith(tunnelOrigin+'/api/account-proxy/codex'),base);
      const body=JSON.stringify({model:'example-model',effort:'high'});
      const bad=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer wrong','content-type':'application/json'},body});
      assert.equal(bad.status,403);
      const response=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body});
      assert.equal(response.status,200,await response.text());
      h._entrypoint='completed-controlled-provider';
    }
    return originalStart(h,opts);
  };
  // No accountGuestProxyOrigin option and no FARAVAN_GUEST_BROKER_ORIGIN: the backend supplies the route.
  delete process.env.FARAVAN_GUEST_BROKER_ORIGIN;
  const {owner,lender,circle,realHeartbeats}=await f.realConnect({lenderOptions:{backend,accountProviderConfigurations:[configuration],
    accountTransportFetch:async(url,options)=>{
      if(options.method==='GET')return Response.json({subject:'subject-a'});
      upstream.push({url,headers:options.headers});
      return Response.json({id:'resp_1',object:'response',status:'completed',model:'example-model'});}}});
  const flow=await api(lender.app,'/api/accounts',{method:'POST',body:{providerId:'codex',label:'a',operationId:'enroll-a'}});
  const account=(await api(lender.app,'/api/accounts/flows/'+flow.value.flowId+'/complete',{method:'POST',body:{answer:'CONTROLLED_SECRET_A'}})).value;
  const modelId='example-model';
  const settingsPath='/api/accounts/'+account.id+'/settings';
  const accountPreference=snapshot=>{
    const row=snapshot.accounts.find(candidate=>candidate.id===account.id);
    assert.ok(row,'GET accounts includes the enrolled fixture account');
    return row.modelPreferences?.[modelId];
  };
  const beforeEnable=await api(lender.app,'/api/accounts');
  const {revision}=beforeEnable;
  assert.ok(Number.isSafeInteger(revision)&&revision>=0,'GET accounts returns a valid settings revision');
  assert.notEqual(accountPreference(beforeEnable)?.enabled,true,'the model is not initially enabled on this account');
  const enabled={enabled:true,effortIds:null};
  const settings=await api(lender.app,settingsPath,{method:'POST',
    body:{expectedRevision:revision,modelPreference:{modelId,...enabled}}});
  assert.equal(settings.ok,true,JSON.stringify(settings));
  const afterEnable=await api(lender.app,'/api/accounts');
  assert.equal(afterEnable.revision,revision+1,'enabling the model advances the persisted revision exactly once');
  assert.deepEqual(accountPreference(afterEnable),enabled);
  const stale=await api(lender.app,settingsPath,{method:'POST',status:409,
    body:{expectedRevision:revision,modelPreference:{modelId,enabled:false,effortIds:null}}});
  assert.equal(stale.error.code,'settings_conflict');
  const afterConflict=await api(lender.app,'/api/accounts');
  assert.equal(afterConflict.revision,afterEnable.revision,'a stale write leaves the persisted revision unchanged');
  assert.deepEqual(accountPreference(afterConflict),enabled,'a stale write leaves the model enabled');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const client=await owner.app.device.client(circle.id);
  await waitFor(()=>realHeartbeats.filter(row=>row.device===lender.app.device.keyId).at(-1)?.body.accounts?.length===1,'account offered with no hostname',30000);
  const submitted=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Tunnel job',
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),harness:'codex',
    runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'}}});
  const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'account approval',30000);
  await api(lender.app,'/api/approvals/'+card.id+'/accept',{method:'POST',body:{}});
  const view=await waitFor(async()=>{const v=await client.getJob(submitted.jobDigest);return v.state==='result-accepted'?v:null;},'signed result',30000);
  const result=await client.fetchResult(submitted.jobDigest,{includeMetadata:true,attempt:view.current_attempt});
  assert.equal(result.receipt.selection.accountId,account.id);
  assert.equal(prepared,tunnelOrigin);
  assert.equal(upstream.length,1);assert.equal(upstream[0].headers.authorization,'Bearer CONTROLLED_SECRET_A');
  assert.doesNotMatch(guestSaw,/CONTROLLED_SECRET/);
  assert.deepEqual(tunnels,{opened:1,closed:1,live:0},'the tunnel is torn down when the run ends');
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
});
