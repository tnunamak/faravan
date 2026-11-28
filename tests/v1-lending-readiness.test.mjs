import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {lendingReadiness} from '../lib/v1/lending-readiness.mjs';
const observation = {refresh_succeeded:true, identity:{verified:true,account_id:'fixture'}, account_week_id:'week', epoch:'epoch',
  complete:true, weekly_resource_id:'weekly', funding:{subscription_only:'proven'}, executor:{single_executor:'proven'},
  stop:{bounded_execution:'proven'}, stop_bound_ms:1, uncertainty_ms:0, resources:[{kappa_micro:1}]};
const check = (changes={}) => lendingReadiness({provider:'codex',signedIn:true,observation,...changes});
test('independent required facts keep missing or stale allowance out of setup holds',()=>{
  const requiredEvidence={identity:{verified:true},funding:{subscription_only:'proven'},
    executor:{single_executor:'proven'},stop:{bounded_execution:'proven'}};
  for(const value of [null,{...observation,refresh_succeeded:false},
    {...observation,resources:[{kappa_micro:null}],calibration_missing:[{}]}]) {
    const rows=check({observation:value,requiredEvidence});
    assert.deepEqual(rows.map(row=>row.id),['signed_in','account','subscription','job_control']);
    assert.ok(rows.every(row=>row.state==='pass'));
  }
  for(const [part,value,id] of [['identity',{verified:false},'account'],
    ['funding',{subscription_only:'unknown'},'subscription'],['executor',{single_executor:'unknown'},'job_control'],
    ['stop',{bounded_execution:'unknown'},'job_control']]) {
    const rows=check({observation:null,requiredEvidence:{...requiredEvidence,[part]:value}});
    assert.equal(rows.find(row=>row.id===id).state,'unknown');
  }
  assert.equal(check({requiredEvidence,runtimeCheck:{ok:false}}).find(row=>row.id==='guard_runtime').state,'fail');
});
test('readiness reports independent policy proofs without claiming a per-job fence',()=>{
  assert.deepEqual(check().map(x=>x.state),['pass','pass','pass','pass','pass','pass']);
  assert.ok(check().every(x=>x.line && (x.state==='pass' ? x.fix===null : x.fix)));
});
test('readiness distinguishes explicit failures and missing evidence',()=>{
  const rows=check({signedIn:false,observation:{...observation,identity:{verified:false},funding:{subscription_only:'unknown',reason:'limit_reached'},complete:false,resources:[{kappa_micro:null}]}});
  assert.deepEqual(rows.map(x=>x.state),['fail','unknown','fail','unknown','unknown','pass']);
  assert.deepEqual(check({signedIn:null,observation:null}).map(x=>x.state),['unknown','unknown','unknown','unknown','unknown','unknown']);
});

test('a mismatched account is a failure rather than an unread account',()=>{
  const row=check({observation:{...observation,identity:{verified:false,reason:'identity_mismatch'}}})[1];
  assert.equal(row.state,'fail');
  assert.match(row.line,/does not match/);
});

test('failing checks offer plain actions without a role prefix',()=>{
  for (const changes of [
    {signedIn:false},
    {observation:{...observation,identity:{verified:false,reason:'identity_mismatch'}}},
    {observation:{...observation,funding:{subscription_only:'unknown',reason:'plan_not_subscription'}}},
  ]) {
    for (const row of check(changes).filter(item=>item.state==='fail')) assert.doesNotMatch(row.fix,/^(?:You|Faravan):/);
  }
  const plan=check({observation:{...observation,funding:{subscription_only:'unknown',reason:'plan_not_subscription'}}})[2];
  assert.equal(plan.line,'This account has no plan Faravan can lend from.');
  assert.equal(plan.fix,'Check the plan, usage limit and billing settings for this account.');
});

test('a missing default-model price row is unknown even after a successful observation', () => {
  for (const observationValue of [null, observation]) {
    const row = check({provider:'uncatalogued-provider', observation:observationValue}).find(row => row.id === 'conversion');
    assert.equal(row.state, 'unknown');
    assert.match(row.line, /not confirmed/);
  }
});

test('missing shipped calibration shows estimation without turning missing measurement into a hold',()=>{
  const detail={reason:'calibration_missing',scope:'plan',provider:'codex',plan:'plus',model:'gpt-6-sol',window:'weekly'};
  const row=check({observation:{...observation,resources:[{kappa_micro:null}],calibration_missing:[detail]}})
    .find(item=>item.id==='conversion');
  assert.equal(row.state,'unknown');
  assert.match(row.line,/Usage estimate:/);
  assert.equal(row.fix,'Refresh the agent allowance. If the estimate is still unavailable, check the account plan or report the missing estimate.');
  const model=check({observation:{...observation,resources:[{kappa_micro:null}],
    calibration_missing:[{...detail,scope:'model_window',plan:'pro',window:'five_hour'}]}}).find(item=>item.id==='conversion');
  assert.match(model.line,/Usage estimate:/);
  assert.equal(model.fix,'Refresh the agent allowance. If the estimate is still unavailable, check the account plan or report the missing estimate.');
  assert.equal(check({observation:{...observation,refresh_succeeded:false,calibration_missing:[detail]}})
    .find(item=>item.id==='conversion').fix,'Refresh the agent allowance. If the estimate is still unavailable, check the account plan or report the missing estimate.');
});

