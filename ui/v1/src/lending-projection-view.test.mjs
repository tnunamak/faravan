import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lendingProjectionOf, formatLendingProjection} from './lending-projection-view.mjs';
import {createLendingProjection, projectLendingState} from '../../../lib/v1/state-projection.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {homeLendingCardVM} from './home-lending.mjs';
import {lendingVM, lendPageVM, machineVM} from './view-models.mjs';
import {effectiveState} from '../../../lib/v1/lending-state.mjs';
import {formatDate} from './dates.mjs';

test('an explicit malformed v2 field fails closed instead of adapting conflicting legacy fields', () => {
  const legacy={intent:{on:true,state:'ready'},state:'ready',lending:{enabled:true}};
  for (const explicit of [null, [], {schemaVersion:2,kind:'lending',intent:'on',admission:'allowed',admissionReason:null,
    execution:'idle',executionJob:null,evidence:{intentState:'ready',dailyLimitReached:true,executionState:'idle'},version:null}]) {
    const projection=lendingProjectionOf({...legacy,lendingProjection:explicit});
    assert.equal(projection.intent,'unknown');
    assert.equal(formatLendingProjection(projection).headline,'Status unavailable');
  }
});

test('explicit allowed admission with unknown execution renders unavailable on Home, Lending and shell', () => {
  const status={lendingProjection:{schemaVersion:2,kind:'lending',intent:'on',admission:'allowed',admissionReason:null,
    execution:'unknown',executionJob:null,evidence:{intentState:'ready',dailyLimitReached:false,executionState:'unknown'},version:null},
    lending:{enabled:true},intent:{on:true,state:'ready'}};
  const projection=lendingProjectionOf(status);
  assert.equal(projection.admission,'unknown');
  assert.equal(projection.execution,'unknown');
  assert.equal(lendPageVM(status).headline,'Status unavailable');
  assert.equal(homeLendingCardVM(lendPageVM(status)).reason,'Lending status could not be confirmed.');
  assert.equal(machineVM(status,null).line,'Status unavailable');
});

test('legacy running labels and active holder identity alone do not prove execution', () => {
  const projection=lendingProjectionOf({intent:{on:true,state:'ready'},today:{jobs:0,jobLimit:3},
    lending:{enabled:true,status:'running',current:'attempt-1'}});
  assert.equal(projection.execution,'unknown');
  assert.equal(formatLendingProjection(projection).headline,'Status unavailable');
});

test('Home keeps the projected reason while exposing prerequisite detail separately', () => {
  const lendingProjection=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false});
  const card=homeLendingCardVM({kind:'blocked',lendingProjection,switch:{on:true},blockers:{
    items:[{key:'agent',status:'blocked',detail:'Codex needs attention.'}],
    needsYou:[{key:'agent',label:'Codex',status:'blocked',detail:'Codex needs attention.',action:'Check Codex'}],
  }});
  assert.equal(card.reason,'A new request is checked against the quota available when it arrives.');
  assert.equal(card.detail,undefined,'the Home attention queue owns blocker detail');
  assert.equal(card.action,null);
});

test('Home, Lending and shell use one projection through cap, execution, blockers and malformed v2 data', () => {
  const states=[
    {name:'ready',projection:projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false}),headline:'Ready for requests'},
    {name:'needs attention',projection:projectLendingState({effective:{intent:{on:true,state:'blocked',reason:'sandbox_not_ready'},execution:{state:'idle'}},dailyLimitReached:false}),headline:'Lending can’t start here'},
    {name:'daily cap with execution',projection:projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:true}),headline:'Running a job'},
    {name:'pending approval cannot hide execution',projection:projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:false}),headline:'Running a job',approvals:[{id:'approval-1'}]},
  ];
  for(const {name,projection,headline,approvals=[]} of states) {
    const status={lendingProjection:projection,lending:{enabled:true},intent:{state:'ready'}};
    const page=lendPageVM(status,{approvals});
    const card=homeLendingCardVM(page);
    const shell=machineVM(status,null,{approvals});
    assert.equal(page.headline,headline,name+' Lending headline');
    assert.equal(card.reason,formatLendingProjection(projection).reason,name+' Home reason');
    if(projection.execution==='running') assert.equal(shell.word,'Running',name+' shell state');
    else if(projection.admission==='allowed') assert.equal(shell.line,'Ready for requests',name+' shell line');
    else assert.equal(shell.line,'Needs you',name+' shell line');
  }
  const invalid={lendingProjection:null,intent:{on:true,state:'ready'},lending:{enabled:true}};
  assert.equal(lendPageVM(invalid).headline,'Status unavailable');
  assert.equal(homeLendingCardVM(lendPageVM(invalid)).reason,'Lending status could not be confirmed.');
  assert.equal(machineVM(invalid,null).line,'Status unavailable');
});

