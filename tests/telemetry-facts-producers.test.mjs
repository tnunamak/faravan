import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetryFacts, systemProfile, mcpClient, requestedJob, finishedJob, surfaceOf} from '../lib/v1/telemetry-facts.mjs';
import {FACT_SCHEMAS,parseFact} from '../lib/v1/telemetry/contract.mjs';

test('requested model never substitutes for execution evidence', () => {
  const requested={harness:['codex'],model:{any_of:['gpt-5.4']},effort:'high'};
  assert.equal(requestedJob(requested).requested_model,'gpt-5.4');
  assert.equal(finishedJob({requirements:requested,role:'borrower',outcome:'finished'}).executed_model,null);
  const fact=finishedJob({requirements:requested,receipt:{model:'gpt-5.4-mini',harness:'codex',effort:'low'},role:'lender',outcome:'finished'});
  assert.equal(fact.executed_model,'gpt-5.4-mini');assert.equal(fact.requested_model,'gpt-5.4');
  assert.equal(fact.model_source,'execution_report');
  assert.equal(requestedJob({model:'private-model'}).requested_model,'custom');
});
test('job producers emit only allowlisted model facts',()=>{
  const rows=[];
  const facts=createTelemetryFacts({telemetry:{observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  facts.job('public',requestedJob({model:'gpt-5.4'}));
  facts.job('custom',requestedJob({model:'private-model-label'}));
  facts.job('custom',finishedJob({receipt:{model:'private-execution-label'},role:'lender',outcome:'finished'}),{terminal:true});
  facts.job('alternatives',requestedJob({model:{any_of:['gpt-5.4','private-alternative-label']}}));
  facts.drain();
  assert.deepEqual(rows.map(({name,p})=>[name,p.requested_model,p.executed_model]),[
    ['job_requested','gpt-5.4',undefined],
    ['job_requested','custom',undefined],
    ['job_execution_finished','custom','custom'],
    ['job_requested',null,undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(rows),/private-(?:model|execution|alternative)-label/);
});

test('operation facts map structured refusals and never emit free-form text',()=>{
  const rows=[];
  const facts=createTelemetryFacts({telemetry:{observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  const resultCode=FACT_SCHEMAS.operation_completed.error_code.values.find(code=>typeof code==='string'&&code.startsWith('result_'));
  assert.ok(resultCode,'the fixed vocabulary has an apply-refusal code');
  for(const [status,body] of [
    [409,{code:'conflict'}],
    [400,{code:'free-form-error-label'}],
    [409,{code:'apply_refused',apply_code:resultCode.slice('result_'.length)}],
    [409,{code:'repo_refused',repo_code:'conflict'}],
    [401,{code:'conflict'}],
    [429,{code:'conflict'}],
    [200,{code:'conflict'}],
  ]) facts.operation({opId:'status.get',status,body:{...body,message:'free-form error detail'}});
  facts.drain();
  assert.deepEqual(rows.map(({name,p})=>[name,p.ok,p.error_code]),[
    ['operation_completed',false,'conflict'],
    ['operation_completed',false,'unknown'],
    ['operation_completed',false,resultCode],
    ['operation_completed',false,'conflict'],
    ['operation_completed',false,'unauthorized'],
    ['operation_completed',false,'rate_limited'],
    ['operation_completed',true,null],
  ]);
  assert.doesNotMatch(JSON.stringify(rows),/free-form/);
});

test('system profile normalizes raw CPU and OS values and buckets RAM for the person', () => {
  const value=systemProfile({platform:'linux',arch:'x64',release:'6.8.1-private-host',cpus:[{model:'AMD Ryzen private-host'}],parallelism:12,totalmem:17*1024**3,docker:{installed:true,running:false,signedIn:true,version:'28.1.0'}});
  assert.equal(value.cpu_class,'amd');assert.equal(value.$set.ram_bucket,'32');assert.equal(value.arch,'amd64');assert.equal(value.os_major,6);
  assert.doesNotThrow(()=>parseFact('system_profile_observed',value));assert.ok(!JSON.stringify(value).includes('private'));
});
test('MCP client names and versions are a closed reported vocabulary', () => {
  for(const [name,family] of [['Claude Code','claude'],['codex','codex'],['ChatGPT','chatgpt'],['Cursor','cursor'],['Visual Studio Code','vscode'],['private@example.test','other']])
    assert.equal(mcpClient({name,version:'1.2.3'}).client_family,family);
  assert.deepEqual(mcpClient({name:'private',version:'1.2-private/token'}),{client_family:'other',source:'reported'});
});
test('entry point surfaces are bounded; phone writer overrides spoofed headers', () => {
  for(const surface of ['ui','cli','mcp','tray','installer','coordinator'])assert.equal(surfaceOf({headers:{'faravan-surface':surface}}),surface);
  assert.equal(surfaceOf({writer:'phone',headers:{'faravan-surface':'ui'}}),'phone');
  assert.equal(surfaceOf({headers:{'faravan-surface':'private'}}),'http');
});
test('startup/profile wait for remote gate, retry refused facts, refresh daily and after reset', () => {
  let time=0,enabled=false,accept=false,generation=1;const rows=[];
  const telemetry={bootstrap:()=>({remoteEnabled:enabled,generation}),observeFact:(name,properties)=>{rows.push({name,properties});return accept;}};
  const facts=createTelemetryFacts({telemetry,now:()=>time,monotonic:()=>time,profile:()=>({os_type:'linux'}),plans:()=>({claude:'max5',codex:'plus'})});
  facts.tick();assert.equal(rows.length,0);enabled=true;facts.tick();assert.ok(rows.some(r=>r.name==='app_started'));
  rows.length=0;accept=true;facts.tick();assert.ok(rows.some(r=>r.name==='app_started'));
  const plans=rows.filter(r=>r.name==='account_plan_observed');assert.equal(plans.length,2);
  assert.equal(plans[0].properties.subscription_verified,false);assert.equal(plans[0].properties.source,'user_selected');
  assert.equal(plans[0].properties.$set.claude_plan,'max5');assert.equal(plans[1].properties.$set.codex_plan,'plus');
  rows.length=0;facts.tick();assert.equal(rows.filter(r=>r.name==='system_profile_observed').length,0);
  time+=86400000;facts.tick();assert.ok(rows.some(r=>r.name==='system_profile_observed'));
  rows.length=0;generation++;facts.tick();assert.ok(rows.some(r=>r.name==='app_started'));
});
test('observations never throw and never send private input fields', () => {
  const facts=createTelemetryFacts({telemetry:{bootstrap:()=>{throw Error('private');},observeFact:()=>{throw Error('private');}}});
  assert.doesNotThrow(()=>{facts.tick();facts.operation({opId:'setup.mark_step',status:200,durationMs:1,body:{prompt:'private',path:'/secret',email:'private'}});facts.close();});
  const rows=[];const safe=createTelemetryFacts({telemetry:{observeFact:(name,properties)=>{rows.push(properties);return true;}}});
  safe.operation({opId:'setup.mark_step',status:500,durationMs:10,body:{code:'private-token',prompt:'private',repo:'private'}});
  safe.drain();
  assert.equal(rows[0].error_code,'unknown');assert.ok(!JSON.stringify(rows).includes('private'));
});
test('local gaps have unknown cause and heartbeats are limited to five minutes', () => {
  let time=0;const rows=[];const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation:1}),observeFact:(name,p)=>{rows.push({name,p});return true;}},now:()=>time,monotonic:()=>time,profile:()=>({}),plans:()=>({})});
  facts.tick();time=1000;facts.tick();assert.equal(rows.filter(r=>r.name==='app_heartbeat').length,1);
  time=600000;facts.tick();assert.equal(rows.find(r=>r.name==='app_resumed').p.gap_reason,'unknown');
  facts.close();facts.drain();assert.equal(rows.at(-1).p.clean,true);
});

test('request-level OFF follows a terminal job; unknown prior-session borrower jobs fail closed',()=>{
  const rows=[];const facts=createTelemetryFacts({telemetry:{observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  facts.job('private-job',requestedJob({harness:'codex'}),{headers:{'faravan-telemetry':'off'},surface:'cli'});
  facts.job('private-job',finishedJob({role:'borrower',outcome:'finished'}),{terminal:true,requireRequested:true});
  facts.job('prior-session-job',finishedJob({role:'borrower',outcome:'finished'}),{terminal:true,requireRequested:true});
  facts.drain();assert.deepEqual(rows,[]);
  facts.job('control',requestedJob({harness:'codex'}),{surface:'cli'});facts.drain();assert.equal(rows.length,1);
});
test('a failed profile source cannot suppress independent heartbeat observations',()=>{
  const rows=[];const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation:1}),observeFact:name=>{rows.push(name);return true;}},profile:()=>{throw Error('unreadable');},constraints:()=>{throw Error('unreadable');}});
  facts.tick();assert.ok(rows.includes('app_heartbeat'));
});

test('a receipt read pending during identity reset cannot publish under the replacement identity',async()=>{
  let generation=1,resolveRead;const rows=[];
  const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation}),observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  facts.job('local-key',requestedJob({model:'gpt-5.4'}),{surface:'cli'});
  facts.finishBorrower('local-key','finished',()=>new Promise(resolve=>{resolveRead=resolve;}));
  facts.drain();await new Promise(resolve=>setImmediate(resolve));generation++;resolveRead({receipt:{model:'gpt-5.4'}});
  await new Promise(resolve=>setImmediate(resolve));facts.drain();assert.equal(rows.length,1);
});

