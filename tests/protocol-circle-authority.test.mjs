import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sign} from 'node:crypto';
import {generateDeviceKeyPair,exportPublicKey,fingerprint,digest,canonicalize} from '../lib/protocol/encoding.mjs';
import {createAuthorityGenesis,createAuthorityTransition,createAuthorityAcceptance,
  attachAuthorityAcceptance,chainVerify,verifyAuthorityProposal} from '../lib/protocol/circle-authority.mjs';

const keys=Array.from({length:5},()=>generateDeviceKeyPair().privateKey);
const [root,owner,backup,target,outsider]=keys;
const identity=key=>({key_id:fingerprint(key),public_key:exportPublicKey(key)});
const circle='99f770d5-3230-4aa1-98aa-d599abc18614',coordinator='https://circle.example',now=1792500000;
const options={circle,coordinator,rootFingerprint:fingerprint(root),now:()=>now+30};
const genesis=()=>createAuthorityGenesis({circle,coordinator,owner:identity(owner),steward:identity(backup),issued_at:now},root);
function proposal(chain,overrides={}) {
  return createAuthorityTransition({chain,owner:identity(target),steward:identity(backup),issued_at:now+10,expires_at:now+3600,...overrides},owner);
}
function accepted(record,key=target,accepted_at=now+20) {
  return attachAuthorityAcceptance(record,createAuthorityAcceptance({proposal:record,accepted_at},key));
}
function rawSign(record,key) {
  return {...record,signature:{algorithm:'Ed25519',key_id:fingerprint(key),
    value:sign(null,Buffer.from(`faravan/circle-authority/v1\0${digest(record.payload)}`),key).toString('base64url')}};
}

test('root anchors owner and backup public identities, without distributing any private key',()=>{
  const chain=[genesis()],checked=chainVerify(chain,options);
  assert.equal(checked.ok,true,checked.code);
  assert.deepEqual(checked.authority.owner,identity(owner));assert.deepEqual(checked.authority.steward,identity(backup));
  assert.equal(checked.authority.digest,digest(chain[0]));
  assert.deepEqual(JSON.parse(canonicalize(chain)),chain);
  assert.equal(chainVerify(chain,{...options,rootFingerprint:fingerprint(outsider)}).code,'root_mismatch');
  assert.equal(chainVerify(chain,{...options,coordinator:'https://other.example'}).code,'wrong_origin');
  assert.equal(chainVerify(chain,{...options,circle:'ed48e196-cd59-4893-b2ef-0e49fce5bc12'}).code,'wrong_circle');
});

test('owner can revoke backup; accepted authority cannot roll back or switch forks',()=>{
  const initial=[genesis()];
  const revoke=createAuthorityTransition({chain:initial,steward:null,issued_at:now+5},owner);
  const chain=[...initial,revoke];
  const checked=chainVerify(chain,{...options,previousChain:initial});assert.equal(checked.ok,true,checked.code);
  assert.equal(checked.authority.steward,null);
  assert.equal(chainVerify(initial,{...options,previousChain:chain}).code,'authority_stale');
  const alternative=createAuthorityTransition({chain:initial,steward:identity(outsider),issued_at:now+5},owner);
  assert.equal(chainVerify([...initial,alternative],{...options,previousChain:chain}).code,'authority_fork');
  assert.throws(()=>createAuthorityTransition({chain:initial,steward:null,issued_at:now+5},backup),{code:'not_owner'});
  assert.equal(chainVerify([...initial,rawSign(revoke,backup)],options).code,'key_mismatch');
});

test('owner can grant and revoke admins; admins cannot authorize further grants',()=>{
  const initial=[genesis()];
  const grant=createAuthorityTransition({chain:initial,admins:[identity(outsider)],issued_at:now+5},owner);
  const granted=[...initial,grant],checked=chainVerify(granted,options);
  assert.equal(checked.ok,true,checked.code);assert.deepEqual(checked.authority.admins,[identity(outsider)]);
  const revoke=createAuthorityTransition({chain:granted,admins:[],issued_at:now+10},owner);
  const revoked=[...granted,revoke];
  assert.equal(chainVerify(revoked,{...options,previousChain:granted}).ok,true);
  assert.deepEqual(chainVerify(revoked,options).authority.admins,[]);
  assert.equal(chainVerify(granted,{...options,previousChain:revoked}).code,'authority_stale');
  assert.throws(()=>createAuthorityTransition({chain:granted,admins:[identity(target)],issued_at:now+10},outsider),{code:'not_owner'});
  assert.throws(()=>createAuthorityTransition({chain:initial,admins:[identity(outsider),identity(outsider)],issued_at:now+5},owner),{code:'authority_conflict'});
});

