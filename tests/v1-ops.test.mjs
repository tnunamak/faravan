import './helpers/no-browser.mjs';
// The operation registry and its HTTP surface: every operation is well formed, reachable over POST /api/ops/<id>,
// confirmation and idempotency keys behave the same for every caller, and the published OpenAPI matches the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OPS, opById, SURFACE_NAME } from '../lib/v1/ops/registry.mjs';
import { check, validate } from '../lib/v1/ops/schema.mjs';
import { appRequest, runOp, restRequest, exitCodeFor, EXIT, opError, problemOf } from '../lib/v1/ops/execute.mjs';
import { runOpsCommand } from '../lib/v1/ops/cli.mjs';
import { createOpsHttp } from '../lib/v1/ops/http.mjs';
import { appFixture, api, boundedFetch } from './helpers/v1-app-fixture.mjs';

// Sends go only to circles whose membership is approved (job-recipient.mjs), so the fixture must show that.
const approvedCircle = circle => ({...circle,enrollment:{state:'approved'},rosterMembershipVerified:true});

test('every operation is well formed', () => {
  const ids = new Set(), mcp = new Set(), cli = new Set();
  for (const op of OPS) {
    assert.match(op.id, /^[a-z]+(_[a-z]+)*(\.[a-z]+(_[a-z]+)*)+$/, op.id);
    assert.ok(!ids.has(op.id), 'duplicate ' + op.id); ids.add(op.id);
    assert.ok(op.title && op.description, op.id + ' has a title and description');
    assert.ok(['read','write','consequential','human'].includes(op.safety), op.id);
    assert.ok(['safe','key','none'].includes(op.idempotency), op.id);
    assert.ok(Boolean(op.rest) !== Boolean(op.handler), op.id + ': exactly one of a route binding or a handler');
    assert.equal(op.input.type, 'object', op.id); assert.equal(op.input.additionalProperties, false, op.id + ' rejects unknown input');
    assert.ok(op.output && typeof op.output === 'object', op.id + ' declares an output schema');
    if (op.safety === 'consequential') assert.equal(typeof op.confirm, 'function', op.id + ' says what it will do');
    if (op.rest) for (const [, name] of op.rest.path.matchAll(/\{(\w+)\}/g))
      assert.ok((op.input.required ?? []).includes(name), op.id + ': path parameter ' + name + ' is required input');
    const tool = SURFACE_NAME.mcp(op), command = SURFACE_NAME.cli(op);
    assert.match(tool, /^[a-zA-Z0-9_-]{1,64}$/, tool);
    assert.ok(!mcp.has(tool) && !cli.has(command), 'unique names for ' + op.id); mcp.add(tool); cli.add(command);
  }
});

test('the validator accepts what the schema allows and names the field it refuses', () => {
  const schema = opById('jobs.submit').input;
  assert.equal(check(schema, {circle:'Friends', prompt:'Fix it', git:{url:'https://example.test/r.git', commit:'a'.repeat(40)}}), null);
  assert.throws(() => validate(schema, {circle:'Friends', prompt:'x', unknown:1}), {code:'invalid_request', field:'unknown'});
  assert.throws(() => validate(schema, {}), {field:'prompt'});
  assert.throws(() => validate(schema, {circle:'Friends', prompt:'x', egress:'everywhere'}), {field:'egress'});
  assert.throws(() => validate(schema, {circle:'Friends', prompt:'x', git:{url:'u', commit:'short'}}), {field:'git.commit'});
  assert.throws(() => validate(opById('jobs.wait').input, {digest:'abcdef', timeout_seconds:301}), {field:'timeout_seconds'});
  assert.equal(check({type:['integer','null']}, null), null);
  assert.ok(check({type:'integer'}, 1.5));
});

test('unknown submission outcome and operation key survive shared API, CLI, and MCP contracts', () => {
  const operationKey = 'original-host-operation-key';
  const error = opError('network_error', 503, 'The host response was lost.', {outcome:'unknown', operationKey});
  assert.deepEqual(problemOf(error), {
    code:'network_error', message:'The host response was lost.', outcome:'unknown', operationKey,
  });
  for (const id of ['jobs.submit','jobs.send_and_wait']) {
    const output = opById(id).output;
    assert.equal(output.properties.operationKey.type, 'string', id + ' exposes the host idempotency key');
    assert.ok(output.required.includes('operationKey'), id + ' requires the key in its successful response');
  }
});

