import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';

const opts={timeout:60000};
test('unchanged idle lending polls emit no new events; a real pause still emits',opts,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await waitFor(async()=> (await api(lender.app,'/api/activity')).find(e=>e.type==='lending'&&e.data.status==='idle'&&e.data.counters?.jobs===0));
  const before=(await api(lender.app,'/api/activity')).at(-1).id;
  const claims=()=>f.networkTrace.filter(row=>row.device==='lender'&&row.route.endsWith('/offers')).length;
  const polled=claims();
  await waitFor(()=>claims()>=polled+5,'five later idle offer reads');
  assert.deepEqual((await api(lender.app,'/api/activity?after='+before)).filter(e=>e.type==='lending'),[]);
  await api(lender.app,'/api/lending/pause',{method:'POST',body:{}});
  assert.ok((await api(lender.app,'/api/activity?after='+before)).some(e=>e.type==='lending'));
});

test('the idle label says what Auto does: jobs the rule allows start without asking',opts,async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'auto'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const idle=await waitFor(async()=> (await api(lender.app,'/api/activity')).findLast(e=>e.type==='lending'&&e.data.status==='idle'));
  assert.equal(idle.data.label,'Lending is on. Jobs your lending rule allows start without asking.');
});

test('readiness serves cached evidence while a refresh is blocked, and supports an explicit refresh',opts,async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root),summary=backend.protectionSummary;
  let release,blocked=false,calls=0;
  backend.protectionSummary=async(...args)=>{calls++;if(blocked)await new Promise(r=>{release=r;});return summary(...args);};
  const {app}=await f.start('cache',{backend,readinessCacheMs:0});
  const first=await api(app,'/api/readiness?refresh=true');
  const initialCalls=calls;
  assert.ok(Number.isFinite(Date.parse(first.observed_at)));
  blocked=true;
  t.after(()=>release?.());
  const started=performance.now();
  const cached=await api(app,'/api/readiness');
  assert.ok(performance.now()-started<50,'cached readiness returns within 50ms');
  assert.deepEqual(cached,first,'a slow preflight cannot delay a cached read');
  await waitFor(()=>release);
  let finished=false;
  const fresh=api(app,'/api/readiness?refresh=true').then(r=>{finished=true;return r;});
  await new Promise(r=>setTimeout(r,30));
  assert.equal(finished,false,'explicit refresh waits for the in-flight fresh observation');
  blocked=false;release();
  assert.equal((await fresh).ready,true);
  assert.equal(calls,initialCalls+2,'explicit refresh follows the in-flight observation with a fresh check');
});
