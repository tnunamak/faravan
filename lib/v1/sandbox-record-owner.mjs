import fs from 'node:fs';
import path from 'node:path';
import {durableWrite} from '../durable-write.mjs';
import {acquireProcessLockSync,processLockOwners} from './lock.mjs';

// One owner per cleanup record on one host. The owner is whoever holds the record's process lock (lib/v1/lock.mjs): a dead
// holder is reclaimed, a live or paused one is never displaced, and no time expires a tenure. The shared watcher and the guard hold
// it for one bounded action at a time, never for a lifetime. Each acquisition saves a higher
// epoch under the lock, and every write rechecks that the lock is still held and the saved epoch is still its own, so a late
// result from an earlier owner cannot write. A holder also saves a progress count under the lock; a watcher whose last action
// is old is reported as stalled, which is a diagnostic and never a permission to take the record.
export const STALL_MS=180000;
const NAME=/^wf-[a-f0-9]{16}$/;
const ROLES=new Set(['app','watcher','guard']);
// The create a record belongs to: its cleanup id, or the create incarnation a hand-off saved with it. A record with neither names no
// create, so no manifest, proof or owner handle can bind to it and it can never be handed off. Null for such a record.
export const createIdOf=record=>{const id=record?._cleanupId??record?.create_incarnation;return typeof id==='string'&&id.length>0?id:null;};
// A record counts as handed off to the shared watcher only when it names a create and carries the watcher's acknowledgment of its
// current challenge. A `watch_adopted` flag without that acknowledgment is a hand-off that has not finished: the record's own guard
// is still its only protector.
export const handedOff=record=>record?.watch_state==='watch_adopted'&&createIdOf(record)!==null&&
  typeof record.watch_challenge==='string'&&record.watch_challenge.length>0&&record.watch_ack?.challenge===record.watch_challenge;
export const ownerLockPath=(directory,name)=>path.join(directory,'act-'+name);
const ownerFile=(directory,name)=>path.join(directory,'own-'+name+'.json');
const lost=()=>Object.assign(new Error('This record has another owner now.'),{code:'owner_lost'});

// The saved ownership of one name, or null when none was ever taken. An unreadable or invalid file throws and is never rewritten.
export function readOwnership(directory,name) {
  if(!NAME.test(name??''))throw Error('Invalid sandbox name.');
  const file=ownerFile(directory,name);
  let data;
  try {if(fs.lstatSync(file).isSymbolicLink())throw Error('Record ownership is a symlink.');data=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(data?.version!==1||data.name!==name||!ROLES.has(data.role)||!Number.isSafeInteger(data.epoch)||data.epoch<1||
    !Number.isSafeInteger(data.progress)||data.progress<0)throw Error('Record ownership is invalid.');
  return data;
}

// Takes the record or throws lock_busy at once. `binding` (cleanup id and watch generation) is saved with the epoch.
export function acquireRecordOwner({directory,name,role,binding={},now=Date.now}) {
  if(!NAME.test(name??'')||!ROLES.has(role))throw Error('Invalid record owner.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const release=acquireProcessLockSync(ownerLockPath(directory,name));
  let released=false,listing=false,state;
  try {
    const previous=readOwnership(directory,name);
    state={version:1,name,role,epoch:(previous?.epoch??0)+1,...binding,progress:0,progress_at:now()};
    durableWrite(ownerFile(directory,name),JSON.stringify(state));
  }catch(error){release();throw error;}
  const self={name,role,epoch:state.epoch,binding,
    // Throws owner_lost once this tenure has ended or the saved epoch is another's.
    assertCurrent() {
      if(released)throw lost();
      let saved;
      try{saved=readOwnership(directory,name);}catch{throw lost();}
      if(saved?.epoch!==state.epoch||saved.role!==role)throw lost();
      return saved;
    },
    mark() {
      const saved=self.assertCurrent();
      state={...saved,progress:saved.progress+1,progress_at:now()};
      durableWrite(ownerFile(directory,name),JSON.stringify(state));
      return state.progress;
    },
    // At most one listing of this record is in flight in a tenure. Returns the function that ends it.
    beginListing() {
      self.assertCurrent();
      if(listing)throw Object.assign(Error('A listing of this record is already in flight.'),{code:'listing_in_flight'});
      listing=true;
      return ()=>{listing=false;};
    },
    release() {if(released)return;released=true;release();}};
  return self;
}

export const stalledOwnership=(saved,{now=Date.now(),after=STALL_MS}={})=>!Number.isFinite(saved?.progress_at)||now-saved.progress_at>after;

// What status shows about one name: its saved owner (the last actor to act on it), whether that actor's lock is live now, and
// whether the watcher's last action on it has stopped advancing. `held` is false when no actor is in the middle of an action and null
// when the lock cannot be read. Nothing here lets another actor take the record: an actor holds it only for one bounded action.
export function ownershipStatus(directory,name,{now=Date.now()}={}) {
  let saved;
  try{saved=readOwnership(directory,name);}catch{return {invalid:true};}
  if(!saved)return null;
  let holders=null;
  try{holders=processLockOwners(ownerLockPath(directory,name));}catch{/* Unknown identity stays unknown. */}
  return {role:saved.role,epoch:saved.epoch,progress:saved.progress,held:holders?holders.length>0:null,
    stalled:saved.role==='watcher'&&stalledOwnership(saved,{now})};
}
