import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {publishClaudeAccount,readClaudeAccount,readClaudeAccountValue} from '../lib/credential-generations.mjs';
import {assignClaudeAccount,verifyClaudeAccountRemoved,claudeAccountReady,recordClaudeAccountCheck} from '../lib/claude-accounts.mjs';
import {accountBackend as sharedAccountBackend} from './helpers/claude-account-backend.mjs';
const accountBackend=(t,options)=>sharedAccountBackend(t,{tokens:[fake],...options});
const fake='sk-ant-oat01-'+ 'f'.repeat(64);
async function fixture(t){const home=await mkdtemp(join(tmpdir(),'faravan-account-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
test('private account generation exposes metadata separately from its value',async t=>{
 const home=await fixture(t),id=randomUUID();
 const account=await publishClaudeAccount(home,id,{kind:'subscription-token',token:fake});
 assert.equal(JSON.stringify(account).includes(fake),false);
 assert.equal(await readClaudeAccountValue(home,await readClaudeAccount(home,id)),fake);
 await chmod(join(home,'credential-generations',account.id,'value'),0o644);
 await assert.rejects(readClaudeAccountValue(home,account));
});
test('shape validation rejects tokens without retaining the supplied value',async t=>{
 const home=await fixture(t);await assert.rejects(publishClaudeAccount(home,randomUUID(),{kind:'subscription-token',token:'bad'}),e=>!e.message.includes('bad'));
});
test('scoped assignment uses stdin, verifies listing, and never falls back',async t=>{
 const home=await fixture(t),account=await publishClaudeAccount(home,randomUUID(),{kind:'subscription-token',token:fake});
 const calls=[],name='wf-0123456789abcdef';let rows=[];
 const run=async(args,options)=>{calls.push({args,options});if(args[1]==='set')rows=[{name:'faravan-claude',scope:name,type:'service'}];return {code:0,stdout:JSON.stringify({secrets:rows,custom_secrets:[],shadowed_services:[],env_only_count:0})};};
 await assignClaudeAccount(run,home,account,name);
 assert.equal(calls[0].options.input,fake);assert.equal(JSON.stringify(calls.map(c=>c.args)).includes(fake),false);
 assert.equal(await verifyClaudeAccountRemoved(run,name,'faravan-claude'),false);rows=[];assert.equal(await verifyClaudeAccountRemoved(run,name,'faravan-claude'),true);
 await assert.rejects(assignClaudeAccount(async()=>({code:1}),home,account,name));
});
test('readiness requires a successful scoped check and invalidates on runtime drift',async t=>{
 const home=await fixture(t),account=await publishClaudeAccount(home,randomUUID(),{kind:'api-key',token:'sk-ant-api03-'+ 'e'.repeat(64)});
 assert.equal(await claudeAccountReady(home,account,{version:'one',kitDigest:'kit'}),false);
 await recordClaudeAccountCheck(home,account,{version:'one',kitDigest:'kit',status:401});
 assert.equal(await claudeAccountReady(home,account,{version:'one',kitDigest:'kit'}),false);
 await recordClaudeAccountCheck(home,account,{version:'one',kitDigest:'kit',status:200,controlStatus:401});
 assert.equal(await claudeAccountReady(home,account,{version:'one',kitDigest:'kit'}),true);
 assert.equal(await claudeAccountReady(home,account,{version:'two',kitDigest:'kit'}),false);
 assert.equal(await claudeAccountReady(home,account,{version:'one',kitDigest:'new'}),false);
});

test('production prepare isolates concurrent accounts and journals before create and set',async t=>{
 const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
 const {createAccountRegistry}=await import('../lib/v1/lending-accounts.mjs');
 const {createSbxPolicy,sbxRunner}=await import('./helpers/sbx-policy-model.mjs');
 const {seedSandboxOwner}=await import('./helpers/sandbox-owner.mjs');
 const {readFile,readdir}=await import('node:fs/promises');
 const home=await fixture(t),oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT,oldBin=process.env.FARAVAN_SBX_BIN;
 process.env.FARAVAN_SBX_BIN=process.execPath;
 process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;seedSandboxOwner();
 t.after(()=>{if(oldBin===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=oldBin;if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
 const registry=createAccountRegistry({file:join(home,'v1','lending-accounts.json')}),accounts=[];
 for(const token of [fake,fake.replaceAll('f','e')]){
   const a=registry.setEnabled(registry.add({provider:'claude',label:'Example'}).id,true),record=await publishClaudeAccount(home,a.id,{kind:'subscription-token',token});
   accounts.push({key:'claude:'+a.id,token,record});
 }
 const calls=[],secrets=[],policy=createSbxPolicy({globalRules:[]});let failSet=false,listingBroken=false,bindingMissing=false;
 const runner=sbxRunner(policy,async(args,options)=>{
   calls.push({args,input:options?.input});
   if(args[0]==='create'&&bindingMissing)return {code:0,stdout:'',stderr:'no binding authorizes faravan-claude'};
   if(args[0]==='secret'&&args[1]==='ls'&&listingBroken)return {code:1,stdout:''};
   if(args[0]==='secret'&&args[1]==='ls')return {code:0,stdout:JSON.stringify({secrets:secrets.map(({token,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0})};
   if(args[0]==='version')return {code:0,stdout:'test-version'};
   if(args[0]==='secret'&&args[1]==='set'){
     const name=args[args.indexOf('--sandbox')+1];
     const journal=await readdir(join(home,'v1','sandbox-cleanup'));
     assert.ok((await Promise.all(journal.filter(f=>f.endsWith('.json')).map(f=>readFile(join(home,'v1','sandbox-cleanup',f),'utf8')))).some(s=>s.includes(name)&&s.includes('scoped_claude_secret')));
     assert.ok(calls.some(c=>c.args[0]==='create'&&c.args.includes(name)));
     if(failSet)return {code:1,stdout:'',stderr:''};
     secrets.push({name:args[2],scope:name,type:'service',token:options.input});
   }
   if(args[0]==='rm'){const name=args.at(-1);for(let n=secrets.length-1;n>=0;n--)if(secrets[n].scope===name)secrets.splice(n,1);}
   return {code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''};
 },{kitAllow:[],secretResult:{code:0,get stdout(){return JSON.stringify({secrets:secrets.map(({token,...row})=>row),custom_secrets:[],shadowed_services:[],env_only_count:0});}}});
 const backend=new DockerSbxBackend({home,runCommand:(args,options)=>{options?.beforeSpawn?.();return runner.run(args,options);}});
 const job={job_id:'test-account',image:'claude',entrypoint:'true',execution_scope:'borrowed',auth_strategy:'docker-native-oauth',
 resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:16384,network_bytes:1048576,max_processes:32},inputs:[],output_manifest:[],egress:'provider-only',provider_hosts:['api.anthropic.com'],required_limits:['cpu','memory','wall','output']};
 for(const {record} of accounts)await recordClaudeAccountCheck(home,record,{...await backend.claudeAccountRuntime(),status:200,controlStatus:401});
 const handles=await Promise.all(accounts.map(a=>backend.prepare(job,{accountKey:a.key})));
 assert.notEqual(handles[0].sandbox_id,handles[1].sandbox_id);
 for(let i=0;i<2;i++)assert.equal(secrets.find(s=>s.scope===handles[i].sandbox_id).token,accounts[i].token);
 for(const handle of handles){const exec=calls.find(c=>c.args[0]==='exec'&&c.args.includes(handle.sandbox_id));assert.ok(exec.args.includes('CLAUDE_CODE_OAUTH_TOKEN=proxy-managed'));}
 assert.equal(JSON.stringify(calls.map(c=>c.args)).includes(fake),false);
 await Promise.all(handles.map(h=>backend.destroy(h)));
 assert.equal(secrets.length,0);
 const before=calls.length;failSet=true;await assert.rejects(backend.prepare(job,{accountKey:accounts[0].key}));
 assert.equal(calls.slice(before).some(c=>c.args[0]==='exec'),false);
 await assert.rejects(backend.prepare({...job,accountKey:accounts[0].key}));
 const defaultStart=calls.length;const handle=await backend.prepare(job);
 assert.equal(calls.slice(defaultStart).some(c=>c.args[0]==='secret'&&c.args[1]==='set'),false);
 assert.equal(calls.slice(defaultStart).some(c=>c.args.includes('--kit')),false);
 await backend.destroy(handle);
 await assert.rejects(backend.prepare(job,{accountKey:'claude:'+randomUUID()}),error=>error.cleanup_receipt?.removed===true);
 failSet=false;bindingMissing=true;const missingStart=calls.length;
 await assert.rejects(backend.prepare(job,{accountKey:accounts[0].key}),/binding is unavailable/);
 assert.equal(calls.slice(missingStart).some(c=>c.args[0]==='exec'),false);bindingMissing=false;
 const dirty=await backend.prepare(job,{accountKey:accounts[0].key});listingBroken=true;
 const removal=await backend.destroy(dirty);assert.equal(removal.removed,true);assert.equal(removal.policy_removed,false);
 assert.ok(backend.cleanupStatus().policy_cleanup_pending>0);listingBroken=false;await backend.reapCleanup();
 assert.equal(backend.cleanupStatus().state,'clear');
 const unreadableStart=calls.length;listingBroken=true;
 await assert.rejects(backend.prepare(job,{accountKey:accounts[0].key}));
 assert.equal(calls.slice(unreadableStart).some(c=>c.args[0]==='exec'),false);listingBroken=false;
 // The failed create left its cleanup pending; the next job only starts after that clears.
 await backend.reapCleanup();assert.equal(backend.cleanupStatus().state,'clear');
 const api=registry.setEnabled(registry.add({provider:'claude',label:'API'}).id,true),apiRecord=await publishClaudeAccount(home,api.id,{kind:'api-key',token:'sk-ant-api03-'+'c'.repeat(64)});
 await recordClaudeAccountCheck(home,apiRecord,{...await backend.claudeAccountRuntime(),status:200,controlStatus:401});
 const apiStart=calls.length,apiHandle=await backend.prepare(job,{accountKey:'claude:'+api.id});
 assert.ok(calls.slice(apiStart).some(c=>c.args[0]==='secret'&&c.args[1]==='set'&&c.args[2]==='anthropic'));
 assert.equal(calls.slice(apiStart).some(c=>c.args.includes('--kit')),false);
 assert.ok(apiHandle._credentialEnv.includes('ANTHROPIC_API_KEY=proxy-managed'));await backend.destroy(apiHandle);
 const {ensureClaudeBinding}=await import('../lib/claude-accounts.mjs');
 const bindingBefore=await readFile(join(home,'.config','sbx','credentials.yaml'),'utf8');await ensureClaudeBinding(home);
 assert.equal(await readFile(join(home,'.config','sbx','credentials.yaml'),'utf8'),bindingBefore);
 assert.deepEqual(Object.keys((await import('yaml')).parse(bindingBefore).bindings),['faravan-claude']);

});

test('CLI adds and lists a labelled account without publishing token bytes',async t=>{
 const {Readable}=await import('node:stream');
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const home=await fixture(t),old=process.env.FARAVAN_SBX_HOME,oldBin=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN=process.execPath;process.env.FARAVAN_SBX_HOME=home;
 t.after(()=>{if(oldBin===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=oldBin;if(old===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=old;});
 let output='';const stdout={write:text=>output+=text};
 await runAccountsCommand(['add','claude','--label','Work'],{home,stdin:Readable.from([fake]),stdout});
 const account=JSON.parse(output);assert.equal(account.kind,'subscription-token');assert.equal(account.signInChecked,false);assert.equal(output.includes(fake),false);
 output='';await runAccountsCommand(['list'],{home,stdout});assert.equal(JSON.parse(output)[0].label,'Work');assert.equal(output.includes(fake),false);
});

// A production backend over a fake sbx that models sandbox-scoped secrets: `sbx rm` deletes a sandbox's scoped values
// unless `rmKeepsSecret` says this sbx left one behind.
test('a malformed token adds no account and stores nothing',async t=>{
 const {Readable}=await import('node:stream');
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const {createAccountRegistry}=await import('../lib/v1/lending-accounts.mjs');
 const {readdir}=await import('node:fs/promises');
 const home=await fixture(t),old=process.env.FARAVAN_SBX_HOME;process.env.FARAVAN_SBX_HOME=home;
 t.after(()=>{if(old===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=old;});
 const bad='sk-ant-oat01-short!'+randomUUID();
 await assert.rejects(runAccountsCommand(['add','claude','--label','Work'],{home,stdin:Readable.from([bad]),stdout:{write(){}}}),
   error=>error.code==='claude_token_invalid'&&!error.message.includes(bad));
 assert.deepEqual(createAccountRegistry({file:join(home,'v1','lending-accounts.json')}).list(),[]);
 assert.equal((await readdir(home)).includes('credential-generations'),false);
});

test('the account list shows readiness from the scoped check and drops it on runtime drift',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t);
 let output='';const stdout={write:text=>output+=text};
 const list=async()=>{output='';await runAccountsCommand(['list'],{home:f.home,stdout,backend:f.backend});return JSON.parse(output);};
 const row=(await list()).find(r=>r.key===f.accounts[0].key);
 assert.equal(row.kind,'subscription-token');assert.equal(row.label,'Example');assert.equal(row.signInChecked,true);
 f.flags.version='newer-version';
 assert.equal((await list()).find(r=>r.key===f.accounts[0].key).signInChecked,false);
 await assert.rejects(f.backend.prepare(f.job,{accountKey:f.accounts[0].key}),error=>error.code==='claude_account_unavailable'&&error.cleanup_receipt?.removed===true);
});

test('the scoped self-check records readiness only for a 200 from the models list',async t=>{
 const {claudeAccountReady,claudeKitDigest}=await import('../lib/claude-accounts.mjs');
 const f=await accountBackend(t);const record=f.accounts[0].record;
 f.flags.curl='401';const start=f.calls.length;
 assert.equal((await f.backend.checkClaudeAccount(f.accounts[0].key)).ok,false);
 const curl=f.calls.slice(start).find(c=>c.args.includes('curl'));
 assert.ok(curl.args.includes('https://api.anthropic.com/v1/models'));
 assert.ok(f.calls.slice(start).some(c=>c.args[0]==='secret'&&c.args[1]==='set'&&c.args[2]==='faravan-claude'));
 assert.equal(await claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),false);
 f.flags.curl='200';
 assert.equal((await f.backend.checkClaudeAccount(f.accounts[0].key)).ok,true);
 assert.equal(await claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),true);
 assert.equal(f.secrets.length,0);assert.equal(f.backend.cleanupStatus().state,'clear');
});

test('teardown removes a scoped value that outlived its sandbox and keeps a retry while that is unknown',async t=>{
 const f=await accountBackend(t);
 f.flags.rmKeepsSecret=true;
 const handle=await f.backend.prepare(f.job,{accountKey:f.accounts[0].key});
 const start=f.calls.length,removal=await f.backend.destroy(handle);
 assert.ok(f.calls.slice(start).some(c=>c.args.join(' ')===`secret rm faravan-claude --sandbox ${handle.sandbox_id} --force`));
 assert.equal(removal.policy_removed,true);assert.equal(f.secrets.length,0);
 // Never a global removal.
 assert.equal(f.calls.some(c=>c.args[0]==='secret'&&c.args[1]==='rm'&&!c.args.includes('--sandbox')),false);
});

const cleanupRows=async home=>{
 const {readFile,readdir}=await import('node:fs/promises'),dir=join(home,'v1','sandbox-cleanup');
 return Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await readFile(join(dir,n),'utf8'))));
};
test('a failed create sets no value, runs nothing and keeps its scoped cleanup obligation',async t=>{
 const f=await accountBackend(t);
 // This sbx reports a failed create although the sandbox appeared: removal then needs the owner's remediation.
 f.flags.createFails=true;const start=f.calls.length;
 await assert.rejects(f.backend.prepare(f.job,{accountKey:f.accounts[0].key}));
 assert.equal(f.execs(start).length,0);
 assert.equal(f.calls.slice(start).some(c=>c.args[1]==='set'),false);
 // The sandbox was removed and its absence proved, and no value was ever set, so no scoped obligation remains.
 assert.deepEqual(await cleanupRows(f.home),[]);
 assert.equal(f.calls.slice(start).some(c=>c.args[0]==='secret'&&c.args[1]==='ls'),true,'the scoped value listing is still checked');
 assert.equal(f.backend.cleanupStatus().policy_cleanup_pending,0);
});

test('a failed create whose scoped value listing is unreadable keeps its scoped cleanup obligation',async t=>{
 const f=await accountBackend(t);
 f.flags.createFails=true;f.flags.listingBroken=true;
 await assert.rejects(f.backend.prepare(f.job,{accountKey:f.accounts[0].key}));
 assert.ok((await cleanupRows(f.home)).some(row=>row.scoped_claude_secret==='faravan-claude'));
});

test('the cleanup obligation survives a cancellation and a crash',async t=>{
 const f=await accountBackend(t),key=f.accounts[0].key;let start;
 // Cancellation while the value is written: no guest command runs and the value goes with the sandbox.
 const controller=new AbortController();f.flags.onSet=()=>controller.abort();start=f.calls.length;
 await assert.rejects(f.backend.prepare(f.job,{accountKey:key,signal:controller.signal}));
 f.flags.onSet=null;
 assert.equal(f.execs(start).length,0);assert.equal(f.secrets.length,0);
 if(f.backend.cleanupStatus().state!=='clear')await f.backend.reapCleanup();
 assert.equal(f.backend.cleanupStatus().state,'clear',JSON.stringify(f.backend.cleanupStatus()));
 // Crash after the value was set: only the durable record remains, and recovery keeps the obligation until absence is proven.
 const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');const {_internal}=await import('../lib/docker-backend.mjs');
 const {writeCreateReceipt}=await import('./helpers/sandbox-receipt-fixture.mjs');const {readFile,writeFile}=await import('node:fs/promises');
 const directory=join(f.home,'v1','sandbox-cleanup'),jobId='crashed-account-job',name='wf-'+'4d'.repeat(8);
 const id=await writeCreateReceipt(directory,{jobId,name,ownerScope:sandboxOwnerScope(),home:_internal.sbxHome(),scratchRoot:_internal.scratchRoot()});
 const file=join(directory,id+'.json');
 await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),scoped_claude_secret:'faravan-claude'}));
 f.policy.createSandbox(name,{kitAllow:[],denyNetwork:[]});f.secrets.push({name:'faravan-claude',scope:name,type:'service',token:f.accounts[0].token});
 const pending={owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(),attemptId:'attempt-1',jobId,attempt:{attempt_id:'attempt-1'}};
 const restarted=f.make();f.flags.listingBroken=true;f.flags.rmKeepsSecret=true;
 const blind=await restarted.reconcilePending(pending);
 assert.equal(blind.removed===true&&blind.policy_removed===true,false,'an unreadable listing never proves the value gone');
 assert.ok((await cleanupRows(f.home)).some(row=>row.sandbox_id===name&&row.scoped_claude_secret==='faravan-claude'));
 f.flags.listingBroken=false;
 const retried=blind.removed===true?(await restarted.reapCleanup(),{removed:true}):await restarted.reconcilePending(pending);
 assert.equal(retried.removed,true);
 assert.equal(restarted.cleanupStatus().state,'clear',JSON.stringify(restarted.cleanupStatus()));
 assert.deepEqual(f.secrets.filter(s=>s.scope===name),[]);
});

