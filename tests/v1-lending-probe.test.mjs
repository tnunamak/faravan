import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROBE_USAGE_LINE, guestProbeArgv, guestProbeScript, parseProbeOutput, createLendingProbe, createLendingReadings, PROBE_REQUESTS } from '../lib/v1/lending-probe.mjs';
import { createLendingLedger } from '../lib/v1/lending-ledger.mjs';
import { createPace50Candidate } from '../lib/v1/lender-pace50.mjs';
import {sanitizeProbeDiagnostics} from '../lib/v1/probe-diagnostics.mjs';

function assertResultDiagnostics(result, expected, phases = null, failedPhase = undefined) {
  const {probe_diagnostics, failed_phase, ...rest} = result;
  assert.deepEqual(rest, expected);
  if (phases === null) {
    assert.equal(probe_diagnostics, undefined, 'a runner that records no phases has no diagnostic receipt');
  } else {
    assert.deepEqual(sanitizeProbeDiagnostics(probe_diagnostics), probe_diagnostics);
    assert.deepEqual(probe_diagnostics.phases.map(p => [p.phase, p.outcome]), phases);
    assert.doesNotMatch(JSON.stringify(probe_diagnostics), /private|SECRET|argv|stderr|HOME/);
  }
  assert.equal(failed_phase, failedPhase);
}

const T = Date.parse('2026-10-20T13:31:00Z');
const CODEX_BODY = { account_id: 'acct-SECRET', email: 'someone@example.com', user_id: 'user-SECRET', plan_type: 'pro',
  rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 33, limit_window_seconds: 604800, reset_at: 1793082726, reset_after_seconds: 1, extra: 'x' }, secondary_window: null },
  credits: { has_credits: false, balance: '17' }, spend_control: { reached: false, individual_limit: 5 } };
const CLAUDE_BODY = { five_hour: { utilization: 25, resets_at: '2026-10-20T16:19:59.550398Z', used_dollars: null },
  seven_day: { utilization: 37, resets_at: '2026-10-23T01:59:59.550422Z' }, seven_day_opus: null, spend: { used: { amount_minor: 5 } },
  extra_usage: { is_enabled: false, used_credits: null }, limits: [{ kind: 'session', group: 'g', percent: 25, resets_at: '2026-10-20T16:20:00Z', is_active: true }] };

// The guest script talks HTTPS to the provider through the guest's proxy. Offline, an HTTP proxy on loopback stands in:
// the provider URL is rewritten to http:// (urllib uses http_proxy for it) and the proxy answers as the provider.
function runThroughProxy(provider, body, status = 200) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const proxy = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    proxy.listen(0, '127.0.0.1', () => {
      // Every provider URL the guest script calls goes through the loopback proxy, including an identity read.
      let script = guestProbeScript(provider);
      for (const url of [PROBE_REQUESTS[provider].url, PROBE_REQUESTS[provider].identity?.url].filter(Boolean)) {
        script = script.replace(url, url.replace('https://', 'http://'));
      }
      execFile('python3', ['-I', '-c', script], { env: { PATH: process.env.PATH, http_proxy: 'http://127.0.0.1:' + proxy.address().port }, timeout: 30000 },
        (err, stdout) => { proxy.close(); err ? reject(err) : resolve({ stdout, seen }); });
    });
  });
}

test('guest probe argv is python3 -c (the Phase 0 transport that honours the guest proxy)', () => {
  for (const p of ['claude', 'codex']) {
    const argv = guestProbeArgv(p);
    assert.equal(argv[0], 'python3'); assert.equal(argv[1], '-c'); assert.match(argv[2], /urllib\.request/);
  }
  assert.throws(() => guestProbeScript('gemini'));
});

test('Codex probe: goes through the proxy with only the placeholder bearer, prints no account identifiers', async () => {
  const { stdout, seen } = await runThroughProxy('codex', CODEX_BODY);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://chatgpt.com/backend-api/wham/usage', 'absolute-URI request: the proxy was used');
  assert.equal(seen[0].headers.authorization, 'Bearer proxy-managed');
  assert.doesNotMatch(stdout, /SECRET|example\.com|balance|individual_limit|extra/);
  const out = parseProbeOutput('codex', stdout, T);
  assert.equal(out.status, 200);
  assert.deepEqual(out.readings.map(r => [r.window_id, r.used_pct, new Date(r.resets_at).toISOString(), r.source]), [['codex:10080', 33, '2026-10-27T06:32:06.000Z', 'probe']]);
  assert.equal(out.limit_reached, false); assert.equal(out.plan_type, 'pro');
});

test('Claude probe: placeholder OAuth bearer and beta header; windows parsed; spend fields dropped', async () => {
  const { stdout, seen } = await runThroughProxy('claude', CLAUDE_BODY);
  assert.equal(seen[0].headers.authorization, 'Bearer sk-ant-oat01-proxy-managed');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.doesNotMatch(stdout, /amount_minor|used_dollars|used_credits|group/);
  const out = parseProbeOutput('claude', stdout, T);
  assert.deepEqual(out.readings.map(r => [r.window_id, r.used_pct]), [['five_hour', 25], ['seven_day', 37]]);
});

// 429 is retried inside the guest (see the scripted tests at the end of this file), so this one uses a status that is not retried.
test('non-200 statuses are reported, not parsed', async () => {
  const { stdout } = await runThroughProxy('claude', { error: 'x' }, 403);
  // The guest skips the identity read when usage did not answer 200.
  assert.deepEqual(parseProbeOutput('claude', stdout, T), { status: 403, readings: [],
    probe: { usage_status: 403, identity_status: null, usage_attempts: 1, identity_attempts: null } });
  assert.equal(parseProbeOutput('claude', 'garbage', T), null);
});

test('the guest prints its usage line before it reads identity, and reads no identity when usage is not 200', async () => {
  const ok = await runThroughProxy('claude', CLAUDE_BODY);
  const lines = ok.stdout.trim().split('\n');
  assert.ok(lines[0].startsWith(PROBE_USAGE_LINE), 'the first line out is the usage line');
  assert.ok(lines.length >= 2 && lines[lines.length - 1].includes('"faravan_probe"'), 'the full reading follows it');
  assert.deepEqual(ok.seen.map(r => r.url.includes('usage')), [true, false], 'usage was asked first, then identity');
  const refused = await runThroughProxy('claude', { error: 'x' }, 403);
  assert.equal(refused.seen.length, 1, 'no identity request after a usage refusal');
  assert.ok(refused.stdout.trim().split('\n')[0].startsWith(PROBE_USAGE_LINE));
});

