import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {lendableModelEfforts} from "../lib/v1/lender.mjs";

import {join} from 'node:path';

import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

// The lender's saved "highest effort" decides which model and effort pairs friends can ask for.
const harness={harness_id:'codex'};
const pairs=['low','medium','high'].map(effort=>({model:'example-model',effort}));
const adapterWith=run=>({spec:harness,run});
const runtimeWith=cap=>({candidate:{},effortMax:()=>cap});

// The real candidate returns the saved cap in its decision; the fixture candidate returns null, so mirror the real one.

test('a cap of low advertises only the low pair',()=>{
  const out=lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:pairs}),{lendingRuntime:runtimeWith('low')});
  assert.deepEqual(out.pairs,[pairs[0]]);
});

test('a cap of medium advertises low and medium, and an explicit pair is never lowered',()=>{
  const out=lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:[pairs[2]]}),{lendingRuntime:runtimeWith('medium')});
  assert.deepEqual(out.pairs,[]);
  assert.deepEqual(lendableModelEfforts(adapterWith({model:null,effort:null,model_efforts:pairs}),{lendingRuntime:runtimeWith('medium')}).pairs,pairs.slice(0,2));
});

test('the lender default effort above the cap is advertised at the cap',()=>{
  const out=lendableModelEfforts(adapterWith({model:'example-model',effort:'high'}),{lendingRuntime:runtimeWith('medium')});
  assert.deepEqual(out.pairs,[{model:'example-model',effort:'medium'}]);
});

test('the default cap of high changes nothing, with or without a saved cap',()=>{
  const run={model:null,effort:null,model_efforts:pairs};
  for(const runtime of [runtimeWith('high'),runtimeWith('xhigh'),runtimeWith('max'),{candidate:{}},null])
    assert.deepEqual(lendableModelEfforts(adapterWith(run),{lendingRuntime:runtime}).pairs,pairs);
  assert.deepEqual(lendableModelEfforts(adapterWith({model:'example-model',effort:'high'}),{lendingRuntime:runtimeWith('high')}).pairs,[pairs[2]]);
});

test('limits.set with effortMax changes the state the page shows and the pairs the heartbeat offers',{timeout:60000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect({heartbeatMs:100});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:null,effort:null,model_efforts:[
    {model:'pair-one',effort:'low'},{model:'pair-one',effort:'medium'},{model:'pair-one',effort:'high'}]}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const efforts=beat=>beat.agents?.find(a=>a.adapter==='codex')?.model_efforts?.map(pair=>pair.effort).join();
  await waitFor(()=>f.heartbeats?.findLast(b=>efforts(b)==='low,medium,high'),'all three pairs offered',15000);
  assert.equal((await api(lender.app,'/api/lending')).limits.lendingPolicy.effortMax,'high');
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{effortMax:'medium'}}});
  await waitFor(()=>f.heartbeats?.findLast(b=>efforts(b)==='low,medium'),'capped pairs offered',15000);
  assert.equal((await api(lender.app,'/api/lending')).limits.lendingPolicy.effortMax,'medium');
});
