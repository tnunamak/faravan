import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as p from '../lib/protocol/index.mjs';
import { provisionV1Store, openV1Store } from '../lib/v1/store.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { startCoordinator } from '../lib/coordinator.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createCirclesRouter } from '../lib/v1/circles-router.mjs';

// R1: two circles on one origin. Keys are the TEST-ONLY golden keys.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pubs = keys.map(p.exportPublicKey), ids = pubs.map(p.fingerprint);
const base = golden.objects.roster.envelope.payload;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');

async function freePort() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise(r => server.close(r)); return port;
}
function roster(circle) {
  const t = Math.floor(Date.now() / 1000);
  return p.signEnvelope('roster', { ...base, circle, epoch: 1, issued_at: iso(t - 60), valid_until: iso(t + 7 * 86400),
    members: base.members.map(m => ({ ...m, joined_epoch: 1 })) }, keys[2]);
}
async function twoCircles(t, quotasB, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-circles-'));
  let router,server;const requests=[];
  t.after(async () => { router?.close();server?.closeAllConnections?.(); if(server?.listening)await new Promise(r => server.close(r));
    if(router)await eventually(()=>(router.pendingRequests??0)===0&&(router.pendingPolls??0)===0&&router.pendingDownloads===0&&router.pendingEnrollmentBodies===0&&router.pendingRosterRecoveries===0,'router failed to drain');
    await new Promise(setImmediate);router?.dispose();rmSync(dir, { recursive: true, force: true }); });
  if(options.limits){
    server=createServer((req,res)=>{requests.push(req);if(router)return router(req,res);res.writeHead(503);res.end();});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
  }
  const port=server?server.address().port:await freePort(),origin='http://127.0.0.1:'+port;
  const A = randomUUID(), B = randomUUID(), circlesDir = join(dir, 'circles');
  for (const [id, quotas] of [[A, undefined], [B, quotasB]]) {
    mkdirSync(join(circlesDir, id), { recursive: true });
    provisionV1Store({ path: join(circlesDir, id, 'coordinator.sqlite'),
      provisioning: { circle_id: id, origin, root_fingerprint: ids[2], roster: roster(id), ...(quotas ? { quotas } : {}) } });
  }
  options.beforeStart?.({A,B,circlesDir,dir,origin});
  if(options.limits) {
    router=createCirclesRouter({circlesDir,origin,limits:options.limits,clock:options.clock,legacy:options.legacy});
  } else server = await startCoordinator({ port, v1: { circlesDir, origin } });
  const client = (circle, index) => {
    const r = roster(circle);
    let saved = { current: r, history: [], highestAcceptedEpoch: 1, highestAcceptedDigest: p.digest(r.payload) };
    return createClient({ origin, circle, deviceKey: keys[index], pinnedRootFingerprint: ids[2],
      rosterCache: { get: async () => saved, set: async v => { saved = v; } }, retry: { maxAttempts: 1 } });
  };
  const signed=(circle,index,method,route,body,epoch=1)=>{
    const bytes=body===undefined?Buffer.alloc(0):Buffer.from(p.canonicalize(body));
    const contentType=method==='GET'?'':'application/json',key=method==='POST'?randomUUID():'';
    const headers={'Faravan-Proof':p.buildRequestProof({circle,roster_epoch:epoch,method,
      target:origin+'/v1/circles/'+circle+route,body:bytes,content_type:contentType,artifact_media_type:'',idempotency_key:key,
      created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},keys[index])};
    if(contentType){headers['Content-Type']=contentType;headers['Content-Length']=String(bytes.length);}
    if(key)headers['Idempotency-Key']=key;
    return {method,headers,...(body===undefined?{}:{body:bytes})};
  };
  const restart=()=>{
    router.close();router.dispose();
    router=createCirclesRouter({circlesDir,origin,limits:options.limits??{},clock:options.clock,legacy:options.legacy});
  };
  return { A, B, origin, circlesDir, client, get router(){return router;}, requests, signed, restart };
}
const job = async (client, circle) => {
  const now = Math.floor(Date.now() / 1000);
  return { ...structuredClone(golden.objects.job.envelope.payload), circle,
    source: { kind: 'archive', artifact: await client.uploadArtifact(Buffer.from('source ' + circle), 'application/gzip') },
    prompt: await client.uploadArtifact(Buffer.from('prompt'), 'text/plain'), roster_epoch: 1,
    intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600) };
};

for (const firstRequest of ['circle', 'invite', 'join page']) test('router discovers legacy provisioned after startup through ' + firstRequest, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-late-legacy-'));
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const circle = randomUUID(), dbPath = join(dir, 'coordinator.sqlite');
  const router = createCirclesRouter({circlesDir: join(dir, 'circles'), origin,
    legacy: {dbPath, blobDir: join(dir, 'blobs')}});
  const server = createServer((req, res) => router(req, res));
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  t.after(async () => {
    router.close(); server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    router.dispose(); rmSync(dir, {recursive: true, force: true});
  });
  assert.equal((await fetch(origin + '/v1/circles/' + circle + '/capabilities')).status, 404);
  provisionV1Store({path: dbPath, provisioning: {circle_id: circle, origin, root_fingerprint: ids[2], roster: roster(circle)}});
  if (firstRequest === 'invite') {
    const response = await fetch(origin + '/v1/invites/' + p.generateInviteCode());
    assert.equal(response.status, 404);
    assert.deepEqual(router.circles(), [circle], 'invite scan discovers the late legacy store');
  }
  if (firstRequest === 'join page') {
    assert.equal((await fetch(origin + '/i/' + p.generateInviteCode())).status, 200);
    assert.deepEqual(router.circles(), [circle]);
  }
  const initial = roster(circle);
  let saved = {current: initial, history: [], highestAcceptedEpoch: 1, highestAcceptedDigest: p.digest(initial.payload)};
  const client = createClient({origin, circle, deviceKey: keys[0], pinnedRootFingerprint: ids[2],
    rosterCache: {get: async () => saved, set: async v => {saved = v;}}, retry: {maxAttempts: 1}});
  assert.ok(await client.capabilities());
  assert.deepEqual(router.circles(), [circle]);
  assert.equal((await fetch(origin + '/v1/circles/' + randomUUID() + '/capabilities')).status, 404);
  assert.deepEqual(router.circles(), [circle], 'unknown requests do not reopen the legacy store');
});

