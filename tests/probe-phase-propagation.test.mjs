import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingProbe,createLendingReadings,sanitizeProbeFailure} from '../lib/v1/lending-probe.mjs';
import {sanitizeProbeDiagnostics} from '../lib/v1/probe-diagnostics.mjs';
const now=()=>Date.parse('2026-11-08T01:00:00.000Z');
const wire=(status=200,identity=true)=>JSON.stringify({faravan_probe:1,status,body:{five_hour:null,extra_usage:{is_enabled:false}},
 ...(identity?{identity:{status:200,account_sha256_16:'a'.repeat(16),email_sha256_16:'b'.repeat(16)}}:{})});
const ledger=()=>({snapshot(){return {read_at:null,windows:[]};},recordReadings(){}});
const fakeRunner=work=>async ({probeContext,...request})=>{
 const p=probeContext.start('preflight');probeContext.end(p);
 probeContext.start('first_command',{budgetMs:120000,deadlineSource:'command'});
 return work(request,probeContext);
};
function assertReceipt(value,expectedPhase='first_command'){
 assert.ok(sanitizeProbeDiagnostics(value.probe_diagnostics));
 assert.equal(value.failed_phase,expectedPhase);
 return value.probe_diagnostics.probe_id;
}

test('review: wrapper result, last result, attempt, outcome share failure correlation',async()=>{
 const receipts=[];const probe=createLendingProbe({ledger:ledger(),now,onProbeReceipt:r=>receipts.push(r),runGuest:fakeRunner(()=>({exitCode:1,stdout:'secret raw nonsense'}))});
 const result=await probe.probe('claude');assert.equal(result.reason,'unreadable');
 const id=assertReceipt(result);
 for(const v of [probe.lastResult('claude'),probe.latestAttempt('claude'),probe.outcome('claude')]) assert.equal(assertReceipt(v),id);
 assert.equal(receipts.length,1);assert.equal(receipts[0].probe_id,id);
 assert.ok(!JSON.stringify(result).includes('secret raw'));
});

test('review: runner exceptions preserve phase and ignore raw exception text',async()=>{
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner((_r,c)=>{
  const row=c.start('storage_qualification',{subject:'qualification'});c.end(row,'failed');
  throw Object.assign(new Error('secret provider exception'),{probe_failure:'sandbox_start_failed'});
 })});
 const result=await probe.probe('claude');assert.equal(result.reason,'sandbox_start_failed');
 assertReceipt(result,'storage_qualification');assert.ok(!JSON.stringify(result).includes('secret provider'));
});

test('review: failed readings and cached failure retain host phase diagnostics',async()=>{
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(()=>({exitCode:1,stdout:'',probe_failure:'timeout'}))});
 const readings=createLendingReadings({ledger:ledger(),probe,now});const result=await readings('claude',{forceRefresh:true});
 assert.equal(result.probe.reason,'timeout');const id=assertReceipt(result.probe);
 assert.equal(assertReceipt(readings.cached('claude').probe),id);
 assert.equal(assertReceipt(sanitizeProbeFailure(result.probe,'claude')),id);
});

test('review: wrapper success remains successful when diagnostics callbacks reject or throw',async()=>{
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(()=>({exitCode:0,stdout:wire()})),
 onProbeEvent(){throw new Error('log failed');},onProbeReceipt(){return Promise.reject(new Error('receipt failed'));}});
 const result=await probe.probe('claude');assert.equal(result.ok,true);
 assert.ok(sanitizeProbeDiagnostics(result.probe_diagnostics));assert.equal(result.failed_phase,undefined);
 assert.equal(probe.outcome('claude').outcome,'good');
 await new Promise(resolve=>setImmediate(resolve));
});

test('review: live readings retain diagnostics for partial identity failure',async()=>{
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(()=>({exitCode:0,stdout:wire(200,false)}))});
 const readings=createLendingReadings({ledger:ledger(),probe,now});const result=await readings('claude',{forceRefresh:true});
 assert.equal(result.probe.reason,'identity_failed');assertReceipt(result.probe);
});

test('review: cached readings retain diagnostics for partial identity failure',async()=>{
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(()=>({exitCode:0,stdout:wire(200,false)}))});
 await probe.probe('claude');
 const readings=createLendingReadings({ledger:ledger(),probe,now});const result=readings.cached('claude');
 assert.equal(result.probe.reason,'identity_failed');assertReceipt(result.probe);
});

