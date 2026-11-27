// Copied helper entrypoint. The bridge copies this module together with
// macos-update-transaction.mjs, ../durable-write.mjs, lock.mjs and
// windows-process.mjs, plus the native process-identity executable and Node.
import {execFile as execFileCallback, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, readFile, realpath, rename} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireProcessLock} from './lock.mjs';
import {createMacBundleTransaction} from './macos-update-transaction.mjs';
import {writeMacUpdateBoot,macUpdateJournalPath,macUpdateRefusalPath} from './macos-update-boot.mjs';
import {durableJsonAsync} from '../durable-write.mjs';
import {isNewerMacUpdate} from './macos-update-version.mjs';

export const MAC_UPDATE_REQUIRED_FILES=['Contents/Info.plist','Contents/MacOS/faravan-launch','Contents/MacOS/faravan-tray',
      'Contents/MacOS/faravan-process-identity','Contents/Helpers/FaravanNotify.app/Contents/Info.plist',
      'Contents/Resources/faravan/VERSION','Contents/Resources/faravan/channel.json',
      'Contents/Resources/faravan/runtime/bin/node','Contents/Resources/faravan/bin/faravan',
      'Contents/MacOS/faravan-update-exchange','Contents/Resources/faravan/lib/v1/macos-update-boot.mjs','Contents/Resources/faravan/lib/v1/app.mjs',
      'Contents/Resources/faravan/lib/v1/macos-update-helper.mjs','Contents/Resources/faravan/lib/v1/macos-update-helper-bridge.mjs',
      'Contents/Resources/faravan/lib/v1/macos-update-transaction.mjs','Contents/Resources/faravan/lib/v1/macos-update-recovery.mjs',
      'Contents/Resources/faravan/lib/v1/macos-update-factory.mjs','Contents/Resources/faravan/lib/v1/macos-update-version.mjs',
      'Contents/Resources/faravan/lib/v1/macos-update-archive.mjs','Contents/Resources/faravan/lib/v1/lock.mjs',
      'Contents/Resources/faravan/lib/v1/windows-process.mjs','Contents/Resources/faravan/lib/durable-write.mjs'];

const protocol='faravan-mac-update-helper-v1';
const execFile=promisify(execFileCallback);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const validBirth=x=>x && typeof x.boot==='string' && x.boot.startsWith('darwin:') && /^\d+$/.test(x.start ?? '') && ['live','Z'].includes(x.state);
const sameBirth=(a,b)=>a.boot===b.boot && a.start===b.start;
const absolute=x=>typeof x==='string' && isAbsolute(x) && resolve(x)===x;

export async function readControl(capsule, controlPath, nonce) {
  if (controlPath!==join(capsule,'.handoff-control.json') || !/^[0-9a-f]{64}$/.test(nonce ?? '')) throw fail('invalid_control','Invalid control identity');
  const directory=await lstat(capsule), file=await lstat(controlPath), uid=process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode&0o077)!==0 ||
      !file.isFile() || file.isSymbolicLink() || file.nlink!==1 || (file.mode&0o077)!==0 ||
      (uid!==undefined && (directory.uid!==uid || file.uid!==uid)) || await realpath(capsule)!==capsule)
    throw fail('invalid_control','Control is not private and owned');
  let record; try {record=JSON.parse(await readFile(controlPath,'utf8'));} catch {throw fail('invalid_control','Unreadable control');}
  if(record?.protocol!==protocol || record.nonce!==nonce || record.state!=='prepared') throw fail('revoked','Handoff authority is absent or revoked');
}

// An identity lookup failure is never interpreted as death. ESRCH from a PID
// probe is decisive; a changed birth identifies a different incarnation.
export async function originalGone(owner,{identity,probe=process.kill}) {
  try {probe(owner.pid,0);} catch(e) {if(e.code==='ESRCH')return true;throw fail('ownership_unknown','Cannot probe owned process');}
  let current; try {current=await identity(owner.pid);} catch {throw fail('ownership_unknown','Cannot read process birth');}
  if(!validBirth(current))throw fail('ownership_unknown','Invalid process birth');
  return !sameBirth(current,owner) || current.state==='Z';
}