test('account fields in job content never select an account',async t=>{
 const f=await accountBackend(t),key=f.accounts[0].key;
 // A job spec that names an account is refused before any sandbox command.
 for(const field of [{accountKey:key},{account_key:key},{account:{id:f.accounts[0].record.accountId,key}}]){
   const start=f.calls.length;
   await assert.rejects(f.backend.prepare({...f.job,...field}),error=>error.code==='policy_unenforceable');
   assert.equal(f.calls.slice(start).some(c=>['create','run','secret','exec'].includes(c.args[0])),false);
 }
 // runJob forwards only its own accountKey parameter, never a field of the job spec.
 const {runJob}=await import('../lib/executor.mjs');const seen=[];
 const backend={admitJob:async()=>({ok:true,enforced_limits:[],unenforced:[]}),probeCapabilities:async()=>({available:true}),
   prepare:async(spec,options)=>{seen.push(options);throw Object.assign(new Error('stop'),{code:'stop',cleanup_receipt:{removed:true}});}};
 await assert.rejects(runJob({jobSpec:{...f.job,accountKey:key},frameJob:{harnessId:'claude-code-subscription',prompt:'x',args:[],accountKey:key},backend}));
 assert.equal(seen[0]?.accountKey,undefined);
 await assert.rejects(runJob({jobSpec:f.job,frameJob:{harnessId:'claude-code-subscription',prompt:'x',args:[]},accountKey:key,backend}));
 assert.equal(seen[1]?.accountKey,key);
 // The bare default key prepares exactly as before; any other key that names no added account never prepares.
 await assert.rejects(runJob({jobSpec:f.job,frameJob:{harnessId:'claude-code-subscription',prompt:'x',args:[]},accountKey:'claude',backend}));
 // The default account carries the cancel signal and remaining wall time like any account, and never an account key.
 assert.equal(seen.length,3);assert.equal(seen[2]?.accountKey,undefined);assert.ok(seen[2]&&'signal' in seen[2]&&'wallRemainingMs' in seen[2]);
 for(const bad of ['claude:','claude:not-an-id','Claude','',{id:'x'},42]){
   await assert.rejects(runJob({jobSpec:f.job,frameJob:{harnessId:'claude-code-subscription',prompt:'x',args:[]},accountKey:bad,backend}),
     error=>error.code==='claude_account_unavailable',String(bad));
 }
 assert.equal(seen.length,3,'no malformed key reached prepare');
});

