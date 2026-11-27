import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as p from '../lib/protocol/index.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {createV1Handler} from '../lib/v1/server.mjs';
import {createClient} from '../lib/v1/client.mjs';
import {createHostAdmission} from '../lib/v1/admission.mjs';

// Synthetic public TEST-ONLY keys; real SQLite and loopback HTTP, no providers.
const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
assert.match(golden.warning,/TEST-ONLY/);
const keys=golden.keys.map(k=>p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
const ids=keys.map(k=>p.fingerprint(p.exportPublicKey(k)));
const vectors=Object.fromEntries(Object.entries(golden.objects).map(([k,v])=>[k,v.envelope]));
const circle=vectors.job.payload.circle,base='/v1/circles/'+circle;
const iso=n=>new Date(n*1000).toISOString().replace('.000Z','Z');
const ad={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],
  enforced_limits:Object.keys(vectors.job.payload.requirements.limits),max_limits:{...vectors.job.payload.requirements.limits,wall_seconds:10000}};
const route=id=>'/jobs/'+id.slice(7)+'/transcript';
const rejected=(fn,code)=>assert.rejects(fn,{code});
async function fixture(t,{quotas={},limits={}}={}) {
  const dir=mkdtempSync(join(tmpdir(),'spk-relay-')),path=join(dir,'store.sqlite');
  let now=Date.parse(vectors.job.payload.created_at)/1000,handler;
  const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  // A circle owner who is neither job author nor lender is still unrelated.
  let roster=p.signEnvelope('roster',{...vectors.roster.payload,members:[...vectors.roster.payload.members,
    {key_id:ids[2],public_key:p.exportPublicKey(keys[2]),joined_epoch:7}]},keys[2]);
  const store=openV1Store({path,circle,origin,rootFingerprint:ids[2],initialRoster:roster,clock:()=>now,quotas});
  t.after(async()=>{handler?.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  roster=p.signEnvelope('roster',{...roster.payload,epoch:8},keys[2]);
  store.installRoster(roster,{proof:p.buildRequestProof({circle,roster_epoch:8,method:'PUT',target:origin+base+'/roster',
    body:Buffer.from(p.canonicalize(roster)),content_type:'application/json',created:now,nonce:randomBytes(24).toString('base64url')},keys[2])});
  const ownerDb=new DatabaseSync(path);try {assert.equal(JSON.parse(ownerDb.prepare("SELECT data FROM circle WHERE id='config'").get().data).owner_device,ids[2]);}finally{ownerDb.close();}
  const admission=createHostAdmission({clock:()=>now,limits});
  handler=createV1Handler({store,blobDir:join(dir,'blobs'),clock:()=>now,limits,admission});

  const clients=ids.map((_,i)=>createClient({origin,circle,deviceKey:keys[i],pinnedRootFingerprint:ids[2],clock:()=>now,
    rosterCache:{get:async()=>({current:roster,history:[],highestAcceptedEpoch:8,highestAcceptedDigest:p.digest(roster.payload)}),set:async()=>{}},retry:{maxAttempts:1}}));
  const f={store,path,clients,admission,origin,advance:n=>{now+=n;},get now(){return now;},
    ctx(i,method,path,body,key=randomUUID()) {const bytes=method==='GET'?Buffer.alloc(0):Buffer.from(p.canonicalize(body));return {proof:p.buildRequestProof({circle,roster_epoch:8,method,target:origin+base+path,
      body_digest:p.digestBytes(bytes),content_length:Math.min(bytes.length,262144),content_type:method==='GET'?'':'application/json',
      artifact_media_type:'',idempotency_key:method==='POST'?key:'',created:now,nonce:randomBytes(24).toString('base64url')},keys[i])};},
    async raw(i,method,path,body,key) {
      const proof=f.ctx(i,method,path,body,key).proof;
      const signed=p.strictParse(p.decodeBase64url(proof)).payload;
      return fetch(origin+base+path,{method,headers:{'Faravan-Proof':proof,...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':signed.idempotency_key}:{})},
        ...(method==='POST'?{body:p.canonicalize(body)}:{})});
    },
    async job(overrides={}) {
      const prompt=await clients[0].uploadArtifact(Buffer.from('synthetic prompt'),'text/plain');
      const source={kind:'archive',artifact:await clients[0].uploadArtifact(Buffer.from('synthetic archive'),'application/gzip')};
      const payload={...vectors.job.payload,prompt,source,roster_epoch:8,intent_id:randomUUID(),created_at:iso(now),expires_at:iso(now+12000),
        requirements:{...vectors.job.payload.requirements,limits:{...vectors.job.payload.requirements.limits,wall_seconds:10000}},...overrides};
      return (await clients[0].submitJob(payload)).jobDigest;
    },
    async claim(id,i=1,start=true) {const {attempt}=await clients[i].claimJob(id,ad);return start?clients[i].startAttempt(attempt):attempt;},
    post(id,a,{seq=1,text='{"type":"text","text":"synthetic"}\n',truncated=false}={},i=1) {
      const body={attempt:a.attempt_id,seq,text,truncated};return store.postLiveTranscript(ids[i],id,body,f.ctx(i,'POST',route(id),body));
    },
    read(id,i=0) {return store.getLiveTranscript(ids[i],id,f.ctx(i,'GET',route(id)));},
    heartbeat:()=>clients[1].heartbeat({boot:'synthetic-boot',seq:0,intent:{state:'ready'},execution:{state:'running'},blockers:[],agents:[],capabilities:['transcript_relay_v1']}),
    rows() {const db=new DatabaseSync(path);try{return db.prepare('SELECT * FROM live_transcripts').all();}finally{db.close();}}
  };return f;
}
async function problem(response,status,code) {assert.equal(response.status,status);assert.equal((await response.json()).code,code);}

test('relay HTTP: current author/holder only, first empty snapshot, latest replacement, small replay acknowledgement',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id),author=f.clients[0],lender=f.clients[1];
  assert.ok((await author.capabilities()).capabilities.includes('transcript_relay_v1'));
  const empty={job_digest:id,attempt:a.attempt_id,seq:0,at:null,text:'',truncated:false,available:false};
  assert.deepEqual(await author.fetchLiveTranscript(id),empty);
  await lender.heartbeat({capabilities:['transcript_relay_v1']});assert.deepEqual(await author.fetchLiveTranscript(id),empty,'member declarations alone do not claim lender support');
  await f.heartbeat();assert.deepEqual(await author.fetchLiveTranscript(id),{...empty,available:true});
  await problem(await f.raw(2,'GET',route(id)),404,'not_found');
  await problem(await f.raw(2,'POST',route(id),{attempt:a.attempt_id,seq:1,text:'private',truncated:false}),404,'not_found');
  await problem(await f.raw(0,'POST',route(id),{attempt:a.attempt_id,seq:1,text:'wrong writer',truncated:false}),403,'forbidden');
  const first=await lender.postLiveTranscript(a,{seq:1,text:'',truncated:false,idempotencyKey:'first-snapshot'});
  assert.deepEqual(first,{job_digest:id,attempt:a.attempt_id,seq:1,at:iso(f.now)});
  assert.deepEqual(await lender.postLiveTranscript(a,{seq:1,text:'',truncated:false,idempotencyKey:'first-snapshot'}),first);
  assert.equal((await author.fetchLiveTranscript(id)).available,true,'an empty upload is available');
  await rejected(()=>lender.postLiveTranscript(a,{seq:2,text:'too soon',truncated:false}),'rate_limited');
  f.advance(2);const ack=await lender.postLiveTranscript(a,{seq:2,text:'{"event":"done"}\n',truncated:true});
  assert.ok(Buffer.byteLength(JSON.stringify(ack))<250,'snapshot never enters mutation replay storage');
  assert.deepEqual(await author.fetchLiveTranscript(id),{...ack,text:'{"event":"done"}\n',truncated:true,available:true});
  assert.equal((await lender.fetchLiveTranscript(id)).text,'{"event":"done"}\n');
  assert.equal(f.rows().length,1,'replace, do not append snapshots');
  f.advance(90);assert.equal((await author.fetchLiveTranscript(id)).available,true,'retained snapshot survives stale heartbeat');
  await rejected(()=>lender.postLiveTranscript(a,{seq:2,text:'stale',truncated:false}),'stale_attempt');
});

test('relay lifecycle: no attempt, pre-start, wrong-job, old attempt, current holder, expiry and audience',async t=>{
  const f=await fixture(t),id=await f.job();
  assert.deepEqual(f.read(id),{job_digest:id,attempt:null,seq:0,at:null,text:'',truncated:false,available:false});
  const old=await f.claim(id,1,false);
  await problem(await f.raw(1,'POST',route(id),{attempt:old.attempt_id,seq:1,text:'',truncated:false}),409,'stale_attempt');
  await f.clients[1].release(old,'synthetic release');
  const a=await f.claim(id,2);
  await f.clients[2].observeExecutionStart(a);
  await problem(await f.raw(1,'GET',route(id)),404,'not_found');
  await problem(await f.raw(1,'POST',route(id),{attempt:old.attempt_id,seq:1,text:'',truncated:false}),409,'stale_attempt');
  const other=await f.job({audience:{device_keys:[ids[0],ids[1]]}});
  await problem(await f.raw(0,'POST',route(other),{attempt:a.attempt_id,seq:1,text:'',truncated:false}),404,'not_found');
  await problem(await f.raw(2,'GET',route(other)),404,'not_found');
  await problem(await f.raw(2,'POST',route(other),{attempt:a.attempt_id,seq:1,text:'',truncated:false}),404,'not_found');
  await problem(await f.raw(2,'POST',route(id),{attempt:old.attempt_id,seq:1,text:'',truncated:false}),403,'forbidden');
  const own=await f.clients[2].postLiveTranscript(a,{seq:1,text:'new attempt only',truncated:false});
  assert.equal(f.read(id).attempt,own.attempt);
  f.advance(121);
  await rejected(()=>f.clients[2].postLiveTranscript(a,{seq:2,text:'expired',truncated:false}),'job_terminal');
  assert.equal(f.read(id).text,'new attempt only','expiry does not erase recent data');
});

test('relay limits: UTF8 bytes, canonical body, strict fields, seq, boolean and HTTP size ceiling',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id),client=f.clients[1];
  const body={attempt:a.attempt_id,seq:1,text:'é'.repeat(32768),truncated:false};
  const ok=await f.raw(1,'POST',route(id),body);assert.equal(ok.status,200);await ok.json();
  assert.equal(Buffer.byteLength(f.read(id).text),65536);
  f.advance(2);await client.postLiveTranscript(a,{seq:2,text:'\u0000'.repeat(40000),truncated:true});
  assert.equal(f.read(id).text.length,40000,'canonical escaping may exceed the raw snapshot byte cap');
  for(const bad of [{...body,text:body.text+'é'},{...body,text:'\u0000'.repeat(65536)}])
    await problem(await f.raw(1,'POST',route(id),bad),413,'payload_too_large');
  for(const extra of [{seq:0},{seq:1.5},{seq:-1},{seq:Number.MAX_SAFE_INTEGER+1},{truncated:'false'},{attempt:'invalid'},{extra:true}]) {
    const bad={...body,text:'',...extra};
    const response=await f.raw(1,'POST',route(id),bad);assert.equal(response.status,400);await response.json();
  }
  for(const bad of [{seq:0,text:'',truncated:false},{seq:2,text:'x'.repeat(65537),truncated:false},{seq:2,text:'',truncated:1}])
    await rejected(()=>client.postLiveTranscript(a,bad),bad.text.length>65536?'payload_too_large':'invalid_request');
});

