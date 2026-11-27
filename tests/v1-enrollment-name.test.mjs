import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, sign, verify } from 'node:crypto';
import { verifyMemberProfile } from '../lib/v1/member-profile.mjs';
import { HOST_CAPABILITIES } from '../lib/v1/versions.mjs';
import { realCoordinator } from './helpers/v1-short-invite.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { need, guard, object, canonicalize, strictParse, digest, decodeBase64url,
  importPublicKey, fingerprint } from '../lib/protocol/encoding.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import * as p from '../lib/protocol/index.mjs';

const testOptions = {timeout: 30000};
const UUID = '11111111-1111-4111-8111-111111111111';

test('enrollment proof binds an optional device name under the invite signature', () => {
  const invite = p.privateKeyFromSeed(Buffer.alloc(32, 7).toString('base64url'));
  const device = p.exportPublicKey(p.privateKeyFromSeed(Buffer.alloc(32, 9).toString('base64url')));
  const base = {circle: UUID, invite_id: UUID, device_public_key: device};
  const options = {invitePublicKey: p.exportPublicKey(invite), ...base};
  const named = p.createEnrollmentProof({...base, device_name: 'Maya’s laptop'}, invite);
  assert.equal(named.payload.device_name, 'Maya’s laptop');
  assert.equal(p.verifyEnrollmentProof(named, options).ok, true);
  // Changing or removing the name breaks the signature: a coordinator cannot relabel a device.
  const renamed = structuredClone(named); renamed.payload.device_name = 'Admin';
  assert.equal(p.verifyEnrollmentProof(renamed, options).code, 'invalid_signature');
  const stripped = structuredClone(named); delete stripped.payload.device_name;
  assert.equal(p.verifyEnrollmentProof(stripped, options).code, 'invalid_signature');
  // Unnamed proofs keep the original wire form.
  assert.equal(p.verifyEnrollmentProof(p.createEnrollmentProof(base, invite), options).ok, true);
  for (const bad of ['', ' padded', 'x'.repeat(65), 'a\nb', 'evil‮gpj', 7])
    assert.throws(() => p.createEnrollmentProof({...base, device_name: bad}, invite), undefined, String(bad));
});

test('owner sees the joining device name and fingerprint; roster carries the approved name', testOptions, async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner'), lender = await f.start('lender');
  await f.provisionFromHome('owner');
  await api(lender.app, '/api/devices', {method: 'POST', body: {name: 'Maya’s laptop'}});
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Friends'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: invite}});
  const [pending] = await api(owner.app, '/api/circles/' + circle.id + '/approvals');
  assert.equal(pending.device_name, 'Maya’s laptop');
  assert.equal(pending.device_fingerprint, p.fingerprint(pending.device_public_key));
  assert.match(pending.device_fingerprint, /^sha256:[0-9a-f]{64}$/);
  const result = await owner.app.device.approveEnrollments(circle.id);
  assert.deepEqual(result.approvedDevices, [{key_id: pending.device_fingerprint, device_name: 'Maya’s laptop'}]);
  await lender.app.device.refreshRoster(circle.id);
  const roster = (await lender.app.device.rosterCache(circle.id).get()).current.payload;
  assert.equal(roster.members.find(m => m.key_id === pending.device_fingerprint).device_name, 'Maya’s laptop');
});

