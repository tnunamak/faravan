import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import * as p from '../lib/protocol/index.mjs';
import {readFile} from 'node:fs/promises';
import {createPrivateKey} from 'node:crypto';
import {HOST_CAPABILITIES, MEMBER_CAPABILITIES, changedMembershipCapabilities} from '../lib/v1/versions.mjs';
import {LENDER_CAPABILITIES} from '../lib/v1/heartbeat.mjs';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

async function fixture(t) {
  const c=await realCoordinator(t),id=c.circle.id;
  // An old computer never declares membership features. Upgrade by reopening the
  // same device with the normal updated flow, rather than forging host presence.
  const legacy=await c.device('legacy',{fetch:async(url,options)=>{
    if(String(url).endsWith('/heartbeat'))return Response.json({received_at:new Date(c.clock()*1000).toISOString(),online_seconds:60});
    return c.traced(url,options);
  }});
  await legacy.joinCircle((await c.owner.createInviteLinks(id)).long);
  await c.owner.approveEnrollments(id);await legacy.refreshRoster(id);
  const upgrade=async()=>{const updated=await c.device('legacy');await updated.refreshRoster(id);return updated;};
  return {...c,id,legacy,upgrade};
}

test('mixed membership refuses people, steward, co-admin and transfer before publication; normal upgrade permits them',async t=>{
  const c=await fixture(t),{owner,id,legacy}=c,before=(await owner.rosterCache(id).get()).current;
  const personProof=await owner.createPersonLink(id,legacy.keyId),deviceProof=await legacy.createPersonLink(id,legacy.keyId,{personId:owner.keyId});
  for(const operation of [()=>owner.linkPersonDevices(id,{personId:owner.keyId,deviceKeyId:legacy.keyId,personProof,deviceProof}),()=>owner.setPersonRole(id,legacy.keyId,'co-admin'),()=>owner.setBackupSteward(id,legacy.keyId),()=>owner.proposeOwnershipTransfer(id,legacy.keyId)]){
    await assert.rejects(operation(),error=>error.code==='circle_members_need_update'&&error.members.some(m=>m.keyId===legacy.keyId));
    assert.deepEqual((await owner.rosterCache(id).get()).current,before);
  }
  const updated=await c.upgrade();
  await owner.setBackupSteward(id,updated.keyId);
  await owner.setPersonRole(id,updated.keyId,'co-admin');
  await owner.setPersonBlocked(id,updated.keyId,true);await owner.setPersonBlocked(id,updated.keyId,false);
  const {proposal}=await owner.proposeOwnershipTransfer(id,updated.keyId);
  await updated.acceptOwnershipTransfer(id,proposal);assert.equal(updated.selectCircle(id).owned,true);
});

test('transactional raw PUT gate includes members removed by the proposed governance change',async t=>{
  const c=await fixture(t),{owner,id,legacy}=c;
  const before=(await owner.rosterCache(id).get()).current.payload;
  // Only the fixture's disposable generated root is used; no account credentials.
  const root=createPrivateKey(await readFile(c.dir+'/owner/v1/roots/'+id+'.pem'));
  const governance={version:1,owner_person:owner.keyId,state:'archived',people:[{person_id:owner.keyId,role:'owner',blocked:false}]};
  const next=p.signEnvelope('roster',{...before,epoch:before.epoch+1,members:before.members.filter(m=>m.key_id!==legacy.keyId),governance},root);
  const api=await owner.client(id);
  const host=await api.capabilities();
  assert.equal(new Set(host.capabilities).size,host.capabilities.length);
  await assert.rejects(api.publishRoster(next),e=>e.code==='circle_members_need_update');
  assert.equal((await api.refreshRoster()).payload.epoch,before.epoch);
  await c.upgrade();await api.publishRoster(next);
  assert.equal((await api.refreshRoster()).payload.governance.state,'archived');
});


