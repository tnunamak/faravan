import './helpers/no-browser.mjs';
// One borrower journey across every surface on one real app: an agent sends a job over MCP, follows it on the CLI,
// the web app's own view models read it, and HTTP operations fetch its result. Each step checks that every surface
// names the same job, state and result, and that consequential steps refuse without confirmation on every agent
// surface. The lender is the synthetic fixture: it signs the result; no sandbox or agent runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { realpath, rm } from 'node:fs/promises';
import { appFixture, api, boundedFetch } from './helpers/v1-app-fixture.mjs';
import { makeRepo, git } from './helpers/git-guest.mjs';
import { createOpsClient } from '../lib/v1/ops/execute.mjs';
import { runOpsCommand } from '../lib/v1/ops/cli.mjs';
import { runMcpServer } from '../lib/v1/mcp.mjs';
import { statusLabel } from '../lib/v1/cli.mjs';
import { jobVM, jobsListVM } from '../ui/v1/src/view-models.mjs';
import { sendableCircles, circleAgents } from '../ui/v1/src/compose-model.mjs';

const jobPath = digest => '/api/jobs/' + encodeURIComponent(digest);

function mcpPeer(t, opsClient, roots, home) {
  const input = new PassThrough(), output = new PassThrough(), waiting = new Map(), seen = [];
  let buffer = '', id = 0;
  output.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      seen.push(message);
      if (!message.method && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  // The app home is outside the checkout; the parity journey tests confirmation, not the repository fence.
  const running = runMcpServer({input, output, opsClient, roots, home, cwd:home, toolsets:['all']});
  t.after(async () => { input.end(); await running; });
  const request = (method, params = {}) => new Promise(resolve => {
    const n = ++id; waiting.set(n, resolve);
    input.write(JSON.stringify({jsonrpc:'2.0', id:n, method, params}) + '\n');
  });
  const call = (name, args = {}) => request('tools/call', {name, arguments:args}).then(reply => reply.result);
  const data = async (name, args) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  return {seen, request, call, data,
    init:() => request('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'parity-agent', version:'1'}})};
}

/** `faravan <argv> --json` in this process against the same app; returns {code, out}. stdin is not a terminal. */
async function cli(client, argv) {
  const stdout = [], stderr = [];
  const code = await runOpsCommand([...argv, '--json'], {client, stdin:new PassThrough(),
    stdout:{write:value => stdout.push(value)}, stderr:{write:value => stderr.push(value)}});
  const text = stdout.join('').trim();
  return {code, out:text ? JSON.parse(text) : null, stderr:stderr.join('')};
}

test('an agent can do the whole borrower journey on the job the app shows, with the app\'s confirmations', {timeout:120000}, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  // strict: every operation answer is checked against the output schema the registry publishes.
  const client = createOpsClient({home:owner.home, autostart:false, strict:true});
  const repo = await makeRepo(); t.after(() => rm(repo.dir, {recursive:true, force:true}));
  repo.dir = await realpath(repo.dir);
  const mcp = mcpPeer(t, client, [repo.dir], owner.home);
  await mcp.init();
  const ops = (id, body = {}, headers = {}, status = 200) => api(owner.app, '/api/ops/' + id, {method:'POST', body, headers, status});
  const jobsSent = async () => (await api(owner.app, '/api/jobs')).filter(job => job.role === 'sent');

  // ---- Readiness: the app's composer decides from circles and the circle's compose view; the agent reads the same.
  const appCircles = await api(owner.app, '/api/circles');
  assert.deepEqual(sendableCircles(appCircles).map(c => c.id), [circle.id], 'the app can send to the circle');
  assert.deepEqual(sendableCircles((await mcp.data('circles_list')).items).map(c => c.id), [circle.id], 'MCP sees the same sendable circle');
  assert.deepEqual(sendableCircles((await cli(client, ['circles', 'list'])).out).map(c => c.id), [circle.id], 'CLI sees the same sendable circle');
  const appCompose = await api(owner.app, '/api/circles/' + encodeURIComponent(circle.id) + '/compose');
  assert.deepEqual(circleAgents(await mcp.data('circles_compose', {circle:circle.id})), circleAgents(appCompose), 'MCP offers the agents the composer offers');
  assert.deepEqual(circleAgents((await cli(client, ['circles', 'compose', circle.id])).out), circleAgents(appCompose), 'CLI offers the agents the composer offers');

  // ---- Send over MCP: refused without confirmation, and nothing reaches the circle.
  const send = {circle:circle.id, prompt:'Synthetic parity task', git:{url:'https://github.com/example/synthetic.git', commit:'4'.repeat(40)}};
  const refused = await mcp.call('jobs_submit', send);
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, 'confirmation_required');
  assert.equal(refused.structuredContent.confirmation_input.expected_circle_id, circle.id);
  const cliRefused = await cli(client, ['jobs', 'submit', '--input', JSON.stringify(send)]);
  assert.equal(cliRefused.code, 6, 'the CLI refuses a send without --yes');
  assert.equal(cliRefused.out.code, 'confirmation_required');
  assert.equal((await ops('jobs.submit', send, {}, 428)).code, 'confirmation_required', 'HTTP refuses a send without Faravan-Confirm');
  assert.deepEqual(await jobsSent(), [], 'no refused send created a job');
  const sent = await mcp.data('jobs_submit', {...send, ...refused.structuredContent.confirmation_input, confirm:true});
  const digest = sent.jobDigest;
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);

  /** Progress: the app route, MCP, the CLI and HTTP give one answer, a value or the same problem code. */
  const sameProgress = async step => {
    const query = {digest, circle:circle.id};
    const route = await boundedFetch(owner.app.origin + jobPath(digest) + '/progress?circle=' + encodeURIComponent(circle.id), {headers:{'x-faravan-session-token':owner.app.token}});
    const appAnswer = await route.json(), appOk = route.ok;
    const expected = appOk ? appAnswer : {code:appAnswer.code};
    const viaMcp = await mcp.call('jobs_progress', query);
    assert.deepEqual(viaMcp.isError === true ? {code:viaMcp.structuredContent.code} : viaMcp.structuredContent, expected, step + ': MCP progress');
    const viaCli = await cli(client, ['jobs', 'progress', digest, '--circle', circle.id]);
    assert.deepEqual(viaCli.code === 0 ? viaCli.out : {code:viaCli.out.code}, expected, step + ': CLI progress');
    const viaHttp = await boundedFetch(owner.app.origin + '/api/ops/jobs.progress', {method:'POST', body:JSON.stringify(query),
      headers:{'x-faravan-session-token':owner.app.token, 'content-type':'application/json'}});
    const httpAnswer = await viaHttp.json();
    assert.equal(viaHttp.status, route.status, step + ': HTTP progress status');
    assert.deepEqual(viaHttp.ok ? httpAnswer : {code:httpAnswer.code}, expected, step + ': HTTP progress');
  };
  /** Every surface's answer for the job, and the app's own view of it. */
  const everySurface = async () => {
    const appView = await api(owner.app, jobPath(digest) + '?circle=' + encodeURIComponent(circle.id));
    const viaMcp = await mcp.data('jobs_get', {digest, circle:circle.id});
    const viaCli = await cli(client, ['jobs', 'get', digest, '--circle', circle.id]);
    assert.equal(viaCli.code, 0, viaCli.stderr);
    const viaHttp = await ops('jobs.get', {digest, circle:circle.id});
    const listed = jobsListVM(await api(owner.app, '/api/jobs')).groups.flatMap(group => group.rows).find(row => row.id === digest);
    const viaLegacy = await mcp.data('get_job', {digest, circle:circle.id});
    return {appView, viaMcp, viaCli:viaCli.out, viaHttp, viaLegacy, listed, ui:jobVM(appView, 'sent')};
  };
  const sameJob = (seen, {key, label, state}) => {
    for (const [surface, view] of Object.entries({app:seen.appView, mcp:seen.viaMcp, cli:seen.viaCli, http:seen.viaHttp, legacy:seen.viaLegacy})) {
      assert.equal(view.job_digest, digest, surface + ': job id');
      assert.equal(view.state, state, surface + ': raw state');
      assert.equal(view.status, label, surface + ': status label');
      assert.equal(statusLabel(view), label, surface + ': the CLI label for its answer');
      assert.equal(view.result_digest ?? null, seen.appView.result_digest ?? null, surface + ': result identity');
    }
    assert.equal(seen.ui.key, key, 'the app job page state');
    assert.equal(seen.listed?.key, key, 'the app Jobs list state');
  };

  // ---- Follow on the CLI: the job the agent sent is the job the app shows, waiting for a lender.
  sameJob(await everySurface(), {key:'waiting', label:'Waiting', state:'queued'});
  const notYet = await cli(client, ['jobs', 'wait', digest, '--circle', circle.id, '--timeout-seconds', '0']);
  assert.equal(notYet.code, 5, 'a wait that ends first says so (exit 5)');
  assert.equal(notYet.out.done, false);
  assert.equal(notYet.out.job.job_digest, digest);
  await sameProgress('waiting');

  // ---- The lender finishes it: every surface sees the same finished job and the same result.
  const signed = await f.complete(digest, 'lender');
  const finished = await everySurface();
  sameJob(finished, {key:'ready', label:'Finished', state:'result-accepted'});
  assert.ok(finished.appView.result_digest, 'the finished job names its result');
  await sameProgress('finished');
  const waited = await mcp.data('jobs_wait', {digest, circle:circle.id, timeout_seconds:0});
  assert.equal(waited.done, true);
  assert.equal(waited.job.job_digest, digest);
  assert.equal(waited.job.result_digest, finished.appView.result_digest);

  // ---- Result: what the app's Changes tab reads is what MCP, the CLI and HTTP return.
  const appChanges = await api(owner.app, jobPath(digest) + '/changes?circle=' + encodeURIComponent(circle.id));
  const mcpChanges = await mcp.call('jobs_changes', {digest, circle:circle.id});
  assert.notEqual(mcpChanges.isError, true, JSON.stringify(mcpChanges.structuredContent));
  assert.match(mcpChanges.content[0].text, /^<untrusted-result-from-another-computer>/, 'MCP marks the result as untrusted');
  assert.deepEqual(mcpChanges.structuredContent, appChanges, 'MCP returns the app\'s changes');
  assert.deepEqual((await cli(client, ['jobs', 'changes', digest, '--circle', circle.id])).out, appChanges, 'the CLI returns the app\'s changes');
  assert.deepEqual(await ops('jobs.changes', {digest, circle:circle.id}), appChanges, 'HTTP returns the app\'s changes');
  const appReceipt = await api(owner.app, jobPath(digest) + '/receipt?circle=' + encodeURIComponent(circle.id));
  const httpReceipt = await ops('jobs.receipt', {digest, circle:circle.id});
  assert.deepEqual(httpReceipt, appReceipt, 'HTTP returns the app\'s receipt');
  assert.deepEqual(await mcp.data('jobs_receipt', {digest, circle:circle.id}), appReceipt, 'MCP returns the app\'s receipt');
  assert.deepEqual(httpReceipt.receipt, signed.payload.receipt, 'the receipt is the one the lender signed');
  const unpacked = await ops('jobs.result', {digest, circle:circle.id, out:'parity-result'});
  assert.equal(typeof unpacked.path, 'string');
  assert.ok(unpacked.path.includes('parity-result'), 'HTTP unpacks the verified result');

  // ---- Apply is consequential: refused without confirmation on every agent surface, and nothing is written.
  const branches = () => git(repo.dir, 'branch', '--list');
  const branchesBefore = branches();
  const applyInput = {digest, circle:circle.id, repo:repo.dir};
  const mcpApply = await mcp.call('jobs_apply', applyInput);
  assert.equal(mcpApply.isError, true);
  assert.equal(mcpApply.structuredContent.code, 'confirmation_required');
  assert.equal((await cli(client, ['jobs', 'apply', '--input', JSON.stringify(applyInput)])).out.code, 'confirmation_required');
  assert.equal((await ops('jobs.apply', applyInput, {}, 428)).code, 'confirmation_required');
  assert.equal(branches(), branchesBefore, 'no refused apply created a branch');

  // ---- Stop: a second job, cancelled from the CLI after MCP and HTTP refused without confirmation.
  const second = await mcp.data('jobs_submit', {...send, prompt:'Synthetic parity job to stop', git:{...send.git, commit:'5'.repeat(40)}, confirm:true});
  const stopDigest = second.jobDigest;
  assert.notEqual(stopDigest, digest);
  const mcpCancel = await mcp.call('jobs_cancel', {digest:stopDigest, circle:circle.id});
  assert.equal(mcpCancel.isError, true);
  assert.equal(mcpCancel.structuredContent.code, 'confirmation_required');
  assert.equal((await ops('jobs.cancel', {digest:stopDigest, circle:circle.id}, {}, 428)).code, 'confirmation_required');
  const cliCancelRefused = await cli(client, ['jobs', 'cancel', stopDigest, '--circle', circle.id]);
  assert.equal(cliCancelRefused.code, 6);
  // The original MCP job tool is the same consequential operation (jobs.cancel), so it asks the same way.
  const legacyCancel = await mcp.call('cancel_job', {digest:stopDigest, circle:circle.id});
  assert.equal(legacyCancel.isError, true, 'cancel_job without confirm must not cancel: ' + JSON.stringify(legacyCancel.structuredContent ?? legacyCancel.content));
  assert.equal(legacyCancel.structuredContent.code, 'confirmation_required');
  assert.match(legacyCancel.structuredContent.effect, /Cancel job sha256:[0-9a-f]{64}\. Work in progress is lost\./);
  const stillWaiting = await api(owner.app, jobPath(stopDigest) + '?circle=' + encodeURIComponent(circle.id));
  assert.equal(stillWaiting.state, 'queued', 'refused cancels left the job alone');
  const cancelled = await cli(client, ['jobs', 'cancel', stopDigest, '--circle', circle.id, '--yes']);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const stopView = await api(owner.app, jobPath(stopDigest) + '?circle=' + encodeURIComponent(circle.id));
  const stopMcp = await mcp.data('jobs_get', {digest:stopDigest, circle:circle.id});
  const stopHttp = await ops('jobs.get', {digest:stopDigest, circle:circle.id});
  const stopCli = (await cli(client, ['jobs', 'get', stopDigest, '--circle', circle.id])).out;
  const stopLegacy = await mcp.data('get_job', {digest:stopDigest, circle:circle.id});
  for (const [surface, view] of Object.entries({app:stopView, mcp:stopMcp, cli:stopCli, http:stopHttp, legacy:stopLegacy})) {
    assert.equal(view.job_digest, stopDigest, surface);
    assert.equal(view.state, 'cancelled', surface);
    assert.equal(view.status, 'Cancelled', surface);
  }
  assert.equal(jobVM(stopView, 'sent').key, 'cancelled', 'the app shows it cancelled');

  // The finished job was never disturbed by the second job's stop.
  assert.equal((await mcp.data('jobs_get', {digest, circle:circle.id})).state, 'result-accepted');
  assert.equal(mcp.seen.some(message => message.method === 'elicitation/create'), false, 'no elicitation without client support');
});
