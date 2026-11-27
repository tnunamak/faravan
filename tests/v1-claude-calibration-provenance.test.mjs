import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realSource from '../lib/v1/lending-pace50-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);

// M1 uses shipped certified bounds, not locally fitted movement/cost records.
// Verify both the accepted rows and refusal of an unknown pricing domain.
const domain = {provider: 'claude', plan: 'max20', window: 'five_hour', model: 'claude-haiku-5-5'};
test('certified conversion carries the accepted bound and provenance', () => {
  const bound = source.certifiedKappa(domain);
  assert.equal(bound.upper_micro, 1583100);
  assert.equal(bound.lower_micro, null, 'no lower bound is invented');
  assert.equal(source.certifiedKappa({...domain, window: 'weekly'}).upper_micro, 534900);
  assert.ok(bound.provenance.method);
  assert.ok(bound.provenance.boundReport);
  assert.ok(bound.provenance.acceptedBy);
});
test('unknown or incomplete conversion domains stay unknown', () => {
  for (const key of Object.keys(domain)) {
    assert.equal(source.certifiedKappa({...domain, [key]: undefined}), null, key);
    assert.equal(source.certifiedKappa({...domain, [key]: 'unknown'}), null, key);
  }
  assert.equal(source.certifiedKappa(), null);
});
test('callers cannot mutate shipped provenance through a returned conversion', () => {
  const first = source.certifiedKappa(domain);
  first.provenance.acceptedBy = 'untrusted replacement';
  assert.notEqual(source.certifiedKappa(domain).provenance.acceptedBy, first.provenance.acceptedBy);
});
test('neither local calibration nor a plan label supplies a conversion without a verified account', async () => {
  const now = Date.parse('2026-10-23T06:40:00Z');
  const src = source.createRealPace50Source({
    readings: async () => ({windows: [
      {window_id: 'seven_day', window_minutes: 10080, used_pct: 5, resets_at: now + 86400000, observed_at: now, state: 'open'},
    ]}),
    calibration: async () => { throw new Error('local calibration must not be consulted'); },
  });
  const obs = await src.observe({...domain, plan: 'unknown'});
  assert.equal(obs.resources[0].kappa_micro, null);
  const accepted = await src.observe(domain);
  assert.equal(accepted.resources[0].kappa_micro, null, 'no seed rate for a supported plan either');
});
