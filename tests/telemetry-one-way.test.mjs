import './helpers/no-browser.mjs';
// One-way (docs/design/TELEMETRY.md §1, §2.2 uploader, §5.9, §6 "One-way"): telemetry only reads what the app does. Nothing the server
// says reaches the app, no lender-side module depends on telemetry, lender decisions are the same with telemetry stalled or broken, and
// a telemetry failure leaves the app's journey green.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import { createServer } from 'node:http';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {makeTelemetry, captureTransport, ENDPOINT} from "./helpers/telemetry-harness.mjs";
import { telemetryApp } from './helpers/telemetry-app.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const failure = {code: 'sandbox_start_failed', phase: 'prepare'};

// ---- (a) The uploader reads only the status and Retry-After, and cancels the body ----------------------------------------------

/**
 * A response that records everything the uploader touches. Allowed: `status`, `headers.get('retry-after')`, `body.cancel()`. Everything else
 * (json(), text(), the stream reader, other headers, `ok`, `url`, ...) is recorded as a violation and throws.
 */
function hostileResponse({status, retryAfter = null, probe}) {
  const violate = what => { probe.violations.push(what); throw new Error('the uploader touched ' + what); };
  const stream = new ReadableStream({
    pull(controller) { probe.pulls++; controller.enqueue(new TextEncoder().encode(JSON.stringify({config: {endpoint: 'https://evil.example', interval_ms: 1, level: 'on'}, flags: {upload_everything: true, disable_consent: true}}))); },
    cancel() { probe.cancels++; },
  });
  const headers = {
    get(name) {
      const lower = String(name).toLowerCase();
      probe.headerReads.push(lower);
      return lower === 'retry-after' ? retryAfter : lower === 'x-telemetry-config' ? '{"level":"diagnostics","endpoint":"https://evil.example"}' : 'looks-like-config';
    },
    has: () => violate('headers.has'), entries: () => violate('headers.entries'), keys: () => violate('headers.keys'), values: () => violate('headers.values'), forEach: () => violate('headers.forEach'),
    [Symbol.iterator]: () => violate('headers[Symbol.iterator]'),
  };
  const body = new Proxy(stream, {get(target, prop) {
    if (prop === 'cancel') return (...args) => target.cancel(...args);
    return violate('body.' + String(prop));
  }});
  const allowed = new Set(['status', 'headers', 'body']);
  return new Proxy({status, headers, body}, {get(target, prop) {
    if (allowed.has(prop)) return target[prop];
    if (prop === 'then') return undefined; // awaited objects are probed for `then`; that is not a read of the response
    return violate('response.' + String(prop));
  }});
}
const newProbe = () => ({violations: [], headerReads: [], pulls: 0, cancels: 0});

function hostileTransport({status, retryAfter}) {
  const inner = captureTransport({status});
  const probe = newProbe();
  const transport = async (url, init) => { await inner(url, init); return hostileResponse({status, retryAfter, probe}); };
  Object.assign(transport, {requests: inner.requests, probe});
  return transport;
}
const observable = h => {
  const view = h.tel.view();
  return {upload: h.tel.status().upload, effective: h.tel.status().effective, generation: h.tel.status().generation, endpoint: view.endpoint_configured, queued: view.queued,
    requests: h.transport.requests.map(r => ({url: r.url, headers: r.headers, body: r.body, status: r.status})),
    ledger: h.tel.preview().items.map(item => ({stream: item.stream, state: item.state, status: item.status, body: item.body}))};
};
async function oneUpload(transport, seed = 5) {
  const h = makeTelemetry({transport, seed});
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  await h.tel.flushNow();
  return h;
}