// Frozen enrollment implementation and closed payload schema from
// tnunamak/faravan@a35bcae6114f1eeadae552089c6bb68d2dfe1148, lib/protocol/index.mjs.
// This is the parent of 5aea0c2 (which first adds person_name). The schema,
// creator and verifier below are copied, not reconstructed from today's validator.
// Shared encoding primitives remain imported; no production enrollment validator
// is used for the legacy side.
const legacyEnrollment = (() => {
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const checkUUID = x => need(typeof x === 'string' && uuidPattern.test(x));
const checkDigest = x => need(typeof x === 'string' && digestPattern.test(x));
const integer = (n, min=0, max=Number.MAX_SAFE_INTEGER) => need(Number.isSafeInteger(n) && !Object.is(n,-0) && n>=min && n<=max, 'invalid_number');

function profile(value) { strictParse(canonicalize(value)); walk(value); }
function walk(v) {
  if (typeof v === 'number') integer(v,-Number.MAX_SAFE_INTEGER);
  if (v && typeof v === 'object') for(const x of Object.values(v)) walk(x);
}

function signingBytes(kind,payload) {
  return Buffer.concat([Buffer.from('faravan/'+kind+'/v1\0'), Buffer.from(digest(payload).slice(7),'hex')]);
}
function validateSignature(signature) {
  importPublicKey(signature.subarray(0,32).toString('base64url'));
  let scalar=0n; for(let i=63;i>=32;i--) scalar=(scalar<<8n)+BigInt(signature[i]);
  need(scalar<((1n<<252n)+27742317777372353535851937790883648493n),'invalid_signature');
}

const checkDeviceName = name => need(typeof name === 'string' && name.length >= 1 && [...name].length <= 64 &&
  name === name.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), 'invalid_device_name');

function createEnrollmentProof({circle,invite_id,device_public_key,device_name},invitePrivateKey) {
  const payload={circle,invite_id,device_public_key};checkUUID(circle);checkUUID(invite_id);importPublicKey(device_public_key);
  if(device_name!==undefined){checkDeviceName(device_name);payload.device_name=device_name;}
  return {payload,signature:{algorithm:'Ed25519',key_id:fingerprint(createPublicKey(invitePrivateKey)),
    value:sign(null,signingBytes('enrollment',payload),invitePrivateKey).toString('base64url')}};
}
/** Verify enrollment context and signature against the owner's independently registered invite public key. */
function verifyEnrollmentProof(proof,{invitePublicKey,circle,invite_id,device_public_key}={}) {
  return guard(()=>{
    object(proof,['payload','signature']);object(proof.payload,['circle','invite_id','device_public_key'],['device_name']);object(proof.signature,['algorithm','key_id','value']);
    if(proof.payload.device_name!==undefined)checkDeviceName(proof.payload.device_name);
    profile(proof);checkUUID(circle);checkUUID(invite_id);importPublicKey(device_public_key);
    need(proof.payload.circle===circle,'wrong_circle');need(proof.payload.invite_id===invite_id,'invite_mismatch');
    need(proof.payload.device_public_key===device_public_key,'device_mismatch');
    need(proof.signature.algorithm==='Ed25519'&&proof.signature.key_id===fingerprint(invitePublicKey),'key_mismatch');
    const signature=decodeBase64url(proof.signature.value,64);validateSignature(signature);
    need(verify(null,signingBytes('enrollment',proof.payload),importPublicKey(invitePublicKey),signature),'invalid_signature');
    return {ok:true,payload:proof.payload};
  });
}

  return Object.freeze({createEnrollmentProof, verifyEnrollmentProof});
})();

test('frozen pre-person-name schema rejects the extra field; old-client proof passes the new host', () => {
  const invite = p.privateKeyFromSeed(Buffer.alloc(32, 7).toString('base64url'));
  const device = p.exportPublicKey(p.privateKeyFromSeed(Buffer.alloc(32, 9).toString('base64url')));
  const base = {circle: UUID, invite_id: UUID, device_public_key: device, device_name: 'Maya’s laptop'};
  const options = {invitePublicKey: p.exportPublicKey(invite), ...base};
  const oldProof = legacyEnrollment.createEnrollmentProof(base, invite);
  assert.equal(legacyEnrollment.verifyEnrollmentProof(oldProof, options).ok, true);
  assert.equal(p.verifyEnrollmentProof(oldProof, options).ok, true);
  const named = p.createEnrollmentProof({...base, person_name: 'Maya'}, invite);
  assert.equal(p.verifyEnrollmentProof(named, options).ok, true);
  assert.equal(legacyEnrollment.verifyEnrollmentProof(named, options).ok, false);
  const tampered = structuredClone(oldProof); tampered.payload.device_name = 'Admin';
  assert.equal(legacyEnrollment.verifyEnrollmentProof(tampered, options).code, 'invalid_signature');
});

