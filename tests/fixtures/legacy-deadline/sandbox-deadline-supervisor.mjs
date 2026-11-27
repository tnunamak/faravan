// Historical retirement behavior from e771097ab; imports point to current shared primitives.
import fs from 'node:fs';
import {sharedWatchServing,completeWatchInventory} from './sandbox-shared-watcher.mjs';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {sandboxDeadlineClock,sandboxDeadlineRemaining} from '../../../lib/sandbox-deadline.mjs';
import path from 'node:path';
import {syncDirectory} from '../../../lib/durable-write.mjs';
import {acquireRecordOwner,createIdOf} from '../../../lib/v1/sandbox-record-owner.mjs';
import {watchProofDirectory} from '../../../lib/v1/sandbox-watch-proofs.mjs';

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
    if(record?.watch_state==='watch_adopted'&&record.watch_ack) {
      if(record.sandbox_id!==payload.sandbox_id||record.sbx_home!==payload.sbx_home||record.deadline_at!==payload.deadline_at||
        JSON.stringify(record.deadline_clock)!==JSON.stringify(payload.deadline_clock))throw Error('Supervisor record binding changed.');
      const opened=fs.fstatSync(fd);if(!opened.isFile())throw Error('Invalid supervisor record.');
      fs.fsyncSync(fd);
      for(let directory=path.dirname(payload.recordPath);;directory=path.dirname(directory)){
        syncDirectory(directory);if(directory===path.dirname(directory))break;
      }
      const named=fs.lstatSync(payload.recordPath);
      if(named.isSymbolicLink()||named.dev!==opened.dev||named.ino!==opened.ino||fs.readFileSync(payload.recordPath,'utf8')!==bytes)throw Error('Supervisor record changed during acknowledgment.');
    }
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
// end the guard's duty: it ends only when a watcher serves the record (`sharedWatchServing`), and a serving watcher holds the
// handle this guard now holds, so none can be serving here.
const stillBound=(row,before,now)=>now!==null&&typeof now==='object'&&now.sandbox_id===row.sandbox_id&&createIdOf(now)!==null&&
  (before===null||createIdOf(now)===createIdOf(before)&&now.watch_generation===before.watch_generation);
