import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api,boundedFetch,browserApi,waitFor} from './helpers/v1-app-fixture.mjs';
import {call,cookieOf} from './helpers/phone-client.mjs';
import {parseFact} from '../lib/v1/telemetry/contract.mjs';

function observer() {
  const rows=[];let generation=1,consent='on',installId='11111111-1111-4111-8111-111111111111';
  const telemetry={prepareRequest(){},observe(){},response(){},ui(){},start(){},close:async()=>{},view:()=>({effective:consent}),
    bootstrap:({headers}={})=>({installId:headers?.['sec-gpc']==='1'?null:installId,consent:headers?.['sec-gpc']==='1'?'off':consent,generation,remoteEnabled:consent==='on'&&headers?.['sec-gpc']!=='1',noticePending:false}),
    observeFact:(name,properties,scope)=>{parseFact(name,properties);rows.push({name,properties,scope});return true;},
    choose:({level})=>{consent=level;generation++;installId=level==='off'?null:'22222222-2222-4222-8222-222222222222';},
    restrict:()=>{telemetry.choose({level:'off'});},resetIdentity:()=>{generation++;installId='33333333-3333-4333-8333-333333333333';},markNoticeShown(){}};
  return {telemetry,rows};
}
test('app stop cancels its queued facts timer before fixture removal',async t=>{
  const f=await appFixture(t);
  let fired=0,afterClose=0,closed=false;
  const timers=[],callbacks=[];
  const {app,home}=await f.start('facts',{telemetryFactSchedule:fn=>{
    callbacks.push(fn);const timer=setTimeout(()=>{fired++;fn();},60000);timers.push(timer);return timer;
  }});
  const bootstrap=app.telemetry.bootstrap;
  app.telemetry.bootstrap=(...args)=>{if(closed)afterClose++;return bootstrap(...args);};
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  await api(app,'/api/status');assert.ok(timers.length>0);
  await app.close();closed=true;
  const directory=join(home,'v1','telemetry');await rm(directory,{recursive:true,force:true});
  const live=timers.filter(timer=>!timer._destroyed);
  // Calling a callback already queued by the event loop must also be harmless.
  for(const callback of callbacks)callback();
  const recreated=await access(directory).then(()=>true,()=>false);
  t.diagnostic(JSON.stringify({liveFactsTimers:live.length,lateBootstraps:afterClose,telemetryDirectoryRecreated:recreated}));
  assert.equal(live.length,0,'no facts timer may outlive the owner stop');
  assert.equal(afterClose,0,'a queued callback cannot recreate the telemetry consent lock');
  assert.equal(recreated,false,'removed telemetry directories stay removed');
  assert.equal(fired,0);
});
test('bootstrap requires authentication, rejects supplied IDs and respects request restrictions', {timeout:120000}, async t=>{
  const f=await appFixture(t);const {telemetry}=observer();const {app}=await f.start('facts',{telemetry});
  await api(app,'/api/telemetry/bootstrap',{token:null,status:401});
  await api(app,'/api/telemetry/bootstrap?installId=private',{status:400});
  const boot=await api(app,'/api/telemetry/bootstrap');
  assert.deepEqual(Object.keys(boot).sort(),['installId','consent','generation','remoteEnabled','noticePending'].sort());
  assert.equal(boot.installId,telemetry.bootstrap().installId);
  assert.equal((await api(app,'/api/telemetry/bootstrap',{headers:{'sec-gpc':'1'}})).remoteEnabled,false);
  await api(app,'/api/telemetry/choose',{method:'POST',body:{level:'counts'},status:400});
  await api(app,'/api/telemetry/choose',{method:'POST',body:{level:'on',installId:'private'},status:400});
});
test('setup marks emit entered, clear emits skipped, invalid marks emit nothing; observer failures cannot fail a mark', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const {app}=await f.start('facts',{telemetry,bootId:async()=>null,resumeHook:{install:async()=>false,remove:async()=>{}}});
  await api(app,'/api/setup/progress',{method:'POST',headers:{'faravan-surface':'cli'},body:{step:'kvm'}});
  await waitFor(()=>rows.some(r=>r.name==='onboarding_step_changed'),'entered setup observation');
  const entered=rows.find(r=>r.name==='onboarding_step_changed');assert.ok(entered);assert.deepEqual({...entered.properties,$set:undefined},{step:'kvm',outcome:'entered',duration_ms:0,surface:'cli',$set:undefined});assert.ok(entered.properties.$set.surfaces_used.includes('cli'));
  await api(app,'/api/setup/progress/clear',{method:'POST',body:{}});
  await waitFor(()=>rows.filter(r=>r.name==='onboarding_step_changed').at(-1)?.properties.outcome==='skipped','skipped setup observation');
  const count=rows.filter(r=>r.name==='onboarding_step_changed').length;await api(app,'/api/setup/progress',{method:'POST',body:{step:'private'},status:400});assert.equal(rows.filter(r=>r.name==='onboarding_step_changed').length,count);
  telemetry.observeFact=()=>{throw Error('private');};
  await api(app,'/api/setup/progress',{method:'POST',body:{step:'hypervisor'}});
});
test('consent and identity changes invalidate restricted event streams without exposing identity', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry}=observer();const {app}=await f.start('facts',{telemetry});
  const abort=new AbortController();t.after(()=>abort.abort());
  const response=await boundedFetch(app.origin+'/api/events',{headers:{'x-faravan-session-token':app.token,'sec-gpc':'1'},signal:abort.signal});
  const reader=response.body.getReader();let text='';
  const reading=(async()=>{try {for(;;){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);}}catch{}})();
  await api(app,'/api/telemetry/choose',{method:'POST',body:{level:'off'}});
  await api(app,'/api/telemetry/reset-id',{method:'POST',body:{}});
  // A regular response completes only after both synchronous notifications have been written.
  await waitFor(()=>(text.match(/event: telemetry\n/g)??[]).length===2,'telemetry invalidations');abort.abort();await reading;
  assert.equal((text.match(/event: telemetry\n/g)??[]).length,2,text);
  assert.ok(text.includes('"refresh":true'));assert.ok(!text.includes('"installId"'));assert.ok(!text.includes('"remoteEnabled"'));
  const replayAbort=new AbortController();t.after(()=>replayAbort.abort());
  const replay=await boundedFetch(app.origin+'/api/events',{headers:{'x-faravan-session-token':app.token,'faravan-telemetry':'off'},signal:replayAbort.signal});
  const replayReader=replay.body.getReader();let replayText='';
  while((replayText.match(/event: telemetry\n/g)??[]).length<2){const {value,done}=await replayReader.read();if(done)break;replayText+=new TextDecoder().decode(value);}
  replayAbort.abort();assert.ok(!replayText.includes('"installId"'));assert.ok(!replayText.includes('"remoteEnabled"'));
});
test('operation HTTP facts attribute each entry point and survive observer exceptions', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const {app}=await f.start('facts',{telemetry});
  rows.length=0;
  for(const surface of ['ui','cli','mcp','tray','installer','coordinator'])
    await api(app,'/api/ops/status.get',{method:'POST',body:{},headers:{'faravan-surface':surface}});
  await waitFor(()=>rows.filter(r=>r.name==='operation_completed').length===6,'entry point observations');
  const operations=rows.filter(r=>r.name==='operation_completed');assert.deepEqual(operations.map(r=>r.scope.surface),['ui','cli','mcp','tray','installer','coordinator']);
  telemetry.observeFact=()=>{throw Error('private');};await api(app,'/api/ops/status.get',{method:'POST',body:{}});
});
test('narrow paired phones cannot bootstrap; full app phones share host identity', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry}=observer();const {app}=await f.start('facts',{telemetry,networkInterfaces:()=>({eth0:[{address:'127.0.0.1',family:'IPv4',internal:false}]})});
  const handoff=await boundedFetch(app.handoffUrl(),{redirect:'manual'});await handoff.text();const browser=handoff.headers.get('set-cookie').split(';')[0];
  const key=join(f.root,'phone-key.pem'),cert=join(f.root,'phone-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
  const on=await api(app,'/api/phone/settings',{method:'POST',token:null,headers:{cookie:browser,origin:app.origin},body:{enabled:true,address:'127.0.0.1',keyFile:key,certFile:cert}});
  async function pair(access) {
    const start=await api(app,'/api/phone/pairing',{method:'POST',body:access?{access}:{}});
    const claim=await call(on.origin,'/phone/api/pair/claim',{method:'POST',body:{code:start.pairing.code,label:'Canary phone'}});
    await api(app,'/api/phone/pairing/confirm',{method:'POST',token:null,headers:{cookie:browser,origin:app.origin},body:{id:start.pairing.id,confirmed:true}});
    return cookieOf(await call(on.origin,'/phone/api/pair/status',{cookie:cookieOf(claim)}));
  }
  const narrow=await pair();assert.notEqual((await call(on.origin,'/api/telemetry/bootstrap',{cookie:narrow})).status,200);
  assert.equal((await call(on.origin,'/api/telemetry/bootstrap',{cookie:await pair('full')})).json.installId,telemetry.bootstrap().installId);
});