test('probe service: records readings in the ledger, backs off after 429, respects cadence', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'lending-probe-test-'));
  try {
    let t = T, status = 200;
    const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => t });
    const calls = [];
    const runGuest = async ({ provider, argv }) => {
      calls.push({ provider, argv });
      return { exitCode: 0, stdout: JSON.stringify({ faravan_probe: 1, status, body: status === 200 ? { rate_limit: CODEX_BODY.rate_limit } : {} }) + '\n' };
    };
    const probe = createLendingProbe({ runGuest, ledger, now: () => t });
    assert.equal(probe.due('codex', { autoLending: true }), true);
    assert.equal((await probe.probe('codex')).ok, true);
    assert.equal(calls[0].argv[0], 'python3');
    assert.equal(ledger.snapshot('codex', { plan: 'pro' }).windows[0].used_pct, 33);
    t += 10 * 60000;
    assert.equal(probe.due('codex', { autoLending: true }), false);
    assert.equal(probe.due('codex', { pageOpen: true }), false);
    t += 21 * 60000;
    assert.equal(probe.due('codex', { autoLending: true }), true);
    assert.equal(probe.due('codex', { autoLending: true, jobRunning: true }), false);
    status = 429;
    const limited = await probe.probe('codex');
    assert.equal(limited.reason, 'rate_limited'); assert.equal(limited.status_class, '4xx'); assert.equal(limited.retry_at, t + 5 * 60000);
    t += 31 * 60000;
    assert.equal((await probe.probe('codex')).retry_at, t + 10 * 60000, 'back-off doubles');
    assert.equal(probe.due('codex', { autoLending: true }), false);
    // It keeps doubling, stops at the 60-minute cap, and starts over at 5 minutes after one success.
    for (const minutes of [20, 40, 60, 60]) {
      t += 61 * 60000;
      assert.equal((await probe.probe('codex')).retry_at, t + minutes * 60000, `back-off ${minutes} min`);
    }
    status = 200; t += 61 * 60000;
    assert.equal((await probe.probe('codex')).ok, true);
    status = 429; t += 31 * 60000;
    assert.equal((await probe.probe('codex')).retry_at, t + 5 * 60000, 'a success resets the back-off to 5 minutes');
    const failing = createLendingProbe({ runGuest: async () => { throw new Error('no sandbox'); }, ledger, now: () => t });
    assertResultDiagnostics(await failing.probe('claude'), { ok: false, reason: 'guest_failed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public probe failures keep a closed reason set and only validated HTTP status classes', async t => {
  const cases = [
    [429, 'rate_limited', '4xx'], [401, 'auth', '4xx'], [403, 'auth', '4xx'],
    [500, 'provider_error', '5xx'], [503, 'provider_error', '5xx'], [404, 'http_error', '4xx'],
    [-1, 'unreadable', null], [0, 'unreadable', null], [600, 'unreadable', null], ['503', 'unreadable', null],
  ];
  for (const [status, reason, statusClass] of cases) {
    const dir = mkdtempSync(join(homedir(), '.tmp', 'probe-failure-envelope-'));
    try {
      let at = T, calls = 0;
      const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => at});
      const probe = createLendingProbe({ledger, now: () => at, runGuest: async () => {
        calls++;
        return {stdout: JSON.stringify({faravan_probe: 1, status, body: {secret: 'BODY_MARKER'},
          identity: {status: 200, email: 'IDENTITY_MARKER'}, url: 'URL_MARKER'})};
      }});
      const direct = await probe.probe('claude');
      assert.equal(direct.ok, false);
      const readingProbe = createLendingProbe({ledger, now: () => at, runGuest: async () => {
        calls++;
        return {stdout: JSON.stringify({faravan_probe: 1, status, body: {secret: 'BODY_MARKER'},
          identity: {status: 200, email: 'IDENTITY_MARKER'}, url: 'URL_MARKER'})};
      }});
      const reading = await createLendingReadings({ledger, probe: readingProbe, now: () => at})('claude', {forceRefresh: true});
      assert.equal(reading.refresh_succeeded, false);
      assert.equal(reading.probe.reason, reason);
      assert.equal(reading.probe.status_class ?? null, statusClass);
      assert.equal(reading.probe.provider, 'claude');
      assert.equal(reading.probe.failure_class, status === 429 ? 'rate_limited'
        : Number.isInteger(status) && status >= 100 && status <= 599 ? `usage_http_${status}` : 'parse_failed');
      assert.equal(calls, 2, 'one direct probe and one required refresh ran');
      assert.doesNotMatch(JSON.stringify(reading), /BODY_MARKER|IDENTITY_MARKER|URL_MARKER/);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('readings whitelist injected probe diagnostics and retain the cached observation unchanged', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'probe-injected-failure-'));
  try {
    let at = T;
    const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => at});
    ledger.recordReadings('claude', [{window_id:'five_hour',window_minutes:300,used_pct:20,
      observed_at:T,reset_at:T+5*60000,resets_at:T+5*60000,state:'open',source:'probe'}]);
    const baseReadAt = ledger.snapshot('claude').read_at;
    const probe = {funding: () => null, due: () => true, probe: async () => ({ok:false,
      reason:'secret-error-text BODY_MARKER',status_class:'-1xx',body:'BODY_MARKER',url:'URL_MARKER',identity:'IDENTITY_MARKER'})};
    const reading = await createLendingReadings({ledger,probe,now:()=>at})('claude',{forceRefresh:true});
    assert.equal(reading.refresh_succeeded,false);
    assert.deepEqual(reading.probe,{reason:'unreadable',provider:'claude',failure_class:'parse_failed'});
    assert.equal(reading.read_at,baseReadAt);
    assert.equal(reading.windows[0].observed_at,T);
    assert.doesNotMatch(JSON.stringify(reading),/secret-error-text|BODY_MARKER|URL_MARKER|IDENTITY_MARKER|-1xx/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('required refresh reports busy, deferred, and cancelled without launching or replacing cached readings', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'probe-required-refresh-'));
  try {
    const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => T});
    ledger.recordReadings('claude', [{window_id:'five_hour',window_minutes:300,used_pct:20,
      observed_at:T,reset_at:T+5*60000,resets_at:T+5*60000,state:'open',source:'probe'}]);
    const readAt = ledger.snapshot('claude').read_at;
    let calls = 0;
    const probe = {funding:()=>null,lastResult:()=>({ok:true}),due:()=>false,probe:async()=>{calls++;return {ok:true};}};
    const busy = await createLendingReadings({ledger,probe,jobRunning:()=>true,now:()=>T})('claude',{forceRefresh:true});
    assert.equal(busy.refresh_succeeded,false); assert.equal(busy.probe.reason,'account_busy');
    assert.equal(busy.read_at,readAt); assert.equal(calls,0,'busy prevents any probe launch');
    const deferred = await createLendingReadings({ledger,probe,now:()=>T})('claude',{forceRefresh:true});
    assert.equal(deferred.refresh_succeeded,false); assert.equal(deferred.probe.reason,'probe_deferred');
    assert.equal(deferred.read_at,readAt); assert.equal(calls,0,'deferred does not call probe');
    const controller = new AbortController(); controller.abort();
    const cancelled = await createLendingReadings({ledger,probe,now:()=>T})('claude',{forceRefresh:true,signal:controller.signal});
    assert.equal(cancelled.refresh_succeeded,false); assert.equal(cancelled.probe.reason,'cancelled');
    assert.equal(cancelled.read_at,readAt); assert.equal(calls,0,'cancelled does not call probe');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a reading keeps identity and censored weekly history, and never an executor or a stop, even when its runner reports them', async () => {
  const historyRows = [];
  const weeklyReset = T + 7 * 24 * 60 * 60 * 1000;
  const shortReset = T + 5 * 60 * 60 * 1000;
  const identity = {status: 200, account_sha256_16: '1111222233334444', email_sha256_16: 'aaaa0000bbbb1111'};
  const stdout = JSON.stringify({faravan_probe: 1, status: 200,
    body: {five_hour: {utilization: 20, resets_at: shortReset}, seven_day: {utilization: 10, resets_at: weeklyReset},
      extra_usage: {is_enabled: false}}, identity,
    guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}});
  const hostEvidence = {executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'},
    stop: {delivered: true, fallback: null, latency_ms: 900, removed: true}};
  const probe = createLendingProbe({now: () => T, history: () => ({record: row => historyRows.push(row)}),
    runGuest: async () => ({stdout, ...hostEvidence})});

  assert.equal((await probe.probe('claude')).ok, true);
  assert.deepEqual(probe.funding('claude'), {extra_usage: 'disabled', observed_at: T,
    identity: {account_sha256_16: identity.account_sha256_16, email_sha256_16: identity.email_sha256_16, org_sha256_16: null},
    guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}});
  assert.equal(historyRows.length, 2);
  assert.ok(historyRows.every(row => row.account_week_epoch === weeklyReset));
  assert.ok(historyRows.every(row => row.censoring.complete === false),
    'a meter sample is censored until the app can prove no refusal or deferral occurred');
});

