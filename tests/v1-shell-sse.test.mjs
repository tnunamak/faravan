import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('reconnecting past a 65 KiB event history replays completely and remains live', {timeout:120000},async t=>{
 const f=await appFixture(t),{app}=await f.start('large-replay');let events=[],bytes=0;
 for(let i=0;i<250&&bytes<75*1024;i++) {
  await api(app,'/api/notification-settings',{method:'POST',body:{job_ready:{desktop:i%2===0}}});
  if(i%40===39){events=await api(app,'/api/activity');bytes=Buffer.byteLength(JSON.stringify(events));}
 }
 assert.ok(bytes>65*1024,'fixture must exceed the former replay cap');
 const last=events.at(-1).id,controller=new AbortController();t.after(()=>controller.abort());
 const response=await fetch(app.origin+'/api/events?after=0',{headers:{'x-faravan-session-token':app.token},signal:controller.signal});
 const reader=response.body.getReader();let text='';
 async function through(id) {while(!text.includes('id: '+id+'\n')) {const chunk=await reader.read();assert.equal(chunk.done,false,'live stream ended during replay');text+=Buffer.from(chunk.value).toString('utf8');}}
 await through(last);
 await api(app,'/api/notification-settings',{method:'POST',body:{job_ready:{desktop:false}}});
 const updated=await api(app,'/api/activity');await through(updated.at(-1).id);
 await reader.cancel();
});