export function createNativeCallbacks(spec,{capsule,nonce,controlPath,exec=execFile,spawnProcess=spawn,fetch=globalThis.fetch,
  probe=process.kill, acquire=acquireProcessLock, sleep=pause, now=Date.now}={}) {
  const helper=join(capsule,'faravan-process-identity');
  const identity=async pid=>JSON.parse((await exec(helper,[String(pid)],{timeout:2500,encoding:'utf8'})).stdout);
  let locks=[];
  const releaseLocks=()=>{for(const release of locks.splice(0).reverse())release();};
  const authority=()=>readControl(capsule,controlPath,nonce);
  async function quiescent() {
    await authority();
    for(const owner of spec.oldOwners)if(!await originalGone(owner,{identity,probe}))return false;
    if(locks.length)return true;
    try {
      for(const name of ['launch.lock','app.lock'])locks.push(await acquire(join(spec.home,'v1',name),{timeoutMs:0}));
      try {await lstat(join(spec.home,'v1','app.json')); releaseLocks(); return false;}
      catch(e){if(e.code!=='ENOENT')throw e;}
      return true;
    } catch(e){releaseLocks();if(e.code==='lock_busy')return false;throw e;}
  }
  async function verifyBundle(path, expected) {
    const required=MAC_UPDATE_REQUIRED_FILES;
    try {
      for(const file of required){const target=join(path,file), st=await lstat(target);if(!st.isFile() || st.isSymbolicLink() || !(await realpath(target)).startsWith(path+'/'))return false;}
      if((await readFile(join(path,required[5]),'utf8')).trim()!==expected)return false;
      const channel=JSON.parse(await readFile(join(path,required[6]),'utf8'));
      if(channel.id!==spec.channel || channel.bundleId!==spec.bundleId)return false;
      const plist=await exec('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,required[0])],{timeout:10000,encoding:'utf8'});
      if(plist.stdout.trim()!==spec.bundleId)return false;
      await exec('/usr/bin/codesign',['--verify','--deep','--strict',path],{timeout:30000});
      return true;
    } catch{return false;}
  }
  async function launch(path,info) {
    await authority();
    await writeMacUpdateBoot({schema:1,transactionId:info.transactionId,appPath:path,home:spec.home,version:info.version,channel:spec.channel,bundleId:spec.bundleId,journalPath:spec.journalPath,expiresAt:now()+300000},{now:now()});
    await authority(); releaseLocks();
    const child=spawnProcess(join(path,'Contents/MacOS/faravan-launch'),['--background'],{env:{...process.env},stdio:'ignore'});
    // A launcher is not readiness. A handle with no established native birth is
    // deliberately unowned and cannot authorize termination.
    child.once?.('error',()=>{});
    if(!child.pid)throw fail('launch_failed','Native launcher failed to start');
    let birth; try {birth=await identity(child.pid);} catch {throw fail('ownership_unknown','Cannot identify launched process');}
    if(!validBirth(birth)||birth.state!=='live')throw fail('ownership_unknown','Cannot identify launched process');
    return {child,birth};
  }
  // Start the installed app again with no boot request. This is the same entry a
  // person uses, so it is safe whatever else is still running.
  async function restart(path) {
    await authority(); releaseLocks();
    const child=spawnProcess(join(path,'Contents/MacOS/faravan-launch'),['--background'],{env:{...process.env},stdio:'ignore'});
    child.once?.('error',()=>{}); child.unref?.();
    if(!child.pid)throw fail('launch_failed','Native launcher failed to start');
  }
  async function waitReady(handle,info) {
    const deadline=now()+(spec.readyTimeoutMs??30000);
    while(now()<deadline) {
      await authority();
      try {
        const file=join(spec.home,'v1','app.json'),st=await lstat(file);
        if(!st.isFile()||st.isSymbolicLink()||(process.getuid?.()!==undefined&&st.uid!==process.getuid()))throw Error('discovery');
        const record=JSON.parse(await readFile(file,'utf8'));
        if(!Number.isInteger(record.port)||record.port<1||record.port>65535||typeof record.token!=='string'||!record.token||!Number.isInteger(record.pid))throw Error('discovery');
        const response=await fetch('http://127.0.0.1:'+record.port+'/api/updates',{headers:{'x-faravan-session-token':record.token},redirect:'error',signal:AbortSignal.timeout(2000)});
        if(response.ok) {
          const status=await response.json(), proof=status.updateBoot;
          if(proof?.version===info.version && proof?.appPath===info.appPath && proof?.home===spec.home &&
            proof?.transactionId===info.transactionId && proof?.pid===record.pid) {
            const birth=await identity(record.pid);
            if(!validBirth(birth)||birth.state!=='live')throw Error('identity');
            // The short-lived launcher is not the resident app. Bind the
            // authenticated resident itself before permitting an orderly stop.
            handle.resident={...record,birth,appPath:info.appPath,transactionId:info.transactionId};
            if(status.currentVersion===info.version)return {...info,authenticated:true};
          }
        }
      }catch{}
      await sleep(100);
    }
    return null;
  }
  // Stop only the nonce-bound resident through its authenticated graceful Quit.
  // A running job refuses this request; no Stop-and-quit or PID signal is used.
  async function stopOwnedLaunch(handle) {
    const resident=handle?.resident;
    if(!resident)return false;
    try {
      await authority();
      const owner={pid:resident.pid,...resident.birth};
      if(await originalGone(owner,{identity,probe}))return true;
      const record=JSON.parse(await readFile(join(spec.home,'v1','app.json'),'utf8'));
      if(record.pid!==resident.pid||record.port!==resident.port||record.token!==resident.token)return false;
      const origin='http://127.0.0.1:'+resident.port;
      const headers={'x-faravan-session-token':resident.token};
      const status=await fetch(origin+'/api/updates',{headers,redirect:'error',signal:AbortSignal.timeout(2000)});
      if(!status.ok)return false;
      const proof=(await status.json()).updateBoot;
      if(proof?.appPath!==resident.appPath||proof?.home!==spec.home||proof?.transactionId!==resident.transactionId||proof?.pid!==resident.pid)return false;
      const response=await fetch(origin+'/api/shutdown',{method:'POST',body:'{}',headers:{...headers,'content-type':'application/json'},
        redirect:'error',signal:AbortSignal.timeout(spec.stopTimeoutMs??30000)});
      if(!response.ok)return false;
      await response.arrayBuffer?.();
      const deadline=now()+(spec.stopTimeoutMs??30000);
      while(now()<deadline) {
        if(await originalGone(owner,{identity,probe}))return true;
        await sleep(100);
      }
      return false;
    }catch{return false;}
  }
  return {identity,authority,quiescent,verifyBundle,launch,restart,waitReady,stopOwnedLaunch,releaseLocks,safeRollback:process.platform==='darwin'};
}

export async function prepareRunner(message,{capsule,callbacksFactory=createNativeCallbacks,exchange=async(a,b)=>execFile(join(capsule,'faravan-update-exchange'),[a,b],{timeout:30000})}={}) {
  const {nonce,controlPath,spec}=message ?? {};
  if(message?.protocol!==protocol || message.type!=='prepare' || !absolute(capsule) || !spec ||
    !absolute(spec.appPath) || !spec.appPath.endsWith('.app') || !absolute(spec.home) ||
    !absolute(spec.journalPath) || spec.journalPath!==macUpdateJournalPath(spec.appPath) ||
    typeof spec.version!=='string' || typeof spec.previousVersion!=='string' || typeof spec.channel!=='string' || typeof spec.bundleId!=='string' ||
    !Array.isArray(spec.oldOwners) || spec.oldOwners.length!==3 ||
    !['app','native','tray'].every(role=>spec.oldOwners.filter(o=>o?.role===role && Number.isSafeInteger(o.pid) && o.pid>0 && validBirth(o) && o.state==='live').length===1) ||
    new Set(spec.oldOwners.map(o=>o.pid)).size!==3) throw fail('invalid_spec','Invalid helper specification');
  await readControl(capsule,controlPath,nonce);
  const callbacks=callbacksFactory(spec,{capsule,nonce,controlPath});
  // The production runner is restricted to the supported native platform.
  if(callbacks.safeRollback!==true)throw fail('runner_unavailable','A qualified native runner is required');
  if(spec.mode==='recover') {
    let journal;try {const st=await lstat(spec.journalPath);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(process.getuid?.()!==undefined&&st.uid!==process.getuid()))throw Error('invalid');journal=JSON.parse(await readFile(spec.journalPath,'utf8'));} catch {throw fail('invalid_journal','Recovery journal is unavailable');}
    if(journal.schema!==1||journal.appPath!==spec.appPath||journal.home!==spec.home||journal.channel!==spec.channel||journal.bundleId!==spec.bundleId||
      journal.version!==spec.version||journal.previousVersion!==spec.previousVersion||['committed','rolled-back'].includes(journal.phase))
      throw fail('invalid_journal','Recovery journal identity does not match');
  } else if(spec.mode!==undefined && spec.mode!=='apply')throw fail('invalid_spec','Unknown transaction mode');
  else if(!await callbacks.verifyBundle(spec.appPath,spec.previousVersion) || !await callbacks.verifyBundle(spec.appPath+'.next',spec.version))
    throw fail('invalid_bundle','Both bundles must support the boot protocol');
  for(const owner of spec.oldOwners) {
    const observed=await callbacks.identity(owner.pid);
    if(!validBirth(observed)||observed.state!=='live'||!sameBirth(observed,owner))throw fail('ownership_unknown','Old process identity changed');
  }
  const isNewer=(a,b)=>isNewerMacUpdate(a,b,spec.channel);
  if(!isNewer(spec.version,spec.previousVersion))throw fail('invalid_version','Candidate is not a supported forward version');
  let transactionLockHeld=false;
  const lockGuard=async work=>{if(!transactionLockHeld)throw fail('lock_required','Install lock is not held');return work();};
  async function refused(error) {
    try {await durableJsonAsync(macUpdateRefusalPath(spec.home),{schema:1,version:spec.version,previousVersion:spec.previousVersion,code:String(error.code??'failed'),at:new Date().toISOString()});}catch{}
    try {await callbacks.restart?.(spec.appPath);}catch{}
  }
  const transaction=createMacBundleTransaction({...spec,...callbacks,isNewer,lockGuard,exchange:async(a,b)=>{await callbacks.authority();await exchange(a,b);},rename:async(from,to)=>{await callbacks.authority();await rename(from,to);}});
  // Refuse a layout or journal that apply would reject now, while the old app is
  // still running, rather than after the helper has waited for it to stop.
  if(spec.mode!=='recover')await transaction.preflight();
  async function transact(){
    const deadline=Date.now()+(spec.stopTimeoutMs??30000);
    let releaseInstall;
    try {releaseInstall=await acquireProcessLock(spec.appPath+'.update.lock',{timeoutMs:spec.stopTimeoutMs??30000});transactionLockHeld=true;
      while(!await callbacks.quiescent()){if(Date.now()>=deadline)throw Object.assign(fail('not_quiescent','Old app did not cease'),{refused:true});await pause(100);}
      await callbacks.authority();return await (spec.mode==='recover'?transaction.recover():transaction.apply());
    } finally {callbacks.releaseLocks();transactionLockHeld=false;releaseInstall?.();}
  }
  return {async run(){
    try {return await transact();}
    catch(error) {
      // The old app is already stopped. When nothing was changed, leave a note the
      // app can show and start the installed app again, after the install lock is
      // free. Never touch a half-done swap: rollback owns that.
      if(error?.refused===true&&spec.mode!=='recover')await refused(error);
      throw error;
    }
  }};
}

export async function serveHelper({channel=process,capsule=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),prepare=prepareRunner}={}) {
  let runner,nonce,cancelled=false,ready=false,disconnected=false;
  channel.on('message',async message=>{
    if(message?.type==='cancel' && message.protocol===protocol && message.nonce===nonce){cancelled=true;channel.send?.({protocol,type:'cancelled',nonce},()=>channel.disconnect?.());return;}
    if(runner || message?.type!=='prepare')return;
    nonce=message.nonce;
    try {runner=await prepare(message,{capsule});if(cancelled||disconnected)return;ready=true;channel.send?.({protocol,type:'ready',nonce});}
    catch {cancelled=true;channel.disconnect?.();}
  });
  channel.once('disconnect',async()=>{disconnected=true;if(ready&&!cancelled)try{await runner.run();}catch{};});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await serveHelper();
