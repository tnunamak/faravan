import './helpers/no-browser.mjs';
// A person who is signed in but still cannot lend must learn, from status.blockers (the one answer the CLI, MCP and
// HTTP give), which agent account needs attention, why, and the one operation that fixes it. The app's Lend page
// already shows the same hold; these tests keep the agent surfaces from saying "Lending is on" while it does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { opById } from '../lib/v1/ops/registry.mjs';
import { lendingStatus } from '../lib/v1/lending-status-copy.mjs';
import { effectiveState } from '../lib/v1/lending-state.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { createSyntheticPace50Source } from './helpers/pace50-synthetic-source.mjs';

const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));

// A held account as the app reports it in status.get lendingPolicy.accounts.
const held = (provider, reason) => {
  const status = lendingStatus({reason});
  return {id:provider, provider, decision:{admitted:false, reason, status, availability:{admitted:false, reason, status}}};
};
const admitted = provider => ({id:provider, provider, decision:{admitted:true, reason:null, status:{id:'ready', line:'Ready.'}}});
const codex = {id:'codex', name:'codex', installed:true, signedIn:true, useForLending:true, signInSupported:true};
const claude = {id:'claude-code-subscription', name:'claude-code-subscription', installed:true, signedIn:true, useForLending:true, signInSupported:true};
// A real lent agent signs in to lending through its own target; the plain target signs in the owner's CLI instead.
const lendingSpec = agent => ({...agent, lendingSignInTarget:agent.id + '-lending', lendingSignInSupported:true});

async function blockers({accounts = [], agents = [codex], status = {}} = {}) {
  const answers = {
    'status.get':{state:'ready', reason:null, headline:'Lending is on', blockers:[], needs_you:[], intent:{on:true, state:'ready'},
      execution:{state:'idle'}, lendingPolicy:{accounts}, ...status},
    'readiness.get':{ready:true, observed_at:'2026-11-05T12:00:00.000Z', checks:[]},
    'agents.list':agents,
  };
  return opById('status.blockers').handler({call:async id => structuredClone(answers[id])});
}

test('a signed-in agent held on a different account blocks lending and names the agent, the cause and the sign-in', async () => {
  const out = await blockers({accounts:[held('codex', 'identity_mismatch')]});
  assert.equal(out.can_lend, false, 'the only lent account cannot take a job');
  assert.equal(out.headline, 'Check lending accounts');
  const item = out.blockers.find(b => b.kind === 'account_held');
  assert.ok(item, JSON.stringify(out.blockers));
  assert.equal(item.agent, 'codex');
  assert.equal(item.reason, 'identity_mismatch');
  assert.match(item.message, /Codex/);
  assert.match(item.message, /different account/);
  assert.deepEqual(item.fix, {op:'signin.start', input:{target:'codex'}});
  assert.ok(out.next_steps.some(step => /signin\.start/.test(step) && /codex/.test(step)), JSON.stringify(out.next_steps));
});

test('the sign-in that fixes a held or signed-out lent agent is its lending sign-in, which keeps it lent', async () => {
  const mismatch = await blockers({accounts:[held('codex', 'identity_mismatch')], agents:[lendingSpec(codex)]});
  assert.deepEqual(mismatch.blockers.find(b => b.kind === 'account_held').fix, {op:'signin.start', input:{target:'codex-lending'}});
  const out = await blockers({agents:[lendingSpec({...codex, signedIn:false})],
    status:{state:'blocked', reason:'agent_not_ready', headline:'Lending stopped', blockers:[{kind:'agent_signed_out', agent:'codex'}]}});
  const signedOut = out.blockers.find(b => b.kind === 'agent_signed_out');
  assert.deepEqual(signedOut.fix, {op:'signin.start', input:{target:'codex-lending'}});
  assert.match(signedOut.message, /Codex/);
});

test('an owner hold with no sign-in fix still names the agent and says what the owner does', async () => {
  const out = await blockers({accounts:[held('codex', 'funding_unknown')]});
  const item = out.blockers.find(b => b.kind === 'account_held');
  assert.equal(item.reason, 'funding_unknown');
  assert.match(item.message, /^Codex: /);
  assert.equal(typeof item.fix?.human, 'string');
  assert.match(item.fix.human, /plan/);
  assert.equal(out.can_lend, false);
});

