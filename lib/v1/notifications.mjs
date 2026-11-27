import {durableJsonAsync} from '../durable-write.mjs';
// Local borrower observations and delivery cursor. Never copy prompts, paths or result text
// into a desktop payload. The history and desktop controls are independent.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {jobStatusLabel, observedExecutionTime, createJobProjection, adaptLegacyJob} from './state-projection.mjs';
export const NOTIFICATION_CATEGORIES=Object.freeze(['requests','job_ready','needs_attention','security','lending_attention','circle_activity']);
const invalid=()=>{throw Object.assign(new Error('Invalid notification settings or cursor.'),{code:'invalid_request',status:400});};
export function notificationSettings(saved={}) {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map(key=>[key,{
    history:typeof saved?.[key]?.history==='boolean'?saved[key].history:true,
    desktop:typeof saved?.[key]?.desktop==='boolean'?saved[key].desktop:key!=='circle_activity',
  }]));
}
export function updateNotificationSettings(saved,patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))invalid();
  const next=notificationSettings(saved);
  for(const [category,choices]of Object.entries(patch)) {
    if(!NOTIFICATION_CATEGORIES.includes(category)||!choices||typeof choices!=='object'||Array.isArray(choices))invalid();
    for(const [key,value]of Object.entries(choices)) {
      if(!['history','desktop'].includes(key)||typeof value!=='boolean')invalid();
      next[category][key]=value;
    }
  }
  return next;
}
export function validJobRoute(route) {
  if(typeof route!=='string'||route.length>1024)return false;
  const parts=route.split('/');
  if(parts.length<3||parts.length>4||parts[0]!=='#'||parts[1]!=='job')return false;
  try {
    if(!/^sha256:[0-9a-f]{64}$/.test(decodeURIComponent(parts[2])))return false;
    return parts.length===3||/^[A-Za-z0-9_-]{1,256}$/.test(decodeURIComponent(parts[3]));
  }catch{return false;}
}
export const validNotificationRoute=route=>route==='#/lend/limits'||route==='#/lend'||validJobRoute(route);
const transitions={Working:['started','circle_activity','Your job started','An agent began working on your job.'],
  Finished:['ready','job_ready','Your job is ready to review','Open the job to review the result.'],
  Failed:['failed','needs_attention','Your job failed','Open the job to see what happened.'],
  Cancelled:['stopped','needs_attention','Your job stopped','Open the job to see its final status.'],
  Expired:['expired','needs_attention','Your job expired','Open the job to review its deadline.']};