test('the binding is created once and touches only its own service',async t=>{
 const {ensureClaudeBinding}=await import('../lib/claude-accounts.mjs');
 const {writeFile,readFile,mkdir}=await import('node:fs/promises');const YAML=(await import('yaml')).default;
 const home=await fixture(t),file=join(home,'.config','sbx','credentials.yaml');
 await mkdir(join(home,'.config','sbx'),{recursive:true,mode:0o700});
 const other={bindings:{'faravan-github':{apiKey:{domains:['api.github.com','github.com']}},'someone-else':{apiKey:{domains:['example.com']}}},extra:{keep:true}};
 await writeFile(file,YAML.stringify(other),{mode:0o600});
 await ensureClaudeBinding(home);const once=await readFile(file,'utf8');
 await ensureClaudeBinding(home);assert.equal(await readFile(file,'utf8'),once);
 const parsed=YAML.parse(once);
 assert.deepEqual(parsed.bindings['faravan-github'],other.bindings['faravan-github']);
 assert.deepEqual(parsed.bindings['someone-else'],other.bindings['someone-else']);
 assert.deepEqual(parsed.extra,other.extra);
 assert.deepEqual(parsed.bindings['faravan-claude'],{apiKey:{domains:['api.anthropic.com']}});
 // A different binding under our name is not ours to change.
 parsed.bindings['faravan-claude']={apiKey:{domains:['evil.example']}};await writeFile(file,YAML.stringify(parsed),{mode:0o600});
 await assert.rejects(ensureClaudeBinding(home));
});