test('R1 two circles on one origin: each serves its own jobs and cannot see the other', { timeout: 20000 }, async t => {
  const f = await twoCircles(t);
  const a = f.client(f.A, 0), b = f.client(f.B, 0);
  const submitted = await a.submitJob(await job(a, f.A));
  assert.equal((await a.getJob(submitted.jobDigest)).state, 'queued');
  const seen = []; for await (const view of b.listJobs()) seen.push(view);
  assert.deepEqual(seen, [], 'circle B lists nothing of circle A');
  await assert.rejects(b.getJob(submitted.jobDigest), e => e.status === 404 && e.code === 'not_found');
  // A job of the same content in B gets its own, different digest and does not touch A.
  const other = await b.submitJob(await job(b, f.B));
  assert.notEqual(other.jobDigest, submitted.jobDigest);
  assert.equal((await a.fetchProgress(submitted.jobDigest)).entries.length, 0);
  // Each circle has its own store and blob directory on disk.
  for (const id of [f.A, f.B]) assert.ok(existsSync(join(f.circlesDir, id, 'coordinator.sqlite')));
  assert.ok(existsSync(join(f.circlesDir, f.A, 'blobs')) && existsSync(join(f.circlesDir, f.B, 'blobs')));
  // A lender in A claims only A's job.
  const claim = await f.client(f.A, 1).claimNext({ harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'],
    egress: ['provider-only'], enforced_limits: Object.keys(golden.objects.job.envelope.payload.requirements.limits),
    max_limits: golden.objects.job.envelope.payload.requirements.limits }, { waitSeconds: 0 });
  assert.equal(claim.job_digest, submitted.jobDigest);
});

test('R1 an unknown or malformed circle id is circle_not_provisioned, the same for both', { timeout: 20000 }, async t => {
  const f = await twoCircles(t);
  for (const id of [randomUUID(), 'not-a-uuid', '..%2F..']) {
    const response = await fetch(f.origin + '/v1/circles/' + id + '/capabilities');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'circle_not_provisioned');
  }
  // A proof for circle A is refused when replayed against circle B's path.
  const a = f.client(f.A, 0);
  const forged = await fetch(f.origin + '/v1/circles/' + f.B + '/capabilities', { headers: { 'Faravan-Proof': p.buildRequestProof({
    circle: f.A, roster_epoch: 1, method: 'GET', target: f.origin + '/v1/circles/' + f.A + '/capabilities', body: Buffer.alloc(0),
    content_type: '', artifact_media_type: '', idempotency_key: '', created: Math.floor(Date.now() / 1000), nonce: 'AAAAAAAAAAAAAAAAAAAAAA' }, keys[0]) } });
  assert.ok([400, 401].includes(forged.status), 'status ' + forged.status);
  assert.ok(a);
});

test('R1 quotas are per circle: a small circle refuses an upload that a default circle accepts', { timeout: 20000 }, async t => {
  const f = await twoCircles(t, { deviceBytes: 1000, circleBytes: 1000, maxArtifactBytes: 500 });
  const a = f.client(f.A, 0), b = f.client(f.B, 0), big = Buffer.alloc(800, 7);
  assert.equal((await a.uploadArtifact(big, 'text/plain')).bytes, 800);
  await assert.rejects(b.uploadArtifact(big, 'text/plain'), e => ['quota_exceeded', 'payload_too_large'].includes(e.code));
  assert.equal((await b.uploadArtifact(Buffer.alloc(100, 7), 'text/plain')).bytes, 100);
});

test('R1 an invite code is found in whichever circle holds it; unknown codes are a 404', { timeout: 20000 }, async t => {
  const f = await twoCircles(t);
  const b = f.client(f.B, 0), now = Math.floor(Date.now() / 1000), code = p.generateInviteCode();
  const invite = p.createInvite({ circle: f.B, coordinator: f.origin, invite_id: randomUUID(), invite_public_key: pubs[3],
    created_at: iso(now), expires_at: iso(now + 3600), display_name: 'B' }, keys[2]);
  await b.publishInvite({ code, invite, binding: p.createInviteBinding(invite, keys[3]) });
  const found = await fetch(f.origin + '/v1/invites/' + code);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).envelope.payload.circle, f.B);
  assert.equal((await fetch(f.origin + '/v1/invites/' + p.generateInviteCode())).status, 404);
  assert.equal((await fetch(f.origin + '/i/' + code)).status, 200, 'the short-link page is served');
});

test('R1 the coordinator command adds a circle with --v1-provision-circle', { timeout: 30000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'faravan-coord-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = randomUUID(), file = join(home, 'provision.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify({ circle_id: id, origin: 'http://127.0.0.1:8787', root_fingerprint: ids[2], roster: roster(id) }));
  const out = execFileSync(process.execPath, [new URL('../bin/faravan-coordinator', import.meta.url).pathname, '--v1-provision-circle', file],
    { env: { ...process.env, FARAVAN_COORDINATOR_HOME: home, FARAVAN_NO_BROWSER: '1' } }).toString();
  assert.equal(JSON.parse(out).status, 'provisioned');
  assert.ok(existsSync(join(home, 'v1', 'circles', id, 'coordinator.sqlite')));
});

test('router invite guesses from one loopback peer cannot poison real codes in either circle',async t=>{
  const f=await twoCircles(t,undefined,{limits:{unauthenticatedFailures:2,inviteLookupsPerCode:2}});
  const codes=[];
  for(const circle of [f.A,f.B]){
    const code=p.generateInviteCode(),now=Math.floor(Date.now()/1000);
    const invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600),display_name:'Test'},keys[2]);
    await f.client(circle,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});codes.push(code);
  }
  for(let n=0;n<35;n++) await (await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).arrayBuffer();
  for(const code of codes)assert.equal((await fetch(f.origin+'/v1/invites/'+code)).status,200);
  assert.equal((await fetch(f.origin+'/v1/invites/'+codes[0])).status,200);
  assert.equal((await fetch(f.origin+'/v1/invites/'+codes[0])).status,429,'valid code has its own bound');
  assert.equal((await fetch(f.origin+'/v1/invites/'+codes[1])).status,200,'another code is unaffected');
});