test('ops HTTP preserves unknown outcomes and retries the same key through the durable send path', async t => {
  const submissionBodies = [];
  let origin;
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/api/circles') {
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify([approvedCircle({id:'Friends',name:'Friends',origin:'https://friends.example'})]));
        return;
      }
      if (path === '/api/jobs' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        submissionBodies.push(JSON.parse(text));
        res.writeHead(503, {'content-type':'application/json'});
        res.end(JSON.stringify({code:'network_error',message:'The host response was lost.',outcome:'unknown',operationKey:'host-key-1023'}));
        return;
      }
      if (await ops(req, res, path.split('/').filter(Boolean))) return;
      res.writeHead(404, {'content-type':'application/json'}); res.end('{}');
    })().catch(error => res.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const ops = createOpsHttp({home:'/tmp',token:'synthetic-session',origin:()=>origin});
  const input = {circle:'Friends',prompt:'Send one job',git:{url:'https://friends.example/project.git',commit:'a'.repeat(40)}};
  const send = (body=input) => fetch(origin + '/api/ops/jobs.submit', {method:'POST',headers:{
    'content-type':'application/json','faravan-confirm':'yes','idempotency-key':'ops-key-1023',
  },body:JSON.stringify(body)});

  const first = await send(), firstBody = await first.json();
  assert.equal(first.status, 503);
  assert.equal(firstBody.outcome, 'unknown');
  assert.equal(firstBody.operationKey, 'host-key-1023');
  const reused = await send({...input,prompt:'A different request'}), reusedBody=await reused.json();
  assert.equal(reused.status,409);
  assert.equal(reusedBody.code,'idempotency_key_reused');
  const retry = await send(), retryBody = await retry.json();
  assert.equal(retry.status, 503);
  assert.equal(retryBody.operationKey, 'host-key-1023');
  assert.equal(submissionBodies.length, 2, 'unknown is not frozen in the ops HTTP answer cache');
  assert.deepEqual(submissionBodies.map(body => body.draft_id), ['ops-key-1023','ops-key-1023']);
});

test('CLI JSON keeps an unknown submit outcome and host operation key', async () => {
  const operationKey = 'cli-host-key-1023', stdout = [], stderr = [];
  const client = {call:async id => {
    if (id === 'circles.list') return [approvedCircle({id:'Friends',name:'Friends',origin:'https://friends.example'})];
    throw opError('network_error',503,'The host response was lost.',{outcome:'unknown',operationKey});
  }};
  const status = await runOpsCommand(['ops','call','jobs.submit','--input',JSON.stringify({circle:'Friends',prompt:'Send one job',git:{url:'https://friends.example/project.git',commit:'a'.repeat(40)}}),'--yes','--json'], {
    client,stdout:{write:value=>stdout.push(value)},stderr:{write:value=>stderr.push(value)},
  });
  assert.equal(status, 1);
  assert.equal(JSON.parse(stdout.join('')).outcome, 'unknown');
  assert.equal(JSON.parse(stdout.join('')).operationKey, operationKey);
  assert.deepEqual(stderr, []);
});

test('route bindings put input in the path, the query or the body, and add fixed fields', () => {
  assert.deepEqual(restRequest(opById('jobs.get'), {digest:'sha256:' + 'a'.repeat(64), circle:'c 1'}),
    {method:'GET', path:'/api/jobs/sha256%3A' + 'a'.repeat(64), query:{circle:'c 1'}});
  assert.deepEqual(restRequest(opById('lending.stop_job'), {attemptId:'a1'}), {method:'POST', path:'/api/lending/stop', body:{attemptId:'a1', confirmed:true}});
  assert.deepEqual(restRequest(opById('jobs.apply_preview'), {digest:'sha256:' + 'b'.repeat(64), circle:'c'}).body, {circle:'c', dry_run:true});
  assert.deepEqual(restRequest(opById('app.quit'), {}).body, {});
  assert.deepEqual(restRequest(opById('app.quit'), {attemptId:'x'}).body, {attemptId:'x', confirmed:true});
});

test('a consequential operation never runs without confirmation, on any surface', async () => {
  let called = false;
  const ctx = {rest:async () => { called = true; return {}; }};
  await assert.rejects(runOp('lending.on', {}, ctx), error => {
    assert.equal(error.code, 'confirmation_required'); assert.equal(error.status, 428);
    assert.match(error.effect, /jobs from other people will run on this computer/);
    assert.equal(exitCodeFor(error), EXIT.confirmation_required);
    return true;
  });
  assert.equal(called, false);
  await runOp('lending.on', {}, {...ctx, confirmed:true});
  assert.equal(called, true);
  await assert.rejects(runOp('uninstall.run', {}, {}), {code:'human_only'});
  await assert.rejects(runOp('nope.nothing', {}, {}), {code:'unknown_operation'});
});

