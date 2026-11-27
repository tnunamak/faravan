import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fluid from '../lib/v1/rules/fluid-protection.mjs';

const Q = 100, EPSILON = 1e-6;
const IDS = ['week', 'short'];
const state = dial => ({
  now_h: 0, dial, history: [],
  windows: [168, 5].map((length_h, i) => ({
    id: IDS[i], length_h, reset_h: length_h,
    used_lo: 0, used_hi: 0, borrower_used: 0, inflight_gross: 0,
  })),
  job: {gross: {week: Math.min(dial, .20) * Q, short: Math.min(dial, .20) * Q}, duration_h: .1},
});

test('cold-start cap is the lead-chosen 20% constant', () => {
  assert.equal(fluid.COLD_START_CAP, .20);
});

for (const dial of [.1, .25, .5, 1]) {
  const budget = Math.min(dial, .20) * Q;
  test(`cold start dial ${dial}: exactly c*Q fits both window identities without history`, () => {
    const s = state(dial), result = fluid.decide(s);
    assert.equal(result.admit, true);
    assert.deepEqual({...result.lendable}, {week: budget, short: budget});
  });

  test(`cold start dial ${dial}: just above c*Q refuses either window identity`, () => {
    for (const id of IDS) {
      const s = state(dial);
      s.job.gross[id] += EPSILON;
      const result = fluid.decide(s);
      assert.equal(result.admit, false, id);
      assert.equal(result.reasonCode, 'fluid_allowance', id);
      assert.equal(result.lendable[id], budget, id);
    }
  });

  test(`cold start dial ${dial}: settled debit plus reservations plus gross share each identity's cap`, () => {
    for (const id of IDS) {
      for (const [settled, reserved] of [[3, 0], [0, 4], [3, 4], [budget, 0], [0, budget]]) {
        const s = state(dial), w = s.windows.find(window => window.id === id);
        w.borrower_used = settled;
        w.used_lo = w.used_hi = settled;
        w.inflight_gross = reserved;
        s.job.gross[id] = budget - settled - reserved;
        assert.equal(fluid.decide(s).admit, true, `${id}: D=${settled}, R=${reserved}`);
        assert.equal(fluid.decide(s).lendable[id], budget - settled - reserved);
        s.job.gross[id] += EPSILON;
        assert.equal(fluid.decide(s).admit, false, `${id}: D+R+g exceeds c*Q`);
      }
    }
  });
}

test('cold-start cap never reaches into what the owner\'s own pace would use', () => {
  // At hour 84 of 168, pace doubles observed use: room left after pace is 100-2a.
  for (const [owner, startup] of [[0, 20], [10, 20], [40, 20], [45, 10], [50, 0], [80, 0]]) {
    const p = fluid.protection([], 'week', 168, .5, {owner, elapsed: 84, later: Q});
    assert.equal(p.startup, startup, `owner ${owner}`);
    const imported = fluid.protection([{
      source: 'import-open-window', window_id: 'week', reset_h: 168,
      trace: [[0, 0], [84, owner]],
    }], 'week', 168, .5, {reset_h: 168, elapsed: 84, later: Q});
    assert.equal(imported.imported, owner);
    assert.equal(imported.startup, startup, `imported ${owner}`);
  }
  // Pace only lowers the allowance: the 20% cap still binds an idle owner.
  assert.equal(fluid.protection([], 'week', 168, 1, {owner: 0, elapsed: 1, later: Q}).startup, 20);
  // Use before any time has passed is treated as unbounded pace.
  assert.equal(fluid.protection([], 'week', 168, .5, {owner: 1, elapsed: 0, later: Q}).startup, 0);
});

test('heavy early use holds cold-start lending; light early use keeps it', () => {
  const s = state(.5), w = s.windows[0];
  s.now_h = 42; w.reset_h = 168; s.windows[1].reset_h = 45;
  s.job.gross = {week: 2, short: 2};
  w.used_lo = w.used_hi = 80;
  assert.equal(fluid.decide(s).admit, false, 'heavy: 80 by hour 42 projects past the quota');
  w.used_lo = w.used_hi = 3;
  assert.equal(fluid.decide(s).admit, true, 'light: 3 by hour 42 projects to 12');
});

