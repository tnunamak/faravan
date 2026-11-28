import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import * as p from '../lib/protocol/index.mjs';
import {createJobOperations,runV1Command} from '../lib/v1/cli.mjs';
import {runMcpServer} from '../lib/v1/mcp.mjs';
import {appFixture,api,boundedFetch,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';
import {syntheticAccountAdvertisement} from './helpers/synthetic-run-account.mjs';
import {resultArchive} from './helpers/v1-journey.mjs';

const seconds=()=>Math.floor(Date.now()/1000);
const iso=n=>new Date(n*1000).toISOString().replace('.000Z','Z');
const advertisement={harnesses:['codex'],models:[],capabilities:['filtered_git_v1','designated_member_v1'],
  egress:['provider-only','internet'],enforced_limits:['cpu','memory_bytes','disk_bytes','output_bytes','wall_seconds'],
  max_limits:{wall_seconds:1800,cpu:2,memory_bytes:8589934592,disk_bytes:17179869184,output_bytes:33554432}};

const accountsByDevice=new WeakMap();
let heartbeatSequence=0;
async function advertise(device,circle,key,execution='idle') {
  const client=await device.memberClient(circle,key);
  await client.heartbeat({seq:heartbeatSequence++,intent:{state:'ready',reason:null,until:null},execution:{state:execution,stops_by:null},
    agents:[{adapter:'codex',readiness:'ready',models:[]}],
    capabilities:['designated_member_v1','run_request_v1'],accounts:accountsByDevice.get(device),blockers:[]});
}

function assertNoOwnerJobWrites(w,start){
  assert.equal(w.realRequests.slice(start).some(row=>row.device===w.borrower.app.device.keyId&&row.method==='POST'&&/\/(jobs|cancel|stop-request)$/.test(row.route)),false);
}

test('default send probes an idle member, pins retries, and saves nothing when nobody answers',{timeout:180000},async t=>{
  const w=await members(t),ops=w.ops();
  await advertise(w.lender.app.device,w.circle.id,w.lenderId);
  w.incumbent.down();
  const input={...w.input('Choose the live member'),designated_member:undefined,draftId:'automatic-draft'};
  const sent=await ops.submit(input);
  const store=w.borrower.app.device.intentStore(w.circle.id);
  assert.equal((await store.get('submit:draft:automatic-draft')).payload.designated_member,w.lenderId);
  const {jobHome}=await ops.get({circle:w.circle.id,digest:sent.jobDigest});
  assert.equal(typeof jobHome.origin,'string');assert.notEqual(jobHome.origin,jobHome.ownerOrigin);
  assert.match((await ops.wait({circle:w.circle.id,digest:sent.jobDigest,timeout:0})).waiting_message,/waits for.*Stop/);
  const compose=await api(w.borrower.app,'/api/circles/'+w.circle.id+'/compose');
  assert.equal(compose.host.reachable,false);assert.equal(compose.sendReachable,true);
  const listener=w.lender.app.memberListener.server,handlers=listener.listeners('request');
  listener.removeAllListeners('request');listener.on('request',req=>req.socket.destroy());
  assert.equal((await ops.submit(input)).jobDigest,sent.jobDigest,'completed draft keeps its saved home without probing');
  const before=(await store.entries()).length;
  await assert.rejects(()=>ops.submit({...input,draftId:'nobody-answers',prompt:'Nobody answers'}),/No computer in this circle can be reached right now\./);
  const refused=await api(w.borrower.app,'/api/jobs',{method:'POST',status:409,headers:{'faravan-confirm':'yes'},
    body:{...input,draftId:undefined,draft_id:'nobody-api',prompt:'Nobody answers from the app'}});
  assert.equal(refused.message,'No computer in this circle can be reached right now.');
  assert.equal(refused.action,undefined);
  assert.equal((await store.entries()).length,before);
  listener.removeAllListeners('request');for(const handler of handlers)listener.on('request',handler);
});

test('default send skips the first addressed member while it is running',{timeout:180000},async t=>{
  t.mock.method(Math,'random',()=>0.999);
  const w=await members(t),ops=w.ops();
  const ordered=[w.borrower,w.lender].sort((a,b)=>a.app.device.keyId.localeCompare(b.app.device.keyId));
  for(const [index,member] of ordered.entries())await advertise(member.app.device,w.circle.id,member.app.device.keyId,index===0?'running':'idle');
  const sent=await ops.submit({...w.input('Use the idle second member'),designated_member:undefined});
  const view=await (await w.borrower.app.device.jobReadClient(w.circle.id,sent.jobDigest)).getJob(sent.jobDigest);
  assert.equal(view.job.payload.designated_member,ordered[1].app.device.keyId);
  await advertise(ordered[0].app.device,w.circle.id,ordered[0].app.device.keyId);
  const memberClient=w.borrower.app.device.memberClient.bind(w.borrower.app.device),probes=[];
  w.borrower.app.device.memberClient=async(...args)=>{
    const client=await memberClient(...args),capabilities=client.capabilities.bind(client);
    client.capabilities=async opts=>{
      probes.push(args[1]);
      if(args[1]===ordered[0].app.device.keyId)throw new Error('probe unavailable');
      return capabilities(opts);
    };
    return client;
  };
  const target=await w.borrower.app.device.sendTarget(w.circle.id,{harness:['codex']});
  assert.equal(target.designatedMember,ordered[1].app.device.keyId);
  assert.deepEqual(probes,ordered.map(member=>member.app.device.keyId),'a failed live probe tries the next member');
  w.borrower.app.device.memberClient=memberClient;
  w.incumbent.down();
  const compose=await api(w.borrower.app,'/api/circles/'+w.circle.id+'/compose');
  assert.deepEqual(compose.lenders.map(row=>row.keyId).sort(),ordered.map(member=>member.app.device.keyId));
  let output='';
  const code=await runV1Command(['job','submit','--git','https://github.com/example/app.git@'+'a'.repeat(40),
    '--prompt','CLI chooses a member','--harness','codex','--circle',w.circle.id,'--yes','--json'],
    {device:w.borrower.app.device,home:w.borrower.home,stdout:{write:text=>{output+=text;}},stderr:{write(){}}});
  assert.equal(code,0,output);
  assert.equal((await (await w.borrower.app.device.jobReadClient(w.circle.id,JSON.parse(output).jobDigest)).getJob(JSON.parse(output).jobDigest)).job.payload.designated_member,
    ordered[0].app.device.keyId);
  const input=new PassThrough(),stream=new PassThrough(),messages=[];
  let buffer='';stream.on('data',chunk=>{
    buffer+=chunk;
    for(let at;(at=buffer.indexOf('\n'))>=0;){messages.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}
  });
  const running=runMcpServer({home:w.borrower.home,input,output:stream,autostart:false});
  try{
    input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})+'\n');
    await waitFor(()=>messages.find(row=>row.id===1),'MCP initialization');
    input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'jobs_submit',arguments:{circle:w.circle.id,
      prompt:'MCP chooses a member',noSource:true,result:{kind:'message'},harness:'codex',confirm:true}}})+'\n');
    const response=await waitFor(()=>messages.find(row=>row.id===2),'MCP default send');
    assert.notEqual(response.result?.isError,true,JSON.stringify(response));
    const digest=response.result.structuredContent.jobDigest;
    assert.equal((await (await w.borrower.app.device.jobReadClient(w.circle.id,digest)).getJob(digest)).job.payload.designated_member,ordered[0].app.device.keyId);
  }finally{input.end();await running;}
});