for (const [status, retryAfter] of [[200, null], [202, null], [204, null], [400, null], [413, null], [415, null], [422, null], [429, '120'], [500, null], [503, '30'], [401, null], [403, null]]) {
  test(`HTTP ${status}${retryAfter ? ` (Retry-After ${retryAfter})` : ''}: only the status and Retry-After are read, the body is cancelled unread, and the result equals a plain empty reply`, async () => {
    const hostile = await oneUpload(hostileTransport({status, retryAfter}));
    const control = await oneUpload(captureTransport({respond: () => ({status, headers: retryAfter ? {'retry-after': retryAfter} : {}})}));
    try {
      const { probe } = hostile.transport;
      assert.deepEqual(probe.violations, [], 'nothing but status, retry-after and body.cancel() was touched');
      assert.ok(probe.headerReads.every(name => name === 'retry-after'), `headers read: ${probe.headerReads}`);
      assert.equal(probe.cancels, 1, 'the body was cancelled');
      assert.ok(probe.pulls <= 1, `the stream was not drained (${probe.pulls} pulls)`);
      assert.deepEqual(observable(hostile), observable(control), 'the hostile reply changed nothing beyond the status handling');
    } finally { hostile.cleanup(); control.cleanup(); }
  });
}

test('a real Response with an endless body and config-looking headers and JSON changes nothing; the stream is cancelled, not drained', async () => {
  for (const status of [200, 500]) {
    const state = {pulls: 0, cancelled: 0};
    const respond = () => {
      const stream = new ReadableStream({pull(controller) { state.pulls++; controller.enqueue(new TextEncoder().encode('{"level":"off","endpoint":"https://evil.example","config":{"x":1}}'.repeat(1000))); }, cancel() { state.cancelled++; }});
      return new Response(stream, {status, headers: {'x-telemetry-config': '{"level":"diagnostics"}', 'x-flags': 'enable_everything', 'content-type': 'application/json', 'set-cookie': 'id=1', location: 'https://evil.example/'}});
    };
    const inner = captureTransport({status});
    const transport = async (url, init) => { await inner(url, init); return respond(); };
    transport.requests = inner.requests;
    const hostile = await oneUpload(transport);
    const control = await oneUpload(captureTransport({status}));
    try {
      assert.equal(state.cancelled, 1, `${status}: cancelled`);
      assert.ok(state.pulls <= 2, `${status}: ${state.pulls} pulls (the stream's own read-ahead only)`);
      assert.deepEqual(observable(hostile), observable(control));
      assert.equal(hostile.tel.status().effective, 'on', 'consent is untouched by what the server said');
      assert.equal(hostile.transport.requests.at(-1).url, ENDPOINT);
    } finally { hostile.cleanup(); control.cleanup(); }
  }
});

test('over real HTTP: an endless response body costs a moment, not the request timeout, and the connection is closed', {timeout: 20000}, async () => {
  let sent = 0, closedAt = null, requestedAt = null;
  const server = createServer((req, res) => {
    requestedAt = Date.now();
    req.resume();
    res.writeHead(200, {'content-type': 'application/json', 'x-telemetry-config': '{"level":"diagnostics"}'});
    const pump = () => { while (res.write('{"config":"x"}'.repeat(4096))) sent += 14 * 4096; };
    res.on('drain', pump);
    res.on('close', () => { closedAt = Date.now(); });
    pump();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/batch`;
  try {
    const h = makeTelemetry({transport: (_url,init) => fetch(url,init)});
    h.tel.observe('lender-failure', failure);
    h.tel.tick();
    const t0 = Date.now();
    await h.tel.flushNow();
    assert.ok(Date.now() - t0 < 5000, `the flush took ${Date.now() - t0} ms; the timeout is 30000`);
    assert.equal(h.tel.status().upload.last.status, 200);
    assert.equal(h.tel.status().upload.failures, 0);
    for (let i = 0; i < 50 && closedAt === null; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual(closedAt, null, 'the server saw the connection close');
    assert.ok(sent < 32 * 1024 * 1024, `${sent} bytes were pushed at the client`);
    h.cleanup();
    void requestedAt;
  } finally { await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }); }
});

test('over real HTTP: a redirect is not followed (the request fails, nothing is sent to the other host)', {timeout: 20000}, async () => {
  const hits = {other: 0, first: 0};
  const other = createServer((req, res) => { hits.other++; req.resume(); res.writeHead(200); res.end('{}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const first = createServer((req, res) => { hits.first++; req.resume(); res.writeHead(307, {location: `http://127.0.0.1:${other.address().port}/stolen`}); res.end(); });
  await new Promise(resolve => first.listen(0, '127.0.0.1', resolve));
  try {
    const h = makeTelemetry({transport:(_url,init)=>fetch(`http://127.0.0.1:${first.address().port}/v1/batch`,init)});
    h.tel.observe('lender-failure', failure);
    h.tel.tick();
    await h.tel.flushNow();
    assert.equal(hits.first, 1);
    assert.equal(hits.other, 0, 'the redirect target never saw the body');
    assert.equal(h.tel.status().upload.failures, 1, 'a redirect is a failed attempt');
    h.cleanup();
  } finally { for (const server of [first, other]) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }); }
});

