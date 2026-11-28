import './helpers/no-browser.mjs';
import test from 'node:test';
import {fixtureAccounts,fixtureAccountOffers} from './helpers/run-request-fixture.mjs';
import assert from 'node:assert/strict';
import {appFixture,api,bounded} from './helpers/v1-app-fixture.mjs';
import {canonicalize} from '../lib/protocol/index.mjs';
import {homePeopleVM} from '../ui/v1/src/view-models.mjs';

// O-H: the circle roster and the job status contract must read the same presence, so a lender the waiting-job line
// sees as active is never shown as "No recent report" on the host's circle page.
function reportPresence(f,lender,fields) {
  f.override=async ctx=>{
    if(ctx.route!=='/presence')return false;
    const devices=fields?[{device:lender.app.device.keyId,source:'heartbeat',capabilities:['run_request_v1'],account_offers:fixtureAccountOffers(),...fields}]:[];
    const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices,persons:[]}));
    ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
  };
}
const memberOf=async (owner,circle,lender)=>(await api(owner.app,'/api/devices')).circles.find(c=>c.circle===circle.id).members.find(m=>m.key_id===lender.app.device.keyId);

test('the host roster shows a lender with a recent heartbeat as online and ready',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const heartbeat=new Date().toISOString();
  reportPresence(f,lender,{online:true,last_heartbeat_at:heartbeat,intent:{state:'ready'}});
  const devices=await api(owner.app,'/api/devices');
  const members=devices.circles.find(row=>row.circle===circle.id).members;
  const member=members.find(row=>row.key_id===lender.app.device.keyId);
  assert.equal(member.online,true);assert.equal(member.ready,true);
  assert.deepEqual(member.presence,{source:'heartbeat',last_heartbeat_at:heartbeat,last_poll_at:null,state:'ready'});
  assert.equal(members.find(row=>row.key_id===owner.app.device.keyId).presence,undefined);
  assert.match(homePeopleVM(members,{ownId:devices.fingerprint})[0].state,/Lending now$/);
});

test('a new signed roster refreshes Home and queued presence for the same circle',{timeout:120000},async t=>{
  const at=Date.now(),clock={now:()=>at};
  const f=await appFixture(t),{owner,lender,circle}=await f.connect({clock},{clock});
  const heartbeat={online:true,last_heartbeat_at:new Date(at).toISOString()};
  reportPresence(f,lender,{...heartbeat,intent:{state:'ready'}});
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,
    git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Wait for the current lender',harness:'codex',send_anyway:true}});
  const read=async()=>{
    const member=await memberOf(owner,circle,lender);
    const job=await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'?circle='+circle.id);
    assert.equal(job.state,'queued');
    return {ready:member.ready,readyCount:job.offerWaiting?.readyCount,dailyLimitCount:job.offerWaiting?.dailyLimitCount};
  };
  assert.deepEqual(await read(),{ready:true,readyCount:1,dailyLimitCount:0});
  const before=await owner.app.device.selectCircle(circle.id);
  const newcomer=await f.start('newcomer',{clock});
  const circlePath='/api/circles/'+circle.id;
  const {invite}=await api(owner.app,circlePath+'/invite',{method:'POST',body:{}});
  await api(newcomer.app,'/api/circles/join',{method:'POST',body:{link:invite}});
  await api(owner.app,circlePath+'/approve',{method:'POST',body:{}});
  await newcomer.app.device.refreshRoster(circle.id);
  const next=await owner.app.device.selectCircle(circle.id);
  assert.deepEqual([next.id,next.origin,next.pinnedRootFingerprint],[before.id,before.origin,before.pinnedRootFingerprint]);
  assert.notEqual(next.rosterDigest,before.rosterDigest);
  reportPresence(f,lender,{...heartbeat,intent:{state:'resting',reason:'daily_limit'}});
  assert.deepEqual(await read(),{ready:false,readyCount:0,dailyLimitCount:1});
});

test('the host roster does not call a lender online when its last report is stale',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const heartbeat=new Date(Date.now()-300000).toISOString();
  reportPresence(f,lender,{online:true,last_heartbeat_at:heartbeat,intent:{state:'ready'}});
  const member=await memberOf(owner,circle,lender);
  assert.equal(member.online,false);
  assert.deepEqual(member.presence,{source:'heartbeat',last_heartbeat_at:heartbeat,last_poll_at:null});
  assert.match(homePeopleVM([member])[0].state,/Last seen /);
});