test('default send shuffles idle members with a seeded order',{timeout:180000},async t=>{
  const w=await members(t),device=w.borrower.app.device;
  const ordered=[w.borrower,w.lender].sort((a,b)=>a.app.device.keyId.localeCompare(b.app.device.keyId));
  for(const member of ordered)await advertise(member.app.device,w.circle.id,member.app.device.keyId);
  // Seed 1 of the Park-Miller generator gives a draw below 1/2, swapping two members.
  let seed=1;t.mock.method(Math,'random',()=>((seed=seed*16807%2147483647)-1)/2147483646);
  const target=await device.sendTarget(w.circle.id,{harness:['codex']});
  assert.equal(target.designatedMember,ordered[1].app.device.keyId);
});

test('Stop before any claim avoids that lender for an hour, then allows it again',{timeout:180000},async t=>{
  t.mock.method(Math,'random',()=>0.999);
  const w=await members(t),ops=w.ops(),device=w.borrower.app.device;
  const ordered=[w.borrower,w.lender].sort((a,b)=>a.app.device.keyId.localeCompare(b.app.device.keyId));
  for(const member of ordered)await advertise(member.app.device,w.circle.id,member.app.device.keyId);
  const input=prompt=>({...w.input(prompt),designated_member:undefined});
  const first=await ops.submit(input('First ask'));
  const firstView=await ops.get({circle:w.circle.id,digest:first.jobDigest});
  assert.equal(firstView.current_attempt,null);
  const stopped=await ops.cancel({circle:w.circle.id,digest:first.jobDigest});
  assert.equal(stopped.attempt,null);
  const next=await ops.submit(input('A different ask also avoids the recently stopped lender'));
  const view=await (await device.jobReadClient(w.circle.id,next.jobDigest)).getJob(next.jobDigest);
  assert.equal(view.job.payload.designated_member,ordered[1].app.device.keyId);
  await ops.cancel({circle:w.circle.id,digest:next.jobDigest});
  const fallback=await device.sendTarget(w.circle.id,{harness:['codex']});
  assert.equal(fallback.designatedMember,null,'both excluded: use the owner queue');
  const store=device.intentStore(w.circle.id),slot='cancel:'+first.jobDigest,record=await store.get(slot);
  await store.set(slot,{...record,result:{...record.result,requested_at:iso(seconds()-3601)}});
  const eligible=await device.sendTarget(w.circle.id,{harness:['codex']});
  assert.equal(eligible.designatedMember,ordered[0].app.device.keyId,'an old Stop does not exclude a lender');
});