test('shell execution badge uses the central formatter label for every projected lifecycle state', () => {
  for (const [execution, headline] of [
    ['running', 'Running Alex Example’s job'],
    ['finishing', 'Finishing Alex Example’s job'],
    ['stopping', 'Stopping Alex Example’s job'],
  ]) {
    const status=withLendingProjection({execution:{state:execution,job:'job-1',person:'Alex Example'}}, {
      execution,executionJob:'job-1',
    });
    const formatted=formatLendingProjection(status.lendingProjection,{person:'Alex Example'});
    const shell=machineVM(status,null);
    assert.equal(formatted.headline,headline,execution+' central headline');
    assert.equal(shell.word,formatted.label,execution+' shell badge');
    assert.equal(shell.line,formatted.headline,execution+' shell headline');
  }
});

test('stop recovery copy distinguishes missing cessation proof from a pending report without changing the hold', () => {
  for (const reason of ['cessation_unverified','stop_report_pending']) {
    const projection=projectLendingState({effective:{intent:{on:false,state:'off',reason},
      execution:{state:'stopping',job:'job-1'}},dailyLimitReached:false});
    const before=JSON.stringify(projection), view=formatLendingProjection(projection);
    assert.equal(projection.admissionReason,reason);
    assert.equal(view.ready,false);
    assert.equal(JSON.stringify(projection),before);
    assert.equal(lendingVM({lendingProjection:projection}).reason,view.reason);
    assert.equal(lendPageVM({lendingProjection:projection}).reason,view.reason);
    if(reason==='cessation_unverified') {
      assert.equal(view.reason,'Faravan cannot confirm that the sandbox stopped. No new jobs start until this is confirmed. Open Setup and choose Check again.');
      assert.doesNotMatch(view.reason,/Setup (?:resolves|fixes)|automatically/);
    } else {
      assert.equal(view.headline,'Job stopped; circle report pending');
      assert.equal(view.label,'Stop report pending');
      assert.equal(view.reason,'The job stopped, but its report to the circle is waiting. Check your connection. Faravan retries the report automatically.');
      assert.doesNotMatch(view.reason,/Setup|Docker/);
    }
  }
});

test('formatter reason follows admission while execution remains visible', () => {
  const cases = [
    {name:'allowed with running execution', input:{effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:false},
      admission:'allowed', execution:'running', headline:'Running a job', reason:'A new request is checked against the quota available when it arrives.'},
    {name:'daily cap with running execution', input:{effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:true},
      admission:'blocked', execution:'running', headline:'Running a job', reason:'Today’s lending limit is reached.'},
    {name:'off with running execution', input:{effective:{intent:{on:false,state:'off'},execution:{state:'running',job:'job-1'}},dailyLimitReached:false},
      admission:'blocked', execution:'running', headline:'Running a job', reason:'No new jobs start on this computer.'},
    {name:'paused with running execution', input:{effective:{intent:{on:true,state:'paused'},execution:{state:'running',job:'job-1'}},dailyLimitReached:false},
      admission:'blocked', execution:'running', headline:'Running a job', reason:'Paused. No new jobs start.'},
  ];
  for (const {name,input,admission,execution,headline,reason} of cases) {
    const projection = projectLendingState(input);
    const view = formatLendingProjection(projection);
    assert.equal(projection.admission, admission, name + ' admission');
    assert.equal(projection.execution, execution, name + ' execution');
    assert.equal(view.headline, headline, name + ' headline');
    assert.equal(view.reason, reason, name + ' reason');
  }
});

