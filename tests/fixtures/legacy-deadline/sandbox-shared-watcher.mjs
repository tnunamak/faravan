// Historical serving predicate from e771097ab; it requires a live record lock.
import fs from 'node:fs';
import path from 'node:path';
import {deadlineProcessStartSync} from '../../../lib/sandbox-deadline.mjs';
import {processLockOwners} from '../../../lib/v1/lock.mjs';
import {watchProofDirectory} from '../../../lib/v1/sandbox-watch-proofs.mjs';
import {ownerLockPath,readOwnership,stalledOwnership} from '../../../lib/v1/sandbox-record-owner.mjs';
import {randomUUID} from 'node:crypto';
export {completeWatchInventory} from '../../../lib/v1/sandbox-shared-watcher.mjs';
const validName=name=>/^wf-[a-f0-9]{16}$/.test(name);
const eligible=row=>row?.create==='dispatched'&&row.compute_created===false&&row.create_settled!==true&&row.compute_stopped!==true&&validName(row.sandbox_id)&&
  typeof row._cleanupId==='string'&&row._cleanupId.length>0&&typeof row.owner_scope==='string'&&row.owner_scope.length>0&&path.isAbsolute(row.sbx_home??'');
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
// ownership (the watcher holds this name's record, bound to this create and generation, with progress that has not stopped).
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
        state.ready===true&&state.generation===manifest.generation&&state.binary===row.watch_ack.binary&&typeof state.start==='string'))return null;
      return watcherOwnsRecord(row.sbx_home,item,state.pid,now)?state:null;
    };
    const state=read();
    if(!state||deadlineProcessStartSync(state.pid)!==state.start)return null;
    // The identity lookup took time. A watcher that is stopping publishes "not ready" and stays alive, with this same identity,
    // while it drains: read everything again, so only a watcher that is still serving counts.
    const again=read();
    return again?.pid===state.pid&&again.start===state.start?again:null;
  }catch{return null;}
}
// The watcher process `pid` holds this name's record and has made progress under that tenure.
function watcherOwnsRecord(home,item,pid,now) {
  const directory=watchProofDirectory(home),saved=readOwnership(directory,item.name),holders=processLockOwners(ownerLockPath(directory,item.name));
  if(saved?.role!=='watcher'||saved.create_incarnation!==item.create_incarnation||saved.watch_generation!==item.watch_generation||saved.progress<1)return null;
  return holders.length===1&&holders[0].pid===pid&&!stalledOwnership(saved,{now})?saved:null;
}
