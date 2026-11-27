import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, utimes, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyRuntime, stageGuestRuntime, runtimeWorkspaceArgs, installGuestRuntime, guestHashCommand, runtimeStartFailed, guardRuntimeReadiness } from '../lib/guest-runtime.mjs';
import { guardRunCommand, guardStopCommand } from '../lib/faravan-guard-host.mjs';
import { FAILURE_CODES } from '../lib/v1/failures.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const bad = {code:'guard_runtime_unavailable'};
test('runtime verification rejects missing and changed files, including after cache population', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guest-runtime-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'node');
  await assert.rejects(verifyRuntime(file,sha('good')),bad);
  await writeFile(file,'good'); await verifyRuntime(file,sha('good'));
  await assert.rejects(verifyRuntime(file,sha('wrong')),bad);
  await writeFile(file,'evil'); await utimes(file,new Date(),new Date(Date.now()+2000));
  await assert.rejects(verifyRuntime(file,sha('good')),bad);
});
test('packaging reuses the Linux host runtime and produces a verified, staged manifest', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guest-package-')); t.after(() => rm(dir,{recursive:true,force:true}));
  execFileSync('bash',['packaging/bundle-node.sh','linux','x64',dir],{env:{...process.env,FARAVAN_NODE_BIN:process.execPath}});
  execFileSync('bash',['packaging/bundle-guest-runtime.sh','linux','x64',dir]);
  assert.equal((await guardRuntimeReadiness({root:dir,arch:'x64',home:path.join(dir,'data')})).ok,true);
  const source = path.join(dir,'runtime/bin/node');
  const manifest = JSON.parse(await readFile(path.join(dir,'guest-runtime/manifest.json')));
  assert.equal(manifest['linux-x64'].sha256,sha(await readFile(source)));
  const runtime = await stageGuestRuntime({root:dir,arch:'x64',home:path.join(dir,'data')});
  assert.equal((await stat(runtime.node)).mode & 0o777,0o555);
  assert.equal(await verifyRuntime(runtime.node,manifest['linux-x64'].sha256),runtime.sha256);
  await writeFile(path.join(dir,'guest-runtime/manifest.json'),'{}');
  assert.deepEqual(await guardRuntimeReadiness({root:dir,arch:'x64',home:dir}), {ok:false,code:'guard_runtime_unavailable',detail:"Faravan's job guard could not start in the sandbox. Update Faravan; if it still fails, reinstall Faravan."});
  await assert.rejects(stageGuestRuntime({root:dir,arch:'x64',home:dir}),bad);
});
test('workspace mount uses the staged absolute path; mountless never adds a primary workspace', () => {
  const runtime={dir:'/data/runtime'};
  assert.deepEqual(runtimeWorkspaceArgs(runtime,{mountless:false}),['/data/runtime:ro']);
  assert.deepEqual(runtimeWorkspaceArgs(runtime,{mountless:true}),[]);
  for (const dir of ['/data/app bundle','/data/dir:ro','relative']) assert.deepEqual(runtimeWorkspaceArgs({dir},{mountless:false}),[]);
});
test('guest runtime checks read-only mount and hash; absent mounts copy', async () => {
  for (const [mounted, mountCode, expected] of [[true,0,'mount'],[true,1,'copy'],[false,1,'copy']]) {
    const calls=[];
    const result=await installGuestRuntime({runtime:{dir:'/data',node:'/data/node',sha256:sha('node')},sandboxId:'sandbox',mounted,run:async args => {
      calls.push(args); return {code:args.at(-1).includes('/proc/self/mountinfo') ? mountCode : 0};
    }});
    assert.equal(result.method,expected);
    assert.equal(result.node,expected === 'mount' ? '/data/node' : '/tmp/faravan-runtime-'+sha('node')+'/node');
    assert.equal(calls.some(a=>a[0]==='cp'),expected==='copy');
    assert.ok(calls.some(a=>a.at(-1).includes('hashlib.sha256')));
  }
  await assert.rejects(installGuestRuntime({runtime:null}),bad);
  await assert.rejects(installGuestRuntime({runtime:{dir:'/data',node:'/data/node',sha256:sha('node')},sandboxId:'sandbox',mounted:false,run:async()=>({code:1})}),bad);
});
test('guest runtime rejects an executable-format error from the staged node', async () => {
  await assert.rejects(installGuestRuntime({
    runtime:{dir:'/data',node:'/data/node',sha256:sha('node')},sandboxId:'sandbox',mounted:true,
    run:async args => args.at(-1).includes('--version')
      ? {code:126,stderr:'cannot execute binary file: Exec format error'}
      : {code:0},
  }),bad);
});
test('guest hash command rejects wrong bytes and missing files without relying on guest node', () => {
  const command=guestHashCommand(sha('node'),'/data/node');
  assert.match(command,/python3/); assert.match(command,/hashlib.sha256/); assert.match(command,/\/data\/node' --version/);
});
test('guard commands use the packaged absolute runtime and missing node has a stable failure code', () => {
  assert.match(guardRunCommand({runtimePath:'/data/node',guardPath:'/guard.mjs',config:{},agentCommand:'true'}),/^'\/data\/node'/);
  assert.match(guardStopCommand({runtimePath:'/data/node',guardPath:'/guard.mjs',ctl:'/ctl',reason:'owner'}),/^'\/data\/node'/);
  assert.equal(runtimeStartFailed({code:127,stderr:'sh: 1: node: not found'}),true);
  assert.equal(runtimeStartFailed({code:1,stderr:'node: not found'}),false);
  assert.ok(FAILURE_CODES.includes('guard_runtime_unavailable'));
});

test('guest hash check runs and rejects mismatched or missing runtime bytes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guest-hash-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'node');
  const bytes = await readFile(process.execPath);
  await writeFile(file,bytes,{mode:0o555});
  execFileSync('sh',['-c',guestHashCommand(sha(bytes),file)]);
  assert.throws(() => execFileSync('sh',['-c',guestHashCommand(sha('wrong'),file)],{stdio:'pipe'}));
  assert.throws(() => execFileSync('sh',['-c',guestHashCommand(sha(bytes),file+'-missing')],{stdio:'pipe'}));
});

