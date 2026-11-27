import fs from 'node:fs';
import {completeWatchInventory} from './v1/sandbox-shared-watcher.mjs';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {sandboxDeadlineClock,sandboxDeadlineRemaining,SANDBOX_GUARD_BUILD_ID,deadlineSuccessorPath} from './sandbox-deadline.mjs';
import {durableWrite} from './durable-write.mjs';
import {persistAbandonedCreateFence} from './sandbox-create-fence.mjs';
import {acquireProcessLockSync} from './v1/lock.mjs';
import path from 'node:path';
import {syncDirectory} from './durable-write.mjs';
import {acquireRecordOwner,createIdOf} from './v1/sandbox-record-owner.mjs';
import {watchProofDirectory,watchProofStore} from './v1/sandbox-watch-proofs.mjs';

export const DEADLINE_COMMAND_MS=5000;
export const DEADLINE_RETRY_MS=1000;
export const DEADLINE_RETRY_MAX_MS=60000;
// A failed attempt is retried after 1 s, then 2 s, doubling to 60 s, so a record that cannot be settled does not keep the host busy.
export const deadlineRetryDelay=failures=>Math.min(DEADLINE_RETRY_MAX_MS,DEADLINE_RETRY_MS*2**Math.min(Math.max(failures-1,0),6));
// Atomic replacement makes a token visible before the writer's directory
// barriers finish. The independent guard establishes durability itself before
// trusting that token, and verifies it still read the exact named record.
function readDeadlineRecord(payload) {
  const fd=fs.openSync(payload.recordPath,'r');
  try {
    const bytes=fs.readFileSync(fd,'utf8'),record=JSON.parse(bytes);
    if(!sameTarget(payload,record))throw Error('Supervisor record binding changed.');
    const opened=fs.fstatSync(fd);if(!opened.isFile())throw Error('Invalid supervisor record.');
    if(record.watch_state==='watch_adopted'&&record.watch_ack) {
      fs.fsyncSync(fd);
      for(let directory=path.dirname(payload.recordPath);;directory=path.dirname(directory)){
        syncDirectory(directory);if(directory===path.dirname(directory))break;
      }
    }
    const named=fs.lstatSync(payload.recordPath);
    if(named.isSymbolicLink()||named.dev!==opened.dev||named.ino!==opened.ino||fs.readFileSync(payload.recordPath,'utf8')!==bytes)throw Error('Supervisor record changed during read.');
    return record;
  }finally{fs.closeSync(fd);}
}
// The guard's removal is fenced by the record's owner handle: the same process lock and epoch the app and the watcher use for
// this name. Taking it never waits (a held record is refused at once), so the guard cannot block on a hand-off, and a hand-off
// never waits on it. The fence covers every record that any actor can bind to a create: a wf- name whose record carries a
// create id (`createIdOf`: its cleanup id, or the create incarnation a hand-off saves) or cannot be read, so its id is unknown.
// A record with no create id can be handed off, adopted, observed or owned by no one: the watcher manifest, the proof store, the
// journal and the app all key on that id. For such a record the guard is the only actor that may remove the name, so there is
// nothing to fence against. A dl- name is never handed off either.
const WATCHABLE=/^wf-[a-f0-9]{16}$/;
const needsFence=(row,record)=>WATCHABLE.test(row.sandbox_id)&&(record===null||createIdOf(record)!==null);
export const takeRecordFence=(row,record)=>acquireRecordOwner({directory:watchProofDirectory(row.sbx_home),name:row.sandbox_id,role:'guard',
  binding:{create_incarnation:createIdOf(record)??undefined,watch_generation:record?.watch_generation}});
// Under the handle: the row is still bound to this guard's sandbox name and to the same create. A `watch_adopted` flag does not
// end the guard's duty, and no watcher serving a record makes the guard leave it: the guard ends only when it proves the removal,
// with exact-binding cessation evidence, never merely because metadata disappeared. The handle it now holds keeps any watcher from acting meanwhile.
const sameTarget=(row,record)=>record!==null&&typeof record==='object'&&!Array.isArray(record)&&
  record.sandbox_id===row.sandbox_id&&record.sbx_home===row.sbx_home&&
  record.deadline_at===row.deadline_at&&JSON.stringify(record.deadline_clock)===JSON.stringify(row.deadline_clock);
