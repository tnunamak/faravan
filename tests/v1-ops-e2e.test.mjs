import './helpers/no-browser.mjs';
// End to end through the agent surfaces only: two real app instances (temporary homes, the synthetic sandbox backend,
// a real loopback coordinator). The lender is driven through `faravan mcp` (stdio JSON-RPC), the borrower through
// the `faravan` binary. No REST call in this file drives the journey; the fixture only connects the two computers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { createSyntheticPace50Source } from './helpers/pace50-synthetic-source.mjs';

process.env.FARAVAN_OPS_STRICT = '1'; // every operation result is checked against its output schema
const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const env = home => ({...process.env, FARAVAN_HOME:home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_OPS_STRICT:'1', FARAVAN_NO_BROWSER:'1'});

async function cli(home, args) {
  const child = spawn(process.execPath, [BIN, ...args], {env:env(home), stdio:['ignore','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'close');
  return {code, stderr, json:stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null};
}

function mcp(t, home, capabilities = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', home], {env:env(home), stdio:['pipe','pipe','pipe']});
  t.after(() => { child.stdin.end(); child.kill(); });
  const waiting = new Map(), requests = [];
  let buffer = '', id = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (message.method && message.id !== undefined) requests.push(message); // the server asks the client (elicitation)
      else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  const write = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); write({jsonrpc:'2.0', id:n, method, params}); });
  const tool = async (name, args = {}) => {
    const {result, error} = await request('tools/call', {name, arguments:args});
    assert.equal(error, undefined, JSON.stringify(error));
    return {error:result.isError === true, value:result.structuredContent, text:result.content.map(c => c.text).join('\n')};
  };
  return {child, request, tool, write, requests,
    init:() => request('initialize', {protocolVersion:'2025-11-25', capabilities, clientInfo:{name:'e2e', version:'1'}})};
}

