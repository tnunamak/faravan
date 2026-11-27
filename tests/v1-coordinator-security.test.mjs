import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import { provisionV1Store, openV1Store } from '../lib/v1/store.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { startCoordinator } from '../lib/coordinator.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createCirclesRouter } from '../lib/v1/circles-router.mjs';

// R1: two circles on one origin. Keys are the TEST-ONLY golden keys.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = [...golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex'))),
  ...[5,6,7,8,9].map(n=>p.privateKeyFromSeed(Buffer.alloc(32,n)))];
const pubs = keys.map(p.exportPublicKey), ids = pubs.map(p.fingerprint);
const base = golden.objects.roster.envelope.payload;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');

async function freePort() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise(r => server.close(r)); return port;
}
let activeA,activeAKeys;
function roster(circle) {
  const t = Math.floor(Date.now() / 1000);
  return p.signEnvelope('roster', { ...base, circle, epoch: 1, issued_at: iso(t - 60), valid_until: iso(t + 7 * 86400),
    members: (circle===activeA?activeAKeys:[1]).map(index=>({key_id:ids[index],public_key:pubs[index],joined_epoch:1})) }, keys[2]);
}
async function twoCircles(t, quotasB, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-circles-')), port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const A = randomUUID(), B = randomUUID(), circlesDir = join(dir, 'circles'); activeA=A;activeAKeys=options.membersA??[0];
  for (const [id, quotas] of [[A, undefined], [B, quotasB]]) {
    mkdirSync(join(circlesDir, id), { recursive: true });
    provisionV1Store({ path: join(circlesDir, id, 'coordinator.sqlite'),
      provisioning: { circle_id: id, origin, root_fingerprint: ids[2], roster: roster(id), ...(quotas ? { quotas } : {}) } });
  }
  let router,server;const requests=[];
  if(options.limits) {
    router=createCirclesRouter({circlesDir,origin,limits:options.limits,...(options.clock?{clock:options.clock}:{})});
    server=createServer((req,res)=>{requests.push(req);return router(req,res);});
    await new Promise(r=>server.listen(port,'127.0.0.1',r));
  } else server = await startCoordinator({ port, v1: { circlesDir, origin } });
  t.after(async () => { router?.close();server.closeAllConnections?.(); await new Promise(r => server.close(r));
    if(router)await eventually(()=>(router.pendingRequests??0)===0&&(router.pendingPolls??0)===0&&(router.pendingDownloads??0)===0&&(router.pendingEnrollmentBodies??0)===0&&(router.pendingRosterRecoveries??0)===0,'router failed to drain');
    await new Promise(setImmediate);router?.dispose();rmSync(dir, { recursive: true, force: true }); });
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
    router=createCirclesRouter({circlesDir,origin,limits:options.limits??{},...(options.clock?{clock:options.clock}:{})});
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


async function eventually(check,message){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,5));}
  assert.fail(message);
}

test('SEC-1: one circle A member must not starve circle B using unfinished bodies', {timeout:30000},async t=>{
  const f=await twoCircles(t,undefined,{limits:{}}),held=[];
  t.after(()=>held.forEach(req=>req.destroy()));
  assert.equal((await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,0,'GET','/capabilities'))).status,403,'attacker is not a member of B');
  const before=await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,1,'GET','/capabilities'));
  assert.equal(before.status,200);await before.arrayBuffer();
  const options=f.signed(f.A,0,'POST','/jobs',{padding:'never sent'});
  for(let n=0;n<64;n++){
    const req=httpRequest(f.origin+'/v1/circles/'+f.A+'/jobs',{method:'POST',headers:options.headers},res=>res.resume());
    req.on('error',()=>{});held.push(req);req.flushHeaders();
  }
  await eventually(()=>f.requests.length===66,'did not receive all 64 held requests');
  const response=await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,1,'GET','/capabilities'));
  const during=response.status;await response.arrayBuffer();
  held.forEach(req=>req.destroy());await eventually(()=>(f.router.pendingRequests??0)===0,'aborted slots did not drain');
  await new Promise(r=>setTimeout(r,50));
  const after=await fetch(f.origin+'/v1/circles/'+f.B+'/capabilities',f.signed(f.B,1,'GET','/capabilities'));
  assert.equal(after.status,200);await after.arrayBuffer();
  t.diagnostic('B before=200, during='+during+', after=200; A-only member held 64 bodies with one reused proof; default admission limits');
  assert.equal(during,200,'a member of A must not exhaust all service capacity for B');
});

