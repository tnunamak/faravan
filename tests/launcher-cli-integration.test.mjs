import './helpers/no-browser.mjs';
// Ordinary production imports. Run on the host with the complete dependency
// tree; this scoped bridge workspace must not import provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOpsCommand, opsRoute} from '../lib/v1/ops/cli.mjs';
import {createOpsClient} from '../lib/v1/ops/execute.mjs';
import {residentQuit} from '../lib/v1/resident-intent.mjs';

const failure = {version:1, code:'sandbox_start_failed', kind:'Error', at:123};
const liveStatus = {summary:{phase:'ready', headline:'Ready for requests', reason:'This computer is ready.', action:null},
  blockers:[], lending:{enabled:true}};
async function fixture(t, saved = failure) {
  const home = await mkdtemp(join(tmpdir(), 'launcher-cli-integration-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  await mkdir(join(home, 'v1'));
  if (saved) await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify(saved));
  return home;
}
const clientFor = home => createOpsClient({home, autostart:false, strict:true, surface:'cli'});
async function command(home, argv, {client = clientFor(home), terminal = false} = {}) {
  let out = '', err = '';
  const code = await runOpsCommand(argv, {home, client, stdin:{isTTY:false},
    stdout:{write:value => {out += value;}}, stderr:{isTTY:terminal, write:value => {err += value;}}});
  return {code, value:out ? JSON.parse(out) : null, err};
}
async function serverFor(t, home, reply) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({method:req.method, path:req.url, headers:req.headers, body:body ? JSON.parse(body) : null});
    if (req.headers['x-faravan-session-token'] !== 'test-session' || req.headers['x-faravan-session-token'] !== 'test-session') {
      res.writeHead(401, {'content-type':'application/json'}).end(JSON.stringify({code:'unauthorized'}));
      return;
    }
    const result = reply(seen.at(-1));
    res.writeHead(result.status ?? 200, {'content-type':'application/json'}).end(JSON.stringify(result.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
  await writeFile(join(home, 'v1', 'app.json'), JSON.stringify({pid:process.pid, port:server.address().port, token:'test-session'}));
  return {seen, server};
}

test('status get and ops call status.get retain the operation schema during startup retry', async t => {
  const home = await fixture(t, {...failure, message:'secret-token', stack:'/Users/private'});
  assert.equal(opsRoute(['status','get','--json']).op.id, 'status.get');
  for (const argv of [['status','get','--json'], ['ops','call','status.get','--json']]) {
    const result = await command(home, argv);
    assert.equal(result.code, 0, result.err);
    assert.ok(Array.isArray(result.value.blockers));
    assert.deepEqual(result.value.lending.start_failure, failure);
    assert.equal(result.value.summary.reason, 'The protected workspace could not start.');
    assert.equal(Object.hasOwn(result.value, 'start_failure'), false);
    assert.equal(Object.hasOwn(result.value, 'running'), false);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|Users|private|stack/);
  }
});

test('offline quit still requires explicit confirmation and validates inputs', async t => {
  const home = await fixture(t);
  const refused = await command(home, ['app','quit','--json']);
  assert.equal(refused.code, 6);
  assert.equal(refused.value.code, 'confirmation_required');
  assert.equal(residentQuit(home), false);
  const invalid = await command(home, ['app','quit','--yes','--unknown','--json']);
  assert.equal(invalid.code, 2);
  assert.equal(residentQuit(home), false);
});

test('confirmed CLI and ops quit persist the intent that cancels startup retry', async t => {
  const home = await fixture(t);
  for (const argv of [['app','quit','--yes','--json'], ['ops','call','app.quit','--yes','--json']]) {
    const result = await command(home, argv, {terminal:true});
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(result.value, {shuttingDown:true});
    assert.equal(residentQuit(home), true);
  }
  assert.deepEqual(JSON.parse(await readFile(join(home, 'v1', 'start-failure.json'), 'utf8')), failure);
});

test('authenticated live status wins over saved failure and performs no incidental notice request', async t => {
  const home = await fixture(t);
  const {seen} = await serverFor(t, home, () => ({body:liveStatus}));
  const result = await command(home, ['status','get','--json'], {terminal:true});
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.value, liveStatus);
  assert.deepEqual(seen.map(row => row.path), ['/api/ops/status.get']);
});

