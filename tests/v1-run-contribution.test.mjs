import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

const runEvents=f=>f.events.filter(event=>event.contribution?.kind==='run');
function launch(f) {
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:async()=>true,onEvent:event=>f.events.push(event)});
  const running=lender.start(controller.signal);
  let failure;const settled=Promise.resolve(running).catch(error=>{failure=error;});
  f.stop=async()=>{
    controller.abort();let timer;
    try {await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lender shutdown timed out')),2000);})]);}
    finally {clearTimeout(timer);}
    if(failure&&failure.name!=='AbortError'&&failure.code!=='aborted')throw failure;
  };
  return lender;
}

test('confirmed backend execution remains a run contribution after a nonzero exit',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{runError:Object.assign(new Error('synthetic nonzero execution'),{code:'entrypoint_start_failed'})});
  launch(f);
  await until(()=>f.events.some(event=>event.status==='failed'),'nonzero execution is reported');
  assert.equal(runEvents(f).length,1,'a later nonzero exit cannot erase the confirmed start');
});

test('confirmed backend execution remains a run contribution when stop rejects start',{timeout:60000},async t=>{
  const f=await lenderFixture(t,{hold:true}),lender=launch(f);
  try {
    await f.entered.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runEvents(f).length,1,'the backend start event is recorded before its promise settles');
    await lender.stopCurrentJob(lender.getState().current);
    await until(()=>f.count('/stopped')===1,'backend stop rejection is reconciled');
    assert.equal(runEvents(f).length,1,'stop cleanup cannot erase the run');
  } finally {await f.stop();}
});

test('failed-before-start remains excluded from run contributions',{timeout:60000},async t=>{
  const f=await lenderFixture(t),original=f.backend.start.bind(f.backend);
  f.backend.start=async(handle,options)=>{
    if(!handle._sourcePreparation&&handle._entrypoint.includes('codex exec'))
      throw Object.assign(new Error('synthetic failure before backend start'),{code:'entrypoint_start_failed'});
    return original(handle,options);
  };
  launch(f);
  await until(()=>f.events.some(event=>event.status==='failed'),'pre-start failure is reported');
  assert.equal(runEvents(f).length,0,'a failed request without the start event is not a run');
});

test('duplicate backend start callbacks create exactly one run observation',{timeout:60000},async t=>{
  const f=await lenderFixture(t),original=f.backend.start.bind(f.backend);
  f.backend.start=(handle,options={})=>original(handle,{...options,onExecutionStarted:()=>{
    options.onExecutionStarted?.();options.onExecutionStarted?.();
  }});
  launch(f);
  await until(()=>runEvents(f).length>0,'confirmed start callback');
  assert.equal(runEvents(f).length,1);
  await until(()=>f.events.some(event=>event.label?.startsWith('Finished.')),'fake execution completes');
  assert.equal(runEvents(f).length,1,'successful completion does not emit a second run');
  await f.stop();
});
