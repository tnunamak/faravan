import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import {chmod, lstat, readFile} from 'node:fs/promises';
const realGit = execFileSync('which',['git'],{encoding:'utf8'}).trim();
async function shimFor(t, repo, mode) {
  const dir=await mkdtemp(join(tmpdir(),'review-shim-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'git'), '#!'+process.execPath+'\n'+
    'const fs=require("node:fs"),{spawnSync}=require("node:child_process");\n'+
    'const args=process.argv.slice(2);\n'+
    'if(args.includes("update-ref")){\n'+
    (mode==='fail' ? 'process.stderr.write("simulated ref storage failure\\n");\n' :
      'const r=spawnSync('+JSON.stringify(realGit)+',args,{stdio:"inherit"});if(r.status!==0)process.exit(r.status??1);\n')+
    'fs.chmodSync('+JSON.stringify(join(repo.dir,'.git'))+',0o555);process.exit('+(mode==='success'?0:1)+');}\n'+
    'const r=spawnSync('+JSON.stringify(realGit)+',args,{stdio:"inherit"});process.exit(r.status??1);\n', {mode:0o700});
  return dir;
}
test('review: failed publication plus cleanup failure never becomes success for overlapping retries', async t=>{
  const {repo,device}=await scenario(t), options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),shim=await shimFor(t,repo,'fail'),original=device.intentStore;
  let arrived=0,release;
  const gate=new Promise(r=>release=r);
  device.intentStore=id=>{const store=original(id),set=store.set;store.set=async(k,v)=>{await set(k,v);if(k.startsWith('apply:')){if(++arrived===2)release();await gate;}};return store;};
  const oldPath=process.env.PATH,oldWarn=console.warn,diagnostics=[];
  process.env.PATH=shim+':'+oldPath;console.warn=(...args)=>diagnostics.push(args.join(' '));
  try{
    const run=()=>applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
    const results=await Promise.allSettled([run(),run()]);
    assert.ok(results.every(r=>r.status==='rejected'));
    assert.deepEqual(results.map(r=>r.reason.code).sort(),['apply_locked','apply_publish_failed']);
    assert.match(results.find(r=>r.reason.code==='apply_publish_failed').reason.message,/simulated ref storage failure/);
    assert.equal(git(repo.dir,'for-each-ref','--format=%(refname)','refs/heads/faravan/'),'');
    assert.match(diagnostics.join('\n'),/cleanup.*EACCES/i);
    assert.ok(await lstat(join(repo.dir,'.git/HEAD.lock')));
  }finally{process.env.PATH=oldPath;console.warn=oldWarn;await chmod(join(repo.dir,'.git'),0o755);}
});
test('review: published ref plus nonzero Git exit plus cleanup failure returns the proven success', async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),shim=await shimFor(t,repo,'published');
  const oldPath=process.env.PATH,oldWarn=console.warn,diagnostics=[];
  process.env.PATH=shim+':'+oldPath;console.warn=(...args)=>diagnostics.push(args.join(' '));
  try{
    const result=await applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
    assert.equal(result.status,'applied');assert.equal(git(repo.dir,'rev-parse',result.branch),result.commit);
    assert.equal((await applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}})).commit,result.commit);
    assert.match(diagnostics.join('\n'),/cleanup.*EACCES/i);
  }finally{process.env.PATH=oldPath;console.warn=oldWarn;await chmod(join(repo.dir,'.git'),0o755);}
});
test('review: acquisition-failure recheck refuses an unpublished candidate and an unrelated same-tree commit', async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),original=device.intentStore;
  let unrelated;
  device.intentStore=id=>{const store=original(id),set=store.set;store.set=async(k,v)=>{
    await set(k,v);if(k.startsWith('apply:')){
      unrelated=git(repo.dir,'commit-tree',v.tree,'-p',v.result.base,'-m','Unrelated same-tree commit');
      git(repo.dir,'update-ref',v.ref,unrelated);
      await writeFile(join(repo.dir,'.git/HEAD.lock'),'native lock');
    }
  };return store;};
  await assert.rejects(applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}}),{code:'apply_locked'});
  assert.equal(git(repo.dir,'rev-parse',preview.branch),unrelated);
  assert.equal(await readFile(join(repo.dir,'.git/HEAD.lock'),'utf8'),'native lock');
});
test('review: a stopped losing candidate is retired after the acquisition-failure success path', async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),shim=await shimFor(t,repo,'success'),original=device.intentStore;
  let release,announce,first=true;
  const paused=new Promise(r=>announce=r),proceed=new Promise(r=>release=r);
  device.intentStore=id=>{const store=original(id),set=store.set;store.set=async(k,v)=>{
    await set(k,v);if(k.startsWith('apply:')&&first){first=false;announce();await proceed;}
  };return store;};
  const oldPath=process.env.PATH,oldWarn=console.warn;
  process.env.PATH=shim+':'+oldPath;console.warn=()=>{};
  const run=()=>applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
  const pending=run();
  try{
    await paused;await new Promise(r=>setTimeout(r,1200));
    const winner=await run();
    const before=(await original('circle').list()).filter(v=>v.kind==='apply');
    assert.equal(before.length,2);assert.notEqual(before[0].result.commit,before[1].result.commit);
    release();assert.equal((await pending).commit,winner.commit);
    assert.equal((await original('circle').list()).filter(v=>v.kind==='apply').length,1);
  }finally{release();await pending.catch(()=>{});process.env.PATH=oldPath;console.warn=oldWarn;await chmod(join(repo.dir,'.git'),0o755);}
});

test('acquisition failure preserves a different dead owner whose writer is unknown', async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),shim=await shimFor(t,repo,'success'),original=device.intentStore;
  let release,announce,first=true;
  const paused=new Promise(r=>announce=r),proceed=new Promise(r=>release=r);
  device.intentStore=id=>{const store=original(id),set=store.set;store.set=async(k,v)=>{
    await set(k,v);if(k.startsWith('apply:')&&first){first=false;announce();await proceed;}
  };return store;};
  const oldPath=process.env.PATH,oldWarn=console.warn;
  process.env.PATH=shim+':'+oldPath;console.warn=()=>{};
  const run=()=>applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}});
  const pending=run();
  try{
    await paused;
    const store=original('circle'),losing=(await store.list()).find(value=>value.kind==='apply');
    const otherCommit=git(repo.dir,'commit-tree',losing.tree,'-p',losing.result.base,'-m','Another candidate');
    await new Promise(r=>setTimeout(r,1200));
    const winner=await run();
    const unknown={...losing,owner:{...losing.owner,pid:2147483647},result:{...losing.result,commit:otherCommit}};
    const key='apply:'+createHash('sha256').update(JSON.stringify([unknown.result.repo,unknown.ref,unknown.result.commit])).digest('hex');
    await store.set(key,unknown);
    release();assert.equal((await pending).commit,winner.commit);
    assert.deepEqual(await store.get(key),unknown);
  }finally{release();await pending.catch(()=>{});process.env.PATH=oldPath;console.warn=oldWarn;await chmod(join(repo.dir,'.git'),0o755);}
});