test('the token never reaches argv, logs, status, journals or errors',async t=>{
 const {Readable}=await import('node:stream');
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const {readFile,readdir,lstat}=await import('node:fs/promises');
 const unique='sk-ant-oat01-'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const f=await accountBackend(t,{tokens:[]});
 let output='';const stdout={write:text=>output+=text};
 await runAccountsCommand(['add','claude','--label','Leak'],{home:f.home,stdin:Readable.from([unique+'\n']),stdout,backend:f.backend});
 const key=JSON.parse(output).key;
 await runAccountsCommand(['check',key],{home:f.home,stdout,backend:f.backend});
 await runAccountsCommand(['list'],{home:f.home,stdout,backend:f.backend});
 const errors=[];
 const handle=await f.backend.prepare(f.job,{accountKey:key});
 const logs=[];await f.backend.run?.(handle,{onLog:line=>logs.push(String(line))}).catch(e=>errors.push(e));
 await f.backend.destroy(handle);
 f.flags.failSet=true;await f.backend.prepare(f.job,{accountKey:key}).catch(e=>errors.push(e));f.flags.failSet=false;
 f.flags.listingBroken=true;await f.backend.prepare(f.job,{accountKey:key}).catch(e=>errors.push(e));f.flags.listingBroken=false;
 const surfaces=[output,JSON.stringify(f.calls.map(c=>c.args)),JSON.stringify(f.backend.cleanupStatus()),JSON.stringify(handle),logs.join('\n'),
   ...errors.map(e=>JSON.stringify({message:e.message,code:e.code,stack:e.stack,...e}))];
 for(const text of surfaces)assert.equal(text.includes(unique),false);
 // Every stdin write is the only place the value travels.
 assert.ok(f.calls.some(c=>c.input===unique));
 const files=[];
 async function walk(dir){for(const name of await readdir(dir)){const p=join(dir,name),s=await lstat(p);if(s.isDirectory())await walk(p);else if(s.isFile())files.push(p);}}
 await walk(f.home);
 const holders=[];for(const p of files)if((await readFile(p)).includes(unique))holders.push(p);
 assert.equal(holders.length,1);assert.match(holders[0],/credential-generations\/[0-9a-f-]+\/value$/);
});

