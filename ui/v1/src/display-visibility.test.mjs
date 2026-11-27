import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleInterval} from './display-visibility.mjs';
import {createReadQueue} from './read-queue.mjs';
import {createResourceRead} from './resource-read.mjs';
class Document extends EventTarget {visibilityState='hidden';show(){this.visibilityState='visible';this.dispatchEvent(new Event('visibilitychange'));}hide(){this.visibilityState='hidden';this.dispatchEvent(new Event('visibilitychange'));}}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('optional page timers pause while hidden and resync immediately on return',t=>{
  t.mock.timers.enable({apis:['setInterval']});const document=new Document();let reads=0;
  const stop=visibleInterval(()=>reads++,15000,{document});t.mock.timers.tick(60000);assert.equal(reads,0);
  document.show();assert.equal(reads,1);t.mock.timers.tick(15000);assert.equal(reads,2);
  document.hide();t.mock.timers.tick(60000);assert.equal(reads,2);document.show();assert.equal(reads,3);
  stop();document.show();assert.equal(reads,3);
});
test('hidden shell and page resources defer optional reads; explicit actions and foreground resync work',async t=>{
  const old=globalThis.document,document=new Document();globalThis.document=document;t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  let shell=0,page=0;const queue=createReadQueue(async()=>{shell++;return 'ok';}),resource=createResourceRead({get:async()=>++page},'jobs',()=>{});
  t.after(()=>{queue.stop();resource.stop();});
  await queue.load();resource.invalidate();await flush();assert.equal(shell,0);assert.equal(page,0);
  await queue.load({force:true});assert.equal(shell,1);
  document.show();await flush();assert.equal(shell,2);assert.equal(page,1);
  document.hide();resource.invalidate();await flush();assert.equal(page,1);
  document.show();await flush();assert.equal(page,2);
});
test('hidden tabs keep SSE events but suppress shell refresh until foreground',async t=>{
  const {watchUpdates}=await import('./api.mjs');
  const old=globalThis.document,document=new Document();globalThis.document=document;t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  let stream,reads=0,events=0;
  const body=new ReadableStream({start(controller){stream=controller;}});
  const stop=watchUpdates({request:async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})},()=>{reads++;},()=>{},{onEvent:()=>events++});
  t.after(()=>{stop();stream.close();});await flush();
  stream.enqueue(new TextEncoder().encode('event: change\ndata: {"type":"job","data":{"state":"running"}}\n\n'));await flush();
  assert.equal(reads,0);assert.equal(events,1);
  document.show();await flush();assert.equal(reads,1);
});
