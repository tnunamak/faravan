import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupVM} from '../ui/v1/src/view-models.mjs';

function account(login) {
  const readiness={ready:login.ok===true,checks:[{name:'sbx_install',ok:true},{name:'docker_runtime',ok:true},
    {name:'docker_login',...login}]};
  return setupVM({readiness,agents:[],status:{lending:{enabled:false}}}).steps.find(step=>step.id==='docker-account');
}

test('positive create-refusal evidence shows the Docker account sign-in step',()=>{
  const step=account({ok:false,cause:'docker_signed_out',detail:'Sign in to Docker to lend.'});
  assert.equal(step.state,'need');
  assert.ok(step.actions.includes('docker-signin'));
});

test('a working listing alone shows one unconfirmed Docker sign-in with a check that runs again', () => {
  const step=account({ok:true,signinVerified:false,detail:'No Docker sign-in refusal has been observed.'});
  assert.equal(step.state,'need');
  assert.equal(step.detail,'Faravan could not confirm the Docker sign-in.');
  assert.doesNotMatch(step.detail,/Signed in\./);
  assert.deepEqual(step.actions,['recheck','docker-create']);
});

test('while the confirm check runs the step says Checking and offers nothing', () => {
  const step=account({ok:true,signinVerified:false,checking:true,detail:'No Docker sign-in refusal has been observed.'});
  assert.equal(step.state,'now');
  assert.equal(step.detail,'Checking…');
  assert.equal(step.actions,undefined);
});

test('an accepted sandbox create shows ok and says only that', () => {
  const step=account({ok:true,signinVerified:false,createAccepted:true,detail:"Docker accepted Faravan's request to start a test workspace."});
  assert.equal(step.state,'ok');
  assert.equal(step.detail,"Docker accepted Faravan's request to start a test workspace.");
  assert.doesNotMatch(step.detail,/Signed in\./);
});

test('a sleeping host still offers Check again rather than Docker sign-in',()=>{
  const step=account({ok:false,cause:'docker_signin_refresh_unavailable'});
  assert.equal(step.state,'now');
  assert.deepEqual(step.actions,['recheck']);
});

test('an unverified failed listing is checking, not signed out',()=>{
  const step=account({ok:false,unknown:true});
  assert.notEqual(step.state,'need');
  assert.ok(!(step.actions??[]).includes('docker-signin'));
});

import {dockerSignedOutFrom,dockerFacts} from '../lib/v1/docker-state.mjs';
import {blockersInput} from '../ui/v1/src/view-models.mjs';
const storageRow={name:'docker_login',ok:false,cause:'docker_signin_state_unavailable',
  label:'Docker sign-in state could not be saved or read.',remedy:'Check access to the app data folder, then restart Faravan.'};
test('unreadable local state is not evidence of a signed-out Docker account',()=>{
  assert.equal(dockerSignedOutFrom([storageRow]),null);
  assert.equal(dockerFacts([storageRow]).signedIn,null);
  const input=blockersInput({readiness:{ready:false,checks:[storageRow]}});
  assert.equal(input.docker.signedIn,null);
  assert.equal(input.readinessRequirements[0].cause,'docker_signin_state_unavailable');
});
test('Setup routes unreadable local state to a storage remedy, not sign-in',()=>{
  const view=setupVM({readiness:{ready:false,checks:[{name:'sbx_install',ok:true},{name:'docker_runtime',ok:true},storageRow]},agents:[],status:{lending:{enabled:false}}});
  const repair=view.steps.find(step=>step.id==='requirement:docker_signin_state_unavailable');
  assert.ok(repair);
  assert.equal(repair.state,'need');
  assert.match(repair.detail,/app data folder/);
  assert.ok(!view.steps.some(step=>(step.actions??[]).includes('docker-signin')));
});

// Exercise the actual app projection before the pure view model. A raw backend
// row alone cannot prove the API retains its bounded evidence fields.
import {readFile} from 'node:fs/promises';
const appSource=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
const projectionStart=appSource.indexOf('    const checks=(report?.preflight?.checks??[]).map(');
const projectionEnd=appSource.indexOf('    const names=value=>',projectionStart);
assert.ok(projectionStart>0&&projectionEnd>projectionStart,'app readiness projection exists');
const projectChecks=new Function('report','safeLine','appRemedy',appSource.slice(projectionStart,projectionEnd)+'return checks;');
const project=checks=>projectChecks({preflight:{checks}},value=>String(value??''),c=>c.fix??'');

test('the app readiness projection retains unverified sign-in evidence for Setup',()=>{
  const checks=project([{name:'sbx_install',ok:true},{name:'docker_runtime',ok:true},
    {name:'docker_login',ok:true,signinVerified:false,detail:'No Docker sign-in refusal has been observed.'}]);
  assert.equal(checks.find(c=>c.name==='docker_login').signinVerified,false);
  const step=setupVM({readiness:{ready:true,checks},agents:[],status:{lending:{enabled:false}}}).steps.find(s=>s.id==='docker-account');
  assert.equal(step.detail,'Faravan could not confirm the Docker sign-in.');
  const accepted=project([{name:'docker_login',ok:true,signinVerified:false,createAccepted:true,detail:'x'}]);
  assert.equal(accepted.find(c=>c.name==='docker_login').createAccepted,true);
});

test('the app readiness projection retains only closed Docker causes and boolean evidence',()=>{
  for(const cause of ['docker_signed_out','docker_signin_state_unavailable','docker_signin_refresh_unavailable']){
    const row=project([{name:'docker_login',ok:false,cause,signinVerified:false}])[0];
    assert.equal(row.cause,cause);assert.equal(row.signinVerified,false);
  }
  const row=project([{name:'docker_login',ok:true,cause:'private output',signinVerified:'private output'}])[0];
  assert.equal(row.cause,undefined);assert.equal(row.signinVerified,undefined);
  assert.doesNotMatch(JSON.stringify(row),/private output/);
});

test('an unverified Docker sign-in stays unknown in the Home and Lend views, not signed in', async () => {
  const {blockersFor, blockersInput} = await import('../ui/v1/src/view-models.mjs');
  const readiness={ready:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_runtime',ok:true},
    {name:'docker_login',ok:true,signinVerified:false}]};
  assert.equal(blockersInput({readiness}).docker.signedIn,null);
  const model=blockersFor({readiness,agents:[]});
  const row=model.items.find(item=>item.key==='docker_signin');
  assert.equal(row.status,'unknown');
  assert.doesNotMatch(row.detail,/Signed in/);
  const accepted={...readiness,checks:readiness.checks.map(c=>c.name==='docker_login'?{...c,createAccepted:true}:c)};
  assert.equal(blockersInput({readiness:accepted}).docker.signedIn,true);
});
