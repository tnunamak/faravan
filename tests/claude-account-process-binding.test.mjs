import './helpers/no-browser.mjs';
import {transportPrelude,transportGlobals,sbxChildEnv} from './helpers/sbx-transport-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {accountBackend} from './helpers/claude-account-backend.mjs';
import {beginClaudeAccountCheck} from '../lib/claude-accounts.mjs';
const source=await readFile(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function runSbx('),source.indexOf('// The normal helper intentionally'));
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');

for(const mode of [false,'account','control'])for(const point of ['create-result','secret-set-daemon','secret-list-daemon'])for(const mutation of ['path','disable'])
test(`${mode||'job'} rejects ${mutation} during ${point} before further secret delivery`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts,original=f.backend.runSbx;
 if(mode)await beginClaudeAccountCheck(f.home,a.record);
 const qualified=process.execPath,replacement=join(f.home,'unqualified-sbx');await writeFile(replacement,'unqualified',{mode:0o700});
 let changed=false,cleanup=false,unqualified=0,secretStarts=0,secretInputs=0;
 const destroy=f.backend.destroy.bind(f.backend);f.backend.destroy=(...args)=>{cleanup=true;return destroy(...args);};
 const mutate=()=>{changed=true;if(mutation==='path')process.env.FARAVAN_SBX_BIN=replacement;else f.registry.setEnabled(a.record.accountId,false);};
 const functions=runInNewContext(transportPrelude(source)+helper+'\n({runSbx})',{...transportGlobals,
  needsSbxDaemon:args=>args[0]!=='version',
  ensureSbxDaemon:async({commandArgs:args})=>{
   const selected=point==='secret-set-daemon'?args[0]==='secret'&&args[1]==='set':point==='secret-list-daemon'?args[0]==='secret'&&args[1]==='ls'&&args.includes('--sandbox')&&f.secrets.length>0:false;
   if(!changed&&selected)mutate();
  },
  sbxBin:()=>process.env.FARAVAN_SBX_BIN,sbxChildEnv,recordDaemonLaunch(){},SbxDaemonVerificationError:class extends Error{},
  execFile(binary,args){
   if(changed&&binary!==qualified)unqualified++;
   if(changed&&!cleanup&&args[0]==='secret'&&['set','ls'].includes(args[1]))secretStarts++;
   let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});
   result.child={stdin:{on(){},end(input){
    if(changed&&input!==undefined)secretInputs++;
    Promise.resolve().then(()=>original(args,{input})).then(result=>{
     if(!changed&&point==='create-result'&&args[0]==='create')mutate();
     resolve({stdout:result.stdout??'',stderr:result.stderr??''});
    },reject);
   }},once(){}};
   return result;
  },
 });
 f.backend.runSbx=functions.runSbx;
 await assert.rejects(f.backend.prepare(f.job,{accountKey:a.key,accountSelfCheck:mode}),e=>e.code==='claude_account_unavailable');
 assert.equal(changed,true,'the pending boundary was reached');
 assert.equal(unqualified,0,'no process uses the unqualified executable');
 assert.equal(secretInputs,0,'no value reaches stdin after invalidation');
 assert.equal(secretStarts,0,'no secret command continues preparation after invalidation');
 f.backend.runSbx=original;
});

test('self-check preparation pins a disabled account without a passing check',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts,original=f.backend.runSbx;
 f.registry.setEnabled(a.record.accountId,false);await beginClaudeAccountCheck(f.home,a.record);
 const calls=[];
 f.backend.runSbx=(args,options)=>{calls.push({args,options});return original(args,options);};
 const handle=await f.backend.prepare(f.job,{accountKey:a.key,accountSelfCheck:'account'});
 assert.ok(calls.length>0);
 for(const {options} of calls){assert.equal(options?.sbxRuntime?.path??options?.binary,process.execPath);assert.ok(options?.sbxRuntime||typeof options?.beforeSpawn==='function','every call carries a qualified runtime or its pinned fence adapter');}
 await f.backend.destroy(handle);
});

test('a self-check keeps one qualified runtime across its account and control probes',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const replacement=join(f.home,'other-sbx');await writeFile(replacement,'other executable',{mode:0o700});
 const prepare=f.backend.prepare.bind(f.backend),run=f.backend.runSbx;let changed=false,inputs=0;
 f.backend.prepare=(job,options)=>{if(options.accountSelfCheck==='control'){changed=true;process.env.FARAVAN_SBX_BIN=replacement;}return prepare(job,options);};
 f.backend.runSbx=(args,options)=>{if(changed&&options?.input!==undefined)inputs++;return run(args,options);};
 await assert.rejects(f.backend.checkClaudeAccount(a.key),e=>e.code==='claude_account_unavailable');
 assert.equal(changed,true);assert.equal(inputs,0,'a changed control runtime receives no value');
});
