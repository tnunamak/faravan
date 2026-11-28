import './helpers/no-browser.mjs';
// Unit tests for lib/v1/lending-objective.mjs. Ported from the reviewed reference, research
// capacity-pooling/lending-default-comparison-2026-10-23/model.test.mjs @ 788c609c (42 tests).
// Not ported: the optimalDivisibleReserve tests (one-shot analytic control, not a production function).
// Repeated-decision tests use exact micro-units; the reference's float values are scaled by MICRO.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MICRO, DEFAULT_PROTECTION, PROTECTION_POSITIONS, chooseObjectiveAction, chooseLendingAction, decideObjectiveLend,
  quotaBudgetUsdMicro, wholeWeekReserveBand, pointsForUsdMicro, usdForPointsMicro,
} from '../lib/v1/lending-objective.mjs';

const M = MICRO;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const resource = (id, remaining) => ({id, remaining, known: true, fresh: true, compatible: true});
const gates = {consent: true, limits: true, funding: true, stopping: true};
const RES = 'weekly:account:window';

function handInput() {
  return {resources: [resource(RES, 10)], gates,
    actions: [{id: 'A', cost: {[RES]: 2}, usefulValue: 10, permitted: true},
      {id: 'B', cost: {[RES]: .5}, usefulValue: 6, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {[RES]: 10}, value: 10, atomic: false}]}]};
}

test('finite objective chooses the highest expected useful value; owner loss never trades against value', () => {
  // Binding design (2026-10-23): the objective is useful value. Owner protection is the chance constraint, not a penalty.
  const input = handInput();
  assert.equal(chooseObjectiveAction(input).choice, 'A');
  const tied = {...input, actions: [{id: 'burn', cost: {[RES]: 1}, usefulValue: 1, permitted: true}]};
  assert.equal(chooseObjectiveAction(tied).choice, 'burn');
  const names = {...input, actions: [{id: 'z', cost: {[RES]: 0}, usefulValue: 1, permitted: true},
    {id: 'a', cost: {[RES]: 0}, usefulValue: 1, permitted: true}]};
  assert.equal(chooseObjectiveAction(names).choice, 'a');
});

test('model loss comparisons break only equal-value action ties and unresolved bounds hold', () => {
  const lossOfCost = Object.assign(() => 0, {compare: (left, right) =>
    left[RES] < right[RES] ? -1 : left[RES] > right[RES] ? 1 : 0});
  const input = {resources:[resource(RES, 10)], gates, lossOfCost,
    actions:[{id:'larger', cost:{[RES]:2}, usefulValue:5, permitted:true},
      {id:'smaller', cost:{[RES]:1}, usefulValue:5, permitted:true}]};
  assert.equal(chooseObjectiveAction(input).choice, 'smaller');

  const unresolved = Object.assign(() => 0, {compare: () => { throw new RangeError('expected loss unresolved'); }});
  assert.throws(() => chooseObjectiveAction({...input, lossOfCost:unresolved}), /expected loss unresolved/);
});

test('linked resources, atomic service, no cross-resource point sum and exact boundaries', () => {
  const input = {resources: [resource('weekly', 100), resource('short', 1)], gates,
    actions: [{id: 'too-short', cost: {weekly: 1, short: 2}, usefulValue: 100, permitted: true},
      {id: 'fits', cost: {weekly: 1, short: 1}, usefulValue: 10, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {weekly: 5, short: 1}, value: 30, atomic: true}]}]};
  const atomic = chooseObjectiveAction(input);
  // The unfit action is infeasible; the feasible one with positive value is chosen, and its owner loss is reported.
  assert.equal(atomic.choice, 'fits');
  assert.deepEqual(atomic.evaluations[1].reasons, ['resource_fit:short']);
  assert.equal(atomic.evaluations[2].loss, 30);
  const divisible = chooseObjectiveAction({...input, resources: [resource('weekly', 100), resource('short', 2)],
    scenarios: [{probability: 1, attempts: [{need: {weekly: 5, short: 2}, value: 30, atomic: false}]}]});
  assert.equal(divisible.evaluations[2].loss, 15);
});

test('finite objective measures useful output, not burn; owner losses cannot cancel across requests', () => {
  const input = {resources: [resource('q', 3)], gates,
    actions: [{id: 'burn', cost: {q: 1}, usefulValue: 0, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {q: 3}, value: 10, atomic: true}, {need: {q: 2}, value: 20, atomic: true}]}]};
  const answer = chooseObjectiveAction(input);
  assert.equal(answer.evaluations[1].loss, 10);
  assert.equal(answer.choice, 'none');
  assert.equal(answer.delay, 'not modeled');
});