test('transactional raw authority PUT is refused before declaration and accepted after normal upgrade',async t=>{
  const c=await fixture(t),{owner,id,legacy}=c,before=(await owner.rosterCache(id).get()).current.payload;
  const root=createPrivateKey(await readFile(c.dir+'/owner/v1/roots/'+id+'.pem'));
  const authority_chain=[p.createAuthorityGenesis({circle:id,coordinator:c.origin,owner:{key_id:owner.keyId,public_key:owner.publicKey},
    steward:{key_id:legacy.keyId,public_key:legacy.publicKey},issued_at:c.clock()},root)];
  const next=p.signEnvelope('roster',{...before,epoch:before.epoch+1,authority_chain},owner.deviceKey),api=await owner.client(id);
  await assert.rejects(api.publishRoster(next),e=>e.code==='circle_members_need_update');
  assert.equal((await api.refreshRoster()).payload.epoch,before.epoch);
  await c.upgrade();await api.publishRoster(next);
  assert.equal((await api.refreshRoster()).payload.authority_chain.length,1);
});

test('unchanged signed people and authority remain renewable after a member downgrades',async t=>{
  let offset=0;
  const c=await realCoordinator(t,{clock:()=>Math.floor(Date.now()/1000)+offset}),id=c.circle.id,member=await c.device('member');
  await member.joinCircle((await c.owner.createInviteLinks(id)).long);await c.owner.approveEnrollments(id);await member.refreshRoster(id);
  await c.owner.setPersonRole(id,member.keyId,'borrow-only');await c.owner.setBackupSteward(id,member.keyId);
  const api=await member.client(id);
  await api.heartbeat({boot:'old-build',seq:0,intent:{state:'off'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]});
  const before=(await c.owner.rosterCache(id).get()).current.payload;
  offset=4*86400;await c.owner.refreshRoster(id);
  const after=(await c.owner.rosterCache(id).get()).current.payload;
  assert.ok(after.epoch>before.epoch);assert.deepEqual(after.governance,before.governance);assert.deepEqual(after.authority_chain,before.authority_chain);
  await assert.rejects(c.owner.setCircleLifecycle(id,'archived'),e=>e.code==='circle_members_need_update');
});

test('capability requirements form a union and ordinary roster renewals need none',()=>{
  const old={members:[]},next={members:[],profile:{name:'New'},governance:{state:'archived'},authority_chain:[{}]};
  assert.deepEqual(changedMembershipCapabilities(old,next),MEMBER_CAPABILITIES);
  assert.deepEqual(changedMembershipCapabilities(next,{...next,epoch:2,issued_at:'later'}),[]);
  assert.equal(new Set(HOST_CAPABILITIES).size,HOST_CAPABILITIES.length);
});

test('updated lending heartbeat capabilities preserve routing and membership declarations',()=>{
  for(const capability of [...MEMBER_CAPABILITIES,'progress_v1','offers_v1'])assert.ok(LENDER_CAPABILITIES.includes(capability),capability);
  assert.equal(new Set(LENDER_CAPABILITIES).size,LENDER_CAPABILITIES.length);
});

test('regular app heartbeat preserves membership support and existing routing capabilities',async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:20,pollMs:60000});
  await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:circle.id}});
  const beat=await waitFor(()=>f.heartbeats?.find(body=>Number.isSafeInteger(body.seq)),'regular heartbeat');
  for(const capability of [...MEMBER_CAPABILITIES,'progress_v1','offers_v1'])assert.ok(beat.capabilities.includes(capability),capability);
  assert.equal(new Set(beat.capabilities).size,beat.capabilities.length);
  assert.ok(Array.isArray(beat.blockers));assert.ok(beat.intent.state);assert.ok(beat.execution.state);
});

