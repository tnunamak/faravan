import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp,{mkdtemp,rm,chmod,readFile,writeFile,readdir,mkdir,stat,symlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {publishClaudeAccount,readClaudeAccount,removeClaudeAccount,removeOrphanClaudeGenerations,readClaudeAccountValue} from '../lib/credential-generations.mjs';
import * as accounts from '../lib/claude-accounts.mjs';
import {accountBackend} from './helpers/claude-account-backend.mjs';

const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
async function home(t){const dir=await mkdtemp(join(tmpdir(),'faravan-fix4-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const runtime=async()=>({version:'test-version',kitDigest:await accounts.claudeKitDigest()});
const failCheck=async(f,record)=>accounts.recordClaudeAccountCheck(f.home,record,{...await f.backend.claudeAccountRuntime(),status:200,controlStatus:200});
const patchFs=(t,patch)=>{const saved={};for(const key of Object.keys(patch)){saved[key]=fsp[key];fsp[key]=patch[key](saved[key]);}syncBuiltinESMExports();
 const restore=()=>{for(const key of Object.keys(saved))fsp[key]=saved[key];syncBuiltinESMExports();};t.after(restore);return restore;};

// A real start() over the fake sbx. The guard install is slow; `during` runs while it is pending.
async function startDuring(t,during){
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const handle=await f.backend.prepare(f.job,{accountKey:account.key});
 let mark=null;
 f.backend._installGuard=async h=>{
  h._execution={...h._execution,guard_runtime:{node:'/usr/bin/node',path:'/usr/bin/node'}};
  await during(f,account);mark=f.calls.length;
  return {path:'/g/guard.mjs',ctl:'/g/ctl',lastBeat:0,running:null,finished:false,config:{v:1,mode:'generic',ctl:'/g/ctl',nonce:'n'.repeat(32),soft_deadline_s:null,heartbeat_ms:1000,sigint_grace_ms:1,sigterm_grace_ms:1,meter_start_ms:1,meter_loss_ms:1,budget:null}};
 };
 await assert.rejects(f.backend.start(handle,{onExecutionStarted(){}}),error=>error.code==='claude_account_unavailable');
 assert.notEqual(mark,null,'the guard install ran');
 assert.equal(f.execs(mark).length,0,'the agent command never ran');
 await f.backend.destroy(handle);
}
test('a check that fails while the guard installs stops the job before its agent command',t=>startDuring(t,(f,a)=>failCheck(f,a.record)));
test('a removed account while the guard installs stops the job before its agent command',t=>startDuring(t,(f,a)=>{f.registry.setEnabled(a.key.slice(7),false);return rm(join(f.home,'claude-account-'+a.record.accountId+'.json'));}));

test('an older check finishing last cannot restore readiness after a newer failed check',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[{record}]=f.accounts,ok={...await f.backend.claudeAccountRuntime(),status:200,controlStatus:401};
 const a=await accounts.beginClaudeAccountCheck(f.home,record),b=await accounts.beginClaudeAccountCheck(f.home,record);
 assert.equal(await accounts.recordClaudeAccountCheck(f.home,record,{...ok,controlStatus:200},b),true);
 assert.equal(await accounts.recordClaudeAccountCheck(f.home,record,ok,a),false);
 assert.equal(await accounts.claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),false);
});
test('an older check finishing while a newer one runs leaves the account not ready',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[{record}]=f.accounts,ok={...await f.backend.claudeAccountRuntime(),status:200,controlStatus:401};
 const a=await accounts.beginClaudeAccountCheck(f.home,record);await accounts.beginClaudeAccountCheck(f.home,record);
 assert.equal(await accounts.recordClaudeAccountCheck(f.home,record,ok,a),false);
 assert.equal(await accounts.claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),false);
});
test('a superseded check does not enable the account',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 f.registry.setEnabled(account.key.slice(7),false);
 f.flags.onSet=(()=>{let n=0;return async()=>{if(n++===0)await accounts.beginClaudeAccountCheck(f.home,account.record);};})();
 let out='';
 const code=await runAccountsCommand(['check',account.key],{home:f.home,stdout:{write:x=>out+=x},backend:f.backend});
 assert.equal(code,1);assert.equal(f.registry.get(account.key.slice(7)).enabled,false);
});

for(const [code,name] of [['EACCES','pointer'],['EIO','generation']])
test(`removal fails closed when the ${name} state is unknown (${code})`,async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t,{tokens:[]});
 const run=async(argv,stdin)=>{let out='';const exit=await runAccountsCommand(argv,{home:f.home,stdin,stdout:{write:x=>out+=x},backend:f.backend});return {exit,out};};
 const added=JSON.parse((await run(['add','claude','--label','Work'],Readable.from([token()]))).out);
 const target=name==='pointer'?'claude-account-'+added.id+'.json':join('credential-generations',(await readClaudeAccount(f.home,added.id)).id);
 patchFs(t,{lstat:real=>async(path,...rest)=>{if(String(path).endsWith(target))throw Object.assign(new Error('x'),{code});return real(path,...rest);}});
 const result=await run(['remove','claude','--label','Work']);
 assert.equal(result.exit,1);assert.equal(JSON.parse(result.out).removed,false);
 assert.equal(f.registry.list().some(a=>a.id===added.id),true,'the account is still listed');
});

