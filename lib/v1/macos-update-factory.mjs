import {readEarlyBuilds,updateFeedURL} from './update-feed.mjs';
import {prepareWithHostedCoordinator} from './hosted-coordinators.mjs';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,lstat,mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile,open} from 'node:fs/promises';
import {dirname,join,isAbsolute,resolve} from 'node:path';
import {durableJsonAsync,durableWriteAsync} from '../durable-write.mjs';
import {UPDATE_PUBLIC_KEY} from './update-key.mjs';
import {DEFAULT_MANIFEST_URL,PREVIEW_FEED_URL,UpdateError,verifyMacManifest,secureUpdateURL as secureURL,getUpdateBytes as get,
  MANIFEST_MAX_BYTES,SIGNATURE_MAX_BYTES,parseVersion,readUpdateState,releaseFloor,acceptedMark,assertReleaseAccepted} from './self-update.mjs';
import {selectUpdateAsset} from './update-assets.mjs';
import {isNewerMacUpdate,validMacUpdateVersion} from './macos-update-version.mjs';
import {validateMacAppZip} from './macos-update-archive.mjs';
import {createNativeCallbacks} from './macos-update-helper.mjs';
import {macUpdateJournalPath,macUpdateRefusalPath} from './macos-update-boot.mjs';
import {prepareMacUpdateHelper} from './macos-update-helper-bridge.mjs';
import {recoveryFiles} from './macos-update-recovery.mjs';
import {acquireProcessLock} from './lock.mjs';

