import test from 'node:test';
import assert from 'node:assert/strict';
import {eventRevisesPages,eventScopeOf,revisionSignature} from './revision-signal.mjs';

test('streamed transcript chunks never revise every open page',()=>{
  assert.equal(eventRevisesPages({type:'lending',data:{status:'transcript',chunk:'tool output'}}),false);
  assert.equal(eventRevisesPages({type:'lending',data:{status:'working'}}),true);
  assert.equal(eventRevisesPages({type:'job',data:{state:'working'}}),true);
  assert.equal(eventRevisesPages({type:'phone',data:{}}),false);
  assert.equal(eventRevisesPages({type:'update',data:{}}),false);
});
test('the shell signature ignores observation times and transcript chunks but sees real changes',()=>{
  const home=extra=>({lending:{enabled:true},observedAt:Date.now()+Math.random(),...extra});
  assert.equal(revisionSignature('home',home()),revisionSignature('home',home()));
  assert.notEqual(revisionSignature('home',home()),revisionSignature('home',home({lending:{enabled:false}})));
  const base=[{id:1,type:'job',data:{state:'queued'}}],chunk={id:2,type:'lending',data:{status:'transcript',chunk:'x'}};
  assert.equal(revisionSignature('activity',base),revisionSignature('activity',[...base,chunk]));
  assert.notEqual(revisionSignature('activity',base),revisionSignature('activity',[...base,{id:3,type:'job',data:{state:'working'}}]));
  assert.notEqual(revisionSignature('jobs',[1]),revisionSignature('jobs',[2]));
});
test('the Jobs signature ignores the status observation time but sees a real change', () => {
  const rows = (at, state = 'queued') => [{job_digest: 'x', state, statusContract: {lifecycle: 'waiting', observedAt: at}}];
  assert.equal(revisionSignature('jobs', rows('t1')), revisionSignature('jobs', rows('t2')));
  assert.notEqual(revisionSignature('jobs', rows('t1')), revisionSignature('jobs', rows('t1', 'claimed')));
});
// Judge r12 R12-2: a job event names one job, so it re-reads only the shell resources that list jobs, their cards, activity
// and totals. Circles, agents, devices and readiness keep their own events and reads.
test('a job event asks the shell for a job-scoped refresh; any other event asks for all of it', () => {
  assert.equal(eventScopeOf({type: 'job', data: {job_digest: 'sha256:a', state: 'working'}}), 'job');
  assert.equal(eventScopeOf({type: 'job', data: {jobDigest: 'sha256:a'}}), 'job');
  assert.equal(eventScopeOf({type: 'job', data: {state: 'working'}}), 'all', 'a job event that names no job could be any of them');
  assert.equal(eventScopeOf({type: 'lending', data: {circle: 'c1', status: 'working'}}), 'all', 'lending state with no job is the whole lender');
  assert.equal(eventScopeOf({type: 'lending', data: {circle: 'c1', jobDigest: 'sha256:a', status: 'running'}}), 'job');
  assert.equal(eventScopeOf({type: 'approval', data: {}}), 'all');
  assert.equal(eventScopeOf({type: 'readiness', data: {seq: 2}}), 'all');
});