test('relay quotas are separate, replacement uses delta and failed writes roll back',async t=>{
  const f=await fixture(t,{quotas:{transcriptDeviceBytes:800,transcriptCircleBytes:1200}});
  const id=await f.job(),a=await f.claim(id);f.post(id,a,{text:'x'.repeat(300)});
  const other=await f.job(),b=await f.claim(other);
  assert.throws(()=>f.post(other,b,{text:'y'.repeat(300)}),{code:'quota_exceeded'});
  assert.equal(f.read(other).seq,0);
  f.advance(2);f.post(id,a,{seq:2,text:''});f.post(other,b,{text:'y'.repeat(300)});
  const third=await f.job(),c=await f.claim(third,2);
  assert.throws(()=>f.post(third,c,{text:'z'.repeat(300)},2),{code:'quota_exceeded'});
  assert.equal(f.read(third).seq,0);
  f.advance(2);f.post(other,b,{seq:2,text:''});f.post(third,c,{text:'z'.repeat(300)},2);
  assert.equal(f.read(third).seq,1);
  const db=new DatabaseSync(f.path);try {
    const replay=db.prepare('SELECT response FROM idempotency WHERE device=?').all(ids[1]);
    assert.ok(replay.every(r=>!r.response.includes('x'.repeat(100))&&!r.response.includes('y'.repeat(100))));
  } finally {db.close();}
});

