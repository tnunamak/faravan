import './helpers/no-browser.mjs';
// A person with no Docker Sandboxes and no agent account can still borrow, and every surface says so the same way.
// The borrower is a fresh install (lending starts on by default, as in production) whose sandbox is missing. The lender
// side is a second synthetic computer that is ready and lending. The answer is read through HTTP, the CLI, MCP and the
// app's own view models.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {appFixture, api, syntheticBackend, adapters} from './helpers/v1-app-fixture.mjs';
import {needsYouItems, lendingStarted} from '../ui/v1/src/view-models.mjs';
import {onboardingVM} from '../ui/v1/src/onboarding.mjs';
import {borrowingReadiness} from '../lib/v1/borrowing-readiness.mjs';

process.env.FARAVAN_OPS_STRICT = '1';
const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const env = home => ({...process.env, FARAVAN_HOME:home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_OPS_STRICT:'1', FARAVAN_NO_BROWSER:'1'});

async function cli(home, args) {
  const child = spawn(process.execPath, [BIN, ...args], {env:env(home), stdio:['ignore','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'close');
  return {code, stderr, json:stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null};
}
function mcpTool(t, home) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', home], {env:env(home), stdio:['pipe','pipe','pipe']});
  t.after(() => { child.stdin.end(); child.kill(); });
  const waiting = new Map();
  let buffer = '', id = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  const request = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:n, method, params}) + '\n'); });
  return {async init() {
    await request('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'borrow-ready', version:'1'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}) + '\n');
  }, async tool(name, args = {}) {
    const {result, error} = await request('tools/call', {name, arguments:args});
    assert.equal(error, undefined, JSON.stringify(error));
    return {error:result.isError === true, value:result.structuredContent, text:result.content.map(c => c.text).join('\n')};
  }};
}

// This computer has no Docker Sandboxes and no agent account.
function noSandbox(f) {
  const backend = syntheticBackend(f.root);
  backend.probeCapabilities = async () => ({available:false, preflight:{ok:false, checks:[{name:'sbx_install', ok:false, detail:'Not installed'}]}});
  backend.lenderCapabilities = () => ({available:false, enforced_limits:[], max_limits:{}, egress:[]});
  return backend;
}

async function connected(t) {
  const f = await appFixture(t);
  // The lender is ready and lending; the borrower is a fresh install with lending left at its default.
  const {owner, lender, circle} = await f.connect({backend:syntheticBackend(f.root), adapters:adapters()},
    {backend:noSandbox(f), adapters:[], freshLending:'automatic'});
  await api(lender.app, '/api/lending/limits', {method:'POST', body:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, idleOnly:false, lendingPolicy:{providerConsent:{codex:true}}}});
  await api(lender.app, '/api/agents/codex', {method:'POST', body:{useForLending:true}});
  await api(lender.app, '/api/lending/mode', {method:'POST', body:{circle:circle.id, mode:'ask'}});
  await api(lender.app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
  return {f, owner, lender, circle};
}

