import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {claudeCallHeadroomUsd, DEFAULT_RUN_MODEL} from '../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The owner's saved per-job limit, through the lender app's own routes. Nothing is saved by default. A change needs a reason,
// an in-range value and no unknown field, and it is audited with the value it replaced. A restart reads the same saved value.
const PATH = '/api/lending/owner-settings';
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}), account_week_id: 'synthetic-week-1'});

test('the owner saves a per-job limit through the app: refusals save nothing, a change is audited, and a restart keeps it', {timeout: 120000}, async (t) => {
  const f = await appFixture(t);
  const {lender} = await f.connect({lendingPace50: evidence()});
  const initial = await api(lender.app, PATH);
  assert.equal(initial.values, null, 'nothing is saved by default');
  assert.deepEqual(initial.audit, []);
  assert.equal(initial.defaultMaxJobUsd, Number((claudeCallHeadroomUsd(DEFAULT_RUN_MODEL.claude) + 4).toFixed(6)), 'the displayed default includes call headroom');
  assert.ok(initial.minimums.length > 0 && initial.minimums.every(row =>
    typeof row.model === 'string' && row.minimumMaxJobUsd > 0), 'model minimums are surfaced');

  await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 0.3}, status: 400});
  await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 0, reason: 'zero is not a limit'}, status: 400});
  await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: -1, reason: 'negative is not a limit'}, status: 400});
  await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 0.3, reason: 'extra field', override: true}, status: 400});
  assert.deepEqual(await api(lender.app, PATH), initial, 'refused changes save nothing and leave no audit');

  const saved = await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 0.3, reason: 'owner sets the Claude chunk limit'}});
  assert.equal(saved.values.maxJobUsd, 0.3);
  assert.equal(saved.audit.length, 1);
  assert.equal(saved.audit[0].by, 'owner');
  assert.equal(saved.audit[0].reason, 'owner sets the Claude chunk limit');
  assert.deepEqual(saved.audit[0].changed, {maxJobUsd: {from: null, to: 0.3}});

  const changed = await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 0.2, reason: 'lower it'}});
  assert.deepEqual(changed.audit.at(-1).changed, {maxJobUsd: {from: 0.3, to: 0.2}}, 'the audit records the value it replaced');
  assert.equal(changed.audit.length, 2);

  await lender.app.close();
  const restarted = await f.start('lender', {lendingPace50: evidence()});
  const after = await api(restarted.app, PATH);
  assert.equal(after.values.maxJobUsd, 0.2, 'the saved limit survives a restart');
  assert.equal(after.audit.length, 2, 'the audit trail survives a restart');
});

test('day-one lending exposes and persists the owner limit without an internal pace50 opt-in', {timeout: 120000}, async (t) => {
  const f = await appFixture(t);
  const {lender} = await f.connect({});
  const initial = await api(lender.app, PATH);
  assert.equal(initial.values, null);
  assert.equal(initial.defaultMaxJobUsd, Number((claudeCallHeadroomUsd(DEFAULT_RUN_MODEL.claude) + 4).toFixed(6)));
  const saved = await api(lender.app, PATH, {method: 'POST', body: {maxJobUsd: 4, reason: 'set day-one cap'}});
  assert.equal(saved.values.maxJobUsd, 4);
  assert.deepEqual(saved.audit[0].changed, {maxJobUsd: {from: null, to: 4}});
});