test('a self-clearing hold blocks its agent without asking the owner to act', async () => {
  const out = await blockers({accounts:[held('codex', 'objective_evidence_unknown'), held('claude', 'identity_mismatch')]});
  const holds = out.blockers.filter(b => b.kind === 'account_held');
  assert.equal(holds.length, 1);
  assert.equal(holds[0].agent, 'codex');
  assert.equal(holds[0].fix, null);
  assert.equal(out.agents[0].lending_state, 'held');
  assert.equal(out.can_lend, false);

  const fine = await blockers({accounts:[admitted('codex')]});
  assert.deepEqual(fine.blockers, []);
  assert.equal(fine.agents[0].lending_state, 'ready');
});

test('one held account is listed while another lent agent can still take jobs', async () => {
  const out = await blockers({agents:[codex, claude], accounts:[held('codex', 'identity_mismatch'), admitted('claude')]});
  assert.ok(out.blockers.some(b => b.kind === 'account_held' && b.agent === 'codex'));
  assert.equal(out.can_lend, true, 'Claude Code still lends');
  assert.equal(out.headline, 'Lending is on');
});

test('an account hold is reported only while lending is on and idle, as the app shows it', async () => {
  const job = {state:'running', job:'synthetic-job', person:'Sam', stops_by:null};
  for (const status of [
    {state:'paused', headline:'Lending paused', intent:{on:true, state:'paused'}},
    {state:'off', headline:'Lending is off', intent:{on:false, state:'off'}},
    {execution:job},
  ]) {
    const out = await blockers({accounts:[held('codex', 'identity_mismatch'), held('claude', 'paused')], agents:[codex, claude], status});
    assert.equal(out.blockers.some(b => b.kind === 'account_held'), false, JSON.stringify({status, blockers:out.blockers}));
    assert.equal(out.headline, status.headline ?? 'Lending is on');
  }
  // The real status.get carries the projection; it decides the same way.
  const projection = (intent, execution) => ({schemaVersion:2, kind:'lending', intent, admission:'unknown', admissionReason:null,
    execution, executionJob:execution === 'idle' ? null : 'synthetic-job', version:null,
    evidence:{dailyLimitReached:false, intentState:intent === 'on' ? 'ready' : intent, executionState:execution}});
  const paused = await blockers({accounts:[held('codex', 'identity_mismatch')], status:{intent:{on:true, state:'ready'}, lendingProjection:projection('paused', 'idle')}});
  assert.equal(paused.blockers.some(b => b.kind === 'account_held'), false);
  const idle = await blockers({accounts:[held('codex', 'identity_mismatch')], status:{lendingProjection:projection('on', 'idle')}});
  assert.equal(idle.blockers.some(b => b.kind === 'account_held'), true);
});

test('every blocker the app reports has a human reason and a fix', async () => {
  // Each state is the app's own projection (lib/v1/lending-state.mjs), so the kinds and the ordered model are real.
  const docker = {installed:true, running:true, signedIn:true}, agent = {id:'codex', name:'codex', enabled:true, installed:true, signedIn:true};
  const requirement = cause => ({docker, readinessRequirements:[{cause, label:'Not ready.', remedy:'Check sandbox setup and try again.'}], agents:[agent]});
  const states = [
    {blocking:{docker:{installed:false}, agents:[agent]}},
    {blocking:{docker:{installed:true, running:false}, agents:[agent]}},
    {blocking:{docker:{...docker, signedIn:false}, agents:[agent]}},
    ...['guard_runtime_unavailable', 'v1_limits', 'network_policy', 'sbx_version'].map(cause => ({blocking:requirement(cause)})),
    {blocking:{docker, circle:{name:'Friends', reachable:false, host:'Sam'}, agents:[agent]}},
    {blocking:{docker, circle:{name:'Friends', hostVersion:'0.1.0', needVersion:'0.2.0'}, agents:[agent]}},
    {blocking:{docker, agents:[{...agent, signedIn:false}]}, agents:[{...agent, signedIn:false}]},
    {blocking:{docker, agents:[]}, agents:[]},
    {blocking:{docker, agents:[{...agent, signedIn:null}]}, agents:[{...agent, signedIn:null}]},
    {blocking:{docker, agents:[agent]}, blockReason:'circle_not_joined'},
    {blocking:{docker, agents:[agent]}, blockReason:'lending_not_started'},
  ];
  const seen = new Set();
  for (const facts of states) {
    const status = effectiveState({intent:'on', now:20000, launchedAt:0, agents:[agent], ...facts});
    const out = await blockers({status, agents:(facts.agents ?? [agent]).map(a => ({...a, useForLending:true}))});
    assert.ok(out.blockers.length, JSON.stringify(facts));
    for (const b of out.blockers) {
      seen.add(b.kind);
      assert.ok(typeof b.message === 'string' && b.message.length > 0, b.kind + ' has no reason');
      assert.ok(b.fix && (b.fix.op || b.fix.human), b.kind + ' has no fix');
    }
    assert.equal(out.next_steps.some(step => /see status\.get/.test(step)), false, JSON.stringify(out.next_steps));
  }
  assert.deepEqual([...seen].sort(), ['agent_not_ready', 'agent_signed_out', 'circle_not_joined', 'circle_unreachable', 'circle_update_needed',
    'docker_not_installed', 'docker_not_running', 'docker_signed_out', 'guard_runtime_unavailable',
    'lending_not_started', 'no_agents', 'policy_unenforceable', 'requirements_unsupported', 'sandbox_not_ready']);
  // 580b3ed49 retired the saved isolation latch: an old isolationFailure is no blocker and holds nothing.
  const effectiveInput = {intent:'on', now:20000, launchedAt:0, agents:[agent], blocking:{docker, agents:[agent]}};
  const baseline = effectiveState(effectiveInput);
  const stale = effectiveState({...effectiveInput,
    blocking:{...effectiveInput.blocking, isolationFailure:'The sandbox could read a file outside the job.'}});
  assert.deepEqual(stale, baseline, 'a retired isolation latch does not change effective lending state');
  const retired = await blockers({status:stale, agents:[{...agent, useForLending:true}]});
  assert.deepEqual(retired.blockers, [], 'a retired isolation latch raises no blocker');
});

