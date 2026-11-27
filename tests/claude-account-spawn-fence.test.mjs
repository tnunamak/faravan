import './helpers/no-browser.mjs';
import {transportPrelude,transportGlobals,sbxChildEnv} from './helpers/sbx-transport-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {runInNewContext} from 'node:vm';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {accountBackend} from './helpers/claude-account-backend.mjs';
import * as accounts from '../lib/claude-accounts.mjs';
import {removeClaudeAccount} from '../lib/credential-generations.mjs';
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const helpers=section('async function runSbx(', '// Binary transport:');
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const unavailable=error=>error.code==='claude_account_unavailable';

for(const fault of ['bytes','mode','symlink'])test(`the final account fence rejects changed value ${fault}`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const handle=await f.backend.prepare(f.job,{accountKey:a.key});
 const path=join(f.home,'credential-generations',a.record.id,'value');
 if(fault==='bytes')await fsp.writeFile(path,token());
 if(fault==='mode')await fsp.chmod(path,0o644);
 if(fault==='symlink'){await fsp.rename(path,path+'.other');await fsp.symlink(path+'.other',path);}
 assert.throws(()=>handle._fenceClaude(),unavailable);
 await f.backend.destroy(handle);
});

for(const code of ['EACCES','EIO'])test(`removal retries its post-unlink deletion obligation (${code})`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const pointer=join(f.home,'claude-account-'+a.record.accountId+'.json'),directory=join(f.home,'credential-generations',a.record.id);
 const real=fsp.rm;let fail=true;
 fsp.rm=async(path,...rest)=>{if(path===directory&&fail)throw Object.assign(new Error('injected'),{code});return real(path,...rest);};syncBuiltinESMExports();
 t.after(()=>{fsp.rm=real;syncBuiltinESMExports();});
 await assert.rejects(removeClaudeAccount(f.home,a.record.accountId));
 assert.equal(fs.existsSync(pointer),false);
 await assert.rejects(removeClaudeAccount(f.home,a.record.accountId));
 assert.equal(fs.existsSync(join(directory,'value')),true);
 fail=false;assert.equal(await removeClaudeAccount(f.home,a.record.accountId),true);
 assert.equal(fs.existsSync(directory),false);
});

// Execute the production helpers with fake daemon and process primitives. Nothing invokes a real sbx.
for(const method of ['buffered','streaming'])for(const revoke of ['failed','superseded','disabled','removed','bytes','mode','symlink'])
test(`${method} checks ${revoke} after daemon preparation`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const handle=await f.backend.prepare(f.job,{accountKey:a.key});
 const generation=await accounts.claudeAccountCheckGeneration(f.home,a.record,await f.backend.claudeAccountRuntime());
 assert.ok(generation);
 let spawns=0,pauses=0;
 const mutate=async()=>{
  pauses++;
  if(revoke==='failed')await accounts.recordClaudeAccountCheck(f.home,a.record,{...await f.backend.claudeAccountRuntime(),status:401});
  if(revoke==='superseded')await accounts.beginClaudeAccountCheck(f.home,a.record);
  if(revoke==='disabled')f.registry.setEnabled(a.record.accountId,false);
  if(revoke==='removed')await fsp.rm(join(f.home,'claude-account-'+a.record.accountId+'.json'));
  const path=join(f.home,'credential-generations',a.record.id,'value');
  if(revoke==='bytes')await fsp.writeFile(path,token());
  if(revoke==='mode')await fsp.chmod(path,0o644);
  if(revoke==='symlink'){await fsp.rename(path,path+'.other');await fsp.symlink(path+'.other',path);}
 };
 const functions=runInNewContext(transportPrelude(source)+helpers+'\n({runSbx,runSbxStreaming})',{...transportGlobals,
  needsSbxDaemon:()=>true,ensureSbxDaemon:mutate,sbxBin:()=>'/fake/sbx',sbxChildEnv,recordDaemonLaunch(){},
  execFile(){spawns++;throw new Error('unexpected spawn');},spawn(){spawns++;throw new Error('unexpected spawn');},SbxDaemonVerificationError:class extends Error{},
 });
 const options={beforeSpawn:handle._fenceClaude,binary:'/fake/sbx'};
 await assert.rejects(method==='buffered'?functions.runSbx(['exec','sandbox'],options):functions.runSbxStreaming(['exec','sandbox'],null,null,null,null,options),unavailable);
 assert.equal(pauses,1);assert.equal(spawns,0,'no process, including a launch acknowledgement, starts');
 await f.backend.destroy(handle);
});

for(const when of ['after admission','during daemon'])test(`runtime identity drift ${when} refuses the dispatch`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const binary=join(f.home,'fake-sbx');await fsp.writeFile(binary,'fake executable',{mode:0o700});
 const old=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN=binary;
 t.after(()=>{if(old===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=old;});
 await accounts.recordClaudeAccountCheck(f.home,a.record,{...await f.backend.claudeAccountRuntime(),status:200,controlStatus:401});
 const handle=await f.backend.prepare(f.job,{accountKey:a.key});
 const change=()=>fsp.writeFile(binary,'a replacement executable with another identity');
 if(when==='after admission'){await change();assert.throws(()=>handle._fenceClaude(),unavailable);}
 else {
  let spawns=0;
  const functions=runInNewContext(transportPrelude(source)+helpers+'\n({runSbx})',{...transportGlobals,
   needsSbxDaemon:()=>true,ensureSbxDaemon:change,sbxBin:()=>binary,sbxChildEnv,recordDaemonLaunch(){},
   execFile(){spawns++;throw new Error('unexpected spawn');},SbxDaemonVerificationError:class extends Error{},
  });
  await assert.rejects(functions.runSbx(['exec','sandbox'],{beforeSpawn:handle._fenceClaude,binary}),unavailable);
  assert.equal(spawns,0);
 }
 await f.backend.destroy(handle);
});

test('the removal CLI keeps a failed deletion listed through EACCES and EIO retries',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const directory=join(f.home,'credential-generations',a.record.id),realRm=fsp.rm,realStat=fsp.lstat;
 let failure='EACCES';
 fsp.rm=async(path,...rest)=>{if(path===directory&&failure==='EACCES')throw Object.assign(new Error('injected'),{code:failure});return realRm(path,...rest);};
 fsp.lstat=async(path,...rest)=>{if(path===directory&&failure==='EIO')throw Object.assign(new Error('injected'),{code:failure});return realStat(path,...rest);};
 syncBuiltinESMExports();t.after(()=>{fsp.rm=realRm;fsp.lstat=realStat;syncBuiltinESMExports();});
 async function remove(){let out='';const exit=await runAccountsCommand(['remove','claude','--label','Example'],{home:f.home,backend:f.backend,stdout:{write:x=>out+=x}});return {exit,...JSON.parse(out)};}
 let result=await remove();assert.equal(result.exit,1);assert.equal(result.removed,false);
 assert.equal(fs.existsSync(join(f.home,'claude-account-'+a.record.accountId+'.json')),false);
 failure='EIO';result=await remove();assert.equal(result.exit,1);assert.equal(result.removed,false);
 assert.equal(f.registry.list().some(row=>row.id===a.record.accountId&&!row.enabled),true);
 assert.equal(fs.existsSync(join(directory,'value')),true);
 failure=null;result=await remove();assert.equal(result.exit,0);assert.equal(result.removed,true);
 assert.equal(fs.existsSync(directory),false);assert.equal(f.registry.list().some(row=>row.id===a.record.accountId),false);
});
