import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {publishClaudeAccount} from '../../lib/credential-generations.mjs';
import {recordClaudeAccountCheck} from '../../lib/claude-accounts.mjs';
import {createDiskLedger} from '../../lib/disk-ledger.mjs';
async function fixture(t){const home=await mkdtemp(join(tmpdir(),'faravan-account-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
// A production DockerSbxBackend over a fake sbx that models sandbox-scoped secrets. Each token becomes an added,
// enabled Claude account whose scoped check passed on this fake runtime.
export async function accountBackend(t,{tokens=[]}={}){
 const {DockerSbxBackend}=await import('../../lib/docker-backend.mjs');
 const {createAccountRegistry}=await import('../../lib/v1/lending-accounts.mjs');
 const {createSbxPolicy,sbxRunner}=await import('./sbx-policy-model.mjs');
 const {seedSandboxOwner}=await import('./sandbox-owner.mjs');
 const home=await fixture(t),oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT,oldBin=process.env.FARAVAN_SBX_BIN;
 process.env.FARAVAN_SBX_BIN=process.execPath;
 process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;seedSandboxOwner();
 t.after(()=>{if(oldBin===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=oldBin;if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
 const registry=createAccountRegistry({file:join(home,'v1','lending-accounts.json')}),accounts=[];
 for(const token of tokens){
   const a=registry.setEnabled(registry.add({provider:'claude',label:'Example',origin:{kind:'subscription-token'}}).id,true),record=await publishClaudeAccount(home,a.id,{kind:'subscription-token',token});
   accounts.push({key:'claude:'+a.id,token,record});
 }
 const flags={failSet:false,listingBroken:false,createFails:false,rmKeepsSecret:false,onSet:null,curl:'200',controlCurl:'401',version:'test-version'};
 // Values added later through the CLI count as account values too.
 const published=new Set();
 const calls=[],secrets=[],policy=createSbxPolicy({globalRules:[]});
 const listing=()=>({code:0,stdout:JSON.stringify({secrets:secrets.map(({token,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0})});
 const runner=sbxRunner(policy,async(args,options)=>{
   calls.push({args,input:options?.input});
   if(args[0]==='create'&&flags.createFails)return {code:1,stdout:'',stderr:'create failed'};
   if(args[0]==='secret'&&args[1]==='ls')return flags.listingBroken?{code:1,stdout:''}:listing();
   if(args[0]==='version')return {code:0,stdout:flags.version};
   if(args[0]==='template'&&args[1]==='ls')return {code:0,stdout:'[]',stderr:''};
   // The models list answers by the value scoped to that sandbox: a published account value gets `curl`, any other
   // (the self-check's control value) gets `controlCurl`.
   if(args[0]==='exec'&&args.includes('curl')){const held=secrets.find(row=>args.includes(row.scope))?.token;return {code:0,stdout:accounts.some(a=>a.token===held)||published.has(held)?flags.curl:flags.controlCurl,stderr:''};}
   if(args[0]==='secret'&&args[1]==='set'){
     await flags.onSet?.();
     if(flags.failSet)return {code:1,stdout:'',stderr:''};
     secrets.push({name:args[2],scope:args[args.indexOf('--sandbox')+1],type:'service',token:options.input});
     if(!String(options.input).includes('negative-control'))published.add(options.input);
   }
   if(args[0]==='secret'&&args[1]==='rm'&&args.includes('--sandbox')){const scope=args[args.indexOf('--sandbox')+1];for(let n=secrets.length-1;n>=0;n--)if(secrets[n].scope===scope&&secrets[n].name===args[2])secrets.splice(n,1);}
   if(args[0]==='rm'&&!flags.rmKeepsSecret){const name=args.at(-1);for(let n=secrets.length-1;n>=0;n--)if(secrets[n].scope===name)secrets.splice(n,1);}
   return {code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''};
 },{kitAllow:[],secretResult:{code:0,get stdout(){return listing().stdout;}}});
 // Host storage protection is qualified, so a full lender job spec can be prepared.
 const storage={supported:async()=>true,available:async()=>true,reserve:async()=>{},release:async()=>{},verify:async()=>true,recordQualification:async()=>{}};
 const ledger=createDiskLedger({file:join(home,'disk-ledger.json')});
 const make=()=>{const backend=new DockerSbxBackend({home,runCommand:(args,options)=>{options?.beforeSpawn?.();return runner.run(args,options);},storage});backend.diskLedger=ledger;return backend;};
 const job={job_id:'test-account-'+randomUUID(),image:'claude',entrypoint:'true',execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
 resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:16384,network_bytes:1048576,max_processes:32},inputs:[],output_manifest:[],egress:'provider-only',provider_hosts:['api.anthropic.com'],required_limits:['cpu','memory','wall','output']};
 const ready=async record=>recordClaudeAccountCheck(home,record,{...await make().claudeAccountRuntime(),status:200,controlStatus:401});
 for(const {record} of accounts)await ready(record);
 const execs=start=>calls.slice(start).filter(c=>c.args[0]==='exec');
 return {home,registry,accounts,flags,calls,secrets,policy,ledger,make,backend:make(),job,ready,execs};
}

