import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api} from './helpers/v1-lifecycle-fixture.mjs';

// These requests enter the real HTTP handler; only the circle transport fails.
test('failed reads do not become lending problems; job changes still do', {timeout:120000}, async t=>{
  const f=await appFixture(t);
  const {lender,circle}=await f.connect({});
  const device=lender.app.device,original=device.client.bind(device);
  const originalPeople=device.listPeople;
  t.after(()=>{device.listPeople=originalPeople;});
  const originalJobRead=device.jobReadClient;
  t.after(()=>{device.jobReadClient=originalJobRead;});
  const before=await api(lender.app,'/api/lending');
  const file=join(lender.home,'v1','lending-errors.jsonl');
  const rows=async()=>(await readFile(file,'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
  t.after(()=>{device.client=original;});
  const source=new URL('../lib/v1/client.mjs',import.meta.url).href;
  const failure=name=>{
    const error=name==='AbortError'?new DOMException('private abort','AbortError'):new Error('private read');
    error.stack=name+': private\n    at read ('+source+':123:45)';
    return error;
  };
  for(const route of ['/api/jobs?circle='+circle.id,'/api/circles/'+circle.id+'/people']) {
    for(const name of ['AbortError','Error'])await t.test(name+' on '+route,async()=>{
      device.client=async()=>({async *listJobs(){throw failure(name);}});
      device.listPeople=async()=>{throw failure(name);};
      const answer=await api(lender.app,route,{status:409});
      assert.equal(answer.error_id,undefined,'a failed read has no lending error reference');
    });
  }
  await t.test('caller abandons a jobs-list read after upstream work starts',async()=>{
    let entered,finished;
    const started=new Promise(resolve=>{entered=resolve;});
    const settled=new Promise(resolve=>{finished=resolve;});
    device.client=async()=>({async *listJobs({signal}){
      assert.ok(signal,'coverage read passes its caller lifetime upstream');
      entered();
      try {await new Promise((_,reject)=>{
        const stop=()=>reject(signal.reason);
        if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
      });} finally {finished();}
    }});
    const controller=new AbortController();
    const pending=fetch(lender.app.origin+'/api/jobs?circle='+circle.id+'&coverage=1',{
      headers:{'x-faravan-session-token':lender.app.token},signal:controller.signal});
    const rejected=assert.rejects(pending,{name:'AbortError'});
    await started;controller.abort();await rejected;await settled;
  });
  await t.test('caller abandons another read before its upstream abort arrives',async()=>{
    let entered,release,finished;
    const started=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const settled=new Promise(resolve=>{finished=resolve;});
    device.listPeople=async()=>{entered();await gate;finished();throw failure('AbortError');};
    const controller=new AbortController();
    const pending=fetch(lender.app.origin+'/api/circles/'+circle.id+'/people',{
      headers:{'x-faravan-session-token':lender.app.token},signal:controller.signal});
    const rejected=assert.rejects(pending,{name:'AbortError'});
    try {await started;controller.abort();await rejected;}
    finally {release();}
    await settled;
  });
  await t.test('a domain refusal on a read keeps its field and is not an internal error',async()=>{
    device.listPeople=async()=>{throw Object.assign(new Error('Pick a circle first'),{code:'invalid_request',field:'circle'});};
    const res=await fetch(lender.app.origin+'/api/circles/'+circle.id+'/people',{headers:{'x-faravan-session-token':lender.app.token}});
    const body=await res.json();
    assert.equal(body.field,'circle',res.status+' '+JSON.stringify(body));
    assert.equal(body.message,'Pick a circle first');
    assert.notEqual(body.code,'internal_error','a typed refusal is not an internal error');
  });
  device.client=original;
  assert.deepEqual(await api(lender.app,'/api/lending'),before,'failed reads leave lending status unchanged');
  // A job-changing route must keep the old internal-error diagnostic and safe source.
  device.jobReadClient=async()=>({cancelJob:async()=>{throw failure('Error');}});
  const digest='sha256:'+'a'.repeat(64);
  const write=await api(lender.app,'/api/jobs/'+encodeURIComponent(digest)+'/cancel',{
    method:'POST',body:{circle:circle.id},status:409});
  assert.equal(write.code,'internal_error');
  assert.ok(write.error_id);
  assert.equal((await device.intentStore(circle.id).get('cancel:'+digest)).state,'pending',
    'the failed cancel touched a job by saving its intent');
  device.client=original;
  await lender.app.close(); // flush the diagnostic queue before asserting absence
  const diagnostics=await rows();
  assert.equal(diagnostics.filter(row=>row.code==='internal_error').length,1);
  const row=diagnostics.find(row=>row.ref===write.error_id);
  assert.equal(row.source,'lib/v1/client.mjs:123');
  assert.match(row.stage,/^POST \/api\/jobs/);
  assert.doesNotMatch(JSON.stringify(diagnostics),/(GET|HEAD) \/api\/(jobs|circles)|private/);
});
