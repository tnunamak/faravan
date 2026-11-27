import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {openV1Store} from '../lib/v1/store.mjs';
import {invitationRevocation,enrollmentRejection} from '../lib/v1/invitation-revoke.mjs';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import {projectMembership} from '../lib/v1/membership-projection.mjs';

// Regression coverage for coordinator revocation and device membership evidence.
// Golden keys are public TEST-ONLY vectors; all storage is temporary, no real backend.
function fixture(t) {
  const golden=JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url)));
  const keys=golden.keys.map(k=>p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
  const initial=golden.objects.roster.envelope,circle=initial.payload.circle;
  const origin='http://127.0.0.1:23123';let now=Date.parse('2026-10-09T12:00:00Z')/1000;
  const dir=mkdtempSync(join(tmpdir(),'roster-model-'));
  let store;
  const open=()=>store=openV1Store({path:join(dir,'store.sqlite'),origin,circle,rootFingerprint:p.fingerprint(keys[2]),initialRoster:initial,clock:()=>now});
  open();t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const ctx=(key,method,route,body,epoch)=>({proof:p.buildRequestProof({circle,roster_epoch:epoch,method,
    target:origin+'/v1/circles/'+circle+route,...(method==='GET'?{body_digest:p.digestBytes(Buffer.alloc(0)),content_length:0}:{body:Buffer.from(p.canonicalize(body))}),
    content_type:method==='GET'?'':'application/json',artifact_media_type:'',idempotency_key:method==='POST'?randomUUID():'',created:now,nonce:randomBytes(24).toString('base64url')},key)});
  const invite=p.createInvite({circle,coordinator:origin,invite_id:randomUUID(),invite_public_key:p.exportPublicKey(keys[3]),created_at:new Date(now*1000).toISOString().replace('.000Z','Z'),expires_at:new Date((now+3600)*1000).toISOString().replace('.000Z','Z'),display_name:'Test'},keys[2]);
  store.registerInvite(invite,ctx(keys[0],'POST','/invites',invite,7));
  const guest=p.generateDeviceKeyPair().privateKey,pub=p.exportPublicKey(guest),id=p.fingerprint(pub);
  const body={invite,device_public_key:pub,enrollment_proof:p.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:pub},keys[3])};
  const e=store.createEnrollment(body,ctx(guest,'POST','/enrollments',body,0));
  const add=p.createRoster({...initial.payload,epoch:8,members:[...initial.payload.members,{key_id:id,public_key:pub,joined_epoch:8}]},keys[2]);
  return {get store(){return store;},keys,initial,origin,now,circle,invite,guest,id,e,add,ctx,restart(){store.close();open();},advance(seconds){now+=seconds;}};
}

test('revoking an invite fences a roster prepared from its pending enrollment',t=>{
  const f=fixture(t);
  const revoke=invitationRevocation({circle:f.circle,origin:f.origin,epoch:7,inviteId:f.invite.payload.invite_id,now:f.now,rootKey:f.keys[2]});
  f.store.revokeInvite(revoke,f.ctx(f.keys[0],'POST','/invites/revoke',revoke,7));
  f.restart();
  // Prepare -> revoke -> restart -> delayed commit. Removal never ran, so there is no device tombstone.
  assert.throws(()=>f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)),e=>e.code==='forbidden');
});

test('a removed device cannot read an old approved enrollment after coordinator restart',t=>{
  const f=fixture(t);
  f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8));
  const removed=p.createRoster({...f.initial.payload,epoch:9},f.keys[2]);
  f.store.installRoster(removed,f.ctx(f.keys[0],'PUT','/roster',removed,9));
  f.restart();
  const answer=f.store.getEnrollment(f.id,f.e.enrollment_id,f.ctx(f.guest,'GET','/enrollments/'+f.e.enrollment_id,null,0));
  assert.notEqual(answer.state,'approved');
});

