import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './api.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Judge r7 O4: a host limits result downloads per computer and answers 429. Reads wait as asked and try again;
// a busy host is never a failure on the page.
test('O4: a 429 with Retry-After is retried after that delay and then succeeds',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  let calls=0;
  const api=createApi('x',async()=>{calls++;return calls===1?new Response('{"code":"rate_limited"}',{status:429,headers:{'retry-after':'2'}}):new Response('{"ok":true}');});
  const pending=api.get('jobs/j/result');
  await flush();assert.equal(calls,1);
  t.mock.timers.tick(1999);await flush();assert.equal(calls,1,'waits the full Retry-After');
  t.mock.timers.tick(1);await flush();
  assert.deepEqual(await pending,{ok:true});assert.equal(calls,2);
});
test('O4: a downloaded result retries 429 with backoff when there is no Retry-After',async()=>{
  let calls=0;
  const api=createApi('x',async()=>{calls++;return calls<3?new Response('',{status:429}):new Response('b',{headers:{'content-disposition':'attachment; filename="r.zip"'}});},{rateRetryBase:1});
  const r=await api.download('jobs/j/result');
  assert.equal(calls,3);assert.equal(r.filename,'r.zip');
});
test('O4: aborting during a 429 wait stops retrying',async()=>{
  let calls=0;
  const api=createApi('x',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'30'}});});
  const controller=new AbortController();
  const p=api.download('jobs/j/result',controller.signal);
  await pause(10);controller.abort();
  await assert.rejects(p,{name:'AbortError'});
  const after=calls;await pause(20);assert.equal(calls,after);
});
test('O4: a direct api.request of an image retries 429; a write never repeats on its own',async()=>{
  let calls=0;
  const api=createApi('x',async(_url,{method='GET'})=>{calls++;return method==='GET'&&calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):method==='GET'?new Response('img'):new Response('{"code":"rate_limited"}',{status:429});});
  assert.equal(await (await api.request('jobs/j/image?path=a.png')).text(),'img');assert.equal(calls,2);
  await assert.rejects(api.post('jobs/j/title',{title:'x'}),{status:429});assert.equal(calls,3);
});
test('O4: a persistent 429 stays pending past 8 attempts and the read deadline, then succeeds',async()=>{
  let calls=0;
  const api=createApi('x',async()=>++calls<=12?new Response('',{status:429,headers:{'retry-after':'0.01'}}):new Response('{"ok":true}'),{readTimeout:15,readRetryDelay:0});
  assert.deepEqual(await api.get('jobs/j/result'),{ok:true});
  assert.equal(calls,13);
});
test('O4: persistent 429 without Retry-After keeps backing off (bounded) and succeeds for downloads',async()=>{
  let calls=0;
  const api=createApi('x',async()=>++calls<=10?new Response('',{status:429}):new Response('b'),{rateRetryBase:1});
  assert.ok(await api.download('jobs/j/result'));assert.equal(calls,11);
});
test('O4: cancelling a read stuck behind persistent 429 rejects as a cancellation, never a rate-limit error',async()=>{
  let calls=0;
  const api=createApi('x',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'0.01'}});},{readTimeout:1000});
  const controller=new AbortController();
  const p=api.get('jobs/j/result',controller.signal);
  for(let i=0;i<100&&calls<=8;i++)await pause(10);assert.ok(calls>8);controller.abort();
  await assert.rejects(p,{name:'AbortError'});
  const after=calls;await pause(40);assert.equal(calls,after);
});
test('O4: a Retry-After longer than our own backoff cap is honoured in full',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  let calls=0;
  const api=createApi('x',async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'120'}}):new Response('{"ok":true}'));
  const pending=api.get('jobs/j/changes');
  await flush();t.mock.timers.tick(60000);await flush();
  assert.equal(calls,1,'no second request before the host said so');
  t.mock.timers.tick(60000);await flush();
  assert.deepEqual(await pending,{ok:true});assert.equal(calls,2);
});
test('O4: a download the person started stops after two minutes of 429 with plain words, never a status code',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  let calls=0;
  const api=createApi('x',async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'50'}});});
  const pending=api.download('jobs/j/result');let error;pending.catch(e=>{error=e;});
  for(let i=0;i<4;i++){await flush();t.mock.timers.tick(50000);}
  await flush();
  assert.equal(error?.code,'rate_limited');assert.doesNotMatch(error.message,/429|error/i);assert.ok(calls<=3,'stopped retrying: '+calls);
});
test('O4: a refused live stream falls back to polling with backoff, then returns to the stream when the host allows it',async()=>{
  const {watchUpdates}=await import('./api.mjs');
  let streams=0,refusing=true,open=null;
  const api=createApi('x',async(url,options)=>{
    if(!String(url).includes('/events'))return new Response('{}');
    streams++;
    if(refusing)return new Response('',{status:429,headers:{'retry-after':'3600'}});
    return new Response(new ReadableStream({start(c){open=c;}}),{headers:{'content-type':'text/event-stream'}});
  });
  let updates=0;const connections=[];
  const stop=watchUpdates(api,async()=>{updates++;},value=>connections.push(value),{interval:5,retry:40,retryBase:5,grace:10,healthy:1000});
  try{
    for(let i=0;i<200&&(updates<3||streams<3);i++)await pause(5);
    assert.ok(updates>=3,'fallback polling ran: '+updates);assert.ok(streams>=3,'reconnects on its own backoff: '+streams);
    refusing=false;
    for(let i=0;i<200&&!open;i++)await pause(5);
    assert.ok(open,'the stream opened again');assert.equal(connections.at(-1),true,'live again');
    const polled=updates;await pause(60);
    assert.ok(updates-polled<=1,'polling stopped once the stream is back: '+(updates-polled));
  }finally{stop();}
});
test('O4: a Retry-After beyond ten minutes waits ten minutes, not longer',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  let calls=0;
  const api=createApi('x',async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'86400'}}):new Response('{"ok":true}'));
  const pending=api.get('jobs/j/changes');
  await flush();t.mock.timers.tick(599999);await flush();assert.equal(calls,1);
  t.mock.timers.tick(1);await flush();
  assert.deepEqual(await pending,{ok:true});assert.equal(calls,2);
});
