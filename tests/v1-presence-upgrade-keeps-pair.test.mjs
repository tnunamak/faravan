import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {APP_DEFAULTS} from '../lib/v1/app.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {lenderFixture} from './helpers/v1-lender-fixture.mjs';

// A settings file as a release before the presence-default change saved it: configVersion 13, a chosen circle,
// provider consent, a custom per-job cap, and both presence protections on. It has no presence marker.
const savedBeforeChange = () => ({version: 1, configVersion: 13, intent: 'on', activeCircle: 'chosen-circle', agents: {},
  modes: {'chosen-circle': 'auto'}, timeZoneChosen: true,
  limits: {...structuredClone(APP_DEFAULTS), idleOnly: true, timeZone: 'UTC',
    lendingPolicy: {...normalizeLendingPolicy(), stopOnReturn: true, strategyParams: {perJobPct: 17},
      providerConsent: {claude: true, codex: true}}}});

test('an upgrade keeps both presence protections, the saved intent and removes retired consent, and a second start writes nothing', {timeout:60000}, async t => {
  const f = await appFixture(t), home = await f.home('presence-keep'), directory = join(home, 'v1');
  await mkdir(directory, {recursive: true});
  const file = join(directory, 'app-settings.json');
  await writeFile(file, JSON.stringify(savedBeforeChange()));
  let {app} = await f.start('presence-keep', {resumeLending: false});
  const first = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(first.limits.idleOnly, true);
  assert.equal(first.limits.lendingPolicy.stopOnReturn, true);
  assert.equal(first.intent, 'on');
  assert.equal(first.activeCircle, 'chosen-circle');
  assert.equal(first.limits.lendingPolicy.providerConsent, undefined);
  assert.equal(first.limits.lendingPolicy.strategyParams.perJobPct, 17);
  assert.equal(first.presenceDefaultsVersion, 2);
  const notice = (await api(app, '/api/home')).lendingPolicy.migration;
  assert.notEqual(notice?.presenceDefaultsChanged, true, 'nothing changed, so no notice says it did');
  assert.notEqual(notice?.presenceDefaultsUncertain, true);
  await app.close();
  const bytes = await readFile(file, 'utf8');
  ({app} = await f.start('presence-keep', {resumeLending: false}));
  await app.close();
  assert.equal(await readFile(file, 'utf8'), bytes, 'a second start writes nothing new');
});

test('a fresh install still gets the new presence defaults', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('presence-fresh', {resumeLending: false});
  const view = await api(app, '/api/home');
  assert.equal(view.lending.limits.idleOnly, false);
  assert.equal(view.lending.limits.lendingPolicy.stopOnReturn, false);
});

test('the migrated idle-only setting still holds a job while the owner is at the computer', {timeout:60000}, async t => {
  const app_ = await appFixture(t), home = await app_.home('presence-hold'), directory = join(home, 'v1');
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, 'app-settings.json'), JSON.stringify(savedBeforeChange()));
  const {app} = await app_.start('presence-hold', {resumeLending: false});
  const migrated = (await api(app, '/api/home')).lending.limits;
  const f = await lenderFixture(t, {policy: {mode: 'auto', idleOnly: migrated.idleOnly,
    quota: () => ({provider: 'codex', remaining: 100, observedAt: f.clock.now()}),
    lendingPolicy: migrated.lendingPolicy, userActive: () => true}});
  const controller = new AbortController();
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock});
  const running = lender.start(controller.signal);
  for (let i = 0; i < 40; i++) { f.clock.advance(5000); for (let j = 0; j < 20; j++) await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false, 'no job starts while the owner is present');
  controller.abort(); await running;
});

// A file that leaves a presence field out takes the new default (off); a value the file saved stays as saved.
const sparseFiles = {
  'policy without stopOnReturn and no idleOnly': {version: 1, intent: 'on', activeCircle: 'chosen', agents: {}, modes: {},
    limits: {lendingPolicy: {strategyParams: {perJobPct: 17}}}},
  'policy with stopOnReturn but no idleOnly': {version: 1, intent: 'on', activeCircle: 'chosen', agents: {}, modes: {},
    limits: {lendingPolicy: {stopOnReturn: true, strategyParams: {perJobPct: 17}}}},
  'empty limits': {version: 1, intent: 'on', activeCircle: 'chosen', agents: {}, modes: {}, limits: {}},
  'no limits': {version: 1, intent: 'on', activeCircle: 'chosen', agents: {}, modes: {}},
};
for (const [name, saved] of Object.entries(sparseFiles)) {
  test(`an upgrade reads an omitted presence protection as off and keeps what was saved: ${name}`, {timeout:60000}, async t => {
    const f = await appFixture(t), home = await f.home('presence-sparse'), directory = join(home, 'v1');
    await mkdir(directory, {recursive: true});
    const file = join(directory, 'app-settings.json');
    await writeFile(file, JSON.stringify(saved));
    const {app} = await f.start('presence-sparse', {resumeLending: false});
    const view = (await api(app, '/api/home')).lending.limits;
    const savedStop = saved.limits?.lendingPolicy?.stopOnReturn === true;
    assert.equal(view.idleOnly, false);
    assert.equal(view.lendingPolicy.stopOnReturn, savedStop);
    if (saved.limits?.lendingPolicy) assert.equal(view.lendingPolicy.strategyParams.perJobPct, 17);
    await app.close();
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.limits.idleOnly, false);
    assert.equal(written.limits.lendingPolicy.stopOnReturn, savedStop);
  });
}

test('an upgrade keeps protections the file saved as off', {timeout:60000}, async t => {
  const f = await appFixture(t), home = await f.home('presence-off'), directory = join(home, 'v1');
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, 'app-settings.json'), JSON.stringify({version: 1, intent: 'on', activeCircle: 'chosen', agents: {}, modes: {},
    limits: {idleOnly: false, lendingPolicy: {stopOnReturn: false, strategyParams: {perJobPct: 17}}}}));
  const {app} = await f.start('presence-off', {resumeLending: false});
  const view = (await api(app, '/api/home')).lending.limits;
  assert.equal(view.idleOnly, false);
  assert.equal(view.lendingPolicy.stopOnReturn, false);
});

test('item 18: a fresh install writes both presence booleans explicitly, so a rollback keeps the pair', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('presence-fresh-disk', {resumeLending: false});
  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3}});
  await app.close();
  const saved = JSON.parse(await readFile(join(await f.home('presence-fresh-disk'), 'v1', 'app-settings.json'), 'utf8'));
  assert.strictEqual(saved.limits.idleOnly, false);
  assert.strictEqual(saved.limits.lendingPolicy.stopOnReturn, false);
  assert.equal(saved.presenceDefaultsVersion, 2);
  assert.equal(saved.presence,undefined,'retired preview presence is not persisted');
});
