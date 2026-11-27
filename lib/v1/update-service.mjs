import {isNewer} from './self-update.mjs';
const LEGACY_EXPOSURE_ACTION = 'Review the saved legacy exposure before trying the update again. Your current version keeps running.';
// The app's update view. Manual checks never stage, swap, or restart a running app.
export function createUpdateService({updater=null,currentVersion=null,owner='development',now=Date.now,busy=()=>null,onChange=()=>{}}={}) {
  let pending=null,closed=false;
  const controller=new AbortController();
  const closing=()=>Object.assign(new Error('The application is closing'),{code:'app_closing',status:503});
  let view={owner,currentVersion,automatic:!!updater,state:updater?'idle':'managed',candidate:null,checkedAt:null,
    nextCheckAt:updater?new Date(now()+(updater.startDelayMs??120000)).toISOString():null,notes:[],notesUrl:null,waitingFor:null,error:null};
  const status=()=>({...view,notes:[...view.notes]});
  const publish=patch=>{view={...view,...patch};if(!closed)onChange(status());return status();};
  function manifestView(manifest) {
    const notes=typeof manifest?.notes==='string'?manifest.notes.split('\n'):Array.isArray(manifest?.notes)?manifest.notes:[];
    let notesUrl=null;
    try {const url=new URL(manifest?.release_notes_url);if(url.protocol==='https:'&&!url.username&&!url.password)notesUrl=url.href;}catch{}
    return {candidate:manifest?.version??null,notes:notes.filter(x=>typeof x==='string').slice(0,3).map(x=>x.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300)),notesUrl};
  }
  function check(options={}) {
    if(closed)return Promise.reject(closing());
    if(!updater)return Promise.resolve(status());
    if(pending)return pending;
    publish({state:'checking',error:null});
    const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    pending=(async()=>{
      try {const {current,manifest}=await updater.check({...options,signal});signal.throwIfAborted();options.admit?.();return publish({...manifestView(manifest),currentVersion:current,checkedAt:new Date(now()).toISOString(),state:manifest?'available':'current'});}
      catch(error) {if(closed)throw closing();if(signal.aborted)throw signal.reason;return publish({state:'failed',error:'Could not check for updates. Your current version keeps running.'});}
      finally {pending=null;}
    })();
    return pending;
  }
  async function tick(options) {
    const outcome=await updater.tick(options);
    // Real updaters expose persisted check details; injected legacy updaters need not.
    const {automaticFailure, ...persisted}=await updater.status?.()??{};
    const legacyBlocked=automaticFailure==='legacy_exposure_pending'&&['failed','too-soon','staged'].includes(outcome);
    const blocking=outcome==='staged'&&!legacyBlocked?await busy():null;
    const state=legacyBlocked?'failed':outcome==='handoff'?'staged':outcome==='skipped-failed-version'?'rolled_back':['applied','staged','failed'].includes(outcome)?outcome:outcome==='current'?'current':view.state;
    publish({...persisted,state,nextCheckAt:new Date(now()+(updater.intervalMs??21600000)).toISOString(),
      waitingFor:outcome==='staged'&&!legacyBlocked?(blocking?.person??null):null,
      error:legacyBlocked?LEGACY_EXPOSURE_ACTION:outcome==='skipped-failed-version'?'This version did not start. Faravan kept your previous version and will wait for a newer update.':outcome==='failed'?'The update could not be installed. Your current version keeps running.':null});
    return outcome;
  }
  // The saved candidate outlives the update that applied it: a candidate this install has reached is not available.
  async function restore() {
    if(updater?.status){
      const {automaticFailure: _automaticFailure, ...saved}=await updater.status();
      const open=saved.candidate&&(!view.currentVersion||isNewer(saved.candidate,view.currentVersion));
      // The helper stopped the app, then refused this update and started the app again.
      if(saved.refused)publish({...saved,candidate:saved.refused.version,state:'failed',error:'The update could not be installed. Your current version keeps running.'});
      else publish(open?{...saved,state:'available'}:{...saved,candidate:null,notes:[],notesUrl:null,state:'idle'});
    }
    return status();
  }
  async function prepareHandoff(options) {
    try {return await updater.prepareHandoff(options);}
    catch(error) {
      const legacyBlocked=!options?.signal?.aborted&&error?.name!=='AbortError'&&error?.code==='legacy_exposure_pending';
      publish({state:'failed',error:legacyBlocked
        ? LEGACY_EXPOSURE_ACTION
        : 'The update could not start. Your current version keeps running.'});
      throw error;
    }
  }
  const close=()=>{closed=true;controller.abort();};
  return {status,check,tick,restore,prepareHandoff,close,installDir:updater?.installDir,intervalMs:updater?.intervalMs,startDelayMs:updater?.startDelayMs};
}
