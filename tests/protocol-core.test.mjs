import './helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign, verify, createPublicKey, createPrivateKey, createHash } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';

const read = name => JSON.parse(readFileSync(new URL('../docs/protocol/'+name, import.meta.url)));
const golden = read('vectors/golden.json');
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex')));
const pub = golden.keys.map(k => k.public_key);
const fp = golden.keys.map(k => k.fingerprint);
const obj = Object.fromEntries(Object.entries(golden.objects).map(([k,v])=>[k,v.envelope]));
const circle = obj.job.payload.circle;
const now = obj.request.payload.created;
const clone = x => structuredClone(x);
const failCode = (f, code) => assert.throws(f,e=>e instanceof p.ProtocolError&&e.code===code);
const rosterOptions = () => ({circle,rootFingerprint:fp[2],now:()=>now});
const inviteOptions = () => ({circle,coordinator:'https://coordinator.example',rootFingerprint:fp[2],now:()=>Date.parse('2026-10-09T10:30:00Z')/1000});
const enrollmentOptions = () => ({circle,invite_id:obj.invite.payload.invite_id,device_public_key:pub[1],invitePublicKey:pub[3]});
function requestOptions(overrides={}) {
  const {schema,created,nonce,...expected}=obj.request.payload;
  return {publicKey:pub[0],expected,now:()=>now,consumeNonce:()=>true,...overrides};
}
function rawSign(kind,payload,key=keys[0],prefix='faravan') {
  const bytes=Buffer.concat([Buffer.from(prefix+'/'+kind+'/v1\0'),createHash('sha256').update(p.canonicalize(payload)).digest()]);
  return {payload,signature:{algorithm:'Ed25519',key_id:p.fingerprint(createPublicKey(key)),value:sign(null,bytes,key).toString('base64url')}};
}

test('golden fixed TEST-ONLY keys, fingerprints and every signed byte',()=>{
  assert.match(golden.warning,/TEST-ONLY/);
  golden.keys.forEach((k,i)=>{
    assert.equal(p.exportPublicKey(keys[i]),k.public_key);
    assert.equal(p.exportPublicKey(p.importPublicKey(k.public_key)),k.public_key);
    assert.equal(p.fingerprint(k.public_key),k.fingerprint);
    assert.equal(p.fingerprint(createPublicKey(keys[i])),k.fingerprint);
    assert.equal(p.exportPublicKey(p.privateKeyFromSeed(Buffer.from(k.seed_hex,'hex').toString('base64url'))),k.public_key);
  });
  for(const [kind,v] of Object.entries(golden.objects)) {
    assert.equal(p.canonicalize(v.envelope.payload),v.payload_jcs,kind);
    assert.equal(p.digest(v.envelope.payload),v.digest,kind);
    const made=kind==='enrollment'?p.createEnrollmentProof(v.envelope.payload,keys[v.key_index]):p.signEnvelope(kind,v.envelope.payload,keys[v.key_index]);
    assert.deepEqual(made,v.envelope,kind);assert.equal(p.canonicalize(made),v.envelope_jcs,kind);
    const checked=kind==='enrollment'?p.verifyEnrollmentProof(made,enrollmentOptions()):p.verifyEnvelope(kind,v.envelope,pub[v.key_index]);
    assert.equal(checked.ok,true,kind+':'+checked.code);
    // Independent direct crypto construction checks domain, NUL and binary digest.
    const direct=rawSign(kind,JSON.parse(v.payload_jcs),keys[v.key_index]);
    assert.equal(direct.signature.value,v.envelope.signature.value,kind);
    if(kind!=='enrollment') {
      assert.equal(p.verifyEnvelope(kind,v.envelope_jcs,pub[v.key_index]).ok,true);
      assert.equal(p.verifyEnvelope(kind,Buffer.from(v.envelope_jcs),pub[v.key_index]).ok,true);
    }
  }
  assert.equal(p.canonicalize(golden.receipt.payload),golden.receipt.payload_jcs);
  assert.equal(p.digest(golden.receipt.payload),golden.receipt.digest);
  failCode(()=>p.signEnvelope('receipt',golden.receipt.payload,keys[0]),'unsupported_kind');
  for(const kind of ['job','result','roster','invite']) assert.deepEqual(read('examples/'+kind+'.minimal.json'),obj[kind]);
  assert.deepEqual(read('examples/receipt.minimal.json'),golden.receipt.payload);
});

for(const v of read('vectors/jcs.json')) test('JCS: '+v.label,()=>assert.equal(p.canonicalize(v.input),v.expected));

