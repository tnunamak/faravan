import {configHome} from '../../lib/local-state.mjs';
import {hostDefaultSbxRuntime,describeSbxRuntime} from '../../lib/sbx-runtime.mjs';
import {appendFileSync,existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createSbxPolicy} from './sbx-policy-model.mjs';
import {DockerSbxBackend,_internal,sbxChildEnv} from '../../lib/docker-backend.mjs';
import {sandboxOwnerScope} from '../../lib/sandbox-name.mjs';
import {sandboxDeadlineUnit} from '../../lib/sandbox-deadline.mjs';
import {GITHUB_SERVICE} from '../../lib/credential-generations.mjs';

export function fakeSandboxDeadlines() {
  const armed=new Set();
  return {register:async row=>{armed.add(row._cleanupId);return {kind:'systemd',unit:sandboxDeadlineUnit(row),binary:'/fake/sbx'};},
    active:async row=>armed.has(row._cleanupId),activeSync:row=>armed.has(row._cleanupId),
    identitySync:row=>armed.has(row._cleanupId)?'armed:'+row._cleanupId:null,cancel:async row=>{armed.delete(row._cleanupId);return true;}};
}

// File-backed SBX fixtures must not launch a detached host watcher. Production
// watcher liveness/handshake has separate process tests; this fake acknowledges
// only the exact generation/challenge supplied by the real adoption protocol.
export function fakeSharedSandboxWatcher() {
  const names=new Set();
  return {acknowledge:async row=>{names.add(row.sandbox_id);return {
    watch_generation:row.watch_generation,challenge:row.watch_challenge,binary:'/fake/sbx'};},
    status:()=>({healthy:true,count:names.size,listing_failed:false})};
}

// A file-backed sbx: a crashed child and its restarted parent see one inventory.
// `create(name,args,options)` decides each create's CLI result and whether the
// sandbox materializes; the CLI result never implies the materialization.
export function fileSbx(directory,{create=async()=>({code:0,materialize:true})}={}) {
  mkdirSync(directory,{recursive:true});
  const inventory=join(directory,'inventory.json'),log=join(directory,'calls.jsonl');
  const read=()=>existsSync(inventory)?JSON.parse(readFileSync(inventory,'utf8')):[];
  const write=names=>writeFileSync(inventory,JSON.stringify(names));
  const policy=createSbxPolicy();
  // Sandbox-scoped GitHub values, as `sbx secret set --sandbox` leaves them.
  const secrets=[];
  const run=async(args,options)=>{
    appendFileSync(log,JSON.stringify(args)+'\n');
    if(args[0]==='settings')return {code:0,stdout:args.join(' ')==='settings get ssh.agentForwardingEnabled'?'false':'',stderr:''};
    if(args[0]==='secret'&&args[1]==='set'&&args.includes('--sandbox'))secrets.push({scope:args[args.indexOf('--sandbox')+1],type:'service',name:args[2]});
    if(args[0]==='secret'&&args[1]==='rm'&&args.includes('--sandbox')) {
      const scope=args[args.indexOf('--sandbox')+1];
      for(let i=secrets.length-1;i>=0;i--)if(secrets[i].scope===scope&&secrets[i].name===args[2])secrets.splice(i,1);
    }
    if(args[0]==='secret')return {code:0,stdout:JSON.stringify({secrets:[...secrets],custom_secrets:[],shadowed_services:[],env_only_count:0}),stderr:''};
    if(args[0]==='create'||args[0]==='run') {
      const name=args[args.indexOf('--name')+1];
      // As sbx does, the kit's own allowances are scoped to the sandbox when it materializes, not when the CLI is dispatched.
      const land=()=>{write([...new Set([...read(),name])]);policy.createSandbox(name,{kitAllow:['api.anthropic.com:443']});};
      const outcome=await create(name,args,options,{materialize:land});
      if(outcome.materialize!==false)land();
      return {code:outcome.code??0,stdout:'',stderr:outcome.stderr??''};
    }
    if(args[0]==='ls')return {code:0,stdout:JSON.stringify(read().map(name=>({name,status:'running'}))),stderr:''};
    if(args[0]==='rm'){write(read().filter(name=>name!==args.at(-1)));policy.removeSandbox(args.at(-1));return {code:0,stdout:'',stderr:''};}
    if(args[0]==='policy')return policy.run(args)??{code:0,stdout:'',stderr:''};
    return {code:0,stdout:'',stderr:''};
  };
  const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  return {run,read,calls,policy,secrets,GITHUB_SERVICE,created:()=>calls().filter(args=>args[0]==='create'||args[0]==='run').map(args=>args[args.indexOf('--name')+1])};
}