test('completed setup steps use the saved step and bounded elapsed time', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();let kvmOk=false,time=Date.now();
  const base=(await f.start('backend-base')).backend;
  const {app}=await f.start('completed',{telemetry,clock:{now:()=>time},bootId:async()=>null,resumeHook:{install:async()=>false,remove:async()=>{}},
    backendFactory:async()=>Object.assign(Object.create(base),{protectionSummary:async()=>({preflight:{checks:[{name:'kvm_access',ok:kvmOk}]}})})});
  await api(app,'/api/setup/progress',{method:'POST',body:{step:'kvm'}});time+=1234;kvmOk=true;
  await api(app,'/api/readiness?refresh=true');
  await waitFor(()=>rows.some(r=>r.name==='onboarding_step_changed'&&r.properties.outcome==='completed'),'completed step observation');
  const completed=rows.find(r=>r.name==='onboarding_step_changed'&&r.properties.outcome==='completed');
  assert.ok(completed);assert.equal(completed.properties.step,'kvm');assert.equal(completed.properties.duration_ms,1234);
});
test('successful plan saves emit provider-specific unverified profile properties', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const {app}=await f.start('plans',{telemetry});
  await api(app,'/api/lending/limits',{method:'POST',headers:{'faravan-surface':'ui'},body:{lendingPolicy:{accountPlans:{claude:'max5',codex:'plus'}}}});
  await waitFor(()=>rows.filter(r=>r.name==='account_plan_observed').length>=2,'saved plan observations');
  const plans=rows.filter(r=>r.name==='account_plan_observed');
  assert.equal(plans.length,2);assert.equal(plans[0].properties.$set.claude_plan,'max5');assert.equal(plans[1].properties.$set.codex_plan,'plus');
  for(const row of plans){assert.equal(row.properties.source,'user_selected');assert.equal(row.properties.subscription_verified,false);}
});
test('saved job submission and terminal observation keep requested and executed evidence separate', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const {owner,lender,circle}=await f.connect({}, {telemetry});
  const {jobDigest}=await api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes','faravan-surface':'cli'},body:{circle:circle.id,prompt:'canary-private-prompt',noSource:true,result:{kind:'message'},harness:'codex',model:'gpt-5.4'}});
  await waitFor(()=>rows.some(r=>r.name==='job_requested'),'submission observation');
  const requested=rows.find(r=>r.name==='job_requested');assert.ok(requested);assert.equal(requested.properties.requested_model,'gpt-5.4');
  const raw=f.jobs.get(jobDigest);const at=new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
  Object.assign(raw,{state:'failed',attempts_started:1,current_attempt:{attempt_id:'11111111-1111-4111-8111-111111111111',job_digest:jobDigest,generation:1,state:'released',holder:lender.app.device.keyId,claimed_at:at,lease_expires_at:at,execution_started_at:at,reason:null,stopped_at:at,compute_stopped:true}});
  // The existing job watcher receives the synthetic coordinator's changed revision.
  for(const wake of f.jobWatches.get(jobDigest)??[])wake();
  await waitFor(()=>rows.find(r=>r.name==='job_execution_finished'),'terminal job fact');
  const finished=rows.find(r=>r.name==='job_execution_finished');assert.equal(finished.properties.requested_model,'gpt-5.4');assert.equal(finished.properties.executed_model,null);assert.equal(finished.properties.model_source,'unknown');assert.equal(finished.scope.surface,'cli');
  assert.ok(!JSON.stringify(rows).includes('canary-private'));assert.ok(!JSON.stringify(rows).includes(jobDigest));
});

