import {chainVerify} from './circle-authority.mjs';
import {ProtocolError, fingerprint, canonicalize} from './encoding.mjs';

export const CIRCLE_ROLES=['owner','co-admin','member','borrow-only','lend-only'];
export const personIdFor=member=>member.person_id??member.key_id;
/** Signed roster policy restricts new work; it never approves execution for a lender. */
export function circleWorkAllowed(roster,keyId,direction) {
  const member=roster.members.find(m=>m.key_id===keyId);
  if(!member)return false;
  if(!roster.governance)return true;
  const g=roster.governance,person=g.people.find(p=>p.person_id===personIdFor(member));
  return g.state==='active'&&Boolean(person)&&!person.blocked&&
    !(direction==='borrow'&&person.role==='lend-only')&&!(direction==='lend'&&person.role==='borrow-only');
}
export function rosterPeople(roster,ownerKeyId) {
  const grouped=new Map();
  for(const m of roster.members) {
    const id=personIdFor(m),signed=roster.governance?.people.find(p=>p.person_id===id);
    if(!grouped.has(id))grouped.set(id,{personId:id,name:null,role:signed?.role??(id===ownerKeyId?'owner':'member'),blocked:signed?.blocked??false,computers:[]});
    grouped.get(id).computers.push(structuredClone(m));
  }
  return [...grouped.values()];
}
export function verifyPeople(roster,verifyEnvelope) {
  const need=(condition,code='invalid_request')=>{if(!condition)throw new ProtocolError(code);};
  const authority=roster.authority_chain?chainVerify(roster.authority_chain,{circle:roster.circle,rootFingerprint:fingerprint(roster.root_public_key),coordinator:roster.coordinator}):null;
  if(authority){
    need(authority.ok,authority.code);
    for(const key of [authority.authority.owner,authority.authority.steward,...authority.authority.admins].filter(Boolean))need(roster.members.some(m=>m.key_id===key.key_id),'forbidden');
  }
  if(!roster.governance){need(!authority?.authority.admins.length);need(roster.members.every(m=>m.person_id===undefined&&m.person_link===undefined));return;}
  const g=roster.governance;
  if(authority){
    const a=authority.authority,owner=roster.members.find(m=>m.key_id===a.owner.key_id);need(g.owner_person===personIdFor(owner),'forbidden');
    for(const key of [a.owner,a.steward,...a.admins].filter(Boolean)){const m=roster.members.find(m=>m.key_id===key.key_id);need(!g.people.find(p=>p.person_id===personIdFor(m))?.blocked,'forbidden');}
    for(const m of roster.members){const person=g.people.find(p=>p.person_id===personIdFor(m));need((person?.role==='co-admin'&&!person.blocked)===a.admins.some(k=>k.key_id===m.key_id),'forbidden');}
  }
  const ids=new Set(roster.members.map(personIdFor));
  need(g.people.length===ids.size&&new Set(g.people.map(p=>p.person_id)).size===ids.size);
  need(g.people.every(p=>ids.has(p.person_id)));
  need(g.people.filter(p=>p.role==='owner').length===1&&g.people.some(p=>p.role==='owner'&&p.person_id===g.owner_person&&!p.blocked));
  for(const m of roster.members) {
    if(personIdFor(m)===m.key_id){need(m.person_link===undefined);continue;}
    const pair=m.person_link;need(pair&&Object.keys(pair).length===2);
    const a=pair.person_proof,b=pair.device_proof,fields=a?.payload;
    need(fields&&fields.circle===roster.circle&&fields.person_id===m.person_id&&fields.device_key_id===m.key_id);
    need(fields.device_public_key===m.public_key&&fingerprint(fields.person_public_key)===m.person_id,'key_mismatch');
    need(b?.payload&&canonicalize(a.payload)===canonicalize(b.payload));
    const av=verifyEnvelope('person-link',a,fields.person_public_key),bv=verifyEnvelope('person-link',b,fields.device_public_key);
    need(av.ok,av.code);need(bv.ok,bv.code);
  }
}

/** Verify restrictions on a delegate against the independently retained prior roster. */
export function verifyGovernanceTransition(previous,next,signer,{requireCurrentLinkEpoch=false}={}) {
  const need=(condition)=>{if(!condition)throw new ProtocolError('forbidden');};
  if(!previous)return;
  for(const member of next.members){
    const before=previous.members.find(m=>m.key_id===member.key_id);
    if(member.person_link&&(!before||canonicalize(before.person_link??null)!==canonicalize(member.person_link))){
      const epoch=member.person_link.person_proof.payload.roster_epoch;
      need(Number.isSafeInteger(epoch)&&epoch>=previous.epoch&&epoch<next.epoch);
      if(requireCurrentLinkEpoch)need(epoch===previous.epoch);
    }
  }
  if(previous.governance){need(next.governance);if(previous.governance.state==='closed')need(next.governance.state==='closed');}
  if(!previous.authority_chain)return;
  need(next.authority_chain);
  const authority=previous.authority_chain.at(-1).payload;
  // A chain update authorizes its explicit authority fields, not arbitrary roster policy edits.
  if(signer===authority.owner.key_id||signer===next.authority_chain.at(-1).payload.owner.key_id)return;
  need((previous.governance?.owner_person??null)===(next.governance?.owner_person??null));
  if(next.governance?.state==='closed')need(previous.governance?.state==='closed');
  for(const p of next.governance?.people??[]){const before=previous.governance?.people.find(x=>x.person_id===p.person_id);need(before?before.role===p.role:p.role==='member');}
  for(const member of next.members){
    const before=previous.members.find(m=>m.key_id===member.key_id);
    if(!before)continue;
    const oldPolicy=previous.governance?.people.find(p=>p.person_id===personIdFor(before));
    const newPolicy=next.governance?.people.find(p=>p.person_id===personIdFor(member));
    need((oldPolicy?.role??'member')===(newPolicy?.role??'member'));
    if(oldPolicy?.blocked)need(newPolicy?.blocked);
  }
  for(const key of [authority.owner,authority.steward,...authority.admins].filter(Boolean)){
    const before=previous.members.find(m=>m.key_id===key.key_id),after=next.members.find(m=>m.key_id===key.key_id);
    need(before&&after&&personIdFor(before)===personIdFor(after));
  }
}
