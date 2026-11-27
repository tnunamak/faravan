import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const source = readFileSync(resolve('lib/v1/app.mjs'), 'utf8');
const {lendingBlockers} = await import(
  pathToFileURL(resolve('lib/v1/blockers.mjs')).href
);

function between(start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, end);
  return source.slice(a, b);
}

const proxyExpression = between(
  '...(a.lendingSpec&&a.proxySignedIn===null',
  '// Three failed automatic checks'
);
// The helper is new. Without it the legacy expression still runs, so a revert of the fix fails on behaviour, not on extraction.
const shownSource = source.includes('const agentCheckShown=id=>{') ? between('const agentCheckShown=id=>{', 'const backgroundCheckIds') : '';
const renderProxy = new Function(
  'a', 'proxyReady', 'signedIn', 'checking', 'agentCheckStartedAt',
  'lendingIdentityChecks', 'lendingIdentityStartedAt', 'backgroundCheck',
  'backgroundCheckIds', 'backgroundCheckStartedAt', 'statusCheckNow', 'STATUS_CHECK_BOUND_MS',
  'AGENT_NAMES', 'id',
  shownSource + ';return ({' + proxyExpression + '});'
);
const unknown = {lendingSpec: {}, proxySignedIn: null,
  proxyStoreUnreadable: false};
const names = {codex: 'Codex'};
function proxyView({checking = new Set(), started = new Map(),
  identities = new Map(), identityStarted = new Map(), background = null,
  backgroundIds = new Set(), backgroundStarted = 0, now = 20001} = {}) {
  return renderProxy(unknown, false, null, checking, started, identities,
    identityStarted, background, backgroundIds, backgroundStarted, () => now, 20000, names,
    'codex');
}

test('account stops saying Checking after its display budget', () => {
  // The producer does not consume startedAt at all. A still-pending
  // identity map entry is sufficient even at monotonic time 20,001 ms.
  const startedAt = 0, monotonicNow = 20001;
  assert.ok(monotonicNow - startedAt >= 20000);
  const result = proxyView({identities: new Map([['codex', {}]]),
    identityStarted: new Map([['codex', startedAt]]), now: monotonicNow});
  assert.notEqual(result.signInState, 'Checking');
});

test('another account background pass cannot mark idle Codex Checking', () => {
  const result = proxyView({background: {}});
  assert.notEqual(result.signInState, 'Checking');
  const own = proxyView({background: {}, backgroundIds: new Set(['codex']), now: 5000});
  assert.equal(own.signInState, 'Checking');
  // A pass still running at +25 s is no longer shown as an open-ended check.
  const late = proxyView({background: {}, backgroundIds: new Set(['codex']),
    backgroundStarted: 0, now: 25000});
  assert.notEqual(late.signInState, 'Checking');
  const early = proxyView({background: {}, backgroundIds: new Set(['codex']),
    backgroundStarted: 0, now: 5000});
  assert.equal(early.signInState, 'Checking');
});

const cachedFunction = between(
  'function cachedReadiness(force=false',
  '// The app never sends a person to a terminal'
);
function cacheHarness(refresh) {
  const ready = {ready: true, observed_at: new Date(0).toISOString(),
    checks: [{name: 'sbx_daemon', ok: true}]};
  const build = new Function(
    'recoveryReadHold', 'recoveryReadiness', 'refreshReadiness',
    'readinessCache', 'readinessGeneration', 'signInGeneration',
    'defaultObservation', 'observationGeneration', 'now',
    'readinessFreshness', 'pendingReadiness', 'options',
    'STATUS_CHECK_BOUND_MS',
    cachedFunction + '; return cachedReadiness;'
  );
  const read = build(
    () => null, () => {throw Error('unexpected recovery');}, refresh,
    ready, 0, () => 0, ready, 0, () => 120000, () => 60000,
    () => ({ready: false, checks: []}), {}, 20000
  );
  return () => read(false, {idle: true});
}
test('expired ready cache is not ready after hung replacement exceeds bound', async () => {
  let calls = 0;
  const never = new Promise(() => {});
  const read = cacheHarness(() => {calls++; return never;});
  const result = await read();
  assert.equal(calls, 1);
  assert.equal(result.ready, false);
});
test('expired ready cache is not ready after replacement timeout rejection', async () => {
  const read = cacheHarness(() => Promise.reject(
    Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})
  ));
  await read();
  await Promise.resolve();
  const result = await read();
  assert.equal(result.ready, false);
});

const good = {
  docker: {installed: true, running: true, signedIn: true},
  intent: {on: true},
  agents: [{id: 'codex', name: 'Codex', enabled: true,
    installed: true, signedIn: true}]
};
test('known Docker failure outranks previous good rows even during checks', () => {
  const model = lendingBlockers({...good,
    readiness: {checks: [{name: 'docker_login', ok: false}]},
    checking: {machine: true, agents: ['codex']}
  });
  assert.equal(model.first.key, 'docker_signin');
  assert.equal(model.first.action, 'Sign in to Docker');
  assert.equal(model.items.find(x => x.agent === 'codex').status, 'waits');
  assert.equal(model.canLend, false);
});
test('unknown agent without an active per-ID check is actionable, not Checking', () => {
  const model = lendingBlockers({...good,
    agents: [{id: 'codex', name: 'Codex', enabled: true,
      installed: true, signedIn: null}],
    checking: {machine: false, agents: []}
  });
  const row = model.items.find(x => x.agent === 'codex');
  assert.equal(row.status, 'blocked');
  assert.equal(row.action, 'Check Codex');
  assert.equal(model.canLend, false);
});
test('unknown agent during its bounded lifecycle can say Checking', () => {
  const model = lendingBlockers({...good,
    agents: [{id: 'codex', name: 'Codex', enabled: true,
      installed: true, signedIn: null}],
    checking: {machine: false, agents: ['codex']}
  });
  assert.equal(model.items.find(x => x.agent === 'codex').status, 'unknown');
  assert.equal(model.canLend, false);
});