test('formatter stays consistent with generated intent, admission and execution tuples', () => {
  const intents=['on','off','paused','unknown'];
  const admissions=['allowed','blocked','unknown'];
  const executions=['idle','running','finishing','stopping','unknown'];
  for (const intent of intents) for (const admission of admissions) for (const execution of executions) {
    const intentState={on:'ready',off:'off',paused:'paused',unknown:null}[intent];
    const admissionReason={allowed:null,blocked:'sandbox_not_ready',unknown:null}[admission];
    const executionJob=['running','finishing','stopping'].includes(execution)?'job-1':null;
    const tuple=createLendingProjection({schemaVersion:2,kind:'lending',intent,admission,admissionReason,execution,executionJob,
      evidence:{intentState,dailyLimitReached:false,executionState:execution},version:null});
    const view=formatLendingProjection(tuple);
    const kind=['running','finishing','stopping'].includes(tuple.execution) ? 'running'
      : tuple.intent==='unknown'||tuple.admission==='unknown'||tuple.execution==='unknown' ? 'unknown'
      : tuple.intent==='off' ? 'off' : tuple.intent==='paused' ? 'paused'
      : tuple.admission==='allowed' ? 'ready' : 'blocked';
    assert.equal(view.kind,kind,`${intent}/${admission}/${execution}`);
    if (view.kind==='ready') assert.equal(tuple.execution,'idle',`${intent}/${admission}/${execution} cannot be ready without known idle execution`);
  }
});