test('borrower completion reads the verified execution receipt outside the operation response', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const {owner,circle}=await f.connect({}, {telemetry});
  const ui=await browserApi(owner.app);
  const {jobDigest}=await ui('/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'private-prompt',noSource:true,result:{kind:'message'},harness:'codex',model:'gpt-5.4'}});
  await f.complete(jobDigest,'owner',{output:{kind:'message'},receipt:{model:'gpt-5.4',harness:'codex',candidate_format:'tree'}});
  await api(owner.app,'/api/jobs/'+encodeURIComponent(jobDigest)+'/receipt?circle='+circle.id);
  await waitFor(()=>rows.find(r=>r.name==='job_execution_finished'),'verified terminal model');
  const fact=rows.find(r=>r.name==='job_execution_finished');assert.equal(fact.properties.executed_model,'gpt-5.4');assert.equal(fact.properties.requested_model,'gpt-5.4');assert.equal(fact.properties.model_source,'execution_report');assert.equal(fact.scope.surface,'ui');
});

for(const restriction of ['off','gpc','reset'])test('deferred setup completion retains '+restriction+' provenance', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();let kvmOk=false;
  const base=(await f.start('backend')).backend;
  const {app}=await f.start('provenance',{telemetry,bootId:async()=>null,resumeHook:{install:async()=>false,remove:async()=>{}},backendFactory:async()=>Object.assign(Object.create(base),{protectionSummary:async()=>({preflight:{checks:[{name:'kvm_access',ok:kvmOk}]}})})});
  await api(app,'/api/setup/progress',{method:'POST',body:{step:'kvm'},headers:restriction==='off'?{'faravan-telemetry':'off'}:restriction==='gpc'?{'sec-gpc':'1'}:{}});
  if(restriction==='reset')await api(app,'/api/telemetry/reset-id',{method:'POST',body:{}});
  rows.length=0;kvmOk=true;await api(app,'/api/readiness?refresh=true');
  await new Promise(resolve=>setTimeout(resolve,75));assert.deepEqual(rows.filter(row=>row.name==='onboarding_step_changed'),[]);
  kvmOk=false;await api(app,'/api/setup/progress',{method:'POST',body:{step:'kvm'}});kvmOk=true;await api(app,'/api/readiness?refresh=true');
  await waitFor(()=>rows.some(row=>row.name==='onboarding_step_changed'&&row.properties.outcome==='completed'),'valid current-generation control');
});
test('a provisional expired claim does not hide a later successful borrower result', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();const seen=[];telemetry.observe=(kind,data)=>{if(kind==='event:job')seen.push(data.state);};
  const {owner,lender,circle}=await f.connect({}, {telemetry});
  const {jobDigest}=await api(owner.app,'/api/jobs',{headers:{'faravan-confirm':'yes'},method:'POST',body:{circle:circle.id,prompt:'private',noSource:true,result:{kind:'message'},harness:'codex',model:'gpt-5.4'}});
  await f.complete(jobDigest,'owner',{output:{kind:'message'},receipt:{model:'gpt-5.4',harness:'codex',candidate_format:'tree'}});
  const raw=f.jobs.get(jobDigest),completedAttempt=structuredClone(raw.current_attempt);
  raw.state='failed';raw.current_attempt={...completedAttempt,state:'released',reason:'lease_expired'};
  for(const wake of f.jobWatches.get(jobDigest)??[])wake();await waitFor(()=>seen.includes('failed'),'provisional job observation');
  assert.equal(rows.filter(row=>row.name==='job_execution_finished').length,0);
  raw.state='result-accepted';raw.current_attempt=completedAttempt;
  for(const wake of f.jobWatches.get(jobDigest)??[])wake();await waitFor(()=>rows.find(row=>row.name==='job_execution_finished'),'late successful result');
  const terminal=rows.find(row=>row.name==='job_execution_finished');assert.equal(terminal.properties.outcome,'finished');assert.equal(terminal.properties.executed_model,'gpt-5.4');
});