test('the self-check refuses an account whose route answers a control value',async t=>{
 const {claudeAccountReady,claudeKitDigest}=await import('../lib/claude-accounts.mjs');
 const {readFile}=await import('node:fs/promises');
 const f=await accountBackend(t);const record=f.accounts[0].record,runtime={version:'test-version',kitDigest:await claudeKitDigest()};
 const sets=start=>f.calls.slice(start).filter(c=>c.args[0]==='secret'&&c.args[1]==='set');
 // The default sign-in answers: the control value also gets 200.
 f.flags.controlCurl='200';let start=f.calls.length;
 const answered=await f.backend.checkClaudeAccount(f.accounts[0].key);
 assert.deepEqual({ok:answered.ok,reason:answered.reason,status:answered.status,controlStatus:answered.controlStatus},
   {ok:false,reason:'default_sign_in_answered',status:200,controlStatus:200});
 const used=sets(start);
 assert.equal(used.length,2,'one sandbox for the account, one for the control');
 assert.notEqual(used[0].args[4],used[1].args[4],'the control runs in its own sandbox');
 assert.equal(used[0].input,f.accounts[0].token);
 assert.match(used[1].input,/^sk-ant-oat01-[A-Za-z0-9_-]{32,}$/,'the control value is well formed');
 assert.notEqual(used[1].input,f.accounts[0].token);
 assert.equal(await claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),false);
 const saved=JSON.parse(await readFile(join(f.home,'credential-generations',record.id,'scoped-check.json'),'utf8'));
 assert.deepEqual({version:saved.version,kitDigest:saved.kitDigest,ok:saved.ok,reason:saved.reason},{...runtime,ok:false,reason:'default_sign_in_answered'});
 // The scoped value wins: account 200, control 401.
 f.flags.controlCurl='401';start=f.calls.length;
 assert.equal((await f.backend.checkClaudeAccount(f.accounts[0].key)).ok,true);
 assert.equal(sets(start).length,2);
 assert.equal(await claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),true);
 // An inconclusive control is not ready either.
 f.flags.controlCurl='000';
 assert.equal((await f.backend.checkClaudeAccount(f.accounts[0].key)).reason,'control_inconclusive');
 assert.equal(await claudeAccountReady(f.home,record,await f.backend.claudeAccountRuntime()),false);
 // A refused account value needs no control sandbox.
 f.flags.curl='401';start=f.calls.length;
 assert.equal((await f.backend.checkClaudeAccount(f.accounts[0].key)).reason,'account_refused');
 assert.equal(sets(start).length,1);
 assert.equal(f.secrets.length,0);assert.equal(f.backend.cleanupStatus().state,'clear');
});

