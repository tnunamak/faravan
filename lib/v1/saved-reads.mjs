import {durableWrite} from '../durable-write.mjs';
// Payload copies are evictable. authority.json is not: a failed physical removal
// must never restore access to a deleted job or a circle's pre-leave copies.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, readdirSync, rmSync, rmdirSync, statSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
export const hostUnreachable=error=>error?.code==='network_error'||[502,503,504].includes(error?.status);
export const jobReadKey=(circle,digest,rest='')=>JSON.stringify([circle??null,digest??null,rest]);
export const jobListKey=circle=>jobReadKey(circle,null,'list');

const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,32);
const unavailable=()=>Object.assign(new Error('Saved read authority is unavailable.'),{code:'saved_reads_unavailable'});
const invalid=()=>Object.assign(new Error('Invalid saved read invalidation.'),{code:'invalid_saved_read_invalidation'});
const name=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,required,optional=[])=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const scopeValid=scope=>scope?.kind==='job'
  ? exact(scope,['kind','digest'],['circle'])&&name(scope.digest)&&(!Object.hasOwn(scope,'circle')||name(scope.circle))
  : scope?.kind==='circle'&&exact(scope,['kind','circle'])&&name(scope.circle);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const effectValid=(scope,effect)=>scope.kind==='job'?effect==='validated_delete_ack':effect==='durable_local_leave';
const sameScope=(a,b)=>scopeValid(a)&&scopeValid(b)&&a.kind===b.kind&&a.digest===b.digest&&
  Object.hasOwn(a,'circle')===Object.hasOwn(b,'circle')&&a.circle===b.circle;
const applied=row=>row.phase==='applied';
const pendingValid=row=>uuid(row?.id)&&scopeValid(row.scope)&&
  (exact(row,['id','scope'])||exact(row,['id','scope','phase','effect'])&&applied(row)&&effectValid(row.scope,row.effect));
// A live instance never accepts rollback of applied evidence it has observed.
// Removal is a forward transition only with the corresponding durable tombstone/floor.
const advancesApplied=(before,after)=>before.pending.filter(applied).every(row=>{
  const next=after.pending.find(next=>next.id===row.id);
  if(next)return applied(next)&&sameScope(next.scope,row.scope)&&next.effect===row.effect;
  return row.scope.kind==='job'?after.jobs.some(job=>job.digest===row.scope.digest&&job.deleted):
    after.circles.some(circle=>circle.circle===row.scope.circle&&
      circle.floor>=before.circles.find(old=>old.circle===row.scope.circle).generation);
});
const unique=(rows,key)=>new Set(rows.map(row=>row[key])).size===rows.length;
function validAuthority(value) {
  if(!exact(value,['version','epoch','revision','lists','jobs','circles','pending'])||value.version!==1||
     !uuid(value.epoch)||!integer(value.revision)||!integer(value.lists)||value.lists>value.revision||
     !['jobs','circles','pending'].every(key=>Array.isArray(value[key])))return false;
  if(!value.jobs.every(row=>exact(row,['digest','generation','deleted'])&&name(row.digest)&&
      integer(row.generation)&&row.generation>0&&row.generation<=value.revision&&typeof row.deleted==='boolean')||!unique(value.jobs,'digest'))return false;
  if(!value.circles.every(row=>exact(row,['circle','generation','floor'])&&name(row.circle)&&
      integer(row.generation)&&row.generation>0&&row.generation<=value.revision&&integer(row.floor)&&row.floor<=row.generation)||!unique(value.circles,'circle'))return false;
  if(!value.pending.every(row=>pendingValid(row)&&
      (row.scope.kind==='job'?value.jobs.some(job=>job.digest===row.scope.digest&&!job.deleted):
        value.circles.some(circle=>circle.circle===row.scope.circle)))||!unique(value.pending,'id'))return false;
  const scopes=value.pending.map(row=>JSON.stringify([row.scope.kind,row.scope.digest??row.scope.circle]));
  return new Set(scopes).size===scopes.length;
}