test('the host roster shows a lender who is done for today as online but not ready',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  reportPresence(f,lender,{online:true,last_heartbeat_at:new Date().toISOString(),intent:{state:'resting',reason:'daily_limit'}});
  const done=await memberOf(owner,circle,lender);
  assert.equal(done.online,true);assert.equal(done.ready,false);
});
// The roster reads one presence page per circle for a few seconds, so each case below is its own app.
test('the host roster says when a computer joined and that it has not reported yet',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  reportPresence(f,lender,null);
  const member=await memberOf(owner,circle,lender);
  assert.equal(member.reported,false,'the presence page was read and holds no entry for this computer');
  assert.ok(Math.abs(Date.now()-Date.parse(member.joinedAt))<120000,'joinedAt is when the roster that added it was issued');
});

test('the host roster marks a computer with a presence entry as having reported',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  reportPresence(f,lender,{online:true,last_heartbeat_at:new Date().toISOString(),intent:{state:'ready'}});
  assert.equal((await memberOf(owner,circle,lender)).reported,true);
});

test('an unreadable presence page claims nothing about whether a computer has reported',{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  f.override=async ctx=>{if(ctx.route!=='/presence')return false;ctx.res.writeHead(503,{'content-type':'application/json'});ctx.res.end('{}');return true;};
  assert.equal(Object.hasOwn(await memberOf(owner,circle,lender),'reported'),false);
});

test('real coordinator fresh joined member with Lending Off has source none and joined availability',{timeout:30000},async t=>{
 const {memberAvailability}=await import('../ui/v1/src/circles-view.mjs');
 const f=await appFixture(t),{owner,lender,circle}=await f.realConnect();
 assert.equal((await api(lender.app,'/api/lending')).enabled,false);
 const raw=await (await owner.app.device.client(circle.id)).fetchPresence();
 const row=raw.devices.find(d=>d.device===lender.app.device.keyId);
 assert.equal(row.source,'none',JSON.stringify(row));assert.equal(row.last_heartbeat_at,null);assert.equal(row.last_poll_at,null);
 const member=await memberOf(owner,circle,lender);
 assert.equal(member.reported,false,'roster enumeration is not a presence report');
 assert.equal(member.online,false);
 assert.match(memberAvailability(member,{now:Date.now(),zone:'UTC'}).word,/^Joined .*not lending yet$/);
});
test('stale poll evidence still means reported even when store source becomes none',{timeout:30000},async t=>{
 const f=await appFixture(t),{owner,lender,circle}=await f.connect();
 reportPresence(f,lender,{source:'none',online:false,last_heartbeat_at:null,last_poll_at:new Date(Date.now()-300000).toISOString()});
 assert.equal((await memberOf(owner,circle,lender)).reported,true);
});

for (const source of ['heartbeat','poll']) test('Compose discloses a lender only with current lending evidence: '+source,{timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const at=Date.now();
  reportPresence(f,lender,{source,online:true,last_poll_at:new Date(at).toISOString(),
    last_heartbeat_at:new Date(at-(source==='poll'?300000:0)).toISOString(),intent:{state:'ready'},
    agents:[{adapter:'codex',readiness:'ready'}]});
  const compose=await api(owner.app,'/api/circles/'+circle.id+'/compose');
  assert.equal(compose.host.reachable,true);
  const member=await memberOf(owner,circle,lender);
  assert.equal(member.online,true);
  assert.equal(member.ready,source==='heartbeat');
  assert.equal(member.presence.source,source);
  assert.equal(member.presence.last_poll_at,new Date(at).toISOString());
  assert.equal(member.presence.state,source==='heartbeat'?'ready':undefined);
  assert.match(homePeopleVM([member])[0].state,source==='heartbeat'?/Lending now$/:/Online$/);
  assert.deepEqual(compose.lenders.map(row=>[row.keyId,row.state,row.agents]),source==='heartbeat'?
    [[lender.app.device.keyId,'ready',[{adapter:'codex',readiness:'ready'}]]]:[]);
});

