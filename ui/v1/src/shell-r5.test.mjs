import test from 'node:test';
import assert from 'node:assert/strict';
import {lendPageVM,machineVM,jobsListVM,connectionVM,needsYouItems} from './view-models.mjs';
import {onboardingVM} from './onboarding.mjs';
import {circlePerson} from './circles-view.mjs';
import {AccountCard} from './lending-policy-view.jsx';
import {Lend} from './lend.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}];
const readiness={ready:true,checks:[]};
const lending={enabled:true,circle:'friends',status:'idle',limits:{dailyJobs:1,dailyMinutes:60,timeZone:'UTC'}};
const home={intent:{on:true,state:'ready'},lending,today:{jobs:1,jobLimit:1,minutes:5,minuteLimit:60}};

test('O6 daily cap has a true headline and sidebar chip',()=>{
 const vm=lendPageVM(home,{agents,readiness});
 assert.equal(vm.kind,'resting'); assert.equal(vm.headline,'Done for today');
 assert.match(vm.reason,/1 of 1 job.*midnight/);
 assert.equal(machineVM(home,{name:'Laptop'},{agents,readiness}).line,'Done for today');
});
test('N18 running the last allowed job takes precedence over daily cap',()=>{
 const vm=lendPageVM(withLendingProjection({...home,execution:{state:'running',job:'attempt-1',person:'Sam'}},
  {intent:'on',intentState:'ready',admission:'blocked',admissionReason:'daily_limit',execution:'running',executionJob:'attempt-1',dailyLimitReached:true}),{agents,readiness});
 assert.equal(vm.kind,'running');assert.equal(vm.headline,'Running Sam’s job');
 assert.doesNotMatch(vm.reason,/Ready for requests/);
});
test('M4 zero daily meters are absent while lending is off',()=>{
 const vm=lendPageVM({...home,intent:{on:false,state:'off'},today:{jobs:0,jobLimit:1,minutes:0,minuteLimit:60},lending:{...lending,enabled:false}},{agents,readiness});
 assert.equal(vm.meters.length,0);
});
test('N17 no circle cannot be ready even if lending intent is on',()=>{
 const status=withLendingProjection({...home,intent:{on:true,state:'blocked',reason:'circle_not_joined'},lending:{...lending,circle:null}},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'circle_not_joined'});
 const page=lendPageVM(status,{agents,readiness});
 assert.equal(page.kind,'blocked');assert.notEqual(machineVM(status,{}, {agents,readiness}).line,'Ready for requests');
 const vm=onboardingVM({home:status,circles:[],jobs:[],agents});
 assert.ok(vm.entry?.actions.some(a=>a.id==='join') || vm.progress?.current?.actions?.some(a=>a.href==='#/circles'));
});
test('N11 unknown agent is omitted from job rows',()=>{
 const row=jobsListVM([{job_digest:'sha256:'+'a'.repeat(64),state:'completed',status:'Ready to review',local:{title:'Write a poem'}}]).groups[0].rows[0];
 assert.equal(row.agent,'');assert.equal(row.whoShort,'');
});
test('O12 phone recovery has one phone instruction and no command',()=>{
 const vm=connectionVM({errors:{home:{status:401}},phone:true});
 assert.match(vm.text,/Settings → Pairing.*pair/);assert.doesNotMatch(vm.text,/tray|terminal/);
 assert.equal(vm.copy,undefined);assert.equal(vm.action,null);
});
test('O8 account card does not invent an allowance when no objective data is present',()=>{
 const html=renderFixture(AccountCard,{account:{id:'codex',provider:'codex',windows:[]},policy:{},now:Date.now(),zone:'UTC'});
 assert.match(html,/Codex/);assert.doesNotMatch(html,/hasn’t read this allowance yet|<p class="allow-row/);
});
test('M7 placeholder profile names fall back to the computer name',()=>{
 assert.equal(circlePerson({localName:'A circle member',ownerName:'A circle member',device_name:'sandpiper'}),'sandpiper');
});
test('N23 recovery action and Pause share a primary-first row',()=>{
 const status={...home,intent:{on:true,state:'blocked',reason:'lending_not_started'},lending:{...lending,enabled:false}};
 const html=renderFixture(Lend,{api:{},agents,lending:status.lending,data:{home:status,readiness,approvals:[]},mutate:async()=>({}),circle:'friends',selected:{id:'friends'},circles:[{id:'friends',origin:'http://fixture'}],members:[],refresh(){},setDialog(){},setCircle(){}});
 assert.ok(html.indexOf('Resume now')<html.indexOf('Pause new jobs…'));
 assert.match(renderedText(html),/Resume now Pause new jobs/);
});

import {peopleVM} from './people-view.mjs';
import {PeopleList} from './people.jsx';
import {StartAnotherCircle} from './start-circle.jsx';
test('M7 unnamed people use computer labels and a neutral avatar',()=>{
 const people=[{personId:'sam',role:'member',name:null,computers:[{key_id:'sam',device_name:'sandpiper'}]}];
 const [person]=peopleVM(people,[],'self');
 assert.equal(person.name,'sandpiper');assert.equal(person.avatarName,'');
 const html=renderFixture(PeopleList,{people,members:[],selfKey:'self',circleId:'c'});
 assert.doesNotMatch(html,/>AP<|A circle member ·/);
});
test('N24 first circle on a configured host avoids another-circle advice',()=>{
 const html=renderFixture(StartAnotherCircle,{mutate:async()=>({}),first:true});
 assert.doesNotMatch(renderedText(html),/same address|new circle/);
});

test('O7 failed join start exposes one named recovery without claiming a restart',()=>{
 const status=withLendingProjection({...home,intent:{on:true,state:'blocked',reason:'lending_not_started'},lending:{...lending,enabled:false},lendingStartFailed:{code:'circle_unreachable',circleName:'Weekend projects'},attention:[{label:'Lending could not start in Weekend projects.',action:'retry'}]},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'lending_not_started'});
 const vm=lendPageVM(status,{agents,readiness});
 assert.equal(vm.heroAction.action,'Resume now');assert.match(vm.reason,/Lending couldn’t start for the circle “Weekend projects”/);assert.doesNotMatch(vm.reason,/restart/);
 assert.equal(needsYouItems({home:status,agents,readiness}).filter(i=>i.kind!=='blocker').length,0);
});

