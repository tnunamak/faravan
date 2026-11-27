import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configHome} from '../local-state.mjs';
import {acquireProcessLock} from './lock.mjs';
import {discoverRunningApp} from './macos-launch.mjs';
import {residentQuit,setResidentQuit} from './resident-intent.mjs';
import {superviseProcess} from './process-supervisor.mjs';

// systemd/Task Scheduler own this process. App and icon have independent
// restart obligations; the persisted Quit gates both without changing lending.
export async function runResident({home=configHome(),background=false,trayPath=null,
  discover=discoverRunningApp,intervalMs=1000,delayMs=1000,ownerGone,
  spawnApp=()=>spawn(process.execPath,[fileURLToPath(new URL('../../bin/faravan',import.meta.url)),'app'],{
    stdio:'ignore',env:{...process.env,FARAVAN_HOME:home,FARAVAN_NO_BROWSER:'1',FARAVAN_RESIDENT_AUTOSTART:'1'},
  }),spawnTray=()=>spawn(trayPath,[],{stdio:['pipe','ignore','ignore'],env:{...process.env,FARAVAN_TRAY_OWNER:'stdin'}})}={}) {
  if(!background)setResidentQuit(false,home);
  if(residentQuit(home))return;
  await mkdir(join(home,'v1'),{recursive:true,mode:0o700});
  const acquire=async name=>{
    try{return await acquireProcessLock(join(home,'v1',name),{timeoutMs:0});}
    catch(error){if(error.code==='lock_busy')return null;throw error;}
  };
  let release=await acquire('resident.lock'),releaseTray;
  try{if(trayPath)releaseTray=await acquire('resident-tray.lock');}
  catch(error){release?.();throw error;}
  if(!release&&!releaseTray)return;
  let app,tray,timer,checking=false,stopping=false,finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const shouldRestart=()=>!stopping&&!residentQuit(home);
  const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);
    Promise.allSettled([app?.stop(),tray?.stop()]).then(finish);};
  const check=async()=>{
    if(stopping||checking)return;
    checking=true;
    try {
      if(!shouldRestart()){stop();return;}
      release??=await acquire('resident.lock');
      if(release&&!app&&!await discover(home))app=superviseProcess({launch:spawnApp,shouldRestart,delayMs});
    }finally{checking=false;}
  };
  try {
    await check();
    if(releaseTray)tray=superviseProcess({launch:spawnTray,shouldRestart,delayMs});
    timer=setInterval(()=>check().catch(()=>{}),intervalMs);
    ownerGone?.then(stop);
    await done;
  }finally{clearInterval(timer);release?.();releaseTray?.();}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.includes('--enable'))setResidentQuit(false);
  else {
    const ownerGone=new Promise(resolve=>{
      for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,resolve);
    });
    const trayIndex=args.indexOf('--tray');
    await runResident({background:args.includes('--background'),trayPath:trayIndex>=0?args[trayIndex+1]:null,ownerGone});
  }
}
