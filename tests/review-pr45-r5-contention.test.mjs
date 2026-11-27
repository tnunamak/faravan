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

import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {applyResult} from '../lib/v1/apply.mjs';
test('review: current-referent lock contention rechecks an overlapping CLI publication',async t=>{
  const {repo,device}=await scenario(t),options={digest,circle:'circle',repo:repo.dir,device};
  const preview=await applyForApp(options),path=join(repo.dir,'.git/refs/heads/main.lock');
  await writeFile(path,'native Git lock');
  let entered,release;
  const paused=new Promise(r=>entered=r),proceed=new Promise(r=>release=r);
  const original=fs.link;
  fs.link=async(from,to)=>{if(to===path){entered();await proceed;}return original(from,to);};
  syncBuiltinESMExports();
  const pending=applyForApp({...options,dryRun:false,expect:{preview_token:preview.preview_token}}).then(value=>({value}),error=>({error}));
  try{
    await paused;
    const before=await device.intentStore().list();
    assert.equal(before.length,1);
    const previousDate=process.env.GIT_COMMITTER_DATE;
    process.env.GIT_COMMITTER_DATE='2001-01-01T00:00:00Z';
    let cli;
    try { cli=await applyResult({...options,dryRun:false}); }
    finally { if(previousDate===undefined)delete process.env.GIT_COMMITTER_DATE;else process.env.GIT_COMMITTER_DATE=previousDate; }
    assert.equal(cli.status,'applied');assert.equal(git(repo.dir,'rev-parse',cli.branch),cli.commit);
    assert.notEqual(cli.commit,before[0].result.commit,'the competing candidates must differ');
    release();
    const app=await pending;
    assert.equal(await fs.readFile(path,'utf8'),'native Git lock');
    console.log(JSON.stringify({cli:{status:cli.status,commit:cli.commit},app:app.error?{error:app.error.code,message:app.error.message}:{status:app.value.status,commit:app.value.commit}}));
    assert.equal(app.error,undefined);
    assert.equal(app.value.status,'applied');assert.equal(app.value.commit,cli.commit);
    const remaining=await device.intentStore().list();
    assert.equal(remaining.length,1);
    assert.equal(remaining[0].result.commit,cli.commit);
  }finally{release();await pending;fs.link=original;syncBuiltinESMExports();}
});
