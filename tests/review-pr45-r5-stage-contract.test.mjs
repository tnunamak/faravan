import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { memoryIntentStore } from './helpers/apply-intents.mjs';
import { applyForApp } from '../lib/v1/apply.mjs';

// U22: the web app's Add as a branch. Preview first, then the same inputs; a repository that changed writes nothing.
const digest = 'sha256:' + 'a'.repeat(64);
async function patchFrom(repo, edit) {
  const copy = await mkdtemp(join(tmpdir(), 'faravan-patch-'));
  try {
    execFileSync('git', ['clone', '-q', repo.dir, copy]);
    await edit(copy); git(copy, 'add', '-A');
    return execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: copy, maxBuffer: 1 << 26 });
  } finally { await rm(copy, { recursive: true, force: true }); }
}
const greeting = copy => writeFile(join(copy, 'src/a.txt'), 'one\nTWO\nthree\nfour\n');
const deviceFor = (patch, base) => ({
  intentStore: memoryIntentStore(),
  selectCircle: async () => ({ id: 'circle' }),
  client: async () => ({
    getJob: async () => ({ current_attempt: { attempt_id: 'x' } }),
    fetchResult: async () => ({ bytes: patch, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'codex', harness_version: '1.2.3', model: 'm', duration_ms: 60000 }, job: { source: { kind: 'git', commit: base }, prompt: { digest: 'x' } } }),
    fetchArtifact: async () => { throw new Error('no prompt'); },
  }),
});
async function scenario(t, { patch, base } = {}) {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const p = patch ?? await patchFrom(repo, greeting);
  return { repo, device: deviceFor(p, base ?? repo.commit) };
}