test('the CLI names the default sign-in when it answers instead of the account',async t=>{
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const f=await accountBackend(t);f.flags.controlCurl='200';
 let output='';
 assert.equal(await runAccountsCommand(['check',f.accounts[0].key],{home:f.home,stdout:{write:text=>output+=text},backend:f.backend}),1);
 assert.match(output,/The default sign-in answered instead of this account\./);
});

test('the API-key control value has the API-key shape',async()=>{
 const {claudeControlValue}=await import('../lib/claude-accounts.mjs');
 const {claudeTokenKind}=await import('../lib/credential-generations.mjs');
 assert.equal(claudeTokenKind(claudeControlValue('api-key')),'api-key');
 assert.equal(claudeTokenKind(claudeControlValue('subscription-token')),'subscription-token');
});

test('a failed publication leaves no value behind',async t=>{
 const {readdir,mkdir}=await import('node:fs/promises');
 const home=await fixture(t),token='sk-ant-oat01-'+randomUUID().replaceAll('-','').repeat(2);
 await mkdir(join(home,'credential-generations'),{mode:0o700});
 // The pointer cannot be written: the home is read-only after the generation directory exists.
 await chmod(home,0o500);
 try{await assert.rejects(publishClaudeAccount(home,randomUUID(),{kind:'subscription-token',token}));}
 finally{await chmod(home,0o700);}
 assert.deepEqual(await readdir(join(home,'credential-generations')),[]);
 assert.deepEqual((await readdir(home)).filter(name=>name!=='credential-generations'),[]);
});

