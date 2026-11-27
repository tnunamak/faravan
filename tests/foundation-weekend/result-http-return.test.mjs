import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appFixture,api} from '../helpers/v1-app-fixture.mjs';
import {resultArchive} from '../helpers/v1-journey.mjs';

const routes=['changes','message','file','result'];
const options={timeout:120000};
const mutations=f=>f.requests.filter(r=>r.method!=='GET'&&r.method!=='HEAD');
const executionCalls=side=>side.backend.calls.filter(([kind])=>['admit','prepare','clone','run','pack','collect'].includes(kind));

async function setup(t) {
  const f=await appFixture(t),connected=await f.connect();
  return {f,...connected};
}
async function completed(ctx,kind='message') {
  const {f,owner,lender,circle}=ctx,id=randomUUID();
  const message='# Verified answer '+id,content='Runtime file '+id+'\n';
  const path='faravan-output/report.md';
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',
    body:{circle:circle.id,prompt:'Return synthetic report '+id,noSource:true,result:{kind}}});
  const candidate=resultArchive(content,path);
  const envelope=await f.complete(jobDigest,'owner',{candidate,output:{kind},
    transcript:JSON.stringify({type:'result',result:message}),receipt:{candidate_format:'tree'}});
  const base='/api/jobs/'+encodeURIComponent(jobDigest),query='?circle='+circle.id;
  // This independent app has its own immutable cache. Establish the actual file DTO and
  // positive route before corruption without warming the requester's artifact/result cache.
  const view=await api(lender.app,base+'/changes'+query);
  assert.equal(view.format,kind);
  assert.equal(view.message.markdown,message);
  const file=view.files.find(row=>row.path===path);
  assert.ok(file,'canonical changes DTO must advertise the runtime archive file');
  assert.equal(file.text,content);
  assert.equal(new URL(file.url,lender.app.origin).searchParams.get('path'),path);
  const urls={changes:base+'/changes'+query,message:view.message.url,file:file.url,result:base+'/result'+query};
  // A separately observed attempt is retained before any adversarial reply.
  const projected=await api(owner.app,base+query);
  assert.equal(projected.state,'result-accepted');
  return {jobDigest,envelope,message,content,candidate,urls,view};
}
async function raw(ctx,url,extra={}) {
  return api(ctx.owner.app,url,{raw:true,status:null,...extra});
}
async function rejected(ctx,job,route,code) {
  const response=await raw(ctx,job.urls[route]);
  assert.ok(response.status>=400,'integrity failure must refuse output, not return 200');
  const text=await response.text(),body=JSON.parse(text);
  assert.notEqual(body.code,'not_found','a missing file is not integrity verification');
  assert.notEqual(body.code,'job_not_found');
  if(code instanceof RegExp)assert.match(body.code,code);else assert.equal(body.code,code);
  assert.ok(!text.includes(job.message)&&!text.includes(job.content),'no returned answer/file bytes escape');
  assert.equal(response.headers.get('content-disposition'),null,'no download headers on verification failure');
}
function attachment(response,type) {
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),type);
  assert.match(response.headers.get('content-disposition'),/^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; sandbox; frame-ancestors 'none'");
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('cache-control'),'no-store');
}