test('restored setup progress has no transferable telemetry provenance', {timeout:120000},async t=>{
  const f=await appFixture(t);const {telemetry,rows}=observer();let kvmOk=false;
  const base=(await f.start('backend')).backend;
  const extra={telemetry,bootId:async()=>null,resumeHook:{install:async()=>false,remove:async()=>{}},backendFactory:async()=>Object.assign(Object.create(base),{protectionSummary:async()=>({preflight:{checks:[{name:'kvm_access',ok:kvmOk}]}})})};
  const first=await f.start('restored',extra);await api(first.app,'/api/setup/progress',{method:'POST',body:{step:'kvm'},headers:{'faravan-telemetry':'off'}});
  await first.app.close();rows.length=0;kvmOk=true;const second=await f.start('restored',extra);await api(second.app,'/api/readiness?refresh=true');
  await new Promise(resolve=>setTimeout(resolve,75));assert.deepEqual(rows.filter(row=>row.name==='onboarding_step_changed'),[]);
  kvmOk=false;await api(second.app,'/api/setup/progress',{method:'POST',body:{step:'kvm'}});kvmOk=true;await api(second.app,'/api/readiness?refresh=true');
  await waitFor(()=>rows.some(row=>row.name==='onboarding_step_changed'&&row.properties.outcome==='completed'),'valid mark after restart');
});