test('strict UTF-8 parser rejects ambiguity and profile violations',()=>{
  for(const [s,code] of [['{"a":1,"\\u0061":2}','duplicate_key'],['{"a":01}','invalid_json'],['NaN','invalid_json'],['Infinity','invalid_json'],['1e999','invalid_number'],['1.1','invalid_number'],['-0','invalid_number'],['-9007199254740992','invalid_number'],['"\udfff"','invalid_unicode'],['"\ud800"','invalid_unicode'],['{"x":1,}','invalid_json'],['[1,]','invalid_json'],['{"a":1}x','invalid_json'],['\ufeff{}','invalid_json'],[' {"a":1}','noncanonical_json']]) failCode(()=>p.strictParse(s),code);
  failCode(()=>p.strictParse(Buffer.from([0xc0,0xaf])),'invalid_utf8');
  failCode(()=>p.strictParse('"'+ 'a'.repeat(262145) +'"'),'payload_too_large');
  failCode(()=>p.strictParse('['.repeat(18)+'0'+']'.repeat(18)),'depth_exceeded');
  assert.deepEqual(p.strictParse(' { "a" : 1 } ',{canonical:false}),{a:1});
  assert.deepEqual(p.strictParse('{"__proto__":{"safe":true}}'),JSON.parse('{"__proto__":{"safe":true}}'));
  assert.equal({}.safe,undefined);
  assert.equal(p.canonicalize(-0),'0');
  assert.equal(p.canonicalize(1e30),'1e+30');
  for(const x of [undefined,NaN,Infinity,1n,new Date(),()=>0]) assert.throws(()=>p.canonicalize(x),p.ProtocolError);
  const cycle={};cycle.x=cycle;failCode(()=>p.canonicalize(cycle),'invalid_json');
  failCode(()=>p.canonicalize(['a',,]),'invalid_json');
  failCode(()=>p.canonicalize({get x(){throw new Error('must not run')}}),'invalid_json');
  failCode(()=>p.canonicalize({['\ud800']:0}),'invalid_unicode');
  assert.equal(p.digestBytes(Buffer.alloc(0)),'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.notEqual(p.digest(obj.job),p.digest(obj.job.payload));
  assert.equal(new p.ProtocolError('stable').code,'stable');
});

test('key and signature encodings reject noncanonical and invalid curve material',()=>{
  for(const encoded of [pub[0]+'=',pub[0].slice(0,-1)+'x','', '!!!!', 'AA']) assert.throws(()=>p.importPublicKey(encoded),p.ProtocolError);
  assert.deepEqual(p.decodeBase64url('AQID',3),Buffer.from([1,2,3]));
  failCode(()=>p.decodeBase64url('AB',1),'invalid_encoding');
  failCode(()=>p.decodeBase64url('AA',2),'invalid_encoding');
  for(const raw of [Buffer.alloc(32),Buffer.from([1,...Array(31).fill(0)]),Buffer.alloc(32,255)]) failCode(()=>p.importPublicKey(raw.toString('base64url')),'invalid_key');
  failCode(()=>p.privateKeyFromSeed(Buffer.alloc(31)),'invalid_key');
  for(const gen of [p.generateDeviceKeyPair,p.generateRootKeyPair]) {
    const pair=gen();assert.equal(pair.privateKey.asymmetricKeyType,'ed25519');assert.equal(p.exportPublicKey(pair.publicKey),p.exportPublicKey(pair.privateKey));
  }
  for(const malformed of [null,{},[],true,{payload:null,signature:{}},'{}','{"a":1,"a":2}']) {
    const r=p.verifyEnvelope('job',malformed,pub[0]);assert.equal(r.ok,false);assert.equal(typeof r.code,'string');
  }
  const padded=clone(obj.job);padded.signature.value+='=';assert.equal(p.verifyEnvelope('job',padded,pub[0]).code,'invalid_encoding');
  const scalar=clone(obj.job);const bytes=Buffer.from(scalar.signature.value,'base64url');bytes.fill(255,32);scalar.signature.value=bytes.toString('base64url');assert.equal(p.verifyEnvelope('job',scalar,pub[0]).code,'invalid_signature');
  const oldDomain=rawSign('job',obj.job.payload,keys[0],'wrong-product');assert.equal(p.verifyEnvelope('job',oldDomain,pub[0]).code,'invalid_signature');
});

test('roster creation, root/circle pins, temporal boundaries and anti-rollback',()=>{
  const {schema,root_public_key,valid_until,...fields}=obj.roster.payload;
  assert.deepEqual(p.createRoster(fields,keys[2]),obj.roster);
  assert.equal(p.verifyRoster(obj.roster,rosterOptions()).ok,true);
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),rootFingerprint:fp[1]}).code,'root_mismatch');
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),circle:obj.job.payload.intent_id}).code,'wrong_circle');
  const start=Date.parse(fields.issued_at)/1000,end=Date.parse(valid_until)/1000;
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),now:()=>start-60}).ok,true);
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),now:()=>start-61}).code,'clock_skew');
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),now:()=>end-1}).ok,true);
  assert.equal(p.verifyRoster(obj.roster,{...rosterOptions(),now:()=>end}).code,'roster_expired');
  const date=t=>new Date(t*1000).toISOString().replace('.000Z','Z');
  assert.equal(p.createRoster({...fields,valid_until:date(start+30*86400)},keys[2]).payload.valid_until,date(start+30*86400));
  failCode(()=>p.createRoster({...fields,valid_until:date(start+30*86400+1)},keys[2]),'roster_validity');
  failCode(()=>p.createRoster({...fields,valid_until:fields.issued_at},keys[2]),'roster_validity');
  assert.equal(p.checkRosterEpoch(obj.roster.payload,7,p.digest(obj.roster.payload)).ok,true);
  assert.equal(p.checkRosterEpoch(obj.roster.payload,7,'sha256:'+'0'.repeat(64)).code,'roster_stale');
  assert.equal(p.checkRosterEpoch(obj.roster.payload,6).ok,true);
  assert.equal(p.findMember(obj.roster.payload,fp[0]).public_key,pub[0]);
  assert.equal(p.findMember(obj.roster.payload,fp[3]),null);
  const invalid=clone(fields);invalid.members[0].joined_epoch=8;assert.throws(()=>p.createRoster(invalid,keys[2]),p.ProtocolError);
  const duplicate=clone(fields);duplicate.members.push(duplicate.members[0]);assert.throws(()=>p.createRoster(duplicate,keys[2]),p.ProtocolError);
  assert.equal(p.createRoster({...fields,members:[]},keys[2]).payload.members.length,0);
});

