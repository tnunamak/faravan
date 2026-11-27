import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import * as p from '../lib/protocol/index.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {invitationRevocation} from '../lib/v1/invitation-revoke.mjs';
async function fixture(t,options={}){
  const c=await realCoordinator(t,options),a=await c.device('a'),b=await c.device('b');
  for(const d of [a,b]){await d.joinCircle((await c.owner.createInviteLinks(c.circle.id)).long,{deviceName:d===a?'A':'B'});await c.owner.approveEnrollments(c.circle.id);await d.refreshRoster(c.circle.id);}
  return {...c,a,b,id:c.circle.id};
}
test('backup steward manages memberships and invites with its own device key',async t=>{
  const {owner,a,b,id}=await fixture(t);
  await owner.setBackupSteward(id,a.keyId);
  await a.refreshRoster(id);assert.equal(a.selectCircle(id).steward,true);assert.equal(a.selectCircle(id).owned,false);
  await a.updateCircleProfile(id,{purpose:'Steward can help'});
  const links=await a.createInviteLinks(id);assert.ok(links.long);
  await a.revokeInvitation(id,p.decodeInviteLink(links.long).invite.payload.invite_id);
  await assert.rejects(a.setBackupSteward(id,b.keyId),e=>e.code==='not_owner');
  await owner.setBackupSteward(id,null);await a.refreshRoster(id);
  await assert.rejects(a.updateCircleProfile(id,{purpose:'Revoked'}),e=>e.code==='not_owner');
});
test('co-admin manages membership and circle details but cannot change roles or ownership',async t=>{
  const {owner,a,b,id}=await fixture(t);
  await owner.setPersonRole(id,a.keyId,'co-admin');await a.refreshRoster(id);
  assert.equal(a.selectCircle(id).admin,true);
  await a.updateCircleProfile(id,{purpose:'Admin can help'});
  assert.ok((await a.createInviteLinks(id)).long);
  await a.setPersonBlocked(id,b.keyId,true);
  await assert.rejects(a.setCircleLifecycle(id,'closed'),e=>e.code==='not_owner');
  const before=(await a.rosterCache(id).get()).current.payload;
  const forged=p.signEnvelope('roster',{...before,epoch:before.epoch+1,governance:{...before.governance,state:'closed'}},a.deviceKey);
  assert.equal(p.verifyRoster(forged,{circle:id,rootFingerprint:a.selectCircle(id).pinnedRootFingerprint,now:()=>Math.floor(Date.now()/1000),previousAuthorityChain:before.authority_chain,previousRoster:before}).ok,false,'members independently reject an admin closing the circle');
  await assert.rejects(a.setPersonRole(id,b.keyId,'co-admin'),e=>e.code==='not_owner');
  await owner.setPersonBlocked(id,a.keyId,true);await a.refreshRoster(id);assert.equal(a.selectCircle(id).admin,false);
  assert.equal((await owner.listPeople(id)).find(p=>p.personId===a.keyId).role,'co-admin');
  await owner.setPersonBlocked(id,a.keyId,false);await a.refreshRoster(id);assert.equal(a.selectCircle(id).admin,true);
  await owner.setPersonRole(id,a.keyId,'member');await a.refreshRoster(id);
  await assert.rejects(a.createInviteLinks(id),e=>e.code==='not_owner');
});
test('ownership stays put until target accepts, then old owner loses authority and stale forks fail',async t=>{
  const {owner,a,b,id,device}=await fixture(t);
  await owner.setPersonRole(id,a.keyId,'co-admin');
  const {proposal}=await owner.proposeOwnershipTransfer(id,a.keyId);
  assert.equal(owner.selectCircle(id).owned,true);assert.equal(a.selectCircle(id).owned,false);
  const old=(await owner.rosterCache(id).get()).current;
  await assert.rejects(b.acceptOwnershipTransfer(id,proposal),e=>e.code==='forbidden');
  const accepted=await a.acceptOwnershipTransfer(id,proposal);assert.equal(accepted.ownerDeviceKeyId,a.keyId);
  assert.equal(a.selectCircle(id).owned,true);
  await owner.refreshRoster(id);assert.equal(owner.selectCircle(id).owned,false);
  await assert.rejects(owner.updateCircleProfile(id,{purpose:'Stale owner'}),e=>e.code==='not_owner');
  await a.updateCircleProfile(id,{purpose:'New owner'});
  const fresh=await a.createInviteLinks(id);assert.ok(fresh.long);
  const newcomer=await device('new-owner-invite');await newcomer.joinCircle(fresh.long);await a.approveEnrollments(id);await newcomer.refreshRoster(id);
  const current=(await a.rosterCache(id).get()).current;
  assert.equal(p.verifyRoster(old,{circle:id,rootFingerprint:a.selectCircle(id).pinnedRootFingerprint,now:()=>Math.floor(Date.now()/1000),previousAuthorityChain:current.payload.authority_chain}).ok,false);
  await assert.rejects(a.acceptOwnershipTransfer(id,proposal));
});
test('cancelling invalidates an exported proposal and membership edits preserve authority',async t=>{
  const {owner,a,b,id}=await fixture(t),{proposal}=await owner.proposeOwnershipTransfer(id,a.keyId);
  await owner.cancelOwnershipTransfer(id);await assert.rejects(a.acceptOwnershipTransfer(id,proposal));
  await owner.removeMember(id,b.keyId);
  assert.ok((await owner.rosterCache(id).get()).current.payload.authority_chain);
});
test('owner links a second computer with both proofs; ownership can move within that person',async t=>{
  const {owner,a,id}=await fixture(t);
  const personProof=await owner.createPersonLink(id,a.keyId),deviceProof=await a.createPersonLink(id,a.keyId,{personId:owner.keyId});
  await owner.linkPersonDevices(id,{personId:owner.keyId,deviceKeyId:a.keyId,personProof,deviceProof});
  let person=(await owner.listPeople(id)).find(p=>p.personId===owner.keyId);
  assert.equal(person.role,'owner');assert.equal(person.computers.length,2);
  await a.refreshRoster(id);assert.equal(a.selectCircle(id).owned,false,'same person does not silently grant signing authority');
  const {proposal}=await owner.proposeOwnershipTransfer(id,a.keyId);await a.acceptOwnershipTransfer(id,proposal);
  person=(await a.listPeople(id)).find(p=>p.personId===owner.keyId);
  assert.equal(person.role,'owner');assert.equal(person.computers.length,2);
  await owner.refreshRoster(id);assert.equal(owner.selectCircle(id).owned,false);assert.equal(a.selectCircle(id).owned,true);
});
test('replacing a pending transfer revokes its already exported code',async t=>{
  const {owner,a,b,id}=await fixture(t);
  const first=await owner.proposeOwnershipTransfer(id,a.keyId);
  const replacement=await owner.proposeOwnershipTransfer(id,b.keyId);
  await assert.rejects(a.acceptOwnershipTransfer(id,first.proposal));
  await b.acceptOwnershipTransfer(id,replacement.proposal);assert.equal(b.selectCircle(id).owned,true);
});

