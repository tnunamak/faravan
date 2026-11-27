import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createAccountRegistry} from './v1/lending-accounts.mjs';
import {readClaudeAccountSync} from './credential-generations.mjs';
import {claudeAccountFenceHolds,currentClaudeCheckGeneration} from './claude-accounts.mjs';
import {resolveSbxExecutable} from './sbx-daemon-owner.mjs';

const context=new AsyncLocalStorage(),capabilities=new WeakMap(),digests=new Map();
const kit=fileURLToPath(new URL('../kits/wf-claude-account/spec.yaml',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const refused=()=>Object.assign(new Error('The sandbox runtime is unavailable. Retry its scoped sign-in check.'),{code:'claude_account_unavailable',sbxLaunchRefused:true});
export function sbxBinaryIdentity(binary,env=process.env){
 const executable=resolveSbxExecutable(binary,env),info=fs.statSync(executable);
 const identity={path:executable,dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};
 const key=JSON.stringify(identity);let digest=digests.get(key);
 if(!digest){digest=hash(fs.readFileSync(executable));digests.set(key,digest);if(digests.size>256)digests.delete(digests.keys().next().value);}
 else {digests.delete(key);digests.set(key,digest);}
 return {...identity,digest};
}
export const sbxKitDigest=()=>hash(fs.readFileSync(kit));
export function sbxRuntimeIdentityHolds(descriptor,env=process.env){
 try {
  const configured=env.FARAVAN_SBX_BIN||'sbx';
  return JSON.stringify(sbxBinaryIdentity(configured,env))===JSON.stringify(descriptor.binary)&&
   sbxKitDigest()===descriptor.kitDigest&&(!descriptor.home||env.HOME===descriptor.home);
 }catch{return false;}
}
export function createSbxRuntime({path:executable,fence,identityFence=fence,descriptor=null,kind='account'}={}){
 if(typeof executable!=='string'||!executable||typeof fence!=='function'||typeof identityFence!=='function')throw refused();
 const runtime=Object.freeze({path:executable,kind,key:descriptor?.id??randomUUID()});
 capabilities.set(runtime,{fence,identityFence,descriptor:descriptor&&structuredClone(descriptor)});return runtime;
}
export function currentSbxRuntime(){return context.getStore()??null;}
export function assertSbxRuntime(runtime,{signal,env}={}){
 const proof=runtime&&capabilities.get(runtime);if(!proof)throw refused();
 const parent=currentSbxRuntime();if(parent?.kind==='account'&&runtime.kind!=='account')throw refused();
 signal?.throwIfAborted();
 try {proof.fence(env);}catch(error){error.sbxLaunchRefused=true;throw error;}
 return runtime;
}
export function withSbxRuntime(runtime,action){
 if(!runtime||!capabilities.has(runtime))throw refused();
 const parent=currentSbxRuntime();if(parent?.kind==='account'&&runtime.kind!=='account')throw refused();
 return context.run(runtime,action);
}
export function describeSbxRuntime(runtime){
 const value=capabilities.get(runtime)?.descriptor;if(!value)throw refused();return structuredClone(value);
}
export function cleanupSbxRuntime(runtime){
 const proof=capabilities.get(runtime);if(!proof)throw refused();
 const descriptor=proof.descriptor&&runtimeDescriptor({...proof.descriptor,purpose:'cleanup'});
 return createSbxRuntime({path:runtime.path,kind:runtime.kind,fence:proof.identityFence,descriptor});
}
export function qualifiedSbxRuntime(descriptor,{fence,env=()=>process.env}={}){
 if(!validRuntimeDescriptor(descriptor)||descriptor.kind!=='account')throw refused();
 const identityFence=childEnv=>{if(!sbxRuntimeIdentityHolds(descriptor,env())||childEnv&&!sbxRuntimeIdentityHolds(descriptor,childEnv))throw refused();};
 return createSbxRuntime({path:descriptor.binary.path,descriptor,kind:'account',identityFence,
  fence:childEnv=>{identityFence(childEnv);fence?.();}});
}
export function runtimeDescriptor({binary,kitDigest=sbxKitDigest(),version=null,home=null,profileHome=null,ownerScope=null,accountFenceKey=null,kind='account',purpose='active'}={}){
 const descriptor={v:1,kind,purpose,binary,kitDigest,version,home,profileHome,ownerScope,accountFenceKey};
 descriptor.id=hash(JSON.stringify(descriptor));return descriptor;
}
export function validRuntimeDescriptor(value){
 if(value?.v!==1||!['active','cleanup'].includes(value.purpose)||!['account','host-default'].includes(value.kind)||!value.binary||typeof value.binary.path!=='string'||
  typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.kitDigest??''))return false;
 const {id,...fields}=value;if(id!==hash(JSON.stringify(fields)))return false;
 if(value.kind==='account'){
  const key=value.accountFenceKey,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if(!path.isAbsolute(value.binary.path)||!/^[a-f0-9]{64}$/.test(value.binary.digest??'')||
   !path.isAbsolute(value.home??'')||!path.isAbsolute(value.profileHome??'')||typeof value.ownerScope!=='string'||
   !key||!uuid.test(key.accountId??'')||!uuid.test(key.generationId??'')||!/^[a-f0-9]{64}$/.test(key.digest??'')||
   typeof key.selfCheck!=='boolean'||typeof key.enabled!=='boolean'||
   !(key.selfCheck&&key.checkGeneration===null)&&!uuid.test(key.checkGeneration??''))return false;
 }

 return true;
}
function hostRuntimeFence(descriptor,env,currentEnv) {
 return childEnv=>{
  try {
   const actual=childEnv??env;
   if((currentEnv()?.HOME??null)!==descriptor.home||(actual?.HOME??null)!==descriptor.home||
     JSON.stringify(sbxBinaryIdentity(descriptor.binary.path,actual))!==JSON.stringify(descriptor.binary))throw refused();
  }catch{throw refused();}
 };
}
export function hostDefaultSbxRuntime({binary=process.env.FARAVAN_SBX_BIN||'sbx',env=process.env,currentEnv=()=>process.env,profileHome=null,ownerScope=null}={}){
 let identity;try{identity=sbxBinaryIdentity(binary,env);}catch(cause){throw Object.assign(refused(),{cause});}
 const descriptor=runtimeDescriptor({binary:identity,home:env.HOME??null,profileHome,ownerScope,kind:'host-default'});
 return createSbxRuntime({path:identity.path,kind:'host-default',descriptor,fence:hostRuntimeFence(descriptor,env,currentEnv)});
}
export function restoreSbxRuntime(descriptor,{env=process.env,currentEnv=()=>process.env,home,profileHome,ownerScope,cleanup=true}={}){
 if(!validRuntimeDescriptor(descriptor)||(home&&descriptor.home!==home)||(profileHome&&descriptor.profileHome!==profileHome)||
  (ownerScope&&descriptor.ownerScope!==ownerScope))throw refused();
 if(descriptor.kind==='account')return qualifiedSbxRuntime(descriptor,{env:()=>({...env,FARAVAN_SBX_BIN:process.env.FARAVAN_SBX_BIN,PATH:process.env.PATH}),fence:cleanup?undefined:()=>{
  const key=descriptor.accountFenceKey;
  const account=createAccountRegistry({file:path.join(descriptor.profileHome,'v1','lending-accounts.json')}).get(key.accountId);
  const record=readClaudeAccountSync(descriptor.home,key.accountId);
  if(!account||account.provider!=='claude'||account.legacy_provider||record.id!==key.generationId||record.digest!==key.digest||
    (key.selfCheck?account.enabled!==key.enabled:!account.enabled)||
    (key.selfCheck?currentClaudeCheckGeneration(descriptor.home,record)!==key.checkGeneration:
      !claudeAccountFenceHolds(descriptor.home,record,key.checkGeneration)))throw refused();
 }});
 if(!descriptor.binary.digest||!path.isAbsolute(descriptor.binary.path))throw refused();
 const fence=hostRuntimeFence(descriptor,env,currentEnv);
 return createSbxRuntime({path:descriptor.binary.path,kind:'host-default',descriptor,fence});
}

// Generic host-tool runners must not become a second sbx transport.
export function nonSbxCommand(command,env=process.env){
 const name=path.basename(command);
 const configured=env.FARAVAN_SBX_BIN||'sbx';
 if(name==='sbx'||command===configured)throw refused();
 try{if(resolveSbxExecutable(command,env)===resolveSbxExecutable(configured,env))throw refused();}
 catch(error){if(error.sbxLaunchRefused)throw error;}
 return command;
}
