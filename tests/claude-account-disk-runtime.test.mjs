import './helpers/no-browser.mjs';
import {transportPrelude,transportGlobals,sbxChildEnv} from './helpers/sbx-transport-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {runInNewContext} from 'node:vm';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {accountBackend} from './helpers/claude-account-backend.mjs';
import {createDiskLedger} from '../lib/disk-ledger.mjs';
import {REMOVE_ARTIFACTS_ENV} from '../lib/disk-sweep-setting.mjs';

const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function runSbx('),source.indexOf('// The normal helper intentionally'));
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');

for(const outcome of ['success','failure'])for(const mutation of ['none','binary','path','PATH','kit','disabled'])
test(`create ${outcome} settlement ${mutation==='none'?'inventories with the qualified binary':mutation==='disabled'?'permits account revocation on the qualified runtime':'refuses '+mutation+' drift without recording ownership'}`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const oldPath=process.env.PATH,oldRemoval=process.env[REMOVE_ARTIFACTS_ENV],readSync=fs.readFileSync;
 const first=join(f.home,'first'),second=join(f.home,'second');await mkdir(first);await mkdir(second);
 const binary=join(first,'sbx'),replacement=join(second,'sbx');
 await writeFile(binary,'qualified executable',{mode:0o700});await writeFile(replacement,'other executable',{mode:0o700});
 process.env.FARAVAN_SBX_BIN=mutation==='PATH'?'sbx':binary;
 process.env.PATH=first+':'+oldPath;process.env[REMOVE_ARTIFACTS_ENV]='1';
 t.after(()=>{process.env.PATH=oldPath;if(oldRemoval===undefined)delete process.env[REMOVE_ARTIFACTS_ENV];else process.env[REMOVE_ARTIFACTS_ENV]=oldRemoval;fs.readFileSync=readSync;syncBuiltinESMExports();});
 const ledger=createDiskLedger({file:join(f.home,'disk-ledger.json')});f.backend.diskLedger=ledger;
 await f.ready(account.record);f.flags.createFails=outcome==='failure';
 let started,release;const pending=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 let invalidated=false,kitChanged=false;const inventory=[],inputs=[],bindings=[],run=f.backend.runSbx;
 fs.readFileSync=(file,...rest)=>kitChanged&&String(file).endsWith('/kits/wf-claude-account/spec.yaml')?Buffer.from('changed kit'):readSync(file,...rest);syncBuiltinESMExports();
 const functions=runInNewContext(transportPrelude(source)+helper+'\n({runSbx})',{...transportGlobals,
  needsSbxDaemon:()=>true,ensureSbxDaemon:async()=>{},sbxBin:()=>process.env.FARAVAN_SBX_BIN,sbxChildEnv,recordDaemonLaunch(){},SbxDaemonVerificationError:class extends Error{},
  execFile(executable,args){
   if(args[0]==='template')inventory.push(executable);
   let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});
   result.child={stdin:{on(){},end(input){
    if(invalidated&&input!==undefined)inputs.push(true);
    Promise.resolve().then(async()=>{
     const result=args[0]==='template'?{code:0,stdout:'[]',stderr:''}:await run(args,{input});
     if(args[0]==='create'){started();await gate;}
     if(result.code!==0)throw Object.assign(new Error('Synthetic command failed'),{code:result.code,stdout:result.stdout??'',stderr:result.stderr??''});
     return result;
    }).then(resolve,reject);
   }}};return result;
  },
 });
 f.backend.runSbx=(args,options)=>{if(args[0]==='template')bindings.push(options);return functions.runSbx(args,options);};
 const prepared=f.backend.prepare(f.job,{accountKey:account.key}).then(handle=>({handle}),error=>({error}));
 await Promise.race([pending,prepared.then(result=>{if(result.error)throw result.error;})]);
 assert.equal(ledger.activeLeases().filter(row=>row.item.startsWith('sandbox:')).length,1);
 inventory.length=0;bindings.length=0;
 if(mutation==='binary')await writeFile(binary,'changed contents at the same path');
 if(mutation==='path')process.env.FARAVAN_SBX_BIN=replacement;
 if(mutation==='PATH')process.env.PATH=second+':'+oldPath;
 if(mutation==='kit')kitChanged=true;
 if(mutation==='disabled')f.registry.setEnabled(account.record.accountId,false);
 invalidated=mutation!=='none';release();
 const result=await prepared;
 const drift=['binary','path','PATH','kit'].includes(mutation);
 if(drift){
  assert.deepEqual(inventory,[],'runtime drift prevents inventory process creation');
  assert.deepEqual(ledger.ownedImages(),{},'refused inventory grants no image ownership');
 }else {
  assert.deepEqual(inventory,outcome==='success'?[binary]:[],'only a successful create needs settlement inventory');
  if(outcome==='success'){assert.equal(bindings[0]?.binary,binary);assert.equal(typeof bindings[0]?.beforeSpawn,'function');}
 }
 assert.equal(inputs.length,0,'no value is delivered after invalidation');
 if(outcome==='failure'||mutation!=='none')assert.ok(result.error);
 else {if(result.error)throw result.error;assert.ok(result.handle);await f.backend.destroy(result.handle);assert.equal(ledger.activeLeases().length,0);}
});

for(const drift of [false,true])test(`disk adapter inherits the job runtime${drift?' and refuses drift before inventory':''}`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const binary=join(f.home,'context-sbx');await writeFile(binary,'qualified executable',{mode:0o700});
 process.env.FARAVAN_SBX_BIN=binary;await f.ready(account.record);
 const handle=await f.backend.prepare(f.job,{accountKey:account.key}),original=f.backend.runSbx,adapters=f.backend.diskSweepAdapters(),inventory=[];
 f.backend.runSbx=async(args,options)=>{
  if(args.at(-1)==='disk-context'){
   if(drift)await writeFile(binary,'changed executable at the same path');
   return adapters.runSbx(['template','ls','--json']);
  }
  options?.beforeSpawn?.();
  if(args[0]==='template'){inventory.push(options);assert.equal(options?.binary,binary);assert.equal(typeof options?.beforeSpawn,'function');}
  return original(args,options);
 };
 const result=f.backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','disk-context']);
 if(drift){await assert.rejects(result,e=>e.code==='claude_account_unavailable');assert.deepEqual(inventory,[]);}
 else {assert.equal((await result).code,0);assert.equal(inventory.length,1);}
 f.backend.runSbx=original;await f.backend.destroy(handle);
});