const call = (app, id, body = {}, headers = {}, status = 200) =>
  api(app, '/api/ops/' + id, {method:'POST', body, headers, status});

test('POST /api/ops/<id> runs the same route the web app uses, with confirmation and idempotency keys', {timeout:120000}, async t => {
  const f = await appFixture(t), {app} = await f.start('ops-http');
  // Discovery and description.
  const listing = await api(app, '/api/ops');
  assert.equal(listing.version, 1);
  assert.deepEqual(listing.ops.map(o => o.id).sort(), OPS.map(o => o.id).sort());
  const described = await api(app, '/api/ops/jobs.submit');
  assert.deepEqual(described.input, JSON.parse(JSON.stringify(opById('jobs.submit').input)));
  assert.equal(described.mcp, 'jobs_submit');
  assert.equal(described.description,opById('jobs.submit').description,'full descriptions remain available after compact discovery');
  // Same answer as the REST route.
  assert.deepEqual(await call(app, 'lending.get'), await api(app, '/api/lending'));
  assert.deepEqual(await call(app, 'agents.list'), await api(app, '/api/agents'));
  // Input is checked against the schema before anything runs.
  const refused = await call(app, 'lending.pause', {until:'soon'}, {}, 400);
  assert.equal(refused.code, 'invalid_request'); assert.equal(refused.field, 'until');
  await call(app, 'nothing.here', {}, {}, 404);
  // Consequential: 428 with the effect, then the route itself decides.
  const needs = await call(app, 'lending.on', {}, {}, 428);
  assert.equal(needs.code, 'confirmation_required'); assert.match(needs.effect, /other people/);
  const attempted = await api(app, '/api/ops/lending.on', {method:'POST', body:{}, headers:{'faravan-confirm':'yes'}, status:409});
  assert.notEqual(attempted.code, 'confirmation_required', 'confirmed: the app\'s own readiness rules answer');
  // Human-only operations are not offered over HTTP.
  assert.equal((await call(app, 'uninstall.run', {}, {}, 403)).code, 'human_only');
  // Idempotency-Key: the same key and input replays the first answer; a different input is refused.
  const first = await boundedFetch(app.origin + '/api/ops/app.open_link', {method:'POST',
    headers:{'x-faravan-session-token':app.token, 'content-type':'application/json', 'idempotency-key':'retry-1'}, body:'{}'});
  const again = await boundedFetch(app.origin + '/api/ops/app.open_link', {method:'POST',
    headers:{'x-faravan-session-token':app.token, 'content-type':'application/json', 'idempotency-key':'retry-1'}, body:'{}'});
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(await again.json(), await first.json(), 'one sign-in link, not two');
  const changed = await call(app, 'limits.set', {dailyJobs:2}, {'idempotency-key':'retry-2'});
  assert.equal(changed.limits.dailyJobs, 2);
  assert.equal((await call(app, 'limits.set', {dailyJobs:3}, {'idempotency-key':'retry-2'}, 409)).code, 'idempotency_key_reused');
  // A route's own not_found passes through unchanged (the client does not mistake it for an older app).
  assert.equal((await call(app, 'approvals.accept', {id:'no-such-card'}, {'faravan-confirm':'yes'}, 404)).code, 'not_found');
  // Handlers compose operations: limits.get reads lending.get.
  assert.equal((await call(app, 'limits.get')).limits.dailyJobs, 2);
  // Without the session token nothing is described or run.
  await api(app, '/api/ops', {token:null, status:401});
  await api(app, '/api/ops/status.get', {method:'POST', body:{}, token:null, status:401});
});