async function eventually(check,message){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,5));}
  assert.fail(message);
}
async function enrollmentBody(f,circle){
  const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
    created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
  await f.client(circle,0).publishInvite({code:p.generateInviteCode(),invite,binding:p.createInviteBinding(invite,keys[3])});
  return {invite,device_public_key:pubs[3],enrollment_proof:p.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:pubs[3]},keys[3])};
}
for(const [route,method,property] of [['/enrollments','POST','pendingEnrollmentBodies'],['/roster','PUT','pendingRosterRecoveries']])
test('router bounds stalled '+route+' bootstrap bodies while authenticated members stay usable',async t=>{
  const f=await twoCircles(t,undefined,{limits:{maxEnrollmentBodies:1,maxRosterRecoveries:1,maxRequests:2,maxRequestsPerSource:2,enrollmentTimeoutMs:1000,rosterRecoveryTimeoutMs:1000}}),requests=[];
  t.after(()=>requests.forEach(req=>req.destroy()));
  const otherBody=method==='POST'?await enrollmentBody(f,f.B):{padding:'refused'};
  const first=f.signed(f.A,3,method,route,{padding:'not sent'},method==='POST'?0:1);
  const held=httpRequest(f.origin+'/v1/circles/'+f.A+route,{method,headers:first.headers},res=>res.resume());
  held.on('error',()=>{});requests.push(held);held.flushHeaders();
  await eventually(()=>f.router[property]===1,'bootstrap body never reserved');
  const capped=await fetch(f.origin+'/v1/circles/'+f.B+route,f.signed(f.B,3,method,route,otherBody,method==='POST'?0:1));
  assert.equal(capped.status,method==='POST'?202:429,'a valid join enters the other circle; roster recovery remains shared');
  if(method==='POST')assert.equal((await fetch(f.origin+'/v1/circles/'+f.A+route,f.signed(f.A,3,method,route,{padding:'refused'},0))).status,429);
  assert.ok(await f.client(f.A,0).capabilities());
  assert.ok(await f.client(f.B,0).capabilities());
  held.destroy();await eventually(()=>f.router[property]===0,'aborted bootstrap body leaked allowance');
});

for(const kind of ['device','circle'])for(const ending of ['abort','deadline'])test('router holds '+kind+' download admission until '+ending+' and releases it',async t=>{
  const f=await twoCircles(t,undefined,{limits:{maxDownloads:kind==='circle'?1:8,maxDownloadsPerDevice:kind==='device'?1:8,downloadTimeoutMs:ending==='deadline'?1000:5000}});
  const ref=await f.client(f.A,0).uploadArtifact(Buffer.alloc(8*1024*1024,42),'text/plain');
  const other=await f.client(f.B,0).uploadArtifact(Buffer.alloc(8*1024*1024,42),'text/plain');
  if(kind==='circle')await f.client(f.B,1).uploadArtifact(Buffer.alloc(8*1024*1024,42),'text/plain');
  assert.equal(other.digest,ref.digest);
  const route='/artifacts/'+ref.digest.slice(7),options=f.signed(f.A,0,'GET',route);let req;
  const res=await new Promise((resolve,reject)=>{req=httpRequest(f.origin+'/v1/circles/'+f.A+route,{headers:options.headers},resolve);req.on('error',reject);req.end();});
  t.after(()=>req.destroy());res.pause();assert.equal(res.statusCode,200);
  assert.equal(f.router.pendingDownloads,1);
  const capped=await fetch(f.origin+'/v1/circles/'+f.B+route,f.signed(f.B,kind==='circle'?1:0,'GET',route));
  assert.equal(capped.status,429);
  assert.ok(await f.client(f.B,0).capabilities());
  if(ending==='abort')req.destroy();
  await eventually(()=>f.router.pendingDownloads===0,'download allowance leaked');
  assert.equal((await f.client(f.A,0).fetchArtifact(ref)).length,ref.bytes);
});

test('router enforces nonce and idempotency cache quotas independently per circle',async t=>{
  const f=await twoCircles(t,{idempotencyRowsPerDevice:2,noncesPerDevice:16});
  const a=f.client(f.A,0),b=f.client(f.B,0),payload=await job(b,f.B),submitted=await b.submitJob(payload);
  await b.cancelJob(submitted.jobDigest);
  const files=()=>JSON.stringify(readdirSync(join(f.circlesDir,f.B,'blobs')).sort());
  const before=files();
  await assert.rejects(b.deleteJob(submitted.jobDigest),e=>e.code==='quota_exceeded');
  assert.equal(files(),before,'cache refusal must preserve blobs');
  assert.equal((await b.submitJob(payload,{idempotencyKey:submitted.operationKey})).jobDigest,submitted.jobDigest,'a recorded write still replays when the cache is full');
  const other=await a.submitJob(await job(a,f.A));assert.ok(other.jobDigest);
  let refused=false;
  for(let n=0;n<20;n++)try{await b.capabilities({refresh:true});}catch(e){assert.equal(e.code,'rate_limited');refused=true;break;}
  assert.ok(refused,'nonces are bounded');
  assert.ok(await a.capabilities());
});

for(const spread of [false,true])for(const cap of ['maxRequests','maxRequestsPerSource'])
test('host '+cap+' reserves short reads when bodies fill the shared work allowance across '+(spread?'two circles':'one circle'),async t=>{
  const f=await twoCircles(t,undefined,{limits:{[cap]:2,jsonTimeoutMs:3000}}),held=[];
  t.after(()=>held.forEach(req=>req.destroy()));
  for(const circle of [f.A,spread?f.B:f.A]){
    const options=f.signed(circle,0,'POST','/jobs',{padding:'held'});
    const req=httpRequest(f.origin+'/v1/circles/'+circle+'/jobs',{method:'POST',headers:options.headers},res=>res.resume());
    req.on('error',()=>{});held.push(req);req.flushHeaders();
  }
  await eventually(()=>f.requests.length===2,'held requests never arrived');
  const target=spread?f.B:f.A;
  assert.ok(f.router.pendingRequests<=1,'held work leaves one source/host request slot free');
  assert.equal((await fetch(f.origin+'/v1/circles/'+target+'/capabilities',f.signed(target,0,'GET','/capabilities'))).status,200);
  assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,404,'short public lookups retain bounded service capacity');
  held.forEach(req=>req.destroy());
  await eventually(()=>(f.router.pendingRequests??0)===0,'request slots leaked');
  assert.ok(await f.client(f.B,0).capabilities());
});

test('unauthenticated failure budget is shared across circle enrollment routes',async t=>{
  const f=await twoCircles(t,undefined,{limits:{unauthenticatedFailures:2}});
  const send=circle=>fetch(f.origin+'/v1/circles/'+circle+'/enrollments',{method:'POST',body:'{}'});
  assert.equal((await send(f.A)).status,401);assert.equal((await send(f.B)).status,401);
  assert.equal((await send(f.B)).status,429);
  assert.ok(await f.client(f.A,0).capabilities());
});