test('a reading never carries or rebinds stop evidence: account A then account B, with and without a receipt', async () => {
  const {createRealPace50Source} = await import('../lib/v1/lending-pace50-source.mjs');
  const {STOP_EVIDENCE_TTL_MS} = await import('../lib/v1/stop-evidence.mjs');
  const dir = mkdtempSync(join(homedir(), '.tmp', 'probe-no-carry-'));
  try {
    let t = T;
    const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => t});
    const idA = {status: 200, account_sha256_16: '1111222233334444', email_sha256_16: 'aaaa0000bbbb1111'};
    const idB = {status: 200, account_sha256_16: '5555666677778888', email_sha256_16: 'bbbb0000cccc2222'};
    const out = id => JSON.stringify({faravan_probe: 1, status: 200, body: CLAUDE_BODY, identity: id,
      guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}});
    // Even a runner that still reports a stop and an executor (an old build's shape) adds nothing to the reading's fact.
    const legacy = {executor: {backend_id: 'docker-sbx', sbx_version: 'v1'}, stop: {delivered: true, fallback: null, latency_ms: 900, removed: true}};
    let identity = idA, receipt = null;
    const probe = createLendingProbe({ledger, now: () => t, runGuest: async () => ({stdout: out(identity), host_read: true, ...legacy})});
    const readings = createLendingReadings({ledger, probe, now: () => t});
    let expectedEmail = idA.email_sha256_16;
    const source = createRealPace50Source({readings, funding: provider => probe.funding(provider), stopBoundMs: 35_000,
      stopEvidence: async () => receipt,
      expectedIdentity: async () => ({email_sha256_16: expectedEmail}),
      expectedExecutor: {backend_id: 'docker-sbx', accepts: v => v === 'v1'}});
    const seen = async () => source.observe({provider: 'claude', admissionOnly: true});

    // No receipt: a read for A, then a read for B. Neither carries an earlier proof, and neither makes one.
    assert.equal((await probe.probe('claude')).ok, true);
    assert.equal(probe.funding('claude').stop, undefined);
    assert.equal(probe.funding('claude').executor, undefined);
    t += 60_000; identity = idB; expectedEmail = idB.email_sha256_16;
    assert.equal((await probe.probe('claude')).ok, true);
    const noReceipt = await seen();
    assert.equal(noReceipt.identity.verified, true, 'B is verified');
    assert.equal(noReceipt.stop.bounded_execution, 'unknown', 'B does not inherit a stop');
    assert.equal(noReceipt.stop.reason, 'stop_unobserved');
    assert.equal(noReceipt.executor.single_executor, 'unknown');

    // A machine receipt proves the stop for whichever account is read, for 24 hours, and then no longer.
    receipt = {executor: {backend_id: 'docker-sbx', sbx_version: 'v1'}, stop: {delivered: true, fallback: null, latency_ms: 900, removed: true}, measured_at: t};
    for (const [id, email] of [[idA, idA.email_sha256_16], [idB, idB.email_sha256_16]]) {
      identity = id; expectedEmail = email; t += 1000;
      assert.equal((await probe.probe('claude')).ok, true);
      const proven = await seen();
      assert.equal(proven.stop.bounded_execution, 'proven');
      assert.equal(proven.stop.proven_until, receipt.measured_at + STOP_EVIDENCE_TTL_MS);
    }
    // A receipt for another runtime version proves no executor.
    receipt = {...receipt, executor: {backend_id: 'docker-sbx', sbx_version: 'v2'}};
    assert.equal((await seen()).executor.single_executor, 'unknown');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('optional history failures retain current quota, identity and funding with a bounded diagnostic', async () => {
  const {createRealPace50Source} = await import('../lib/v1/lending-pace50-source.mjs');
  for (const failure of ['record', 'factory', 'warning', 'async-warning']) {
    const dir = mkdtempSync(join(homedir(), '.tmp', 'probe-history-warning-'));
    try {
      const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => T});
      const identity = {status: 200, account_sha256_16: '1111222233334444', email_sha256_16: 'aaaa0000bbbb1111'};
      const storageFailure = () => { throw new Error('PRIVATE_STORAGE_ERROR'); };
      const warnings = [];
      const probe = createLendingProbe({ledger, now: () => T,
        history: failure === 'factory' ? storageFailure : {record: storageFailure},
        warnHistoryWrite: warning => {
          warnings.push(warning);
          if (failure === 'warning') throw new Error('PRIVATE_LOG_ERROR');
          if (failure === 'async-warning') return Promise.reject(new Error('PRIVATE_ASYNC_LOG_ERROR'));
        },
        runGuest: async () => ({stdout: JSON.stringify({faravan_probe: 1, status: 200, body: CLAUDE_BODY, identity})})});
      const result = await probe.probe('claude');
      assert.equal(result.ok, true, failure);
      assert.equal(result.warning, 'history_write_failed');
      await new Promise(resolve => setImmediate(resolve)); // Rejected async diagnostics must be handled, not become unhandled rejections.
      const readings = createLendingReadings({ledger, probe, now: () => T});
      const observation = await createRealPace50Source({readings}).observe({provider: 'claude'});
      assert.equal(observation.refresh_succeeded, true, failure);
      assert.equal(observation.complete, true, failure);
      assert.deepEqual(observation.resources.map(row => [row.id, row.used_micro]),
        [['five_hour', 25000000], ['seven_day', 37000000]]);
      assert.equal(probe.funding('claude').extra_usage, 'disabled');
      assert.equal(probe.funding('claude').observed_at, T);
      assert.deepEqual(probe.funding('claude').identity, {
        account_sha256_16: identity.account_sha256_16, email_sha256_16: identity.email_sha256_16, org_sha256_16: null});
      assert.deepEqual(warnings, [{at: T, code: 'history_write_failed'}], 'one bounded warning, without raw error text');
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('a required ledger write failure still withholds current funding and refresh success', async () => {
  const storageError = new Error('durable ledger write failed');
  let writes = 0, historyWrites = 0, warnings = 0;
  const cached = {read_at: null, windows: []};
  const ledger = {snapshot: () => cached, recordReadings() { writes++; throw storageError; }};
  const probe = createLendingProbe({ledger, now: () => T,
    history: {record() { historyWrites++; }}, warnHistoryWrite() { warnings++; },
    runGuest: async () => ({stdout: JSON.stringify({faravan_probe: 1, status: 200, body: CLAUDE_BODY})})});
  await assert.rejects(probe.probe('claude'), error => error === storageError);
  assert.equal(probe.funding('claude'), null);
  const reading = await createLendingReadings({ledger, probe, now: () => T})('claude', {forceRefresh: true});
  assert.equal(reading.refresh_succeeded, false);
  assert.equal(probe.funding('claude'), null);
  assert.equal(writes, 2, 'both direct probe and required refresh reached the ledger write');
  assert.equal(historyWrites, 0, 'optional history is not attempted after required persistence fails');
  assert.equal(warnings, 0, 'required persistence failure is not downgraded to an optional warning');
});

test('a durable reservation rejection is not swallowed as optional history failure', async t => {
  const directory = mkdtempSync(join(homedir(), '.tmp', 'probe-durable-rejection-'));
  const opened = createPace50Candidate({directory, now: () => T,
    account: 'synthetic-account', account_week_id: 'synthetic-week',
    measurementHistory: {record() { throw new Error('optional history write failed'); }}});
  t.after(async () => { await opened.adapter.close(); rmSync(directory, {recursive: true, force: true}); });
  const storageError = new Error('durable reservation write failed');
  let reservations = 0;
  // Simulate the durable adapter rejecting its admission write, not a learning recorder.
  opened.adapter.admit = async () => { reservations++; throw storageError; };
  await assert.rejects(opened.candidate.reserve({attemptId: 'write-failed', jobId: 'write-failed',
    provider: 'claude', model: 'claude-haiku-5-5', automatic: false, ownerAbsent: true,
    job: {requirements: {limits: {wall_seconds: 300}}, budget_v1: {max_list_usd: 20},
      expires_at: new Date(T + 3600000).toISOString()}}), error => error === storageError);
  assert.equal(reservations, 1, 'the durable write boundary was reached');
  assert.equal(opened.candidate.registry.entry('write-failed').authorized, false);
  assert.deepEqual(opened.adapter.state().attempts, [], 'failed admission never creates a usable reservation');
});

test('lendingReadings (app.mjs injection): probes when stale and idle, returns the ledger snapshot with plan', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'lending-probe-test-'));
  try {
    let t = T, runs = 0, running = false;
    const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => t });
    const probe = createLendingProbe({ ledger, now: () => t, runGuest: async () => { runs++; return { stdout: JSON.stringify({ faravan_probe: 1, status: 200, body: CLAUDE_BODY }) }; } });
    const readings = createLendingReadings({ ledger, probe, plans: () => ({ claude: 'max20' }), jobRunning: () => running, now: () => t });
    const snap = await readings('claude');
    assert.equal(runs, 1); assert.equal(snap.plan, 'max20'); assert.equal(snap.windows.length, 2);
    assert.equal(snap.windows.find(w => w.window_id === 'seven_day').kappa, 1 / 20);
    await readings('claude'); assert.equal(runs, 1, 'fresh: no probe');
    await readings('claude',{forceRefresh:true}); assert.equal(runs,2,'an explicit refresh probes even a recent reading');
    t += 16 * 60000; running = true;
    const held=await readings('claude',{forceRefresh:true});
    assert.equal(runs,2, 'never probes while a lent job runs on the account');
    assert.equal(held.refresh_succeeded,false,'an explicit check during a live job stays unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lendingReadings after a restart: a recent saved reading still gets one probe, because admission needs that run\'s facts', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'lending-probe-restart-'));
  try {
    let t = T, runs = 0, status = 200;
    const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => t });
    const runGuest = async () => { runs++; return { stdout: JSON.stringify({ faravan_probe: 1, status, body: CLAUDE_BODY }) }; };
    await createLendingReadings({ ledger, probe: createLendingProbe({ ledger, now: () => t, runGuest }), now: () => t })('claude');
    assert.equal(runs, 1);
    t += 60000; // the app restarts a minute later: the saved reading is recent, but the new process has no probe fact
    const probe = createLendingProbe({ ledger, now: () => t, runGuest });
    const readings = createLendingReadings({ ledger, probe, now: () => t });
    await readings('claude');
    assert.equal(runs, 2, 'the first reading after a restart probes');
    assert.notEqual(probe.funding('claude'), null);
    await readings('claude'); assert.equal(runs, 2, 'then a recent reading is used as before');
    // A failed probe leaves no fact, and the cadence still keeps it from probing again at once.
    status = 500;
    const failing = createLendingProbe({ ledger, now: () => t, runGuest });
    const again = createLendingReadings({ ledger, probe: failing, now: () => t });
    await again('claude'); await again('claude');
    assert.equal(runs, 3, 'one probe, not one per call');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lendingReadings for a waiting job: a reading older than the rule accepts gets a probe, at most every few minutes', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'lending-probe-admission-'));
  try {
    let t = T, runs = 0;
    const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => t });
    const probe = createLendingProbe({ ledger, now: () => t, runGuest: async () => { runs++; return { stdout: JSON.stringify({ faravan_probe: 1, status: 200, body: CLAUDE_BODY }) }; } });
    const readings = createLendingReadings({ ledger, probe, now: () => t });
    await readings('claude'); assert.equal(runs, 1);
    t += 90000;
    await readings('claude'); assert.equal(runs, 1, 'a status check uses the saved reading');
    const fresh = await readings('claude', { maxAgeMs: 60000 });
    assert.equal(runs, 1, 'not yet: the last probe was under two minutes ago');
    t += 30000;
    const now = await readings('claude', { maxAgeMs: 60000 });
    assert.equal(runs, 2, 'a job waiting on an old reading gets a current one');
    assert.ok(t - now.read_at <= 60000);
    t += 61000;
    await readings('claude', { maxAgeMs: 60000 }); assert.equal(runs, 2, 'a held job does not probe every minute');
    assert.ok(fresh.read_at < now.read_at);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a probe without overage evidence cannot erase a newer ledger overage signal', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'funding-evidence-test-'));
  try {
    let t = T;
    const week = 7 * 86400000, reset = T + week;
    const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => t });
    for (const end of [T - week, T]) {
      const rows = [];
      for (let at = end - week; at < end; at += 6 * 3600000)
        rows.push({ window_id: 'codex:10080', window_minutes: 10080, used_pct: 5,
          resets_at: end, observed_at: at, state: 'open', source: 'probe' });
      ledger.recordReadings('codex', rows);
    }
    const body = { rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: reset / 1000 } },
      credits: { has_credits: true } };
    const probe = createLendingProbe({ ledger, now: () => t,
      runGuest: () => runThroughProxy('codex', body) });
    const observe = (fields, at = t) => ledger.recordReadings('codex', [], {signal: {at, ...fields}});

    observe({using_overage: true});
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, true);
    t += 1000;
    assert.equal((await probe.probe('codex')).ok, true);
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, true,
      'a fresh limit=false probe without an overage observation must not clear it');
    observe({using_overage: false}, t - 2000);
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, true, 'older false cannot clear');
    observe({limit_reached: false});
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, true,
      'an unrelated limit verdict does not clear overage');
    t += 1000;
    observe({using_overage: false});
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, false,
      'fresh explicit false replaces the old observation');
    observe({using_overage: true}, t - 1);
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, false,
      'older true does not replace newer explicit false');
    observe({using_overage: true});
    observe({using_overage: false});
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, true,
      'equal-time conflict retains true');
    t += 1000;
    observe({limit_reached: false});
    observe({using_overage: false}, t - 500);
    assert.equal(ledger.snapshot('codex', {plan: 'pro'}).signal.using_overage, false,
      'signal ordering is per field, not by the newest unrelated field');
    const reopened = createLendingLedger({file:join(dir,'ledger.json'),now:()=>t});
    assert.equal(reopened.snapshot('codex',{plan:'pro'}).signal.using_overage,false,'evidence survives reopen');
    assert.equal(reopened.snapshot('codex',{plan:'pro'}).signal.using_overage_at,t-500);
    const claudeProbe = createLendingProbe({ledger,now:()=>t,
      runGuest:()=>runThroughProxy('claude',{...CLAUDE_BODY,extra_usage:{is_enabled:true}})});
    assert.equal((await claudeProbe.probe('claude')).ok,true);
    assert.notEqual(ledger.snapshot('claude',{plan:'max20'}).signal?.using_overage,true,
      'extra-usage capability alone is not an observation of paid routing');
    ledger.recordReadings('claude', [], {signal:{at:t+1,limit_reached:false}});
    ledger.recordReadings('claude', [], {signal:{at:t,using_overage:true}});
    assert.equal(ledger.snapshot('claude',{plan:'max20'}).signal.using_overage,true,
      'a field with no prior observation is not ordered by an unrelated field');

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude usage-only probe preserves a prior limit verdict until explicit live recovery', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'missing-claude-verdict-'));
  try {
    let t = T;
    const ledger = createLendingLedger({file:join(dir,'ledger.json'),now:()=>t});
    ledger.recordReadings('claude',[],{signal:{at:t,limit_reached:true,using_overage:true}});
    const probe = createLendingProbe({ledger,now:()=>t,runGuest:()=>runThroughProxy('claude',CLAUDE_BODY)});
    t += 1000;
    assert.equal((await probe.probe('claude')).ok,true);
    let signal = ledger.snapshot('claude',{plan:'max20'}).signal;
    assert.equal(signal.limit_reached,true,'usage windows contain no explicit recovery verdict');
    assert.equal(signal.limit_reached_at,T,'unknown must not refresh verdict evidence');
    assert.equal(signal.using_overage,true);
    t += 1000;
    ledger.recordReadings('claude',[],{signal:{at:t,limit_reached:false,using_overage:false}});
    signal = ledger.snapshot('claude',{plan:'max20'}).signal;
    assert.equal(signal.limit_reached,false,'explicit live recovery remains supported');
    assert.equal(signal.using_overage,false);
    const recoveredAt = t;
    t += 1000;
    await probe.probe('claude');
    assert.equal(ledger.snapshot('claude',{plan:'max20'}).signal.limit_reached_at,recoveredAt);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Codex probe distinguishes missing verdicts, true conflicts, and explicit recovery', async () => {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'missing-codex-verdict-'));
  try {
    let t = T, body;
    const ledger = createLendingLedger({file:join(dir,'ledger.json'),now:()=>t});
    ledger.recordReadings('codex',[],{signal:{at:t,limit_reached:true}});
    const probe = createLendingProbe({ledger,now:()=>t,runGuest:()=>runThroughProxy('codex',body)});
    const unknown = () => ({rate_limit:{primary_window:CODEX_BODY.rate_limit.primary_window},credits:{has_credits:true}});
    for (const candidate of [
      unknown(),
      {...unknown(),rate_limit:{...unknown().rate_limit,allowed:null,limit_reached:'false'},spend_control:{reached:0}},
      {...unknown(),rate_limit:{...unknown().rate_limit,allowed:true,limit_reached:false}},
    ]) {
      body = candidate; t += 1000;
      assert.equal((await probe.probe('codex')).ok,true);
      const signal = ledger.snapshot('codex',{plan:'pro'}).signal;
      assert.equal(signal.limit_reached,true,'absent, invalid or incomplete negative evidence cannot clear');
      assert.equal(signal.limit_reached_at,T);
    }
    body = {...CODEX_BODY,spend_control:{reached:true}}; t += 1000;
    await probe.probe('codex');
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached,true,'true spend rejection wins a conflict');
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached_at,t);
    body = {...CODEX_BODY,rate_limit:{...CODEX_BODY.rate_limit,allowed:false}}; t += 1000;
    await probe.probe('codex');
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached,true,'explicit denied dominates limit=false');
    body = CODEX_BODY; t += 1000;
    await probe.probe('codex');
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached,false,'all explicit negative rejection facts permit recovery');
    const recoveredAt = t;
    body = unknown(); t += 1000;
    await probe.probe('codex');
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached,false);
    assert.equal(ledger.snapshot('codex',{plan:'pro'}).signal.limit_reached_at,recoveredAt);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// Like runThroughProxy, but each path answers from its own script, in order. The last response repeats once the script is used
