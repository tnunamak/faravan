import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { execFileSync } from 'node:child_process';

const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);
const submit = (owner, circle) => api(owner.app, '/api/jobs', { method: 'POST', body: { circle: circle.id,
  git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Synthetic task', harness: 'codex' } });

test('Changes tab data: file list, bounded unified diff and the apply command for a diff candidate', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const { jobDigest } = await submit(owner, circle);
  const big = 'x'.repeat(100) + '\n';
  await writeFile(join(repo.dir, 'big.txt'), big.repeat(4000)); await writeFile(join(repo.dir, 'README.md'), 'hello\nmore\n');
  git(repo.dir, 'add', '-A');
  const patch = execFileSync('git', ['diff', '--binary', '--cached', '--no-renames', repo.commit], { cwd: repo.dir, maxBuffer: 1 << 26 });
  await f.complete(jobDigest, 'owner', { candidate: patch, candidateMediaType: 'text/x-diff',
    receipt: { candidate_format: 'diff', diffstat: { files: 2, insertions: 4001, deletions: 0 } } });
  const view = await api(owner.app, jobPath(jobDigest) + '/changes?circle=' + circle.id);
  assert.equal(view.format, 'diff');
  assert.deepEqual(view.diffstat, { files: 2, insertions: 4001, deletions: 0 });
  assert.deepEqual(view.files.map(x => x.path).sort(), ['README.md', 'big.txt']);
  assert.equal(view.command, `faravan apply ${jobDigest} --circle ${circle.id}`);
  assert.equal(view.truncated, true, 'a 400 KB diff is cut');
  assert.ok(view.diff.length <= 256 * 1024 && view.diff.endsWith('\n'), 'cut on a line boundary within the preview bound');
  assert.equal(view.bytes, patch.length);
  assert.deepEqual(view.blocked, []);
});

test('Changes tab data flags patches that apply would refuse, and reports tree candidates honestly', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const hostile = Buffer.from('diff --git a/.git/config b/.git/config\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+x\n');
  const a = (await submit(owner, circle)).jobDigest;
  await f.complete(a, 'owner', { candidate: hostile, candidateMediaType: 'text/x-diff', receipt: { candidate_format: 'diff', diffstat: { files: 1, insertions: 1, deletions: 0 } } });
  const view = await api(owner.app, jobPath(a) + '/changes?circle=' + circle.id);
  assert.equal(view.blocked.length, 1); assert.match(view.blocked[0], /\.git/);
  const b = (await api(owner.app, '/api/jobs', { method: 'POST', body: { circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '2'.repeat(40), prompt: 'Second', harness: 'codex' } })).jobDigest;
  await f.complete(b, 'owner', { receipt: { candidate_format: 'tree' } });
  const tree = await api(owner.app, jobPath(b) + '/changes?circle=' + circle.id);
  assert.equal(tree.format, 'tree'); assert.equal(tree.command, null);
  assert.equal(tree.receipt.candidate_format, 'tree');
});

test('the web form shape {git:{url,commit}} submits a repository job', { timeout: 20000 }, async t => {
  const f = await appFixture(t), { owner, circle } = await f.connect();
  const commit = '3'.repeat(40);
  const { jobDigest } = await api(owner.app, '/api/jobs', { method: 'POST', body: { circle: circle.id,
    git: { url: 'https://github.com/example/synthetic.git', commit }, prompt: 'From the form', harness: 'codex' } });
  const view = await api(owner.app, jobPath(jobDigest) + '?circle=' + circle.id);
  assert.match(view.local.source, new RegExp('github.com/example/synthetic.git @ ' + commit.slice(0, 8)));
});

// All three HTTP result views must use the shared retained-attempt path.
test('app changes, result download and transcript reuse an earlier observed attempt', {timeout:20000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await submit(owner,circle);
  await f.complete(jobDigest,'owner');
  const originalClient=owner.app.device.client.bind(owner.app.device),seen=[];
  owner.app.device.client=async id=>{
    const client=await originalClient(id);
    return new Proxy(client,{get(target,name){
      if(['fetchResult','fetchTranscript'].includes(name))return async(digest,opts)=>{
        assert.equal(digest,jobDigest);assert.ok(opts?.attempt,'retain the attempt before fetching');
        assert.equal(opts.attempt.job_digest,jobDigest);seen.push(structuredClone(opts.attempt));
        return target[name](digest,opts);
      };
      return target[name];
    }});
  };
  const earlier=await api(owner.app,jobPath(jobDigest)+'?circle='+circle.id);
  await api(owner.app,jobPath(jobDigest)+'/changes?circle='+circle.id);
  await api(owner.app,jobPath(jobDigest)+'/transcript?circle='+circle.id);
  const url=new URL(jobPath(jobDigest)+'/result',owner.app.origin);url.searchParams.set('circle',circle.id);
  const download=await fetch(url,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(download.status,200);assert.ok((await download.arrayBuffer()).byteLength>0);
  assert.equal(seen.length,3);for(const attempt of seen)assert.deepEqual(attempt,earlier.current_attempt);
});
