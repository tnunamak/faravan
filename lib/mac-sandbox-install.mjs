import {mkdir, mkdtemp, rm, rename, access, readdir, lstat} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pipeline} from 'node:stream/promises';
import {MAC_SANDBOX_RELEASE} from './mac-sandbox-release.mjs';
import {supportedSbxVersion as supported} from './sbx-version.mjs';
import {resolveSbxExecutable} from './sbx-daemon-owner.mjs';

// Keep relocation in one place: the complete bundle must stay together.
export const MAC_SANDBOX_DIRECTORY='sandbox-runtime';
const exec=promisify(execFile);
const run=async(command,args)=>{const result=await exec(command,args,{timeout:120000,maxBuffer:1024*1024});return result.stdout+result.stderr;};
export async function macSandboxArch({arch=process.arch,run:execute=run}={}) {
  try {
    const arm64=(await execute('/usr/sbin/sysctl',['-n','hw.optional.arm64'])).trim();
    if(arm64==='1')return 'arm64';
    if(arm64==='0')return 'x64';
  }catch {}
  return arch;
}
async function download(url,file,progress,signal) {
  const idle=new AbortController();
  let timer;
  const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(),60000);};
  reset();
  const totalTimer=setTimeout(()=>idle.abort(),60*60*1000);
  try {
    const response=await fetch(url,{signal:AbortSignal.any([signal,idle.signal])});
    if(!response.ok||!response.body)throw Error('Download failed.');
    const total=Number(response.headers.get('content-length'))||null;
    let received=0;
    async function* chunks() {
      for await(const chunk of response.body) {
        if(chunk.length)reset();
        received+=chunk.length;
        if(received>512*1024*1024)throw Error('Download is too large.');
        progress(received,total);yield chunk;
      }
      if(total!==null&&received!==total)throw Error('Download ended early.');
    }
    await pipeline(chunks(),createWriteStream(file,{flags:'wx',mode:0o600}));
  }finally {clearTimeout(timer);clearTimeout(totalTimer);}
}
export function createMacSandboxInstaller({home,platform=process.platform,arch,release=MAC_SANDBOX_RELEASE,
  run:execute=run,download:fetchArchive=download,resolveExecutable=resolveSbxExecutable,env=process.env}={}) {
  const root=join(home,MAC_SANDBOX_DIRECTORY),destination=join(root,release.version);
  const binary=join(destination,'Sbx.app/Contents/MacOS/sbx');
  let state={phase:'idle'},flight=null,controller=null;
  const architecture=arch!==undefined?Promise.resolve(arch):platform==='darwin'?macSandboxArch({run:execute}):Promise.resolve(process.arch);
  const status=()=>({...state});
  const versionOutput=command=>execute(command,['version']).catch(error=>(error.stdout||'')+(error.stderr||''));
  const verify=async(bundle)=>{
    try {await execute('/usr/bin/codesign',['--verify','--deep','--strict',
      `-R=anchor apple generic and certificate leaf[subject.OU] = "${release.teamId}"`,bundle]);}
    catch {throw Error('The sandbox signature could not be verified. Retry the installation.');}
  };
  async function findInstalled() {
    if(platform!=='darwin'||await architecture!=='arm64')return null;
    // Honor the explicit runtime choice and a supported Homebrew/manual install first.
    const configured=env.FARAVAN_SBX_BIN||'sbx';
    for(const candidate of new Set([configured,'/opt/homebrew/bin/sbx','/usr/local/bin/sbx','/Applications/Sbx.app/Contents/MacOS/sbx'])) {
      try {
        const output=await versionOutput(candidate);
        if(supported(output))return resolveExecutable(candidate,env);
      }catch {}
    }
    try {
      await access(binary);await verify(join(destination,'Sbx.app'));
      if(supported(await versionOutput(binary)))return binary;
    }catch {}
    return null;
  }
  async function perform() {
    if(platform!=='darwin'||await architecture!=='arm64')throw Error('The sandbox install button requires an Apple silicon Mac.');
    let staging,published=false;
    controller=new AbortController();
    try {
      state={phase:'checking'};
      await mkdir(root,{recursive:true,mode:0o700});
      for(const entry of await readdir(root,{withFileTypes:true})) {
        if(entry.isDirectory()&&entry.name.startsWith('.install-')) {
          const path=join(root,entry.name);
          if(Date.now()-(await lstat(path)).mtimeMs>3600000)await rm(path,{recursive:true,force:true});
        }
      }
      const installed=await findInstalled();
      controller.signal.throwIfAborted();
      if(installed)return state={phase:'installed',executable:installed};
      staging=await mkdtemp(join(root,'.install-'));
      // Only this pinned version belongs to this attempt; move a broken claim
      // before downloading so a later concurrent publisher still wins exclusively.
      if(!/^\d+\.\d+\.\d+$/.test(release.version))throw Error('Invalid sandbox version.');
      try {await rename(destination,join(staging,'broken'));}catch(error){if(error.code!=='ENOENT')throw error;}
      const archive=join(staging,'runtime.tar.gz'),unpacked=join(staging,'unpacked');
      state={phase:'downloading',received:0,total:null};
      try {await fetchArchive(release.url,archive,(received,total)=>{state={phase:'downloading',received,total};},controller.signal);}
      catch {throw Error('The sandbox download did not finish. Retry the installation.');}
      state={phase:'verifying'};
      const hash=createHash('sha256');
      for await(const chunk of createReadStream(archive))hash.update(chunk);
      if(hash.digest('hex')!==release.sha256)throw Error('The sandbox download could not be verified. Retry the installation.');
      state={phase:'unpacking'};
      await mkdir(unpacked,{mode:0o700});
      await execute('/usr/bin/tar',['-xzf',archive,'-C',unpacked]);
      await verify(join(unpacked,'Sbx.app'));
      controller.signal.throwIfAborted();
      // Claim a new directory exclusively, after checking the hash and signer.
      await mkdir(destination,{mode:0o700});
      published=true;
      await rename(join(unpacked,'Sbx.app'),join(destination,'Sbx.app'));
      if(!supported(await versionOutput(binary)))throw Error('The sandbox could not start. Retry the installation.');
      controller.signal.throwIfAborted();
      for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])) {
        if(entry.isDirectory()&&/^\d+\.\d+\.\d+$/.test(entry.name)&&entry.name!==release.version)
          await rm(join(root,entry.name),{recursive:true,force:true}).catch(()=>{});
      }
      return state={phase:'installed',executable:binary};
    }catch(error) {
      if(published)await rm(destination,{recursive:true,force:true}).catch(()=>{});
      const messages=[
        'The sandbox signature could not be verified. Retry the installation.',
        'The sandbox download did not finish. Retry the installation.',
        'The sandbox download could not be verified. Retry the installation.',
        'The sandbox could not start. Retry the installation.',
      ];
      const message=messages.includes(error.message)?error.message:'The sandbox installation did not finish. Retry installation.';
      state=controller.signal.aborted?{phase:'idle',message:'Installation cancelled. Install the sandbox when you are ready.'}:{phase:'failed',message};
      throw Error(state.message);
    }
    finally {if(staging)await rm(staging,{recursive:true,force:true}).catch(()=>{});controller=null;}
  }
  return {status,findInstalled,install(){if(!flight)flight=perform().finally(()=>{flight=null;});return flight;},
    cancel(){controller?.abort();return flight?.catch(()=>{});}};
}
