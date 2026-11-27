import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIsolation,isolationPolicy,isolationControl,isolationScript,checkJobIsolation,isolationGuest,ISOLATION_TARGETS,ISOLATION_CHECK_BUDGET_MS} from '../lib/v1/isolation-check.mjs';
import {isolationReport as reportOf, isolationPolicy as policyOf} from './helpers/isolation-check-fixture.mjs';
const checked=(report=reportOf(),options={})=>parseIsolation(JSON.stringify(report),{code:0,controlHost:'api.anthropic.com',before:{},after:checkedPolicy(reportOf()),...options});
test('isolation requires actual HTTP answers and fresh matching policy observations', () => {
  assert.equal(checked().ok, true);
  assert.equal(checked().denied.length, 6);
  for (const error of ['ECONNREFUSED', 'timeout', 'ENOTFOUND', 'ECONNRESET']) {
    const report = reportOf();
    Object.assign(report.targets[0], { observation: 'error', status: null, tlsAuthorized: false, error });
    assert.equal(checked(report).ok, null, error);
    assert.ok(checked(report).inconclusive.includes(report.targets[0].host));
  }
  for (const status of [502, 503, 504]) {
    const report = reportOf(); report.targets[0].status = status;
    assert.equal(checked(report).ok, null);
  }
  const report = reportOf(), host = report.targets[0].host;
  let after = { ...checkedPolicy(report), [host]: 'allowed' };
  assert.equal(checked(report, { after }).ok, null, '403 without blocked evidence is not proof');
  report.targets[0].status = 200;
  assert.equal(checked(report, { after }).ok, false);
  assert.deepEqual(checked(report, { after }).reached, [host]);
  assert.equal(checked(report, { before: { [host]: 'denied' } }).ok, null, 'stale denial');
  assert.equal(checked(report, { after: null }).ok, null);
  assert.equal(checked(report, { before: null }).ok, null);
});
function checkedPolicy(report) {
  return isolationPolicy({ code: 0, stdout: JSON.stringify(policyOf(report)) }, 'sb-1');
}

test('positive control must respond with valid TLS, correct host and allowed evidence', () => {
  for (const mutate of [
    r => { r.control = null; }, r => { r.control.host = 'wrong.example'; },
    r => { r.control.tlsAuthorized = false; },
    r => { r.control.port = 80; },
    r => { r.control.status = 502; },
    ...['timeout', 'ECONNREFUSED'].map(error => r => Object.assign(r.control, { observation: 'error', status: null, tlsAuthorized: false, error })),
  ]) {
    const r = reportOf(); mutate(r);
    assert.equal(checked(r, { after: checkedPolicy(reportOf()) }).ok, null);
  }
  assert.equal(checked(reportOf(), { after: { ...checkedPolicy(reportOf()), 'api.anthropic.com': 'denied' } }).ok, null);
  assert.equal(checked(reportOf(), { before: { 'api.anthropic.com': 'allowed' } }).ok, true,
    'setup may already contact the provider; this probe still requires a new verified TLS response');
  assert.equal(isolationControl({ spec: { provider_domains: ['*.example.com', 'api.openai.com'] } }), 'api.openai.com');
  assert.equal(isolationScript('*.example.com'), null);
});

test('strict reports reject missing, duplicate, extra, malformed and untrusted fields', () => {
  for (const mutate of [
    r => r.targets.pop(), r => r.targets.push(r.targets[0]),
    r => { r.targets[0].host = '127.0.0.1'; },
    r => { r.targets[0].port = 81; },
    r => { r.targets[0].status = '403'; },
    r => { r.targets[0].observation = 'denied'; },
    r => { r.targets[0].verdict = 'pass'; },
    r => { r.completed = false; }, r => { r.schema = 0; },
    r => { r.gateway = 'not-ip'; }, r => { r.control.error = 'unexpected'; },
  ]) {
    const r = reportOf(); mutate(r);
    assert.equal(checked(r, { after: checkedPolicy(reportOf()) }).ok, null);
  }
  assert.equal(checked(reportOf(), { code: 1 }).ok, null, 'missing Node or nonzero exit cannot pass');
  assert.equal(parseIsolation('{"schema":1').ok, null);
  assert.equal(checked(reportOf('api.anthropic.com', null)).ok, null, 'gateway required');
  assert.equal(checked(reportOf('api.anthropic.com', '10.0.0.1')).ok, true, 'deduplicated gateway');
});