test('the generation directory is made durable after the marker and before the value',async t=>{
 const h=await home(t),events=[];
 patchFs(t,{open:real=>async(path,flags,...rest)=>{
  if(typeof flags==='number'&&String(path).endsWith('claude-account.json'))events.push('marker');
  else if(typeof flags==='number'&&String(path).endsWith('/value'))events.push('value');
  else if(flags==='r'&&/claude-pending-/.test(String(path)))events.push('sync-generation');
  return real(path,flags,...rest);}});
 await publishClaudeAccount(h,randomUUID(),{kind:'subscription-token',token:token()});
 const first=events.indexOf('marker');
 assert.deepEqual(events.slice(first,first+3),['marker','sync-generation','value']);
});
test('recovery removes a value that has no marker when this app created the directory',async t=>{
 const h=await home(t);
 const restore=patchFs(t,{open:real=>async(path,...rest)=>{const fd=await real(path,...rest);
  if(String(path).endsWith('/value')){const close=fd.close.bind(fd);fd.close=async()=>{await close();throw Object.assign(new Error('crash'),{code:'EIO'});};}return fd;},rm:()=>async()=>{}});
 await assert.rejects(publishClaudeAccount(h,randomUUID(),{kind:'subscription-token',token:token()}),/crash/);restore();
 const [left]=await readdir(join(h,'credential-generations'));
 await rm(join(h,'credential-generations',left,'claude-account.json'));
 assert.ok((await stat(join(h,'credential-generations',left,'value'))).isFile());
 assert.equal((await removeOrphanClaudeGenerations(h)).length,1);
 assert.deepEqual(await readdir(join(h,'credential-generations')),[]);
});
test('recovery keeps a directory holding only a value that this app did not name',async t=>{
 const h=await home(t),root=join(h,'credential-generations');await mkdir(root,{recursive:true,mode:0o700});
 const id=randomUUID();await mkdir(join(root,id),{mode:0o700});await writeFile(join(root,id,'value'),'gh',{mode:0o600});
 assert.deepEqual(await removeOrphanClaudeGenerations(h),[]);assert.deepEqual(await readdir(root),[id]);
});

test('recovery reads nothing through a symlinked generation directory',async t=>{
 const h=await home(t),outside=await home(t),root=join(h,'credential-generations');await mkdir(root,{recursive:true,mode:0o700});
 const id=randomUUID();await writeFile(join(outside,'claude-account.json'),'{}',{mode:0o600});await symlink(outside,join(root,id));
 const opened=[];
 patchFs(t,{open:real=>async(path,...rest)=>{opened.push(String(path));return real(path,...rest);},readFile:real=>async(path,...rest)=>{opened.push(String(path));return real(path,...rest);}});
 await removeOrphanClaudeGenerations(h);
 assert.deepEqual(opened.filter(path=>path.includes(join(root,id))),[]);
});
test('secret and marker files are opened without following symlinks and checked on the open descriptor',async t=>{
 const h=await home(t),id=randomUUID(),record=await publishClaudeAccount(h,id,{kind:'subscription-token',token:token()});
 const flags=[];
 const restore=patchFs(t,{open:real=>async(path,f,...rest)=>{if(String(path).endsWith('/value'))flags.push(f);return real(path,f,...rest);}});
 await readClaudeAccountValue(h,record);restore();
 const {constants}=await import('node:fs');
 assert.ok(flags.length>0&&flags.every(f=>typeof f==='number'&&(f&constants.O_NOFOLLOW)!==0));
 const value=join(h,'credential-generations',record.id,'value'),bytes=await readFile(value);
 await rm(value);await writeFile(join(h,'other'),bytes,{mode:0o600});await symlink(join(h,'other'),value);
 await assert.rejects(readClaudeAccountValue(h,record));
});

test('a check record valid except for a missing control result, or with a 200 control, is not checked',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[{record}]=f.accounts,rt=await runtime();
 const file=join(f.home,'credential-generations',record.id,'scoped-check.json');
 const base={...rt,digest:record.digest,ok:true,reason:null,status:200,generation:randomUUID()};
 await rm(file);await writeFile(file,JSON.stringify(base),{mode:0o600});
 assert.equal(await accounts.claudeAccountReady(f.home,record,rt),false);
 await rm(file);await writeFile(file,JSON.stringify({...base,controlStatus:200}),{mode:0o600});
 assert.equal(await accounts.claudeAccountReady(f.home,record,rt),false);
 await rm(file);await writeFile(file,JSON.stringify({...base,controlStatus:401}),{mode:0o600});
 assert.equal(await accounts.claudeAccountReady(f.home,record,rt),true);
});