function createDiskCopies(directory,maxBytes,{remove,persist}) {
  const files=new Map();let bytes=0;
  const folder=(circle,digest)=>join(directory,hash(circle),digest===null?'lists':hash(digest));
  const fileFor=key=>{const [circle,digest]=JSON.parse(key);return join(folder(circle,digest),hash(key)+'.json');};
  const discard=path=>{
    const size=files.get(path);if(size===undefined)return true;
    try{remove(path,{force:true});}catch{return false;}
    files.delete(path);bytes-=size;return true;
  };
  const evict=()=>{while(bytes>maxBytes&&files.size)if(!discard(files.keys().next().value))break;};
  const list=path=>{try{return readdirSync(path);}catch{return [];}};
  const found=[];
  // authority.json is a sibling of the hashed circle folders, never a payload.
  for(const c of list(directory))for(const j of list(join(directory,c)))for(const file of list(join(directory,c,j))){
    if(!file.endsWith('.json'))continue;
    const path=join(directory,c,j,file);
    try{const info=statSync(path);if(info.isFile())found.push([path,info.size,info.mtimeMs]);}catch{}
  }
  found.sort((a,b)=>a[2]-b[2]);for(const [path,size]of found){files.set(path,size);bytes+=size;}
  evict();
  const account=path=>{
    try{const size=statSync(path).size;bytes+=size-(files.get(path)??0);files.set(path,size);}catch{}
  };
  return {
    write(key,row){
      const path=fileFor(key),text=JSON.stringify({key,savedAt:row.savedAt,text:row.text,circleGeneration:row.circleGeneration});
      const size=Buffer.byteLength(text);
      if(size>maxBytes)return;
      while(bytes-(files.get(path)??0)+size>maxBytes){
        const victim=[...files.keys()].find(file=>file!==path);
        if(!victim||!discard(victim))return; // no progress: do not grow past failed removals
      }
      try{persist(path,text);}catch{account(path);evict();return;}
      account(path);evict();
    },
    read(key){
      const path=fileFor(key);if(!files.has(path))return null;
      try{
        const row=JSON.parse(readFileSync(path,'utf8'));
        const generation=row.circleGeneration??0; // legacy copies are generation zero only
        return row.key===key&&typeof row.text==='string'&&typeof row.savedAt==='string'&&integer(generation)
          ? {text:row.text,bytes:Buffer.byteLength(row.text),savedAt:row.savedAt,circleGeneration:generation}:null;
      }catch{return null;}
    },
    forget(circle){
      const target=join(directory,hash(circle));
      for(const path of [...files.keys()])if(path.startsWith(target+'/'))discard(path);
      for(const child of list(target))try{rmdirSync(join(target,child));}catch{}
      try{rmdirSync(target);}catch{}
    },
    forgetEverywhere(digest){
      for(const c of list(directory))for(const child of [hash(digest),'lists']){
        const target=join(directory,c,child);
        for(const path of [...files.keys()])if(path.startsWith(target+'/'))discard(path);
        try{rmdirSync(target);}catch{}
      }
    },
  };
}

/**
 * Synchronous single-writer authority. The app must await beginInvalidation before
 * its remote delete/leave, commit on success, and cancel ONLY a known not_applied
 * refusal. Unknown outcomes retain the token. This cache never retries remote work.
 * Job scope: {kind:'job',digest,circle?}; leave: {kind:'circle',circle}.
 * For restart recovery, callers explicitly attest a validated delete ACK or durable
 * local leave via markInvalidationApplied(id, exactScope, effect). This is not a
 * remote verifier: call only after that effect is known applied, and await success.
 * Applied-only recovery retires local copies; it never retries remote operations.
 * A crash after the effect but before the mark remains unresolved indefinitely.
 * Old compatibility forget* calls cannot close the remote-success/preflight gap.
 * remove/persist are narrow synchronous effect ports; defaults use real filesystem I/O.
 */