// The guard leaves a record only for a watcher that serves it now: acknowledged for the current challenge, alive, ready, holding
// the record and advancing. A watcher that is stopping, stalled or absent, and any other holder of the lock, is not one.
const servedByWatcher=record=>record!==null&&typeof record==='object'&&sharedWatchServing(record)!==null;
// Each command and retry delay is bounded. A never-observed create or failed
// removal keeps the independent obligation alive, with a durable failure report.
export async function superviseSandboxDeadline(row,{clock=sandboxDeadlineClock,
  readRecord=()=>readDeadlineRecord(row),publish=()=>{},observed=false,
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),beforeRemove=async()=>{},fence=record=>takeRecordFence(row,record),run}={}) {
  run??=(args,options)=>new Promise(resolve=>execFile(row.binary,args,{env:{HOME:row.sbx_home},
    timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
  let statusErrorReported=false;
  const report=state=>{try{publish({...state,...(observed?{observed:true}:{})});statusErrorReported=false;return true;}catch{if(!statusErrorReported)console.error('Independent sandbox cleanup status could not be saved.');statusErrorReported=true;return false;}};
  const inventory=completeWatchInventory;
  let failures=0,expired=false;
  for(;;) {
    let record;
    try{record=readRecord();}catch(error){if(error.code==='ENOENT'){report({state:'removed'});return;}record=null;}
    if(servedByWatcher(record)) {
      if(report({state:'watch_adopted',watch_generation:record.watch_generation}))return;
    }
    if(record?.compute_stopped===true&&record.deadline_at===undefined){report({state:'removed'});return;}
    let left=0;
    try{left=sandboxDeadlineRemaining(row,clock());}catch{expired=true;report({state:'failed',failures:++failures,reason:'clock_unavailable'});}
    expired||=left<=0;
    if(!expired&&left>0){await pause(Math.min(left,1000));continue;}
    // `retry` ends an attempt without removing: it falls through to the one wait at the end of the loop, outside the catch below, so a
    // wait that rejects (a stop request) ends the guard instead of being counted as a failed removal.
    try {retry:{
      const before=inventory(await run(['ls','--json'],{timeout:DEADLINE_COMMAND_MS}));
      if(before?.some(item=>item.name===row.sandbox_id)) {
        observed=true;
        // Persist materialization before removing its only inventory evidence.
        // A failed status write must still not leave compute running.
        report({state:'armed'});
      }
      if(before&&!observed&&record?.create_settled!==true) {
        report({state:'failed',failures:++failures,reason:'creation_pending'});
      }else{
        // The listing waited. If a live watcher took this record meanwhile, this guard no longer acts on it.
        try{record=readRecord();}catch(error){if(error.code==='ENOENT'){report({state:'removed'});return;}record=null;}
        if(servedByWatcher(record)){
          if(report({state:'watch_adopted',watch_generation:record.watch_generation}))return;
          failures++;break retry;
        }
        await beforeRemove();
        // The check above is not enough: the watcher can take the record after it. Take the record's owner handle first and look
        // again under it; with the handle held, nobody else adopts, observes or removes this name until it is released.
        let handle=null;
        if(needsFence(row,record)) {
          try{handle=fence(record);}
          catch(error){
            report({state:'failed',failures:++failures,reason:error?.code==='lock_busy'?'record_held':'record_unavailable'});
            break retry;
          }
        }
        try {
          if(handle) {
            let current=null;
            try{current=readRecord();}catch(error){if(error.code==='ENOENT'){report({state:'removed'});return;}}
            if(!stillBound(row,record,current)){
              report({state:'failed',failures:++failures,reason:current===null?'record_unreadable':'record_changed'});
              break retry;
            }
            record=current;
          }
          await run(['rm','--force',row.sandbox_id],{timeout:DEADLINE_COMMAND_MS});
          const after=inventory(await run(['ls','--json'],{timeout:DEADLINE_COMMAND_MS}));
          const absent=after&&!after.some(item=>item.name===row.sandbox_id);
          // Creation can advance while commands wait. Refresh the journal and
          // require materialization evidence before releasing the obligation.
          if(absent) {
            try{record=readRecord();}catch(error){if(error.code==='ENOENT'){report({state:'removed'});return;}record=null;}
            if(record?.create_settled===true){report({state:'removed'});return;}
            if(observed&&report({state:'removed'}))return;
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
export async function startDeadlineSupervisor(payload) {
  const {acquireProcessLockSync}=await import('../../../lib/v1/lock.mjs');
  const {deadlineBinding,deadlineProcessStart,deadlineMaterialized}=await import('../../../lib/sandbox-deadline.mjs');
  const path=await import('node:path');
  if(!/^(?:wf|dl)-[a-f0-9]{16}$/.test(payload.sandbox_id)||!path.isAbsolute(payload.sbx_home)||!path.isAbsolute(payload.binary)||!path.isAbsolute(payload.recordPath)||payload.statusPath!==payload.recordPath+'.deadline')throw Error('Invalid supervisor target.');
  const record=JSON.parse(fs.readFileSync(payload.recordPath,'utf8'));
  if(record.sandbox_id!==payload.sandbox_id||record.sbx_home!==payload.sbx_home||record.deadline_at!==payload.deadline_at||JSON.stringify(record.deadline_clock)!==JSON.stringify(payload.deadline_clock))throw Error('Supervisor record binding changed.');
  const acknowledge=()=>{if(process.connected){process.send({ready:true},()=>{});process.disconnect();}};
  let release;
  try{release=acquireProcessLockSync(payload.statusPath+'.lock');}
  catch(error){
    if(error.code!=='lock_busy')throw error;
    acknowledge();return;
  }
  const identity={binding:deadlineBinding(payload),pid:process.pid,start:await deadlineProcessStart(process.pid)};
  if(!identity.start){release();throw Error('Supervisor identity is unavailable.');}
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
  let command,held=null;
  const stop=()=>{command?.kill('SIGKILL');held?.release();release();process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGHUP',stop);
  try {
    publish({state:'armed'});acknowledge();
    await superviseSandboxDeadline(payload,{publish,observed,fence:record=>held=takeRecordFence(payload,record),run:(args,options)=>new Promise(resolve=>{
      command=execFile(payload.binary,args,{env:{HOME:payload.sbx_home},timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>{command=null;resolve({code:error?1:0,stdout,stderr});});
    })});
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);release();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try{await startDeadlineSupervisor(JSON.parse(process.argv[2]));}catch{process.exitCode=1;}
}
