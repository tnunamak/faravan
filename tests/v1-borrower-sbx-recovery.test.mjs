import './helpers/no-browser.mjs';
import './helpers/short-sbx-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSbxDaemon,restartSbxDaemon} from '../lib/docker-backend.mjs';
import {acquirePreviewLock,recoverPreviewLock,recordTransaction} from '../lib/v1/preview-lock.mjs';
import { systemdShowEnvironment } from './helpers/systemd-environment.mjs';

for(const step of ['start','ls'])test('repair child has a deadline: '+step,async()=>{
 const calls=[];
 const runCommand=async(_command,args,options)=>{calls.push({args,options});return {code:0,stdout:args[0]==='ls'?'[]':''};};
 if(step==='start')await startSbxDaemon({runCommand});
 else await restartSbxDaemon({runCommand,daemons:[{pid:123,environ:{}}],sandboxes:[],waitForExit:async()=>true});
 const call=calls.find(c=>c.args[0]===(step==='ls'?'ls':'daemon')&&(step==='ls'||c.args[1]===step));
 assert.ok(call.options.timeout>0,'repair subprocess must have a finite timeout');
});

test('macOS abandoned preview lock retains identity and can be recovered',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'preview-mac-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let alive=true,groupAlive=true;
 const options={platformName:'darwin',identityReader:()=>({boot:'darwin:123',start:'456'}),processKill:pid=>{if(pid<0?groupAlive:alive)return;throw Object.assign(new Error(),{code:'ESRCH'});}};
 const path=join(dir,'HEAD.lock');
 await acquirePreviewLock(path,join(dir,'stage'),options);
 const saved=JSON.parse(await readFile(path,'utf8'));
 assert.equal(saved.boot,'darwin:123');
 await assert.rejects(recoverPreviewLock(path,options),{code:'preview_lock_blocked'});
 await recordTransaction(path,123,join(dir,'stage'));
 alive=false;
 await assert.rejects(recoverPreviewLock(path,options),{code:'preview_lock_blocked'});
 groupAlive=false;
 await recoverPreviewLock(path,options);
 await assert.rejects(readFile(path),{code:'ENOENT'});
 await writeFile(path,JSON.stringify({version:1,token:saved.token}));
 await assert.rejects(recoverPreviewLock(path,options),{code:'preview_lock_blocked'});
});

test('hung repair client is killed and reaped before another health refresh',{timeout:15000},async t=>{
 const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
 const dir=await mkdtemp(join(tmpdir(),'repair-hang-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const executable=join(dir,'sbx-fixture'),pidFile=join(dir,'pid');
 await writeFile(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700});
 const previous=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN=executable;
 t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=previous;});
 const backend=Object.create(DockerSbxBackend.prototype);backend._healthRecovery=null;
 backend._recoverHealth=options=>startSbxDaemon(options);
 const result=await backend.recoverHealth({commandTimeoutMs:1500});
 assert.notEqual(result.code,0);
 assert.equal(backend._healthRecovery,null);
 const pid=Number(await readFile(pidFile,'utf8'));
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 backend._recoverHealth=async()=>({recovered:true});
 assert.equal((await backend.recoverHealth()).recovered,true);
});

test('a waiting job can abort without releasing the shared repair',async()=>{
 const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
 const backend=Object.create(DockerSbxBackend.prototype);let finish;
 backend._healthRecovery=new Promise(resolve=>{finish=resolve;});
 const controller=new AbortController(),pending=backend.waitForHealth({signal:controller.signal});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 assert.ok(backend._healthRecovery);finish();
});

test('macOS preview lock is recovered from disk after its owner crashes',{timeout:15000},async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');
 const dir=await mkdtemp(join(tmpdir(),'preview-mac-crash-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'HEAD.lock'),module=new URL('../lib/v1/preview-lock.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`
 import {acquirePreviewLock} from ${JSON.stringify(module)};
 await acquirePreviewLock(${JSON.stringify(path)},${JSON.stringify(join(dir,'stage'))},{platformName:'darwin',identityReader:()=>({boot:'darwin:123',start:'456'})});
 console.log('locked');setInterval(()=>{},1000);
 `],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
 await once(child.stdout,'data');
 const options={platformName:'darwin',identityReader:()=>({boot:'darwin:123',start:'456'})};
 assert.equal(JSON.parse(await readFile(path,'utf8')).boot,'darwin:123');
 await assert.rejects(recoverPreviewLock(path,options),{code:'preview_lock_blocked'});
 child.kill('SIGKILL');await exited;
 await recoverPreviewLock(path,options);
 await assert.rejects(readFile(path),{code:'ENOENT'});
});


test('managed daemon stop has a finite deadline after ownership is verified', async t => {
  const {sbxOwnerFile,installRoot}=await import('../lib/sbx-daemon-owner.mjs');
  const {sbxChildEnv,credentialStoreEnv,sbxDaemonDescription}=await import('../lib/docker-backend.mjs');
  const dir=await mkdtemp(join(tmpdir(),'repair-owned-stop-'));
  const previous=process.env.FARAVAN_HOME;process.env.FARAVAN_HOME=dir;
  t.after(async()=>{if(previous===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=previous;await rm(dir,{recursive:true,force:true});});
  const id='a'.repeat(64),executable=process.execPath;
  await writeFile(sbxOwnerFile(),JSON.stringify({id,executable}));
  const env=systemdShowEnvironment([...Object.entries(credentialStoreEnv(sbxChildEnv().HOME,'linux')),['FARAVAN_SBXD_OWNER_ID',id],['FARAVAN_SBXD_INSTALL_ROOT',installRoot],['FARAVAN_SBXD_DATA_HOME',dir]]);
  let stopped;
  const runCommand=async(command,args,options)=>{
    if(args[0]==='ls')return {code:0,stdout:'[]'};
    if(command==='systemctl' && args.includes('show'))return {code:0,stdout:`LoadState=loaded\nActiveState=active\nMainPID=123\nInvocationID=${'b'.repeat(32)}\nDescription=${sbxDaemonDescription()}\nExecStart={ path=${executable} ; argv[]=${executable} daemon start ; }\nEnvironment=${env}\n`};
    if(command==='systemctl' && args.includes('stop')){stopped=options;return {code:1};}
    throw new Error('unexpected lifecycle command');
  };
  await restartSbxDaemon({runCommand,daemons:[{pid:123,environ:sbxChildEnv()}],sandboxes:[],inspectSandboxes:async()=>[],platformName:'linux',systemd:true,isProcessAlive:()=>true});
  // The stop is bound to the checked invocation, so the unit must report one.
  assert.ok(stopped.timeout>0,'the verified unit stop must have a finite deadline');
});
