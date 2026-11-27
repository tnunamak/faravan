import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import * as p from '../lib/protocol/index.mjs';

test('owner invitation ledger and revoke run against the real coordinator; existing members keep access', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.realConnect();
  const path='/api/circles/'+circle.id;
  const {invite}=await api(owner.app,path+'/invite',{method:'POST',body:{preset:'group'}});
  const decoded=p.decodeShortLink(invite);assert.equal(decoded.ok,true);
  const rows=await api(owner.app,path+'/invitations'),item=rows.find(row=>row.state==='issued');
  assert.equal(item.maxUses,10);
  assert.equal(Date.parse(item.expiresAt)-Date.parse(item.createdAt),86400000);
  assert.ok(!JSON.stringify(rows).includes(decoded.seed),'ledger never returns invitation seeds');
  const joining=await f.start('joining',{joinWaitMs:0});
  await api(owner.app,path+'/approval-mode',{method:'POST',body:{approveEach:true}});
  await api(joining.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  assert.equal((await api(owner.app,path+'/invitations')).find(row=>row.id===item.id).state,'waiting');
  const result=await api(owner.app,path+'/invitations/revoke',{method:'POST',body:{inviteId:item.id}});
  assert.equal(result.revoked,true);
  assert.equal((await api(owner.app,path+'/invitations')).find(row=>row.id===item.id).state,'revoked');
  const another=await f.start('another');
  await api(another.app,'/api/circles/join',{method:'POST',body:{link:invite},status:400});
  const own=(await api(lender.app,'/api/devices')).fingerprint;
  await lender.app.device.refreshRoster(circle.id);
  assert.ok((await lender.app.device.rosterCache(circle.id).get()).current.payload.members.some(member=>member.key_id===own));
  const pending=await api(owner.app,path+'/approvals');assert.ok(!pending.some(row=>row.invite_id===item.id));
});

test('an older coordinator refuses revoke without recording a false success', {timeout:30000}, async t=>{
  const f=await appFixture(t),owner=await f.start('owner');await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}}),path='/api/circles/'+circle.id;
  await api(owner.app,path+'/invite',{method:'POST',body:{}});
  const [item]=await api(owner.app,path+'/invitations');
  f.hostCapabilities={capabilities:[]};
  const error=await api(owner.app,path+'/invitations/revoke',{method:'POST',body:{inviteId:item.id},status:409});
  assert.equal(error.code,'host_update_required');
  assert.equal((await api(owner.app,path+'/invitations'))[0].state,'issued');
});

test('a saved approval decision is not reported as approved until a signed roster confirms it', {timeout:30000}, async t=>{
  const f=await appFixture(t),owner=await f.start('owner');await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}}),path='/api/circles/'+circle.id;
  await api(owner.app,path+'/invite',{method:'POST',body:{}});
  const store=owner.app.device.intentStore(circle.id),saved=(await store.list()).find(row=>row.kind==='invite');
  const current=(await owner.app.device.rosterCache(circle.id).get()).current.payload;
  await store.set('invite:'+saved.invite.payload.invite_id,{...saved,approvedKeys:{[owner.app.device.keyId]:current.epoch+1}});
  const [item]=await api(owner.app,path+'/invitations');
  assert.equal(item.approved,0);assert.equal(item.unconfirmed,1);assert.equal(item.state,'approval_unconfirmed');
});

test('offline history keeps local revokes visible and legacy invitations are issued', {timeout:30000}, async t=>{
  const f=await appFixture(t),owner=await f.start('owner');await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}}),path='/api/circles/'+circle.id;
  await api(owner.app,path+'/invite',{method:'POST',body:{}});
  const store=owner.app.device.intentStore(circle.id),saved=(await store.list()).find(row=>row.kind==='invite'),key='invite:'+saved.invite.payload.invite_id;
  const legacy={...saved};delete legacy.published;await store.set(key,legacy);
  assert.equal((await api(owner.app,path+'/invitations'))[0].state,'issued');
  await store.set(key,{...legacy,revokeRequested:true});
  const prior=f.override;f.override=async ctx=>{if(ctx.route==='/enrollments'){ctx.res.writeHead(503);ctx.res.end();return true;}return prior(ctx);};
  const [row]=await api(owner.app,path+'/invitations');
  assert.equal(row.state,'revocation_unconfirmed');assert.equal(row.waiting,null);
});

test('a pending request cannot report approval after local revocation starts', {timeout:30000},async t=>{
  const f=await appFixture(t),owner=await f.start('owner'),joining=await f.start('joining');await f.provisionFromHome('owner');
  const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}}),path='/api/circles/'+circle.id;
  const {invite}=await api(owner.app,path+'/invite',{method:'POST',body:{}});
  await api(joining.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  const [pending]=await api(owner.app,path+'/approvals'),store=owner.app.device.intentStore(circle.id),saved=(await store.list()).find(row=>row.kind==='invite');
  await store.set('invite:'+saved.invite.payload.invite_id,{...saved,revokeRequested:true});
  const error=await api(owner.app,path+'/approve',{method:'POST',body:{enrollmentId:pending.enrollment_id},status:409});
  assert.equal(error.code,'invitation_revoked');
});


test('a late publication acknowledgement preserves a concurrent local revoke', {timeout:30000},async t=>{
 const f=await appFixture(t),owner=await f.start('owner');await f.provisionFromHome('owner');
 const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Friends'}}),path='/api/circles/'+circle.id;
 const prior=f.override;let release;
 const held=new Promise(resolve=>{release=resolve;});
 f.override=async ctx=>{if(ctx.route==='/invites')await held;return prior(ctx);};
 const issuing=api(owner.app,path+'/invite',{method:'POST',body:{}});issuing.catch(()=>{});
 const store=owner.app.device.intentStore(circle.id);
 try {
  const row=await waitFor(async()=>(await store.list()).find(row=>row.kind==='invite'));
  await store.set('invite:'+row.invite.payload.invite_id,{...row,revokeRequested:true,revokedAt:'2026-10-20T12:00:00Z'});
  release();await issuing;
  const saved=await store.get('invite:'+row.invite.payload.invite_id);
  assert.equal(saved.published,true);assert.equal(saved.revokeRequested,true);assert.equal(saved.revokedAt,'2026-10-20T12:00:00Z');
 } finally {release();await issuing.catch(()=>{});}
});
