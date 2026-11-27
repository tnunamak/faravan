import fs from 'node:fs';
import path from 'node:path';
import {durableWrite} from '../durable-write.mjs';
import {acquireProcessLock} from './lock.mjs';
import {acquireRecordOwner} from './sandbox-record-owner.mjs';

// What the shared sandbox watcher and the app have seen of each watched name. A saved cleanup row closes only on a proof that
// names the sandbox, its sandbox home, its owner scope and the exact create (cleanup id) and watch generation of that row.
// Time never produces a proof. Every change is durable before the caller acts on it, so a crash between the proof and the
// cleanup that follows it is finished on restart, and a missing proof leaves the row open.
//
//   seen_absent_at  a complete listing did not show the name. Only then is a name this install's own, so only then may it be removed.
//   seen_present    a complete listing showed the name (removal was authorized or the name was reported). `present_at` is its place
//                   in the shared order below.
//   state 'gone'    the name was seen present and later seen absent: removed, by us or by anyone. `absent_at` is the place of the
//                   listing that showed it absent, taken when that listing was started; it is strictly after `present_at`, or the
//                   record is not valid.
//
// A listing says only what was true when it was taken. Two actors (the app and the watcher, each a process of its own that may
// restart) list at different times and write when their listing ends, so a result can arrive after a newer one. Their clocks
// and in-memory counters cannot say which listing started first, so the order lives in the proof file: one counter, advanced
// under the file's lock and saved before the caller lists (`stamp()`), the same shape as a fencing token. A saved sighting takes
// the next number when it is saved. An empty listing counts against a sighting only when its number is above the sighting's,
// that is, when it started after the sighting was saved. Wall-clock time takes no part.
const VALID_NAME=/^wf-[a-f0-9]{16}$/;
const STATES=new Set(['watching','gone']);
export const watchProofDirectory=home=>path.join(home,'.faravan-shared-watch');

function bind(source) {
  // A cleanup row names its create by its own cleanup id. A row that also carries a different create_incarnation is
  // contradictory, and matches no proof at all, not even one of the other create.
  const own=source?._cleanupId,carried=source?.create_incarnation;
  if(own!==undefined&&carried!==undefined&&own!==carried)return null;
  const binding={name:source?.sandbox_id??source?.name,create_incarnation:own??carried,watch_generation:source?.watch_generation};
  if(!VALID_NAME.test(binding.name??'')||typeof binding.create_incarnation!=='string'||!binding.create_incarnation||
    typeof binding.watch_generation!=='string'||!binding.watch_generation)return null;
  return binding;
}
const finite=Number.isFinite;
// A gone record must show what it claims: the name was seen present, and a listing started strictly later did not show it.
const goneEvidence=entry=>entry.seen_present===true&&finite(entry.present_at)&&finite(entry.absent_at)&&entry.absent_at>entry.present_at&&finite(entry.gone_at);
// The highest number handed out so far. A file saved before the counter existed holds numbers from the wall clock; they count too,
// so a number taken now is above every saved one.
const ORDER_FIELDS=['present_at','absent_at','gone_at'];
const highest=data=>{
  let top=Number.isSafeInteger(data.seq)?data.seq:0;
  for(const entry of Object.values(data.proofs))for(const field of ORDER_FIELDS)if(finite(entry[field])&&entry[field]>top)top=entry[field];
  return top;
};

