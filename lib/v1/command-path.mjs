import {access, chmod, link as hardlink, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {channelDataHome, channelIdentity, isChannelIdentity} from '../channel-identity.mjs';
import {acquireProcessLockSync} from './lock.mjs';
const PROFILE_LINE='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
const LOGIN_PATH_BEGIN='FARAVAN-PATH-BEGIN';
const LOGIN_PATH_END='FARAVAN-PATH-END';
const LOGIN_ZDOTDIR_BEGIN='FARAVAN-ZDOTDIR-BEGIN';
const LOGIN_ZDOTDIR_END='FARAVAN-ZDOTDIR-END';

export function launcherForCli(cliPath) {
  const cli=resolve(cliPath);
  const mac=cli.match(/^(.*\/[^/]+\.app)\/Contents\/Resources\/faravan\/bin\/(?:faravan|faravan)$/);
  if(mac)return join(mac[1],'Contents','MacOS','faravan');
  const macSupervisor=cli.match(/^(.*\/[^/]+\.app)\/Contents\/Resources\/faravan\/lib\/v1\/macos-launch\.mjs$/);
  if(macSupervisor)return join(macSupervisor[1],'Contents','MacOS','faravan');
  if(['/usr/lib/faravan/bin/faravan','/usr/lib/faravan/bin/faravan'].includes(cli))return '/usr/bin/faravan';
  const portable=cli.match(/^(.*)\/lib\/faravan\/bin\/(?:faravan|faravan)$/);
  if(portable)return join(portable[1],'bin','faravan');
  return null;
}

function loginProfile(home, shell, env, zdotdir=env.ZDOTDIR||home) {
  if(shell.endsWith('/zsh'))return join(zdotdir,'.zshrc');
  if(shell.endsWith('/bash'))return join(home,'.bashrc');
  return join(home,'.profile');
}

function cleanupProfiles(home, env, zdotdir=env.ZDOTDIR||home) {
  return [join(home,'.bashrc'),join(home,'.bash_profile'),join(home,'.bash_login'),join(home,'.profile'),join(zdotdir,'.zshrc'),join(zdotdir,'.zprofile')];
}

async function installProfiles(home, shell, env, zdotdir=env.ZDOTDIR||home) {
  if(shell.endsWith('/zsh'))return [join(zdotdir,'.zshrc'),join(zdotdir,'.zprofile')];
  if(shell.endsWith('/bash')) {
    const login=[join(home,'.bash_profile'),join(home,'.bash_login'),join(home,'.profile')];
    let selected=join(home,'.profile');
    for(const path of login) {
      try { if((await stat(path)).isFile()){selected=path;break;} } catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    return [join(home,'.bashrc'),selected];
  }
  return [];
}

function failure(code,message,path,directory) {
  return Object.assign(new Error(message),{code,path,directory});
}

async function isExecutableFile(path) {
  try { return (await stat(path)).isFile()&&(await access(path,constants.X_OK),true); } catch { return false; }
}

async function commandOnPath(pathValue, command, exists) {
  for(const dir of String(pathValue??'').split(':').filter(Boolean)) {
    const path=join(dir,command);
    if(await exists(path))return path;
  }
  return null;
}

async function atomicWrite(path, content, original, beforeMutation) {
  let destination=path;
  let info;
  try { info=await lstat(path); } catch(error) { if(error.code!=='ENOENT')throw failure('command_path_write_failed',`Couldn't update ${path}.`,path,dirname(path)); }
  if((original===null)!==!info)throw failure('command_path_write_failed',`The profile ${path} changed. Check it and try again.`,path,dirname(path));
  if(info?.isSymbolicLink()) {
    try { destination=await realpath(path); }
    catch { throw failure('command_path_write_failed',`Couldn't update ${path}: its symlink target does not exist.`,path,dirname(path)); }
  }
  const originalInfo=info;
  const destinationInfo=await lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const parent=dirname(destination);
  await mkdir(parent,{recursive:true,mode:0o700});
  let mode=0o600;
  try {
    const existing=await stat(destination);
    if(!existing.isFile()||!(existing.mode&0o222))throw failure('command_path_write_failed',`Couldn't update ${path}: edit the profile or make it writable.`,path,parent);
    mode=existing.mode&0o7777;
    await access(destination,constants.W_OK);
  } catch(error) {
    if(error.code!=='ENOENT')throw error.code==='command_path_write_failed'?error:failure('command_path_write_failed',`Couldn't update ${path}: edit the profile or make it writable.`,path,parent);
  }
  const temp=join(parent,`.${destination.slice(parent.length+1)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp,content,{mode,flag:'wx'});
    await chmod(temp,mode);
    await beforeMutation('write-profile',path);
    const current=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const currentDestination=await lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const same=(a,b)=>a===null&&b===null||Boolean(a&&b&&a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode);
    if(!same(originalInfo??null,current)||!same(destinationInfo,currentDestination)||
      (original!==null&&await readFile(path,'utf8')!==original))throw new Error('profile changed');
    if(destinationInfo)await rename(temp,destination);
    else {await hardlink(temp,destination);await rm(temp);}
  } catch(error) {
    await rm(temp,{force:true}).catch(()=>{});
    throw failure('command_path_write_failed',`Couldn't update ${path}.`,path,parent);
  }
}

function stripManagedBlock(content, profileMarker) {
  const lines=content.split(/(?<=\n)/);
  return lines.filter((line,index)=>{
    if(line.replace(/\r?\n$/,'').trimEnd()===profileMarker)return false;
    if(index>0&&lines[index-1].replace(/\r?\n$/,'').trimEnd()===profileMarker&&line.replace(/\r?\n$/,'')===PROFILE_LINE)return false;
    return true;
  }).join('');
}

export function createCommandPath({env=process.env, home=env.HOME??homedir(), dataHome, channel=channelIdentity(), launcher, platform=process.platform, exists=isExecutableFile, beforeMutation=async()=>{}}={}) {
  if(!home)throw new Error('HOME is required');
  if(!isChannelIdentity(channel))throw new Error('Invalid command channel identity');
  const command=channel.id==='faravan'?'faravan':channel.linuxPrefix;
  if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)||(channel.id!=='faravan'&&['faravan','faravan'].includes(command.toLowerCase())))throw new Error('Invalid channel command name');
  const profileMarker=channel.id==='faravan'?'# Faravan command path':`# Faravan command path (${command})`;
  const target=launcher?resolve(launcher):null;
  const bin=join(home,'.local','bin'), link=join(bin,command);
  const marker=join(dataHome??channelDataHome({channel,platform,home,env})??join(home,'.faravan'),'command-path-installed');
  const shell=env.SHELL||(platform==='darwin'?'/bin/zsh':'/bin/bash');
  const profile=loginProfile(home,shell,env);
  const unsupported=platform==='win32'?{code:'command_path_unsupported_platform',message:'The command-line tool is not supported on this platform.'}:
    !shell.endsWith('/bash')&&!shell.endsWith('/zsh')?{code:'command_path_unsupported_shell',message:'This shell is not supported yet.'}:null;
  const resultError=(error,profiles=[profile])=>({installed:false,path:link,launcher:target??link,profile:profiles[0]??profile,profiles,managed:false,error:{code:error.code,message:error.message,...(error.path?{path:error.path}:{}),...(error.directory?{directory:error.directory}:{})}});
  const managedPath=async found=>{
    if(!found)return false;
    const actual=await realpath(found).catch(()=>null), expected=target?await realpath(target).catch(()=>null):null;
    return Boolean(actual&&(actual===expected||(target==='/usr/lib/faravan/bin/faravan'&&actual==='/usr/bin/faravan')));
  };
  const ownedLink=async path=>{
    if(!target)return false;
    const raw=await readlink(path);
    const owner=resolve(dirname(path),raw);
    if(owner===target)return true;
    const info=await lstat(owner).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;});
    // A user's file symlink is not ours merely because it reaches the launcher.
    return Boolean(info?.isFile()&&await ownsInstallation({command,launcher:owner}));
  };
  const markerState=async()=>{
    try {
      const info=await lstat(marker);
      if(!info.isFile())return 'foreign';
      try {const saved=JSON.parse(await readFile(marker,'utf8'));return saved?.version===1&&typeof saved.command==='string'&&typeof saved.launcher==='string'?'managed':'foreign';}
      catch(error){if(error instanceof SyntaxError)return 'foreign';throw error;}
    } catch(error) { if(error.code==='ENOENT')return 'missing'; throw error; }
  };
  const removeOwnedLink=async path=>{
    const info=await lstat(path), raw=await readlink(path);
    if(!(await ownedLink(path)))return false;
    await beforeMutation('remove-link',path);
    const current=await lstat(path), currentRaw=await readlink(path);
    if(!current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino||currentRaw!==raw||!(await ownedLink(path)))return false;
    await rm(path);
    return true;
  };
  async function inspectPath() {
    const fallbackZdotdir=env.ZDOTDIR||home;
    if(unsupported)return {resolved:null,error:failure(unsupported.code,unsupported.message),profiles:await installProfiles(home,shell,env,fallbackZdotdir),profile};
    try {
      const shellValues=await loginShellEnvironment({home,env,platform});
      const profiles=await installProfiles(home,shell,env,shellValues.zdotdir);
      return {resolved:await commandOnPath(shellValues.path,command,exists),error:null,profiles,profile:loginProfile(home,shell,env,shellValues.zdotdir)};
    } catch(error) {
      const profiles=await installProfiles(home,shell,env,fallbackZdotdir);
      return {resolved:null,error:error.code==='command_path_shell_failed'?error:failure('command_path_shell_failed','Could not check the login shell PATH.',link,bin),profiles,profile:loginProfile(home,shell,env,fallbackZdotdir)};
    }
  }

  async function classify(found) {
    if(!found)return {kind:'missing'};
    let regular=false;
    try { regular=(await stat(found)).isFile(); } catch {}
    if(!regular)return {kind:'conflict',path:found};
    if(await managedPath(found))return {kind:'managed',path:found};
    return {kind:'conflict',path:found};
  }

  async function status() {
    if(unsupported)return resultError(failure(unsupported.code,unsupported.message));
    const pathResult=await inspectPath();
    const {profiles}=pathResult;
    if(pathResult.error)return resultError(pathResult.error,profiles);
    const found=pathResult.resolved, classified=await classify(found);
    if(classified.kind==='conflict') {
      const error=failure('command_path_conflict',`Another ${command} command is already at ${classified.path}.`,classified.path);
      return resultError(error,profiles);
    }
    return found?{installed:true,path:found,launcher:target??found,profile:pathResult.profile,profiles,managed:await managedPath(found)}:
      {installed:false,path:link,launcher:target??link,profile:pathResult.profile,profiles,managed:true};
  }

  async function ensurePath(profiles) {
    for(const path of profiles) {
      let original=null;
      try{original=await readFile(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw failure('command_path_write_failed',`Couldn't read ${path}.`,path,dirname(path));}
      const content=original??'';
      const lines=content.split(/\r?\n/), markerIndex=lines.findIndex(line=>line.trimEnd()===profileMarker);
      if(markerIndex>=0&&lines[markerIndex+1]===PROFILE_LINE)continue;
      let repaired=content;
      if(markerIndex>=0)repaired=stripManagedBlock(content,profileMarker);
      const separator=repaired.length&&!repaired.endsWith('\n')?'\n':'';
      await beforeMutation('profile-read',path);
      await atomicWrite(path,`${repaired}${separator}${profileMarker}\n${PROFILE_LINE}\n`,original,beforeMutation);
    }
  }

  const recordInstallation=async()=>{
    await assertInstallationOwner();
    const original=await readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    await atomicWrite(marker,JSON.stringify({version:1,command,launcher:target})+'\n',original,beforeMutation);
  };
  async function readInstallation() {
    try {
      if(await markerState()!=='managed')return null;
      const saved=JSON.parse(await readFile(marker,'utf8'));
      return saved?.version===1&&typeof saved.command==='string'&&saved.command.length>0&&typeof saved.launcher==='string'&&saved.launcher.length>0?saved:null;
    } catch(error) {
      if(error.code==='ENOENT'||error instanceof SyntaxError)return null;
      throw error;
    }
  }
  async function ownsInstallation(saved) {
    if(!saved||saved.command!==command||!target)return false;
    try {
      const [savedPath,currentPath]=await Promise.all([realpath(saved.launcher),realpath(target)]);
      return savedPath===currentPath;
    } catch(error) {
      if(error.code==='ENOENT'||error.code==='ENOTDIR')return resolve(saved.launcher)===target;
      throw error;
    }
  }
  async function ownsMarker() {
    return ownsInstallation(await readInstallation());
  }
  async function assertInstallationOwner() {
    const saved=await readInstallation();
    if(saved&&!(await ownsInstallation(saved)))throw failure('command_path_data_home_conflict',`This data home is already used by ${saved.command} from ${saved.launcher}. Choose a different data home (FARAVAN_DATA_HOME) for ${command}.`,marker);
    if(await markerState()==='foreign')throw failure('command_path_conflict',`The install marker at ${marker} is not managed by Faravan. Move it before trying again.`,marker);
  }

  async function install() {
    if(unsupported)return resultError(failure(unsupported.code,unsupported.message));
    let profiles=[profile];
    try {
      await assertInstallationOwner();
      const pathResult=await inspectPath();
      profiles=pathResult.profiles;
      if(pathResult.error)return resultError(pathResult.error,profiles);
      const found=pathResult.resolved, classified=await classify(found);
      if(classified.kind==='conflict')return resultError(failure('command_path_conflict',`Another ${command} command is already at ${found}.`,found),profiles);
      if(!target||!(await exists(target)))return resultError(failure('launcher_missing','The Faravan launcher is not available.',link),profiles);
      if(classified.kind==='managed') {
        await ensurePath(profiles);
        await recordInstallation();
        return {installed:true,path:found,launcher:target,profile:pathResult.profile,profiles,managed:true};
      }
      await mkdir(bin,{recursive:true,mode:0o700});
      let createLink=true;
      try {
        const info=await lstat(link);
        if(info.isSymbolicLink()) {
          if(!(await ownedLink(link)))throw failure('command_path_conflict',`Couldn't replace the existing command link at ${link}.`,link);
          if(await realpath(link).catch(()=>null))createLink=false;
          else if(!(await removeOwnedLink(link)))throw failure('command_path_conflict',`The command link at ${link} changed. Inspect it before trying again.`,link);
        } else throw failure('command_path_conflict',`Couldn't replace ${link}.`,link);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      if(createLink)await symlink(target,link);
      if(!(await exists(link)))throw failure('command_path_write_failed',`Couldn't write to ${bin}.`,link,bin);
      await ensurePath(profiles);
      const verified=await inspectPath();
      if(verified.error)throw verified.error;
      const final=await classify(verified.resolved);
      if(final.kind==='missing')throw failure('command_path_unresolved',`The login shell cannot resolve ${command}.`,link);
      if(final.kind==='conflict')throw failure('command_path_conflict',`Another ${command} command is already at ${final.path}.`,final.path);
      await recordInstallation();
      return {installed:true,path:final.path,launcher:target,profile:pathResult.profile,profiles,managed:true};
    } catch(error) {
      if(error.code&&error.code.startsWith('command_path_'))return resultError(error,profiles);
      return resultError(failure('command_path_write_failed',`Couldn't write to ${bin}.`,link,bin),profiles);
    }
  }

  async function uninstall() {
    if(unsupported)throw failure(unsupported.code,`${unsupported.message} Remove the Faravan link and profile lines manually if needed.`,link);
    if(!target)return status();
    let ownsProfile=await ownsMarker();
    for(const path of [link]) {
      try {
        const info=await lstat(path);
        if(info.isSymbolicLink()) {
          if(await removeOwnedLink(path))ownsProfile=true;
        }
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if(ownsProfile) {
      let zdotdir=env.ZDOTDIR||home;
      if(shell.endsWith('/zsh')) {
        try { zdotdir=(await loginShellEnvironment({home,env,platform})).zdotdir; } catch {}
      }
      for(const path of cleanupProfiles(home,env,zdotdir)) {
        const content=await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(content===null)continue;
        const updated=stripManagedBlock(content,profileMarker);
        if(updated!==content)await atomicWrite(path,updated,content,beforeMutation);
      }
    }
    if(await ownsMarker()) {
      const info=await lstat(marker);
      await beforeMutation('remove-marker',marker);
      const current=await lstat(marker).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(current&&current.dev===info.dev&&current.ino===info.ino&&await ownsMarker())await rm(marker);
    }
    const after=await status();
    return {installed:after.installed===true&&after.managed===true,path:after.error?.path??after.path};
  }

  async function verifyOnLaunch() {
    try {
      if(unsupported)return resultError(failure(unsupported.code,unsupported.message));
      if(!target)return await status();
      const found=(await inspectPath()).resolved;
      if(found) return await status();
      const managed=await ownsMarker();
      let linkState='missing';
      try {
        const info=await lstat(link);
        if(!info.isSymbolicLink())return await status();
        const owned=await ownedLink(link), actual=await realpath(link).catch(()=>null);
        linkState=owned?(actual?'valid':'dangling'):'foreign';
      }catch(error){if(error.code!=='ENOENT')throw error;}
      if(linkState==='foreign')return resultError(failure('command_path_conflict',`Another ${command} command is already at ${link}.`,link));
      if(!managed)return await install();
      if(linkState==='valid')return await status();
      return await install();
    } catch(error) { return resultError(error.code?error:failure('command_path_check_failed','Could not check the command-line tool.',link,bin)); }
  }

  async function withOwnershipLock(operation) {
    if(unsupported)return operation();
    let release;
    const lock=marker+'.lock';
    try {release=acquireProcessLockSync(lock);}
    catch(error) {
      if(error.code==='lock_busy')throw failure('lock_busy','Command setup is busy or its lock owner could not be verified. Close other Faravan setup windows and try again.',lock);
      throw failure('command_path_write_failed',`Couldn't lock ${marker}.`,marker,dirname(marker));
    }
    try {return await operation();}
    finally {release();}
  }
  async function lockedResult(operation) {
    try {return await withOwnershipLock(operation);}
    catch(error) {return resultError(error);}
  }

  // Repair calls install while holding the same lock; it must not reacquire it.
  return {status,install:()=>lockedResult(install),uninstall:()=>withOwnershipLock(uninstall),verifyOnLaunch:()=>lockedResult(verifyOnLaunch),link,target,profile};
}

async function loginShellEnvironment({home=process.env.HOME,env=process.env,platform=process.platform}={}) {
  const shell=env.SHELL||(platform==='darwin'?'/bin/zsh':'/bin/bash');
  if(platform==='win32')throw failure('command_path_unsupported_platform','The command-line tool is not supported on this platform.');
  if(!shell.endsWith('/bash')&&!shell.endsWith('/zsh'))throw failure('command_path_unsupported_shell','This shell is not supported yet.');
  const format=`printf '%s\\n%s\\n%s\\n' '${LOGIN_PATH_BEGIN}' "$PATH" '${LOGIN_PATH_END}'; printf '%s\\n%s\\n%s\\n' '${LOGIN_ZDOTDIR_BEGIN}' "\${ZDOTDIR:-$HOME}" '${LOGIN_ZDOTDIR_END}'`;
  try {
    const {stdout}=await new Promise((resolve,reject)=>{
      const child=spawn(shell,['-lc',format],{env:{...env,HOME:home},stdio:['ignore','pipe','pipe'],detached:true});
      let stdout='',stderr='',timedOut=false;
      const signalGroup=signal=>{
        if(!child.pid)return;
        try{process.kill(-child.pid,signal);}
        catch(error){
          if(error.code==='ESRCH')return;
          try{child.kill(signal);}catch{}
        }
      };
      child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
      child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
      const timeoutMs=15000,killGraceMs=250;
      const timer=setTimeout(()=>{
        timedOut=true;signalGroup('SIGTERM');
        setTimeout(()=>{
          signalGroup('SIGKILL');
          reject(new Error(`timed out after ${timeoutMs}ms`));
        },killGraceMs);
      },timeoutMs-killGraceMs);
      child.once('error',error=>{
        if(timedOut)return;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close',(code,signal)=>{
        if(timedOut)return; // The process group can outlive the shell; keep the KILL deadline.
        clearTimeout(timer);
        if(code===0)resolve({stdout});
        else reject(new Error(stderr.trim()||`login shell exited with ${signal??code}`));
      });
    });
    const match=stdout.match(new RegExp(`${LOGIN_PATH_BEGIN}\\r?\\n([\\s\\S]*?)\\r?\\n${LOGIN_PATH_END}`));
    if(!match)throw new Error('The login shell did not return its PATH.');
    const zdotdirMatch=stdout.match(new RegExp(`${LOGIN_ZDOTDIR_BEGIN}\\r?\\n([\\s\\S]*?)\\r?\\n${LOGIN_ZDOTDIR_END}`));
    return {path:match[1],zdotdir:zdotdirMatch?.[1]||env.ZDOTDIR||home};
  } catch(error) {
    throw failure('command_path_shell_failed',`Could not read PATH from ${shell}: ${error.message}`);
  }
}

export async function loginPath(options={}) {
  return (await loginShellEnvironment(options)).path;
}
