import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {realCoordinator} from './helpers/v1-short-invite.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('circle list counts signed people like detail, including namesakes and linked computers', async t => {
  const c=await realCoordinator(t),id=c.circle.id;
  const f=await appFixture(t),{app}=await f.start('count',{device:c.owner});
  const a=await c.device('a'),b=await c.device('b');
  for(const d of [a,b]) {
    await d.joinCircle((await c.owner.createInviteLinks(id)).long,{deviceName:'Same name'});
    await c.owner.approveEnrollments(id);
    await d.refreshRoster(id);
  }
  const count=async()=> (await api(app,'/api/circles')).find(c=>c.id===id).personCount;
  assert.equal(await count(),3,'equal display names stay separate');
  assert.equal(await count(),(await api(app,'/api/circles/'+id+'/people')).length);
  const personProof=await a.createPersonLink(id,b.keyId);
  const deviceProof=await b.createPersonLink(id,b.keyId,{personId:a.keyId});
  await c.owner.linkPersonDevices(id,{personId:a.keyId,deviceKeyId:b.keyId,personProof,deviceProof});
  assert.equal(await count(),2,'two people on three computers');
  assert.equal(await count(),(await api(app,'/api/circles/'+id+'/people')).length);
  // List reads must use only local data, even when the host cannot be reached.
  c.owner.client=()=>{throw new Error('list must not contact host');};
  assert.equal(await count(),2);
  const cache=c.owner.rosterCache.bind(c.owner),held=await cache(id).get();
  const forged=structuredClone(held);
  forged.current.payload.members[1].person_id=c.owner.keyId;
  c.owner.rosterCache=()=>({get:async()=>forged});
  assert.equal(await count(),undefined,'unverified person link makes the count unknown');
  c.owner.rosterCache=()=>({get:async()=>({current:null})});
  assert.equal(await count(),undefined,'no held roster is unknown');
  c.owner.rosterCache=cache;
});