test('relay retention removes snapshots at 24h, job deletion removes relay rows',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id);f.post(id,a);
  f.advance(86400);assert.equal(f.read(id).available,false);assert.equal(f.rows().length,0);
  const fresh=await f.job(),b=await f.claim(fresh);f.post(fresh,b);
  await f.clients[1].observeExecutionStart(b);
  await f.clients[1].fail(b,'synthetic failure');await f.clients[0].deleteJob(fresh);
  assert.equal(f.rows().length,0);await problem(await f.raw(0,'GET',route(fresh)),404,'not_found');
});

test('relay maximum is 2048 accepted updates even when seq jumps; each uses normal daily mutation budget',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id);
  for(let n=1;n<=2048;n++) {
    if(n%50===0) await f.clients[1].renew(a);
    f.post(id,a,{seq:n*2,text:''});f.advance(2);
  }
  assert.throws(()=>f.post(id,a,{seq:5000,text:''}),{code:'quota_exceeded'});
  assert.equal(f.read(id).seq,4096);
  const db=new DatabaseSync(f.path);try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM idempotency WHERE request_digest IS NOT NULL AND response LIKE ?').get('%"seq":%').n,2048);
  } finally {db.close();}
});

test('relay daily mutation exhaustion atomically rejects snapshot',async t=>{
  const f=await fixture(t,{quotas:{idempotencyRowsPerDevice:3}}),id=await f.job(),a=await f.claim(id);
  // Holder has spent two mutations: claim and start. One snapshot fills its budget.
  f.post(id,a,{text:'first'});f.advance(2);
  assert.throws(()=>f.post(id,a,{seq:2,text:'must not persist'}),{code:'quota_exceeded'});
  assert.equal(f.read(id).text,'first');
});

