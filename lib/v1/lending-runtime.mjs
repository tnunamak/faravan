import {machineCapacity} from './lending-policy.mjs';
import {totalmem,availableParallelism} from 'node:os';
import {DIALS,EXPLAINER,LIMIT} from './lending-status-copy.mjs';
import {DEFAULT_PROTECTION,PROTECTION_POSITIONS} from './lending-objective.mjs';
export function createLendingRuntime({settings,readOverride,statusRead,refreshRead=readOverride??statusRead,accountStatus=async()=>[],presence,now=Date.now}) {
  async function readings(key,options={}) {try{return await (readOverride??statusRead)?.(key,options)??null;}catch{return null;}}
  async function view() {
    const saved=settings(),position=saved.limits?.lendingPolicy?.protectionPosition??DEFAULT_PROTECTION;
    const accounts=await accountStatus();
    const dial={position,...PROTECTION_POSITIONS[position],...(DIALS[position]??DIALS[DEFAULT_PROTECTION]),explainer:EXPLAINER,limit:LIMIT};
    return {accounts,dial,machineCapacity:machineCapacity({ramBytes:totalmem(),cpus:availableParallelism(),memoryMb:4096,cpu:2}),watchOnly:false,shadow:[]};
  }
  async function refreshCapacity(accountKey,{signal}={}) {
    const reading=await refreshRead?.(accountKey,{signal,forceRefresh:true});
    return {reason:reading?.refresh_succeeded===false?'refresh_failed':null,probe:reading?.probe??null};
  }
  return {readings,view,refreshCapacity,samplePresence:async()=>settings()?.limits?.idleOnly===true?presence?.():false,
    effortMax:()=>settings()?.limits?.lendingPolicy?.effortMax??'high',busy:()=>false,
    cancelObservations:()=>{},start(){},async close(){return {live_attempts:[],capture_drain_complete:true};}};
}