test('the running app reports a mismatched account alike over HTTP, the CLI and MCP', {timeout:150000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start:Date.now(), used:{weekly:0, short:0}, kappa:{weekly:1_000_000, short:1_000_000},
    override:({base}) => ({...base, identity:{verified:false, reason:'identity_mismatch'}})});
  const {lender, circle} = await f.connect({lendingPace50:{source}});
  await api(lender.app, '/api/lending/limits', {method:'POST', body:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, idleOnly:false,
    lendingPolicy:{providerConsent:{codex:true}}}});
  const call = (id, input = {}) => api(lender.app, '/api/ops/' + id, {method:'POST', body:input, headers:{'faravan-confirm':'yes'}});
  await call('agents.select', {id:'codex', useForLending:true});
  await call('lending.on', {circle:circle.id});
  // An explicit On reads no quota until a job waits (v1-app-fresh-owner-first-reading), so the owner's Check agents takes the reading.
  await call('agents.check');
  const out = await waitFor(async () => {
    const value = await call('status.blockers');
    return value.blockers.some(b => b.kind === 'account_held' && b.reason === 'identity_mismatch') ? value : null;
  }, 'the held Codex account in status.blockers', 60000);
  assert.equal(out.can_lend, false);
  const item = out.blockers.find(b => b.kind === 'account_held');
  assert.equal(item.agent, 'codex');
  assert.deepEqual(item.fix, {op:'signin.start', input:{target:'codex'}});

  const child = spawn(process.execPath, [BIN, 'status', 'blockers', '--json'], {
    env:{...process.env, FARAVAN_HOME:lender.home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_NO_BROWSER:'1'}, stdio:['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const cli = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(cli.can_lend, false);
  assert.deepEqual(cli.blockers.find(b => b.kind === 'account_held'), item, 'the CLI and the HTTP operation give the same answer');

  // MCP, with every operation result checked against its output schema.
  const mcp = spawn(process.execPath, [BIN, 'mcp', '--root', lender.home], {
    env:{...process.env, FARAVAN_HOME:lender.home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_NO_BROWSER:'1', FARAVAN_OPS_STRICT:'1'}, stdio:['pipe', 'pipe', 'pipe']});
  t.after(() => { mcp.stdin.end(); mcp.kill(); });
  const replies = new Map();
  let buffer = '';
  mcp.stdout.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) { const m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); replies.get(m.id)?.(m); }
  });
  const rpc = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); mcp.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n'); });
  await rpc(1, 'initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'account-attention', version:'1'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}) + '\n');
  const {result, error} = await rpc(2, 'tools/call', {name:'status_blockers', arguments:{}});
  assert.equal(error, undefined, JSON.stringify(error));
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(result.structuredContent.can_lend, false);
  assert.deepEqual(result.structuredContent.blockers.find(b => b.kind === 'account_held'), item, 'MCP gives the same answer');
});
