import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createLender} from '../lib/v1/lender.mjs';

import {isPassingDecline} from '../lib/v1/failures.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';

const turn = () => new Promise(resolve => setTimeout(resolve,30));
function launch(f, client=f.client, policy=f.policy) {
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client,backend:f.backend,adapters:f.adapters,policy,clock:f.clock,
    approve:async()=>true,onEvent:e=>f.events.push(e)});
  const loop = lender.start(controller.signal);
  return async()=>{controller.abort();await loop;};
}

for(const code of ['approval_denied','requirements_unsupported','unknown_refusal'])
  test(`lasting decline never reoffers over an hour: ${code}`,async t=>{
    const f=await realLenderFixture(t,{offers:true,mutateJob:job=>{job.expires_at='2026-10-09T18:00:00Z';}});
    let prepares=0;
    f.backend.prepare=async()=>{prepares++;throw Object.assign(new Error(code),{code});};
    f.stop=launch(f);
    await until(()=>f.events.some(e=>e.status==='declined'&&e.reason===code),'lasting decline');
    for(let n=0;n<12;n++){f.clock.advance(300000);await turn();}
    assert.equal(prepares,1);
    assert.equal(f.calls.filter(([kind])=>kind==='run').length,0);
  });

test('a refusal from a limit window that stopped being reported or cannot be read is reconsidered', ()=>{
  for(const reason of ['lending_window_missing','lending_window_memory_unreadable', 'lending_window_invalid'])
    assert.equal(isPassingDecline(reason),true,reason);
});
