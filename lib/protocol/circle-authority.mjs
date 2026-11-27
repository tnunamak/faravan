import {sign,verify} from 'node:crypto';
import {canonicalize,strictParse,digest,decodeBase64url,exportPublicKey,importPublicKey,
  fingerprint,guard,need,object} from './encoding.mjs';

// Authority is independent of roster epochs. The root signs only genesis. Each
// following certificate is signed by the preceding owner; a new owner also signs
// an acceptance of that exact proposal. Never put private keys in this chain.
const SCHEMA='faravan.circle-authority.v1';
const ACCEPTANCE='faravan.circle-authority-acceptance.v1';
const MAX_STEPS=128;
const MAX_TRANSFER_SECONDS=7*86400;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^sha256:[0-9a-f]{64}$/;
const integer=n=>need(Number.isSafeInteger(n)&&!Object.is(n,-0)&&n>=0);

function member(value) {
  object(value,['key_id','public_key']);
  need(value.key_id===fingerprint(value.public_key),'key_mismatch');
}
function payload(value) {
  object(value,['schema','circle','coordinator','root_public_key','sequence','previous','owner','steward','admins','issued_at'],['expires_at']);
  need(value.schema===SCHEMA,'unsupported_version');
  need(typeof value.circle==='string'&&uuid.test(value.circle));
  need(typeof value.coordinator==='string'&&value.coordinator.length<=4096);
  const url=new URL(value.coordinator);
  need(value.coordinator===url.origin&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password);
  importPublicKey(value.root_public_key);
  integer(value.sequence);need(value.sequence>=1&&value.sequence<=MAX_STEPS);
  need(value.previous===null||typeof value.previous==='string'&&hash.test(value.previous));
  integer(value.issued_at);member(value.owner);
  if(value.steward!==null) { member(value.steward);need(value.steward.key_id!==value.owner.key_id,'authority_conflict'); }
  need(Array.isArray(value.admins)&&value.admins.length<=10000);
  const seen=new Set();
  for(const admin of value.admins) {
    member(admin);need(!seen.has(admin.key_id),'authority_conflict');seen.add(admin.key_id);
  }
  if(value.expires_at!==undefined) {
    integer(value.expires_at);
    need(value.expires_at>value.issued_at&&value.expires_at-value.issued_at<=MAX_TRANSFER_SECONDS,'transfer_expiry');
  }
}
function bytes(domain,value) { return Buffer.from(`faravan/${domain}/v1\0${digest(value)}`); }
function signature(domain,value,key) {
  return {algorithm:'Ed25519',key_id:fingerprint(key),value:sign(null,bytes(domain,value),key).toString('base64url')};
}
function verifySignature(domain,value,sig,publicKey) {
  object(sig,['algorithm','key_id','value']);
  need(sig.algorithm==='Ed25519'&&sig.key_id===fingerprint(publicKey),'key_mismatch');
  const raw=decodeBase64url(sig.value,64);
  importPublicKey(raw.subarray(0,32).toString('base64url'));
  let scalar=0n;for(let i=63;i>=32;i--)scalar=(scalar<<8n)+BigInt(raw[i]);
  need(scalar<((1n<<252n)+27742317777372353535851937790883648493n),'invalid_signature');
  need(verify(null,bytes(domain,value),importPublicKey(publicKey),raw),'invalid_signature');
}
const proposalOf=record=>({payload:record.payload,signature:record.signature});
function acceptanceValid(record) {
  const accepted=record.acceptance;
  object(accepted,['payload','signature']);
  object(accepted.payload,['schema','circle','proposal_digest','accepted_at','key_id']);
  const a=accepted.payload,p=record.payload;
  need(a.schema===ACCEPTANCE,'unsupported_version');integer(a.accepted_at);
  need(a.circle===p.circle&&a.proposal_digest===digest(proposalOf(record)),'transfer_mismatch');
  need(a.key_id===p.owner.key_id,'key_mismatch');
  need(a.accepted_at>=p.issued_at&&a.accepted_at<p.expires_at,'transfer_expired');
  verifySignature('circle-authority-acceptance',a,accepted.signature,p.owner.public_key);
}

/** Bootstrap authority. Context (circle, coordinator and root pin) must be independently trusted. */
export function createAuthorityGenesis({circle,coordinator,owner,steward=null,admins=[],issued_at},rootPrivateKey) {
  const p={schema:SCHEMA,circle,coordinator,root_public_key:exportPublicKey(rootPrivateKey),sequence:1,
    previous:null,owner,steward,admins,issued_at};
  payload(p);return {payload:p,signature:signature('circle-authority',p,rootPrivateKey)};
}

/** Verify complete history and, when provided, require an exact extension of accepted history.
 * `requireFreshTransfer` belongs only at the coordinator's transaction commit:
 * historical certificates remain valid after their proposal expiry. A client
 * must retain previousChain even when its roster expires or the app restarts.
 */
