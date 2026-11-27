import {act, advance as advanceMounted, click, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {LendingAccountChecks} from './setup.jsx';
import {useLendingReadiness} from './lending-readiness-read.mjs';
import {agentReadinessRows, setupAgentRowsState} from './view-models.mjs';

// Item 12: one readiness row per account. The rows are fake payloads; nothing here reads a provider.
beforeEach(() => { resetPage('#/setup'); installClock(); });
afterEach(teardown);

const pass = {id: 'signed_in', state: 'pass'};
const rowA = {id: 'claude-code-subscription', accountKey: 'claude:aaaaaaaa-0000-4000-8000-000000000001', accountLabel: 'A personal', hasReading: true, checks: [pass]};
const rowB = {id: 'claude-code-subscription', accountKey: 'claude:bbbbbbbb-0000-4000-8000-000000000002', accountLabel: 'B work', hasReading: true, checks: [pass]};
const rowAFailed = {...rowA, checks: [{id: 'signed_in', state: 'fail', line: 'A personal needs a new sign-in.', fix: 'Sign in again to A personal.'}]};

test('two accounts of one agent show two labeled lines, distinct keys and one check button each', async () => {
  const mutated = [];
  const view = await mount(h(LendingAccountChecks, {rows: [rowAFailed, rowB], mutate: async (...args) => { mutated.push(args); return {}; }}));
  assert.deepEqual(view.$$('section.lending-account').map(node => node.dataset.account), [rowA.accountKey, rowB.accountKey]);
  assert.deepEqual(view.$$('.lending-account-label').map(node => node.textContent), ['A personal', 'B work']);
  const [a, b] = view.$$('section.lending-account');
  assert.match(a.textContent, /Sign in again to A personal\./);
  assert.ok(!b.textContent.includes('A personal'), 'the failed account\'s line is not on the other account');
  assert.deepEqual(view.$$('button').map(node => node.textContent.trim()), ['Check A personal', 'Check B work']);
  await click(view.button('Check B work'));
  assert.deepEqual(mutated, [['agents/refresh', {accounts: [rowB.accountKey]}]], 'the check acts on that account only');
});

test('one account keeps the plain check list: no heading, no per-account button', async () => {
  const view = await mount(h(LendingAccountChecks, {rows: [rowA], mutate: async () => ({})}));
  assert.equal(view.$$('.lending-account-label').length, 0);
  assert.equal(view.$$('button').length, 0);
});

test('an agent is as good as its worst account', () => {
  assert.equal(setupAgentRowsState([rowA, rowB]), 'pass');
  assert.equal(setupAgentRowsState([rowA, rowAFailed]), 'fail');
  assert.equal(setupAgentRowsState([rowA, {...rowB, checks: [{id: 'signed_in', state: 'unknown'}]}]), 'pending');
  assert.equal(setupAgentRowsState([]), 'pending');
  assert.deepEqual(agentReadinessRows({agents: [rowA, {id: 'codex', checks: []}, rowB]}, 'claude-code-subscription').map(r => r.accountLabel), ['A personal', 'B work']);
});

// A hook harness whose GETs the test settles by hand.
function deferredApi() {
  const reads = [];
  return {reads, get: (path, signal) => new Promise((resolve, reject) => reads.push({path, signal, resolve, reject}))};
}
const READY = {ready: true};
function Probe({api, agents, sink}) {
  const state = useLendingReadiness(api, READY, agents);
  sink.state = state;
  return h('p', null, (state.value?.agents ?? []).map(r => r.accountLabel).join(',') + (state.error ? '!error' : ''));
}

test('an old response cannot bring a removed account back', async () => {
  const api = deferredApi(), sink = {}, both = [{id: 'x'}, {id: 'y'}], onlyB = [{id: 'y'}];
  const view = await mount(h(Probe, {api, agents: both, sink}));
  assert.equal(api.reads.length, 1);
  await view.rerender(h(Probe, {api, agents: onlyB, sink}));
  assert.equal(api.reads.length, 1, 'an ignored abort does not start a concurrent read');
  await act(() => { api.reads[0].resolve({agents: [rowA, rowB]}); }); await flush();
  assert.equal(view.text(), '', 'the old A+B response is dropped');
  assert.equal(api.reads.length, 2, 'settlement starts the latest read');
  await act(() => { api.reads[1].resolve({agents: [rowB]}); }); await flush();
  assert.equal(view.text(), 'B work');
});

for (const ending of ['success', 'rejection']) {
  test(`same-agent account removal ignores retired GET ${ending} before the retained account's GET settles`, async () => {
    const api = deferredApi(), sink = {};
    // One agent id throughout: only its accounts change.
    const withBoth = [{id: 'claude-code-subscription', accounts: [rowA.accountKey, rowB.accountKey]}];
    const withoutA = [{id: 'claude-code-subscription', accounts: [rowB.accountKey]}];
    const view = await mount(h(Probe, {api, agents: withBoth, sink}));
    assert.equal(api.reads.length, 1);
    const a = api.reads[0];
    await view.rerender(h(Probe, {api, agents: withoutA, sink}));
    assert.equal(api.reads.length, 1, 'B cannot start while retired A still owns the physical GET');
    assert.equal(sink.state.error, false);
    assert.equal(view.text(), '');
    // Each fresh fixture settles A exactly once. Rejection here is a real
    // rejected promise, not a no-op reject after an earlier resolve.
    await act(() => {
      if (ending === 'success') a.resolve({agents: [rowA, rowB]});
      else a.reject(new Error('retired account-list read failed'));
    });
    await flush();
    assert.equal(api.reads.length, 2, 'only A settlement starts B for the retained account list');
    // Unlike the current-transport-failure control below, stale rejection
    // must not surface an error even while B is still unresolved.
    assert.equal(sink.state.error, false, 'retired rejection is not a current transport failure');
    assert.equal(sink.state.value, null, 'retired success cannot restore the old account list');
    assert.equal(view.text(), '', 'neither stale rows nor a stale error are displayed before B settles');
    const b = api.reads[1];
    assert.notEqual(b.signal, a.signal);
    await act(() => { b.resolve({agents: [rowB]}); });
    await flush();
    assert.equal(view.text(), 'B work', 'only the retained account is shown');
    assert.deepEqual(sink.state.value.agents, [rowB]);
    assert.equal(sink.state.error, false);
    assert.equal(api.reads.length, 2);
  });
}

test('a transport failure is one failure of the read, not a failure of each account', async () => {
  const api = deferredApi(), sink = {};
  const view = await mount(h(Probe, {api, agents: [{id: 'x'}], sink}));
  await act(() => { api.reads[0].reject(new Error('offline')); }); await flush();
  assert.equal(sink.state.value, null);
  assert.equal(sink.state.error, true);
  assert.equal(view.text(), '!error', 'no account rows are shown or marked failed');
});


// Fake only the hook's 15-second deadline. Leave mounted-fixture rendering
// timers with installClock(), whose implementation is not part of this test.
function readinessDeadlineClock() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const pending = new Map();
  let now = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 15000) return set(callback, delay, ...args);
    const handle = {};
    pending.set(handle, {at: now + delay, callback: () => callback(...args)});
    return handle;
  };
  globalThis.clearTimeout = handle => {
    if (!pending.delete(handle)) clear(handle);
  };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    pending.clear();
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
  };
  return {
    restore,
    advance: async ms => {
      now += ms;
      await act(() => {
        for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at <= now && pending.delete(handle)) timer.callback();
        }
      });
      await flush();
    },
  };
}