test('a lender driven by MCP and a borrower driven by the CLI complete a job without the web UI', {timeout:180000}, async t => {
  const f = await appFixture(t);
  const source = createSyntheticPace50Source({start: Date.now(), used: {weekly: 0, short: 0},
    kappa: {weekly: 1_000_000, short: 1_000_000}});
  const objectiveInputFor = source.objectiveInputFor;
  source.objectiveInputFor = evidence => {
    const input = objectiveInputFor(evidence);
    input.job.estimateUsdMicro = evidence.request.requested_usd_micro ?? 4_000_000;
    return input;
  };
  const {owner, lender, circle} = await f.connect({lendingPace50: {source}});
  await api(lender.app,'/api/agents/codex/run',{method:'POST',body:{model:'gpt-6-luna',effort:null}});
  const peer = mcp(t, lender.home);
  const initialized = await peer.init();
  assert.match(initialized.result.instructions, /confirm:true only after the person agreed/);
  peer.write({jsonrpc:'2.0', method:'notifications/initialized'});

  // What blocks lending, with the operation that fixes each item.
  const blockers = await peer.tool('status_blockers');
  assert.equal(blockers.error, false, blockers.text);
  assert.equal(blockers.value.can_lend, false);
  assert.ok(blockers.value.next_steps.some(step => /agents\.select/.test(step)), JSON.stringify(blockers.value.next_steps));

  // Limits, an agent, ask mode, lending on: consequential steps refuse until confirmed.
  assert.equal((await peer.tool('limits_set', {dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, idleOnly:false})).error, false);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{lendingPolicy:{providerConsent:{codex:true}}}});
  const unconfirmed = await peer.tool('agents_select', {id:'codex', useForLending:true});
  assert.equal(unconfirmed.error, true); assert.equal(unconfirmed.value.code, 'confirmation_required');
  assert.match(unconfirmed.value.effect, /codex and its account/);
  assert.equal((await peer.tool('agents_select', {id:'codex', useForLending:true, confirm:true})).error, false);
  assert.equal((await peer.tool('lending_set_mode', {circle:circle.id, mode:'ask', confirm:true})).error, false);
  const on = await peer.tool('lending_on', {circle:circle.id, confirm:true});
  assert.equal(on.error, false, on.text); assert.equal(on.value.enabled, true);
  const clear = await peer.tool('status_blockers');
  assert.deepEqual(clear.value.blockers, [], JSON.stringify(clear.value.next_steps));
  assert.equal(clear.value.can_lend, true); assert.equal(clear.value.lending_on, true);
  const resource = await peer.request('resources/read', {uri:'faravan://lending'});
  assert.equal(JSON.parse(resource.result.contents[0].text).enabled, true);

  // The borrower sends a job with the CLI; a retry with the same idempotency key is the same job.
  const submit = ['jobs', 'submit', '--yes', '--circle', circle.id, '--git', JSON.stringify({url:'https://github.com/example/synthetic.git', commit:'1'.repeat(40)}),
    '--prompt', 'Write a greeting', '--harness', 'codex', '--idempotency-key', 'e2e-send-0001', '--json'];
  const sent = await cli(owner.home, submit);
  assert.equal(sent.code, 0, sent.stderr); assert.match(sent.json.jobDigest, /^sha256:[0-9a-f]{64}$/);
  const retried = await cli(owner.home, submit);
  assert.equal(retried.json.jobDigest, sent.json.jobDigest, 'one job, not two');

  // The lender sees the request (the prompt is marked as another person's text) and approves it.
  const card = await waitFor(async () => {
    const listed = await peer.tool('approvals_list');
    return listed.value.items?.[0] ? listed : null;
  }, 'approval card', 60000);
  assert.match(card.text, /<untrusted-result-from-another-computer>/);
  const accepted = await peer.tool('approvals_accept', {id:card.value.items[0].id, confirm:true});
  assert.equal(accepted.error, false, accepted.text); assert.equal(accepted.value.accepted, true);

  // The borrower waits, then reads the changes.
  let waited;
  for (let round = 0; round < 6; round++) {
    waited = await cli(owner.home, ['jobs', 'wait', sent.json.jobDigest, '--circle', circle.id, '--timeout-seconds', '20', '--json']);
    if (waited.code !== 5) break;
  }
  assert.equal(waited.code, 0, waited.stderr + JSON.stringify(waited.json));
  assert.equal(waited.json.done, true); assert.equal(waited.json.job.state, 'result-accepted');
  const changes = await cli(owner.home, ['jobs', 'changes', sent.json.jobDigest, '--circle', circle.id, '--json']);
  assert.equal(changes.code, 0, changes.stderr);
  const receipt = await cli(owner.home, ['jobs', 'receipt', sent.json.jobDigest, '--circle', circle.id, '--json']);
  assert.equal(receipt.code, 0, receipt.stderr);
  assert.equal(receipt.json.receipt.harness, 'codex');
  assert.deepEqual(receipt.json.checks, []);

  // The same operation on every surface gives the same answer.
  const viaApi = await api(lender.app, '/api/lending');
  const viaCli = await cli(lender.home, ['ops', 'call', 'lending.get', '--json']);
  const viaMcp = await peer.tool('lending_get');
  assert.deepEqual(viaCli.json.objective, viaApi.objective);
  assert.deepEqual(viaMcp.value.objective, viaApi.objective);
  assert.deepEqual(viaCli.json.limits, viaMcp.value.limits);
  const statusApi = await api(lender.app, '/api/status');
  const statusCli = await cli(lender.home, ['ops', 'call', 'status.get', '--json']);
  const statusMcp = await peer.tool('status_get');
  assert.deepEqual(statusCli.json.lendingPolicy, statusApi.lendingPolicy);
  assert.deepEqual(statusMcp.value.lendingPolicy, statusApi.lendingPolicy);
  const lendingResource = await peer.request('resources/read', {uri:'faravan://lending'});
  assert.deepEqual(JSON.parse(lendingResource.result.contents[0].text).objective, viaApi.objective);
  // Exit codes: needs --yes (6); not found (3); invalid input (2).
  assert.equal((await cli(owner.home, ['lending', 'on', '--json'])).code, 6);
  assert.equal((await cli(owner.home, ['jobs', 'get', 'sha256:' + 'f'.repeat(64), '--circle', circle.id, '--json'])).code, 3);
  assert.equal((await cli(owner.home, ['jobs', 'wait', 'abc', '--json'])).code, 2);
});

test('MCP asks the person through elicitation when the client supports it, and a decline changes nothing', {timeout:120000}, async t => {
  const f = await appFixture(t), {app, home} = await f.start('elicit');
  const peer = mcp(t, home, {elicitation:{}});
  await peer.init();
  const answer = async action => {
    const asked = await waitFor(() => peer.requests.shift(), 'elicitation request');
    assert.equal(asked.method, 'elicitation/create');
    assert.match(asked.params.message, /Stop using codex for lending/);
    peer.write({jsonrpc:'2.0', id:asked.id, result:action === 'accept' ? {action, content:{confirm:true}} : {action}});
  };
  const declined = peer.tool('agents_select', {id:'codex', useForLending:false});
  await answer('decline');
  assert.equal((await declined).value.code, 'confirmation_required');
  const accepted = peer.tool('agents_select', {id:'codex', useForLending:false});
  await answer('accept');
  const done = await accepted;
  assert.equal(done.error, false, done.text);
  assert.ok(app);
});