test('transfer acceptance rechecks declarations, including raw accepted authority PUT',async t=>{
  const c=await fixture(t),{owner,id}=c,target=await c.upgrade(),spectator=await c.device('spectator');
  await spectator.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await spectator.refreshRoster(id);
  const {proposal}=await owner.proposeOwnershipTransfer(id,target.keyId);
  await (await spectator.client(id)).heartbeat({boot:'downgraded',seq:0,intent:{state:'off'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]});
  await assert.rejects(target.acceptOwnershipTransfer(id,proposal),e=>e.code==='circle_members_need_update'&&e.members.some(m=>m.keyId===spectator.keyId));
  const before=(await owner.rosterCache(id).get()).current.payload;
  const accepted=p.attachAuthorityAcceptance(proposal,p.createAuthorityAcceptance({proposal,accepted_at:c.clock()},target.deviceKey));
  const next=p.signEnvelope('roster',{...before,epoch:before.epoch+1,authority_chain:[...before.authority_chain,accepted]},target.deviceKey);
  await assert.rejects((await target.client(id)).publishRoster(next),e=>e.code==='circle_members_need_update');
  const upgraded=await c.device('spectator');await upgraded.refreshRoster(id);
  await target.acceptOwnershipTransfer(id,proposal);assert.equal(target.selectCircle(id).owned,true);
});

test('uncertain applied removal reconciles without treating the removed device as an undeclared member',async t=>{
  const c=await fixture(t),id=c.id;await c.upgrade();
  // Establish governance so removal changes a capability-gated field.
  await c.owner.setCircleLifecycle(id,'active');
  let loseResponse=true;
  const owner=await c.device('owner',{clientOptions:{retry:{maxAttempts:1}},fetch:async(url,options)=>{
    const response=await c.traced(url,options);
    if(loseResponse&&String(url).endsWith('/roster')&&options.method==='PUT'&&response.ok)throw new Error('synthetic lost response');
    return response;
  }});
  await assert.rejects(owner.removePerson(id,c.legacy.keyId),e=>e.code==='network_error');
  loseResponse=false;
  await owner.refreshRoster(id);
  assert.equal((await owner.listPeople(id)).some(person=>person.personId===c.legacy.keyId),false);
});

test('withdrawn capabilities cannot veto owner blocking and removal, even with an undeclared remaining member',async t=>{
  const c=await fixture(t),{owner,id}=c,target=await c.upgrade(),remaining=await c.device('remaining');
  await remaining.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await remaining.refreshRoster(id);
  await owner.setPersonRole(id,target.keyId,'co-admin');await owner.setBackupSteward(id,target.keyId);
  const targetApi=await target.client(id),remainingApi=await remaining.client(id);
  const retry={idempotencyKey:'withdrawn-capability-retry'};
  await targetApi.heartbeat({capabilities:[]},retry);await remainingApi.heartbeat({capabilities:[]});
  await owner.setPersonBlocked(id,target.keyId,true);
  await owner.removePerson(id,target.keyId);
  assert.equal((await owner.listPeople(id)).some(person=>person.personId===target.keyId),false);
  await assert.rejects(targetApi.fetchPresence(),e=>e.code==='forbidden');
  await assert.rejects(targetApi.heartbeat({capabilities:[]},retry),e=>e.code==='forbidden');
});

test('raw signed removal of a legacy member cannot be vetoed by capability withdrawal',async t=>{
  const c=await fixture(t),{owner,id,legacy}=c;
  const legacyApi=await legacy.client(id);
  const remaining=await c.device('remaining');
  await remaining.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await remaining.refreshRoster(id);
  await (await remaining.client(id)).heartbeat({capabilities:[]});
  const before=(await owner.rosterCache(id).get()).current.payload;
  const root=createPrivateKey(await readFile(c.dir+'/owner/v1/roots/'+id+'.pem'));
  const governance={version:1,owner_person:owner.keyId,state:'active',people:[{person_id:owner.keyId,role:'owner',blocked:false},
    {person_id:remaining.keyId,role:'member',blocked:false}]};
  const next=p.signEnvelope('roster',{...before,epoch:before.epoch+1,members:before.members.filter(m=>m.key_id!==legacy.keyId),governance},root);
  await (await owner.client(id)).publishRoster(next);
  await assert.rejects(legacyApi.fetchPresence(),e=>e.code==='forbidden');
});