test('invite link, context-bound enrollment and expiry',()=>{
  const {schema,root_public_key,root_fingerprint,...input}=obj.invite.payload;
  assert.deepEqual(p.createInvite(input,keys[2]),obj.invite);
  assert.equal(p.verifyInvite(obj.invite,inviteOptions()).ok,true);
  assert.equal(p.verifyInvite(obj.invite,{...inviteOptions(),now:()=>Date.parse(input.expires_at)/1000}).code,'enrollment_expired');
  assert.equal(p.verifyInvite(obj.invite,{...inviteOptions(),rootFingerprint:fp[0]}).code,'root_mismatch');
  assert.equal(p.verifyInvite(obj.invite,{...inviteOptions(),coordinator:'https://other.example'}).code,'wrong_origin');
  assert.equal(p.encodeInviteLink(obj.invite,Buffer.alloc(32,4)),golden.invite_link);
  const decoded=p.decodeInviteLink(golden.invite_link);assert.equal(decoded.ok,true);assert.deepEqual(decoded.invite,obj.invite);
  assert.equal(decoded.invite_private_seed,Buffer.alloc(32,4).toString('base64url'));
  assert.equal(golden.invite_link.split('#')[0],'https://coordinator.example/join');
  assert.equal(JSON.stringify(obj.invite).includes('invite_private_seed'),false);
  failCode(()=>p.encodeInviteLink(obj.invite,Buffer.alloc(32,1)),'key_mismatch');
  for(const link of [golden.invite_link.replace('#','?'),golden.invite_link.replace('/join','/other'),golden.invite_link.replace('coordinator.example','other.example'),golden.invite_link+'=']) assert.equal(p.decodeInviteLink(link).ok,false);
  assert.equal(p.verifyEnrollmentProof(obj.enrollment,enrollmentOptions()).ok,true);
  assert.equal(p.verifyEnrollmentProof(obj.enrollment,{...enrollmentOptions(),invite_id:obj.job.payload.intent_id}).code,'invite_mismatch');
  assert.equal(p.verifyEnrollmentProof(obj.enrollment,{...enrollmentOptions(),invitePublicKey:pub[0]}).code,'key_mismatch');
  for(const badOrigin of ['https://u:p@example.test','https://example.test/path','https://example.test?secret=1','http://localhost','http://192.168.1.1']) assert.throws(()=>p.createInvite({...input,coordinator:badOrigin},keys[2]));
  assert.equal(p.createInvite({...input,coordinator:'http://127.0.0.1:8123'},keys[2]).payload.coordinator,'http://127.0.0.1:8123');
});

test('invite binding and short link: golden bytes, independent construction and attack resistance',()=>{
  const g=golden.invite_binding,seed=Buffer.alloc(32,4).toString('base64url');
  assert.equal(g.domain,'faravan/invite-binding/v1');
  assert.equal(p.digest(obj.invite),g.envelope_digest);
  assert.deepEqual(p.createInviteBinding(obj.invite,keys[g.key_index]),g.binding);
  assert.deepEqual(p.createInviteBinding(obj.invite,seed),g.binding);
  // Independent construction: domain, one NUL, raw digest of the WHOLE envelope (signature included).
  const bytes=Buffer.concat([Buffer.from('faravan/invite-binding/v1\0'),createHash('sha256').update(p.canonicalize(obj.invite)).digest()]);
  assert.equal(sign(null,bytes,keys[3]).toString('base64url'),g.binding.value);
  assert.equal(verify(null,bytes,p.importPublicKey(pub[3]),Buffer.from(g.binding.value,'base64url')),true);
  assert.equal(g.binding.key_id,fp[3]);
  assert.equal(p.verifyInviteBinding(obj.invite,g.binding,{invitePublicKey:pub[3]}).ok,true);
  assert.deepEqual(read('examples/invite-binding.minimal.json'),g.binding);
  assert.deepEqual(read('examples/invite-publication.minimal.json'),{code:golden.short_link.code,envelope:obj.invite,invite_binding:g.binding});
  // Any change to the envelope, key or signature fails closed.
  const moved=clone(obj.invite);moved.payload.owner_name='Mallory';
  assert.equal(p.verifyInviteBinding(moved,g.binding,{invitePublicKey:pub[3]}).ok,false);
  const flipped=clone(g.binding);flipped.value=flipped.value.slice(0,-2)+(flipped.value.endsWith('A')?'B':'A')+flipped.value.slice(-1);
  assert.equal(p.verifyInviteBinding(obj.invite,flipped,{invitePublicKey:pub[3]}).ok,false);
  assert.equal(p.verifyInviteBinding(obj.invite,{...g.binding,extra:1},{invitePublicKey:pub[3]}).ok,false);
  failCode(()=>p.createInviteBinding(obj.invite,keys[0]),'key_mismatch');
  // The coordinator holds no invite key: its best attempt (its own key signing a rewritten envelope) cannot verify under the real one.
  const own=p.createInviteBinding(p.createInvite({...obj.invite.payload,schema:undefined,root_public_key:undefined,root_fingerprint:undefined,invite_public_key:pub[0]},keys[2]),keys[0]);
  assert.equal(p.verifyInviteBinding(obj.invite,own,{invitePublicKey:pub[3]}).ok,false);
  // Short link: exact bytes, fragment-only seed, strict decoding.
  const link=p.encodeShortLink({coordinator:'https://coordinator.example',code:golden.short_link.code,seed});
  assert.equal(link,golden.short_link.link);
  assert.deepEqual(p.decodeShortLink(link),{ok:true,coordinator:'https://coordinator.example',code:golden.short_link.code,seed});
  assert.ok(link.length<100);assert.equal(new URL(link).search,'');assert.equal(link.split('#')[0].includes(seed),false);
  for(const bad of [link.replace('/i/','/j/'),link.replace('#','?'),link+'x',link.replace(golden.short_link.code,'ABCDEFGHIJ'),link.replace(golden.short_link.code,'abc'),link.replace('https://','https://u:p@'),link.replace('https://coordinator.example','http://evil.example')])
    assert.equal(p.decodeShortLink(bad).ok,false,bad);
  // generateInviteCode: 10 base32 characters from 10 random bytes, and nothing else.
  const code=p.generateInviteCode();assert.match(code,p.INVITE_CODE_PATTERN);
  assert.equal(p.generateInviteCode(()=>Buffer.alloc(10,255)),'7'.repeat(10));
  assert.equal(p.generateInviteCode(()=>Buffer.alloc(10)),'a'.repeat(10));
  failCode(()=>p.generateInviteCode(()=>Buffer.alloc(9)),'invalid_random');
  assert.equal(new Set(Array.from({length:200},()=>p.generateInviteCode())).size,200);
  // Resolution: the joiner turns a publication into the long link only after the binding verifies.
  const published={envelope:obj.invite,invite_binding:g.binding};
  const resolved=p.inviteLinkFromPublication(published,{coordinator:'https://coordinator.example',seed});
  assert.equal(resolved.ok,true);assert.equal(resolved.link,golden.invite_link);
  assert.equal(p.inviteLinkFromPublication(published,{coordinator:'https://other.example',seed}).code,'wrong_origin');
  assert.equal(p.inviteLinkFromPublication(published,{coordinator:'https://coordinator.example',seed:Buffer.alloc(32,1).toString('base64url')}).code,'key_mismatch');
});

