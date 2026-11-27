import './helpers/no-browser.mjs';
// The machine zone is Chicago for every test here; it is set before the app module is loaded.
process.env.TZ = 'America/Chicago';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {writeMacUpdateBoot} from '../lib/v1/macos-update-boot.mjs';
const {appFixture, api, waitFor} = await import('./helpers/v1-app-fixture.mjs');

// Settings files in the shape release .61 wrote (lib/v1/app.mjs and lending-policy.mjs at f57df1e0): no timeZoneChosen marker,
// limits with a saved UTC zone and the old 3-jobs, 60-minutes default, and a current-shape lending policy.
// Release .61 already reset both at startup.
const MACHINE_ZONE = 'America/Chicago';
const OLD_SCHEDULE = {days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', weekends_all_day: false};
const POLICY_61 = {strategy: 'automatic', strategyParams: {perJobPct: 9}, protectionPosition: 'share_more', warningPct: 10,
  effortMax: 'high', allowFast: false, stopOnReturn: true, machineSlots: 3, accountSlots: 1, watchOnlyUntil: null,
  providerConsent: {claude: true, codex: true}, accountPlans: {claude: 'max20', codex: 'plus'}, probeMinutes: 30};

async function startFrom(t, limits, extra = {}) {
  const f = await appFixture(t), home = await f.home('owner');
  await mkdir(join(home, 'v1'), {recursive: true});
  const file = join(home, 'v1', 'app-settings.json');
  await writeFile(file, JSON.stringify({version: 1, name: 'Saved settings', enabled: false, intent: 'off', agents: {}, modes: {},
    limits: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, quotaReserve: 30, idleOnly: true, timeZone: 'UTC', schedule: null, ...limits}, presenceDefaultsVersion: 1, ...extra}));
  const {app} = await f.start();
  return {app, saved: async () => JSON.parse(await readFile(file, 'utf8'))};
}

test('a saved UTC schedule from .61 stays UTC and is marked as chosen', async t => {
  const {app, saved} = await startFrom(t, {schedule: OLD_SCHEDULE});
  const view = await api(app, '/api/lending');
  assert.equal(view.limits.timeZone, 'UTC');
  assert.deepEqual(view.limits.schedule, OLD_SCHEDULE);
  assert.equal((await saved()).timeZoneChosen, true);
  assert.equal((await saved()).limits.timeZone, 'UTC');
});

test('a saved UTC daily limit from .61 stays UTC because it resets at UTC midnight', async t => {
  const {app} = await startFrom(t, {dailyJobs: 8});
  assert.equal((await api(app, '/api/lending')).limits.timeZone, 'UTC');
});

test('the untouched .61 default (UTC, no schedule, 3 jobs, 60 minutes) adopts the machine zone', async t => {
  const {app} = await startFrom(t, {});
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, MACHINE_ZONE);
  assert.equal((await api(app, '/api/lending')).limits.timeZone, MACHINE_ZONE);
});

test('one out-of-range field is reset and every other value is kept, but lending stays off until deliberately resumed', async t => {
  const {app, saved} = await startFrom(t, {lendingPolicy: {...POLICY_61, warningPct: 150}}, {intent: 'on'});
  const view = await api(app, '/api/lending');
  const policy = (await saved()).limits.lendingPolicy;
  assert.equal(policy.warningPct, 10, 'the bad field returns to its default');
  assert.deepEqual({...policy, providerConsent: POLICY_61.providerConsent}, {...POLICY_61, warningPct: 10}, 'nothing else changed, plans included');
  assert.equal(policy.providerConsent, undefined);
  assert.equal(view.limits.lendingPolicy.providerConsent, undefined);
  assert.equal(view.lending_on, false);
  assert.deepEqual(view.migration.reset, [{field: 'warningPct', was: 150}]);
  assert.equal(view.migration.consentReset, true);
  assert.equal(view.migration.acknowledged, false);
});

test('one bad strategy number is reset alone; the rest is kept and lending is off', async t => {
  const {app, saved} = await startFrom(t, {lendingPolicy: {...POLICY_61, strategyParams: {perJobPct: 9000}}}, {intent: 'on'});
  const view = await api(app, '/api/lending');
  assert.deepEqual(view.migration.reset, [{field: 'strategyParams.perJobPct', was: 9000}]);
  assert.equal(view.lending_on, false);
  assert.equal((await saved()).limits.lendingPolicy.protectionPosition, 'share_more');
  assert.equal((await saved()).limits.lendingPolicy.machineSlots, 3);
  assert.deepEqual((await saved()).limits.lendingPolicy.accountPlans, POLICY_61.accountPlans);
});

test('a policy that is not an object is reset, lending is off, and the note keeps what was saved', async t => {
  const {app, saved} = await startFrom(t, {lendingPolicy: 'broken'}, {intent: 'on'});
  const view = await api(app, '/api/lending');
  assert.equal(view.lending_on, false);
  assert.equal((await saved()).limits.lendingPolicy.providerConsent, undefined);
  assert.deepEqual(view.migration.reset, [{field: 'lendingPolicy', was: 'broken'}]);
  assert.equal(view.migration.consentReset, true);
});

test('legacy consent is discarded without a policy repair', async t => {
  const {app, saved} = await startFrom(t, {lendingPolicy: {...POLICY_61, providerConsent: {claude: 'yes'}}}, {intent: 'on'});
  const view = await api(app, '/api/lending');
  assert.equal(view.migration, null);
  assert.equal((await saved()).limits.lendingPolicy.providerConsent, undefined);
  assert.equal((await saved()).limits.lendingPolicy.machineSlots, 3);
});