export function chainVerify(chain,{circle,rootFingerprint,coordinator,previousChain,now,requireFreshTransfer=false}={}) {
  return guard(()=>{
    need(typeof circle==='string'&&uuid.test(circle));need(typeof rootFingerprint==='string'&&hash.test(rootFingerprint));
    need(typeof coordinator==='string');need(Array.isArray(chain)&&chain.length>0&&chain.length<=MAX_STEPS,'authority_chain');
    const records=strictParse(canonicalize(chain));
    const t=typeof now==='function'?now():now;
    if(t!==undefined)integer(t);
    if(requireFreshTransfer)need(t!==undefined);
    let previous=null;
    for(const record of records) {
      object(record,['payload','signature'],['acceptance']);payload(record.payload);
      const p=record.payload;
      need(p.circle===circle,'wrong_circle');need(p.coordinator===coordinator,'wrong_origin');
      need(fingerprint(p.root_public_key)===rootFingerprint,'root_mismatch');
      if(t!==undefined)need(p.issued_at<=t+60,'clock_skew');
      if(!previous) {
        need(p.sequence===1&&p.previous===null&&p.expires_at===undefined&&record.acceptance===undefined,'authority_chain');
        verifySignature('circle-authority',p,record.signature,p.root_public_key);
      } else {
        const prior=previous.payload;
        need(p.sequence===prior.sequence+1&&p.previous===digest(previous),'authority_chain');
        need(p.root_public_key===prior.root_public_key&&p.issued_at>=prior.issued_at,'authority_chain');
        verifySignature('circle-authority',p,record.signature,prior.owner.public_key);
        const transfer=p.owner.key_id!==prior.owner.key_id;
        if(transfer) {
          need(p.expires_at!==undefined&&record.acceptance!==undefined,'transfer_acceptance_required');
          acceptanceValid(record);
          if(t!==undefined)need(record.acceptance.payload.accepted_at<=t+60,'clock_skew');
        } else need(p.expires_at===undefined&&record.acceptance===undefined,'authority_chain');
      }
      previous=record;
    }
    let acceptedLength=0;
    if(previousChain!==undefined) {
      need(Array.isArray(previousChain)&&previousChain.length>0,'authority_chain');
      need(records.length>=previousChain.length,'authority_stale');
      for(let i=0;i<previousChain.length;i++)need(digest(records[i])===digest(previousChain[i]),'authority_fork');
      acceptedLength=previousChain.length;
    }
    if(requireFreshTransfer) for(let i=acceptedLength;i<records.length;i++) {
      const record=records[i];
      if(record.acceptance)need(record.payload.expires_at>t,'transfer_expired');
    }
    const last=records.at(-1),p=last.payload,authority={owner:p.owner,steward:p.steward,admins:p.admins,sequence:p.sequence,digest:digest(last)};
    return {ok:true,authority,digest:authority.digest,chain:records};
  });
}

/** Construct an owner-authorized next state. Changing owner produces a proposal:
 * the target must add acceptance before it becomes a valid chain certificate.
 * An unchanged state is permitted to cancel outstanding proposals by advancing
 * the predecessor fence. Steward keys never authorize authority transitions.
 */
export function createAuthorityTransition({chain,owner,steward,admins,issued_at,expires_at},ownerPrivateKey) {
  const first=chain?.[0]?.payload;
  const verified=chainVerify(chain,{circle:first?.circle,rootFingerprint:first?fingerprint(first.root_public_key):undefined,
    coordinator:first?.coordinator,now:issued_at});
  need(verified.ok,verified.code);
  const previous=chain.at(-1),prior=previous.payload;
  need(fingerprint(ownerPrivateKey)===prior.owner.key_id,'not_owner');
  const p={...prior,sequence:prior.sequence+1,previous:digest(previous),owner:owner===undefined?prior.owner:owner,
    steward:steward===undefined?prior.steward:steward,admins:admins===undefined?prior.admins:admins,issued_at};
  delete p.expires_at;
  if(p.owner.key_id!==prior.owner.key_id) { need(expires_at!==undefined,'transfer_expiry');p.expires_at=expires_at; }
  else need(expires_at===undefined,'transfer_expiry');
  payload(p);need(p.issued_at>=prior.issued_at,'authority_chain');
  return {payload:p,signature:signature('circle-authority',p,ownerPrivateKey)};
}

/** Countersign the complete owner-signed proposal; the caller must display and
 * authenticate the proposal against its current chain before requesting assent.
 */
export function createAuthorityAcceptance({proposal,accepted_at},targetPrivateKey) {
  object(proposal,['payload','signature']);payload(proposal.payload);integer(accepted_at);
  const p=proposal.payload;
  need(p.expires_at!==undefined,'transfer_expiry');need(fingerprint(targetPrivateKey)===p.owner.key_id,'not_transfer_target');
  need(accepted_at>=p.issued_at&&accepted_at<p.expires_at,'transfer_expired');
  const a={schema:ACCEPTANCE,circle:p.circle,proposal_digest:digest(proposal),accepted_at,key_id:p.owner.key_id};
  return {payload:a,signature:signature('circle-authority-acceptance',a,targetPrivateKey)};
}

export function attachAuthorityAcceptance(proposal,acceptance) {
  object(proposal,['payload','signature']);
  const record={...proposal,acceptance};acceptanceValid(record);return record;
}

/** Check a pending proposal against accepted authority before displaying or accepting it. */
export function verifyAuthorityProposal(proposal,{chain,circle,rootFingerprint,coordinator,now}={}) {
  return guard(()=>{
    const checked=chainVerify(chain,{circle,rootFingerprint,coordinator,now});need(checked.ok,checked.code);
    object(proposal,['payload','signature']);payload(proposal.payload);
    const p=proposal.payload,previous=chain.at(-1),prior=previous.payload;
    need(p.circle===circle,'wrong_circle');need(p.coordinator===coordinator,'wrong_origin');
    need(p.root_public_key===prior.root_public_key,'root_mismatch');
    need(p.sequence===prior.sequence+1&&p.previous===digest(previous),'authority_stale');
    need(p.owner.key_id!==prior.owner.key_id&&p.expires_at!==undefined,'transfer_expiry');
    const t=typeof now==='function'?now():now;integer(t);
    need(p.issued_at>=prior.issued_at&&p.issued_at<=t+60,'clock_skew');need(p.expires_at>t,'transfer_expired');
    verifySignature('circle-authority',p,proposal.signature,prior.owner.public_key);
    return {ok:true,proposal,digest:digest(proposal),owner:p.owner};
  });
}