test('finite objective agrees with an exhaustive value-only check; the owner loss is reported, never traded', () => {
  for (let capacity = 1; capacity <= 5; capacity++) for (let demand = 0; demand <= 6; demand++) {
    const input = {resources: [resource('q', capacity)], gates,
      actions: Array.from({length: capacity}, (_, i) => ({id: 'x' + (i + 1), cost: {q: i + 1}, usefulValue: (i + 1) * 2, permitted: true})),
      scenarios: [{probability: .5, attempts: [{need: {q: demand}, value: demand, atomic: false}]},
        {probability: .5, attempts: [{need: {q: capacity}, value: capacity, atomic: true}]}]};
    const result = chooseObjectiveAction(input);
    // Value-only: the largest feasible action has the largest value, 2 x capacity, and wins whatever its owner loss.
    assert.equal(result.choice, 'x' + capacity);
    const loss = .5 * (Math.min(capacity, demand) - Math.min(0, demand)) + .5 * capacity;
    close(result.evaluations.find(a => a.id === 'x' + capacity).loss, loss);
  }
});

test('protection is one rule: Keep more for me default, immutable hard gates', () => {
  // The measured-rate replay sets Keep more for me as default.
  assert.equal(DEFAULT_PROTECTION, 'keep_more_for_me');
  assert.deepEqual(Object.values(PROTECTION_POSITIONS).map(p => p.lambda), [10, 4, 2]);
  const input = handInput();
  for (const gate of Object.keys(gates)) {
    const result = chooseObjectiveAction({...input, gates: {...gates, [gate]: false}});
    assert.equal(result.choice, 'none');
  }
  const blocked = chooseObjectiveAction({...input, actions: input.actions.map(a => ({...a, permitted: undefined}))});
  assert.equal(blocked.choice, 'none');
});

test('objective interfaces reject unknown, nonfinite and mismatched inputs', () => {
  const input = handInput();
  assert.throws(() => chooseObjectiveAction({...input, resources: [{...input.resources[0], known: false}]}));
  assert.throws(() => chooseObjectiveAction({...input, actions: [{...input.actions[0], cost: {different: 2}}]}));
  assert.throws(() => chooseObjectiveAction({...input,
    scenarios: [{probability: 1, attempts: [{need: {[RES]: 1}, value: 1}]}]}));
});

test('the chooser is pure: inputs unchanged, and an inherited gate object closes every action', () => {
  const input = handInput(), before = JSON.stringify(input);
  chooseObjectiveAction(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(chooseObjectiveAction({...input, gates: Object.create(gates)}).choice, 'none');
});

test('binary64 near tie picks lower gross displaced service', () => {
  // .1 + .2 is not exactly .3 in binary64. The two values are one tie under the tolerance; the lower owner loss wins.
  const r = chooseObjectiveAction({resources: [resource('q', 1)], gates,
    actions: [{id: 'a', cost: {q: .1}, usefulValue: .1 + .2, permitted: true}, {id: 'b', cost: {q: 0}, usefulValue: .3, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {q: 1}, value: 1, atomic: false}]}]});
  assert.equal(r.choice, 'b');
});

const bandInput = (n = 9, score = 10) => ({
  position: 'keep_more_for_me', weekStart: 100, epoch: 'e', procedure: 'frozen-v1',
  domain: ['weekly@0', 'short@0'],
  weeks: Array.from({length: n}, (_, i) => ({id: 'w' + i, end: i, epoch: 'e', procedure: 'frozen-v1', complete: true,
    upperScores: {'weekly@0': score, 'short@0': score / 2}})),
  forecasts: [{id: 'weekly', domain: 'weekly@0', prediction: 0, scale: 1}, {id: 'short', domain: 'short@0', prediction: 0, scale: 1}],
});