test('mixed saved provider maps preserve valid siblings while lending stays off', async t => {
  const accountPlans = {claude:'max20', codex:'not-a-plan'};
  const providerConsent = {claude:true, codex:'yes'};
  const {app, saved} = await startFrom(t, {lendingPolicy:{...POLICY_61, accountPlans, providerConsent}}, {intent:'on'});
  const view = await api(app, '/api/lending');
  const persisted = await saved();
  const expectedPlans = {claude:'max20', codex:'unknown'};
  assert.deepEqual(view.limits.lendingPolicy.accountPlans, expectedPlans);
  assert.deepEqual(persisted.limits.lendingPolicy.accountPlans, expectedPlans);
  assert.deepEqual(view.migration.reset, [{field:'accountPlans',was:accountPlans}]);
  assert.equal(view.limits.lendingPolicy.providerConsent, undefined);
  assert.equal(persisted.limits.lendingPolicy.providerConsent, undefined);
  assert.equal(view.lending_on, false);
  assert.equal(persisted.intent, 'off');
  assert.equal(persisted.enabled, false);
});

// Lending that was running (on, paused, timed pause, or an old enabled flag) must not resume by itself after a repair.
const BOOT_ID = '11111111-1111-1111-1111-111111111111';
async function runningLenderThenEdit(t, edit) {
  const f = await appFixture(t), {lender, circle} = await f.connect();
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await lender.app.close();
  const file = join(lender.home, 'v1', 'app-settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  edit(settings);
  await writeFile(file, JSON.stringify(settings));
  return {f, file, circle, home: lender.home};
}
const policyOf = settings => ({...settings.limits.lendingPolicy, providerConsent: {claude: true, codex: true}});
const STATES = [
  ['paused', s => { s.intent = 'paused'; s.paused = true; }],
  ['a timed pause', s => { s.intent = 'on'; s.pause_until = Date.now() + 3600000; }],
  ['a legacy enabled flag with no intent', s => { delete s.intent; s.enabled = true; }],
  ['on', s => { s.intent = 'on'; }],
];
const quiet = ms => new Promise(resolve => setTimeout(resolve, ms));
const noAutoResume = (f, restarted, before) => {
  assert.equal(restarted.backend.calls.some(c => ['admit', 'run'].includes(c[0])), false);
  assert.equal(f.networkTrace.filter(x => x.device === 'lender' && x.route?.includes('claim-next')).length, before);
};

for (const [label, state] of STATES) {
  test(`a repaired policy saved while lending was ${label} leaves lending off, and restart does not resume it`, {timeout: 120000}, async t => {
    const {f, file, circle} = await runningLenderThenEdit(t, s => { state(s); s.limits.lendingPolicy = policyOf(s); s.limits.lendingPolicy.warningPct = 150; });
    const before = f.networkTrace.filter(x => x.device === 'lender' && x.route?.includes('claim-next')).length;
    const restarted = await f.start('lender');
    await quiet(300);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.intent, 'off');
    assert.equal(saved.paused, false);
    assert.equal(saved.pause_until, null);
    assert.equal(saved.enabled, false);
    const view = await api(restarted.app, '/api/lending');
    assert.equal(view.lending_on, false);
    assert.equal(view.intent, 'off');
    assert.equal(view.enabled, false);
    assert.equal(view.limits.lendingPolicy.providerConsent, undefined);
    assert.equal(view.migration.consentReset, true);
    noAutoResume(f, restarted, before);
    assert.ok(circle.id);
  });

  test(`a repaired policy saved while lending was ${label} is not resumed when an update-boot hold is released`, {timeout: 120000}, async t => {
    const {f, file, home} = await runningLenderThenEdit(t, s => { state(s); s.limits.lendingPolicy = policyOf(s); s.limits.lendingPolicy.warningPct = 150; });
    const identity = {appPath: join(f.root, 'Faravan.app'), version: '1.0.2', channel: 'faravan', bundleId: 'com.example.app'};
    const request = {schema: 1, transactionId: BOOT_ID, home, journalPath: identity.appPath + '.update-journal.json', ...identity, expiresAt: Date.now() + 300000};
    await writeMacUpdateBoot(request);
    const journal = phase => writeFile(request.journalPath, JSON.stringify({schema: 1, id: BOOT_ID, appPath: identity.appPath, home,
      channel: identity.channel, bundleId: identity.bundleId, version: identity.version, previousVersion: '1.0.1', phase}), {mode: 0o600});
    await journal('starting');
    const before = f.networkTrace.filter(x => x.device === 'lender' && x.route?.includes('claim-next')).length;
    const restarted = await f.start('lender', {updateBootIdentity: identity, faravanVersion: identity.version, updateBootPollMs: 20});
    await journal('committed');
    await waitFor(async () => !(await api(restarted.app, '/api/updates')).updateHold, 'the boot hold releases');
    await quiet(300);
    const view = await api(restarted.app, '/api/lending');
    assert.equal(view.intent, 'off');
    assert.equal(view.enabled, false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).intent, 'off');
    noAutoResume(f, restarted, before);
  });
}

test('a valid current-shape policy is left alone: no notice, no change to lending state', {timeout: 120000}, async t => {
  const {f, file} = await runningLenderThenEdit(t, s => { s.intent = 'paused'; s.paused = true; s.limits.lendingPolicy = {...s.limits.lendingPolicy, ...POLICY_61}; });
  const restarted = await f.start('lender');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const view = await api(restarted.app, '/api/lending');
  assert.equal(view.migration, null);
  assert.equal(saved.lendingPolicyMigration, undefined);
  assert.equal(saved.intent, 'paused');
  assert.equal(saved.paused, true);
  assert.deepEqual(saved.limits.lendingPolicy, POLICY_61, 'the policy and its consent are unchanged');
});
