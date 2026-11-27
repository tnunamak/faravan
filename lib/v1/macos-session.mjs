import {execFile} from 'node:child_process';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {launchAgentPlist,launchProfileEnvironment,bundledLauncher} from './autostart.mjs';
import {channelIdentity} from '../channel-identity.mjs';

const runLaunchctl=(command,args)=>new Promise(resolve=>execFile(command,args,{timeout:10000},error=>resolve({code:error?(Number.isInteger(error.code)&&error.code!==0?error.code:-1):0})));

// A plist outside Library/LaunchAgents lasts only for this GUI session. Login
// startup remains a separate preference; launchd owns crashes in either case.
export async function ensureMacSession({home,uid=process.getuid?.(),launcher=bundledLauncher(),
  label=channelIdentity().launchAgentLabel+'.resident',run=runLaunchctl,environment=process.env}={}) {
  if(!Number.isSafeInteger(uid)||uid<0||!launcher)throw new Error('A bundled app and GUI session are required.');
  if(typeof home!=='string'||home==='')throw new Error('A session home is required.');
  const profile=launchProfileEnvironment(environment,home);
  const target='gui/'+uid+'/'+label;
  const loaded=await run('launchctl',['print',target]);
  if(loaded.code!==0){
    if(![3,113].includes(loaded.code))throw new Error('Could not inspect the Faravan session. Reopen Faravan and try again; if this persists, log out of macOS and back in.');
    const directory=join(home,'v1'),plist=join(directory,'resident.plist');
    await mkdir(directory,{recursive:true,mode:0o700});
    const contents=launchAgentPlist(launcher,label,profile).replace('<string>--background</string>','<string>--background</string><string>--managed</string>');
    await writeFile(plist+'.new',contents,{mode:0o600});
    await rename(plist+'.new',plist);
    const registered=await run('launchctl',['bootstrap','gui/'+uid,plist]);
    if(!Number.isInteger(registered.code)||registered.code<0||registered.code!==0&&(await run('launchctl',['print',target])).code!==0)throw new Error('Could not register Faravan session recovery. Reopen Faravan and try again; if this persists, log out of macOS and back in.');
  }
  // No -k: opening Faravan again must not kill the app already doing work.
  if((await run('launchctl',['kickstart',target])).code!==0)throw new Error('Could not start the Faravan session. Reopen Faravan and try again; if this persists, log out of macOS and back in.');
}
