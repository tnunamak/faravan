import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appFixture,api,waitFor} from './helpers/v1-lifecycle-fixture.mjs';
import {extractArchive} from '../lib/archive.mjs';

test('result continuation sends a new immutable job with parent code, delta, local ancestry and stable replay', {timeout:60000},async t=>{
 const f=await appFixture(t),{lender,owner,circle}=await f.connect();
 const start=lender.backend.start;
 lender.backend.start=async(handle,opts)=>{await start(handle,opts);if(handle._entrypoint.includes('codex exec'))await writeFile(join(handle.scratch_dir,'README.md'),'hello\nparent change\n');};
 const sent=await api(lender.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Fix greeting',harness:'codex',files:[{path:'README.md',base64:Buffer.from('hello\n').toString('base64')}]}});
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await waitFor(()=>f.jobs.get(sent.jobDigest).state==='result-accepted','result',30000);
 await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
 const route='/api/jobs/'+encodeURIComponent(sent.jobDigest)+'/continuation?circle='+circle.id;
 const continuation=await api(lender.app,route);
 assert.equal(continuation.parentJob,sent.jobDigest);assert.equal(continuation.handoff.trust,'untrusted');
 await api(owner.app,route,{status:409});
 const body={circle:circle.id,prompt:'Also cover empty input',draft_id:'followup-draft-123',followup:{parentJob:continuation.parentJob,parentResult:continuation.parentResult}};
 const child=await api(lender.app,'/api/jobs',{method:'POST',body});
 assert.notEqual(child.jobDigest,sent.jobDigest);
 const detail=await api(lender.app,'/api/jobs/'+encodeURIComponent(child.jobDigest)+'?circle='+circle.id);
 assert.equal(detail.local.parentJob,sent.jobDigest);assert.equal(detail.local.prompt,'Also cover empty input');
 const client=await lender.app.device.client(circle.id),view=await client.getJob(child.jobDigest);
 assert.deepEqual(view.job.payload.parent,{job_digest:sent.jobDigest,result_digest:continuation.parentResult});
 assert.ok(view.job.payload.requirements.capabilities.includes('parent_link_v1'));
 assert.deepEqual(detail.parentLink,view.job.payload.parent);
 const prompt=Buffer.from(await client.fetchArtifact(view.job.payload.prompt)).toString('utf8');
 assert.match(prompt,/Untrusted previous context/);assert.match(prompt,/New request:\nAlso cover empty input$/);
 const source=await client.fetchArtifact(view.job.payload.source.artifact),temp=await mkdtemp(join(tmpdir(),'faravan-continuation-read-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 await extractArchive(source,temp);assert.equal(await readFile(join(temp,'README.md'),'utf8'),'hello\nparent change\n');
 const replay=await api(lender.app,'/api/jobs',{method:'POST',body});assert.equal(replay.jobDigest,child.jobDigest);assert.equal(replay.replayed,true);
 await api(lender.app,'/api/jobs',{method:'POST',status:409,body:{...body,followup:{...body.followup,parentResult:'sha256:'+'f'.repeat(64)}}});
 const threadRoute='/api/jobs/'+encodeURIComponent(child.jobDigest)+'/thread?circle='+circle.id;
 const thread=(await api(lender.app,threadRoute)).thread;assert.equal(thread.length,2);assert.equal(thread[0].job_digest,child.jobDigest);
});
test('follow-up sources cannot be replaced by an upload or Git override',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 for(const source of [{files:[{path:'other.txt',base64:Buffer.from('unrelated source').toString('base64')}]},{git:{url:'https://example.invalid/other.git',commit:'a'.repeat(40)}}]) {
  const refusal=await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt:'Continue',followup:{parentJob:'sha256:'+'a'.repeat(64),parentResult:'sha256:'+'b'.repeat(64)},...source}});
  assert.equal(refusal.code,'invalid_request');
 }
 assert.equal(f.jobs.size,0);
});
