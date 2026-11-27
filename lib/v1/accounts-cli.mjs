import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {configHome} from '../local-state.mjs';
import {_internal} from '../docker-backend.mjs';
const {sbxHome}=_internal;
import {createAccountRegistry} from './lending-accounts.mjs';
import {accountKey,accountIdOfKey} from './lending-account-key.mjs';
import {publishClaudeAccount,claudeTokenKind,readClaudeAccount,removeClaudeAccount} from '../credential-generations.mjs';
import {claudeAccountReady} from '../claude-accounts.mjs';
import {withCredentialPreparation} from '../sandbox-credentials.mjs';
export async function runAccountsCommand(argv,{home=configHome(),stdout=process.stdout,stdin=process.stdin,backend}={}){
 const registry=createAccountRegistry({file:join(resolve(home),'v1','lending-accounts.json')});
 const [action,provider,...rest]=argv;
 if(action==='list'){
   const accounts=registry.list();
   let runtime=null;
   const scoped=account=>account.provider==='claude'&&!account.legacy_provider;
   if(accounts.some(scoped)){const {DockerSbxBackend}=await import('../docker-backend.mjs');runtime=await (backend??new DockerSbxBackend({home})).claudeAccountRuntime().catch(()=>null);}
   // An added account's sign-in counts as checked only after a scoped check on this sbx version and this mixin.
   // Nothing reserves on added accounts yet, so no row says an account lends.
   const checked=async account=>{
     if(!scoped(account))return null;
     try{return Boolean(runtime)&&account.enabled&&await claudeAccountReady(sbxHome(),await readClaudeAccount(sbxHome(),account.id),runtime);}catch{return false;}
   };
   const rows=await Promise.all(accounts.map(async account=>({id:account.id,key:accountKey(account),provider:account.provider,label:account.label,
     kind:account.legacy_provider?'default':account.origin?.kind??'unknown',signInChecked:await checked(account),lends:false})));
   stdout.write(JSON.stringify(rows)+'\n');return 0;
 }
 if(action==='check'&&provider){
   const {DockerSbxBackend}=await import('../docker-backend.mjs');
   const result=await (backend??new DockerSbxBackend({home})).checkClaudeAccount(provider);
   // Only a passed scoped check lets the account take jobs.
   if(result.ok)registry.setEnabled(accountIdOfKey(provider),true);
   const why={check_superseded:' Another check of this account ran at the same time. Run it again.',default_sign_in_answered:' The default sign-in answered instead of this account.',control_inconclusive:' The route could not be confirmed to use this account.'}[result.reason]??'';
   stdout.write(result.ok?'Scoped sign-in check passed.\n':'Scoped sign-in check failed.'+why+'\n');return result.ok?0:1;
 }
 if(action==='remove'&&provider==='claude'&&rest.length===2&&rest[0]==='--label'){
   const matches=registry.list().filter(account=>account.provider==='claude'&&!account.legacy_provider&&account.label===rest[1]);
   if(matches.length!==1)throw Object.assign(new Error(matches.length?'Several added Claude accounts use that label.':'No added Claude account uses that label.'),{code:'not_found'});
   // Disabled first, so no new job can choose it while its value is being deleted.
   registry.setEnabled(matches[0].id,false);
   try{await withCredentialPreparation(sbxHome(),()=>removeClaudeAccount(sbxHome(),matches[0].id),{isolatedSources:true});}
   catch{
     // The saved value may still exist, so the account stays listed (disabled) and can be removed again.
     stdout.write(JSON.stringify({id:matches[0].id,key:accountKey(matches[0]),removed:false,message:'The saved sign-in could not be confirmed removed. Try again.'})+'\n');return 1;
   }
   registry.markRemoved(matches[0].id);
   stdout.write(JSON.stringify({id:matches[0].id,key:accountKey(matches[0]),removed:true})+'\n');return 0;
 }
 if(action!=='add'||provider!=='claude'||rest.length!==2||rest[0]!=='--label'||!rest[1].trim())throw new Error('Use faravan accounts add claude --label NAME, accounts remove claude --label NAME, accounts list, or accounts check KEY.');
 if(stdin.isTTY)throw new Error('Supply the Claude token on standard input.');
 const chunks=[];let length=0;
 for await(const chunk of stdin){length+=Buffer.byteLength(chunk);if(length>16384)throw new Error('Claude token format is invalid.');chunks.push(Buffer.from(chunk));}
 const token=Buffer.concat(chunks).toString('utf8').trim(),kind=claudeTokenKind(token);
 // Unchecked until `accounts check` passes: an added account takes no jobs before its scoped check.
 const account=registry.add({provider:'claude',label:rest[1],origin:{kind}});
 registry.setEnabled(account.id,false);
 await mkdir(sbxHome(),{recursive:true,mode:0o700});
 await withCredentialPreparation(sbxHome(),()=>publishClaudeAccount(sbxHome(),account.id,{kind,token}),{isolatedSources:true});
 stdout.write(JSON.stringify({id:account.id,key:accountKey(account),provider:'claude',kind,label:account.label,signInChecked:false,lends:false})+'\n');return 0;
}