export function watchProofStore({home,owner}={}) {
  if(typeof home!=='string'||!path.isAbsolute(home)||typeof owner!=='string'||!owner)throw Error('Invalid watch proof target.');
  const directory=watchProofDirectory(home),file=path.join(directory,'proofs.json'),lock=path.join(directory,'proofs.lock');
  const empty=()=>({version:1,home,owner,proofs:{}});
  function read() {
    let data;
    try {
      if(fs.lstatSync(file).isSymbolicLink())throw Error('Watch proofs are a symlink.');
      data=JSON.parse(fs.readFileSync(file,'utf8'));
    }catch(error){if(error.code==='ENOENT')return empty();throw error;}
    if(data?.version!==1||data.home!==home||data.owner!==owner||!data.proofs||typeof data.proofs!=='object'||Array.isArray(data.proofs)||
      data.seq!==undefined&&!(Number.isSafeInteger(data.seq)&&data.seq>=0))throw Error('Watch proofs are invalid.');
    for(const [name,entry] of Object.entries(data.proofs)) {
      if(!VALID_NAME.test(name)||entry?.name!==name||!STATES.has(entry.state)||typeof entry.create_incarnation!=='string'||typeof entry.watch_generation!=='string')
        throw Error('Watch proofs are invalid.');
      // A gone record without its evidence is not a proof. The file is left as it is, for diagnosis, and nothing is closed on it.
      if(entry.state==='gone'&&!goneEvidence(entry))throw Error('Watch proofs are invalid.');
    }
    return data;
  }
  const same=(entry,binding)=>entry?.name===binding.name&&entry.create_incarnation===binding.create_incarnation&&entry.watch_generation===binding.watch_generation;
  // The saved entry for exactly this row or manifest item, or null. An entry of another create or generation never matches.
  function matching(source) {
    const binding=bind(source);
    if(!binding)return null;
    if(source?.sbx_home!==undefined&&source.sbx_home!==home||source?.owner_scope!==undefined&&source.owner_scope!==owner)return null;
    try {const entry=read().proofs[binding.name];return same(entry,binding)?entry:null;}catch{return null;}
  }
  // The next place in the shared order, durable before it is returned. Take it before a listing starts and pass it to `observe`.
  async function stamp() {
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const release=await acquireProcessLock(lock,{timeoutMs:5000});
    try {
      const data=read(),seq=highest(data)+1;
      durableWrite(file,JSON.stringify({...data,seq}));
      return seq;
    }finally{release();}
  }
  // Only the record's owner writes. `tenure` is the owner's (see `own`); without one, this call takes the record for itself, writes
  // and lets it go, and a record another actor owns refuses the write (lock_busy). Under the proof lock, a tenure that has ended or
  // lost its epoch refuses too (owner_lost), so a late result from an earlier owner writes nothing.
  async function owned(source,tenure,write) {
    const binding=bind(source);
    if(!binding||source?.sbx_home!==undefined&&source.sbx_home!==home||source?.owner_scope!==undefined&&source.owner_scope!==owner)
      throw Error('Watch proof binding is invalid.');
    if(tenure&&(tenure.name!==binding.name||tenure.binding.create_incarnation!==binding.create_incarnation||tenure.binding.watch_generation!==binding.watch_generation))
      throw Error('Watch proof binding is invalid.');
    const own=tenure??own_(source,{role:'app'});
    try {
      fs.mkdirSync(directory,{recursive:true,mode:0o700});
      const release=await acquireProcessLock(lock,{timeoutMs:5000});
      try {own.assertCurrent();return write(binding,own);}finally{release();}
    }finally{if(!tenure)own.release();}
  }
  // Records one complete listing for one name. The entry is durable before this returns, and it is the only thing that
  // authorizes a removal (`seen_absent_at`) or a close (`state: 'gone'`). `listedAt` is the `stamp()` taken before the
  // listing was started. Returns the entry, or null when the listing is older than a sighting already saved and was dropped.
  function observe(source,present,{listedAt,tenure}={}) {
    return owned(source,tenure,binding=>{
      const data=read(),current=same(data.proofs[binding.name],binding)?data.proofs[binding.name]:null;
      let next=current??{...binding,state:'watching'},seq=data.seq;
      if(next.state!=='gone') {
        const at=seq=highest(data)+1;
        if(present)next={...next,seen_present:true,present_at:at};
        else if(next.seen_present===true) {
          // An empty listing that was started before the sighting says nothing about the time after it.
          if(finite(listedAt)&&!(listedAt>next.present_at))return null;
          next={...next,state:'gone',absent_at:finite(listedAt)?listedAt:at,gone_at:at,scratch_cleanup:'pending',policy_cleanup:'pending'};
        }
        else if(!finite(next.seen_absent_at))next={...next,seen_absent_at:at};
      }
      if(!current||JSON.stringify(current)!==JSON.stringify(next))
        durableWrite(file,JSON.stringify({...data,...(seq===undefined?{}:{seq}),proofs:{...data.proofs,[binding.name]:next}}));
      return next;
    });
  }
  // The empty listing this exact cleanup row already recorded before it was handed over. It is that row's create receipt:
  // a name that appears late is then its own to remove. Only a row's own, finite receipt is taken; nothing is inferred.
  function receipt(source,absentAt,{tenure}={}) {
    if(!finite(absentAt))throw Error('Watch proof binding is invalid.');
    return owned(source,tenure,binding=>{
      const data=read(),current=same(data.proofs[binding.name],binding)?data.proofs[binding.name]:null;
      if(current?.state==='gone'||finite(current?.seen_absent_at))return current;
      const next={...(current??{...binding,state:'watching'}),seen_absent_at:absentAt};
      durableWrite(file,JSON.stringify({...data,proofs:{...data.proofs,[binding.name]:next}}));
      return next;
    });
  }
  // Takes this name's record for a role, as its owner for as long as the caller holds it. Throws lock_busy while another holds it.
  function own_(source,{role}) {
    const binding=bind(source);
    if(!binding||source?.sbx_home!==undefined&&source.sbx_home!==home||source?.owner_scope!==undefined&&source.owner_scope!==owner)
      throw Error('Watch proof binding is invalid.');
    return acquireRecordOwner({directory,name:binding.name,role,binding:{create_incarnation:binding.create_incarnation,watch_generation:binding.watch_generation}});
  }
  return {directory,matching,observe,receipt,stamp,own:own_,
    // A name may be removed only after it was seen absent first: before that, a listed sandbox has no create receipt.
    mayRemove:source=>{const entry=matching(source);return Number.isFinite(entry?.seen_absent_at);},
    // The state of the proof that closes a row, or null.
    gone:source=>matching(source)?.state==='gone'?matching(source):null};
}
