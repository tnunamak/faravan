import {safeName} from './helpers.mjs';

export const ROLE_NAMES=Object.freeze({owner:'Owner','co-admin':'Co-admin',member:'Member','borrow-only':'Borrow only','lend-only':'Lend only'});
export const personHref=(circle,id)=>'#/person/'+encodeURIComponent(id)+'/'+encodeURIComponent(circle);
// A person id is verified membership data. Names and local nicknames never merge identities.
export function peopleVM(people=[],members=[],selfKey) {
  return people.map(person=>{
    const computers=person.computers.map(computer=>({...computer,...members.find(member=>member.key_id===computer.key_id)}));
    const self=computers.some(computer=>computer.key_id===selfKey);
    const nickname=computers.map(computer=>safeName(computer.localName)).find(Boolean);
    const avatarName=nickname||safeName(person.name)||computers.map(computer=>safeName(computer.personName)).find(Boolean)||'';
    const name=avatarName|| (self?'You':safeName(computers[0]?.device_name)||'A circle member');
    return {...person,computers,self,name,avatarName,roleName:ROLE_NAMES[person.role]||'Member'};
  });
}
export function personJobs(jobs=[],person) {
  const keys=new Set(person.computers.map(computer=>computer.key_id));
  return {
    asked:jobs.filter(job=>keys.has(job.historyIdentity?.author??job.job?.payload?.author??job.job?.author)),
    ran:jobs.filter(job=>keys.has(job.current_attempt?.holder)||job.attempts?.some(run=>keys.has(run.holder))),
  };
}

export function parseCircleCode(value,code='invalid_person_link') {
  try {const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}
  catch {throw Object.assign(new Error('The shared code is not valid.'),{code});}
}

// Only explicit, timestamped observations can describe current availability.
export function computerAvailability(status, {blocked=false, lifecycle='active', now=Date.now()}={}) {
  if (blocked) return 'Blocked · No new jobs';
  if (lifecycle==='closed') return 'Circle closed · No new jobs';
  if (lifecycle==='archived') return 'Circle archived · No new jobs';
  const checked=typeof status?.checkedAt==='number'?status.checkedAt:Date.parse(status?.checkedAt);
  if (!Number.isFinite(checked)||checked>now) return 'Availability unknown';
  const label=status?.online===false?'Offline':status?.online===true
    ? status.lending===true?'Online · Lending enabled':status.lending===false?'Online · Not lending':'Online · Lending unknown'
    :'Availability unknown';
  const time=new Date(checked).toISOString();
  return status.stale||status.error||now-checked>60000
    ? 'Last known: '+label+' · Updated '+time
    : label+' · Last checked '+time;
}

// Bind the draft to both identities; only clean drafts follow a remote role.
export function roleFormState(draft,binding,current) {
  if (!draft || draft.binding!==binding || draft.value===draft.baseline || draft.value===current) return {binding,baseline:current,value:current,conflict:false};
  return {...draft,conflict:draft.baseline!==current};
}
export function unblockMessage(lifecycle='active') {
  const restriction=lifecycle==='archived'?' This circle is archived: no new jobs.':lifecycle==='closed'?' This circle is closed: no new jobs.':'';
  return "This removes this person's block. Circle lifecycle, role, approval, and lending restrictions still apply."+restriction;
}

// Legacy rosters identify each computer separately. Group matching display names
// only in the list; links and access controls retain the signed person identities.
export function peopleListVM(people=[], members=[], selfKey) {
  const rows=peopleVM(people,members,selfKey), groups=new Map();
  for (const row of rows) {
    const signed=row.computers.some(computer=>computer.person_id);
    const key=signed ? 'id:'+row.personId : 'name:'+(safeName(row.name)||row.personId);
    const prior=groups.get(key);
    if (!prior) {groups.set(key,{...row,computers:[...row.computers]});continue;}
    prior.computers.push(...row.computers);
    prior.self ||= row.self;
    if(row.role==='owner') {prior.role=row.role;prior.roleName=row.roleName;prior.personId=row.personId;}
  }
  return [...groups.values()];
}

const WEEK_MS=7*24*60*60*1000;
export function memberComputerRows(computers, selfKey, now) {
  const names=new Map();
  const rows=computers.map(computer=>{
    const name=safeName(computer.device_name);
    if(name)names.set(name,(names.get(name)??0)+1);
    return {computer,name,self:computer.key_id===selfKey};
  });
  const visible=[],older=[];
  for(const row of rows) {
    const {computer,name,self}=row;
    if(!self&&computer.online===false&&names.get(name)>1) {
      const {last_heartbeat_at,last_poll_at}=computer.presence??{};
      const lastSeen=Math.max(...[last_heartbeat_at,last_poll_at].map(Date.parse).filter(Number.isFinite));
      if(Number.isFinite(lastSeen)&&now-lastSeen>=WEEK_MS) {
        older.push({...row,lastSeen});
        continue;
      }
    }
    visible.push(row);
  }
  return {visible,older};
}
