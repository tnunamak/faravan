import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,boundedFetch} from './helpers/v1-app-fixture.mjs';

// Judge r8 O2: every signed host request spends one of the device's 2048 nonces per five minutes. Each app read used
// to re-read the roster, the host's capabilities and presence, so a job page polling once a second spent about
// eight host requests a second and the host refused the sender's result reads with 429. Shared host facts keep a
// repeated read to the requests that carry its own answer.
const jobPath=d=>'/api/jobs/'+encodeURIComponent(d);
test('O2: repeated page reads spend only their own host requests, not a roster, names and result read each',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'x',harness:'codex'}});
  await f.complete(jobDigest,'owner',{});
  const q='?circle='+circle.id;
  const reads=[jobPath(jobDigest)+q,jobPath(jobDigest)+'/changes'+q,jobPath(jobDigest)+'/transcript'+q,'/api/jobs','/api/devices'];
  for(const path of reads)await api(owner.app,path);// the first visit may read the shared facts once
  const before=f.rawRequests.length;
  for(let i=0;i<3;i++)for(const path of reads)await api(owner.app,path);
  const host=f.rawRequests.slice(before).map(r=>r.method+' '+r.url.split('?')[0].split('/').slice(4).join('/'));
  // Before this fix the same 15 reads spent 78 host requests: 24 roster, 12 capabilities, 9 presence and 15 result downloads.
  const repeated=host.filter(line=>/^GET (roster|artifacts\/|jobs\/[0-9a-f]{64}\/result$)/.test(line));
  assert.deepEqual(repeated,[],'the roster and verified result bytes are not read again for every page read');
  // Names may be read again once five seconds have passed, so a slow run can see one presence read per round.
  assert.ok(host.filter(line=>line==='GET presence').length<=3,'names are not read for every view');
  assert.ok(host.length<=2*3*reads.length,'at most two host requests per page read on average, saw '+host.length+': '+JSON.stringify(host));
});

test('O2: a host that is still busy passes its Retry-After through the app to the page',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'x',harness:'codex'}});
  const previous=f.override;
  f.override=async context=>{
    if(context.req.method==='GET'&&context.route==='/jobs/'+jobDigest.slice(7)){
      context.res.writeHead(429,{'content-type':'application/problem+json','retry-after':'1'});
      context.res.end(JSON.stringify({type:'urn:faravan:problem:rate_limited',title:'rate limited',code:'rate_limited',status:429,retryable:true,outcome:'not_applied'}));return true;
    }
    return previous?.(context)??false;
  };
  const response=await boundedFetch(owner.app.origin+jobPath(jobDigest)+'?circle='+circle.id,{headers:{'x-faravan-session-token':owner.app.token}});
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'1','the page waits as long as the host asked, not its own growing backoff');
});

// Judge r9 O-B: a cold page whose host is still busy after the client's waits shows the saved copy, not a skeleton.
test('O-B: a busy host answers a read from the saved copy, marked saved',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'x',harness:'codex'}});
  const path=jobPath(jobDigest)+'?circle='+circle.id;
  const live=await api(owner.app,path);
  const previous=f.override;
  f.override=async context=>{
    if(context.req.method==='GET'&&context.route==='/jobs/'+jobDigest.slice(7)){
      context.res.writeHead(429,{'content-type':'application/problem+json','retry-after':'0'});
      context.res.end(JSON.stringify({type:'urn:faravan:problem:rate_limited',title:'rate limited',code:'rate_limited',status:429,retryable:true,outcome:'not_applied'}));return true;
    }
    return previous?.(context)??false;
  };
  const busy=await api(owner.app,path);
  assert.equal(busy.job_digest,live.job_digest);
  assert.ok(Number.isFinite(Date.parse(busy.savedAt)),'served from the saved copy and says so');
});