test('shutdown waits at most 2 s for an upload whose server never answers', {timeout: 15000}, async () => {
  const h = makeTelemetry({transport: () => new Promise(() => {})}); // ignores the abort signal too
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  void h.tel.flushNow();
  await new Promise(resolve => setImmediate(resolve));
  const t0 = Date.now();
  await h.tel.close();
  assert.ok(Date.now() - t0 < 4000, `close() took ${Date.now() - t0} ms`);
  h.cleanup();
});

// ---- (b) Import graph -----------------------------------------------------------------------------------------------------------

const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
function sourceFiles(...dirs) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { if (name !== 'node_modules') walk(file); } else out.push(file);
    }
  };
  for (const dir of dirs) walk(join(ROOT, dir));
  return out.filter(file => /\.(mjs|js|cjs)$/.test(file) || dirname(file).endsWith('/bin'));
}
function importGraph() {
  const edges = new Map();
  for (const file of sourceFiles('lib', 'bin')) {
    const targets = new Set();
    for (const match of readFileSync(file, 'utf8').matchAll(SPEC)) {
      if (!match[2].startsWith('.')) continue;
      const base = resolve(dirname(file), match[2]);
      const found = [base, base + '.mjs', base + '.js', base + '.cjs', join(base, 'index.mjs')].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (found) targets.add(found);
    }
    edges.set(file, targets);
  }
  return edges;
}
const GRAPH = importGraph();
const rel = file => relative(ROOT, file);
const isTelemetry = file => file.startsWith(join(ROOT, 'lib/v1/telemetry') + '/');
const LENDING_NAME = /^(lend|admission|docker-backend)/; // lend*, lender*, lending-*, admission*, docker-backend*
// The one list of public lending reasons is data: telemetry reads it to name its offer reasons, so a reason has one definition.
// Telemetry may import it only while it imports nothing itself, because then no path leads from telemetry to a decision.
const LENDING_DATA = new Set(['lending-reasons.mjs']);
const isLending = file => LENDING_NAME.test(basename(file)) && !LENDING_DATA.has(basename(file));
function reaches(start, wanted) {
  const seen = new Set([start]), stack = [[start, [start]]];
  while (stack.length) {
    const [file, path] = stack.pop();
    for (const next of GRAPH.get(file) ?? []) {
      if (wanted(next)) return [...path, next].map(rel);
      if (!seen.has(next)) { seen.add(next); stack.push([next, [...path, next]]); }
    }
  }
  return null;
}