test('changed folder files download from the member home with the owner offline',{timeout:180000},async t=>{
  const w=await members(t),folder=join(w.f.root,'member-folder');
  await mkdir(folder);await writeFile(join(folder,'notes.txt'),'old\n');
  w.incumbent.down();
  const sent=await api(w.borrower.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:{circle:w.circle.id,repo:{path:folder},
    prompt:'Update notes',harness:'codex',designated_member:w.lenderId,send_anyway:true}});
  const client=await w.lender.app.device.memberClient(w.circle.id,w.lenderId);
  await advertise(w.lender.app.device,w.circle.id,w.lenderId);
  const claim=await client.claimJob(sent.jobDigest,{...w.advertisement,
    capabilities:[...w.advertisement.capabilities,'source_manifest_v1','source_project_name_v1']},{leaseSeconds:120});
  await client.startAttempt(claim.attempt);
  const job=(await client.getJob(sent.jobDigest)).job.payload;
  const patch=Buffer.from('diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n');
  await complete(client,claim.attempt,job,w.lenderId,client,{candidate:patch,mediaType:'text/x-diff'});
  const response=await boundedFetch(w.borrower.app.origin+'/api/jobs/'+sent.jobDigest+'/changed-files?circle='+w.circle.id,
    {headers:{'x-faravan-session-token':w.borrower.app.token}});
  assert.equal(response.status,200,await response.clone().text());
  const zip=Buffer.from(await response.arrayBuffer());
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  const nameLength=zip.readUInt16LE(26),extraLength=zip.readUInt16LE(28),start=30+nameLength+extraLength;
  assert.equal(zip.subarray(30,30+nameLength).toString(),'notes.txt');
  assert.equal(zip.subarray(start,start+zip.readUInt32LE(18)).toString(),'new\n');
});

test('default send uses the shared owner queue when addressed members are busy',{timeout:180000},async t=>{
  const w=await members(t);
  await advertise(w.lender.app.device,w.circle.id,w.lenderId,'running');
  const sent=await w.ops().submit({...w.input('Use the shared queue'),designated_member:undefined});
  const view=await (await w.borrower.app.device.client(w.circle.id)).getJob(sent.jobDigest);
  assert.equal(view.job.payload.designated_member,undefined);
});

test('the fixture records an owner request even when its socket is destroyed',{timeout:180000},async t=>{
  const w=await members(t);
  const client=await w.borrower.app.device.client(w.circle.id);
  w.incumbent.down();const before=w.realRequests.length;
  await assert.rejects(()=>client.cancelJob('sha256:'+'a'.repeat(64)));
  assert.throws(()=>assertNoOwnerJobWrites(w,before),assert.AssertionError);
});

