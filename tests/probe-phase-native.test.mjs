import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const repoRoot=new URL('../',import.meta.url);
const baseRoot=process.env.PROBE_BASE_ROOT?pathToFileURL(resolve(process.env.PROBE_BASE_ROOT)+sep):null;
import {createProbeDiagnostics,probeDiagnosticFields,sanitizeProbeDiagnostics} from '../lib/v1/probe-diagnostics.mjs';
// Executes only the two actual native function bodies; it never imports executor dependencies.
async function loadNative({base=false,backend,workspace={ok:true},timers=[]}={}){
 if(base&&!baseRoot)throw new Error('PROBE_BASE_ROOT is required for baseline comparison');
 const file=new URL('lib/executor.mjs',base?baseRoot:repoRoot);
 const source=await readFile(file,'utf8');const begin=source.indexOf('export async function probeFaravanIdentity(');
 const end=source.indexOf('// --- ValidatedJobSpec construction',begin);assert.ok(begin>=0&&end>begin);
 const body=source.slice(begin,end).replace('export async function','async function');
 const harness=name=>({harness_id:name,provider_service_id:name,auth_strategy:'docker-native-oauth'});
 const deps={createProbeDiagnostics,probeDiagnosticFields,sanitizeProbeDiagnostics,
  DockerSbxBackend:class{},DEFAULT_IDENTITY_PROBE_HARNESSES:['claude'],DEFAULT_RESOURCES:{wall_seconds:1800},
  resolveHarness:harness,identityProbeCommand:()=> 'status only',capacityKindForHarness:()=> 'subscription',
  testWorkspace:async()=>{if(workspace instanceof Error)throw workspace;return workspace;},
  buildValidatedJobSpec:x=>x,parseIdentityEvidence:(_name,stdout)=>stdout==='ok'?{installed:true,signedIn:true,account:null}:{installed:null,signedIn:null,account:null},
  workspaceFailure:e=>({cause:e?.code==='wall_timeout'?'timeout':'sandbox_start_failed'}),
  setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimeout:t=>{if(t)t.cleared=true;}};
 const fn=new Function(...Object.keys(deps),body+'\nreturn probeFaravanIdentity;')(...Object.values(deps));
 return options=>fn({harnessNames:['claude'],backendFactory:()=>backend,readDockerAccount:async()=>null,...options});
}
function backend(){return {calls:[],async lenderCapabilities(){this.calls.push('capabilities');return {available:true,guest_block_device_capacity:true};},
 async prepare(spec,options){this.calls.push(['prepare',spec,options]);return {_lastExecStdout:'ok'};},
 async start(_handle,options){this.calls.push(['start',options]);},async destroy(){this.calls.push('destroy');return {removed:true};}};}
function withoutDiagnostics(value){if(Array.isArray(value))return value.map(withoutDiagnostics);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['probe_diagnostics','failed_phase'].includes(k)).map(([k,v])=>[k,withoutDiagnostics(v)]));return value;}

test('review: actual native success preserves current invariants and optional baseline parity',async()=>{
 const a=backend(),b=backend(),at=[],bt=[];
 const baseline=baseRoot?await (await loadNative({base:true,backend:a,timers:at}))():null;
 const current=await (await loadNative({backend:b,timers:bt}))();
 assert.deepEqual(withoutDiagnostics(current),baseline??{docker_account:null,providers:[{harness_id:'claude',service:'claude',capacity_kind:'subscription',installed:true,signedIn:true,authed:true}]});
 assert.deepEqual(b.calls.map(c=>Array.isArray(c)?c[0]:c),baseline?a.calls.map(c=>Array.isArray(c)?c[0]:c):['capabilities','capabilities','prepare','start','destroy']);
 if(baseline)assert.deepEqual(at.map(t=>t.ms),[30000]);assert.deepEqual(bt.map(t=>t.ms),[30000]);assert.ok(bt.every(t=>t.cleared));
 assert.equal(b.calls.find(c=>c[0]==='prepare')[1].resources.wall_seconds,180);
 assert.equal(current.providers[0].failed_phase,undefined);assert.ok(sanitizeProbeDiagnostics(current.probe_diagnostics));
});

