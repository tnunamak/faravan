import './mounted.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Setup} from './setup.jsx';
import {setupVM} from './view-models.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {lendingReadiness} from '../../../lib/v1/lending-readiness.mjs';
import {click, flush, mount, resetPage, teardown} from './mounted.test-helper.mjs';

const circle={id:'weekend',name:'Weekend projects',origin:'https://circle.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
const agent={id:'codex',installed:true,signedIn:true,useForLending:true};

const commandPath={installed:false,path:'/home/ana/.local/bin/faravan',launcher:'/Applications/Faravan.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true};
const readyChecks=['sbx_install','sbx_daemon','docker_login'].map(name=>({name,ok:true}));
const dockerNotReady={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false},{name:'docker_login',ok:true}]};
const dataFor=(readiness,commandPathResult=commandPath)=>({readiness,agents:[agent],commandPath:commandPathResult,
  home:{lending:{enabled:false,circle:circle.id}},devices:{name:'Ana’s computer'}});
const props=(api,readiness)=>({api,data:dataFor(readiness),agents:[agent],circles:[circle],circle:circle.id,
  lending:{circle:circle.id,limits:{dailyJobs:3,dailyMinutes:60}},mutate:async()=>({}),refresh:async()=>{},phone:false});

test('Setup keeps a missing CLI quiet behind Docker, then keeps its install action working when current',async t=>{
  t.after(teardown); resetPage();
  const calls=[];
  const api={get:async()=>({agents:[{id:'codex',checks:[{id:'signed_in',state:'pass'}]}]}),post:async(path,body)=>{
    calls.push([path,body]);
    return {installed:true,path:commandPath.path,launcher:commandPath.launcher,profile:commandPath.profile,managed:true};
  }};
  const view=await mount(h(Setup,props(api,dockerNotReady)));
  assert.match(view.$('.setup-current').textContent,/Prepare Docker Sandboxes for friends’ jobs/);
  assert.equal(view.$('.setup-current').getAttribute('data-state'),'blocked');
  assert.equal(view.$('.setup-current a[href="docker-desktop://"]'),null);
  assert.match(view.$('.setup-current').textContent,/Docker Sandboxes isn’t ready\./);
  assert.ok(view.button('Check again'));
  assert.match(view.$('.command-line-tool').textContent,/The faravan command isn't available in your terminal yet\./);
  assert.equal(view.$('.command-line-tool .btn-primary'),null,'a future CLI action is not primary');
  assert.ok(view.$('.command-line-tool details summary'),'secondary CLI details remain available');
  assert.equal(view.button('Install command-line tool'),null);

  await view.rerender(h(Setup,props(api,{ready:true,checks:readyChecks})));
  const install=view.button('Install command-line tool');
  assert.ok(install,'the current CLI action remains available');
  assert.match(install.className,/btn-primary/);
  await click(install);
  assert.deepEqual(calls,[['ops/command_path.install',{}]]);
  assert.match(view.text(),/Installed\./);
});

const lendingPass={agents:[{id:'codex',hasReading:true,checks:[{id:'signed_in',state:'pass'}]}]};
const readyAccount={provider:'codex',decision:{availability:{admitted:true,reason:'objective_lend',status:{id:'ready',line:'Ready to lend.'},objective:{admission:'allowed'},windows:[]}}};
for (const platform of ['other','mac','linux'])for (const [label,projection,expected] of [
  ['on and passing',{},'This computer is ready to lend'],
  ['on and held',{admission:'blocked',admissionReason:'daily_limit',dailyLimitReached:true},'Done for today'],
  ['unknown',{intent:'unknown',admission:'unknown',execution:'unknown'},'Lending status unavailable'],
]) test(platform+' Setup preserves the headline when '+label,async t=>{
  t.after(teardown);resetPage();
  const p=props({get:async()=>lendingPass},{ready:true,checks:readyChecks});
  const account=label==='on and held'?{provider:'codex',decision:{availability:{admitted:false,reason:'owner_reserve',status:{id:'holding',line:'Holding for your own use.'},objective:{admission:'held'},windows:[]}}}:readyAccount;
  p.data.home=withLendingProjection({...p.data.home,desktop:{platform},lendingPolicy:{accounts:[account]}},projection);
  const view=await mount(h(Setup,p));
  assert.equal(view.$('h1').textContent,expected);
});
for (const platform of ['other','mac','linux'])test(platform+' Setup with lending on never promises ready while lending checks run',async t=>{
  t.after(teardown);resetPage();
  let settle;
  const p=props({get:path=>path==='lending/readiness'?new Promise(resolve=>{settle=resolve;}):Promise.resolve({})},{ready:true,checks:readyChecks});
  p.data.home=withLendingProjection({...p.data.home,desktop:{platform},lendingPolicy:{accounts:[readyAccount]}});
  const view=await mount(h(Setup,p));
  assert.doesNotMatch(view.$('h1').textContent,/is ready|ready for requests/i);
  settle(lendingPass);await flush();
  await view.rerender(h(Setup,p));
  assert.equal(view.$('h1').textContent,'This computer is ready to lend');
});
for (const platform of ['other','mac','linux'])test(platform+' Setup heading and progress stay incomplete while required lending checks run or fail',async t=>{
  t.after(teardown);resetPage();
  let settle,calls=0;
  const pending={get:path=>path==='lending/readiness'&&++calls===1?new Promise(resolve=>{settle=resolve;}):Promise.resolve(lendingPass)};
  const p=props(pending,{ready:true,checks:readyChecks});
  p.data.home.desktop={platform};
  const view=await mount(h(Setup,p));
  assert.match(view.$('h1').textContent,/Getting this computer ready to lend/);
  assert.match(view.$('#needs-h').textContent,/of .*required checks complete/);
  assert.equal((view.text().match(/Checking whether this computer can lend…/g)||[]).length,1);
  settle({agents:[{id:'codex',hasReading:true,checks:[{id:'subscription',state:'fail',line:'Check the plan.'}]}]});
  await flush();
  await view.rerender(h(Setup,p));
  assert.match(view.$('h1').textContent,/Getting this computer ready to lend/);
  assert.doesNotMatch(view.$('h1').textContent,/ready for requests/i);
  await click(view.button('Check lending again'));
  assert.match(view.$('h1').textContent,/Your computer is ready/);
});
test('Setup names the selected membership without a redundant circle checklist',async t=>{
 t.after(teardown);resetPage();
 const api={get:async()=>lendingPass};
 const p=props(api,{ready:true,checks:readyChecks});
 p.circles=[circle,...['Work','Family','Friends'].map((name,i)=>({...circle,id:'other-'+i,name}))];
 const view=await mount(h(Setup,p));
 assert.match(view.$('.setup-selected-circle').textContent,/Selected circle: Weekend projects/);
 assert.equal(view.$('.setup-selected-circle a').getAttribute('href'),'#/circles');
 assert.match(view.$('.setup-selected-circle a').textContent,/All memberships/);
 assert.equal(view.$('.setup-steps [data-blocker="circle"]'),null);
 assert.ok(view.$('.command-line-tool').closest('details.setup-cli-details'));
 assert.equal(view.$('details.setup-cli-details').open,false);
 assert.doesNotMatch(view.text(),/Each step waits for the ones above it/);
});
for(const [label,result] of [
  ['failed',{agents:[{id:'codex',hasReading:true,checks:[{id:'subscription',state:'fail',line:'Check the plan.',fix:'Open Lending.'}]}]}],
  ['unknown',{agents:[{id:'codex',hasReading:false,checks:[{id:'account',state:'unknown'}]}]}],
  ['missing agent',{agents:[]}],
]) test('Review F1 settled '+label+' lending evidence remains current and recoverable',async t=>{
  t.after(teardown);resetPage();
  let reading=result,calls=0;
  const api={get:async path=>{if(path==='update-settings')return {earlyBuilds:false};calls++;return reading;}};
  const view=await mount(h(Setup,props(api,{ready:true,checks:readyChecks})));
  assert.equal(view.$('.setup-current')?.getAttribute('data-blocker'),'agent:codex');
  assert.ok(view.button('Check lending again'));
  assert.ok(view.$('.setup-current a[href="#/lend"]'));
  assert.doesNotMatch(view.text(),/No steps need you|Your computer is ready/);
  reading=lendingPass;
  await click(view.button('Check lending again'));
  assert.equal(calls,2);
  assert.match(view.text(),/Your computer is ready/);
  assert.equal(Boolean(view.$('.setup-current')),false);
});

test('setup_retry_and_limits_actions_name_their_targets: retry recovers to confirmed ready',async t=>{
  t.after(teardown);resetPage();let calls=0;
  const api={get:async path=>{if(path==='update-settings')return {earlyBuilds:false};if(++calls===1)throw Error('offline');return lendingPass;}};
  const view=await mount(h(Setup,props(api,{ready:true,checks:readyChecks})));
  assert.equal(view.$('.setup-current')?.getAttribute('data-blocker'),'agent:codex');
  assert.doesNotMatch(view.text(),/No steps need you|Your computer is ready/);
  assert.equal(view.$('.setup-summary button').textContent,'Check lending again');
  await click(view.$('.setup-summary button'));
  assert.equal(calls,2);
  assert.match(view.text(),/Your computer is ready/);
});

test('Review F1 a hung lending read becomes retryable and its late result is ignored',async t=>{
  t.after(teardown);resetPage();
  const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
  const tokens=new Set();let expire,settle,calls=0;
  globalThis.setTimeout=(fn,delay,...args)=>{
    if(delay!==15000)return originalSet(fn,delay,...args);
    const token={};tokens.add(token);expire=fn;return token;
  };
  globalThis.clearTimeout=token=>tokens.has(token)?tokens.delete(token):originalClear(token);
  t.after(()=>{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;});
  const api={get:path=>path==='update-settings'?Promise.resolve({earlyBuilds:false}):++calls===1?new Promise(resolve=>{settle=resolve;}):Promise.resolve(lendingPass)};
  const p=props(api,{ready:true,checks:readyChecks});
  const view=await mount(h(Setup,p));
  assert.equal(typeof expire,'function','pending read installs bounded recovery');
  expire();
  await view.rerender(h(Setup,p));
  assert.ok(view.$('.setup-summary button'));
  assert.doesNotMatch(view.text(),/Your computer is ready/);
  assert.equal(view.$('.setup-summary button').textContent,'Check lending again');
  await click(view.$('.setup-summary button'));
  assert.equal(calls,1, 'retry waits for the aborted physical read to settle');
  assert.equal(view.$('.setup-summary button').textContent,'Check lending again', 'the failed read remains retryable while abort is pending');
  settle({agents:[]});
  await flush();
  await view.rerender(h(Setup,p));
  assert.equal(calls,2);
  assert.match(view.text(),/Your computer is ready/);
});

const allowanceObservation = {refresh_succeeded:true, identity:{verified:true,account_id:'fixture'}, account_week_id:'week', epoch:'epoch',
  complete:true, weekly_resource_id:'weekly', funding:{subscription_only:'proven'}, executor:{single_executor:'proven'},
  stop:{bounded_execution:'proven'}, stop_bound_ms:1, uncertainty_ms:0, resources:[{kappa_micro:1}]};
const missingPlan = {reason:'calibration_missing',scope:'plan',provider:'codex',plan:'plus',model:'gpt-6-sol',window:'weekly'};
const mountAllowance = async observation => {
  const requiredEvidence = {identity:allowanceObservation.identity, funding:allowanceObservation.funding, executor:allowanceObservation.executor, stop:allowanceObservation.stop};
  const checks = lendingReadiness({provider:'codex',signedIn:true,sandboxState:'passed',observation,requiredEvidence});
  const api = {get:async path => {
    if(path==='update-settings')return {earlyBuilds:false};
    assert.equal(path,'lending/readiness');
    return {agents:[{id:'codex',hasReading:true,checks}]};
  }};
  return mount(h(Setup,props(api,{ready:true,checks:readyChecks})));
};

test('Setup does not block lending when conversion coverage is missing',async t=>{
  t.after(teardown); resetPage();
  const view=await mountAllowance({...allowanceObservation,resources:[{kappa_micro:null}],calibration_missing:[missingPlan]});
  assert.doesNotMatch(view.text(),/isn't supported for lending|Borrowing still works|Checked again automatically/);
  assert.ok(view.button('Turn on lending for Weekend projects'), 'missing conversion uses the starting estimate');
});

test('Setup does not promise a mandatory live meter check while learning',async t=>{
  t.after(teardown); resetPage();
  const view=await mountAllowance({...allowanceObservation,resources:[{conversion:'native_window',kappa_micro:null}],
    learning:[{reason:'learning',provider:'codex',window:'weekly'}]});
  assert.ok(view.button('Turn on lending for Weekend projects'));
  assert.doesNotMatch(view.text(),/checks each job against the live meter/);
});

test('Setup does not hold lending solely for a stale reading',async t=>{
  t.after(teardown); resetPage();
  const stale=await mountAllowance({...allowanceObservation,refresh_succeeded:false,resources:[{conversion:'native_window',kappa_micro:null}]});
  assert.ok(stale.button('Turn on lending for Weekend projects'), 'stale usage alone must not hold lending');
});

for(const [label,calibration_missing] of [['absent',undefined],['empty',[]],['malformed',[{}]]])
test('Setup uses the starting estimate with '+label+' calibration metadata',async t=>{
  t.after(teardown); resetPage();
  const view=await mountAllowance({...allowanceObservation,resources:[{kappa_micro:null}],calibration_missing});
  assert.doesNotMatch(view.text(),/isn't supported for lending|Checked again automatically/);
  assert.ok(view.button('Turn on lending for Weekend projects'), 'missing calibration metadata must not hold lending');
});

test('Setup keeps supported conversion readiness unchanged',async t=>{
  t.after(teardown); resetPage();
  const view=await mountAllowance(allowanceObservation);
  assert.match(view.text(),/Account details/);
  assert.ok(view.button('Turn on lending for Weekend projects'));
  assert.doesNotMatch(view.$('.setup-summary').textContent,/not supported|estimate is not confirmed|Refresh the agent allowance/);
});

test('unsupported Setup sends owners without a circle to membership before promising jobs',()=>{
  for (const desktop of [{platform:'windows'},{platform:'mac',lendable:false}]) {
    const vm=setupVM({status:{desktop},circle:null});
    assert.equal(vm.kind,'unsupported');
    assert.equal(vm.ready,false);
    assert.match(vm.card.text,/Join or start a circle first/);
    assert.match(vm.card.text,/Once your membership is approved/);
    assert.deepEqual(vm.card.action,{label:'Open Circles',href:'#/circles'});
  }
});

test('unsupported Setup waits for pending or unverified circle membership',()=>{
  for (const membership of [
    {...circle,enrollment:{state:'pending'},rosterMembershipVerified:false},
    {...circle,rosterMembershipVerified:false},
  ]) {
    const vm=setupVM({status:{desktop:{platform:'windows'}},circle:membership});
    assert.match(vm.card.text,/Confirm your circle membership first/);
    assert.deepEqual(vm.card.action,{label:'Open Circles',href:'#/circles'});
  }
});

// Compatibility coverage: this case already passes on the base.
test('unsupported Setup preserves sending copy for an approved circle member',()=>{
  const vm=setupVM({status:{desktop:{platform:'windows'}},circle});
  assert.equal(vm.card.text,'Send jobs to your friends and get results on this computer, including `faravan apply` in the terminal.');
  assert.deepEqual(vm.card.action,{label:'Send a job',href:'#/jobs/new'});
});

test('Setup details the user closed stay closed when readiness changes',async t=>{
  t.after(teardown);resetPage('#/setup/details');
  const api={get:async()=>lendingPass};
  const view=await mount(h(Setup,props(api,{ready:true,checks:readyChecks})));
  const details=view.$('#setup-safety-details');
  assert.ok(details,'the safety details render');
  assert.ok(details.open,'the details deep link opens them');
  details.open=false;
  await view.rerender(h(Setup,props(api,{ready:true,checks:readyChecks.map(check=>({...check}))})));
  const after=view.$('#setup-safety-details');
  assert.ok(after===details,'the same details node stays mounted');
  assert.ok(!after.open,'a readiness change does not reopen details the user closed');
});

test('Setup can initialize missing network rules after Docker sign-in',async t=>{
 t.after(teardown);resetPage();
 const posts=[];
 const api={get:async()=>({agents:[]}),post:async(path,body)=>{posts.push([path,body]);return {};}};
 const readiness={ready:false,checks:[...readyChecks,{name:'network_policy',ok:false,label:'global network policy has not been initialized.',remedy:'Initialize sandbox network rules',repair:'policy_init_confirm'}]};
 const p=props(api,readiness);
 const {lendingBlockers}=await import('../../../lib/v1/blockers.mjs');
 p.data.home.lending_blockers=lendingBlockers({docker:{installed:true,running:true,signedIn:true},intent:{on:true},readinessRequirements:[{cause:'network_policy',label:'Missing network rules.',remedy:'Initialize sandbox network rules'}]});
 const view=await mount(h(Setup,p));
 assert.match(view.$('.setup-current').textContent,/Sandbox network rules/);
 await click(view.button('Initialize sandbox network rules'));
 const confirm=[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Initialize sandbox network rules');
 assert.ok(confirm);
 await click(confirm);
 assert.deepEqual(posts,[['setup/initialize-policy',{confirmed:true}]]);
});

test('workspace timeout with healthy Docker offers one Check again, no restart, and clears only on a fresh pass',async t=>{
  t.after(teardown);resetPage();
  const timeout={name:'test_workspace',ok:false,cause:'timeout',
    label:'Faravan cannot confirm its sandbox job runner.',remedy:'Choose Check again.'};
  const held={ready:false,checks:[...readyChecks,timeout]};
  const fresh={ready:true,checks:[...readyChecks,{name:'test_workspace',ok:true}]};
  const calls=[];let current=held,refreshes=0,reply=null;
  const api={
    get:async path=>{
      calls.push(['get',path]);
      if(path!=='readiness?refresh=true')return lendingPass;
      return new Promise(resolve=>{reply=()=>resolve(current);});
    },
    post:async(path,body)=>{calls.push(['post',path,body]);return {};},
  };
  const forced=()=>calls.filter(call=>call[0]==='get'&&call[1]==='readiness?refresh=true');
  const renderProps=()=>{
    const p=props(api,current);
    p.data.home.reason='setup_required'; // Saved hold must lose to fresh readiness.
    // The refresh callback only re-renders; it never invents a pass.
    return {...p,refresh:async()=>{refreshes++;}};
  };
  const view=await mount(h(Setup,renderProps()));
  const card=view.$('.setup-current');
  assert.ok(card);
  assert.match(card.textContent,/Faravan couldn’t start a test workspace, so this computer can’t lend yet/);
  assert.doesNotMatch(card.textContent,/service isn.t running|needs to restart to finish its update|Restart Docker Sandboxes/);
  const primary=card.querySelectorAll('.btn-primary');
  assert.equal(primary.length,1,'one primary action, not diagnostics');
  assert.equal(primary[0].textContent.trim(),'Check again');
  assert.equal(primary[0].tagName,'BUTTON');
  assert.ok(view.$('#setup-safety-details summary'),'diagnostics remain a separate disclosure');
  assert.equal(forced().length,0,'no readiness read before the click');
  // Retry still times out: the control is pending, the hold persists, nothing offers Ready or lending.
  await click(primary[0]);
  assert.equal(forced().length,1,'exactly one forced readiness read');
  assert.match(view.$('.setup-current .check-control, .setup-current')?.textContent??'',/Checking…/,'pending while the read is outstanding');
  reply();await flush();
  assert.equal(refreshes,1);
  await view.rerender(h(Setup,renderProps()));
  assert.match(view.$('.setup-current')?.textContent??'',/test workspace/,'a still-timed-out retry keeps the hold');
  assert.equal(view.button('Check again')?.textContent.includes('Checking…')??false,false,'pending ends with the read');
  assert.doesNotMatch(view.text(),/Your computer is ready/);
  assert.equal(Boolean(view.button('Turn on lending for Weekend projects')),false);
  // A fresh passing observation is the only thing that clears it.
  current=fresh;
  await click(view.button('Check again'));
  assert.equal(forced().length,2);
  reply();await flush();
  await view.rerender(h(Setup,renderProps()));
  assert.notEqual(view.$('.setup-current')?.getAttribute('data-blocker'),'readiness_requirement','fresh passed checks supersede the workspace hold');
  assert.doesNotMatch(view.$('.setup-current')?.textContent??'',/test workspace/);
  assert.match(view.text(),/Test workspace\s*Passed/);
  assert.equal(calls.some(call=>call[0]==='post'),false,'no restart request, ever');
  assert.equal(document.querySelector('dialog'),null,'no confirmation dialog');
  assert.equal(Boolean(view.button('Restart Docker Sandboxes')),false);
});

for (const cause of ['timeout', 'unknown']) test('Setup keeps Docker passes separate from a blocked test workspace: '+cause, async t => {
  t.after(teardown); resetPage();
  const claude={...agent,id:'claude-code-subscription'};
  const optional={...agent,signedIn:null};
  const reading={agents:[
    {id:claude.id,hasReading:true,checks:[{id:'signed_in',state:'pass'}]},
    {id:'codex',hasReading:false,checks:[{id:'account',state:'unknown'}]},
  ]};
  const workspace={name:'test_workspace',ok:cause==='timeout'?false:null,cause,
    label:'Unconfirmed workspace',remedy:'Choose Check again.'};
  let current={ready:false,checks:[...readyChecks,workspace]}, refreshes=0;
  const calls=[];
  const api={get:async path=>{
    calls.push(['get',path]);
    return path==='readiness?refresh=true'?current:reading;
  },post:async(path,body)=>{calls.push(['post',path,body]);return {};}};
  const renderProps=()=>{
    const p=props(api,current);
    p.agents=[claude,optional];p.data.agents=p.agents;
    p.refresh=async()=>{refreshes++;};
    return p;
  };
  const view=await mount(h(Setup,renderProps()));
  const vm=setupVM({readiness:current,agents:[claude,optional],status:{lending:{enabled:false}},circle,lendingReadiness:reading});
  assert.equal(vm.ready,false);
  assert.ok(vm.done<vm.required,'an unconfirmed workspace cannot count as complete');
  assert.equal(vm.steps.find(row=>row.id==='sandboxes').state,'ok');
  assert.equal(vm.steps.find(row=>row.id==='docker-account').state,'ok');
  const card=view.$('.setup-current');
  assert.ok(card);
  assert.match(card.textContent,cause==='timeout'
    ? /Faravan couldn’t start a test workspace, so this computer can’t lend yet/
    : /Faravan hasn’t confirmed a test workspace, so this computer can’t lend yet/);
  assert.doesNotMatch(card.textContent,/Choose Check again|service isn.t running|needs to restart to finish its update/);
  assert.doesNotMatch(view.text(),/4 of 4 required checks complete|Your computer is ready/);
  assert.equal(Boolean(view.button('Turn on lending for Weekend projects')),false);
  const before=calls.length;
  await click(view.button('Check again'));
  assert.ok(calls.some(call=>call[0]==='get'&&call[1]==='readiness?refresh=true'));
  assert.equal(calls.some(call=>call[0]==='post'),false);
  assert.equal(document.querySelector('dialog'),null);
  assert.equal(refreshes,1);
  await view.rerender(h(Setup,renderProps()));
  assert.match(view.$('.setup-current')?.textContent??'',/test workspace/,
    'successful recovery action is not a successful workspace observation');
  assert.doesNotMatch(view.text(),/Your computer is ready/);
  current={ready:true,checks:[...readyChecks,{name:'test_workspace',ok:true}]};
  await view.rerender(h(Setup,renderProps()));
  assert.equal(Boolean(view.button('Restart Docker Sandboxes')),false);
  assert.doesNotMatch(view.$('.setup-current')?.textContent??'',/test workspace/);
});

test('Setup explains package-managed updates without offering an early-build switch',async t=>{
  t.after(teardown);resetPage();
  const api={get:async path=>path==='update-settings'?{earlyBuilds:false,canSelfUpdate:false}:lendingPass};
  const view=await mount(h(Setup,props(api,{ready:true,checks:readyChecks})));await flush();
  assert.ok(!view.$('#early-builds'),'package-managed installs have no early-build switch');
  assert.match(view.text(),/This install updates through your package manager\./);
});
