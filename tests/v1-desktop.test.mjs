import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopView, parseTrayReport } from '../lib/v1/desktop.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

test('the pin prompt is for Windows only, once, after lending turns on', () => {
  const view = (platform, lendingOn, pinPromptShown = false) => desktopView({platform, lendingOn, pinPromptShown, tray: null});
  assert.equal(view('win32', false).pinPrompt, false, 'not before lending is on');
  assert.equal(view('win32', true).pinPrompt, true);
  assert.equal(view('win32', true, true).pinPrompt, false, 'not again once shown');
  assert.equal(view('win32', true).pinSettingsUri, 'ms-settings:taskbar');
  for (const platform of ['darwin', 'linux']) {
    assert.equal(view(platform, true).pinPrompt, false, platform);
    assert.equal(view(platform, true).pinSettingsUri, null);
  }
});

test('only Linux can lack a tray, and only when the tray helper says so', () => {
  const view = (platform, tray) => desktopView({platform, lendingOn: true, pinPromptShown: false, tray});
  assert.deepEqual([view('linux', false).tray, view('linux', false).noTrayNote], [false, true]);
  assert.deepEqual([view('linux', true).tray, view('linux', true).noTrayNote], [true, false]);
  assert.deepEqual([view('linux', null).tray, view('linux', null).noTrayNote], [null, false], 'unknown is not a claim');
  assert.deepEqual([view('darwin', false).tray, view('darwin', false).noTrayNote], [true, false], 'a Mac always has a menu bar');
  assert.deepEqual([view('win32', false).tray, view('win32', false).noTrayNote], [true, false]);
});

test('a tray report is exactly {tray: boolean}', () => {
  assert.equal(parseTrayReport({tray: false}), false);
  assert.equal(parseTrayReport({tray: true}), true);
  for (const bad of [null, [], {}, {tray: 'no'}, {tray: false, extra: 1}]) assert.equal(parseTrayReport(bad), null);
});

test('the app reports the desktop, takes the tray report, and shows the pin prompt once', {timeout: 120000}, async t => {
  const f = await appFixture(t), {app} = await f.start('desktop-win', {platform: 'win32'});
  const status = () => api(app, '/api/status').then(s => s.desktop);
  assert.deepEqual(await status(), {platform: 'windows', tray: true, pinPrompt: false, pinSettingsUri: 'ms-settings:taskbar', noTrayNote: false, lendable: false});
  await api(app, '/api/desktop/pin-prompt', {method: 'POST', body: {}});
  assert.equal((await status()).pinPrompt, false);
  await api(app, '/api/desktop/pin-prompt', {method: 'POST', body: {x: 1}, status: 400});
  const linux = await (await appFixture(t)).start('desktop-linux', {platform: 'linux'});
  assert.equal((await api(linux.app, '/api/status')).desktop.tray, null);
  await api(linux.app, '/api/desktop/tray', {method: 'POST', body: {tray: false}});
  const after = (await api(linux.app, '/api/status')).desktop;
  assert.deepEqual([after.tray, after.noTrayNote], [false, true]);
  await api(linux.app, '/api/desktop/tray', {method: 'POST', body: {tray: 'maybe'}, status: 400});
  await api(linux.app, '/api/desktop/tray', {method: 'POST', token: null, body: {tray: true}, status: 401});
});