test('review: actual native cleanup failure does not replace first identity failure',async()=>{
 const b=backend();b.start=async()=>{throw Object.assign(new Error('secret status output'),{code:'wall_timeout'});};b.destroy=async()=>({removed:false});
 const result=await (await loadNative({backend:b}))();
 const row=result.providers[0];assert.equal(row.failed_phase,'identity');assert.equal(row.probe_diagnostics.first_failure.outcome,'timed_out');
 assert.equal(row.probe_diagnostics.phases.find(p=>p.phase==='teardown').outcome,'failed');
 assert.ok(!JSON.stringify(result).includes('secret status output'));
});

test('review: cancellation as prepare completes is represented as cancellation, not a success receipt',async()=>{
 const controller=new AbortController(),b=backend();b.prepare=async()=>{controller.abort(new DOMException('User cancelled','AbortError'));return {_lastExecStdout:'ok'};};
 const result=await (await loadNative({backend:b}))({signal:controller.signal});
 const row=result.providers[0];assert.equal(row.signedIn,null);
 assert.ok(row.probe_diagnostics.first_failure,'cancelled operation needs a failed phase');
 assert.equal(row.probe_diagnostics.first_failure.outcome,'cancelled');
});

test('review: a later provider observes caller cancellation as cancelled rather than timed out',async()=>{
 const controller=new AbortController(),b=backend();let destroys=0;
 b.destroy=async()=>{if(++destroys===1)controller.abort(new DOMException('User cancelled','AbortError'));return {removed:true};};
 const result=await (await loadNative({backend:b}))({signal:controller.signal,harnessNames:['claude','codex']});
 assert.equal(result.providers[1].probe_diagnostics.first_failure.outcome,'cancelled');
});

test('review: thrown native preflight exposes sanitized diagnostics on the error',async()=>{
 const b=backend();b.lenderCapabilities=async()=>({available:true,guest_block_device_capacity:false});b.storage={supported:async()=>{throw new Error('secret host path');}};
 const run=await loadNative({backend:b});
 await assert.rejects(run(),e=>{assert.ok(sanitizeProbeDiagnostics(e.probe_diagnostics));assert.equal(e.failed_phase,'preflight');return true;});
});

test('review: per-provider failure does not contaminate next provider',async()=>{
 const b=backend();let starts=0;b.start=async handle=>{handle._lastExecStdout=++starts===1?'unknown':'ok';};
 const result=await (await loadNative({backend:b}))({harnessNames:['claude','codex']});
 assert.equal(result.providers[0].failed_phase,'identity');assert.equal(result.providers[1].failed_phase,undefined);
 assert.equal(result.providers[1].signedIn,true);
});

test('review: actual native watchdog remains 30 seconds and records timed_out',async()=>{
 const b=backend(),timers=[];b.start=()=>new Promise(()=>{});
 const run=await loadNative({backend:b,timers});const pending=run();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(timers.length,1);assert.equal(timers[0].ms,30000);timers[0].fn();const result=await pending;
 assert.equal(result.providers[0].probe_diagnostics.first_failure.outcome,'timed_out');
 assert.equal(result.providers[0].failed_phase,'identity');assert.ok(timers[0].cleared);
});

test('review: actual native callback failures stay advisory',async()=>{
 const b=backend(),run=await loadNative({backend:b});
 const result=await run({onProbeEvent(){throw new Error('observer broke');},onProbeReceipt(){return Promise.reject(new Error('writer broke'));}});
 assert.equal(result.providers[0].signedIn,true);assert.equal(result.providers[0].failed_phase,undefined);
 await new Promise(resolve=>setImmediate(resolve));
});
