import './helpers/no-browser.mjs';
// Consent off means zero network and nothing on disk to send (docs/design/TELEMETRY.md §4.5, §6 "Consent off => zero network").
// A journey (a response failure, a lender failure, job and setup events, a health pull, a quota window) runs under every "off"
// condition while a guard refuses every non-loopback network call. Then: turning off during an upload aborts it and purges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTelemetry, captureTransport, settle, networkGuard, ENDPOINT, RELEASE } from './helpers/telemetry-harness.mjs';
import { writeCrashFile } from '../lib/v1/telemetry/crash.mjs';

const digest = 'sha256:' + 'b'.repeat(64);
const health = () => ({readiness: {checks: [{name: 'docker_runtime', ok: true}, {name: 'sbx_install', ok: false}]}, history: {durable: true}, install: {lendingOn: true, hostsCircle: false, circles: 1, agents: ['codex']},
  quotaMeter: {ok: true}, circle: {connected: true}});

/** Each way telemetry can be off, as makeTelemetry options, and the reason `status()` must give. */
const CASES = [
  ['level=off', {level: 'off'}, {kind: 'choice'}],
  ['FARAVAN_NO_TELEMETRY=1', {env: {FARAVAN_NO_TELEMETRY: '1'}}, {kind: 'env', env: 'FARAVAN_NO_TELEMETRY'}],
  ['DO_NOT_TRACK=1', {env: {DO_NOT_TRACK: '1'}}, {kind: 'env', env: 'DO_NOT_TRACK'}],
  ['notice pending with a legacy EU region', {level: null, setup: tel => tel.view()}, {kind: 'notice_pending'}],
  ['notice pending (level unset, region US)', {level: null, setup: tel => tel.view()}, {kind: 'notice_pending'}],
  ['build OFF', {enabled: false}, {kind: 'no_upload'}],
  ['no packaged VERSION', {version: null}, {kind: 'no_upload'}],
];

/** The whole journey the design names. */
async function journey(h) {
  const { tel, clock } = h;
  tel.response({writer: 'app', req: {url: '/api/jobs', headers: {}}, status: 500, body: {code: 'internal_error', message: 'secret /home/someone/x'}});
  tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare', message: 'x'});
  tel.observe('event:lending', {account: 'codex:0', status: 'preparing'});
  clock.advance(30000);
  tel.observe('event:lending', {account: 'codex:0', status: 'finished'});
  tel.observe('event:job', {job_digest: digest, state: 'queued', job: {payload: {created_at: new Date(clock.now()).toISOString(), expires_at: new Date(clock.now() + 3600000).toISOString(), requirements: {harness: ['codex']}}}});
  clock.advance(60000);
  tel.observe('event:job', {job_digest: digest, state: 'result-accepted', attempts_started: 1, job: {payload: {requirements: {harness: ['codex']}}}});
  tel.observe('event:readiness', {});
  tel.observe('event:signin', {flowId: 'f1', status: 'starting', target: 'codex'});
  tel.observe('event:signin', {flowId: 'f1', status: 'complete', target: 'codex'});
  for (const windowKind of ['five_hour', 'seven_day']) {
    tel.observe('event:quota-window', {provider: 'codex', windowKind, plan: 'plus', lendingOn: true, ownerUsedPct: 60, lentPoints: 5, unusedPct: 30, shortfall: false, coverage: 0.9,
      contaminated: false, history: 5, slots: Array.from({length: 28}, () => ({o: 1, l: 0})), charges: [{points: 3, stopReason: 'finished'}]});
  }
  tel.ui([{kind: 'dead_end', route: 'home'}], {headers: {}});
  writeCrashFile({dir: h.dir, env: h.env ?? {}, kind: 'panic', error: new Error('x'), now: clock.now}); // an edge producer: writes only when it may
  tel.ingestInbox();
  await settle(h); // the hour closes (health pull included), housekeeping, an upload attempt
  await settle(h, {hours: 2});
  await tel.flushNow();
  tel.ingestInbox();
  await tel.flushNow();
  await tel.close();
}

