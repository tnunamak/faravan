import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp,{mkdtemp,rm,chmod,readFile,writeFile,readdir,mkdir,stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {publishClaudeAccount,readClaudeAccount,removeClaudeAccount,removeOrphanClaudeGenerations} from '../lib/credential-generations.mjs';
import * as accounts from '../lib/claude-accounts.mjs';
import {accountBackend} from './helpers/claude-account-backend.mjs';

const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function home(t){const dir=await mkdtemp(join(tmpdir(),'faravan-fix-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const runtime=async()=>({version:'test-version',kitDigest:await accounts.claudeKitDigest()});
const failCheck=async(f,record)=>accounts.recordClaudeAccountCheck(f.home,record,{...await f.backend.claudeAccountRuntime(),status:200,controlStatus:200});
const goodCheck=async(f,record)=>accounts.recordClaudeAccountCheck(f.home,record,{...await f.backend.claudeAccountRuntime(),status:200,controlStatus:401});
const marker=(h,id)=>join(h,'credential-generations',id,'claude-account.json');

test('a check that fails while a preparation waits for the lock stops that preparation before it creates anything',async t=>{
 const {acquireCredentialPreparation}=await import('../lib/sandbox-credentials.mjs');
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const release=await acquireCredentialPreparation(f.home,{isolatedSources:true});
 const start=f.calls.length;
 const prepared=f.backend.prepare(f.job,{accountKey:account.key});prepared.catch(()=>{});
 await delay(300);
 await failCheck(f,account.record);
 await release();
 await assert.rejects(prepared,error=>error.code==='claude_account_unavailable');
 assert.equal(f.calls.slice(start).some(c=>c.args[0]==='create'||c.args[0]==='exec'||(c.args[0]==='secret'&&c.args[1]==='set')),false);
 assert.equal(f.secrets.length,0);
});

test('a check that fails while the scoped value is being set stops the job before its first exec',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 f.flags.onSet=()=>failCheck(f,account.record);
 const start=f.calls.length;
 await assert.rejects(f.backend.prepare(f.job,{accountKey:account.key}),error=>error.code==='claude_account_unavailable');
 assert.equal(f.execs(start).length,0);
 await f.backend.reapCleanup();
 assert.equal(f.secrets.length,0);
});

test('a prepared job does not start once its account check failed',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const handle=await f.backend.prepare(f.job,{accountKey:account.key});
 await failCheck(f,account.record);
 const start=f.calls.length;
 await assert.rejects(f.backend.start(handle,{}),error=>error.code==='claude_account_unavailable');
 assert.equal(f.execs(start).length,0);
 await f.backend.destroy(handle);
});

test('a check that starts makes the account not ready until it ends',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 assert.equal(await accounts.claudeAccountReady(f.home,account.record,await f.backend.claudeAccountRuntime()),true);
 await accounts.beginClaudeAccountCheck(f.home,account.record);
 assert.equal(await accounts.claudeAccountReady(f.home,account.record,await f.backend.claudeAccountRuntime()),false);
});

test('a check record without the negative control result is not ready',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const {version,kitDigest}=await runtime();
 await writeFile(join(f.home,'credential-generations',account.record.id,'scoped-check.json'),
  JSON.stringify({version,kitDigest,digest:account.record.digest,ok:true,reason:null}),{mode:0o600});
 assert.equal(await accounts.claudeAccountReady(f.home,account.record,{version,kitDigest}),false);
 await goodCheck(f,account.record);
 assert.equal(await accounts.claudeAccountReady(f.home,account.record,await f.backend.claudeAccountRuntime()),true);
});

