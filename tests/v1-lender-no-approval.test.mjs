import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';

function noExecution(f) {
  assert.equal(f.calls.filter(([kind])=>kind==='run').length,0,'no agent execution');
  assert.equal(f.calls.some(([kind])=>kind==='prepare'),false,'no sandbox preparation');
  assert.equal(f.count('/start'),0,'no execution start request');
  assert.equal(f.count('/complete'),0,'no completion request');
}

function noFreshClaim(f) {
  assert.equal(f.count('/jobs/claim-next'),0,'no fresh claim-next request');
  assert.equal(f.requests.some(({route})=>route.startsWith('/jobs/')&&route.endsWith('/claim')),false,
    'no claim for a selected offer');
}

for(const [name,approvalOption] of [
  ['omitted',{}],
  ['null',{approve:null}],
  ['undefined',{approve:undefined}],
])test('ask-mode lender without approval ('+name+') holds offered work before claiming', {timeout:60000}, async t=>{
  // The fixture offers a signed job and a usable fake backend. Do not use the
  // shared launch helper: its nullish default would replace all three cases.
  const f=await lenderFixture(t,{policy:{mode:'ask',enabled:true,pollMs:1000}});
  assert.ok(f.jobDigest,'the fixture offers a job');
  assert.ok(f.job.payload,'the offered job is available for the admission probe');
  const controller=new AbortController();
  const lender=createLender({
    client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    ...approvalOption,
    onEvent:event=>{f.events.push(event);},
  });
  let failure;
  const settled=Promise.resolve(lender.start(controller.signal)).catch(error=>{failure=error;});
  f.stop=async()=>{
    controller.abort();
    let timer;
    try {
      await Promise.race([settled,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('Lender shutdown timed out')),2000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    if(failure&&failure.name!=='AbortError'&&failure.code!=='aborted')throw failure;
  };
  const heldEvents=()=>f.events.filter(event=>event.reason==='approval_unavailable').length;
  const assertHeld=()=>{
    noFreshClaim(f);
    noExecution(f);
    assert.equal(lender.getState().status,'paused');
    assert.equal(lender.getState().reason,'approval_unavailable');
    assert.equal(lender.getState().paused,false,'the hold preserves enabled lending intent');
    assert.equal(lender.admits(f.job.payload),'approval_unavailable','readiness uses the same hold');
  };
  try {
    // A removed pre-claim hold can reach the later decline guard with the same
    // reason. Check requests as well as the reason so that mutant cannot pass.
    await until(()=>heldEvents()>0||f.count('/jobs/claim-next')>0||failure,
      'missing approval hold or an unexpected claim');
    if(failure)throw failure;
    assertHeld();
    await until(()=>f.clock.pending().includes(1000),'held lender schedules another poll');
    const before=heldEvents();
    f.clock.advance(1000);
    await until(()=>heldEvents()>before||f.count('/jobs/claim-next')>0||failure,
      'missing approval remains held after another poll');
    if(failure)throw failure;
    assertHeld();
  } finally {
    await f.stop();
  }
  noFreshClaim(f);
  noExecution(f);
});
