import {readFile,open,rename,mkdir,rmdir,stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {parseCredentialListing} from './sandbox-credentials.mjs';
import {readClaudeAccount,readClaudeAccountSync,readClaudeAccountValue,approveServiceBinding} from './credential-generations.mjs';
import {accountIdOfKey} from './v1/lending-account-key.mjs';
export const CLAUDE_SERVICE='faravan-claude';
export const CLAUDE_KIT=fileURLToPath(new URL('../kits/wf-claude-account',import.meta.url));
export const claudeKitDigest=async()=>createHash('sha256').update(await readFile(join(CLAUDE_KIT,'spec.yaml'))).digest('hex');
export const claudeService=account=>account.kind==='subscription-token'?CLAUDE_SERVICE:'anthropic';
const failed=()=>Object.assign(new Error('The selected Claude account could not be prepared. Check its scoped sign-in.'),{code:'claude_account_unavailable'});
export async function ensureClaudeBinding(home){await approveServiceBinding(home,CLAUDE_SERVICE,['api.anthropic.com']);}
// A well-formed value that no provider accepts. On an account's route it must be refused; a 200 means another
// sign-in (the computer's default) answered instead of the scoped value.
export const claudeControlValue=kind=>(kind==='api-key'?'sk-ant-api03-':'sk-ant-oat01-')+'faravan-negative-control-'+'0'.repeat(64);
// `value` is a credential already in memory (a lent job's store lease); an added account's value is read from its record.
export async function assignClaudeAccount(run,home,account,sandboxId,{control=false,value}={}){
 const input=control?claudeControlValue(account.kind):value??await readClaudeAccountValue(home,account),service=claudeService(account);
 let result;
 try{result=await run(['secret','set',service,'--sandbox',sandboxId,'--force'],{input});}catch{throw failed();}
 if(result.code!==0)throw failed();
 const listing=parseCredentialListing(await run(['secret','ls','--json','--sandbox',sandboxId]));
 if(listing.secrets.filter(row=>row.name===service&&row.scope===sandboxId&&row.type==='service').length!==1)throw failed();
}
// `sbx rm` deletes a sandbox's scoped values. If one is still listed, remove that scoped value only (never a global
// one), then trust only the listing. An unreadable listing leaves the obligation open for the next cleanup pass.
export async function verifyClaudeAccountRemoved(run,sandboxId,service){
 if(!/^wf-[a-f0-9]{16}$/.test(sandboxId)||![CLAUDE_SERVICE,'anthropic','openai'].includes(service))return false;
 const scoped=listing=>listing.secrets.some(row=>row.scope===sandboxId&&row.name===service);
 if(!scoped(parseCredentialListing(await run(['secret','ls','--json','--sandbox',sandboxId]))))return true;
 await run(['secret','rm',service,'--sandbox',sandboxId,'--force']).catch(()=>{});
 return !scoped(parseCredentialListing(await run(['secret','ls','--json','--sandbox',sandboxId])));
}
const checkFile=(home,account)=>join(home,'credential-generations',account.id,'scoped-check.json');
// A check that a newer check replaced. Its answer is never recorded.
export const claudeCheckSuperseded=()=>({ok:false,reason:'check_superseded'});
// The account's value must get 200 and the control value 401 on the same route; anything else is not ready.
export function claudeCheckOutcome(status,controlStatus){
 if(status!==200)return {ok:false,reason:'account_refused'};
 if(controlStatus===200)return {ok:false,reason:'default_sign_in_answered'};
 if(controlStatus!==401)return {ok:false,reason:'control_inconclusive'};
 return {ok:true,reason:null};
}
async function writeCheck(home,account,body,op){
 const path=checkFile(home,account),pending=path+'.'+randomUUID();
 const fd=await open(pending,'wx',0o600);
 try{await fd.writeFile(JSON.stringify({digest:account.digest,generation:randomUUID(),op,...body}));await fd.sync();}finally{await fd.close();}
 await rename(pending,path);const dir=await open(join(home,'credential-generations',account.id),'r');try{await dir.sync();}finally{await dir.close();}
}
// The compare-and-write below must not interleave across processes, so it holds a short lock next to the record.
async function withCheckLock(home,account,run){
 const lock=checkFile(home,account)+'.lock',until=Date.now()+10000;
 for(;;){
  try{await mkdir(lock,{mode:0o700});break;}catch(error){
   if(error.code!=='EEXIST')throw error;
   // A holder keeps it for milliseconds; one older than a minute died holding it.
   const info=await stat(lock).catch(()=>null);
   if(info&&Date.now()-info.mtimeMs>60000){await rmdir(lock).catch(()=>{});continue;}
   if(Date.now()>until)throw Object.assign(new Error('The account check is busy.'),{code:'claude_account_unavailable'});
   await new Promise(resolve=>setTimeout(resolve,20));
  }
 }
 try{return await run();}finally{await rmdir(lock).catch(()=>{});}
}
const currentCheckOp=async(home,account)=>{try{return JSON.parse(await readFile(checkFile(home,account),'utf8')).op??null;}catch{return null;}};
// Every write of the check record carries a fresh generation, so a job that saw an earlier record can tell it changed.
// A check that starts replaces the record with a not-ready one first and returns its operation id: nothing may pass on
// the old answer while it runs, and only the newest started check may write the final record.
export const beginClaudeAccountCheck=(home,account)=>withCheckLock(home,account,async()=>{
 const op=randomUUID();await writeCheck(home,account,{ok:false,reason:'checking'},op);return op;
});
// Writes the final record and returns true only if `op` is still the newest check. A superseded check writes nothing.
// Without an operation id the write is unconditional.
export const recordClaudeAccountCheck=(home,account,{version,kitDigest,binary,status,controlStatus},op)=>withCheckLock(home,account,async()=>{
 if(op!==undefined&&await currentCheckOp(home,account)!==op)return false;
 await writeCheck(home,account,{version,kitDigest,binary,status,controlStatus,...claudeCheckOutcome(status,controlStatus)},op??randomUUID());
 return true;
});
// The generation of a passing check for this account, this sbx and this mixin; null when the account is not ready.
// Records written before the negative control existed carry no control result, so they are not ready until re-checked.
export async function claudeAccountCheckGeneration(home,account,{version,kitDigest,binary}){
 try{
  await readClaudeAccountValue(home,account);
  const info=JSON.parse(await readFile(checkFile(home,account),'utf8'));
  return info.ok===true&&info.status===200&&info.controlStatus===401&&info.version===version&&info.kitDigest===kitDigest&&
   info.digest===account.digest&&JSON.stringify(info.binary)===JSON.stringify(binary)&&typeof info.generation==='string'?info.generation:null;
 }catch{return null;}
}
// The last step before an agent command is released, so it is synchronous: the same saved account, its value, and the
// passing check record the job was admitted on. Any change to the pointer, the value or the record fails it.
export function claudeAccountFenceHolds(home,account,generation){
 try{
  const pointer=readClaudeAccountSync(home,account.accountId);
  if(pointer.id!==account.id||pointer.digest!==account.digest)return false;
  const info=JSON.parse(readFileSync(checkFile(home,account),'utf8'));
  return info.ok===true&&info.status===200&&info.controlStatus===401&&info.digest===account.digest&&info.generation===generation;
 }catch{return false;}
}
export async function claudeAccountReady(home,account,current){return (await claudeAccountCheckGeneration(home,account,current))!==null;}
// The generation of the current check record, read synchronously for admission. Any record counts as a change.
export function currentClaudeCheckGeneration(home,account){
 try{return JSON.parse(readFileSync(checkFile(home,account),'utf8')).generation??null;}catch{return null;}
}
export const claudeGuestEnv=account=>[
 'CLAUDE_CODE_OAUTH_TOKEN='+(account.kind==='subscription-token'?'proxy-managed':''),
 'ANTHROPIC_API_KEY='+(account.kind==='api-key'?'proxy-managed':''),'ANTHROPIC_AUTH_TOKEN=',
];
// Admission is synchronous, so it reads the last refreshed answer. An added Claude account admits jobs only while it
// is enabled in the registry now, its saved value exists, and its check record is the same one the last refresh
// accepted. Any change to the account or its check is therefore seen on the next call. While the answer is old or
// being read again, nothing added is admitted. The default account and other providers are not judged here.
export function claudeAccountAdmission({accounts,sbxHome,runtime,maxAgeMs=30000,now=Date.now}){
 let ready=new Map(),at=-Infinity,running=null;
 const refresh=()=>running??=(async()=>{
  const next=new Map();
  try{
   const current=await runtime();
   for(const account of accounts())if(account.provider==='claude'&&!account.legacy_provider&&account.enabled){
    try{
     const record=await readClaudeAccount(sbxHome(),account.id),generation=await claudeAccountCheckGeneration(sbxHome(),record,current);
     if(generation!==null)next.set('claude:'+account.id,{record,generation});
    }catch{}
   }
  }catch{}
  ready=next;at=now();
 })().finally(()=>{running=null;});
 return {refresh,reason(accountKey){
  if(accountIdOfKey(accountKey)===null||!accountKey.startsWith('claude:'))return null;
  const unavailable='claude_account_unavailable';
  if(running)return unavailable;
  if(now()-at>maxAgeMs){refresh();return unavailable;}
  const entry=ready.get(accountKey),current=accounts().find(account=>'claude:'+account.id===accountKey);
  if(!entry||!current?.enabled||current.provider!=='claude'||current.legacy_provider)return unavailable;
  return currentClaudeCheckGeneration(sbxHome(),entry.record)===entry.generation?null:unavailable;
 }};
}