test('a computer with no Docker and no agent account can borrow, and every surface says so the same way', {timeout:180000}, async t => {
  const {owner, circle} = await connected(t);
  const mcp = mcpTool(t, owner.home);
  await mcp.init();

  // The setup really is missing: lending is blocked here, as it should be.
  const lending = await api(owner.app, '/api/ops/status.blockers', {method:'POST', body:{}});
  assert.equal(lending.can_lend, false);

  // (a) One borrowing answer, the same on HTTP, the CLI and MCP.
  const viaHttp = await api(owner.app, '/api/ops/status.borrowing', {method:'POST', body:{}});
  const viaCli = await cli(owner.home, ['ops', 'call', 'status.borrowing', '--json']);
  const viaMcp = await mcp.tool('status_borrowing');
  assert.equal(viaHttp.can_borrow, true, JSON.stringify(viaHttp));
  assert.deepEqual(viaHttp.blockers, []);
  assert.equal(viaHttp.circles.find(c => c.id === circle.id)?.ready, true);
  assert.equal(viaCli.code, 0, viaCli.stderr);
  assert.deepEqual(viaCli.json, viaHttp);
  assert.equal(viaMcp.error, false, viaMcp.text);
  assert.deepEqual(viaMcp.value, viaHttp);
  // The lending answer carries the same borrowing answer, so an agent that reads only it is not misled.
  assert.deepEqual(lending.borrowing, viaHttp);

  // (b) A job from this computer is accepted: over HTTP and with the CLI.
  const git = {url:'https://github.com/example/synthetic.git', commit:'1'.repeat(40)};
  const sent = await api(owner.app, '/api/jobs', {method:'POST', body:{circle:circle.id, git, prompt:'Write a greeting', harness:'codex'}});
  assert.match(sent.jobDigest, /^sha256:[0-9a-f]{64}$/);
  const sentCli = await cli(owner.home, ['jobs', 'submit', '--yes', '--circle', circle.id, '--git', JSON.stringify(git),
    '--prompt', 'Write another greeting', '--harness', 'codex', '--idempotency-key', 'borrow-ready-0001', '--json']);
  assert.equal(sentCli.code, 0, sentCli.stderr);
  assert.match(sentCli.json.jobDigest, /^sha256:[0-9a-f]{64}$/);

  // (c) The app: no lending blocker is offered as something this person must fix, and the first-run path stays borrowing.
  const home = await api(owner.app, '/api/status'), readiness = await api(owner.app, '/api/readiness'),
    agents = await api(owner.app, '/api/agents'), circles = await api(owner.app, '/api/circles');
  assert.equal(lendingStarted(home, agents), false, 'a default of lending-on is not the person starting to lend');
  const needs = needsYouItems({home, readiness, agents, approvals:[], jobs:[]});
  assert.deepEqual(needs.filter(item => item.kind === 'blocker'), []);
  const first = onboardingVM({home, circles, jobs:[], agents});
  assert.equal(first.lendingSetup, true, 'lending setup is offered as optional');
  assert.ok(first.progress, 'the borrowing steps stay visible');
  // (d) The app reads the same answer as the operation.
  assert.equal(first.progress.steps.find(step => step.id === 'joined').done, viaHttp.can_borrow);
  assert.deepEqual(borrowingReadiness({circles}), viaHttp);
});

test('lending blockers stay with a person who chose to lend', async () => {
  const home = {intent:{on:true, state:'blocked'}, lending:{enabled:true, circle:'c1'}, lending_blockers:{items:[], needsYou:[], first:null, canLend:false}};
  const agents = [{id:'codex', name:'Codex', useForLending:true, installed:false, signedIn:false}];
  const readiness = {ready:false, checks:[{name:'sbx_install', ok:false, label:'Docker Sandboxes is not installed'}]};
  assert.equal(lendingStarted(home, agents), true);
  assert.ok(needsYouItems({home, readiness, agents, approvals:[], jobs:[]}).some(item => item.kind === 'blocker'));
});

test('borrowing readiness names what a person with no usable circle needs, and never mentions lending setup', () => {
  const none = borrowingReadiness({circles:[]});
  assert.equal(none.can_borrow, false);
  assert.deepEqual(none.blockers.map(b => b.kind), ['no_circle']);
  assert.equal(none.blockers[0].fix.op, 'circles.join');
  const pending = borrowingReadiness({circles:[{id:'c1', name:'Friends', origin:'http://127.0.0.1:1', membershipProjection:{schemaVersion:3, kind:'membership', phase:'pending',
    evidence:{enrollmentState:'pending', origin:true, rosterMembershipVerified:false}, invitationPolicy:'each'}}]});
  assert.equal(pending.can_borrow, false);
  assert.deepEqual(pending.blockers.map(b => b.kind), ['membership_pending']);
  assert.doesNotMatch(JSON.stringify([none, pending]), /docker|sandbox|agent account|lend/i);
});

test('a local placeholder that never joined a host is not a circle to check: join or start is offered', () => {
  const placeholder = borrowingReadiness({circles:[{id:'local', name:'My devices', origin:null}]});
  assert.equal(placeholder.can_borrow, false);
  assert.deepEqual(placeholder.blockers.map(b => b.kind), ['no_circle']);
  assert.equal(placeholder.blockers[0].fix.op, 'circles.join');
  assert.doesNotMatch(placeholder.next_steps.join('\n'), /circles\.check/);
  // A placeholder beside a circle that is still waiting does not hide the waiting circle.
  const mixed = borrowingReadiness({circles:[{id:'local', name:'My devices', origin:null},
    {id:'c1', name:'Friends', origin:'http://127.0.0.1:1', membershipProjection:{schemaVersion:3, kind:'membership', phase:'pending',
      evidence:{enrollmentState:'pending', origin:true, rosterMembershipVerified:false}, invitationPolicy:'each'}}]});
  assert.deepEqual(mixed.blockers.map(b => b.kind), ['membership_pending']);
});
