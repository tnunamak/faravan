import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {decideObjectiveLend} from '../lib/v1/lending-objective.mjs';
import {calibration, MICRO, NOW, OWNER_NONE, RESET, windows} from './helpers/lending-objective-fixtures.mjs';

// The old minimum-quote and overrun-margin tests pinned an independent allocator.
// The objective now caps total spend and subtracts one worst-call headroom for the native cap.
const MODELS = [
  ['claude-haiku-5-5', 1_320_000, 10_680_000],
  ['claude-sonnet-5-5', 5_280_000, 6_720_000],
  ['claude-opus-5-5', 10_560_000, 1_440_000],
];
const GATES = {consent: true, limits: true, funding: true, stopping: true};

function decide({model, ownerCapUsd, requestedUsd, chunkCandidates} = {}) {
  return decideObjectiveLend({
    now: NOW,
    observedAt: NOW,
    windows: windows({weeklyUsedMicro: 10 * MICRO, shortUsedMicro: 0, resetAtMs: RESET}),
    band: calibration({weeks: 19}),
    owner: OWNER_NONE,
    gates: GATES,
    laterBurnCapacityMicro: 0,
    ownerMaxJobUsdMicro: ownerCapUsd === null ? null : Math.round(ownerCapUsd * MICRO),
    job: {id: model, friendValue: 100, estimateUsdMicro: requestedUsd * MICRO,
      requestedUsdMicro: requestedUsd === null ? null : requestedUsd * MICRO,
      worstCallUsdMicro: Math.round(claudeCallHeadroomUsd(model) * MICRO),
      wallMs: 60_000, uncertaintyMs: 30_000, stopMs: 60_000,
      ...(chunkCandidates ? {chunkCandidates} : {})},
  });
}

test('the total-spend cap subtracts exactly one model worst-call headroom', () => {
  for (const [model, headroomMicro, nativeAtTwelveMicro] of MODELS) {
    assert.equal(Math.round(claudeCallHeadroomUsd(model) * MICRO), headroomMicro);
    const result = decide({model, ownerCapUsd: 12, requestedUsd: 20,
      chunkCandidates: [{id: 'twelve-dollar-checkpoint', usdMicro: 12 * MICRO, friendValue: 100}]});
    assert.equal(result.admitted, true, `${model}: ${result.reasonText}`);
    assert.equal(result.maximumExposureUsd, 12, `${model}: owner cap bounds total spend`);
    assert.equal(Math.round(result.nativeMaxBudgetUsd * MICRO), nativeAtTwelveMicro,
      `${model}: native cap leaves one worst-case call inside total exposure`);
  }
});

test('the borrower request can be the smaller total-spend cap', () => {
  const result = decide({model: MODELS[0][0], ownerCapUsd: 20, requestedUsd: 12});
  assert.equal(result.admitted, true, result.reasonText);
  assert.equal(result.maximumExposureUsd, 12);
  assert.equal(result.nativeMaxBudgetUsd, 10.68);
});

test('a $1.50 total cap has no fixed minimum quote, while a cap below headroom holds', () => {
  const smallUsefulChunk = decide({model: MODELS[0][0], ownerCapUsd: 1.5, requestedUsd: 1.5});
  assert.equal(smallUsefulChunk.admitted, true, smallUsefulChunk.reasonText);
  assert.equal(smallUsefulChunk.maximumExposureUsd, 1.5);
  assert.equal(smallUsefulChunk.nativeMaxBudgetUsd, 0.18);

  const tooSmall = decide({model: MODELS[0][0], ownerCapUsd: 1, requestedUsd: 3});
  assert.equal(tooSmall.admitted, false);
  assert.equal(tooSmall.reasonCode, 'budget_too_small');
  assert.equal(tooSmall.nativeMaxBudgetUsd, 0);
});
