import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,stat,readFile,chmod,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {gitSourceSnapshotScript} from '../lib/git-source-snapshot.mjs';

async function fixture(t,files) {
 const root=await mkdtemp(join(tmpdir(),'pinned-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
 git('init','-q');
 for(const [path,data] of Object.entries(files)){await mkdir(join(repo,path,'..'),{recursive:true});await writeFile(join(repo,path),data);}
 git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 return {root,repo,run:()=>execFileSync('sh',['-c',gitSourceSnapshotScript({node:process.execPath,sha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex')})],{cwd:root,stdio:'pipe'})};
}
test('pinned Git snapshot removes recoverable history and shared credential rules before agent access',async t=>{
 const f=await fixture(t,{'.env':'dummy-only','.env.example':'EXAMPLE=x','packages/app/id_ecdsa':'dummy-only','packages/app/check.sh':'echo ok','src/main.js':'source'});
 await chmod(join(f.repo,'packages/app/check.sh'),0o755);
 execFileSync('git',['-C',f.repo,'update-index','--chmod=+x','packages/app/check.sh']);
 execFileSync('git',['-C',f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','mode']);
 assert.match(f.run().toString(),/FARAVAN_GIT_SOURCE_OK/);
 for(const name of ['.git','.env','packages/app/id_ecdsa'])await assert.rejects(stat(join(f.repo,name)),{code:'ENOENT'});
 assert.equal(await readFile(join(f.repo,'.env.example'),'utf8'),'EXAMPLE=x');
 assert.equal((await stat(join(f.repo,'packages/app/check.sh'))).mode&0o111,0o111);
});
test('pinned Git snapshot refuses nested metadata before exposing a source tree',async t=>{
 const f=await fixture(t,{'packages/app/HEAD':'ref: refs/heads/main','packages/app/config':'dummy'});
 assert.throws(f.run);
 assert.ok(await stat(join(f.repo,'.git')),'original clone stays intact until validation succeeds; executor destroys the sandbox on failure');
});


// These cases exercise the actual status helper in a bounded child, never a remote.
// Deliberately do not set GIT_NO_LAZY_FETCH: the helper's explicit option is the fence.
const statusModule=new URL('../lib/git-source-status.mjs',import.meta.url).href;
const statusEnv=root=>({PATH:process.env.PATH,HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'});
const bounded={encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:1024*1024};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function statusFixture() {
 const root=await mkdtemp(join(tmpdir(),'status-no-fetch-'));
 try {
  const repo=join(root,'repo');await mkdir(repo);
  const env=statusEnv(root);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{...bounded,env});
  git('init','-q','--template=');
  await mkdir(join(repo,'.git','info'),{recursive:true});
  await writeFile(join(repo,'tracked.txt'),'original\n');
  await writeFile(join(repo,'deleted.txt'),'delete me\n');
  git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');
  return {root,repo,env,git};
 } catch(error) {await rm(root,{recursive:true,force:true});throw error;}
}
async function readChanged(f,{scope=[],env=f.env}={}) {
 const code='import {changedFiles} from '+JSON.stringify(statusModule)+';'+
  'try { console.log(JSON.stringify({files:await changedFiles('+JSON.stringify(f.repo)+','+JSON.stringify({scope})+')})); }'+
  'catch(error) { console.log(JSON.stringify({refused:true,code:error.code,detail:String(error.stderr??error.message)})); }';
 return JSON.parse((await ownedNode(f,code,{env})).trim());
}
test('changedFiles refuses a missing promisor tree without invoking transport',async()=>{
 const f=await statusFixture();
 try {
  // Resolve/remove only this fixture's loose HEAD tree, before arming the helper.
  const tree=f.git('rev-parse','HEAD^{tree}').trim();
  assert.match(tree,/^[0-9a-f]{40,64}$/);
  await rm(join(f.repo,'.git','objects',tree.slice(0,2),tree.slice(2)));
  const marker=join(f.root,'transport-ran');
  const helper=join(f.root,'ssh-marker');
  await writeFile(helper,'#!/bin/sh\nprintf ran > '+quote(marker)+'\nexit 1\n',{mode:0o700});
  f.git('config','core.repositoryFormatVersion','1');
  f.git('config','extensions.partialClone','origin');
  f.git('config','remote.origin.url','ssh://fixture.invalid/no-network');
  f.git('config','remote.origin.promisor','true');
  f.git('config','core.sshCommand',quote(helper));
  // A failed command alone is not proof of an armed transport boundary.
  // The unfenced real Git control must execute this fixture's local marker.
  const realGit=await realGitPath();
  await ownedNode(f,'import assert from "node:assert/strict";import {execFileSync} from "node:child_process";'+
   'let failure;try{execFileSync('+JSON.stringify(realGit)+',["-C",'+JSON.stringify(f.repo)+',"status","--porcelain=v1","-z"],'+
   JSON.stringify({...bounded,env:{...f.env,GIT_OPTIONAL_LOCKS:'0'}})+');}catch(error){failure=error;}'+
   'assert.ok(Number.isInteger(failure?.status)&&failure.status!==0,"real unfenced Git must fail normally");');
  assert.equal(await readFile(marker,'utf8'),'ran','transport positive control must actually fire');
  await rm(marker);
  const result=await readChanged(f);
  assert.equal(result.refused,true,'missing content must refuse, never fabricate empty status');
  await assert.rejects(stat(marker),{code:'ENOENT'},'the protected read never calls the harmless transport helper');
 } finally {await disposeFixture(f);}
});
test('changedFiles keeps exact complete-repository changes and path scoping',async()=>{
 const f=await statusFixture();
 try {
  await writeFile(join(f.repo,'tracked.txt'),'changed\n');
  await rm(join(f.repo,'deleted.txt'));
  await writeFile(join(f.repo,'new.txt'),'new\n');
  assert.deepEqual(await readChanged(f),{files:[
   {code:'D',path:'deleted.txt'},{code:'M',path:'tracked.txt'},{code:'?',path:'new.txt'},
  ]});
  assert.deepEqual(await readChanged(f,{scope:['tracked.txt']}),{files:[{code:'M',path:'tracked.txt'}]});
 } finally {await disposeFixture(f);}
});
test('unsupported no-lazy-fetch refuses on the first invocation without downgrade',async()=>{
 const f=await statusFixture();
 try {
  const bin=join(f.root,'bin');await mkdir(bin);
  const calls=join(f.root,'git-calls'),downgrade=join(f.root,'downgrade');
  // Owned shim models option rejection only, not qualification of an old Git.
  await writeFile(join(bin,'git'),'#!/bin/sh\nprintf "%s\\n" "$1" >> '+quote(calls)+
   '\nif [ "$1" = "--no-lazy-fetch" ]; then\n printf "unknown option: --no-lazy-fetch\\n" >&2\n exit 129\nfi\nprintf ran > '+quote(downgrade)+'\nexit 0\n',{mode:0o700});
  const result=await readChanged(f,{env:{...f.env,PATH:bin}});
  assert.equal(result.refused,true);
  assert.equal(result.code,129);
  assert.match(result.detail,/unknown option: --no-lazy-fetch/);
  assert.equal(await readFile(calls,'utf8'),'--no-lazy-fetch\n','no second invocation or fallback');
  await assert.rejects(stat(downgrade),{code:'ENOENT'});
 } finally {await disposeFixture(f);}
});

async function realGitPath() {
 for(const directory of (process.env.PATH??'').split(':')) {
  const candidate=join(directory,'git');
  try {if((await stat(candidate)).isFile())return candidate;} catch(error){if(error.code!=='ENOENT')throw error;}
 }
 throw new Error('Git executable not found on fixture PATH');
}
test('isolated status defeats deterministic post-enumeration config mutation',async()=>{
 for(const viaInclude of [false,true]) {
  const f=await statusFixture();
  try {
   const realGit=await realGitPath();
   const bin=join(f.root,'bin');await mkdir(bin);
   const temp=join(f.root,'temp');await mkdir(temp);
   const marker=join(f.root,'driver-ran'),mutated=join(f.root,'mutated');
   const driver=join(f.root,'driver.cjs'),mutator=join(f.root,'mutator.cjs');
   const include=join(f.root,'included.config');
   await writeFile(include,'');
   f.git('config','include.path',include);
   await writeFile(join(f.repo,'.gitattributes'),'tracked.txt filter=late\n');
   f.git('add','.gitattributes');
   f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','attributes');
   const originalConfig=await readFile(join(f.repo,'.git','config'),'utf8');
   const originalIndex=await readFile(join(f.repo,'.git','index'));
   const originalHead=await readFile(join(f.repo,'.git','HEAD'));
   await writeFile(driver,'const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(marker)+',"ran\\n");process.stdout.write(fs.readFileSync(0));');
   const command=quote(process.execPath)+' '+quote(driver);
   const filter='\n[filter "late"]\n clean = '+JSON.stringify(command)+'\n required = true\n';
   const target=viaInclude?include:join(f.repo,'.git','config');
   await writeFile(mutator,'const fs=require("node:fs");fs.writeFileSync('+JSON.stringify(target)+','+
    JSON.stringify((viaInclude?'':originalConfig)+filter)+');fs.writeFileSync('+JSON.stringify(mutated)+',"yes");');
   await writeFile(join(bin,'git'),'#!/bin/sh\nfor arg do\n if [ "$arg" = "status" ]; then\n '+
    quote(process.execPath)+' '+quote(mutator)+' || exit 91\n fi\ndone\nexec '+quote(realGit)+' "$@"\n',{mode:0o700});
   await writeFile(join(f.repo,'tracked.txt'),'changed!\n'); // same size, changed contents: conversion is needed
   await utimes(join(f.repo,'tracked.txt'),new Date('2030-01-01T00:00:00Z'),new Date('2030-01-01T00:00:00Z'));
   const env={...f.env,PATH:bin+':'+process.env.PATH,TMPDIR:temp,GIT_OPTIONAL_LOCKS:'0'};
   // Old algorithm: enumerate before the shim changes executable authority.
   const code='import {gitFilterOverrides} from '+JSON.stringify(statusModule)+';'+
    'import {execFileSync} from "node:child_process";'+
    'const disabled=await gitFilterOverrides('+JSON.stringify(f.repo)+');'+
    'execFileSync("git",["--no-lazy-fetch","-C",'+JSON.stringify(f.repo)+',...disabled,"status","--porcelain=v1","-z"],'+
    JSON.stringify({...bounded,env})+');';
   await ownedNode(f,code,{env});
   assert.equal(await readFile(mutated,'utf8'),'yes','the race boundary actually ran');
   assert.match(await readFile(marker,'utf8'),/ran/,'vulnerable reference must execute the harmless driver');
   await rm(marker);await rm(mutated);
   await writeFile(join(f.repo,'.git','config'),originalConfig);await writeFile(include,'');
   const protectedResult=await readChanged(f,{env});
   assert.equal(await readFile(mutated,'utf8'),'yes','protected status crosses the same mutation boundary');
   assert.deepEqual(protectedResult,{files:[{code:'M',path:'tracked.txt'}]});
   assert.deepEqual(await readChanged(f,{env:{...env,GIT_DIR:join(f.root,'nonexistent'),
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'filter.late.clean',GIT_CONFIG_VALUE_0:command}}),protectedResult,
    'inherited Git path and executable config cannot enter the isolated reader');
   await assert.rejects(stat(marker),{code:'ENOENT'});
   assert.deepEqual(await readFile(join(f.repo,'.git','index')),originalIndex);
   assert.deepEqual(await readFile(join(f.repo,'.git','HEAD')),originalHead);
   // Only the deliberately armed shim wrote config; the reader never repairs or rewrites it.
   assert.equal(await readFile(target,'utf8'),(viaInclude?'':originalConfig)+filter);
   assert.deepEqual(await (await import('node:fs/promises')).readdir(temp),[]);
  } finally {await disposeFixture(f);}
 }
});
test('isolated reader preserves staged rename, linked worktree and unborn status',async()=>{
 const f=await statusFixture();
 try {
  f.git('mv','deleted.txt','renamed.txt');
  await writeFile(join(f.repo,'tracked.txt'),'changed!\n');
  await writeFile(join(f.repo,'untracked.txt'),'new');
  assert.deepEqual(await readChanged(f),{files:[
   {code:'R',path:'renamed.txt'},{code:'M',path:'tracked.txt'},{code:'?',path:'untracked.txt'},
  ]});
  const linked=join(f.root,'linked');f.git('worktree','add','--detach',linked,'HEAD');
  await writeFile(join(linked,'tracked.txt'),'changed!\n');
  assert.deepEqual(await readChanged({...f,repo:linked}),{files:[{code:'M',path:'tracked.txt'}]});
  const unborn=join(f.root,'unborn');await mkdir(unborn);
  execFileSync('git',['-C',unborn,'init','-q','--template='],{...bounded,env:f.env});
  await writeFile(join(unborn,'new.txt'),'new');
  assert.deepEqual(await readChanged({...f,repo:unborn}),{files:[{code:'?',path:'new.txt'}]});
 } finally {await disposeFixture(f);}
});
test('isolated reader closes escaped capabilities and disposes on callback and process failure',async()=>{
 const f=await statusFixture();
 try {
  const temp=join(f.root,'private-temp');await mkdir(temp);
  const code='import assert from "node:assert/strict";import {withIsolatedGitRead} from '+JSON.stringify(statusModule)+';'+
   'let saved;await assert.rejects(withIsolatedGitRead('+JSON.stringify(f.repo)+',async r=>{saved=r;await r.status();throw new Error("owned failure");}),/owned failure/);'+
   'await assert.rejects(saved.status(),/closed/);'+
   'for(const name of ["packaging","archive","committedTree"])await assert.rejects(saved[name](),/closed/);'+
   'await assert.rejects(saved.blobBuffer("0".repeat(40)),/closed/);'+
   'await assert.rejects(withIsolatedGitRead('+JSON.stringify(f.repo)+',r=>r.blob("0".repeat(40))));';
  await ownedNode(f,code,{env:{...f.env,TMPDIR:temp}});
  assert.deepEqual(await (await import('node:fs/promises')).readdir(temp),[]);
 } finally {await disposeFixture(f);}
});
test('isolated reader explicitly refuses a non-SHA1 repository',async()=>{
 const f=await statusFixture();
 try {
  const other=join(f.root,'sha256');await mkdir(other);
  execFileSync('git',['-C',other,'init','-q','--template=','--object-format=sha256'],{...bounded,env:f.env});
  const result=await readChanged({...f,repo:other});
  assert.equal(result.refused,true);
  assert.equal(result.code,'invalid_request');
  assert.match(result.detail,/Unsupported Git object format/);
 } finally {await disposeFixture(f);}
});

// Each Node driver owns a private process group. Do not remove fixture files
// until both its wrapper and that group have observably closed.
const uncertainRoots=new Set();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function groupAlive(pid) {
 try {process.kill(-pid,0);return true;} catch(error){if(error.code==='ESRCH')return false;throw error;}
}
async function disposeFixture(f) {
 if(uncertainRoots.has(f.root))throw new Error('Owned child closure unknown; retaining fixture '+f.root);
 await rm(f.root,{recursive:true,force:true});
}
async function ownedNode(f,code,{env=f.env,deadline=10000}={}) {
 if(process.platform==='win32')throw new Error('Owned process-group test requires POSIX');
 const child=spawn(process.execPath,['--input-type=module','-e',
  'process.on("SIGTERM",()=>{process.exitCode=143});'+code],{env,detached:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',failure=null,closed=false;
 uncertainRoots.add(f.root);
 const signal=kind=>{if(child.pid&&groupAlive(child.pid))process.kill(-child.pid,kind);};
 const closure=new Promise(resolve=>{
  child.once('error',error=>{failure=error;});
  child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});
 });
 for(const [stream,append] of [[child.stdout,s=>stdout+=s],[child.stderr,s=>stderr+=s]]) {
  stream.setEncoding('utf8');
  stream.on('data',data=>{
   append(data);
   if(stdout.length+stderr.length>1024*1024&&!failure){
    failure=new Error('Owned wrapper output budget exceeded');signal('SIGTERM');
   }
  });
 }
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;signal('SIGTERM');},deadline);
 let outcome;
 const timers=[];
 const until=ms=>new Promise(resolve=>timers.push(setTimeout(()=>resolve(null),ms)));
 try {
  outcome=await Promise.race([closure,until(deadline+1000)]);
  if(!closed) {signal('SIGKILL');outcome=await Promise.race([closure,until(1000)]);}
  // A wrapper may close while a child has detached its stdio. Its process
  // group is still ours, so terminate that group and observe absence too.
  if(child.pid&&groupAlive(child.pid))signal('SIGTERM');
  for(let i=0;i<100&&child.pid&&groupAlive(child.pid);i++)await delay(10);
  if(!closed||(child.pid&&groupAlive(child.pid))) {
   signal('SIGKILL');
   for(let i=0;i<100&&child.pid&&groupAlive(child.pid);i++)await delay(10);
  }
  if(!closed||(child.pid&&groupAlive(child.pid)))throw new Error('Owned descendant closure unknown');
  uncertainRoots.delete(f.root);
  if(timedOut)throw Object.assign(new Error('Owned wrapper deadline'),{code:'OWNED_TIMEOUT'});
  if(failure)throw failure;
  if(outcome?.code!==0)throw new Error('Owned wrapper failed: '+stderr);
  return stdout;
 } finally {clearTimeout(timer);for(const timer of timers)clearTimeout(timer);}
}
async function packageRead(f,body,{repo=f.repo,env=f.env}={}) {
 return ownedNode(f,'import assert from "node:assert/strict";import {withIsolatedGitRead,MAX_GIT_ARCHIVE_BYTES} from '+
  JSON.stringify(statusModule)+';import {execFileSync} from "node:child_process";'+
  'await withIsolatedGitRead('+JSON.stringify(repo)+',async read=>{'+body+'});',{env});
}
test('owned Node deadline waits for actual held Git shim closure before cleanup',async()=>{
 const f=await statusFixture();
 try {
  const bin=join(f.root,'held-bin');await mkdir(bin);
  const started=join(f.root,'started'),stopped=join(f.root,'stopped');
  await writeFile(join(bin,'git'),'#!'+process.execPath+'\n'+
   'const fs=require("node:fs");fs.writeFileSync('+JSON.stringify(started)+',String(process.pid));'+
   'process.on("SIGTERM",()=>{fs.writeFileSync('+JSON.stringify(stopped)+',"closed");process.exit(0)});setInterval(()=>{},1000);',{mode:0o700});
  await assert.rejects(ownedNode(f,'import {changedFiles} from '+JSON.stringify(statusModule)+
   ';await changedFiles('+JSON.stringify(f.repo)+');',{env:{...f.env,PATH:bin},deadline:500}),{code:'OWNED_TIMEOUT'});
  const pid=Number(await readFile(started,'utf8'));
  assert.ok(Number.isSafeInteger(pid)&&pid>0);
  assert.equal(await readFile(stopped,'utf8'),'closed');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'known owned shim is gone before root removal');
  assert.equal((await ownedNode(f,'console.log("normal")')).trim(),'normal');
 } finally {await disposeFixture(f);}
});
test('packaging pins binary archive and raw blob, preserves export omissions and selected directory names',async()=>{
 const f=await statusFixture();
 try {
  await mkdir(join(f.repo,'sub'));
  await writeFile(join(f.repo,'sub','bytes.bin'),Buffer.from([0,255,254,128,10]));
  await writeFile(join(f.repo,'sub','omit.txt'),'omitted');
  await writeFile(join(f.repo,'sub','.gitattributes'),'omit.txt export-ignore\n');
  f.git('add','.');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','binary');
  const commit=f.git('rev-parse','HEAD').trim();
  const object=f.git('rev-parse','HEAD:sub/bytes.bin').trim();
  const common=JSON.stringify({kind:'committed',commit,subdirectory:'sub',tracked:true});
  const body='const {worktree,branch,...packaging}=await read.packaging();assert.deepEqual(packaging,'+common+');assert.equal(typeof worktree,"string");assert.ok(branch===null||typeof branch==="string");'+
   'assert.deepEqual(await read.blobBuffer('+JSON.stringify(object)+'),Buffer.from([0,255,254,128,10]));'+
   'const archive=await read.archive();assert.ok(Buffer.isBuffer(archive));'+
   'assert.deepEqual(execFileSync("tar",["-xOf","-","bytes.bin"],{input:archive}),Buffer.from([0,255,254,128,10]));'+
   'assert.doesNotMatch(execFileSync("tar",["-tf","-"],{input:archive,encoding:"utf8"}),/omit.txt|sub\\//);'+
   'assert.match(await read.committedTree(),/\\tomit.txt\\0/);'+
   'await assert.rejects(read.archive({maxBytes:1024}));'+
   'await assert.rejects(read.blobBuffer('+JSON.stringify(object)+',{maxBytes:4}));';
  await packageRead(f,body,{repo:join(f.repo,'sub')});
  await packageRead(f,'const p=await read.packaging();assert.equal(p.commit,'+JSON.stringify(commit)+');assert.equal(p.subdirectory,"");assert.match(await read.committedTree(),/sub\\/omit.txt/);');
  const linked=join(f.root,'linked');f.git('worktree','add','--detach',linked,'HEAD');
  await packageRead(f,body,{repo:join(linked,'sub')});
  await packageRead(f,'const before=await read.packaging();'+
   'execFileSync("git",["-C",'+JSON.stringify(f.repo)+',"update-ref","HEAD","HEAD~1"],{env:'+JSON.stringify(f.env)+'});'+
   'assert.deepEqual(await read.packaging(),before);assert.match(await read.committedTree(),/sub\\/bytes.bin/);');
 } finally {await disposeFixture(f);}
});
test('packaging explicit fallback classifications are not error recovery',async()=>{
 const f=await statusFixture();
 try {
  const plain=join(f.root,'plain'),unborn=join(f.root,'unborn'),empty=join(f.repo,'empty');
  for(const path of [plain,unborn,empty])await mkdir(path);
  execFileSync('git',['-C',unborn,'init','-q','--template='],{...bounded,env:f.env});
  for(const [repo,kind] of [[plain,'nonrepository'],[unborn,'unborn'],[empty,'no-tracked-content']]) {
   await packageRead(f,'assert.equal((await read.packaging()).kind,'+JSON.stringify(kind)+');if((await read.packaging()).commit===null){await assert.rejects(read.archive());await assert.rejects(read.committedTree());}else{assert.ok(Buffer.isBuffer(await read.archive()));}',{repo});
  }
  await assert.rejects(packageRead(f,'await read.packaging();',{repo:join(f.repo,'.git')}));
  f.git('config','core.sparseCheckout','true');
  await assert.rejects(packageRead(f,'await read.packaging();'));
  f.git('config','--unset','core.sparseCheckout');
  const tree=f.git('rev-parse','HEAD^{tree}').trim();
  await rm(join(f.repo,'.git','objects',tree.slice(0,2),tree.slice(2)));
  await assert.rejects(packageRead(f,'await read.committedTree();'),'missing objects never grant plain fallback');
 } finally {await disposeFixture(f);}
});
test('archive budget exceeds text budget without a one-GiB allocation',async()=>{
 const f=await statusFixture();
 try {
  await writeFile(join(f.repo,'large.bin'),Buffer.alloc(65*1024*1024,255));
  f.git('add','large.bin');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','large');
  await packageRead(f,'assert.equal(MAX_GIT_ARCHIVE_BYTES,1024*1024*1024);'+
   'const a=await read.archive({maxBytes:70*1024*1024});assert.ok(Buffer.isBuffer(a));assert.ok(a.length>64*1024*1024);'+
   'await assert.rejects(read.archive({maxBytes:64*1024*1024}));');
 } finally {await disposeFixture(f);}
});
test('sealed packaging keeps nonexecutable global/local data settings but never drivers or replacement objects',async()=>{
 const f=await statusFixture();
 try {
  const excludes=join(f.root,'excludes'),attrs=join(f.root,'attributes'),marker=join(f.root,'driver');
  await writeFile(excludes,'ignored.local\n');
  await writeFile(attrs,'deleted.txt export-ignore\n');
  // This is the real default global config location for the owned HOME, not
  // GIT_CONFIG_GLOBAL (which must be scrubbed by the helper).
  await writeFile(join(f.root,'.gitconfig'),'[core]\n excludesFile = '+JSON.stringify(excludes)+'\n attributesFile = '+JSON.stringify(attrs)+'\n autocrlf = input\n'+
   '[filter "evil"]\n clean = touch '+marker+'\n required = true\n');
  await writeFile(join(f.repo,'.git','info','attributes'),'tracked.txt filter=evil\ntracked.txt export-ignore\n');
  await writeFile(join(f.repo,'ignored.local'),'ignored');
  await writeFile(join(f.repo,'tracked.txt'),'original\r\n');
  // Seed the index under input normalization, as it would be in this configuration.
  f.git('-c','core.autocrlf=input','add','--renormalize','tracked.txt');
  const original=f.git('rev-parse','HEAD:tracked.txt').trim();
  const replacement=f.git('hash-object','-w','--stdin').trim(); // owned empty stdin object
  f.git('replace',original,replacement);
  const hooks=join(f.root,'hooks');await mkdir(hooks);
  for(const name of ['post-checkout','post-index-change','reference-transaction'])
   await writeFile(join(hooks,name),'#!/bin/sh\nprintf ran > '+quote(marker)+'\n',{mode:0o700});
  f.git('config','core.hooksPath',hooks);
  f.git('config','core.fsmonitor','printf ran > '+quote(marker));
  const before=await readFile(join(f.repo,'.git','index'));
  const configBefore=await readFile(join(f.repo,'.git','config'));
  const headBefore=await readFile(join(f.repo,'.git','HEAD'));
  await packageRead(f,'assert.equal(await read.status(),"");'+
   'assert.equal((await read.blobBuffer('+JSON.stringify(original)+')).toString(),"original\\n");'+
   'const names=execFileSync("tar",["-tf","-"],{input:await read.archive(),encoding:"utf8"});assert.doesNotMatch(names,/deleted.txt|tracked.txt/);'+
   'assert.match(await read.committedTree(),/deleted.txt/);',{env:{...f.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.sshCommand',GIT_CONFIG_VALUE_0:'touch '+marker}});
  await assert.rejects(stat(marker),{code:'ENOENT'});
  assert.deepEqual(await readFile(join(f.repo,'.git','index')),before);
  assert.deepEqual(await readFile(join(f.repo,'.git','config')),configBefore);
  assert.deepEqual(await readFile(join(f.repo,'.git','HEAD')),headBefore);
 } finally {await disposeFixture(f);}
});

test('packaging refuses explicit unreadable data and permission errors without fallback',async()=>{
 const f=await statusFixture();
 try {
  f.git('config','core.excludesFile',join(f.root,'missing-excludes'));
  await assert.rejects(packageRead(f,'await read.packaging();'));
  f.git('config','--unset','core.excludesFile');
  const realGit=await realGitPath(),bin=join(f.root,'permission-bin');await mkdir(bin);
  // Permission failure is deterministic even when the host runs as root.
  await writeFile(join(bin,'git'),'#!/bin/sh\nfor arg do\n if [ "$arg" = "cat-file" ]; then\n printf "Permission denied\\n" >&2\n exit 128\n fi\ndone\nexec '+quote(realGit)+' "$@"\n',{mode:0o700});
  await assert.rejects(packageRead(f,'await read.packaging();',{env:{...f.env,PATH:bin+':'+process.env.PATH}}),/Permission denied/);
 } finally {await disposeFixture(f);}
});
