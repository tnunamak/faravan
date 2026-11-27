import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTINGS, SETTINGS_GROUPS, searchSettings, settingsMapVM, scopeLabel, visibleSettings} from './settings-registry.mjs';
import {routeFromHash} from './helpers.mjs';

test('registry: every row is complete, unique and in a known group', () => {
  const groups = new Set(SETTINGS_GROUPS.map(g => g.id)), keys = new Set();
  for (const item of SETTINGS) {
    assert.ok(!keys.has(item.key), 'duplicate ' + item.key); keys.add(item.key);
    assert.ok(groups.has(item.group), item.key + ' group');
    for (const field of ['label', 'href', 'scope', 'storage', 'effect', 'owner']) assert.ok(item[field], item.key + ' lacks ' + field);
    assert.ok(['low', 'medium', 'high'].includes(item.risk), item.key + ' risk');
    assert.ok(Object.hasOwn(item, 'default') && (item.default === null || typeof item.default === 'string' && item.default), item.key + ' default');
    if (item.authority) assert.notEqual(item.risk, 'low', item.key + ' gives access away, so it is not low risk');
    assert.ok(['browser', 'computer', 'circle', 'account'].includes(item.scope), item.key + ' scope');
    assert.ok(item.reset === null || (item.reset.verb && ['discard', 'default', 'override', 'erase'].includes(item.reset.kind)), item.key + ' reset');
  }
});

test('registry: every in-app target is a real route, never the 404 page', () => {
  for (const item of SETTINGS.filter(i => i.href.startsWith('#/'))) {
    assert.notEqual(routeFromHash(item.href).page, 'not-found', item.key + ' → ' + item.href);
  }
});

test('registry: reset verbs are honest — only the four verbs the research names, and none on browser permission', () => {
  const verbs = new Set(SETTINGS.filter(i => i.reset).map(i => i.reset.verb));
  for (const verb of verbs) assert.ok(['Remove this override', 'Use system theme', 'Discard unsaved changes', 'Erase local data'].includes(verb), verb);
  const notifications = SETTINGS.find(i => i.key === 'notifications.browser');
  assert.equal(notifications.reset, null);
  assert.match(notifications.resetNote, /browser’s site settings/);
});

test('registry: authority settings are computer- or account-scoped, never browser-scoped (authority never syncs)', () => {
  for (const item of SETTINGS.filter(i => i.authority)) assert.notEqual(item.scope, 'browser', item.key);
  assert.equal(SETTINGS.find(i => i.key === 'appearance.theme').scope, 'browser');
});

test('search: synonyms reach the setting people mean', () => {
  const first = q => searchSettings(q)[0]?.key;
  assert.equal(first('protection'), 'limits.protectionPosition');
  assert.ok(searchSettings('quota').map(i => i.key).includes('limits.protectionPosition'));
  assert.ok(searchSettings('allowance').map(i => i.key).includes('limits.protectionPosition'));
  assert.equal(first('approval'), 'lending.mode');
  assert.equal(first('away'), 'limits.stopOnReturn');
  assert.equal(first('computer name'), 'profile.computerName');
  assert.equal(first('dark'), 'appearance.theme');
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('zzzz'), []);
});

test('search: a label prefix outranks a synonym', () => {
  assert.equal(searchSettings('keep')[0].key, 'limits.protectionPosition');
});

test('reserved destinations stay hidden until their module is ready', () => {
  assert.equal(visibleSettings().some(i => i.key === 'updates'), false);
  assert.equal(visibleSettings(['updates']).some(i => i.key === 'updates'), true);
  assert.deepEqual(searchSettings('version'), []);
  assert.equal(searchSettings('version', {ready: ['updates']})[0].key, 'updates');
});

test('scope header: browser values never claim the computer', () => {
  assert.equal(scopeLabel('browser', {computer: 'sandpiper'}), 'This browser');
  assert.equal(scopeLabel('computer', {computer: 'sandpiper'}), 'This computer · sandpiper');
  assert.equal(scopeLabel('computer'), 'This computer');
});