test('missing or malformed calibration metadata never promises automatic conversion recovery',()=>{
  for(const calibration_missing of [undefined,[],[{}],[{reason:'calibration_missing',scope:'plan'}]]) {
    const row=check({observation:{...observation,resources:[{kappa_micro:null}],calibration_missing}})
      .find(item=>item.id==='conversion');
    assert.equal(row.state,'unknown');
    assert.equal(row.line,'The default model allowance estimate is not confirmed.');
    assert.equal(row.fix,'Refresh the agent allowance. If the estimate is still unavailable, check the account plan or report the missing estimate.');
    assert.doesNotMatch(row.line+' '+row.fix,/Borrowing still works|Checked again automatically/);
  }
});

test('Codex usage limit checklist waits for reset without sending the owner to billing', () => {
  const row = check({observation:{...observation, funding:{subscription_only:'unknown', reason:'limit_reached'}}})[2];
  assert.equal(row.state, 'fail');
  assert.match(row.line, /this account has reached its Codex usage limit/);
  assert.match(row.line, /when the limit resets/);
  assert.equal(row.fix, 'Wait for the limit to reset');
  assert.doesNotMatch(row.line + row.fix, /plan|billing/i);
});

test('a failed runtime check gives an actionable blocker and a passing check removes it', () => {
  const blocked = check({runtimeCheck:{ok:false}}).find(row=>row.code==='guard_runtime_unavailable');
  assert.equal(blocked.state,'fail');
  assert.equal(blocked.line,"Faravan's job guard could not start in the sandbox. Update Faravan; if it still fails, reinstall Faravan.");
  assert.match(blocked.fix,/Update Faravan.*reinstall Faravan/);
  assert.equal(check({runtimeCheck:{ok:true}}).some(row=>row.code==='guard_runtime_unavailable'),false);
});

test('runtime failure has specific owner status and lending log copy', async () => {
  const {lendingStatus,RUNTIME_HELP}=await import('../lib/v1/lending-status-copy.mjs');
  const {messageForCode}=await import('../lib/v1/lending-log.mjs');
  assert.equal(messageForCode('guard_runtime_unavailable','before_claim'),RUNTIME_HELP);
  const status=lendingStatus({reason:'guard_runtime_unavailable'});
  assert.match(status.line,/job guard could not start/);
  assert.match(status.recovery.action,/update Faravan.*reinstall Faravan/);
});

test('a failed probe explains stale allowance checks without executor or installation advice', () => {
  const rows = check({observation:{...observation, executor:{single_executor:'unknown'},
    probe_outcome:{outcome:'failed',reason:'guest_failed',at:123}}});
  const row = rows.find(row=>row.id==='job_control');
  assert.equal(row.state, 'unknown');
  assert.equal(row.line, "Faravan could not read this account's allowance: the allowance check could not run.");
  assert.match(row.fix, /allowance check could not run/);
  assert.doesNotMatch(row.line + row.fix, /installed|executor|verdict|receipt|attempt|settled|lease|Ran on/);
  assert.equal(rows[0].state, 'pass');
});

test('a probe that failed because the job guard could not start says how to fix it', () => {
  const row = check({observation:{...observation, executor:{single_executor:'unknown'},
    probe_outcome:{outcome:'failed',reason:'guard_runtime_unavailable',at:123}}}).find(row=>row.id==='job_control');
  assert.equal(row.line, "Faravan could not read this account's allowance: Faravan's sandbox job guard could not start.");
  assert.equal(row.fix, 'Update Faravan; if it still fails, reinstall Faravan.');
});

test('missing quota or epoch evidence for a signed-in account is an estimate in progress, not a user-action veto',async()=>{
  const {usageEstimateNote}=await import('../lib/v1/lending-status-copy.mjs');
  for(const patch of [{epoch:null},{account_week_id:null},{complete:false},{weekly_resource_id:null}]) {
    const rows=check({observation:{...observation,...patch}});
    const byId=Object.fromEntries(rows.map(row=>[row.id,row]));
    assert.equal(byId.weekly_window.state,'unknown',JSON.stringify(patch));
    assert.equal(byId.weekly_window.line,usageEstimateNote(),JSON.stringify(patch));
    assert.equal(byId.weekly_window.fix,null,JSON.stringify(patch));
    for(const id of ['signed_in','account','subscription','job_control']) assert.equal(byId[id].state,'pass',id+JSON.stringify(patch));
    assert.equal(rows.some(row=>row.state==='fail'),false);
  }
});

test('each diagnostic comes from its own evidence, never from the admission proof list',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../lib/v1/lending-readiness.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/observationProofFailures/);
});

test('confirmed hard facts still hold when allowance evidence is missing',()=>{
  const gap={epoch:null,account_week_id:null};
  const state=(changes,id)=>check(changes).find(row=>row.id===id).state;
  assert.equal(state({observation:{...observation,...gap,identity:{verified:false,reason:'identity_mismatch'}}},'account'),'fail');
  assert.equal(state({observation:{...observation,...gap,funding:{subscription_only:'unknown',reason:'extra_usage_enabled'}}},'subscription'),'fail');
  assert.equal(state({signedIn:false,observation:{...observation,...gap}},'signed_in'),'fail');
  for(const stop of [{stop:{bounded_execution:'unknown'}},{stop_bound_ms:null},{uncertainty_ms:-1},{executor:{single_executor:'unknown'}}])
    assert.equal(state({observation:{...observation,...gap,...stop}},'job_control'),'unknown',JSON.stringify(stop));
});
