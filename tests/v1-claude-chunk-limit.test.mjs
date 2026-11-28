import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {chunkLimitUsdMicro} from '../lib/v1/chunk-limit.mjs';

test('the objective size is lowered by the owner total-spend cap and borrower request', () => {
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 1_500_000}), 1_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000}), 2_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 0}), 0,
    'a zero total-spend cap allows no exposure');
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 2_000_000,
    jobLimitUsdMicro: 700_000}), 700_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 2_000_000,
    jobLimitUsdMicro: 5_000_000}), 2_000_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, jobLimitUsdMicro: 1_500_000}), 1_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, jobLimitUsdMicro: 9_000_000}), 2_500_000);
});
