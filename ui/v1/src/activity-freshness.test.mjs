import test from 'node:test';
import assert from 'node:assert/strict';
import {activityFreshness} from './activity-freshness.mjs';
test('stale activity marks current state words as last known',()=>{
  assert.deepEqual(activityFreshness({stale:true,headline:'Waiting for kestrel to say yes'}),{
    stale:true,headline:'Last known: Waiting for kestrel to say yes',empty:'No agent updates are available yet. Current activity is unconfirmed.'});
  assert.equal(activityFreshness({error:{code:'network'},headline:'Running'}).stale,true);
  assert.equal(activityFreshness({headline:'Running'}).headline,'Running');
});
test('first local transcript update never refers to this computer in the third person',()=>{
  assert.equal(activityFreshness({role:'ran'}).empty,'Your agent is starting. Its first update will appear here.');
  assert.doesNotMatch(activityFreshness({role:'ran'}).empty,/Waiting for|computer/);
});

test('stale and conflict empty feeds do not assert current execution',()=>{
 for(const role of [undefined,'ran'])for(const state of [{stale:true},{error:{status:409}}]){
  assert.equal(activityFreshness({...state,role}).empty,'No agent updates are available yet. Current activity is unconfirmed.');
 }
 assert.equal(activityFreshness({error:{status:500}}).empty,'Faravan couldn’t load what the agent is doing.');
});
