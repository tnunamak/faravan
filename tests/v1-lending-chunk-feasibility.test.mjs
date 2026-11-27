import './helpers/no-browser.mjs';
// Review regression (dot review faravan-review-core-port-1024, P2): a chunk below the worst-call headroom has no native
// budget. It must be infeasible alone, and it must not poison the feasible chunks beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decideObjectiveLend, MICRO} from '../lib/v1/lending-objective.mjs';
import {calibration, GATES, NOW, OWNER_NONE, job, windows} from './helpers/lending-objective-fixtures.mjs';

const M = MICRO;

function decideWith(chunkCandidates) {
  return decideObjectiveLend({now: NOW, observedAt: NOW,
    windows: windows({weeklyUsedMicro: 0, shortUsedMicro: 0}), band: calibration(), owner: OWNER_NONE, gates: GATES,
    laterBurnCapacityMicro: 0,
    job: job({friendValue: 1, requestedUsdMicro: 5 * M, estimateUsdMicro: 5 * M, worstCallUsdMicro: M, chunkCandidates})});
}

test('small-plus-large: the undersized chunk is infeasible alone; the large chunk is admitted with its $2 native budget', () => {
  const d = decideWith([{id: 'small', usdMicro: 500_000, friendValue: 1}, {id: 'large', usdMicro: 3 * M, friendValue: 2}]);
  assert.equal(d.admitted, true, d.reasonCode);
  assert.equal(d.reason, 'lend');
  assert.equal(d.chunkId, 'large');
  assert.equal(d.nativeBudgetUsdMicro, 2 * M);
});

test('an undersized chunk alone is a named hold, never an invalid-input throw', () => {
  const d = decideWith([{id: 'small', usdMicro: 500_000, friendValue: 1}]);
  assert.equal(d.admitted, false);
  assert.ok(typeof d.reasonCode === 'string' && d.reasonCode.length > 0);
});
