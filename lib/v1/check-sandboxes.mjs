import {durableJsonAsync} from '../durable-write.mjs';
import {readFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

import {acquireProcessLock} from './lock.mjs';

// Sign-in, identity and safety checks share this lease journal. Job execution
// never does. The backend's cleanup journal owns each check sandbox's compute,
// scratch and policies through that dispatch's own create receipt; this
// journal never derives a name or removes a sandbox itself.
export function createCheckSandboxes({backend,file,now=Date.now,timeoutMs=315000,isClosed=()=>false}) {
  let tail=Promise.resolve(),timer=null,reaping=null,blocker=null;
  const live=new Set();
  // Only a missing file is an empty journal. Valid JSON of the wrong shape is an error, never "no work to reap".
  const read=async()=>{try {const value=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(value))throw Object.assign(new Error('not a list of checks'),{code:'check_journal_invalid'});return value;}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const change=fn=>{
    const work=tail.then(async()=>{
      await mkdir(dirname(file),{recursive:true,mode:0o700});
      const release=await acquireProcessLock(file+'.lock',{timeoutMs:30000});
      try {
        const rows=await fn(await read());
        await durableJsonAsync(file,rows);
      }finally{await release();}
    });
    tail=work.catch(()=>{});return work;
  };
  const forget=id=>change(rows=>rows.filter(row=>row.job_id!==id));
  const checkJob=id=>typeof id==='string'&&/^wf-pull-0{16}-[0-9a-f]{8}$/.test(id);
  const wrapped=new Proxy(backend,{get(target,key){
    if(key==='prepare')return async (job,...args)=>{
      if(isClosed())throw Object.assign(new Error('app_closing'),{code:'app_closing'});
      if(!checkJob(job.job_id))throw Object.assign(new Error('invalid_check_job'),{code:'invalid_check_job'});
      const row={job_id:job.job_id,sandbox_id:null,expires_at:now()+timeoutMs,scratch_dir:null};
      await change(rows=>[...rows.filter(r=>r.job_id!==row.job_id),row]);
      if(isClosed())throw Object.assign(new Error('app_closing'),{code:'app_closing'});
      live.add(row.job_id);
      let handle;
      try {handle=await target.prepare(job,...args);}catch(error){live.delete(row.job_id);throw error;}
      try {await change(rows=>rows.map(r=>r.job_id===row.job_id?{...r,sandbox_id:handle.sandbox_id,scratch_dir:handle.scratch_dir}:r));}
      catch(error){live.delete(row.job_id);await target.destroy(handle).catch(()=>{});throw error;}
      return handle;
    };
    if(key==='destroy')return async handle=>{
      let result;
      try {result=await target.destroy(handle);}finally{live.delete(handle.job_id);}
      if(result?.removed===true&&result.scratch_removed===true)await forget(handle.job_id);
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  async function reap({protectedJobIds=[]}={}) {
    await tail;
    await backend.reconcileOrphanedScratch?.();
    let journal;
    try {journal=await read();}
    catch(error){blocker={reason:'could not read check journal '+file+': '+error.message+'. Faravan left it unchanged; cleanup of earlier checks waits until it is repaired.'};throw error;}
    blocker=null;
    if(!journal.length)return {forgotten:[]};
    const forgotten=[],protectedJobs=new Set(protectedJobIds);
    // An expired lease of a dead flow is forgotten. Its sandbox, if any, stays
    // with the cleanup journal record that reserved its name.
    await change(rows=>rows.filter(row=>{
      const keep=!row||!checkJob(row.job_id)||!Number.isFinite(row.expires_at)||row.expires_at>now()||live.has(row.job_id)||protectedJobs.has(row.job_id);
      if(!keep)forgotten.push(row.job_id);
      return keep;
    }));
    return {forgotten};
  }

  function startReaper({intervalMs=30000,protectedJobIds=()=>[]}={}) {
    if(timer)return;
    timer=setInterval(()=>{
      if(isClosed()||reaping)return;
      reaping=Promise.resolve(protectedJobIds()).then(ids=>reap({protectedJobIds:ids})).catch(()=>{}).finally(()=>{reaping=null;});
    },intervalMs);timer.unref();
  }
  async function close(){clearInterval(timer);timer=null;await reaping;await tail;}
  // The reason a cleanup pass could not read its journal, or null. Shown to the person; the journal itself is never rewritten.
  return {backend:wrapped,reap,startReaper,close,journalBlocker:()=>blocker};
}