test('whole-week band: max score over the full domain and exact finite rank; missing domains retained', () => {
  const b = wholeWeekReserveBand(bandInput());
  assert.equal(b.rank, 9); assert.equal(b.threshold, 10);
  assert.deepEqual(b.reserves, {weekly: 10, short: 10});
  for (const n of [0, 8]) assert.equal(wholeWeekReserveBand(bandInput(n)).status, 'insufficient_history');
  assert.equal(wholeWeekReserveBand(bandInput(19)).rank, 18);
  assert.equal(wholeWeekReserveBand(bandInput(26)).rank, 25);
  const missing = bandInput(); delete missing.weeks[0].upperScores['short@0'];
  assert.equal(wholeWeekReserveBand(missing).threshold, Infinity);
  const negative = bandInput(); negative.weeks.forEach(w => { w.upperScores = {'weekly@0': -Infinity, 'short@0': -Infinity}; });
  assert.deepEqual(wholeWeekReserveBand(negative).reserves, {weekly: 0, short: 0});
  const future = bandInput(); future.weeks[0].end = 101;
  assert.throws(() => wholeWeekReserveBand(future));
});

// Repeated-decision fixture in micro-units, as in the reference's targetInput: remaining 100, reserve 10, gross
// usd = cost, no owner cap, zero headroom. Reset times are abstract clock units; now = 100, finish = 103, stop = 1.
function lendInput({remaining = 100, reserve = 10, later = 0} = {}) {
  const spare = (remaining - reserve) * M;
  return {
    resources: [
      {id: 'weekly', kind: 'weekly', remainingMicro: remaining * M, resetAtMs: 110, pointsPerUsdMicro: M,
        pointsPerUsdLowerMicro: M, known: true, fresh: true, compatible: true},
      {id: 'short', kind: 'short', remainingMicro: 100 * M, resetAtMs: 105, pointsPerUsdMicro: M,
        pointsPerUsdLowerMicro: M, known: true, fresh: true, compatible: true},
    ],
    weeklyResource: 'weekly', now: 100, stopMarginMs: 1, laterBurnCapacityMicro: later * M,
    band: bandInput(9, reserve), position: 'keep_more_for_me', gates,
    actions: [{id: 'use-spare', costMicro: {weekly: spare, short: spare}, usdMicro: spare, worstCallUsdMicro: 0,
      usefulValue: remaining - reserve, permitted: true, finishMs: 103}],
    scenarios: [{probability: 1, attempts: [{need: {weekly: reserve, short: reserve}, value: reserve, atomic: false}]}],
  };
}

test('revision: light owner lends all 90 spare, heavy owner keeps all 99 needed', () => {
  const light = chooseLendingAction(lendInput());
  assert.equal(light.choice, 'use-spare');
  assert.equal(light.lendNowMicro, 90 * M);
  assert.equal(light.evaluations.find(a => a.id === light.choice).loss, 0);
  const heavy = chooseLendingAction(lendInput({remaining: 100, reserve: 99}));
  assert.equal(heavy.choice, 'use-spare');
  assert.equal(heavy.lendNowMicro, 1 * M);
  assert.equal(heavy.evaluations.find(a => a.id === heavy.choice).loss, 0);
  assert.equal(chooseLendingAction(lendInput({reserve: 10, later: 90})).choice, 'use-spare',
    'a continuous future-throughput estimate does not cap the current indivisible action');
});

test('revision: representative model jobs fit objective spare with no owner USD cap set', () => {
  for (const [id, cost] of [['Haiku', 3], ['Sonnet', 12], ['Opus', 30]]) {
    const input = lendInput();
    input.actions = [{...input.actions[0], id, costMicro: {weekly: cost * M, short: cost * M}, usdMicro: cost * M, usefulValue: cost}];
    assert.equal(chooseLendingAction(input).choice, id);
  }
});

test('legacy discrete model carry uses only the latest persisted reserve', () => {
  const decision = decideObjectiveLend({
    now: 100, observedAt: 100, position: 'balanced', weeklyResource: 'weekly', laterBurnCapacityMicro: 0,
    windows: {weekly: {kind: 'weekly', known: true, fresh: true, compatible: true, usedMicro: 0,
      committedMicro: 0, uncertaintyMicro: 0, pointsPerUsdMicro: M, resetAtMs: 1000}},
    band: bandInput(9, 0), gates, frozenProtectionSource: 'model',
    demandModel: {kind: 'discrete-atoms', id: 'test-atoms', label: 'Test atoms', provenance: 'synthetic test',
      markBound: () => 1, prior: () => ({}), posterior: () => [{amount: 50, probability: 1}],
      ownerScenarios: () => [{probability: 1, attempts: [{need: {weekly: 0}, value: 0, atomic: false}]}],
      harm: () => 0, riskBudget: () => .25},
    modelDataByResource: {weekly: {initialCapacityPoints: 100, ownerCount: 0, observations: {count: 0},
      exposureFraction: .5, updateIndex: 3, forecasts: [
        {ownerAtIssue: 0, reservePoints: 40, updateIndex: 2},
        {ownerAtIssue: 0, reservePoints: 20, updateIndex: 1},
      ]}},
    owner: {scenarios: [{probability: 1, attempts: [{need: {weekly: 0}, value: 0, atomic: false}]}]},
    job: {friendValue: 10, estimateUsdMicro: 50 * M, requestedUsdMicro: 50 * M, worstCallUsdMicro: 0,
      wallMs: 1, uncertaintyMs: 1, stopMs: 1},
  });
  assert.equal(decision.protectedOwnerPoints.weekly, 40);
});

