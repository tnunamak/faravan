import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSweepScheduler, SWEEP_INTERVAL_MS, PRESSURE_CHECK_MS, SWEEP_BACKOFF_MAX_MS } from '../lib/disk-sweep-schedule.mjs';
import { WATERMARK_START_FREE_BYTES, WATERMARK_STOP_FREE_BYTES } from '../lib/disk-sweep-plan.mjs';

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => { pending.delete(id); },
    delays: () => [...pending.values()].map(t => t.ms),
    count: () => pending.size,
    async fire(ms) { const hit = [...pending].find(([, t]) => t.ms === ms); assert.ok(hit, `no timer of ${ms} ms`); pending.delete(hit[0]); await hit[1].fn(); },
    async fireNext() { const hit = [...pending][0]; pending.delete(hit[0]); await hit[1].fn(); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function rig(overrides = {}) {
  const timers = fakeTimers();
  const runs = [];
  let result = { removed: 0, errors: [] };
  const sweeper = { running: false, run: async ({ trigger }) => { runs.push(trigger); return typeof result === 'function' ? result() : result; } };
  let free = 100 * 1024 ** 3;
  let release;
  const ready = overrides.ready ?? new Promise(resolve => { release = resolve; });
  const scheduler = createSweepScheduler({ sweeper, hostFree: async () => free, ready, timers, random: () => 0.5, ...overrides.options });
  return { timers, runs, sweeper, scheduler, ready, release, setFree: v => { free = v; }, setResult: v => { result = v; } };
}

test('the first sweep waits for readiness: nothing runs before it, one runs right after', async () => {
  const t = rig();
  t.scheduler.start();
  await settle();
  assert.deepEqual(t.runs, [], 'a lend is never delayed by a sweep that starts before readiness');
  t.release();
  await settle();
  assert.deepEqual(t.runs, ['startup']);
});

test('the timer re-arms after each sweep with jitter and never runs two at once', async () => {
  const t = rig({ options: { random: () => 0 } });
  t.release?.();
  t.scheduler.start();
  await settle();
  // random() = 0 -> the lowest jitter; the delay stays within +-10% of the interval.
  const [sweepDelay] = t.timers.delays().filter(ms => ms !== PRESSURE_CHECK_MS);
  assert.ok(sweepDelay >= SWEEP_INTERVAL_MS * 0.9 && sweepDelay <= SWEEP_INTERVAL_MS * 1.1);
  let release;
  t.setResult(() => new Promise(resolve => { release = () => resolve({ removed: 0, errors: [] }); }));
  const first = t.timers.fire(sweepDelay);
  await settle();
  assert.equal(t.scheduler.inFlight, true);
  t.sweeper.running = true;
  // A second trigger while one is in flight is dropped, not queued.
  await t.scheduler.trigger('timer');
  assert.equal(t.runs.filter(r => r === 'timer').length, 1, 'no second concurrent run');
  release();
  await first;
  assert.equal(t.scheduler.inFlight, false);
  assert.ok(t.timers.delays().some(ms => ms >= SWEEP_INTERVAL_MS * 0.9), 'the next timer is armed only after the sweep ended');
});

test('a failed sweep backs off: the next delay doubles, up to a cap, and a clean sweep resets it', async () => {
  // The clock moves by the delay each time a timer fires, as it does in real life.
  let clock = 0;
  const t = rig({ options: { random: () => 0.5, now: () => clock } });
  const fireAfter = async ms => { clock += ms; await t.timers.fire(ms); };
  t.release?.();
  t.scheduler.start();
  await settle();
  const sweepDelays = () => t.timers.delays().filter(ms => ms !== PRESSURE_CHECK_MS);
  assert.equal(sweepDelays()[0], SWEEP_INTERVAL_MS);
  t.setResult({ removed: 0, errors: [{ item: 'x', message: 'boom' }] });
  await fireAfter(SWEEP_INTERVAL_MS);
  assert.equal(sweepDelays()[0], SWEEP_INTERVAL_MS * 2);
  await fireAfter(SWEEP_INTERVAL_MS * 2);
  assert.equal(sweepDelays()[0], SWEEP_INTERVAL_MS * 4);
  for (let i = 0; i < 6; i++) await fireAfter(sweepDelays()[0]);
  assert.equal(sweepDelays()[0], SWEEP_BACKOFF_MAX_MS);
  t.setResult({ removed: 1, errors: [] });
  await fireAfter(SWEEP_BACKOFF_MAX_MS);
  assert.equal(sweepDelays()[0], SWEEP_INTERVAL_MS, 'success resets the interval');
});

test('a thrown sweep is contained and backs off', async () => {
  const t = rig();
  t.release?.();
  t.scheduler.start();
  await settle();
  t.setResult(() => { throw new Error('daemon gone'); });
  await t.timers.fire(SWEEP_INTERVAL_MS);
  assert.equal(t.timers.delays().filter(ms => ms !== PRESSURE_CHECK_MS)[0], SWEEP_INTERVAL_MS * 2);
});

test('a thrown startup sweep publishes only fresh free space and backs off pressure', async () => {
  const low = WATERMARK_START_FREE_BYTES - 1;
  const events = [], summaries = [], freeReadings = [];
  const failure = new Error('synthetic startup sweep failure');
  let clock = 1_000_000;
  const t = rig({ options: {
    now: () => clock,
    hostFree: async () => { events.push('hostFree'); return low; },
    onError: error => { assert.equal(error, failure); events.push('onError'); },
    onFree: free => { freeReadings.push(free); events.push('onFree'); },
    onSummary: summary => summaries.push(summary),
  } });
  t.setResult(() => { events.push('startup throw'); throw failure; });
  t.scheduler.start();
  t.release();
  await settle();
  assert.deepEqual(t.runs, ['startup']);
  assert.deepEqual(events, ['startup throw', 'onError', 'hostFree', 'onFree']);
  assert.deepEqual(freeReadings, [low]);
  assert.deepEqual(summaries, [], 'a thrown sweep does not fabricate inventory');
  t.setResult({ removed: 0, errors: [] });
  clock += PRESSURE_CHECK_MS;
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(freeReadings, [low, low], 'the first pressure tick performed its read');
  assert.deepEqual(t.runs, ['startup'], 'failure backoff blocks a second sweep despite low space');
  assert.deepEqual(summaries, []);
  await t.scheduler.stop();
});

test('pressure starts a sweep below the start mark and keeps sweeping until the stop mark', async () => {
  const t = rig();
  t.release?.();
  t.scheduler.start();
  await settle();
  t.runs.length = 0;
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, [], 'plenty of free space: the check only reads');
  t.setFree(WATERMARK_START_FREE_BYTES - 1);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['pressure']);
  t.setFree(WATERMARK_START_FREE_BYTES + 1024 ** 3);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['pressure', 'pressure'], 'between the marks it is still collecting');
  t.setFree(WATERMARK_STOP_FREE_BYTES);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['pressure', 'pressure'], 'at the stop mark it stops');
  t.setFree(WATERMARK_START_FREE_BYTES + 1024 ** 3);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['pressure', 'pressure'], 'and does not restart between the marks');
});

