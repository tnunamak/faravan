import {sanitizedEnv,sbxChildEnv,suppressChildBrowserLaunch} from './docker-backend.mjs';
import {acquireCredentialMutation,spawnCredentialWriter} from './sandbox-credentials.mjs';
import {createProviderSource,publishProviderGeneration,savePrivateFile} from './credential-generations.mjs';
import {execFile} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {resolveHostCli} from './host-cli.mjs';
import {createHash} from 'node:crypto';
import {access,constants} from 'node:fs/promises';
import {join} from 'node:path';

const unresolved=()=>Object.assign(new Error('A previous sign-in may still be changing credentials.'),{code:'credential_writer_unresolved'});
const run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:15000,maxBuffer:1<<20,encoding:'utf8'},
  (error,stdout)=>error?reject(error):resolve(stdout)));

// The Keychain service the Claude CLI uses when CLAUDE_SECURESTORAGE_CONFIG_DIR names `directory`.
export const claudeKeychainService=directory=>
  'Claude Code-credentials-'+createHash('sha256').update(directory.normalize('NFC')).digest('hex').slice(0,8);

// Hard guard: only the suffixed entry for Faravan's own source folder may be touched. The unsuffixed
// `Claude Code-credentials` item is the owner's normal Claude login and is never read or deleted.
export const ownKeychainService=service=>{
  if(typeof service!=='string' || service==='Claude Code-credentials' || !/^Claude Code-credentials-[0-9a-f]{8}$/.test(service))throw unresolved();
  return service;
};

// On macOS the Claude CLI keeps its login in the Keychain, not in the source folder. Move that one item into the
// source folder's credentials file, then delete the item. The value is never logged or put in an error.
export async function darwinKeychainSource(directory,{security='/usr/bin/security'}={}) {
  const service=ownKeychainService(claudeKeychainService(directory));
  const file=join(directory,'.credentials.json');
  if(await access(file,constants.F_OK).then(()=>true,()=>false))return {};
  let text;
  try {
    text=(await run(security,['find-generic-password','-s',service,'-w'])).trim();
    const oauth=JSON.parse(text)?.claudeAiOauth;
    if(typeof oauth?.accessToken!=='string' || !oauth.accessToken || typeof oauth.refreshToken!=='string' || !oauth.refreshToken || !Number.isFinite(oauth.expiresAt))throw new Error('shape');
    await savePrivateFile(file,text);
  } catch {throw unresolved();}
  try {await run(security,['delete-generic-password','-s',service]);return {};}
  catch {return {warning:'The Keychain entry could not be removed.'};}
}

