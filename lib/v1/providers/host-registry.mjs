import {readFileSync} from 'node:fs';
import {createProviderRegistry} from './index.mjs';
import {createNativeHostProviders} from './native-host.mjs';
import {createClaudeProvider} from './claude.mjs';
import {createCodexProvider} from './codex.mjs';
import {createPiProvider} from './pi.mjs';
import {ok,fault} from '../accounts.mjs';

// Identity is a bounded, authenticated JSON object, not a credential digest.
async function identitySubject(response,field,signal) {
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('identity_refused');}
  if(!response.body)throw Error('identity_missing');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>65536)throw Error('identity_too_large');chunks.push(Buffer.from(value));}
    signal.throwIfAborted();
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,field))
      throw Error('identity_missing');
    const subject=value[field];
    if(typeof subject!=='string'||!subject||subject.length>512||subject.trim()!==subject||/[\u0000-\u001f\u007f]/.test(subject))
      throw Error('identity_invalid');
    return subject;
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}

// Explicit Faravan configuration, never a discovery of the owner's CLI files.
// Each entry describes a key-enrolled HTTP service and its installed guest CLI.
// Native subscription drivers own independent host OAuth flows; explicit
// configuration can replace a provider without discovering CLI credentials.
export function loadHostProviders(file) {
  try {const entries=JSON.parse(readFileSync(file,'utf8'));
    if(!Array.isArray(entries))throw Error('invalid_provider_configuration');return entries;
  }catch(error){if(error.code==='ENOENT')return [];throw error;}
}
// Self-hosted pi is data too: a local_harness descriptor, an explicit host
// subject, and the CLI shape. It has no secret; its guest key is only a job key
// for the host proxy, and its destinations are loopback services (pi.mjs).
const ENV_NAME=/^[A-Z][A-Z0-9_]*$/;
const PI_GUEST_PROVIDER='faravan';
function piFromConfiguration(config,proxyOrigin) {
  const {descriptor,identity,command,args=[],modelFlag,effortFlag,keyEnv,baseUrlEnv,modelsEnv,effortValuePrefix}=config;
  if(typeof command!=='string'||!command||!Array.isArray(args)||!args.every(v=>typeof v==='string')||
    typeof modelFlag!=='string'||!modelFlag||(effortFlag!==undefined&&(typeof effortFlag!=='string'||!effortFlag))||
    !ENV_NAME.test(keyEnv)||!(ENV_NAME.test(baseUrlEnv??'')||ENV_NAME.test(modelsEnv??''))||
    (baseUrlEnv!==undefined&&!ENV_NAME.test(baseUrlEnv))||(modelsEnv!==undefined&&!ENV_NAME.test(modelsEnv))||typeof identity!=='string'||!identity||
    (effortValuePrefix!==undefined&&typeof effortValuePrefix!=='string'))
    throw Error('invalid_provider_configuration');
  const adapter=(()=>{try{return createPiProvider({descriptor,identity,createRun:({selection,jobKey,job,receipt,enforcement})=>{
    if(selection.effortId!==null&&!effortFlag)return fault('effort_unavailable');
    const origin=config.guestProxyOrigin??proxyOrigin();
    const baseUrl=new URL('/api/account-proxy/'+encodeURIComponent(descriptor.id),origin).href;
    // pi reads its endpoint from a models file, not from an environment variable. The guest launcher writes this
    // text to its own agent directory. It holds the endpoint and model names; the key is only named, never stored.
    const models=modelsEnv===undefined?null:JSON.stringify({providers:{[PI_GUEST_PROVIDER]:{baseUrl,api:'openai-completions',apiKey:'$'+keyEnv,
      models:descriptor.models.filter(m=>m.enabled).map(m=>({id:m.id,reasoning:m.efforts.length>0}))}}});
    return ok({schemaVersion:1,command,args:[...args,...(models===null?[]:['--provider',PI_GUEST_PROVIDER]),modelFlag,selection.modelId,
      ...(selection.effortId===null?[]:[effortFlag,(effortValuePrefix??'')+selection.effortId]),job.promptText],
      env:{[keyEnv]:jobKey,...(baseUrlEnv===undefined?{}:{[baseUrlEnv]:baseUrl}),...(models===null?{}:{[modelsEnv]:models})},
      proxy:{providerId:descriptor.id,origin:new URL(origin).origin},receipt,enforcement});
  }});}catch{throw Error('invalid_provider_configuration');}})();
  return {...adapter,harnessId:config.harnessId??descriptor.id};
}
export function createHostProviderRegistry({configurations=[],proxyOrigin,fetch:send=globalThis.fetch,clock=Date.now,nativeDrivers,piProvider}) {
  const configuredIds=new Set(configurations.map(config=>config.descriptor?.id));
  const native=createNativeHostProviders({proxyOrigin,fetch:send,clock,...(nativeDrivers?{drivers:nativeDrivers}:{})})
    .filter(adapter=>!configuredIds.has(adapter.descriptor.id));
  return createProviderRegistry([...native,...(piProvider?[piProvider]:[]),...configurations.map(config=>{
    if(config.descriptor?.signInKind==='local_harness')return piFromConfiguration(config,proxyOrigin);
    const {descriptor:d,command,args=[],modelFlag,effortFlag,keyEnv,baseUrlEnv}=config;
    if(d?.signInKind!=='api_key'||d.refreshKind!=='none'||typeof command!=='string'||!command||
      !Array.isArray(args)||!args.every(v=>typeof v==='string')||
      ![keyEnv,baseUrlEnv].every(v=>/^[A-Z][A-Z0-9_]*$/.test(v))||!modelFlag||
      !d.destinations?.length||d.destinations.some(v=>new URL(v.origin).protocol!=='https:')||
      typeof config.identitySubjectField!=='string'||!(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).test(config.identitySubjectField)||
      ['constructor','prototype','__proto__'].includes(config.identitySubjectField)||
      !config.identityUrl||!d.destinations.some(v=>new URL(config.identityUrl).origin===v.origin)||
      (config.effortValuePrefix!==undefined&&typeof config.effortValuePrefix!=='string'))
      throw Error('invalid_provider_configuration');
    const flows=new Set();
    const effects={
      beginSignIn:async({accountId})=>{flows.add(accountId);return ok({flowId:accountId,state:'waiting',presentation:{kind:'key'}});},
      cancelSignIn:async id=>{flows.delete(id);},
      finishSignIn:async({flowId,answer,signal})=>{
        if(!flows.delete(flowId)||typeof answer!=='string'||!answer||answer.length>16384||/[\r\n]/.test(answer))return fault('signin_failed');
        // Authenticate the static key on an explicitly configured, non-inference
        // provider route. Never infer sign-in from pasted text or an email.
        if(signal?.aborted)return fault('signin_cancelled');
        const identitySignal=AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]);
        let subjectId;
        try {
          const response=await send(config.identityUrl,{method:'GET',headers:{authorization:'Bearer '+answer},
            redirect:'error',signal:identitySignal});
          subjectId=await identitySubject(response,config.identitySubjectField,identitySignal);
          if(subjectId.includes(answer))throw Error('identity_contains_credential');
        }catch{return fault(signal?.aborted?'signin_cancelled':'signin_failed');}
        return ok({subjectId,secret:{key:answer},expiresAtMs:null});
      },
      authorizeRequest:async({auth,request})=>{
        if(typeof auth.secret?.key!=='string')return fault('account_signed_out');
        return ok({...request,headers:{'content-type':'application/json',authorization:'Bearer '+auth.secret.key}});
      },
      makeRun:({selection,jobKey,job,receipt,enforcement})=>{
        if(selection.effortId!==null&&!effortFlag)return fault('effort_unavailable');
        const origin=config.guestProxyOrigin??proxyOrigin();
        const endpoint=new URL('/api/account-proxy/'+encodeURIComponent(d.id),origin).href;
        return ok({schemaVersion:1,command,args:[...args,modelFlag,selection.modelId,
          ...(selection.effortId===null?[]:[effortFlag,(config.effortValuePrefix??'')+selection.effortId]),job.promptText],
          env:{[keyEnv]:jobKey,[baseUrlEnv]:endpoint},proxy:{providerId:d.id,origin:new URL(origin).origin},receipt,enforcement});
      },
    };
    return {...(d.id==='codex'?createCodexProvider:createClaudeProvider)({descriptor:d,effects}),harnessId:config.harnessId??d.id};
  })]);
}