test('SEC-2: exhausted unauthenticated failure budget must stop further enrollment verification work',async t=>{
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{unauthenticatedFailures:1,bootstrapWorkPerWindow:1,bootstrapPerDevice:1},clock:()=>now}),code=p.generateInviteCode();
  const invite=p.createInvite({circle:f.A,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:pubs[1],created_at:iso(now),expires_at:iso(now+3600)},keys[2]);
  await f.client(f.A,0).publishInvite({code,invite,binding:p.createInviteBinding(invite,keys[1])});
  const publication=await (await fetch(f.origin+'/v1/invites/'+code)).json();
  // A stranger can copy this public signature; it is invalid for enrollment's separate domain.
  const body={invite:publication.envelope,device_public_key:pubs[3],enrollment_proof:{payload:{circle:f.A,invite_id:invite.payload.invite_id,device_public_key:pubs[3]},signature:publication.invite_binding}};
  const prepare=DatabaseSync.prototype.prepare;let lookups=0;
  DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT data FROM invites WHERE id=?')lookups++;return prepare.call(this,sql);};
  const statuses=[];
  try{
    for(let n=0;n<4;n++){
      const response=await fetch(f.origin+'/v1/circles/'+f.A+'/enrollments',f.signed(f.A,3,'POST','/enrollments',body,0));
      statuses.push(response.status);await response.arrayBuffer();
    }
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(statuses,[401,429,429,429]);
  assert.ok(await f.client(f.B,1).capabilities());
  t.diagnostic('failure limit=1, response statuses='+statuses.join(',')+', expensive invite-verification entries='+lookups);
  assert.equal(lookups,1,'rate-limited attempts must not keep entering the expensive verification path');
  const db=new DatabaseSync(join(f.circlesDir,f.A,'coordinator.sqlite'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM nonces WHERE device=?').get(ids[3]).n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM enrollments').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM bootstrap_rates').get().n,0);db.close();
  now+=60;
  const valid={...body,enrollment_proof:p.createEnrollmentProof({circle:f.A,invite_id:invite.payload.invite_id,device_public_key:pubs[3]},keys[1])};
  const joined=await fetch(f.origin+'/v1/circles/'+f.A+'/enrollments',f.signed(f.A,3,'POST','/enrollments',valid,0));
  assert.equal(joined.status,202,'invalid attempts did not consume the invite or verified-device admission allowance');await joined.arrayBuffer();
});

test('SEC-3: tiny unreferenced artifacts must have a bounded object count',async t=>{
  const f=await twoCircles(t,{deviceBytes:128,circleBytes:128,deviceArtifacts:8,circleArtifacts:8},{limits:{}}),client=f.client(f.B,1);
  let admitted=0;
  for(let n=0;n<64;n++){
    const bytes=Buffer.alloc(2);bytes.writeUInt16BE(n);
    try{await client.uploadArtifact(bytes,'text/plain');admitted++;}catch(error){assert.equal(error.code,'quota_exceeded');break;}
  }
  const directory=join(f.circlesDir,f.B,'blobs'),files=readdirSync(directory).filter(x=>/^[0-9a-f]{64}$/.test(x));
  const allocated=files.reduce((total,name)=>total+statSync(join(directory,name)).blocks*512,0);
  const quotas=await fetch(f.origin+'/v1/circles/'+f.B+'/quotas',f.signed(f.B,1,'GET','/quotas'));
  const usage=await quotas.json();
  t.diagnostic('admitted='+admitted+', logical bytes='+usage.circle.retained_bytes+', allocated blob bytes='+allocated);
  assert.equal(admitted,8,'object quota must reject additional tiny files even below the byte quota');
  assert.equal(files.length,8);assert.equal(usage.circle.retained_bytes,16);
});