test('overlapping cold job details share the same circle presence read',{timeout:30000},async t=>{
 const seconds=Math.floor(Date.now()/1000),clock=()=>seconds;
 const f=await appFixture(t),{owner,lender,circle}=await f.connect({clock,pollMs:60_000},{clock,pollMs:60_000});
 const lenderKey=lender.app.device.keyId,client=await lender.app.device.client(circle.id);
 const digests=[];
 for (const label of ['First','Second']) {
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,
   git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:label+' overlapping synthetic request',harness:'codex',send_anyway:true}});
  const limits=f.jobs.get(jobDigest).job.payload.requirements.limits;
  const claim=await client.claimNext({harnesses:['codex'],models:['example-model'],capabilities:['filtered_git_v1','run_request_v1'],accounts:fixtureAccounts(),
   egress:['internet','provider-only'],enforced_limits:Object.keys(limits),max_limits:limits},{waitSeconds:0});
  assert.equal(claim.job_digest,jobDigest);
  digests.push(jobDigest);
 }
 // Claimed, pre-execution jobs each need the same waiting facts. Distinct IDs
 // let the coordinator fixture witness entry of the second public read.
 const secondRoute='/jobs/'+digests[1].slice('sha256:'.length);
 const firstPresence=Promise.withResolvers(),secondEntry=Promise.withResolvers(),reply=Promise.withResolvers();
 const base=f.override,started=[];
 let presenceCalls=0,secondStarted=false;
 f.override=async ctx=>{
  if (ctx.circleId!==circle.id||ctx.req.headers['x-test-device']!=='owner') return base(ctx);
  if (secondStarted&&ctx.req.method==='GET'&&ctx.route===secondRoute) secondEntry.resolve();
  if (ctx.route!=='/presence') return base(ctx);
  presenceCalls++;firstPresence.resolve();
  await reply.promise;
  if (!ctx.res.destroyed) {
   const bytes=Buffer.from(canonicalize({now:new Date(seconds*1000).toISOString(),online_seconds:90,
    devices:[{device:lenderKey,online:true,source:'heartbeat',last_heartbeat_at:new Date(seconds*1000).toISOString(),
      intent:{state:'ready'},capabilities:['offers_v1','run_request_v1'],account_offers:fixtureAccountOffers()}],persons:[]}));
   ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);
  }
  return true;
 };
 const detail=digest=>{
  const request=api(owner.app,'/api/jobs/'+encodeURIComponent(digest)+'?circle='+circle.id);
  started.push(request);
  void request.catch(()=>{});
  return request;
 };
 try {
  const first=detail(digests[0]);
  await bounded(firstPresence.promise,'the first cold detail reaches presence');
  secondStarted=true;
  const second=detail(digests[1]);
  await bounded(secondEntry.promise,'the second detail reaches its own job read while presence is held');
  assert.equal(presenceCalls,1);
  reply.resolve();
  const views=await Promise.all([first,second]);
  const expected={readyCount:1,dailyLimitCount:0,dailyLimitDevices:[],dailyLimitNames:[],deciding:null,approval:'approved'};
  for (const [index,view] of views.entries()) {
   assert.equal(view.job_digest,digests[index]);
   assert.equal(view.current_attempt.holder,lenderKey);
   assert.deepEqual(view.offerWaiting,expected);
  }
  assert.equal(presenceCalls,1,'both projections use one coordinator presence response');
 } finally {
  reply.resolve();
  await Promise.allSettled(started);
  f.override=base;
 }
});

// A slow presence read does not make the signed roster or its count stale.
test('a stalled presence read does not hold /api/devices or mark the roster last known',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Second circle'}});
  const stalled=circle.id;
  const timers=new Set();t.after(()=>timers.forEach(clearTimeout));
  f.override=async ctx=>{
    if(ctx.route!=='/presence')return false;
    if(ctx.circleId===stalled) {
      // Never answers within the test's budget.
      await new Promise(resolve=>{const timer=setTimeout(resolve,15000);timers.add(timer);});
      ctx.res.writeHead(504);ctx.res.end();return true;
    }
    const bytes=Buffer.from(canonicalize({now:new Date().toISOString(),online_seconds:90,devices:[{device:owner.app.device.keyId,source:'heartbeat',online:true,last_heartbeat_at:new Date().toISOString(),intent:{state:'ready'}}],persons:[]}));
    ctx.res.writeHead(200,{'content-type':'application/json','content-length':bytes.length});ctx.res.end(bytes);return true;
  };
  const started=Date.now();
  const devices=await api(owner.app,'/api/devices');
  const elapsed=Date.now()-started;
  assert.ok(elapsed<4000,'devices read took '+elapsed+' ms');
  const healthy=devices.circles.find(c=>c.circle===second.id),slow=devices.circles.find(c=>c.circle===stalled);
  assert.equal(healthy.membersLastKnown,undefined);
  assert.equal(healthy.members.find(m=>m.key_id===owner.app.device.keyId).online,true);
  assert.equal(slow.membersLastKnown,undefined,'a presence timeout must not warn about the member count');
  assert.equal(slow.presenceTimedOut,true);
  assert.ok(slow.rosterHeld&&slow.members.length>=2,'the stalled circle keeps its held roster');
  assert.equal(slow.members.find(m=>m.key_id===lender.app.device.keyId).online,undefined,'no presence is claimed for the stalled circle');
});
