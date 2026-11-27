import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import {accountBackend} from './helpers/claude-account-backend.mjs';
import * as runtime from '../lib/sbx-runtime.mjs';
import * as commandDiagnostics from '../lib/sandbox-command-diagnostic.mjs';
import {sandboxCommandDiagnostic} from '../lib/sandbox-command-observation.mjs';
import {DOCKER_SIGNED_OUT,DOCKER_SIGNIN_STATE_UNAVAILABLE} from '../lib/v1/docker-state.mjs';
import {sbxChildEnv} from '../lib/docker-backend.mjs';
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
function declarations(names){const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});return names.map(name=>{const node=ast.body.map(n=>n.declaration??n).find(n=>n.id?.name===name||n.declarations?.some(declaration=>declaration.id.name===name));return node?source.slice(node.start,node.end).replaceAll('import.meta.url',JSON.stringify(new URL('../lib/docker-backend.mjs',import.meta.url).href)):'';}).join('\n');}
const token=()=>'sk-ant-oat01-'+randomBytes(32).toString('hex');
const refused=e=>e.code==='claude_account_unavailable';

for(const mutation of ['account','binary'])test(`real recovery daemon gate refuses ${mutation} drift before status or stdin`,async t=>{
 const fixture=await accountBackend(t,{tokens:[token()]}),[account]=fixture.accounts;
 const handle=await fixture.backend.prepare(fixture.job,{accountKey:account.key});
 const replacement=join(fixture.home,'unqualified-sbx');await writeFile(replacement,'unqualified executable',{mode:0o700});
 let release;const paused=new Promise(resolve=>release=resolve),launches=[],inputs=[];
 const binding=handle._sbxRuntime??runtime.createSbxRuntime({path:handle._claudeBinary,fence:handle._fenceClaude});
 const jobContext=new AsyncLocalStorage();let entered;
 const reached=new Promise(resolve=>entered=resolve);
 const code=declarations(['HOST_PREFLIGHT_COMMANDS','runSbx','dispatchSbx','launchRuntime','spawnSbxChild','runPreflightCommand','ensureSbxDaemon','ensureSbxDaemonLocked']);
 const funcs=runInNewContext(code+'\n({runSbx})',{
  ...runtime,...commandDiagnostics,sandboxCommandDiagnostic,performance,DOCKER_SIGNED_OUT,DOCKER_SIGNIN_STATE_UNAVAILABLE,execFile(command,args){launches.push({command,args});const p=Promise.resolve({stdout:'running',stderr:''});p.child={stdin:{on(){},end(value){inputs.push(value);}},once(_event,resolve){queueMicrotask(resolve);}};return p;},
  execFileCb(){throw new Error('Unexpected callback');},spawn(){throw new Error('Unexpected stream');},spawnSync(){throw new Error('Unexpected sync');},process,
  sbxBin:()=>process.env.FARAVAN_SBX_BIN,sbxChildEnv,needsSbxDaemon:()=>true,
  withDaemonLifecycle:async action=>{entered();await paused;return action();},daemonGateOff:()=>true,
  observationDaemonContext:new AsyncLocalStorage(),daemonJobContext:jobContext,sbxBinaryIdentity:()=>'/fixture',daemonLifecycleGeneration:1,
  PREFLIGHT_COMMAND_TIMEOUT_MS:15000,PREFLIGHT_CANCEL_GRACE_MS:2000,sbxDaemonRunning:r=>r?.code===0,
  refuseUnverifiedDaemon(){throw Object.assign(new Error('Unknown daemon'),{code:'claude_account_unavailable'});},daemonFailure:()=>({}),
  recordDaemonLaunch(){},policyError:(code,message)=>Object.assign(new Error(message),{code}),SbxDaemonVerificationError:class extends Error{},
  setTimeout,clearTimeout,AbortSignal,queueMicrotask,
 });
 const running=jobContext.run({recovery:true},()=>funcs.runSbx(['secret','set'],{sbxRuntime:binding,binary:binding.path,beforeSpawn:()=>runtime.assertSbxRuntime(binding),input:Buffer.from('synthetic input')}));
 await reached;
 if(mutation==='account')fixture.registry.setEnabled(account.record.accountId,false);else process.env.FARAVAN_SBX_BIN=replacement;
 release();await assert.rejects(running,refused);
 assert.deepEqual(launches,[],'daemon status is a fenced subprocess too');assert.deepEqual(inputs,[]);
});

