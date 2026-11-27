import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createProbeDiagnostics,probeDiagnosticFields,sanitizeProbeDiagnostics,probeReceiptDetails,renderProbeReceiptDetails} from '../lib/v1/probe-diagnostics.mjs';
const root=new URL('../',import.meta.url);
const baseRoot=process.env.PROBE_BASE_ROOT?pathToFileURL(resolve(process.env.PROBE_BASE_ROOT)+sep):null;
async function source(path,base=false){if(base&&!baseRoot)throw new Error('PROBE_BASE_ROOT is required for baseline comparison');return readFile(new URL(path,base?baseRoot:root),'utf8');}
async function loadCheckAgent(identityProbe){
 const text=await source('lib/v1/app.mjs');const begin=text.indexOf('  async function checkAgent('),end=text.indexOf('\n  // `background`',begin);
 assert.ok(begin>=0&&end>begin);const timers=[],identityCache=new Map(),identityProbes=new Map();
 const snapshot={installed:true,signedIn:true};identityCache.set('claude-code-subscription',snapshot);
 const deps={createProbeDiagnostics,probeDiagnosticFields,sanitizeProbeDiagnostics,closed:false,signin:null,
  options:{identityProbe},identityCache,identityProbes,checkSandboxes:{backend:{}},
  beginAutomaticCheck:()=>({}),finishAutomaticCheck:()=>{},recordDiagnostic:()=>{},probeReceipts:{record:()=>{}},
  automaticAgentChecks:new Map(),probeFaravanIdentity:()=>{throw new Error('unexpected real native call');},
  WORKSPACE_REMEDIES:{timeout:'try again',sandbox_start_failed:'try again'},noteDocker:()=>{},
  observeAgentEvidence:(s,v)=>({...s,...v}),now:()=>1000,admissionChanged:()=>{},safeLine:s=>s,
  setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimeout:t=>{if(t)t.cleared=true;}};
 const fn=new Function(...Object.keys(deps),text.slice(begin,end)+'\nreturn checkAgent;')(...Object.values(deps));
 return {run:()=>fn({spec:{harness_id:'claude-code-subscription'}},snapshot,90000),identityCache,identityProbes,timers};
}

test('review: actual checkAgent catch retains failed native phase without raw exception',async()=>{
 const h=await loadCheckAgent(async({probeContext})=>{probeContext.start('preflight');throw new Error('secret native path');});
 await h.run();const row=h.identityCache.get('claude-code-subscription');
 assert.equal(row.installed,null);assert.equal(row.signedIn,null);assert.equal(row.checkFailed,true);
 assert.ok(sanitizeProbeDiagnostics(row.probeDiagnostics));assert.equal(row.probeDiagnostics.failed_phase,'preflight');
 assert.ok(!JSON.stringify(row).includes('secret native path'));
});

test('review: actual checkAgent display timeout preserves timed_out and caller deadline',async()=>{
 let controllerSignal;
 const h=await loadCheckAgent(async({probeContext,signal})=>{controllerSignal=signal;probeContext.start('create_ready');return new Promise(()=>{});});
 const pending=h.run();await new Promise(r=>setImmediate(r));assert.equal(h.timers[0].ms,90000);h.timers[0].fn();await pending;
 const row=h.identityCache.get('claude-code-subscription');assert.equal(row.workspaceCause,'timeout');assert.equal(controllerSignal.aborted,true);
 assert.equal(row.probeDiagnostics.first_failure.outcome,'timed_out');assert.equal(row.probeDiagnostics.failed_phase,'create_ready');
 assert.equal(row.probeDiagnostics.phases[0].deadline_source,'caller');assert.equal(row.probeDiagnostics.phases[0].effective_deadline_elapsed_ms,90000);
});

test('review: owner-local sidecar route is after app authentication and not saved remotely',async()=>{
 const text=await source('lib/v1/app.mjs');const at=text.indexOf("if(parts[3]==='probe-receipts'");assert.ok(at>0);
 const auth=text.indexOf("if(!authorized)return send({code:'unauthorized'");assert.ok(auth>0&&auth<at);
 const saved=text.slice(text.indexOf('if(savedCircle&&'),text.indexOf('const display=',text.indexOf('if(savedCircle&&')));
 assert.ok(!saved.includes('probe-receipts'));
 const route=text.slice(at,text.indexOf("if(parts[3]==='receipt'",at));assert.match(route,/probeReceipts\.forJob\(input\.digest\)/);
 assert.ok(!route.includes('operations.fetchReceipt'));assert.ok(!route.includes('upload'));
});

test('review: close flushes sidecar after probes have drained',async()=>{
 const text=await source('lib/v1/app.mjs');const end=text.indexOf('await recordDiagnostic.flush()');
 const close=text.slice(text.lastIndexOf('async function closeApp(',end),text.indexOf('// Only the native managed supervisor',end));
 assert.match(close,/probeReceipts\.flush\(\)/);
 const probes=close.indexOf('Promise.allSettled([...identityProbes.keys()');
 assert.ok(probes>=0&&close.indexOf('probeReceipts.flush()')>probes);
});

