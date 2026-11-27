import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFromHash} from './helpers.mjs';
import {youVM, SETTINGS_READY} from './settings-model.mjs';
import {Settings} from './info.jsx';
import {paletteVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// PRODUCT-UX-FIELD-RESEARCH §9: one settings home with a map and search, a scope header on every settings surface,
// and deep links from search to the field itself.
const page = (id, data = {devices: {name: 'sandpiper', ownerName: 'Ana'}}) =>
  renderFixture(Settings, {data, errors: {}, route: {page: 'settings', id}, api: {get: () => new Promise(() => {})}, mutate() {}, refresh() {}});

test('settings routes: every You section has an address, unknown ones are 404', () => {
  for (const id of ['all', 'profile', 'appearance', 'notifications', 'updates', 'data', 'account', 'phone'])
    assert.deepEqual(routeFromHash('#/you/' + id), {page: 'settings', id}, id);
  assert.deepEqual(routeFromHash('#/settings/updates'), {page: 'settings', id: 'updates'}, 'the toast uses the existing Updates route');
  assert.equal(routeFromHash('#/you/nope').page, 'not-found');
});

test('settings sections: Appearance, Updates and Phone are listed; a reserved section waits for its module', () => {
  const ids = youVM({}, null).sections.map(s => s.id);
  assert.deepEqual(ids, ['all', 'profile', 'appearance', 'notifications', 'updates', 'phone', 'data', 'account']);
  assert.deepEqual(SETTINGS_READY, ['updates', 'phone']);
  assert.equal(youVM({}, 'phone', {ready: ['updates']}).selected, null, 'an unready Phone section is not selectable');
});

test('settings map: #/you/all lists every group, with a search field and each row’s scope', () => {
  const html = page('all'), text = renderedText(html);
  assert.match(html, /<input[^>]*type="search"[^>]*aria-label="Search settings"/);
  for (const group of ['You', 'This computer', 'Circles', 'Advanced and recovery']) assert.match(text, new RegExp(group));
  assert.match(text, /How much to lend/);
  assert.match(text, /This computer · sandpiper/);
  assert.match(text, /Updates/, 'updates is a ready destination');
  assert.match(text, /Pairing/, 'pairing is a ready destination');
});

test('scope header: browser-local sections never claim the computer', () => {
  const notifications = renderedText(page('notifications'));
  assert.match(notifications, /Notifications · This computer · sandpiper/);
  assert.match(notifications, /Browser notifications · This browser/);
  assert.match(notifications, /Notifications on this computer/, 'the cycle 1 history/desktop matrix is mounted');
  assert.match(renderedText(page('appearance')), /Appearance · This browser/);
  assert.match(renderedText(page('updates')), /Updates · This computer · sandpiper/);
  assert.match(renderedText(page('profile')), /Profile · This computer · sandpiper/);
  assert.match(renderedText(page('phone')), /Pairing · This computer · sandpiper/);
});

test('appearance: System, Light and Dark are one labelled group of pressed buttons', () => {
  const html = page('appearance');
  assert.match(html, /role="group"[^>]*aria-labelledby="setting-theme-label"|aria-labelledby="setting-theme-label"[^>]*role="group"/);
  for (const label of ['System', 'Light', 'Dark']) assert.match(html, new RegExp('aria-pressed="(true|false)"[^>]*>' + label));
  assert.match(html, /id="setting-theme"/, 'search deep-links land on the theme control');
});

test('updates: the section mounts the Updates panel', () => {
  assert.match(renderedText(page('updates')), /Loading update status/);
});

test('palette: a setting is one search away and deep-links to its field', () => {
  const result = paletteVM('protection');
  const section = result.sections.find(s => s.title === 'Settings');
  assert.ok(section, 'a Settings section');
  const item = section.items[0];
  assert.equal(item.label, 'How much to lend · What you lend');
  assert.equal(item.href, '#/lend/limits');
  assert.equal(item.focus, 'input[name="protectionPosition"]:checked');
  const returnSetting = paletteVM('away').sections.find(s => s.title === 'Settings').items[0];
  assert.equal(returnSetting.label, 'Stop a running job when I return · What you lend');
  assert.equal(returnSetting.href, '#/lend/limits');
  assert.equal(returnSetting.focus, '[role="switch"][aria-label="Stop a running job when I return"]');
  assert.equal(paletteVM('').sections.some(s => s.title === 'Settings'), false, 'no settings flood the empty palette');
  assert.ok(paletteVM('settings').items.some(i => i.href === '#/you/all'), 'the map is a Go to target');
});

test('updates: the latest update event is handed to the panel', () => {
  const text = renderedText(page('updates', {devices: {name: 'sandpiper'}, updateStatus: {owner: 'faravan', state: 'available', currentVersion: '1.0.0', candidate: '1.1.0'}}));
  assert.match(text, /Faravan 1\.1\.0 is available/);
});
