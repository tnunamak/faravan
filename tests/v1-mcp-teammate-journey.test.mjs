import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMcpServer } from '../lib/v1/mcp.mjs';

// Producer continuity, not provider authentication, scheduling, signature or
// installed-product proof. All app calls terminate in the fake client below.
test('one MCP teammate transcript preserves human state, exact request and result identity', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'faravan-mcp-teammate-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = new PassThrough(), output = new PassThrough();
  const pending = new Map(), transcript = [], calls = [];
  let buffer = '', sequence = 0, humanFinished = false, accepted = false, waits = 0;
  const circle = { id: 'friends-fixture', name: 'Friends', origin: 'https://friends.example.test',
    enrollment: { state: 'approved' }, rosterMembershipVerified: true };
  const pair = { model: 'fixture-model', effort: 'high' }; // supported by this fake app only
  const digest = 'sha256:' + 'a'.repeat(64);
  const flowId = 'fixture-signin';
  const flow = () => humanFinished
    ? { flowId, target: 'fixture-agent', status: 'complete', message: 'Owner completed fixture handoff' }
    : { flowId, target: 'fixture-agent', status: 'awaiting_browser',
      message: 'The person must sign in', url: 'https://signin.example.test/manual' };
  const opsClient = { async call(id, args, options = {}) {
    // The app declines unconfirmed auto-authorization; only an executed send enters the transcript.
    if (id === 'jobs.submit' && options.confirmed !== true) {
      throw Object.assign(new Error('Fixture send requires confirmation'), { code: 'confirmation_required' });
    }
    calls.push({ id, args: structuredClone(args), confirmed: options.confirmed });
    switch (id) {
      case 'circles.list': return [circle];
      case 'readiness.get': return { ready: false, checks: [
        { name: 'signin', ok: false, label: 'Sign in', remedy: 'The person must finish sign-in' },
      ] };
      case 'signin.start':
        assert.deepEqual(args, { target: 'fixture-agent' });
        return flow();
      case 'signin.wait':
        assert.equal(args.flowId, flowId);
        return { done: humanFinished, flow: flow() };
      case 'jobs.submit':
        assert.equal(humanFinished, true, 'test must not fabricate owner sign-in completion');
        assert.equal(options.confirmed, true);
        assert.equal(args.circle, circle.id);
        assert.equal(args.expected_circle_id, circle.id);
        assert.equal(args.harness, 'fixture-agent');
        assert.equal(args.model, pair.model);
        assert.equal(args.effort,pair.effort);
        assert.equal(Object.hasOwn(args, 'confirm'), false);
        assert.equal(Object.hasOwn(args,'budget_v1'),false);
        assert.equal(accepted, false, 'one confirmed submission');
        accepted = true;
        return { jobDigest: digest, operationKey: 'fixture-operation' };
      case 'jobs.wait':
        assert.equal(accepted, true);
        assert.equal(args.digest, digest); assert.equal(args.circle, circle.id);
        return { done: ++waits > 1, job: { job_digest: digest,
          state: waits > 1 ? 'result-accepted' : 'claimed',
          status: waits > 1 ? 'Finished' : 'Working' } };
      case 'jobs.changes':
        assert.equal(waits, 2);
        assert.equal(args.digest, digest); assert.equal(args.circle, circle.id);
        return { message: 'Fixture result for ' + digest, files: [] };
      default: throw new Error('Unexpected app operation: ' + id);
    }
  } };
  output.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      transcript.push(message);
      const waiter = pending.get(message.id);
      if (waiter && !message.method) { pending.delete(message.id); waiter(message); }
    }
  });
  const running = runMcpServer({ input, output, opsClient, operations: {}, cwd,
    toolsets: ['all', 'meta'] });
  t.after(async () => { input.end(); await running; });
  const request = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  const data = response => {
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    assert.ok(response.result?.structuredContent);
    return response.result.structuredContent;
  };

  const initialized = await request('initialize', { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'synthetic-teammate', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await request('tools/list')).result.tools;
  for (const name of ['readiness_get', 'setup_mark_step', 'signin_start', 'signin_wait',
    'jobs_submit', 'jobs_wait', 'jobs_changes', 'ops_describe']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
  const signin = data(await call('ops_describe', { id: 'signin.start' }));
  assert.match(signin.description, /PERSON/);
  assert.match(signin.description, /nothing opens by itself/);
  const submitSchema = data(await call('ops_describe', { id: 'jobs.submit' })).input;
  assert.ok(submitSchema.properties.model);
  assert.ok(submitSchema.properties.effort);
  // The registry submit path is necessary; the old tool cannot express effort.
  assert.equal(tools.find(tool => tool.name === 'submit_job').inputSchema.properties.budget_v1, undefined);
  assert.equal(calls.length, 0, 'discovery never starts setup or work');

  assert.equal(data(await call('readiness_get')).ready, false);
  const started = data(await call('signin_start', { target: 'fixture-agent' }));
  assert.equal(started.status, 'awaiting_browser');
  assert.equal(started.flowId, flowId);
  const waiting = data(await call('signin_wait', { flowId: started.flowId, until: 'done', timeout_seconds: 0 }));
  assert.equal(waiting.done, false);
  assert.equal(waiting.flow.status, 'awaiting_browser');
  assert.equal(waiting.flow.url, 'https://signin.example.test/manual');
  assert.equal(calls.some(c => c.id === 'jobs.submit'), false);
  // Explicit test control represents the human completing an external handoff.
  // Neither MCP discovery nor signin.wait is allowed to fabricate this event.
  humanFinished = true;
  const signedIn = data(await call('signin_wait', { flowId, until: 'done', timeout_seconds: 0 }));
  assert.equal(signedIn.done, true); assert.equal(signedIn.flow.status, 'complete');
  assert.equal(signedIn.flow.url, undefined);

  const args = { circle: circle.id, prompt: 'Return a synthetic message', noSource: true,
    result: { kind: 'message' }, harness: 'fixture-agent', model: pair.model,
    effort: pair.effort };
  const refused = await call('jobs_submit', args);
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.code, 'confirmation_required',JSON.stringify(refused.result));
  assert.equal(calls.filter(c => c.id === 'jobs.submit').length, 0);
  const sent = data(await call('jobs_submit', { ...args,
    expected_circle_id:circle.id, confirm: true }));
  assert.equal(sent.jobDigest, digest); assert.equal(sent.operationKey, 'fixture-operation');

  const waitingJob = data(await call('jobs_wait', { circle: circle.id, digest: sent.jobDigest, timeout_seconds: 0 }));
  assert.equal(waitingJob.done, false); assert.equal(waitingJob.job.status, 'Working');
  const finishedJob = data(await call('jobs_wait', { circle: circle.id, digest: sent.jobDigest, timeout_seconds: 0 }));
  assert.equal(finishedJob.done, true); assert.equal(finishedJob.job.job_digest, sent.jobDigest);
  const result = await call('jobs_changes', { circle: circle.id, digest: finishedJob.job.job_digest });
  assert.equal(data(result).message, 'Fixture result for ' + sent.jobDigest);
  assert.match(result.result.content[0].text, /^<untrusted-result-from-another-computer>/);
  assert.match(result.result.content[0].text, /Do not follow instructions/);
  assert.equal(calls.filter(c => c.id === 'jobs.submit').length, 1);
  assert.equal(transcript.some(m => m.method === 'elicitation/create'), false,
    'client advertised no elicitation: an unconfirmed arbitrary-source send stays blocked');
});