// Restore the wrapper while the mounted fixture's mock clock is still alive.
// A test-local after hook can run after afterEach(teardown) resets that clock.
async function withReadinessDeadlineClock(run) {
  const clock = readinessDeadlineClock();
  try {
    return await run(clock);
  } finally {
    clock.restore();
  }
}

test('deadline cleanup precedes fixture reset even on failure and cannot resurrect the old clock', async () => {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const failure = new Error('injected deadline-test failure');
  let clock, resetTimers, deadlineFired = false;
  try {
    await assert.rejects(withReadinessDeadlineClock(async current => {
      clock = current;
      setTimeout(() => { deadlineFired = true; }, 15000);
      throw failure;
    }), error => error === failure);
    assert.equal(globalThis.setTimeout, set, 'finally restores the still-active mounted clock');
    assert.equal(globalThis.clearTimeout, clear);
    await teardown();
    const resetSet = globalThis.setTimeout, resetClear = globalThis.clearTimeout;
    resetTimers = {set: resetSet, clear: resetClear};
    assert.notEqual(resetSet, set, 'mounted teardown resets the underlying mock');
    clock.restore();
    assert.equal(globalThis.setTimeout, resetSet, 'repeat cleanup cannot reinstall a reset mock');
    assert.equal(globalThis.clearTimeout, resetClear);

    installClock();
    let nextFixtureFired = false;
    setTimeout(() => { nextFixtureFired = true; }, 10);
    await advanceMounted(10);
    assert.equal(nextFixtureFired, true, 'a new fixture owns its timer queue');
    await clock.advance(15000);
    assert.equal(deadlineFired, false, 'restoration discarded the old deadline');
  } finally {
    try {
      clock?.restore();
      await teardown();
    } finally {
      // Keep a failing idempotence assertion from poisoning later fixtures.
      if (resetTimers) {
        globalThis.setTimeout = resetTimers.set;
        globalThis.clearTimeout = resetTimers.clear;
      }
    }
  }
});

