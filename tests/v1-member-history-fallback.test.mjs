import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJobOperations} from '../lib/v1/cli.mjs';

// The member-store fallback for circle job history, against fake clients only. The real signed path, with a real
// member store and a real incumbent taken away, is in member-history-offline.test.mjs.
const digest=n=>'sha256:'+String(n).repeat(64);
const circle={id:'test-circle',name:'Test'};
const queued=(n,designated)=>({job_digest:digest(n),state:'queued',attempts_started:0,
  job:{payload:{author:'reader',circle:circle.id,created_at:'2026-11-20T10:00:0'+n+'Z',...(designated?{designated_member:designated}:{})}}});
const unreachable=()=>Object.assign(new Error('connect ECONNREFUSED'),{code:'network_error'});

async function fixture(t,{incumbent,members}) {
  const home=await mkdtemp(join(tmpdir(),'faravan-member-history-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const calls=[];
  const clientFor=(name,answer)=>({async *listJobs(){
    calls.push(name);
    for(const row of await answer())yield row instanceof Error?(()=>{throw row;})():structuredClone(row);
  }});
  const device={keyId:'reader',selectCircle:async()=>circle,intentStore:()=>({list:async()=>[]}),
    client:async()=>clientFor('incumbent',incumbent),
    memberReadClients:async()=>members.map(m=>({keyId:m.keyId,origin:'https://'+m.keyId+'.invalid',client:clientFor(m.keyId,m.answer)}))};
  return {operations:createJobOperations({device,home}),calls};
}

test('an unreachable incumbent falls back to member stores, keeps only their designated jobs and says the list is partial',async t=>{
  const f=await fixture(t,{incumbent:async()=>{throw unreachable();},members:[
    // The lender's store holds a job designated to it and a stale copy of an ordinary job; only the first is its to answer for.
    {keyId:'lender',answer:async()=>[queued(1,'lender'),queued(2),queued(3,'other')]},
    {keyId:'denier',answer:async()=>{throw Object.assign(new Error('forbidden'),{status:403,code:'forbidden'});}},
    {keyId:'gone',answer:async()=>{throw unreachable();}},
    // A store that fails midway adds none of the rows it had already verified.
    {keyId:'broken',answer:async()=>[queued(4,'broken'),Object.assign(new Error('bad'),{code:'invalid_response'})]},
  ]});
  const {items,coverage}=await f.operations.listWithCoverage({circle:circle.id},{memberFallback:true});
  assert.deepEqual(items.map(row=>row.job_digest),[digest(1)]);
  assert.deepEqual(coverage,{state:'partial',reason:'incumbent_unreachable',members:[
    {keyId:'lender',state:'listed'},{keyId:'denier',state:'denied'},{keyId:'gone',state:'unreachable'},{keyId:'broken',state:'failed'}]});

  // An ordinary list keeps the incumbent-only answer: it never reads a member store.
  f.calls.length=0;
  await assert.rejects(()=>f.operations.list({circle:circle.id}),error=>error.code==='network_error');
  assert.deepEqual(f.calls,['incumbent']);
  await assert.rejects(()=>f.operations.listWithCoverage({circle:circle.id}),error=>error.code==='network_error',
    'the fallback is opt-in');
});

test('a refusal from the incumbent is never replaced by member answers',async t=>{
  for(const refusal of [{status:403,code:'forbidden'},{status:401,code:'unauthorized'},{status:404,code:'not_found'},{status:429,code:'rate_limited'}]) {
    const f=await fixture(t,{incumbent:async()=>{throw Object.assign(new Error(refusal.code),refusal);},
      members:[{keyId:'lender',answer:async()=>[queued(1,'lender')]}]});
    await assert.rejects(()=>f.operations.listWithCoverage({circle:circle.id},{memberFallback:true}),
      error=>error.status===refusal.status,refusal.code+' stands');
    assert.deepEqual(f.calls,['incumbent'],refusal.code+': no member store is read');
  }
});

test('when no member store lists, the incumbent failure stands; a complete incumbent answer is not partial',async t=>{
  const denied=await fixture(t,{incumbent:async()=>{throw unreachable();},members:[
    {keyId:'denier',answer:async()=>{throw Object.assign(new Error('forbidden'),{status:403,code:'forbidden'});}}]});
  await assert.rejects(()=>denied.operations.listWithCoverage({circle:circle.id},{memberFallback:true}),
    error=>error.code==='network_error','an access-denied member is no fallback');
  const none=await fixture(t,{incumbent:async()=>{throw unreachable();},members:[]});
  await assert.rejects(()=>none.operations.listWithCoverage({circle:circle.id},{memberFallback:true}),error=>error.code==='network_error');

  const live=await fixture(t,{incumbent:async()=>[queued(2),queued(1,'lender')],members:[{keyId:'lender',answer:async()=>[queued(1,'lender')]}]});
  const answer=await live.operations.listWithCoverage({circle:circle.id},{memberFallback:true});
  assert.deepEqual(answer.coverage,{state:'complete'});
  assert.deepEqual(answer.items.map(row=>row.job_digest),[digest(2),digest(1)]);
  assert.deepEqual(live.calls,['incumbent'],'a reachable incumbent is the only source');
});

test('a person stopping the read stops the fallback too',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,{incumbent:async()=>{controller.abort();throw unreachable();},
    members:[{keyId:'lender',answer:async()=>[queued(1,'lender')]}]});
  await assert.rejects(()=>f.operations.listWithCoverage({circle:circle.id},{memberFallback:true,signal:controller.signal}));
  assert.deepEqual(f.calls,['incumbent']);
});

test('a parked member cannot erase a completed partial list at the shared deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let started;
  const parked=new Promise(resolve=>{started=resolve;});
  const f=await fixture(t,{incumbent:async()=>{throw unreachable();},members:[
    {keyId:'ready',answer:async()=>[queued(1,'ready')]},
    {keyId:'slow',answer:()=>{started();return new Promise(()=>{});}},
  ]});
  const reading=f.operations.listWithCoverage({circle:circle.id},{memberFallback:true,memberFallbackTimeoutMs:5});
  await parked;
  t.mock.timers.tick(5);
  const answer=await reading;
  assert.deepEqual(answer.items.map(row=>row.job_digest),[digest(1)]);
  assert.equal(answer.coverage.state,'partial');
  assert.deepEqual(answer.coverage.members.map(member=>member.state),['listed','unreachable']);
});

test('caller cancellation ends a parked fallback without waiting for its reader',async t=>{
  let started;
  const parked=new Promise(resolve=>{started=resolve;});
  const controller=new AbortController();
  const f=await fixture(t,{incumbent:async()=>{throw unreachable();},members:[
    {keyId:'slow',answer:()=>{started();return new Promise(()=>{});}},
  ]});
  const reading=f.operations.listWithCoverage({circle:circle.id},{memberFallback:true,signal:controller.signal});
  await parked;
  controller.abort();
  await assert.rejects(reading,{name:'AbortError'});
});
