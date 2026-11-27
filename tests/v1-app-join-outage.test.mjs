import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {appFixture,api,boundedFetch,waitFor} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';
import * as protocol from '../lib/protocol/index.mjs';
import {resolveJoinLink} from '../lib/v1/short-invite.mjs';

function enrollmentTransport(mode, keys) {
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/enrollments') && options.method === 'POST') {
      keys.push(options.headers?.['Idempotency-Key']);
      if (mode.value === 'down') throw new TypeError('synthetic host outage before transport');
      const response = await boundedFetch(url, options);
      if (mode.value === 'drop-response') {
        await response.arrayBuffer();
        throw new TypeError('synthetic response loss after host acceptance');
      }
      return response;
    }
    return boundedFetch(url, options);
  };
}

function recordingEnrollmentTransport(mode, requests) {
  return async (url, options = {}) => {
    if (new URL(url).pathname.endsWith('/enrollments') && options.method === 'POST') {
      const text = typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8');
      const body = JSON.parse(text);
      const attempt = {inviteId: body.invite.payload.invite_id, key: options.headers?.['Idempotency-Key']};
      if (mode.value === 'down') {
        requests.push({...attempt, status: 'offline'});
        throw new TypeError('synthetic host outage before transport');
      }
      const response = await boundedFetch(url, options);
      let code;
      if (!response.ok) {try {code = (await response.clone().json()).code;} catch {}}
      requests.push({...attempt, status: response.status, code});
      return response;
    }
    return boundedFetch(url, options);
  };
}

async function joinRequest(joiner, invite) {
  return boundedFetch(joiner.app.origin + '/api/circles/join', {
    method:'POST',
    headers:{'x-faravan-session-token':joiner.app.token,'content-type':'application/json'},
    body:JSON.stringify({link:invite}),
  });
}

function dedupeHostEnrollments(f) {
  let received=0;
  const seen=new Map(),previous=f.override;
  f.override=async details=>{
    if(details.route==='/enrollments'&&details.req.method==='POST') {
      received++;
      const key=details.req.headers['idempotency-key'];
      const request={circleId:details.circleId,inviteId:details.body.invite.payload.invite_id,
        deviceKeyId:JSON.parse(Buffer.from(details.req.headers['faravan-proof'],'base64url')).payload.key_id,
        body:protocol.canonicalize(details.body)};
      const prior=seen.get(key);
      if(prior) {
        assert.deepEqual(prior,request);
        const hostCircle=f.circles.get(details.circleId);
        const enrollment=hostCircle?.enrollments.find(item=>item.invite_id===request.inviteId&&item.device_key_id===request.deviceKeyId);
        assert.ok(enrollment,'a replay returns the original enrollment');
        json(details.res,{enrollment_id:enrollment.enrollment_id,state:enrollment.state,
          device_key_id:enrollment.device_key_id,roster:hostCircle.roster.payload.members.some(member=>member.key_id===enrollment.device_key_id)?hostCircle.roster:null},201);
        return true;
      }
      seen.set(key,request);
    }
    return previous(details);
  };
  return ()=>received;
}

