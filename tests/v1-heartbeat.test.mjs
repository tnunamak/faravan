import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, HEARTBEAT_INTERVAL_MS, LENDER_CAPABILITIES } from '../lib/v1/heartbeat.mjs';

function fakeTimers() {
  const queue = []; let id = 0;
  return { setTimer: (fn, ms) => { const t = { id: ++id, fn, ms, unref() {} }; queue.push(t); return t; },
    clearTimer: t => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
    async fire() { const t = queue.shift(); await t.fn(); }, get pending() { return queue.length; } };
}
const tick = () => new Promise(r => setImmediate(r));

test('heartbeat sends at start and every 30 s, with an increasing seq, in every lending state', async () => {
  const timers = fakeTimers(), sent = [];
  const states = ['blocked', 'paused', 'resting', 'off', 'ready'];
  let n = 0;
  const hb = createHeartbeat({ ...timers, send: async b => { sent.push(b); }, snapshot: async () => ({ intent: { state: states[n++ % states.length] } }) });
  hb.start(); await tick(); await tick();
  assert.equal(sent.length, 1); assert.equal(timers.pending, 1);
  for (let i = 0; i < 4; i++) { await timers.fire(); await tick(); }
  assert.deepEqual(sent.map(b => b.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(sent.map(b => b.intent.state), states, 'blocked, paused, resting and off all report');
  hb.stop(); assert.equal(timers.pending, 0);
  assert.equal(HEARTBEAT_INTERVAL_MS, 30000); assert.ok(LENDER_CAPABILITIES.includes('progress_v1'));
});

test('a failed send or snapshot never stops the heartbeat', async () => {
  const timers = fakeTimers(); let calls = 0;
  const hb = createHeartbeat({ ...timers, snapshot: async () => { if (calls++ === 1) throw new Error('boom'); return {}; },
    send: async () => { if (calls === 1) throw new Error('network'); } });
  hb.start(); await tick(); await tick();
  await timers.fire(); await tick(); await timers.fire(); await tick();
  assert.equal(calls, 3); assert.equal(timers.pending, 1);
  hb.stop();
});

test('each heartbeat sender has its own boot id, the same for all its beats, so a restart is told apart from a late beat', async () => {
  const sent = [], send = async b => { sent.push(b); };
  const a = createHeartbeat({ ...fakeTimers(), send, snapshot: async () => ({}) }), b = createHeartbeat({ ...fakeTimers(), send, snapshot: async () => ({}) });
  await a.beat(); await a.beat(); await b.beat();
  assert.match(sent[0].boot, /^[A-Za-z0-9_-]{8,40}$/);
  assert.equal(sent[0].boot, sent[1].boot); assert.notEqual(sent[0].boot, sent[2].boot);
  assert.deepEqual([sent[0].seq, sent[1].seq, sent[2].seq], [0, 1, 0]);
});

function manualTimers() {
  const q = new Set();
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; q.add(t); return t; },
    clearTimer: t => q.delete(t),
    fireDeadline() { const t = [...q].find(x => x.ms === 25000); q.delete(t); t.fn(); },
    get pending() { return q.size; },
  };
}

test('a snapshot that never resolves settles both coalesced callers at one shared deadline, and the next beat is not pinned', async () => {
  const timers = manualTimers(), sent = [], signals = [];
  let hang = true;
  const hb = createHeartbeat({ ...timers, deadlineMs: 25000,
    snapshot: ({ signal }) => { signals.push(signal); return hang ? new Promise(() => {}) : {}; },
    send: async b => { sent.push(b); } });
  const a = hb.beat(), b = hb.beat();
  assert.equal(a, b, 'callers share one flight');
  assert.equal(timers.pending, 1, 'one deadline timer');
  timers.fireDeadline();
  await Promise.all([a, b]);
  assert.equal(signals[0].aborted, true);
  assert.equal(sent.length, 0, 'no send after the deadline');
  hang = false;
  await hb.beat();
  assert.equal(sent.length, 1, 'next beat starts a fresh flight');
  assert.equal(sent[0].seq, 0, 'the abandoned beat did not use a sequence number');
  assert.equal(signals.length, 2);
});

test('a hung send gets the same aborted signal as the snapshot, and a beat finished late sends nothing more', async () => {
  const timers = manualTimers(), seen = {};
  const hb = createHeartbeat({ ...timers, deadlineMs: 25000,
    snapshot: async ({ signal }) => { seen.snapshot = signal; return {}; },
    send: (_b, { signal }) => { seen.send = signal; return new Promise(() => {}); } });
  const flight = hb.beat();
  await tick();
  timers.fireDeadline();
  await flight;
  assert.equal(seen.send, seen.snapshot, 'one signal for both stages');
  assert.equal(seen.send.aborted, true);
  assert.equal(timers.pending, 0);
  const next = hb.beat(); await tick(); timers.fireDeadline(); await next;
});

test('stop aborts a beat in flight', async () => {
  const timers = manualTimers(); let signal;
  const hb = createHeartbeat({ ...timers, snapshot: async o => { signal = o.signal; return {}; }, send: () => new Promise(() => {}) });
  hb.start(); await tick();
  hb.stop();
  assert.equal(signal.aborted, true);
});

test('a restarted sender uses a new boot id with seq from 0, so a receiver can tell an old-boot late beat from a new one', async () => {
  const sent = [], send = async b => { sent.push(b); };
  const old = createHeartbeat({ ...fakeTimers(), send, snapshot: async () => ({}) });
  await old.beat(); await old.beat();
  const fresh = createHeartbeat({ ...fakeTimers(), send, snapshot: async () => ({}) });
  await fresh.beat(); await old.beat(); // a late beat from the old boot arrives after the new one
  assert.deepEqual(sent.map(b => b.seq), [0, 1, 0, 2]);
  assert.equal(sent[3].boot, sent[0].boot);
  assert.notEqual(sent[2].boot, sent[3].boot);
});
