import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// D8: the server alone records which rule the app made for a circle. A client never sets it.
async function joined(t) {
  const f = await appFixture(t), {owner, lender, circle} = await f.connect({freshLending: 'automatic', resumeLending: false});
  const file = join(lender.home, 'v1', 'app-settings.json');
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});
  await waitFor(async () => (await readFile(file, 'utf8').then(JSON.parse, () => ({}))).standingRules?.length, 'the default rule is installed');
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const view = () => api(lender.app, '/api/lending');
  const rules = async () => (await view()).standingRules;
  const post = (path, body, status) => api(lender.app, '/api/lending/' + path, {method: 'POST', body, status});
  const appRule = async () => (await rules()).find(r => r.circle === circle.id && r.appOwned);
  return {f, owner, lender, circle, file, read, view, rules, post, appRule};
}
const clean = ({appOwned, ...rule}) => rule;
const custom = (x, extra = {}) => ({id: 'custom-person-rule', circle: x.circle.id, people: [x.owner.app.device.keyId], agents: ['codex'], maxWallSeconds: 600,
  dailyJobs: 2, weeklyJobs: 5, dailyMinutes: 30, weeklyMinutes: 90, schedule: null, timeZone: 'UTC', expiresAt: Date.now() + 5 * 86400000, ...extra});

test('joining a circle records the app rule on the server and projects it read-only', {timeout: 120000}, async t => {
  const x = await joined(t);
  const rule = await x.appRule();
  assert.ok(rule, 'the default rule is the app\'s');
  const saved = await x.read();
  assert.equal(saved.appRuleIds[x.circle.id], rule.id);
  assert.equal(saved.modes[x.circle.id], 'auto');
});

test('a client body that carries the ownership record is refused with state unchanged; a per-rule ownership field is dropped', {timeout: 120000}, async t => {
  const x = await joined(t);
  const before = await readFile(x.file, 'utf8');
  const version = (await x.view()).configVersion;
  const rules = await x.rules();
  const refused = await x.post('rules', {rules: rules.map(clean), version, appRuleIds: {[x.circle.id]: 'custom-person-rule'}}, 400);
  assert.equal(refused.code, 'invalid_request');
  assert.equal(await readFile(x.file, 'utf8'), before, 'nothing was written');
  const added = await x.post('rules', {rules: [...rules.map(clean), {...custom(x), appOwned: true, peopleScope: 'circle'}], version});
  const saved = await x.read();
  assert.equal(saved.appRuleIds[x.circle.id], rules.find(r => r.appOwned).id, 'the forged marker confers nothing');
  const forged = saved.standingRules.find(r => r.id === 'custom-person-rule');
  assert.equal(forged.peopleScope, undefined);
  assert.equal(forged.appOwned, undefined);
  assert.equal(added.standingRules.find(r => r.id === 'custom-person-rule').appOwned, undefined);
});

test('a client rule with a forged circle marker and no people is refused, state unchanged', {timeout: 120000}, async t => {
  const x = await joined(t);
  const before = await readFile(x.file, 'utf8');
  const version = (await x.view()).configVersion;
  const rules = await x.rules();
  const refused = await x.post('rules', {rules: [...rules.map(clean), {...custom(x, {people: []}), peopleScope: 'circle', appOwned: true}], version}, 400);
  assert.equal(refused.code, 'invalid_request');
  assert.equal(await readFile(x.file, 'utf8'), before, 'nothing was written');
});

test('an unchanged whole-form save keeps the app rule, its id, expiry, marker and the record', {timeout: 120000}, async t => {
  const x = await joined(t);
  const before = await x.rules(), was = await x.read();
  const version = (await x.view()).configVersion;
  await x.post('rules', {rules: before.map(clean), version});
  const after = await x.read();
  assert.deepEqual(after.standingRules, was.standingRules, 'every rule is byte-equal, including the circle marker and expiry');
  assert.deepEqual(after.appRuleIds, was.appRuleIds);
  assert.equal(after.modes[x.circle.id], 'auto');
  assert.ok((await x.appRule()), 'still the app\'s rule');
});