test('new client sends a legacy enrollment proof without a pre-membership capability request', testOptions, async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Friends'}});
  const {long: link} = await owner.app.device.createInviteLinks(circle.id);
  const decoded = p.decodeInviteLink(link);
  assert.equal(decoded.ok, true);
  const payload = decoded.invite.payload;
  const deviceKey = p.privateKeyFromSeed(Buffer.alloc(32, 9).toString('base64url'));
  const publicKey = p.exportPublicKey(deviceKey);
  for (const mode of ['legacy', 'modern']) await t.test(mode, async () => {
    const sent = [], requests = [];
    const client = createClient({
      origin: payload.coordinator, circle: payload.circle, deviceKey,
      pinnedRootFingerprint: payload.root_fingerprint, lanMode: payload.lan_mode === true,
      rosterCache: {get: async () => null, set: async () => {}}, retry: {maxAttempts: 1},
      fetch: async (url, init) => {
        requests.push(new URL(url).pathname);
        assert.ok(url.endsWith('/enrollments'));
        assert.equal(init.method, 'POST');
        const body = JSON.parse(Buffer.from(init.body).toString());
        sent.push(body.enrollment_proof);
        const verifyProof = mode === 'modern' ? p.verifyEnrollmentProof : legacyEnrollment.verifyEnrollmentProof;
        const result = verifyProof(body.enrollment_proof, {
          invitePublicKey: payload.invite_public_key, circle: payload.circle,
          invite_id: payload.invite_id, device_public_key: publicKey,
        });
        if (!result.ok) return new Response(JSON.stringify({code: result.code}), {
          status: 400, headers: {'content-type': 'application/problem+json'},
        });
        return new Response(p.canonicalize({enrollment_id: UUID, state: 'pending', device_key_id: p.fingerprint(publicKey), roster: null}), {headers: {'content-type': 'application/json'}});
      },
    });
    const result = await client.enroll(link, {deviceName: 'Maya’s laptop', personName: 'Maya'});
    assert.equal(result.state, 'pending');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.device_name, 'Maya’s laptop');
    assert.equal(sent[0].payload.person_name, undefined);
    assert.deepEqual(requests.map(path => path.split('/').at(-1)), ['enrollments']);
  });
});


test('post-membership names use signed profiles without extending the roster', testOptions, async t => {
  const time=Math.floor(Date.now()/1000);
  const f = await realCoordinator(t,{clock:()=>time}), member = await f.device('member');
  await member.setOwnerName('Maya Okafor');
  await member.joinCircle((await f.owner.createInviteLinks(f.circle.id)).long, {deviceName:'kestrel'});
  await f.owner.approveEnrollments(f.circle.id);
  await member.refreshRoster(f.circle.id);
  assert.equal((await f.owner.memberNames(f.circle.id)).get(member.keyId), 'Maya Okafor');
  const roster = (await member.rosterCache(f.circle.id).get()).current.payload;
  assert.equal(roster.members.find(m=>m.key_id===member.keyId).device_name, 'kestrel');
  assert.ok(roster.members.every(m=>m.person_name===undefined));
  const presence = await (await member.client(f.circle.id)).fetchPresence();
  const profile = presence.devices.find(d=>d.device===member.keyId).member_profile;
  assert.ok(profile.proof);
  assert.equal(profile.body.profile.person_name, 'Maya Okafor');
  // A forged name cannot replace the cached verified name.
  f.override = (req,res) => {
    if (!req.url.endsWith('/presence')) return false;
    const forged = structuredClone(presence);
    forged.devices.find(d=>d.device===member.keyId).member_profile.body.profile.person_name = 'Impostor';
    res.writeHead(200, {'content-type':'application/json'}); res.end(p.canonicalize(forged));return true;
  };
  assert.equal((await f.owner.memberNames(f.circle.id)).get(member.keyId), 'Maya Okafor');
  f.override = null;
  await member.setOwnerName('Maya Renamed');
  await member.refreshRoster(f.circle.id);
  assert.equal((await f.owner.memberNames(f.circle.id)).get(member.keyId), 'Maya Renamed');
  const latestPresence=await (await member.client(f.circle.id)).fetchPresence();
  const latest=latestPresence.devices.find(d=>d.device===member.keyId).member_profile;
  assert.equal(p.strictParse(p.decodeBase64url(profile.proof)).payload.created,p.strictParse(p.decodeBase64url(latest.proof)).payload.created,'both names were signed within the same second');
  f.override=(req,res)=>{
    if(!req.url.endsWith('/presence'))return false;
    res.writeHead(200,{'content-type':'application/json'});res.end(p.canonicalize(presence));return true;
  };
  assert.equal((await f.owner.memberNames(f.circle.id)).get(member.keyId),'Maya Renamed','an older signed name cannot roll back the cache in the same second');
  f.override=null;
  await (await member.client(f.circle.id)).heartbeat(profile.body);
  assert.equal((await f.owner.memberNames(f.circle.id)).get(member.keyId),'Maya Renamed','a late authenticated older profile cannot roll back host storage');
  f.restart();
  assert.equal((await (await member.client(f.circle.id)).fetchPresence()).devices.find(d=>d.device===member.keyId).online,false);
  const reopened=await f.device('owner');
  f.override=(req,res)=>{
    if(!req.url.endsWith('/presence'))return false;
    res.writeHead(503,{'content-type':'application/problem+json'});res.end(JSON.stringify({code:'unavailable'}));return true;
  };
  assert.equal((await reopened.memberNames(f.circle.id)).get(member.keyId),'Maya Renamed','verified names survive restart and an unavailable host');
  f.override=req=>req.url.endsWith('/presence'); // A host that accepts the connection but never replies.
  assert.equal((await reopened.memberNames(f.circle.id)).get(member.keyId),'Maya Renamed','a stalled host cannot hide cached names');
  f.override=null;
  const restartedMember=await f.device('member');
  await restartedMember.setOwnerName('Maya After Restart');await restartedMember.refreshRoster(f.circle.id);
  assert.equal((await reopened.memberNames(f.circle.id)).get(member.keyId),'Maya After Restart');
  const persisted=(await (await restartedMember.client(f.circle.id)).fetchPresence()).devices.find(d=>d.device===member.keyId).member_profile;
  assert.ok(persisted.body.profile.revision>latest.body.profile.revision,'the signed revision increases across process restarts');
});