test('join intent survives an outage and replays the same idempotency key without phantom approval', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const hostEnrollmentPosts=dedupeHostEnrollments(f);

  const owner = await f.start('owner',{autoApprove:false,pollMs:250});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Join outage recovery'}});
  await api(owner.app,'/api/circles/'+circle.id+'/approval-mode',{method:'POST',body:{approveEach:true}});
  const {invite} = await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});

  const mode = {value:'down'},keys=[];
  const fetch = enrollmentTransport(mode,keys);
  let joiner = await f.start('joiner',{fetch,autoApprove:false});
  const first = await joinRequest(joiner,invite);
  assert.equal(first.status,409);
  const firstProblem = await first.json();
  assert.equal(hostEnrollmentPosts(),0,'the failed request never reaches the host');
  assert.deepEqual(await api(owner.app,'/api/circles/'+circle.id+'/approvals'),[]);

  const afterOutage = (await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id);
  assert.equal(afterOutage.membershipProjection.phase,'unknown');
  assert.equal(firstProblem.code,'network_error');
  assert.equal(firstProblem.outcome,'unknown');
  assert.equal(afterOutage.joinIntent.outcome,'unknown');
  assert.ok(afterOutage.joinIntent.createdAt);
  assert.equal(JSON.stringify(afterOutage).includes(invite),false,'the reusable invite is never exposed');
  assert.equal(Object.hasOwn(afterOutage.joinIntent,'idempotencyKey'),false);
  assert.equal(JSON.parse((await f.cli(['circle','list','--json'],'joiner')).stdout)
    .find(item=>item.id===circle.id).membershipProjection.phase,'unknown');
  assert.equal((await api(joiner.app,'/api/ops/circles.list',{method:'POST',body:{}}))
    .find(item=>item.id===circle.id).membershipProjection.phase,'unknown');
  const circleOperation=await api(joiner.app,'/api/ops/circles.list');
  assert.deepEqual(circleOperation.output.items.properties.membershipProjection.properties.phase.enum,
    ['approved','pending','expired','rejected','unknown']);

  await joiner.app.close();
  mode.value='drop-response';
  joiner = await f.start('joiner',{fetch,autoApprove:false});
  const afterRestart = (await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id);
  assert.equal(afterRestart.membershipProjection.phase,'unknown');
  assert.equal(afterRestart.joinIntent.createdAt,afterOutage.joinIntent.createdAt);

  const retry = await joinRequest(joiner,invite);
  assert.equal(retry.status,409,'host accepted the request, but the response was lost');
  assert.equal((await retry.json()).outcome,'unknown');
  assert.equal(hostEnrollmentPosts(),4,'the client retried a lost response with one stable key');
  const afterLostResponse = (await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id);
  assert.equal(afterLostResponse.membershipProjection.phase,'unknown');
  assert.equal(afterLostResponse.joinIntent.outcome,'unknown');
  assert.equal((await api(owner.app,'/api/circles/'+circle.id+'/approvals')).length,1);

  mode.value='pass';
  const checked = await api(joiner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal(checked.state,'pending');
  assert.equal(hostEnrollmentPosts(),5,'Check approval resumes the saved enrollment intent with the same key');
  assert.ok(keys.length>=9);
  assert.ok(keys.every(key=>key===keys[0]&&typeof key==='string'));
  assert.equal((await api(owner.app,'/api/circles/'+circle.id+'/approvals')).length,1,'host replay did not create a duplicate');
  assert.equal((await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id).membershipProjection.phase,'pending');

  const repeated = await joinRequest(joiner,invite);
  assert.equal(repeated.status,200);
  await repeated.arrayBuffer();
  assert.equal(hostEnrollmentPosts(),5,'retrying an existing enrollment does not send a new request');
  const pending = await api(owner.app,'/api/circles/'+circle.id+'/approvals');
  assert.equal(pending.length,1);
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{enrollmentId:pending[0].enrollment_id}});
  const approved = await api(joiner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal(approved.state,'approved');
  assert.equal(approved.membershipProjection.phase,'approved');
  assert.equal((await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id).membershipProjection.phase,'approved');
});

test('background sweep resumes an unknown join intent when the host returns', {timeout:60000}, async t => {
  const f = await appFixture(t);
  dedupeHostEnrollments(f);
  const owner = await f.start('owner',{autoApprove:false,pollMs:250});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Join sweep recovery'}});
  const {invite} = await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const mode = {value:'down'},keys=[];
  const joiner = await f.start('joiner',{fetch:enrollmentTransport(mode,keys),autoApprove:true,approvalPollMs:50});
  const first = await joinRequest(joiner,invite);
  assert.equal(first.status,409);
  await first.arrayBuffer();
  assert.equal((await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id).membershipProjection.phase,'unknown');

  mode.value='pass';
  await waitFor(async()=>{
    const item=(await api(joiner.app,'/api/circles')).find(value=>value.id===circle.id);
    return item?.enrollment?.state==='pending'&&item.joinIntent==null;
  },'background join-intent retry');
  assert.ok(keys.length>=2);
  assert.ok(keys.every(key=>key===keys[0]&&typeof key==='string'));
  assert.equal((await api(owner.app,'/api/circles/'+circle.id+'/approvals')).length,1);
  assert.equal((await api(joiner.app,'/api/circles')).find(item=>item.id===circle.id).membershipProjection.phase,'pending');
});