test('editing one limit makes the rule the person\'s own: same id, ordinary expiry, no record, never renewed', {timeout: 120000}, async t => {
  const x = await joined(t);
  const [rule] = await x.rules();
  const edited = {...clean(rule), maxWallSeconds: 300, expiresAt: Date.now() + 3 * 86400000};
  await x.post('rules', {rules: [edited], version: (await x.view()).configVersion});
  const saved = await x.read();
  assert.equal(saved.appRuleIds[x.circle.id], undefined);
  const now = saved.standingRules.find(r => r.id === rule.id);
  assert.ok(now, 'same id, so its counters stay');
  assert.equal(now.maxWallSeconds, 300);
  assert.equal(now.expiresAt, edited.expiresAt);
  assert.equal(await x.appRule(), undefined);
  assert.equal(saved.modes[x.circle.id], 'auto');
});

test('deleting the app rule while Automatic is on makes the default again, once, and survives a restart', {timeout: 120000}, async t => {
  const x = await joined(t);
  const [rule] = await x.rules();
  await x.post('rules', {rules: [], version: (await x.view()).configVersion});
  const saved = await x.read();
  assert.equal(saved.modes[x.circle.id], 'auto', 'the circle stays Automatic');
  assert.equal(saved.standingRules.length, 1);
  assert.notEqual(saved.standingRules[0].id, rule.id);
  assert.equal(saved.appRuleIds[x.circle.id], saved.standingRules[0].id);
  assert.equal(saved.standingRules[0].peopleScope, 'circle');
  await x.lender.app.close();
  const again = await x.f.start('lender', {resumeLending: false, freshLending: 'automatic'});
  const after = JSON.parse(await readFile(x.file, 'utf8'));
  assert.deepEqual(after.appRuleIds, saved.appRuleIds, 'a restart adds nothing');
  assert.equal((await api(again.app, '/api/lending')).standingRules.length, 1);
});

test('a custom rule the person deleted stays deleted', {timeout: 120000}, async t => {
  const x = await joined(t);
  const base = (await x.rules()).map(clean);
  await x.post('rules', {rules: [...base, custom(x)], version: (await x.view()).configVersion});
  assert.ok((await x.rules()).some(r => r.id === 'custom-person-rule'));
  await x.post('rules', {rules: base, version: (await x.view()).configVersion});
  const saved = await x.read();
  assert.equal(saved.standingRules.some(r => r.id === 'custom-person-rule'), false);
  assert.equal(saved.standingRules.length, 1);
});

test('a limits save with Automatic updates the app rule in place and keeps a custom rule', {timeout: 120000}, async t => {
  const x = await joined(t);
  const base = (await x.rules()).map(clean), [app] = base;
  const named = custom(x);
  await x.post('rules', {rules: [...base, named], version: (await x.view()).configVersion});
  const out = await x.post('limits', {circle: x.circle.id, mode: 'auto', dailyJobs: 4, version: (await x.view()).configVersion});
  const saved = await x.read();
  const rule = saved.standingRules.find(r => r.id === app.id);
  assert.ok(rule, 'same id');
  assert.equal(rule.dailyJobs, 4, 'the narrower cap applies');
  assert.equal(rule.expiresAt, app.expiresAt, 'no renewal from a limits save');
  assert.equal(saved.appRuleIds[x.circle.id], app.id);
  assert.deepEqual(saved.standingRules.find(r => r.id === 'custom-person-rule'), named);
  assert.equal(out.standingRules.length, 2);
  await x.post('limits', {dailyJobs: 4});
  assert.deepEqual((await x.read()).appRuleIds, saved.appRuleIds, 'a limits save without a circle changes no record');
});