test('an unreadable free-space reading never starts a sweep', async () => {
  const t = rig({ options: { hostFree: async () => { throw new Error('statfs failed'); } } });
  t.release?.();
  t.scheduler.start();
  await settle();
  t.runs.length = 0;
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, []);
});

test('stop() clears every timer and waits for a sweep in flight', async () => {
  const t = rig();
  t.release?.();
  t.scheduler.start();
  await settle();
  let release;
  t.setResult(() => new Promise(resolve => { release = () => resolve({ removed: 0, errors: [] }); }));
  const fired = t.timers.fire(SWEEP_INTERVAL_MS);
  await settle();
  let stopped = false;
  const stopping = t.scheduler.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false, 'stop waits for the sweep in flight');
  release();
  await fired;
  await stopping;
  assert.equal(t.timers.count(), 0);
});

test('pressure sweeps honour the failure backoff shared with the timer', async () => {
  let clock = 1_000_000;
  const t = rig({ options: { now: () => clock } });
  t.setFree(WATERMARK_START_FREE_BYTES - 1);
  t.setResult({ removed: 0, errors: [{ item: 'x', message: 'boom' }] });
  t.release?.();
  t.scheduler.start();
  await settle();
  assert.deepEqual(t.runs, ['startup'], 'the startup sweep failed');
  await t.timers.fire(PRESSURE_CHECK_MS);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['startup'], 'a full disk does not retry a failing sweep every check');
  clock += SWEEP_INTERVAL_MS * 2 + 1;
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.deepEqual(t.runs, ['startup', 'pressure'], 'once the backoff has passed the pressure sweep runs');
  t.setResult({ removed: 1, errors: [] });
  clock += SWEEP_INTERVAL_MS * 4 + 1;
  await t.timers.fire(PRESSURE_CHECK_MS);
  await t.timers.fire(PRESSURE_CHECK_MS);
  assert.equal(t.runs.length, 4, 'a clean sweep clears the backoff');
});
