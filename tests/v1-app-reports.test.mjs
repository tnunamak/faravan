import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {appFixture,api,boundedFetch} from './helpers/v1-app-fixture.mjs';
import {pngOf} from './helpers/raster-fixtures.mjs';
const prompt='Research rain gardens and cite sources';
async function returned(t,{outside=false,large=false,bomb=false}={}){const root=await mkdtemp(join(tmpdir(),'app-reports-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'faravan-output'));await writeFile(join(root,'faravan-output/report.md'),'# Findings\n\nRain gardens capture runoff.');await writeFile(join(root,'faravan-output/data.csv'),'a,b\n1,2');await writeFile(join(root,'faravan-output/pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));if(outside)await writeFile(join(root,'unexpected.js'),'hidden');if(large)await writeFile(join(root,'faravan-output/large.csv'),Buffer.alloc(20*1024*1024,65));if(bomb)await writeFile(join(root,'faravan-output/pixel.png'),pngOf(12000,12000));return execFileSync('tar',['-czf','-','.'],{cwd:root});}
test('prompt-only report goes through signed submission, report reader API, and individual/all downloads',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,noSource:true,result:{kind:'message'}}});
 const base='/api/jobs/'+encodeURIComponent(jobDigest),query='?circle='+circle.id;
 const projected=await api(owner.app,base+query);assert.equal(projected.sourceKind,'none');assert.equal(projected.resultKind,'message');
 const job=f.jobs.get(jobDigest);assert.deepEqual(job.job.payload.source,{kind:'none'});assert.deepEqual(job.job.payload.result,{kind:'message'});
 await f.complete(jobDigest,'owner',{candidate:await returned(t),output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'# Findings\n\nRain gardens capture runoff.'}),receipt:{candidate_format:'tree'}});
 const view=await api(owner.app,base+'/changes'+query);assert.equal(view.format,'message');assert.match(view.message.markdown,/# Findings/);assert.equal(view.files.length,3);
 const file=await boundedFetch(owner.app.origin+base+'/file'+query+'&path=faravan-output%2Freport.md',{headers:{'x-faravan-session-token':owner.app.token}});
 assert.equal(file.status,200);assert.match(file.headers.get('content-disposition'),/attachment; filename="report.md"/);assert.match(await file.text(),/# Findings/);
 const image=await boundedFetch(owner.app.origin+base+'/image'+query+'&path=faravan-output%2Fpixel.png',{headers:{'x-faravan-session-token':owner.app.token}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal((await image.arrayBuffer()).byteLength,68);
 const message=await boundedFetch(owner.app.origin+base+'/message'+query,{headers:{'x-faravan-session-token':owner.app.token}});assert.equal(message.status,200);assert.match(await message.text(),/# Findings/);
 const bundle=await boundedFetch(owner.app.origin+base+'/result'+query,{headers:{'x-faravan-session-token':owner.app.token}});assert.equal(bundle.status,200);assert.equal(bundle.headers.get('content-type'),'application/zip');
 const unavailable=await boundedFetch(owner.app.origin+base+'/file'+query+'&path=..%2Freport.md',{headers:{'x-faravan-session-token':owner.app.token}});assert.equal(unavailable.status,404);
});
test('app rejects ambiguous sources before packaging local files',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt,noSource:true,repo:{path:'/must-not-be-read'},result:{kind:'message'}}});
});