test('invite guesses do no circle lookup work and cross-circle publications reject collisions',async t=>{
  const f=await twoCircles(t,undefined,{limits:{unknownInviteLookups:2,unauthenticatedFailures:100,inviteLookupsPerCode:1}}),code=p.generateInviteCode();
  const publish=circle=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600),display_name:'Test'},keys[2]);
    return f.client(circle,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
  };
  await publish(f.A);
  let lookups=0;const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT data FROM invite_codes WHERE id=?')lookups++;return prepare.call(this,sql);};
  try{
    for(const expected of [404,404,429])assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,expected);
    assert.equal(lookups,0,'unknown guesses must never probe circle stores');
    assert.equal((await fetch(f.origin+'/v1/invites/'+code)).status,200,'unknown budget must not poison real links');
    assert.equal(lookups,1,'known code resolves in exactly one circle');
    assert.equal((await fetch(f.origin+'/v1/invites/'+code)).status,429);
    assert.equal(lookups,1,'known code budget is enforced before store work');
  }finally{DatabaseSync.prototype.prepare=prepare;}
  await assert.rejects(publish(f.B),e=>e.code==='conflict');
  f.restart();
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,f.A,'initial load rebuilds the index');
});

const pollAdvertisement={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],
  enforced_limits:Object.keys(golden.objects.job.envelope.payload.requirements.limits),max_limits:golden.objects.job.envelope.payload.requirements.limits};
for(const limits of [{maxPolls:1},{maxPollsPerDevice:1},{maxPollsPerSource:1}])
test('host poll admission spans circles '+JSON.stringify(limits),async t=>{
  const f=await twoCircles(t,undefined,{limits}),body={advertisement:pollAdvertisement,wait_seconds:30};
  const controller=new AbortController();t.after(()=>controller.abort());
  const pending=fetch(f.origin+'/v1/circles/'+f.A+'/jobs/claim-next',{
    ...f.signed(f.A,1,'POST','/jobs/claim-next',body),signal:controller.signal}).catch(()=>null);
  await eventually(()=>f.requests.length===1,'poll did not arrive');
  const index=limits.maxPollsPerDevice?1:0;
  const capController=new AbortController();t.after(()=>capController.abort());
  const capRequest=fetch(f.origin+'/v1/circles/'+f.B+'/jobs/claim-next',{...f.signed(f.B,index,'POST','/jobs/claim-next',body),signal:capController.signal}).catch(()=>null);
  let timer;const capped=await Promise.race([capRequest,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),500);})]);clearTimeout(timer);
  assert.ok(capped,'cross-circle poll must be rejected promptly');assert.equal(capped.status,429);
  controller.abort();await pending;
  await eventually(()=>f.router.pendingPolls===0,'poll slot leaked');
  const replacementController=new AbortController();
  const replacement=fetch(f.origin+'/v1/circles/'+f.B+'/jobs/claim-next',{
    ...f.signed(f.B,index,'POST','/jobs/claim-next',body),signal:replacementController.signal}).catch(()=>null);
  await eventually(()=>f.router.pendingPolls===1,'released poll slot not reusable');
  f.router.close();replacementController.abort();await replacement;
  await eventually(()=>f.router.pendingPolls===0&&f.router.pendingRequests===0,'close leaked poll/request slots');
  assert.equal((await fetch(f.origin+'/join')).status,503,'closed router cannot load handlers');
});

test('verified enrollment device budget is host-wide while invite state stays per circle',async t=>{
  const f=await twoCircles(t,undefined,{limits:{bootstrapPerDevice:1,unauthenticatedFailures:1}});
  const enroll=async circle=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    const publication={code:p.generateInviteCode(),invite,binding:p.createInviteBinding(invite,keys[3])};
    await f.client(circle,0).publishInvite(publication);
    const body={invite,device_public_key:pubs[3],enrollment_proof:p.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:pubs[3]},keys[3])};
    return fetch(f.origin+'/v1/circles/'+circle+'/enrollments',f.signed(circle,3,'POST','/enrollments',body,0));
  };
  assert.equal((await enroll(f.A)).status,202);
  assert.equal((await enroll(f.B)).status,429);
  assert.ok(await f.client(f.B,0).capabilities());
});

test('hot-provisioned circles publish into the index without an invite scan',async t=>{
  const f=await twoCircles(t,undefined,{limits:{unknownInviteLookups:1}}),circle=randomUUID();
  mkdirSync(join(f.circlesDir,circle),{recursive:true});
  provisionV1Store({path:join(f.circlesDir,circle,'coordinator.sqlite'),provisioning:{circle_id:circle,origin:f.origin,root_fingerprint:ids[2],roster:roster(circle)}});
  const now=Math.floor(Date.now()/1000),code=p.generateInviteCode();
  const invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
  await f.client(circle,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
  assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,404);
  assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,429);
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,circle);
  assert.equal((await fetch(f.origin+'/i/'+code)).status,200);
});

test('cross-circle code collision rejects publication and leaves the original link intact',async t=>{
  const f=await twoCircles(t,undefined,{limits:{}}),code=p.generateInviteCode();
  const publish=circle=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    return f.client(circle,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
  };
  await publish(f.A);await assert.rejects(publish(f.B),e=>e.code==='conflict');
  f.restart();
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,f.A);
});

test('an invite publication with an uncertain commit still reserves its host code',async t=>{
  const f=await twoCircles(t,undefined,{limits:{}}),code=p.generateInviteCode();
  const publications=new Map();
  const publish=circle=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    if(!publications.has(circle))publications.set(circle,{code,invite,binding:p.createInviteBinding(invite,keys[3])});
    return f.client(circle,0).publishInvite(publications.get(circle),{idempotencyKey:circle});
  };
  const exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;let interrupted=false;
  DatabaseSync.prototype.exec=function(sql){
    const publication=sql==='COMMIT'&&!interrupted&&prepare.call(this,'SELECT id FROM invite_codes WHERE id=?').get(code);
    const result=exec.call(this,sql);
    if(publication){interrupted=true;throw new Error('commit acknowledgement lost');}
    return result;
  };
  try{await assert.rejects(publish(f.A),error=>error.code==='internal_error');}
  finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(interrupted,true,'fault must happen after the publication commits');
  await assert.rejects(publish(f.B),error=>error.code==='conflict');
  assert.equal((await publish(f.A)).code,code,'the recorded publication still replays over HTTP');
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,f.A);
});

