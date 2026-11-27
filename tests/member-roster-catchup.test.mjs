import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as p from '../lib/protocol/index.mjs';
import {createClient} from '../lib/v1/client.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

// Owner-offline invite and roster slice, in real apps over a real signed-roster host (no network beyond loopback):
//  1. an invite signs the member addresses the accepted roster records, and an ordinary invite is unchanged;
//  2. a known member catches up to a newer roster through a member the accepted roster already names when only
//     the incumbent host is unreachable, and refuses every carried roster that is stale, foreign, moved or expired;
//  3. a FRESH join needs the incumbent: the exact edges that would need new enrollment authority are pinned here.

const nowSeconds=()=>Math.floor(Date.now()/1000);
const iso=seconds=>new Date(seconds*1000).toISOString().replace('.000Z','Z');

/** The circle with the lender serving its own recorded origin, accepted by the lender and the declining peer. */
async function circleWithServingMember(t) {
  const f=await appFixture(t);
  const connected=await f.realConnect({lenderOptions:{}});
  const {owner,lender,circle}=connected;
  const memberOrigin='http://127.0.0.1:'+(await lender.app.memberListener.start()).port;
  // Everything the lender's own listener receives is recorded, and a test may answer GET /roster there instead.
  const seen=[],server=lender.app.memberListener.server,original=server.listeners('request');
  const control={answer:null};
  server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const url=new URL(req.url,'http://member');
    const proof=req.headers['faravan-proof']?JSON.parse(Buffer.from(req.headers['faravan-proof'],'base64url')).payload:null;
    seen.push({method:req.method,path:url.pathname,key:proof?.key_id??null,target:proof?.target??null,epoch:proof?.roster_epoch??null});
    if(control.answer&&req.method==='GET'&&url.pathname.endsWith('/roster')) {
      res.writeHead(200,{'content-type':'application/json'});return void res.end(p.canonicalize(control.answer));
    }
    for(const listener of original)listener.call(server,req,res);
  });
  const rootKey=createPrivateKey(await readFile(join(await f.home('owner'),'v1','roots',circle.id+'.pem'),'utf8'));
  const epochOf=async app=>(await app.device.rosterCache(circle.id).get()).current.payload.epoch;
  return {f,...connected,memberOrigin,seen,control,rootKey,epochOf,lenderId:lender.app.device.keyId,ownerId:owner.app.device.keyId};
}

test('an invite signs the accepted member addresses; an ordinary invite is unchanged; a fresh join still needs the incumbent',{timeout:240000},async t=>{
  const w=await circleWithServingMember(t);
  const {f,owner,lender,circle,incumbent,memberOrigin,seen,lenderId}=w;
  const decode=link=>p.decodeInviteLink(link).invite;

  // A circle that records no member address signs none: the invite is exactly the one an older Faravan reads.
  const plain=await owner.app.device.createInviteLinks(circle.id);
  assert.ok(plain.short&&plain.long);
  assert.equal(decode(plain.long).payload.member_origins,undefined);
  assert.deepEqual(Object.keys(decode(plain.long).payload).sort(),
    ['circle','coordinator','created_at','display_name','expires_at','invite_id','invite_public_key','owner_name','root_fingerprint','root_public_key','schema']);

  // The accepted roster now records the lender's own origin; the invite signs it and keeps the canonical coordinator.
  await owner.app.device.setMemberOrigin(circle.id,lenderId,memberOrigin);
  const carried=await owner.app.device.createInviteLinks(circle.id);
  assert.equal(carried.short,null,'a short link cannot carry signed addresses, so only the long link is offered');
  assert.match(carried.note,/long link/);
  const invite=decode(carried.long);
  assert.deepEqual(invite.payload.member_origins,[{key_id:lenderId,origin:memberOrigin}]);
  assert.equal(invite.payload.coordinator,circle.origin,'the canonical coordinator is unchanged');
  assert.equal(invite.payload.max_uses,undefined,'default use compatibility is unchanged');
  p.verifyInvite(invite,{rootFingerprint:circle.pinnedRootFingerprint,circle:circle.id,coordinator:circle.origin,now:nowSeconds});
  assert.equal(await owner.app.device.createInvite(circle.id).then(link=>decode(link).payload.coordinator),circle.origin,'the wrapper returns the long link when addresses are carried');
  const listed=await owner.app.device.listInvitations(circle.id);
  for(const link of [plain.long,carried.long])
    assert.equal(listed.find(row=>row.id===decode(link).payload.invite_id)?.state,'issued','the invite is registered at the incumbent');

  // The first fresh join with the incumbent gone: nothing reaches the serving member, and nothing is spent.
  const joiner=await f.start('joiner');
  await lender.app.device.refreshRoster(circle.id);
  incumbent.down();
  const memberRequests=seen.length;
  const refused=await joiner.app.device.joinCircle(carried.long,{waitMs:0}).then(()=>null,error=>error);
  assert.ok(refused,'the join cannot complete while the incumbent is unreachable');
  assert.equal(refused.outcome,'unknown','an unreachable host is an uncertain outcome, never a refusal');
  assert.equal(seen.length,memberRequests,'the joiner sends no enrollment to a member');
  assert.equal((await joiner.app.device.selectCircle(circle.id)).joinIntent.outcome,'unknown','the signed invite stays resumable');

  // Edge 1: a client bound to a member origin refuses the invite, because an invite names one coordinator.
  const bound=createClient({origin:memberOrigin,circle:circle.id,deviceKey:joiner.app.device.deviceKey,pinnedRootFingerprint:circle.pinnedRootFingerprint,
    rosterCache:{get:async()=>null,set:async()=>{}},lanMode:false});
  await assert.rejects(()=>bound.enroll(carried.long),error=>error.code==='wrong_origin');
  assert.equal(seen.length,memberRequests,'the refusal happens before any request');

  // The incumbent returns: the same signed invite is used exactly once, and the real authorized signer admits it.
  incumbent.up();
  await joiner.app.device.resumeJoin(circle.id);
  await api(owner.app,'/api/circles/'+circle.id+'/approve',{method:'POST',body:{}});
  await joiner.app.device.refreshRoster(circle.id);
  const joined=(await joiner.app.device.rosterCache(circle.id).get()).current.payload;
  assert.ok(p.findMember(joined,joiner.app.device.keyId),'admitted by the roster the owner signed');
  assert.equal(joined.coordinator,circle.origin);
  assert.equal(p.findMember(joined,lenderId).origin,memberOrigin);

  // One-use and revocation evidence are intact for an invite that carries addresses.
  const second=await f.start('second');
  const reused=await second.app.device.joinCircle(carried.long,{waitMs:0}).then(()=>null,error=>error);
  assert.ok(reused,'a used invite is refused');
  assert.equal(reused.outcome,'not_applied');
  const revoked=await owner.app.device.createInviteLinks(circle.id);
  await owner.app.device.revokeInvitation(circle.id,decode(revoked.long).payload.invite_id);
  const third=await f.start('third');
  const refusedRevoked=await third.app.device.joinCircle(revoked.long,{waitMs:0}).then(()=>null,error=>error);
  assert.ok(refusedRevoked,'a revoked invite is refused');
  assert.equal(refusedRevoked.outcome,'not_applied');
});