test('no available lender is a queued wait with a plain reason',async()=>{
  const digest='sha256:'+'a'.repeat(64),circle={id:'circle',name:'Friends'};
  const client={getJob:async()=>({job_digest:digest,state:'queued',attempts_started:0,current_attempt:null,
    job:{payload:{requirements:{harness:['codex']}}}}),fetchPresence:async()=>({devices:[]})};
  const device={selectCircle:async()=>circle,intentStore:()=>({list:async()=>[]}),jobReadClient:async()=>client};
  const view=await createJobOperations({device}).wait({circle:circle.id,digest,timeout:0});
  assert.equal(view.state,'queued');assert.equal(view.waiting_reason,'agent_unavailable');
  assert.match(view.waiting_message,/No computer.*lends Codex right now/);
});

async function members(t,{lenderOptions}={}) {
  const f=await appFixture(t);
  const w=await f.realConnect({lenderOptions:lenderOptions?.(f)??{}});
  const {owner,declining:borrower,lender,circle,incumbent}=w;
  const lenderId=lender.app.device.keyId;
  for(const member of [borrower,lender])accountsByDevice.set(member.app.device,syntheticAccountAdvertisement(member.home));
  const claimAdvertisement={...advertisement,capabilities:[...advertisement.capabilities,'run_request_v1'],accounts:accountsByDevice.get(lender.app.device)};
  const origin='http://127.0.0.1:'+(await lender.app.memberListener.start()).port;
  const borrowerOrigin='http://127.0.0.1:'+(await borrower.app.memberListener.start()).port;
  await owner.app.device.setMemberOrigin(circle.id,lenderId,origin);
  await owner.app.device.setMemberOrigin(circle.id,borrower.app.device.keyId,borrowerOrigin);
  await borrower.app.device.refreshRoster(circle.id);await lender.app.device.refreshRoster(circle.id);
  const ops=()=>createJobOperations({device:borrower.app.device,home:borrower.home,clock:seconds});
  const input=prompt=>({circle:circle.id,prompt,git:'https://github.com/example/app.git@'+'a'.repeat(40),
    harness:'codex',send_anyway:true,designated_member:lenderId});
  const rootKey=createPrivateKey(await readFile(join(owner.home,'v1','roots',circle.id+'.pem'),'utf8'));
  return {...w,f,borrower,lenderId,origin,ops,input,rootKey,advertisement:claimAdvertisement};
}

