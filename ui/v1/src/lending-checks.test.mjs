import test from 'node:test';
import assert from 'node:assert/strict';
import {recheckReadiness,checkOutcome} from './lending-checks.mjs';
import {createApi} from './api.mjs';

const at='2026-10-20T07:14:00Z';
const ready={ready:true,protection:{observed_at:at}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('one forced readiness check is pending after 15 seconds and reports the measured 22.375-second success', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const calls=[];
  let settled=false;
  const result=recheckReadiness({
    get(path,signal) {
      calls.push({path,signal});
      return new Promise((resolve,reject)=>{
        setTimeout(()=>resolve(ready),22375);
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });
    },
  }).then(value=>{settled=true;return value;},error=>{settled=true;return error;});

  t.mock.timers.tick(15001);
  await flush();
  assert.equal(settled,false,'the forced check remains pending past the old observer deadline');
  assert.equal(calls[0].signal.aborted,false);
  assert.deepEqual(calls.map(call=>call.path),['readiness?refresh=true']);

  t.mock.timers.tick(22375-15001);
  assert.equal(await result,ready);
  assert.equal(checkOutcome(ready,'America/Chicago'),'Sandbox checks passed. Last checked Oct 20, 2026, 2:14 AM CDT');
});

test('readiness has a 90-second caller deadline and navigation can cancel it sooner', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(AbortSignal,'timeout',ms=>{
    const deadline=new AbortController();
    setTimeout(()=>deadline.abort(new DOMException('Timed out','TimeoutError')),ms);
    return deadline.signal;
  });
  const api={get:(_path,signal)=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })};
  const navigation=new AbortController();
  const cancelled=assert.rejects(recheckReadiness(api,navigation.signal),{name:'AbortError'});
  navigation.abort();
  await cancelled;

  const deadline=assert.rejects(recheckReadiness(api),{name:'TimeoutError'});
  t.mock.timers.tick(89999);
  let settled=false;
  deadline.then(()=>{settled=true;});
  await flush();
  assert.equal(settled,false);
  t.mock.timers.tick(1);
  await deadline;
});

test('readiness observation time includes the calendar date and zone',()=>{
  const text=checkOutcome({ready:true,observed_at:at},'UTC');
  assert.match(text,/Last checked Oct 20, 2026/);
  assert.match(text,/UTC/);
  assert.notEqual(text,checkOutcome({ready:true,observed_at:'2026-10-21T07:14:00Z'},'UTC'));
  assert.equal(checkOutcome({ready:true}),'Sandbox checks passed.');
});

test('readiness shows the first authoritative failed check and its existing remedy',()=>{
  const report={ready:false,observed_at:at,checks:[
    {ok:true,label:'Sandbox service is running.'},
    {ok:false,unknown:true,label:'Docker sign-in was unconfirmed.',remedy:'Sign in to Docker'},
    {ok:false,label:'Faravan could not read free disk space.',remedy:'Check access to the named filesystem.'},
    {ok:false,label:'Required job limits are unavailable.',remedy:'Open Settings'},
  ]};
  assert.equal(checkOutcome(report),'Faravan could not read free disk space — Check access to the named filesystem.');
  assert.equal(checkOutcome({ready:false,checks:[{ok:false,label:'The sandbox check timed out. Choose Check again.',remedy:'Choose Check again.'}]}),
    'The sandbox check timed out. Choose Check again.');
  assert.equal(checkOutcome({ready:false,observed_at:at,checks:[{ok:false,unknown:true,label:'The sandbox service timed out.'}]}),
    'Faravan couldn’t confirm readiness. Check again.');
});

test('passing preflight does not hide a failed or unconfirmed workspace start',()=>{
  const ready={ready:true,checks:[{name:'docker_login',ok:true,signinVerified:false}]};
  assert.match(checkOutcome(ready),/hasn’t confirmed a Docker workspace start/);
  assert.match(checkOutcome({...ready,checks:[{...ready.checks[0],checking:true}]}),/is checking whether Docker can start a workspace/);
  assert.match(checkOutcome({...ready,checks:[{...ready.checks[0],createAccepted:true}]}),/Sandbox checks passed/);
  assert.match(checkOutcome({...ready,workspaceCheck:{ok:true}}),/Sandbox checks passed/);
  assert.equal(checkOutcome({...ready,workspaceCheck:{ok:false,label:'The test workspace took too long to start.',remedy:'Choose Check again.'}}),
    'The test workspace took too long to start — Choose Check again.');
});

test('Check again waits for one HTTP transfer past the usual read timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const api=createApi('session',(url,{signal})=>{
    calls++;
    assert.equal(url,'/api/readiness?refresh=true');
    return new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new DOMException('Timed out','AbortError')),{once:true});
      setTimeout(()=>resolve(Response.json(ready)),45000);
    });
  },{readRetryDelay:0});
  const request=recheckReadiness(api);
  t.mock.timers.tick(30001);
  await flush();
  assert.equal(calls,1);
  t.mock.timers.tick(14999);
  assert.deepEqual(await request,ready);

  let failedCalls=0;
  const refused=createApi('session',async()=>{failedCalls++;return Response.json({code:'unavailable'},{status:503});});
  await assert.rejects(recheckReadiness(refused),{status:503});
  assert.equal(failedCalls,1);
});
