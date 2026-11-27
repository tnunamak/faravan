import './no-browser.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tempDir } from './temp-dir.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as p from '../../lib/protocol/index.mjs';
import {HOST_CAPABILITIES} from '../../lib/v1/versions.mjs';

const bin = fileURLToPath(new URL('../../bin/faravan', import.meta.url));
const joinPage = fileURLToPath(new URL('../../public/join/index.html', import.meta.url));
export const instant = () => new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
export function json(res, value, status=200) {
  const body=Buffer.from(p.canonicalize(value));
  res.writeHead(status, {'content-type':'application/json','content-length':body.length}); res.end(body);
}
export function problem(res,status,code) {
  const body=Buffer.from(p.canonicalize({type:'urn:faravan:problem:'+code,title:code.replaceAll('_',' '),
    code,status,retryable:status>=500,outcome:'not_applied'}));
  res.writeHead(status,{'content-type':'application/problem+json','content-length':body.length}); res.end(body);
}
function binary(res,bytes,mediaType) {
  res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,'faravan-media-type':mediaType}); res.end(bytes);
}
// Tiny deterministic TEST-ONLY tar fixture. Production packing/extraction is not reimplemented.
export function resultArchive(text='Synthetic verified result\n',name='summary.txt') {
  const bytes=Buffer.from(text), header=Buffer.alloc(512);
  header.write(name); header.write('0000600\0',100); header.write('0000000\0',108);
  header.write('0000000\0',116); header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);
  header.write('00000000000\0',136); header.fill(32,148,156); header.write('0',156);
  header.write('ustar\0',257); header.write('00',263);
  const sum=header.reduce((a,b)=>a+b,0); header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)]));
}
export async function fixture(t, {managedShutdown = false} = {}) {
  // Explicit lifecycle owners await child/app shutdown before the existing after
  // callback removes this root. Do not register tempDir's synchronous signal drain.
  const root=managedShutdown
    ? await mkdtemp(join(tmpdir(),'faravan-v1-journey-'))
    : tempDir('faravan-v1-journey-');
  const homes=new Map(), circles=new Map(), jobs=new Map(), artifacts=new Map(), requests=[], failures=[], nonces=new Set();
  const provisionHomes=new Set(),pins=new Map(),artifactMediaTypes=new Map();
  const publications=new Map(), rawRequests=[];
  // publications: short code -> {envelope, invite_binding}; rawRequests: everything the server saw, verbatim, for secrecy assertions.
  // A device that runs on a fake clock signs with that clock; the coordinator judges its requests by the same one.
  const clocks=new Map();
  const f={root,homes,circles,jobs,artifacts,requests,failures,override:null,publications,rawRequests,clocks};
  let origin;
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const bytes=Buffer.concat(chunks), body=bytes.length&&req.headers['content-type']==='application/json'?JSON.parse(bytes):null;
      // A fake-clock device is judged at the instant it signed. A request that left before the test advanced the clock
      // can arrive after it, and judging it by the clock's later reading would reject it as skewed.
      const signedAt=()=>{try{return JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload.created*1000;}catch{return Date.now();}};
      const nowMs=clocks.has(req.headers['x-test-device'])?signedAt:Date.now;
      const u=new URL(req.url,origin), parts=u.pathname.split('/'), circleId=parts[3], route='/'+parts.slice(4).join('/');
      const raw={method:req.method,url:req.url,headers:{...req.headers},body:bytes.toString()};
      rawRequests.push(raw);
      res.once('finish',()=>{raw.status=res.statusCode;});
      if(req.method==='GET'&&(u.pathname==='/join'||/^\/i\/[a-z2-7]{10}$/.test(u.pathname))) {
        // The real coordinator serves this same page; the stub mirrors its headers so browser tests see the real policy.
        const page=await readFile(joinPage), short=u.pathname!=='/join';
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':page.length,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
          'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src "+(short?"'self'":"'none'")+"; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
        return res.end(page);
      }
      if(req.method==='GET'&&parts[1]==='v1'&&parts[2]==='invites') {
        // Public, unauthenticated, like the real server: only public material.
        const publication=publications.get(parts[3]);
        if(!publication) return problem(res,404,'not_found');
        if(Date.parse(publication.envelope.payload.expires_at)<=nowMs()) return problem(res,410,'enrollment_expired');
        return json(res,{envelope:publication.envelope,invite_binding:publication.invite_binding});
      }
      // Read-only app proxies can outlive their old ephemeral port. This coordinator is not an app API.
      if(parts[1]!=='v1')return problem(res,404,'not_found');
      assert.equal(parts[2],'circles');
      const proof=JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url'));
      let c=circles.get(circleId);
      const proposed=route==='/roster'&&req.method==='PUT'?body:null;
      if(proposed&&!c) {
        // TEST-ONLY administrator provisioning: trust a separately nominated fixture home,
        // never the root supplied by an arbitrary network request. Real deployment provisions out-of-band.
        let pin;
        for(const home of provisionHomes) {
          try {pin=p.fingerprint(p.exportPublicKey(createPrivateKey(await readFile(join(home,'v1','roots',circleId+'.pem')))));break;}
          catch(error) {if(error.code!=='ENOENT')throw error;}
        }
        if(!pin) return problem(res,404,'circle_not_found');
        assert.equal(p.fingerprint(proposed.payload.root_public_key),pin);pins.set(circleId,pin);
      }
      const recovery=req.method==='GET'&&(route==='/roster'||/^\/rosters\/\d+$/.test(route));
      const enrollmentBootstrap=proof.payload.roster_epoch===0&&
        (route==='/enrollments'&&req.method==='POST'||route.startsWith('/enrollments/')&&req.method==='GET');
      // Match production preflight: current membership and epoch precede crypto/nonce admission.
      // Enrollment/root provisioning keep their separate bootstrap path, not a recovery privilege.
      if(!proposed&&!enrollmentBootstrap) {
        if(!c)return problem(res,404,'circle_not_provisioned');
        if(Date.parse(c.roster.payload.valid_until)<=nowMs())return problem(res,410,'roster_expired');
        if(!p.findMember(c.roster.payload,proof.payload.key_id))return problem(res,403,'forbidden');
        if(recovery?proof.payload.roster_epoch>c.roster.payload.epoch:proof.payload.roster_epoch!==c.roster.payload.epoch)
          return problem(res,409,'roster_stale');
      }
      const members=proposed?.payload.members??c?.roster.payload.members??[];
      const pub=members.find(m=>m.key_id===proof.payload.key_id)?.public_key ??
        (p.fingerprint(proposed?.payload.root_public_key??c?.roster.payload.root_public_key??'')===proof.payload.key_id?
          (proposed?.payload.root_public_key??c.roster.payload.root_public_key):null) ??
        body?.device_public_key ?? c?.enrollments.find(e=>e.device_key_id===proof.payload.key_id)?.device_public_key;
      assert.ok(pub,'request signer must be known to this synthetic circle');
      const expectedEpoch=route.startsWith('/enrollments/')||route==='/enrollments'&&req.method==='POST'?0:
        recovery?proof.payload.roster_epoch:proposed?.payload.epoch??c?.roster.payload.epoch;
      const checked=await p.verifyRequestProof(req.headers['faravan-proof'],{publicKey:pub,now:()=>Math.floor(nowMs()/1000),
        expected:{circle:circleId,key_id:proof.payload.key_id,roster_epoch:expectedEpoch,method:req.method,target:origin+req.url,
          body_digest:p.digestBytes(bytes),content_length:bytes.length,content_type:req.headers['content-type']??'',
          artifact_media_type:req.headers['faravan-media-type']??'',idempotency_key:req.headers['idempotency-key']??''},
        consumeNonce:async(key,nonce)=>{const k=key+nonce;if(nonces.has(k))return false;nonces.add(k);return true;}});
      if(!checked.ok) {
        const code=['invalid_signature','replay','unauthenticated'].includes(checked.code)?checked.code:'invalid_request';
        return problem(res,code==='invalid_request'?400:401,code);
      }
      if(body) assert.equal(bytes.toString(),p.canonicalize(body));
      requests.push({method:req.method,route,circleId,body,proof});
      if(f.override && await f.override({req,res,body,route,circleId})) return;
      if(proposed) {
        const check=p.verifyRoster(body,{circle:circleId,rootFingerprint:pins.get(circleId),now:()=>Math.floor(nowMs()/1000)});
        assert.equal(check.ok,true,JSON.stringify(check));
        // Like the real host (store.mjs), a byte-identical re-publish of the current epoch is a retry, not a conflict.
        if(c&&body.payload.epoch===c.roster.payload.epoch&&p.canonicalize(body)===p.canonicalize(c.roster))return json(res,c.roster);
        if(c) assert.equal(body.payload.epoch,c.roster.payload.epoch+1);
        else {c={roster:body,invites:new Map(),enrollments:[]};circles.set(circleId,c);}
        c.roster=body; return json(res,body);
      }
      assert.ok(c);
      if(route==='/roster') return json(res,c.roster);
      // This fake serves no /enrollments/reject route, so it does not advertise it.
      if(route==='/capabilities'&&req.method==='GET')return json(res,{capabilities:HOST_CAPABILITIES.filter(c=>c!=='enrollment_reject_v1')});
      if(route==='/invites'&&req.method==='POST') {
        // A bare invite (long links) or a publication {code, envelope, invite_binding} (short links).
        const invite=body.envelope??body;
        assert.equal(p.verifyInvite(invite,{circle:circleId,rootFingerprint:p.fingerprint(c.roster.payload.root_public_key),coordinator:origin,now:()=>Math.floor(nowMs()/1000)}).ok,true);
        c.invites.set(invite.payload.invite_id,invite);
        if(body.envelope) {
          assert.equal(p.verifyInviteBinding(invite,body.invite_binding,{invitePublicKey:invite.payload.invite_public_key}).ok,true);
          if(f.refuseShortInvites) return problem(res,400,'invalid_request');
          publications.set(body.code,{envelope:invite,invite_binding:body.invite_binding});
        }
        return json(res,body,201);
      }
      if(route==='/enrollments'&&req.method==='POST') {
        const invite=c.invites.get(body.invite.payload.invite_id); assert.ok(invite);
        if(Date.parse(invite.payload.expires_at)<=nowMs())return problem(res,410,'enrollment_expired');
        assert.equal(p.verifyEnrollmentProof(body.enrollment_proof,{invitePublicKey:invite.payload.invite_public_key,
          circle:circleId,invite_id:invite.payload.invite_id,device_public_key:body.device_public_key}).ok,true);
        const e={enrollment_id:randomUUID(),state:'pending',device_key_id:p.fingerprint(body.device_public_key),
          device_public_key:body.device_public_key,invite_id:invite.payload.invite_id,invite:body.invite,enrollment_proof:body.enrollment_proof};
        c.enrollments.push(e); return json(res,{enrollment_id:e.enrollment_id,state:e.state,device_key_id:e.device_key_id,roster:null},201);
      }
      if(route==='/enrollments'&&req.method==='GET') return json(res,{items:c.enrollments.filter(e=>!c.roster.payload.members.some(m=>m.key_id===e.device_key_id)).map(e=>({enrollment_id:e.enrollment_id,state:e.state,invite_id:e.invite_id,device_public_key:e.device_public_key,enrollment_proof:e.enrollment_proof,created_at:instant()})),next_cursor:null});
      if(route.startsWith('/enrollments/')) {
        const e=c.enrollments.find(e=>e.enrollment_id===parts[5]); assert.ok(e);
        const approved=c.roster.payload.members.some(m=>m.key_id===e.device_key_id);
        return json(res,{enrollment_id:e.enrollment_id,state:approved?'approved':'pending',device_key_id:e.device_key_id,roster:approved?c.roster:null});
      }
      if(route.startsWith('/artifacts/')) {
        const id='sha256:'+parts[5];
        if(req.method==='GET') return artifacts.has(id)?binary(res,artifacts.get(id),artifactMediaTypes.get(id)):problem(res,404,'artifact_not_found');
        assert.equal(p.digestBytes(bytes),id);artifacts.set(id,bytes);artifactMediaTypes.set(id,req.headers['faravan-media-type']);
        return json(res,{digest:id,bytes:bytes.length,media_type:req.headers['faravan-media-type']},201);
      }
      if(route==='/jobs'&&req.method==='POST') {
        assert.equal(p.verifyEnvelope('job',body,pub).ok,true);
        const id=p.digest(body.payload),view={job_digest:id,job:body,state:'queued',attempts_started:0,current_attempt:null,result_digest:null};
        jobs.set(id,view); if(f.dropPublishAck) return req.socket.destroy(); return json(res,view,201);
      }
      if(route==='/jobs') return json(res,{items:[...jobs.values()].filter(v=>v.job.payload.circle===circleId).map(({result,...view})=>view),next_cursor:null});
      const id='sha256:'+parts[5], view=jobs.get(id);
      if(!view) return problem(res,404,'job_not_found');
      if(route.endsWith('/cancel')) {
        assert.equal(p.verifyEnvelope('cancellation',body,pub).ok,true);view.state='cancelled';
        return json(res,{job_digest:id,cancellation_digest:p.digest(body.payload),requested_at:instant(),authority_revoked:true,compute_stopped:true,attempt:null});
      }
      // This host advertises transcript_relay_v1; an idle job still returns its closed relay snapshot.
      if(route.endsWith('/transcript')&&req.method==='GET')return json(res,{job_digest:id,attempt:view.current_attempt?.attempt_id??null,seq:0,at:null,text:'',truncated:false,available:false});
      if(route.endsWith('/result')) return json(res,view.result);
      // The protocol view has a closed shape; result is fixture-only state.
      const {result,...wire}=view; return json(res,wire);
    } catch(error) {failures.push(error);if(!res.headersSent)problem(res,400,'invalid_request');else res.destroy();}
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); origin='http://127.0.0.1:'+server.address().port; f.origin=origin;
  f.home=async(name='owner')=>{if(!homes.has(name)){const home=join(root,name);await mkdir(home);homes.set(name,home);}return homes.get(name);};
  f.provisionFromHome=async(name='owner')=>provisionHomes.add(await f.home(name));
  f.env=async(name='owner')=>({ ...process.env, HOME:await f.home(name),FARAVAN_HOME:await f.home(name),FARAVAN_V1_ORIGIN:undefined,FARAVAN_JOIN_WAIT_MS:'0' });
  f.spawn=async(args,name='owner')=>spawn(process.execPath,[bin,...args],{env:await f.env(name),stdio:['pipe','pipe','pipe']});
  f.cli=async(args,name='owner')=>{
    const child=await f.spawn(args,name);let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    // A hang guard: a CLI process under host load can take well over 15 s to start and answer.
    const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
    try {const [code,signal]=await once(child,'close');assert.equal(signal,null,stderr);return {code,stdout,stderr};}
    finally{clearTimeout(timer);}
  };
  f.complete=async(id,name='owner',{candidate=resultArchive(),candidateMediaType='application/gzip',output,transcript:transcriptText,receipt:receiptExtra={}}={})=>{
    const view=jobs.get(id),job=view.job.payload,key=createPrivateKey(await readFile(join(await f.home(name),'v1','device.pem')));
    const transcript=Buffer.from(transcriptText??'{"synthetic":true}\n');
    const ref=(b,media_type)=>{const digest=p.digestBytes(b);artifacts.set(digest,b);artifactMediaTypes.set(digest,media_type);return{digest,bytes:b.length,media_type};};
    const now=instant(),holder=p.fingerprint(p.exportPublicKey(key)),attempt_id=randomUUID();
    const result=p.signEnvelope('result',{schema:'faravan.result.v1',circle:job.circle,job_digest:id,attempt_id,generation:1,executor:holder,
      roster_epoch:job.roster_epoch,submitted_at:now,...(output?{output}:{}),candidate:ref(candidate,candidateMediaType),transcript:ref(transcript,'application/x-ndjson'),
      receipt:{schema:'faravan.receipt.v1',self_reported:true,harness:job.requirements.harness?.[0]??'test-agent',harness_version:'test',
        model:job.requirements.model?.any_of[0]??'test-model',backend:'synthetic',limits_applied:job.requirements.limits,
        egress_applied:job.requirements.egress,capabilities_applied:job.requirements.capabilities,started_at:now,finished_at:now,duration_ms:0,source:job.source,...receiptExtra}},key);
    Object.assign(view,{state:'result-accepted',attempts_started:1,result_digest:p.digest(result.payload),result,
      current_attempt:{attempt_id,job_digest:id,generation:1,holder,state:'completed',claimed_at:now,execution_started_at:now,lease_expires_at:now,reason:null,compute_stopped:true,stopped_at:now}});
    return result;
  };
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});
    assert.deepEqual(failures,[],failures.map(e=>e.stack).join('\n'));});
  return f;
}
export function parseOne(result) {
  assert.equal(result.code,0,result.stderr+'\n'+result.stdout);
  assert.equal(result.stdout.trim().split('\n').length,1,result.stdout);
  return JSON.parse(result.stdout);
}
