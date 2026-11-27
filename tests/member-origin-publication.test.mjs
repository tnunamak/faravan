import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {randomBytes} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {appFixture} from './helpers/v1-app-fixture.mjs';

// Authenticated member-origin publication and convergence (owner-offline topology): only the signed
// owner/steward/admin path records where a member serves; the member converges through the ordinary
// roster refresh and serves under that origin; the coordinator identity never moves.

const publicOrigin='https://member.example';
const get=(port,path,headers)=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method:'GET',headers},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));
    res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',reject);req.end();
});

test('the owner signs a member origin into the roster and the member converges and serves it',{timeout:180000},async t=>{
  const f=await appFixture(t);
  const {owner,lender,circle}=await f.realConnect({lenderOptions:{}});
  const ownerId=owner.app.device.keyId,lenderId=lender.app.device.keyId;
  const before=(await owner.app.device.rosterCache(circle.id).get()).current.payload;

  await assert.rejects(()=>lender.app.device.setMemberOrigin(circle.id,lenderId,publicOrigin),
    error=>error.code==='not_owner','a member cannot publish its own origin');
  await assert.rejects(()=>owner.app.device.setMemberOrigin(circle.id,'sha256:'+'f'.repeat(64),publicOrigin),
    error=>error.code==='not_found','a non-member cannot be given an origin');
  await assert.rejects(()=>owner.app.device.setMemberOrigin(circle.id,lenderId,'http://insecure.example'),
    'an origin the protocol rejects is not signed');

  const published=await owner.app.device.setMemberOrigin(circle.id,lenderId,publicOrigin);
  assert.equal(published.epoch,before.epoch+1);
  await assert.rejects(()=>owner.app.device.setMemberOrigin(circle.id,ownerId,publicOrigin),
    'two members cannot claim one origin');

  // Convergence: the member's ordinary refresh accepts the signed roster; coordinator identity is unchanged.
  await lender.app.device.refreshRoster(circle.id);
  const after=(await lender.app.device.rosterCache(circle.id).get()).current.payload;
  assert.equal(after.epoch,published.epoch);
  assert.equal(p.findMember(after,lenderId).origin,publicOrigin);
  assert.equal(after.coordinator,before.coordinator,'the incumbent coordinator identity does not move');
  assert.equal(p.findMember(after,ownerId).origin,undefined,'other members gain no origin');

  const path='/v1/circles/'+circle.id+'/roster';
  const read=async()=>get((await lender.app.memberListener.start()).port,path,{host:'member.example','faravan-proof':p.buildRequestProof({circle:circle.id,
    roster_epoch:after.epoch,method:'GET',target:publicOrigin+path,body:Buffer.alloc(0),created:Math.floor(Date.now()/1000),
    nonce:randomBytes(24).toString('base64url')},owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey)});
  const served=await read();
  assert.equal(served.status,200,'the member answers under the published origin: '+served.body.slice(0,160));

  // Withdrawal converges the same way and closes the endpoint.
  const cleared=await owner.app.device.setMemberOrigin(circle.id,lenderId,null);
  await lender.app.device.refreshRoster(circle.id);
  assert.equal(p.findMember((await lender.app.device.rosterCache(circle.id).get()).current.payload,lenderId).origin,undefined);
  assert.equal(cleared.epoch,published.epoch+1);
  assert.equal((await read()).status,404,'a withdrawn origin serves nothing');
});
