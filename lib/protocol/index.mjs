import { MODEL_EFFORT_PAIRS_CAPABILITY, AUTO_RUN_CAPABILITY, RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY } from '../v1/versions.mjs';
import { validateRunRequest, validateAccountAdvertisement, resolveSelection } from '../v1/run-request.mjs';
import { CHECK_SKIPPED } from './verification.mjs';
import {chainVerify} from './circle-authority.mjs';
export * from './circle-authority.mjs';
import {verifyPeople,verifyGovernanceTransition} from './people.mjs';
export {CIRCLE_ROLES,personIdFor,rosterPeople,circleWorkAllowed} from './people.mjs';
import {validateWorkingDirectory} from '../working-directory.mjs';
import { sign, verify, createPublicKey, createHash, randomBytes } from 'node:crypto';
import jobSchema from '../../docs/protocol/job.schema.json' with { type: 'json' };
import resultSchema from '../../docs/protocol/result.schema.json' with { type: 'json' };
import receiptSchema from '../../docs/protocol/receipt.schema.json' with { type: 'json' };
import rosterSchema from '../../docs/protocol/roster.schema.json' with { type: 'json' };
import inviteSchema from '../../docs/protocol/invite.schema.json' with { type: 'json' };
import { ProtocolError, fail, guard, need, object, canonicalize, strictParse, digest, digestBytes,
  decodeBase64url, importPublicKey, exportPublicKey, privateKeyFromSeed, fingerprint } from './encoding.mjs';
export { ProtocolError, canonicalize, strictParse, digest, digestBytes, decodeBase64url,
  importPublicKey, exportPublicKey, privateKeyFromSeed, fingerprint,
  generateDeviceKeyPair, generateRootKeyPair } from './encoding.mjs';

const schemas = { 'job.schema.json': jobSchema, 'result.schema.json': resultSchema,
  'receipt.schema.json': receiptSchema, 'roster.schema.json': rosterSchema, 'invite.schema.json': inviteSchema };