test('the graph scan sees the modules the rule is about (the check is not vacuous)', () => {
  const lending = [...GRAPH.keys()].filter(isLending).map(rel);
  for (const name of ['lib/docker-backend.mjs', 'lib/v1/admission.mjs', 'lib/v1/lender.mjs', 'lib/v1/lending-pool.mjs', 'lib/v1/lending-manager.mjs', 'lib/v1/lending-policy.mjs']) assert.ok(lending.includes(name), `${name} is in the scan`);
  assert.ok([...GRAPH.keys()].filter(isTelemetry).length >= 10, 'the telemetry modules are in the scan');
  const importers = [...GRAPH].filter(([file, targets]) => !isTelemetry(file) && [...targets].some(isTelemetry)).map(([file]) => rel(file));
  assert.ok(importers.includes('lib/v1/app.mjs') && importers.includes('bin/faravan'), `known importers found: ${importers}`);
});

test('the lending data modules telemetry may import import nothing', () => {
  for (const name of LENDING_DATA) {
    const file = join(ROOT, 'lib/v1', name);
    assert.ok(GRAPH.has(file), `${name} is in the scan`);
    assert.deepEqual([...GRAPH.get(file)].map(rel), [], `${name} must stay a leaf`);
  }
});

test('no lender, lending, admission or docker-backend module imports anything from lib/v1/telemetry/, directly or through other modules', () => {
  const direct = [], transitive = [];
  for (const [file, targets] of GRAPH) {
    if (!isLending(file)) continue;
    for (const target of targets) if (isTelemetry(target)) direct.push(`${rel(file)} imports ${rel(target)}`);
    const path = reaches(file, isTelemetry);
    if (path) transitive.push(path.join(' -> '));
  }
  assert.deepEqual(direct, []);
  assert.deepEqual(transitive, []);
});

test('no module under lib/v1/telemetry/ imports a lender, lending, admission or docker-backend module (the CLI command file is the only one that reaches the operation registry)', () => {
  const direct = [], transitive = [];
  for (const [file, targets] of GRAPH) {
    if (!isTelemetry(file)) continue;
    for (const target of targets) if (isLending(target)) direct.push(`${rel(file)} imports ${rel(target)}`);
    if (basename(file) === 'cli.mjs') continue; // the `faravan telemetry` command talks to the app through the ops client, which reaches the registry
    const path = reaches(file, isLending);
    if (path) transitive.push(path.join(' -> '));
  }
  assert.deepEqual(direct, []);
  assert.deepEqual(transitive, []);
});

// ---- (c) Decision replay --------------------------------------------------------------------------------------------------------

/** A fixed sequence of lender-side calls. `between(label)` is where the other run lets telemetry do things. Returns every decision. */

/** What the app does around each lender decision: observe, tick, try to upload. */

// ---- (d) Telemetry failure leaves the app green ------------------------------------------------------------------------------------

const hostileValues = () => {
  const circular = {code: 'sandbox_start_failed'}; circular.self = circular;
  const throwing = new Proxy({}, {get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); }, has() { throw new Error('boom'); }});
  return [null, undefined, 0, NaN, 'x', 10n, Symbol('s'), () => 1, [], [[[[]]]], circular, throwing, {get code() { throw new Error('getter'); }}, {code: 'x'.repeat(10 ** 6)}, {status: 500, body: throwing}, {status: 'x', body: 'y'},
    JSON.parse('{"__proto__": {"code": "x"}}'), Object.create(null), new Date(NaN), new Map([[1, 2]])];
};

