import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFact} from '../lib/v1/telemetry/contract.mjs';
import {STEPS} from '../lib/v1/setup-progress.mjs';

test('onboarding uses existing setup IDs and closed outcomes, integer duration and surface', () => {
  for(const step of Object.keys(STEPS))for(const outcome of ['entered','completed','skipped','failed']) {
    const value={step,outcome,duration_ms:123,surface:'ui'};
    assert.deepEqual(parseFact('onboarding_step_changed',value),value);
  }
});
test('onboarding refuses unknown keys, private values and fractional or excessive durations', () => {
  const base={step:'kvm',outcome:'entered',duration_ms:0,surface:'cli'};
  assert.deepEqual(parseFact('onboarding_step_changed',base),base,'the valid control must be accepted before malformed variants');
  for(const patch of [{prompt:'private'},{step:'private'},{outcome:'private'},{surface:'private'},
    {duration_ms:0.5},{duration_ms:-1},{duration_ms:2**31},{duration_ms:NaN}])
    assert.throws(()=>parseFact('onboarding_step_changed',{...base,...patch}),{code:Number.isNaN(patch.duration_ms)?'bad_type':'invalid_fact'});
});
test('existing numeric fields continue accepting fractional values', () => {
  assert.equal(parseFact('system_profile_observed',{total_ram_gib:7.5}).total_ram_gib,7.5);
});
