import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {prepareFollowup} from '../lib/v1/followup.mjs';
import {createJobMetaStore} from '../lib/v1/job-meta.mjs';
import {extractArchive} from '../lib/archive.mjs';
import {makeRepo} from './helpers/git-guest.mjs';
const digest='sha256:'+'a'.repeat(64),result='sha256:'+'b'.repeat(64);
const patch=Buffer.from('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+continued\n');
test('follow-up snapshot contains the parent result code and carries only new request outside quoted history',async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const scratch=await mkdtemp(join(tmpdir(),'faravan-followup-test-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{prompt:'Original request',circle:'c',sourcePath:repo.dir});
 const archive=gzipSync(execFileSync('git',['archive','--format=tar','HEAD'],{cwd:repo.dir}));
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'archive',artifact:{}}}},current_attempt:{}}),fetchArtifact:async()=>archive,fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:'text/x-diff'},bytes:patch})};
 const prepared=await prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'Also test empty input',directory:scratch});
 const dest=join(scratch,'unpacked');await extractArchive(prepared.sourceTar,dest);
 assert.equal(await readFile(join(dest,'README.md'),'utf8'),'hello\ncontinued\n');
 assert.equal(await readFile(join(repo.dir,'README.md'),'utf8'),'hello\n','the user checkout is unchanged');
 assert.match(prepared.prompt,/New request:\nAlso test empty input$/);
 assert.equal(prepared.followup.parentResult,result);
 await assert.rejects(prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:'sha256:'+'f'.repeat(64)},delta:'x',directory:scratch}),{code:'followup_result_changed'});
 await assert.rejects(prepareFollowup({client,meta,circle:'other',followup:{parentJob:digest,parentResult:result},delta:'x',directory:scratch}),{code:'not_your_job'});
});
test('local thread links and each observed run/result survive reload',async t=>{
 const scratch=await mkdtemp(join(tmpdir(),'faravan-thread-test-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'First',submittedAt:'2026-01-01'});
 const child='sha256:'+'c'.repeat(64);await meta.record(child,{circle:'c',prompt:'Next',parentJob:digest,parentResult:result,submittedAt:'2026-01-02'});
 await meta.observe(digest,{current_attempt:{attempt_id:'one',generation:1,state:'failed'}});
 await meta.observe(digest,{current_attempt:{attempt_id:'two',generation:2,state:'completed'},result_digest:result});
 const thread=await createJobMetaStore(scratch).thread(child,'c');assert.deepEqual(thread.map(x=>x.job_digest),[child,digest]);
 assert.equal(thread[1].runs.length,2);assert.equal(thread[1].runs[1].result_digest,result);
 assert.deepEqual(await meta.thread(child,'other'),[]);
});
test('a URL-only pinned source fetches the exact commit without needing a local path and preserves export-ignored source',async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const {writeFile}=await import('node:fs/promises');
 await writeFile(join(repo.dir,'.gitattributes'),'kept.txt export-ignore\n');await writeFile(join(repo.dir,'kept.txt'),'still source\n');
 execFileSync('git',['add','.'],{cwd:repo.dir});execFileSync('git',['-c','user.name=Fixture','-c','user.email=x@example.invalid','commit','-qm','export attr'],{cwd:repo.dir});
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo.dir,encoding:'utf8'}).trim();
 const scratch=await mkdtemp(join(tmpdir(),'faravan-url-followup-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'URL-only job'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'git',url:'https://example.invalid/repo.git',commit}}},current_attempt:{}}),fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:'text/x-diff'},bytes:patch})};
 const commands=[];
 const prepared=await prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch,runGit:async(cwd,args,input)=>{
  commands.push(args);const local=[...args];if(local[0]==='fetch')local[3]=repo.dir;
  return execFileSync('git',['-c','core.hooksPath=/dev/null',...local],{cwd,input});
 }});
 const dest=join(scratch,'out');await extractArchive(prepared.sourceTar,dest);
 assert.equal(await readFile(join(dest,'kept.txt'),'utf8'),'still source\n');assert.match(await readFile(join(dest,'README.md'),'utf8'),/continued/);
 assert.ok(commands.some(args=>args[0]==='fetch'&&args.at(-1)===commit));
 await assert.rejects(prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},directory:scratch}),{code:'invalid_request'});
});
test('unsupported symbolic-link snapshots are refused before a follow-up is submitted',async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const {symlink}=await import('node:fs/promises');await symlink('README.md',join(repo.dir,'link'));
 execFileSync('git',['add','.'],{cwd:repo.dir});execFileSync('git',['-c','user.name=Fixture','-c','user.email=x@example.invalid','commit','-qm','link'],{cwd:repo.dir});
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo.dir,encoding:'utf8'}).trim();
 const scratch=await mkdtemp(join(tmpdir(),'faravan-link-followup-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'git job'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'git',url:'https://example.invalid/repo.git',commit}}},current_attempt:{}}),fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:'text/x-diff'},bytes:Buffer.alloc(0)})};
 await assert.rejects(prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch,runGit:async(cwd,args,input)=>{const local=[...args];if(local[0]==='fetch')local[3]=repo.dir;return execFileSync('git',local,{cwd,input,stdio:['pipe','pipe','pipe']});}}),{code:'followup_base_unavailable'});
});
test('a full-tree result supplies its exact returned code without requiring the old source',async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const archive=gzipSync(execFileSync('git',['archive','--format=tar','HEAD'],{cwd:repo.dir}));
 const scratch=await mkdtemp(join(tmpdir(),'faravan-tree-followup-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'tree job'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'archive',artifact:{}}}},current_attempt:{}}),fetchArtifact:()=>{throw new Error('old source should not be read');},fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:'application/gzip'},bytes:archive})};
 const prepared=await prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch});
 const dest=join(scratch,'out');await extractArchive(prepared.sourceTar,dest);assert.equal(await readFile(join(dest,'README.md'),'utf8'),'hello\n');
});
for(const fullTree of [false,true])test(`follow-up preserves ignored parent files from ${fullTree?'full-tree result':'archive source'}`,async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const {mkdir,writeFile}=await import('node:fs/promises');
 await mkdir(join(repo.dir,'dist'));await writeFile(join(repo.dir,'.gitignore'),'dist/\n');await writeFile(join(repo.dir,'dist/schema.json'),'{"retained":true}\n');
 execFileSync('git',['add','--force','.gitignore','dist/schema.json'],{cwd:repo.dir});
 execFileSync('git',['-c','user.name=Fixture','-c','user.email=x@example.invalid','commit','-qm','tracked ignored file'],{cwd:repo.dir});
 const archive=gzipSync(execFileSync('git',['archive','--format=tar','HEAD'],{cwd:repo.dir}));
 const scratch=await mkdtemp(join(tmpdir(),'faravan-ignored-followup-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'Keep schema'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'archive',artifact:{}}}},current_attempt:{}}),fetchArtifact:async()=>archive,fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:fullTree?'application/gzip':'text/x-diff'},bytes:fullTree?archive:Buffer.alloc(0)})};
 const prepared=await prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch});
 const dest=join(scratch,'out');await extractArchive(prepared.sourceTar,dest);
 assert.equal(await readFile(join(dest,'dist/schema.json'),'utf8'),'{"retained":true}\n');
});
for(const fullTree of [false,true])test(`follow-up rejects metadata roots before Git from ${fullTree?'full-tree result':'archive source'}`,async t=>{
 const {createTar}=await import('../lib/tar-writer.mjs');
 const archive=gzipSync(createTar(['HEAD','config','objects/fixture'].map(name=>({name,type:'0',mode:0o644,data:Buffer.from('inert synthetic metadata')}))));
 const scratch=await mkdtemp(join(tmpdir(),'faravan-metadata-followup-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'Continue'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'archive',artifact:{}}}},current_attempt:{}}),fetchArtifact:async()=>archive,fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:fullTree?'application/gzip':'text/x-diff'},bytes:fullTree?archive:Buffer.alloc(0)})};
 let commands=0;
 await assert.rejects(prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch,runGit:async()=>{commands++;throw new Error('Git must not interpret this root');}}),/Git metadata.*source/i);
 assert.equal(commands,0);
});
test('a patch-created metadata root is rejected before snapshot packaging',async t=>{
 const repo=await makeRepo();t.after(()=>rm(repo.dir,{recursive:true,force:true}));
 const archive=gzipSync(execFileSync('git',['archive','--format=tar','HEAD'],{cwd:repo.dir}));
 const patch=Buffer.from(['HEAD','config','objects/fixture'].map(name=>`diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+inert synthetic metadata\n`).join(''));
 const scratch=await mkdtemp(join(tmpdir(),'faravan-metadata-patch-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const meta=createJobMetaStore(scratch);await meta.record(digest,{circle:'c',prompt:'Continue'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'archive',artifact:{}}}},current_attempt:{}}),fetchArtifact:async()=>archive,fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>({candidate:{media_type:'text/x-diff'},bytes:patch})};
 await assert.rejects(prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'next',directory:scratch}),/Git metadata.*source/i);
});

test('no-project continuation needs no returned files, local folder or Git operation',async t=>{
 const home=await mkdtemp(join(tmpdir(),'faravan-empty-followup-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const meta=createJobMetaStore(home);await meta.record(digest,{prompt:'Original question',circle:'c',sourcePath:'/stale/must-not-be-read'});
 const client={getJob:async()=>({state:'result-accepted',result_digest:result,job:{payload:{source:{kind:'none'}}},current_attempt:{}}),fetchTranscript:async()=>Buffer.from(''),fetchResult:async()=>{throw new Error('Must not fetch returned files');},fetchArtifact:async()=>{throw new Error('Must not fetch a source');}};
 const prepared=await prepareFollowup({client,meta,circle:'c',followup:{parentJob:digest,parentResult:result},delta:'One more question',directory:join(home,'unused'),runGit:async()=>{throw new Error('Must not run Git');}});
 assert.equal(prepared.noSource,true);assert.equal(prepared.sourceTar,undefined);assert.equal(prepared.sourcePath,undefined);assert.match(prepared.prompt,/One more question/);
});
