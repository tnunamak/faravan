import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {acquireProcessLock} from '../lib/v1/lock.mjs';

test('activity records successful lending actions once, independently of heartbeat observations', {timeout:30000}, async t => {
 const f=await appFixture(t),{lender,circle}=await f.connect();
 const post=(name,body={})=>api(lender.app,'/api/'+name,{method:'POST',body});
 await post('agents/codex',{useForLending:true});
 await post('lending/on',{circle:circle.id});
 await post('lending/on',{circle:circle.id});
 await post('lending/pause',{until:Date.now()+3600000});
 await post('lending/resume',{circle:circle.id});
 await post('lending/off');
 await post('lending/off');
 const events=await api(lender.app,'/api/activity');
 assert.deepEqual(events.filter(e=>e.type==='lending-action').map(e=>({circle:e.data.circle,action:e.data.action})),
  ['on','paused','resumed','off'].map(action=>({circle:circle.id,action})));
 assert.ok(events.some(e=>e.type==='lending'));
});

test('a roster removal is not displayed as approved after the state write is busy', {timeout:30000}, async t => {
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const device=lender.app.device,cache=device.rosterCache(circle.id);
 const stateFile=join(device.directory,'state.json');
 const persisted=async()=>JSON.parse(await readFile(stateFile,'utf8')).circles.find(c=>c.id===circle.id);
 assert.equal((await persisted()).rosterMembershipVerified,true);
 assert.equal(device.selectCircle(circle.id).rosterMembershipVerified,true,'a matching roster still proves approval');
 await owner.app.device.removeMember(circle.id,device.keyId);
 const removal=await owner.app.device.rosterCache(circle.id).get();
 assert.equal(removal.current.payload.members.some(m=>m.key_id===device.keyId),false);
 const release=await acquireProcessLock(join(device.directory,'state.lock'));
 try {
  await assert.rejects(cache.set(removal),{code:'device_busy'});
 } finally {release();}
 assert.equal((await cache.get()).highestAcceptedDigest,removal.highestAcceptedDigest,'the signed roster committed');
 assert.notEqual((await persisted()).rosterDigest,removal.highestAcceptedDigest,'the state patch did not commit');
 assert.equal((await persisted()).rosterMembershipVerified,true,'replay starts with stale approval on disk');

 assert.equal(device.selectCircle(circle.id).rosterMembershipVerified,false,'a stale state record cannot prove approval');
 assert.equal((await device.listCircles()).find(c=>c.id===circle.id).rosterMembershipVerified,false);
 const snapshot=device.displaySnapshot();
 assert.equal(snapshot.selectCircle(circle.id).rosterMembershipVerified,false);
 assert.equal((await snapshot.listCircles()).find(c=>c.id===circle.id).rosterMembershipVerified,false);
 for(const path of ['/api/status','/api/devices']) {
  const view=await api(lender.app,path);
  const membership=view.circles.find(c=>(c.id??c.circle)===circle.id).membershipProjection;
  assert.notEqual(membership.phase,'approved',path+' cannot display a removed computer as approved');
 }

 await cache.set(removal);
 assert.equal((await persisted()).rosterDigest,removal.highestAcceptedDigest,'replay durably repairs the state');
 assert.equal((await persisted()).rosterMembershipVerified,false);
 assert.equal(device.selectCircle(circle.id).rosterMembershipVerified,false);
});

test('an approval wrongly persisted with the roster digest does not survive a removal', {timeout:30000}, async t => {
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 const device=lender.app.device,cache=device.rosterCache(circle.id);
 const stateFile=join(device.directory,'state.json');
 await owner.app.device.removeMember(circle.id,device.keyId);
 const removal=await owner.app.device.rosterCache(circle.id).get();
 await cache.set(removal);
 const saved=JSON.parse(await readFile(stateFile,'utf8'));
 const record=saved.circles.find(c=>c.id===circle.id);
 assert.equal(record.rosterDigest,removal.highestAcceptedDigest);
 record.rosterMembershipVerified=true; // what the old undefined comparison persisted
 await writeFile(stateFile,JSON.stringify(saved));
 assert.equal(device.selectCircle(circle.id).rosterMembershipVerified,false,'a removed computer is not shown approved');
 await cache.set(removal);
 const after=JSON.parse(await readFile(stateFile,'utf8')).circles.find(c=>c.id===circle.id);
 assert.equal(after.rosterMembershipVerified,false,'replaying the same bytes reconciles the durable state');
});
