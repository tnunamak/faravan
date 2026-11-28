import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createLender } from '../lib/v1/lender.mjs';
import { diffstat } from '../lib/git-candidate.mjs';
import * as p from '../lib/protocol/index.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: event => f.events.push(event) });
  let failure; const settled = Promise.resolve(lender.start(controller.signal)).catch(error => { failure = error; });
  f.stop = async () => { controller.abort(); await settled; if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure; };
}
const finished = f => f.events.some(e => e.label?.startsWith('Finished.'));
const archiveOf = (dir, ...paths) => gzipSync(execFileSync('tar', ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', ...paths], { cwd: dir, maxBuffer: 1 << 26 }));
const gitArchive = dir => gzipSync(execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: dir, maxBuffer: 1 << 26 }));
const sourceOf = bytes => ({ kind: 'archive', artifact: { digest: p.digestBytes(bytes), bytes: bytes.length, media_type: 'application/gzip' } });

test('archive job: the lender returns a signed diff against the committed snapshot, with diffstat and base tree', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const bytes = gitArchive(repo.dir);
  const f = await lenderFixture(t, { mutateJob: job => { job.source = sourceOf(bytes); },
    agent: async dir => { await writeFile(join(dir, 'src/a.txt'), 'one\nTWO\nthree\n'); await writeFile(join(dir, 'added.txt'), 'new\n'); } });
  f.artifacts.set(sourceOf(bytes).artifact.digest, bytes);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  const { candidate, receipt } = f.result.payload;
  assert.equal(candidate.media_type, 'text/x-diff');
  assert.equal(receipt.candidate_format, 'diff');
  assert.deepEqual(receipt.diffstat, { files: 2, insertions: 2, deletions: 1 });
  assert.equal(receipt.base_tree, git(repo.dir, 'rev-parse', 'HEAD^{tree}'), 'the snapshot base tree equals the source repository tree');
  assert.equal(receipt.diff_unavailable, undefined);
  const patch = f.artifacts.get(candidate.digest);
  assert.deepEqual(diffstat(patch), receipt.diffstat, 'receipt diffstat is computed from the signed bytes');
  assert.match(patch.toString(), /^diff --git a\/added\.txt b\/added\.txt/m);
  assert.equal(f.calls.some(([kind]) => kind === 'pack'), false, 'no tarball is produced when a diff exists');
  // The signed diff applies to the borrower's original commit.
  git(repo.dir, 'checkout', '-q', '-b', 'try'); execFileSync('git', ['apply', '--check', '-'], { cwd: repo.dir, input: patch });
});

test('pinned git job: the filtered tree retains the verified commit without claiming a diff base', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const f = await lenderFixture(t, { mutateJob: job => { job.source = { kind: 'git', url: 'https://github.com/example/synthetic.git', object_format: 'sha1', commit: repo.commit }; },
    onClone: handle => execFileSync('git', ['clone', '-q', repo.dir, join(handle.scratch_dir, 'repo')]),
    agent: async dir => { await writeFile(join(dir, 'repo/README.md'), 'hello\nagent was here\n'); } });
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  const { candidate, receipt } = f.result.payload;
  assert.equal(candidate.media_type, 'application/gzip');
  assert.equal(receipt.candidate_format, 'tree');
  assert.equal(receipt.verified_commit, repo.commit);
  assert.equal(receipt.diffstat, undefined);
  assert.equal(receipt.base_tree, undefined);
});

test('a snapshot that already carries .git falls back to the tree candidate and says why', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const bytes = archiveOf(repo.dir, '.git', 'README.md');
  const f = await lenderFixture(t, { mutateJob: job => { job.source = sourceOf(bytes); } });
  f.artifacts.set(sourceOf(bytes).artifact.digest, bytes);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  const { candidate, receipt } = f.result.payload;
  assert.equal(candidate.media_type, 'application/gzip');
  assert.equal(receipt.candidate_format, 'tree');
  assert.equal(receipt.diff_unavailable, 'archive_has_git');
  assert.equal(receipt.diffstat, undefined);
  assert.ok(f.calls.some(([kind]) => kind === 'pack'));
});