// The HOME-only inventory read runs on the host default runtime and acts on no record.
const acting=calls=>calls.filter(c=>c.args[0]!=='ls'&&c.args.join(' ')!=='ls --json').map(c=>c.args);
for(const mode of ['reap','restart'])test(`${mode} reconstructs persisted runtime and retains unknown or changed bindings`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const binary=join(f.home,'qualified-sbx');await writeFile(binary,'qualified executable',{mode:0o700});process.env.FARAVAN_SBX_BIN=binary;await f.ready(a.record);
 const handle=await f.backend.prepare(f.job,{accountKey:a.key});
 const directory=join(f.home,'v1','sandbox-cleanup'),file=join(directory,handle._cleanupId+'.json');
 const row=JSON.parse(await readFile(file,'utf8'));
 assert.equal(JSON.stringify(row).includes(a.token),false);
 f.registry.setEnabled(a.record.accountId,false);
 await writeFile(binary,'replacement executable');
 const start=f.calls.length;
 assert.equal((await f.backend.destroy(handle)).removed,false);
 const backend=mode==='restart'?f.make():f.backend;
 await backend.reapCleanup();assert.deepEqual(acting(f.calls.slice(start)),[],'no recovery subprocess runs after identity drift');assert.equal(fs.existsSync(file),true);
 assert.equal(row.sbx_runtime?.binary.path,binary);assert.equal(row.sbx_runtime?.accountFenceKey.accountId,a.record.accountId);
 const missing={...row};delete missing.sbx_runtime;
 await assert.rejects(async()=>backend._rowRun(missing,['ls','--json']),refused);
 await writeFile(file,JSON.stringify(missing));await backend.reapCleanup();
 assert.equal(fs.existsSync(file),true);assert.deepEqual(acting(f.calls.slice(start)),[],'a row with no reconstructable runtime remains pending');
 // Restore exact identity by using the original executable fixture anew and publishing its matching descriptor.
 const fresh=await accountBackend(t,{tokens:[token()]}),[next]=fresh.accounts;
 const live=await fresh.backend.prepare(fresh.job,{accountKey:next.key});
 const saved=JSON.parse(await readFile(join(fresh.home,'v1','sandbox-cleanup',live._cleanupId+'.json'),'utf8'));
 fresh.registry.setEnabled(next.record.accountId,false);
 fresh.backend.cleanupJournal.finish(live,{});
 const recovered=fresh.make();const launch=fresh.calls.length;
 await recovered.reapCleanup();assert.ok(fresh.calls.length>launch);
 assert.equal(fs.existsSync(join(fresh.home,'v1','sandbox-cleanup',saved._cleanupId+'.json')),false);
 assert.equal(fresh.secrets.length,0,'cleanup ignores account revocation while retaining runtime identity');
});

for(const helper of ['check','provider-free','git'])test(`${helper} preparation inherits the parent runtime without provider credentials`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[a]=f.accounts;
 const parent=await f.backend.prepare(f.job,{accountKey:a.key});
 let child;
 if(helper==='git'){
  const prepare=f.backend.prepare.bind(f.backend);f.backend.prepare=async(...args)=>{child=await prepare(...args);return child;};
  await f.backend.cloneGitSource(parent,{url:'https://github.com/example/project'});
 }else if(helper==='provider-free')child=await f.backend.prepare({...f.job,job_id:f.job.job_id+'-helper'},parent._deadline,{providerAccess:false,githubKit:false,sbxRuntime:parent._sbxRuntime});
 else child=await f.backend.prepareCheck(parent);
 assert.equal(child.scoped_claude_secret,undefined,'inherited runtime grants no account value');
 f.registry.setEnabled(a.record.accountId,false);const start=f.calls.length;
 // The git helper's sandbox is already reserved for cleanup when it returns, which refuses before the account check; both refuse with no subprocess.
 await assert.rejects(f.backend._runJobCommand(child,['exec',child.sandbox_id,'--','true']),e=>refused(e)||(helper==='git'&&/reserved for cleanup/.test(e.message)));
 assert.equal(f.calls.length,start);
 assert.equal(child._sbxRuntime?.path??child._claudeBinary,parent._claudeBinary,'the helper uses the admitted executable');
 assert.equal(child._sbxRuntime,parent._sbxRuntime,'runtime provenance survives derived sandbox creation');
 assert.equal(child.sbx_runtime.binary.path,parent.sbx_runtime.binary.path);
 await f.backend.destroy(child);await f.backend.destroy(parent);
});

