import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {createV1Handler} from '../lib/v1/server.mjs';
const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
const keys=golden.keys.map(k=>p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex'))),pub=keys.map(p.exportPublicKey),fp=pub.map(p.fingerprint);
const baseRoster=golden.objects.roster.envelope,circle=baseRoster.payload.circle,origin='https://coordinator.example';
const now=Date.parse('2026-10-09T12:00:00Z')/1000;
function fixture(t,role='member',blocked=false,state='active',quotas={}) {
  const dir=mkdtempSync(join(tmpdir(),'faravan-people-policy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const roster=p.signEnvelope('roster',{...baseRoster.payload,governance:{version:1,owner_person:fp[0],state,people:baseRoster.payload.members.map(m=>({person_id:m.key_id,role:m.key_id===fp[0]?'owner':role,blocked:m.key_id===fp[0]?false:blocked}))}},keys[2]);
  const store=openV1Store({path:join(dir,'store.sqlite'),circle,origin,rootFingerprint:fp[2],initialRoster:roster,clock:()=>now,quotas});t.after(()=>store.close());
  const ctx=(d,method,route,body,epoch=roster.payload.epoch)=>({proof:p.buildRequestProof({circle,roster_epoch:epoch,method,target:origin+'/v1/circles/'+circle+route,body:method==='GET'?Buffer.alloc(0):Buffer.from(p.canonicalize(body)),content_type:method==='GET'?'':'application/json',created:now,nonce:randomBytes(16).toString('base64url'),idempotency_key:method==='POST'?randomUUID():''},keys[d])});
  return {store,roster,ctx,dir};
}
test('coordinator enforces blocked and lend-only borrowers before admitting artifacts',t=>{
  for(const [role,blocked,state] of [['lend-only',false,'active'],['member',true,'active'],['member',false,'archived'],['member',false,'closed']]) {
    const {store,roster,ctx}=fixture(t,role,blocked,state),job=p.signEnvelope('job',{...golden.objects.job.envelope.payload,author:fp[1],roster_epoch:roster.payload.epoch},keys[1]);
    assert.throws(()=>store.publishJob(job,ctx(1,'POST','/jobs',job)),e=>e.code==='forbidden');
    assert.ok(store.getRoster(fp[1],ctx(1,'GET','/roster')).payload);
  }
});
test('coordinator refuses borrow-only and blocked claimants, governance downgrade, reopening closed circle',t=>{
  for(const [role,blocked] of [['borrow-only',false],['member',true]]){
    const {store,ctx}=fixture(t,role,blocked);
    const ad={harnesses:['codex'],models:['example-model'],capabilities:['patch-output'],egress:['provider-only'],enforced_limits:Object.keys(golden.objects.job.envelope.payload.requirements.limits),max_limits:golden.objects.job.envelope.payload.requirements.limits};
    const body={advertisement:ad,lease_seconds:120};
    assert.throws(()=>store.claimJob(fp[1],'sha256:'+'a'.repeat(64),ad,ctx(1,'POST','/jobs/'+ 'a'.repeat(64)+'/claim',body)),e=>e.code==='forbidden');
  }
  const {store,ctx,roster}=fixture(t,'member',false,'closed');
  const {governance,...legacy}=roster.payload;
  for(const payload of [{...legacy,epoch:legacy.epoch+1},{...roster.payload,epoch:legacy.epoch+1,governance:{...governance,state:'active'}}]){
    const signed=p.signEnvelope('roster',payload,keys[2]);
    assert.throws(()=>store.installRoster(signed,ctx(0,'PUT','/roster',signed,payload.epoch)),e=>e.code==='forbidden');
  }
});
test('queued blob cleanup survives a replacement reservation until release',t=>{
  const {store,roster,ctx,dir}=fixture(t,'member',false,'active',{unreferencedArtifactGraceSeconds:0});
  const bytes=Buffer.from('reserved blob'),ref={digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'};
  const name=ref.digest.slice(7),path=join(dir,name);
  store.setBlobRemover(name=>rmSync(join(dir,name)));
  const reserve=()=>store.reserveArtifact(fp[0],ref,{proof:p.buildRequestProof({
    circle,roster_epoch:roster.payload.epoch,method:'PUT',target:origin+'/v1/circles/'+circle+'/artifacts/'+name,
    body:bytes,content_type:'application/octet-stream',artifact_media_type:ref.media_type,
    created:now,nonce:randomBytes(16).toString('base64url'),idempotency_key:''
  },keys[0])});
  const initial=reserve();
  writeFileSync(path,bytes);
  store.commitArtifact(fp[0],initial.reservation_id,ref,ctx(0,'POST','/artifact-reservations/'+initial.reservation_id+'/commit',ref));
  const replacement=reserve();
  assert.equal(existsSync(path),true,'the active reservation must protect the queued blob');
  assert.deepEqual(store.getQuotas(fp[0],ctx(0,'GET','/quotas')).circle,
    {retained_bytes:0,reserved_bytes:bytes.length,uploads:1});
  store.collect();
  assert.equal(existsSync(path),true,'repeated maintenance must keep the cleanup pending');
  store.releaseArtifactReservation(fp[0],replacement.reservation_id,
    ctx(0,'POST','/artifact-reservations/'+replacement.reservation_id+'/release',{}));
  assert.equal(existsSync(path),false,'releasing the last reservation must remove the queued blob');
  assert.deepEqual(store.getQuotas(fp[0],ctx(0,'GET','/quotas')).circle,
    {retained_bytes:0,reserved_bytes:0,uploads:0});
});

test('startup upload cleanup preserves bytes owned by a non-transport reservation',t=>{
  const dir=mkdtempSync(join(tmpdir(),'faravan-shared-upload-'));
  const path=join(dir,'store.sqlite'),blobDir=join(dir,'blobs');
  const bytes=Buffer.from('retained shared upload\n');
  const ref={digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'};
  const blob=join(blobDir,ref.digest.slice(7)),route='/artifacts/'+ref.digest.slice(7);
  mkdirSync(blobDir);
  let store,handler;
  t.after(()=>{handler?.close();store?.close();rmSync(dir,{recursive:true,force:true});});
  const options={path,circle,origin,rootFingerprint:fp[2],initialRoster:baseRoster,clock:()=>now};
  const ctx=(method,target,body,upload=false)=>({proof:p.buildRequestProof({
    circle,roster_epoch:baseRoster.payload.epoch,method,target:origin+'/v1/circles/'+circle+target,
    body:upload?bytes:method==='GET'?Buffer.alloc(0):Buffer.from(p.canonicalize(body)),
    content_type:upload?'application/octet-stream':method==='GET'?'':'application/json',
    artifact_media_type:upload?ref.media_type:'',created:now,
    nonce:randomBytes(16).toString('base64url'),idempotency_key:method==='POST'?randomUUID():''
  },keys[0])});
  store=openV1Store(options);
  const abandoned=store.reserveArtifact(fp[0],ref,{...ctx('PUT',route,null,true),transport:true});
  // Installation reached disk, but a later IO failure rolled back retention.
  assert.throws(()=>store.finishArtifactUpload(fp[0],abandoned.reservation_id,ref,()=>{
    writeFileSync(blob,bytes);
    throw Object.assign(new Error('injected directory sync failure'),{code:'EIO'});
  },abandoned.owner_token,{verifiedInput:true}),error=>error.code==='internal_error');
  store.close();store=null;
  store=openV1Store(options);
  let failCleanup=true,cleanupFailures=0;
  handler=createV1Handler({store,blobDir,clock:()=>now,uploadIO:{unlinkSync(file){
    if(file===blob&&failCleanup){cleanupFailures++;throw Object.assign(new Error('injected unlink failure'),{code:'EIO'});}
    return unlinkSync(file);
  }}});
  assert.ok(cleanupFailures>0,'restart attempted to clean the abandoned installation');
  const pending=store.reserveArtifact(fp[0],ref,ctx('PUT',route,null,true));
  assert.deepEqual(readFileSync(blob),bytes,'the new reservation owns existing verified bytes');
  failCleanup=false;
  const commitRoute='/artifact-reservations/'+pending.reservation_id+'/commit';
  assert.deepEqual(store.commitArtifact(fp[0],pending.reservation_id,ref,ctx('POST',commitRoute,ref)),ref);
  assert.deepEqual(store.getArtifact(fp[0],ref.digest,ctx('GET',route)),ref);
  assert.deepEqual(readFileSync(blob),bytes,'retained metadata must still have its shared bytes');
  assert.deepEqual(store.listArtifactReservations(fp[0],ctx('GET','/artifact-reservations')),[]);
  assert.deepEqual(store.getQuotas(fp[0],ctx('GET','/quotas')).device,
    {retained_bytes:bytes.length,reserved_bytes:0,uploads:0});
});