test('missing git in the sandbox falls back to the tree candidate', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const bytes = gitArchive(repo.dir);
  const f = await lenderFixture(t, { mutateJob: job => { job.source = sourceOf(bytes); } });
  f.artifacts.set(sourceOf(bytes).artifact.digest, bytes);
  const start = f.backend.start;
  f.backend.start = async (handle, opts) => {
    if (handle._entrypoint.startsWith(': faravan-git-base')) { handle._lastExecStdout = 'FARAVAN_NOGIT=git_unavailable\n'; return; }
    return start(handle, opts);
  };
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  assert.equal(f.result.payload.receipt.candidate_format, 'tree');
  assert.equal(f.result.payload.receipt.diff_unavailable, 'git_unavailable');
});

test('the job output limit applies to the diff: an oversized diff is never sent', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const bytes = gitArchive(repo.dir);
  const f = await lenderFixture(t, { mutateJob: job => { job.source = sourceOf(bytes); job.requirements.limits.output_bytes = 2048; },
    agent: async dir => { await writeFile(join(dir, 'big.txt'), 'x'.repeat(4096) + '\n'); } });
  f.artifacts.set(sourceOf(bytes).artifact.digest, bytes);
  launch(f); await until(() => f.events.some(e => e.status === 'failed'), 'failure');
  await f.stop();
  assert.ok(f.events.some(e => e.status === 'failed' && e.reason === 'output_too_large'));
  assert.equal(f.count('/complete'), 0);
  assert.equal([...f.artifacts.keys()].length, 2, 'only the prompt and the source exist; no candidate was uploaded');
});

test('an agent that changes nothing produces an empty, valid diff', { timeout: 20000 }, async t => {
  const repo = await makeRepo(); t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const bytes = gitArchive(repo.dir);
  const f = await lenderFixture(t, { mutateJob: job => { job.source = sourceOf(bytes); } });
  f.artifacts.set(sourceOf(bytes).artifact.digest, bytes);
  launch(f); await until(() => finished(f), 'finished'); await f.stop();
  assert.deepEqual(f.result.payload.receipt.diffstat, { files: 0, insertions: 0, deletions: 0 });
  assert.equal(f.result.payload.candidate.bytes, 0);
});

