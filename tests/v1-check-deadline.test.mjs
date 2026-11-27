import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

test('the check budget uses the earlier lender wall timer, including time already spent preparing',async t=>{
  const f=await lenderFixture(t,{agent:()=>f.clock.advance(10000),mutateJob:job=>{
    job.verify={cmd:'npm test'};job.requirements.capabilities=['verify_v1'];job.requirements.limits.wall_seconds=300;
  }});
  const capabilities=f.backend.lenderCapabilities;
  f.backend.lenderCapabilities=()=>({...capabilities(),capabilities:['verify_v1']});
  f.backend.verificationFiles=async()=>'';
  f.backend.verify=async()=>({exit:0,timed_out:false,stdout:''});
  const prepare=f.backend.prepareCheck;let remaining;
  f.backend.prepareCheck=(agent,options)=>{remaining=options.remainingMs;return prepare(agent,options);};
  const controller=new AbortController(),lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,
    policy:f.policy,clock:f.clock,approve:async()=>true,onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal).catch(e=>{if(!controller.signal.aborted)throw e;});
  f.stop=async()=>{controller.abort();await running;};
  await until(()=>f.result,'signed checked result');await f.stop();
  assert.equal(remaining,290000);
});