const SABOTAGE = {
  'the transport throws synchronously': h => ({transport: () => { throw new Error('boom'); }}),
  'the transport rejects': h => ({transport: async () => { throw new Error('ECONNRESET'); }}),
  'the transport rejects with a non-error': h => ({transport: () => Promise.reject('just a string')}),
  'the outbox cannot be written (its directory is a file)': h => { rmSync(join(h.dir, 'outbox'), {recursive: true}); writeFileSync(join(h.dir, 'outbox'), 'x'); },
  'rollup.json is unwritable (it is a directory)': h => { rmSync(join(h.dir, 'rollup.json'), {force: true}); mkdirSync(join(h.dir, 'rollup.json')); },
  'the inbox is a file': h => { rmSync(join(h.dir, 'inbox'), {recursive: true, force: true}); writeFileSync(join(h.dir, 'inbox'), 'x'); },
  'the sent ledger is gone': h => rmSync(join(h.dir, 'sent'), {recursive: true, force: true}),
  'everything above at once': h => { for (const name of ['outbox', 'sent', 'inbox']) { rmSync(join(h.dir, name), {recursive: true, force: true}); writeFileSync(join(h.dir, name), 'x'); } rmSync(join(h.dir, 'rollup.json'), {force: true}); mkdirSync(join(h.dir, 'rollup.json')); },
};

for (const [name, sabotage] of Object.entries(SABOTAGE)) {
  test(`${name}: observe, response, ui, ingestInbox, tick, flushNow and close never throw and raise no unhandled rejection`, async () => {
    const rejections = [], onRejection = reason => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const failing = (...args) => { throw new Error('transport never set'); };
    const options = {transport: captureTransport(), health: () => ({readiness: {checks: [{name: 'docker_runtime', ok: true}]}, install: {agents: ['codex']}})};
    const h = makeTelemetry(options);
    const replacement = sabotage(h);
    let tel = h.tel;
    if (replacement?.transport) { tel = makeTelemetry({...options, transport: replacement.transport, dir: h.dir, level: null, clock: h.clock, seed: 77}).tel; }
    void failing;
    try {
      for (let round = 0; round < 3; round++) {
        for (const value of hostileValues()) {
          for (const kind of ['response', 'lender-failure', 'health', 'ui', 'inbox', 'event:job', 'event:lending', 'event:quota-window', 'nonsense']) assert.doesNotThrow(() => tel.observe(kind, value), `observe(${kind})`);
          for (const req of [null, {}, {url: 5, headers: null}, {url: '/api/x', headers: {'faravan-surface': ['cli', 'mcp'], 'sec-gpc': 1}}, {url: '//[bad', headers: {}}]) {
            assert.doesNotThrow(() => tel.response({writer: 'app', req, status: 500, body: value, opId: 'jobs.get', durationMs: 3}), 'response() with an odd request');
          }
          assert.doesNotThrow(() => tel.response({writer: 'ops', req: {url: '/api/ops/x', headers: {}}, status: value, body: {code: value}, opId: value, durationMs: value, fromRest: value}), 'response() with odd fields');
          assert.doesNotThrow(() => tel.ui([value, {kind: value, route: value}], {headers: {}}), 'ui() with hostile records');
        }
        for (let i = 0; i < 5; i++) tel.observe('lender-failure', failure);
        tel.observe('event:lending', {account: 'codex:0', status: 'preparing'});
        h.clock.advance(61 * 60000);
        assert.doesNotThrow(() => tel.tick(), 'tick()');
        assert.doesNotThrow(() => tel.ingestInbox(), 'ingestInbox()');
        await assert.doesNotReject(async () => { await tel.flushNow(); }, 'flushNow()');
        h.clock.advance(61 * 60000);
        assert.doesNotThrow(() => tel.tick(), 'tick() again');
        await assert.doesNotReject(async () => { await tel.flushNow(); }, 'flushNow() again');
      }
      await assert.doesNotReject(async () => { await tel.close(); }, 'close()');
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(rejections, [], 'no unhandled rejection');
    } finally { process.off('unhandledRejection', onRejection); h.cleanup(); }
  });
}

test('DEFECT: response() and ui() never throw, whatever they are handed (the response observer runs inside the app\'s response writers)', () => {
  const h = makeTelemetry();
  try {
    for (const value of hostileValues()) {
      assert.doesNotThrow(() => h.tel.response(value), `response(${String(typeof value)})`);
      assert.doesNotThrow(() => h.tel.ui(value, {headers: value}), `ui(${String(typeof value)})`);
      assert.doesNotThrow(() => h.tel.ui([], value), 'ui() with hostile options');
    }
  } finally { h.cleanup(); }
});