import {waitingCopyVM,lendingLimitsVM} from './view-models.mjs';
test('O6 borrower sees the named limited computer when no lender is ready',()=>{
 const job={state:'queued',circle:{id:'friends'},offerWaiting:{readyCount:0,deciding:null,dailyLimitCount:1,dailyLimitDevices:['sam']}};
 const devices={circles:[{circle:'friends',members:[{key_id:'sam',device_name:'sandpiper'}]}]};
 assert.equal(waitingCopyVM(job,{devices}).headline,'sandpiper’s computer has reached its limit for today');
 assert.equal(waitingCopyVM({...job,offerWaiting:{...job.offerWaiting,readyCount:1}},{devices}).headline,'Waiting for someone to run it');
});
test('singular daily caps say one job',()=>{
 assert.equal(lendingLimitsVM(lending)[0].value,'1 job');
 assert.match(lendPageVM(home,{agents,readiness}).reason,/1 of 1 job\./);
});

test('review N2 Codex-only lending omits the Claude-specific reserve',()=>{
 assert.equal(lendingLimitsVM(lending,null,agents).some(row=>row.label==='Keep for yourself'),false);
});

import {Shell} from './shell.jsx';
test('review N4 ended sessions hide phone navigation',()=>{
 const html=renderFixture(Shell,{route:{page:'jobs'},circles:[],sessionEnded:true});
 assert.doesNotMatch(html,/class="tabbar"/);
});

import {LendingCard} from './lend.jsx';
test('singular Home daily-cap reason reads one job and the meter does not repeat it',()=>{
 const html=renderFixture(LendingCard,{vm:lendPageVM(home,{agents,readiness}),device:'Laptop',circle:'friends',lending,agents,mutate:async()=>({})});
 assert.match(renderedText(html),/1 of 1 job\b/);assert.doesNotMatch(renderedText(html),/1 of 1 jobs\b/);assert.equal((renderedText(html).match(/1 of 1 job/g)||[]).length,1);
});

test('ended sessions cannot keep a cached ready sidebar status',()=>{
 assert.equal(machineVM(home,{name:'Laptop'},{agents,readiness,unavailable:{status:401}}).line,'Not connected');
});