test('gitignored faravan-output is returned as added files without collecting other ignored files', { timeout: 20000 }, async t => {
  const repo = await makeRepo({ 'README.md':'hello\n', '.gitignore':'*\n!README.md\n!.gitignore\n' });
  t.after(() => rm(repo.dir, { recursive:true, force:true }));
  const bytes = gitArchive(repo.dir);
  const f = await lenderFixture(t, { mutateJob:job => {job.source=sourceOf(bytes);}, agent:async dir => {
    await mkdir(join(dir,'faravan-output'),{recursive:true});
    await writeFile(join(dir,'faravan-output/render.png'),Buffer.from([137,80,78,71,0,1,2]));
    await writeFile(join(dir,'ignored-secret.txt'),'do not collect\n');
  }});
  f.artifacts.set(sourceOf(bytes).artifact.digest,bytes);
  launch(f); await until(() => finished(f),'finished'); await f.stop();
  const {candidate,receipt}=f.result.payload;
  const patch=f.artifacts.get(candidate.digest);
  assert.match(patch.toString(), /new file mode 100644/);
  assert.match(patch.toString(), /faravan-output\/render.png/);
  assert.doesNotMatch(patch.toString(), /ignored-secret/);
  assert.deepEqual(receipt.diffstat,{files:1,insertions:0,deletions:0});
  const transcript=f.artifacts.get(f.result.payload.transcript.digest).toString();
  const context=transcript.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(event=>event.type==='faravan.job_context');
  assert.ok(f.events.some(event=>event.status==='transcript'&&event.chunk?.includes('faravan.job_context')),'the local live transcript receives the same metadata');
  assert.equal(context.type,'faravan.job_context');
  assert.equal(context.job_framing_version,1);
  assert.equal(context.workspace_path,'/workspace');
  assert.doesNotMatch(JSON.stringify(context),/faravan-lender|\/home\/|\/tmp\//,'framing contains no private scratch prefix');
  assert.equal(receipt.job_framing_version,undefined,'v1 receipt remains readable by older validators');
  execFileSync('git',['apply','--check','-'],{cwd:repo.dir,input:patch});
});

test('untracked names are staged literally, including Git pathspec syntax', {timeout:20000},async t=>{
  const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
  const bytes=gitArchive(repo.dir);
  const f=await lenderFixture(t,{mutateJob:job=>{job.source=sourceOf(bytes);},agent:async dir=>{
    for(const name of [':(top)zz',':!a','*.md'])await writeFile(join(dir,name),'new\n');
  }});
  f.artifacts.set(sourceOf(bytes).artifact.digest,bytes);
  launch(f);await until(()=>finished(f),'finished');await f.stop();
  assert.equal(f.result.payload.receipt.candidate_format,'diff');
  assert.equal(f.result.payload.receipt.diffstat.files,3);
});

test('every signed result transcript carries a scanned summary-only continuation', {timeout:20000}, async t=>{
 const f=await lenderFixture(t,{stdout:JSON.stringify({type:'result',result:'Updated greeting; no further steps.'})+'\n'});
 launch(f);await until(()=>finished(f),'finished');await f.stop();
 const text=Buffer.from(f.artifacts.get(f.result.payload.transcript.digest)).toString('utf8');
 const record=text.trim().split('\n').map(line=>JSON.parse(line)).find(record=>record.type==='faravan.continuation');
 assert.ok(record,'signed transcript must contain the handoff');
 assert.equal(record.handoff.trust,'untrusted');assert.equal(record.handoff.mode,'summary');
 assert.equal(record.handoff.scan.status,'passed');assert.match(record.handoff.agent_claims,/Updated greeting/);
});

test('lender known values never enter the signed handoff, even without a token-shaped format', {timeout:20000},async t=>{
 const name='FARAVAN_CONTINUATION_TEST_TOKEN',previous=process.env[name];
 process.env[name]='obscure-known-lender-value-42';t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
 const f=await lenderFixture(t,{stdout:JSON.stringify({type:'result',result:'found obscure-known-lender-value-42'})+'\n'});
 launch(f);await until(()=>finished(f),'finished');await f.stop();
 const text=Buffer.from(f.artifacts.get(f.result.payload.transcript.digest)).toString('utf8');
 const record=text.trim().split('\n').map(line=>JSON.parse(line)).find(record=>record.type==='faravan.continuation');
 assert.equal(record.handoff.scan.status,'withheld');assert.doesNotMatch(JSON.stringify(record),/obscure-known-lender-value-42/);
});

test('public transcript normalizes saved project paths before live events and signing',{timeout:20000},async t=>{
  let privateRoot;
  const options={agent:async dir=>{
    privateRoot=dir;await mkdir(join(dir,'repo/faravan-output'),{recursive:true});await writeFile(join(dir,'repo/faravan-output/report.txt'),'result');
    options.stdout=JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\n'+
      JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Saved '+dir+'/repo/faravan-output/report.txt'}]}})+'\n';
  }};
  const f=await lenderFixture(t,options);launch(f);await until(()=>finished(f),'finished');await f.stop();
  const transcript=f.artifacts.get(f.result.payload.transcript.digest).toString();
  assert.equal(transcript.includes(privateRoot),false,'private prefix never enters the signed transcript');
  assert.equal(f.events.filter(e=>e.status==='transcript').map(e=>e.chunk).join('').includes(privateRoot),false,'live output is normalized too');
  const events=transcript.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const context=events.find(e=>e.type==='faravan.job_context'),summary=events.find(e=>e.type==='assistant').message.content[0].text;
  const {jobOutputWarningVM}=await import('../ui/v1/src/view-models.mjs');
  assert.equal(jobOutputWarningVM(summary,context.workspace_path),'','returned project files never get an outside-project warning');
});
