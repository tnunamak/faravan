// The deadline guard exactly as commit 6a311240e6456866dfde2af1b1429a730855fca7 shipped it (lib/sandbox-deadline-supervisor.mjs).
// Only the import paths changed, so the file runs from this directory. It must keep the name sandbox-deadline-supervisor.mjs:
// the process scan finds a guard by that program name. Used by tests/sandbox-old-guard-darwin.test.mjs as a real older guard.
import fs from 'node:fs';
import {sharedWatchBound,completeWatchInventory} from '../../../lib/v1/sandbox-shared-watcher.mjs';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {sandboxDeadlineClock,sandboxDeadlineRemaining} from '../../../lib/sandbox-deadline.mjs';
import path from 'node:path';
import {syncDirectory} from '../../../lib/durable-write.mjs';

export const DEADLINE_COMMAND_MS=5000;
export const DEADLINE_RETRY_MS=1000;
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
// Each command and retry delay is bounded. A never-observed create or failed
// removal keeps the independent obligation alive, with a durable failure report.
export async function superviseSandboxDeadline(row,{clock=sandboxDeadlineClock,
  readRecord=()=>readDeadlineRecord(row),publish=()=>{},observed=false,
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run}={}) {
  run??=(args,options)=>new Promise(resolve=>execFile(row.binary,args,{env:{HOME:row.sbx_home},
    timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
  let statusErrorReported=false;
  const report=state=>{try{publish({...state,...(observed?{observed:true}:{})});statusErrorReported=false;return true;}catch{if(!statusErrorReported)console.error('Independent sandbox cleanup status could not be saved.');statusErrorReported=true;return false;}};
  const inventory=completeWatchInventory;
  let failures=0,expired=false;
  for(;;) {
    let record;
    try{record=readRecord();}catch(error){if(error.code==='ENOENT'){report({state:'removed'});return;}record=null;}
    if(record?.watch_state==='watch_adopted'&&await sharedWatchBound(record)) {
      if(report({state:'watch_adopted',watch_generation:record.watch_generation}))return;
    }
    if(record?.compute_stopped===true&&record.deadline_at===undefined){report({state:'removed'});return;}
    let left=0;
    try{left=sandboxDeadlineRemaining(row,clock());}catch{expired=true;report({state:'failed',failures:++failures,reason:'clock_unavailable'});}
    expired||=left<=0;
    if(!expired&&left>0){await pause(Math.min(left,1000));continue;}
    try {
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
      }
    }catch{report({state:'failed',failures:++failures,reason:'removal_unproven'});}
    await pause(DEADLINE_RETRY_MS);
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
  let command;
  const stop=()=>{command?.kill('SIGKILL');release();process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGHUP',stop);
  try {
    publish({state:'armed'});acknowledge();
    await superviseSandboxDeadline(payload,{publish,observed,run:(args,options)=>new Promise(resolve=>{
      command=execFile(payload.binary,args,{env:{HOME:payload.sbx_home},timeout:options.timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},(error,stdout,stderr)=>{command=null;resolve({code:error?1:0,stdout,stderr});});
    })});
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);release();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try{await startDeadlineSupervisor(JSON.parse(process.argv[2]));}catch{process.exitCode=1;}
}
