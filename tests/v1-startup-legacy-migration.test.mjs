import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';

// Item 2 of the startup lane: a settings file written by an older build is migrated at startup, before validation, into the
// strategy-and-position shape. People, agents, expiry and the remaining limits are carried over unchanged.
// Synthetic circle and devices only; no provider calls.

const EXPIRY = 4102444800000;
const CONSENT = {claude: true};
const PLANS = {claude: 'max20'};

const LEGACY_SHAPES = [
  ['unlikely_to_need', {preset: 'unlikely_to_need', e0: 0.5, perJobPct: 5}, {strategy: 'automatic', protectionPosition: 'keep_more_for_me',
    strategyParams: {perJobPct: 5}}],
  ['lend_more', {preset: 'lend_more', e0: 0.3, perJobPct: 10}, {strategy: 'automatic', protectionPosition: 'share_more',
    strategyParams: {perJobPct: 10}}],
  ['fixed_share', {preset: 'fixed_share', fixedSharePct: 20, keepPct: 30, perJobPct: 5}, {strategy: 'fixed_share', protectionPosition: 'keep_more_for_me', strategyParams: {fixedSharePct: 20, keepPct: 30, perJobPct: 5}}],
  ['custom', {preset: 'custom', e0: 0.5, keepPct: 40, perJobPct: 8}, {strategy: 'custom', protectionPosition: 'keep_more_for_me', strategyParams: {e0: 0.5, keepPct: 40, perJobPct: 8}}],
];

