import {lstat,readFile,realpath,unlink,open} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {durableJsonAsync} from '../durable-write.mjs';
import {acquireProcessLock} from './lock.mjs';
import {isNewerMacUpdate} from './macos-update-version.mjs';

const canonical=x=>typeof x==='string'&&isAbsolute(x)&&resolve(x)===x;
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const requestPath=home=>join(home,'v1','update-boot.json');
export const macUpdateJournalPath=appPath=>appPath+'.update-journal.json';
// Written by the update helper when it refuses an update after the app has stopped.
export const macUpdateRefusalPath=home=>join(home,'v1','macos-update-refusal.json');
async function ownedFile(path) {
  const st=await lstat(path),uid=process.getuid?.();
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(uid!==undefined&&st.uid!==uid))throw Error('Invalid private update record');
  return JSON.parse(await readFile(path,'utf8'));
}
function valid(record,now,{allowExpired=false}={}) {
  return record?.schema===1&&Object.keys(record).length===9&&uuid(record.transactionId)&&canonical(record.appPath)&&record.appPath.endsWith('.app')&&
    canonical(record.home)&&canonical(record.journalPath)&&record.journalPath===macUpdateJournalPath(record.appPath)&&
    typeof record.version==='string'&&record.version.length>0&&typeof record.channel==='string'&&record.channel.length>0&&
    typeof record.bundleId==='string'&&record.bundleId.length>0&&Number.isSafeInteger(record.expiresAt)&&record.expiresAt>0&&(allowExpired||record.expiresAt>now)&&record.expiresAt<=now+600000;
}
export async function writeMacUpdateBoot(request,{now=Date.now()}={}) {
  if(!valid(request,now))throw Error('Invalid update boot request');
  const directory=join(request.home,'v1'), st=await lstat(directory),uid=process.getuid?.();
  if(!st.isDirectory()||st.isSymbolicLink()||(uid!==undefined&&st.uid!==uid)||await realpath(directory)!==directory)throw Error('Invalid profile directory');
  const path=requestPath(request.home);
  try {const old=await ownedFile(path);
    if(['transactionId','appPath','home','journalPath','channel','bundleId'].some(key=>old[key]!==request[key]))throw Error('Conflicting update boot request');
  }catch(e){if(e.code!=='ENOENT')throw e;}
  await durableJsonAsync(path,request);
}
export async function readMacUpdateBoot({home,identity,now=Date.now()}={}) {
  let request;
  try {request=await ownedFile(requestPath(home));}catch(e){
    if(e.code!=='ENOENT')return {held:true,proof:null,request:null};
    let release;
    if(identity?.appPath)try {
      // Keep the journal for recovery history. A terminal record is safe only
      // after the transaction writer has released the install lock.
      try {release=await acquireProcessLock(identity.appPath+'.update.lock',{timeoutMs:0});}
      catch {return {held:true,proof:null,request:null};}
      // A writer may have published a boot request since our first read.
      try {await lstat(requestPath(home));return {held:true,proof:null,request:null};}
      catch(error){if(error.code!=='ENOENT')throw error;}
      const journal=await ownedFile(macUpdateJournalPath(identity.appPath));
      const terminal=journal.schema===1&&uuid(journal.id)&&journal.appPath===identity.appPath&&journal.home===home&&
        journal.channel===identity.channel&&journal.bundleId===identity.bundleId&&
        isNewerMacUpdate(journal.version,journal.previousVersion,identity.channel)&&
        ['committed','rolled-back'].includes(journal.phase);
      return {held:!terminal,proof:null,request:null,terminal};
    } catch(error){if(error.code!=='ENOENT')return {held:true,proof:null,request:null};}
    finally {release?.();}
    return {held:false,proof:null,request:null};
  }
  if(!valid(request,now,{allowExpired:true})||!identity||request.home!==home||request.appPath!==identity.appPath||request.version!==identity.version||
      request.channel!==identity.channel||request.bundleId!==identity.bundleId)return {held:true,proof:null,request:null};
  return {held:true,request,proof:request.expiresAt>now?{appPath:identity.appPath,home,version:identity.version,transactionId:request.transactionId,pid:process.pid}:null};
}
export async function macUpdateBootReleased(request) {
  if(!request)return false;
  try {
    const journal=await ownedFile(request.journalPath);
    return journal.schema===1&&journal.id===request.transactionId&&journal.appPath===request.appPath&&journal.home===request.home&&journal.channel===request.channel&&journal.bundleId===request.bundleId&&
      ((journal.phase==='committed'&&journal.version===request.version)||(journal.phase==='rolled-back'&&journal.previousVersion===request.version));
  }catch{return false;}
}

// Serialize retirement against the transaction writer so a newer request can
// never be removed by a previous app's terminal watcher.
export async function retireMacUpdateBoot(request) {
  let release;
  try {
    release=await acquireProcessLock(request.appPath+'.update.lock',{timeoutMs:0});
    const current=await ownedFile(requestPath(request.home));
    if(!valid(request,Date.now(),{allowExpired:true})||JSON.stringify(current)!==JSON.stringify(request)||!await macUpdateBootReleased(request))return false;
    await unlink(requestPath(request.home));
    const fd=await open(join(request.home,'v1'),'r');try{await fd.sync();}finally{await fd.close();}
    return true;
  } catch {return false;} finally {release?.();}
}