for(const helper of ['sbx-exec-launch','credential-writer-launch'])for(const mutation of ['none','account','binary','kit','revoked-cleanup'])
test(`${helper} revalidates ${mutation} at its exec handoff`,async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const binary=join(f.home,'qualified-sbx');await writeFile(binary,'qualified executable',{mode:0o700});process.env.FARAVAN_SBX_BIN=binary;await f.ready(account.record);
 const handle=await f.backend.prepare(f.job,{accountKey:account.key});
 const descriptor=runtime.describeSbxRuntime(mutation==='revoked-cleanup'?runtime.cleanupSbxRuntime(handle._sbxRuntime):handle._sbxRuntime);
 const childEnv={...sbxChildEnv()},launches=[],read=fs.readFileSync,callbacks=new Map();
 if(mutation==='account'||mutation==='revoked-cleanup')f.registry.setEnabled(account.record.accountId,false);
 if(mutation==='binary')await writeFile(binary,'replacement executable');
 if(mutation==='kit'){fs.readFileSync=(file,...args)=>String(file).endsWith('/kits/wf-claude-account/spec.yaml')?Buffer.from('changed kit'):read(file,...args);t.after(()=>{fs.readFileSync=read;});}
 const childProcess={env:childEnv,execve(){},on:(name,callback)=>callbacks.set(name,callback),exit(){throw Object.assign(new Error('Helper exited'),{code:'helper_exit'});},
  argv:helper==='sbx-exec-launch'?['node','helper',Buffer.from(JSON.stringify(descriptor)).toString('base64url'),'daemon','start']:['node','helper',binary,'login']};
 const source=read(new URL('../lib/'+helper+'.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 const {spawnSbxChild}=await import('../lib/docker-backend.mjs');
 const run=()=>{
  runInNewContext(source,{process:childProcess,Buffer,restoreSbxRuntime:runtime.restoreSbxRuntime,nonSbxCommand:runtime.nonSbxCommand,
   spawnSbxChild:(binding,args,options)=>spawnSbxChild(binding,args,options,{execve:(path)=>{launches.push(path);throw Object.assign(new Error('Exec reached'),{code:'fixture_exec'});}})});
  callbacks.get('message')?.({start:true,runtime:descriptor});
 };
 if(mutation==='none'||mutation==='revoked-cleanup'){
  assert.throws(run,e=>e.code==='fixture_exec');assert.deepEqual(launches,[binary]);
 }else {assert.throws(run,refused);assert.deepEqual(launches,[]);}
 fs.readFileSync=read;await f.backend.destroy(handle);
});

test('handle entrypoints reject a missing runtime instead of selecting host defaults',async t=>{
 const f=await accountBackend(t),parent=await f.backend.prepare(f.job),handle={...parent};delete handle.sbx_runtime;
 const before=f.calls.length;
 await assert.rejects(f.backend._runJobCommand(handle,['exec',handle.sandbox_id,'--','true']),refused);
 await assert.rejects(f.backend.prepareCheck(handle),refused);
 await assert.rejects(f.backend.cloneGitSource(handle,{url:'https://github.com/example/project'}),refused);
 await assert.rejects(f.backend.inspect(handle),refused);
 await assert.rejects(async()=>f.backend._diskRunSbx(['template','ls','--json'],{},handle),refused);
 assert.equal(f.calls.length,before);await f.backend.destroy(parent);
});

test('provider-free selection requires its admitted runtime before any subprocess',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts,start=f.calls.length;
 await assert.rejects(f.backend.prepare(f.job,{providerAccess:false,accountKey:account.key}),refused);
 assert.equal(f.calls.length,start);
});