test('a stale former owner refreshes authority before automatic half-life renewal',async t=>{
  let offset=0;const clock=()=>Math.floor(Date.now()/1000)+offset;
  const {owner,a,id}=await fixture(t,{clock});
  const {proposal}=await owner.proposeOwnershipTransfer(id,a.keyId);await a.acceptOwnershipTransfer(id,proposal);
  offset=4*86400;
  await owner.refreshRoster(id);
  assert.equal(owner.selectCircle(id).owned,false);
  assert.equal(owner.selectCircle(id).authorityOwnerKeyId,a.keyId);
});
test('an expired roster remains renewable by its current designated owner',async t=>{
  let offset=0;const clock=()=>Math.floor(Date.now()/1000)+offset;
  const {owner,a,id}=await fixture(t,{clock});
  await owner.setBackupSteward(id,a.keyId);
  const before=(await owner.rosterCache(id).get()).current.payload;
  offset=8*86400;
  await owner.refreshRoster(id);
  const after=(await owner.rosterCache(id).get()).current.payload;
  assert.ok(after.epoch>before.epoch);
  assert.ok(Date.parse(after.valid_until)/1000>clock());
  assert.equal(owner.selectCircle(id).owned,true);
});

async function rawCircleRequest(c,device,method,route,body,epoch) {
  const bytes=Buffer.from(p.canonicalize(body)),target=c.origin+'/v1/circles/'+c.id+route;
  const idempotencyKey=method==='POST'?randomUUID():'';
  const proof=p.buildRequestProof({circle:c.id,roster_epoch:epoch,method,target,body:bytes,content_type:'application/json',
    created:c.clock(),nonce:randomBytes(24).toString('base64url'),idempotency_key:idempotencyKey},device.deviceKey);
  return fetch(target,{method,headers:{'content-type':'application/json','Faravan-Proof':proof,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:bytes});
}
test('raw co-admin roster cannot assign a new person a restricted role and poison owner refresh',async t=>{
  const c=await fixture(t),{owner,a,id}=c;
  await owner.setPersonRole(id,a.keyId,'co-admin');await a.refreshRoster(id);
  const before=(await a.rosterCache(id).get()).current.payload;
  const key=p.generateDeviceKeyPair(),public_key=p.exportPublicKey(key.privateKey),key_id=p.fingerprint(public_key);
  const payload={...before,epoch:before.epoch+1,members:[...before.members,{key_id,public_key,joined_epoch:before.epoch+1}],
    governance:{...before.governance,people:[...before.governance.people,{person_id:key_id,role:'lend-only',blocked:false}]}};
  const forged=p.signEnvelope('roster',payload,a.deviceKey);
  const response=await rawCircleRequest(c,a,'PUT','/roster',forged,payload.epoch);
  assert.equal(response.status,403);assert.equal((await response.json()).code,'forbidden');
  await owner.refreshRoster(id);
  assert.equal((await owner.rosterCache(id).get()).current.payload.epoch,before.epoch);
  assert.equal((await owner.listPeople(id)).some(person=>person.personId===key_id),false);
});
test('unknown invite revocation tombstone cannot prevent owner revoking a co-admin',async t=>{
  const c=await fixture(t),{owner,a,id}=c;
  await owner.setPersonRole(id,a.keyId,'co-admin');await a.refreshRoster(id);
  const epoch=(await a.rosterCache(id).get()).current.payload.epoch,inviteId=randomUUID();
  const body=invitationRevocation({circle:id,origin:c.origin,epoch,inviteId,now:c.clock(),rootKey:a.deviceKey});
  const response=await rawCircleRequest(c,a,'POST','/invites/revoke',body,epoch);
  assert.equal(response.status,200);assert.equal((await response.json()).revoked,true);
  await owner.setPersonRole(id,a.keyId,'member');await owner.refreshRoster(id);await a.refreshRoster(id);
  assert.equal(a.selectCircle(id).admin,false);
  assert.equal((await owner.listPeople(id)).find(person=>person.personId===a.keyId).role,'member');
});

test('raw steward linking cannot erase a surviving device role or replay old consent',async t=>{
  const {owner,a,b,id}=await fixture(t);
  await owner.setBackupSteward(id,a.keyId);
  await owner.setPersonRole(id,b.keyId,'lend-only');
  await a.refreshRoster(id);await b.refreshRoster(id);
  const personProof=await a.createPersonLink(id,b.keyId),deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  const previous=(await a.rosterCache(id).get()).current.payload;
  const linked=structuredClone(previous);linked.epoch++;
  const member=linked.members.find(m=>m.key_id===b.keyId);
  member.person_id=a.keyId;member.person_link={person_proof:personProof,device_proof:deviceProof};
  linked.governance.people=linked.governance.people.filter(x=>x.person_id!==b.keyId);
  const signed=p.signEnvelope('roster',linked,a.deviceKey);
  const options={circle:id,now:()=>Math.floor(Date.now()/1000),rootFingerprint:a.selectCircle(id).pinnedRootFingerprint,previousRoster:previous,previousAuthorityChain:previous.authority_chain};
  const renewal=p.createAuthorityTransition({chain:previous.authority_chain,steward:previous.authority_chain.at(-1).payload.steward,issued_at:Math.floor(Date.now()/1000)},owner.deviceKey);
  const renewed=p.signEnvelope('roster',{...linked,authority_chain:[...previous.authority_chain,renewal]},a.deviceKey);
  assert.equal(p.verifyRoster(renewed,options).code,'forbidden','unrelated owner-authorized chain update does not authorize role relaxation');
  await assert.rejects((await a.client(id)).publishRoster(signed),e=>e.code==='forbidden','coordinator rejects raw publication');
  assert.equal(p.verifyRoster(signed,options).code,'forbidden','members reject role laundering');
  await owner.setPersonRole(id,b.keyId,'member');await a.refreshRoster(id);await b.refreshRoster(id);
  await assert.rejects(owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof,deviceProof}),e=>['invalid_person_link','forbidden'].includes(e.code),'policy change invalidates old consent');
  const freshPerson=await a.createPersonLink(id,b.keyId),freshDevice=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof:freshPerson,deviceProof:freshDevice});
  await owner.updateCircleProfile(id,{purpose:'Existing link remains valid in later epochs'});
});