test('request exact bytes, clock boundaries and atomic nonce callback order',async()=>{
  const {schema,key_id,...input}=obj.request.payload;
  assert.equal(p.buildRequestProof(input,keys[0]),golden.request_header);
  assert.equal(p.buildRequestProof({...input,body:Buffer.from(golden.objects.job.envelope_jcs)},keys[0]),golden.request_header);
  let calls=0;const opts=requestOptions({consumeNonce:(id,nonce,expires)=>{
    assert.equal(id,fp[0]);assert.equal(nonce,input.nonce);assert.equal(expires,now+361);return ++calls===1;
  }});
  assert.equal((await p.verifyRequestProof(golden.request_header,opts)).ok,true);
  assert.equal((await p.verifyRequestProof(golden.request_header,opts)).code,'replay');
  for(const delta of [-60,300]) assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({now:()=>now+delta}))).ok,true);
  let touched=false;
  const bad=requestOptions({expected:{...requestOptions().expected,content_length:0},consumeNonce:()=>{touched=true;return true;}});
  assert.equal((await p.verifyRequestProof(golden.request_header,bad)).code,'request_mismatch');assert.equal(touched,false);
  for(const field of Object.keys(requestOptions().expected)) {
    const expected={...requestOptions().expected,[field]:typeof requestOptions().expected[field]==='number'?999:'different'};
    assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({expected}))).code,'request_mismatch',field);
  }
  assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({consumeNonce:()=>{throw Error('store offline');}}))).code,'nonce_store_failure');
  assert.equal((await p.verifyRequestProof('?',requestOptions())).ok,false);
  for(const url of ['https://coordinator.example/a/../b','https://coordinator.example/%2e/b','https://coordinator.example/a%2fb','https://coordinator.example/x?a=1&a=2','https://coordinator.example/x#secret']) assert.throws(()=>p.buildRequestProof({...input,target:url},keys[0]),p.ProtocolError);
  const get={...input,method:'GET',body:Buffer.alloc(0),content_type:'',idempotency_key:''};
  const getHeader=p.buildRequestProof(get,keys[0]);assert.equal(p.strictParse(Buffer.from(getHeader,'base64url')).payload.content_length,0);
  const put={...input,method:'PUT',body_digest:'sha256:'+'0'.repeat(64),content_length:1073741824,content_type:'application/octet-stream',artifact_media_type:'application/gzip',idempotency_key:''};
  assert.equal(p.strictParse(Buffer.from(p.buildRequestProof(put,keys[0]),'base64url')).payload.content_length,1073741824);
  failCode(()=>p.buildRequestProof({...input,body:Buffer.from(' { } ')},keys[0]),'noncanonical_json');
});

test('synchronous request proof shares validation and rejects asynchronous nonce callbacks',async()=>{
  let calls=0;
  const options=requestOptions({consumeNonce:(id,nonce,expiry)=>{
    assert.equal(id,fp[0]);assert.equal(nonce,obj.request.payload.nonce);
    assert.equal(expiry,now+361);return ++calls===1;
  }});
  const accepted=p.verifyRequestProofSync(golden.request_header,options);
  assert.equal(accepted.ok,true);assert.equal(accepted.then,undefined);
  assert.deepEqual(accepted,await p.verifyRequestProof(golden.request_header,requestOptions()));
  assert.equal(p.verifyRequestProofSync(golden.request_header,options).code,'replay');
  for(const delta of [-61,-60,300,301]) {
    const opts=requestOptions({now:()=>now+delta});
    assert.deepEqual(p.verifyRequestProofSync(golden.request_header,opts),await p.verifyRequestProof(golden.request_header,opts));
  }
  for(const field of Object.keys(requestOptions().expected)) {
    const expected={...requestOptions().expected,[field]:typeof requestOptions().expected[field]==='number'?999:'different'};
    const opts=requestOptions({expected,consumeNonce:()=>{throw Error('validation must precede nonce');}});
    assert.equal(p.verifyRequestProofSync(golden.request_header,opts).code,'request_mismatch',field);
  }
  let touched=false;
  assert.equal(p.verifyRequestProofSync('?',requestOptions({consumeNonce:()=>{touched=true;return true;}})).ok,false);
  assert.equal(touched,false);
  for(const consumeNonce of [()=>Promise.resolve(true),()=>({then(){throw Error('must not await');}}),()=>{throw Error('offline');}]) {
    assert.equal(p.verifyRequestProofSync(golden.request_header,requestOptions({consumeNonce})).code,'nonce_store_failure');
  }
  for(const value of [false,undefined,null,1,'true',{}]) {
    assert.equal(p.verifyRequestProofSync(golden.request_header,requestOptions({consumeNonce:()=>value})).code,'replay');
  }
  assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({consumeNonce:async()=>true}))).ok,true);
  assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({consumeNonce:async()=>false}))).code,'replay');
  assert.equal((await p.verifyRequestProof(golden.request_header,requestOptions({consumeNonce:async()=>{throw Error('offline');}}))).code,'nonce_store_failure');
});