test('reserved rows without a reconstructable runtime retain every cleanup obligation',async t=>{
 const f=await accountBackend(t),handle=await f.backend.prepare(f.job);
 f.backend.cleanupJournal.finish(handle,{});
 const file=join(f.home,'v1','sandbox-cleanup',handle._cleanupId+'.json');
 const row=JSON.parse(await readFile(file,'utf8'));delete row.sbx_runtime;row.create='reserved';row.compute_created=false;row.create_settled=false;
 await writeFile(file,JSON.stringify(row));const start=f.calls.length;
 await f.make().reapCleanup();
 // The HOME-only inventory read runs on the host default runtime; nothing may act on the reserved record.
 assert.deepEqual(f.calls.slice(start).filter(c=>c.args[0]!=='ls').map(c=>c.args),[]);assert.equal(fs.existsSync(file),true);assert.equal(fs.existsSync(handle.scratch_dir),true);
});

test('a captured executable alias cannot bypass the runtime after configuration changes',async t=>{
 const f=await accountBackend(t,{tokens:[token()]}),[account]=f.accounts;
 const binary=join(f.home,'qualified-binary'),alias=join(f.home,'selected-cli'),replacement=join(f.home,'replacement-cli');
 await writeFile(binary,'qualified executable',{mode:0o700});await writeFile(replacement,'replacement',{mode:0o700});await fs.promises.symlink(binary,alias);
 process.env.FARAVAN_SBX_BIN=alias;await f.ready(account.record);
 const handle=await f.backend.prepare(f.job,{accountKey:account.key});
 const binding=handle._sbxRuntime??runtime.createSbxRuntime({path:handle._claudeBinary,fence:handle._fenceClaude});
 process.env.FARAVAN_SBX_BIN=replacement;f.registry.setEnabled(account.record.accountId,false);
 const launches=[];
 const code=declarations(['HOST_PREFLIGHT_COMMANDS','spawnSbxChild','runPreflightCommand']);
 const {run}=runInNewContext(code+'\n({run:runPreflightCommand})',{
  ...runtime,process,Buffer,execFileCb(){},spawn(){},spawnSync(){},
  sbxBin:()=>process.env.FARAVAN_SBX_BIN,sbxChildEnv,
  execFile(command){launches.push(command);const p=Promise.resolve({stdout:'',stderr:''});p.child={stdin:{end(){}},once(_event,resolve){queueMicrotask(resolve);}};return p;},
  PREFLIGHT_COMMAND_TIMEOUT_MS:15000,PREFLIGHT_CANCEL_GRACE_MS:2000,setTimeout,clearTimeout,
 });
 const result=await runtime.withSbxRuntime(binding,()=>run(alias,['version'],{skipDaemonGate:true}));
 assert.deepEqual(launches,[]);assert.equal(result.errorCode,'claude_account_unavailable');
});

test('untagged service delegation is refused before the launcher executes',async()=>{
 const launches=[];
 const code=declarations(['HOST_PREFLIGHT_COMMANDS','spawnSbxChild','runPreflightCommand']);
 const {run}=runInNewContext(code+'\n({run:runPreflightCommand})',{
  ...runtime,process,Buffer,execFileCb(){},spawn(){},spawnSync(){},sbxBin:()=>'/configured/sbx',sbxChildEnv:()=>({}),
  policyError:(code,message)=>Object.assign(new Error(message),{code}),
  execFile(command){launches.push(command);const p=Promise.resolve({stdout:'',stderr:''});p.child={stdin:{end(){}},once(_event,resolve){queueMicrotask(resolve);}};return p;},
  PREFLIGHT_COMMAND_TIMEOUT_MS:15000,PREFLIGHT_CANCEL_GRACE_MS:2000,setTimeout,clearTimeout,
 });
 const result=await run('systemd-run',['--','/qualified/sbx','daemon','start'],{skipDaemonGate:true});
 assert.deepEqual(launches,[]);assert.equal(result.errorCode,'claude_account_unavailable');
});