test('policy snapshots distinguish valid empty, unknown and foreign-sandbox evidence', () => {
  assert.deepEqual({ ...isolationPolicy({ code: 0, stdout: '{"allowed":[],"blocked":[]}' }, 'sb-1') }, {});
  for (const result of [{ code: 1, stdout: '{}' }, { code: 0, stdout: '{}' }, { code: 0, stdout: '{' },
    { code: 0, stdout: '{"allowed":[],"blocked":[{"host":"10.0.0.1"}]}' }]) {
    assert.equal(isolationPolicy(result, 'sb-1'), null);
  }
  const foreign = isolationPolicy({ code: 0, stdout: JSON.stringify(policyOf(reportOf(), 'sb-2')) }, 'sb-1');
  assert.equal(checked(reportOf(), { after: foreign }).ok, null);
  const both = policyOf(reportOf()); both.blocked.push({ sandbox_id: 'sb-1', host: 'api.anthropic.com' });
  assert.equal(checked(reportOf(), { after: isolationPolicy({ code: 0, stdout: JSON.stringify(both) }, 'sb-1') }).ok, null);
});


import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {passingReport} from './helpers/credential-probe-fixture.mjs';
import {MARKER} from '../lib/v1/credential-probe.mjs';
import {sbxVersionCheck} from '../lib/docker-backend.mjs';
import {isPassingDecline} from '../lib/v1/failures.mjs';

for(const mode of ['pass','reachable','lan-reachable','timeout','missing','control','credentials','credential-leak'])test('per-job check: '+mode,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-isolation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'real-agent'};
 const report=reportOf();let calls=0,logs=0;
 if(mode==='reachable')report.targets[0].status=200;
 if(mode==='lan-reachable')report.targets[1].status=200;
 if(mode==='control')report.control.tlsAuthorized=false;
 const backend={
  ensureGuestRuntime: async () => ({node:"/runtime/node"}),
  async runSbx(){logs++;const policy=policyOf(report);if(mode==='reachable'){policy.allowed.push(policy.blocked.shift());}if(mode==='lan-reachable'){policy.allowed.push(policy.blocked.splice(1,1)[0]);}return {code:0,stdout:JSON.stringify(logs===1?{allowed:[],blocked:[]}:policy)};},
  async start(h,{signal}){assert.match(h._entrypoint,/hashlib.sha256/);assert.match(h._entrypoint,/exit 125; }; '\/runtime\/node' /);calls++;if(mode==='timeout')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));h._lastExecStdout=calls===1?JSON.stringify(report):mode==='missing'?'':MARKER+JSON.stringify(mode==='credential-leak'?passingReport({verdict:'fail',checks:passingReport().checks.map((c,i)=>i===0?{...c,found:true,severity:'critical'}:c)}):mode==='credentials'?passingReport({verdict:'inconclusive',self_test:{canary_detected:false,sentinel_ignored:true}}):passingReport());}
 };
 const out=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}},timeoutMs:mode==='timeout'?5:1000});
 assert.equal(out.state,mode==='pass'?'pass':['reachable','lan-reachable','credential-leak'].includes(mode)?'failed':'inconclusive');
 if(mode==='reachable')assert.match(out.blocker,/cloud metadata/);
 if(mode==='lan-reachable')assert.match(out.blocker,/your home network/);
 assert.equal(handle._entrypoint,'real-agent');
 if(out.code)assert.equal(isPassingDecline(out.code),out.state==='inconclusive');
 assert.equal(calls,['pass','missing','credentials','credential-leak'].includes(mode)?2:1);
});
test('Docker Sandboxes minimum is 0.51.0, unknown versions block',()=>{
 for(const version of ['0.42.0','0.48.9','0.49.0','0.49.1','0.50.1','unknown'])assert.equal(sbxVersionCheck({code:0,stdout:'sbx version '+version}).ok,false,version);
 for(const version of ['0.51.0','0.52.3','1.0.0'])assert.equal(sbxVersionCheck({code:0,stdout:'sbx version '+version}).ok,true,version);
});

