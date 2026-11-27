import {durableWriteAsync} from '../durable-write.mjs';
// One GUI LaunchAgent owns the native launcher. No root services or lending changes.
import {execFile} from 'node:child_process';
import {access, mkdir, readFile, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {channelIdentity} from '../channel-identity.mjs';

export const LAUNCH_AGENT_LABEL='com.faravan.agent';
const launchAgentLabel=()=>channelIdentity().launchAgentLabel;
const DISABLED='<key>Disabled</key><true/>';
const activePlist=text=>text?.replace(DISABLED,'');
const xml=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
// Carry only explicit profile selectors, never the caller's general environment.
export function launchProfileEnvironment(environment=process.env, home) {
  const selected={};
  for(const key of ['FARAVAN_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']){
    const value=key==='FARAVAN_HOME'&&home!==undefined?home:environment[key];
    if(value===undefined||value==='')continue;
    if(typeof value!=='string'||!isAbsolute(value)||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(value))
      throw new Error(key+' must be an absolute path without unsafe XML characters.');
    selected[key]=value;
  }
  return selected;
}
export function launchAgentPlist(launcher, label = launchAgentLabel(), environment={}) {
  if(typeof launcher!=='string'||!isAbsolute(launcher)||/[\u0000-\u001f]/.test(launcher))throw new Error('Launcher must be an absolute path without control characters.');
  const selected=launchProfileEnvironment(environment);
  const entries=Object.entries(selected).map(([key,value])=>'<key>'+key+'</key><string>'+xml(value)+'</string>').join('');
  const profile=entries?'<key>EnvironmentVariables</key><dict>'+entries+'</dict>\n':'';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>--background</string></array>
${profile}<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>3</integer>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}
const defaultRun=(command,args)=>new Promise(resolve=>execFile(command,args,{timeout:10000},error=>resolve({code:error?(error.code??1):0})));
export function bundledLauncher(modulePath=fileURLToPath(import.meta.url)) {
  const marker='/Contents/Resources/faravan/';
  const at=modulePath.lastIndexOf(marker);
  return at<0?null:join(modulePath.slice(0,at),'Contents/MacOS/faravan-launch');
}
export function createMacAutostart({platform=process.platform,userHome=homedir(),uid=process.getuid?.(),launcher=bundledLauncher(),run=defaultRun,channel=channelIdentity(),environment=process.env}={}) {
  const profile=launchProfileEnvironment(environment);
  const label=channel.launchAgentLabel || LAUNCH_AGENT_LABEL;
  const plist=join(userHome,'Library/LaunchAgents',label+'.plist'),target='gui/'+uid+'/'+label;
  const supported=platform==='darwin';
  async function status() {
    if(!supported)return {supported:false,available:false,enabled:false,needsRepair:false};
    const saved=await readFile(plist,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const translocated=Boolean(launcher?.includes('/AppTranslocation/'));
    const available=Boolean(launcher)&&!translocated&&await access(launcher,constants.X_OK).then(()=>true,()=>false);
    const enabled=saved!==null&&!saved.includes(DISABLED);
    return {supported:true,available,enabled,needsRepair:enabled&&(!available||activePlist(saved)!==launchAgentPlist(launcher,label,profile)),...(translocated?{reason:'move_to_applications'}:{})};
  }
  let pending=Promise.resolve();
  async function change(enabled) {
    if(typeof enabled!=='boolean')throw new Error('enabled must be a boolean.');
    if(!supported)throw new Error('Launch at login is available on macOS app installs.');
    if(!Number.isSafeInteger(uid)||uid<0)throw new Error('A GUI user session is required.');
    if(!enabled){
      const result=await run('launchctl',['disable',target]);
      if(result.code!==0)throw new Error('launchctl could not disable launch at login.');
      const saved=await readFile(plist,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(saved!==null)await durableWriteAsync(plist,activePlist(saved).replace('</dict></plist>',DISABLED+'</dict></plist>'));
      return status();
    }
    const view=await status();
    if(!view.available)throw new Error(view.reason==='move_to_applications'?'Move Faravan.app to Applications and open that copy before enabling launch at login.':'Install and open the installed Faravan.app before enabling launch at login.');
    const previous=await readFile(plist,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    await mkdir(dirname(plist),{recursive:true,mode:0o700});
    await durableWriteAsync(plist,launchAgentPlist(launcher,label,profile));
    try {
      const enable=await run('launchctl',['enable',target]);
      if(enable.code!==0)throw new Error('launchctl could not enable launch at login.');
      const loaded=await run('launchctl',['print',target]);
      // Never boot out a live owner to update a preference: it may be serving this request.
      // launchd reloads the updated file at the next login. Missing jobs can start now.
      if(loaded.code!==0){
        if(![3,113].includes(loaded.code))throw new Error('launchctl could not inspect the login agent.');
        const result=await run('launchctl',['bootstrap','gui/'+uid,plist]);
        if(result.code!==0)throw new Error('launchctl could not register launch at login. Check macOS Login Items and try again.');
      }
    }catch(error){
      if(previous!==null)await durableWriteAsync(plist,previous);
      else await rm(plist,{force:true});
      if(previous===null||previous.includes(DISABLED))await run('launchctl',['disable',target]);
      throw error;
    }
    return status();
  }
  return {status,setEnabled:enabled=>{const next=pending.then(()=>change(enabled));pending=next.catch(()=>{});return next;}};
}

export async function runAutostart(argv,options={}) {
  const [verb,...extra]=argv,stdout=options.stdout??process.stdout,stderr=options.stderr??process.stderr;
  if(!['status','on','off'].includes(verb)||extra.some(v=>v!=='--json')){stderr.write('Usage: faravan autostart status|on|off [--json]\n');return 2;}
  try {
    const agent=createMacAutostart(options),view=verb==='status'?await agent.status():await agent.setEnabled(verb==='on');
    stdout.write(extra.includes('--json')?JSON.stringify(view)+'\n':view.needsRepair?'Launch at login needs repair. Run faravan autostart on from the installed app.\n':view.enabled?'Launch at login is on.\n':view.available?'Launch at login is off.\n':'Launch at login requires the installed macOS app.\n');
    return 0;
  }catch(error){stderr.write(error.message+'\n');return 1;}
}
