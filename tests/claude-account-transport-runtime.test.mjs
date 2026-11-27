import './helpers/no-browser.mjs';
import {passThroughJobContext,transportPrelude,transportGlobals,sbxChildEnv} from './helpers/sbx-transport-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {runInNewContext} from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {accountBackend} from './helpers/claude-account-backend.mjs';

const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('async function runSbx('),source.indexOf('function outputOf('));
const unavailable=()=>Object.assign(new Error('Account unavailable'),{code:'claude_account_unavailable'});
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');

function transports({fallback,daemon=async()=>{},execFile,spawn}){
 return runInNewContext(transportPrelude(source)+helpers+'\n({runSbx,runSbxStreaming,streamSbxOutput})',{...transportGlobals,
  needsSbxDaemon:()=>true,ensureSbxDaemon:daemon,sbxBin:()=>fallback,sbxChildEnv,
  recordDaemonLaunch(){},daemonJobContext:passThroughJobContext(),execFile,spawn,
  policyError:(code,message)=>Object.assign(new Error(message),{code}),SbxDaemonVerificationError:class extends Error{},
 });
}

for(const method of ['buffered','streaming','output'])for(const refused of [false,true])
test(`${method} transport ${refused?'refuses before launch and stdin':'launches the pinned executable instead of the configured fallback'}`,async()=>{
 const pinned='/qualified/sbx',fallback='/configured/sbx',launches=[],inputs=[],events=[];
 assert.notEqual(pinned,fallback);
 const functions=transports({fallback,daemon:async()=>{events.push('daemon');},
  execFile(binary){
   events.push('launch');launches.push(binary);
   const result=Promise.resolve({stdout:'fixture output',stderr:''});
   result.child={stdin:{on(){},end(input){inputs.push(input!==undefined);}}};return result;
  },
  spawn(binary){
   events.push('launch');launches.push(binary);
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;
   child.kill=()=>{child.exitCode=0;child.stdout.end();child.stderr.end();child.emit('close',0);};
   setImmediate(()=>{child.stdout.end('fixture output');child.stderr.end();child.exitCode=0;child.emit('close',0);});
   return child;
  },
 });
 const beforeSpawn=()=>{events.push('fence');if(refused)throw unavailable();};
 const run=async()=>{
  if(method==='buffered')return functions.runSbx(['secret','set'],{binary:pinned,beforeSpawn,input:Buffer.from('synthetic stdin')});
  if(method==='streaming')return functions.runSbxStreaming(['exec','sandbox'],null,null,null,null,{binary:pinned,beforeSpawn});
  for await(const _chunk of functions.streamSbxOutput({sandbox_id:'sandbox',_sbxRuntime:transportGlobals.createSbxRuntime({path:pinned,fence:beforeSpawn})},'/out')){}
 };
 if(refused){await assert.rejects(run(),e=>e.code==='claude_account_unavailable');assert.deepEqual(launches,[]);assert.deepEqual(inputs,[]);assert.deepEqual(events,['daemon','fence']);}
 else {await run();assert.deepEqual(launches,[pinned]);assert.deepEqual(events,['daemon','fence','launch']);assert.deepEqual(inputs,method==='buffered'?[true]:[]);}
});

for(const mutation of ['none','binary','kit','path'])
test(`cleanup after account revocation ${mutation==='none'?'succeeds on the qualified runtime':'refuses '+mutation+' drift after daemon preparation'}`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const binary=join(f.home,'qualified-sbx'),replacement=join(f.home,'other-sbx');
 await writeFile(binary,'qualified executable',{mode:0o700});await writeFile(replacement,'other executable',{mode:0o700});
 process.env.FARAVAN_SBX_BIN=binary;await f.ready(account.record);
 const handle=await f.backend.prepare(f.job,{accountKey:account.key});
 f.registry.setEnabled(account.record.accountId,false);
 const original=f.backend.runSbx,readSync=fs.readFileSync,launches=[],inputs=[];let changed=false,kitChanged=false;
 fs.readFileSync=(file,...rest)=>kitChanged&&String(file).endsWith('/kits/wf-claude-account/spec.yaml')?Buffer.from('changed kit'):readSync(file,...rest);
 syncBuiltinESMExports();
 t.after(()=>{fs.readFileSync=readSync;syncBuiltinESMExports();f.backend.runSbx=original;});
 const functions=transports({fallback:binary,
  daemon:async()=>{
   if(changed)return;changed=true;
   if(mutation==='binary')await writeFile(binary,'changed contents at the same path');
   if(mutation==='kit')kitChanged=true;
   if(mutation==='path')process.env.FARAVAN_SBX_BIN=replacement;
  },
  execFile(executable,args){
   launches.push(executable);
   let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});
   result.child={stdin:{on(){},end(input){inputs.push(input!==undefined);Promise.resolve().then(()=>original(args,{input})).then(resolve,reject);}}};
   return result;
  },spawn(){throw new Error('Cleanup must use the buffered control transport');},
 });
 f.backend.runSbx=functions.runSbx;
 const receipt=await f.backend.destroy(handle);
 assert.equal(changed,true,'cleanup reached its daemon boundary');
 if(mutation==='none'){
  assert.equal(receipt.removed&&receipt.policy_removed&&receipt.scratch_removed,true);
  assert.ok(launches.length>0);assert.ok(launches.every(path=>path===binary));assert.equal(f.secrets.length,0);
 }else {assert.equal(receipt.removed,false);assert.deepEqual(launches,[],'runtime drift prevents every cleanup process');assert.equal(f.secrets.length,1);}
 assert.ok(inputs.every(hasValue=>!hasValue),'cleanup never sends a value to stdin');
});