test('a known member catches up through a pinned member when only the incumbent is unreachable, and refuses carried rosters that are stale, foreign, moved or expired',{timeout:240000},async t=>{
  const w=await circleWithServingMember(t);
  const {f,owner,declining,lender,circle,incumbent,memberOrigin,seen,control,rootKey,epochOf,lenderId,ownerId}=w;
  const id=circle.id,decliningId=declining.app.device.keyId;

  // A fourth member joins first, so the later update has something legitimate to change.
  const newcomer=await f.start('newcomer');
  await newcomer.app.device.joinCircle(await owner.app.device.createInvite(id),{waitMs:0});
  await api(owner.app,'/api/circles/'+id+'/approve',{method:'POST',body:{}});
  await newcomer.app.device.refreshRoster(id);
  // Epoch A: the owner signs the lender's serving origin in; both members accept it from the incumbent.
  await owner.app.device.setMemberOrigin(id,lenderId,memberOrigin);
  await declining.app.device.refreshRoster(id);await lender.app.device.refreshRoster(id);
  const epochA=await epochOf(declining.app);
  assert.equal(await epochOf(lender.app),epochA);
  const accepted=(await declining.app.device.rosterCache(id).get()).current;
  assert.equal(p.findMember(accepted.payload,lenderId).origin,memberOrigin,'the origin is pinned by the accepted roster');

  // The declining peer sends a job designated to the lender: its basis is epoch A and it is kept in the member store.
  const operations=createJobOperations({device:declining.app.device,clock:nowSeconds});
  const submitted=await operations.submit({circle:id,prompt:'Retained across a roster update',git:'https://github.com/example/app.git@'+'a'.repeat(40),
    harness:'claude-code',send_anyway:true,designated_member:lenderId});
  const digest=submitted.jobDigest;
  assert.ok(digest);

  // Epoch B: one legitimate update (the owner removes that member), accepted by the lender from the incumbent while it is still reachable.
  await owner.app.device.removeMember(id,newcomer.app.device.keyId);
  await lender.app.device.refreshRoster(id);
  const epochB=await epochOf(lender.app);
  assert.equal(epochB,epochA+1);
  assert.equal(await epochOf(declining.app),epochA,'the declining peer has not seen it yet');

  // While the incumbent answered, an ordinary refresh never asked a member.
  assert.equal(seen.filter(row=>row.path.endsWith('/roster')&&row.key===decliningId).length,0,'the incumbent is the ordinary coordinator');

  // The declining peer is still at epoch A and has to catch up: take the incumbent away.
  const cache=declining.app.device.rosterCache(id);
  const before=await declining.app.device.selectCircle(id);
  incumbent.down();
  const clientFor=()=>createClient({origin:memberOrigin,circle:id,deviceKey:declining.app.device.deviceKey,pinnedRootFingerprint:circle.pinnedRootFingerprint,rosterCache:cache,lanMode:false});
  const unchanged=async label=>{
    assert.equal(await epochOf(declining.app),epochA,label+': the accepted roster did not move');
    assert.equal((await declining.app.device.selectCircle(id)).origin,before.origin,label+': the canonical coordinator is unchanged');
  };

  // Rejections: each answer arrives at the pinned origin and is refused by the existing roster verification.
  const current=(await lender.app.device.rosterCache(id).get()).current;
  const members=current.payload.members;
  const foreign=generateKeyPairSync('ed25519').privateKey;
  const rosterOf=(payload,key=rootKey)=>p.signEnvelope('roster',payload,key);
  const cases=[
    ['wrong pin: a roster signed by another root',rosterOf({...current.payload,epoch:epochB+1,root_public_key:p.exportPublicKey(foreign)},foreign),['root_mismatch']],
    ['moved: the roster no longer names the origin it was read from',
      rosterOf({...current.payload,epoch:epochB+1,members:members.map(m=>m.key_id===lenderId?{...m,origin:'http://127.0.0.1:1'}:m)}),['wrong_origin']],
    ['expired: a signed roster past its validity',
      rosterOf({...current.payload,epoch:epochB+1,issued_at:iso(nowSeconds()-2*86400),valid_until:iso(nowSeconds()-86400)}),['roster_expired']],
  ];
  for(const [label,answer,codes] of cases) {
    control.answer=answer;
    await assert.rejects(()=>clientFor().refreshRoster(),error=>codes.includes(error.code),label+' is refused by roster verification');
    await assert.rejects(()=>declining.app.device.refreshRoster(id),error=>error.code==='network_error'||error.status===503||error.code==='circle_unreachable',label+': the incumbent failure stands');
    await unchanged(label);
  }
  control.answer=null;

  // The honest member serves the update. The roster verified by the pinned root is accepted from the exact target.
  const requestsBefore=seen.length;
  const caught=await declining.app.device.refreshRoster(id);
  assert.equal(caught.payload.epoch,epochB);
  assert.equal(await epochOf(declining.app),epochB,'caught up through the pinned member while the incumbent is down');
  assert.equal(p.digest(caught.payload),p.digest(current.payload),'exactly the roster the authority signed');
  assert.equal(caught.signature.key_id,current.signature.key_id,'signed by the circle authority, not by the serving member');
  const carried=seen.slice(requestsBefore).filter(row=>row.method==='GET'&&row.path==='/v1/circles/'+id+'/roster');
  assert.ok(carried.length>0);
  for(const row of carried) {
    assert.equal(row.key,decliningId,'the request is signed by the reading member');
    assert.equal(row.target,memberOrigin+'/v1/circles/'+id+'/roster','the exact request target of the pinned member');
  }
  const after=await declining.app.device.selectCircle(id);
  assert.equal(after.origin,circle.origin,'the canonical coordinator is unchanged');
  assert.equal(after.owned===true||after.steward===true||after.admin===true,false,'the carrier is no authority here');
  const latest=(await cache.get()).current.payload;
  assert.equal(latest.coordinator,circle.origin);
  assert.equal(p.findMember(latest,newcomer.app.device.keyId),null,'the update the authority signed: that member is gone');
  assert.equal(p.findMember(latest,lenderId).origin,memberOrigin);
  assert.equal(p.findMember(latest,lenderId).key_id===ownerId,false);
  assert.notEqual(declining.app.device.rosterReceipt(id)?.epoch,epochB,'a peer-carried roster is not a fresh host receipt');

  // The retained job basis: the job accepted at epoch A is still the same job at the member store under epoch B.
  const lenderClient=await declining.app.device.memberClient(id,lenderId);
  const view=await lenderClient.getJob(digest);
  assert.equal(view.job_digest,digest);
  assert.equal(view.state,'queued');
  const persisted=new DatabaseSync(join(await f.home('lender'),'v1','member-stores',id+'.sqlite'),{readOnly:true});
  t.after(()=>persisted.close());
  assert.equal(JSON.parse(persisted.prepare("SELECT data FROM circle WHERE id='config'").get().data).epoch,epochB,'the member store serves the update');
  assert.ok(persisted.prepare('SELECT data FROM jobs WHERE id=?').get(digest),'the retained job is in the member store');

  // Nothing newer: a member that only holds the roster already accepted is no catch-up, and the failure stands.
  await assert.rejects(()=>declining.app.device.refreshRoster(id),error=>error.code==='network_error');
  assert.equal(await epochOf(declining.app),epochB);

  // Stale: once epoch B is accepted, a carried epoch A is not an update.
  control.answer=accepted;
  await assert.rejects(()=>clientFor().refreshRoster(),error=>error.code==='roster_stale','a stale carried roster is refused');
  await assert.rejects(()=>declining.app.device.refreshRoster(id),()=>true);
  assert.equal(await epochOf(declining.app),epochB,'the accepted roster never moved back');
  control.answer=null;
});