test('restarting a custom-name join replays the exact enrollment body with the same key', {timeout:60000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f);
  const owner=await f.start('owner',{autoApprove:false,pollMs:250});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Stable replay body'}});
  await api(owner.app,'/api/circles/'+circle.id+'/approval-mode',{method:'POST',body:{approveEach:true}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const mode={value:'drop-response'},keys=[],fetch=enrollmentTransport(mode,keys);
  let joiner=await f.start('joiner',{fetch,autoApprove:false,joinWaitMs:0});

  await assert.rejects(joiner.app.device.joinCircle(invite,{deviceName:'Original laptop',waitMs:0}),error=>
    error.code==='network_error'&&error.outcome==='unknown');
  const intent=await joiner.app.device.intentStore(circle.id).get('join-enrollment');
  assert.equal(intent.deviceName,'Original laptop');
  const firstPosts=hostEnrollmentPosts();
  assert.ok(firstPosts>=1);
  await joiner.app.close();

  mode.value='pass';
  joiner=await f.start('joiner',{fetch,autoApprove:false,joinWaitMs:0});
  const replay=await joiner.app.device.resumeJoin(circle.id,{deviceName:'Renamed laptop'});
  assert.equal(replay.enrollment.state,'pending');
  assert.equal(hostEnrollmentPosts(),firstPosts+1);
  assert.ok(keys.every(key=>key===keys[0]&&typeof key==='string'));
  assert.equal((await api(owner.app,'/api/circles/'+circle.id+'/approvals')).length,1);
});

test('a private join intent written before circle visibility is recovered after restart', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const hostEnrollmentPosts=dedupeHostEnrollments(f);
  const owner = await f.start('owner',{autoApprove:false,pollMs:250});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Orphaned join recovery'}});
  await api(owner.app,'/api/circles/'+circle.id+'/approval-mode',{method:'POST',body:{approveEach:true}});
  const {invite} = await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const fullInvite=await resolveJoinLink(invite,{fetch:boundedFetch});
  const decoded=protocol.decodeInviteLink(fullInvite);
  assert.equal(decoded.ok,true);
  const payload=decoded.invite.payload;
  const mode={value:'down'},keys=[],fetch=enrollmentTransport(mode,keys);
  let joiner=await f.start('joiner',{fetch,autoApprove:true,approvalPollMs:50,joinWaitMs:0});
  assert.equal((await joiner.app.device.listCircles()).some(item=>item.id===circle.id),false);
  const keyId=joiner.app.device.keyId;
  await joiner.app.device.intentStore(circle.id).set('join-enrollment',{
    kind:'join-enrollment',invite:fullInvite,inviteId:payload.invite_id,
    idempotencyKey:payload.invite_id+'-'+keyId.slice(7,23),createdAt:new Date().toISOString(),lastAttemptAt:null,
    outcome:'unknown',joinInfo:{inviteId:payload.invite_id,approval:'each',ownerName:payload.owner_name??null,
      code:joiner.app.device.matchCode(keyId),role:payload.role??'lend'},
  });
  await joiner.app.close();

  joiner=await f.start('joiner',{fetch,autoApprove:true,approvalPollMs:50,joinWaitMs:0});
  await waitFor(async()=>{
    const item=(await api(joiner.app,'/api/circles')).find(value=>value.id===circle.id);
    return item?.membershipProjection.phase==='unknown'&&item?.joinIntent?.outcome==='unknown';
  },'orphaned join intent restored before host returns');
  assert.equal(hostEnrollmentPosts(),0,'the first recovery attempt still fails before transport');

  mode.value='pass';
  await waitFor(async()=>(await api(owner.app,'/api/circles/'+circle.id+'/approvals')).length===1,
    'background sweep resumes the orphaned intent');
  assert.ok(keys.length>=2);
  assert.ok(keys.every(key=>key===keys[0]&&typeof key==='string'));
  const repeated=await joinRequest(joiner,invite);
  assert.equal(repeated.status,200);
  await repeated.arrayBuffer();
  assert.equal(hostEnrollmentPosts(),1,'same invite does not create a second enrollment');
  const [pending]=await api(owner.app,'/api/circles/'+circle.id+'/approvals');
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{enrollmentId:pending.enrollment_id}});
  const approved=await api(joiner.app,'/api/circles/'+circle.id+'/check',{method:'POST',body:{}});
  assert.equal(approved.membershipProjection.phase,'approved');
});

test('same-invite CLI retry refreshes approval without another enrollment POST', {timeout:120000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f);
  const owner=await f.start('owner',{pollMs:250});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Retry sees approval'}});
  await api(owner.app,'/api/circles/'+circle.id+'/approval-mode',{method:'POST',body:{approveEach:true}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  await f.start('joiner',{autoApprove:false,pollMs:60000});

  const first=await f.cli(['circle','join',invite,'--json'],'joiner');
  assert.equal(first.code,0,first.stderr);
  assert.equal(JSON.parse(first.stdout).membershipProjection.phase,'pending');
  const [pending]=await api(owner.app,'/api/circles/'+circle.id+'/approvals');
  assert.ok(pending);
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{enrollmentId:pending.enrollment_id}});
  const postsAfterApproval=hostEnrollmentPosts();
  assert.equal(postsAfterApproval,1);

  // The joiner has no approval sweep enabled, and there is no Check between approval and this CLI retry.
  const retry=await f.cli(['circle','join',invite,'--json'],'joiner');
  assert.equal(retry.code,0,retry.stderr);
  assert.equal(JSON.parse(retry.stdout).membershipProjection.phase,'approved');
  assert.equal(hostEnrollmentPosts(),postsAfterApproval,'a same-invite retry refreshes the roster without another POST');
});