test('identity predicates bind independently retained job and attempt',()=>{
  assert.equal(p.checkAuthor(obj.job.payload,fp[0]).ok,true);
  assert.equal(p.checkExecutor(obj.result.payload,fp[1],{holder:fp[1]}).ok,true);
  assert.equal(p.checkCircle(obj.job.payload,circle).ok,true);
  assert.equal(p.checkJobDigest(obj.result.payload,golden.objects.job.digest).ok,true);
  const attempt={attempt_id:obj.result.payload.attempt_id,generation:1};
  assert.equal(p.checkAttempt(obj.result.payload,attempt).ok,true);
  assert.equal(p.checkAttempt(obj.result.payload,{...attempt,generation:2}).code,'stale_attempt');
  assert.equal(p.checkAuthor(null,fp[0]).ok,false);
  assert.equal(p.checkExecutor({},undefined,{}).ok,false);
});

test('requirements fail closed, OR alternatives, AND capabilities and every ceiling',()=>{
  const req=obj.job.payload.requirements;
  const lender={harnesses:['codex'],models:['example-model'],capabilities:['patch-output','run_request_v1'],egress:['provider-only'],enforced_limits:Object.keys(req.limits),max_limits:{...req.limits}};
  assert.equal(p.validateRequirements(req).ok,true);assert.deepEqual(p.canSatisfy(req,lender),{ok:true,unmet:[]});
  for(const bad of [{...req,mounts:['/']},{...req,capabilities:['unknown']},{...req,egress:'host'},{...req,limits:{...req.limits,network:1}},{...req,limits:{...req.limits,cpu:0}},{...req,harness:[]},{...req,model:{any_of:[]}}]) assert.equal(p.validateRequirements(bad).ok,false);
  const choice={...req,harness:['not-present','codex']};
  assert.equal(p.canSatisfy(choice,lender).ok,true);
  assert.equal(p.canSatisfy(req,{...lender,harnesses:['not-present']}).unmet.includes('harness'),true);
  assert.equal(p.canSatisfy(req,{...lender,capabilities:[]}).unmet.includes('capability:patch-output'),true);
  assert.equal(p.canSatisfy(req,{...lender,egress:['internet']}).unmet.includes('egress'),true);
  for(const limit of Object.keys(req.limits)) assert.equal(p.canSatisfy(req,{...lender,enforced_limits:lender.enforced_limits.filter(x=>x!==limit)}).unmet.includes('limit:'+limit),true);
  assert.equal(p.canSatisfy(req,{...lender,max_limits:{...lender.max_limits,cpu:1}}).unmet.includes('limit:cpu'),true);
  const noModel=clone(req);delete noModel.model;assert.equal(p.canSatisfy(noModel,{...lender,models:[]}).ok,true);
  assert.equal(p.validateRequirements({...req,capabilities:['local-contract']},{recognizedCapabilities:['local-contract']}).ok,true);
});

for(const v of read('vectors/negative.json')) test('negative golden: '+v.name,async()=>{
  let result;
  switch(v.operation) {
    case 'wrong-domain': result=p.verifyEnvelope('job',rawSign('result',obj.job.payload),pub[0]);break;
    case 'tamper': {const x=clone(obj.job);x.payload.max_attempts=2;result=p.verifyEnvelope('job',x,pub[0]);break;}
    case 'wrong-key':result=p.verifyEnvelope('job',obj.job,pub[1]);break;
    case 'roster-expired':result=p.verifyRoster(obj.roster,{...rosterOptions(),now:()=>Date.parse(obj.roster.payload.valid_until)/1000});break;
    case 'roster-rollback':result=p.checkRosterEpoch(obj.roster.payload,8);break;
    case 'author':result=p.checkAuthor(obj.job.payload,fp[1]);break;
    case 'executor':result=p.checkExecutor(obj.result.payload,fp[1],{holder:fp[0]});break;
    case 'circle':result=p.checkCircle(obj.job.payload,obj.job.payload.intent_id);break;
    case 'job-digest':result=p.checkJobDigest(obj.result.payload,'sha256:'+'0'.repeat(64));break;
    case 'replay':result=await p.verifyRequestProof(golden.request_header,requestOptions({consumeNonce:()=>false}));break;
    case 'clock-old':result=await p.verifyRequestProof(golden.request_header,requestOptions({now:()=>now+301}));break;
    case 'clock-future':result=await p.verifyRequestProof(golden.request_header,requestOptions({now:()=>now-61}));break;
    case 'enrollment-device':result=p.verifyEnrollmentProof(obj.enrollment,{...enrollmentOptions(),device_public_key:pub[0]});break;
    case 'binding-forged-root': {
      // The coordinator's own invite: another root, the real invite_public_key, the owner's real binding.
      const {schema,root_public_key,root_fingerprint,...fields}=obj.invite.payload;
      const forged=p.createInvite(fields,keys[1]);
      result=p.verifyInviteBinding(forged,golden.invite_binding.binding,{invitePublicKey:pub[3]});break;
    }
    case 'binding-wrong-seed':result=p.verifyInviteBinding(obj.invite,golden.invite_binding.binding,{invitePublicKey:pub[0]});break;
    case 'binding-wrong-domain': {
      const bytes=Buffer.concat([Buffer.from('faravan/enrollment/v1\0'),createHash('sha256').update(p.canonicalize(obj.invite)).digest()]);
      const wrong={...golden.invite_binding.binding,value:sign(null,bytes,keys[3]).toString('base64url')};
      result=p.verifyInviteBinding(obj.invite,wrong,{invitePublicKey:pub[3]});break;
    }
    case 'short-link':result=p.decodeShortLink(v.input);break;
    case 'parse':failCode(()=>p.strictParse(v.input),v.expected_code);return;
    default:assert.fail('Unimplemented negative vector '+v.operation);
  }
  assert.equal(result.ok,false);assert.equal(result.code,v.expected_code);
});

