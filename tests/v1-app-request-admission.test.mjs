import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

const jobInput=circle=>({circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
  prompt:'Admission projection fixture',harness:'codex',send_anyway:true});

function localDay(now,timeZone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date(now)).reduce((out,part)=>(out[part.type]=part.value,out),{});
  return parts.year+'-'+parts.month+'-'+parts.day;
}

async function writeCounters(lender,{jobs,milliseconds,timeZone}) {
  const zone=timeZone??(await api(lender.app,'/api/lending')).limits.timeZone;
  await writeFile(join(lender.home,'v1','app-counters.json'),JSON.stringify({
    day:localDay(Date.now(),zone),jobs,milliseconds,pending:null,requesters:{},declined:[],hiddenOffers:[],
  }));
}

async function enableAskLending(lender,circle,{dailyMinutes}) {
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
}

async function setDailyMinutes(lender,dailyMinutes) {
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes,maxWallSeconds:1200,idleOnly:false}});
}

async function waitForCard(lender,jobDigest) {
  return waitFor(async()=>(await api(lender.app,'/api/approvals')).find(card=>card.jobDigest===jobDigest),'matching approval card');
}

test('approval card allows a request when both optional daily caps are unset', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const card=await waitForCard(lender,jobDigest);
  assert.deepEqual(card.requestAdmission,{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
    evidence:{jobCap:null,minuteCap:null}});
});

test('approval card reports a signed request that does not fit raw remaining minutes', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  const wallMilliseconds=f.jobs.get(jobDigest).job.payload.requirements.limits.wall_seconds*1000;
  const dailyMinutes=Math.ceil(wallMilliseconds/60000)+10;
  const limitMilliseconds=dailyMinutes*60000;
  const accountedMilliseconds=limitMilliseconds-wallMilliseconds+1;
  // Discover the real signed request while the lender advertises enough wall
  // time, then lower the cap by one millisecond of remaining budget.
  await enableAskLending(lender,circle,{dailyMinutes:dailyMinutes+1});
  await writeCounters(lender,{jobs:1,milliseconds:accountedMilliseconds});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});

  await waitForCard(lender,jobDigest);
  await setDailyMinutes(lender,dailyMinutes);
  const card=await waitForCard(lender,jobDigest);
  assert.deepEqual(card.requestAdmission,{schemaVersion:2,kind:'request-admission',admission:'blocked',
    reasonCode:'request_does_not_fit',evidence:{jobCap:{used:1,limit:3},minuteCap:{used:Math.round(accountedMilliseconds/60000),
      limit:dailyMinutes,usedMilliseconds:accountedMilliseconds,limitMilliseconds,requestedMilliseconds:wallMilliseconds}}});
  assert.ok(accountedMilliseconds/60000<dailyMinutes,'rounded display usage stays below the cap');
  assert.equal(accountedMilliseconds+wallMilliseconds,limitMilliseconds+1,'the signed wall time exceeds the exact remaining budget by one millisecond');
});

test('approval card allows a signed request that exactly fits raw remaining minutes', {timeout:60000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  const wallMilliseconds=f.jobs.get(jobDigest).job.payload.requirements.limits.wall_seconds*1000;
  const dailyMinutes=Math.ceil(wallMilliseconds/60000)+10;
  const limitMilliseconds=dailyMinutes*60000;
  const accountedMilliseconds=limitMilliseconds-wallMilliseconds;
  await enableAskLending(lender,circle,{dailyMinutes});
  await writeCounters(lender,{jobs:1,milliseconds:accountedMilliseconds});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});

  const card=await waitForCard(lender,jobDigest);
  assert.deepEqual(card.requestAdmission,{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
    evidence:{jobCap:{used:1,limit:3},minuteCap:{used:Math.round(accountedMilliseconds/60000),limit:dailyMinutes,
      usedMilliseconds:accountedMilliseconds,limitMilliseconds,requestedMilliseconds:wallMilliseconds}}});
  assert.equal(accountedMilliseconds+wallMilliseconds,limitMilliseconds);
});

test('next approval GET reflects changed daily limits and durable usage', {timeout:90000}, async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  const first=await api(owner.app,'/api/jobs',{method:'POST',body:jobInput(circle)});
  const wallMilliseconds=f.jobs.get(first.jobDigest).job.payload.requirements.limits.wall_seconds*1000;
  const dailyMinutes=Math.ceil(wallMilliseconds/60000)+10;
  const firstUsage=dailyMinutes*60000-wallMilliseconds+1;
  await enableAskLending(lender,circle,{dailyMinutes:dailyMinutes+1});
  await writeCounters(lender,{jobs:1,milliseconds:firstUsage});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});

  await waitForCard(lender,first.jobDigest);
  await setDailyMinutes(lender,dailyMinutes);
  const firstCard=await waitForCard(lender,first.jobDigest);
  assert.equal(firstCard.requestAdmission.admission,'blocked');
  assert.equal(firstCard.requestAdmission.reasonCode,'request_does_not_fit');
  await api(lender.app,'/api/approvals/'+firstCard.id+'/skip',{method:'POST',body:{}});
  await waitFor(async()=>(await api(lender.app,'/api/lending')).current===null,'skipped reservation released');

  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:dailyMinutes+10,maxWallSeconds:1200,idleOnly:false}});
  const timeZone=(await api(lender.app,'/api/lending')).limits.timeZone;
  await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
  await lender.app.close();
  const newUsage=900000;
  await writeCounters(lender,{jobs:2,milliseconds:newUsage,timeZone});
  const second=await api(owner.app,'/api/jobs',{method:'POST',body:{...jobInput(circle),prompt:'Updated admission snapshot'}});
  const restarted=await f.start('lender');
  await api(restarted.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});

  const updated=await waitForCard(restarted,second.jobDigest);
  const updatedLimit=dailyMinutes+10;
  assert.deepEqual(updated.requestAdmission,{schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
    evidence:{jobCap:{used:2,limit:3},minuteCap:{used:Math.round(newUsage/60000),limit:updatedLimit,
      usedMilliseconds:newUsage,limitMilliseconds:updatedLimit*60000,requestedMilliseconds:wallMilliseconds}}});
  assert.equal((await readFile(join(restarted.home,'v1','app-settings.json'),'utf8')).includes('"dailyMinutes":'+updatedLimit),true);
});