test('a new invite reconciles an expired unknown join before starting its own join', {timeout:120000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f),requests=[];
  const owner=await f.start('owner',{autoApprove:false,pollMs:60000});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Reconcile before replacing'}});
  const expiresAt=Math.floor(Date.now()/1000)+5;
  const inviteA=await owner.app.device.createInvite(circle.id,{expires_at:new Date(expiresAt*1000).toISOString().replace('.000Z','Z')});
  const inviteB=await owner.app.device.createInvite(circle.id);
  const [longInviteA,longInviteB]=await Promise.all([
    resolveJoinLink(inviteA,{fetch:boundedFetch}),resolveJoinLink(inviteB,{fetch:boundedFetch}),
  ]);
  const mode={value:'down'};
  const joiner=await f.start('joiner',{autoApprove:false,pollMs:60000,clientOptions:{retry:{maxAttempts:1}},
    fetch:recordingEnrollmentTransport(mode,requests)});

  const first=await joinRequest(joiner,inviteA);
  assert.equal(first.status,409);
  await first.arrayBuffer();
  assert.equal((await joiner.app.device.intentStore(circle.id).get('join-enrollment'))?.outcome,'unknown');
  assert.equal(hostEnrollmentPosts(),0,'the first attempt fails before reaching the host');
  await new Promise(done=>setTimeout(done,Math.max(0,(expiresAt+1)*1000-Date.now())));

  mode.value='pass';
  const second=await joinRequest(joiner,inviteB);
  const secondBody=await second.text();
  assert.equal(second.status,200,secondBody);
  assert.deepEqual(requests.map(request=>request.inviteId),[
    protocol.decodeInviteLink(longInviteA).invite.payload.invite_id,
    protocol.decodeInviteLink(longInviteA).invite.payload.invite_id,
    protocol.decodeInviteLink(longInviteB).invite.payload.invite_id,
  ]);
  assert.equal(requests[0].status,'offline');
  assert.ok(requests[1].status>=400,'the host gives a definitive answer for expired A before B is sent: '+JSON.stringify(requests[1]));
  assert.ok(requests[2].status<400,'the new invite B is accepted after A is reconciled');
  assert.equal(requests[1].key,requests[0].key,'replaying A keeps its idempotency key');
  assert.notEqual(requests[2].key,requests[1].key,'B uses its own idempotency key');
  assert.equal(hostEnrollmentPosts(),2,'the host sees expired A, then B');
});

test('a direct retry of an expired saved invite reaches the host for a definitive answer', {timeout:120000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f),requests=[];
  const owner=await f.start('owner',{autoApprove:false,pollMs:60000});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Retry expired saved invite'}});
  const expiresAt=Math.floor(Date.now()/1000)+5;
  const invite=await owner.app.device.createInvite(circle.id,{expires_at:new Date(expiresAt*1000).toISOString().replace('.000Z','Z')});
  const longInvite=await resolveJoinLink(invite,{fetch:boundedFetch});
  const mode={value:'down'};
  const joiner=await f.start('joiner',{autoApprove:false,pollMs:60000,clientOptions:{retry:{maxAttempts:1}},
    fetch:recordingEnrollmentTransport(mode,requests)});

  const first=await joinRequest(joiner,invite);
  assert.equal(first.status,409);
  await first.arrayBuffer();
  await new Promise(done=>setTimeout(done,Math.max(0,(expiresAt+1)*1000-Date.now())));
  mode.value='pass';
  const retry=await joinRequest(joiner,invite);
  const retryBody=await retry.text();
  assert.ok(retry.status>=400,'the host rejects the expired invitation: '+retry.status+' '+retryBody);
  assert.equal(requests.length,2,'the expired saved invite is replayed instead of being rejected locally');
  assert.equal(requests[1].inviteId,protocol.decodeInviteLink(longInvite).invite.payload.invite_id);
  assert.ok(requests[1].status>=400);
  assert.equal(requests[1].key,requests[0].key,'the direct retry uses the original idempotency key');
  assert.equal((await joiner.app.device.intentStore(circle.id).get('join-enrollment'))?.outcome,'not_applied');
  assert.equal(hostEnrollmentPosts(),1);
});