import {lendingBlockers} from '../lib/v1/blockers.mjs';
import {dockerFacts} from '../lib/v1/docker-state.mjs';
test('an installed runtime below the floor asks for an update',()=>{
 const version=sbxVersionCheck({code:0,stdout:'sbx version 0.49.0'});
 const checks=[{name:'sbx_install',ok:true},{name:'sbx_cli_contract',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true},version];
 const docker=dockerFacts(checks);
 assert.equal(docker.installed,true);
 const model=lendingBlockers({docker,intent:{on:true},readinessRequirements:[{cause:version.name,label:version.detail,remedy:version.fix}],agents:[]});
 assert.equal(model.first.label,'Update Docker Sandboxes');
 assert.match(model.first.detail,/0\.51\.0/);assert.equal(model.first.action,'Check again');assert.equal(model.canLend,false);
});

import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('guest program uses the configured HTTP agent for real loopback HEAD responses', async t => {
  const seen = [];
  let hold=false;
  const server = createServer((req, res) => { seen.push(req.method); if(!hold){res.writeHead(403);res.end();} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  // Transport destinations and route input are injected; sockets and HEAD are real.
  // HTTPS deliberately uses plain HTTP here, so TLS authorization must be false.
  const program = [
    "const vm = require('node:vm'), http = require('node:http'), net = require('node:net');",
    "const agent = new http.Agent(); agent.createConnection = (options, callback) => net.createConnection({ host: '127.0.0.1', port: " + port + " }, callback); http.globalAgent = agent;",
    "const transport = { request(options, callback) { return http.request({ ...options, hostname: '127.0.0.2', port: " + port + " }, callback); } };",
    "const localRequire = name => name === 'node:fs' ? { readFileSync: () => 'Iface Destination Gateway Flags\\neth0 00000000 010011AC 0003\\n' } : transport;",
    "vm.runInNewContext('(' + " + JSON.stringify(isolationGuest.toString()) + " + ')', { require: localRequire, process, setTimeout, clearTimeout })('api.anthropic.com', " + JSON.stringify(ISOLATION_TARGETS) + ").catch(() => { process.exitCode = 1; });",
  ].join('\n');
  let began=performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', program], { timeout: 10000 });
  t.diagnostic('network guest, loopback responses: '+(performance.now()-began).toFixed(1)+' ms');
  const report = JSON.parse(stdout);
  assert.equal(report.completed, true);
  assert.equal(report.gateway, '172.17.0.1');
  assert.equal(report.targets.length, 6);
  assert.ok(report.targets.every(row => row.observation === 'response' && row.status === 403));
  assert.equal(report.control.tlsAuthorized, false, 'plain HTTP cannot masquerade as valid TLS');
  assert.equal(checked(report).ok, null);
  assert.deepEqual(seen, Array(7).fill('HEAD'));
  const script = isolationScript('api.anthropic.com', '/runtime/node');
  assert.ok(script.startsWith("'/runtime/node' -e "));
  assert.ok(!script.includes('/dev/tcp'));
  hold=true;began=performance.now();
  const stalled=await promisify(execFile)(process.execPath,['-e',program],{timeout:10000});
  t.diagnostic('network guest, stalled loopback requests: '+(performance.now()-began).toFixed(1)+' ms');
  const timeoutReport=JSON.parse(stalled.stdout);
  assert.ok(timeoutReport.targets.every(row=>row.error==='timeout'));
  assert.equal(checked(timeoutReport).ok,null);
});

test('job check passes its exact workspace to the guest and snapshots after both probes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-scope-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent',_execution:{egress_evidence:{'10.0.0.1':'denied'}}};
 const events=[],report=reportOf();let probes=0,logs=0;
 const backend={
  ensureGuestRuntime: async () => ({node:"/runtime/node"}),async snapshotEgress(){events.push('boundary');return new Map([['denied\0'+'169.254.169.254',1],['allowed\0api.anthropic.com',1]]);},async runSbx(){events.push('policy');return {code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))};},
  async start(h){events.push(++probes===1?'network':'credentials');if(probes===2)assert.ok(h._entrypoint.endsWith("--exclude-workspace '"+dir+"'"));h._lastExecStdout=probes===1?JSON.stringify(report):MARKER+JSON.stringify(passingReport());}};
 const result=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}}});
 assert.equal(result.state,'pass');
 assert.deepEqual(events,['policy','network','policy','credentials','boundary']);
 assert.ok(handle._egressBaseline.has('denied\0'+'169.254.169.254'));
 assert.ok(handle._egressBaseline.has('allowed\0api.anthropic.com'));
 assert.equal(handle._execution.egress_evidence,null,'probe evidence cannot survive a later agent launch failure');
});