test('transfer is incomplete until exact target countersigns owner-authorized proposal',()=>{
  const initial=[genesis()],offer=proposal(initial);
  assert.equal(verifyAuthorityProposal(offer,{...options,chain:initial}).ok,true);
  assert.equal(chainVerify([...initial,offer],options).code,'transfer_acceptance_required');
  assert.throws(()=>createAuthorityAcceptance({proposal:offer,accepted_at:now+20},outsider),{code:'not_transfer_target'});
  const record=accepted(offer),chain=[...initial,record];
  const checked=chainVerify(chain,{...options,previousChain:initial,requireFreshTransfer:true});
  assert.equal(checked.ok,true,checked.code);assert.deepEqual(checked.authority.owner,identity(target));
  const next=createAuthorityTransition({chain,steward:null,issued_at:now+30},target);
  assert.equal(chainVerify([...chain,next],{...options,previousChain:chain}).ok,true);
  assert.throws(()=>createAuthorityTransition({chain,steward:null,issued_at:now+30},owner),{code:'not_owner'});
  assert.equal(chainVerify([...initial,rawSign(record,root)],options).code,'key_mismatch');
});

test('acceptance cannot be transplanted, forged, delayed past expiry, or replayed after cancellation',()=>{
  const initial=[genesis()],offer=proposal(initial),record=accepted(offer);
  const changed=proposal(initial,{steward:null});
  assert.throws(()=>attachAuthorityAcceptance(changed,record.acceptance),{code:'transfer_mismatch'});
  const forged=structuredClone(record);forged.acceptance.payload.accepted_at++;
  assert.equal(chainVerify([...initial,forged],options).code,'invalid_signature');
  assert.throws(()=>createAuthorityAcceptance({proposal:offer,accepted_at:now+3600},target),{code:'transfer_expired'});
  assert.equal(verifyAuthorityProposal(offer,{...options,chain:initial,now:()=>now+3600}).code,'transfer_expired');
  const cancel=createAuthorityTransition({chain:initial,issued_at:now+25},owner),cancelled=[...initial,cancel];
  assert.equal(verifyAuthorityProposal(offer,{...options,chain:cancelled}).code,'authority_stale');
  assert.equal(chainVerify([...initial,record],{...options,previousChain:cancelled}).code,'authority_fork');
});

test('commit checks expiry, while accepted historical transfer remains verifiable after restart',()=>{
  const initial=[genesis()],chain=[...initial,accepted(proposal(initial))];
  const later={...options,now:()=>now+86400};
  assert.equal(chainVerify(chain,later).ok,true);
  assert.equal(chainVerify(chain,{...later,previousChain:initial,requireFreshTransfer:true}).code,'transfer_expired');
  assert.equal(chainVerify(chain,{...later,previousChain:structuredClone(chain),requireFreshTransfer:true}).ok,true);
});

test('chain rejects truncation, altered predecessor, future certificates and unknown fields',()=>{
  const initial=[genesis()],record=accepted(proposal(initial));
  assert.equal(chainVerify([record],options).code,'authority_chain');
  const changed=structuredClone(record);changed.payload.previous=digest({unrelated:true});
  assert.equal(chainVerify([...initial,changed],options).code,'authority_chain');
  const future=createAuthorityTransition({chain:initial,issued_at:now+120},owner);
  assert.equal(chainVerify([...initial,future],options).code,'clock_skew');
  const unknown=structuredClone(initial);unknown[0].payload.private_key='do not accept';
  assert.equal(chainVerify(unknown,options).ok,false);
  assert.throws(()=>proposal(initial,{expires_at:now+10+8*86400}),{code:'transfer_expiry'});
});