// up. `prelude` runs first inside the guest's Python, so a test can read the waits without sleeping.
function runScripted(provider, script, prelude = '') {
  return new Promise((resolve, reject) => {
    const seen = {};
    const proxy = createServer((req, res) => {
      const path = new URL(req.url, 'http://provider.invalid').pathname;
      const left = script[path] ?? [];
      const step = left.length > 1 ? left.shift() : left[0];
      seen[path] = (seen[path] ?? 0) + 1;
      res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) });
      res.end(JSON.stringify(step.body ?? {}));
    });
    proxy.listen(0, '127.0.0.1', () => {
      let body = guestProbeScript(provider);
      for (const url of [PROBE_REQUESTS[provider].url, PROBE_REQUESTS[provider].identity?.url].filter(Boolean)) {
        body = body.replace(url, url.replace('https://', 'http://'));
      }
      execFile('python3', ['-I', '-c', prelude + '\n' + body], { env: { PATH: process.env.PATH, http_proxy: 'http://127.0.0.1:' + proxy.address().port }, timeout: 60000 },
        (err, stdout, stderr) => { proxy.close(); err ? reject(err) : resolve({ stdout, stderr, seen }); });
    });
  });
}
const USAGE_PATH = '/api/oauth/usage';
const PROFILE_PATH = '/api/oauth/profile';
const PROFILE = { account: { uuid: 'acct-uuid-1', email: 'Someone@Example.com' }, organization: { uuid: 'org-uuid-1' } };

