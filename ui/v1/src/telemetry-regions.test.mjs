import test from 'node:test';
import assert from 'node:assert/strict';
import {regionDefault} from '../../../lib/v1/telemetry/consent.mjs';
import {ASK_FIRST_REGIONS, REGION_CODES, asksFirst, isRegionCode, regionOptions} from './telemetry-regions.mjs';

const ASK_FIRST_SPEC = [];

test('launch policy has no ask-first regions', () => {
  assert.deepEqual([...ASK_FIRST_REGIONS].sort(), [...ASK_FIRST_SPEC].sort());
  assert.equal(new Set(ASK_FIRST_REGIONS).size, ASK_FIRST_REGIONS.length);
});

test('the UI table equals the server rule for every region code, and for what is not a code', () => {
  for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) {
    const code = String.fromCharCode(a, b);
    assert.equal(asksFirst(code), regionDefault(code) === null, code);
  }
  for (const value of [null, undefined, '', 'us', 'USA', 'U', 7, {}]) assert.equal(asksFirst(value), regionDefault(value) === null, String(value));
  assert.equal(isRegionCode('US'), true);
  assert.equal(isRegionCode('us'), false);
});

test('the country list is the 249 ISO 3166-1 codes, each with a name, with no legacy or grouped codes', () => {
  assert.equal(REGION_CODES.length, 249);
  assert.equal(new Set(REGION_CODES).size, 249);
  for (const code of REGION_CODES) assert.ok(isRegionCode(code), code);
  for (const code of ['UK', 'EU', 'UN', 'ZZ', 'SU', 'YU', 'AN']) assert.ok(!REGION_CODES.includes(code), code + ' is not a country');
  for (const code of [...ASK_FIRST_REGIONS, 'US', 'CA', 'JP', 'AU', 'IN', 'BR']) assert.ok(REGION_CODES.includes(code), code);
  const names = new Intl.DisplayNames('en', {type: 'region', fallback: 'none'});
  for (const code of REGION_CODES) assert.ok(names.of(code), code + ' has a name');
});

test('regionOptions gives sorted, named options and falls back to codes', () => {
  const options = regionOptions('en');
  assert.equal(options.length, 249);
  assert.deepEqual(options.find(item => item.code === 'GB'), {code: 'GB', name: 'United Kingdom'});
  const sorted = [...options].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  assert.deepEqual(options.map(item => item.code), sorted.map(item => item.code));
  assert.deepEqual(regionOptions('en', ['US', 'DE']).map(item => item.code), ['DE', 'US']);
});
