import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import fs from 'node:fs';
import {openDevice} from '../lib/v1/device.mjs';
import {provisionV1Store,openV1Store} from '../lib/v1/store.mjs';
import {createV1Handler} from '../lib/v1/server.mjs';
import * as p from '../lib/protocol/index.mjs';

const cases=[
  {name:'loopback origin'},
  {name:'LAN origin',lanMode:true},
  {name:'10-day-old initial roster',ageDays:10},
  {name:'interrupted origin state write',interrupted:true},
  {name:'queued profile edit',queued:true},
  {name:'interrupted profile state write',staleProfile:true},
  {name:'unpublished preparation after interrupted profile state write',staleProfile:true,publish:false},
];
for(const {name,lanMode=false,ageDays=0,interrupted=false,queued=false,staleProfile=false,publish=true} of cases)test('offline profile attachment: '+name,async t=>{
  const home=await mkdtemp(join(tmpdir(),'faravan-offline-profile-attach-'));
  let seconds=Math.floor(Date.now()/1000);const clock=()=>seconds;
  let handler,store;
  const server=createServer((request,response)=>{
    if(handler)return handler(request,response);
    response.writeHead(503);response.end();
  });
  t.after(async()=>{handler?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store?.close();await rm(home,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const owner=await openDevice({home:join(home,'owner'),clock,ensureDefault:false,provisionCircle:async({provisioning})=>{
    const dbPath=join(home,'coordinator.sqlite');
    provisionV1Store({path:dbPath,provisioning,clock});
    store=openV1Store({path:dbPath,clock});
    handler=createV1Handler({store,blobDir:join(home,'blobs'),clock});
  }});
  const offline=await owner.createCircle(null,{name:'Offline circle'});
  seconds+=ageDays*86400;
  await owner.updateCircleProfile(offline.id,{name:'Project crew',purpose:'First draft'});
  if(staleProfile){
    const rename=fs.renameSync;
    fs.renameSync=(source,target)=>{if(target===join(home,'owner','v1','state.json'))throw new Error('interrupted profile state write');return rename(source,target);};
    try{await assert.rejects(owner.updateCircleProfile(offline.id,{name:'Signed project crew',purpose:'Help with small projects'}),/interrupted profile state write/);}
    finally{fs.renameSync=rename;}
  }else await owner.updateCircleProfile(offline.id,{purpose:'Help with small projects'});
  const before=await owner.rosterCache(offline.id).get();
  assert.equal(before.current.payload.epoch,3);
  const rename=fs.renameSync;let profileEdit;
  if(interrupted){
    fs.renameSync=(source,target)=>{if(target===join(home,'owner','v1','state.json'))throw new Error('interrupted state write');return rename(source,target);};
    try{await assert.rejects(owner.createCircle(origin,{name:'Project crew',lanMode}),/interrupted state write/);}
    finally{fs.renameSync=rename;}
    assert.equal(owner.selectCircle(offline.id).origin,null);
    assert.equal((await owner.rosterCache(offline.id).get()).current.payload.coordinator,origin);
    const sealed=p.digest((await owner.rosterCache(offline.id).get()).current.payload);
    await assert.rejects(owner.createCircle('http://127.0.0.1:'+(server.address().port===65535?65534:server.address().port+1),{name:'Project crew'}),error=>error.code==='wrong_origin');
    await assert.rejects(owner.createCircle(origin,{name:'Project crew',lanMode:true}),error=>error.code==='transport_mismatch');
    assert.equal(p.digest((await owner.rosterCache(offline.id).get()).current.payload),sealed);
  }
  if(queued)fs.renameSync=(source,target)=>{
    const result=rename(source,target);
    if(target===join(home,'owner','v1','circles',offline.id,'roster.json')&&!profileEdit)
      profileEdit=owner.updateCircleProfile(offline.id,{purpose:'The queued purpose'});
    return result;
  };
  let attached;
  try{attached=await owner.createCircle(origin,{name:'Project crew',lanMode,publish});await profileEdit;}
  finally{fs.renameSync=rename;}
  const expectedPurpose=queued?'The queued purpose':'Help with small projects',expectedEpoch=queued?4:3;
  const expectedName=staleProfile?'Signed project crew':'Project crew';
  assert.equal(attached.id,offline.id);assert.equal(attached.pinnedRootFingerprint,offline.pinnedRootFingerprint);
  assert.equal(attached.origin,origin);assert.equal(attached.purpose,'Help with small projects');
  assert.equal(attached.name,expectedName);assert.equal(owner.selectCircle(attached.id).name,expectedName);
  assert.equal(owner.selectCircle(attached.id).purpose,expectedPurpose);
  const cache=await owner.rosterCache(offline.id).get();
  assert.equal(cache.highestAcceptedEpoch,expectedEpoch);assert.equal(cache.highestAcceptedDigest,p.digest(cache.current.payload));
  assert.deepEqual(cache.current.payload.profile,{...before.current.payload.profile,purpose:expectedPurpose});
  assert.deepEqual(cache.history.map(r=>r.payload.epoch).sort(),queued?[1,2,3]:[1,2]);
  for(const envelope of [cache.current,...cache.history]){
    assert.equal(envelope.payload.coordinator,origin);assert.equal(envelope.payload.lan_mode===true,lanMode);
    assert.equal(p.verifyRoster(envelope,{circle:offline.id,rootFingerprint:offline.pinnedRootFingerprint,now:()=>Date.parse(envelope.payload.issued_at)/1000}).ok,true);
  }
  const provisioning=JSON.parse(await readFile(attached.provisioningPath,'utf8'));
  assert.equal(provisioning.roster.payload.epoch,1);
  if(!publish)return;
  assert.deepEqual(await (await owner.client(attached.id)).refreshRoster(),cache.current);
  const member=await openDevice({home:join(home,'member'),clock,ensureDefault:false});
  const links=await owner.createInviteLinks(attached.id);
  await member.joinCircle(links.long,{acknowledgedWarning:true,waitMs:0});
  await owner.approveEnrollments(attached.id);await member.refreshRoster(attached.id);
  assert.equal(member.selectCircle(attached.id).name,expectedName);
  assert.equal(member.selectCircle(attached.id).purpose,expectedPurpose);
});
