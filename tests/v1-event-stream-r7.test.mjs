import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';

test('unchanged lending on two accounts emits no events over ten seconds',{timeout:60000},async t=>{
  const adapters=['claude-code-subscription','codex'].map(id=>({spec:legacyProxyHarness(id),installed:true,signedIn:true,harnessVersion:'synthetic-only',models:['example-model'],capabilities:[]}));
  const f=await appFixture(t),{lender,circle}=await f.connect({adapters,pollMs:500});
  const post=(path,body)=>api(lender.app,'/api/'+path,{method:'POST',body});
  await post('lending/limits',{idleOnly:false});
  for(const id of ['claude-code-subscription','codex'])await post('agents/'+id,{useForLending:true});
  await post('lending/on',{circle:circle.id});
  await waitFor(async()=>new Set((await api(lender.app,'/api/activity')).filter(e=>e.type==='lending'&&e.data.status==='idle').map(e=>e.data.account)).size===2,'both idle accounts',30000);
  // Let the second worker join the aggregate, then observe a full ten-second window.
  await new Promise(resolve=>setTimeout(resolve,1500));
  const cursor=(await api(lender.app,'/api/activity')).at(-1)?.id??0;
  await new Promise(resolve=>setTimeout(resolve,10000));
  const events=(await api(lender.app,'/api/activity?after='+cursor)).filter(e=>e.type==='lending');
  t.diagnostic(JSON.stringify({windowSeconds:10,lendingEvents:events.length,eventsPerSecond:events.length/10}));
  assert.deepEqual(events,[]);
});

test('byte-bounded replay resets a gap once and preserves the cursor for live events',async()=>{
  const {createEventReplay,EVENT_REPLAY_BYTES}=await import('../lib/v1/event-stream.mjs');
  const replay=createEventReplay();
  for(let id=1;id<=20;id++)replay.append({id,type:'job',data:{text:'界'.repeat(50000)}});
  const reset=replay.framesAfter(0);
  assert.equal(reset.length,1);
  const frame=reset[0];
  assert.ok(Buffer.byteLength(frame)<EVENT_REPLAY_BYTES);
  const event=JSON.parse(frame.split('\ndata: ')[1].trim());
  assert.equal(event.type,'reset');assert.equal(event.id,20);
  assert.deepEqual(replay.framesAfter(event.id),[]);
  replay.append({id:21,type:'job',data:{state:'running'}});
  assert.equal(replay.framesAfter(event.id).length,1);
  const retained=replay.framesAfter(19).join('');
  assert.ok(Buffer.byteLength(retained)<=EVENT_REPLAY_BYTES);
  assert.ok(EVENT_REPLAY_BYTES<=768*1024,'margin below the client 1 MiB incomplete frame limit');
});

test('transcript chunks reach open streams but are not kept for replay',async()=>{
  const {createEventReplay}=await import('../lib/v1/event-stream.mjs');
  const replay=createEventReplay();
  replay.append({id:1,type:'job',data:{state:'running'}});
  for(let id=2;id<=400;id++)assert.match(replay.append({id,type:'lending',data:{status:'transcript',chunk:'x'.repeat(4000)}}),/transcript/);
  replay.append({id:401,type:'approval',data:{state:'accepted'}});
  assert.deepEqual(replay.since(0).map(e=>e.id),[1,401],'job events stay in the window');
  assert.equal(replay.framesAfter(0).length,2,'no reset: nothing was trimmed');
});
