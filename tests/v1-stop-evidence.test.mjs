import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createStopEvidenceStore} from '../lib/v1/stop-evidence.mjs';
import {createStopCheck, STOP_CHECK_MARKER} from '../lib/v1/stop-check.mjs';

const T0 = Date.UTC(2026, 10, 11, 12);
const BIND = {backend_id: 'docker-sbx', sbx_version: '9.9.9'};

// A fake backend: one dedicated guarded handle, a fake clock, and control over how the Stop and the removal end.
function fixture({mode = 'guarded', cessationAfter = 3000, removalAfter = 50_000, removed = true, startFails = false, stopThrows = false} = {}) {
  const clock = {t: T0, now: () => clock.t};
  const events = [], creates = [];
  let finishRun;
  const backend = {
    async lenderCapabilities() { return {available: true, backend_id: BIND.backend_id, version: BIND.sbx_version}; },
    async prepare(spec) { creates.push(spec); events.push('create'); return {sandbox_id: 'stop-check-1', spec}; },
    start(handle, options) {
      events.push('start');
      assert.equal(options.lendingBudget, undefined);
      assert.equal(typeof options.onExecutionStarted, 'function');
      return new Promise((resolve, reject) => {
        finishRun = resolve;
        if (startFails) return reject(Object.assign(new Error('guest failed'), {code: 'guest_failed'}));
        queueMicrotask(() => options.onLog({stream: 'stdout', chunk: Buffer.from(`${STOP_CHECK_MARKER}_ready\n`)}));
      });
    },
    async requestStop(handle, reason, {onCessation, answerMs} = {}) {
      events.push('request');
      if (stopThrows) throw new Error('boom');
      if (mode === 'unguarded' || mode === 'finished') { events.push('no-guard'); return {delivered: false, fallback: null, reason, running: false}; }
      if (mode === 'hard') { clock.t += answerMs; events.push('hard'); finishRun?.(null); return {delivered: false, fallback: 'hard', reason}; }
      clock.t += cessationAfter; events.push('cessation'); onCessation?.(); finishRun?.(null);
      return {delivered: true, fallback: null, reason};
    },
    async destroy() { clock.t += removalAfter; events.push('destroy'); return {removed}; },
  };
  return {backend, clock, events, creates};
}

async function setup(options) {
  const dir = await mkdtemp(join(process.env.HOME, '.tmp', 'stop-check-'));
  const f = fixture(options);
  const real = createStopEvidenceStore({file: join(dir, 's.json'), now: f.clock.now});
  const saves = [];
  const store = {...real, begin: () => real.begin(), succeed: (...a) => { saves.push(a); return real.succeed(...a); }, fail: g => real.fail(g),
    receipt: () => real.receipt(), current: b => real.current(b), status: b => real.status(b)};
  const check = createStopCheck({backend: f.backend, store, now: f.clock.now, stopAnswerMs: 30_000, timeoutMs: 5000});
  return {...f, real, saves, check, done: () => rm(dir, {recursive: true, force: true})};
}

test('a guarded Stop of the dedicated check sandbox writes one receipt, after verified removal, measured to cessation', async () => {
  const s = await setup();
  try {
    const result = await s.check();
    assert.equal(result.ok, true);
    assert.equal(s.saves.length, 1);
    const receipt = await s.real.current(BIND);
    assert.equal(receipt.delivered, true); assert.equal(receipt.fallback, null); assert.equal(receipt.removed, true);
    assert.deepEqual([receipt.backend_id, receipt.sbx_version], [BIND.backend_id, BIND.sbx_version]);
    // The interval ends at cessation: the 50 s the removal took afterwards is not in it.
    assert.equal(receipt.latency_ms, 3000);
    assert.equal(receipt.measured_at, T0 + 3000);
    assert.deepEqual(s.events, ['create', 'start', 'request', 'cessation', 'destroy']);
    assert.equal(s.creates.length, 1);
    assert.match(s.creates[0].entrypoint, new RegExp(STOP_CHECK_MARKER));
  } finally { await s.done(); }
});

