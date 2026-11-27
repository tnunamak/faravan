import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs,{readFileSync,writeFileSync} from 'node:fs';
import {writeFile,rm,chmod,rename,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';
import {accountAwaitInventory,instrumentAwaits} from './helpers/account-await-census.mjs';
const inventory=accountAwaitInventory(),sources=new Map(inventory.map(entry=>[entry.url,entry]));
const sites=inventory.flatMap(entry=>entry.sites),callSites=inventory.flatMap(entry=>entry.calls);
const transport=new AsyncLocalStorage();
let pause=async(_id,run)=>run(),fake=null,active=false,phase='setup',kitChanged=false,subprocesses=new Set();
const readSync=fs.readFileSync;
const syncFile=fs.fsyncSync,fixtureDevice=fs.statSync(tmpdir()).dev;
// Keep real ledger I/O and barriers on the fixture filesystem. The census does not flush ancestor
// directories on other filesystems; the focused lease regressions retain the full durability path.
fs.fsyncSync=fd=>{const info=fs.fstatSync(fd);if(info.isDirectory()&&info.dev!==fixtureDevice)return;return syncFile(fd);};
fs.readFileSync=(file,...rest)=>kitChanged&&String(file).endsWith('/kits/wf-claude-account/spec.yaml')?Buffer.from('changed kit'):readSync(file,...rest);
syncBuiltinESMExports();
globalThis.__accountAwaitPause=(...args)=>pause(...args);
const binding=(site,options)=>{
 if(active){if(options?.sbxRuntime)assert.equal(typeof options.sbxRuntime.path,'string',site+' supplies a qualified runtime');else {assert.equal(typeof options?.binary,'string',site+' supplies the admitted binary');assert.equal(typeof options?.beforeSpawn,'function',site+' supplies a final fence');}subprocesses.add(site);}
};
globalThis.__accountSpawnTest={
 call(owner,site,args,options){binding(site,options);return transport.run({site,options},()=>owner.runSbx(args,options));},
 stream(run,site,...args){binding(site,args[5]);return transport.run({site,options:args[5]},()=>run(...args));},
 output(run,site,...args){if(active)subprocesses.add(site);return run(...args);},
 directSpawn(site,...args){if(active)subprocesses.add(site);return fake.spawn(...args);},
 daemon:(...args)=>fake.daemon(...args),execFile:(...args)=>fake.execFile(...args),spawn:(...args)=>fake.spawn(...args),
};
const hook=registerHooks({load(url,context,next){
 const loaded=next(url,context),entry=sources.get(url);
 if(!entry){if(/\.[cm]?[jt]s$/.test(url)&&url.startsWith(new URL('../',import.meta.url).href)&&!url.includes('/tests/')&&!url.includes('/node_modules/'))throw new Error('Uninventoried local dependency: '+url);return loaded;}
 let source=instrumentAwaits(String(loaded.source),entry.file).source;
 if(entry.file==='lib/docker-backend.mjs'){
  const a=source.indexOf('async function runSbx('),b=source.indexOf('export async function',a);
  source=source.slice(0,a)+source.slice(a,b).replaceAll('ensureSbxDaemon(', 'globalThis.__accountSpawnTest.daemon(').replaceAll('execFile(', 'globalThis.__accountSpawnTest.execFile(').replaceAll('spawn(', 'globalThis.__accountSpawnTest.spawn(')+source.slice(b);
  source=source.replace('primitives={execFile,execFileCb,spawn,spawnSync,execve:process.execve}','primitives=globalThis.__accountSpawnTest');
  source+='\nexport {runSbx as censusRunSbx};';
 }
 return {...loaded,source};
}});
const {accountBackend}=await import('./helpers/claude-account-backend.mjs');
const accounts=await import('../lib/claude-accounts.mjs');
const {censusRunSbx,DockerSbxBackend}=await import('../lib/docker-backend.mjs');
const {stageGuestRuntime}=await import('../lib/guest-runtime.mjs');
const {describeSbxRuntime}=await import('../lib/sbx-runtime.mjs');
const {storageVolumes}=await import('../lib/sandbox-storage.mjs');
const {createHostDisk}=await import('../lib/host-disk.mjs');
const {REMOVE_ARTIFACTS_ENV}=await import('../lib/disk-sweep-setting.mjs');
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const census=JSON.parse(readFileSync(new URL('./fixtures/claude-account-await-census.json',import.meta.url),'utf8'));

test('every added-account subprocess is pinned and fenced from preparation through cleanup',async t=>{
 const oldRemoval=process.env[REMOVE_ARTIFACTS_ENV];process.env[REMOVE_ARTIFACTS_ENV]='1';
 t.after(()=>{if(oldRemoval===undefined)delete process.env[REMOVE_ARTIFACTS_ENV];else process.env[REMOVE_ARTIFACTS_ENV]=oldRemoval;});
 const totals=Object.fromEntries(inventory.map(entry=>[entry.file,entry.totalAwaits]));
 if(!process.env.UPDATE_ACCOUNT_AWAIT_CENSUS)assert.deepEqual(totals,census.totals,'new awaits or local dependencies require census review');
 async function journey(t,{target=null,revoke=null,guarded=true,mounted=true,cold=false,output=false,diskStop=false,reserve=false,widenRuntime=false,selfCheck=false,mountless=false,residue=false,post=false,diskContention=false}={}){
  const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
  if(mountless){
   const backend=new DockerSbxBackend({home:f.home,runCommand:f.backend.runSbx});
   backend.diskLedger=f.ledger;
   backend.storage={...f.backend.storage,verify:backend.storage.verify};f.backend=backend;
   f.job.resources.storage_mib=8192;f.job.required_limits.push('guest_block_device_capacity');
  }
  // Keep the production disk reader and its awaits, with deterministic filesystem observations and no periodic
  // wall-clock polls. The explicit low-disk variant exercises the job stop path.
  f.backend.hostDisk=createHostDisk({paths:()=>[f.home],statPath:async()=>({dev:1}),statfsPath:async()=>({type:0,bsize:4096,bavail:2**24,blocks:2**25})});
  f.backend.diskTimers={setTimeout:()=>({unref(){}}),clearTimeout(){}};
  if(residue){f.flags.rmKeepsSecret=true;f.job.inputs=[{artifact_id:'fixture-input',dest:'inputs/data'}];}
  const original=f.backend.runSbx,seen=[],spawns=[],inputs=[],counts=new Map();let revoked=false,ack=false,stream=null,prepared;
  const close=()=>{if(stream&&stream.exitCode===null){stream.exitCode=0;stream.stdout.end();stream.stderr.end();stream.emit('close',reserve?124:0);}};
  f.backend._hardStop=async()=>{close();};
  const destroy=f.backend.destroy.bind(f.backend);f.backend.destroy=(...args)=>{phase='cleanup';return destroy(...args);};
  const binary=join(f.home,'fake-binary'),replacement=join(f.home,'replacement-binary');
  await writeFile(binary,'fake executable',{mode:0o700});await writeFile(replacement,'another executable',{mode:0o700});
  const oldBin=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN=binary;
  await accounts.recordClaudeAccountCheck(f.home,a.record,{...await f.backend.claudeAccountRuntime(),status:200,controlStatus:401});
  if(selfCheck){f.registry.setEnabled(a.record.accountId,false);await accounts.beginClaudeAccountCheck(f.home,a.record);}
  let contention=diskContention?await f.backend._diskCoordinator().acquire():null;
  t.after(()=>contention?.release());
  const mutate=async()=>{
   if(revoke==='failed')await accounts.recordClaudeAccountCheck(f.home,a.record,{...await f.backend.claudeAccountRuntime(),status:401});
   if(revoke==='superseded')await accounts.beginClaudeAccountCheck(f.home,a.record);
   if(revoke==='disabled')f.registry.setEnabled(a.record.accountId,Boolean(selfCheck));
   if(revoke==='removed')await rm(join(f.home,'claude-account-'+a.record.accountId+'.json'));
   const path=join(f.home,'credential-generations',a.record.id,'value');
   if(revoke==='bytes')await writeFile(path,token());
   if(revoke==='mode')await chmod(path,0o644);
   if(revoke==='symlink'){await rename(path,path+'.other');await symlink(path+'.other',path);}
   if(revoke==='binary')await writeFile(binary,'changed binary');
   if(revoke==='path')process.env.FARAVAN_SBX_BIN=replacement;
   if(revoke==='kit')kitChanged=true;
  };
  let mutating=false,mutation=null;
  pause=async(id,run)=>{
   if(contention&&id==='lib/docker-backend.mjs:_admitDiskJob:0'){const held=contention;contention=null;setImmediate(()=>held.release());}
   const result=await run();
   if(active&&!mutating){
    const key=phase+'/'+id,occurrence=key+'@'+(counts.get(key)??0);counts.set(key,(counts.get(key)??0)+1);seen.push(occurrence);
    if(!revoked&&occurrence===target){mutating=true;mutation=mutate();await mutation;mutating=false;revoked=true;}
   }
   return result;
  };
  fake={daemon:async()=>{},execFile(executable,args,options){
   assert.equal(executable,binary,'every subprocess uses the qualified executable');
   const templateInventory=args.length===3&&args[0]==='template'&&args[1]==='ls'&&args[2]==='--json';
   const sandboxInventory=args.length===2&&args[0]==='ls'&&args[1]==='--json'&&describeSbxRuntime(transport.getStore()?.options?.sbxRuntime).purpose==='cleanup';
   spawns.push({phase,revoked,command:args[0],verb:args[1],inventory:templateInventory||sandboxInventory});
   let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});
   result.child={stdin:{on(){},end(input){
    if(input!==undefined)inputs.push({phase,revoked});
    Promise.resolve().then(()=>original(args,{input,signal:options.signal,env:options.env})).then(value=>{
     let stdout=value.stdout??'';
     if(args.includes('lsblk')){const volumes=storageVolumes(f.job.resources.storage_mib*1048576,'claude');stdout=JSON.stringify({blockdevices:[volumes.root,volumes.docker,...volumes.kit].map(size=>({size,type:'disk',ro:false}))});}
     if(args.includes('findmnt'))stdout=JSON.stringify({filesystems:[]});
     if(value.code!==0)return reject(Object.assign(new Error('Synthetic command refused'),{code:value.code,stdout,stderr:value.stderr??''}));
     if(args.some(arg=>typeof arg==='string'&&arg.includes(' > ')&&arg.includes('/launch-ack'))){ack=true;setImmediate(close);}
     resolve({stdout,stderr:value.stderr??''});
    },reject);
   }},once(){}};
   return result;
  },spawn(executable,args){
   assert.equal(executable,binary,'streaming uses the qualified executable');
   spawns.push({phase,revoked,command:'exec'});
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{close();return true;};stream=child;
   if(output){setImmediate(()=>{child.stdout.end('output');close();});return child;}
   setImmediate(()=>child.stderr.write(JSON.stringify({type:'faravan.started',v:1,seq:1,nonce:prepared._lending.guard.config.nonce,at:new Date().toISOString()})+'\n'));
   return child;
  }};
  f.backend.runSbx=(args,options)=>censusRunSbx(args,options);
  active=true;phase='prepare';let error;
  try {
   prepared=await f.backend.prepare(f.job,{accountKey:a.key,accountSelfCheck:selfCheck});
   prepared._guardRuntimeMounted=mounted;prepared._guardRuntimeCheck={ok:true,runtime:{node:binary,dir:f.home,sha256:'a'.repeat(64)}};
   if(cold){
    const root=join(f.home,'runtime-fixture'),dir=join(root,'guest-runtime','linux-'+process.arch);
    await mkdir(dir,{recursive:true});await writeFile(join(dir,'node'),'synthetic runtime');
    const sha256=createHash('sha256').update('synthetic runtime').digest('hex');
    await writeFile(join(root,'guest-runtime','manifest.json'),JSON.stringify({['linux-'+process.arch]:{sha256}}));
    if(widenRuntime){const dest=join(f.home,'guest-runtime',sha256);await mkdir(dest,{recursive:true});await writeFile(join(dest,'node'),'synthetic runtime',{mode:0o700});}
    f.backend.guestRuntime=options=>stageGuestRuntime({...options,root});prepared._guardRuntimeCheck=null;
   }
   if(reserve)prepared._deadline.endsAt=f.backend.monotonic()+600000;
   if(diskStop){const run=f.backend.runSbx;f.backend.runSbx=(args,options)=>{if(phase==='start'&&args[0]==='exec'){const disk=f.backend._diskSentry(prepared);disk.low={reason:'host_disk_low'};disk.halt=Promise.resolve();}return run(args,options);};}
   phase=output?'output':'start';
   if(output){for await(const _chunk of f.backend.streamOutput(prepared,'/out')){}}
   else if(selfCheck)await f.backend._runJobCommand(prepared,['exec',prepared.sandbox_id,'--','curl']);
   else await f.backend.start(prepared,guarded?{onLaunchDurable:async()=>{},reserveSeconds:reserve?180:0}:{});
   if(post){
    phase='verify';await f.backend.verify(prepared,{cmd:'true',workdir:prepared.scratch_dir});
    await f.backend.verificationFiles(prepared,prepared.scratch_dir);await f.backend.syncWorkspace(prepared);await f.backend.snapshotEgress(prepared);
    phase='cleanup';await f.backend.cancel(prepared);
   }
  }catch(e){error=e;}
  if(mutation)await mutation;
  await new Promise(resolve=>setImmediate(resolve));
  if(prepared)await f.backend.destroy(prepared);
  if(mutation)await mutation;
  active=false;pause=async(_id,run)=>run();kitChanged=false;f.backend.runSbx=original;process.env.FARAVAN_SBX_BIN=oldBin;close();
  if(target){
   assert.ok(revoked,'pause reached: '+target);
   assert.equal(inputs.filter(row=>row.revoked).length,0,'no value is delivered after invalidation');
   assert.equal(spawns.filter(row=>row.revoked&&row.phase!=='cleanup'&&row.command!=='version'&&!row.inventory).length,0,'no job subprocess or acknowledgement starts after invalidation');
   if(['binary','path','kit'].includes(revoke))assert.equal(spawns.filter(row=>row.revoked&&(row.phase==='cleanup'||row.inventory)).length,0,'runtime drift prevents cleanup and inventory process creation');
   if(error)assert.equal(error.code,'claude_account_unavailable');
  }else if(error)throw error;
  return {seen:[...new Set(seen)],ack,inputs};
 }
 const observed=new Map();subprocesses=new Set();
 const variants=[{guarded:false},{guarded:true,mounted:true},{guarded:true,mounted:false},{guarded:true,mounted:false,cold:true},{guarded:true,mounted:false,cold:true,widenRuntime:true},{guarded:false,diskStop:true},{guarded:true,reserve:true},{output:true},{selfCheck:'account'},{selfCheck:'control'},{guarded:false,mountless:true},{guarded:false,mountless:true,residue:true,post:true},{guarded:false,diskContention:true}];
 for(const options of variants){const result=await journey(t,options);for(const id of result.seen)if(!observed.has(id))observed.set(id,options);if(options.guarded)assert.equal(result.ack,true);assert.ok(result.inputs.length>0,'the positive preparation transmits its scoped value');}
 const reached=new Set([...observed.keys()].map(id=>id.slice(id.indexOf('/')+1).split('@')[0]));
 const snapshot={totals,static:sites.filter(site=>reached.has(site.id)).map(({id,expression})=>({id,expression})),covered:[...observed.keys()].sort(),subprocessSites:[...subprocesses].sort()};
 if(process.env.UPDATE_ACCOUNT_AWAIT_CENSUS){writeFileSync(new URL('./fixtures/claude-account-await-census.json',import.meta.url),JSON.stringify(snapshot,null,2)+'\n');return;}
 assert.deepEqual(snapshot,census,'await and subprocess observations must agree with the published census');
 // Every target against every revocation is about nine thousand journeys of several seconds each. A normal run takes every
 // eighth target, each with a rotating revocation; set ACCOUNT_AWAIT_CENSUS_FULL=1 for the exhaustive sweep.
 const revocations=['failed','superseded','disabled','removed','bytes','mode','symlink','binary','path','kit'],full=process.env.ACCOUNT_AWAIT_CENSUS_FULL==='1';
 for(const [index,target] of census.covered.entries())for(const [step,revoke] of revocations.entries())if(full||index%8===0&&step===(index/8)%revocations.length)await t.test(target+' / '+revoke,async t=>journey(t,{...observed.get(target),target,revoke}));
});
test.after(()=>{hook.deregister();fs.readFileSync=readSync;fs.fsyncSync=syncFile;syncBuiltinESMExports();delete globalThis.__accountAwaitPause;delete globalThis.__accountSpawnTest;});