test('new host approves a frozen old-client proof and serves an old-readable roster', testOptions, async t => {
  const f=await realCoordinator(t),named=await f.device('named-member');
  await named.setOwnerName('Maya');
  await named.joinCircle((await f.owner.createInviteLinks(f.circle.id)).long,{deviceName:'kestrel'});
  await f.owner.approveEnrollments(f.circle.id);await named.refreshRoster(f.circle.id);
  assert.equal((await f.owner.memberNames(f.circle.id)).get(named.keyId),'Maya');
  const {long:link}=await f.owner.createInviteLinks(f.circle.id);
  const {invite,invite_private_seed}=p.decodeInviteLink(link),key=p.generateDeviceKeyPair().privateKey;
  const publicKey=p.exportPublicKey(key),keyId=p.fingerprint(publicKey),circle=f.circle.id;
  const enrollment_proof=legacyEnrollment.createEnrollmentProof({circle,invite_id:invite.payload.invite_id,device_public_key:publicKey,device_name:'old computer'},p.privateKeyFromSeed(invite_private_seed));
  const body=Buffer.from(p.canonicalize({invite,device_public_key:publicKey,enrollment_proof}));
  const target=f.origin+'/v1/circles/'+circle+'/enrollments';
  const proof=p.buildRequestProof({circle,roster_epoch:0,method:'POST',target,body,content_type:'application/json',artifact_media_type:'',idempotency_key:'old-client',created:f.clock(),nonce:Buffer.alloc(24,8).toString('base64url')},key);
  const response=await fetch(target,{method:'POST',headers:{'content-type':'application/json','Faravan-Proof':proof,'Idempotency-Key':'old-client'},body});
  assert.equal(response.status,202);const enrollment=await response.json();
  await f.owner.approveEnrollments(circle);
  const cache={get:async()=>null,set:async()=>{}};
  const client=createClient({origin:f.origin,circle,deviceKey:key,pinnedRootFingerprint:f.circle.pinnedRootFingerprint,rosterCache:cache});
  const approved=await client.getEnrollment(enrollment.enrollment_id);
  assert.equal(approved.state,'approved');
  assert.ok(approved.roster.payload.members.every(m=>Object.keys(m).every(k=>['key_id','public_key','joined_epoch','device_name','person_id','person_link'].includes(k))));
  const names=await f.owner.memberNames(circle);
  assert.equal(names.has(keyId),false,'missing name remains missing for device-name fallback');
  assert.equal(names.get(named.keyId),'Maya','an older joiner does not remove new members’ names');
});

