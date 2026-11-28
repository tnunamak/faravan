import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
const HAIKU='claude-haiku-5-5',NEAR=(a,b)=>Math.abs(a-b)<1e-9;
test('the per-call headroom prices the largest context in the tier that context reaches', () => {
  // Haiku 5.5's largest context is 1M tokens, above the 100k threshold, so each input token is priced at the higher tier:
  // 1,000,000 x $1.00/M cache write, plus 128,000 x $2.50/M output.
  assert.ok(NEAR(claudeCallHeadroomUsd(HAIKU), 1.32), `haiku 5.5 headroom ${claudeCallHeadroomUsd(HAIKU)}`);
  // Haiku 4.5 has no higher tier: 200,000 x $2.00/M cache write, plus 128,000 x $5.00/M output.
  assert.ok(NEAR(claudeCallHeadroomUsd('claude-haiku-4-5'), 1.04), `haiku 4.5 headroom ${claudeCallHeadroomUsd('claude-haiku-4-5')}`);
});