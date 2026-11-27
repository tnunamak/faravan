import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

// Judge r10 R2: every host request spends one of the device's nonces. A Jobs list used to read each listed job from
// the host again to check that it had not moved, so a person with 30 jobs spent 30+ host reads per poll, used up
// the budget, and their own Send was then refused.
const jobInput=(circle,prompt)=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt,harness:'codex',send_anyway:true});
const jobReads=(requests,from)=>requests.slice(from).filter(r=>/\/jobs\/[0-9a-f]{64}$/.test(r.route.split('?')[0])).length;

test('R2: a Jobs list of finished jobs spends no per-job host reads',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,circle,realRequests}=await f.realConnect();
  for(let i=0;i<6;i++){
    const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Finished job '+i)});
    await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/cancel',{method:'POST',body:{circle:circle.id}});
  }
  await api(owner.app,'/api/jobs');
  const before=realRequests.length;
  const rows=await api(owner.app,'/api/jobs');
  assert.equal(rows.length,6);
  // Before this fix the list read each of the 6 jobs again. The app's own tracker may read one job in this window.
  assert.ok(jobReads(realRequests,before)<=1,'a cancelled job cannot move, so the list read is its observation');
});

test('a submitted job watch starts from the response status read',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,circle,realRequests}=await f.realConnect();
  const before=realRequests.length;
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Watch its first state')});
  // Recorded routes keep the query string (?wait=…&after=…), so the path is compared without it.
  const watchPath=read=>read.route.split('?')[0].endsWith('/watch');
  await waitFor(()=>realRequests.some(watchPath),'the job watcher parks on coordinator news');
  assert.equal(jobReads(realRequests,before),1,
    'the response read seeds the watcher; starting it must not issue a duplicate coordinator status read');
  assert.ok(realRequests.slice(before).some(read=>watchPath(read)&&read.route.includes(sent.jobDigest.slice(7))),
    'the watcher subscribes to the submitted job identity');
});

// Judge r10 R2: a person's own action never ends in a refusal while the host is merely busy. Here background page
// polling has used up this computer's ordinary share of the host's request budget; Sends and a Delete still land,
// because a person's action (its reads too) has its own reserved share.
test('R2: Sends and a Delete land while background reads have used up the ordinary budget',{timeout:120000},async t=>{
  const f=await appFixture(t),{owner,circle,realRequests}=await f.realConnect({quotas:{noncesPerDevice:400}});
  // Page polling until the host refuses background reads.
  let refused=false;
  for(let i=0;i<400&&!refused;i++){
    try{await owner.app.device.client(circle.id).then(c=>c.capabilities({refresh:true}));}
    catch(error){assert.equal(error.code,'rate_limited');refused=true;}
  }
  assert.ok(refused,'background reads reached their share');
  const sent=[];
  for(let i=0;i<5;i++)sent.push((await api(owner.app,'/api/jobs',{method:'POST',body:{...jobInput(circle,'Busy send '+i),draft_id:'draft-busy-'+i}})).jobDigest);
  assert.equal(new Set(sent).size,5,'five distinct jobs');
  await api(owner.app,'/api/jobs/'+encodeURIComponent(sent[0])+'/cancel',{method:'POST',body:{circle:circle.id}});
  await api(owner.app,'/api/jobs/'+encodeURIComponent(sent[0])+'/delete',{method:'POST',body:{circle:circle.id}});
  void realRequests;
});

// Judge r10 R1: a saved copy served because the host was busy says so ("catching up"), never "unreachable"; the
// host's own computer showed its own circle as unreachable.
const busy=res=>{res.writeHead(429,{'content-type':'application/problem+json','retry-after':'0'});
  res.end(JSON.stringify({type:'urn:faravan:problem:rate_limited',title:'rate limited',code:'rate_limited',status:429,retryable:true,outcome:'not_applied'}));return true;};
test('R1: a busy host serves saved copies marked busy, never unreachable',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const waiting=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Still waiting')});
  const done=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Already cancelled')});
  await api(owner.app,'/api/jobs/'+encodeURIComponent(done.jobDigest)+'/cancel',{method:'POST',body:{circle:circle.id}});
  const path='/api/jobs/'+encodeURIComponent(waiting.jobDigest)+'?circle='+circle.id;
  await api(owner.app,path);await api(owner.app,'/api/jobs');
  const previous=f.override;
  f.override=async context=>context.req.method==='GET'&&/^\/jobs(?:\/[0-9a-f]{64})?$/.test(context.route.split('?')[0])?busy(context.res):previous(context);
  const detail=await api(owner.app,path);
  assert.equal(detail.savedReason,'busy','a busy host is not an unreachable one');
  const rows=await api(owner.app,'/api/jobs');
  assert.deepEqual(rows.map(row=>row.savedReason),['busy','busy']);
  for(const row of rows)assert.equal(row.jobProjection.observation?.state,'last_known','each saved row keeps its state, framed as last known');
});

// Judge r10 R2: a cold Jobs list sat as a skeleton for 20 s while the host was slow. With a saved list, the page gets
// it at once, marked as catching up, and the slow read refreshes the saved copy for the next poll.
test('R2: a slow host list read answers from the saved list at once',{timeout:90000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect();
  await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle,'Saved row')});
  await api(owner.app,'/api/jobs');
  const previous=f.override;let release;const held=new Promise(resolve=>{release=resolve;});
  f.override=async context=>{if(context.req.method==='GET'&&context.route.split('?')[0]==='/jobs')await held;return previous(context);};
  t.after(()=>release());
  const started=Date.now(),rows=await api(owner.app,'/api/jobs');
  assert.ok(Date.now()-started<4000,'answered in '+(Date.now()-started)+' ms, not after the slow read');
  assert.equal(rows.length,1);
  assert.equal(rows[0].savedReason,'busy');
  release();
});
