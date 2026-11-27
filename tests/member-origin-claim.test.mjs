import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {appFixture,waitFor} from './helpers/v1-app-fixture.mjs';
import {provider,approved,publicOrigin} from './helpers/fake-gozar-provider.mjs';

// The member's origin claim (owner-offline topology). The member app turns its verified Gozar route into a small
// versioned claim carried as the body of an ordinary authenticated circle request; the sender is the roster member
// that request proof names. An authorized publisher reviews it and signs the origin in through setMemberOrigin. The
// claim is reach data only: it never changes membership or the signed roster by itself. Provider is the injected
// fake; no network, credentials or real route.

const rosterOf=async(app,id)=>(await app.device.rosterCache(id).get()).current.payload;
const reasons=(promise,code,label)=>assert.rejects(promise,error=>error.code===code,label+' ('+code+')');

test('a verified member route becomes a claim only the publisher can accept, exactly once, against the current roster',{timeout:300000},async t=>{
  const f=await appFixture(t),fake=provider();
  const {owner,declining,lender,circle,realRequests}=await f.realConnect({lenderOptions:{memberGozar:fake.api,memberRecheckMs:20}});
  const id=circle.id,ownerId=owner.app.device.keyId,lenderId=lender.app.device.keyId,otherId=declining.app.device.keyId;
  const origins=()=>realRequests.filter(r=>r.route.endsWith('/member-origins'));
  const review=async()=>(await owner.app.device.reviewMemberOrigins(id)).items;
  const initial=await rosterOf(owner.app,id);

  // Nothing is offered without a verified route, and a lost approval installs nothing.
  await reasons(lender.app.proposeMemberOrigin(id),'route_not_verified','no route yet');
  assert.equal(origins().length,0,'nothing reached the publisher');
  assert.deepEqual(await review(),[]);

  await approved(lender.app,fake);
  const started=await lender.app.memberExposure.start();
  assert.equal(started.origin,publicOrigin);
  const claim=await lender.app.proposeMemberOrigin(id);
  assert.equal(claim.state,'proposed');
  assert.deepEqual(Object.keys(claim.proposal).sort(),['generation','observed_at','origin','schema','state','valid_until'],
    'only bounded origin, generation and freshness evidence');
  assert.equal(claim.proposal.origin,publicOrigin);
  assert.equal(claim.proposal.generation,started.route.handle.generation);
  const posted=origins().filter(r=>r.method==='POST');
  assert.deepEqual(posted.map(r=>[r.device,r.status]),[[lenderId,202]],'the sender is the proof’s own roster member');
  const wire=JSON.stringify(claim.proposal);
  for(const secret of [started.route.handle.id,String(new URL(lender.app.origin).port),(await lender.app.memberListener.start()).target,'127.0.0.1'])
    assert.equal(wire.includes(secret),false,'the claim carries no local target, handle or tray detail: '+secret);

  // Who may read or accept it: the publisher authority only. A member can neither review nor publish its own claim.
  await reasons(lender.app.device.reviewMemberOrigins(id),'not_owner','member review');
  await reasons(lender.app.device.setMemberOrigin(id,lenderId,publicOrigin),'not_owner','member publish');
  await reasons(declining.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:claim.proposal_digest,roster_epoch:initial.epoch}),'not_owner','peer accept');
  await reasons((await lender.app.device.client(id)).listMemberOrigins(),'forbidden','host refuses a member listing');
  // The sender cannot be named in the body: a field naming another member is refused before anything is stored.
  const body=Buffer.from(p.canonicalize({proposal:claim.proposal,key_id:ownerId}));
  const spoof=await fetch(circle.origin+'/v1/circles/'+id+'/member-origins',{method:'POST',headers:{'content-type':'application/json',
    'idempotency-key':randomUUID(),'faravan-proof':p.buildRequestProof({circle:id,roster_epoch:initial.epoch,method:'POST',
      target:circle.origin+'/v1/circles/'+id+'/member-origins',body,content_type:'application/json',artifact_media_type:'',idempotency_key:randomUUID(),
      created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},lender.app.device.deviceKey.privateKey??lender.app.device.deviceKey)},body});
  assert.ok(spoof.status>=400&&spoof.status<500,'a body that names a sender is refused: '+spoof.status);

  const [reviewed]=await review();
  assert.deepEqual([reviewed.key_id,reviewed.state,reviewed.origin,reviewed.generation,reviewed.current_origin],
    [lenderId,'proposed',publicOrigin,claim.proposal.generation,null]);
  assert.equal(reviewed.proposal_digest,claim.proposal_digest);
  assert.deepEqual((await review()).map(row=>row.key_id),[lenderId],'only the sender has a claim');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch,'a claim alone changes no roster');

  // A lost route withdraws the claim (best effort), and a lost or changed claim cannot be approved.
  fake.lose(started.route.handle.id);
  await waitFor(()=>lender.app.memberExposure.origin()===null,'route loss');
  const withdrawn=await waitFor(async()=>(await review()).find(row=>row.state==='withdrawn'),'withdrawn claim');
  await reasons(owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:claim.proposal_digest,roster_epoch:initial.epoch}),'proposal_changed','old claim after loss');
  await reasons(owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:withdrawn.proposal_digest,roster_epoch:initial.epoch}),'proposal_withdrawn','withdrawn claim');
  await reasons(lender.app.proposeMemberOrigin(id),'route_not_verified','no live route');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch);

  // The member brings up a new route (a new generation) and offers that; the old reviewed claim is no longer current.
  await approved(lender.app,fake);
  const second=await lender.app.memberExposure.start();
  assert.notEqual(second.route.handle.generation,started.route.handle.generation);
  const fresh=await lender.app.proposeMemberOrigin(id);
  assert.notEqual(fresh.proposal_digest,claim.proposal_digest);
  const [current]=await review();
  assert.equal(current.generation,second.route.handle.generation);
  await reasons(owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:claim.proposal_digest,roster_epoch:initial.epoch}),'proposal_changed','changed generation');
  await reasons(owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:current.proposal_digest,roster_epoch:initial.epoch+5}),'roster_stale','another roster');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch,'refused approvals changed nothing');

  // The publisher accepts exactly the current claim; the signed member entry changes and nothing else does.
  const accepted=await owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:current.proposal_digest,roster_epoch:current.roster_epoch});
  assert.deepEqual([accepted.unchanged,accepted.origin,accepted.epoch],[false,publicOrigin,initial.epoch+1]);
  await lender.app.device.refreshRoster(id);
  await declining.app.device.refreshRoster(id);
  for(const view of [await rosterOf(owner.app,id),await rosterOf(lender.app,id)]) {
    assert.equal(view.epoch,initial.epoch+1);
    assert.equal(p.findMember(view,lenderId).origin,publicOrigin);
    assert.equal(view.coordinator,initial.coordinator,'the canonical coordinator does not move');
    for(const key of [ownerId,otherId])assert.deepEqual(p.findMember(view,key),p.findMember(initial,key),'unrelated members are unchanged');
    assert.deepEqual({...p.findMember(view,lenderId),origin:undefined},{...p.findMember(initial,lenderId),origin:undefined},'the member keeps every other field');
  }
  // An exact retry changes nothing.
  const again=await owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:current.proposal_digest,roster_epoch:current.roster_epoch});
  assert.deepEqual([again.unchanged,again.epoch],[true,initial.epoch+1]);
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch+1,'a replay publishes no new epoch');

  // A claim whose proof has lapsed cannot be approved (offered directly, below the app, with a two second proof).
  const t0=Math.floor(Date.now()/1000);
  await lender.app.device.proposeMemberOrigin(id,{origin:publicOrigin,generation:current.generation,validUntilSeconds:t0+2});
  await waitFor(async()=>(await review()).some(row=>row.state==='expired'),'lapsed claim',8000);
  const [lapsed]=await review();
  await reasons(owner.app.device.acceptMemberOrigin(id,{key_id:lenderId,proposal_digest:lapsed.proposal_digest,roster_epoch:lapsed.roster_epoch}),'proposal_expired','expired claim');
  assert.equal((await rosterOf(owner.app,id)).epoch,initial.epoch+1);

  // The local tray stays isolated: it serves no origin-claim route, and the listener answers only signed protocol paths.
  const tray=await fetch(lender.app.origin+'/api/member-origins',{headers:{'x-faravan-session-token':lender.app.token}});
  assert.equal(tray.status,404);
  const {port}=await lender.app.memberListener.start();
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/member-origins')).status,404);

  // Close finishes and removes only the member's own route.
  await lender.app.close();
  assert.deepEqual([...fake.routes.keys()].sort(),['coordinator-route','foreign-route']);
});