const providerConfiguration={descriptor:{schemaVersion:1,id:'codex',label:'Fixture',signInKind:'api_key',refreshKind:'none',
  usageKind:'job_local',maxConcurrentJobs:1,nativeUnits:[{id:'tokens',scale:1}],models:[{id:'example-model',label:'Example',enabled:true,
    rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
  destinations:[{origin:'https://controlled.invalid',pathPrefixes:['/v1'],methods:['POST']}]},
  identityUrl:'https://controlled.invalid/me',identitySubjectField:'subject',command:'codex',args:['exec'],
  modelFlag:'-m',effortFlag:'--effort',keyEnv:'JOB_KEY',baseUrlEnv:'BASE_URL'};

for(const outcome of ['result','Stop','borrower Stop'])test('the lender app returns '+outcome+' to a non-owner app while every owner request fails',{timeout:180000},async t=>{
  const waitForState=async read=>{
    for(;;){
      t.signal.throwIfAborted();
      const value=await read();
      if(value)return value;
      await delay(25,undefined,{signal:t.signal});
    }
  };
  let signalHold;
  const enteredHold=new Promise(resolve=>{signalHold=resolve;});
  const w=await members(t,{lenderOptions:f=>{
    const backend=syntheticBackend(f.root,{finalMessage:'Finished offline.',captureStream:true});
    backend.prepareAccountRun=async spec=>Object.assign(await backend.prepare(spec),{job_id:spec.job_id,
      sandbox_id:'offline-'+randomUUID(),_cleanupId:randomUUID()});
    backend.inspect=async h=>({job_id:h.job_id,status:'exited'});
    const start=backend.start.bind(backend);
    const held=new Set();
    backend.release=()=>{for(const release of held)release();};
    backend.start=async(h,opts)=>{
      const agent=h._entrypoint.startsWith('env ');
      if(agent){
        const key=/JOB_KEY=([^']+)/.exec(h._entrypoint)?.[1],base=/BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
        const reply=await boundedFetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
          body:JSON.stringify({model:'example-model',effort:'high'})});
        assert.equal(reply.status,200,'the fixture dispatch supplies the model evidence required for completion');
        h._entrypoint='stub-agent';
      }
      const result=await start(h,opts);
      if(agent)await new Promise(resolve=>{
        const release=()=>{held.delete(release);resolve();};
        held.add(release);h._release=release;signalHold();
      });
      return result;
    };
    return {backend,accountProviderConfigurations:[providerConfiguration],
      accountTransportFetch:async(_url,options)=>Response.json(options.method==='GET'?{subject:'offline-fixture'}:
        {id:'fixture-response',object:'response',status:'completed',model:'example-model'})};
  }});
  const post=(path,body)=>api(w.lender.app,path,{method:'POST',body});
  const flow=await post('/api/accounts',{providerId:'codex',label:'Fixture',operationId:'offline-enroll'});
  const account=(await post('/api/accounts/flows/'+flow.value.flowId+'/complete',{answer:'FIXTURE_KEY'})).value;
  const {revision}=await api(w.lender.app,'/api/accounts');
  await post('/api/accounts/'+account.id+'/settings',{expectedRevision:revision,
    modelPreference:{modelId:'example-model',enabled:true,effortIds:null}});
  await post('/api/lending/limits',{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false});
  await post('/api/agents/codex',{useForLending:true});
  await post('/api/lending/mode',{circle:w.circle.id,mode:'auto'});
  await post('/api/lending/on',{circle:w.circle.id});
  await waitForState(async()=>{
    const page=await (await w.lender.app.device.memberClient(w.circle.id,w.lenderId)).fetchPresence();
    return page.devices.some(row=>row.device===w.lenderId&&row.intent?.state==='ready'&&row.execution?.state==='idle'&&row.account_offers?.length);
  });
  w.incumbent.down();
  const requestStart=w.realRequests.length;
  const ops=w.ops(),input={...w.input('App runs with the owner already gone'),git:undefined,noSource:true,result:{kind:'message'},
    designated_member:undefined,harness:'codex',runRequest:{schemaVersion:1,models:[{providerId:'codex',modelId:'example-model'}],effortId:'high'}};
  const submitted=await api(w.borrower.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes'},body:input});
  await w.lender.app.device.probeHost(w.circle.id);
  await enteredHold;
  if(outcome==='result'){
    w.lender.backend.release();
    const done=await waitFor(async()=>{const view=await ops.get({circle:w.circle.id,digest:submitted.jobDigest});
      assert.notEqual(view.state,'failed',JSON.stringify(view));
      return view.state==='result-accepted'&&view;},'app result',30000);
    assert.equal(done.attempts_started,1);
    assert.ok((await ops.fetchResult({circle:w.circle.id,digest:submitted.jobDigest})).length);
    const continuation=await api(w.borrower.app,'/api/jobs/'+submitted.jobDigest+'/continuation?circle='+w.circle.id);
    assert.equal(continuation.parentJob,submitted.jobDigest);
    await waitFor(async()=>!(await api(w.lender.app,'/api/lending')).current,'lender finished settling',30000);
    await w.lender.app.close();
    const database=new DatabaseSync(join(w.lender.home,'v1','member-stores',w.circle.id+'.sqlite'),{readOnly:true});
    let completion;
    try{completion=JSON.parse(database.prepare('SELECT data FROM results WHERE id=?').get(submitted.jobDigest).data).signed.payload;}
    finally{database.close();}
    const reopened=await w.f.start('lender',{accountProviderConfigurations:[providerConfiguration]});
    assert.equal('http://127.0.0.1:'+(await reopened.app.memberListener.start()).port,w.origin);
    const client=await reopened.app.device.memberClient(w.circle.id,w.lenderId);
    const repeated=await client.completeAttempt(done.current_attempt,completion,{idempotencyKey:'restart-result-replay'});
    const recovered=await client.getJob(submitted.jobDigest);
    assert.equal(repeated.result_digest,recovered.result_digest);
    assert.equal(recovered.attempts_started,1,'restart and repeated completion do not create another run');
    assert.equal(reopened.backend.calls.filter(([op])=>op==='run').length,0);
  } else {
    const active=await ops.get({circle:w.circle.id,digest:submitted.jobDigest});
    // Only a cancel sent after this Stop proves this Stop stopped compute.
    const callsBeforeStop=w.lender.backend.calls.length;
    if(outcome==='borrower Stop')assert.equal((await ops.cancel({circle:w.circle.id,digest:submitted.jobDigest})).authority_revoked,true);
    else await post('/api/lending/stop',{attemptId:active.current_attempt.attempt_id,confirmed:true});
    // Borrower Stop is observed on the lender's next lease renewal (30 s).
    // Poll local state while it settles: signed reads every 10 ms can exhaust
    // the member store's nonce budget before that renewal, masking a valid Stop.
    await waitFor(async()=>!(await api(w.lender.app,'/api/lending')).current,'lender finished Stop',90000);
    const stopped=await ops.get({circle:w.circle.id,digest:submitted.jobDigest});
    assert.equal(stopped.current_attempt?.attempt_id,active.current_attempt.attempt_id,'the same attempt was stopped');
    assert.equal(stopped.current_attempt?.compute_stopped,true,'confirmed app Stop');
    assert.ok(w.lender.backend.calls.slice(callsBeforeStop).some(([op])=>op==='cancel'),'this Stop made the backend stop compute');
  }
  assertNoOwnerJobWrites(w,requestStart);
});

async function complete(client,attempt,job,executor,uploader=client,{candidate=resultArchive(),mediaType='application/gzip'}={}) {
  const transcript=Buffer.from('{"synthetic":true}\n');
  const ref=async(bytes,type)=>uploader.uploadArtifact(bytes,type);
  const at=iso(seconds());
  return client.completeAttempt(attempt,{schema:'faravan.result.v1',circle:job.circle,job_digest:p.digest(job),
    attempt_id:attempt.attempt_id,generation:attempt.generation,executor,roster_epoch:job.roster_epoch,submitted_at:at,
    candidate:await ref(candidate,mediaType),transcript:await ref(transcript,'application/x-ndjson'),
    receipt:{schema:'faravan.receipt.v1',self_reported:true,harness:'codex',harness_version:'test',model:attempt.selection.modelId,selection:attempt.selection,
      backend:'synthetic',candidate_format:mediaType==='text/x-diff'?'diff':'tree',...(mediaType==='text/x-diff'?{diffstat:{files:1,insertions:1,deletions:1}}:{}),limits_applied:job.requirements.limits,egress_applied:job.requirements.egress,
      capabilities_applied:job.requirements.capabilities,started_at:at,finished_at:at,duration_ms:0,source:job.source}});
}

test('two non-owner apps send, claim, start, renew, read a result and Stop with the owner unreachable before send',{timeout:180000},async t=>{
  const w=await members(t),{borrower,lender,circle,lenderId,incumbent}=w;
  incumbent.down();
  const ops=w.ops(),submitted=await ops.submit(w.input('Owner offline from the first send'));
  const borrowerClient=await borrower.app.device.memberClient(circle.id,lenderId);
  const lenderClient=await lender.app.device.lendingClient(circle.id);
  await advertise(lender.app.device,circle.id,lenderId);
  const jobs=[];for await(const job of lenderClient.listOffers({waitSeconds:0}))jobs.push(job);
  assert.ok(jobs.some(job=>job.job_digest===submitted.jobDigest));
  await assert.rejects(()=>borrowerClient.claimJob(submitted.jobDigest,w.advertisement),e=>e.code==='not_designated');
  const claim=await lenderClient.claimJob(submitted.jobDigest,w.advertisement,{leaseSeconds:120});
  assert.equal(claim.attempt.holder,lenderId);
  await assert.rejects(()=>borrowerClient.claimJob(submitted.jobDigest,w.advertisement),e=>['not_designated','conflict'].includes(e.code));
  await lenderClient.startAttempt(claim.attempt);
  await lenderClient.renew(claim.attempt,{leaseSeconds:120});
  const view=await borrowerClient.getJob(submitted.jobDigest);
  const ack=await complete(lenderClient,claim.attempt,view.job.payload,lenderId,await lender.app.device.memberClient(circle.id,lenderId));
  assert.equal(ack.status,'result-accepted');
  assert.equal((await ops.get({circle:circle.id,digest:submitted.jobDigest})).state,'result-accepted');
  assert.ok((await ops.fetchResult({circle:circle.id,digest:submitted.jobDigest})).length);

  const stop=await ops.submit(w.input('Stop at the home'));
  // A new pool session discovers the same home and persists its attempt route before claiming.
  const restarted=await lender.app.device.lendingClient(circle.id);
  for await(const _ of restarted.listOffers({waitSeconds:0})){}
  const active=await restarted.claimJob(stop.jobDigest,w.advertisement,{leaseSeconds:120});
  await restarted.startAttempt(active.attempt);
  const requested=await restarted.requestStop(active.attempt);
  assert.equal(requested.attempt_id,active.attempt.attempt_id);
  assert.equal((await restarted.getStopRequest(active.attempt)).attempt_id,active.attempt.attempt_id);
  await restarted.release(active.attempt,'stopped_by_lender');
  const stopped=await restarted.stopped(active.attempt,{stoppedAt:iso(seconds())});
  assert.equal(stopped.compute_stopped,true);
  assert.equal((await borrowerClient.getJob(stop.jobDigest)).current_attempt.compute_stopped,true);
});

test('borrower cancellation reaches the saved home; an unavailable home leaves cancellation pending',{timeout:180000},async t=>{
  const w=await members(t),ops=w.ops();
  w.incumbent.down();
  const sent=await ops.submit(w.input('Cancel through the saved signed home'));
  await w.borrower.app.device.intentStore(w.circle.id).delete('job:'+sent.jobDigest);
  const result=await ops.cancel({circle:w.circle.id,digest:sent.jobDigest});
  assert.equal(result.authority_revoked,true);
  assert.equal((await ops.get({circle:w.circle.id,digest:sent.jobDigest})).state,'cancelled');
  const draft={...w.input('A draft fixes its home'),draftId:'fixed-home-draft'};
  await ops.submit(draft);
  await assert.rejects(()=>ops.submit({...draft,designated_member:w.borrower.app.device.keyId}),e=>e.code==='draft_changed');
  const ask=w.input('The same text for a different home is a different request');
  const atLender=await ops.submit(ask),store=w.borrower.app.device.intentStore(w.circle.id);
  const [savedSlot,saved]=(await store.entries()).find(([,row])=>row.kind==='submit'&&row.jobDigest===atLender.jobDigest);
  // Reproduce the slot format written before designated members were part of request identity.
  const oldSlot='submit:'+p.digest({source:saved.payload.source,prompt:saved.payload.prompt.digest,
    harness:ask.harness,model:null,egress:saved.payload.requirements.egress});
  await store.set(oldSlot,saved);await store.delete(savedSlot);
  assert.equal((await ops.submit(ask)).jobDigest,atLender.jobDigest,'an older saved send still replays its signed home');
  const atBorrower=await ops.submit({...ask,designated_member:w.borrower.app.device.keyId});
  assert.notEqual(atLender.jobDigest,atBorrower.jobDigest);
  const next=await ops.submit(w.input('Home unreachable when cancelling'));
  const listener=w.lender.app.memberListener.server,handlers=listener.listeners('request');
  listener.removeAllListeners('request');listener.on('request',(req)=>req.socket.destroy());
  const waiting=await api(w.borrower.app,'/api/jobs/'+next.jobDigest+'/cancel',{method:'POST',body:{circle:w.circle.id}});
  assert.equal(waiting.state,'pending');
  assert.equal(waiting.authority_revoked,false);assert.equal(waiting.compute_stopped,false);
  assert.match(waiting.message,/stop.*pending/i);
  const intent=await w.borrower.app.device.intentStore(w.circle.id).get('cancel:'+next.jobDigest);
  assert.equal(intent.state,'pending');assert.equal(intent.result,undefined);
  listener.removeAllListeners('request');for(const handler of handlers)listener.on('request',handler);
  await ops.recoverPending();
  assert.equal((await w.borrower.app.device.intentStore(w.circle.id).get('cancel:'+next.jobDigest)).state,'complete');
});

test('a pending send with a lost acknowledgement recovers after borrower restart at the same home',{timeout:180000},async t=>{
  const w=await members(t),ops=w.ops();
  w.incumbent.down();
  let drop=true;const sends=[];
  w.lender.app.memberListener.server.prependListener('request',(req,res)=>{
    if(req.method!=='POST'||!req.url.endsWith('/jobs'))return;
    const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload;
    sends.push({body:proof.body_digest,key:req.headers['idempotency-key']});
    const end=res.end.bind(res);
    res.end=(...args)=>drop&&res.statusCode>=200&&res.statusCode<300?(res.destroy(),res):end(...args);
  });
  await assert.rejects(()=>ops.submit(w.input('Recover the original signed intent')),e=>e.code==='network_error');
  const store=w.borrower.app.device.intentStore(w.circle.id);
  const [slot,pending]=(await store.entries()).find(([,row])=>row.kind==='submit'&&row.state==='pending');
  assert.ok(pending);assert.equal(pending.payload.designated_member,w.lenderId);
  drop=false;
  await w.borrower.app.close();
  const restarted=await w.f.start('declining');
  const recovered=createJobOperations({device:restarted.app.device,home:restarted.home,clock:seconds});
  await recovered.recoverPending();
  const saved=await restarted.app.device.intentStore(w.circle.id).get(slot);
  assert.equal(saved.state,'complete');
  assert.ok(sends.length>1);for(const send of sends)assert.deepEqual(send,sends[0]);
  assert.equal((await recovered.get({circle:w.circle.id,digest:pending.jobDigest})).state,'queued');
});

test('cached member membership expires and a superseded roster removes access without an owner confirmation',{timeout:180000},async t=>{
  const w=await members(t),{circle,borrower,lender,rootKey}=w;
  const cache=borrower.app.device.rosterCache(circle.id),before=await cache.get();
  w.incumbent.down();
  const receipt=borrower.app.device.rosterReceipt(circle.id);
  const client=await borrower.app.device.memberClient(circle.id,w.lenderId);
  await client.refreshRoster();
  assert.deepEqual(borrower.app.device.rosterReceipt(circle.id),receipt,'equal epoch from a peer is no owner confirmation');
  const expired=p.signEnvelope('roster',{...before.current.payload,epoch:before.current.payload.epoch+1,
    issued_at:iso(seconds()-86400*2),valid_until:iso(seconds()-86400)},rootKey);
  const snapshot=current=>({current,history:[before.current],highestAcceptedEpoch:current.payload.epoch,highestAcceptedDigest:p.digest(current.payload)});
  await cache.set(snapshot(expired));
  await assert.rejects(()=>w.ops().submit(w.input('Expired membership')),e=>e.code==='roster_expired');
  const remaining=before.current.payload.members.filter(m=>m.key_id!==borrower.app.device.keyId);
  const removed=p.signEnvelope('roster',{...before.current.payload,epoch:expired.payload.epoch+1,members:remaining,
    governance:{...before.current.payload.governance,people:before.current.payload.governance.people.filter(person=>
      remaining.some(member=>p.personIdFor(member)===person.person_id))}},rootKey);
  await lender.app.device.rosterCache(circle.id).set(snapshot(removed));
  await assert.rejects(()=>client.uploadArtifact(Buffer.from('removed'),'text/plain'),e=>['not_member','forbidden'].includes(e.code));
});

test('an expired member cache refreshes from a reachable owner before sending',{timeout:180000},async t=>{
  const w=await members(t),cache=w.borrower.app.device.rosterCache(w.circle.id),before=await cache.get();
  await w.borrower.app.close();
  const expired=p.signEnvelope('roster',{...before.current.payload,epoch:before.current.payload.epoch+1,
    issued_at:iso(seconds()-172800),valid_until:iso(seconds()-86400)},w.rootKey);
  await cache.set({...before,current:expired,highestAcceptedEpoch:expired.payload.epoch,highestAcceptedDigest:p.digest(expired.payload)});
  await w.owner.app.device.setMemberOrigin(w.circle.id,w.lenderId,w.origin);
  await w.owner.app.device.setMemberOrigin(w.circle.id,w.lenderId,w.origin);
  await w.lender.app.device.refreshRoster(w.circle.id);
  const sent=await w.ops().submit(w.input('Refresh membership before sending'));
  assert.ok(sent.jobDigest);
  assert.ok((await cache.get()).current.payload.epoch>expired.payload.epoch);
});