export const receiptJob=(overrides={})=>({
  job_id:'job-receipt-1',
  execution_scope:'owner',
  image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  entrypoint:'wf-guest-entrypoint',
  resources:{cpu:2,memory_mib:4096,storage_mib:2048,wall_seconds:3600,output_bytes:10485760,network_bytes:104857600,max_processes:256},
  inputs:[],
  output_manifest:[],
  egress:'internet',
  provider_hosts:['**.openai.com','**.chatgpt.com'],
  ...overrides,
});

export function manualDeadlines() {
  const pending=new Set();
  return {
    setTimeout(callback,milliseconds){const timer={callback,milliseconds,unref(){}};pending.add(timer);return timer;},
    clearTimeout(timer){pending.delete(timer);},
    fireAll(){for(const timer of [...pending]){pending.delete(timer);timer.callback();}},
  };
}

// The sandbox HOME and scratch root come from the environment; the profile
// directories are explicit so a child and its parent share every journal.
export function receiptBackend(root,sbx,options={}) {
  writeFileSync(join(root,'.keep'),'');
  return new DockerSbxBackend({home:join(root,'profile'),cleanupDirectory:join(root,'profile','v1','sandbox-cleanup'),
    sandboxDeadlines:fakeSandboxDeadlines(),sharedSandboxWatcherFactory:()=>fakeSharedSandboxWatcher(),
    scratchJournal:join(root,'scratch-journal'),runCommand:sbx.run,deadlineTimers:manualDeadlines(),
    hostDisk:{free:async()=>({free:2**40})},legacyDaemonOptions:{inspectDaemons:async()=>[],
      runProcessCommand:async()=>({code:0,stdout:' PID PPID COMMAND\n 1 0 fixture-idle\n',stderr:''})},...options});
}

// A current cleanup record as a finished create dispatch leaves it: the name
// was reserved, the create command returned success and the sandbox was seen.
export async function writeCreateReceipt(directory,{jobId,name,ownerScope,home,scratchRoot,created=true,settled=true,runtime,profileHome=directory.endsWith('/v1/sandbox-cleanup')?directory.slice(0,-'/v1/sandbox-cleanup'.length):configHome()}) {
  const {mkdir,writeFile}=await import('node:fs/promises');
  const {randomUUID}=await import('node:crypto');
  const id=randomUUID();
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(join(directory,id+'.json'),JSON.stringify({version:2,_cleanupId:id,owner_scope:ownerScope,sbx_home:home,job_id:jobId,sandbox_id:name,
    sbx_runtime:runtime??describeSbxRuntime(hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary:process.env.FARAVAN_SBX_BIN??process.execPath,env:{...process.env,HOME:home},profileHome,ownerScope})),
    scratch_dir:join(scratchRoot,'wf-job-'+name+'-'+randomUUID()),create:'dispatched',compute_created:created,create_settled:settled,
    compute_stopped:false,data_cleanup:'owned',policy_cleanup:'owned'}));
  return id;
}

// A hand-made handle with the durable record a real create dispatch leaves:
// reserved, dispatched and, unless told otherwise, accepted and observed.
export async function receiptedHandle(backend,{job_id,sandbox_id,created=true,settled=true,...rest}) {
  const {mkdtemp}=await import('node:fs/promises');
  const {randomBytes}=await import('node:crypto');
  const {tmpdir}=await import('node:os');
  const name=sandbox_id??'wf-'+randomBytes(8).toString('hex');
  const scratch_dir=await mkdtemp(join(process.env.FARAVAN_SCRATCH_ROOT||tmpdir(),'wf-job-'+name+'-'));
  const runtime=hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary:process.env.FARAVAN_SBX_BIN??process.execPath,env:{...process.env,HOME:backend.sandboxOwnership().sbx_home},profileHome:backend._profileHome,ownerScope:backend.sandboxOwnership().owner_scope});
  const handle={job_id,sandbox_id:name,scratch_dir,_sbxRuntime:runtime,sbx_runtime:describeSbxRuntime(runtime),...rest};
  backend.cleanupJournal.register(handle);
  backend.cleanupJournal.mark(handle,{create:'dispatched',compute_created:created,create_settled:settled});
  return handle;
}

export function bindTestSbxRuntime(backend,handle){
 const ownership=backend.sandboxOwnership();
 const runtime=hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary:process.env.FARAVAN_SBX_BIN??process.execPath,env:{...process.env,HOME:ownership.sbx_home},profileHome:backend._profileHome,ownerScope:ownership.owner_scope});
 Object.defineProperty(handle,'_sbxRuntime',{value:runtime,configurable:true});
 handle.sbx_runtime=describeSbxRuntime(runtime);return handle;
}

export function testSbxRuntimeFields(profileHome=configHome(),binary=process.env.FARAVAN_SBX_BIN??process.execPath){
 const ownership={owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome()};
 const runtime=hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary,env:{...process.env,HOME:ownership.sbx_home},profileHome,ownerScope:ownership.owner_scope});
 return {_sbxRuntime:runtime,sbx_runtime:describeSbxRuntime(runtime)};
}
