import { canonicalize } from '../protocol/encoding.mjs';

// Faravan version comparison for P22 (versions between the host and members). Dotted numbers only ("0.12.0").
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim().replace(/[-+].*$/, ''));
  const parts = match ? match.slice(1).map(Number) : null;
  return parts?.every(Number.isSafeInteger) ? parts : null;
}
/** true / false when both are readable, null when either is not: an unknown version never counts as new enough or too old. */
export function versionAtLeast(have, need) {
  const a = parseVersion(have), b = parseVersion(need);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export const isVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && parseVersion(value) !== null;
// What a host (the coordinator `faravan host` runs) can do, advertised by GET /capabilities. A new field in a signed job, or a new
// route, is used only when the host lists its capability here and the chosen lender lists its own in the heartbeat.
export const MODEL_EFFORT_PAIRS_CAPABILITY = 'model_effort_pairs_v1';
// A job may ask the lender to choose the model and effort (auto_run_v1). Only a lender that lists this capability is given such a job.
export const AUTO_RUN_CAPABILITY = 'auto_run_v1';
// A job may carry a signed `runRequest` (the models and effort it allows). Only a lender that advertises `accounts` and lists this
// capability is given such a job, and its receipt carries the effective `selection`.
export const RUN_REQUEST_CAPABILITY = 'run_request_v1';
// A job may name its designated member (designated_member_v1): the one member whose store may dispatch it.
// Any online member can accept the signed submission and preserve it; only the designated member's store claims.
export const DESIGNATED_MEMBER_CAPABILITY = 'designated_member_v1';
export const AUTO_RUN_INTENTS = Object.freeze(['cheapest', 'strongest']);
export const HOST_CAPABILITIES = Object.freeze([MODEL_EFFORT_PAIRS_CAPABILITY, AUTO_RUN_CAPABILITY, RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY, 'heartbeat_v1', 'member_profile_v1', 'presence_v1', 'progress_v1', 'leave_v1', 'short_invite_v1', 'network_requirements_v1', 'retention_v1', 'results_v1', 'offers_v1', 'circle_profile_v1', 'member_capabilities_v1','budget_v1','source_manifest_v1','source_project_name_v1','working_directory_v1','filtered_git_v1', 'parent_link_v1', 'frozen_audience_v1', 'invite_revoke_v1', 'enrollment_reject_v1', 'circle_people_v1', 'circle_authority_v1', 'transcript_relay_v1', 'stop_intent_v1', 'offer_decline_v1']);

// These describe what this device can read in a signed roster, independently of lending.
export const MEMBER_CAPABILITIES = Object.freeze(['circle_profile_v1', 'circle_people_v1', 'circle_authority_v1']);

const same = (a,b) => canonicalize(a ?? null) === canonicalize(b ?? null);
const demotesAdmin = (before,after) => before?.role==='co-admin'&&after.role==='member';
// Compatibility is not consent to revocation. Classify removals, blocks and admin demotions;
// signatures, authority and roster validity are still verified by their callers.
function restrictsPeople(old,next) {
  if(!next.members.every(member=>{
    const prior=old.members.find(m=>m.key_id===member.key_id);
    if(!prior)return false;
    // Normal roster signing drops this legacy display field.
    const {person_name,...retained}=prior;
    return same(member,prior)||same(member,retained);
  }))return false;
  if(!next.governance)return !old.governance;
  const owner=next.governance.owner_person;
  const before=old.governance??{version:1,owner_person:owner,state:'active',people:old.members.map(m=>({
    person_id:m.person_id??m.key_id,role:(m.person_id??m.key_id)===owner?'owner':'member',blocked:false}))};
  const after=next.governance;
  if(before.owner_person!==after.owner_person||before.state!==after.state)return false;
  if(!after.people.every(person=>{
    const prior=before.people.find(p=>p.person_id===person.person_id);
    return prior&&(prior.role===person.role||demotesAdmin(prior,person))&&(!prior.blocked||person.blocked);
  }))return false;
  return next.members.length<old.members.length||after.people.some(person=>{
    const prior=before.people.find(p=>p.person_id===person.person_id);
    return person.blocked&&!prior?.blocked||demotesAdmin(prior,person);
  });
}
function restrictsAuthority(old,next) {
  const before=old.authority_chain,after=next.authority_chain;
  if(!before||!after||after.length!==before.length+1||!before.every((record,i)=>same(record,after[i])))return false;
  const prior=before.at(-1).payload,current=after.at(-1).payload;
  return same(prior.owner,current.owner)&&(current.steward===null||same(prior.steward,current.steward))&&
    current.admins.every(admin=>prior.admins.some(key=>same(admin,key)));
}

/** Only semantic changes need an upgrade gate; carrying existing signed fields through renewal does not. */
export function changedMembershipCapabilities(old, next) {
  if (!old) return [];
  const changed = (a, b) => canonicalize(a ?? null) !== canonicalize(b ?? null);
  const required = [];
  if (next.profile && changed(old.profile, next.profile)) required.push('circle_profile_v1');
  const links = roster => roster.members.filter(m => m.person_id !== undefined || m.person_link !== undefined)
    .map(m => ({key_id:m.key_id, person_id:m.person_id ?? null, person_link:m.person_link ?? null}));
  if ((changed(old.governance, next.governance) || changed(links(old), links(next)))&&!restrictsPeople(old,next)) required.push('circle_people_v1');
  if (changed(old.authority_chain, next.authority_chain)&&!restrictsAuthority(old,next)) required.push('circle_authority_v1');
  return required;
}

// Live snapshots are bounded independently from final signed transcript artifacts.
export const TRANSCRIPT_RELAY_LIMITS = Object.freeze({snapshotBytes:65536,requestBytes:262144,
  minIntervalSeconds:2,maxUpdates:2048,retentionSeconds:86400});