test('review: readings catch preserves diagnostics from failed durable ledger write',async()=>{
 const l=ledger();l.recordReadings=()=>{throw new Error('secret path');};
 const probe=createLendingProbe({ledger:l,now,runGuest:fakeRunner(()=>({exitCode:0,stdout:wire()}))});
 const readings=createLendingReadings({ledger:l,probe,now});const result=await readings('claude',{forceRefresh:true});
 assert.equal(result.probe.reason,'guest_failed');assertReceipt(result.probe);
 assert.ok(!JSON.stringify(result).includes('secret path'));
});

test('review: provider failures preserve precise phase without exposing raw response fields',async()=>{
 for(const [status,reason] of [[401,'auth'],[429,'rate_limited'],[503,'provider_error']]){
  const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(()=>({exitCode:0,stdout:wire(status)}))});
  const result=await probe.probe('claude');assert.equal(result.reason,reason);assertReceipt(result);
  assert.equal(result.probe_diagnostics.provider,'claude');assert.equal(result.probe_diagnostics.generation,1);
 }
});

test('review: each wrapper attempt has distinct correlation and supplied meter identity',async()=>{
 const runner=fakeRunner(()=>({exitCode:0,stdout:wire()}));
 runner.probeIdentity={purpose:'meter',job_digest:'a'.repeat(64),attempt_id:'attempt_1',token:'private'};
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:runner});
 const a=await probe.probe('claude'),b=await probe.probe('claude');
 assert.notEqual(a.probe_diagnostics.probe_id,b.probe_diagnostics.probe_id);
 assert.equal(b.probe_diagnostics.generation,2);assert.equal(b.probe_diagnostics.purpose,'meter');
 assert.equal(b.probe_diagnostics.job_digest,'a'.repeat(64));assert.equal(b.probe_diagnostics.attempt_id,'attempt_1');
 assert.equal(b.probe_diagnostics.token,undefined);
});

test('review: pending outcome and latest attempt expose only the current running phase',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(async()=>{await waiting;return {exitCode:0,stdout:wire()};})});
 const pending=probe.probe('claude');await new Promise(resolve=>setImmediate(resolve));
 const attempt=probe.latestAttempt('claude'),outcome=probe.outcome('claude');
 assert.equal(attempt.outcome,'pending');assert.equal(outcome.outcome,'pending');
 assert.ok(sanitizeProbeDiagnostics(attempt.probe_diagnostics));
 assert.equal(attempt.probe_diagnostics.probe_id,outcome.probe_diagnostics.probe_id);
 assert.equal(attempt.probe_diagnostics.generation,attempt.generation);
 assert.equal(attempt.probe_diagnostics.phases.at(-1).phase,'first_command');assert.equal(attempt.probe_diagnostics.phases.at(-1).outcome,'running');
 assert.equal(attempt.failed_phase,undefined);assert.equal(probe.successfulResult('claude'),null);
 release();await pending;assert.equal(probe.outcome('claude').outcome,'good');
});

test('review: invalidation clears active diagnostics and old completion cannot restore evidence',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 const probe=createLendingProbe({ledger:ledger(),now,runGuest:fakeRunner(async()=>{await waiting;return {exitCode:0,stdout:wire()};})});
 const pending=probe.probe('claude');await new Promise(resolve=>setImmediate(resolve));
 const old=probe.latestAttempt('claude');probe.invalidateFacts('account changed');
 assert.equal(probe.latestAttempt('claude'),null);assert.equal(probe.outcome('claude'),null);assert.equal(probe.successfulResult('claude'),null);assert.equal(probe.lastResult('claude'),null);
 release();assert.equal((await pending).reason,'cancelled');
 assert.equal(probe.latestAttempt('claude'),null);assert.equal(probe.outcome('claude'),null);assert.equal(probe.successfulResult('claude'),null);assert.equal(probe.lastResult('claude'),null);
 const next=await probe.probe('claude');assert.equal(next.ok,true);assert.notEqual(next.probe_diagnostics.probe_id,old.probe_diagnostics.probe_id);
 assert.ok(next.probe_diagnostics.generation>old.generation);
});
