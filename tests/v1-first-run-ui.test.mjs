import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {lendingLabel} from '../lib/v1/status.mjs';
import {problemForError} from '../lib/v1/cli.mjs';
import {setupVM,needsYouItems} from '../ui/v1/src/view-models.mjs';
import {setupDetailsVM} from '../ui/v1/src/setup-details.mjs';
import {lendingBlockers} from '../lib/v1/blockers.mjs';

test('fresh lending choice agrees across API, CLI, checklist and attention',async t=>{
 const f=await appFixture(t);
 const backend=syntheticBackend(f.root);
 const original=backend.protectionSummary.bind(backend);
 backend.protectionSummary=async(...args)=>{const report=await original(...args);report.preflight.checks.push({name:'docker_login',ok:false,detail:'Not signed in.'});report.satisfied=false;return report;};
 const {app}=await f.start('fresh',{backend,freshLending:'automatic'});
 const lending=await api(app,'/api/lending');
 assert.equal(lending.intent,'on');assert.equal(lending.enabled,false);assert.equal(lending.lending_on,true);
 assert.equal(lending.paused,false);assert.match(lending.label,/Lending is on/);
 assert.match(lendingLabel(lending),/Lending on/);
 assert.doesNotMatch(JSON.stringify(lending.objective),/turn lending on to take new jobs/);
 const home=await api(app,'/api/home');
 assert.equal(home.intent.on,true);
 assert.equal(home.lending_blockers.items.find(x=>x.key==='lending').detail,'On.');
 const items=needsYouItems({home,readiness:await api(app,'/api/readiness'),agents:await api(app,'/api/agents')});
 // Lending is on by default, but the person has not chosen it: the sign-in step stays in the lending model (Lend and Setup)
 // and is not an item that needs them on Home, where a computer that only borrows must never be told lending setup blocks it.
 assert.ok(home.lending_blockers.items.some(x=>x.key==='docker_signin'&&x.status==='blocked'));
 assert.deepEqual(items.filter(x=>x.kind==='blocker'),[]);
 assert.ok(items.every(x=>x.label||x.item||['request','approval','result'].includes(x.kind)),JSON.stringify(items));
});

test('network setup waits for Docker and retains its repair action after sign-in',()=>{
 const requirements=[{cause:'docker_login',label:'raw login error'},{cause:'network_policy',label:'global network policy has not been initialized.',remedy:'Initialize sandbox network rules'}];
 const input={docker:{installed:true,running:true,signedIn:false},readinessRequirements:requirements,intent:{on:true},agents:[]};
 const blocked=lendingBlockers(input);
 assert.equal(blocked.items.filter(x=>x.key==='docker_signin').length,1);
 assert.equal(blocked.items.filter(x=>x.cause==='docker_login').length,0);
 assert.equal(blocked.items.find(x=>x.cause==='network_policy').status,'waits');
 const ready=lendingBlockers({...input,docker:{...input.docker,signedIn:true}});
 const policy=ready.items.find(x=>x.cause==='network_policy');
 assert.equal(policy.label,'Sandbox network rules');assert.equal(policy.action,'Initialize sandbox network rules');
 const vm=setupVM({status:{lending_blockers:ready},readiness:{checks:[]}});
 assert.equal(vm.steps.find(x=>x.id==='requirement:network_policy').blocker.action,policy.action);
 assert.equal(new Set(vm.steps.map(x=>x.id)).size,vm.steps.length);
});

test('fresh local circle is absent membership, while a tried invitation keeps its status',()=>{
 const row=circle=>setupVM({circle}).steps.find(x=>x.id==='circle');
 for(const circle of [null,{id:'local',name:'My devices',origin:null}]) {
  assert.match(row(circle).detail,/haven’t joined or started/);assert.equal(row(circle).link.href,'#/circles');
 }
 assert.match(row({id:'remote',origin:'https://circle.invalid',enrollment:{state:'pending'}}).detail,/waiting for approval/);
});

test('sign-in storage capability does not claim a saved login and dependent rules wait',()=>{
 const rows=setupDetailsVM({checks:[{name:'sbx_credential_store',ok:true},{name:'docker_login',ok:false},{name:'network_policy',ok:false}]}).rows;
 assert.equal(rows[0].label,'Docker can store sign-in on this computer');
 assert.equal(rows[1].state,'Needs attention');assert.equal(rows[2].state,'Waiting');
});

test('already running message names the app and the command to open it',()=>{
 const problem=problemForError({code:'app_already_running'});
 assert.match(problem.message,/Faravan is already running/);assert.match(problem.message,/faravan app open-link/);
 assert.doesNotMatch(problem.message,/Interrupted/);
});