test('a 429 on the usage read is retried once after its Retry-After, and the reading is the retry\'s', async () => {
  const { stdout, seen } = await runScripted('claude', {
    [USAGE_PATH]: [{ status: 429, headers: { 'retry-after': '0' }, body: {} }, { status: 200, body: CLAUDE_BODY }],
    [PROFILE_PATH]: [{ status: 200, body: PROFILE }],
  });
  assert.equal(seen[USAGE_PATH], 2, 'one retry after the 429');
  assert.equal(seen[PROFILE_PATH], 1, 'the identity read succeeded first time, so it is not retried');
  const out = parseProbeOutput('claude', stdout, T);
  assert.equal(out.status, 200);
  assert.ok(out.readings.length > 0, 'the retry produced readings');
  assert.deepEqual(out.probe, { usage_status: 200, identity_status: 200, usage_attempts: 2, identity_attempts: 1 });
});

test('a guest that still gets 429 after three tries reports the status and the tries, with no reading', async () => {
  const { stdout, seen } = await runScripted('claude', {
    [USAGE_PATH]: [{ status: 429, headers: { 'retry-after': '0' }, body: {} }],
    [PROFILE_PATH]: [{ status: 200, body: PROFILE }],
  });
  assert.equal(seen[USAGE_PATH], 3, 'three tries in all, no more');
  assert.equal(seen[PROFILE_PATH], undefined, 'a rate-limited account is not asked for its identity');
  assert.deepEqual(parseProbeOutput('claude', stdout, T), { status: 429, readings: [],
    probe: { usage_status: 429, identity_status: null, usage_attempts: 3, identity_attempts: null } });
});

test('a failed guest run names the HTTP status and the tries of each request, so a refusal can say what it saw', () => {
  const line = '{"faravan_probe":1,"status":429,"body":{},"attempts":{"usage":3,"identity":1},"identity":{"status":429}}';
  assert.deepEqual(parseProbeOutput('claude', line, T), { status: 429, readings: [],
    probe: { usage_status: 429, identity_status: 429, usage_attempts: 3, identity_attempts: 1 } });
});