test('owner removal still works when normal signing drops legacy person names',async t=>{
  const c=await fixture(t),{owner,id,legacy}=c;
  const before=(await owner.rosterCache(id).get()).current.payload;
  const root=createPrivateKey(await readFile(c.dir+'/owner/v1/roots/'+id+'.pem'));
  const oldNames=p.signEnvelope('roster',{...before,epoch:before.epoch+1,
    members:before.members.map(member=>({...member,person_name:'Test person'}))},root);
  await (await owner.client(id)).publishRoster(oldNames);
  await owner.removePerson(id,legacy.keyId);
  assert.equal((await owner.listPeople(id)).some(person=>person.personId===legacy.keyId),false);
});

test('owner demotes an undeclared co-admin while another remaining member withholds capabilities',async t=>{
  const c=await fixture(t),{owner,id}=c,target=await c.upgrade(),remaining=await c.device('remaining');
  await remaining.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await remaining.refreshRoster(id);
  await owner.setPersonRole(id,target.keyId,'co-admin');
  const targetApi=await target.client(id);
  await targetApi.heartbeat({capabilities:[]});await (await remaining.client(id)).heartbeat({capabilities:[]});
  await owner.setPersonRole(id,target.keyId,'member');
  assert.equal((await owner.listPeople(id)).find(person=>person.personId===target.keyId).role,'member');
  const after=(await owner.rosterCache(id).get()).current.payload;
  assert.ok(after.members.some(member=>member.key_id===target.keyId));
  assert.ok(!after.authority_chain.at(-1).payload.admins.some(admin=>admin.key_id===target.keyId));
  assert.ok(await targetApi.fetchPresence(),'demotion retains ordinary membership');
  await assert.rejects(owner.setPersonRole(id,target.keyId,'co-admin'),e=>e.code==='circle_members_need_update');
});

test('raw owner PUT demotes an undeclared co-admin while another remaining member withholds capabilities',async t=>{
  const c=await fixture(t),{owner,id}=c,target=await c.upgrade(),remaining=await c.device('remaining');
  await remaining.joinCircle((await owner.createInviteLinks(id)).long);await owner.approveEnrollments(id);await remaining.refreshRoster(id);
  await owner.setPersonRole(id,target.keyId,'co-admin');
  const targetApi=await target.client(id);
  await targetApi.heartbeat({capabilities:[]});await (await remaining.client(id)).heartbeat({capabilities:[]});
  const before=(await owner.rosterCache(id).get()).current.payload,governance=structuredClone(before.governance);
  governance.people.find(person=>person.person_id===target.keyId).role='member';
  const authority_chain=[...before.authority_chain,p.createAuthorityTransition({chain:before.authority_chain,admins:[],issued_at:c.clock()},owner.deviceKey)];
  const next=p.signEnvelope('roster',{...before,epoch:before.epoch+1,governance,authority_chain},owner.deviceKey);
  await (await owner.client(id)).publishRoster(next);
  const after=(await owner.rosterCache(id).get()).current.payload;
  assert.equal(after.governance.people.find(person=>person.person_id===target.keyId).role,'member');
  assert.deepEqual(after.authority_chain.at(-1).payload.admins,[]);
  assert.ok(await targetApi.fetchPresence());
});

test('work-role changes and co-admin grants still require compatibility declarations',()=>{
  const members=[{key_id:'owner'},{key_id:'target'}];
  const roster=role=>({members,governance:{version:1,state:'active',owner_person:'owner',people:[
    {person_id:'owner',role:'owner',blocked:false},{person_id:'target',role,blocked:false}]}});
  assert.deepEqual(changedMembershipCapabilities(roster('co-admin'),roster('member')),[]);
  assert.deepEqual(changedMembershipCapabilities(roster('member'),roster('co-admin')),['circle_people_v1']);
  assert.deepEqual(changedMembershipCapabilities(roster('borrow-only'),roster('lend-only')),['circle_people_v1']);
  assert.deepEqual(changedMembershipCapabilities(roster('lend-only'),roster('borrow-only')),['circle_people_v1']);
});
