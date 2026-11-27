import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,randomBytes} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {appFixture} from './helpers/v1-app-fixture.mjs';
import {memberProtocolRoute} from '../lib/v1/member-listener.mjs';

// Public signed-protocol ingress (owner-offline topology): a request that arrives under the member's
// recorded public origin is answered from the member store and authenticated by its signed proof against
// the exact roster target, never by Host, Origin or a forwarding header. No other route is reachable
// under a public Host, and the loopback session rules are unchanged.

const publicOrigin='https://member.example';
const get=(app,path,headers,port=new URL(app.origin).port)=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method:'GET',headers},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));
    res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',reject);req.end();
});

test('only exact signed-protocol paths qualify as member ingress',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  assert.equal(memberProtocolRoute('/v1/circles/'+id+'/roster'),id);
  assert.equal(memberProtocolRoute('/v1/circles/'+id),id);
  assert.equal(memberProtocolRoute('/v1/circles/'+id+'/jobs?limit=2'),id);
  for(const target of ['/api/status','/','/v1/circles/not-a-uuid/roster','/v1/circles/'+id+'/../../api/status','/v1/circles/'+id+'/%2e%2e/x',
    '//v1/circles/'+id+'/roster','http://member.example/v1/circles/'+id+'/roster','/v1/circles/'+id+'x/roster','/v1/circles/'+id+'\\..\\api',undefined,null])
    assert.equal(memberProtocolRoute(target),null,String(target));
});

test('a member serves signed-protocol requests under its public origin and nothing else',{timeout:180000},async t=>{
  const f=await appFixture(t);
  const {owner,lender,circle}=await f.realConnect({lenderOptions:{}});
  const lenderId=lender.app.device.keyId;
  const current=(await owner.app.device.rosterCache(circle.id).get()).current;
  const members=current.payload.members.map(member=>member.key_id===lenderId?{...member,origin:publicOrigin}:member);
  const rootKey=createPrivateKey(await readFile(join(await f.home('owner'),'v1','roots',circle.id+'.pem'),'utf8'));
  const roster=p.signEnvelope('roster',{...current.payload,epoch:current.payload.epoch+1,members},rootKey);
  const body=Buffer.from(p.canonicalize(roster));
  const route=circle.origin+'/v1/circles/'+circle.id+'/roster';
  const installProof=p.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method:'PUT',target:route,body,
    content_type:'application/json',artifact_media_type:'',idempotency_key:'',created:Math.floor(Date.now()/1000),
    nonce:randomBytes(24).toString('base64url')},owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey);
  assert.equal((await fetch(route,{method:'PUT',headers:{'content-type':'application/json','faravan-proof':installProof},body})).status,200);
  await owner.app.device.rosterCache(circle.id).set({current:roster,history:[],
    highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:p.digest(roster.payload)});
  await lender.app.device.refreshRoster(circle.id);

  const path='/v1/circles/'+circle.id+'/roster';
  const proofFor=target=>p.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method:'GET',target,
    body:Buffer.alloc(0),created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},
    owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey);
  const publicHost={host:'member.example'};
  const {port:memberPort}=await lender.app.memberListener.start();
  assert.notEqual(String(memberPort),new URL(lender.app.origin).port,'the member protocol has its own port');
  const member=(target,headers)=>get(lender.app,target,headers,memberPort);

  const served=await member(path,{...publicHost,'faravan-proof':proofFor(publicOrigin+path)});
  assert.equal(served.status,200,'a signed request for the recorded public target is served: '+served.body.slice(0,200));
  assert.equal(JSON.parse(served.body).payload.epoch,roster.payload.epoch);

  // Forwarding headers are not authority: lying values neither help nor hurt a correctly signed request.
  const forwarded=await member(path,{...publicHost,'x-forwarded-host':'evil.example','x-forwarded-proto':'http',
    forwarded:'host=evil.example','faravan-proof':proofFor(publicOrigin+path)});
  assert.equal(forwarded.status,200,'the proof target alone decides, not forwarding headers');
  // A proof for any other target is refused even under the right Host, and an unsigned request is refused.
  const other=await member(path,{...publicHost,'faravan-proof':proofFor('https://other.example'+path)});
  assert.ok(other.status>=400&&other.status<500,'a proof for another target is refused: '+other.status);
  const loopbackTarget=await member(path,{...publicHost,'faravan-proof':proofFor(lender.app.origin+path)});
  assert.ok(loopbackTarget.status>=400&&loopbackTarget.status<500,'the old loopback target is no longer the roster target');
  const unsigned=await member(path,publicHost);
  assert.ok(unsigned.status>=400&&unsigned.status<500,'no proof, no answer');

  // The tray port refuses the signed-protocol path: the member protocol is not served there.
  const tray=await get(lender.app,path,{...publicHost,'faravan-proof':proofFor(publicOrigin+path)},new URL(lender.app.origin).port);
  assert.equal(tray.status,403,'the tray port does not serve member traffic under a public Host');
  // The tray and session surface stays closed over the public path, however the request is shaped.
  for(const target of ['/','/api/status','/api/jobs','/auth/handoff?code=x','/mcp','/api/account-proxy/codex/v1/x','/favicon.svg',
    '/v1/circles/'+circle.id+'/../../api/status','/v1/circles/'+circle.id+'/%2e%2e/%2e%2e/api/status']) {
    const refused=await get(lender.app,target,{...publicHost,'x-forwarded-host':'127.0.0.1',origin:publicOrigin});
    assert.equal(refused.status,403,'public Host cannot reach '+target+': '+refused.body.slice(0,120));
    assert.doesNotMatch(refused.body,/sessionToken|"token"/);
  }
  // Local access is unchanged: the loopback Host still reaches the session boundary and is asked to sign in.
  const local=await get(lender.app,'/api/status',{});
  assert.equal(local.status,401,'loopback Host still needs the session');
});