test('admission answers unavailable at once after a failed check, a disable, a removal or an expired answer',async t=>{
 const f=await accountBackend(t,{tokens:[token(),token()]}),[one,two]=f.accounts;
 for(const a of f.accounts)f.registry.setEnabled(a.record.accountId,true);
 let clock=0;
 const gate=accounts.claudeAccountAdmission({accounts:()=>f.registry.list(),sbxHome:()=>f.home,runtime:()=>f.backend.claudeAccountRuntime(),now:()=>clock});
 await gate.refresh();
 assert.equal(gate.reason(one.key),null);assert.equal(gate.reason(two.key),null);
 await failCheck(f,one.record);
 assert.equal(gate.reason(one.key),'claude_account_unavailable','a failed check');
 f.registry.setEnabled(two.record.accountId,false);
 assert.equal(gate.reason(two.key),'claude_account_unavailable','a disable');
 await gate.refresh();
 f.registry.setEnabled(two.record.accountId,true);await goodCheck(f,one.record);await gate.refresh();
 assert.equal(gate.reason(one.key),null);assert.equal(gate.reason(two.key),null);
 await removeClaudeAccount(f.home,two.record.accountId);
 assert.equal(gate.reason(two.key),'claude_account_unavailable','a removal');
 clock+=60000;
 assert.equal(gate.reason(one.key),'claude_account_unavailable','the first call after the answer expired');
 assert.equal(gate.reason(one.key),'claude_account_unavailable','while the new answer is being read');
 await gate.refresh();
 assert.equal(gate.reason(one.key),null);
});

for(const [name,damage] of [
 ['unreadable',async path=>chmod(path,0o000)],
 ['bad mode',async path=>chmod(path,0o644)],
 ['bad JSON',async path=>writeFile(path,'{not json',{mode:0o600})],
]) test(`startup keeps every generation while an account pointer is ${name}`,async t=>{
 const h=await home(t),id=randomUUID(),other=randomUUID();
 const kept=await publishClaudeAccount(h,id,{kind:'subscription-token',token:token()});
 const spare=await publishClaudeAccount(h,other,{kind:'subscription-token',token:token()});
 await rm(join(h,'claude-account-'+other+'.json'));
 const pointer=join(h,'claude-account-'+id+'.json');
 await damage(pointer);
 const before=await readFile(join(h,'credential-generations',kept.id,'value'));
 await assert.rejects(removeOrphanClaudeGenerations(h),error=>error.code==='claude_pointer_uncertain');
 assert.deepEqual(await readFile(join(h,'credential-generations',kept.id,'value')),before);
 assert.ok((await stat(join(h,'credential-generations',spare.id))).isDirectory(),'nothing is deleted while a pointer is unknown');
 await chmod(pointer,0o600);
});

test('startup deletes only directories whose marker is a Claude account marker of that same directory',async t=>{
 const h=await home(t);
 const root=join(h,'credential-generations');await mkdir(root,{recursive:true,mode:0o700});
 const dirs={dirMarker:randomUUID(),badJson:randomUUID(),wrongId:randomUUID(),wide:randomUUID(),good:randomUUID()};
 const record=id=>JSON.stringify({version:1,id,accountId:randomUUID(),kind:'subscription-token',digest:'0'.repeat(64)});
 for(const id of Object.values(dirs))await mkdir(join(root,id),{mode:0o700});
 await mkdir(marker(h,dirs.dirMarker));
 await writeFile(marker(h,dirs.badJson),'{',{mode:0o600});
 await writeFile(marker(h,dirs.wrongId),record(randomUUID()),{mode:0o600});
 await writeFile(marker(h,dirs.wide),record(dirs.wide),{mode:0o644});
 await writeFile(marker(h,dirs.good),record(dirs.good),{mode:0o600});
 assert.deepEqual(await removeOrphanClaudeGenerations(h),[dirs.good]);
 assert.deepEqual((await readdir(root)).sort(),[dirs.dirMarker,dirs.badJson,dirs.wrongId,dirs.wide].sort());
});