test('semantic schema and profile failures do not authorize signed attacker payloads',()=>{
  const variants=[
    x=>{x.extra=true;},x=>{x.created_at='2026-02-30T12:00:00Z';},x=>{x.expires_at=x.created_at;},
    x=>{x.max_attempts=1.5;},x=>{x.roster_epoch=-0;},x=>{x.circle=x.circle.toUpperCase().replace('1','A');},
    x=>{x.requirements.privilege=true;},x=>{x.prompt.media_type='application/gzip';}
  ];
  for(const change of variants){const x=clone(obj.job.payload);change(x);assert.equal(p.verifyEnvelope('job',rawSign('job',x),pub[0]).ok,false);}
  const bad=clone(obj.result.payload);bad.receipt.finished_at='2026-10-09T11:00:00Z';assert.equal(p.verifyEnvelope('result',rawSign('result',bad,keys[1]),pub[1]).ok,false);
});

test('RFC8032 Ed25519 primitive known-answer test, independent of protocol wrappers',()=>{
  // RFC8032 section 7.1 TEST 1, public specification material, never real keys.
  const seed=Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex');
  const publicHex='d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const expected='e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f'
    +'b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
  const key=p.privateKeyFromSeed(seed);
  assert.equal(Buffer.from(p.exportPublicKey(key),'base64url').toString('hex'),publicHex);
  assert.equal(sign(null,Buffer.alloc(0),key).toString('hex'),expected);
  assert.equal(verify(null,Buffer.alloc(0),p.importPublicKey(Buffer.from(publicHex,'hex').toString('base64url')),Buffer.from(expected,'hex')),true);
});

test('static schema vocabulary cannot silently expand beyond the bounded validator',()=>{
  // readOnly/deprecated are annotations; new-mode payload validation enforces historical-only fields.
  const allowed=new Set(['$id','$schema','$defs','title','description','readOnly','deprecated','type','additionalProperties','properties','required','$ref','const','enum','oneOf','minimum','maximum','minLength','maxLength','pattern','format','items','minItems','maxItems','uniqueItems','minProperties','maxProperties']);
  function inspect(schema) {
    for(const name of Object.keys(schema)) assert.equal(allowed.has(name),true,'Unsupported runtime schema keyword: '+name);
    for(const group of ['properties','$defs']) for(const child of Object.values(schema[group]??{})) inspect(child);
    if(schema.items)inspect(schema.items);
    for(const child of schema.oneOf??[])inspect(child);
  }
  for(const name of ['job','result','receipt','roster','invite'])inspect(read(name+'.schema.json'));
});

test('every inline signed worked example verifies and enrollment never carries its seed',()=>{
  const spec=readFileSync(new URL('../docs/protocol/v1.md',import.meta.url),'utf8');
  let count=0;
  function inspect(v) {
    if(!v||typeof v!=='object')return;
    assert.equal(Object.hasOwn(v,'enrollment_secret'),false);
    assert.equal(Object.hasOwn(v,'invite_private_seed'),false);
    if(v.payload?.schema?.startsWith('faravan.')&&v.signature) {
      const kind=v.payload.schema.split('.')[1];
      const key=golden.keys.find(k=>k.fingerprint===v.signature.key_id);
      assert.ok(key);assert.equal(p.verifyEnvelope(kind,v,key.public_key).ok,true);count++;
    }
    if(v.enrollment_proof)assert.equal(p.verifyEnrollmentProof(v.enrollment_proof,enrollmentOptions()).ok,true);
    for(const child of Object.values(v))inspect(child);
  }
  for(const match of spec.matchAll(/```json\n([\s\S]*?)\n```/g))inspect(JSON.parse(match[1]));
  assert.ok(count>=7);
});

test('request/schema sizes and missing metadata fail closed before consuming nonces',async()=>{
  const {schema,key_id,...fields}=obj.request.payload;
  failCode(()=>p.buildRequestProof({...fields,content_type:'a'.repeat(257)},keys[0]),'invalid_request');
  failCode(()=>p.buildRequestProof({...fields,target:'https://coordinator.example/'+'a'.repeat(4096)},keys[0]),'invalid_request');
  const missing=requestOptions();delete missing.expected.key_id;
  assert.equal((await p.verifyRequestProof(golden.request_header,missing)).ok,false);
  const payload=clone(obj.enrollment);payload.signature.value+='=';
  assert.equal(p.verifyEnrollmentProof(payload,enrollmentOptions()).code,'invalid_encoding');
  assert.equal(p.canSatisfy(obj.job.payload.requirements,null).unmet[0],'lenderCapabilities');
  assert.equal(p.validateRequirements({...obj.job.payload.requirements,privilege:true}).code,'unsupported_version');
});