test('cold-start cap keeps physical room and deadline gates on both identities', () => {
  for (const id of IDS) {
    const s = state(.5), w = s.windows.find(window => window.id === id);
    // An uncertain meter (upper 80, lower 0) isolates physical room from pace.
    w.used_hi = 80;
    assert.equal(fluid.decide(s).admit, true, `${id}: physical boundary`);
    w.used_hi = 80 + EPSILON;
    assert.equal(fluid.decide(s).admit, false, `${id}: physical room exhausted`);
    w.used_lo = w.used_hi = 0;
    // A long remaining window for the other identity isolates this deadline.
    s.windows.find(window => window.id !== id).reset_h = 200;
    s.job.duration_h = w.reset_h;
    assert.equal(fluid.decide(s).admit, true, `${id}: exact deadline`);
    s.job.duration_h += EPSILON;
    assert.equal(fluid.decide(s).reasonCode, 'fluid_deadline', id);
  }
});

test('settling a reservation preserves the remaining cold-start cap', () => {
  const s = state(.5);
  for (const w of s.windows) {
    w.inflight_gross = 7;
    s.job.gross[w.id] = 13;
  }
  const reserved = fluid.decide(s);
  assert.equal(reserved.admit, true);
  for (const w of s.windows) {
    w.inflight_gross = 0;
    w.used_lo = w.used_hi = w.borrower_used = 7;
  }
  assert.deepEqual(fluid.decide(s), reserved);
});

test('history-trained optimum can still exceed the startup cap inside the existing envelope', () => {
  const history = [{window_id: 'week', trace: [[0, 0], [168, 10]]}];
  const p = fluid.protection(history, 'week', 168, .5, {later: 0});
  assert.equal(p.n, 1);
  assert.ok(Math.abs(p.optimum - 90) < 1e-9);
  assert.equal(p.envelope, Math.min(50, Math.max(p.optimum, 20)));
  assert.equal(p.envelope, 50);
});

test('later no-history optimum is not a lifetime 20% cap', () => {
  const s = state(1);
  s.now_h = 84;
  for (const w of s.windows) {
    w.reset_h = s.now_h + w.length_h / 2;
    s.job.gross[w.id] = 50;
  }
  const result = fluid.decide(s);
  assert.equal(result.admit, true);
  assert.deepEqual({...result.lendable}, {week: 50, short: 50});
});

test('Share more with a first reading late in the window may lend more than a fifth, without history', () => {
  // The starting-assumption copy says a fifth is where lending starts, not the most it can lend.
  const s = state(.5);
  s.now_h = 151.2;
  for (const w of s.windows) {
    w.reset_h = s.now_h + w.length_h / 10;
    s.job.gross[w.id] = 45;
  }
  const result = fluid.decide(s);
  assert.equal(result.admit, true);
  for (const id of IDS) assert.ok(result.lendable[id] > .20 * Q + EPSILON, `${id}: ${result.lendable[id]}`);
});

test('R1 completed-history maximum bounds startup using the optimum samples', () => {
  const row=(use,extra={})=>({window_id:'week',trace:[[0,0],[168,use]],...extra});
  const opts={owner:0,later:100,elapsed:1,reset_h:168};
  assert.equal(fluid.protection([row(100)],'week',168,.5,opts).startup,0);
  assert.equal(fluid.protection([row(90,{metadata:{measurement:'rounded'}})],'week',168,.5,opts).startup,9.5);
  assert.equal(fluid.protection([row(10,{censored:true})],'week',168,.5,opts).startup,0);
  assert.equal(fluid.protection([row(90),row(30)],'week',168,.5,opts).startup,10);
  assert.equal(fluid.protection([{...row(100),window_id:'other'}],'week',168,.5,opts).startup,20);
  assert.equal(fluid.protection([{source:'import-open-window',window_id:'week',reset_h:999,trace:[[0,0],[1,100]]}],'week',168,.5,opts).startup,20);
});