test('noncanonical invite targets cannot spend a valid code allowance',async t=>{
  const f=await twoCircles(t,undefined,{limits:{inviteLookupsPerCode:1}});
  for(const suffix of ['query','dot-segment']){
    const circle=suffix==='query'?f.A:f.B,now=Math.floor(Date.now()/1000),code=p.generateInviteCode();
    const invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    await f.client(circle,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
    const path=suffix==='query'?'/v1/invites/'+code+'?junk=1':'/v1/unused/../invites/'+code;
    const rejected=await new Promise((resolve,reject)=>{
      const req=httpRequest(f.origin,{path},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.end();
    });
    assert.ok([400,404].includes(rejected),'noncanonical target must be rejected');
    assert.equal((await fetch(f.origin+'/v1/invites/'+code)).status,200,'rejected '+suffix+' target must leave the real link usable');
  }
});

test('a rolled-back invite publication releases its provisional code binding',async t=>{
  const f=await twoCircles(t,{idempotencyRowsPerDevice:1},{limits:{}}),code=p.generateInviteCode();
  const publish=(circle,chosen)=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    return f.client(circle,0).publishInvite({code:chosen,invite,binding:p.createInviteBinding(invite,keys[3])});
  };
  await publish(f.B,p.generateInviteCode());
  await assert.rejects(publish(f.B,code),error=>error.code==='quota_exceeded');
  await publish(f.A,code);
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,f.A);
});

for(const [route,method,property] of [['/enrollments','POST','pendingEnrollmentBodies'],['/roster','PUT','pendingRosterRecoveries']])
test('router close cancels held '+route+' bodies before their deadline',async t=>{
  const f=await twoCircles(t,undefined,{limits:{enrollmentTimeoutMs:30000,rosterRecoveryTimeoutMs:30000}});
  const options=f.signed(f.A,3,method,route,{padding:'held'},method==='POST'?0:1);
  const req=httpRequest(f.origin+'/v1/circles/'+f.A+route,{method,headers:options.headers},res=>res.resume());
  req.on('error',()=>{});t.after(()=>req.destroy());req.flushHeaders();
  await eventually(()=>f.router[property]===1,'body did not reserve a slot');
  f.router.close();
  await eventually(()=>f.router[property]===0,'close did not release held body');
  assert.equal(f.router.pendingRequests,0);
});

test('initial invite index quarantines pre-existing cross-circle code collisions',async t=>{
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{},clock:()=>now}),code=p.generateInviteCode();
  const publication=circle=>{
    const now=Math.floor(Date.now()/1000),invite=p.createInvite({circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],
      created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
    return {code,envelope:invite,invite_binding:p.createInviteBinding(invite,keys[3])};
  };
  // Simulate two independently provisioned databases made before host ownership.
  f.router.close();f.router.dispose();
  for(const circle of [f.A,f.B]){
    const store=openV1Store({path:join(f.circlesDir,circle,'coordinator.sqlite'),origin:f.origin});
    try{
      const body=publication(circle),options=f.signed(circle,0,'POST','/invites',body);
      store.registerInvite(body,{proof:options.headers['Faravan-Proof']});
    }finally{store.close();}
  }
  f.restart();
  const [owner,quarantined]=[f.A,f.B].sort();
  assert.deepEqual(f.router.circles(),[owner]);
  assert.equal(f.router.quarantined()[0].circle,quarantined);
  assert.equal(f.router.quarantined()[0].code,'conflict');
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,owner,'collision must preserve the first healthy owner');
  assert.equal((await fetch(f.origin+'/v1/circles/'+quarantined+'/capabilities',f.signed(quarantined,0,'GET','/capabilities'))).status,503);
  assert.ok(await f.client(owner,0).capabilities());
  const submitted=await f.client(owner,0).submitJob(await job(f.client(owner,0),owner));
  assert.equal((await f.client(owner,0).getJob(submitted.jobDigest)).state,'queued');
  const prepare=DatabaseSync.prototype.prepare;let scans=0;
  DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT id FROM invite_codes')scans++;return prepare.call(this,sql);};
  try{for(let n=0;n<4;n++)assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,503);}
  finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(scans,0,'unknown invite guesses must not rescan a quarantined circle');
  // Repair the clashing offline store, then retry through its circle path.
  const db=new DatabaseSync(join(f.circlesDir,quarantined,'coordinator.sqlite'));
  try{db.prepare('DELETE FROM invite_codes WHERE id=?').run(code);}finally{db.close();}
  now++;assert.ok(await f.client(quarantined,0).capabilities());
  assert.deepEqual(f.router.quarantined(),[]);
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,owner,'repair cannot steal the original code');
});

for(const kind of ['claim','offers'])for(const cap of ['maxRequests','maxRequestsPerSource'])
test('waiting '+kind+' polls release '+cap+' capacity across circles',async t=>{
  const f=await twoCircles(t,undefined,{limits:{[cap]:1,maxPolls:2,maxPollsPerDevice:2}}),controllers=[];
  t.after(()=>controllers.forEach(c=>c.abort()));
  const route=kind==='claim'?'/jobs/claim-next':'/offers?wait=30';
  const start=(circle,index)=>{
    const controller=new AbortController();controllers.push(controller);
    const options=kind==='claim'?f.signed(circle,index,'POST',route,{advertisement:pollAdvertisement,wait_seconds:30}):f.signed(circle,index,'GET',route);
    return fetch(f.origin+'/v1/circles/'+circle+route,{...options,signal:controller.signal}).catch(()=>null);
  };
  const first=start(f.A,1);
  await eventually(()=>f.router.pendingPolls===1,'first poll did not open');
  assert.equal((await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,0,'GET','/capabilities'))).status,200,'waiting poll must leave member API capacity');
  assert.equal(f.router.pendingRequests,0);
  const second=start(f.B,1);
  await eventually(()=>f.router.pendingPolls===2,'second circle poll did not open');
  const capped=await start(f.B,0);assert.equal(capped.status,429,'independent host poll cap still applies');
  assert.ok(await f.client(f.A,0).capabilities());
  controllers.forEach(c=>c.abort());await Promise.all([first,second]);
  await eventually(()=>f.router.pendingPolls===0&&f.router.pendingRequests===0,'abort leaked admission');
});

