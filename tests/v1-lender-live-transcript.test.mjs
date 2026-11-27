import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLender} from '../lib/v1/lender.mjs';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {until} from './helpers/v1-lender-fixture.mjs';

const prose=JSON.stringify({type:'assistant',account:{email:'private-lender@example.com'},message:{content:[{type:'text',text:'I found the parser. I will fix the quoted fields.'}]}})+'\n';
const command=JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'private-session',name:'Bash',input:{command:'npm test'}}]}})+'\n';

test('a real HTTP lender relays live redacted prose and command activity to its author before completion', {timeout:60000}, async t=>{
  const f=await realLenderFixture(t,{hold:true,stdout:prose+command});
  const original=f.backend.start.bind(f.backend);
  f.backend.start=async(handle,opts={})=>{
    if(handle._entrypoint?.includes('codex')&&!handle._entrypoint.includes('login status'))opts.onLog?.({stream:'stdout',chunk:Buffer.from(prose+command)});
    return original(handle,opts);
  };
  const controller=new AbortController();
  const lender=createLender({client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,clock:f.clock,
    approve:async()=>true,credentialValues:async()=>[],onEvent:e=>f.events.push(e)});
  const running=lender.start(controller.signal);
  f.stop=async()=>{f.execution.resolve();controller.abort();await running;};
  await until(()=>f.calls.some(([kind])=>kind==='run'),'agent entered');
  let snapshot;
  for(let tries=0;tries<100;tries++){
    snapshot=await f.owner.fetchLiveTranscript(f.jobDigest);
    if(snapshot.text.includes('quoted fields'))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await f.owner.getJob(f.jobDigest)).state,'claimed');
  assert.match(snapshot.text,/quoted fields/);assert.match(snapshot.text,/npm test/);
  assert.doesNotMatch(snapshot.text,/private-lender|private-session|\/home\//);
  assert.equal(snapshot.available,true);
  assert.ok(f.realRequests.some(r=>r.url.endsWith('/transcript')));
  f.execution.resolve();await until(()=>f.events.some(e=>e.status==='finished'),'result delivered');
});