test('registered REST routes and narrow phone actions emit one fixed operation without path identifiers',()=>{
  const rows=[];const facts=createTelemetryFacts({telemetry:{observeFact:(name,p,scope)=>{rows.push({name,p,scope});return true;}}});
  facts.operation({writer:'app',req:{method:'GET',url:'/api/status',headers:{'faravan-surface':'ui'}},status:200,durationMs:5});
  facts.operation({writer:'phone',req:{method:'POST',url:'/phone/api/requests/private-id/accept',headers:{}},status:200});
  facts.operation({writer:'app',req:{method:'GET',url:'/api/status',headers:{'faravan-operation-dispatch':'1','faravan-surface':'cli'}},status:200});
  facts.drain();
  assert.deepEqual(rows.map(row=>row.p.op),['status.get','approvals.accept']);assert.equal(rows[1].scope.surface,'phone');
  assert.ok(!JSON.stringify(rows).includes('private-id'));
});

test('foreground facts clear the previous identity surface cohort before the next timer tick',()=>{
  let generation=1;const rows=[];const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation}),observeFact:(name,p)=>{rows.push(p);return true;}}});
  facts.operation({opId:'status.get',status:200,req:{headers:{'faravan-surface':'cli'}}});
  facts.drain();generation++;facts.operation({opId:'status.get',status:200,req:{headers:{'faravan-surface':'ui'}}});
  facts.drain();assert.deepEqual(rows.at(-1).$set.surfaces_used,['ui']);
});