const run=promisify(execFile),limit=256*1024*1024;
const error=(code,message)=>new UpdateError(code,message);
const readText=async path=>(await readFile(path,'utf8')).trim();
const missing=e=>e.code==='ENOENT';
async function exists(path){try{return await lstat(path);}catch(e){if(missing(e))return null;throw e;}}
async function privateJSON(path){const st=await exists(path);if(!st)return null;
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(process.getuid?.()!==undefined&&st.uid!==process.getuid()))throw error('invalid_state','Update state is not private');
  try{return JSON.parse(await readFile(path,'utf8'));}catch{throw error('invalid_state','Update state is invalid');}}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function createMacUpdaterForInstall({home,installDir,env=process.env,managedContext,hosts,publicKey=UPDATE_PUBLIC_KEY,
  manifestUrl=env.FARAVAN_UPDATE_URL,fetch=globalThis.fetch,arch=process.arch,
  extract=async(zip,out)=>run('/usr/bin/ditto',['-x','-k',zip,out],{timeout:120000}),verifyBundle,
  prepare=prepareMacUpdateHelper,afterStageRename=async()=>{},now=Date.now,intervalMs=6*3600000,startDelayMs=120000,log=()=>{}}={}) {
  const suffix='/Contents/Resources/faravan',appPath=installDir.slice(0,-suffix.length),parent=dirname(appPath),uid=process.getuid?.();
  if(!isAbsolute(home??'')||resolve(home)!==home||!installDir.endsWith(suffix)||!appPath.endsWith('.app')||!['arm64','x64'].includes(arch))return null;
  try {
    const app=await lstat(appPath),dir=await lstat(parent),profile=await lstat(home);
    if(!profile.isDirectory()||profile.isSymbolicLink()||(uid!==undefined&&profile.uid!==uid)||await realpath(home)!==home||
      !app.isDirectory()||app.isSymbolicLink()||(uid!==undefined&&app.uid!==uid)||!dir.isDirectory()||dir.isSymbolicLink()||
      (uid!==undefined&&![0,uid].includes(dir.uid))||await realpath(appPath)!==appPath||await realpath(installDir)!==installDir) return null;
    await access(parent,3);
  }catch{return null;}
  let channel;try{channel=JSON.parse(await readFile(join(installDir,'channel.json'),'utf8'));}catch{return null;}
  if(typeof channel?.id!=='string'||typeof channel?.bundleId!=='string')return null;
  manifestUrl = updateFeedURL({earlyBuilds:await readEarlyBuilds(home),override:manifestUrl});
  manifestUrl ||= parseVersion(await readText(join(installDir,'VERSION')))?.length===5?PREVIEW_FEED_URL:DEFAULT_MANIFEST_URL;
  const target={platform:'darwin',arch,channel:channel.id,bundleId:channel.bundleId};
  const versionFile=join(installDir,'VERSION'),next=appPath+'.next',journalPath=macUpdateJournalPath(appPath),receiptPath=join(home,'v1','macos-update-stage.json'),archivePath=join(home,'v1','macos-update-stage.zip');
  const markPath=join(home,'v1','update.json');
  const lockPath=appPath+'.update.lock',pendingPath=receiptPath+'.pending',verified=new WeakMap();
  const checkBundle=verifyBundle??createNativeCallbacks({channel:channel.id,bundleId:channel.bundleId},{capsule:'/',nonce:'',controlPath:''}).verifyBundle;
  let last=null;
  async function locked(work){const release=await acquireProcessLock(lockPath,{timeoutMs:0});try{return await work();}finally{release();}}
  // The release mark has its own lock, so a check is not blocked by a long stage or handoff holding the install lock.
  async function markLocked(work){let release;try{release=await acquireProcessLock(markPath+'.lock',{timeoutMs:3000});}
    catch(e){if(e?.code==='lock_busy')throw error('busy','Another Faravan update is already running.');throw e;}
    try{return await work();}finally{release();}}
  async function journal() {
    const j=await privateJSON(journalPath);if(!j)return null;
    if(j.schema!==1||j.appPath!==appPath||j.home!==home||j.channel!==channel.id||j.bundleId!==channel.bundleId||
      ! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(j.id??'')||!isNewerMacUpdate(j.version,j.previousVersion,channel.id)||!['committed','rolled-back'].includes(j.phase))throw error('recovery_required','An earlier update needs recovery');
    return j;
  }
  // Left by the update helper when it stopped the app and then refused the update.
  // It applies only while the installed version is still older than that candidate.
  async function refusal() {
    try {
      const r=await privateJSON(macUpdateRefusalPath(home));
      if(r?.schema!==1||typeof r.version!=='string'||typeof r.code!=='string'||!isNewerMacUpdate(r.version,await readText(versionFile),channel.id))return null;
      return {version:r.version,code:r.code,at:typeof r.at==='string'?r.at:null};
    } catch {return null;}
  }
  async function check({signal,admit=()=>{},commit=fn=>{admit();return fn();}}={}) {
    signal?.throwIfAborted();admit();
    if(!publicKey)throw error('no_key','This build has no release key pinned');
    const current=await readText(versionFile);if(!validMacUpdateVersion(current,channel.id))throw error('unknown_version','This installation has no supported version');
    const url=secureURL(manifestUrl),signatureURL=new URL(url);signatureURL.pathname+='.sig';
    const bytes=await get(fetch,url,MANIFEST_MAX_BYTES,{signal});admit();
    const signature=(await get(fetch,signatureURL.href,SIGNATURE_MAX_BYTES,{signal})).toString('utf8');
    const manifest=verifyMacManifest(bytes,signature,publicKey,channel.id);
    // Select an asset only for a newer version, so a feed without this install's asset reads as current.
    const candidate=isNewerMacUpdate(manifest.version,current,channel.id)?manifest:null;
    if(candidate){let asset;try{asset=selectUpdateAsset(manifest,target);}catch{throw error('bad_target','No update matches this installation');}
      verified.set(candidate,{bytes:bytes.toString('base64'),signature,asset});}
    // The Mac swap runs in a helper after the app quits, so this mark moves here rather than at apply.
    // A broken release therefore cannot be withdrawn by republishing; that is the cost of having no in-process apply step.
    const scope={channel:channel.id,parts:parseVersion(current).length};
    await markLocked(async()=>{
      signal?.throwIfAborted();admit();
      const state=await readUpdateState(markPath,now);
      assertReleaseAccepted(manifest,releaseFloor(state,scope,current),{newer:(a,b)=>isNewerMacUpdate(a,b,channel.id),now});
      await mkdir(dirname(markPath),{recursive:true,mode:0o700});
      await durableJsonAsync(markPath,{...state,accepted:acceptedMark(manifest,scope)},
        {publish:replace=>{signal?.throwIfAborted();return commit(replace);}});
    });
    last={checkedAt:new Date(now()).toISOString(),candidate:candidate?.version??null,notes:[],notesUrl:null};
    return {current,manifest:candidate};
  }
  function proofFromReceipt(receipt) {
    if(!receipt||receipt.schema!==1||receipt.appPath!==appPath||receipt.home!==home||receipt.channel!==channel.id||receipt.bundleId!==channel.bundleId||
      typeof receipt.bytes!=='string'||receipt.bytes.length>700000||typeof receipt.signature!=='string'||!Number.isSafeInteger(receipt.stageDev)||!Number.isSafeInteger(receipt.stageIno))throw error('invalid_state','Staged update receipt is invalid');
    const bytes=Buffer.from(receipt.bytes,'base64'),manifest=verifyMacManifest(bytes,receipt.signature,publicKey,channel.id);
    let asset;try{asset=selectUpdateAsset(manifest,target);}catch{throw error('bad_target','No update matches this installation');}
    return {manifest,asset};
  }
  async function validateStage(receipt,expected,path=next) {
    const {manifest,asset}=proofFromReceipt(receipt),st=await exists(path);
    if(!st||!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022)!==0||(uid!==undefined&&st.uid!==uid)||st.dev!==receipt.stageDev||st.ino!==receipt.stageIno||await realpath(path)!==path||manifest.version!==expected||!await checkBundle(path,expected))
      throw error('invalid_stage','Staged update cannot be verified');
    return {manifest,asset};
  }
  async function privateArchive(expected,path=archivePath) {
    const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const st=await fd.stat();
      if(!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0||(uid!==undefined&&st.uid!==uid)||st.size!==expected.size||st.size>limit)
        throw error('invalid_stage','The saved archive is invalid');
      const bytes=Buffer.allocUnsafe(expected.size);let offset=0;
      while(offset<bytes.length){const {bytesRead}=await fd.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw error('bad_hash','The saved archive is incomplete');offset+=bytesRead;}
      const extra=Buffer.alloc(1);if((await fd.read(extra,0,1,offset)).bytesRead!==0||digest(bytes)!==expected.sha256)
        throw error('bad_hash','The saved archive does not match its signed manifest');
      return bytes;
    } finally {await fd.close();}
  }
  async function extractVerified(bytes,version) {
    await validateMacAppZip(bytes,{appName:'Faravan.app'});
    const work=await mkdtemp(join(parent,'.faravan-stage-'));
    try {
      const file=join(work,'archive.zip'),out=join(work,'out');await writeFile(file,bytes,{mode:0o600,flag:'wx'});await mkdir(out,{mode:0o700});
      await extract(file,out);
      const app=join(out,'Faravan.app'),st=await lstat(app);
      if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022)!==0||(uid!==undefined&&st.uid!==uid)||!await checkBundle(app,version))
        throw error('invalid_bundle','The staged app failed verification');
      return {work,app};
    } catch(e){await rm(work,{recursive:true,force:true});throw e;}
  }
  const sameReceipt=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  async function recoverStage(afterRename=async()=>{}) {
    const pending=await privateJSON(pendingPath);if(!pending)return;
    const {receipt,previous,work,workDev,workIno}=pending;
    if(pending.schema!==1||typeof work!=='string'||dirname(work)!==parent||!work.startsWith(join(parent,'.faravan-stage-')))
      throw error('invalid_state','Stage recovery identity is invalid');
    const ws=await exists(work);
    if(!ws||!ws.isDirectory()||ws.isSymbolicLink()||(ws.mode&0o077)!==0||(uid!==undefined&&ws.uid!==uid)||
      ws.dev!==workDev||ws.ino!==workIno||await realpath(work)!==work)
      throw error('invalid_state','Stage recovery directory changed');
    const {manifest,asset}=proofFromReceipt(receipt),saved=await privateJSON(receiptPath);
    if(!sameReceipt(saved,previous)&&!sameReceipt(saved,receipt))throw error('invalid_state','Stage receipt changed during publication');
    const bytes=await privateArchive(asset,join(work,'archive.zip')),entry=await exists(next);
    if(entry&&entry.dev===receipt.stageDev&&entry.ino===receipt.stageIno) {
      await validateStage(receipt,manifest.version);
    } else {
      const candidate=join(work,'out','Faravan.app');
      await validateStage(receipt,manifest.version,candidate);
      if(entry) {
        const old=proofFromReceipt(previous);
        if(manifest.version!==old.manifest.version&&!isNewerMacUpdate(manifest.version,old.manifest.version,channel.id))
          throw error('invalid_version','Staged update does not advance');
        // Prove ownership by the signed receipt's inode, not by the tree's contents:
        // an interrupted removal leaves a partial tree that must not block the retry.
        if(!entry.isDirectory()||entry.isSymbolicLink()||(uid!==undefined&&entry.uid!==uid)||
          entry.dev!==previous.stageDev||entry.ino!==previous.stageIno||await realpath(next)!==next)
          throw error('invalid_stage','Staged update cannot be verified');
        await rm(next,{recursive:true});
      }
      await rename(candidate,next);
      const sourceFd=await open(dirname(candidate),'r');try{await sourceFd.sync();}finally{await sourceFd.close();}
      const parentFd=await open(parent,'r');try{await parentFd.sync();}finally{await parentFd.close();}
      await afterRename();
    }
    // The intent remains until both durable files describe the renamed inode.
    // A crash at any point above or between these writes can be replayed.
    await durableWriteAsync(archivePath,bytes);
    await durableJsonAsync(receiptPath,receipt);
    await rm(pendingPath);
    const profileFd=await open(dirname(pendingPath),'r');try{await profileFd.sync();}finally{await profileFd.close();}
    await rm(work,{recursive:true});
  }
  async function publishStage(staged,proof) {
    const entry=await lstat(staged.app),ws=await lstat(staged.work),previous=await privateJSON(receiptPath);
    const receipt={schema:1,appPath,home,channel:channel.id,bundleId:channel.bundleId,stageDev:entry.dev,stageIno:entry.ino,bytes:proof.bytes,signature:proof.signature};
    // Keep the recovery archive and its directory durable before the intent.
    const archiveFd=await open(join(staged.work,'archive.zip'),'r');try{await archiveFd.sync();}finally{await archiveFd.close();}
    for(const path of [dirname(staged.app),staged.work,parent]) {
      const fd=await open(path,'r');try{await fd.sync();}finally{await fd.close();}
    }
    // Persist ownership before any stage rename/removal, not afterwards.
    staged.pending=true;
    await durableJsonAsync(pendingPath,{schema:1,receipt,previous,work:staged.work,workDev:ws.dev,workIno:ws.ino});
    await recoverStage(afterStageRename);
    staged.pending=false;
  }
  async function stage(manifest) {return locked(async()=>{
    const p=verified.get(manifest);if(!p)throw error('bad_signature','Update was not verified');
    const signed=verifyMacManifest(Buffer.from(p.bytes,'base64'),p.signature,publicKey,channel.id);
    if(manifest.version!==signed.version)throw error('bad_signature','Update identity changed after verification');
    const current=await readText(versionFile),j=await journal();
    await recoverStage();
    if(!isNewerMacUpdate(manifest.version,current,channel.id))throw error('invalid_version','Update does not advance this installation');
    if(j?.phase==='rolled-back'&&!isNewerMacUpdate(manifest.version,j.version,channel.id))throw error('failed_version','This version previously failed');
    if(await exists(next)) {
      const receipt=await privateJSON(receiptPath);
      if(receipt) {const old=proofFromReceipt(receipt);
        await validateStage(receipt,old.manifest.version);await privateArchive(old.asset);
        const sameVersion=old.manifest.version===manifest.version;
        if(sameVersion&&old.asset.size===p.asset.size&&old.asset.sha256===p.asset.sha256)return;
        if(!sameVersion&&!isNewerMacUpdate(manifest.version,old.manifest.version,channel.id))
          throw error('invalid_stage','An existing staged update is newer');
      } else throw error('invalid_stage','An existing staged update requires recovery');
    }
    await privateJSON(receiptPath);
    const asset=p.asset,bytes=await get(fetch,secureURL(asset.url,manifestUrl),Math.min(limit,asset.size));
    if(bytes.length!==asset.size||digest(bytes)!==asset.sha256)throw error('bad_hash','The update archive does not match its signed manifest');
    const staged=await extractVerified(bytes,manifest.version);
    try {
      const directory=join(home,'v1');await mkdir(directory,{recursive:true,mode:0o700});
      const ds=await lstat(directory);
      if(!ds.isDirectory()||ds.isSymbolicLink()||(ds.mode&0o022)!==0||(uid!==undefined&&ds.uid!==uid)||await realpath(directory)!==directory)
        throw error('invalid_state','Update profile directory is invalid');
      const oldArchive=await exists(archivePath);
      if(oldArchive&&(!oldArchive.isFile()||oldArchive.isSymbolicLink()||oldArchive.nlink!==1||(oldArchive.mode&0o077)!==0||(uid!==undefined&&oldArchive.uid!==uid)))
        throw error('invalid_state','Saved archive path is invalid');
      await publishStage(staged,p);
    } finally {if(!staged.pending||!await exists(pendingPath))await rm(staged.work,{recursive:true,force:true});}
  });}
  async function tick({idle,admit,commit}={}) {
    try {
      await locked(journal);
      const {manifest}=await check({admit,commit});if(!manifest)return 'current';
      const j=await locked(journal);if(j?.phase==='rolled-back'&&!isNewerMacUpdate(manifest.version,j.version,channel.id))return 'skipped-failed-version';
      // The helper already refused this version once and had to restart the app. Do not stop the app for it again.
      if((await refusal())?.version===manifest.version){log('update: refused earlier');return 'failed';}
      await stage(manifest);return idle?'handoff':'staged';
    } catch(e){log('update: '+(e.code??'failed'));return e?.code==='no_key'?'disabled':'failed';}
  }
  async function prepareHandoff({signal,exclusive}={}) {
    const context=managedContext?.();if(!context||typeof context.snapshot!=='function')throw error('managed_required','Open the managed Faravan app to update');
    const combined=context.signal?AbortSignal.any([signal,context.signal].filter(Boolean)):signal;
    const releaseInstall=await acquireProcessLock(lockPath,{timeoutMs:0});let releaseIdle,handed=false;
    const release=async()=>{if(releaseIdle){const fn=releaseIdle;releaseIdle=null;await fn();}releaseInstall();};
    try {
      combined?.throwIfAborted();const j=await journal();await recoverStage();const receipt=await privateJSON(receiptPath);
      const {manifest,asset}=proofFromReceipt(receipt),current=await readText(versionFile);
      if(!isNewerMacUpdate(manifest.version,current,channel.id)||j?.phase==='rolled-back'&&!isNewerMacUpdate(manifest.version,j.version,channel.id))throw error('failed_version','This update cannot be installed');
      await validateStage(receipt,manifest.version);
      releaseIdle=await exclusive();if(releaseIdle===null)throw error('busy','Faravan is busy');
      // Reconstruct from the signed archive after exclusion, so a replacement or
      // modification of the previous staged tree cannot borrow its receipt.
      const bytes=await privateArchive(asset),staged=await extractVerified(bytes,manifest.version);
      try {
        combined?.throwIfAborted();await validateStage(receipt,manifest.version);
        await publishStage(staged,{bytes:receipt.bytes,signature:receipt.signature});
      } finally {if(!staged.pending||!await exists(pendingPath))await rm(staged.work,{recursive:true,force:true});}
      const oldOwners=await context.snapshot();combined?.throwIfAborted();
      const root=join(home,'v1','update-helpers');await mkdir(root,{recursive:true,mode:0o700});
      const st=await lstat(root);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||(uid!==undefined&&st.uid!==uid)||await realpath(root)!==root)throw error('invalid_state','Update helper directory is invalid');
      const ticket=await prepareWithHostedCoordinator(hosts,()=>prepare({appPath,sourceRoot:appPath,capsuleRoot:root,files:recoveryFiles,runtime:'runtime/bin/node',entrypoint:'lib/v1/macos-update-helper.mjs',signal:combined,exclusive:async()=>release,
        spec:{mode:'apply',appPath,home,journalPath,version:manifest.version,previousVersion:current,channel:channel.id,bundleId:channel.bundleId,oldOwners}}));
      if(combined?.aborted){await ticket?.cancel?.();combined.throwIfAborted();}
      if(!ticket?.ready||typeof ticket.cancel!=='function'){await ticket?.cancel?.();throw error('handoff_unavailable','The update helper is unavailable');}
      handed=true;return ticket;
    } finally {if(!handed)await release();}
  }
  return {kind:'packaged-mac',installDir,check,stage,tick,prepareHandoff,status:async()=>({...(last??{checkedAt:null,candidate:null,notes:[],notesUrl:null}),...await refusal().then(r=>r?{refused:r}:{})}),intervalMs,startDelayMs};
}