test('Ask removes the record and the rule; a restart does not bring it back', {timeout: 120000}, async t => {
  const x = await joined(t);
  await x.post('mode', {circle: x.circle.id, mode: 'ask'});
  const saved = await x.read();
  assert.equal(saved.modes[x.circle.id], 'ask');
  assert.deepEqual(saved.appRuleIds, {});
  assert.deepEqual(saved.standingRules, []);
  await x.lender.app.close();
  await x.f.start('lender', {resumeLending: false, freshLending: 'automatic'});
  const after = JSON.parse(await readFile(x.file, 'utf8'));
  assert.equal(after.modes[x.circle.id], 'ask');
  assert.deepEqual(after.standingRules, []);
});

const legacy = (rules, extra = {}) => ({version: 1, intent: 'off', activeCircle: null, agents: {}, modes: {c1: 'auto', c2: 'auto'}, standingRules: rules, limits: {}, ...extra});
const rule = (id, circle, extra = {}) => ({id, circle, people: ['k1'], agents: ['codex'], maxWallSeconds: 600, dailyJobs: null, weeklyJobs: null, dailyMinutes: null, weeklyMinutes: null,
  schedule: null, expiresAt: Date.now() + 86400000, ...extra});
async function startLegacy(t, name, saved) {
  const f = await appFixture(t), directory = join(await f.home(name), 'v1');
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, 'app-settings.json'), JSON.stringify(saved));
  const {app} = await f.start(name, {resumeLending: false});
  return {f, app, view: () => api(app, '/api/lending')};
}

test('a file from before the record: exactly one marked rule in a circle is the app rule; zero or two are not; lookalikes are not', {timeout: 120000}, async t => {
  const x = await startLegacy(t, 'prov-legacy', legacy([
    rule('a-marked', 'c1', {peopleScope: 'circle'}),
    rule('b-first', 'c2', {peopleScope: 'circle'}), rule('b-second', 'c2', {peopleScope: 'circle'}),
    rule('c-plain', 'c3', {maxWallSeconds: null}),
  ]));
  const rules = (await x.view()).standingRules;
  assert.deepEqual(rules.filter(r => r.appOwned).map(r => r.id), ['a-marked']);
});

test('after the person edits the app rule, an Automatic limits save keeps their rule and makes no new app rule', {timeout: 120000}, async t => {
  const x = await joined(t);
  const [rule] = await x.rules();
  const edited = {...clean(rule), maxWallSeconds: 300, expiresAt: Date.now() + 3 * 86400000};
  await x.post('rules', {rules: [edited], version: (await x.view()).configVersion});
  await x.post('limits', {circle: x.circle.id, mode: 'auto', dailyJobs: 4, version: (await x.view()).configVersion});
  const saved = await x.read();
  assert.deepEqual(saved.standingRules.map(r => r.id), [rule.id], 'their rule survives and nothing else appears');
  assert.equal(saved.standingRules[0].maxWallSeconds, 300);
  assert.equal(saved.appRuleIds[x.circle.id], undefined);
  assert.equal(saved.modes[x.circle.id], 'auto');
  await x.post('mode', {circle: x.circle.id, mode: 'ask'});
  assert.deepEqual((await x.read()).standingRules.map(r => r.id), [rule.id], 'Ask never deletes a rule the person made');
});

test('an empty or unavailable roster never writes Ask: the app rule is made again with no members and Automatic stays', {timeout: 120000}, async t => {
  const x = await joined(t);
  const device = x.lender.app.device, original = device.rosterCache.bind(device);
  device.rosterCache = id => ({...original(id), get: async () => null});
  const [rule] = await x.rules();
  await x.post('rules', {rules: [], version: (await x.view()).configVersion});
  const saved = await x.read();
  assert.equal(saved.modes[x.circle.id], 'auto');
  const made = saved.standingRules.find(r => r.circle === x.circle.id);
  assert.ok(made && made.id !== rule.id, 'a new app rule');
  assert.deepEqual(made.people, []);
  assert.equal(saved.appRuleIds[x.circle.id], made.id);
});