test('removing an account by label disables it and deletes its value',async t=>{
 const {Readable}=await import('node:stream');
 const {runAccountsCommand}=await import('../lib/v1/accounts-cli.mjs');
 const {readdir}=await import('node:fs/promises');
 const f=await accountBackend(t,{tokens:[]});
 const add=async(label,value)=>{let out='';await runAccountsCommand(['add','claude','--label',label],{home:f.home,stdin:Readable.from([value]),stdout:{write:text=>out+=text},backend:f.backend});return JSON.parse(out);};
 const keep=await add('Keep','sk-ant-oat01-'+'k'.repeat(64)),gone=await add('Gone','sk-ant-oat01-'+'g'.repeat(64));
 f.registry.setEnabled(gone.id,true);
 const goneRecord=await readClaudeAccount(f.home,gone.id),keepRecord=await readClaudeAccount(f.home,keep.id);
 let out='';
 assert.equal(await runAccountsCommand(['remove','claude','--label','Gone'],{home:f.home,stdout:{write:text=>out+=text},backend:f.backend}),0);
 assert.equal(JSON.parse(out).removed,true);
 assert.equal(f.registry.get(gone.id).enabled,false);
 assert.deepEqual(await readdir(join(f.home,'credential-generations')),[keepRecord.id]);
 assert.equal((await readdir(f.home)).includes('claude-account-'+gone.id+'.json'),false);
 await assert.rejects(readClaudeAccount(f.home,gone.id),error=>error.code==='claude_account_unavailable');
 assert.equal(goneRecord.id!==keepRecord.id,true);
 await assert.rejects(f.backend.prepare(f.job,{accountKey:gone.key}),error=>error.code==='claude_account_unavailable');
 await assert.rejects(runAccountsCommand(['remove','claude','--label','Nobody'],{home:f.home,stdout:{write(){}},backend:f.backend}),error=>error.code==='not_found');
});