test('enrollment bodies have fair per-circle slots under a finite shared host cap',async t=>{
  const f=await twoCircles(t,undefined,{limits:{maxEnrollmentBodies:2,maxEnrollmentBodiesHost:3,maxRosterRecoveries:1,enrollmentTimeoutMs:10000}}),held=[];
  t.after(()=>held.forEach(req=>req.destroy()));
  const C=randomUUID();
  provisionV1Store({path:join(f.circlesDir,C,'coordinator.sqlite'),provisioning:{circle_id:C,origin:f.origin,root_fingerprint:ids[2],roster:roster(C)}});
  const hold=async(circle,route='/enrollments',method='POST')=>{
    const options=f.signed(circle,3,method,route,{padding:'held'},method==='POST'?0:1);
    const req=httpRequest(f.origin+'/v1/circles/'+circle+route,{method,headers:options.headers},res=>res.resume());
    req.on('error',()=>{});held.push(req);req.flushHeaders();return req;
  };
  const a=await hold(f.A);await hold(f.A);
  await eventually(()=>f.router.pendingEnrollmentBodies===2,'circle A slots not held');
  assert.equal((await fetch(f.origin+'/v1/circles/'+f.A+'/enrollments',f.signed(f.A,3,'POST','/enrollments',{},0))).status,429,'one circle cannot take the whole host');
  await hold(f.B);
  await eventually(()=>f.router.pendingEnrollmentBodies===3,'circle B must retain its own capacity over the same loopback source');
  assert.equal((await fetch(f.origin+'/v1/circles/'+C+'/enrollments',f.signed(C,3,'POST','/enrollments',{},0))).status,429,'host cap spans all circles');
  await hold(C,'/roster','PUT');
  await eventually(()=>f.router.pendingRosterRecoveries===1,'roster recovery has separate capacity');
  assert.ok(await f.client(f.A,0).capabilities());assert.ok(await f.client(C,0).capabilities());
  a.destroy();await eventually(()=>f.router.pendingEnrollmentBodies===2,'abort must release host and circle body slots');
  await hold(C);await eventually(()=>f.router.pendingEnrollmentBodies===3,'another circle can reuse the aborted host slot');
  held.forEach(req=>req.destroy());
  await eventually(()=>f.router.pendingEnrollmentBodies===0&&f.router.pendingRosterRecoveries===0,'body leases leaked');
});

test('enrollment body deadlines restore both circle and host capacity',async t=>{
  const f=await twoCircles(t,undefined,{limits:{maxEnrollmentBodies:1,maxEnrollmentBodiesHost:2,enrollmentTimeoutMs:60}});
  const options=f.signed(f.A,3,'POST','/enrollments',{padding:'held'},0);let req;
  const response=await new Promise((resolve,reject)=>{req=httpRequest(f.origin+'/v1/circles/'+f.A+'/enrollments',{method:'POST',headers:options.headers},resolve);req.on('error',reject);req.flushHeaders();});
  t.after(()=>req.destroy());response.resume();assert.equal(response.statusCode,400);
  await eventually(()=>f.router.pendingEnrollmentBodies===0,'deadline leaked enrollment lease');
  for(const circle of [f.A,f.B]){
    const next=f.signed(circle,3,'POST','/enrollments',{padding:'held again'},0);
    const status=await new Promise((resolve,reject)=>{const held=httpRequest(f.origin+'/v1/circles/'+circle+'/enrollments',{method:'POST',headers:next.headers},res=>{res.resume();held.destroy();resolve(res.statusCode);});held.on('error',reject);t.after(()=>held.destroy());held.flushHeaders();});
    assert.equal(status,400,'released capacity admits a new body until its deadline');
  }
});

test('corrupt circle startup is quarantined with retry backoff and successful repair',async t=>{
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{circleOpenRetrySeconds:5},clock:()=>now,
    beforeStart:({B,circlesDir})=>writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not a sqlite database')});
  assert.deepEqual(f.router.circles(),[f.A]);
  const rejected=()=>fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,0,'GET','/capabilities'));
  assert.equal((await rejected()).status,503);
  assert.equal(f.router.quarantined()[0].attempts,1,'startup failure is not retried immediately');
  assert.equal((await fetch(f.origin+'/join')).status,200,'default routing uses any healthy circle');
  const a=f.client(f.A,0),submitted=await a.submitJob(await job(a,f.A));
  assert.equal((await a.getJob(submitted.jobDigest)).state,'queued');
  now+=5;assert.equal((await rejected()).status,503);
  assert.equal(f.router.quarantined()[0].attempts,2,'failed retry increases backoff');
  rmSync(join(f.circlesDir,f.B,'coordinator.sqlite'));
  provisionV1Store({path:join(f.circlesDir,f.B,'coordinator.sqlite'),provisioning:{circle_id:f.B,origin:f.origin,root_fingerprint:ids[2],roster:roster(f.B)}});
  now+=9;assert.equal((await rejected()).status,503,'repair waits until the retry deadline');
  now++;assert.ok(await f.client(f.B,0).capabilities());
  assert.deepEqual(f.router.quarantined(),[]);
  const stamp=Math.floor(Date.now()/1000),code=p.generateInviteCode();
  const invite=p.createInvite({circle:f.B,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],created_at:iso(stamp),expires_at:iso(stamp+3600)},keys[2]);
  await f.client(f.B,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
  assert.equal((await (await fetch(f.origin+'/v1/invites/'+code)).json()).envelope.payload.circle,f.B,'repair restores invite routing');
});

test('corrupt legacy startup does not prevent healthy circles or default routing',async t=>{
  let now=Math.floor(Date.now()/1000);
  const options={limits:{},clock:()=>now,beforeStart:({dir})=>{
    options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};
    writeFileSync(options.legacy.dbPath,'not a sqlite database');
  }};
  const f=await twoCircles(t,undefined,options);
  assert.equal(f.router.circles().length,2);
  assert.equal(f.router.quarantined()[0].circle,null);
  assert.equal((await fetch(f.origin+'/join')).status,200);
  assert.ok(await f.client(f.A,0).capabilities());assert.ok(await f.client(f.B,0).capabilities());
  assert.equal(f.router.quarantined()[0].attempts,1,'healthy requests must not reopen broken legacy on each request');
  const circle=randomUUID();rmSync(options.legacy.dbPath);
  provisionV1Store({path:options.legacy.dbPath,provisioning:{circle_id:circle,origin:f.origin,root_fingerprint:ids[2],roster:roster(circle)}});
  now++;assert.equal((await fetch(f.origin+'/join')).status,200);
  assert.ok(await f.client(circle,0).capabilities());
  assert.equal(f.router.circles().length,3);assert.deepEqual(f.router.quarantined(),[]);
});

test('quarantine regression: unavailable legacy may own an unknown circle id',async t=>{
  let now=Math.floor(Date.now()/1000);
  const options={limits:{circleOpenRetrySeconds:5},clock:()=>now,beforeStart:({dir})=>{
    options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};
    writeFileSync(options.legacy.dbPath,'not a sqlite database');
  }};
  const f=await twoCircles(t,undefined,options),circle=randomUUID();
  const response=await fetch(f.origin+'/v1/circles/'+circle+'/capabilities');
  assert.equal(response.status,503,'unreadable legacy configuration cannot rule out this circle');
  assert.equal((await response.json()).code,'unavailable');
  assert.ok(await f.client(f.A,0).capabilities());
  assert.equal((await fetch(f.origin+'/v1/circles/not-a-circle/capabilities')).status,404);
  rmSync(options.legacy.dbPath);
  provisionV1Store({path:options.legacy.dbPath,provisioning:{circle_id:circle,origin:f.origin,root_fingerprint:ids[2],roster:roster(circle)}});
  now+=5;assert.ok(await f.client(circle,0).capabilities());
  assert.deepEqual(f.router.quarantined(),[]);
  assert.equal((await fetch(f.origin+'/v1/circles/'+randomUUID()+'/capabilities')).status,404);
});