test('the published OpenAPI document is the one the registry generates', async () => {
  const {readFile} = await import('node:fs/promises');
  const {openApiDocument} = await import('../lib/v1/ops/http.mjs');
  const committed = JSON.parse(await readFile(new URL('../docs/protocol/app-openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(openApiDocument())), 'run npm run gen:ops and commit the result');
  const ids = Object.values(committed.paths).flatMap(item => Object.values(item).map(entry => entry.operationId));
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
});

test('generated app and coordinator OpenAPI documents describe decline', {timeout:120000}, async t => {
  const {readFile}=await import('node:fs/promises');
  const f=await appFixture(t),{app}=await f.start('decline-openapi');
  const live=await api(app,'/api/openapi.json');
  const committed=JSON.parse(await readFile(new URL('../docs/protocol/app-openapi.json',import.meta.url),'utf8'));
  assert.deepEqual(live,committed);
  assert.equal(live.paths['/api/ops/approvals.decline'].post.operationId,'approvals.decline');
  assert.equal(live.paths['/api/approvals/{id}/decline'].post.operationId,'approvals.decline.rest');
  const coordinator=JSON.parse(await readFile(new URL('../docs/protocol/openapi.yaml',import.meta.url),'utf8'));
  const operation=coordinator.paths['/v1/circles/{circle_id}/jobs/{job_digest}/decline'].post;
  assert.equal(operation.operationId,'declineJob');
  assert.ok(operation.responses['200']);
});

test('limits.set needs confirmation only when it switches a circle to auto', async () => {
  const sent = [];
  const ctx = {rest:async (method, path, request) => { sent.push(request.body); return {}; }};
  await runOp('limits.set', {dailyJobs:2}, ctx);
  await runOp('limits.set', {mode:'ask', circle:'c'}, ctx);
  await assert.rejects(runOp('limits.set', {mode:'auto', circle:'c'}, ctx), {code:'confirmation_required'});
  await runOp('limits.set', {mode:'auto', circle:'c'}, {...ctx, confirmed:true});
  assert.equal(sent.length, 3);
});

test('a wait is bounded even when the app stops answering mid-read', async t => {
  // A real HTTP read keeps the event loop alive; this signal-only fake needs its own handle.
  const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
  const {pollUntil} = await import('../lib/v1/ops/registry.mjs');
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  const started = Date.now();
  await assert.rejects(pollUntil({readGraceMs:50}, hang, () => false, 0.1), {code:'timeout'});
  let reads = 0;
  const second = signal => ++reads === 1 ? Promise.resolve({state:'queued'}) : hang(signal);
  assert.deepEqual(await pollUntil({readGraceMs:50, pollMs:10}, second, v => v.state === 'done', 0.1), {done:false, value:{state:'queued'}});
  assert.ok(Date.now() - started < 3000, 'both waits ended near their deadline');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(pollUntil({signal:cancelled.signal}, async () => ({}), () => false, 10));
});

test('lending.log output allows a row whose code was not a known one (the legacy command shows it too)', () => {
  validate(opById('lending.log').output, [{at:'2026-10-19T00:00:00.000Z', job:null, title:null, code:null, phase:null, message:'Something went wrong.'}]);
});

test('--no-<field> is only for true/false fields; numbers never silently become 0', async () => {
  const {parseOpArgs} = await import('../lib/v1/ops/cli.mjs');
  await assert.rejects(parseOpArgs(opById('limits.set'), ['--no-quota-reserve']), {code:'invalid_request'});
  await assert.rejects(parseOpArgs(opById('events.list'), ['--no-after']), {code:'invalid_request'});
  assert.deepEqual((await parseOpArgs(opById('limits.set'), ['--no-idle-only'])).input, {idleOnly:false});
  assert.deepEqual((await parseOpArgs(opById('agents.select'), ['codex', '--use-for-lending'])).input, {id:'codex', useForLending:true});
});

test('a CLI or MCP client meeting an app from before /api/ops calls its routes directly', async t => {
  const {createServer} = await import('node:http');
  const {mkdtemp, mkdir, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createOpsClient} = await import('../lib/v1/ops/execute.mjs');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    const body = req.url === '/api/lending' ? {enabled:false, limits:{}, configVersion:0} : {code:'not_found', message:'API endpoint not found.'};
    res.writeHead(req.url === '/api/lending' ? 200 : 404, {'content-type':'application/json'}); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'faravan-old-app-'));
  t.after(async () => { server.close(); await rm(home, {recursive:true, force:true}); });
  await mkdir(join(home, 'v1'));
  await writeFile(join(home, 'v1', 'app.json'), JSON.stringify({port:server.address().port, token:'old-app', pid:process.pid}));
  const client = createOpsClient({home, autostart:false});
  assert.equal((await client.call('lending.get', {})).enabled, false);
  assert.deepEqual(seen, ['POST /api/ops/lending.get', 'GET /api/ops', 'GET /api/lending']);
  await assert.rejects(client.call('lending.on', {}), {code:'confirmation_required'}, 'confirmation is still required');
});

test('a not_found from a current app is the answer, not a sign of an older app', {timeout:120000}, async t => {
  const {createOpsClient} = await import('../lib/v1/ops/execute.mjs');
  const f = await appFixture(t), {home} = await f.start('not-found');
  const client = createOpsClient({home, autostart:false});
  await assert.rejects(client.call('approvals.accept', {id:'no-such-card'}, {confirmed:true}), {code:'not_found', status:404});
  await assert.rejects(client.call('approvals.accept', {id:'no-such-card'}), {code:'confirmation_required'}, 'still sent through /api/ops');
});