test('fresh production probe ledger source retains successful guest windows without admission injection', async () => {
  const {createRealPace50Source} = await import('../lib/v1/lending-pace50-source.mjs');
  const dir = mkdtempSync(join(homedir(), '.tmp', 'fresh-probe-contract-'));
  try {
    const body = {five_hour: {utilization: 3, resets_at: new Date(T + 5 * 3600000).toISOString()},
      seven_day: {utilization: 8, resets_at: new Date(T + 7 * 86400000).toISOString()}, extra_usage: {is_enabled: false}};
    const ledger = createLendingLedger({file: join(dir, 'ledger.json'), now: () => T});
    const probe = createLendingProbe({ledger, now: () => T,
      runGuest: () => runThroughProxy('claude', body)});
    const readings = createLendingReadings({ledger, probe, now: () => T});
    const source = createRealPace50Source({readings});
    assert.deepEqual(ledger.snapshot('claude').windows, []);
    const observation = await source.observe({provider: 'claude'});
    assert.equal(observation.refresh_succeeded, true);
    assert.equal(observation.complete, true);
    assert.deepEqual(observation.resources.map(r => [r.id, r.used_micro]),
      [['five_hour', 3000000], ['seven_day', 8000000]]);
    assert.equal(ledger.snapshot('claude').windows.length, 2);
    assert.equal(observation.identity.verified, false);
    assert.notEqual(observation.funding.subscription_only, 'proven');
    assert.notEqual(observation.executor.single_executor, 'proven');
    assert.notEqual(observation.stop.bounded_execution, 'proven');
    assert.ok(observation.resources.every(r => r.kappa_micro === null));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('closing a lending probe aborts its pending read and prevents a later read', async () => {
  let observedSignal;
  const probe = createLendingProbe({runGuest: ({signal}) => {
    observedSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  }});
  const pending = probe.probe('claude');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedSignal?.aborted, false);
  await probe.close();
  assert.equal(observedSignal.aborted, true);
  assertResultDiagnostics(await pending, {ok:false,reason:'closed'});
  assert.equal(probe.due('claude', {pageOpen:true}), false);
  assert.deepEqual(await probe.probe('claude'), {ok:false,reason:'closed'});
});

test('closing a probe drains a late successful read without publishing evidence', async () => {
  const publications = [];
  const ledger = { recordReadings: (...args) => publications.push(args) };
  const result = { stdout: JSON.stringify({ faravan_probe: 1, status: 200, body: CLAUDE_BODY }) };
  let enter, release, observedSignal;
  const entered = new Promise(resolve => { enter = resolve; });
  const deferred = new Promise(resolve => { release = resolve; });
  const probe = createLendingProbe({ ledger, now: () => T, runGuest: ({signal}) => {
    observedSignal = signal;
    enter();
    return deferred;
  } });
  try {
    const pending = probe.probe('claude');
    await entered;
    let drained = false;
    const closed = probe.close().then(value => { drained = true; return value; });
    assert.equal(observedSignal.aborted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'close has not drained the outstanding read');
    release(result);
    assert.equal(await closed, undefined);
    assertResultDiagnostics(await pending, {ok:false,reason:'closed'});
    assert.deepEqual(publications, [], 'late success never reaches the evidence writer');
  } finally {
    release(result);
    await probe.close();
  }
});

test('one aborted candidate observer cancels all joiners, drains before retry, and cannot publish a late result', async t => {
  const directory=mkdtempSync(join(homedir(),'.tmp','candidate-observation-cancel-'));
  let calls=0, releaseFirst, releaseSecond, firstSignal;
  const success={refresh_succeeded:true,complete:true,resources:[],observed_at:T};
  const source={observe({signal}){
    calls++;
    if(calls===1){firstSignal=signal;return new Promise(resolve=>{releaseFirst=()=>resolve(success);});}
    return new Promise(resolve=>{releaseSecond=()=>resolve({...success,observed_at:T+1});});
  }};
  const opened=createPace50Candidate({directory,now:()=>T,account:'synthetic-account',account_week_id:'synthetic-week',source});
  t.after(async()=>{await opened.candidate.cancelObservations();await opened.adapter.close();rmSync(directory,{recursive:true,force:true});});
  const args={provider:'claude',model:'claude-haiku-5-5',plan:'max20',now:T};
  const controller=new AbortController();
  const first=opened.candidate.observe({...args,signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  const second=opened.candidate.observe(args);
  controller.abort(new DOMException('test cancellation','AbortError'));
  assert.equal(firstSignal.aborted,true,'one observer cancels the shared source signal');
  const third=opened.candidate.observe(args);
  assert.equal(calls,1,'a new caller joins the still-draining cancelled observation');
  releaseFirst();
  const cancelled=await Promise.all([first,second,third]);
  assert.ok(cancelled.every(value=>value.refresh_succeeded===false),'all joiners see a cancelled unknown result');
  assert.equal(opened.candidate.observeSnapshot(args),null,'a late successful callback cannot populate the snapshot cache');
  const retry=opened.candidate.observe(args);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2,'retry starts only after the old observation settles');
  releaseSecond();
  assert.equal((await retry).refresh_succeeded,true);
  assert.equal(opened.candidate.observeSnapshot(args).observed_at,T+1);
});

test('read-only sandbox preflight forwards the shutdown abort signal to each command', async () => {
  const {probeSbxPreflight}=await import('../lib/docker-backend.mjs');
  const controller=new AbortController(),signals=[];
  const report=await probeSbxPreflight({platformName:'darwin',signal:controller.signal,
    runCommand:async (_command,args,{signal})=>{
      signals.push(signal);
      if(args.join(' ')==='run --help')return {code:0,stdout:'Usage: sbx run [options]\n',stderr:''};
      if(args[0]==='version')return {code:0,stdout:'sbx version: v0.47.0',stderr:''};
      if(args[0]==='diagnose')return {code:0,stdout:'Daemon healthy\nDocker authentication healthy',stderr:''};
      if(args[0]==='policy')return {code:0,stdout:'Policy rules',stderr:''};
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }});
  assert.equal(typeof report.ok,'boolean');
  assert.ok(signals.length>0);
  controller.abort();
  assert.ok(signals.every(signal=>signal?.aborted));
});


test('each probe failure class reaches the preflight decision and durable history without secrets', async t => {
  const {createRealPace50Source} = await import('../lib/v1/lending-pace50-source.mjs');
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const {readFileSync} = await import('node:fs');
  const cases = [
    ['probe_unavailable', {unavailable:true}],
    ['probe_cancelled', {result:{ok:false,reason:'cancelled'}}],
    ['usage_http_503', {stdout:JSON.stringify({faravan_probe:1,status:503,body:{token:'SECRET_BODY'}})}],
    ['rate_limited', {stdout:JSON.stringify({faravan_probe:1,status:429,body:{token:'SECRET_BODY'}})}],
    ['identity_failed', {stdout:JSON.stringify({faravan_probe:1,status:200,body:CLAUDE_BODY,
      identity:{status:401,account_id:'SECRET_ACCOUNT'}})}],
    ['sandbox_start_failed', {error:'sandbox_start_failed'}], ['parse_failed', {stdout:'SECRET_BODY'}],
    ['timeout', {error:'timeout'}], ['other', {error:'unknown'}],
  ];
  for (const [failureClass, fixture] of cases) await t.test(failureClass, async () => {
    const directory = mkdtempSync(join(homedir(), '.tmp', 'probe-provenance-'));
    const history = createMeasurementHistory({directory:join(directory,'history'),now:()=>T});
    let candidate;
    try {
      const ledger = createLendingLedger({file:join(directory,'ledger.json'),now:()=>T});
      let probe = createLendingProbe({ledger,now:()=>T,runGuest:async()=>{
        if (fixture.error) throw Object.assign(new Error('SECRET_ERROR'),{probe_failure:fixture.error,token:'SECRET_TOKEN'});
        return {stdout:fixture.stdout};
      }});
      if (fixture.result || fixture.deferred) probe = {due:()=>!fixture.deferred, funding:()=>null, lastResult:()=>fixture.result,
        probe:async()=>({...fixture.result,body:'SECRET_BODY',account_id:'SECRET_ACCOUNT',token:'SECRET_TOKEN'})};
      if (fixture.unavailable) probe = null;
      const readings = createLendingReadings({ledger,probe,now:()=>T,jobRunning:()=>fixture.busy===true});
      const source = createRealPace50Source({readings,funding:provider=>probe?.funding?.(provider)});
      ({candidate} = createPace50Candidate({directory:join(directory,'candidate'),now:()=>T,
        account:'synthetic',account_week_id:'synthetic-week',source,measurementHistory:history}));
      // Refreshing belongs to the background path; admission only reads its saved result.
      if (probe) await probe.probe('claude');
      assert.equal(await candidate.preflight({provider:'claude',ownerAbsent:true}),
        failureClass === 'identity_failed' ? 'identity_unknown' : 'refresh_failed');
      const decision = candidate.lastJobDecisionFor('claude');
      assert.equal(decision.admitted,false);
      assert.equal(decision.assessedAt,T);
      assert.equal(decision.probe.provider,'claude');
      assert.equal(decision.probe.failure_class,failureClass);
      if (failureClass === 'rate_limited') assert.equal(decision.probe.retry_at,T+5*60_000);
      await history.flush();
      const rows = readFileSync(join(history.directory,'measurements.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const failed = rows.find(row=>row.type==='observation_failed');
      assert.equal(failed.data.probe.provider,'claude');
      assert.equal(failed.data.probe.failure_class,failureClass);
      if (failureClass === 'rate_limited') assert.equal(failed.data.probe.retry_at,T+5*60_000);
      assert.doesNotMatch(JSON.stringify({decision,failed}),/SECRET_|account_id|token|body/);
      if (failureClass === 'rate_limited') {
        const deferred = await readings('claude',{forceRefresh:true});
        assert.equal(deferred.probe.reason,'rate_limited');
        assert.equal(deferred.refresh_outcome,undefined);
        assert.equal(deferred.probe.failure_class,'rate_limited');
        assert.equal(deferred.probe.deferral_cause,undefined);
        assert.equal(deferred.probe.retry_at,T+5*60_000);
      }
    } finally {
      await candidate?.adapter?.close();
      await history.flush(); history.close();
      rmSync(directory,{recursive:true,force:true});
    }
  });
});


test('candidate cancellation still records provider and failure class', async () => {
  const rows = [];
  const directory = mkdtempSync(join(homedir(), '.tmp', 'probe-cancel-provenance-'));
  const controller = new AbortController();
  controller.abort();
  const {candidate,adapter} = createPace50Candidate({directory,now:()=>T,account:'synthetic',
    account_week_id:'synthetic-week',source:{observe:()=>assert.fail('cancelled source must not run')},
    measurementHistory:{record:(type,data)=>{rows.push({type,data});return null;}}});
  try {
    const result = await candidate.observe({provider:'codex',signal:controller.signal});
    assert.equal(result.probe.provider,'codex');
    assert.equal(result.probe.failure_class,'probe_cancelled');
    const failed = rows.find(row=>row.type==='observation_failed');
    assert.equal(failed.data.probe.provider,'codex');
    assert.equal(failed.data.probe.failure_class,'probe_cancelled');
  } finally {await adapter.close();rmSync(directory,{recursive:true,force:true});}
});


test('failure diagnostics reject unbounded back-off and arbitrary or non-string classes', async () => {
  const {sanitizeProbeFailure} = await import('../lib/v1/lending-probe.mjs');
  for (const retry_at of [-1,Infinity,NaN,'123',Number.MAX_SAFE_INTEGER,1.5]) {
    const diagnostic = sanitizeProbeFailure({reason:'rate_limited',provider:'codex',retry_at});
    assert.equal(diagnostic.failure_class,'rate_limited');
    assert.equal(Object.hasOwn(diagnostic,'retry_at'),false);
  }
  for (const failure_class of ['SECRET_CLASS',['usage_http_503'],{toString:()=> 'usage_http_503'}]) {
    const diagnostic = sanitizeProbeFailure({reason:'guest_failed',provider:'codex',failure_class,
      body:'SECRET_BODY',token:'SECRET_TOKEN',account_id:'SECRET_ACCOUNT'});
    assert.deepEqual(diagnostic,{reason:'guest_failed',provider:'codex',failure_class:'other'});
  }
});

for (const reason of ['account_busy', 'probe_deferred']) test(reason + ' is a durable deferral, never a failed observation', async t => {
  const {createRealPace50Source, paceInputFromObservation, observationProofFailures} = await import('../lib/v1/lending-pace50-source.mjs');
  const {createMeasurementHistory} = await import('../lib/v1/event-history.mjs');
  const {lendingReadiness} = await import('../lib/v1/lending-readiness.mjs');
  const {lendingStatus} = await import('../lib/v1/lending-status-copy.mjs');
  const {readFileSync} = await import('node:fs');
  const directory = mkdtempSync(join(homedir(), '.tmp', 'probe-deferral-'));
  const history = createMeasurementHistory({directory:join(directory,'history'),now:()=>T});
  let calls = 0;
  const ledger = {snapshot:()=>({read_at:T,windows:[{observed_at:T}]})};
  const probe = {funding:()=>null,lastResult:()=>({ok:true}),due:()=>false,retryAt:()=>T+60_000,probe:async()=>{calls++;assert.fail('no request due');}};
  const readings = createLendingReadings({ledger,probe,now:()=>T,jobRunning:()=>reason==='account_busy'});
  const source = createRealPace50Source({readings});
  const {candidate,adapter} = createPace50Candidate({directory:join(directory,'candidate'),now:()=>T,
    account:'synthetic',account_week_id:'synthetic-week',source,measurementHistory:history});
  t.after(async()=>{await adapter.close();await history.flush();history.close();rmSync(directory,{recursive:true,force:true});});
  const observation = await candidate.observe({provider:'codex',forceRefresh:true});
  assert.equal(calls,0);
  assert.equal(observation.refresh_outcome,'deferred');
  assert.equal(observation.refresh_succeeded,false);
  assert.equal(observation.probe.reason,reason);
  assert.deepEqual(observation.resources,[],'cached windows cannot be admitted');
  assert.equal(paceInputFromObservation(observation,{now:T}).refuse,reason);
  assert.equal(observationProofFailures(observation).includes('refresh_failed'),false);
  const ready = lendingReadiness({observation,provider:'codex',signedIn:true,sandboxState:'passed'});
  assert.equal(ready.find(row=>row.id==='weekly_window').state,'unknown');
  assert.match(ready.find(row=>row.id==='weekly_window').line,reason==='account_busy'?/busy/:/next check/);
  const status = lendingStatus({reason,detail:observation.probe});
  assert.match(status.line,reason==='account_busy'?/busy/:/next check/);
  assert.doesNotMatch(status.line,/could not be measured|verdict|receipt|attempt|settled|lease/i);
  await candidate.observe({provider:'codex'}); // cached deferrals also stay deferrals
  assert.equal(await candidate.preflight({provider:'codex',ownerAbsent:true}),'objective_evidence_unknown');
  await history.flush();
  const rows = readFileSync(join(history.directory,'measurements.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.type==='observation_failed').length,1);
  assert.equal(rows.filter(row=>row.type==='observation_deferred').length,1);
  assert.ok(rows.filter(row=>row.type==='observation_deferred').every(row=>row.data.reason===reason));
});

test('a 429 then an early refresh retains the rate-limit failure without another request', async t => {
  const {createRealPace50Source,paceInputFromObservation} = await import('../lib/v1/lending-pace50-source.mjs');
  const rows = [], directory = mkdtempSync(join(homedir(),'.tmp','probe-backoff-deferral-'));
  let calls = 0;
  const ledger = {snapshot:()=>({windows:[],read_at:null})};
  const probe = createLendingProbe({ledger,now:()=>T,runGuest:async()=>{calls++;return {stdout:JSON.stringify({faravan_probe:1,status:429})};}});
  const source = createRealPace50Source({readings:createLendingReadings({ledger,probe,now:()=>T})});
  const {candidate,adapter} = createPace50Candidate({directory,now:()=>T,account:'synthetic',account_week_id:'synthetic-week',source,
    measurementHistory:{record:(type,data)=>{rows.push({type,data});return null;}}});
  t.after(async()=>{await adapter.close();await probe.close();rmSync(directory,{recursive:true,force:true});});
  const args = {provider:'codex',model:'gpt-6-sol'};
  const first = await candidate.refreshObservation(args);
  assert.equal(first.probe.reason,'rate_limited');
  assert.equal(paceInputFromObservation(first,{now:T}).refuse,'refresh_failed');
  const deferred = await candidate.refreshObservation(args);
  assert.equal(calls,1);
  assert.equal(deferred.refresh_succeeded,false);
  assert.notEqual(deferred.refresh_outcome,'deferred');
  assert.deepEqual(deferred.probe,first.probe);
  assert.equal(paceInputFromObservation(deferred,{now:T}).refuse,'refresh_failed');
  assert.notEqual(candidate.observeSnapshot(args).refresh_outcome,'deferred');
  assert.equal(rows.filter(row=>row.type==='observation_failed').length,2);
  assert.equal(rows.filter(row=>row.type==='observation_deferred').length,0);
});

test('a deferred refresh cannot restore a prior successful cache for admission', async t => {
  const {paceInputFromObservation} = await import('../lib/v1/lending-pace50-source.mjs');
  const directory = mkdtempSync(join(homedir(),'.tmp','deferred-cache-'));
  let reads = 0;
  const deferred = {refresh_outcome:'deferred',refresh_succeeded:false,resources:[],
    probe:{reason:'account_busy',provider:'codex',failure_class:'probe_busy'}};
  const source = {observe:async()=>++reads===1?{refresh_succeeded:true,resources:[],observed_at:T}:deferred};
  const {candidate,adapter} = createPace50Candidate({directory,now:()=>T,account:'synthetic',account_week_id:'synthetic-week',source});
  t.after(async()=>{await adapter.close();rmSync(directory,{recursive:true,force:true});});
  const args = {provider:'codex',model:'gpt-6-sol'};
  assert.equal((await candidate.observe(args)).refresh_succeeded,true);
  assert.equal((await candidate.refreshObservation(args)).refresh_outcome,'deferred');
  assert.equal(candidate.observeSnapshot(args).refresh_outcome,'deferred');
  assert.equal(paceInputFromObservation(await candidate.observe(args),{now:T}).refuse,'account_busy');
  assert.equal(reads,2,'cached hold remains closed without another provider request');
});

test('cadence deferral carries its known next check time without making a request', async () => {
  let at = T, calls = 0;
  const ledger = {recordReadings(){},snapshot:()=>({read_at:T,windows:[]})};
  const probe = createLendingProbe({ledger,now:()=>at,runGuest:async()=>{calls++;return {
    stdout:JSON.stringify({faravan_probe:1,status:200,body:CODEX_BODY})};}});
  try {
    assert.equal((await probe.probe('codex')).ok,true);
    at++;
    const reading = await createLendingReadings({ledger,probe,now:()=>at})('codex',{maxAgeMs:0});
    assert.equal(calls,1);
    assert.equal(reading.refresh_outcome,'deferred');
    assert.equal(reading.probe.retry_at,T+120_000);
    assert.equal(reading.probe.deferral_cause,undefined);
  } finally {await probe.close();}
});

test('a malformed deferred outcome can never supply successful admission proof', async () => {
  const {observationProofFailures} = await import('../lib/v1/lending-pace50-source.mjs');
  const otherwiseValid = {refresh_succeeded:true,identity:{verified:true,account_id:'synthetic'},
    account_week_id:'week',epoch:'epoch',complete:true,weekly_resource_id:'weekly',
    funding:{subscription_only:'proven'},executor:{single_executor:'proven'},
    stop:{bounded_execution:'proven'},stop_bound_ms:1,uncertainty_ms:0,resources:[]};
  assert.deepEqual(observationProofFailures(otherwiseValid),[]);
  for (const probe of [{reason:'account_busy'},{reason:'SECRET_REASON'},null])
    assert.deepEqual(observationProofFailures({...otherwiseValid,refresh_outcome:'deferred',probe}),['refresh_failed']);
});

test('malformed deferred success is recorded as failed, never completed', async t => {
  const rows = [], directory = mkdtempSync(join(homedir(),'.tmp','malformed-deferral-'));
  const source = {observe:async()=>({refresh_outcome:'deferred',refresh_succeeded:true,resources:[],
    probe:{reason:'account_busy',provider:'codex'}})};
  const {candidate,adapter} = createPace50Candidate({directory,now:()=>T,account:'synthetic',account_week_id:'synthetic-week',source,
    measurementHistory:{record:(type,data)=>{rows.push({type,data});return null;}}});
  t.after(async()=>{await adapter.close();rmSync(directory,{recursive:true,force:true});});
  await candidate.observe({provider:'codex'});
  assert.equal(rows.filter(row=>row.type==='observation_completed').length,0);
  assert.equal(rows.filter(row=>row.type==='observation_deferred').length,0);
  assert.equal(rows.filter(row=>row.type==='observation_failed').length,1);
  assert.equal(rows.find(row=>row.type==='observation_failed').data.reason,'refresh_failed');
});


test('cadence skips retain the last real failure class until a successful probe', async t => {
  for (const [name, output, reason, failureClass] of [
    ['401', {stdout:JSON.stringify({faravan_probe:1,status:401})}, 'auth', 'usage_http_401'],
    ['503', {stdout:JSON.stringify({faravan_probe:1,status:503})}, 'provider_error', 'usage_http_503'],
    ['timeout', {probe_failure:'timeout'}, 'timeout', 'timeout'],
    ['parse', {stdout:'not-json'}, 'unreadable', 'parse_failed'],
  ]) await t.test(name, async () => {
    let at = T, calls = 0, succeeds = false;
    const ledger = {recordReadings(){},snapshot:()=>({read_at:null,windows:[]})};
    const probe = createLendingProbe({ledger,now:()=>at,runGuest:async()=>{
      calls++; return succeeds ? {stdout:JSON.stringify({faravan_probe:1,status:200,body:CODEX_BODY})} : output;
    }});
    try {
      const read = createLendingReadings({ledger,probe,now:()=>at});
      const first = await read('codex');
      at++;
      const skipped = await read('codex');
      assert.equal(calls,1);
      assert.equal(skipped.refresh_succeeded,false);
      assert.equal(skipped.refresh_outcome,undefined);
      assert.equal(skipped.probe.reason,reason);
      assert.equal(skipped.probe.failure_class,failureClass);
      assert.deepEqual(skipped.probe,first.probe);
      succeeds = true;
      await read('codex',{forceRefresh:true});
      at++;
      assert.equal((await read('codex')).refresh_outcome,'deferred');
      assert.equal(calls,2);
    } finally { await probe.close(); }
  });
});

test('a closed probe reports failure rather than a cadence deferral', async () => {
  const ledger = {snapshot:()=>({read_at:null,windows:[]})};
  const probe = createLendingProbe({ledger,now:()=>T,runGuest:async()=>assert.fail('closed probe ran')});
  await probe.close();
  const read = await createLendingReadings({ledger,probe,now:()=>T})('codex');
  assert.equal(read.refresh_succeeded,false);
  assert.equal(read.refresh_outcome,undefined);
  assert.equal(read.probe.reason,'closed');
  assert.equal(read.probe.failure_class,'probe_cancelled');
});

test('rate-limit retry time respects page, admission and forced refresh cadence', async () => {
  let at = T, calls = 0;
  const ledger = {snapshot:()=>({read_at:T,windows:[]})};
  const probe = createLendingProbe({ledger,now:()=>at,runGuest:async()=>{
    calls++; return {stdout:JSON.stringify({faravan_probe:1,status:429})};
  }});
  try {
    await probe.probe('codex');
    at++;
    const read = createLendingReadings({ledger,probe,now:()=>at});
    for (const [options, minutes] of [[{},15],[{maxAgeMs:0},5],[{forceRefresh:true},5]]) {
      const skipped = await read('codex',options);
      assert.equal(skipped.probe.reason,'rate_limited');
      assert.equal(skipped.probe.retry_at,T+minutes*60_000);
      assert.equal(skipped.refresh_outcome,undefined);
    }
    assert.equal(calls,1);
  } finally { await probe.close(); }
});


test('a thrown refresh failure after success is retained during cadence', async () => {
  let at=T, calls=0;
  const ledger={recordReadings(){},snapshot:()=>({read_at:T,windows:[]})};
  const probe=createLendingProbe({ledger,now:()=>at,runGuest:async()=>{
    if (++calls>1) throw Object.assign(new Error('private runner detail'),{probe_failure:'timeout'});
    return {stdout:JSON.stringify({faravan_probe:1,status:200,body:CODEX_BODY})};
  }});
  try {
    await probe.probe('codex');
    at++;
    const read=createLendingReadings({ledger,probe,now:()=>at});
    assert.equal((await read('codex',{forceRefresh:true})).probe.reason,'timeout');
    const skipped=await read('codex');
    assert.equal(calls,2);
    assert.equal(skipped.probe.failure_class,'timeout');
    assert.equal(skipped.refresh_outcome,undefined);
    assert.doesNotMatch(JSON.stringify(skipped),/private runner detail/);
  } finally { await probe.close(); }
});
