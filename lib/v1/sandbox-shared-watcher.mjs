import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {durableWrite} from '../durable-write.mjs';
import {deadlineProcessStartSync} from '../sandbox-deadline.mjs';
import {processLockOwners} from './lock.mjs';
import {watchProofStore,watchProofDirectory} from './sandbox-watch-proofs.mjs';
import {ownerLockPath,readOwnership,stalledOwnership,ownershipStatus,handedOff} from './sandbox-record-owner.mjs';

export const WATCH_POLL_MS=5000, WATCH_BACKOFF_MS=60000;
// The build of this watcher code. A watcher keeps running after the app that started it quits or updates, so each watcher
// publishes its build, and a newer app retires one that reports another build (or none, as older apps did).
export const WATCHER_BUILD=(()=>{try{return createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0,16);}catch{return 'unknown';}})();
const validName=name=>/^wf-[a-f0-9]{16}$/.test(name);
const eligible=row=>row?.create==='dispatched'&&row.compute_created===false&&row.create_settled!==true&&row.compute_stopped!==true&&validName(row.sandbox_id)&&
  typeof row._cleanupId==='string'&&row._cleanupId.length>0&&typeof row.owner_scope==='string'&&row.owner_scope.length>0&&path.isAbsolute(row.sbx_home??'');
