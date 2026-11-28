import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {deferred,lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

for(const unavailable of [false,true])test('a lent job printing its selected account token redacts transcript, live entries and handoff'+(unavailable?' when scanning is unavailable':''),{timeout:20000},async t=>{
  const secrets=['lender@example.test','sk-ant-api03-'+ 'a'.repeat(50),'opaque-lender-value'];
  const stdout=secrets.map(text=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})).join('\n')+'\n';
  const f=await lenderFixture(t,{stdout,credentialValues:async()=>{if(unavailable)throw new Error('selected account unreadable');return [secrets[2]];}}),events=[],diagnostics=[],relayed=[],controller=new AbortController();
  const lender=createLender({...f.runOptions,client:{...f.client,postLiveTranscript:async(_attempt,entry)=>relayed.push(entry)},backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,
    credentialValues:async()=>{if(unavailable)throw new Error('synthetic scan failure');return [secrets[2]];},onDiagnostic:event=>diagnostics.push(event),onEvent:event=>{events.push(event);f.events.push(event);}});
  const running=lender.start(controller.signal).catch(error=>{if(!controller.signal.aborted)throw error;});
  t.after(async()=>{controller.abort();await running;});
  await until(()=>f.result,'signed result');controller.abort();await running;
  const uploaded=f.artifacts.get(f.result.payload.transcript.digest).toString();
  const streamed=events.filter(event=>event.status==='transcript').map(event=>event.chunk).join('');
  assert.ok(relayed.length>0,'the relay also publishes a snapshot');
  for(const secret of secrets){assert.equal(JSON.stringify(relayed).includes(secret),false,'relay transcript is private');assert.equal(uploaded.includes(secret),false,'uploaded transcript is private');assert.equal(streamed.includes(secret),false,'streamed transcript is private');}
  assert.match(uploaded,/private details withheld/);
  const handoff=JSON.parse(uploaded.trim().split('\n').at(-1)).handoff;
  assert.equal(JSON.stringify(handoff).includes(secrets[2]),false,'handoff hides the selected account token');
  if(unavailable)assert.ok(diagnostics.some(event=>event.code==='transcript_scan_unavailable'),'local diagnostic explains why text was withheld');
  for(const line of uploaded.trim().split('\n'))assert.doesNotThrow(()=>JSON.parse(line));
});

for(const secret of [false,true])test('long raw streams '+(secret?'omit late private tool output before selecting context':'retain a scanned continuation'),{timeout:20000},async t=>{
  const privateValue='opaque-lender-value';
  const safe=JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Ordinary progress. '.repeat(100)}]}})+'\n';
  const stdout=safe.repeat(50)+(secret?JSON.stringify({type:'tool_result',content:privateValue})+'\n':'')+JSON.stringify({type:'result',result:'Finished safely.'})+'\n';
  assert.ok(Buffer.byteLength(stdout)>65536);
  const f=await lenderFixture(t,{stdout,credentialValues:async()=>[privateValue]}),controller=new AbortController();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,credentialValues:async()=>[privateValue]});
  const running=lender.start(controller.signal).catch(error=>{if(!controller.signal.aborted)throw error;});
  t.after(async()=>{controller.abort();await running;});
  await until(()=>f.result,'signed result');controller.abort();await running;
  const uploaded=f.artifacts.get(f.result.payload.transcript.digest).toString();
  const handoff=JSON.parse(uploaded.trim().split('\n').at(-1)).handoff;
  assert.equal(handoff.scan.status,'passed','the handoff scans selected context after outbound redaction');
  assert.equal(uploaded.includes(privateValue),false);
  assert.equal(handoff.changes,'Finished safely.');
});

test('adversarial output cannot starve the lender wall timer',{timeout:10000},async t=>{
  const stdout=('token='.repeat(680)+'\n').repeat(257),f=await lenderFixture(t,{stdout});
  const start=f.backend.start.bind(f.backend),timers=new Set();let wake,elapsed,produced=false;
  f.backend.start=async(handle,options={})=>{
    await start(handle,{...options,onLog:event=>{
      if(event.chunk.toString()===stdout){
        produced=true;const started=performance.now();
        // Arm the lender's registered job timer immediately before processing
        // adversarial output; it must not expire during source preparation.
        const timer=[...timers].at(-1);timer.real=setTimeout(()=>{elapsed=performance.now()-started;timer.fn();},10);
      }
      options.onLog?.(event);
    }});
    if(handle._lastExecStdout===stdout)await new Promise(resolve=>{wake=resolve;});
  };
  f.backend.cancel=async()=>{f.calls.push(['cancel']);wake?.();return {compute_stopped:true};};
  const controller=new AbortController();
  const clock={...f.clock,setTimeout(fn,ms){
    if(ms===120000){const timer={fn,real:null};timers.add(timer);return timer;}
    return f.clock.setTimeout(fn,ms);
  },clearTimeout(id){if(typeof id==='object'){timers.delete(id);clearTimeout(id.real);}else f.clock.clearTimeout(id);}};
  // Keep the stop report pending until teardown, regardless of host speed.
  // The fixture must drain the lender before closing its HTTP server.
  const allowStopped=deferred();
  const client={...f.client,async stopped(...args){await allowStopped.promise;return f.client.stopped(...args);}};
  const lender=createLender({...f.runOptions,client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock,approve:async()=>true,credentialValues:async()=>[],onEvent:event=>f.events.push(event)});
  let runError;
  // Observe failures immediately without creating another unhandled rejection;
  // propagate them from the fixture-owned drain below.
  const running=lender.start(controller.signal).catch(error=>{runError=error;});
  f.stop=async()=>{
    for(const timer of timers)clearTimeout(timer.real);
    wake?.();controller.abort();allowStopped.resolve();
    await running;
    if(runError)throw runError;
    assert.equal(f.attempt().compute_stopped,true,'stop reporting finishes before fixture HTTP teardown');
    assert.equal(lender.snapshot.counters.stoppedPending,null,'the stop acknowledgement is persisted');
  };
  await until(()=>elapsed!==undefined,'wall timer',2000);
  assert.equal(produced,true,'the agent must emit the adversarial data before the timer fires');
  assert.ok(f.events.some(event=>event.status==='stopping'&&event.reason==='job_expired'));
  assert.ok(elapsed<900,'wall timer must run within a second despite adversarial output');
});

for(const scanUnavailable of [false,true])test('signed lender transcript withholds numeric private values and unprojected fields'+(scanUnavailable?' without scanning':''),{timeout:10000},async t=>{
  const stdout='42817\n'+JSON.stringify({type:'result',result:42817,metadata:{account_number:42817},session_id:'provider-correlation'})+'\n';
  const f=await lenderFixture(t,{stdout,credentialValues:async()=>{if(scanUnavailable)throw new Error('selected account unreadable');return ['42817'];}}),controller=new AbortController(),streamed=[];
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,approve:async()=>true,
    credentialValues:async()=>{if(scanUnavailable)throw new Error('synthetic scanner failure');return ['42817'];},
    onEvent:event=>{if(event.status==='transcript')streamed.push(event.chunk);}});
  const running=lender.start(controller.signal).catch(error=>{if(!controller.signal.aborted)throw error;});
  t.after(async()=>{controller.abort();await running;});
  await until(()=>f.result,'signed result');controller.abort();await running;
  const uploaded=f.artifacts.get(f.result.payload.transcript.digest).toString();
  for(const text of [uploaded,streamed.join('')]){assert.doesNotMatch(text,/42817|provider-correlation|account_number/);for(const line of text.trim().split('\n'))assert.doesNotThrow(()=>JSON.parse(line));}
});