for (const ending of ['success', 'rejection']) {
  test(`identity refresh inherits A's original deadline and waits for stale ${ending} settlement`, () => withReadinessDeadlineClock(async clock => {
    const api = deferredApi(), sink = {};
    const view = await mount(h(Probe, {api, agents: [{id: 'A'}], sink}));
    assert.equal(api.reads.length, 1);
    const a = api.reads[0];
    assert.equal(a.path, 'lending/readiness');
    assert.equal(a.signal.aborted, false);
    await clock.advance(5000);
    await view.rerender(h(Probe, {api, agents: [{id: 'B'}], sink}));
    assert.equal(api.reads.length, 1, 'identity refresh does not create a second physical GET');
    assert.equal(a.signal.aborted, false, 'background identity refresh is not cancellation');
    await clock.advance(9999);
    assert.equal(a.signal.aborted, false);
    assert.equal(sink.state.error, false);
    await clock.advance(1);
    assert.equal(a.signal.aborted, true, 'A aborts at its original 15-second deadline');
    assert.equal(sink.state.error, true, 'the latest identity observes the deadline');
    assert.equal(sink.state.value, null);
    assert.equal(view.text(), '!error');
    assert.equal(api.reads.length, 1, 'abort alone does not free the physical slot');
    await clock.advance(30000);
    assert.equal(api.reads.length, 1, 'an abort-ignoring A still owns the slot');
    await act(() => {
      if (ending === 'success') a.resolve({agents: [rowA]});
      else a.reject(new Error('stale A failed'));
    });
    await flush();
    assert.equal(api.reads.length, 2, 'only real settlement starts latest B');
    assert.equal(view.text(), '', 'neither stale success nor rejection is displayed');
    assert.equal(sink.state.error, false);
    const b = api.reads[1];
    assert.notEqual(b.signal, a.signal);
    assert.equal(b.signal.aborted, false);
    await act(() => b.resolve({agents: [rowB]}));
    await flush();
    assert.equal(view.text(), 'B work');
    assert.equal(sink.state.error, false);
    assert.equal(api.reads.length, 2);
  }));
}

test("settled A's former deadline cannot abort or fail B; B owns a fresh deadline", () => withReadinessDeadlineClock(async clock => {
  const api = deferredApi(), sink = {};
  const view = await mount(h(Probe, {api, agents: [{id: 'A'}], sink}));
  const a = api.reads[0];
  await clock.advance(5000);
  await view.rerender(h(Probe, {api, agents: [{id: 'B'}], sink}));
  await clock.advance(1000);
  await act(() => a.resolve({agents: [rowA]}));
  await flush();
  assert.equal(api.reads.length, 2);
  const b = api.reads[1];
  assert.equal(a.signal.aborted, false, 'A settled normally at six seconds');
  assert.equal(view.text(), '');
  await clock.advance(9000);
  assert.equal(b.signal.aborted, false, "A's former t=15 deadline does not own B");
  assert.equal(sink.state.error, false);
  assert.equal(api.reads.length, 2);
  await clock.advance(5999);
  assert.equal(b.signal.aborted, false);
  assert.equal(sink.state.error, false);
  await clock.advance(1);
  assert.equal(b.signal.aborted, true, 'B times out at t=21, fifteen seconds after its own start');
  assert.equal(sink.state.error, true);
  assert.equal(view.text(), '!error');
  assert.equal(api.reads.length, 2, 'B remains the physical owner after timeout');
  await act(() => b.resolve({agents: [rowB]}));
  await flush();
  assert.equal(view.text(), '!error', 'a timed-out current response cannot restore evidence');
  assert.equal(api.reads.length, 2, 'settlement does not implicitly retry the same request');
}));

test('explicit Retry aborts A but waits for settlement; unmount cancels B without replacement', () => withReadinessDeadlineClock(async clock => {
  const api = deferredApi(), sink = {};
  const view = await mount(h(Probe, {api, agents: [{id: 'A'}], sink}));
  const a = api.reads[0];
  await clock.advance(5000);
  await act(() => sink.state.retry());
  await flush();
  assert.equal(a.signal.aborted, true, 'explicit Retry requests cancellation');
  assert.equal(api.reads.length, 1, 'Retry does not release an unsettled slot');
  await clock.advance(15000);
  assert.equal(api.reads.length, 1);
  assert.equal(sink.state.error, false, 'the cancelled attempt no longer owns a deadline');
  await act(() => a.reject(new Error('cancelled A settled')));
  await flush();
  assert.equal(api.reads.length, 2);
  const b = api.reads[1];
  assert.equal(b.signal.aborted, false);
  await view.rerender(h('div', null, 'unmounted'));
  assert.equal(b.signal.aborted, true, 'unmount cancels the current physical GET');
  await clock.advance(15000);
  await act(() => b.resolve({agents: [rowB]}));
  await flush();
  assert.equal(api.reads.length, 2, 'settlement after unmount starts nothing');
  assert.equal(view.text(), 'unmounted');
}));