test('SEC-CONTROL: nonmember keys and artifact digests cannot cross circle boundaries',async t=>{
  const f=await twoCircles(t,undefined,{limits:{}});
  const ref=await f.client(f.B,1).uploadArtifact(Buffer.from('only in B'),'text/plain');
  const route='/artifacts/'+ref.digest.slice(7);
  for(const readRoute of ['/jobs','/presence','/roster',route]){
    const response=await fetch(f.origin+'/v1/circles/'+f.B+readRoute,f.signed(f.B,0,'GET',readRoute));
    assert.equal(response.status,403);await response.arrayBuffer();
  }
  const absent=await fetch(f.origin+'/v1/circles/'+f.A+route,f.signed(f.A,0,'GET',route));
  assert.equal(absent.status,404);await absent.arrayBuffer();
  assert.equal((await f.client(f.B,1).fetchArtifact(ref)).toString(),'only in B');
});

for(const small of [false,true])test('SEC-1: several verified A members leave reads and heartbeat capacity for B'+(small?' with a small source cap':''),async t=>{
  const membersA=[0,3,4,5,6],limits=small?{maxRequests:8,maxRequestsPerSource:4,maxMemberBodies:1000,maxMemberBodiesPerSource:1000}:{};
  const f=await twoCircles(t,undefined,{limits,membersA}),held=[];
  t.after(()=>held.forEach(req=>req.destroy()));
  let replies=0;
  for(let n=0;n<40;n++){
    const route=n%3===0?'/heartbeat':'/jobs',options=f.signed(f.A,membersA[n%membersA.length],'POST',route,{held:true});
    const req=httpRequest(f.origin+'/v1/circles/'+f.A+route,{method:'POST',headers:options.headers},res=>{replies++;res.resume();});
    req.on('error',()=>{});held.push(req);req.flushHeaders();
  }
  await eventually(()=>f.requests.length===40&&replies>=24,'A work did not settle into bounded leases');
  assert.ok(f.router.pendingRequests<=(small?2:16));
  for(const route of ['/capabilities','/roster']){
    const response=await fetch(f.origin+'/v1/circles/'+f.B+route,f.signed(f.B,1,'GET',route));
    assert.equal(response.status,200);await response.arrayBuffer();
  }
  const heartbeat={seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]};
  const response=await fetch(f.origin+'/v1/circles/'+f.B+'/heartbeat',f.signed(f.B,1,'POST','/heartbeat',heartbeat));
  assert.equal(response.status,200);await response.arrayBuffer();
  held.forEach(req=>req.destroy());await eventually(()=>f.router.pendingRequests===0,'fair leases did not drain');
});

test('SEC-2: bootstrap work rejects malformed attempts before body slots and refills independently of members',async t=>{
  let now=Math.floor(Date.now()/1000);
  const f=await twoCircles(t,undefined,{limits:{bootstrapWorkPerWindow:1,bootstrapWindowSeconds:10},clock:()=>now});
  const send=()=>fetch(f.origin+'/v1/circles/'+f.A+'/enrollments',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
  assert.equal((await send()).status,401);
  const options=f.signed(f.A,3,'POST','/enrollments',{held:true},0);
  const response=await fetch(f.origin+'/v1/circles/'+f.A+'/enrollments',options);
  assert.equal(response.status,429);await response.arrayBuffer();assert.equal(f.router.pendingEnrollmentBodies,0);
  const recovery=await fetch(f.origin+'/v1/circles/'+f.A+'/roster',f.signed(f.A,3,'PUT','/roster',{held:true}));
  assert.equal(recovery.status,429);await recovery.arrayBuffer();assert.equal(f.router.pendingRosterRecoveries,0);
  assert.ok(await f.client(f.B,1).capabilities());
  now+=10;
  assert.equal((await send()).status,401,'attempt budget refills at its window boundary');
});

const pollAdvertisement={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],
  enforced_limits:Object.keys(golden.objects.job.envelope.payload.requirements.limits),max_limits:golden.objects.job.envelope.payload.requirements.limits};