test('Mac package resources contain manifests for both Linux guest architectures', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'guest-mac-package-')); t.after(() => rm(dir,{recursive:true,force:true}));
  execFileSync('bash',['packaging/bundle-node.sh','darwin','arm64',dir],{env:{...process.env,FARAVAN_NODE_BIN:process.execPath}});
  execFileSync('bash',['packaging/bundle-guest-runtime.sh','darwin','arm64',dir],{env:{...process.env,FARAVAN_NODE_BIN:process.execPath}});
  const manifest=JSON.parse(await readFile(path.join(dir,'guest-runtime/manifest.json')));
  assert.deepEqual(Object.keys(manifest).sort(),['linux-arm64','linux-x64']);
  for (const arch of ['arm64','x64']) await verifyRuntime(path.join(dir,'guest-runtime','linux-'+arch,'node'),manifest['linux-'+arch].sha256);
});

test('each handle installs its runtime once and reuses failed installation results', async () => {
  const {DockerSbxBackend} = await import('../lib/docker-backend.mjs');
  for (const code of [0,126]) {
    let calls=0;
    const backend=new DockerSbxBackend({guestRuntime:async()=>({node:'/data/node',sha256:'0'.repeat(64)})});
    backend._runJobCommand=async()=>{calls++;return {code};};
    const handle={sandbox_id:'runtime-cache',_execution:{}};
    const results=await Promise.allSettled([backend.ensureGuestRuntime(handle),backend.ensureGuestRuntime(handle)]);
    if(code===0){assert.equal(results[0].value,results[1].value);assert.equal(results[0].value,handle._execution.guard_runtime);assert.equal(calls,3);}
    else {for(const result of results)assert.equal(result.reason.code,'guard_runtime_unavailable');assert.equal(calls,1);}
    await backend.ensureGuestRuntime(handle).catch(()=>{});
    assert.equal(calls,code===0?3:1);
  }
});

test('mounted writable runtime fails closed without copying', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'runtime-mount-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const mountinfo=path.join(dir,'mountinfo');
  await writeFile(mountinfo,'42 1 0:1 / /data rw,relatime - virtiofs runtime rw\n');
  const calls=[];
  await assert.rejects(installGuestRuntime({runtime:{dir:'/data',node:'/data/node',sha256:sha('node')},sandboxId:'sandbox',mounted:true,run:async args => {
    calls.push(args);
    const result=spawnSync('sh',['-c',args.at(-1).replace('/proc/self/mountinfo',mountinfo)],{encoding:'utf8'});
    return {code:result.status};
  }}),bad);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'exec');
  assert.match(calls[0].at(-1),/writable/);
});

test('replacing a copied runtime before stop hard-stops without executing the replacement', async t => {
  const {DockerSbxBackend} = await import('../lib/docker-backend.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'runtime-stop-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source'), copied=path.join(dir,'node'), marker=path.join(dir,'tampered-ran');
  const original='#!/bin/sh\nexit 0\n';
  await writeFile(source,original,{mode:0o555});
  const backend=new DockerSbxBackend({guestRuntime:async()=>({node:source,sha256:sha(original)})});
  const guestNode='/tmp/faravan-runtime-'+sha(original)+'/node';
  backend._runJobCommand=async (handle,args)=>{
    if(args[0]==='cp'){await copyFile(source,copied);return {code:0};}
    if(args.at(-1).startsWith('mkdir -p'))return {code:0};
    const result=spawnSync('sh',['-c',args.at(-1).replaceAll(guestNode,copied)],{encoding:'utf8'});
    return {code:result.status,stdout:result.stdout,stderr:result.stderr};
  };
  let stopped=0;
  backend.cancel=async()=>{stopped++;};
  const handle={sandbox_id:'runtime-stop',_execution:{},_lending:{requested:new Set(),guard:{path:'/guard.mjs',ctl:'/ctl',finished:false,running:new Promise(()=>{})}}};
  assert.equal((await backend.ensureGuestRuntime(handle)).method,'copy');
  await rm(copied);
  await writeFile(copied,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  assert.deepEqual(await backend.requestStop(handle,'owner'),{delivered:false,fallback:'hard',reason:'owner'});
  assert.equal(stopped,1);
  assert.equal(handle._lending.hard_stop,'guard_runtime_unavailable');
  await assert.rejects(stat(marker),{code:'ENOENT'});
  handle._lending.hard_stop=null;
  backend._runJobCommand=async()=>{throw new Error('guest command unavailable');};
  assert.equal((await backend.requestStop(handle,'owner')).fallback,'hard');
  assert.equal(handle._lending.hard_stop,'guard_runtime_unavailable');
  assert.equal(stopped,2);
});
