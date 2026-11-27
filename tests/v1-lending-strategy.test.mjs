import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {lendableByStrategy} from '../lib/v1/lending-strategy.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';
import {calibration, GATES, job, MICRO as M, NOW, OWNER_NONE, RESET, windows} from './helpers/lending-objective-fixtures.mjs';

const DEFAULTS = {
  fixedShare: {maxWeeklySharePct:20, keepWeeklyPct:30},
  custom: {weekly:{maxSharePct:20, keepPct:30}, short:{maxSharePct:20, keepPct:30}},
};

function input({strategy = 'automatic', strategyConfig = DEFAULTS, requestedUsdMicro = 25 * M,
  ownerMaxJobUsdMicro = null, resetAtMs = RESET, known = true, weeklyUsedMicro = 10 * M,
  shortUsedMicro = 10 * M, weeklyCommittedMicro = 0, shortCommittedMicro = 0,
  weeklyK = M, shortK = M, lentMicro = 0, friendValue = 100} = {}) {
  const resourceWindows = windows({weeklyUsedMicro, shortUsedMicro, weeklyCommittedMicro, shortCommittedMicro,
    weeklyK, shortK, resetAtMs, known});
  resourceWindows.seven_day.lentMicro = lentMicro;
  resourceWindows.five_hour.lentMicro = 0;
  resourceWindows.seven_day.anchorAtMs = NOW - 24 * 3_600_000;
  resourceWindows.five_hour.anchorAtMs = NOW - 4 * 3_600_000;
  resourceWindows.seven_day.ownerUsedMicro = 0;
  resourceWindows.five_hour.ownerUsedMicro = 0;
  const task = job({requestedUsdMicro, estimateUsdMicro:requestedUsdMicro ?? 20 * M,
    worstCallUsdMicro:M, friendValue});
  return {now:NOW, observedAt:NOW, windows:resourceWindows, band:calibration({weeks:19,score:0}),
    owner:OWNER_NONE, gates:GATES, laterBurnCapacityMicro:0,
    ownerMaxJobUsdMicro, strategy, strategyConfig, weeklyResource:'seven_day', job:task};
}

test('switching strategy changes the capacity decision on identical provider evidence', () => {
  const automatic = decideObjectiveLend(input());
  const fixed = decideObjectiveLend(input({strategy:'fixed_share'}));
  const custom = decideObjectiveLend(input({strategy:'custom', strategyConfig:{...DEFAULTS,
    custom:{weekly:{maxSharePct:10,keepPct:30},short:{maxSharePct:10,keepPct:30}}}}));

  assert.equal(automatic.admitted,true);
  assert.equal(automatic.projection.strategyId,'automatic');
  assert.equal(automatic.exposureUsdMicro,25 * M);
  assert.equal(fixed.admitted,true);
  assert.equal(fixed.projection.strategyId,'fixed_share');
  assert.equal(fixed.exposureUsdMicro,20 * M);
  assert.equal(fixed.projection.protectionSource.seven_day,'strategy');
  assert.equal(custom.admitted,true);
  assert.equal(custom.projection.strategyId,'custom');
  assert.equal(custom.exposureUsdMicro,10 * M);
});

test('fixed share counts prior borrower spend against its cumulative weekly maximum', () => {
  const d = decideObjectiveLend(input({strategy:'fixed_share', lentMicro:18 * M, requestedUsdMicro:null}));
  assert.equal(d.admitted,true,d.reasonCode);
  assert.equal(d.exposureUsdMicro,2 * M);
  assert.equal(d.nativeBudgetUsdMicro,1 * M);
});

test('a selected fixed-share strategy with no saved percentages holds with a specific explanation', () => {
  const d = decideObjectiveLend(input({strategy:'fixed_share', strategyConfig:{
    fixedShare:{maxWeeklySharePct:null,keepWeeklyPct:null},
    custom:{weekly:{maxSharePct:null,keepPct:null},short:{maxSharePct:null,keepPct:null}},
  }}));
  assert.equal(d.admitted,false);
  assert.equal(d.reason,'strategy_config_unknown');
  assert.equal(d.projection.reasonCode,'objective_strategy_config_unknown');
  assert.equal(d.projection.protectionSource.seven_day,'strategy');
  assert.match(d.projection.reasonText,/weekly share limit and keep-back/);
});