test('migrated lending surfaces do not classify lifecycle or admission from legacy fields', () => {
  const source = file => readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const body = (text, name) => {
    const start = text.indexOf('export function ' + name + '(');
    assert.notEqual(start, -1, name + ' exists');
    let parens = 0, close = -1;
    for (let i = text.indexOf('(', start); i < text.length; i++) {
      if (text[i] === '(') parens++;
      if (text[i] === ')' && --parens === 0) { close = i; break; }
    }
    assert.notEqual(close, -1, name + ' parameters close');
    let depth = 0, opened = false;
    for (let i = text.indexOf('{', close); i < text.length; i++) {
      if (text[i] === '{') { depth++; opened = true; }
      if (text[i] === '}' && --depth === 0 && opened) return text.slice(start, i + 1);
    }
    throw new Error('unclosed function ' + name);
  };
  const viewModels = source('view-models.mjs');
  const helpers = source('helpers.mjs');
  const homeLending = source('home-lending.mjs');
  const migrated = [
    ...['lendingVM', 'lendingVerdictVM', 'lendPageVM', 'machineVM'].map(name => [name, body(viewModels, name)]),
    ['homeLendingCardVM', body(homeLending, 'homeLendingCardVM')],
    ['iconState', body(helpers, 'iconState')],
    ['lendingView', body(helpers, 'lendingView')],
  ];

  // Counters still provide meter facts; only the central adapter/formatter may turn them into admission.
  const rawLifecycle = /\b(?:status|s|lending|home)\??\.(?:state|status|enabled|paused|reason)\b|\b(?:status|s|lending|home)\??\.lending\??\.(?:state|status|enabled|paused|reason)\b|\b(?:status|s|lending|home)\??\.intent\??\.(?:state|reason)\b|\b(?:desktop|status\.desktop)\??\.lendable\b/;
  const rawAdmissionMath = /\b(?:today|status\.today|s\.counters)\.[\w.]+\s*>=|\b(?:jobsCapped|minutesCapped|dailyLimitReached|jobsUsed|minutesUsed|jobsMax|minutesMax|dailyLimit)\b|\.(?:evidence\??\.)dailyLimitReached\b|\breason\s*={2,3}\s*['"](?:daily_limit|quota_reserve|user_active|outside_hours)['"]/;
  for (const [name, fn] of migrated) {
    assert.doesNotMatch(fn, rawLifecycle, name + ' must use the shared projection for lifecycle facts');
    assert.doesNotMatch(fn, rawAdmissionMath, name + ' may display counters but cannot derive admission from them');
    assert.doesNotMatch(fn, /\b(?:blockers|page\.blockers)\.(?:canLend|active)\b/, name + ' must not let checklist admission decide the domain state');
  }

  const lendPage = body(viewModels, 'lendPageVM');
  assert.doesNotMatch(lendPage, /\b(?:awaitingAnswer|approvals\.length)\b|\bapprovals\b[\s\S]{0,120}\?\s*null\s*:/,
    'approval-card presence cannot suppress projected execution');
  const homeCard = body(homeLending, 'homeLendingCardVM');
  assert.doesNotMatch(homeCard, /\b(?:reason|headline)\s*:\s*(?:fix|waiting|item)\b/,
    'prerequisite details and actions stay separate from the projected headline reason');
});

test('a scheduled outside-hours wait reads as a wait through the real producer, projection and renderer', () => {
  const nextStart = Date.UTC(2026, 9, 19, 22);
  const effective = effectiveState({intent: 'on', now: Date.UTC(2026, 9, 19, 20), launchedAt: 0, timeZone: 'UTC', outsideNextStart: nextStart,
    agents: [{id: 'codex', enabled: true, installed: true, signedIn: true}]});
  assert.equal(effective.intent.state, 'outside', 'the producer names the window');
  const projection = projectLendingState({effective: {...effective, version: 'producer-v1'}, dailyLimitReached: false});
  const start = formatDate(nextStart, 'clock');
  assert.match(start, /\d:\d\d/, 'the next start has a clock time');
  const view = formatLendingProjection(projection);
  assert.deepEqual([view.kind, view.headline, view.reason, view.label, view.iconState],
    ['outside', 'Outside lending hours', `This computer is outside its lending hours. Lending starts at ${start}.`, 'Outside lending hours', 'Lending on']);
});

// Judge r9 O-D: a lending state read while its facts were moving keeps the newest intent and execution. A pending
// stop reads as stopping; idle reads as updating; neither reads as "Status unavailable".
test('a transitional lending projection reads as stopping or updating, never unavailable', async () => {
  const {transitionalLendingProjection, projectLendingState} = await import('../../../lib/v1/state-projection.mjs');
  const stopping = transitionalLendingProjection(projectLendingState({effective:{intent:{on:false,state:'off'},execution:{state:'stopping',job:null}},dailyLimitReached:false}));
  const a = formatLendingProjection(stopping, {person:'Alex Example'});
  assert.equal(a.headline, 'Stopping Alex Example’s job');
  const idle = transitionalLendingProjection(projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false}));
  assert.equal(idle.admission, 'blocked', 'a transitional read never admits new work');
  const b = formatLendingProjection(idle);
  assert.equal(b.headline, 'Updating lending status');
  for (const f of [a, b]) assert.doesNotMatch(f.headline + ' ' + f.reason + ' ' + f.label, /Status unavailable|could not be confirmed|Needs attention/);
});