test('signed message/files, runtime downloads and duplicates preserve read-only/security boundaries',options,async t=>{
  const ctx=await setup(t);
  for(const kind of ['message','files']) {
    const job=await completed(ctx,kind);
    const before=mutations(ctx.f).length;
    const backendBefore=[executionCalls(ctx.owner).length,executionCalls(ctx.lender).length];
    const stateBefore=structuredClone(ctx.f.jobs.get(job.jobDigest));
    for(let repeat=0;repeat<2;repeat++) {
      const view=await api(ctx.owner.app,job.urls.changes);
      assert.equal(view.message.markdown,job.message);
      assert.equal(view.files.find(row=>row.path==='faravan-output/report.md').text,job.content);
      const message=await raw(ctx,view.message.url);
      attachment(message,'text/markdown; charset=utf-8');
      assert.equal(await message.text(),job.message);
      const file=await raw(ctx,view.files[0].url);
      attachment(file,'application/octet-stream');
      assert.equal(await file.text(),job.content);
      const bundle=await raw(ctx,job.urls.result);
      assert.equal(bundle.status,200);
      assert.equal(bundle.headers.get('content-type'),'application/zip');
      assert.match(bundle.headers.get('content-disposition'),/^attachment;/);
      const bytes=Buffer.from(await bundle.arrayBuffer());
      assert.equal(bytes.subarray(0,2).toString(),'PK');
    }
    const denied=await raw(ctx,job.urls.file,{token:null});
    assert.equal(denied.status,401);assert.equal((await denied.json()).code,'unauthorized');
    const traversal=new URL(job.urls.file,ctx.owner.app.origin);traversal.searchParams.set('path','../report.md');
    const refused=await raw(ctx,traversal.pathname+traversal.search);
    assert.equal(refused.status,404);assert.equal((await refused.json()).code,'not_found');
    assert.equal(mutations(ctx.f).length,before,'duplicate reads/auth refusal/traversal do not mutate coordinator');
    assert.deepEqual(ctx.f.jobs.get(job.jobDigest),stateBefore);
    assert.deepEqual([executionCalls(ctx.owner).length,executionCalls(ctx.lender).length],backendBefore);
    assert.deepEqual(backendBefore,[0,0],'signed fixture completion never starts an agent/backend');
  }
});

for(const artifact of ['candidate','transcript']) test(artifact+' equal-length corruption is refused by every result route',options,async t=>{
  const ctx=await setup(t);
  for(const route of routes) {
    const job=await completed(ctx),ref=job.envelope.payload[artifact];
    const corrupt=Buffer.from(ctx.f.artifacts.get(ref.digest));
    corrupt[Math.floor(corrupt.length/2)]^=1;
    assert.equal(corrupt.length,ref.bytes);
    ctx.f.artifacts.set(ref.digest,corrupt);
    await rejected(ctx,job,route,'digest_mismatch');
  }
});

test('signed payload tampering is refused by every result route',options,async t=>{
  const ctx=await setup(t);
  for(const route of routes) {
    const job=await completed(ctx);
    ctx.f.jobs.get(job.jobDigest).result.payload.receipt.duration_ms++;
    await rejected(ctx,job,route,/signature/);
  }
});

test('result digest mismatch is refused by every result route',options,async t=>{
  const ctx=await setup(t);
  for(const route of routes) {
    const job=await completed(ctx);
    ctx.f.jobs.get(job.jobDigest).result_digest='sha256:'+'0'.repeat(64);
    await rejected(ctx,job,route,'result_digest_mismatch');
  }
});

test('retained attempt cannot be replaced by a later coordinator reply',options,async t=>{
  const ctx=await setup(t);
  for(const route of routes) {
    const job=await completed(ctx);
    ctx.f.jobs.get(job.jobDigest).current_attempt.generation++;
    await rejected(ctx,job,route,/attempt|generation|executor/);
  }
});

test('interrupted candidate transfer fails closed then retries the same expected binding',options,async t=>{
  const ctx=await setup(t),job=await completed(ctx);
  const original=ctx.f.override,expected=structuredClone(ctx.f.jobs.get(job.jobDigest));
  const route='/artifacts/'+job.envelope.payload.candidate.digest.slice(7);
  let interrupt=true,dropped=0;
  ctx.f.override=async request=>{
    if(interrupt&&request.req.method==='GET'&&request.route===route) {
      dropped++;
      request.res.writeHead(200,{'content-type':'application/octet-stream','content-length':job.candidate.length,
        'faravan-media-type':'application/gzip'});
      request.res.write(job.candidate.subarray(0,Math.max(1,Math.floor(job.candidate.length/2))));
      request.res.destroy();
      return true;
    }
    return original(request);
  };
  try {
    await rejected(ctx,job,'message',/network_error|size_mismatch/);
    assert.ok(dropped>0,'the real candidate transport was interrupted');
    interrupt=false;
    const response=await raw(ctx,job.urls.message);
    attachment(response,'text/markdown; charset=utf-8');
    assert.equal(await response.text(),job.message);
    const file=await raw(ctx,job.urls.file);
    assert.equal(file.status,200);assert.equal(await file.text(),job.content);
    assert.deepEqual(ctx.f.jobs.get(job.jobDigest),expected,'retry never changes or repins expected attempt/result');
    assert.equal(executionCalls(ctx.owner).length,0);
    assert.equal(executionCalls(ctx.lender).length,0);
  } finally {ctx.f.override=original;}
});