test('the whole-result route refuses a signed typed tree with hidden root files',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,noSource:true,result:{kind:'message'}}});
 await f.complete(jobDigest,'owner',{candidate:await returned(t,{outside:true}),output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'Answer'}),receipt:{candidate_format:'tree'}});
 const response=await boundedFetch(owner.app.origin+'/api/jobs/'+encodeURIComponent(jobDigest)+'/result?circle='+circle.id,{headers:{'x-faravan-session-token':owner.app.token}});
 assert.notEqual(response.status,200);assert.equal((await response.json()).code,'path_traversal');
});
test('a large attachment leaves the final Markdown readable and downloadable',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,noSource:true,result:{kind:'message'}}});
 await f.complete(jobDigest,'owner',{candidate:await returned(t,{large:true}),output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'# Complete answer'}),receipt:{candidate_format:'tree'}});
 const base='/api/jobs/'+encodeURIComponent(jobDigest),q='?circle='+circle.id;
 const view=await api(owner.app,base+'/changes'+q);assert.equal(view.message.markdown,'# Complete answer');
 const attachment=view.files.find(file=>file.path.endsWith('large.csv'));assert.equal(attachment.download_only,true);assert.equal(attachment.text,undefined);
 const response=await boundedFetch(owner.app.origin+base+'/message'+q,{headers:{'x-faravan-session-token':owner.app.token}});
 assert.equal(response.status,200);assert.equal(await response.text(),'# Complete answer');
});
test('a typed image with excessive dimensions is downloadable but never advertised or served inline',async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,noSource:true,result:{kind:'message'}}});
 await f.complete(jobDigest,'owner',{candidate:await returned(t,{bomb:true}),output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'Image'}),receipt:{candidate_format:'tree'}});
 const base='/api/jobs/'+encodeURIComponent(jobDigest),q='?circle='+circle.id;
 const view=await api(owner.app,base+'/changes'+q),image=view.files.find(file=>file.path.endsWith('pixel.png'));
 assert.equal(image.preview,undefined);assert.equal(image.download_only,true);
 const response=await boundedFetch(owner.app.origin+base+'/image'+q+'&path=faravan-output%2Fpixel.png',{headers:{'x-faravan-session-token':owner.app.token}});
 assert.equal(response.status,404);await response.json();
 const file=await boundedFetch(owner.app.origin+image.url,{headers:{'x-faravan-session-token':owner.app.token}});assert.equal(file.status,200);assert.equal((await file.arrayBuffer()).byteLength,45);
});

for (const kind of ['message','files']) test(`a ${kind} no-project follow-up stays empty and retains its local ancestry`,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const {jobDigest:parent}=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt,noSource:true,result:{kind}}});
 await f.complete(parent,'owner',{candidate:await returned(t),output:{kind},transcript:JSON.stringify({type:'result',result:'# Original answer'}),receipt:{candidate_format:'tree'}});
 const query='?circle='+circle.id,base='/api/jobs/'+encodeURIComponent(parent);
 const context=await api(owner.app,base+'/continuation'+query);
 assert.equal(context.sourceKind,'none');
 const parentResult=f.jobs.get(parent).result_digest;
 const body={circle:circle.id,prompt:'Explain the next step',draft_id:'no-project-followup-'+kind,followup:{parentJob:parent,parentResult}};
 const before=f.requests.filter(r=>r.method==='PUT'&&r.route.startsWith('/artifacts/')).length;
 const {jobDigest:child}=await api(owner.app,'/api/jobs',{method:'POST',body});
 const payload=f.jobs.get(child).job.payload;
 assert.deepEqual(payload.source,{kind:'none'});assert.deepEqual(payload.result,{kind:'message'});
 assert.deepEqual(payload.requirements.capabilities,['results_v1','parent_link_v1']);
 assert.equal(f.requests.filter(r=>r.method==='PUT'&&r.route.startsWith('/artifacts/')).length-before,1,'only the follow-up prompt is uploaded');
 const view=await api(owner.app,'/api/jobs/'+encodeURIComponent(child)+query);
 assert.equal(view.local.parentJob,parent);assert.equal(view.local.parentResult,parentResult);assert.equal(view.local.prompt,body.prompt);
 const replay=await api(owner.app,'/api/jobs',{method:'POST',body});assert.equal(replay.jobDigest,child);assert.equal(replay.replayed,true);
 const thread=await api(owner.app,'/api/jobs/'+encodeURIComponent(child)+'/thread'+query);assert.equal(thread.thread.length,2);
 const explicit=await api(owner.app,'/api/jobs',{method:'POST',body:{...body,draft_id:'explicit-followup-'+kind,noSource:true}});
 assert.deepEqual(f.jobs.get(explicit.jobDigest).job.payload.source,{kind:'none'});
 assert.deepEqual(f.jobs.get(explicit.jobDigest).job.payload.result,{kind:'message'});
});