const files = (dir, sub) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []);
function assertNothingOnDisk(dir, label) {
  assert.deepEqual(files(dir, 'outbox').filter(name => name.endsWith('.jsonl')), [], `${label}: outbox segments`);
  assert.deepEqual(files(dir, 'sent'), [], `${label}: sent ledger`);
  assert.deepEqual(existsSync(join(dir, 'outbox')) ? readdirSync(join(dir, 'outbox')).filter(name => /^inflight-/.test(name)) : [], [], `${label}: an in-flight batch`);
  assert.deepEqual(files(dir, 'inbox').filter(name => name.endsWith('.json')), [], `${label}: inbox files`);
}

for (const [name, spec, reason] of CASES) {
  test(`off by ${name}: zero transport calls, zero network attempts, nothing on disk to send`, async () => {
    const { setup, ...options } = spec;
    const guard = networkGuard();
    const injected = captureTransport();
    const real = []; // a second instance with no injected transport: it would use the (guarded) global fetch
    try {
      for (const variant of ['capture transport', 'global fetch']) {
        const transport = variant === 'capture transport' ? injected : (...args) => globalThis.fetch(...args);
        const h = makeTelemetry({transport, health, ...options});
        h.env = options.env;
        setup?.(h.tel);
        assert.equal(h.tel.status().effective, 'off', `${name}/${variant}: effective`);
        assert.deepEqual(h.tel.status().reason, reason, `${name}/${variant}: reason`);
        await journey(h);
        assertNothingOnDisk(h.dir, `${name}/${variant}`);
        assert.deepEqual(h.tel.preview().items, [], `${name}/${variant}: nothing to preview`);
        real.push(h);
        h.cleanup();
      }
    } finally { guard.restore(); }
    assert.equal(injected.requests.length, 0, 'no transport call');
    assert.deepEqual(guard.hits, [], 'no network attempt reached fetch, http(s), net or tls');
  });
}

test('the control journey is not vacuous: with consent on it uploads through the transport and the guard sees nothing', async () => {
  const guard = networkGuard();
  try {
    const h = makeTelemetry({health});
    await journey(h);
    const names = new Set(h.transport.records().map(record => record.name));
    for (const expected of ['problem.count', 'problem.observed.readiness', 'job.run', 'job.outcome.count', 'setup.readiness', 'quota.week', 'health.state']) assert.ok(names.has(expected), `${expected} is part of the journey`);
    assert.ok(h.transport.requests.length >= 3);
    assert.deepEqual(guard.hits, []);
    h.cleanup();
  } finally { guard.restore(); }
});

test('the guard itself refuses fetch, http, https, net and tls to a non-loopback host and allows loopback', async () => {
  const { default: http } = await import('node:http');
  const { default: https } = await import('node:https');
  const { default: net } = await import('node:net');
  const { default: tls } = await import('node:tls');
  const guard = networkGuard();
  try {
    assert.throws(() => fetch('https://telemetry.example/v1/batch'), /network guard/);
    assert.throws(() => http.request('http://203.0.113.9/x'), /network guard/);
    assert.throws(() => http.get({hostname: 'telemetry.example'}), /network guard/);
    assert.throws(() => https.request('https://telemetry.example/x'), /network guard/);
    assert.throws(() => net.connect(443, 'telemetry.example'), /network guard/);
    assert.throws(() => net.createConnection({host: '203.0.113.9', port: 80}), /network guard/);
    assert.throws(() => tls.connect({host: 'telemetry.example', port: 443}), /network guard/);
    assert.equal(guard.hits.length, 7);
    assert.doesNotThrow(() => { const request = http.request({hostname: '127.0.0.1', port: 9, path: '/'}); request.on('error', () => {}); request.destroy(); });
    assert.equal(guard.hits.length, 7, 'loopback is not a hit');
  } finally { guard.restore(); }
});

// ---- Turning off during an upload ---------------------------------------------------------------------------------

/** A transport that answers 200 at once until `hang` is set, then holds the request until its signal aborts. */
function hangingTransport() {
  const state = {hang: false, started: 0, aborted: 0, ignoreAbort: false, release: null};
  const transport = async (url, init) => {
    state.started++;
    if (!state.hang) return {status: 200, headers: new Headers(), body: {cancel: async () => {}}};
    return new Promise((resolve, reject) => {
      state.release = () => resolve({status: 200, headers: new Headers(), body: {cancel: async () => {}}});
      init.signal.addEventListener('abort', () => { state.aborted++; if (!state.ignoreAbort) reject(init.signal.reason); });
    });
  };
  transport.state = state;
  return transport;
}
const until = async (condition, label) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(condition(), label); };