test('raw owner publication cannot apply link consent from an older accepted epoch',async t=>{
  const {owner,a,b,id}=await fixture(t);
  await owner.setBackupSteward(id,a.keyId);
  await owner.setPersonRole(id,b.keyId,'member');
  const personProof=await a.createPersonLink(id,b.keyId),deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await owner.updateCircleProfile(id,{purpose:'Changed after consent'});
  const previous=(await owner.rosterCache(id).get()).current.payload,next=structuredClone(previous);next.epoch++;
  const member=next.members.find(m=>m.key_id===b.keyId);member.person_id=a.keyId;member.person_link={person_proof:personProof,device_proof:deviceProof};
  next.governance.people=next.governance.people.filter(person=>person.person_id!==b.keyId);
  const signed=p.signEnvelope('roster',next,owner.deviceKey);
  await assert.rejects((await owner.client(id)).publishRoster(signed),e=>e.code==='forbidden','coordinator rejects replay even with owner roster signature');
  assert.equal(p.verifyRoster(signed,{circle:id,now:()=>Math.floor(Date.now()/1000),rootFingerprint:owner.selectCircle(id).pinnedRootFingerprint,previousRoster:previous}).code,'forbidden');
});

test('a stale member can refresh across an epoch-bound person link',async t=>{
  const {owner,a,b,id,device}=await fixture(t),stale=await device('stale');
  await stale.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await stale.refreshRoster(id);
  await owner.setBackupSteward(id,a.keyId);
  await a.refreshRoster(id);await b.refreshRoster(id);
  const personProof=await a.createPersonLink(id,b.keyId),deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof,deviceProof});
  await owner.updateCircleProfile(id,{purpose:'A later edit'});
  await stale.refreshRoster(id);
  assert.equal((await stale.listPeople(id)).find(person=>person.personId===a.keyId).computers.length,2);
});