test('limit modes preserve legacy fail-closed jobs and permit only explicit preferred gaps',()=>{
  const req=clone(obj.job.payload.requirements);
  const lender={harnesses:req.harness??[],models:req.model?.any_of??[],capabilities:req.capabilities,
    egress:[req.egress],enforced_limits:Object.keys(req.limits).filter(k=>k!=='disk_bytes'),max_limits:{...req.limits}};
  assert.deepEqual(p.canSatisfy(req,lender).unmet,['limit:disk_bytes']);
  req.limit_modes={disk_bytes:'preferred'};
  assert.deepEqual(p.canSatisfy(req,lender),{ok:true,unmet:[],preferred_unmet:['limit:disk_bytes']});
  assert.deepEqual(p.limitRequirements(req).preferred,['disk_bytes']);
  lender.enforced_limits=lender.enforced_limits.filter(k=>k!=='cpu');
  assert.deepEqual(p.canSatisfy(req,lender).unmet,['limit:cpu']);
  req.limit_modes={disk_bytes:'required'};
  assert.ok(p.canSatisfy(req,lender).unmet.includes('limit:disk_bytes'));
  for(const modes of [{disk_bytes:'best-effort'},{storage:'preferred'},null,[],{cpu:true}])
    assert.equal(p.validateRequirements({...req,limit_modes:modes}).ok,false);
  req.limit_modes={disk_bytes:'preferred'};
  lender.enforced_limits=Object.keys(req.limits);
  lender.max_limits.disk_bytes=req.limits.disk_bytes-1;
  assert.equal(p.canSatisfy(req,lender).ok,true);
  assert.deepEqual(p.canSatisfy(req,lender).preferred_unmet,['limit:disk_bytes']);
  const job=clone(obj.job.payload);job.requirements=req;
  const signed=p.signEnvelope('job',job,keys[0]);
  assert.equal(p.verifyEnvelope('job',signed,pub[0]).ok,true);
  signed.payload.requirements.limit_modes.disk_bytes='required';
  assert.equal(p.verifyEnvelope('job',signed,pub[0]).code,'invalid_signature');
  assert.equal(p.validateRequirements(read('examples/requirements.preferred.json')).ok,true);
});


test('LAN transport is explicit, narrow, canonical, and signed',()=>{
  const allowed=['http://10.2.3.4:9000','http://172.16.0.1','http://192.168.1.2','http://169.254.2.3','http://[fe80::1]','http://lender.local'];
  for(const value of allowed) {
    assert.equal(p.validateOrigin(value).ok,false,value);
    assert.equal(p.validateOrigin(value,{lanMode:true}).ok,true,value);
  }
  for(const value of ['http://8.8.8.8','http://172.32.0.1','http://0.0.0.0','http://localhost','http://[fd00::1]','http://host.local.evil','http://-bad.local','http://192.168.01.2','http://10.1.1.1/','http://user@10.1.1.1','http://10.1.1.1?x']) {
    assert.equal(p.validateOrigin(value,{lanMode:true}).ok,false,value);
  }
  assert.equal(p.validateOrigin('https://public.example').ok,true);
  assert.equal(p.validateOrigin('http://127.0.0.1:9999').ok,true);
  const payload={...obj.invite.payload,coordinator:allowed[0],lan_mode:true,display_name:'Friends circle'};
  const invite=p.signEnvelope('invite',payload,keys[2]);
  const opts={...inviteOptions(),coordinator:payload.coordinator,lanMode:true};
  assert.equal(p.verifyInvite(invite,opts).ok,true);
  assert.equal(p.verifyInvite(invite,{...opts,lanMode:false}).ok,false);
  const tampered=clone(invite);tampered.payload.display_name='Someone else';
  assert.equal(p.verifyInvite(tampered,opts).ok,false);
  const link=p.encodeInviteLink(invite,Buffer.from(golden.keys[3].seed_hex,'hex'));
  assert.equal(p.decodeInviteLink(link).invite.payload.display_name,'Friends circle');
  const noMode={...payload};delete noMode.lan_mode;
  assert.throws(()=>p.signEnvelope('invite',noMode,keys[2]));
});

test('LAN request proof requires matching provisioned mode before consuming nonce',()=>{
  const payload={...obj.request.payload,target:'http://192.168.1.2/v1/circles/'+circle+'/jobs'};
  const header=p.buildRequestProof(payload,keys[0],{lanMode:true});
  const {schema,created,nonce,...expected}=payload;
  let consumed=0;
  const options={publicKey:pub[0],expected,now:()=>now,consumeNonce:()=>{consumed++;return true;}};
  assert.equal(p.verifyRequestProofSync(header,options).ok,false);
  assert.equal(consumed,0);
  assert.equal(p.verifyRequestProofSync(header,{...options,lanMode:true}).ok,true);
  assert.equal(consumed,1);
  assert.throws(()=>p.buildRequestProof({...payload,target:'http://public.example/jobs'},keys[0],{lanMode:true}));
});