const stillBound=(row,original,now)=>sameTarget(row,now)&&createIdOf(now)===createIdOf(original)&&
  now.owner_scope===original.owner_scope;
// Capture once from the verified startup record, never from a later retry.
// Generation belongs to a tenure, not a create: a legitimate handoff may change it.
const startupBinding=(row,record)=>{
  if(!sameTarget(row,record))throw Error('Invalid supervisor startup binding.');
  return Object.freeze({...record,deadline_clock:record.deadline_clock?
    Object.freeze({...record.deadline_clock}):record.deadline_clock});
};
// The proof store holds a `gone` proof bound to exactly this record (name, home, owner, create and watch generation): the name was
// seen present and then seen absent by a listing that started later. That is authoritative evidence that the removal this guard
// exists for is done, and the guard has nothing left to do. Time, a successful command and a settled create are not such evidence.
const provedGone=(row,record,proofStore)=>{
  try {
    return record?.sandbox_id===row.sandbox_id&&record.sbx_home===row.sbx_home&&typeof record.owner_scope==='string'&&typeof record.watch_generation==='string'&&
      proofStore({home:record.sbx_home,owner:record.owner_scope}).gone(record)!==null;
  }catch{return false;}
};
// The guard releases only compute duty. The app still owns data and policy
// cleanup. Its permanent name fence takes over any later inert materialization.
export function settleNeverCreatedDeadline(payload,before,{clock=sandboxDeadlineClock}={}) {
  if(!/^[a-f0-9-]{36}$/.test(before?._cleanupId??'')||!WATCHABLE.test(before.sandbox_id)||
    path.basename(payload.recordPath??'')!==before._cleanupId+'.json')return false;
  let recordLock,nameLock,owner;
  try {
    recordLock=acquireProcessLockSync(payload.recordPath+'.lock');
    nameLock=acquireProcessLockSync(path.join(path.dirname(payload.recordPath),before.sandbox_id+'.scope'));
    if(fs.lstatSync(payload.recordPath).isSymbolicLink())return false;
    const row=readDeadlineRecord(payload);
    if(!stillBound(payload,before,row)||row.owner_scope!==before.owner_scope||row.sbx_home!==payload.sbx_home||
      row.deadline_at!==payload.deadline_at||JSON.stringify(row.deadline_clock)!==JSON.stringify(payload.deadline_clock)||
      row.create!=='dispatched'||row.compute_created!==false||row.create_settled===true||sandboxDeadlineRemaining(payload,clock())>0)return false;
    owner=takeRecordFence(payload,row);owner.assertCurrent();
    persistAbandonedCreateFence(path.dirname(payload.recordPath),row);
    owner.assertCurrent();
    durableWrite(payload.recordPath,JSON.stringify({...row,create_abandoned:true,exec_fenced:true,compute_stopped:true,
      absent_since:Number.isFinite(row.absent_since)?row.absent_since:clock().wall}));
    return true;
  }finally{owner?.release();nameLock?.();recordLock?.();}
}
// Each command and retry delay is bounded. Failed removal or an unsettled
// create keeps retrying; complete absence can settle an expired inert create
// only after its durable name fence is published.
export async function superviseSandboxDeadline(row,{clock=sandboxDeadlineClock,
  readRecord=()=>readDeadlineRecord(row),publish=()=>{},observed=false,originalRecord,
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),beforeRemove=async()=>{},fence=record=>takeRecordFence(row,record),
  settleNeverCreated=record=>settleNeverCreatedDeadline(row,record,{clock}),proofStore=watchProofStore,run}={}) {
  const original=startupBinding(row,originalRecord);
  run??=(args,options)=>new Promise(resolve=>execFile(row.binary,args,{env:{HOME:row.sbx_home},
    timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
  let statusErrorReported=false;
  const report=state=>{try{publish({...state,...(observed?{observed:true}:{})});statusErrorReported=false;return true;}catch{if(!statusErrorReported)console.error('Independent sandbox cleanup status could not be saved.');statusErrorReported=true;return false;}};
  const inventory=completeWatchInventory;
  let failures=0,expired=false;
  for(;;) {
    let record;
    try{record=readRecord();}catch{record=null;}
    if(provedGone(row,original,proofStore)){if(report({state:'removed'}))return;}
    if(!stillBound(row,original,record)){
      report({state:'failed',failures:++failures,reason:record===null?'record_unreadable':'record_changed'});
      await pause(deadlineRetryDelay(failures));continue;
    }
    if(provedGone(row,record,proofStore)){if(report({state:'removed'}))return;}
    let left=0;
    try{left=sandboxDeadlineRemaining(row,clock());}catch{expired=true;report({state:'failed',failures:++failures,reason:'clock_unavailable'});}
    expired||=left<=0;
    if(!expired&&left>0){await pause(Math.min(left,1000));continue;}
    // `retry` ends an attempt without removing: it falls through to the one wait at the end of the loop, outside the catch below, so a
    // wait that rejects (a stop request) ends the guard instead of being counted as a failed removal.
    try {retry:{
      const before=inventory(await run(['ls','--json'],{timeout:DEADLINE_COMMAND_MS}));
      const seen=Boolean(before?.some(item=>item.name===row.sandbox_id));
      if(before&&!observed&&record?.create==='dispatched'&&record.compute_created===false&&record.create_settled!==true&&
        /^[a-f0-9-]{36}$/.test(record._cleanupId??'')&&!before.some(item=>item.name===row.sandbox_id)&&await settleNeverCreated(record)) {
        report({state:'removed'});return;
      }
      if(before&&!seen&&!observed&&record?.create_settled!==true) {
        report({state:'failed',failures:++failures,reason:'creation_pending'});
      }else{
        // The listing waited: read the record again, then take the record's owner handle and look again under it. With the handle
        // held, nobody else adopts, observes or removes this name until it is released.
        try{record=readRecord();}catch{record=null;}
        await beforeRemove();
        if(!stillBound(row,original,record)){
          report({state:'failed',failures:++failures,reason:record===null?'record_unreadable':'record_changed'});break retry;
        }
        let handle=null;
        if(needsFence(row,record)) {
          try{handle=fence(record);}
          catch(error){
            report({state:'failed',failures:++failures,reason:error?.code==='lock_busy'?'record_held':'record_unavailable'});
            break retry;
          }
        }
        try {
          // Every destructive action revalidates the immutable create under the
          // acquired owner tenure; no await separates validation from dispatch.
          let current=null;try{current=readRecord();}catch{}
          handle?.assertCurrent();
          if(!stillBound(row,original,current)||current.watch_generation!==record.watch_generation){
            report({state:'failed',failures:++failures,reason:current===null?'record_unreadable':'record_changed'});
            break retry;
          }
          record=current;
          if(seen){observed=true;report({state:'armed'});}
          await run(['rm','--force',row.sandbox_id],{timeout:DEADLINE_COMMAND_MS});
          const after=inventory(await run(['ls','--json'],{timeout:DEADLINE_COMMAND_MS}));
          const absent=after&&!after.some(item=>item.name===row.sandbox_id);
          // Creation can advance while commands wait. Refresh the journal and
          // require materialization evidence before releasing the obligation.
          if(absent) {
            try{record=readRecord();}catch{record=null;}
            handle?.assertCurrent();
            if(!stillBound(row,original,record)||record.watch_generation!==current.watch_generation){
              report({state:'failed',failures:++failures,reason:record===null?'record_unreadable':'record_changed'});break retry;
            }
            if((record.create_settled===true||observed)&&report({state:'removed'}))return;
          }
          report({state:'failed',failures:++failures,reason:record===null?'record_unreadable':absent?(observed?'observation_not_saved':'creation_pending'):'removal_unproven'});
        }finally{handle?.release();}
      }
    }}catch{report({state:'failed',failures:++failures,reason:'removal_unproven'});}
    await pause(deadlineRetryDelay(failures));
  }
}

// The guard publishes its identity under an exclusive process lock before it
// acknowledges readiness. Recovery discovers that publication even if the app
// died before updating its ordinary cleanup row.
export async function startDeadlineSupervisor(payload,{standby=false}={}) {
  const {acquireProcessLock}=await import('./v1/lock.mjs');
  const {deadlineBinding,deadlineProcessStart,deadlineMaterialized}=await import('./sandbox-deadline.mjs');
  const path=await import('node:path');
  if(!/^(?:wf|dl)-[a-f0-9]{16}$/.test(payload.sandbox_id)||!path.isAbsolute(payload.sbx_home)||!path.isAbsolute(payload.binary)||!path.isAbsolute(payload.recordPath)||payload.statusPath!==payload.recordPath+'.deadline')throw Error('Invalid supervisor target.');
  const record=startupBinding(payload,readDeadlineRecord(payload));
  const acknowledge=waiting=>{if(process.connected){process.send({ready:true,...(waiting?{waiting:true}:{})},()=>{});process.disconnect();}};
  let release,releaseReady,command,held=null;
  const readyPath=deadlineSuccessorPath(payload);
  const identity={binding:deadlineBinding(payload),pid:process.pid,start:await deadlineProcessStart(process.pid),build_id:SANDBOX_GUARD_BUILD_ID};
  if(!identity.start)throw Error('Supervisor identity is unavailable.');
  const clearReady=()=>{
    if(!releaseReady)return;
    try{if(JSON.parse(fs.readFileSync(readyPath,'utf8')).pid===process.pid)fs.unlinkSync(readyPath);}catch{}
    releaseReady();releaseReady=null;
  };
  const stop=()=>{command?.kill('SIGKILL');held?.release();release?.();clearReady();process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGHUP',stop);
  try {
    if(standby) {
      releaseReady=await acquireProcessLock(readyPath+'.lock',{timeoutMs:250});
      durableWrite(readyPath,JSON.stringify({...identity,state:'waiting'}));
      acknowledge(true);
      // This loop is independent of the launching app and IPC connection.
      // Keep waiting while the predecessor is alive; never steal its lock.
      for(;;) {
        try{release=acquireProcessLockSync(payload.statusPath+'.lock');break;}
        catch(error){if(error.code!=='lock_busy')throw error;await new Promise(resolve=>setTimeout(resolve,1000));}
      }
    }else {
      try{release=await acquireProcessLock(payload.statusPath+'.lock',{timeoutMs:250});}
      catch(error){if(error.code!=='lock_busy')throw error;acknowledge();return;}
    }
    // A wait can outlive the cleanup record. Validate again before publishing.
    // The startup snapshot remains authoritative after a standby wait. Missing
    // or changed metadata keeps duty; it must not make the successor exit.
    let current=null;try{current=readDeadlineRecord(payload);}catch{}
    const bound=stillBound(payload,record,current);
    let observed=false;
    try{observed=deadlineMaterialized(payload,JSON.parse(fs.readFileSync(payload.statusPath,'utf8')));}catch{}
    const publish=state=>{
      observed||=state.observed===true;
      const file=payload.statusPath+'.'+process.pid+'.'+Math.random().toString(16).slice(2)+'.tmp',data={...identity,...state,...(observed?{observed:true}:{})};
      try {
        fs.writeFileSync(file,JSON.stringify(data),{mode:0o600,flag:'wx'});
        let fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(file,payload.statusPath);
        fd=fs.openSync(path.dirname(payload.statusPath),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      }catch(error){try{fs.unlinkSync(file);}catch{}throw error;}
    };
    publish(bound?{state:'armed'}:{state:'failed',reason:current===null?'record_unreadable':'record_changed'});
    if(!standby){
      if(bound)acknowledge();
      else if(process.connected){process.send({ready:false,reason:'record_unavailable'},()=>{});process.disconnect();}
    }
    await superviseSandboxDeadline(payload,{publish,observed,originalRecord:record,fence:record=>held=takeRecordFence(payload,record),run:(args,options)=>new Promise(resolve=>{
      command=execFile(payload.binary,args,{env:{HOME:payload.sbx_home},timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>{command=null;resolve({code:error?1:0,stdout,stderr});});
    })});
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);release?.();clearReady();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try{await startDeadlineSupervisor(JSON.parse(process.argv[2]),{standby:process.argv[3]==='--standby'});}catch{console.error('Independent sandbox deadline supervisor startup failed: record or authority unavailable.');process.exitCode=1;}
}