import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {recoverPreviewLocks,reconcileApplies} from '../lib/v1/apply.mjs';
const previewModule=new URL('../lib/v1/preview-lock.mjs',import.meta.url).href;
// A simulated platform must supply its own identity probes before acquiring a guard.
function macIdentityProbe(exec,program,args,options) {
  if(program==='/usr/sbin/sysctl'&&args.join(' ')==='-n kern.boottime')return '{ sec = 1000, usec = 0 }';
  if(program==='/bin/ps'&&args.join(' ')===`-p ${process.pid} -o lstart=`)return 'Mon Jan 1 00:00:00 2024';
  return exec(program,args,options);
}
async function milestone(child){
  let timer;
  try{return await Promise.race([once(child,'message').then(([message])=>message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('child milestone timeout')),15000);})]);}
  finally{clearTimeout(timer);}
}
async function crashOwner(t,repo,{mode='acquire',mac=false}={}){
  const head=join(repo.dir,'.git/HEAD.lock'),branch=join(repo.dir,'.git/refs/heads/main.lock');
  const script=String.raw`
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
process.on('message',()=>{});
const cfg=JSON.parse(process.env.REVIEW_CONFIG);
if(cfg.mac){
  const exec=childProcess.execFileSync;
  childProcess.execFileSync=(...args)=>(${macIdentityProbe.toString()})(exec,...args);
  syncBuiltinESMExports();
  Object.defineProperty(process,'platform',{value:'darwin'});
}
const pause=async message=>{process.send(message);await new Promise(()=>{});};
if(!cfg.mac){
  if(cfg.mode==='acquire'){
    const link=fs.link;
    let branchStage;
    fs.link=async(from,to)=>{const out=await link(from,to);if(to===cfg.branch)branchStage=from;return out;};
    const unlink=fs.unlink;
    fs.unlink=async path=>{if(path===branchStage)await pause({stage:path});return unlink(path);};
  }else{
    const rename=fs.rename;
    fs.rename=async(from,to)=>{if(to===cfg.branch)await pause({stage:from});return rename(from,to);};
  }
  syncBuiltinESMExports();
}
const {acquirePreviewLock,recordTransaction,previewGuard}=await import(cfg.module);
await previewGuard(cfg.common);
// The process guard is verified; these preview records deliberately lack identity.
const previewOptions=cfg.mac?{identityReader:()=>{throw Error('preview identity unavailable');}}:{};
await acquirePreviewLock(cfg.head,cfg.staging,previewOptions);
await acquirePreviewLock(cfg.branch,cfg.staging,previewOptions);
if(cfg.mac)await pause({stage:null});
else if(cfg.mode==='record')await recordTransaction(cfg.branch,process.pid,cfg.staging);
`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,REVIEW_CONFIG:JSON.stringify({mode,mac,head,branch,common:join(repo.dir,'.git'),staging:join(repo.dir,'.git/faravan-preview-staging'),module:previewModule})},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const message=await milestone(child).catch(e=>{throw Error(e.message+' '+stderr);});
  child.kill('SIGKILL');await exited;
  return {...message,head,branch};
}
for(const mode of ['acquire','record'])test('review: SIGKILL during '+mode+' keeps staging files out of the Git ref namespace',async t=>{
  const {repo}=await scenario(t),before=git(repo.dir,'for-each-ref');
  const crash=await crashOwner(t,repo,{mode});
  assert.ok(await lstat(crash.stage));
  assert.equal((await recoverPreviewLocks({repo:repo.dir})).status,'recovered');
  await assert.rejects(lstat(crash.head),{code:'ENOENT'});
  await assert.rejects(lstat(crash.branch),{code:'ENOENT'});
  assert.ok(await lstat(crash.stage),'recovery does not sweep staging files');
  const refs=spawnSync('git',['for-each-ref'],{cwd:repo.dir,encoding:'utf8'});
  const fsck=spawnSync('git',['fsck','--full'],{cwd:repo.dir,encoding:'utf8'});
  const clone=spawnSync('git',['clone','--no-local',repo.dir,join(repo.dir,'copy')],{encoding:'utf8'});
  assert.equal(refs.status,0);assert.equal(refs.stdout.trim(),before);assert.equal(refs.stderr,'');
  assert.equal(fsck.status,0,fsck.stderr);assert.equal(clone.status,0,clone.stderr);
  console.log(JSON.stringify({mode,staging:crash.stage,forEachRef:{status:refs.status,stderr:refs.stderr},fsck:{status:fsck.status,stderr:fsck.stderr},clone:{status:clone.status,stderr:clone.stderr}}));
});
for(const published of [false,true])test('review: simulated macOS crash '+(published?'after':'before')+' publication preserves locks and reports the exact outcome',async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  device.listCircles=async()=>[{id:'circle'}];
  const preview=await applyForApp(options);
  const winner=published?await applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}}):null;
  const crash=await crashOwner(t,repo,{mac:true});
  const owner=JSON.parse(await readFile(crash.head,'utf8'));
  assert.deepEqual(Object.keys(owner).sort(),['token','version']);
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  const exec=childProcess.execFileSync;
  t.mock.method(childProcess,'execFileSync',(...args)=>macIdentityProbe(exec,...args));
  syncBuiltinESMExports();
  Object.defineProperty(process,'platform',{value:'darwin'});
  try{
    const recovered=await reconcileApplies(device);
    assert.equal(recovered.length,published?1:0);
    if(published){const result=await applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});assert.equal(result.status,'applied');assert.equal(result.commit,winner.commit);}
    else{
      const again=await applyForApp(options);assert.equal(again.status,'dry_run');
      await assert.rejects(applyForApp({...options,dryRun:false,expect:{preview_token:again.preview_token}}),e=>{console.log('mac before-ref refusal',e.code,e.message);return e.code==='apply_locked';});
    }
    await assert.rejects(recoverPreviewLocks({repo:repo.dir}),e=>{console.log('mac recovery refusal',e.code,e.message);return e.code==='preview_lock_blocked'&&e.message.includes('main.lock');});
    assert.ok(await lstat(crash.head));assert.ok(await lstat(crash.branch));
  }finally{Object.defineProperty(process,'platform',descriptor);t.mock.restoreAll();syncBuiltinESMExports();}
});
