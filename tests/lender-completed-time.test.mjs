import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

test('completed time is durable before output recovery or the first result intent',async t=>{
  const f=await lenderFixture(t,{hold:true}),controller=new AbortController();
  f.override=({route,req})=>{if(route.endsWith('/complete')){req.socket.destroy();return true;}return false;};
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:async()=>true,onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal);
  f.stop=async()=>{controller.abort();await running.catch(error=>{if(error.name!=='AbortError')throw error;});};
  await until(()=>f.events.some(event=>event.status==='running'),'agent running');
  f.clock.advance(6000);f.execution.resolve();
  await until(()=>f.saves.some(value=>value.resultPending),'first result intent');
  await f.stop();
  const result=f.saves.find(value=>value.resultPending),output=f.saves.findLast(value=>value.outputPending&&!value.resultPending);
  for(const saved of [output,result])assert.deepEqual(saved.pending.actualUse,{attemptId:f.attempt().attempt_id,ms:6000});
});