test('relay shares global request and member JSON body admission',async t=>{
  const f=await fixture(t,{limits:{maxRequests:4,maxRequestsPerSource:4,maxMemberWorkPerDevice:1}}),id=await f.job(),a=await f.claim(id);
  const source='127.0.0.1';
  const global=Array.from({length:4},()=>f.admission.acquire('requests','another-source'));
  await problem(await f.raw(0,'GET',route(id)),429,'rate_limited');global.forEach(release=>release());
  for(const kind of ['memberWork','memberBodies']) {
    const leases=Array.from({length:kind==='memberBodies'?3:1},()=>f.admission.acquire(kind,source,ids[1],circle));
    await problem(await f.raw(1,'POST',route(id),{attempt:a.attempt_id,seq:1,text:'',truncated:false}),429,'rate_limited');
    leases.forEach(release=>release());
  }
  assert.equal((await f.raw(1,'POST',route(id),{attempt:a.attempt_id,seq:1,text:'',truncated:false})).status,200);
});

test('relay client gates old hosts and rejects malformed snapshots and acknowledgements',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id);
  let value={capabilities:[]},capStatus=200;const paths=[];
  const make=()=>createClient({origin:f.origin,circle,deviceKey:keys[1],pinnedRootFingerprint:ids[2],clock:()=>f.now,
    rosterCache:{get:async()=>({current:vectors.roster,history:[],highestAcceptedEpoch:7,highestAcceptedDigest:p.digest(vectors.roster.payload)}),set:async()=>{}},retry:{maxAttempts:1},
    fetch:async(url)=>{paths.push(url);return new Response(p.canonicalize(url.endsWith('/capabilities')?{capabilities:value.capabilities??['transcript_relay_v1']}:value),{status:url.endsWith('/capabilities')?capStatus:200,headers:{'Content-Type':capStatus===404?'application/problem+json':'application/json'}});}});
  await rejected(()=>make().fetchLiveTranscript(id),'host_too_old');
  await rejected(()=>make().postLiveTranscript(a,{seq:1,text:'',truncated:false}),'host_too_old');
  capStatus=404;await rejected(()=>make().fetchLiveTranscript(id),'host_too_old');
  capStatus=200;assert.ok(paths.every(path=>path.endsWith('/capabilities')));
  for(const bad of [
    {job_digest:id,attempt:a.attempt_id,seq:0,at:null,text:'hidden',truncated:false,available:false},
    {job_digest:id,attempt:a.attempt_id,seq:1,at:iso(f.now),text:'x'.repeat(65537),truncated:false,available:true},
    {job_digest:id,attempt:a.attempt_id,seq:1,at:null,text:'',truncated:false,available:true},
    {job_digest:id,attempt:a.attempt_id,seq:0,at:null,text:'',truncated:false,available:false,extra:1}
  ]) {value=bad;await assert.rejects(()=>make().fetchLiveTranscript(id));}
  value={job_digest:id,attempt:a.attempt_id,seq:2,at:iso(f.now)};
  await rejected(()=>make().postLiveTranscript(a,{seq:1,text:'',truncated:false}),'invalid_response');
});