test('removal refuses a pointer that names another kind of generation, another account, or a shared generation',async t=>{
 const h=await home(t);
 const root=join(h,'credential-generations');await mkdir(root,{recursive:true,mode:0o700});
 const github=randomUUID();await mkdir(join(root,github),{mode:0o700});
 await writeFile(join(root,github,'value'),'gh',{mode:0o600});
 const wrongKind=randomUUID(),pointerKind=join(h,'claude-account-'+wrongKind+'.json');
 await writeFile(pointerKind,JSON.stringify({version:1,id:github,accountId:wrongKind,kind:'github',digest:'0'.repeat(64)}),{mode:0o600});
 await assert.rejects(removeClaudeAccount(h,wrongKind));
 assert.ok((await stat(pointerKind)).isFile());assert.ok((await stat(join(root,github,'value'))).isFile());
 const wrongAccount=randomUUID(),pointerAccount=join(h,'claude-account-'+wrongAccount+'.json');
 await writeFile(pointerAccount,JSON.stringify({version:1,id:github,accountId:randomUUID(),kind:'subscription-token',digest:'0'.repeat(64)}),{mode:0o600});
 await assert.rejects(removeClaudeAccount(h,wrongAccount));
 assert.ok((await stat(pointerAccount)).isFile());assert.ok((await stat(join(root,github,'value'))).isFile());
 const a=randomUUID(),b=randomUUID(),published=await publishClaudeAccount(h,a,{kind:'subscription-token',token:token()});
 const copy=join(h,'claude-account-'+b+'.json');
 await writeFile(copy,JSON.stringify({...published,accountId:b}),{mode:0o600});
 await writeFile(marker(h,published.id),JSON.stringify(published),{mode:0o600});
 await assert.rejects(removeClaudeAccount(h,a));
 assert.ok((await stat(join(root,published.id,'value'))).isFile());assert.ok((await stat(join(h,'claude-account-'+a+'.json'))).isFile());
});

test('a crash between the two generation writes leaves an unfinished build the sweep deletes',async t=>{
 const h=await home(t),id=randomUUID();
 const realOpen=fsp.open,realRm=fsp.rm;
 fsp.open=async(path,...rest)=>{if(String(path).endsWith('/value'))throw Object.assign(new Error('crash'),{code:'EIO'});return realOpen(path,...rest);};
 fsp.rm=async()=>{};
 syncBuiltinESMExports();
 try{await assert.rejects(publishClaudeAccount(h,id,{kind:'subscription-token',token:token()}),/crash/);}
 finally{fsp.open=realOpen;fsp.rm=realRm;syncBuiltinESMExports();}
 const left=await readdir(join(h,'credential-generations'));
 assert.equal(left.length,1);
 assert.match(left[0],/^claude-pending-/);
 assert.ok((await stat(join(h,'credential-generations',left[0],'claude-account.json'))).isFile(),'the marker exists before the value');
 assert.deepEqual(await removeOrphanClaudeGenerations(h),[left[0].replace('claude-pending-','')]);
 assert.deepEqual(await readdir(join(h,'credential-generations')),[]);
});

test('add, check, remove, add the same label, remove works and the list shows only active accounts',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t,{tokens:[]});
 const run=async(argv,stdin)=>{let out='';const code=await runAccountsCommand(argv,{home:f.home,stdin,stdout:{write:text=>out+=text},backend:f.backend});return {code,out};};
 const first=JSON.parse((await run(['add','claude','--label','Work'],Readable.from([token()]))).out);
 assert.equal((await run(['check',first.key])).code,0);
 assert.equal((await run(['remove','claude','--label','Work'])).code,0);
 assert.deepEqual(JSON.parse((await run(['list'])).out),[]);
 const second=JSON.parse((await run(['add','claude','--label','Work'],Readable.from([token()]))).out);
 assert.notEqual(second.id,first.id);
 assert.equal((await run(['remove','claude','--label','Work'])).code,0);
 await assert.rejects(readClaudeAccount(f.home,second.id));
 assert.deepEqual(JSON.parse((await run(['list'])).out),[]);
 assert.equal(f.registry.get(first.id).enabled,false);
});

test('the account list reports a checked sign-in, never ready to lend',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t,{tokens:[token()]});
 let out='';
 await runAccountsCommand(['list'],{home:f.home,stdout:{write:text=>out+=text},backend:f.backend});
 const [row]=JSON.parse(out);
 assert.equal(row.signInChecked,true);
 assert.equal(Object.hasOwn(row,'ready'),false);
 assert.equal(row.lends,false);
});