export function createSavedReads({maxBytes=32*1024*1024,maxEntryBytes=4*1024*1024,now=Date.now,directory=null,
  maxDiskBytes=64*1024*1024,remove=rmSync,persist=durableWrite}={}) {
  const rows=new Map();let bytes=0,authority=null,available=true;
  const authorityPath=directory?join(directory,'authority.json'):null;
  const fresh=()=>({version:1,epoch:randomUUID(),revision:0,lists:0,jobs:[],circles:[],pending:[]});
  const readAuthority=()=>{
    if(!lstatSync(authorityPath).isFile())throw unavailable();
    const text=readFileSync(authorityPath,'utf8'),value=JSON.parse(text);
    // Our writer has one canonical representation; duplicate JSON keys and
    // ambiguous/foreign formats are not silently repaired into empty history.
    if(!validAuthority(value)||JSON.stringify(value)!==text)throw unavailable();
    if(authority&&(value.epoch!==authority.epoch||value.revision<authority.revision||
       (value.revision===authority.revision&&JSON.stringify(value)!==JSON.stringify(authority))||!advancesApplied(authority,value)))throw unavailable();
    return value;
  };
  if(!directory)authority=fresh();
  else {
    try{authority=readAuthority();}
    catch(error){
      // Missing metadata is fresh only beside NO pre-existing payload/history.
      // Missing metadata next to old copies is unknown, not an empty tombstone set.
      let empty=false;
      if(error?.code==='ENOENT'){
        try{empty=readdirSync(directory).length===0;}catch(cause){empty=cause?.code==='ENOENT';}
      }
      if(empty){try{const next=fresh();persist(authorityPath,JSON.stringify(next));authority=next;}catch{available=false;}}
      else available=false;
    }
  }
  const refresh=()=>{
    if(!available)return false;
    if(directory)try{authority=readAuthority();}catch{available=false;}
    return available;
  };
  // Never evict payloads as a side effect of opening unknown metadata.
  let disk=directory&&available?createDiskCopies(directory,maxDiskBytes,{remove,persist}):null;
  const drop=key=>{const row=rows.get(key);if(row){bytes-=row.bytes;rows.delete(key);}};
  const keep=(key,row)=>{rows.set(key,row);bytes+=row.bytes;while(bytes>maxBytes&&rows.size)drop(rows.keys().next().value);};
  const circleOf=circle=>authority.circles.find(row=>row.circle===circle);
  const jobOf=digest=>authority.jobs.find(row=>row.digest===digest);
  const blocked=(circle,digest)=>jobOf(digest)?.deleted===true||authority.pending.some(({scope})=>
    scope.kind==='circle'?scope.circle===circle:digest===null||scope.digest===digest);
  const ticketFor=(circle,digest)=>JSON.stringify([authority.epoch,circleOf(circle)?.generation??0,
    digest===null?authority.lists:jobOf(digest)?.generation??0]);
  const stamped=(circle,digest)=>Boolean((circleOf(circle)?.generation??0)||(digest===null?authority.lists:jobOf(digest)?.generation));
  const save=next=>{
    if(!integer(next.revision)) {available=false;throw unavailable();}
    try{if(directory)persist(authorityPath,JSON.stringify(next));}
    catch{available=false;throw unavailable();} // even post-rename: do not publish, retry, or overwrite
    authority=next;
  };
  const mutate=change=>{
    if(!refresh())throw unavailable();
    const next=structuredClone(authority);next.revision++;
    change(next);if(!validAuthority(next)){available=false;throw unavailable();}
    save(next);
  };
  const pending=id=>{
    if(!uuid(id))throw invalid();
    const row=authority.pending.find(row=>row.id===id);if(!row)throw invalid();return row;
  };
  const api={
    // Explicitly reload after an ambiguous save. No operation auto-clears the latch.
    reloadInvalidations(){
      if(!directory)return available;
      try{
        authority=readAuthority();
        disk??=createDiskCopies(directory,maxDiskBytes,{remove,persist});
        available=true;return true;
      }catch{available=false;return false;}
    },
    pendingInvalidations(){if(!refresh())throw unavailable();return structuredClone(authority.pending);},
    ticket(key){
      if(!refresh())return null;
      const [circle,digest]=JSON.parse(key);
      return blocked(circle,digest)?null:ticketFor(circle,digest);
    },
    remember(key,value,ticket){
      if(!refresh())return;const [circle,digest]=JSON.parse(key);
      if(blocked(circle,digest)||ticket!==undefined&&ticket!==ticketFor(circle,digest)||
         ticket===undefined&&stamped(circle,digest))return;
      if(Array.isArray(value))value=value.filter(item=>!jobOf(item?.job_digest)?.deleted);
      const text=JSON.stringify(value),size=Buffer.byteLength(text),generation=circleOf(circle)?.generation??0;
      const same=rows.get(key)?.text===text&&rows.get(key)?.circleGeneration===generation;
      drop(key);if(size>maxEntryBytes)return;
      const row={text,bytes:size,savedAt:new Date(now()).toISOString(),circleGeneration:generation};
      keep(key,row);if(!same)disk?.write(key,row);
    },
    recall(key){
      if(!refresh())return null;const [circle,digest]=JSON.parse(key);
      if(blocked(circle,digest))return null;
      let row=rows.get(key);
      if(!row){row=disk?.read(key)??null;if(row)keep(key,row);}
      if(!row)return null;
      if(row.circleGeneration<(circleOf(circle)?.floor??0)||
         row.circleGeneration>(circleOf(circle)?.generation??0)){drop(key);return null;}
      if(rows.has(key)){rows.delete(key);rows.set(key,row);}
      let value;try{value=JSON.parse(row.text);}catch{drop(key);return null;}
      return {value:Array.isArray(value)?value.filter(item=>!jobOf(item?.job_digest)?.deleted):value,savedAt:row.savedAt};
    },
    beginInvalidation(scope){
      if(!scopeValid(scope))throw invalid();
      const id=randomUUID();
      mutate(next=>{
        if(next.pending.some(row=>row.scope.kind===scope.kind&&
           (scope.kind==='job'?row.scope.digest===scope.digest:row.scope.circle===scope.circle)))throw invalid();
        if(scope.kind==='job'){
          let row=next.jobs.find(row=>row.digest===scope.digest);
          if(row?.deleted)throw invalid();
          if(!row){row={digest:scope.digest,generation:0,deleted:false};next.jobs.push(row);}
          row.generation++;next.lists++;
        }else{
          let row=next.circles.find(row=>row.circle===scope.circle);
          if(!row){row={circle:scope.circle,generation:0,floor:0};next.circles.push(row);}
          row.generation++;
        }
        next.pending.push({id,scope:structuredClone(scope)});
      });
      return id; // ACK only after the durable barrier
    },
    markInvalidationApplied(id,scope,effect){
      if(!scopeValid(scope)||!effectValid(scope,effect))throw invalid();
      if(!refresh())throw unavailable();const row=pending(id);
      if(!sameScope(row.scope,scope))throw invalid();
      if(applied(row)){if(row.effect!==effect)throw invalid();return;}
      mutate(next=>{
        const row=next.pending.find(row=>row.id===id);
        row.phase='applied';row.effect=effect;
      }); // return only after the durable barrier; failed writes latch unavailable
    },
    retireAppliedInvalidation(id,scope,effect){
      if(!scopeValid(scope)||!effectValid(scope,effect))throw invalid();
      if(!refresh())throw unavailable();const row=pending(id);
      if(!applied(row)||!sameScope(row.scope,scope)||row.effect!==effect)throw invalid();
      api.commitInvalidation(id);
    },
    recoverAppliedInvalidations(){
      const retired=[];
      // Snapshot validated metadata, never current membership, age or presence.
      for(const row of api.pendingInvalidations().filter(applied)){
        api.retireAppliedInvalidation(row.id,row.scope,row.effect);retired.push(row.id);
      }
      return retired;
    },
    commitInvalidation(id){
      if(!refresh())throw unavailable();const {scope}=pending(id);
      mutate(next=>{
        if(scope.kind==='job')next.jobs.find(row=>row.digest===scope.digest).deleted=true;
        else {const row=next.circles.find(row=>row.circle===scope.circle);row.floor=row.generation;}
        next.pending=next.pending.filter(row=>row.id!==id);
      });
      for(const key of [...rows.keys()]){
        const [circle,digest]=JSON.parse(key);
        if(scope.kind==='job'?digest===scope.digest||digest===null:circle===scope.circle)drop(key);
      }
      if(scope.kind==='job')disk?.forgetEverywhere(scope.digest);else disk?.forget(scope.circle);
      // This is logical invalidation, not a promise of physical erasure.
    },
    cancelInvalidation(id){
      if(!refresh())throw unavailable();if(applied(pending(id)))throw invalid();
      mutate(next=>{next.pending=next.pending.filter(row=>row.id!==id);});
      // Do not rewind generations: prior copies remain readable, old callbacks do not.
    },
    forgetJob(digest,circle){
      if(!refresh())throw unavailable();
      if(jobOf(digest)?.deleted)return;
      const scope={kind:'job',digest,...(circle==null?{}:{circle})};
      api.commitInvalidation(api.beginInvalidation(scope));
    },
    forgetCircle(circle){api.commitInvalidation(api.beginInvalidation({kind:'circle',circle}));},
  };
  return api;
}

export const savedReasonFor=error=>error?.status===429?'busy':'unreachable';
export function markSaved(value,savedAt,savedReason='unreachable') {
  const mark=row=>row&&typeof row==='object'&&!Array.isArray(row)?{...row,savedAt,savedReason}:row;
  return Array.isArray(value)?value.map(mark):mark(value);
}

// Keep coverage outside rows so even a saved empty list has its original time.
export function selectedJobListCoverage(circleId, items, savedAt, reason) {
  const saved = savedAt !== undefined;
  return {
    items: saved ? markSaved(items,savedAt,reason) : items,
    circleCoverage: [saved
      ? {circleId,state:'unavailable',reason,cachedRows:items.length,savedAt}
      : {circleId,state:items.length?'verified':'verified_empty'}],
  };
}