const kinds = ['job', 'result', 'roster', 'invite', 'cancellation', 'request', 'leave', 'person-link'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const checkUUID = x => need(typeof x === 'string' && uuidPattern.test(x));
const checkDigest = x => need(typeof x === 'string' && digestPattern.test(x));
const integer = (n, min=0, max=Number.MAX_SAFE_INTEGER) => need(Number.isSafeInteger(n) && !Object.is(n,-0) && n>=min && n<=max, 'invalid_number');
function timestamp(s) {
  need(typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s));
  const ms=Date.parse(s); need(Number.isFinite(ms) && new Date(ms).toISOString()===s.slice(0,-1)+'.000Z');
  return ms/1000;
}
function instant(n) { integer(n); return new Date(n*1000).toISOString().replace('.000Z','Z'); }
function profile(value) { strictParse(canonicalize(value)); walk(value); }
function walk(v) {
  if (typeof v === 'number') integer(v,-Number.MAX_SAFE_INTEGER);
  if (v && typeof v === 'object') for(const x of Object.values(v)) walk(x);
}
function origin(value,{lanMode=false}={}) {
  need(typeof value === 'string' && value.length<=4096);
  const u=new URL(value);
  need(value===u.origin && !u.username && !u.password && (u.protocol==='https:' ||
    (u.protocol==='http:' && (['127.0.0.1','[::1]'].includes(u.hostname) || lanMode===true&&lanHost(u.hostname)))));
  return value;
}
function lanHost(host) {
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(host)) return true;
  if (/^\[fe[89ab][0-9a-f]:[0-9a-f:]+\]$/.test(host)) return true;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const [a,b,...rest]=host.split('.').map(Number);
  return [a,b,...rest].every(n=>n<=255) && (a===10 || a===172&&b>=16&&b<=31 || a===192&&b===168 || a===169&&b===254);
}
export const LAN_WARNING='This circle uses your local network without encryption; people on the same network could read uploaded code.';
export function validateOrigin(value,options={}) { return guard(()=>({ok:true,origin:origin(value,options)})); }
// Deliberately bounded interpreter for this repository's static schema keyword subset.
// Cryptographic, temporal and authority checks are separate from structural validation.
function schemaValidate(v, schema, root=schema) {
  if(schema.$ref) {
    const [file, pointer] = schema.$ref.split('#'); const doc=file?schemas[file]:root;
    need(doc); let target=doc;
    if(pointer) for(const part of pointer.slice(1).split('/')) target=target[part.replace(/~1/g,'/').replace(/~0/g,'~')];
    return schemaValidate(v,target,doc);
  }
  if(schema.oneOf) { need(schema.oneOf.filter(s=>guard(()=>{schemaValidate(v,s,root);return {ok:true};}).ok).length===1); return; }
  if(Object.hasOwn(schema,'const')) need(v===schema.const,
    typeof schema.const==='string'&&schema.const.startsWith('faravan.')?'unsupported_version':'invalid_request');
  if(schema.enum) need(schema.enum.includes(v));
  if(schema.type) {
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    need(types.some(t=> t==='null'?v===null:t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):t==='integer'?Number.isSafeInteger(v)&&!Object.is(v,-0):typeof v===t));
  }
  if(typeof v==='number') { if(schema.minimum!==undefined) need(v>=schema.minimum); if(schema.maximum!==undefined) need(v<=schema.maximum); }
  if(typeof v==='string') {
    if(schema.minLength!==undefined) need([...v].length>=schema.minLength);
    if(schema.maxLength!==undefined) need([...v].length<=schema.maxLength);
    if(schema.pattern) need(new RegExp(schema.pattern).test(v));
    if(schema.format==='uuid') checkUUID(v);
    if(schema.format==='date-time') timestamp(v);
    if(schema.format==='uri') { const u=new URL(v); need(Boolean(u.protocol)); }
  }
  if(Array.isArray(v)) {
    if(schema.minItems!==undefined) need(v.length>=schema.minItems);
    if(schema.maxItems!==undefined) need(v.length<=schema.maxItems);
    if(schema.uniqueItems) need(new Set(v.map(canonicalize)).size===v.length);
    if(schema.items) for(const item of v) schemaValidate(item,schema.items,root);
  } else if(v&&typeof v==='object') {
    const keys=Object.keys(v), properties=schema.properties??{};
    if(schema.minProperties!==undefined) need(keys.length>=schema.minProperties);
    if(schema.maxProperties!==undefined) need(keys.length<=schema.maxProperties);
    for(const key of schema.required??[]) need(Object.hasOwn(v,key));
    for(const key of keys) {
      if(Object.hasOwn(properties,key)) schemaValidate(v[key],properties[key],root);
      else if(schema.additionalProperties===false) need(false);
      else if(schema.additionalProperties && typeof schema.additionalProperties==='object') schemaValidate(v[key],schema.additionalProperties,root);
    }
  }
}
// Capabilities this validator understands. An unknown one fails as unsupported_version
// before the schema runs, which is how older devices refuse newer jobs.
const RECOGNIZED_CAPABILITIES=Object.freeze([MODEL_EFFORT_PAIRS_CAPABILITY,'patch-output','verify_v1','results_v1','parent_link_v1','working_directory_v1','source_manifest_v1','source_project_name_v1','filtered_git_v1','budget_v1',AUTO_RUN_CAPABILITY,RUN_REQUEST_CAPABILITY,DESIGNATED_MEMBER_CAPABILITY]);
function source(v) {
  if(v.kind==='none') return;
  if(v.kind==='git') { const u=new URL(v.url); need(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash); need(v.commit.length===(v.object_format==='sha1'?40:64)); }
  else need(v.artifact.media_type==='application/gzip');
}
function requirements(v, recognized=RECOGNIZED_CAPABILITIES) {
  if(v && typeof v==='object') {
    need(Object.keys(v).every(k=>['harness','model','capabilities','egress','limits','limit_modes','network','registries'].includes(k)), 'unsupported_version');
    if(v.limits && typeof v.limits==='object') need(Object.keys(v.limits).every(k=>Object.hasOwn(jobSchema.$defs.limits.properties,k)), 'unsupported_version');
  }
  schemaValidate(v,jobSchema.$defs.requirements,jobSchema);
  if(v.network!==undefined) need(v.egress===(v.network==='internet'?'internet':'provider-only'));
  if(v.registries!==undefined) need(v.network==='provider+registries');
  if(v.network==='provider+registries') need(v.registries?.length>0);
  need(v.capabilities.every(x=>recognized.includes(x)), 'unsupported_version');
}
function requestPayload(p) {
  object(p,['schema','circle','key_id','roster_epoch','method','target','body_digest','content_length','content_type','artifact_media_type','idempotency_key','created','nonce'],['lan_mode']);
  if(p.lan_mode!==undefined) need(p.lan_mode===true);
  need(p.schema==='faravan.request.v1','unsupported_version'); checkUUID(p.circle); checkDigest(p.key_id); integer(p.roster_epoch); integer(p.created);
  need(['GET','HEAD','POST','PUT'].includes(p.method)); checkDigest(p.body_digest); integer(p.content_length,0,1073741824);
  for(const name of ['content_type','artifact_media_type']) need(typeof p[name]==='string' && p[name].length<=256);
  need(typeof p.idempotency_key==='string'&&p.idempotency_key.length<=128);
  need(typeof p.nonce==='string'&&p.nonce.length>=22&&p.nonce.length<=86); const nonce=decodeBase64url(p.nonce); need(nonce.length>=16&&nonce.length<=64);
  target(p.target,{lanMode:p.lan_mode===true});
  if(p.method==='GET'||p.method==='HEAD') need(p.content_length===0&&p.body_digest===digestBytes(Buffer.alloc(0))&&p.content_type===''&&p.artifact_media_type===''&&p.idempotency_key==='');
  if(p.method==='POST') need(/^[A-Za-z0-9._~-]{1,128}$/.test(p.idempotency_key)&&p.content_type==='application/json'&&p.artifact_media_type==='');
  if(p.method==='PUT') need(p.idempotency_key===''&&['application/json','application/octet-stream'].includes(p.content_type));
  if(p.content_type==='application/octet-stream') need(['application/gzip','text/x-diff','text/plain','application/x-ndjson'].includes(p.artifact_media_type));
  else need(p.artifact_media_type==='');
  if(p.content_type==='application/json') integer(p.content_length,0,262144);
}
function target(value,options={}) {
  need(typeof value==='string' && value.length<=4096 && !/[\\\s#]/.test(value));
  const u=new URL(value); origin(u.origin,options); need(!u.username&&!u.password);
  const m=/^(https?:\/\/[^/]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(value); need(m);
  const rawPath=m[2]??'/';
  need(!/%(?:2f|5c)/i.test(rawPath), 'ambiguous_target');
  for(const part of rawPath.split('/')) {
    let decoded; try { decoded=decodeURIComponent(part); } catch { fail('ambiguous_target'); }
    need(decoded!=='.'&&decoded!=='..'&&!/[\\\x00-\x20]/.test(decoded), 'ambiguous_target');
  }
  need(u.pathname===rawPath, 'ambiguous_target');
  const keys=new Set(); for(const key of u.searchParams.keys()) { need(!keys.has(key), 'ambiguous_target'); keys.add(key); }
}
function validatePayload(kind,p) {
  need(kinds.includes(kind), 'unsupported_kind'); profile(p);
  if(kind==='request') return requestPayload(p);
  if(kind==='cancellation') {
    object(p,['schema','circle','job_digest','author','roster_epoch','created_at','reason']);
    need(p.schema==='faravan.cancellation.v1','unsupported_version'); checkUUID(p.circle); checkDigest(p.job_digest); checkDigest(p.author); integer(p.roster_epoch,1); timestamp(p.created_at);
    need(typeof p.reason==='string'&&[...p.reason].length>=1&&[...p.reason].length<=4096); return;
  }
  if(kind==='person-link') {
    object(p,['schema','circle','person_id','device_key_id','person_public_key','device_public_key'],['roster_epoch']);
    if(p.roster_epoch!==undefined)need(Number.isSafeInteger(p.roster_epoch)&&p.roster_epoch>=1);
    need(p.schema==='faravan.person-link.v1','unsupported_version');checkUUID(p.circle);
    importPublicKey(p.person_public_key);importPublicKey(p.device_public_key);
    need(fingerprint(p.person_public_key)===p.person_id&&fingerprint(p.device_public_key)===p.device_key_id,'key_mismatch');return;
  }
  if(kind==='leave') {
    // A member's own, optional request to be removed from the roster (v1.0 addition; old devices never send or read it).
    object(p,['schema','circle','key_id','issued_at']);
    need(p.schema==='faravan.leave.v1','unsupported_version'); checkUUID(p.circle); checkDigest(p.key_id); timestamp(p.issued_at); return;
  }
  if(kind==='job') requirements(p?.requirements);
  schemaValidate(p,schemas[kind+'.schema.json'].properties.payload,schemas[kind+'.schema.json']);
  if(kind==='job') {
    need((p.budget_v1!==undefined)===p.requirements.capabilities.includes('budget_v1'),'requirements_mismatch');
    if(p.budget_v1)need(Object.keys(p.budget_v1).length>0);
    // An automatic choice is its own answer to "which model and effort"; beside an explicit one it would be two answers.
    need((p.auto_run_v1!==undefined)===p.requirements.capabilities.includes(AUTO_RUN_CAPABILITY),'requirements_mismatch');
    if(p.auto_run_v1!==undefined)need(p.requirements.model===undefined&&!(p.budget_v1&&Object.hasOwn(p.budget_v1,'effort')));
    // A signed run request is its own answer to "which model and effort": beside another one there would be two answers.
    need((p.runRequest!==undefined)===p.requirements.capabilities.includes(RUN_REQUEST_CAPABILITY),'requirements_mismatch');
    if(p.runRequest!==undefined) {
      need(validateRunRequest(p.runRequest).ok,'invalid_run_request');
      need(p.auto_run_v1===undefined&&p.requirements.model===undefined&&!(p.budget_v1&&Object.hasOwn(p.budget_v1,'effort')));
    }
    // The designated member (owner-offline topology, product owner 11-19): the one member whose store may dispatch
    // this job. Any member store can accept the signed submission and preserve it; membership is still
    // checked at publish and the claim fence at the store.
    need((p.designated_member!==undefined)===p.requirements.capabilities.includes(DESIGNATED_MEMBER_CAPABILITY),'requirements_mismatch');
    if(p.designated_member!==undefined) checkDigest(p.designated_member);
    need((p.parent!==undefined)===p.requirements.capabilities.includes('parent_link_v1'));
    if(p.working_directory!==undefined){try{validateWorkingDirectory(p.working_directory);}catch{need(false);}need(p.requirements.capabilities.includes('working_directory_v1'));}
    else need(!p.requirements.capabilities.includes('working_directory_v1'));
    source(p.source);
    if(p.requirements.capabilities.includes('filtered_git_v1'))need(p.source.kind==='git');
    if(p.source_manifest!==undefined){need(p.requirements.capabilities.includes('source_manifest_v1'));need(p.source.kind==='archive' && p.source_manifest.archive_digest===p.source.artifact.digest && p.source_manifest.packed_bytes===p.source.artifact.bytes);}
    else need(!p.requirements.capabilities.includes('source_manifest_v1'));
    need((p.source_manifest?.project_name!==undefined)===p.requirements.capabilities.includes('source_project_name_v1'));
    need(p.prompt.media_type==='text/plain'); need(timestamp(p.expires_at)>timestamp(p.created_at));
    if(p.verify!==undefined) need(p.verify.cmd.trim().length>0&&p.requirements.capabilities.includes('verify_v1')&&p.requirements.limits.wall_seconds>180);
    else need(!p.requirements.capabilities.includes('verify_v1'));
    // A typed result and results_v1 come together; an empty workspace must say what it returns.
    need((p.result!==undefined)===p.requirements.capabilities.includes('results_v1'));
    if(p.source.kind==='none') need(p.result!==undefined);
    // A frozen audience always names its author; roster membership needs the roster, so the host checks it at publish.
    if(p.audience!==undefined) need(p.audience.device_keys.includes(p.author));
  }
  if(kind==='result') {
    for(const check of p.checks??[]) {
      need(check.cmd.trim().length>0);
      if(check.skipped!==undefined)need(Object.values(CHECK_SKIPPED).includes(check.skipped)&&check.exit===null&&
        check.parser===null&&check.summary===''&&check.duration_ms===undefined&&check.timeout_ms===undefined);
      for(const path of check.changed_test_files)
        need(!/[\\\x00-\x1f\x7f]/.test(path)&&!path.startsWith('/')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'));
    }
    need(['text/x-diff','application/gzip'].includes(p.candidate.media_type)); need(['application/x-ndjson','text/plain'].includes(p.transcript.media_type));
    source(p.receipt.source); need(timestamp(p.receipt.finished_at)>=timestamp(p.receipt.started_at));
    if(p.receipt.verified_commit!==undefined)
      need(p.receipt.source.kind==='git'&&p.receipt.verified_commit===p.receipt.source.commit,'git_commit_unverified');
    if(p.receipt.network_scope!==undefined) need(p.receipt.source.kind==='git');
    need((p.receipt.auto_run_v1!==undefined)===p.receipt.capabilities_applied.includes(AUTO_RUN_CAPABILITY),'requirements_mismatch');
    need((p.receipt.selection!==undefined)===p.receipt.capabilities_applied.includes(RUN_REQUEST_CAPABILITY),'requirements_mismatch');
    if(p.receipt.selection!==undefined) need(p.receipt.model===p.receipt.selection.modelId,'requirements_mismatch');
    const format=p.receipt.candidate_format;
    need(format!==undefined||(p.receipt.diffstat===undefined&&p.receipt.base_tree===undefined&&p.receipt.diff_unavailable===undefined));
    if(format==='diff') need(p.candidate.media_type==='text/x-diff'&&p.receipt.diffstat!==undefined&&p.receipt.diff_unavailable===undefined);
    if(format==='tree') need(p.candidate.media_type==='application/gzip'&&p.receipt.diffstat===undefined&&p.receipt.base_tree===undefined);
    // A message or files result is the faravan-output/ tree by design, never a failed diff.
    if(p.output!==undefined) need(format==='tree'&&p.receipt.diff_unavailable===undefined);
  }
  if(kind==='roster') {
    if(p.lan_mode!==undefined) need(p.lan_mode===true&&p.coordinator!==undefined);
    if(p.coordinator!==undefined) origin(p.coordinator,{lanMode:p.lan_mode===true});
    importPublicKey(p.root_public_key); const seen=new Set(); const origins=new Set();
    for(const m of p.members) { object(m,['key_id','public_key','joined_epoch'],['device_name','person_name','person_id','person_link','origin']); if(m.device_name!==undefined) checkDeviceName(m.device_name); if(m.person_name!==undefined) checkDeviceName(m.person_name); need(m.key_id===fingerprint(m.public_key),'key_mismatch'); need(m.joined_epoch<=p.epoch); need(!seen.has(m.key_id)); seen.add(m.key_id);
      // A member origin (owner-offline topology, product owner 11-19): the address this member serves the circle at,
      // signed by the same root authority that signs the roster. It never grants membership or signing power.
      if(m.origin!==undefined) { origin(m.origin,{lanMode:p.lan_mode===true}); need(!origins.has(m.origin),'origin_conflict'); origins.add(m.origin); } }
    verifyPeople(p,verifyEnvelope);
    const lifetime=timestamp(p.valid_until)-timestamp(p.issued_at); need(lifetime>0&&lifetime<=30*86400,'roster_validity');
    if(p.profile!==undefined) { object(p.profile,['name'],['purpose']); checkCircleText(p.profile.name); if(p.profile.purpose!==undefined) checkCircleText(p.profile.purpose); }
  }
  if(kind==='invite') {
    origin(p.coordinator,{lanMode:p.lan_mode===true}); importPublicKey(p.invite_public_key);
    need(p.root_fingerprint===fingerprint(p.root_public_key),'root_mismatch');
    const lifetime=timestamp(p.expires_at)-timestamp(p.created_at); need(lifetime>0&&lifetime<=86400,'invite_validity');
    // The signed member-origin list (owner-offline topology, product owner 11-19): where each member serves the
    // circle, carried beside the coordinator origin. Reach data only; it never grants membership.
    if(p.member_origins!==undefined) {
      need(Array.isArray(p.member_origins)&&p.member_origins.length<=1000&&p.member_origins.length>0);
      const seen=new Set();
      for(const item of p.member_origins) {
        object(item,['key_id','origin']); checkDigest(item.key_id); origin(item.origin,{lanMode:p.lan_mode===true});
        need(!seen.has(item.key_id),'key_mismatch'); seen.add(item.key_id);
      }
    }
  }
}
/** The immutable root authorizes a chain; its current owner, steward and admins may sign circle documents. */
export function circleDocumentSigner(payload,keyId) {
  if(!payload.authority_chain)return payload.root_public_key;
  const result=chainVerify(payload.authority_chain,{circle:payload.circle,rootFingerprint:fingerprint(payload.root_public_key),coordinator:payload.coordinator});
  need(result.ok,result.code);
  const key=[result.authority.owner,result.authority.steward,...(result.authority.admins??[])].find(k=>k?.key_id===keyId);
  need(key,'forbidden');return key.public_key;
}
function signingBytes(kind,payload) {
  return Buffer.concat([Buffer.from('faravan/'+kind+'/v1\0'), Buffer.from(digest(payload).slice(7),'hex')]);
}
function validateSignature(signature) {
  importPublicKey(signature.subarray(0,32).toString('base64url'));
  let scalar=0n; for(let i=63;i>=32;i--) scalar=(scalar<<8n)+BigInt(signature[i]);
  need(scalar<((1n<<252n)+27742317777372353535851937790883648493n),'invalid_signature');
}
/** Sign a schema/profile-valid payload in its exact v1 domain; receipts remain unsigned. */
export function signEnvelope(kind,payload,privateKey) {
  validatePayload(kind,payload);
  if(kind==='job') need(!(payload.source_manifest?.not_sent??[]).some(item=>Object.hasOwn(item,'path')));
  const key_id=fingerprint(createPublicKey(privateKey));
  if(kind==='request'||kind==='leave') need(payload.key_id===key_id,'key_mismatch');
  if(kind==='roster'||kind==='invite')need(fingerprint(circleDocumentSigner(payload,key_id))===key_id,'root_mismatch');
  if(kind==='invite') need(payload.root_fingerprint===fingerprint(payload.root_public_key),'root_mismatch');
  return { payload:strictParse(canonicalize(payload)), signature:{ algorithm:'Ed25519',key_id,
    value:sign(null,signingBytes(kind,payload),privateKey).toString('base64url') } };
}
// Successful verifyEnvelope results, keyed by a digest of the kind, the public key and the exact input. The outcome is a
// pure function of those inputs, so repeat checks of the same signed bytes skip the point and signature math. Failures are
// never stored; a changed byte, signature or key is a different key; the table is least-recently-used and bounded.
const VERIFY_MEMO_LIMIT=512;
const verifyMemo=new Map();
function verifyMemoKey(kind,envelope,publicKey){
  if(typeof publicKey!=='string')return null;
  try{
    const hash=createHash('sha256').update(kind).update('\0').update(publicKey).update('\0');
    if(typeof envelope==='string')return hash.update('s').update(envelope).digest('hex');
    if(envelope instanceof Uint8Array)return hash.update('b').update(envelope).digest('hex');
    return hash.update('j').update(canonicalize(envelope)).digest('hex');
  }catch{return null;}
}
/** Verify shape, numeric profile, key ID, domain and signature; no membership or contextual trust is implied. */
export function verifyEnvelope(kind,envelope,publicKey) {
  const memoKey=verifyMemoKey(kind,envelope,publicKey);
  if(memoKey!==null&&verifyMemo.has(memoKey)){
    const hit=verifyMemo.get(memoKey);verifyMemo.delete(memoKey);verifyMemo.set(memoKey,hit);
    return structuredClone(hit);
  }
  const result=guard(()=>{
    if(typeof envelope==='string'||envelope instanceof Uint8Array) envelope=strictParse(envelope);
    profile(envelope); object(envelope,['payload','signature']); object(envelope.signature,['algorithm','key_id','value']);
    need(envelope.signature.algorithm==='Ed25519','invalid_signature');
    validatePayload(kind,envelope.payload);
    let encoded=typeof publicKey==='string'?publicKey:exportPublicKey(publicKey);
    if((kind==='roster'||kind==='invite')&&envelope.payload.authority_chain){
      const signer=circleDocumentSigner(envelope.payload,envelope.signature.key_id);need(encoded===envelope.payload.root_public_key||encoded===signer,'root_mismatch');encoded=signer;
    }
    const key=importPublicKey(encoded);
    need(envelope.signature.key_id===fingerprint(encoded),'key_mismatch');
    if(kind==='request'||kind==='leave') need(envelope.payload.key_id===envelope.signature.key_id,'key_mismatch');
    if(kind==='roster'&&!envelope.payload.authority_chain) need(envelope.payload.root_public_key===encoded,'root_mismatch');
    if(kind==='invite'&&!envelope.payload.authority_chain) need(envelope.payload.root_fingerprint===envelope.signature.key_id&&envelope.payload.root_public_key===encoded,'root_mismatch');
    const signature=decodeBase64url(envelope.signature.value,64);
    validateSignature(signature);
    need(verify(null,signingBytes(kind,envelope.payload),key,signature),'invalid_signature');
    return {ok:true,payload:envelope.payload,key_id:envelope.signature.key_id,digest:digest(envelope.payload)};
  });
  if(memoKey!==null&&result.ok===true){
    verifyMemo.set(memoKey,structuredClone(result));
    if(verifyMemo.size>VERIFY_MEMO_LIMIT)verifyMemo.delete(verifyMemo.keys().next().value);
  }
  return result;
}
/** Validate a requirements block against the closed schema and explicitly recognized capability vocabulary. */
export function validateRequirements(value,{recognizedCapabilities=RECOGNIZED_CAPABILITIES}={}) {
  return guard(()=>{ profile(value); requirements(value,recognizedCapabilities); return {ok:true}; });
}
/** Omitted modes are required: old signed jobs must never silently weaken. */
export function limitRequirements(req) {
  requirements(req);
  const required=[], preferred=[];
  for(const key of Object.keys(req.limits)) (req.limit_modes?.[key]==='preferred'?preferred:required).push(key);
  return {required,preferred};
}
// Exact configured tuples, never independent model/effort lists. The effort vocabulary
// belongs to the existing job schema, including the explicit value "none".
const effortValues = () => jobSchema.properties.payload.properties.budget_v1.properties.effort.enum;
export function validateModelEffortPairs(pairs,{models,harnesses,harness,maxModelLength=4096}={}) {
  return guard(()=>{
    need(Array.isArray(pairs)&&pairs.length<=128);
    need(Array.isArray(models)&&Array.isArray(harnesses));
    const seen=new Set();
    for(const pair of pairs) {
      object(pair,harness===undefined?['harness','model','effort']:['model','effort']);
      const adapter=harness===undefined?pair.harness:harness;
      need(typeof adapter==='string'&&harnesses.includes(adapter));
      need(typeof pair.model==='string'&&[...pair.model].length>=1&&[...pair.model].length<=maxModelLength&&models.includes(pair.model));
      need(typeof pair.effort==='string'&&effortValues().includes(pair.effort));
      const key=canonicalize([adapter,pair.model,pair.effort]);
      need(!seen.has(key));seen.add(key);
    }
    return {ok:true};
  });
}
/** Compare required OR/AND capabilities and enforceable ceilings with a lender's self-report. */
export function canSatisfy(req,lender,{recognizedCapabilities=RECOGNIZED_CAPABILITIES,job}={}) {
  const valid=validateRequirements(req,{recognizedCapabilities}); if(!valid.ok) return {...valid,unmet:['requirements']};
  const matched=guard(()=>{
    object(lender,['harnesses','models','capabilities','egress','enforced_limits','max_limits'],['model_efforts','accounts']);
    for(const name of ['harnesses','models','capabilities','egress','enforced_limits']) {
      const list=lender[name];
      need(Array.isArray(list)&&list.every(x=>typeof x==='string')&&new Set(list).size===list.length);
      if(['harnesses','models','capabilities'].includes(name))
        need(list.length<=128&&list.every(x=>[...x].length>=1&&[...x].length<=4096));
    }
    need(lender.harnesses.length>=1&&lender.egress.length>=1);
    need(lender.egress.every(x=>['provider-only','internet'].includes(x)));
    need(lender.enforced_limits.every(x=>Object.hasOwn(jobSchema.$defs.limits.properties,x)));
    schemaValidate(lender.max_limits,jobSchema.$defs.limits,jobSchema);
    if(Object.hasOwn(lender,'model_efforts')) {
      need(lender.capabilities.includes(MODEL_EFFORT_PAIRS_CAPABILITY));
      need(validateModelEffortPairs(lender.model_efforts,lender).ok);
    }
    if(Object.hasOwn(lender,'accounts')) {
      need(lender.capabilities.includes(RUN_REQUEST_CAPABILITY));
      need(validateAccountAdvertisement(lender.accounts));
    }
    const unmet=[];
    if(job!==undefined) {
      if(!job||canonicalize(job.requirements)!==canonicalize(req)) return {ok:false,code:'requirements_unsupported',unmet:['job']};
      if(job.budget_v1&&Object.hasOwn(job.budget_v1,'effort')) {
        const effort=job.budget_v1.effort;
        const supported=typeof effort==='string'&&effortValues().includes(effort)
          &&lender.capabilities.includes(MODEL_EFFORT_PAIRS_CAPABILITY)
          &&lender.model_efforts?.some(pair=>pair.effort===effort
            &&(!req.harness||req.harness.includes(pair.harness))
            &&(!req.model||req.model.any_of.includes(pair.model)));
        if(!supported)unmet.push('model_effort');
      }
      // A signed run request needs an account, model and effort the lender advertises. Capacity is the lender's own later answer.
      if(job.runRequest!==undefined&&!(lender.capabilities.includes(RUN_REQUEST_CAPABILITY)&&Object.hasOwn(lender,'accounts')&&
        (r=>r.ok||r.code==='account_busy')(resolveSelection({runRequest:job.runRequest,accounts:lender.accounts}))))unmet.push('run_request');
      // An automatic choice needs at least one configured pair on the job's harness to choose from.
      if(job.auto_run_v1&&!lender.model_efforts?.some(pair=>!req.harness||req.harness.includes(pair.harness)))unmet.push('model_effort');
    }
    if(req.harness&&!req.harness.some(x=>lender.harnesses.includes(x))) unmet.push('harness');
    if(req.model&&!req.model.any_of.some(x=>lender.models.includes(x))) unmet.push('model');
    for(const c of req.capabilities) if(!lender.capabilities.includes(c)) unmet.push('capability:'+c);
    if(!lender.egress.includes(req.egress)) unmet.push('egress');
    // New network semantics must never be silently treated as legacy egress.
    // Older validators reject the optional fields with unsupported_version;
    // upgraded validators reject incapable lenders with requirements_unsupported.
    if(req.network==='provider+registries'&&!lender.capabilities.includes('network-registries-v1')) unmet.push('network');
    const preferred_unmet=[];
    for(const [k,v] of Object.entries(req.limits)) {
      if(!lender.enforced_limits.includes(k)||lender.max_limits[k]<v)
        (req.limit_modes?.[k]==='preferred'?preferred_unmet:unmet).push('limit:'+k);
    }
    const result=unmet.length?{ok:false,code:'requirements_unsupported',unmet}:{ok:true,unmet:[]};
    return preferred_unmet.length?{...result,preferred_unmet}:result;
  });
  return matched.ok || matched.unmet ? matched : {...matched,unmet:['lenderCapabilities']};
}
/** What a job returns: branch (code changes, encoded by omitting `result` so legacy jobs stay byte-identical),
 * message (the agent's final message, plus faravan-output/ files) or files (faravan-output/). */
export const RESULT_KINDS=Object.freeze(['branch','message','files']);
/** The canonical result kind of a verified job payload (or of a result's `output`); absent means branch. */
export const resultKind=value=>value?.result?.kind??value?.output?.kind??'branch';
/** Check author equality against an independently verified signer. */
export function checkAuthor(job,signer) { return guard(()=>{need(job.author===signer,'author_mismatch');checkDigest(signer);return {ok:true};}); }
/** Whether a job payload lets this device key see it: true without a frozen audience, else only for the listed keys. */
export function audienceAllows(payload,keyId) { return payload?.audience===undefined||payload.audience.device_keys.includes(keyId); }
/** Check executor equality against signer and the preserved attempt holder. */
export function checkExecutor(result,signer,attempt) { return guard(()=>{need(result.executor===signer&&signer===attempt.holder,'executor_mismatch');checkDigest(signer);return {ok:true};}); }
/** Check a payload circle against an independently configured circle. */
export function checkCircle(payload,expected) { return guard(()=>{checkUUID(expected);need(payload.circle===expected,'wrong_circle');return {ok:true};}); }
/** Check a result's job digest against an independently retained digest. */
export function checkJobDigest(result,expected) { return guard(()=>{checkDigest(expected);need(result.job_digest===expected,'wrong_job_digest');return {ok:true};}); }
/** Check result attempt/generation against a preserved authoritative attempt record. */
export function checkAttempt(result,attempt) { return guard(()=>{integer(attempt.generation,1);checkUUID(attempt.attempt_id);need(result.attempt_id===attempt.attempt_id&&result.generation===attempt.generation,'stale_attempt');return {ok:true};}); }
/** Check roster epoch and same-epoch digest against remembered, independently accepted state. */
export function checkRosterEpoch(roster,highestAcceptedEpoch,highestAcceptedDigest) {
  return guard(()=>{integer(highestAcceptedEpoch);integer(roster.epoch,1);need(roster.epoch>=highestAcceptedEpoch,'roster_stale');
    if(roster.epoch===highestAcceptedEpoch) { checkDigest(highestAcceptedDigest);need(digest(roster)===highestAcceptedDigest,'roster_stale'); } return {ok:true};});
}
/** Find a member by fingerprint in an already verified roster payload, or return null. */
export function findMember(roster,keyId) { return roster?.members?.find(m=>m.key_id===keyId)??null; }
/** Create a root-signed roster with a seven-day default and a thirty-day maximum lifetime. */
export function createRoster({circle,epoch,members,issued_at,valid_until,coordinator,lan_mode},rootPrivateKey) {
  const start=timestamp(issued_at);
  return signEnvelope('roster',{schema:'faravan.roster.v1',circle,root_public_key:exportPublicKey(rootPrivateKey),epoch,issued_at,
    valid_until:valid_until??instant(start+7*86400),members,...(coordinator!==undefined?{coordinator}:{}),
    ...(lan_mode!==undefined?{lan_mode}:{})},rootPrivateKey);
}
/** Verify root pin, circle, signature, lifetime, injected clock, and optional anti-rollback state. */
export function verifyRoster(envelope,{rootFingerprint,circle,now,highestAcceptedEpoch=0,highestAcceptedDigest,previousAuthorityChain,previousRoster,requireCurrentLinkEpoch=false}={}) {
  return guard(()=>{
    checkDigest(rootFingerprint);checkUUID(circle);need(typeof now==='function');const t=now();integer(t);
    const parsed=typeof envelope==='string'||envelope instanceof Uint8Array?strictParse(envelope):envelope;
    need(fingerprint(parsed.payload.root_public_key)===rootFingerprint,'root_mismatch');
    if(previousAuthorityChain||parsed.payload.authority_chain){
      const authority=chainVerify(parsed.payload.authority_chain,{circle,rootFingerprint,coordinator:parsed.payload.coordinator,previousChain:previousAuthorityChain,now:t});need(authority.ok,authority.code);
    }
    const checked=verifyEnvelope('roster',parsed,parsed.payload.root_public_key);if(!checked.ok)return checked;
    const p=checked.payload;need(p.circle===circle,'wrong_circle');
    verifyGovernanceTransition(previousRoster,p,checked.key_id,{requireCurrentLinkEpoch});
    need(timestamp(p.issued_at)<=t+60,'clock_skew');need(timestamp(p.valid_until)>t,'roster_expired');
    const epoch=checkRosterEpoch(p,highestAcceptedEpoch,highestAcceptedDigest);if(!epoch.ok)return epoch;
    return {...checked,roster:p};
  });
}
/** A member's reach claim for its own serving origin (owner-offline topology). It is carried as the body of an
 *  ordinary authenticated circle request, so its sender is the roster member that proof names; the body has no
 *  sender field. It is reach data only: it changes no membership, authority or roster until an authorized
 *  publisher signs the origin in. Bounded evidence only: the exact public HTTPS origin, the provider route's
 *  generation, when it was observed and when that proof lapses. Never a local target, handle or credential. */
export const MEMBER_ORIGIN_SCHEMA='faravan.member-origin.v1';
const MEMBER_ORIGIN_MAX_AGE=7*86400;
export function validateMemberOriginProposal(value,{now}={}) {
  return guard(()=>{
    need(value&&typeof value==='object'&&!Array.isArray(value));
    need(value.schema===MEMBER_ORIGIN_SCHEMA,'unsupported_version');
    if(value.state==='withdrawn') {
      object(value,['schema','state','observed_at']);
      const observed=timestamp(value.observed_at);
      if(now!==undefined)need(observed<=now+60,'invalid_request');
      return {ok:true,proposal:value,state:'withdrawn',observed};
    }
    object(value,['schema','state','origin','generation','observed_at','valid_until']);
    need(value.state==='proposed');
    origin(value.origin);need(new URL(value.origin).protocol==='https:');
    integer(value.generation,0,2147483647);
    const observed=timestamp(value.observed_at),until=timestamp(value.valid_until);
    need(until>observed&&until-observed<=MEMBER_ORIGIN_MAX_AGE,'invalid_request');
    if(now!==undefined)need(observed<=now+60&&until>now,'invalid_request');
    return {ok:true,proposal:value,state:'proposed',observed,until};
  });
}
/** Build a request proof using supplied nonce/time and exact raw-body metadata (no random or clock side effects). */
export function buildRequestProof({circle,roster_epoch,method,target:targetURL,body,body_digest,content_length,
  content_type='',artifact_media_type='',idempotency_key='',created,nonce},privateKey,{lanMode=false}={}) {
  if(body!==undefined) {need(body instanceof Uint8Array);body_digest=digestBytes(body);content_length=body.length;if(content_type==='application/json')strictParse(body);}
  const payload={schema:'faravan.request.v1',circle,key_id:fingerprint(createPublicKey(privateKey)),roster_epoch,method,target:targetURL,
    body_digest,content_length,content_type,artifact_media_type,idempotency_key,created,nonce,...(lanMode?{lan_mode:true}:{})};
  return Buffer.from(canonicalize(signEnvelope('request',payload,privateKey))).toString('base64url');
}
function verifyRequestMetadata(header,{publicKey,expected,now,consumeNonce,lanMode=false}) {
  return guard(()=>{
    need(typeof header==='string'&&header.length<=16384,'payload_too_large');
    const parsed=strictParse(decodeBase64url(header));const checked=verifyEnvelope('request',parsed,publicKey);if(!checked.ok)return checked;
    need(typeof now==='function'&&typeof consumeNonce==='function');const t=now();integer(t);
    const p=checked.payload;need((p.lan_mode===true)===(lanMode===true),'transport_mismatch');
    origin(new URL(p.target).origin,{lanMode});need(t-p.created<=300&&p.created-t<=60,'clock_skew');
    object(expected,['circle','key_id','roster_epoch','method','target','body_digest','content_length','content_type','artifact_media_type','idempotency_key']);
    for(const key of Object.keys(expected)) need(p[key]===expected[key],'request_mismatch');
    return {...checked,receivedAt:t};
  });
}
/** Verify a request with an atomic synchronous nonce callback, suitable for a synchronous transaction.
 * The caller must check current membership first. Only literal true accepts a nonce;
 * callbacks returning a Promise/thenable are unsupported and fail closed.
 */
export function verifyRequestProofSync(header,options={}) {
  const result=verifyRequestMetadata(header,options);
  if(!result.ok)return result;
  try {
    const accepted=options.consumeNonce(result.key_id,result.payload.nonce,result.receivedAt+361);
    if(accepted!==null && (typeof accepted==='object'||typeof accepted==='function') && typeof accepted.then==='function') {
      return {ok:false,code:'nonce_store_failure'};
    }
    return accepted===true?result:{ok:false,code:'replay'};
  } catch { return {ok:false,code:'nonce_store_failure'}; }
}
/** Verify exact request metadata, time window and injected atomic nonce consumption after all other checks. */
export async function verifyRequestProof(header,options={}) {
  const result=verifyRequestMetadata(header,options);
  if(!result.ok)return result;
  try {
    const accepted=await options.consumeNonce(result.key_id,result.payload.nonce,result.receivedAt+361);
    return accepted===true?result:{ok:false,code:'replay'};
  } catch { return {ok:false,code:'nonce_store_failure'}; }
}
/** Create a public authority-signed invite; private invite material is never placed in the envelope. */
export function createInvite({circle,coordinator,invite_id,invite_public_key,created_at,expires_at,display_name,lan_mode,owner_name,approval,role,max_uses,authority_chain,root_public_key,member_origins},rootPrivateKey) {
  return signEnvelope('invite',{schema:'faravan.invite.v1',circle,coordinator,invite_id,invite_public_key,created_at,expires_at,
    root_public_key:root_public_key??exportPublicKey(rootPrivateKey),root_fingerprint:fingerprint(root_public_key??exportPublicKey(rootPrivateKey)),...(authority_chain?{authority_chain}:{}),
    ...(member_origins!==undefined?{member_origins}:{}),
    ...(display_name!==undefined?{display_name}:{}),...(lan_mode!==undefined?{lan_mode}:{}),
    ...(owner_name!==undefined?{owner_name}:{}),...(approval!==undefined?{approval}:{}),
    ...(role!==undefined?{role}:{}),...(max_uses!==undefined?{max_uses}:{})},rootPrivateKey);
}
/** Verify a public invite against independently trusted root, circle, origin and injected clock. */
export function verifyInvite(envelope,{rootFingerprint,circle,coordinator,now,lanMode=false}={}) {
  return guard(()=>{
    const parsed=typeof envelope==='string'||envelope instanceof Uint8Array?strictParse(envelope):envelope;
    checkDigest(rootFingerprint);checkUUID(circle);origin(coordinator,{lanMode});need(typeof now==='function');const t=now();integer(t);
    need(fingerprint(parsed.payload.root_public_key)===rootFingerprint,'root_mismatch');
    if(parsed.payload.authority_chain){const authority=chainVerify(parsed.payload.authority_chain,{circle,rootFingerprint,coordinator,now:t});need(authority.ok,authority.code);}
    const checked=verifyEnvelope('invite',parsed,parsed.payload.root_public_key);if(!checked.ok)return checked;
    const p=checked.payload;need(p.circle===circle,'wrong_circle');
    need(p.coordinator===coordinator,'wrong_origin');
    need((p.lan_mode===true)===(lanMode===true),'transport_mismatch');
    need(timestamp(p.created_at)<=t+60,'clock_skew');need(timestamp(p.expires_at)>t,'enrollment_expired');return checked;
  });
}
/** Encode a /join invite URL with its seed exclusively inside the URL fragment. */
export function encodeInviteLink(invite,invitePrivateSeed) {
  const checked=verifyEnvelope('invite',invite,invite.payload.root_public_key);need(checked.ok,checked.code);
  const seed=typeof invitePrivateSeed==='string'?invitePrivateSeed:Buffer.from(invitePrivateSeed).toString('base64url');
  need(exportPublicKey(privateKeyFromSeed(seed))===invite.payload.invite_public_key,'key_mismatch');
  return invite.payload.coordinator+'/join#invite='+Buffer.from(canonicalize({invite,invite_private_seed:seed})).toString('base64url');
}
/** Decode a fragment-only invite link and validate its key binding; trusted-channel pinning remains the caller's duty. */
export function decodeInviteLink(link) {
  return guard(()=>{
    need(typeof link==='string'&&link.length<=65536);const u=new URL(link);
    need(link.startsWith(u.origin+'/join#invite=')&&u.pathname==='/join'&&!u.search&&!u.username&&!u.password,'invalid_invite_link');
    const decoded=strictParse(decodeBase64url(u.hash.slice('#invite='.length)));
    object(decoded,['invite','invite_private_seed']);const p=decoded.invite.payload;need(p.coordinator===u.origin,'wrong_origin');
    const valid=verifyEnvelope('invite',decoded.invite,p.root_public_key);if(!valid.ok)return valid;
    origin(u.origin,{lanMode:p.lan_mode===true});
    need(exportPublicKey(privateKeyFromSeed(decoded.invite_private_seed))===p.invite_public_key,'key_mismatch');
    need(encodeInviteLink(decoded.invite,decoded.invite_private_seed)===link,'invalid_invite_link');
    return {ok:true,...decoded};
  });
}
// --- Short invites ---------------------------------------------------------
// A short link, <origin>/i/<code>#<seed>, names a published invite by an unguessable code and carries
// the invite private seed only in its fragment. The coordinator stores the public envelope plus the
// owner device's binding signature, made with the invite key (domain faravan/invite-binding/v1) over
// the exact envelope. The verifier derives the invite key from the original link. A coordinator
// without the seed cannot bind an envelope that pins a different circle root. Queue-served JavaScript
// can capture the fragment, so this protection requires an independently trusted app or CLI.
const CODE_ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
export const INVITE_CODE_PATTERN=/^[a-z2-7]{10}$/;
/** A fresh 10-character lowercase base32 code: 50 random bits, never derived from other state. */
export function generateInviteCode(random=randomBytes) {
  const bytes=random(10);need(bytes instanceof Uint8Array&&bytes.length===10,'invalid_random');
  return Array.from(bytes,b=>CODE_ALPHABET[b&31]).join('');
}
/** Sign the exact authority-signed invite envelope with the one-time invite private key (or its seed). */
export function createInviteBinding(invite,invitePrivateKey) {
  const checked=verifyEnvelope('invite',invite,invite.payload.root_public_key);need(checked.ok,checked.code);
  const key=typeof invitePrivateKey==='string'||invitePrivateKey instanceof Uint8Array?privateKeyFromSeed(invitePrivateKey):invitePrivateKey;
  need(exportPublicKey(key)===invite.payload.invite_public_key,'key_mismatch');
  return {algorithm:'Ed25519',key_id:fingerprint(createPublicKey(key)),
    value:sign(null,signingBytes('invite-binding',invite),key).toString('base64url')};
}
/**
 * Verify that the holder of invitePublicKey (the key the joiner rebuilt from the link seed) bound this
 * exact envelope. The caller must pass a key it derived itself, never one read from the envelope.
 * Nothing in the envelope, including the root fingerprint, may be trusted before this succeeds.
 */
export function verifyInviteBinding(invite,binding,{invitePublicKey}={}) {
  return guard(()=>{
    importPublicKey(invitePublicKey);object(binding,['algorithm','key_id','value']);
    need(binding.algorithm==='Ed25519','invalid_signature');
    profile(invite);object(invite,['payload','signature']);
    need(invite.payload&&invite.payload.invite_public_key===invitePublicKey,'key_mismatch');
    need(binding.key_id===fingerprint(invitePublicKey),'key_mismatch');
    const signature=decodeBase64url(binding.value,64);validateSignature(signature);
    need(verify(null,signingBytes('invite-binding',invite),importPublicKey(invitePublicKey),signature),'invalid_signature');
    const checked=verifyEnvelope('invite',invite,invite.payload.root_public_key);if(!checked.ok)return checked;
    return {ok:true,payload:checked.payload,digest:checked.digest};
  });
}
/** Encode the short link: origin, then /i/<code>, then the seed alone in the fragment. */
export function encodeShortLink({coordinator,code,seed}) {
  need(INVITE_CODE_PATTERN.test(code),'invalid_invite_link');
  const encoded=typeof seed==='string'?seed:Buffer.from(seed).toString('base64url');decodeBase64url(encoded,32);
  const u=new URL(coordinator);need(u.origin===coordinator&&origin(coordinator,{lanMode:true}),'invalid_invite_link');
  return coordinator+'/i/'+code+'#'+encoded;
}
/** Decode a short link into {coordinator, code, seed}. The origin is a claim until the binding verifies. */
export function decodeShortLink(link) {
  return guard(()=>{
    need(typeof link==='string'&&link.length<=512);const u=new URL(link);
    const m=/^\/i\/([a-z2-7]{10})$/.exec(u.pathname);
    need(m&&!u.search&&!u.username&&!u.password&&u.hash.length>1,'invalid_invite_link');
    origin(u.origin,{lanMode:true});decodeBase64url(u.hash.slice(1),32);
    const result={coordinator:u.origin,code:m[1],seed:u.hash.slice(1)};
    need(encodeShortLink(result)===link,'invalid_invite_link');
    return {ok:true,...result};
  });
}
/**
 * Turn a published {envelope, invite_binding} plus the link's origin and seed into the equivalent long
 * link. Rebuilds the key from the seed, checks it equals the envelope's invite_public_key, verifies
 * the binding, and only then lets the envelope's coordinator and root be used.
 */
export function inviteLinkFromPublication(publication,{coordinator,seed}={}) {
  return guard(()=>{
    object(publication,['envelope','invite_binding']);
    const invitePublicKey=exportPublicKey(privateKeyFromSeed(seed));
    need(publication.envelope?.payload?.invite_public_key===invitePublicKey,'key_mismatch');
    const bound=verifyInviteBinding(publication.envelope,publication.invite_binding,{invitePublicKey});if(!bound.ok)return bound;
    need(bound.payload.coordinator===coordinator,'wrong_origin');
    return {ok:true,link:encodeInviteLink(publication.envelope,seed),payload:bound.payload};
  });
}
/** Device display names are chosen on the joining device: 1-64 characters, no control, format or bidi characters, no edge spaces. */
export const checkDeviceName = name => need(typeof name === 'string' && name.length >= 1 && [...name].length <= 64 &&
  name === name.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), 'invalid_device_name');
/** Owner-signed circle name and purpose: 1-256 characters, no control, format or bidi characters, no edge spaces. */
export const checkCircleText = text => need(typeof text === 'string' && text.length >= 1 && [...text].length <= 256 &&
  text === text.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text), 'invalid_circle_profile');
/** Sign a device public key, an optional device display name and circle/invite context with the one-time invite private key. */
export function createEnrollmentProof({circle,invite_id,device_public_key,device_name,person_name},invitePrivateKey) {
  const payload={circle,invite_id,device_public_key};checkUUID(circle);checkUUID(invite_id);importPublicKey(device_public_key);
  if(device_name!==undefined){checkDeviceName(device_name);payload.device_name=device_name;}
  if(person_name!==undefined){checkDeviceName(person_name);payload.person_name=person_name;}
  return {payload,signature:{algorithm:'Ed25519',key_id:fingerprint(createPublicKey(invitePrivateKey)),
    value:sign(null,signingBytes('enrollment',payload),invitePrivateKey).toString('base64url')}};
}
/** Verify enrollment context and signature against the owner's independently registered invite public key. */
export function verifyEnrollmentProof(proof,{invitePublicKey,circle,invite_id,device_public_key}={}) {
  return guard(()=>{
    object(proof,['payload','signature']);object(proof.payload,['circle','invite_id','device_public_key'],['device_name','person_name']);object(proof.signature,['algorithm','key_id','value']);
    if(proof.payload.device_name!==undefined)checkDeviceName(proof.payload.device_name);
    if(proof.payload.person_name!==undefined)checkDeviceName(proof.payload.person_name);
    profile(proof);checkUUID(circle);checkUUID(invite_id);importPublicKey(device_public_key);
    need(proof.payload.circle===circle,'wrong_circle');need(proof.payload.invite_id===invite_id,'invite_mismatch');
    need(proof.payload.device_public_key===device_public_key,'device_mismatch');
    need(proof.signature.algorithm==='Ed25519'&&proof.signature.key_id===fingerprint(invitePublicKey),'key_mismatch');
    const signature=decodeBase64url(proof.signature.value,64);validateSignature(signature);
    need(verify(null,signingBytes('enrollment',proof.payload),importPublicKey(invitePublicKey),signature),'invalid_signature');
    return {ok:true,payload:proof.payload};
  });
}