test('with the outbox broken the read side (status, view, preview) does not throw either', async () => {
  const h = makeTelemetry();
  try {
    h.tel.observe('lender-failure', failure);
    rmSync(join(h.dir, 'outbox'), {recursive: true}); writeFileSync(join(h.dir, 'outbox'), 'x');
    assert.doesNotThrow(() => h.tel.status(), 'status()');
    assert.doesNotThrow(() => h.tel.view(), 'view() (served by GET /api/telemetry)');
    assert.doesNotThrow(() => h.tel.preview(), 'preview() (served by GET /api/telemetry/preview)');
  } finally { h.cleanup(); }
});

/** The same calls against a running app; returns what the person's side sees. */
async function appJourney(t, {broken}) {
  const failingAutostart = {setEnabled: async () => { throw new Error('cannot write /home/alice/.config/autostart/x.desktop'); }, status: async () => ({supported: true, enabled: false})};
  const parts = {transport: broken ? () => { throw new Error('ECONNREFUSED'); } : captureTransport()};
  const tele = makeTelemetry({...parts, intervals: {tick: 15, inbox: 15, upload: 15}, seed: broken ? 41 : 42, level: 'on'});
  if (broken) {
    rmSync(join(tele.dir, 'outbox'), {recursive: true}); writeFileSync(join(tele.dir, 'outbox'), 'x');
    rmSync(join(tele.dir, 'rollup.json'), {force: true}); mkdirSync(join(tele.dir, 'rollup.json'));
  }
  const x = await telemetryApp(t, {level: null, extra: {telemetry: tele.tel, autostart: failingAutostart}});
  const seen = [];
  const call = async (method, path, body, status, {compareBody = true} = {}) => {
    const response = await fetch(x.app.origin + path, {method, headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const text = await response.text();
    seen.push([method, path, response.status, compareBody ? text : '(not compared: readiness is still settling)']);
    if (status !== undefined) assert.equal(response.status, status, `${method} ${path}`);
  };
  await call('GET', '/api/folders?path=' + encodeURIComponent('/etc'), undefined, 403);
  await call('POST', '/api/desktop/autostart', {enabled: true}, 409);
  await call('POST', '/api/ops/jobs.get', {nope: 1}, 400);
  await call('POST', '/api/ops/jobs.get', {digest: 'sha256:' + '1'.repeat(64)});
  await call('POST', '/api/ops/status.blockers', {}, 200, {compareBody: false});
  await call('GET', '/api/status', undefined, 200, {compareBody: false});
  await new Promise(resolve => setTimeout(resolve, 120)); // let the fast timers run against the broken pieces
  await call('POST', '/api/ops/jobs.get', {nope: 2}, 400);
  return seen;
}

test('the app\'s journey gives the same answers with a failing transport, a broken outbox and an unwritable rollup as with healthy telemetry', {timeout: 120000}, async t => {
  const rejections = [], onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const healthy = await appJourney(t, {broken: false});
    const broken = await appJourney(t, {broken: true});
    const strip = rows => rows.map(([method, path, status, text]) => [method, path, status, text.replace(/\/[^"]*tmp[^"/]*/g, '<home>').replace(/"port":\d+/g, '"port":0')]);
    assert.deepEqual(strip(broken).map(r => r.slice(0, 3)), strip(healthy).map(r => r.slice(0, 3)), 'the same statuses');
    assert.deepEqual(strip(broken), strip(healthy), 'the same statuses and bodies');
    assert.ok(healthy.some(row => row[2] === 403) && healthy.some(row => row[2] === 409), 'the journey includes real failures');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(rejections, [], 'no unhandled rejection in the app process');
  } finally { process.off('unhandledRejection', onRejection); }
});