test('relay atomic HTTP races and a second store preserve sequence, rate and replacement',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id);
  const responses=await Promise.all(['first','second'].map(text=>f.raw(1,'POST',route(id),{attempt:a.attempt_id,seq:1,text,truncated:false})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);await Promise.all(responses.map(r=>r.json()));
  const retained=f.read(id);assert.equal(retained.seq,1);assert.ok(['first','second'].includes(retained.text));
  const second=openV1Store({path:f.path,clock:()=>f.now});
  try {
    assert.deepEqual(second.getLiveTranscript(ids[0],id,f.ctx(0,'GET',route(id))),retained);
    const body={attempt:a.attempt_id,seq:2,text:'restart replacement',truncated:false};
    assert.throws(()=>second.postLiveTranscript(ids[1],id,body,f.ctx(1,'POST',route(id),body)),{code:'rate_limited'});
    f.advance(2);second.postLiveTranscript(ids[1],id,body,f.ctx(1,'POST',route(id),body));
    assert.equal(f.read(id).text,body.text);assert.equal(f.rows().length,1);
  } finally {second.close();}
});

test('relay no-data heartbeat freshness and no query or unauthenticated access',async t=>{
  const f=await fixture(t),id=await f.job(),a=await f.claim(id);
  await f.heartbeat();assert.equal(f.read(id).available,true);
  f.advance(90);assert.equal(f.read(id).available,false);
  await problem(await f.raw(0,'GET',route(id)+'?attempt='+a.attempt_id),400,'invalid_request');
  await problem(await fetch(f.origin+base+route(id)),401,'unauthenticated');
});