test('every strategy stays inside the shared reset, usage, stop, and total-spend envelope', () => {
  for (const strategy of ['automatic','fixed_share','custom']) {
    const make = patch => input({strategy, requestedUsdMicro:null, ownerMaxJobUsdMicro:5 * M, ...patch});
    const admitted = decideObjectiveLend(make({}));
    assert.equal(admitted.admitted,true,`${strategy}: ${admitted.reasonCode}`);
    assert.equal(admitted.exposureUsdMicro,5 * M,`${strategy} total owner cap`);
    assert.equal(admitted.nativeBudgetUsdMicro,4 * M,`${strategy} deducts one worst call`);

    const stopped = decideObjectiveLend({...make({}), stopped:true});
    assert.equal(stopped.admitted,false,`${strategy} stop fence`);
    assert.equal(stopped.reasonCode,'objective_stopped');

    const unknown = decideObjectiveLend(make({known:false}));
    assert.equal(unknown.admitted,false,`${strategy} unknown usage`);
    assert.equal(unknown.reasonCode,'objective_usage_unknown');

    const atReset = decideObjectiveLend(make({resetAtMs:NOW + 150_000}));
    assert.equal(atReset.admitted,false,`${strategy} finish plus stop margin`);
    assert.equal(atReset.reasonCode,'objective_reset');
  }
});

test('strategy capacity property holds across usage, commitments, conversions and caps', () => {
  for (const strategy of ['automatic','fixed_share','custom']) {
    let admittedCount = 0;
    for (let sample = 0; sample < 32; sample++) {
      const d = decideObjectiveLend(input({strategy,
        weeklyUsedMicro:(sample * 2_750_000) % (82 * M),
        shortUsedMicro:(sample * 4_100_000) % (91 * M),
        weeklyCommittedMicro:(sample % 4) * M,
        shortCommittedMicro:(sample % 3) * M,
        weeklyK:(80 + sample % 41) * 10_000,
        shortK:(70 + sample % 53) * 10_000,
        requestedUsdMicro:(1 + sample % 24) * M,
        ownerMaxJobUsdMicro:sample % 5 === 0 ? 6 * M : null,
        lentMicro:(sample % 21) * M,
      }));
      if (!d.admitted) continue;
      admittedCount++;
      assert.equal(d.nativeBudgetUsdMicro + d.worstCallUsdMicro, d.exposureUsdMicro,
        `${strategy} sample ${sample} reserves the full total spend`);
      assert.ok(d.exposureUsdMicro <= (1 + sample % 24) * M);
      assert.ok(d.exposureUsdMicro <= ((sample % 5 === 0) ? 6 * M : Number.MAX_SAFE_INTEGER));
      assert.ok(d.reservePointsMicro.seven_day <= d.projection.lendablePoints.seven_day * M + 1);
      assert.ok(d.reservePointsMicro.five_hour <= d.projection.lendablePoints.five_hour * M + 1);
      assert.ok(Object.values(d.projection.resetsAt).every(reset => Date.parse(reset) > NOW + 150_000));
    }
    assert.ok(admittedCount > 0, `${strategy} admits at least one safe generated case`);
  }
});

test('strategy configuration rejects unbounded or malformed values', () => {
  for (const strategyConfig of [null, {fixedShare:null}, {fixedShare:{maxWeeklySharePct:101}},
    {custom:{weekly:null}}, {custom:{short:{keepPct:-1}}}]) {
    assert.throws(() => decideObjectiveLend(input({strategy:'custom', strategyConfig})),
      /invalid_lending_strategy|invalid strategy percentage/);
  }
});

for (const strategy of ['fixed_share','custom']) {
  for (const [label,maxSharePct,keepPct,expected,used] of [
    ['max below half micro',20.0000004,0,20_000_000,0],
    ['max above half micro',20.0000006,0,20_000_000,0],
    ['keep below half micro',100,30.0000004,69_999_999,0],
    ['keep above half micro',100,30.0000006,69_999_999,0],
    ['integer bounds',20,30,20_000_000,0],
    ['keep at remaining',100,30.0000004,0,70_000_000],
  ]) {
    test(`${strategy} honors directional ${label} at the exported policy API`, () => {
      const config = {fixedShare:{maxWeeklySharePct:maxSharePct,keepWeeklyPct:keepPct},
        custom:{weekly:{maxSharePct,keepPct},short:{maxSharePct,keepPct}}};
      const resources = [{id:'weekly',kind:'weekly',remainingMicro:100_000_000-used,lentMicro:0},
        {id:'short',kind:'short',remainingMicro:100_000_000-used,lentMicro:0}];
      const result = lendableByStrategy({id:strategy,config,resources,
        automaticLendableMicro:{weekly:0,short:0}});
      assert.equal(result.lendableMicro.weekly,expected);
      assert.equal(result.lendableMicro.short,strategy === 'custom' ? expected : 100_000_000-used);
      if (expected > 0) {
        const decision = decideObjectiveLend(input({strategy,strategyConfig:config,
          weeklyUsedMicro:used,shortUsedMicro:used,requestedUsdMicro:90*M}));
        assert.equal(decision.admitted,true,decision.reasonCode);
        assert.equal(decision.exposureUsdMicro,expected);
      }
    });
  }
}