const LIMIT=512,MAX_OBSERVATIONS=4000,MAX_UNSENT=100;
export async function createNotificationFeed(directory,{now=Date.now}={}) {
  const file=join(directory,'notifications.json');
  let state;
  try {state=JSON.parse(await readFile(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  state??={version:1,epoch:randomUUID(),sequence:0,observations:{},notifications:[],history:[]};
  if(state.version!==1||typeof state.epoch!=='string'||!Number.isSafeInteger(state.sequence)||
    !state.observations||!Array.isArray(state.notifications)||!Array.isArray(state.history))throw Error('Invalid notification history.');
  const cursor=()=>state.epoch+':'+state.sequence;
  let pending=Promise.resolve();
  async function persist(next) {
    // Delivery-only entries live in memory; turning history off must not retain
    // their content on disk. Persist cursor/observations for restart deduplication.
    const retained=new Set(next.history.map(row=>row.id));
    const stored={...next,notifications:next.notifications.filter(row=>retained.has(row.id))};
    await durableJsonAsync(file,stored);state=next;
  }
  const queued=run=>{const result=pending.then(run);pending=result.catch(()=>{});return result;};
  const unsent=[];let dropped=0,lastCode=null;
  async function apply({view,baseline},settings) {
    const circle=view.borrowerCircle,digest=view.job_digest;
    if(!circle||!/^sha256:[0-9a-f]{64}$/.test(digest??''))return;
    const status=jobStatusLabel(view);
    const projection=view.jobProjection !== undefined ? createJobProjection(view.jobProjection) : adaptLegacyJob(view);
    const key=JSON.stringify([circle,digest]),transition=projection.phase==='stopped' && projection.reasonCode==='cancelled_before_start'
      ? ['stopped','needs_attention','Your job was cancelled','Nothing ran. Open the job to see its final status.'] : transitions[status];
    // Remember Waiting/lease-only Starting across restart without notifying.
    // Stop requested still cannot claim confirmed cessation.
    const kind=transition?.[0];
    const signature=kind==='started'?kind+':'+(view.current_attempt?.attempt_id??''):kind??
      ({Waiting:'waiting','Waiting for an answer':'waiting',Approved:'starting',Starting:'starting'})[status];
    if(!signature)return;
    if(state.observations[key]===signature)return;
    const firstObservation=!Object.hasOwn(state.observations,key);
    const next=structuredClone(state);delete next.observations[key];next.observations[key]=signature;
    // Unresolved jobs keep their execution identity until they end. Only completed
    // history is an eviction cache; evicting a live run would announce it again.
    const completed=Object.keys(next.observations).filter(k=>!['waiting','starting'].includes(next.observations[k])&&!next.observations[k].startsWith('started:'));
    for(const old of completed.slice(0,Math.max(0,completed.length-MAX_OBSERVATIONS)))delete next.observations[old];
    // Restored jobs predating this feed establish state without an alert storm.
    if(!transition||(baseline&&firstObservation)){await persist(next);return;}
    function append([eventKind,eventCategory,eventTitle,eventBody],at=new Date(now()).toISOString()) {
      const notification={id:next.epoch+':'+(++next.sequence),category:eventCategory,kind:eventKind,title:eventTitle,body:eventBody,
        route:'#/job/'+encodeURIComponent(digest)+'/'+encodeURIComponent(circle),at};
      next.notifications.push(notification);next.notifications=next.notifications.slice(-LIMIT);
      if(settings[eventCategory].history){next.history.push(notification);next.history=next.history.slice(-LIMIT);}
    }
    const attempt=view.current_attempt;
    const executionAt=observedExecutionTime(attempt);
    // A fast run may finish between polls. Its confirmed execution timestamp
    // still proves it started; a mere lease never does.
    if(kind!=='started'&&typeof executionAt==='string'&&
      state.observations[key]!=='started:'+(attempt?.attempt_id??''))append(transitions.Working,executionAt);
    append(transition);
    await persist(next);
  }
  // Oldest first, so a job's transitions keep their order. A failed write stops the drain and stays pending.
  // Any other failure would repeat forever and block the rest, so that observation is dropped and counted.
  async function deliver(settings) {
    while(unsent.length) {
      try {await apply(unsent[0],settings);unsent.shift();}
      catch(error){
        if(/^E[A-Z0-9_]{1,31}$/.test(error?.code)){lastCode=error.code;return;}
        unsent.shift();dropped++;
      }
    }
    lastCode=null;
  }
  return {
    // Resolves once every queued write has finished, so a closing app never writes after its data is gone.
    settled:async()=>{let last;do{last=pending;await last;}while(last!==pending);},
    observe(view,settings,{baseline=false}={}) {
      unsent.push({view:structuredClone(view),baseline});
      for(;unsent.length>MAX_UNSENT;dropped++)unsent.shift();
      return queued(()=>deliver(settings));
    },
    // Called on every poll: delivers what an earlier failed write left behind.
    retry:settings=>queued(()=>deliver(settings)),
    status:()=>({degraded:unsent.length>0,lastCode,dropped}),

    lendingWarning({provider,windowId,resetsAt,threshold,used},settings) {
      const run=async()=>{
        if(!['claude','codex'].includes(provider)||!Number.isFinite(resetsAt)||!Number.isFinite(threshold)||threshold<=0||used<threshold)return;
        const key=JSON.stringify(['allowance',provider,windowId,resetsAt,threshold]);
        if(state.observations[key])return;
        const next=structuredClone(state);next.observations[key]='warned';
        while(Object.keys(next.observations).length>MAX_OBSERVATIONS)delete next.observations[Object.keys(next.observations)[0]];
        const note={id:next.epoch+':'+(++next.sequence),category:'lending_attention',kind:'allowance_warning',title:'Lending reached your warning',
          body:'Friends have used '+threshold+'% of your '+(provider==='claude'?'Claude':'Codex')+' week. Your lending limits still apply.',
          route:'#/lend/limits',at:new Date(now()).toISOString()};
        next.notifications.push(note);next.notifications=next.notifications.slice(-LIMIT);
        if(settings.lending_attention.history){next.history.push(note);next.history=next.history.slice(-LIMIT);}
        await persist(next);
      };
      const result=pending.then(run);pending=result.catch(()=>{});return result;
    },
    // Low disk space on the drive that holds the sandbox store. Once a day at most, so a drive that stays low
    // does not repeat itself every ten minutes. The wording comes from the warning (lib/disk-report.mjs).
    diskWarning(warning,settings) {
      const run=async()=>{
        if(warning?.kind!=='disk_space_low'||typeof warning.text!=='string')return;
        const day=new Date(now()).toISOString().slice(0,10);
        const key=JSON.stringify(['disk_space_low',day]);
        if(state.observations[key])return;
        const next=structuredClone(state);next.observations[key]='warned';
        while(Object.keys(next.observations).length>MAX_OBSERVATIONS)delete next.observations[Object.keys(next.observations)[0]];
        const note={id:next.epoch+':'+(++next.sequence),category:'lending_attention',kind:'disk_space_low',title:'This computer is low on disk space',
          body:warning.text,route:'#/lend',at:new Date(now()).toISOString()};
        next.notifications.push(note);next.notifications=next.notifications.slice(-LIMIT);
        if(settings.lending_attention.history){next.history.push(note);next.history=next.history.slice(-LIMIT);}
        await persist(next);
      };
      const result=pending.then(run);pending=result.catch(()=>{});return result;
    },
    read(after) {
      let sequence=state.sequence;
      if(after!==undefined&&after!=='') {
        if(typeof after!=='string'||!/^[0-9a-f-]{36}:\d+$/.test(after))invalid();
        const split=after.lastIndexOf(':'),epoch=after.slice(0,split),value=Number(after.slice(split+1));
        if(!Number.isSafeInteger(value)||value<0)invalid();
        // An old process/file cursor establishes a fresh baseline; never replay old toasts.
        if(epoch===state.epoch){if(value>state.sequence)invalid();sequence=value;}
      }
      return {cursor:cursor(),notifications:state.notifications.filter(row=>Number(row.id.slice(row.id.lastIndexOf(':')+1))>sequence),history:structuredClone(state.history)};
    },
  };
}
