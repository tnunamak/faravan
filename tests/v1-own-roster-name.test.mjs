import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { openDevice } from '../lib/v1/device.mjs';
import * as p from '../lib/protocol/index.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

async function deviceFixture(t) {
  const home=await mkdtemp(join(tmpdir(),'faravan-own-roster-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  return openDevice({home,ensureDefault:false});
}

test('new circle signs the hostname as its own device name when no name was set', async t=>{
  const device=await deviceFixture(t);
  const circle=await device.createCircle(null,{name:'Hostname circle'});
  const {current}=await device.rosterCache(circle.id).get();
  assert.equal(current.payload.members.find(m=>m.key_id===device.keyId).device_name,hostname());
  assert.equal(p.verifyRoster(current,{rootFingerprint:circle.pinnedRootFingerprint,circle:circle.id,now:()=>Math.floor(Date.now()/1000)}).ok,true);
});

test('circle creation through the app signs the configured local device name', {timeout:60000}, async t=>{
  const f=await appFixture(t),{app}=await f.start('owner');
  await api(app,'/api/devices',{method:'POST',body:{name:'Own workstation'}});
  const circle=await api(app,'/api/circles',{method:'POST',body:{name:'Named circle',publish:false}});
  const {current}=await app.device.rosterCache(circle.id).get();
  assert.equal(current.payload.members.find(m=>m.key_id===app.device.keyId).device_name,'Own workstation');
  assert.equal(p.verifyRoster(current,{rootFingerprint:circle.pinnedRootFingerprint,circle:circle.id,now:()=>Math.floor(Date.now()/1000)}).ok,true);
});

test('legacy self roster reads use the local name without rewriting signed data or naming other members', {timeout:60000}, async t=>{
  const f=await appFixture(t),{app}=await f.start('owner');
  const circle=(await app.device.listCircles())[0];
  const root=createPrivateKey(await readFile(join(app.device.directory,'roots',circle.id+'.pem')));
  const otherPublic=p.exportPublicKey(p.generateDeviceKeyPair().privateKey),otherKey=p.fingerprint(otherPublic);
  const cache=await app.device.rosterCache(circle.id).get();
  const self={...cache.current.payload.members.find(m=>m.key_id===app.device.keyId)};
  delete self.device_name;
  // A signed legacy fixture with no device names.
  const payload={...cache.current.payload,epoch:cache.current.payload.epoch+1,
    members:[self,{key_id:otherKey,public_key:otherPublic,joined_epoch:1}]};
  const envelope=p.signEnvelope('roster',payload,root);
  await app.device.rosterCache(circle.id).set({current:envelope,history:[],highestAcceptedEpoch:payload.epoch,highestAcceptedDigest:p.digest(payload)});
  const file=join(app.device.directory,'circles',circle.id,'roster.json'),before=await readFile(file,'utf8');
  const devices=await api(app,'/api/devices');
  const roster=devices.circles.find(c=>c.circle===circle.id).members;
  assert.equal(devices.name,hostname());
  assert.equal(roster.find(m=>m.key_id===app.device.keyId).device_name,devices.name);
  assert.equal(roster.find(m=>m.key_id===otherKey).device_name,null);
  await api(app,'/api/devices',{method:'POST',body:{name:'Renamed local computer'}});
  const renamed=await api(app,'/api/devices');
  assert.equal(renamed.circles.find(c=>c.circle===circle.id).members.find(m=>m.key_id===app.device.keyId).device_name,renamed.name);
  assert.equal(await readFile(file,'utf8'),before,'reads and local renames preserve signed roster bytes');
  assert.equal(p.verifyRoster(envelope,{rootFingerprint:circle.pinnedRootFingerprint,circle:circle.id,now:()=>Math.floor(Date.now()/1000)}).ok,true);
  await api(app,'/api/devices',{method:'POST',body:{name:hostname()}});
});