test('revision: an unresolved direct band holds; stop, reset and resource limits remain hard gates', () => {
  const input = lendInput();
  input.band = bandInput(0);
  assert.equal(chooseLendingAction(input).choice, 'none');
  for (const alter of [
    x => { x.gates = {...gates, stopping: false}; },
    x => { x.actions[0].finishMs = 104; },
    x => { x.actions[0].costMicro.short = 91 * M; },
  ]) {
    const x = lendInput(); alter(x);
    assert.equal(chooseLendingAction(x).choice, 'none');
  }
});

test('a censored cell stays unbounded after a finite rank exists', () => {
  const input = lendInput();
  input.band = bandInput(9, 10);
  input.band.weeks[0].complete = false;
  input.band.weeks[0].upperScores['weekly@0'] = Infinity;
  input.band.weeks[0].upperScores['short@0'] = Infinity;
  assert.equal(chooseLendingAction(input).choice, 'none');
});

test('budget derives from the gross quota vector; only an optional owner cap bounds it', () => {
  assert.equal(quotaBudgetUsdMicro({weekly: 90 * M, short: 40 * M}, {weekly: 3 * M, short: 2 * M}, null, 0), 20 * M);
  assert.equal(quotaBudgetUsdMicro({weekly: 90 * M, short: 40 * M}, {weekly: 3 * M, short: 2 * M}, 7 * M, 0), 7 * M);
  assert.throws(() => quotaBudgetUsdMicro({weekly: M}, {short: M}, null, 0));
  assert.throws(() => quotaBudgetUsdMicro({weekly: M}, {weekly: 0}, null, 0));
  const x = lendInput();
  const got = chooseLendingAction(x);
  assert.equal(got.choice, 'use-spare');
  assert.equal(got.nativeBudgetsMicro['use-spare'], 90 * M);
  x.actions[0].usdMicro = 90 * M + 10_000;
  assert.equal(chooseLendingAction(x).choice, 'none');
});

test('revision: joint band cannot be defeated by optimistic scenarios or history gaps', () => {
  const x = lendInput({remaining: 100, reserve: 101});
  x.actions[0].costMicro = {weekly: M, short: M};
  x.actions[0].usdMicro = M;
  x.actions[0].usefulValue = 100;
  x.scenarios = [{probability: 1, attempts: []}];
  assert.equal(chooseLendingAction(x).choice, 'none');
  const b = bandInput(); b.weeks[0].complete = false;
  assert.equal(wholeWeekReserveBand(b).threshold, Infinity);
  const malformed = bandInput(); malformed.weeks[0].upperScores['short@0'] = NaN;
  assert.equal(wholeWeekReserveBand(malformed).threshold, Infinity);
  const earliest = lendInput();
  earliest.resources[0].resetAtMs = 102;
  assert.equal(chooseLendingAction(earliest).choice, 'none');
});

test('revision: tolerance tie set is anchored to the maximum, independent of action order', () => {
  // B and C are one tie under the tolerance, and C is the maximum. Owner loss then breaks the tie: B's loss is lower.
  const input = {resources: [resource('q', 10)], gates,
    actions: [{id: 'A', cost: {q: 1}, usefulValue: 2, permitted: true},
      {id: 'B', cost: {q: 2}, usefulValue: 3 + .75e-9, permitted: true},
      {id: 'C', cost: {q: 3}, usefulValue: 3 + 1.5e-9, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {q: 10}, value: 10, atomic: false}]}]};
  assert.equal(chooseObjectiveAction(input).choice, 'B');
  assert.equal(chooseObjectiveAction({...input, actions: [...input.actions].reverse()}).choice, 'B');
});