test('accepting the signed removal roster clears the device membership projection',async t=>{
  const c=await realCoordinator(t),id=c.circle.id;
  const link=await c.owner.createInvite(id),guest=await c.device('guest');
  await guest.joinCircle(link);await c.owner.approveEnrollments(id);await guest.refreshRoster(id);
  assert.equal(projectMembership(await guest.selectCircle(id)).phase,'approved');
  await c.owner.removeMember(id,guest.keyId);
  const fresh=await c.owner.rosterCache(id).get();
  assert.equal(p.findMember(fresh.current.payload,guest.keyId),null);
  // Supply the genuine removal roster directly: even learning it does not clear the membership bit.
  await guest.rosterCache(id).set(fresh);
  assert.notEqual(projectMembership(await guest.selectCircle(id)).phase,'approved');
});

test('coordinator keeps the epoch fence and removed-key tombstone across restart',t=>{
  const f=fixture(t);
  f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8));
  const removed=p.createRoster({...f.initial.payload,epoch:9},f.keys[2]);
  f.store.installRoster(removed,f.ctx(f.keys[0],'PUT','/roster',removed,9));
  f.restart();
  assert.throws(()=>f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)),e=>e.code==='roster_stale');
  const replay=p.createRoster({...f.add.payload,epoch:10},f.keys[2]);
  assert.throws(()=>f.store.installRoster(replay,f.ctx(f.keys[0],'PUT','/roster',replay,10)),e=>e.code==='forbidden');
});

test('device cache rejects an older roster after accepting a newer one',async t=>{
  const c=await realCoordinator(t),id=c.circle.id;
  const before=await c.owner.rosterCache(id).get();
  await c.owner.updateCircleProfile(id,{name:'New name'});
  const newer=await c.owner.rosterCache(id).get();
  assert.ok(newer.highestAcceptedEpoch>before.highestAcceptedEpoch);
  await assert.rejects(c.owner.rosterCache(id).set(before),e=>e.code==='roster_stale');
  assert.equal((await c.owner.rosterCache(id).get()).highestAcceptedEpoch,newer.highestAcceptedEpoch);
});


test('a removed offline device cannot dispatch with its stale signed roster', t => {
  const f=fixture(t);
  f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8));
  const cached=f.add;
  const removed=p.createRoster({...f.initial.payload,epoch:9},f.keys[2]);
  f.store.installRoster(removed,f.ctx(f.keys[0],'PUT','/roster',removed,9));
  f.restart();
  // The guest never receives the removal roster and signs with its cached epoch.
  assert.ok(p.findMember(cached.payload,f.id));
  const job=p.signEnvelope('job',{...JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json',import.meta.url))).objects.job.envelope.payload,
    author:f.id,roster_epoch:cached.payload.epoch},f.guest);
  assert.throws(()=>f.store.publishJob(job,f.ctx(f.guest,'POST','/jobs',job,cached.payload.epoch)),e=>e.code==='forbidden');
});

test('an explicitly added device without enrollment history can still join',t=>{
  const f=fixture(t),key=p.generateDeviceKeyPair().privateKey,pub=p.exportPublicKey(key);
  const direct=p.createRoster({...f.initial.payload,epoch:8,members:[...f.initial.payload.members,
    {key_id:p.fingerprint(pub),public_key:pub,joined_epoch:8}]},f.keys[2]);
  assert.equal(f.store.installRoster(direct,f.ctx(f.keys[0],'PUT','/roster',direct,8)).payload.epoch,8);
});

test('a shared rejection needs circle authority and fences a roster signed before it',t=>{
  const f=fixture(t);
  const reject=key=>enrollmentRejection({circle:f.circle,origin:f.origin,epoch:7,enrollmentId:f.e.enrollment_id,now:f.now,rootKey:key});
  const forged=reject(f.keys[0]);
  assert.throws(()=>f.store.rejectEnrollment(forged,f.ctx(f.keys[0],'POST','/enrollments/reject',forged,7)),e=>e.code==='forbidden');
  const body=reject(f.keys[2]);
  assert.equal(f.store.rejectEnrollment(body,f.ctx(f.keys[0],'POST','/enrollments/reject',body,7)).state,'rejected');
  f.restart();
  assert.equal(f.store.getEnrollment(f.id,f.e.enrollment_id,f.ctx(f.guest,'GET','/enrollments/'+f.e.enrollment_id,null,0)).state,'rejected');
  assert.throws(()=>f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)),e=>e.code==='forbidden');
});