test('a mounted runtime is named to the credential probe; a copied runtime is not',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-runtime-mount-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [runtime,named] of [[{method:'mount',dir:'/rt/abc',node:'/rt/abc/node'},true],[{method:'copy',node:'/tmp/faravan-runtime-abc/node'},false]]) {
  const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};
  const report=reportOf();let probes=0,logs=0,command=null;
  const backend={
   ensureGuestRuntime: async () => runtime,async runSbx(){return {code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))};},
   async start(h){if(++probes===2)command=h._entrypoint;h._lastExecStdout=probes===1?JSON.stringify(report):MARKER+JSON.stringify(passingReport());}};
  const result=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'anthropic'}}});
  assert.equal(result.state,'pass');
  assert.equal(command.includes(" --allow-ro-mount '/rt/abc' "),named);
  assert.ok(command.endsWith("--exclude-workspace '"+dir+"'"));
 }
});

test('a private guest receives the staged probe before the credential command',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-private-probe-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_mountless:true,_entrypoint:'agent'};
 const report=reportOf();let copied=false,present=false,probes=0,logs=0;
 const backend={
  ensureGuestRuntime: async () => ({node:"/runtime/node"}),async runSbx(args){if(args[0]==='cp'){assert.equal(args[2],'sb-1:'+args[1]);copied=true;present=true;return {code:0};}if(args[0]==='exec'){assert.deepEqual(args.slice(2,6),['--','rm','-f','--']);present=false;return {code:0};}return {code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))};},
  async start(h){probes++;h._lastExecStdout=probes===1?JSON.stringify(report):present?MARKER+JSON.stringify(passingReport()):'';}};
 const result=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}}});
 assert.equal(result.state,'pass');assert.equal(copied,true);assert.equal(present,false);
});

test('credential dispatch receives only the remaining monotonic parent budget',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-budget-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};let now=0,calls=0,logs=0,budget;
 const report=reportOf();
 const backend={
  ensureGuestRuntime: async () => ({node:"/runtime/node"}),async runSbx(){return {code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))};},async start(h){
  if(++calls===1){now=700;h._lastExecStdout=JSON.stringify(report);}else{budget=Number(/--budget-ms (\d+)/.exec(h._entrypoint)?.[1]);h._lastExecStdout=MARKER+JSON.stringify(passingReport());}
 }};
 assert.equal((await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}},timeoutMs:1000,monotonic:()=>now})).state,'pass');
 assert.ok(budget>0&&budget<=300,String(budget));
});

test('a busy host where each sandbox command pays a cold boot still passes within the default budget',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-cold-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};
 let now=0,probes=0,logs=0;const report=reportOf();
 const backend={
  async ensureGuestRuntime(){now+=5000;return {node:'/runtime/node'};},
  async runSbx(){now+=500;return {code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))};},
  async start(h){now+=7800;probes++;h._lastExecStdout=probes===1?JSON.stringify(report):MARKER+JSON.stringify(passingReport());}};
 const result=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}},monotonic:()=>now});
 assert.equal(result.state,'pass');
 assert.equal(now,21600,'longer than the old 20 s budget, shorter than the measured one');
});

