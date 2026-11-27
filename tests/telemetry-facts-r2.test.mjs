import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {runMcpServer} from '../lib/v1/mcp.mjs';
import {createTelemetryFacts,observeLenderClient} from '../lib/v1/telemetry-facts.mjs';
const busy=()=>{const until=performance.now()+500;while(performance.now()<until){/* deliberate synchronous observer */}};
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function observer() {
  const rows=[],scheduled=[];let generation=1,level='on';
  const telemetry={prepareRequest(){},observe(){},response(){},ui(){},start(){},close:async()=>{},view:()=>({effective:level}),
    bootstrap:()=>({installId:level==='on'?'11111111-1111-4111-8111-111111111111':null,consent:level,generation,remoteEnabled:level==='on',noticePending:false}),
    observeFact:(name,properties)=>{rows.push({name,properties});return true;},
    choose:async input=>{level=input.level;generation++;},resetIdentity:async()=>{generation++;},restrict:async()=>{level='off';generation++;},markNoticeShown:async()=>{generation++;}};
  const schedule=fn=>{scheduled.push(fn);};
  const drain=()=>{while(scheduled.length)scheduled.shift()();};
  return {telemetry,rows,schedule,drain};
}
test('a 500 ms observer runs after MCP initialize output, outside the response microtasks',async t=>{
  const input=new PassThrough(),output=new PassThrough();let observed=0;
  const running=runMcpServer({input,output,opsClient:{},telemetry:{observeFact:()=>{busy();observed++;return true;}}});
  t.after(async()=>{input.end();await running;});
  const response=once(output,'data'),began=performance.now();
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'codex',version:'1'}}})+'\n');
  const [data]=await response;assert.equal(JSON.parse(data).id,1);assert.equal(observed,0);assert.ok(performance.now()-began<400);
  await waitFor(()=>observed===1,'the deferred slow observer');
});
test('a 500 ms observer runs after lender completion resolves',async()=>{
  let observed=0;const scheduled=[];
  const facts=createTelemetryFacts({schedule:fn=>scheduled.push(fn),telemetry:{observeFact:()=>{busy();observed++;return true;}}});
  const attempt={attempt_id:'a'},client=observeLenderClient({claimJob:async()=>({attempt,job:{payload:{requirements:{harness:['codex']}}}}),completeAttempt:async()=> 'ok'},facts);
  await client.claimJob();const began=performance.now();assert.equal(await client.completeAttempt(attempt,{receipt:{model:'gpt-5.4'}}),'ok');
  assert.equal(observed,0);assert.ok(performance.now()-began<400);
  while(scheduled.length)scheduled.shift()();assert.equal(observed,1);
});
test('a 500 ms observer runs after a setup mark HTTP response', {timeout:120000},async t=>{
  const f=await appFixture(t),o=observer();let observed=0;
  o.telemetry.observeFact=(name,properties)=>{o.rows.push({name,properties});if(name==='onboarding_step_changed'){busy();observed++;}return true;};
  const {app}=await f.start('slow',{telemetry:o.telemetry,telemetryFactSchedule:o.schedule,bootId:async()=>null,resumeHook:{install:async()=>false,remove:async()=>{}}});
  const began=performance.now();const response=await api(app,'/api/setup/progress',{method:'POST',body:{step:'kvm'}});
  assert.equal(response.resume.step,'kvm');assert.equal(observed,0);assert.ok(performance.now()-began<400);
  o.drain();assert.equal(observed,1);
});
for(const mutation of ['reset','off-on'])test('a pending borrower submit retains its initiating '+mutation+' scope', {timeout:120000},async t=>{
  const f=await appFixture(t),o=observer();const {owner,circle}=await f.connect({}, {telemetry:o.telemetry,telemetryFactSchedule:o.schedule});o.drain();o.rows.length=0;
  const entered=gate(),release=gate(),original=f.override;let hold=true;
  f.override=async info=>{if(hold&&info.route==='/jobs'&&info.req.method==='POST'){hold=false;entered.resolve();await release.promise;}return original(info);};
  t.after(()=>release.resolve());
  const input={circle:circle.id,prompt:'first private prompt',noSource:true,result:{kind:'message'},harness:'codex',model:'gpt-5.4'};
  const submitting=api(owner.app,'/api/jobs',{method:'POST',body:input});await entered.promise;
  if(mutation==='reset')await api(owner.app,'/api/telemetry/reset-id',{method:'POST',body:{}});
  else for(const level of ['off','on'])await api(owner.app,'/api/telemetry/choose',{method:'POST',body:{level}});
  release.resolve();await submitting;o.drain();assert.equal(o.rows.filter(row=>row.name==='job_requested').length,0);
  await api(owner.app,'/api/jobs',{method:'POST',body:{...input,prompt:'second private prompt'}});o.drain();
  assert.equal(o.rows.filter(row=>row.name==='job_requested').length,1,'same scenario has a working current-generation submission');
});
for(const method of ['restrict','markNoticeShown','resetIdentity','choose'])test('HTTP awaits async '+method+' before notifying or answering', {timeout:120000},async t=>{
  const f=await appFixture(t),o=observer(),entered=gate(),release=gate();let done=false;
  let completed=false,earlyRead=false;const original=o.telemetry[method];o.telemetry[method]=async(...args)=>{entered.resolve();await release.promise;await original(...args);completed=true;};
  const {app}=await f.start('async',{telemetry:o.telemetry});
  const originalView=o.telemetry.view;o.telemetry.view=()=>{if(!completed)earlyRead=true;return originalView();};
  const routes={restrict:'off',markNoticeShown:'notice',resetIdentity:'reset-id',choose:'choose'};
  const request=api(app,'/api/telemetry/'+routes[method],{method:'POST',body:method==='choose'?{level:'off'}:{}}).then(value=>{done=true;return value;});
  t.after(()=>release.resolve());await entered.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
  release.resolve();const response=await request;assert.equal(response.effective,o.telemetry.view().effective);assert.equal(earlyRead,false,'view and response follow completed consent mutation');
});
test('the observation queue is bounded and captures an immutable scope',()=>{
  let observed=0;const scheduled=[];const facts=createTelemetryFacts({schedule:fn=>scheduled.push(fn),telemetry:{observeFact:()=>{observed++;return true;}}});
  const scope=facts.captureScope({surface:'mcp'});assert.ok(Object.isFrozen(scope));
  for(let i=0;i<256;i++)assert.equal(facts.emit('mcp_client_connected',{client_family:'other',source:'reported'},scope),true);
  assert.equal(facts.emit('mcp_client_connected',{client_family:'other',source:'reported'},scope),false);assert.equal(observed,0);assert.equal(scheduled.length,1);
  while(scheduled.length)scheduled.shift()();assert.equal(observed,256);
});
test('a 500 ms observer runs after an operation HTTP response', {timeout:120000},async t=>{
  const f=await appFixture(t),o=observer();let observed=0;
  o.telemetry.observeFact=(name)=>{if(name==='operation_completed'){busy();observed++;}return true;};
  const {app}=await f.start('slow-operation',{telemetry:o.telemetry,telemetryFactSchedule:o.schedule});
  const began=performance.now();await api(app,'/api/ops/status.get',{method:'POST',body:{}});
  assert.equal(observed,0);assert.ok(performance.now()-began<400);
  o.drain();assert.equal(observed,1,'the observer runs, once, after the response');
});