for(const removed of ['database','directory'])test('quarantine regression: deleted circle '+removed+' returns 404 before backoff expires',async t=>{
  const f=await twoCircles(t,undefined,{limits:{circleOpenRetrySeconds:30},
    beforeStart:({B,circlesDir})=>writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not a sqlite database')});
  const path=join(f.circlesDir,f.B);
  rmSync(removed==='directory'?path:join(path,'coordinator.sqlite'),{recursive:true});
  assert.equal((await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities')).status,404);
  assert.deepEqual(f.router.quarantined(),[],'removed stores must not stay quarantined');
  provisionV1Store({path:join(path,'coordinator.sqlite'),provisioning:{circle_id:f.B,origin:f.origin,root_fingerprint:ids[2],roster:roster(f.B)}});
  assert.ok(await f.client(f.B,0).capabilities(),'replacement is discoverable immediately');
});

test('quarantine regression: deleted legacy clears quarantine before backoff expires',async t=>{
  const options={limits:{circleOpenRetrySeconds:30},beforeStart:({dir})=>{
    options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};
    writeFileSync(options.legacy.dbPath,'not a sqlite database');
  }};
  const f=await twoCircles(t,undefined,options);
  rmSync(options.legacy.dbPath);
  assert.ok(await f.client(f.A,0).capabilities());
  assert.deepEqual(f.router.quarantined(),[]);
  assert.equal((await fetch(f.origin+'/v1/circles/'+randomUUID()+'/capabilities')).status,404);
});

test('quarantine regression: Retry-After tracks remaining exponential backoff',async t=>{
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{circleOpenRetrySeconds:5},clock:()=>now,
    beforeStart:({B,circlesDir})=>writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not a sqlite database')});
  const rejected=()=>fetch(f.origin+'/v1/circles/'+f.B+'/capabilities');
  for(const [advance,seconds,attempts] of [[0,5,1],[2,3,1],[3,10,2],[9,1,2],[1,20,3],[20,30,4]]){
    now+=advance;
    const response=await rejected();
    assert.equal(response.status,503);
    assert.equal(response.headers.get('retry-after'),String(seconds));
    assert.equal(f.router.quarantined()[0].attempts,attempts);
  }
});

test('quarantine regression: child-held SQLite lock does not block healthy traffic and repairs after release',async t=>{
  let child;
  t.after(async()=>{
    if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  });
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{circleOpenRetrySeconds:5},clock:()=>now}),circle=randomUUID();
  const path=join(f.circlesDir,circle,'coordinator.sqlite');
  provisionV1Store({path,provisioning:{circle_id:circle,origin:f.origin,root_fingerprint:ids[2],roster:roster(circle)}});
  child=spawn(process.execPath,['--input-type=module','-e',`
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    process.on('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect();});
    setTimeout(()=>process.exit(1),30000).unref();
  `,path],{stdio:['ignore','ignore','ignore','ipc']});
  assert.deepEqual(await once(child,'message'),['locked',undefined]);
  for(let attempt=1;attempt<=2;attempt++){
    const started=performance.now(),arrivals=f.requests.length;
    const blocked=fetch(f.origin+'/v1/circles/'+circle+'/capabilities');
    // Count turns rather than wall time: a blocked event loop must reach the latency assertion.
    for(let n=0;n<200&&f.requests.length===arrivals;n++)await new Promise(r=>setTimeout(r,5));
    assert.ok(f.requests.length>arrivals,'locked circle request did not arrive');
    assert.ok(await f.client(f.A,0).capabilities());
    const elapsed=performance.now()-started;
    assert.equal((await blocked).status,503);
    assert.ok(elapsed<1000,'healthy request blocked for '+Math.round(elapsed)+'ms by synchronous store open');
    assert.equal(f.router.quarantined()[0].attempts,attempt);
    now+=5;
  }
  const exited=once(child,'exit');child.send('release');await exited;
  assert.equal((await fetch(f.origin+'/v1/circles/'+circle+'/capabilities')).status,503,'released lock still respects backoff');
  now+=5;
  assert.ok(await f.client(circle,0).capabilities());
  assert.deepEqual(f.router.quarantined(),[]);
});

test('misfiled circle and noncanonical circle IDs cannot replace healthy routing',async t=>{
  const f=await twoCircles(t,undefined,{limits:{}}),C=randomUUID();
  mkdirSync(join(f.circlesDir,C));copyFileSync(join(f.circlesDir,f.A,'coordinator.sqlite'),join(f.circlesDir,C,'coordinator.sqlite'));
  assert.equal((await fetch(f.origin+'/v1/circles/'+C+'/capabilities',f.signed(C,0,'GET','/capabilities'))).status,503);
  assert.deepEqual(new Set(f.router.circles()),new Set([f.A,f.B]));
  assert.ok(await f.client(f.A,0).capabilities());
  for(const id of ['not-a-circle',f.A.toUpperCase(),'%2e%2e']){
    const status=await new Promise((resolve,reject)=>{const req=httpRequest(f.origin,{path:'/v1/circles/'+id+'/capabilities'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
    assert.ok([400,404].includes(status));
  }
  assert.equal(f.router.quarantined().length,1,'invalid path IDs never become quarantine entries');
});

test('failed circle SQLite initialization closes every acquired database handle',async t=>{
  const exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close,failed=new Set();
  DatabaseSync.prototype.exec=function(sql){try{return exec.call(this,sql);}catch(error){failed.add(this);throw error;}};
  DatabaseSync.prototype.close=function(){const result=close.call(this);failed.delete(this);return result;};
  try{
    const f=await twoCircles(t,undefined,{limits:{},beforeStart:({B,circlesDir})=>writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not a sqlite database')});
    assert.equal(f.router.circles().length,1);
    assert.equal(failed.size,0,'openV1Store must close a handle even when PRAGMA/schema initialization fails');
  }finally{
    for(const db of failed)try{close.call(db);}catch{}
    DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;
  }
});

test('bad enrollment proofs on shared loopback never spend valid invite or device rates',async t=>{
  const f=await twoCircles(t,undefined,{limits:{bootstrapPerDevice:2,unauthenticatedFailures:1}});
  const bodies=new Map();
  for(const circle of [f.A,f.B])bodies.set(circle,await enrollmentBody(f,circle));
  for(const circle of [f.A,f.B])for(let n=0;n<12;n++){
    const invalid={...bodies.get(circle),enrollment_proof:{}};
    const response=await fetch(f.origin+'/v1/circles/'+circle+'/enrollments',f.signed(circle,3,'POST','/enrollments',invalid,0));
    assert.ok([400,429].includes(response.status));await response.arrayBuffer();
  }
  for(const circle of [f.A,f.B]){
    const response=await fetch(f.origin+'/v1/circles/'+circle+'/enrollments',f.signed(circle,3,'POST','/enrollments',bodies.get(circle),0));
    assert.equal(response.status,202,'invalid proofs cannot exhaust either valid invite or the host device budget');
  }
});

for(const kind of ['claim','offers'])test('waiting '+kind+' polls release leases on deadline and router close',async t=>{
  const f=await twoCircles(t,undefined,{limits:{maxRequests:1,maxPolls:1}}),controllers=[];
  t.after(()=>controllers.forEach(c=>c.abort()));
  const start=wait=>{
    const route=kind==='claim'?'/jobs/claim-next':'/offers?wait='+wait;
    const options=kind==='claim'?f.signed(f.A,1,'POST',route,{advertisement:pollAdvertisement,wait_seconds:wait}):f.signed(f.A,1,'GET',route);
    const controller=new AbortController();controllers.push(controller);
    return fetch(f.origin+'/v1/circles/'+f.A+route,{...options,signal:controller.signal});
  };
  const timed=start(1);await eventually(()=>f.router.pendingPolls===1,'timed poll never opened');
  assert.ok(await f.client(f.B,0).capabilities());
  assert.equal((await timed).status,kind==='claim'?204:200);
  await eventually(()=>f.router.pendingPolls===0&&f.router.pendingRequests===0,'deadline leaked a lease');
  const held=start(30);await eventually(()=>f.router.pendingPolls===1,'replacement poll never opened');
  f.router.close();assert.equal((await held).status,503);
  await eventually(()=>f.router.pendingPolls===0&&f.router.pendingRequests===0,'router close leaked a lease');
});

test('quarantined invite lookup retries after backoff without a circle-path request or failure-budget spend',async t=>{
 let now=Math.floor(Date.now()/1000);
 const f=await twoCircles(t,undefined,{limits:{circleOpenRetrySeconds:5,unauthenticatedFailures:1,unknownInviteLookups:10},clock:()=>now}),code=p.generateInviteCode();
 const invite=p.createInvite({circle:f.B,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[3],created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
 await f.client(f.B,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[3])});
 f.router.close();f.router.dispose();
 const path=join(f.circlesDir,f.B,'coordinator.sqlite'),bytes=readFileSync(path);
 writeFileSync(path,'not a sqlite database');f.restart();
 for(let i=0;i<3;i++){
  const response=await fetch(f.origin+'/v1/invites/'+code);
  assert.equal(response.status,503);assert.equal((await response.json()).retryable,true);
 }
 assert.equal(f.router.quarantined()[0].attempts,1);
 writeFileSync(path,bytes);now+=5;
 const response=await fetch(f.origin+'/v1/invites/'+code);
 assert.equal(response.status,200);assert.equal((await response.json()).envelope.payload.circle,f.B);
 assert.deepEqual(f.router.quarantined(),[]);
});

test('known duplicate legacy ownership does not make unrelated circle ids unavailable',async t=>{
 const options={limits:{},beforeStart:({dir})=>{options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};}};
 const f=await twoCircles(t,undefined,options);
 copyFileSync(join(f.circlesDir,f.A,'coordinator.sqlite'),options.legacy.dbPath);
 assert.ok(await f.client(f.A,0).capabilities());
 assert.equal(f.router.quarantined()[0].code,'conflict');
 assert.equal((await fetch(f.origin+'/v1/circles/'+randomUUID()+'/capabilities')).status,404);
});

test('an invite miss retries at most one quarantined store after admission',async t=>{
 let now=Math.floor(Date.now()/1000);
 const f=await twoCircles(t,undefined,{limits:{unknownInviteLookups:1,circleOpenRetrySeconds:5},clock:()=>now,
  beforeStart:({B,circlesDir})=>{
   writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not a sqlite database');
   const other=join(circlesDir,randomUUID());mkdirSync(other);writeFileSync(join(other,'coordinator.sqlite'),'also not sqlite');
  }});
 const attempts=()=>f.router.quarantined().reduce((sum,entry)=>sum+entry.attempts,0);
 assert.equal(attempts(),2);now+=5;
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,503);
 assert.equal(attempts(),3,'one miss cannot scan every quarantined store');
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,429);
 assert.equal(attempts(),3,'rate-limited misses cannot retry another store');
 assert.ok(await f.client(f.A,0).capabilities());
});

test('rate-limited invite misses cannot discover a newly provisioned legacy store',async t=>{
 const options={limits:{unknownInviteLookups:1},beforeStart:({dir})=>{options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};}};
 const f=await twoCircles(t,undefined,options),circle=randomUUID();
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,404);
 provisionV1Store({path:options.legacy.dbPath,provisioning:{circle_id:circle,origin:f.origin,root_fingerprint:ids[2],roster:roster(circle)}});
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,429);
 assert.equal(f.router.circles().length,2,'invite admission must precede legacy store discovery');
});

test('an invite miss retries only one store when both legacy and named circles are quarantined',async t=>{
 let now=Math.floor(Date.now()/1000);
 const options={limits:{circleOpenRetrySeconds:5},clock:()=>now,beforeStart:({B,circlesDir,dir})=>{
  options.legacy={dbPath:join(dir,'legacy.sqlite'),blobDir:join(dir,'legacy-blobs')};
  writeFileSync(options.legacy.dbPath,'not sqlite');writeFileSync(join(circlesDir,B,'coordinator.sqlite'),'not sqlite either');
 }};
 const f=await twoCircles(t,undefined,options),attempts=()=>f.router.quarantined().reduce((sum,entry)=>sum+entry.attempts,0);
 assert.equal(attempts(),2);
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,503);
 assert.equal(attempts(),2);now+=5;
 assert.equal((await fetch(f.origin+'/v1/invites/'+p.generateInviteCode())).status,503);
 assert.equal(attempts(),3,'legacy discovery must share the one-candidate retry bound');
 assert.ok(await f.client(f.A,0).capabilities());
});