// Connect a real owner, lender and circle, stop the lender, then save the legacy shape with rules that name the real circle.
// The lender stays stopped: the caller decides how it starts again.
async function legacyFixture(t, policy) {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect();
  const rule = {id: 'owner-rule', circle: circle.id, people: [owner.app.device.keyId], agents: ['claude-code-subscription'],
    maxWallSeconds: 1200, dailyJobs: 3, weeklyJobs: 21, dailyMinutes: 60, weeklyMinutes: 420, expiresAt: EXPIRY};
  await lender.app.close();
  const file = join(await f.home('lender'), 'v1', 'app-settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.limits = {...settings.limits, lendingPolicy: {...policy, providerConsent: CONSENT, accountPlans: PLANS, watchOnlyUntil: EXPIRY}};
  settings.standingRules = [rule];
  await writeFile(file, JSON.stringify(settings));
  return {f, file, rule, circle};
}
async function legacyLender(t, policy) {
  const {f, file, rule, circle} = await legacyFixture(t, policy);
  const restarted = await f.start('lender');
  return {file, rule, circle, restarted, f};
}

for (const [name, policy, expected] of LEGACY_SHAPES) {
  test(`a legacy ${name} settings file migrates to its strategy and removes retired consent and keeps people, expiry and limits`, {timeout: 120000}, async t => {
    const {file, rule, restarted} = await legacyLender(t, policy);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    const migrated = onDisk.limits.lendingPolicy;
    assert.equal(migrated.strategy, expected.strategy);
    if (expected.protectionPosition) assert.equal(migrated.protectionPosition, expected.protectionPosition);
    if (expected.strategyParams) assert.deepEqual(migrated.strategyParams, expected.strategyParams, 'the legacy numbers are kept as they were');
    assert.equal(Object.hasOwn(migrated, 'preset'), false, 'no legacy preset key survives the migration');
    assert.equal(migrated.providerConsent,undefined,'retired provider consent is removed');
    assert.deepEqual(migrated.accountPlans, PLANS);
    assert.equal(migrated.watchOnlyUntil, EXPIRY, 'the expiry is unchanged');
    // The app fills the schedule default into a rule on save; every field the owner set is unchanged.
    assert.deepEqual(onDisk.standingRules.map(({schedule, ...kept}) => kept), [rule], 'people, agents and expiry are unchanged');
    assert.equal(onDisk.limits.maxWallSeconds, null, 'no global wall-time default throttles lending');
    assert.equal(onDisk.limits.dailyJobs, null, 'no daily job default throttles lending');
    assert.equal(onDisk.limits.dailyMinutes, null, 'no daily minute default throttles lending');
    assert.equal(onDisk.lendingPolicyMigration?.fromLegacyPolicy, true, 'the migration is noted');
    assert.equal(onDisk.lendingPolicyMigration?.acknowledged, false, 'the note stays until the owner saves');
    const running = await api(restarted.app, '/api/lending');
    assert.equal(running.limits.lendingPolicy.accountPlans.claude,'max20','the saved plan remains visible');
  });

  test(`a legacy ${name} app reaches the backend with consent unchanged and migrates once`, {timeout: 120000}, async t => {
    const {f, file, restarted} = await legacyLender(t, policy);
    assert.ok(restarted.backend.calls.some(([kind]) => kind === 'probe'), 'startup reached the backend from the migrated settings');
    const first = JSON.parse(await readFile(file, 'utf8'));
    await restarted.app.close();
    // A second start from the migrated file does not migrate again: the policy and the one-time note are the same.
    await f.start('lender');
    const second = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(second.limits.lendingPolicy, first.limits.lendingPolicy, 'the policy is not migrated twice');
    assert.deepEqual(second.lendingPolicyMigration, first.lendingPolicyMigration, 'the note is written once');
    assert.equal(first.limits.lendingPolicy.strategy, expected.strategy);
  });
}

// The migration is written before the rest of startup runs. The lender's backend step is held open here, after the
// settings were validated and the device opened, so the file on disk must already be the migrated policy.
test('the migrated policy is on disk before startup goes on, and the atomic write leaves no temporary file', {timeout: 120000}, async t => {
  const {f, file} = await legacyFixture(t, LEGACY_SHAPES[0][1]);
  const backend = syntheticBackend(f.root);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = f.start('lender', {backend, backendFactory: () => gate.then(() => backend)});
  starting.catch(() => {});
  try {
    const onDisk = await waitFor(async () => {
      const value = JSON.parse(await readFile(file, 'utf8'));
      return value.lendingPolicyMigration?.fromLegacyPolicy === true ? value : null;
    }, 'the migrated policy on disk while startup waits at the backend step', 20000);
    assert.equal(onDisk.limits.lendingPolicy.strategy, 'automatic');
    assert.equal(Object.hasOwn(onDisk.limits.lendingPolicy, 'preset'), false, 'no legacy preset key is on disk');
    const leftovers = (await readdir(dirname(file))).filter(name => name.startsWith('app-settings.json.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the atomic write leaves no temporary file');
  } finally {
    release();
  }
  const restarted = await starting;
  const view = await api(restarted.app, '/api/lending');
  assert.equal(view.limits.lendingPolicy.accountPlans.claude, 'max20', 'startup finished on the migrated policy');
});

// A legacy start point outside today's range does not stop startup: it is clamped into the range, and the note names it.
test('a legacy custom start point outside 0.2 to 0.5 is clamped into it, and the migration note names it', {timeout: 120000}, async t => {
  const {f, file} = await legacyFixture(t, {preset: 'custom', e0: 0.6, keepPct: 40, perJobPct: 8});
  await f.start('lender');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.limits.lendingPolicy.strategy, 'custom');
  assert.equal(onDisk.limits.lendingPolicy.strategyParams.e0, 0.5, 'the start point is clamped to the top of its range');
  assert.deepEqual(onDisk.lendingPolicyMigration.adjusted, ['e0'], 'the note names the clamped number');
  assert.equal(onDisk.limits.lendingPolicy.strategyParams.keepPct, 40, 'an unread legacy number is kept as saved');
  assert.equal(onDisk.limits.lendingPolicy.providerConsent,undefined,'retired provider consent stays absent');
});

// A record this build cannot normalize at all is reset to the defaults with no consent, and startup carries on.
test('a legacy record that cannot be normalized is reset to the defaults with no consent, and startup continues', {timeout: 120000}, async t => {
  const {f, file} = await legacyFixture(t, {preset: 'fixed_share', warningPct: '10'});
  const restarted = await f.start('lender');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.limits.lendingPolicy.strategy, 'automatic', 'the defaults apply');
  assert.equal(onDisk.limits.lendingPolicy.providerConsent,undefined,'retired consent is absent');
  assert.ok(restarted.app, 'startup finished');
});
