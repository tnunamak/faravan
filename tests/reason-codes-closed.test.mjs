import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LENDING_REASONS,lendingReasonCode,lendingReasonText,giveBackCode} from '../lib/v1/lending-reasons.mjs';
test('public reasons have a sentence and one action, with fewer codes than the retired path',()=>{
 assert.ok(Object.keys(LENDING_REASONS).length<41);
 for(const [code,row] of Object.entries(LENDING_REASONS)){
  assert.ok(row.sentence.endsWith('.'),code);assert.ok(row.action,code);
 }
 assert.equal(lendingReasonCode('raw_backend_diagnostic'),'conditions_unavailable');
 assert.equal(giveBackCode('requirements_unsupported'),'cannot_run_here');
 assert.match(lendingReasonText('outside_hours',{until:1234,formatTime:()=> '09:00'}),/09:00/);
});
test('literal decision codes and wait observations belong to the public list',()=>{
 for(const file of ['lending-decision.mjs','account-execution.mjs','lender.mjs']){
  const source=readFileSync(new URL('../lib/v1/'+file,import.meta.url),'utf8');
  const codes=[...source.matchAll(/(?:hold\(|wait\(|reason:\s*|code:\s*)'([a-z_]+)'/g)].map(m=>m[1]);
  // Transport and durable lifecycle errors are diagnostics, not lending decisions.
  const decisions=file==='lender.mjs'?[...source.matchAll(/\bwait\('([a-z_]+)'/g)].map(m=>m[1]):codes;
  for(const code of decisions)if(!['settings_conflict','invalid_decision_input','strategy_unsupported','job_binding_mismatch','not_used','restart_recovery','cancelled','finished','preparation_failed','admission','settlement','limit_recheck'].includes(code))
   assert.ok(Object.hasOwn(LENDING_REASONS,code),file+': '+code);
 }
});
