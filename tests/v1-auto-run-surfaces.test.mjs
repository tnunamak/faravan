import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {runMcpServer} from '../lib/v1/mcp.mjs';
import {fixture, parseOne} from './helpers/v1-journey.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';
import {draftBody} from '../ui/v1/src/compose-draft.mjs';

// The compose screen, `faravan job submit` and the MCP tool all send one automatic choice, and all of them sign the same field.
const git = 'https://example.test/synthetic.git@' + 'a'.repeat(40);
async function create(f, name = 'owner') {
  await f.provisionFromHome(name);
  const result = await f.cli(['circle', 'create', f.origin, '--name', 'Synthetic circle'], name);
  assert.equal(result.code, 0, result.stderr);
  return [...f.circles.keys()].at(-1);
}
const submitCli = async (f, circle, extra) => parseOne(await f.cli(['job', 'submit', '--yes', '--git', git, '--prompt', 'Synthetic automatic choice', '--circle', circle, '--json', ...extra])).jobDigest;

test('the compose body, the shared op and the CLI sign the same automatic choice', async t => {
  const f = await fixture(t), circle = await create(f), ops = createJobOperations({home: await f.home()});
  const {runOp} = await import('../lib/v1/ops/execute.mjs');
  const context = {confirmed: true, rest: async (method, path, request) => {
    if (path === '/api/circles') return [{id: circle, name: 'Synthetic circle', origin: f.origin, enrollment: {state: 'approved'}, rosterMembershipVerified: true}];
    assert.equal(method, 'POST'); assert.equal(path, '/api/jobs');
    return ops.submit({...request.body, git: request.body.git.url + '@' + request.body.git.commit});
  }};
  for (const intent of ['cheapest', 'strongest']) {
    const body = draftBody({id: 'draft-auto-0001', prompt: 'Synthetic automatic choice', sourceKind: 'git', gitUrl: 'https://example.test/synthetic.git', gitCommit: 'a'.repeat(40), agent: 'codex', auto: intent}, circle);
    assert.deepEqual(body.auto_run_v1, {intent});
    assert.equal(body.model, undefined); assert.equal(body.budget_v1, undefined);
    const viaOp = (await runOp('jobs.submit', {circle, prompt: 'Synthetic automatic choice', git: {url: 'https://example.test/synthetic.git', commit: 'a'.repeat(40)}, result: {kind: 'message'}, auto_run_v1: {intent}}, context)).jobDigest;
    const viaCli = await submitCli(f, circle, ['--auto', intent]);
    for (const digest of [viaOp, viaCli]) {
      const signed = f.jobs.get(digest).job.payload;
      assert.deepEqual(signed.auto_run_v1, {intent});
      assert.ok(signed.requirements.capabilities.includes('auto_run_v1'));
      assert.equal(signed.requirements.model, undefined, 'the lender picks the model, so none is pinned');
      assert.equal(signed.budget_v1, undefined, 'no effort or budget is written into the budget field');
    }
  }
  assert.equal(f.jobs.get(await submitCli(f, circle, [])).job.payload.auto_run_v1, undefined, 'the default still lets the lender choose');
});

test('an automatic choice refuses an unknown intent or a second answer before any network call', async t => {
  const f = await fixture(t), circle = await create(f), before = f.requests.length;
  for (const extra of [['--auto', 'best'], ['--auto', ''], ['--auto', 'cheapest', '--effort', 'high'], ['--auto', 'cheapest', '--model', 'synthetic-model'],
    ['--auto', 'strongest', '--budget-v1', '{"effort":"low"}']]) {
    const result = await f.cli(['job', 'submit', '--yes', '--git', git, '--prompt', 'Refuse', '--circle', circle, '--json', ...extra]);
    assert.equal(result.code, 2, extra.join(' ') + result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).code, 'invalid_request');
  }
  assert.equal(f.requests.length, before);
  assert.equal(f.jobs.size, 0);
});

function server(t, options) {
  const input = new PassThrough(), output = new PassThrough(), waiting = new Map();
  let buffer = '', id = 0;
  output.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (!message.method && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  const running = runMcpServer({input, output, ...options});
  t.after(async () => { input.end(); await running; });
  const request = (method, params = {}, n = ++id) => new Promise(resolve => { waiting.set(n, resolve); input.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n'); });
  return {request, init: () => request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 't', version: '1'}})};
}

test('the MCP tool lists the field and forwards the same intent', async t => {
  const calls = [];
  const peer = server(t, {opsClient: {call: async (id, args) => {
    if (id === 'circles.list') return [{id: 'Friends', name: 'Friends', origin: 'https://example.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true}];
    calls.push({id, input: args}); return {jobDigest: 'sha256:' + 'a'.repeat(64)};
  }}});
  await peer.init();
  const listed = await peer.request('tools/list');
  const schema = listed.result.tools.find(tool => tool.name === 'jobs_submit').inputSchema;
  assert.deepEqual(schema.properties.auto_run_v1.properties.intent.enum, ['cheapest', 'strongest']);
  const args = {circle: 'Friends', prompt: 'Think', noSource: true, result: {kind: 'message'}, confirm: true};
  const sent = await peer.request('tools/call', {name: 'jobs_submit', arguments: {...args, auto_run_v1: {intent: 'strongest'}}});
  assert.notEqual(sent.result.isError, true);
  assert.deepEqual(calls[0].input.auto_run_v1, {intent: 'strongest'});
  const refused = await peer.request('tools/call', {name: 'jobs_submit', arguments: {...args, auto_run_v1: {intent: 'best'}}});
  assert.equal(refused.result.isError, true);
  assert.equal(calls.length, 1);
});

// The same budget as tests/v1-ops-parity.test.mjs ("MCP tool lists stay within their size budget"), measured on what the running server
// actually returns for tools/list rather than on the tool table, so the new field is counted where a client pays for it.
test('the full tools/list a client receives stays inside the documented size budget', async t => {
  const peer = server(t, {opsClient: {call: async () => ({})}});
  await peer.init();
  const listed = await peer.request('tools/list');
  const bytes = Buffer.byteLength(JSON.stringify(listed.result.tools));
  assert.ok(bytes <= 68 * 1024, 'tools/list is ' + bytes + ' bytes; the budget is ' + 68 * 1024);
  assert.ok(listed.result.tools.find(tool => tool.name === 'jobs_submit').inputSchema.properties.auto_run_v1, 'the field is part of what was measured');
});

test('a legacy jobs_submit without the automatic choice reaches the operation unchanged', async t => {
  const calls = [];
  const peer = server(t, {opsClient: {call: async (id, args) => {
    if (id === 'circles.list') return [{id: 'Friends', name: 'Friends', origin: 'https://example.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true}];
    calls.push({id, input: args}); return {jobDigest: 'sha256:' + 'a'.repeat(64)};
  }}});
  await peer.init();
  const legacy = {circle: 'Friends', prompt: 'Think', noSource: true, result: {kind: 'message'}, model: 'gpt-6-sol', confirm: true};
  const sent = await peer.request('tools/call', {name: 'jobs_submit', arguments: legacy});
  assert.notEqual(sent.result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].input, 'auto_run_v1'), false, 'nothing automatic is added');
  assert.equal(calls[0].input.model, 'gpt-6-sol');
});