test('revision: inherited fields, empty conversions and overflow fail closed', () => {
  const b = bandInput(); b.weeks[0].upperScores = Object.create({'weekly@0': 10, 'short@0': 5});
  assert.equal(wholeWeekReserveBand(b).threshold, Infinity);
  assert.throws(() => quotaBudgetUsdMicro({weekly: M}, Object.assign(Object.create({weekly: M}), {other: M}), null, 0));
  assert.throws(() => quotaBudgetUsdMicro({}, {}, 5 * M, 0));
  const overflow = bandInput(9, 1e308); overflow.forecasts.forEach(f => { f.scale = 1e9; });
  assert.equal(wholeWeekReserveBand(overflow).status, 'unbounded');
  const x = lendInput(); x.resources[0].id = '__proto__'; x.weeklyResource = '__proto__';
  assert.throws(() => chooseLendingAction(x));
});

// Reference r4: native budget subtracts required model headroom exactly once, before the owner cap.
test('owner cap bounds total spend; worst-call headroom is subtracted after the gross cap', () => {
  for (const worstCallUsd of [1_320_000, 5_280_000, 10_560_000]) {
    const cost = {short: 31_600_000, weekly: 15_800_000}, k = {short: 1_580_000, weekly: 790_000};
    assert.equal(quotaBudgetUsdMicro(cost, k, null, worstCallUsd), 20 * M - worstCallUsd);
    assert.equal(quotaBudgetUsdMicro(cost, k, 7 * M, worstCallUsd), 7 * M - worstCallUsd);
  }
  for (const bad of [undefined, NaN, Infinity, -1]) {
    assert.throws(() => quotaBudgetUsdMicro({q: 10 * M}, {q: M}, null, bad), /worstCallUsd/);
    const x = lendInput();
    x.actions[0].worstCallUsdMicro = bad;
    assert.throws(() => chooseLendingAction(x), /worstCallUsd/);
  }
  for (const headroom of [1 * M, 2 * M]) {
    const x = lendInput({remaining: 100, reserve: 99});
    x.actions[0].worstCallUsdMicro = headroom;
    x.actions[0].usdMicro = 0;
    const got = chooseLendingAction(x);
    assert.equal(got.choice, 'none');
    assert.ok(got.evaluations[1].reasons.includes('budget_too_small'));
  }
});

// Reference r4: zero-benefit and exact equality hold regardless of the lexical action id.
test('r4: zero benefit holds regardless of lexical action ID; positive benefit is chosen regardless of owner loss', () => {
  for (const id of ['a', 'z']) {
    const zero = chooseObjectiveAction({resources: [resource('q', 10)], gates,
      actions: [{id, cost: {q: 1}, usefulValue: 0, permitted: true}], scenarios: [{probability: 1, attempts: []}]});
    assert.equal(zero.choice, 'none');
    const positive = chooseObjectiveAction({resources: [resource('q', 10)], gates,
      actions: [{id, cost: {q: 1}, usefulValue: 10, permitted: true}],
      scenarios: [{probability: 1, attempts: [{need: {q: 10}, value: 10, atomic: false}]}]});
    assert.equal(positive.choice, id);
  }
});

test('r4: any strictly positive value is chosen despite owner loss; zero value holds', () => {
  // The owner loss here is 100 x .2 = 20 at the action's cost, and it does not offset value any more.
  const choice = value => chooseObjectiveAction({resources: [resource('q', 100)], gates,
    actions: [{id: 'x', cost: {q: .2}, usefulValue: value, permitted: true}],
    scenarios: [{probability: 1, attempts: [{need: {q: 100}, value: 100, atomic: false}]}]}).choice;
  assert.equal(choice(0), 'none');
  assert.equal(choice(1e-12), 'x');
  assert.equal(choice(.8), 'x');
});

test('strictly positive value beats zero harm even inside the tie-ranking tolerance', () => {
  const result = chooseObjectiveAction({resources: [resource('q', 10)], gates,
    actions: [{id: 'tiny-useful-result', cost: {q: 0}, usefulValue: 5e-10, permitted: true}],
    scenarios: [{probability: 1, attempts: []}]});
  assert.equal(result.choice, 'tiny-useful-result');
});

test('conversions round as declared: reservations up, budgets down', () => {
  assert.equal(pointsForUsdMicro(20 * M, 1_580_000), 31_600_000);
  assert.equal(usdForPointsMicro(1 * M, 1_580_000), 632_911);
  assert.equal(usdForPointsMicro(500_000, 790_000), 632_911);
  assert.equal(pointsForUsdMicro(632_911, 1_580_000), 1_000_000);
});
