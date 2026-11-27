// Find a provider's own command (`claude`, `codex`) for a sign-in started by the desktop app.
// The app is launched by the desktop or launchd with a minimal PATH, while the person's PATH lives in their login
// shell's startup files. GUI-launched developer tools (VS Code, shell-env, fix-path) read PATH from that shell; so do we,
// once per process and only for this lookup. Neither the PATH nor any shell output is logged.
import {execFile} from 'node:child_process';
import {accessSync,constants,statSync} from 'node:fs';
import {userInfo} from 'node:os';
import path from 'node:path';

const MARKER='__FARAVAN_PATH_8f3a__';
const missing=provider=>Object.assign(new Error('The '+provider+' command could not be found on this computer.'),{code:'provider_cli_missing',provider});

const findOn=(searchPath,name)=>String(searchPath||'').split(path.delimiter).filter(path.isAbsolute).map(dir=>path.join(dir,name))
  .find(candidate=>{try{accessSync(candidate,constants.X_OK);return statSync(candidate).isFile();}catch{return false;}});

// Runs the shell with stdin ignored; resolves to its stdout text.
const defaultRunShell=(shell,args,{env,timeoutMs})=>new Promise((resolve,reject)=>{
  const child=execFile(shell,args,{env,timeout:timeoutMs,maxBuffer:1<<20,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout));
  child.stdin?.end();
});
const loginShell=env=>{
  if(env.SHELL)return env.SHELL;
  try{return userInfo().shell||'/bin/sh';}catch{return '/bin/sh';}
};
const parsePath=text=>{
  const parts=String(text).split(MARKER);
  return parts.length>=3&&parts[1]?parts[1].trim():'';
};
const script='printf "%s%s%s" "'+MARKER+'" "$PATH" "'+MARKER+'"';

// One shell read per runner, shell and starting PATH, for the life of the process.
const cache=new WeakMap();
async function loginShellPath({env,shell,runShell,timeoutMs}){
  for(const flags of ['-ilc','-lc']){
    try{
      const found=parsePath(await runShell(shell,[flags,script],{env,timeoutMs}));
      if(found)return found;
    }catch{/* try the next flag set */}
  }
  return '';
}

export async function resolveHostCli(name,{env=process.env,shell=loginShell(env),runShell=defaultRunShell,timeoutMs=10000}={}) {
  const direct=findOn(env.PATH,name);
  if(direct)return {path:direct,searchPath:String(env.PATH)};
  if(!cache.has(runShell))cache.set(runShell,new Map());
  const reads=cache.get(runShell),key=shell+'\0'+env.PATH;
  if(!reads.has(key))reads.set(key,loginShellPath({env,shell,runShell,timeoutMs}));
  const searchPath=await reads.get(key);
  if(!searchPath)reads.delete(key); // a failed shell read may succeed next time
  const found=findOn(searchPath,name);
  if(!found)throw missing(name);
  return {path:found,searchPath};
}
