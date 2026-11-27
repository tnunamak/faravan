import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkLimitUsdMicro} from '../lib/v1/chunk-limit.mjs';

const M = 1_000_000;

test('the objective-selected size is bounded by owner total spend and the borrower request in exact micro-dollars', () => {
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000}), 2_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 1_500_000}), 1_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 2_000_000,
    jobLimitUsdMicro: 700_000}), 700_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 0}), 0);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 0}), null);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2 * M, ownerLimitUsdMicro: -1}), null);
});