test('leaving an unknown join prevents its intent from restoring the circle after restart', {timeout:120000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f),requests=[];
  const owner=await f.start('owner',{autoApprove:false,pollMs:60000});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Leave unknown join'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const mode={value:'down'},fetch=recordingEnrollmentTransport(mode,requests);
  let joiner=await f.start('joiner',{autoApprove:false,pollMs:60000,clientOptions:{retry:{maxAttempts:1}},fetch});
  const first=await joinRequest(joiner,invite);
  assert.equal(first.status,409);
  await first.arrayBuffer();
  assert.equal(hostEnrollmentPosts(),0,'the host did not accept the join');

  await joiner.app.device.leaveCircle(circle.id,{requestLeave:false});
  const attemptsBeforeRestart=requests.length;
  await joiner.app.close();
  mode.value='pass';
  joiner=await f.start('joiner',{autoApprove:false,pollMs:10,clientOptions:{retry:{maxAttempts:1}},fetch});
  await new Promise(done=>setTimeout(done,250));

  const circles=await api(joiner.app,'/api/circles');
  assert.equal(circles.some(item=>item.id===circle.id),false,'the left circle stays absent after startup recovery');
  assert.equal(requests.length,attemptsBeforeRestart,'startup does not retry the abandoned enrollment');
  assert.equal(hostEnrollmentPosts(),0,'the abandoned join never reaches the host after restart');
});

test('startup recovery does not restore an intent after a concurrent leave', {timeout:120000}, async t => {
  const f=await appFixture(t),hostEnrollmentPosts=dedupeHostEnrollments(f),requests=[];
  const owner=await f.start('owner',{autoApprove:false,pollMs:60000});
  await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Leave during recovery'}});
  const {invite}=await api(owner.app,'/api/circles/'+circle.id+'/invite',{method:'POST',body:{}});
  const mode={value:'down'},fetch=recordingEnrollmentTransport(mode,requests);
  const joiner=await f.start('joiner',{autoApprove:false,pollMs:60000,clientOptions:{retry:{maxAttempts:1}},fetch});
  const first=await joinRequest(joiner,invite);
  assert.equal(first.status,409);
  await first.arrayBuffer();
  assert.equal((await joiner.app.device.intentStore(circle.id).get('join-enrollment'))?.outcome,'unknown');

  const barrier=new SharedArrayBuffer(4),worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {openDevice}=await import(workerData.deviceURL);
      let paused=false;
      const device=await openDevice({home:workerData.home,ensureDefault:false,clock:()=>{
        if(!paused){paused=true;parentPort.postMessage({paused:true});Atomics.wait(new Int32Array(workerData.barrier),0,0);}
        return Math.floor(Date.now()/1000);
      }});
      parentPort.postMessage({done:true,circles:await device.listCircles()});
    })().catch(error=>parentPort.postMessage({fatal:error.stack}));
  `,{eval:true,workerData:{deviceURL:new URL('../lib/v1/device.mjs',import.meta.url).href,home:joiner.home,barrier}});
  const nextMessage=()=>new Promise((resolve,reject)=>{
    const cleanup=()=>{worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);};
    const onMessage=message=>{cleanup();if(message.fatal)reject(new Error(message.fatal));else resolve(message);};
    const onError=error=>{cleanup();reject(error);};
    const onExit=code=>{cleanup();reject(new Error('recovery worker exited before its next message: '+code));};
    worker.once('message',onMessage);worker.once('error',onError);worker.once('exit',onExit);
  });
  t.after(async()=>{Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);await worker.terminate();});

  assert.deepEqual(await nextMessage(),{paused:true},'recovery pauses after reading the saved intent and before taking the state lock');
  await joiner.app.device.leaveCircle(circle.id,{requestLeave:false});
  assert.equal(await joiner.app.device.intentStore(circle.id).get('join-enrollment'),null);
  assert.equal((await joiner.app.device.listCircles()).some(item=>item.id===circle.id),false);
  const attemptsAfterLeave=requests.length;
  await joiner.app.close();

  const resumed=nextMessage();
  Atomics.store(new Int32Array(barrier),0,1);
  Atomics.notify(new Int32Array(barrier),0);
  const result=await resumed;
  assert.equal(result.done,true);
  assert.equal(result.circles.some(item=>item.id===circle.id),false,'startup re-reads the intent after acquiring the join lock');
  assert.equal(requests.length,attemptsAfterLeave,'recovery does not retry the abandoned enrollment');
  assert.equal(hostEnrollmentPosts(),0,'the abandoned join never reaches the host');
});
