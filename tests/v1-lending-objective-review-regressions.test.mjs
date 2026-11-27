import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideObjectiveLend, MICRO} from '../lib/v1/lending-objective.mjs';
import {MODELS, NOW, GATES, OWNER_NONE, calibration, windows, job} from './helpers/lending-objective-fixtures.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';

const M = MICRO;
const emptyQueue = 0;
const ample = () => windows({weeklyUsedMicro: 84_200_000, weeklyK: 790_000,
  shortUsedMicro: 68_400_000, shortK: 1_580_000});

test('owner maxJobUsd caps total spend before worst-call headroom', () => {
  const expectedNative = [10_680_000, 6_720_000, 1_440_000];
  for (const [index, model] of MODELS.entries()) {
    const decision = decideObjectiveLend({now: NOW, observedAt: NOW, windows: ample(), band: calibration(), owner: OWNER_NONE,
      gates: GATES, laterBurnCapacityMicro: emptyQueue, ownerMaxJobUsdMicro: 12 * M,
      job: job({friendValue: 100, requestedUsdMicro: null, estimateUsdMicro: 20 * M,
        worstCallUsdMicro: model.headroomUsdMicro})});
    assert.equal(decision.admitted, true);
    assert.equal(decision.exposureUsdMicro, 12 * M);
    assert.equal(decision.nativeBudgetUsdMicro, expectedNative[index]);
    assert.equal(decision.nativeBudgetUsdMicro + model.headroomUsdMicro, 12 * M);
  }

  for (const model of MODELS) {
    const decision = decideObjectiveLend({now: NOW, observedAt: NOW, windows: ample(), band: calibration(), owner: OWNER_NONE,
      gates: GATES, laterBurnCapacityMicro: emptyQueue, ownerMaxJobUsdMicro: M,
      job: job({friendValue: 100, requestedUsdMicro: null, estimateUsdMicro: 20 * M,
        worstCallUsdMicro: model.headroomUsdMicro})});
    assert.equal(decision.admitted, false, `${model.model} cannot fit under a $1 total cap`);
    assert.equal(decision.reason, 'budget_too_small');
  }
});

test('atomic owner service loss is evaluated as an indivisible attempt and reported; positive value inside the slack lends', () => {
  const decision = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}), band: calibration(), gates: GATES,
    laterBurnCapacityMicro: emptyQueue,
    owner: {scenarios: [{probability: 1, attempts: [
      {need: {seven_day: 100, five_hour: 100}, value: 100, atomic: true},
    ]}]},
    job: job({friendValue: 10, requestedUsdMicro: 2 * M, estimateUsdMicro: 2 * M})});
  // Binding design: owner loss is not traded against value. The atomic attempt's loss is reported in full, and a positive
  // value inside the protected slack is chosen.
  assert.equal(decision.admitted, true, decision.reasonCode);
  assert.equal(decision.projection.expectedOwnerHarm, 100);
});

test('a resized job needs its own useful checkpoint value', () => {
  const decision = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 90 * M, shortUsedMicro: 0}), band: calibration(), owner: OWNER_NONE,
    gates: GATES, laterBurnCapacityMicro: emptyQueue,
    job: job({friendValue: 10, requestedUsdMicro: 20 * M, estimateUsdMicro: 20 * M})});
  assert.equal(decision.admitted, false);
  // The request (20 USD) is above the spare (10 USD), so the job holds whole and the hold names the spare.
  assert.equal(decision.projection.reasonCode, 'objective_exceeds_spare');
  assert.equal(decision.projection.maximumExposureUsd, 10);
});

test('a request above the spare holds whole, and the status names what the job needs and what is spare now', () => {
  // Weekly use of 90 points leaves 9 points of spare, which is 10 USD in this fixture. The 20 USD request is above it.
  const decision = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 90 * M, shortUsedMicro: 0}), band: calibration(), owner: OWNER_NONE,
    gates: GATES, laterBurnCapacityMicro: emptyQueue,
    job: job({friendValue: 10, requestedUsdMicro: 20 * M, estimateUsdMicro: 3 * M})});
  assert.equal(decision.admitted, false);
  assert.equal(decision.projection.reasonCode, 'objective_exceeds_spare');
  assert.equal(decision.projection.estimateUsd, 3);
  assert.equal(decision.projection.requestedUsd, 20);
  assert.equal(decision.projection.maximumExposureUsd, 10);
  assert.equal(decision.reasonText, 'Holding this job: it needs $20.00, and $10.00 is spare now.');
  const status = lendingStatus({reason: 'exceeds_spare', detail: {needUsd: decision.projection.requestedUsd,
    spareUsd: decision.projection.maximumExposureUsd}});
  assert.equal(status.id, 'spare');
  assert.equal(status.line, 'Holding — this job needs $20.00, and $10.00 is spare now. It clears on its own when enough quota is '
    + 'spare for the whole job.');
  assert.equal(lendingStatus({reason: 'exceeds_spare'}).line, 'Holding — this job needs more than the spare quota now. It clears on '
    + 'its own when enough quota is spare for the whole job.');
});

test('the owner per-job limit, when it is the binding cap, holds as a request above the limit and not as a spare hold', () => {
  const decision = decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: ample(), band: calibration(), owner: OWNER_NONE, gates: GATES, laterBurnCapacityMicro: emptyQueue,
    ownerMaxJobUsdMicro: 5 * M,
    job: job({friendValue: 10, requestedUsdMicro: 20 * M, estimateUsdMicro: 20 * M})});
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'request_too_large');
  assert.equal(decision.projection.reasonCode, 'objective_request_too_large');
  assert.match(decision.reasonText, /per-job limit of \$5\.00 allows/);
  assert.match(lendingStatus({reason: 'request_too_large'}).line, /asks for more than your per-job limit allows/);
});

// The designated weekly identity is semantic, not a spelling convention for the resource key.
for (const source of ['history', 'model']) {
  for (const weeklyResource of ['seven_day', 'custom_week']) {
    for (const withShort of [false, true]) {
      const input = () => {
        const original = windows({weeklyUsedMicro: 10 * M, shortUsedMicro: 0});
        const resources = {[weeklyResource]: {...original.seven_day}};
        if (withShort) resources.five_hour = {...original.five_hour};
        const band = calibration();
        band.forecasts = band.forecasts.filter(f => withShort || f.id === 'seven_day')
          .map(f => ({...f, id: f.id === 'seven_day' ? weeklyResource : f.id}));
        return {now: NOW, observedAt: NOW, weeklyResource, windows: resources, band,
          frozenProtectionSource: source,
          owner: {scenarios: [{probability: 1, attempts: []}]}, gates: GATES,
          laterBurnCapacityMicro: 87 * M, job: job()};
      };
      const label = `${source}, ${weeklyResource}, ${withShort ? 'weekly+short' : 'weekly-only'}`;
      test(`weekly kind valid control: ${label}`, () => {
        const decision = decideObjectiveLend(input());
        assert.equal(decision.admitted, true, decision.reason);
        assert.equal(decision.protectionSource[weeklyResource], source);
        assert.ok(decision.exposureUsdMicro > 0);
      });
      for (const kind of ['short', undefined, 'unknown']) {
        test(`designated weekly rejects ${kind ?? 'missing'} kind: ${label}`, () => {
          const malformed = input();
          if (kind === undefined) delete malformed.windows[weeklyResource].kind;
          else malformed.windows[weeklyResource].kind = kind;
          assert.throws(() => decideObjectiveLend(malformed), /weekly resource must declare weekly kind/);
        });
      }
    }
  }
}