test('a new member does not send a profile to an old host', testOptions, async t => {
  const f=await realCoordinator(t),circle=f.circle.id,requests=[];
  const member=await f.device('new-member',{fetch:async(url,init)=>{
    requests.push({url,body:init?.body&&JSON.parse(String(init.body))});
    if(url.endsWith('/capabilities'))return Response.json({capabilities:HOST_CAPABILITIES.filter(c=>c!=='member_profile_v1')});
    if(url.endsWith('/enrollments')&&init.method==='POST'){
      const body=JSON.parse(String(init.body));
      assert.equal(legacyEnrollment.verifyEnrollmentProof(body.enrollment_proof,{invitePublicKey:body.invite.payload.invite_public_key,circle,invite_id:body.invite.payload.invite_id,device_public_key:body.device_public_key}).ok,true);
    }
    return f.traced(url,init);
  }});
  await member.setOwnerName('Maya');
  await member.joinCircle((await f.owner.createInviteLinks(circle)).long,{deviceName:'kestrel'});
  await f.owner.approveEnrollments(circle);await member.refreshRoster(circle);
  assert.ok(requests.some(r=>r.url.endsWith('/heartbeat')));
  assert.ok(requests.every(r=>!r.body?.profile));
  const enrollmentIndex=requests.findIndex(r=>r.url.endsWith('/enrollments'));
  assert.equal(requests.slice(0,enrollmentIndex).some(r=>r.url.endsWith('/capabilities')),false);
  assert.equal((await f.owner.memberNames(circle)).has(member.keyId),false);
});

test('profile verification rejects changed names, signatures, members, circles, routes and extra fields',()=>{
  const key=p.generateDeviceKeyPair().privateKey,publicKey=p.exportPublicKey(key),key_id=p.fingerprint(publicKey);
  const origin='https://example.com',body={capabilities:['circle_profile_v1'],profile:{person_name:'Maya',revision:0}};
  const member={key_id,public_key:publicKey,joined_epoch:1},options={circle:UUID,origin,member};
  const make=(body,changes={})=>({body,proof:p.buildRequestProof({circle:UUID,roster_epoch:1,method:'POST',target:origin+'/v1/circles/'+UUID+'/heartbeat',body:Buffer.from(p.canonicalize(body)),content_type:'application/json',artifact_media_type:'',idempotency_key:'profile',created:1,nonce:Buffer.alloc(24,8).toString('base64url'),...changes},key)});
  const valid=make(body);
  assert.equal(verifyMemberProfile(valid,options).name,'Maya');
  for(const change of [
    v=>{v.body.profile.person_name='Forged';},
    v=>{v.proof=v.proof.slice(0,-3)+'AAA';},
    v=>{v.body.profile.extra='closed';}
  ]){const v=structuredClone(valid);change(v);assert.equal(verifyMemberProfile(v,options),null);}
  assert.equal(verifyMemberProfile(valid,{...options,circle:'22222222-2222-4222-8222-222222222222'}),null);
  assert.equal(verifyMemberProfile(valid,{...options,member:{...member,key_id:'sha256:'+'f'.repeat(64)}}),null);
  assert.equal(verifyMemberProfile(make(body,{target:origin+'/v1/circles/'+UUID+'/leave-requests'}),options),null);
  assert.equal(verifyMemberProfile(make({...body,extra:'closed'}),options),null);
  assert.equal(verifyMemberProfile(make({...body,capabilities:['bad-capability']}),options),null);
  assert.equal(verifyMemberProfile(make({...body,profile:{person_name:'Maya',extra:'closed'}}),options),null);
});

test('concurrent profile refreshes retain the newest signed revision', testOptions, async t => {
  const f=await realCoordinator(t),member=await f.device('member'),id=f.circle.id;
  await member.setOwnerName('Name A');
  await member.joinCircle((await f.owner.createInviteLinks(id)).long,{deviceName:'kestrel'});
  await f.owner.approveEnrollments(id);await member.refreshRoster(id);await f.owner.memberNames(id);
  await member.setOwnerName('Name B');await member.refreshRoster(id);
  const older=await (await member.client(id)).fetchPresence();
  await member.setOwnerName('Name C');await member.refreshRoster(id);
  const newer=await (await member.client(id)).fetchPresence();
  let release,arrive,first=true;
  const arrived=new Promise(resolve=>{arrive=resolve;});
  f.override=(req,res)=>{
    if(!req.url.endsWith('/presence'))return false;
    const send=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(p.canonicalize(value));};
    if(first){first=false;release=()=>send(older);arrive();}else send(newer);
    return true;
  };
  const delayed=f.owner.memberNames(id,{signal:AbortSignal.timeout(10000)});
  await arrived;
  assert.equal((await f.owner.memberNames(id)).get(member.keyId),'Name C');
  release();await delayed;
  f.override=(req,res)=>{
    if(!req.url.endsWith('/presence'))return false;
    res.writeHead(503,{'content-type':'application/problem+json'});res.end(JSON.stringify({code:'unavailable'}));return true;
  };
  assert.equal((await f.owner.memberNames(id)).get(member.keyId),'Name C','a delayed older refresh must not replace newer durable cache');
});
