import {durableJsonAsync} from '../durable-write.mjs';
// Local audit receipts. Display names identify the local owner configuration, not a verified person.
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {acquireProcessLock} from './lock.mjs';

const MAX_EVENTS=10000,MAX_BYTES=4*1024*1024;
// Queued writes per decisions file, shared by every log this process opens on it.
const writes=new Map();
export function createDecisionLog(directory) {
  const file=join(directory,'decisions.json');
  async function snapshot() {
    try {
      const value=JSON.parse(await readFile(file,'utf8'));
      if(value.version!==1||!Array.isArray(value.events))throw new Error('Invalid decision log');
      return value;
    } catch(error) {if(error.code==='ENOENT')return {version:1,events:[],truncated:false};throw error;}
  }
  return {snapshot,async record(input) {
    const row=structuredClone(input);
    const validDecider=row.surface==='phone'?
      typeof row.decider?.sessionId==='string'&&Boolean(row.decider.sessionId)&&typeof row.decider.label==='string'&&Boolean(row.owner?.deviceKey):Boolean(row.decider?.deviceKey);
    if(!row.id||!validDecider||!Number.isSafeInteger(row.at)||
      !['job','standing_rule','lending_mode'].includes(row.kind)||!['accept','decline','skip','create','update','revoke'].includes(row.decision))
      throw new Error('Invalid decision receipt');
    if(Buffer.byteLength(JSON.stringify({version:1,events:[row],truncated:false}))>MAX_BYTES)
      throw new Error('Decision receipt exceeds the local audit limit');
    await mkdir(directory,{recursive:true,mode:0o700});
    // Writers in this process queue here, so only another process ever waits on the lock.
    const run=(writes.get(file)??Promise.resolve()).catch(()=>{}).then(()=>append(row));
    writes.set(file,run);
    const finished=()=>{if(writes.get(file)===run)writes.delete(file);};
    run.then(finished,finished);
    return run;
  }};
  async function append(row) {
    // The holder fsyncs the file and its parent, which can outlast the default 250 ms on a busy disk.
    const release=await acquireProcessLock(join(directory,'decisions.lock'),{timeoutMs:3000});
    try {
      const log=await snapshot();
      if(log.events.some(event=>event.id===row.id))return false;
      log.events.push(row);
      while(log.events.length>MAX_EVENTS||Buffer.byteLength(JSON.stringify(log))>MAX_BYTES){log.events.shift();log.truncated=true;}
      await durableJsonAsync(file,log);
      return true;
    }finally{await release();}
  }
}