test('the receipt waits for removal: nothing is saved while the removal is pending', async () => {
  const s = await setup();
  try {
    let release;
    const gateRemoval = new Promise(resolve => { release = resolve; });
    const destroy = s.backend.destroy;
    s.backend.destroy = async handle => { await gateRemoval; return destroy(handle); };
    const running = s.check();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(s.events.includes('cessation'));
    assert.equal(s.saves.length, 0, 'cessation alone is not evidence');
    assert.equal(await s.real.receipt(), null);
    release();
    assert.equal((await running).ok, true);
    assert.equal(s.saves.length, 1);
  } finally { await s.done(); }
});

for (const [name, options] of [
  ['an unguarded handle', {mode: 'unguarded'}],
  ['a finished guard', {mode: 'finished'}],
  ['a failed sample', {startFails: true}],
  ['a failed removal', {removed: false}],
  ['a thrown stop', {stopThrows: true}],
  ['a hard fallback', {mode: 'hard'}],
]) {
  test(`${name} is never evidence`, async () => {
    const s = await setup(options);
    try {
      const result = await s.check();
      assert.equal(result.ok, false);
      assert.equal(s.saves.length, 0);
      assert.equal(await s.real.receipt(), null);
      assert.equal(await s.real.status(BIND), 'failed');
      assert.ok(s.events.includes('destroy'), 'the check sandbox is still removed');
    } finally { await s.done(); }
  });
}

test('the answer window expiring hard-stops once and cannot qualify; a failed check also kills an older receipt', async () => {
  const good = await setup();
  try {
    assert.equal((await good.check()).ok, true);
    // The next check on the same store fails by hard fallback: the older receipt stops standing.
    good.backend.requestStop = async (handle, reason, {answerMs}) => { good.clock.t += answerMs; good.events.push('hard'); return {delivered: false, fallback: 'hard', reason}; };
    good.backend.start = () => new Promise(() => {});
    good.backend.start = (handle, options) => { queueMicrotask(() => options.onLog({stream: 'stdout', chunk: Buffer.from(`${STOP_CHECK_MARKER}_ready`)})); return Promise.resolve(null); };
    assert.equal((await good.check()).ok, false);
    assert.equal(good.events.filter(e => e === 'hard').length, 1);
    assert.equal(await good.real.receipt(), null);
  } finally { await good.done(); }
});

test('a real job stop never touches the receipt', async () => {
  const s = await setup();
  try {
    // A real job's handle goes through the backend directly; no path from it reaches the store.
    await s.backend.requestStop({sandbox_id: 'real-job'}, 'owner', {onCessation() {}});
    await s.backend.destroy({sandbox_id: 'real-job'});
    assert.equal(await s.real.receipt(), null);
    assert.equal(s.saves.length, 0);
  } finally { await s.done(); }
});

test('a check that cannot name the runtime does not start a sandbox or touch the store', async () => {
  const s = await setup();
  try {
    s.backend.lenderCapabilities = async () => ({available: true, backend_id: 'docker-sbx'});
    const result = await s.check();
    assert.deepEqual([result.ok, result.reason], [false, 'stop_check_unavailable']);
    assert.equal(s.creates.length, 0);
  } finally { await s.done(); }
});

for (const stage of ['prepare', 'start']) {
  test(`${stage} refusal keeps its code through the coordinator status`, async () => {
    const {createStopCheckCoordinator} = await import('../lib/v1/stop-check-coordinator.mjs');
    const s = await setup();
    try {
      s.backend[stage] = async () => { throw Object.assign(new Error('fixture refusal'), {code: 'limits_unenforceable'}); };
      const coordinator = createStopCheckCoordinator({store: s.real, check: s.check, binding: s.check.binding});
      assert.deepEqual(await coordinator.ensure(), {ok: false, reason: 'limits_unenforceable'});
      assert.equal((await coordinator.view()).reason, 'limits_unenforceable');
      assert.equal(await s.real.receipt(), null);
    } finally { await s.done(); }
  });
}
