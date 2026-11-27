import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {normalizeLendingPolicy, strategyCeilingMicro} from '../lib/v1/lending-policy.mjs';

// The engine checks the numbers a strategy reads, refuses a bad one by field, and fills the advertised defaults. Synthetic only.
const refusal = policy => {
  try { normalizeLendingPolicy(policy); return null; } catch (error) { return error; }
};

test('a string per-job cap is refused by field, not read as no cap', () => {
  const error = refusal({strategyParams: {perJobPct: '1'}});
  assert.equal(error?.message, 'invalid_lending_policy');
  assert.equal(error.field, 'strategyParams.perJobPct');
  assert.equal(error.reason, 'must be number');
});

test('a custom start point outside 0.2 to 0.5 is refused by field', () => {
  assert.equal(refusal({strategy: 'custom', strategyParams: {e0: -1}})?.field, 'strategyParams.e0');
  assert.equal(refusal({strategy: 'custom', strategyParams: {e0: 0.6}})?.field, 'strategyParams.e0');
});

test('fixed_share numbers outside 0 to 100 are refused by field', () => {
  assert.equal(refusal({strategy: 'fixed_share', strategyParams: {fixedSharePct: 101, keepPct: 30}})?.field, 'strategyParams.fixedSharePct');
  assert.equal(refusal({strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: -20}})?.field, 'strategyParams.keepPct');
});

test('an unknown parameter and an unknown field are refused by name', () => {
  assert.equal(refusal({strategyParams: {bogus: 1}})?.field, 'strategyParams.bogus');
  assert.equal(refusal({effort: 'max'})?.field, 'effort');
});

test('numbers the chosen strategy does not read are kept as saved, unchecked', () => {
  const kept = normalizeLendingPolicy({strategy: 'automatic', strategyParams: {e0: 'junk', fixedSharePct: 150}});
  assert.equal(kept.strategyParams.e0, 'junk');
  assert.equal(kept.strategyParams.fixedSharePct, 150);
});

test('the advertised defaults apply at normalization, and their ceilings are the catalog values', () => {
  const weekly = {usedMicro: 0, committedMicro: 0, lentMicro: 0, resetAtMs: 604800000};
  const now = 453600000; // three quarters of the week has elapsed
  assert.deepEqual({...normalizeLendingPolicy({strategy: 'fixed_share'}).strategyParams}, {fixedSharePct: 20, keepPct: 30, perJobPct:10});
  assert.deepEqual({...normalizeLendingPolicy({strategy: 'custom'}).strategyParams}, {e0: 0.5, perJobPct:10});
  assert.equal(strategyCeilingMicro(normalizeLendingPolicy({strategy: 'fixed_share'}), weekly, now), 10000000);
  assert.equal(strategyCeilingMicro(normalizeLendingPolicy({strategy: 'custom'}), weekly, now), 10000000);
  assert.equal(strategyCeilingMicro(normalizeLendingPolicy({strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30}}),
    weekly, now), 10000000, 'the default and the explicit numbers give the same ceiling');
});

test('a fixed share already lent in full this week allows nothing more, even with nothing held', () => {
  // Settled friend spend counts toward the share once the provider reading has not yet caught up (lentMicro = spent + held).
  const lentFull = {usedMicro: 20000000, committedMicro: 0, lentMicro: 20000000, resetAtMs: 604800000};
  assert.equal(strategyCeilingMicro(normalizeLendingPolicy({strategy: 'fixed_share'}), lentFull, 453600000), 0);
});

test('a present per-job cap that is not a number holds the job, never drops the cap', () => {
  const unchecked = {strategy: 'automatic', strategyParams: {perJobPct: '1'}};
  assert.equal(strategyCeilingMicro(unchecked, {usedMicro: 0, committedMicro: 0, resetAtMs: 604800000}, 453600000), 0);
});

test('the page refuses a bad live number by field and leaves the saved policy and its version unchanged', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  const before = await api(lender.app, '/api/lending');
  const problem = await api(lender.app, '/api/lending/limits', {method: 'POST', status: 400,
    body: {lendingPolicy: {strategyParams: {perJobPct: '1'}}}});
  assert.equal(problem.code, 'invalid_request');
  assert.equal(problem.field, 'lendingPolicy.strategyParams.perJobPct');
  assert.match(problem.message, /lendingPolicy\.strategyParams\.perJobPct must be number/);
  const after = await api(lender.app, '/api/lending');
  assert.equal(after.configVersion, before.configVersion, 'a refused save changes nothing');
  assert.equal(after.limits.lendingPolicy.strategy, 'automatic');
});

test('a saved policy this build refuses does not stop startup; its consent is cleared until the owner saves again', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  await lender.app.close();
  const file = join(await f.home('lender'), 'v1', 'app-settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.limits = {...settings.limits, lendingPolicy: {...settings.limits.lendingPolicy, strategy: 'custom',
    strategyParams: {e0: 3}, providerConsent: {claude: true}}};
  await writeFile(file, JSON.stringify(settings));
  const restarted = await f.start('lender');
  const view = await api(restarted.app, '/api/lending');
  assert.deepEqual(view.limits.lendingPolicy.providerConsent, {}, 'no consent, so nothing lends');
});