test('review: signed public receipt excludes diagnostics and optionally matches baseline byte-for-byte',async()=>{
 const cut=text=>{const a=text.indexOf("      const publicReceipt={schema:'faravan.receipt.v1'");return text.slice(a,text.indexOf('\n    return payload;',a));};
 const after=cut(await source('lib/v1/lender.mjs'));assert.ok(after.length>2000);
 assert.ok(!after.includes('probe_diagnostics'));assert.ok(!after.includes('probeReceipts'));
 if(baseRoot)assert.equal(after,cut(await source('lib/v1/lender.mjs',true)));
});

test('review: actual private receipt permits only matching-job diagnostics and execution metadata excludes them',async()=>{
 const text=await source('lib/executor.mjs');const start=text.indexOf('export function executionMetadata('),end=text.indexOf('/**\n * Explicit observational refresh',start);
 const body=text.slice(start,end).replaceAll('export function','function');
 const deps={probeDiagnosticFields,resolveHarness:()=>({}),parseHarnessExecutionResult:()=>({model:'known',usage:{input_tokens:1}}),capacityKindForHarness:()=> 'subscription',parseProviderAccount:()=>null};
 const {buildTaskReceipt,executionMetadata}=new Function(...Object.keys(deps),body+'\nreturn {buildTaskReceipt,executionMetadata};')(...Object.values(deps));
 const digest='a'.repeat(64),d=createProbeDiagnostics({purpose:'meter',job_digest:digest,attempt_id:'attempt_1'});d.end(d.start('first_command'),'failed');
 const execution={stdout:'secret stdout',provider_status_stdout:'secret identity',duration_ms:12,probe_diagnostics:d.finish()};
 const match=buildTaskReceipt({taskDigest:digest,harnessId:'claude',execution}),other=buildTaskReceipt({taskDigest:'b'.repeat(64),harnessId:'claude',execution});
 assert.equal(match.failed_phase,'first_command');assert.equal(other.probe_diagnostics,undefined);
 assert.equal(executionMetadata(match).probe_diagnostics,undefined);assert.ok(!JSON.stringify(match.probe_diagnostics).includes('secret'));
 assert.match(probeReceiptDetails(match.probe_diagnostics).summary,/reading the account allowance/);
});

test('review: actual sidecar route serves bounded private text and unchanged JSON detail',async()=>{
 const text=await source('lib/v1/app.mjs'),a=text.indexOf("          if(parts[3]==='probe-receipts')"),b=text.indexOf("          if(parts[3]==='receipt')",a);
 assert.ok(a>0&&b>a);const body=text.slice(a,b);const digest='a'.repeat(64);
 const d=createProbeDiagnostics({job_digest:digest,attempt_id:'attempt_1'});d.end(d.start('identity',{budgetMs:30000,deadlineSource:'command'}),'timed_out');const receipt={...d.finish(),stderr:'secret raw'};
 const outputs=[];const deps={parts:['api','jobs',digest,'probe-receipts'],input:{digest},probeReceipts:{async forJob(x){assert.equal(x,digest);return [receipt];}},
 probeReceiptDetails,renderProbeReceiptDetails,res:{writeHead:(status,headers)=>outputs.push({status,headers}),end:body=>outputs.push({body})},send:body=>outputs.push({json:body})};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const invoke=url=>new AsyncFunction(...Object.keys(deps),'url',body)(...Object.values(deps),new URL(url));
 await invoke('http://localhost/api/jobs/'+digest+'/probe-receipts?format=text');
 assert.equal(outputs[0].headers['Content-Type'],'text/plain; charset=utf-8');assert.equal(outputs[0].headers['Cache-Control'],'no-store');
 assert.match(outputs[1].body,/separate from the signed saved result/);assert.match(outputs[1].body,/timed out while checking the account sign-in/);assert.ok(!outputs[1].body.includes('secret raw'));
 outputs.length=0;await invoke('http://localhost/api/jobs/'+digest+'/probe-receipts');
 assert.equal(outputs[0].json.schema,'faravan.local-probe-receipts.v1');assert.equal(outputs[0].json.details[0].receipt.stderr,undefined);
});

test('review: text renderer caps receipts and rejects malformed/raw content',()=>{
 const d=createProbeDiagnostics({attempt_id:'attempt_1'});d.end(d.start('preflight'),'failed');const receipt=d.finish();
 const text=renderProbeReceiptDetails(Array(80).fill({...receipt,raw:'secret material'}));
 assert.equal((text.match(/Saved job check result/g)||[]).length,64);assert.ok(!text.includes('secret material'));
 assert.equal(renderProbeReceiptDetails([{purpose:'secret',phases:[]}]),'No saved result from a local check is retained for this job.\n');
 assert.ok(Buffer.byteLength(text)<1000000);
});

test('owner check details use plain words while preserving the saved result fields',()=>{
 const banned=/\b(?:verdicts?|receipts?|attempt(?:s|ed|ing)?|settled|leases?)\b/i;
 for(const attempt_id of [undefined,'run_1']) {
  const d=createProbeDiagnostics({attempt_id});d.end(d.start('preflight'),'failed');const receipt=d.finish();
  const details=probeReceiptDetails(receipt);
  assert.equal(details.label,attempt_id?'Saved job check result':'Saved check result; job not started');
  assert.deepEqual(details.receipt,receipt);
  assert.doesNotMatch(details.label+' '+details.summary,banned);
  assert.doesNotMatch(renderProbeReceiptDetails([receipt]),banned);
 }
 assert.doesNotMatch(renderProbeReceiptDetails([]),banned);
});
