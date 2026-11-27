import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {lendingStatusLines} from '../lib/v1/status.mjs';

test('agent refresh, readiness and status expose only the safe latest probe outcome', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  const {app} = await f.start('owner', {backend,
    adapters:()=>[{spec:legacyProxyHarness('codex'),installed:true,signedIn:true,models:['gpt-6-sol'],capabilities:[]}],
    identityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]}),
    lendingProbeRunner:async()=>({probe_failure:'guest_failed',stdout:'private guest output',stderr:'private guest error'})});
  await api(app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  const rows = await api(app, '/api/agents/refresh', {method:'POST',body:{agents:['codex']}});
  const capacity = rows.find(row=>row.id==='codex').capacity;
  assert.equal(capacity.reason, 'refresh_failed');
  assert.equal(capacity.probe.reason, 'guest_failed');
  assert.deepEqual(capacity.probe_outcome, {outcome:'failed',reason:'guest_failed',at:capacity.probe_outcome.at});
  assert.equal(typeof capacity.probe_outcome.at, 'number');
  const readiness = await api(app, '/api/lending/readiness');
  assert.deepEqual(readiness.agents[0].probe_outcome, capacity.probe_outcome);
  assert.ok(!readiness.agents[0].checks.some(row=>row.id==='job_control'));
  assert.match(readiness.agents[0].checks.find(row=>row.id==='usage_estimate').note, /starting estimate/);
  const lending = await api(app, '/api/lending');
  const account = lending.objective.accounts.find(row=>row.provider==='codex');
  assert.deepEqual(account.probe_outcome, capacity.probe_outcome);
  assert.match(lendingStatusLines(lending).join('\n'), /allowance check could not run/);
  const status = await api(app, '/api/status');
  assert.deepEqual(status.lendingPolicy.accounts.find(row=>row.provider==='codex').probe_outcome, capacity.probe_outcome);
  assert.doesNotMatch(JSON.stringify({rows,readiness,lending,status}), /private guest/);
});

test('readiness observes an executor version change and discards older account facts', {timeout:60000}, async t => {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  let version = 'A';
  const summary = backend.protectionSummary.bind(backend);
  backend.protectionSummary = async (...args) => {
    const report = await summary(...args);
    return {...report, preflight:{...report.preflight,version}};
  };
  const {app} = await f.start('owner', {backend,
    adapters:()=>[{spec:legacyProxyHarness('codex'),installed:true,signedIn:true,models:['gpt-6-sol'],capabilities:[]}],
    identityProbe:async()=>({providers:[{harness_id:'codex',installed:true,signedIn:true}]}),
    lendingExpectedIdentity:()=>({email_sha256_16:'aaaabbbbccccdddd'}),
    lendingExpectedExecutor:()=>({backend_id:'test',accepts:v=>v===version}),
    lendingProbeRunner:async()=>({executor:{backend_id:'test',sbx_version:version},
      stdout:JSON.stringify({faravan_probe:1,status:200,body:{plan_type:'pro',
        rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:14,limit_window_seconds:604800,reset_at:Math.floor(Date.now()/1000)+86400}}},
        identity:{status:200,account_sha256_16:'1111222233334444',email_sha256_16:'aaaabbbbccccdddd'}})})});
  await api(app, '/api/agents/codex', {method:'POST',body:{useForLending:true}});
  await api(app, '/api/agents/refresh', {method:'POST',body:{agents:['codex']}});
  const before = await api(app, '/api/lending/readiness');
  assert.ok(!before.agents[0].checks.some(row=>row.id==='account'));
  version = 'B';
  await api(app, '/api/readiness?refresh=true');
  const after = await api(app, '/api/lending/readiness');
  assert.ok(!after.agents[0].checks.some(row=>row.id==='account'));
  assert.match(after.agents[0].checks.find(row=>row.id==='usage_estimate').note,/starting estimate/);
});
