import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {appFixture, api, syntheticBackend} from "./helpers/v1-app-fixture.mjs";

const claudeAdapters = () => [{spec:legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: ['claude-haiku-5-5'], capabilities: []}];
const askAutoAdapters = () => [...claudeAdapters(), {spec:legacyProxyHarness('codex'),installed:true,signedIn:true,
  harnessVersion:'synthetic-only',models:['gpt-6-luna'],capabilities:[]}];

test('explicit capacity refresh forwards its owned signal through the provider reader', {timeout: 180000}, async t => {
  const f=await appFixture(t);
  const backend=syntheticBackend(f.root),probeCapabilities=backend.probeCapabilities.bind(backend);
  let capabilitySignal=null,runnerSignal=null;
  backend.probeCapabilities=async options=>{
    if(options?.signal)capabilitySignal=options.signal;
    return {...await probeCapabilities(),backend_id:'synthetic-only',version:'synthetic-version'};
  };
  const body={five_hour:{utilization:5,resets_at:new Date(Date.now()+5*3600000).toISOString()},
    seven_day:{utilization:10,resets_at:new Date(Date.now()+7*86400000).toISOString()},extra_usage:{is_enabled:false}};
  const runner=async({provider,signal})=>{
    assert.equal(provider,'claude');runnerSignal=signal;
    return {exitCode:0,stdout:JSON.stringify({faravan_probe:1,status:200,body,
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'},
      guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}}),
      executor:{backend_id:'synthetic-only',sbx_version:'synthetic-version'},
      stop:{delivered:true,fallback:null,latency_ms:1,removed:true}};
  };
  const {lender,circle}=await f.connect({backend,adapters:claudeAdapters,lendingProbeRunner:runner});
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,idleOnly:false,
    lendingPolicy:{accountPlans:{claude:'max20'}}}});
  await api(lender.app,'/api/agents/claude-code-subscription',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['claude-code-subscription']}});
  assert.ok(runnerSignal instanceof AbortSignal,'the explicit probe receives its owned abort signal');
});

test('jobless readiness uses the same local probe reading as the weekly status without probing again', {timeout:180000}, async t => {
  const f=await appFixture(t);
  let calls=0;
  const runner=async ({provider})=>{
    assert.equal(provider,'codex'); calls++;
    return {exitCode:0,stdout:JSON.stringify({faravan_probe:1,status:200,
      body:{plan_type:'pro',spend_control:{reached:false},rate_limit:{allowed:true,limit_reached:false,secondary_window:null,
        primary_window:{used_percent:58,limit_window_seconds:604800,reset_after_seconds:259200}}},
      identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'}}),
      host_read:true};
  };
  let executorMatches=true;
  // Stop proof is the machine's receipt, never part of a reading.
  const stopEvidenceStore={receipt:async()=>({backend_id:'synthetic-only',sbx_version:'synthetic-version',measured_at:Date.now(),
    delivered:true,fallback:null,latency_ms:1,removed:true})};
  const {lender,circle}=await f.connect({adapters:askAutoAdapters,lendingProbeRunner:runner,stopEvidenceStore,
    lendingExpectedIdentity:()=>({account_sha256_16:'1111222233334444'}),
    lendingExpectedExecutor:()=>({backend_id:'synthetic-only',accepts:version=>executorMatches && version==='synthetic-version'})});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await api(lender.app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  const before=calls;
  const row=(await api(lender.app,'/api/lending/readiness')).agents.find(a=>a.id==='codex');
  assert.equal(calls,before,'readiness never starts a probe');
  assert.equal(row.hasReading,true);
  // Required setup facts stay separate from the allowance estimate; no per-job read is promised.
  assert.deepEqual(row.checks.map(check=>check.state),['pass','pass','pass','pass','pass']);
  assert.equal(row.checks[4].id,'usage_estimate');
  assert.match(row.checks[4].note,/Usage estimate:/);
  assert.doesNotMatch(row.checks[4].note,/checks each job against the live meter/);
  executorMatches=false;
  const mismatch=(await api(lender.app,'/api/lending/readiness')).agents.find(a=>a.id==='codex');
  assert.equal(mismatch.checks.find(check=>check.id==='job_control').state,'unknown');
  assert.equal(calls,before,'checking the executor does not run another provider probe');
});
