import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {countJobs, countMemberHomeJobs, readRealJobs} from '../scripts/bar-real-jobs.mjs';

const since='2026-11-01T00:00:00Z';
const jobs=(n=20)=>Array.from({length:n},(_,i)=>({job_digest:`job-${i}`,state:'result-accepted',current_attempt:{claimed_at:'2026-11-02T00:00:00Z',execution_observed_at:'2026-11-02T00:01:30Z'}}));
test('only finished member-home jobs since publication count for the real owner-offline path',()=>{
  const owner={...jobs(1)[0],jobHome:{origin:'https://owner.test',ownerOrigin:'https://owner.test'}},
    member={...owner,jobHome:{origin:'https://member.test',ownerOrigin:'https://owner.test'}};
  assert.equal(countMemberHomeJobs([owner],since).pass,false);
  assert.equal(countMemberHomeJobs([{...member,state:'failed'}],since).pass,false);
  assert.equal(countMemberHomeJobs([{...owner,designatedMember:'member-without-address'}],since).pass,false);
  assert.equal(countMemberHomeJobs([{...member,jobHome:{origin:null,ownerOrigin:'https://owner.test'}}],since).pass,false);
  assert.equal(countMemberHomeJobs(jobs(1),since).pass,false);
  assert.equal(countMemberHomeJobs([{...member,current_attempt:null}],since).pass,false);
  assert.equal(countMemberHomeJobs([{...member,submittedAt:'2026-10-31T00:00:00Z'}],since).pass,false);
  for(const state of ['result-accepted','finished']) {
    const result=countMemberHomeJobs([{...member,state},{...member,state}],since);
    assert.equal(result.pass,true);assert.equal(result.finished,1);
    assert.equal(result.reason,`real: 1 finished jobs sent to a member's address since ${since}`);
  }
  assert.throws(()=>countMemberHomeJobs([member],'bad'),/Invalid/);
});
test('20 jobs, 18 finished, 18 starts within 90 seconds passes',()=>{
  const input=jobs(); for(const row of input.slice(18)){row.state='failed';row.current_attempt.reason='provider_limit';delete row.current_attempt.execution_observed_at;}
  const result=countJobs(input,since);
  assert.equal(result.pass,true);assert.equal(result.finished,18);assert.equal(result.startedWithin90,18);assert.equal(result.unnamedFailures,0);
});
test('insufficient sample, unnamed failures, slow and missing starts fail',()=>{
  assert.equal(countJobs(jobs(19),since).pass,false);
  const input=jobs(); input[0].state='failed';
  assert.equal(countJobs(input,since).unnamedFailures,1);
  for(const row of input.slice(0,3))row.current_attempt.execution_observed_at='2026-11-02T00:01:31Z';
  assert.equal(countJobs(input,since).pass,false);
  for(const row of input)delete row.current_attempt.claimed_at;
  assert.equal(countJobs(input,since).startedWithin90,0);
});
test('only newest 20 since publication count; duplicate jobs do not inflate sample',()=>{
  const input=jobs(21);input[0].current_attempt.claimed_at='2026-10-31T00:00:00Z';input[0].state='failed';
  assert.equal(countJobs([...input,...input],since).sample,20);
  assert.equal(countJobs(input,since).pass,true);
  assert.throws(()=>countJobs(input,'bad'),/Invalid/);
});
test('start request is not observed execution, and negative latency never counts',()=>{
  const input=jobs();for(const row of input){delete row.current_attempt.execution_observed_at;row.current_attempt.execution_started_at='2026-11-02T00:00:01Z';}
  assert.equal(countJobs(input,since).startedWithin90,0);
  for(const row of input)row.current_attempt.execution_observed_at='2026-11-01T00:00:00Z';
  assert.equal(countJobs(input,since).startedWithin90,0);
});
test('newest twenty are selected and JSON failure causes are named',()=>{
  const input=jobs(21);
  input[0].state='failed';input[0].current_attempt.claimed_at='2026-11-01T00:00:00Z';
  assert.equal(countJobs(input,since).pass,true);
  input[20].state='failed';input[20].current_attempt.reason='{"code":"entrypoint_start_failed"}';
  assert.equal(countJobs(input,since).unnamedFailures,0);
  input[20].current_attempt.reason='{}';
  assert.equal(countJobs(input,since).unnamedFailures,1);
  assert.throws(()=>countJobs([...jobs(1),{...jobs(1)[0],state:'failed'}],since),/disagree/);
});
test('installed command prefers the release directory and uses executable PATH fallback',async()=>{
  const {installedApp}=await import('../scripts/bar-real-jobs.mjs');
  const home='/fixture/home',data='/fixture/data',release=data+'/faravan/usr/bin/faravan',cli='/fixture/bin/faravan';
  const env={XDG_DATA_HOME:data,PATH:'/fixture/bin'};
  const tried=[];
  const only=(...paths)=>async file=>{tried.push(file);if(!paths.includes(file))throw Error('not executable');};
  assert.equal(await installedApp({home,env,canExecute:only(release,cli)}),release);
  assert.deepEqual(tried,[release]);
  tried.length=0;
  assert.equal(await installedApp({home,env,canExecute:only(cli)}),cli);
  assert.ok(!tried.some(path=>path.includes('faravan-preview-')));
});

test('installed command reports a missing candidate without using a retired preview',async()=>{
  const {installedApp}=await import('../scripts/bar-real-jobs.mjs');
  const tried=[];
  await assert.rejects(installedApp({home:'/fixture/home',env:{PATH:''},canExecute:async file=>{
    tried.push(file);throw Error('not executable');
  }}),/Installed Faravan command not found/);
  assert.equal(tried[0],'/fixture/home/.local/share/faravan/usr/bin/faravan');
  assert.ok(!tried.some(path=>path.includes('faravan-preview-')));
});

test('reader only calls installed list and get commands, and rejects saved results',async()=>{
  const calls=[];
  const run=async(app,args)=>{calls.push([app,args]);return {stdout:JSON.stringify(args[1]==='list'?[{...jobs(1)[0],circle:{id:'circle'}}]:jobs(1)[0])};};
  const result=await readRealJobs({apps:['/installed/faravan'],since,run});
  assert.equal(result.sample,1);
  assert.deepEqual(calls,[['/installed/faravan',['jobs','list','--json']],['/installed/faravan',['jobs','get','--digest','job-0','--circle','circle','--json']]]);
  await assert.rejects(readRealJobs({apps:['app'],since,run:async()=>({stdout:JSON.stringify([{...jobs(1)[0],savedAt:since}])})}),/saved/);
  const memberRun=async(app,args)=>({stdout:JSON.stringify(args[1]==='list'?jobs(1):{...jobs(1)[0],jobHome:{origin:'https://member.test',ownerOrigin:'https://owner.test'}})});
  assert.equal((await readRealJobs({apps:['/installed/faravan'],since,run:memberRun,memberHome:true})).pass,true);
});