test('live shutdown keeps confirmation, exact attempt identity and app safety refusals', async t => {
  const home = await fixture(t);
  let refusal = 'job_running';
  const {seen} = await serverFor(t, home, () => ({status:409, body:{code:refusal, message:'Quit refused.'}}));
  for (const code of ['job_running','job_changed','approval_pending','cessation_unverified']) {
    refusal = code;
    const result = await command(home, ['app','quit','--attempt-id','test-attempt','--yes','--json'], {terminal:true});
    assert.equal(result.code, 4);
    assert.equal(result.value.code, code);
    assert.equal(residentQuit(home), false);
    assert.equal(seen.at(-1).headers['faravan-confirm'], 'yes');
    assert.deepEqual(seen.at(-1).body, {attemptId:'test-attempt'});
  }
  assert.ok(seen.every(row => row.path === '/api/ops/app.quit'));
});

test('accepted live shutdown is not replaced by an offline resident write or restarted by telemetry', async t => {
  const home = await fixture(t);
  const {seen} = await serverFor(t, home, () => ({body:{shuttingDown:true}}));
  const result = await command(home, ['app','quit','--yes','--json'], {terminal:true});
  assert.equal(result.code, 0, result.err);
  assert.equal(residentQuit(home), false);
  assert.deepEqual(seen.map(row => row.path), ['/api/ops/app.quit']);
});

test('HTTP errors named like local connection failures never trigger offline fallbacks', async t => {
  const home = await fixture(t);
  let problem = 'app_not_running';
  await serverFor(t, home, () => ({status:401, body:{code:problem, message:'Authentication failed.'}}));
  const client = clientFor(home);
  for (const code of ['app_not_running','app_unreachable']) {
    problem = code;
    await assert.rejects(client.call('status.get'), error => error.code === code && error.fromRest);
    await assert.rejects(client.call('app.quit', {}, {confirmed:true}), error => error.code === code && error.fromRest);
    assert.equal(residentQuit(home), false);
  }
});

test('unreachable live process exposes read-only failure evidence but never bypasses shutdown', async t => {
  const home = await fixture(t);
  const {server} = await serverFor(t, home, () => ({body:liveStatus}));
  await new Promise(resolve => server.close(resolve));
  const client = clientFor(home);
  const status = await client.call('status.get');
  assert.deepEqual(status.lending.start_failure, failure);
  assert.equal(status.lending.app_running, null);
  await assert.rejects(client.call('app.quit', {}, {confirmed:true}), {code:'app_unreachable'});
  assert.equal(residentQuit(home), false);
});

test('older live app retains authenticated direct shutdown and its refusal', async t => {
  const home = await fixture(t);
  const {seen} = await serverFor(t, home, row => row.path === '/api/shutdown'
    ? {status:409, body:{code:'job_changed', message:'The job changed.'}}
    : {status:404, body:{code:'not_found', message:'Not found.'}});
  await assert.rejects(clientFor(home).call('app.quit', {attemptId:'test-attempt'}, {confirmed:true}), {code:'job_changed'});
  assert.deepEqual(seen.map(row => row.path), ['/api/ops/app.quit','/api/ops','/api/shutdown']);
  assert.deepEqual(seen.at(-1).body, {attemptId:'test-attempt', confirmed:true});
  assert.equal(seen.at(-1).headers['faravan-confirm'], 'yes');
  assert.equal(residentQuit(home), false);
});

test('cancelled and malformed offline requests do not persist quit', async t => {
  const home = await fixture(t), abort = new AbortController();
  abort.abort();
  await assert.rejects(clientFor(home).call('app.quit', {}, {confirmed:true, signal:abort.signal}), {code:'cancelled'});
  await writeFile(join(home, 'v1', 'app.json'), '{broken');
  await assert.rejects(clientFor(home).call('app.quit', {}, {confirmed:true}), {code:'app_not_running'});
  assert.equal(residentQuit(home), false);
});

test('status without saved startup evidence retains the ordinary unavailable error when autostart is disabled', async t => {
  const home = await fixture(t, null);
  await assert.rejects(clientFor(home).call('status.get'), {code:'app_not_running'});
  await writeFile(join(home, 'v1', 'app.json'), '{broken');
  await assert.rejects(clientFor(home).call('status.get'), {code:'app_not_running'});
});