test('a roster signed for a join request that has since expired cannot admit it',t=>{
  const f=fixture(t);
  f.advance(86400+60);
  // The request lapsed before the signed admission reached the coordinator; the roster itself is still valid.
  assert.throws(()=>f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)),e=>e.code==='forbidden');
});

test('an admission that already committed stays an idempotent success after its invitation is revoked',t=>{
  const f=fixture(t);
  assert.equal(f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)).payload.epoch,8);
  const revoke=invitationRevocation({circle:f.circle,origin:f.origin,epoch:8,inviteId:f.invite.payload.invite_id,now:f.now,rootKey:f.keys[2]});
  f.store.revokeInvite(revoke,f.ctx(f.keys[0],'POST','/invites/revoke',revoke,8));
  // A publisher retrying the exact committed bytes (lost acknowledgement) is told it succeeded.
  assert.equal(f.store.installRoster(f.add,f.ctx(f.keys[0],'PUT','/roster',f.add,8)).payload.epoch,8);
});

test('a roster signed for one join request cannot be revived by another pending request of the same key',t=>{
  const f=fixture(t);
  // The same key asks again through a second invitation, so two requests are pending.
  const inviteKey=p.generateDeviceKeyPair().privateKey;
  const second=p.createInvite({circle:f.circle,coordinator:f.origin,invite_id:randomUUID(),invite_public_key:p.exportPublicKey(inviteKey),
    created_at:new Date(f.now*1000).toISOString().replace('.000Z','Z'),expires_at:new Date((f.now+3600)*1000).toISOString().replace('.000Z','Z'),display_name:'Test'},f.keys[2]);
  f.store.registerInvite(second,f.ctx(f.keys[0],'POST','/invites',second,7));
  const pub=p.exportPublicKey(f.guest);
  const body={invite:second,device_public_key:pub,enrollment_proof:p.createEnrollmentProof({circle:f.circle,invite_id:second.payload.invite_id,device_public_key:pub},inviteKey)};
  f.store.createEnrollment(body,f.ctx(f.guest,'POST','/enrollments',body,0));
  // The owner signs the admission for request A, then declines A before the roster is published.
  const forA=p.createRoster({...f.initial.payload,epoch:8,members:[...f.initial.payload.members,
    {key_id:f.id,public_key:pub,joined_epoch:8}]},f.keys[2]);
  const reject=enrollmentRejection({circle:f.circle,origin:f.origin,epoch:7,enrollmentId:f.e.enrollment_id,now:f.now,rootKey:f.keys[2]});
  f.store.rejectEnrollment(reject,f.ctx(f.keys[0],'POST','/enrollments/reject',reject,7));
  f.restart();
  assert.throws(()=>f.store.installRoster(forA,f.ctx(f.keys[0],'PUT','/roster',forA,8)),e=>e.code==='forbidden');
  // A roster signed after the decision answers the still-pending request B.
  f.advance(5);
  const issued=new Date((f.now+5)*1000).toISOString().replace('.000Z','Z');
  const forB=p.createRoster({...f.initial.payload,epoch:8,issued_at:issued,valid_until:new Date((f.now+3600)*1000).toISOString().replace('.000Z','Z'),members:[...f.initial.payload.members,
    {key_id:f.id,public_key:pub,joined_epoch:8}]},f.keys[2]);
  assert.equal(f.store.installRoster(forB,f.ctx(f.keys[0],'PUT','/roster',forB,8)).payload.epoch,8);
});