export function assertWatchExecAllowed(row) {
  if(!row||row.exec_fenced===true||row.watch_state==='watch_adopted')throw Error('This sandbox is reserved for cleanup.');
}
// The journal caller owns BOTH its record and name locks throughout these steps.
// This adapter deliberately does not implement recovery traversal or lock policy.
export async function adoptSandboxWatch(result,{fence,persist,acknowledge}={}) {
  if(['in_progress','foreign_locked'].includes(result?.status))return result;
  const row=result?.row;
  if(!eligible(row)||!['watching','failed'].includes(result?.status))return result;
  // A record already handed off to a watcher that serves it is not handed off again: a new challenge would save a null
  // acknowledgment over a healthy hand-off, rewrite the manifest and reopen the window before the watcher answers.
  if(handedOff(row)&&sharedWatchServing(row)!==null)return {...result,row,status:'watching',admission_released:true};
  let next;
  try {
    fence(row);
    next={...row,exec_fenced:true,watch_state:'watch_adopted',watch_generation:row.watch_generation??randomUUID(),
      create_incarnation:row._cleanupId,watch_challenge:randomUUID(),watch_ack:null,compute_stopped:false};
    persist(next); // Includes the fence and all existing cleanup debts, with fsync barriers.
    const ack=await acknowledge(next);
    if(ack?.watch_generation!==next.watch_generation||ack.challenge!==next.watch_challenge||!path.isAbsolute(ack.binary??''))throw Error('Shared cleanup watcher has not acknowledged this name.');
    next={...next,watch_ack:{challenge:ack.challenge,binary:ack.binary}};persist(next);
    return {...result,row:next,status:'watching',admission_released:true};
  }catch(error){
    // A guard (or any actor that is not the watcher) holds the record: say so, so status can show what the name waits on.
    return {...result,row:next??row,status:'failed',admission_released:false,error:String(error?.message??error),...(error?.code==='lock_busy'?{reason:'record_held'}:{})};
  }
}
export function completeWatchInventory(result) {
  try {
    if(result?.code!==0||result.truncated||result.timedOut||result.killed||result.errorCode||String(result.stderr??'').trim())return null;
    const rows=JSON.parse(result.stdout);
    return Array.isArray(rows)&&rows.every(r=>typeof r?.name==='string')?rows:null;
  }catch{return null;}
}
// With `proofs`, the poller observes and removes each name it watches, one action at a time. It holds no record between actions:
// an action takes the record's owner lock (without waiting), does one bounded thing under it and lets it go, so a guard that is
// past its deadline, or the app, takes the record within the time of one action. An action is a saved sighting, or the listing and
// removal of one name. It removes only a name it (or the app, before the hand-off) first saw absent, records each change of what it
// sees before acting on it, and lists again as the owner before it removes. Every write rechecks that the action's tenure is still
// its own. A record another actor is acting on is skipped and acted on again at a later pass. Without `proofs`, it removes any
// listed manifest name.
export function createWatchPoller({read,run,publish,now=Date.now,proofs}) {
  let failures=0,lastState='',lastWrite=-Infinity,inFlight,stopped=false;
  const queued=new Set(),queue=[],workers=new Set(),items=new Map(),observed=new Map(),claims=new Map(),finished=new Set();
  const keyOf=item=>item.create_incarnation+'/'+item.watch_generation;
  const SKIPPED=Symbol('skipped');
  // One action on one record. A record held by another actor, or one whose ownership cannot be read, is skipped.
  async function act(item,work) {
    let tenure;
    try{tenure=proofs.own(item,{role:'watcher'});}catch{return SKIPPED;}
    try{return await work(tenure);}finally{tenure.release();}
  }
  // Saves one unit of progress on a record, under the lock for that one write.
  const touch=item=>{
    let tenure;
    try{tenure=proofs.own(item,{role:'watcher'});tenure.mark();return true;}catch{return false;}finally{tenure?.release();}
  };
  // Registers every manifest name not yet watched (and each name of a newer create) and saves its first progress, here rather than
  // at the next listing, so an acknowledgment need not wait behind a slow one.
  function claim(names) {
    if(!proofs||stopped)return;
    for(const item of names) {
      const key=keyOf(item),held=claims.get(item.name);
      if(held?.key===key||finished.has(item.name+'/'+key))continue;
      if(held)claims.delete(item.name);
      if(touch(item))claims.set(item.name,{key,item,marked:now()});
      // Otherwise another actor is on the record: leave it and claim it again on a later pass.
    }
  }
  const progress=(claimed,force=false)=>{
    if(!force&&now()-claimed.marked<15000)return;
    if(touch(claimed.item))claimed.marked=now();
  };
  async function remove(name) {
    const item=items.get(name),claimed=claims.get(name);
    if(!proofs||!item)return run(['rm','--force',name],{timeout:5000});
    // Only the watcher of this exact create removes its name.
    if(!claimed||claimed.key!==keyOf(item))return;
    // The manifest may have moved on to a newer create of this name since the listing.
    const fresh=read().names.find(entry=>entry.name===name);
    if(!fresh||fresh.create_incarnation!==item.create_incarnation||fresh.watch_generation!==item.watch_generation||!proofs.mayRemove(item))return;
    await act(item,async tenure=>{
      // The listing that queued this removal is older than this check. Look again as the owner and act only on this listing.
      const listedAt=await proofs.stamp(),current=completeWatchInventory(await run(['ls','--json'],{timeout:5000}));
      if(!current)return;
      const here=current.some(entry=>entry.name===name);
      await proofs.observe(item,here,{listedAt,tenure});
      if(!here)return;
      // The lock is held across the bounded command, and the tenure is checked on both sides of it.
      tenure.assertCurrent();
      await run(['rm','--force',name],{timeout:5000});
      tenure.assertCurrent();
      tenure.mark();claimed.marked=now();
    });
  }
  function pump(){while(!stopped&&workers.size<4&&queue.length){
    const name=queue.shift();
    const work=Promise.resolve().then(()=>remove(name)).catch(()=>{}).finally(()=>{queued.delete(name);workers.delete(work);pump();});
    workers.add(work);
  }}
  async function one() {
    const manifest=read(); // Invalid manifests are fatal, never interpreted as no names.
    const names=manifest.names;
    claim(names);
    // A name whose removal is queued is not observed again meanwhile.
    const watched=new Map();
    if(proofs)for(const item of names) {
      const claimed=claims.get(item.name);
      if(claimed&&claimed.key===keyOf(item)&&!queued.has(item.name))watched.set(item.name,claimed);
    }
    // The listing is stamped (a durable place in the order shared with the app) before it starts: it says nothing about any
    // sighting saved after that. A stamp that cannot be saved means no listing this pass. It holds no record.
    let listedAt,listing;
    try{listedAt=watched.size?await proofs.stamp():undefined;listing=completeWatchInventory(await run(['ls','--json'],{timeout:5000}));}catch{listing=null;}
    const failed=listing===null;failures=failed?failures+1:0;
    if(listing) {
      const present=new Set(listing.map(r=>r.name));
      for(const item of names) {
        const here=present.has(item.name),claimed=proofs?watched.get(item.name):null;
        if(proofs) {
          if(!claimed)continue;
          // The listing is saved before anything is done about it. A name is observed again only when what it shows changes.
          const key=item.create_incarnation+'/'+item.watch_generation+'/'+here;
          if(observed.get(item.name)!==key) {
            // A listing dropped as older than a saved sighting is not remembered: the next listing is observed again.
            const entry=await act(item,async tenure=>{const saved=await proofs.observe(item,here,{listedAt,tenure});if(saved)tenure.mark();return saved;}).catch(()=>null);
            if(entry&&entry!==SKIPPED){observed.set(item.name,key);claimed.marked=now();}else observed.delete(item.name);
            // A name seen gone has nothing left to watch.
            if(entry?.state==='gone'){finished.add(item.name+'/'+keyOf(item));claims.delete(item.name);continue;}
          }else progress(claimed);
        }
        if(!stopped&&here&&!queued.has(item.name)&&(!proofs||claimed&&proofs.mayRemove(item))){items.set(item.name,item);queued.add(item.name);queue.push(item.name);}
      }
      pump();
      // Names stay registered forever. Even successful rm and absence do not erase debts.
    }
    const state={count:names.length,listing_failed:failed,message:failed?`watching ${names.length} names until listing works`:`watching ${names.length} names`};
    const serialized=JSON.stringify(state),at=now();
    if(serialized!==lastState||at-lastWrite>=60000){publish(state);lastState=serialized;lastWrite=at;}
    return failed?Math.min(WATCH_BACKOFF_MS,WATCH_POLL_MS*2**Math.min(failures-1,4)):WATCH_POLL_MS;
  }
  return {tick(){if(!inFlight)inFlight=one().finally(()=>{inFlight=null;});return inFlight;},claim,
    stop(){stopped=true;queue.length=0;},async drain(){while(workers.size)await Promise.all([...workers]);if(stopped)claims.clear();}};
}
function paths(home) {
  if(!path.isAbsolute(home))throw Error('Invalid sandbox HOME.');
  const directory=path.join(home,'.faravan-shared-watch');
  return {directory,manifest:path.join(directory,'names.json'),status:path.join(directory,'status.json'),lock:path.join(directory,'watcher.lock'),writeLock:path.join(directory,'names.lock')};
}
function readManifest(file,home,owner,{missing=false}={}) {
  let data;
  try {if(fs.lstatSync(file).isSymbolicLink())throw Error('Watcher manifest is a symlink.');data=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(missing&&error.code==='ENOENT')return {version:1,home,owner,generation:randomUUID(),names:[]};throw error;}
  if(data?.version!==1||data.home!==home||data.owner!==owner||typeof data.generation!=='string'||!Array.isArray(data.names))throw Error('Watcher ownership is invalid.');
  const seen=new Set();
  for(const item of data.names){
    if(!validName(item?.name)||seen.has(item.name)||typeof item.create_incarnation!=='string'||typeof item.watch_generation!=='string'||item.state!=='watch_adopted')throw Error('Watcher name binding is invalid.');
    seen.add(item.name);
  }
  return data;
}
// Whether the watcher serves this row now: its manifest entry, its status, its process lock, its identity, and the record's own
// ownership (the watcher's last action on this name's record, bound to this create and generation, made progress that has not
// stopped). The watcher holds the record only while it acts, so no live lock on the record is asked for.
// Everything is read in one synchronous pass, so a caller that must act on the answer reads it again right before it acts.
// The status file only says what the watcher published; the ownership record is what authorizes.
export function sharedWatchServing(row,{now=Date.now()}={}) {
  if(!eligible(row)||row.watch_state!=='watch_adopted'||!row.exec_fenced||!row.watch_challenge||row.watch_ack?.challenge!==row.watch_challenge||!path.isAbsolute(row.watch_ack?.binary??''))return null;
  try {
    const p=paths(row.sbx_home);
    // What is on disk now: the watcher's status when it names this row, is serving it and holds its record, or null.
    const read=()=>{
      const manifest=readManifest(p.manifest,row.sbx_home,row.owner_scope);
      const item=manifest.names.find(item=>item.name===row.sandbox_id);
      if(item?.create_incarnation!==row._cleanupId||item?.watch_generation!==row.watch_generation||item?.challenge!==row.watch_challenge)return null;
      const state=JSON.parse(fs.readFileSync(p.status,'utf8')),holders=processLockOwners(p.lock);
      if(!(holders.length===1&&holders[0].pid===state.pid&&state.home===row.sbx_home&&state.owner===row.owner_scope&&
        state.ready===true&&state.generation===manifest.generation&&state.binary===row.watch_ack.binary&&state.build===WATCHER_BUILD&&typeof state.start==='string'))return null;
      return watcherServesRecord(row.sbx_home,item,now)?state:null;
    };
    const state=read();
    if(!state||deadlineProcessStartSync(state.pid)!==state.start)return null;
    // The identity lookup took time. A watcher that is stopping publishes "not ready" and stays alive, with this same identity,
    // while it drains: read everything again, so only a watcher that is still serving counts.
    const again=read();
    return again?.pid===state.pid&&again.start===state.start?again:null;
  }catch{return null;}
}
// The watcher's last action on this name's record was for this create and generation, made progress, and is recent.
function watcherServesRecord(home,item,now) {
  const saved=readOwnership(watchProofDirectory(home),item.name);
  if(saved?.role!=='watcher'||saved.create_incarnation!==item.create_incarnation||saved.watch_generation!==item.watch_generation||saved.progress<1)return null;
  return !stalledOwnership(saved,{now})?saved:null;
}
export async function sharedWatchBound(row) {return sharedWatchServing(row)!==null;}
// A watcher of this exact create acted on the row's record last, and the row carries its acknowledgment. This says only who acted
// last; it does not say the watcher serves (it can be stopping or stalled). `sharedWatchServing` decides that.
export function watcherActedOnRecord(row) {
  // The hand-off counts only once the watcher's acknowledgment is saved in the record.
  return handedOff(row)&&watcherTakenRecord(row);
}
// A watcher of this create and generation acted on the record last, whether or not the row has saved its acknowledgment yet.
function watcherTakenRecord(row) {
  try {
    if(!row?.watch_challenge||!validName(row.sandbox_id)||!path.isAbsolute(row.sbx_home??''))return false;
    const saved=readOwnership(watchProofDirectory(row.sbx_home),row.sandbox_id);
    return saved?.role==='watcher'&&saved.create_incarnation===row._cleanupId&&saved.watch_generation===row.watch_generation;
  }catch{return false;}
}
// One manifest writer at a time, one independent watcher lock per HOME, not per profile/name.
export function createSharedSandboxWatcher({home,owner,binary,build=WATCHER_BUILD,spawnWatcher=spawn,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,readyMs=15000}={}) {
  const p=paths(home);let pending;
  const executable=()=>typeof binary==='function'?binary():binary;
  async function acknowledge(row) {
    if(!eligible(row)||row.sbx_home!==home||row.owner_scope!==owner||row.watch_state!=='watch_adopted')throw Error('Shared watcher row binding changed.');
    const {acquireProcessLockSync,processLockOwners}=await import('./lock.mjs');
    const {deadlineProcessStart}=await import('../sandbox-deadline.mjs');
    fs.mkdirSync(p.directory,{recursive:true,mode:0o700});
    // The empty listing this row recorded before the hand-off is saved with the hand-off, so the watcher never holds a name
    // without the receipt its row already had.
    // The receipt is saved while this process owns the name's record, before the manifest names it. If the watcher already owns
    // the record, the receipt was saved by an earlier request, and nothing is written.
    const proofs=watchProofStore({home,owner});
    if(Number.isFinite(row.absent_since)) {
      let tenure;
      try{tenure=proofs.own(row,{role:'app'});}
      // The receipt already exists, so a record that a watcher of this create is acting on needs nothing written. Any other
      // holder (a guard, the app) is another actor on the record: the hand-off is refused at once, and nothing is published.
      catch(error){if(error?.code!=='lock_busy'||!proofs.mayRemove(row)||!watcherTakenRecord(row))throw error;}
      if(tenure)try{await proofs.receipt(row,row.absent_since,{tenure});}finally{tenure.release();}
    }
    const release=acquireProcessLockSync(p.writeLock);
    let manifest;
    try {
      manifest=readManifest(p.manifest,home,owner,{missing:true});
      const existing=manifest.names.find(item=>item.name===row.sandbox_id);
      if(existing&&(existing.create_incarnation!==row._cleanupId||existing.watch_generation!==row.watch_generation))throw Error('Shared watcher name belongs to another create.');
      const challenge=row.watch_challenge??randomUUID();
      const adopted={name:row.sandbox_id,create_incarnation:row._cleanupId,watch_generation:row.watch_generation,state:'watch_adopted',challenge};
      manifest={...manifest,generation:randomUUID(),names:existing?manifest.names.map(item=>item.name===row.sandbox_id?adopted:item):[...manifest.names,adopted]};
      // Repeat barriers on replay: a previous rename may have succeeded before fsync failed.
      durableWrite(p.manifest,JSON.stringify(manifest));
    }finally{release();}
    const readAck=async()=>{
      try {
        const state=JSON.parse(fs.readFileSync(p.status,'utf8'));
        const current=readManifest(p.manifest,home,owner);
        const expected=manifest.names.find(item=>item.name===row.sandbox_id);
        const observed=current.names.find(item=>item.name===row.sandbox_id);
        if(observed?.challenge!==expected.challenge||observed?.name!==expected.name||observed?.create_incarnation!==expected.create_incarnation||observed?.watch_generation!==expected.watch_generation)return null;
        const holders=processLockOwners(p.lock);
        // The watcher must hold this name's record with progress made after the transfer: a ready flag is not enough.
        if(state.ready===true&&holders.length===1&&holders[0].pid===state.pid&&state.binary===executable()&&state.build===build&&state.home===home&&state.owner===owner&&state.generation===current.generation&&
          typeof state.start==='string'&&await deadlineProcessStart(state.pid)===state.start&&watcherServesRecord(home,observed,Date.now()))
          return {watch_generation:row.watch_generation,challenge:expected.challenge,binary:state.binary};
      }catch{}return null;
    };
    // The previous child may die while this acknowledgment is waiting. Retry
    // ownership after its exit, but launch at most one new child per request.
    let launched=false,retired=false;
    // A live watcher of another build holds the lock and would make a new child exit at once. Once its identity is proven (it holds
    // the lock, its status names its process, and that process still has the start time it published), ask it to stop. It finishes
    // its current work and releases the lock; the manifest, with every name it held, stays on disk for the new watcher.
    const retireOtherBuild=async()=>{
      if(retired)return;
      let state;try{state=JSON.parse(fs.readFileSync(p.status,'utf8'));}catch{return;}
      const holders=processLockOwners(p.lock);
      if(!(state?.ready===true&&state.build!==build&&holders.length===1&&holders[0].pid===state.pid&&state.home===home&&state.owner===owner&&
        typeof state.start==='string'&&await deadlineProcessStart(state.pid)===state.start))return;
      // The identity lookup took time: the holder must still be the same process.
      const again=processLockOwners(p.lock);
      if(!(again.length===1&&again[0].pid===state.pid&&deadlineProcessStartSync(state.pid)===state.start))return;
      retired=true;
      try{process.kill(state.pid,'SIGTERM');}catch{}
    };
    const ensurePending=()=>{
      if(pending||launched)return;
      // Another build's watcher still holds the lock: wait for it to leave instead of starting a child that cannot run.
      if(retired&&processLockOwners(p.lock).length>0)return;
      const resolved=executable();if(!path.isAbsolute(resolved??''))throw Error('Shared cleanup executable is unavailable.');
      const payload={home,owner,binary:resolved,build};
      const child=spawnWatcher(process.execPath,[fileURLToPath(import.meta.url),JSON.stringify(payload)],{detached:true,stdio:'ignore',env:{HOME:home}});
      launched=true;pending=child;child.on('error',()=>{if(pending===child)pending=null;});child.on('exit',()=>{if(pending===child)pending=null;});child.unref?.();
    };
    const until=now()+readyMs;
    do {const ack=await readAck();if(ack)return ack;await retireOtherBuild();ensurePending();await pause(25);}while(now()<until);
    throw Error('Shared cleanup watcher is unavailable.');
  }
  return {acknowledge,status(){
    let count=null;
    try {
      const manifest=readManifest(p.manifest,home,owner);count=manifest.names.length;
      if(fs.lstatSync(p.status).isSymbolicLink())throw Error('Invalid watcher status.');
      const state=JSON.parse(fs.readFileSync(p.status,'utf8')),holders=processLockOwners(p.lock);
      const healthy=state.ready===true&&holders.length===1&&holders[0].pid===state.pid&&state.home===home&&state.owner===owner&&
        state.binary===executable()&&state.build===build&&path.isAbsolute(state.binary??'')&&state.generation===manifest.generation&&
        typeof state.start==='string'&&deadlineProcessStartSync(state.pid)===state.start;
      if(healthy){const listing_failed=state.listing_failed===true;
        // A live watcher whose action on a record has stopped advancing is reported, never replaced. A finished name is not counted.
        const proofs=watchProofStore({home,owner});
        const stalled=manifest.names.filter(item=>!proofs.gone(item)&&ownershipStatus(watchProofDirectory(home),item.name)?.stalled===true).length;
        return {healthy:true,count,listing_failed,message:listing_failed?`watching ${count} names until listing works`:stalled?`watching ${count} names, ${stalled} not advancing`:`watching ${count} names`};}
    }catch{}
    return {healthy:false,count,listing_failed:true,message:count===null?'Shared cleanup watcher is unavailable.':`watching ${count} names until watcher is available`};
  }};
}
export async function startSharedSandboxWatcher({home,owner,binary,build=WATCHER_BUILD,runCommand,signal,refreshMs=100}) {
  if(!path.isAbsolute(binary??'')||typeof owner!=='string'||!owner)throw Error('Invalid shared cleanup target.');
  const p=paths(home);
  const {acquireProcessLock}=await import('./lock.mjs');
  const {deadlineProcessStart}=await import('../sandbox-deadline.mjs');
  // Concurrent admissions can both encounter an unfinished lock selection. Retry
  // that transient contention before giving up; a live singleton is never displaced.
  const release=await acquireProcessLock(p.lock);
  const children=new Set();let stopped=false,stopPublisher=()=>{};
  const stop=()=>{if(stopped)return;stopped=true;try{stopPublisher();}catch{}for(const child of children)child.kill('SIGKILL');};
  process.once('SIGTERM',stop);process.once('SIGHUP',stop);signal?.addEventListener('abort',stop,{once:true});
  try {
    const start=await deadlineProcessStart(process.pid);if(!start)throw Error('Shared watcher identity is unavailable.');
    let current,identity,health={},poll;
    const publish=state=>{health={...health,...state};durableWrite(p.status,JSON.stringify({...health,...identity}));};
    stopPublisher=()=>publish({ready:false});
    const refresh=()=>{
      if(stopped)return current;
      const data=readManifest(p.manifest,home,owner);
      // The watcher registers each name the manifest names (here, not at the next listing), so an acknowledgment need
      // not wait behind a listing. A name another actor is acting on is claimed again on a later refresh.
      poll?.claim(data.names);
      if(current?.generation!==data.generation){current=data;identity={home,owner,binary,build,pid:process.pid,start,generation:data.generation};publish({ready:true,count:data.names.length});}
      return current;
    };
    poll=createWatchPoller({read:refresh,publish,proofs:watchProofStore({home,owner}),run:runCommand??((args,options)=>new Promise(resolve=>{
      if(stopped)return resolve({code:1});
      const child=execFile(binary,args,{env:{HOME:home},timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:2*1024*1024},
        (error,stdout,stderr)=>{children.delete(child);resolve({code:error?1:0,stdout,stderr});});children.add(child);
    }))});
    let refreshError;refresh();
    // Manifest acknowledgments must not wait behind a 500-name removal batch.
    const refreshTimer=setInterval(()=>{try{refresh();}catch(error){refreshError=error;stop();}},refreshMs);
    try {while(!stopped){const started=Date.now(),delay=await poll.tick();const until=started+delay;
      while(!stopped&&Date.now()<until)await new Promise(r=>setTimeout(r,Math.min(100,until-Date.now())));
    }if(refreshError)throw refreshError;}finally{clearInterval(refreshTimer);poll.stop();for(const child of children)child.kill('SIGKILL');await poll.drain();}
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);signal?.removeEventListener('abort',stop);release();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try{await startSharedSandboxWatcher(JSON.parse(process.argv[2]));}catch{process.exitCode=1;}
}
