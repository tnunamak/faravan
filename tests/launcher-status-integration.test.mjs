import './helpers/no-browser.mjs';
// Uses the ordinary production imports. Hosts must run this suite where the full
// status dependency tree is available; no production module is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {showStatus, readSummary} from '../lib/v1/status.mjs';

const failure = {version: 1, code: 'sandbox_start_failed', kind: 'Error', at: 123};
const liveSummary = {phase: 'ready', kind: 'ready', headline: 'Ready for requests', label: 'Lending on',
  reason: 'This computer is ready.', action: null};
const device = {keyId: 'a'.repeat(64), listCircles: async () => []};

async function fixture(t, saved = failure) {
  const home = await mkdtemp(join(tmpdir(), 'launcher-status-integration-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, 'v1'));
  if (saved !== null) await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify(saved));
  return home;
}

async function status(home, argv = ['--json']) {
  let out = '', err = '';
  const code = await showStatus(argv, {home, device, diskLedgerFile: join(home, 'disk-ledger.json'), storeFree: async () => null,
    stdout: {write: text => { out += text; }}, stderr: {write: text => { err += text; }}});
  assert.equal(code, 0, err || out);
  assert.equal(err, '');
  return argv.includes('--json') ? JSON.parse(out) : out;
}

async function liveApp(t, home, {lendingCode = 200, statusCode = 200} = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.headers['x-faravan-session-token'] !== 'test-session' || req.headers['x-faravan-session-token'] !== 'test-session') {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = req.url === '/api/lending' ? lendingCode : statusCode;
    res.end(JSON.stringify(req.url === '/api/lending' ? {enabled: true, intent: 'on'} : {summary: liveSummary}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await writeFile(join(home, 'v1', 'app.json'), JSON.stringify({pid: process.pid, port: server.address().port, token: 'test-session'}));
  return seen;
}

test('normal JSON status keeps device/circles/jobs/disk and adds the saved startup failure', async t => {
  const home = await fixture(t, {...failure, message: 'private-token', stack: '/Users/private'});
  const result = await status(home);
  assert.deepEqual(Object.keys(result).sort(), ['circles', 'device', 'disk', 'jobs', 'lending']);
  assert.equal(result.device.key_id, device.keyId);
  assert.deepEqual(result.circles, []);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.lending.app_running, false);
  assert.equal(result.lending.enabled, false);
  assert.equal(result.lending.status, 'Faravan could not start');
  assert.equal(result.lending.summary.reason, 'The protected workspace could not start.');
  assert.deepEqual(result.lending.start_failure, failure);
  assert.equal(result.lending.starting_assumption, null);
  assert.deepEqual(result.lending.status_lines, []);
  assert.doesNotMatch(JSON.stringify(result), /private-token|Users|stack/);
});

test('normal text status explains a saved startup failure in fixed words', async t => {
  const home = await fixture(t);
  const text = await status(home, []);
  assert.match(text, /Lending:     Faravan could not start/);
  assert.match(text, /Why:         The protected workspace could not start\./);
  assert.match(text, /This device:/);
  assert.match(text, /Circles:/);
  assert.doesNotMatch(text, /sandbox_start_failed|verdict|receipt|attempt|settled|lease/);
  assert.equal((await readSummary(home)).headline, 'Faravan could not start');
});

test('normal status prefers the authenticated live app over an older startup failure', async t => {
  const home = await fixture(t), seen = await liveApp(t, home);
  const result = await status(home);
  assert.deepEqual(seen, ['/api/lending', '/api/status']);
  assert.equal(result.lending.app_running, true);
  assert.equal(result.lending.enabled, true);
  assert.deepEqual(result.lending.summary, liveSummary);
  assert.equal(result.lending.status, liveSummary.headline);
  assert.equal(Object.hasOwn(result.lending, 'start_failure'), false);
});

test('one authenticated live status response prevents a stale startup failure override', async t => {
  const home = await fixture(t);
  await liveApp(t, home, {lendingCode: 503});
  const result = await status(home);
  assert.equal(result.lending.app_running, null);
  assert.deepEqual(result.lending.summary, liveSummary);
  assert.equal(Object.hasOwn(result.lending, 'start_failure'), false);
  assert.deepEqual(await readSummary(home), liveSummary);
});

test('failed authentication does not hide a saved startup failure', async t => {
  const home = await fixture(t);
  await liveApp(t, home, {lendingCode: 401, statusCode: 401});
  const result = await status(home);
  assert.equal(result.lending.app_running, null);
  assert.equal(result.lending.enabled, null);
  assert.deepEqual(result.lending.start_failure, failure);
  assert.equal(result.lending.read_error, 'The app did not answer.');
  assert.match(await status(home, []), /Why:         The protected workspace could not start\./);
});

test('live lending also wins when the summary endpoint cannot answer', async t => {
  const home = await fixture(t);
  await liveApp(t, home, {statusCode: 503});
  const result = await status(home);
  assert.equal(result.lending.app_running, true);
  assert.equal(result.lending.enabled, true);
  assert.equal(Object.hasOwn(result.lending, 'start_failure'), false);
  assert.equal(await readSummary(home), null);
});

test('malformed app and startup files cannot inject raw diagnostic text', async t => {
  const home = await fixture(t);
  await writeFile(join(home, 'v1', 'app.json'), '{"private-token": /Users/private}');
  const result = await status(home);
  assert.deepEqual(result.lending.start_failure, failure);
  assert.doesNotMatch(JSON.stringify(result), /private-token|Users/);
  await writeFile(join(home, 'v1', 'start-failure.json'), '{malformed');
  await rm(join(home, 'v1', 'app.json'));
  const without = await status(home);
  assert.equal(without.lending.status, 'Not running');
  assert.equal(without.lending.summary, null);
  assert.equal(Object.hasOwn(without.lending, 'start_failure'), false);
});

test('status prints each cleanup item once while another account can lend',async t=>{
 const home=await fixture(t,null),message='Sandbox wf-0000000000000001 still has access rules left. Choose Clean up now to retry.';
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/lending'?{enabled:true,intent:'on'}:{summary:liveSummary,cleanup:{items:[{id:'fixture',message,action:'Clean up now'}]}}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 await writeFile(join(home,'v1','app.json'),JSON.stringify({pid:process.pid,port:server.address().port,token:'test-session'}));
 const text=await status(home,[]);assert.equal(text.split(message).length-1,1);assert.match(text,/Ready for requests/);assert.doesNotMatch(text,/undefined/);
 const json=await status(home);assert.deepEqual(json.lending.cleanup_items,[{id:'fixture',message,action:'Clean up now'}]);
});