test('turning off during an in-flight upload aborts the request and purges the queue, the sent ledger and the inbox', async () => {
  const transport = hangingTransport();
  const h = makeTelemetry({transport, health});
  try {
    // A past upload, so there is a sent ledger; then queued diagnostics, counts waiting in rollup and a file in the inbox.
    h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
    await settle(h);
    assert.ok(files(h.dir, 'sent').length > 0, 'a sent ledger exists');
    h.tel.observe('lender-failure', {code: 'lender_failed', phase: 'run'});
    h.tel.tick();
    assert.equal(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'panic', error: new Error('x')}), true);
    assert.ok(files(h.dir, 'inbox').length > 0);
    assert.ok(h.tel.status().outbox.queued.diagnostics > 0);
    transport.state.hang = true;
    const startedBefore = transport.state.started;
    h.clock.advance(6 * 60000);
    const flushing = h.tel.flushNow();
    await until(() => transport.state.started === startedBefore + 1 && transport.state.release, 'a further upload is in flight');

    h.tel.restrict(); // the person (or MCP) turns telemetry off now
    // The request is aborted at once (not by the 30 s request timeout), so the flush ends within moments.
    let timer;
    const outcome = await Promise.race([flushing.then(() => 'ended'), new Promise(resolve => { timer = setTimeout(() => resolve('still hanging'), 3000); })]);
    clearTimeout(timer);
    assert.equal(outcome, 'ended', 'turning off aborts the request in flight');
    assert.equal(transport.state.aborted, 1, 'the in-flight request was aborted');
    assertNothingOnDisk(h.dir, 'after off');
    assert.equal(h.tel.status().effective, 'off');
    const queued = h.tel.status().outbox.queued;
    assert.deepEqual([queued.counts, queued.diagnostics, queued.quota], [0, 0, 0]);
    // Turning it back on never sends the purged backlog.
    transport.state.hang = false;
    h.tel.choose({level: 'on'});
    h.clock.advance(HOUR_MS);
    await settle(h);
    const codes = JSON.stringify(h.transport?.requests ?? []);
    assert.ok(!codes.includes('lender_failed'), 'the purged record was not sent after re-enable');
    assert.equal(transport.state.started, startedBefore + 1, 'nothing was uploaded after the abort (no new data was captured)');
  } finally { h.cleanup(); }
});
const HOUR_MS = 3600000;

test('DEFECT: a response that races past the off switch does not refill the sent ledger or the outbox', async () => {
  const transport = hangingTransport();
  const h = makeTelemetry({transport, health});
  try {
    transport.state.hang = true;
    transport.state.ignoreAbort = true; // a transport that already has its answer in hand when the abort arrives
    h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
    h.tel.tick();
    const flushing = h.tel.flushNow();
    await until(() => transport.state.started === 1 && transport.state.release, 'the upload is in flight');
    h.tel.restrict();
    transport.state.release(); // the 200 arrives after the person turned telemetry off
    await flushing;
    assertNothingOnDisk(h.dir, 'after off with a racing response');
    assert.deepEqual(h.tel.preview().items, [], 'nothing of the old session is shown or kept');
  } finally { h.cleanup(); }
});

test('the environment switch is read once: it does not change a running instance', async () => {
  const env = {};
  const h = makeTelemetry({env});
  try {
    assert.equal(h.tel.status().effective, 'on');
    env.FARAVAN_NO_TELEMETRY = '1'; // set after the process started
    assert.equal(h.tel.status().effective, 'on', 'applies to the next process, not this one');
    const later = makeTelemetry({env: {...env}, dir: h.dir, level: null, clock: h.clock, transport: h.transport});
    assert.equal(later.tel.status().effective, 'off');
    assert.equal(later.tel.status().reason.kind, 'env');
    assert.equal(RELEASE.length > 0 && ENDPOINT.length > 0, true);
  } finally { h.cleanup(); }
});