// Judge r10 R3, R5, R9: "ready" is what the running lender would admit. A busy, stopped or short-of-time lender says so.
test('readiness follows the lender admission check: busy, stopped, or too little time left', () => {
  const view=(effective,dailyFacts=null)=>formatLendingProjection(projectLendingState({effective,dailyLimitReached:effective.intent.reason==='daily_limit'}),{dailyFacts,person:'Alex Example'});
  const running=view({intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'},admission:{reason:'busy'}});
  assert.deepEqual([running.headline,running.reason],['Running Alex Example’s job','No other job starts until this one finishes.']);
  assert.doesNotMatch(running.headline+running.reason,/Ready for requests/);
  const starting=view({intent:{on:true,state:'starting',reason:'busy'},execution:{state:'idle'}});
  assert.deepEqual([starting.kind,starting.headline,starting.label],['running','Starting Alex Example’s job','Starting']);
  const stopped=view({intent:{on:true,state:'blocked',reason:'lender_stopped'},execution:{state:'idle'}});
  assert.equal(stopped.headline,'Jobs can’t start');
  assert.equal(stopped.remedy,'Check lending');
  assert.match(stopped.reason,/Check lending before trying again/);
  assert.equal(view({intent:{on:false,state:'off'},execution:{state:'idle'}}).remedy,'Turn lending on');
  assert.equal(view({intent:{on:true,state:'paused'},execution:{state:'idle'}}).remedy,'Resume lending');
  const short=view({intent:{on:true,state:'resting',reason:'daily_limit'},execution:{state:'idle'}},{jobs:2,jobLimit:12,minutes:42,minuteLimit:60,jobMinutes:20});
  assert.deepEqual([short.headline,short.reason],['Done for today','18 minutes left today, and a job needs 20. Lending resumes at midnight.']);
});

test('O-E no-circle On names the missing membership instead of passed workspace checks',{timeout:60000},async t=>{
 const {appFixture,api}=await import('../../../tests/helpers/v1-app-fixture.mjs');
 const f=await appFixture(t),d=await f.start('no-circle');
 await api(d.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(d.app,'/api/lending/on',{method:'POST',body:{}});
 const s=await api(d.app,'/api/status');
 assert.equal(s.lendingProjection.admissionReason,'circle_not_joined');
 assert.equal(lendPageVM(s).reason,'Join or create a circle before lending can start.');
 const {renderFixture}=await import('./render.test-helper.mjs');
 const {Lend}=await import('./lend.jsx');
 const html=renderFixture(Lend,{api:{},agents:[],lending:s.lending,circles:[],members:[],
   refresh(){},setDialog(){},setCircle(){},mutate:async()=>({}),
   data:{home:s,readiness:{ready:true,checks:[]},approvals:[],activity:[],jobs:[]}});
 assert.match(html,/<a[^>]*href="#[/]circles"[^>]*>Join or create a circle<[/]a>/);
});

test('copy audit B sign-in is conditional and failed starts have a next step',async()=>{
 const view=reason=>formatLendingProjection(projectLendingState({effective:{intent:{on:true,state:'blocked',reason},execution:{state:'idle'}},dailyLimitReached:false}),{agentName:'Codex',circleName:'Friends'});
 assert.match(view('agent_signed_out').reason,/sandbox/);
 assert.match(view('agent_signed_out').reason,/then lending can resume/);
 assert.equal(view('lending_not_started').reason,'Lending couldn’t start for the circle “Friends”. Check lending for what is blocking it.');
 const {joinLendingNote}=await import('./lending-projection-view.mjs');
 const status={intent:{on:true,state:'ready'},lending:{enabled:true,status:'idle'}};
 assert.equal(joinLendingNote(status,{surface:'fresh'}),joinLendingNote(status));
});

test('blocked waits use admission labels without changing intent or readiness', () => {
  for (const [reason, state, headline] of [
    ['daily_limit', 'resting', 'Done for today'], ['quota_reserve', 'resting', 'Resting'],
    ['user_active', 'resting', 'Resting'], ['outside_hours', 'outside', 'Outside lending hours'],
    ['observation_changed', 'ready', 'Updating lending status'],
  ]) {
    const projection=createLendingProjection({schemaVersion:2,kind:'lending',intent:'on',admission:'blocked',
      admissionReason:reason,execution:'idle',executionJob:null,
      evidence:{intentState:state,dailyLimitReached:reason==='daily_limit',executionState:'idle'},version:null});
    const view=formatLendingProjection(projection);
    assert.deepEqual([view.headline,view.label], [headline,headline], reason);
    assert.equal(view.on,true,reason);
    assert.equal(view.ready,false,reason);
  }
});


import {currentCapacityWait, lendingSummary} from '../../../lib/v1/lending-summary.mjs';
const waitNow = Date.UTC(2026, 10, 17, 19);
const waitAccount = () => ({provider:'codex', decision:{availability:{
  admitted:false, reason:'owner_reserve', objective:{strategyId:'pace'},
  wait:{accountKey:'codex',reason:'owner_reserve',strategyId:'pace',source:'window_reset',nextEvaluationAtMs:waitNow+60000},
  status:{line:'Saved wait text',recovery:{who:'automatic'}},
}}});
const idleWaitProjection = () => projectLendingState({effective:{
  intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false});
test('current projected deadline expires exactly and never grants admission', () => {
  const account=waitAccount(), projection=idleWaitProjection();
  const options={lendingAccounts:[account],selectedAgents:['codex'],now:waitNow};
  assert.match(currentCapacityWait(account,{now:waitNow}).line,/resets at/);
  assert.match(lendingSummary(projection,options).reason,/resets at/);
  const expired=lendingSummary(projection,{...options,now:waitNow+60000});
  assert.match(expired.reason,/fresh allowance check/);
  assert.equal(expired.phase,'waiting');
  assert.equal(expired.action,null);
  for(const deadline of [null,NaN,Infinity,'tomorrow',-1]) {
    const invalid=waitAccount();
    invalid.decision.availability.wait.nextEvaluationAtMs=deadline;
    assert.match(currentCapacityWait(invalid,{now:waitNow}).line,/not confirmed/);
  }
  const inconsistent=waitAccount();
  inconsistent.decision.availability.wait.accountKey='another-account';
  assert.match(currentCapacityWait(inconsistent,{now:waitNow}).line,/not confirmed/);
});
test('saved waits never override current eligibility, pause, stop or admitted execution', () => {
  const old=waitAccount().decision.availability;
  assert.equal(currentCapacityWait({provider:'codex',decision:{lastJobDecision:old,assessmentSource:'last_job',...old}},{now:waitNow}),null);
  assert.equal(currentCapacityWait({provider:'codex',decision:{...old,availability:{admitted:true}}},{now:waitNow}),null);
  assert.equal(currentCapacityWait({provider:'codex',decision:{...old,availability:{admitted:false,reason:'refresh_failed'}}},{now:waitNow}),null);
  for(const [state,on,execution,headline] of [
    ['paused',true,'idle','Lending is paused'],['off',false,'idle','Lending is off'],
    ['ready',true,'running','Running a job'],['off',false,'stopping','Stopping this job'],
  ]) {
    const projection=projectLendingState({effective:{intent:{on,state},
      execution:{state:execution,...(execution!=='idle'?{job:'admitted-job'}:{})}},dailyLimitReached:false});
    const summary=lendingSummary(projection,{lendingAccounts:[waitAccount()],selectedAgents:['codex'],now:waitNow});
    assert.equal(summary.headline,headline);
    assert.doesNotMatch(summary.reason,/Saved wait|automatically.*allowance/);
  }
});
test('Lending recomputes wait text after clock advance instead of using saved summary', () => {
  const account=waitAccount(), projection=idleWaitProjection();
  const status={lendingProjection:projection,lending:{enabled:true},needs_you:[],
    lendingPolicy:{accounts:[account]},summary:{headline:'Lending on',reason:'Saved wait text'}};
  const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}];
  const current=lendPageVM(status,{agents,now:waitNow,zone:'UTC'});
  assert.match(current.reason,/resets at/);
  const expired=lendPageVM(status,{agents,now:waitNow+60000,zone:'UTC'});
  assert.match(expired.reason,/fresh allowance check/);
  assert.equal(expired.readiness.state,'holding');
  assert.equal(expired.exec,null);
  assert.equal(JSON.stringify(account),JSON.stringify(waitAccount()),'display is read-only');
});
