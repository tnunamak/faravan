import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path,{join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {parse} from 'acorn';
import {runInNewContext} from 'node:vm';
import {createSandboxScratch} from '../lib/sandbox-scratch.mjs';
import {runtimeDescriptor,sbxBinaryIdentity} from '../lib/sbx-runtime.mjs';
const installedSource=fs.readFileSync(new URL('./fixtures/compat/sandbox-scratch-42712735.txt',import.meta.url),'utf8');
const blob=createHash('sha1').update('blob '+Buffer.byteLength(installedSource)+'\0').update(installedSource).digest('hex');
assert.equal(blob,'8239119353f3f85949afe5202dcdc23bf9c1bfbb','the compatibility reader is the exact installed 42712735 blob');
const ast=parse(installedSource,{ecmaVersion:'latest',sourceType:'module'});
const code=ast.body.filter(node=>node.type!=='ImportDeclaration').map(node=>installedSource.slice(node.declaration?.start??node.start,node.end)).join('\n');
const installed=runInNewContext(code+'\n({deadScratchOwners,recoverSandboxScratch})',{...fsp,process,constants:fs.constants,join,resolve,dirname,basename,randomUUID,fs,path,sandboxOwnerScope:()=>'',acquireProcessLock:async()=>async()=>{}});
async function fixture(t){const root=await fsp.mkdtemp(join(tmpdir(),'scratch-compat-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return root;}
const nested=(root,label,count)=>join(root,label,...Array.from({length:count},(_,n)=>String(n)+'x'.repeat(179)));
for(const reader of ['dead-owner','recovery'])test(`long-path runtime receipt remains readable by the installed ${reader} reader`,async t=>{
 const base=await fixture(t),root=nested(base,'work',4),home=nested(base,'home',4),profileHome=nested(base,'profile',4),binary=join(nested(base,'bin',4),'sbx'),journal=join(base,'journal'),id='wf-0123456789abcdef',ownerScope=randomUUID();
 await fsp.mkdir(dirname(binary),{recursive:true});await fsp.writeFile(binary,'synthetic executable',{mode:0o700});
 const runtime=runtimeDescriptor({kind:'host-default',binary:sbxBinaryIdentity(binary),home,profileHome,ownerScope});
 const scratch=await createSandboxScratch(id,root,journal,{home,ownerScope,runtime});
 const file=join(journal,id+'.json'),record=JSON.parse(await fsp.readFile(file,'utf8'));record.ownerPid=1073741824;
 await fsp.writeFile(file,JSON.stringify(record));
 if(reader==='dead-owner')assert.equal((await installed.deadScratchOwners(journal,root)).includes(id),true,'the installed reader recognizes the new writer receipt');
 else {assert.equal(await installed.recoverSandboxScratch(id,root,journal),true,'the installed reader can remove the new writer workspace');assert.equal(fs.existsSync(scratch),false);}
 assert.ok(Buffer.byteLength(JSON.stringify(record))<=4096,'the writer preserves the installed v1 receipt limit');
});
test('an oversized base receipt refuses before creating a receipt or workspace',async t=>{
 const base=await fixture(t),root=nested(base,'work',8),home=nested(base,'home',8),journal=join(base,'journal'),id='wf-fedcba9876543210';
 await assert.rejects(createSandboxScratch(id,root,journal,{home}),error=>error?.code==='scratch_cleanup_pending');
 assert.equal(fs.existsSync(journal),false,'no receipt directory is published for an unreadable record');
 assert.equal(fs.existsSync(root),false,'no workspace root is created for an unreadable record');
});

for(const authority of ['present','missing'])test(`compact scratch runtime reference ${authority==='present'?'rebuilds from the cleanup journal':'fails closed without its journal authority'}`,async t=>{
 const {DockerSbxBackend,sbxChildEnv}=await import('../lib/docker-backend.mjs');
 const {hostDefaultSbxRuntime,describeSbxRuntime}=await import('../lib/sbx-runtime.mjs');
 const {deadScratchOwners}=await import('../lib/sandbox-scratch.mjs');
 const {sandboxOwnerScope}=await import('../lib/sandbox-name.mjs');
 const {seedSandboxOwner}=await import('./helpers/sandbox-owner.mjs');
 const base=await fixture(t),root=join(base,'work'),home=join(base,'sbx'),profileHome=join(base,'profile'),journal=join(home,'scratch-journal'),id='wf-1123456789abcdef';
 const saved={home:process.env.FARAVAN_SBX_HOME,root:process.env.FARAVAN_SCRATCH_ROOT};
 process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=root;seedSandboxOwner();
 t.after(()=>{if(saved.home===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=saved.home;if(saved.root===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=saved.root;});
 const calls=[],backend=new DockerSbxBackend({home:profileHome,runCommand:async(args,options)=>{options.beforeSpawn();calls.push({args,binary:options.binary});return {code:0,stdout:'[]'};}});
 const runtime=hostDefaultSbxRuntime({binary:process.execPath,env:sbxChildEnv(),currentEnv:sbxChildEnv,profileHome,ownerScope:sandboxOwnerScope()});
 const handle={job_id:'compact-runtime',sandbox_id:id,sbx_runtime:describeSbxRuntime(runtime)};
 const scratch=await createSandboxScratch(id,root,journal,{home,ownerScope:sandboxOwnerScope(),runtime:handle.sbx_runtime,beforeCreate:scratch=>{handle.scratch_dir=scratch;backend.cleanupJournal.register(handle);}});
 try {
  const receipt=join(journal,id+'.json'),record=JSON.parse(await fsp.readFile(receipt,'utf8'));
  assert.equal(record.sbx_runtime,undefined);assert.equal(record.runtime_id,handle.sbx_runtime.id);
  record.ownerPid=1073741824;await fsp.writeFile(receipt,JSON.stringify(record));
  const [row]=await deadScratchOwners(journal,root,{withGeneration:true});assert.equal(row.runtime_id,handle.sbx_runtime.id);
  if(authority==='missing')await fsp.unlink(join(profileHome,'v1','sandbox-cleanup',handle._cleanupId+'.json'));
  if(authority==='present'){await backend._rowRun(row,['ls','--json']);assert.equal(calls.length,1);assert.equal(calls[0].binary,process.execPath);}
  else {await assert.rejects(backend._rowRun(row,['ls','--json']),error=>error?.code==='claude_account_unavailable');assert.equal(calls.length,0);assert.equal(fs.existsSync(receipt),true);assert.equal(fs.existsSync(scratch),true);}
 }finally{backend.cleanupJournal.finish(handle,{});}
});