const mismatch=()=>Object.assign(new Error('The pasted address is not from this sign-in.'),{code:'signin_redirect_mismatch'});
// The redirect target Codex's own login URL names, kept only when it is a loopback http address with a state.
const codexRedirectTarget=providerUrl=>{
  try {
    const query=new URL(providerUrl).searchParams,redirect=new URL(query.get('redirect_uri')),state=query.get('state');
    if(redirect.protocol!=='http:' || !['localhost','127.0.0.1'].includes(redirect.hostname) || !redirect.port || !state)return null;
    return {port:redirect.port,path:redirect.pathname,state};
  } catch {return null;}
};
// Check a pasted address against this flow's own login URL. Anything else throws and sends nothing.
export const codexRedirectRequest=(providerUrl,pasted)=>{
  const target=codexRedirectTarget(providerUrl);
  let url;
  try {url=new URL(String(pasted).trim());} catch {throw mismatch();}
  // Exactly one code and one state: a repeated name could pass this check and mean something else to the listener.
  const codes=url.searchParams.getAll('code'),states=url.searchParams.getAll('state');
  if(!target || url.protocol!=='http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.port!==target.port ||
    url.pathname!==target.path || codes.length!==1 || !codes[0] || states.length!==1 || states[0]!==target.state)throw mismatch();
  // Only the code and state go on: anything else in the pasted address is dropped.
  return {port:Number(target.port),path:target.path+'?'+new URLSearchParams({code:codes[0],state:states[0]})};
};
// One GET to the CLI's own listener on this computer, never followed anywhere else. It settles within 5 seconds whatever the
// listener does: a reply, an upgrade, a closed connection or silence. The error never carries a URL, code or state.
const REPLAY_DEADLINE_MS=5000;
// Complete OSC ends at BEL or ESC backslash. Broken OSC resumes plain text at CR/LF or 2048 body bytes.
// A partial bounded OSC remains hidden until a later chunk completes it or establishes recovery.
function stripOsc(raw) {
  let text='', cursor=0, opener;
  while ((opener=raw.indexOf('\u001b]',cursor))!==-1) {
    text+=raw.slice(cursor,opener);
    let end=opener+2, bytes=0, complete=false, broken=false;
    while (end<raw.length) {
      if (bytes>=2048 || raw[end]==='\r' || raw[end]==='\n') { broken=true; break; }
      if (raw[end]==='\u0007') { end++; complete=true; break; }
      if (raw[end]==='\u001b' && raw[end+1]==='\\') { end+=2; complete=true; break; }
      const character=String.fromCodePoint(raw.codePointAt(end));
      bytes+=Buffer.byteLength(character,'utf8'); end+=character.length;
    }
    if (bytes>=2048 && !complete) broken=true;
    if (!complete && !broken) return text;
    cursor=broken?opener+2:end;
  }
  return text+raw.slice(cursor);
}
const CSI_COMPLETE=/\u001b\[[0-?]*[ -\/]*[@-~]/g;
const CSI_OPEN=/\u001b\[[0-?]*[ -\/]*$/;
const OSC8_URL=/\u001b\]8;[^;\u0007\u001b\r\n]*;([^\u0007\u001b\r\n]*)(?:\u0007|\u001b\\)/g;
export function stripTerminalCodes(raw) {
  return stripOsc(raw).replace(CSI_COMPLETE,'').replace(CSI_OPEN,'').replace(/\u001b$/,'').replace(/\u001b[\u0030-\u007e]/g,'');
}
// The URLs a terminal hyperlink (OSC 8) points to, as printed text for the same exact-link check.
const hyperlinkTargets=raw=>[...raw.matchAll(OSC8_URL)].filter(m=>Buffer.byteLength(m[0].slice(2).replace(/(?:\u0007|\u001b\\)$/,''),'utf8')<2048).map(m=>m[1]).filter(Boolean);
const DEVICE_CODE_LINE=/^\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m;
// What the Codex CLI prints when OpenAI refuses a device code: the account setting is off or the request failed.
const DEVICE_CODE_REFUSED=/failed to request device code|device code request failed with status|device code exchange failed|device code login|code (?:has )?expired|device code (?:is )?expired/i;
// The class of a failed device sign-in, from what the CLI printed. Only a fixed code leaves; the text never does.
export const deviceFailureReason=text=>{
  if(!DEVICE_CODE_REFUSED.test(text))return null;
  if(/code (?:has )?expired|device code (?:is )?expired/i.test(text))return 'codex_device_code_expired';
  if(/device code exchange failed/i.test(text))return 'codex_device_code_exchange_failed';
  const status=/device code request failed with status (\d{3})/i.exec(text)?.[1];
  if(status){
    if(status==='401' || status==='403')return 'codex_device_code_unavailable';
    if(status==='429')return 'codex_device_code_rate_limited';
    return 'codex_device_code_service_unavailable';
  }
  if(/device code login/i.test(text))return 'codex_device_code_unavailable';
  return 'codex_device_code_service_unavailable';
};
const DEVICE_LINK_HOST='auth.openai.com',DEVICE_LINK_PATH='/codex/device',DEVICE_GRACE_MS=60_000,DEFAULT_CODE_LIFE_MS=15*60_000;
// The one verification link a device sign-in may show: https, this host and path, no userinfo, the default port, no query.
export const deviceVerificationLink=url=>url.protocol==='https:' && url.hostname===DEVICE_LINK_HOST && url.pathname===DEVICE_LINK_PATH &&
  !url.username && !url.password && url.port==='' && !url.search && !url.hash ? 'https://'+DEVICE_LINK_HOST+DEVICE_LINK_PATH : null;
const failureError=reason=>Object.assign(new Error('The device code sign-in did not start.'),{diagnosticReason:reason});
const replayRedirect=({port,path},{deadlineMs=REPLAY_DEADLINE_MS}={})=>new Promise((resolve,reject)=>{
  let settled=false,req;
  const settle=(done,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(done===resolve)resolve(value);else{try{req?.destroy();}catch{}reject(Object.assign(new Error('The sign-in listener did not answer.'),{code:'signin_redirect_unreachable'}));}};
  const timer=setTimeout(()=>settle(reject),deadlineMs);
  req=httpRequest({host:'127.0.0.1',port,path,method:'GET'},res=>{
    // 2xx and 3xx are a good callback (Codex answers with a redirect to its success page, never followed). 4xx and 5xx are errors.
    if(res.statusCode<200 || res.statusCode>=400){res.resume();settle(reject);return;}
    res.resume();res.once('end',()=>settle(resolve));res.once('error',()=>settle(reject));res.once('close',()=>settle(reject));
  });
  req.once('upgrade',()=>settle(reject));req.once('error',()=>settle(reject));req.once('close',()=>settle(reject));
  req.end();
});

// Native provider sign-in writes only a fresh provider-owned directory. The
// provider never receives the path of a published generation or consumer copy.
export async function startProviderGenerationAuth(spec, {onHandle, home=sbxChildEnv().HOME,
  providerBin, env=process.env, platform=process.platform, securityBin, urlTimeoutMs=75000, completionTimeoutMs, method, deviceCodeLifeMs}={}) {
  const provider=spec.install;
  if(!['codex','claude'].includes(provider))throw new Error('Provider generation sign-in is unavailable.');
  // Codex signs in with a device code unless the loopback browser flow is asked for. The code lives 15 minutes.
  const device=provider==='codex' && method!=='browser';
  const browserWindowMs=completionTimeoutMs??300000;
  // The desktop app's PATH lacks the person's own command folders; find the command through their login shell.
  const host=providerBin?null:await resolveHostCli(provider,{env});
  const release=await acquireCredentialMutation(home,{isolatedSources:true,concurrentSources:true});
  let source,child;
  try {
    source=await createProviderSource(home,provider);
    const childEnv=suppressChildBrowserLaunch({...sanitizedEnv(env),...(host?{PATH:host.searchPath}:{}),HOME:source.directory,
      CODEX_HOME:source.directory,CLAUDE_CONFIG_DIR:source.directory,
      ...(provider==='claude'?{CLAUDE_SECURESTORAGE_CONFIG_DIR:source.directory}:{})});
    const args=provider==='codex'?['-c','cli_auth_credentials_store="file"','login',...(device?['--device-auth']:[])]:['auth','login','--claudeai'];
    child=await spawnCredentialWriter(home,providerBin || host.path,args,{env:childEnv,
      credentialIsolation:{kind:'provider-source',id:source.id}});
  } catch(error) {await release();throw error;}

  let output='',resolveURL,rejectURL,completion,failure=null;
  const publication=new AbortController();
  const urlReady=new Promise((resolve,reject)=>{resolveURL=resolve;rejectURL=reject;});
  // Install rejection handling immediately: launch errors can precede the await.
  urlReady.catch(()=>{});
  // The group is signalled while the sign-in CLI runs, and once more as it is reaped (its helpers may outlive it). After that its
  // number may name an unrelated process, so a late cancel or the completion timer signals nothing.
  let reaped=false;
  const stop=()=>{if(reaped)return;try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const handle={harness_id:spec.harness_id,status:'pending',url:undefined,code:undefined,acceptsCode:false,
    // Device code: the moment the code stops working (ms since the epoch), set when the code is first seen.
    expiresAt:undefined,
    // Codex: a sign-in approved on another device ends at a localhost page that cannot load. The pasted address finishes it.
    get acceptsRedirect(){return provider==='codex' && !device && handle.status==='awaiting-browser' && codexRedirectTarget(handle.url)!==null;},
    async submitRedirect(pasted){
      if(!handle.acceptsRedirect)throw mismatch();
      await replayRedirect(codexRedirectRequest(handle.url,pasted));
    },
    cancel(){handle.status='cancelled';publication.abort();stop();clearTimeout(deadline);void ended.then(unlock);},
    submitCode(code){
      if(!handle.acceptsCode || handle.status!=='awaiting-browser' || typeof code!=='string' || !/^[A-Za-z0-9#_.~-]{8,512}$/.test(code))throw new Error('Sign-in code is not valid.');
      child.stdin.write(code+'\n');
    },
    waitForCompletion(){return completion ??= finish();},
  };
  const capture=chunk=>{
    output=(output+chunk.toString('utf8')).slice(-65536);
    // The CLI colors the link and the code even through a pipe; match on the text without terminal color codes.
    const text=stripTerminalCodes(output);
    handle.acceptsCode=/paste (the )?code here/i.test(text);
    if(device){
      failure=deviceFailureReason(text);
      if(!handle.code){
        const found=DEVICE_CODE_LINE.exec(text);
        if(found){
          handle.code=found[1];
          const minutes=/expires in (\d{1,3}) minutes?/i.exec(text)?.[1];
          handle.expiresAt=Date.now()+(deviceCodeLifeMs??(minutes?Number(minutes)*60_000:DEFAULT_CODE_LIFE_MS));
        }
      }
    }
    const candidates=[...(text.match(/https:\/\/[^\s<>"']+/g) || []),...hyperlinkTargets(output)];
    for(const candidate of candidates){
      let url;try{url=new URL(candidate);}catch{continue;}
      const allowed=provider==='codex'?['auth.openai.com','auth0.openai.com','chatgpt.com']:['claude.ai','claude.com','console.anthropic.com'];
      // A device sign-in shows only its one verification link; any other link in the output (a help link) is ignored.
      const link=device?deviceVerificationLink(url):allowed.includes(url.hostname)?url.href:null;
      if(!handle.url && link){
        handle.url=link;
        if(!device){handle.status='awaiting-browser';resolveURL();}
      }
    }
    // A device sign-in is ready to show only with both the link and the code.
    if(device && handle.url && handle.code && handle.status==='pending'){handle.status='awaiting-browser';armDeadline(Math.max(0,handle.expiresAt-Date.now())+DEVICE_GRACE_MS);resolveURL();}
  };
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  child.stdin.on('error',()=>{});
  const ended=new Promise(resolve=>{
    const end=code=>{
      stop();reaped=true;clearTimeout(deadline);
      child.stdout.destroy();child.stderr.destroy();
      if(handle.status!=='awaiting-browser')rejectURL(failure?failureError(failure):new Error('Provider sign-in ended before returning a login URL.'));
      resolve(code);
    };
    child.once('error',()=>end(-1));child.once('exit',end);
  });
  // Browser and Claude flows start their deadline now. A device flow starts it when its code is ready, so a slow start
  // does not eat the person's time.
  let deadline;
  const armDeadline=ms=>{clearTimeout(deadline);deadline=setTimeout(()=>{handle.status='failed';publication.abort();stop();},ms);deadline.unref?.();};
  if(!device)armDeadline(browserWindowMs);
  // Release serialization on every exit, including cancellation before the
  // consumer calls waitForCompletion. Receipts continue describing the source.
  let releasePromise;
  const unlock=()=>releasePromise ??= release();
  ended.then(()=>{if(handle.status==='cancelled' || handle.status==='failed')void unlock();});
  async function finish(){
    try {
      const code=await ended;
      if(['cancelled','failed'].includes(handle.status) || code!==0){handle.status=handle.status==='cancelled'?'cancelled':'failed';return {status:'failed',detail:'Provider sign-in was not completed.',...(failure && handle.status==='failed' && code!==0?{diagnosticReason:failure}:{})};}
      const extra=provider==='claude' && platform==='darwin'?await darwinKeychainSource(source.directory,{security:securityBin}):{};
      await publishProviderGeneration(home,source,{signal:publication.signal});
      handle.status='complete';
      return {status:'complete',detail:'Provider sign-in is ready.',...extra};
    }finally{clearTimeout(deadline);await unlock();}
  }
  onHandle?.(handle);
  const urlDeadline=setTimeout(()=>{rejectURL(new Error('Provider sign-in did not return a login URL.'));handle.cancel();},urlTimeoutMs);
  try{await urlReady;return handle;}
  catch(error){handle.cancel();await ended;await unlock();throw error;}
  finally{clearTimeout(urlDeadline);}
}