test('legacy link consent requires fresh epoch-bound proofs and gives an actionable error',async t=>{
  const {owner,a,b,id}=await fixture(t);
  const personPayload={...(await a.createPersonLink(id,b.keyId)).payload};delete personPayload.roster_epoch;
  const devicePayload={...(await b.createPersonLink(id,b.keyId,{personId:a.keyId})).payload};delete devicePayload.roster_epoch;
  const personProof=p.signEnvelope('person-link',personPayload,a.deviceKey),deviceProof=p.signEnvelope('person-link',devicePayload,b.deviceKey);
  await assert.rejects(owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof,deviceProof}),e=>e.code==='person_link_refresh_required');
  const freshPerson=await a.createPersonLink(id,b.keyId),freshDevice=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof:freshPerson,deviceProof:freshDevice});
  assert.equal((await owner.listPeople(id)).find(person=>person.personId===a.keyId).computers.length,2);
});

test('malformed authority chains return a client error without mutating the roster',async t=>{
  const c=await fixture(t),{owner,id}=c;
  const previous=(await owner.rosterCache(id).get()).current.payload;
  for(const authority_chain of [null,{},[],[null],[{}],[{payload:null}]]) {
    const signed=structuredClone((await owner.rosterCache(id).get()).current);signed.payload.epoch=previous.epoch+1;
    signed.payload.authority_chain=authority_chain;
    const response=await rawCircleRequest(c,owner,'PUT','/roster',signed,previous.epoch+1),problem=await response.json();
    assert.ok(response.status>=400&&response.status<500,JSON.stringify({authority_chain,status:response.status,code:problem.code}));
    assert.equal(problem.code,'invalid_request');
    assert.equal(response.status,400);
  }
  await owner.refreshRoster(id);assert.equal((await owner.rosterCache(id).get()).current.payload.epoch,previous.epoch);
});