test('advertisement lists enforce bounds, uniqueness and closed authority vocabularies',()=>{
  const req=clone(obj.job.payload.requirements);
  const lender={harnesses:['codex'],models:['example-model'],capabilities:['patch-output','run_request_v1'],
    egress:['provider-only'],enforced_limits:Object.keys(req.limits),max_limits:{...req.limits}};
  const invalid=[];
  for(const name of ['harnesses','models','capabilities']) {
    for(const items of [[''],['😀'.repeat(4097)],Array.from({length:129},(_,i)=>'item-'+i),['duplicate','duplicate']])
      invalid.push({[name]:items});
  }
  invalid.push({harnesses:[]},{egress:[]},{egress:['provider-only','unknown']},
    {egress:['provider-only','provider-only']},{enforced_limits:[...lender.enforced_limits,'unknown']},
    {enforced_limits:[...lender.enforced_limits,'cpu']});
  for(const change of invalid) {
    const checked=p.canSatisfy(req,{...lender,...change});
    assert.equal(checked.ok,false,JSON.stringify(change));
    assert.deepEqual(checked.unmet,['lenderCapabilities']);
  }
  assert.equal(p.canSatisfy(req,{...lender,models:[...lender.models,'😀'.repeat(4096)]}).ok,true);
  assert.equal(p.canSatisfy(req,{...lender,capabilities:[...lender.capabilities,...Array.from({length:126},(_,i)=>'cap-'+i)]}).ok,true);
  const preferred={...req,limit_modes:Object.fromEntries(Object.keys(req.limits).map(k=>[k,'preferred']))};
  assert.equal(p.canSatisfy(preferred,{...lender,enforced_limits:[]}).ok,true);
});

test('cancellation reasons count Unicode code points at the 4096 boundary',()=>{
  const payload={schema:'faravan.cancellation.v1',circle,job_digest:p.digest(obj.job.payload),
    author:fp[0],roster_epoch:obj.job.payload.roster_epoch,created_at:obj.job.payload.created_at,reason:'😀'.repeat(4096)};
  const signed=p.signEnvelope('cancellation',payload,keys[0]);
  assert.equal(p.verifyEnvelope('cancellation',signed,pub[0]).ok,true);
  for(const reason of ['', '😀'.repeat(4097)])
    assert.equal(p.verifyEnvelope('cancellation',rawSign('cancellation',{...payload,reason}),pub[0]).ok,false);
});

test('unsupported object schema literals and job authority fields retain unsupported_version',()=>{
  for(const [kind,key] of [['job',0],['result',1],['roster',2],['invite',2]]) {
    const payload={...clone(obj[kind].payload),schema:'faravan.'+kind+'.v2'};
    assert.equal(p.verifyEnvelope(kind,rawSign(kind,payload,keys[key]),pub[key]).code,'unsupported_version',kind);
    failCode(()=>p.signEnvelope(kind,payload,keys[key]),'unsupported_version');
  }
  const receipt=clone(obj.result.payload);receipt.receipt.schema='faravan.receipt.v2';
  assert.equal(p.verifyEnvelope('result',rawSign('result',receipt,keys[1]),pub[1]).code,'unsupported_version');
  for(const change of [
    {mounts:['/']}, {limits:{...obj.job.payload.requirements.limits,network:1}},
    {capabilities:['unknown']},
  ]) {
    const payload={...clone(obj.job.payload),requirements:{...obj.job.payload.requirements,...change}};
    assert.equal(p.verifyEnvelope('job',rawSign('job',payload),pub[0]).code,'unsupported_version');
  }
});

test('explicit effort matches one configured tuple while legacy callers stay compatible',()=>{
  const req=clone(obj.job.payload.requirements),cap='model_effort_pairs_v1';
  const ad={harnesses:['codex','other'],models:['example-model','other-model'],
    capabilities:[...req.capabilities,cap],egress:[req.egress],
    enforced_limits:Object.keys(req.limits),max_limits:{...req.limits},
    model_efforts:[{harness:'codex',model:'example-model',effort:'low'},
      {harness:'other',model:'other-model',effort:'high'}]};
  const job={requirements:req,budget_v1:{effort:'low'}};
  assert.equal(p.canSatisfy(req,ad,{job}).ok,true);
  for(const effort of ['high','unknown',null,1,undefined])
    assert.equal(p.canSatisfy(req,ad,{job:{...job,budget_v1:{effort}}}).ok,false);
  const legacy={...ad};delete legacy.model_efforts;
  assert.deepEqual(p.canSatisfy(req,legacy),{ok:true,unmet:[]});
  assert.equal(p.canSatisfy(req,legacy,{job}).ok,false);
  assert.equal(p.canSatisfy(req,legacy,{job:{requirements:req}}).ok,true);
  assert.equal(p.canSatisfy(req,{...ad,capabilities:req.capabilities},{job}).ok,false);
  assert.equal(p.canSatisfy(req,ad,{job:{...job,requirements:{...req,egress:'internet'}}}).ok,false);
  for(const model_efforts of [null,{},[{model:'example-model',effort:'low'}],
    [{harness:'codex',model:'missing',effort:'low'}],
    [{harness:'codex',model:'example-model',effort:'unknown'}],
    [{...ad.model_efforts[0],extra:true}],
    [ad.model_efforts[0],ad.model_efforts[0]],Array(129).fill(ad.model_efforts[0])]) {
    assert.deepEqual(p.canSatisfy(req,{...ad,model_efforts},{job}).unmet,['lenderCapabilities']);
  }
  // Both tuples exist, but neither meets this harness/model combination.
  const crossed={...req,harness:['codex'],model:{any_of:['other-model']}};
  assert.equal(p.canSatisfy(crossed,ad,{job:{requirements:crossed,budget_v1:{effort:'high'}}}).ok,false);
  const hb={models:['example-model'],harnesses:['codex'],harness:'codex',maxModelLength:80};
  assert.equal(p.validateModelEffortPairs([{model:'example-model',effort:'low'}],hb).ok,true);
  assert.equal(p.validateModelEffortPairs([{model:'example-model',effort:'low',harness:'other'}],hb).ok,false);
});