test('the default budget exceeds the slowest measured check, and a backend that never answers ends within it',async t=>{
 assert.equal(ISOLATION_CHECK_BUDGET_MS,35000);
 assert.ok(ISOLATION_CHECK_BUDGET_MS>30600,'above the observed maximum');
 t.mock.timers.enable({apis:['setTimeout']});
 const dir=await mkdtemp(join(tmpdir(),'job-silent-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};
 let now=0;
 const backend={ensureGuestRuntime:async()=>({node:'/runtime/node'}),runSbx:async()=>({code:0,stdout:'{"allowed":[],"blocked":[]}'}),
  start:(h,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))};
 const pending=checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}},monotonic:()=>now});
 let settled=false;pending.then(()=>{settled=true;});
 for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 now=ISOLATION_CHECK_BUDGET_MS-1;t.mock.timers.tick(ISOLATION_CHECK_BUDGET_MS-1);
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false,'still waiting just inside the budget');
 now=ISOLATION_CHECK_BUDGET_MS;t.mock.timers.tick(1);
 const out=await pending;
 assert.equal(out.state,'inconclusive');assert.equal(out.code,'isolation_check_inconclusive');
 assert.deepEqual(out.details,{step:'network_probe',elapsedMs:ISOLATION_CHECK_BUDGET_MS,budgetMs:ISOLATION_CHECK_BUDGET_MS});
});

test('a deadline reports the step it reached and the elapsed time, and a found credential still refuses',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-diag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};
 let now=0,probes=0,logs=0;const report=reportOf();
 const backend={ensureGuestRuntime:async()=>({node:'/runtime/node'}),
  runSbx:async()=>({code:0,stdout:JSON.stringify(++logs===1?{allowed:[],blocked:[]}:policyOf(report))}),
  async start(h){probes++;now+=probes===1?1000:ISOLATION_CHECK_BUDGET_MS;h._lastExecStdout=probes===1?JSON.stringify(report):MARKER+JSON.stringify(passingReport());}};
 const out=await checkJobIsolation({backend,handle,adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}},monotonic:()=>now});
 assert.equal(out.state,'inconclusive');
 assert.deepEqual(out.details,{step:'credential_probe',elapsedMs:1000+ISOLATION_CHECK_BUDGET_MS,budgetMs:ISOLATION_CHECK_BUDGET_MS});
 assert.deepEqual(Object.keys(out.details).sort(),['budgetMs','elapsedMs','step']);
 // The refusal paths are unchanged by a larger budget.
 const leak=passingReport({verdict:'fail',checks:passingReport().checks.map((c,i)=>i===0?{...c,found:true,severity:'critical'}:c)});
 let n=0,policies=0;
 const refusing={ensureGuestRuntime:backend.ensureGuestRuntime,runSbx:async()=>({code:0,stdout:JSON.stringify(++policies===1?{allowed:[],blocked:[]}:policyOf(report))}),
  async start(h){n++;h._lastExecStdout=n===1?JSON.stringify(report):MARKER+JSON.stringify(leak);}};
 assert.equal((await checkJobIsolation({backend:refusing,handle:{...handle},adapter:{spec:{provider_domains:['api.anthropic.com'],provider_service_id:'openai'}}})).state,'failed');
});

import {safetyFacts,overviewFacts} from '../ui/v1/src/safety-copy.mjs';
test('the owner known-secret note states its limit without banned product words',()=>{
 const notes=[safetyFacts({adapter:{credentialInGuest:false,credentialProxyVerified:true}}),overviewFacts({anyCredentialUnverified:false})].map(view=>view.facts.find(f=>f.icon==='key').text);
 for(const note of notes){assert.match(note,/not compare your own tokens/);assert.doesNotMatch(note,/\b(?:verdict|receipt|attempt|settled|lease|ran on)\b/i);}
});

test('runtime installation failure is visible to the owner before isolation commands run',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'job-runtime-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const handle={sandbox_id:'sb-1',scratch_dir:dir,_entrypoint:'agent'};
 const result=await checkJobIsolation({backend:{ensureGuestRuntime:async()=>{throw Object.assign(new Error('unavailable'),{code:'guard_runtime_unavailable'});},start:()=>assert.fail('no guest command may run')},handle,adapter:{spec:{provider_domains:['api.anthropic.com']}}});
 assert.equal(result.state,'failed');assert.equal(result.code,'guard_runtime_unavailable');assert.match(result.blocker,/Update Faravan/);
 assert.equal(handle._entrypoint,'agent');
});