// A submission waiting in the mutation queue keeps the consent it arrived under; later consent routes bypass the queue.
async function heldSubmission(t,{start}) {
  let held=false,gate=null;
  const f=await appFixture(t);const {telemetry,rows}=observer();
  const {owner,circle}=await f.connect({}, {telemetry,identityProbe:async()=>{if(held)await new Promise(resolve=>{gate=resolve;});return {installed:true,signedIn:true};}});
  if(start==='off')await api(owner.app,'/api/telemetry/choose',{method:'POST',body:{level:'off'}});
  rows.length=0;held=true;
  const refresh=api(owner.app,'/api/agents/refresh',{method:'POST',body:{}});
  await waitFor(()=>gate,'the mutation lane is held');
  const submit=api(owner.app,'/api/jobs',{method:'POST',headers:{'faravan-confirm':'yes','faravan-surface':'cli'},body:{circle:circle.id,prompt:'private',noSource:true,result:{kind:'message'},harness:'codex',model:'gpt-5.4'}});
  await new Promise(resolve=>setTimeout(resolve,100));
  return {owner,rows,release:async()=>{held=false;gate();await refresh;return submit;}};
}
test('a submission accepted while telemetry is Off publishes no fact when it is turned On during the queue wait', {timeout:120000},async t=>{
  const h=await heldSubmission(t,{start:'off'});
  await api(h.owner.app,'/api/telemetry/choose',{method:'POST',body:{level:'on'}});
  await h.release();
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.deepEqual(h.rows.filter(r=>r.name==='job_requested'),[]);
});
test('a submission accepted in generation N never publishes under N+1 after an identity reset in the queue wait', {timeout:120000},async t=>{
  const h=await heldSubmission(t,{start:'on'});
  await api(h.owner.app,'/api/telemetry/reset-id',{method:'POST',body:{}});
  await h.release();
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.deepEqual(h.rows.filter(r=>r.name==='job_requested'),[]);
});
