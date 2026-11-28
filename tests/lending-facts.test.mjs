import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideLending} from '../lib/v1/lending-decision.mjs';
const at=1800000000000;
const base={schemaVersion:1,nowMs:at,account:{id:'a',providerId:'p',enabled:true,authState:'signed_in'},
 usage:{accountId:'a',state:'unavailable',reading:null},policy:{enabled:true,revision:1,strategy:'automatic',strategyParams:{},protectionPosition:'balanced'},
 eligibility:{evaluatedAtMs:at,settingsRevision:1,enabledNow:true},ledger:{accountId:'a',resources:[]},history:{accountId:'a',rows:[]},job:null,runtime:{canStart:true}};
test('unknown sandbox and account observations lend',()=>{
 assert.equal(decideLending({...base,runtime:{canStart:null},account:{...base.account,authState:'unknown'}}).kind,'lend');
});
test('soft conditions choose the earliest real future time',()=>{
 const d=decideLending({...base,conditions:{waits:[{reason:'cleanup_pending',nextEvaluationAtMs:at+8000},{reason:'outside_hours',nextEvaluationAtMs:at+3000}]}});
 assert.equal(d.kind,'wait');assert.equal(d.reason,'outside_hours');assert.equal(d.nextEvaluationAtMs,at+3000);
});
test('provider limit without reset has a recheck time',()=>{
 const d=decideLending({...base,usage:{...base.usage,state:'limit',limitResetAtMs:null}});
 assert.equal(d.kind,'wait');assert.equal(d.reason,'provider_limit_reached');assert.equal(d.nextEvaluationAtMs,at+120000);
});