test('the startup sweep creates nothing in a fresh sandbox home and never waits for a busy lock',async t=>{
 const {readdir}=await import('node:fs/promises');
 const {acquireCredentialPreparation}=await import('../lib/sandbox-credentials.mjs');
 const f=await accountBackend(t);
 const fresh=await fixture(t),previous=process.env.FARAVAN_SBX_HOME;
 process.env.FARAVAN_SBX_HOME=fresh;
 try{
  assert.deepEqual(await f.backend.removeOrphanClaudeAccounts(),[]);
  assert.deepEqual(await readdir(fresh),[]);
 }finally{if(previous===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=previous;}
 const release=await acquireCredentialPreparation(f.home);
 try{
  const started=Date.now();
  await assert.rejects(f.backend.removeOrphanClaudeAccounts(),error=>error.condition==='preparation_lock_unavailable');
  assert.ok(Date.now()-started<5000,'the sweep returned at once');
 }finally{await release();}
});

test('startup deletes only Claude account values that no account names',async t=>{
 const {mkdir,writeFile,readdir,rm:remove,symlink,lstat}=await import('node:fs/promises');
 const f=await accountBackend(t,{tokens:['sk-ant-oat01-'+'r'.repeat(64),'sk-ant-oat01-'+'o'.repeat(64)]});
 const [kept,orphan]=f.accounts;
 // A crash after the value but before the pointer: the generation exists and nothing names it.
 await remove(join(f.home,'claude-account-'+orphan.record.accountId+'.json'));
 await writeFile(join(f.home,orphan.record.id+'.publication'),'{}',{mode:0o600});
 // A GitHub generation has no account record and is never touched.
 const github=randomUUID();await mkdir(join(f.home,'credential-generations',github),{mode:0o700});
 await writeFile(join(f.home,'credential-generations',github,'value'),'gh',{mode:0o600});
 // A symlink that looks like an orphan is not followed.
 const outside=await fixture(t),linked=randomUUID();
 await writeFile(join(outside,'claude-account.json'),'{}',{mode:0o600});
 await symlink(outside,join(f.home,'credential-generations',linked));
 assert.deepEqual(await f.backend.removeOrphanClaudeAccounts(),[orphan.record.id]);
 assert.deepEqual((await readdir(join(f.home,'credential-generations'))).sort(),[kept.record.id,github,linked].sort());
 assert.equal((await readdir(f.home)).includes(orphan.record.id+'.publication'),false);
 assert.ok((await lstat(join(outside,'claude-account.json'))).isFile());
 assert.equal((await readClaudeAccount(f.home,kept.record.accountId)).id,kept.record.id);
});

test('the app sweeps orphaned account values when it starts its backend',{timeout:60000},async t=>{
 const {appFixture,syntheticBackend,waitFor}=await import('./helpers/v1-app-fixture.mjs');
 const f=await appFixture(t);let swept=0;
 const backend=Object.assign(syntheticBackend(f.root),{removeOrphanClaudeAccounts:async()=>{swept++;return [];}});
 await f.start('sweep',{backend});
 await waitFor(()=>swept===1,'the startup sweep ran');
});