for(const kind of ['claim','offers'])for(const ending of ['abort','shutdown'])
test('SEC-1: many A '+kind+' polls preserve B service and release on '+ending,async t=>{
  const membersA=[0,3,4,5,6],f=await twoCircles(t,undefined,{limits:{},membersA}),held=[];
  t.after(()=>held.forEach(req=>req.destroy()));
  for(let n=0;n<20;n++){
    const route=kind==='claim'?'/jobs/claim-next':'/offers?wait=30';
    const body=kind==='claim'?{advertisement:pollAdvertisement,wait_seconds:30}:undefined;
    const options=f.signed(f.A,membersA[n%membersA.length],kind==='claim'?'POST':'GET',route,body);
    const req=httpRequest(f.origin+'/v1/circles/'+f.A+route,{method:options.method,headers:options.headers},res=>res.resume());
    req.on('error',()=>{});held.push(req);req.end(options.body);
  }
  await eventually(()=>f.requests.length===20&&f.router.pendingPolls===16,'A poll cap was not applied');
  assert.ok(f.router.pendingRequests<=16);assert.ok(await f.client(f.B,1).capabilities());
  const heartbeat={seq:0,intent:{state:'ready'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]};
  const response=await fetch(f.origin+'/v1/circles/'+f.B+'/heartbeat',f.signed(f.B,1,'POST','/heartbeat',heartbeat));
  assert.equal(response.status,200);await response.arrayBuffer();
  if(ending==='shutdown')f.router.close();else held.forEach(req=>req.destroy());
  await eventually(()=>f.router.pendingRequests===0&&f.router.pendingPolls===0,'poll fairness leases leaked');
});

test('SEC-1: verified body and offers-poll leases release at their deadlines',async t=>{
  const f=await twoCircles(t,undefined,{limits:{jsonTimeoutMs:100,maxPollSeconds:1}});
  const options=f.signed(f.A,0,'POST','/jobs',{held:true});
  const req=httpRequest(f.origin+'/v1/circles/'+f.A+'/jobs',{method:'POST',headers:options.headers},res=>res.resume());
  req.on('error',()=>{});t.after(()=>req.destroy());req.flushHeaders();
  await eventually(()=>f.router.pendingRequests===1,'body did not acquire a lease');
  await eventually(()=>f.router.pendingRequests===0,'body deadline leaked its lease');
  const route='/offers?wait=1',poll=fetch(f.origin+'/v1/circles/'+f.A+route,f.signed(f.A,0,'GET',route));
  await eventually(()=>f.router.pendingPolls===1,'offer poll never parked');
  assert.equal((await poll).status,200);await eventually(()=>f.router.pendingRequests===0&&f.router.pendingPolls===0,'poll deadline leaked its lease');
});

test('SEC-1: several A downloaders cannot consume B download or ordinary-read capacity',async t=>{
  const membersA=[0,3,4,5,6],f=await twoCircles(t,undefined,{limits:{},membersA}),held=[];
  const bytes=Buffer.alloc(8*1024*1024,19),a=await f.client(f.A,0).uploadArtifact(bytes,'text/plain');
  const author=f.client(f.A,0);await author.submitJob({...await job(author,f.A),prompt:a});
  const b=await f.client(f.B,1).uploadArtifact(bytes,'text/plain'),route='/artifacts/'+a.digest.slice(7);
  t.after(()=>held.forEach(req=>req.destroy()));
  for(let n=0;n<5;n++){
    const options=f.signed(f.A,membersA[n],'GET',route);
    const response=await new Promise((resolve,reject)=>{const req=httpRequest(f.origin+'/v1/circles/'+f.A+route,{headers:options.headers},resolve);
      held.push(req);req.on('error',reject);req.end();});
    if(n<4){assert.equal(response.statusCode,200);response.pause();}else{assert.equal(response.statusCode,429);response.resume();}
  }
  assert.equal(f.router.pendingDownloads,4);assert.ok(await f.client(f.B,1).capabilities());
  assert.equal((await f.client(f.B,1).fetchArtifact(b)).length,bytes.length);
  held.forEach(req=>req.destroy());await eventually(()=>f.router.pendingDownloads===0&&f.router.pendingRequests===0,'download circle leases leaked');
});
