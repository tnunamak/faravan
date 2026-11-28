import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';
import {calibration, MICRO, NOW, OWNER_NONE, RESET, windows} from './helpers/lending-objective-fixtures.mjs';

const HAIKU = 'claude-haiku-5-5';
const HEADROOM_MICRO = 1_320_000;
const GATES = {consent: true, limits: true, funding: true, stopping: true};

function decide({requestedUsd, chunkCandidates} = {}) {
  return decideObjectiveLend({
    now: NOW,
    observedAt: NOW,
    windows: windows({weeklyUsedMicro: 10 * MICRO, shortUsedMicro: 0, resetAtMs: RESET}),
    band: calibration({weeks: 19}),
    owner: OWNER_NONE,
    gates: GATES,
    laterBurnCapacityMicro: 0,
    job: {id: 'claude-chunk', friendValue: 3, estimateUsdMicro: requestedUsd * MICRO,
      requestedUsdMicro: requestedUsd === null ? null : requestedUsd * MICRO,
      worstCallUsdMicro: HEADROOM_MICRO, wallMs: 60_000, uncertaintyMs: 30_000, stopMs: 60_000,
      ...(chunkCandidates ? {chunkCandidates} : {})},
  });
}

test('one catalog headroom prices the largest reachable Claude call', () => {
  const headroom = claudeCallHeadroomUsd(HAIKU);
  assert.equal(headroom, 1.32);
  assert.equal(Math.round(headroom * MICRO), HEADROOM_MICRO);
  assert.equal(claudeCallHeadroomUsd('no-such-model'), null);
});

test('the objective subtracts one call from the requested size', () => {
  const requestBound = decide({requestedUsd: 2});
  assert.equal(requestBound.admitted, true, requestBound.reasonText);
  assert.equal(requestBound.maximumExposureUsd, 2);
  assert.equal(requestBound.nativeMaxBudgetUsd, 680_000 / MICRO);
});

test('there is no fixed minimum quote: a $1.50 total cap admits after reserving the $1.32 call headroom', () => {
  const result = decide({requestedUsd: 1.5});
  assert.equal(result.admitted, true, result.reasonText);
  assert.equal(result.maximumExposureUsd, 1.5);
  assert.equal(result.nativeMaxBudgetUsd, 180_000 / MICRO);
});

test('a total cap below one worst-case call holds with budget_too_small', () => {
  const result = decide({requestedUsd: 1});
  assert.equal(result.admitted, false);
  assert.equal(result.reasonCode, 'budget_too_small');
  assert.equal(result.maximumExposureUsd, 1);
  assert.equal(result.nativeMaxBudgetUsd, 0);
});
