import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import * as p from '../lib/protocol/index.mjs';

async function fixture(t) {
  const c=await realCoordinator(t),a=await c.device('a'),b=await c.device('b');
  for(const d of [a,b]) {
    await d.joinCircle((await c.owner.createInviteLinks(c.circle.id)).long,{deviceName:'Same name'});
    await c.owner.approveEnrollments(c.circle.id);
    await d.refreshRoster(c.circle.id);
  }
  return {...c,a,b,id:c.circle.id};
}
test('same names remain separate; explicit two-computer proof links one person',async t=>{
  const {owner,a,b,id}=await fixture(t);
  assert.equal((await owner.listPeople(id)).length,3);
  const personProof=await a.createPersonLink(id,b.keyId),deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof,deviceProof});
  const people=await owner.listPeople(id);
  assert.equal(people.length,2);
  assert.equal(people.find(x=>x.personId===a.keyId).computers.length,2);
  await owner.setPersonBlocked(id,a.keyId,true);
  assert.equal((await owner.listPeople(id)).find(x=>x.personId===a.keyId).blocked,true);
  await a.refreshRoster(id); // blocked is reversible and retains roster access
  await owner.setPersonBlocked(id,a.keyId,false);
  await owner.setPersonRole(id,a.keyId,'borrow-only');
  assert.equal((await owner.listPeople(id)).find(x=>x.personId===a.keyId).role,'borrow-only');
  await assert.rejects(a.setPersonRole(id,a.keyId,'owner'),e=>e.code==='not_owner');
  await assert.rejects(owner.setPersonRole(id,a.keyId,'owner'),e=>e.code==='ownership_transfer_required');
});
test('a member sees the circle owner as Owner, not as another member',async t=>{
  const {owner,a,id}=await fixture(t);
  const people=await a.listPeople(id);
  assert.equal(people.find(x=>x.computers.some(m=>m.key_id===owner.keyId)).role,'owner');
  assert.ok(people.filter(x=>!x.computers.some(m=>m.key_id===owner.keyId)).every(x=>x.role==='member'));
});
test('forged, swapped and cross-circle linking proofs do not change membership',async t=>{
  const {owner,a,b,id}=await fixture(t);
  const personProof=await a.createPersonLink(id,b.keyId),deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  const forged=structuredClone(deviceProof);forged.payload.circle='00000000-0000-0000-0000-000000000000';
  for(const pair of [{personProof,deviceProof:forged},{personProof:deviceProof,deviceProof:personProof}])
    await assert.rejects(owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,...pair}));
  assert.equal((await owner.listPeople(id)).length,3);
});
test('role policy denies new work while preserving read access and local approval authority',async()=>{
  const r={members:[{key_id:'a',person_id:'p'}],governance:{state:'active',people:[{person_id:'p',role:'lend-only',blocked:false}]}};
  assert.equal(p.circleWorkAllowed(r,'a','borrow'),false);
  assert.equal(p.circleWorkAllowed(r,'a','lend'),true);
  r.governance.people[0].blocked=true;
  assert.equal(p.circleWorkAllowed(r,'a','lend'),false);
  r.governance.people[0].blocked=false;r.governance.people[0].role='co-admin';r.governance.state='archived';
  assert.equal(p.circleWorkAllowed(r,'a','borrow'),false);
});
test('archive resumes, close is permanent and deleting affects this membership only',async t=>{
  const {owner,a,id}=await fixture(t);
  await assert.rejects(owner.leaveCircle(id),e=>e.code==='ownership_transfer_required');
  await owner.setCircleLifecycle(id,'archived');assert.equal(owner.selectCircle(id).lifecycle,'archived');
  await assert.rejects(owner.leaveCircle(id),e=>e.code==='ownership_transfer_required');
  await assert.rejects(owner.deleteLocalCircleData(id),e=>e.code==='circle_must_be_closed');
  await owner.setCircleLifecycle(id,'active');await owner.setCircleLifecycle(id,'closed');
  await assert.rejects(owner.setCircleLifecycle(id,'active'),e=>e.code==='circle_closed');
  await a.refreshRoster(id);assert.equal(a.selectCircle(id).lifecycle,'closed');
  assert.deepEqual(await a.deleteLocalCircleData(id),{id,deleted:true,scope:'local-membership'});
  assert.equal((await a.listCircles()).some(c=>c.id===id),false);
  assert.equal((await owner.listPeople(id)).length,3,'shared history and roster remain on host');
  assert.equal((await owner.leaveCircle(id)).left,true,'owner may leave a closed circle');
});
