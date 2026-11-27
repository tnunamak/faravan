import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSbxBackend, parseObservedEgress } from '../lib/docker-backend.mjs';
import { createSbxPolicy } from './helpers/sbx-policy-model.mjs';

const sandbox = 'wf-synthetic-egress';
const row = host => ({sandbox_id:sandbox,host,proxy_type:'forward',count:1});
const fixture = {allowed:[row('API.EXAMPLE.TEST:443')],blocked:[row('blocked.example.test:80')]};
const response = value => ({code:0,stdout:JSON.stringify(value)});

test('observed sbx decisions include allowed and blocked hosts, filtered to this sandbox',()=>{
  assert.deepEqual(parseObservedEgress(response({...fixture,
    allowed:[...fixture.allowed,{...row('other.example.test'),sandbox_id:'other'}]}),sandbox),
    {'blocked.example.test':'denied','api.example.test':'allowed'});
});

test('observed decisions are bounded and never include credentials, URLs or malformed hosts',()=>{
  const invalid = ['https://example.test/token','user:secret@example.test','example.test/path',
    'example.test:0','example.test:65536','bad..test','-bad.test','constructor','__proto__','x'.repeat(254)];
  const value = {blocked:[row('same.test')],allowed:[
    ...invalid.map(row),row('same.test'),...Array.from({length:40},(_,i)=>row('host'+i+'.test'))]};
  const evidence = parseObservedEgress(response(value),sandbox);
  assert.equal(Object.keys(evidence).length,32);
  assert.equal(evidence['same.test'],'denied');
  assert.ok(invalid.every(host=>!Object.hasOwn(evidence,host)));
});

test('absent, empty, malformed and failed policy logs stay unknown',()=>{
  for(const log of [null,{code:1,stdout:'{}'},{code:0,stdout:'not JSON'},
    response({}),response({allowed:[],blocked:[]}),response({allowed:[row('bad/path')],blocked:[]})])
    assert.equal(parseObservedEgress(log,sandbox),null);
});

test('backend reads run observations before teardown and clears stale data on failure',async()=>{
  const calls=[];
  let log=response(fixture);
  const backend=new DockerSbxBackend({runCommand:async args=>{
    calls.push(args);
    return args[0]==='policy'?log:{code:0,stdout:'done',stderr:''};
  }});
  backend.assertActive=async()=>{};
  const handle={...testSbxRuntimeFields(),sandbox_id:sandbox,_entrypoint:'true',_execution:{egress_evidence:null}};
  await backend.start(handle);
  assert.deepEqual(calls,[['exec',sandbox,'--','sh','-c','true'],['policy','log',sandbox,'--json']]);
  assert.deepEqual(handle._execution.egress_evidence,{'blocked.example.test':'denied','api.example.test':'allowed'});
  log={code:1,stdout:''};
  await backend.start(handle);
  assert.equal(handle._execution.egress_evidence,null);
});

test('policy verification never becomes observed traffic',async()=>{
  const model=createSbxPolicy();
  model.createSandbox(sandbox,{kitAllow:[]});
  const backend=new DockerSbxBackend({runCommand:async args=>model.run(args)??{code:0,stdout:'',stderr:''}});
  const handle={...testSbxRuntimeFields(),sandbox_id:sandbox,_egress:'provider-only',_providerHosts:['api.example.test'],
    _execution:{egress_evidence:null}};
  await backend._configureEgress(handle);
  assert.equal(handle._execution.egress_evidence,null);
  assert.equal(handle._policyVerification['api.example.test'],'allowed');
  assert.equal(handle._policyVerification['10.0.0.1'],'denied');
});

test('pre-agent observations are subtracted before bounding the agent evidence',async()=>{
  const baseline={allowed:Array.from({length:40},(_,i)=>row('setup'+i+'.test')),blocked:[row('169.254.169.254'),row('10.0.0.1')]};
  const log=response({allowed:[...baseline.allowed,row('agent.example.test')],blocked:baseline.blocked});
  const backend=new DockerSbxBackend({runCommand:async args=>args[0]==='policy'?log:{code:0,stdout:'done',stderr:''}});
  backend.assertActive=async()=>{};
  const handle={...testSbxRuntimeFields(),sandbox_id:sandbox,_entrypoint:'true',_execution:{egress_evidence:null},_egressBaseline:await new DockerSbxBackend({runCommand:async()=>response(baseline)}).snapshotEgress({...testSbxRuntimeFields(),sandbox_id:sandbox})};
  await backend.start(handle);
  assert.deepEqual(handle._execution.egress_evidence,{'agent.example.test':'allowed'});
  handle._egressBaseline=null;
  await backend.start(handle);
  assert.equal(handle._execution.egress_evidence,null,'a failed snapshot cannot attribute cumulative traffic');
});

test('a repeated metadata or provider contact after the boundary remains agent evidence',async()=>{
 let log=response({allowed:[row('api.example.test')],blocked:[row('169.254.169.254')]});
 const backend=new DockerSbxBackend({runCommand:async args=>args[0]==='policy'?log:{code:0,stdout:'done',stderr:''}});
 backend.assertActive=async()=>{};
 const handle={...testSbxRuntimeFields(),sandbox_id:sandbox,_entrypoint:'true',_execution:{egress_evidence:null}};
 // Counts are the number of matching policy observations, not a host exclusion list.
 handle._egressBaseline=await backend.snapshotEgress(handle);
 log=response({allowed:[{...row('api.example.test'),count:2}],blocked:[{...row('169.254.169.254'),count:2}]});
 await backend.start(handle);
 assert.deepEqual(handle._execution.egress_evidence,{'169.254.169.254':'denied','api.example.test':'allowed'});
 // Removing count metadata makes occurrence attribution unavailable, even for a new host.
 log=response({allowed:[{sandbox_id:sandbox,host:'api.example.test'}],blocked:[]});
 await backend.start(handle);
 assert.equal(handle._execution.egress_evidence,null);
});

test('reset, ambiguous duplicate and replaced authority counters cannot assert attribution',async()=>{
 const before=response({allowed:[row('api.example.test:443')],blocked:[]});
 const backend=new DockerSbxBackend({runCommand:async()=>before});
 const boundary=await backend.snapshotEgress({...testSbxRuntimeFields(),sandbox_id:sandbox});
 for(const value of [
  {allowed:[{...row('api.example.test:443'),count:0}],blocked:[]},
  {allowed:[row('api.example.test:443'),row('api.example.test:443')],blocked:[]},
  {allowed:[row('api.example.test:80')],blocked:[]},
 ])assert.equal(parseObservedEgress(response(value),sandbox,{afterCounts:boundary}),null);
});