test('close drains an admitted failed completion before app_closed exactly once',async()=>{
  const rows=[],callbacks=[];
  const facts=createTelemetryFacts({schedule:fn=>{callbacks.push(fn);return {unref(){}};},
    telemetry:{bootstrap:()=>({remoteEnabled:true,generation:1}),observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  facts.job('job',requestedJob({harness:'codex'}),{surface:'cli'});facts.drain();
  assert.equal(facts.finishBorrower('job','failed'),true);
  await facts.close();
  for(const callback of callbacks)callback();
  assert.deepEqual(rows.map(row=>row.name),['job_requested','job_execution_finished','app_closed']);
  assert.equal(rows[1].p.outcome,'failed');
  assert.equal(facts.finishBorrower('job','failed'),false);
});

test('close waits for an already-admitted result read and refuses new observations',async()=>{
  const rows=[];let resolveRead;
  const facts=createTelemetryFacts({telemetry:{bootstrap:()=>({remoteEnabled:true,generation:1}),observeFact:(name,p)=>{rows.push({name,p});return true;}}});
  facts.job('job',requestedJob({harness:'codex'}),{surface:'cli'});facts.drain();
  facts.finishBorrower('job','finished',()=>new Promise(resolve=>{resolveRead=resolve;}));facts.drain();
  await new Promise(resolve=>setImmediate(resolve));
  const closing=facts.close({drainMs:1000});
  assert.equal(facts.finishBorrower('new','failed'),false);
  resolveRead({receipt:{harness:'codex',model:'gpt-5.4'}});
  await closing;
  assert.deepEqual(rows.map(row=>row.name),['job_requested','job_execution_finished','app_closed']);
  assert.equal(rows[1].p.executed_model,'gpt-5.4');
});

test('a result read beyond the close budget cannot publish or reopen telemetry',async()=>{
  const rows=[];let resolveRead,bootstraps=0;
  const facts=createTelemetryFacts({telemetry:{bootstrap:()=>{bootstraps++;return {remoteEnabled:true,generation:1};},observeFact:name=>{rows.push(name);return true;}}});
  facts.job('job',requestedJob({harness:'codex'}));facts.drain();
  facts.finishBorrower('job','finished',()=>new Promise(resolve=>{resolveRead=resolve;}));facts.drain();
  await new Promise(resolve=>setImmediate(resolve));
  await facts.close({drainMs:5});
  const before=bootstraps,emitted=rows.slice();
  resolveRead({receipt:{harness:'codex'}});await new Promise(resolve=>setImmediate(resolve));
  facts.tick();facts.drain();
  assert.deepEqual(rows,emitted);assert.deepEqual(rows.filter(name=>name!=='app_closed'),['job_requested']);assert.equal(bootstraps,before);
});
