import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import * as p from '../lib/protocol/index.mjs';

const legacyHeartbeat={boot:'legacy-profile-member',seq:0,intent:{state:'off'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]};
async function fixture(t){
 const c=await realCoordinator(t),member=await c.device('member');
 await member.joinCircle((await c.owner.createInviteLinks(c.circle.id)).long,{deviceName:"Sam's computer",waitMs:0});
 await c.owner.approveEnrollments(c.circle.id);await member.refreshRoster(c.circle.id);
 const api=await member.client(c.circle.id);await api.heartbeat(legacyHeartbeat);
 return {...c,member,api,id:c.circle.id};
}

test('an older current member blocks a profile edit before any roster changes',async t=>{
 const f=await fixture(t),before=await f.owner.rosterCache(f.id).get();
 await assert.rejects(f.owner.updateCircleProfile(f.id,{name:'Renamed',purpose:'New purpose'}),error=>{
  assert.equal(error.code,'circle_members_need_update');
  assert.deepEqual(error.members,[{keyId:f.member.keyId,name:"Sam's computer"}]);return true;
 });
 assert.deepEqual(await f.owner.rosterCache(f.id).get(),before);
 assert.equal((await f.api.refreshRoster()).payload.profile,undefined);
 assert.ok(await f.api.capabilities());
});

test('a signed capability-only heartbeat permits rename without changing lending presence',async t=>{
 const f=await fixture(t),before=(await f.api.fetchPresence()).devices.find(d=>d.device===f.member.keyId);
 await f.api.heartbeat({capabilities:['circle_profile_v1']});
 const after=(await f.api.fetchPresence()).devices.find(d=>d.device===f.member.keyId);
 assert.deepEqual(after.intent,before.intent);assert.deepEqual(after.execution,before.execution);
 assert.equal(after.last_heartbeat_at,before.last_heartbeat_at);
 assert.deepEqual(after.member_capabilities,['circle_profile_v1']);
 await f.owner.updateCircleProfile(f.id,{name:'Renamed'});await f.member.refreshRoster(f.id);
 assert.equal(f.member.selectCircle(f.id).name,'Renamed');
});

test('the host rejects a direct profile publication while a current member lacks support',async t=>{
 const f=await fixture(t),cached=await f.owner.rosterCache(f.id).get();
 const root=createPrivateKey(await readFile(join(f.dir,'owner','v1','roots',f.id+'.pem')));
 const next=p.signEnvelope('roster',{...cached.current.payload,epoch:cached.current.payload.epoch+1,profile:{name:'Bypass'}},root);
 await assert.rejects((await f.owner.client(f.id)).publishRoster(next),error=>error.code==='circle_members_need_update');
 assert.equal((await f.api.refreshRoster()).payload.epoch,cached.current.payload.epoch);
});

test('capability declarations survive restart without making a computer online, and legacy heartbeats clear support',async t=>{
 const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
 await member.joinCircle((await f.owner.createInviteLinks(id)).long,{deviceName:"Sam's computer",waitMs:0});
 await f.owner.approveEnrollments(id);await member.refreshRoster(id);
 const api=await member.client(id);
 const before=(await api.fetchPresence()).devices.find(d=>d.device===member.keyId);
 assert.equal(before.online,false);assert.equal(before.last_heartbeat_at,null);
 f.restart();
 const after=(await api.fetchPresence()).devices.find(d=>d.device===member.keyId);
 assert.deepEqual(after.member_capabilities,['circle_profile_v1','circle_people_v1','circle_authority_v1']);
 assert.equal(after.online,false);assert.equal(after.last_heartbeat_at,null);
 await api.heartbeat(legacyHeartbeat);
 assert.deepEqual((await api.fetchPresence()).devices.find(d=>d.device===member.keyId).member_capabilities,[]);
 await assert.rejects(f.owner.updateCircleProfile(id,{name:'Blocked after downgrade'}),error=>error.code==='circle_members_need_update');
});
