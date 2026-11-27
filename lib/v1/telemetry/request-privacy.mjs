// Request opt-outs outlive report cleanup and process crashes. No report content belongs in this store.
import {existsSync,readFileSync,statSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveJsonFile} from '../../local-state.mjs';
import {syncDirectory} from '../../durable-directory.mjs';
import {acquireProcessLockSync} from '../lock.mjs';
import {ROLLUP_LIMITS} from './rollup.mjs';
const refused=()=>({suppressed:[],refusedUntil:Number.MAX_SAFE_INTEGER});
function valid(state) {
 return state && Number.isSafeInteger(state.refusedUntil) && state.refusedUntil>=0 && Array.isArray(state.suppressed) && state.suppressed.length<=ROLLUP_LIMITS.suppressed &&
  state.suppressed.every(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[0].length<=256&&Number.isSafeInteger(entry[1])&&entry[1]>=0);
}
/** A busy or broken privacy store refuses all job capture; it never evicts a restriction to admit a new one. */
export function createRequestPrivacy({dir,base,now=Date.now,initial}) {
 const file=join(dir,'request-privacy.json'),uncertain=join(dir,'request-privacy-uncertain');let failed=false;
 const empty=()=>({suppressed:[],refusedUntil:0});
 function read() {
  if(failed||existsSync(uncertain))return refused();
  try {
   if(statSync(file).size>512*1024)return refused();
   const state=JSON.parse(readFileSync(file,'utf8'));return valid(state)?state:refused();
  }catch(error){return error.code==='ENOENT'?empty():refused();}
 }
 // An unbound reservation blocks job capture until its digest is known, including after a crash.
 function snapshot() {
  const state=read();
  const pendingUntil=Math.max(0,...state.suppressed.filter(([key])=>key.startsWith('pending:')).map(([,expiry])=>expiry));
  return {suppressed:state.suppressed.filter(([key])=>!key.startsWith('pending:')),refusedUntil:state.refusedUntil,...(pendingUntil>now()?{pendingUntil}:{})};
 }
 function merge(extra,{remove}={}) {
  let release;
  try {
   release=acquireProcessLockSync(join(dir,'request-privacy.lock'),{durable:false});
   const state=read(),marks=new Map(state.suppressed.filter(([key,expiry])=>key!==remove&&expiry>now()));
   state.refusedUntil=Math.max(state.refusedUntil,extra.refusedUntil);
   for(const [key,expiry] of extra.suppressed) {
    if(typeof key!=='string'||key.length>256){state.refusedUntil=Number.MAX_SAFE_INTEGER;continue;}
    if(expiry<=now())continue;
    if(marks.has(key)||marks.size<ROLLUP_LIMITS.suppressed)marks.set(key,Math.max(marks.get(key)??0,expiry));
    else state.refusedUntil=Math.max(state.refusedUntil,expiry);
   }
   saveJsonFile(file,{suppressed:[...marks],refusedUntil:state.refusedUntil},{base});
  }catch {
   failed=true;
   // Separate immutable latch: concurrent failed writers cannot overwrite or shorten one another's refusal.
   // Keep it through report cleanup. Uncertain privacy state requires explicit local repair.
   try{mkdirSync(uncertain,{recursive:true,mode:0o700});syncDirectory(dir);}catch{throw privacyUnavailable();}
  }finally{release?.();}
 }
 if(initial){const state={suppressed:initial.suppressed??[],refusedUntil:initial.refusedUntil??0};merge(valid(state)?state:refused());}
 const mark=key=>({suppressed:[[key,now()+ROLLUP_LIMITS.spanMaxMs]],refusedUntil:0});
 return {snapshot,suppress(key){merge(mark(key));},
  reserve(){const token='pending:'+randomUUID();merge(mark(token));return token;},
  bind(token,key){
   // reserve() already persisted a blanket refusal. If binding fails, that earlier restriction survives the crash.
   try{merge(mark(key),{remove:token});}catch(error){if(error.code!=='telemetry_privacy_unavailable')throw error;}
  }};
}

export const privacyUnavailable=()=>Object.assign(new Error('Could not save your telemetry choice. The job was not sent. Try again when local storage is available.'),{code:'telemetry_privacy_unavailable',status:503});