test('settings map: groups in order, filtered by a query, with an honest empty line', () => {
  const all = settingsMapVM({computer: 'sandpiper'});
  assert.deepEqual(all.groups.map(g => g.label), ['You', 'This computer', 'Circles', 'Advanced and recovery']);
  assert.equal(all.empty, '');
  const theme = all.groups[0].items.find(i => i.key === 'appearance.theme');
  assert.equal(theme.scope, 'This browser');
  const lending = all.groups[1].items.find(i => i.key === 'lending.enabled');
  assert.equal(lending.scope, 'This computer · sandpiper');
  const protection = settingsMapVM({query: 'protection'});
  assert.equal(protection.count, 1);
  assert.ok(protection.groups.every(g => g.items.length));
  assert.equal(settingsMapVM({query: 'zzzz'}).empty, 'No setting matches “zzzz”.');
});

test('registry: defaults match the shipped defaults, and provider-derived ones say unknown', async () => {
  const by = key => SETTINGS.find(i => i.key === key).default;
  assert.equal(by('limits.protectionPosition'), 'Keep more for me');
  const {LENDING_POLICY_DEFAULTS} = await import('../../../lib/v1/lending-policy.mjs');
  assert.equal(LENDING_POLICY_DEFAULTS.protectionPosition, 'keep_more_for_me');
  assert.equal(by('lending.mode'), 'Automatic');
  assert.equal(by('limits.perJobPct'), '10%');
  assert.equal(LENDING_POLICY_DEFAULTS.strategyParams.perJobPct,10);
  assert.equal(by('limits.stopOnReturn'), 'Off');
  assert.equal((await import('../../../lib/v1/lending-policy.mjs')).LENDING_POLICY_DEFAULTS.stopOnReturn, false);
  assert.equal(by('appearance.theme'), 'System');
  assert.equal(by('updates'), 'unknown');
  // The server's APP_DEFAULTS are the source; read them as text so this test never boots the app.
  const {readFileSync} = await import('node:fs');
  const app = readFileSync(new URL('../../../lib/v1/app.mjs', import.meta.url), 'utf8');
  const defaults = app.match(/APP_DEFAULTS=Object\.freeze\(\{([^}]*)/)[1];
  assert.match(defaults, /dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30/);
  assert.match(app, /name:hostname\(\)/);
  const {limitsDraft} = await import('./view-models.mjs');
  assert.equal(limitsDraft({}).mode, 'auto');
});

test('settings map: a row repeats its scope only when it differs from its group; the group says it once', () => {
  const vm = settingsMapVM({computer: 'sandpiper'});
  const computer = vm.groups.find(g => g.id === 'computer');
  assert.equal(computer.note, 'Most settings here apply only to this computer. Items marked Your account apply across your account.');
  assert.equal(computer.items.find(i => i.key === 'lending.enabled').meta, '');
  assert.equal(computer.items.find(i => i.key === 'devices').meta, 'Your account');
  assert.equal(vm.groups[0].items.find(i => i.key === 'appearance.theme').meta, 'This browser');
});

test('mixed-scope computer group retains the actual scope of every row', () => {
  const group = settingsMapVM({ready:['updates','phone'], computer:'sandpiper'}).groups.find(g => g.id === 'computer');
  assert.equal(group.note, 'Most settings here apply only to this computer. Items marked Your account apply across your account.');
  for (const row of group.items) {
    const source = SETTINGS.find(item => item.key === row.key);
    assert.equal(row.scope, scopeLabel(source.scope, {computer:'sandpiper'}));
    assert.equal(row.meta, source.scope === 'computer' ? '' : scopeLabel(source.scope, {computer:'sandpiper'}));
  }
  assert.equal(group.items.find(row => row.key === 'devices').meta, 'Your account');
});

test('map VM retains defaults, storage, effects and safety timing', () => {
  const items = settingsMapVM().groups.flatMap(group => group.items);
  for (const item of items) {
    const source = SETTINGS.find(row => row.key === item.key);
    assert.equal(item.default, source.default);
    assert.equal(item.storage, source.storage);
    assert.equal(item.effect, source.effect);
  }
  assert.equal(items.find(row => row.key === 'lending.enabled').help, 'Stops new jobs. A running job finishes first.');
  assert.equal(items.find(row => row.key === 'notifications.desktop').help, 'Changes apply after Save.');
});
