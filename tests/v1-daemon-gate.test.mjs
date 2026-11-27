import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';
import {createDaemonGate} from '../lib/v1/daemon-gate.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {ISOLATION_CHECK_BUDGET_MS} from '../lib/v1/isolation-check.mjs';
import {createLendingProbe} from '../lib/v1/lending-probe.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';

// Controlled promises and hand-fired timers: nothing here races real time, and no sandbox backend is real.
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function manualTimers() {
  const timers = new Set();
  return {timers,
    setTimer: (fn, ms) => { const timer = {fn, ms, unref() {}}; timers.add(timer); return timer; },
    clearTimer: timer => { timers.delete(timer); },
    fireWhere(ms) { for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn(); } },
    fireAll() { for (const timer of [...timers]) { timers.delete(timer); timer.fn(); } }};
}

test('two callers never hold a turn together, and they go in arrival order', async () => {
  const gate = createDaemonGate();
  const events = [], first = deferred(), second = deferred();
  const a = gate.run(async () => { events.push('a:start'); await first.promise; events.push('a:end'); });
  const b = gate.run(async () => { events.push('b:start'); await second.promise; events.push('b:end'); });
  const c = gate.run(async () => { events.push('c:start'); events.push('c:end'); });
  await flush();
  assert.deepEqual(events, ['a:start']);
  first.resolve(); await flush();
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
  second.resolve(); await Promise.all([a, b, c]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  assert.equal(gate.busy, false);
});

test('a waiter past the bound leaves the line with a named reason and does not block the next caller', async () => {
  const clock = manualTimers();
  const gate = createDaemonGate({maxWaitMs: 5_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  const hold = deferred();
  const holder = gate.run(() => hold.promise);
  const late = gate.run(() => 'never', {label: 'the isolation check'});
  const lateResult = late.then(() => null, error => error);
  const next = gate.run(() => 'next ran');
  await flush();
  assert.equal(gate.waiting, 2);
  // Only the two waiters have timers; fire the first waiter's alone, the way its own deadline would.
  const [firstTimer] = clock.timers; clock.timers.delete(firstTimer); firstTimer.fn();
  const error = await lateResult;
  assert.equal(error.code, 'daemon_busy');
  assert.match(error.message, /busy with other work for 5 s before the isolation check could start/);
  assert.equal(gate.waiting, 1, 'the expired waiter is out of the line');
  hold.resolve(); await holder;
  assert.equal(await next, 'next ran');
  assert.equal(clock.timers.size, 0, 'the winner cleared its timer');
});

test('the turn comes back when the work throws', async () => {
  const gate = createDaemonGate();
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.busy, false);
  assert.equal(await gate.run(() => 'ok'), 'ok');
});

test('an abort takes a waiter out of the line without a turn, and an abort before the call never runs the work', async () => {
  const gate = createDaemonGate();
  const hold = deferred(), controller = new AbortController();
  let ran = false;
  const holder = gate.run(() => hold.promise);
  const waiting = gate.run(() => { ran = true; }, {signal: controller.signal}).catch(error => error);
  await flush();
  controller.abort(new DOMException('stop', 'AbortError'));
  assert.equal((await waiting).name, 'AbortError');
  assert.equal(gate.waiting, 0);
  const already = new AbortController(); already.abort();
  await assert.rejects(gate.run(() => { ran = true; }, {signal: already.signal}));
  hold.resolve(); await holder;
  assert.equal(ran, false);
  assert.equal(gate.busy, false);
});

// A backend whose steps wait on controllable promises.
function fakeBackend() {
  const log = [], gates = {prepare: deferred(), destroy: deferred()};
  return {log, gates,
    lenderCapabilities: async () => ({available: true, backend_id: 'docker-sbx', version: 'test'}),
    prepare: async () => { log.push('prepare'); await gates.prepare.promise; return {job_id: 'probe', sandbox_id: 'sbx-probe'}; },
    start: async (_handle, {onLog} = {}) => { log.push('start'); onLog?.({stream: 'stdout', chunk: Buffer.from('{"faravan_probe":1}\n')}); return {code: 0}; },
    requestStop: async () => ({delivered: true, fallback: null}),
    destroy: async () => { log.push('destroy'); await gates.destroy.promise; return {removed: true}; }};
}
const argv = ['python3', '-c', 'print(1)'];

test('a turn is returned at the hold bound once, even when the stuck work settles later', async () => {
  const clock = manualTimers();
  const gate = createDaemonGate({maxWaitMs: 10 ** 9, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  const stuck = deferred();
  const first = gate.run(() => stuck.promise, {holdMs: 100}).catch(error => error);
  const second = gate.run(() => new Promise(() => {}), {holdMs: 100}).catch(error => error);
  await flush();
  clock.fireWhere(100); // the first holder's bound; the second then takes the turn
  assert.equal((await first).code, 'daemon_hold_timeout');
  await flush();
  assert.equal(gate.busy, true, 'the second holder has the turn');
  stuck.resolve(); await flush();
  assert.equal(gate.busy, true, 'the first holder settling late does not release the second holder\'s turn');
  clock.fireWhere(100);
  assert.equal((await second).code, 'daemon_hold_timeout');
  assert.equal(gate.busy, false);
});

test('a waiter cancelled after the grant does not run its work, and the next waiter still gets the turn', async () => {
  const gate = createDaemonGate();
  const hold = deferred();
  const holder = gate.run(() => hold.promise);
  // The cancel lands between the grant and the first line of the waiter's own continuation.
  const signal = {aborted: false, reason: new DOMException('stop', 'AbortError'), addEventListener() {}, removeEventListener() { this.aborted = true; }};
  let ran = false;
  const cancelled = gate.run(() => { ran = true; }, {signal}).catch(error => error);
  const third = gate.run(() => 'third ran');
  await flush();
  hold.resolve(); await holder;
  assert.equal((await cancelled).name, 'AbortError');
  assert.equal(ran, false);
  assert.equal(await third, 'third ran');
  assert.equal(gate.busy, false);
});

test('an isolation check that never settles ends as a named hold timeout and the turn passes on', {timeout: 20000}, async t => {
  const clock = manualTimers();
  const gate = createDaemonGate({maxWaitMs: 10 ** 9, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  let checks = 0; const logged = [];
  const f = await lenderFixture(t, {policy: {daemonGate: gate, checkJobIsolation: async () => { checks++; return new Promise(() => {}); }}});
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: e => f.events.push(e), onDiagnostic: entry => logged.push(entry)});
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => checks === 1, 'the isolation check holds the turn');
  const next = gate.run(() => 'next ran');
  await flush();
  assert.equal(gate.waiting, 1);
  clock.fireWhere(ISOLATION_CHECK_BUDGET_MS + 60_000);
  await until(() => f.attempt().state === 'released', 'pre-start decline');
  assert.equal(await next, 'next ran');
  assert.equal(JSON.parse(f.attempt().reason).code, 'isolation_check_inconclusive');
  assert.equal(logged.find(e => e.code === 'isolation_check_inconclusive')?.details?.step, 'daemon_hold');
});

test('a job whose isolation check cannot get a turn fails with the busy reason and never runs the check', {timeout: 20000}, async t => {
  const clock = manualTimers();
  const gate = createDaemonGate({maxWaitMs: 1_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  const hold = deferred(), holder = gate.run(() => hold.promise);
  t.after(() => { hold.resolve(); });
  let checks = 0; const logged = [];
  const f = await lenderFixture(t, {policy: {daemonGate: gate, checkJobIsolation: async () => { checks++; return {state: 'pass'}; }}});
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: e => f.events.push(e), onDiagnostic: entry => logged.push(entry)});
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; await holder; });
  await until(() => gate.waiting === 1, 'the isolation check is waiting for a turn');
  clock.fireAll();
  await until(() => f.attempt().state === 'released', 'pre-start decline');
  assert.equal(checks, 0);
  assert.equal(JSON.parse(f.attempt().reason).code, 'isolation_check_inconclusive');
  assert.equal(logged.find(e => e.code === 'isolation_check_inconclusive')?.details?.step, 'daemon_busy');
});
