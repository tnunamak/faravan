import {mount, click, flush, teardown, window} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Settings, SettingsMap, Notifications} from './info.jsx';
import {restartLine} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {DATA_SHARING_COPY} from './safety-copy.mjs';

// Review P0: the Settings page said lending stays off after a restart. The app saves "on" and resumes it.
const settings = home => renderedText(renderFixture(Settings, {api:{}, refresh() {}, data:{home, readiness:null}}));

test('restartLine follows the real intent', () => {
  const pausedAt = Date.parse('2026-10-19T15:00:00Z');
  const localTime = new Intl.DateTimeFormat('en-US', {hour:'numeric', minute:'2-digit'}).format(pausedAt);
  assert.equal(restartLine({intent:{state:'ready'}, lending:{enabled:true}}), 'Lending is on. After a restart it turns back on by itself.');
  assert.equal(restartLine({intent:{state:'off'}, lending:{enabled:false}}), 'Lending is off. After a restart it stays off until you turn it on.');
  assert.equal(restartLine({state:'ready', lending:{enabled:true}}), 'Lending is on. After a restart it turns back on by itself.', 'older servers');
  assert.equal(restartLine({intent:{state:'paused', until:pausedAt}, lending:{enabled:true, limits:{timeZone:'UTC'}}}),
    `Lending is paused until ${localTime}. After a restart it stays paused and resumes by itself at that time.`);
  assert.equal(restartLine({intent:{state:'paused'}, lending:{enabled:true}}), 'Lending is paused. After a restart it stays paused until you resume it.');
  assert.equal(restartLine({}), '');
});

test('Profile leaves restart and lending facts on Lending', () => {
  const text = settings({intent:{state:'ready'}, lending:{enabled:true}});
  assert.doesNotMatch(text, /Lending is|After a restart|stays off/);
  assert.doesNotMatch(settings({intent:{state:'off'}, lending:{enabled:false}}), /Lending is|After a restart|stays off/);
});
test('Your data settings names circle recipients, provider access, and copies after leaving', () => {
  const text=renderedText(renderFixture(Settings,{api:{},refresh(){},route:{id:'data'},data:{}}));
  assert.ok(text.includes(DATA_SHARING_COPY));
  assert.match(text,/AI provider can also access them, and logs or other copies may persist/);
  assert.match(text,/Leaving a circle does not delete those copies/);
});

const mapFixture = () => renderFixture(SettingsMap, {computer:'Map fixture', ready:[]});

test('settings map renders effect and safety help below unchanged labels', () => {
  const text = renderedText(mapFixture());
  assert.ok(text.includes('Lending on or off'));
  assert.ok(text.includes('at once; a running job finishes first'));
  assert.ok(text.includes('Stops new jobs. A running job finishes first.'));
  assert.ok(text.includes('Changes apply after Save.'));
  assert.ok(text.indexOf('Lending on or off') < text.indexOf('Stops new jobs. A running job finishes first.'));
});

test('settings map renders supplied defaults and storage without null defaults', () => {
  const text = renderedText(mapFixture());
  assert.match(text, /Default:\s*Off/);
  assert.match(text, /Stored:\s*this computer/);
  assert.match(text, /Default:\s*System/);
  assert.doesNotMatch(text, /Default:\s*(null|undefined)/);
});

test('settings map states the circle group scope once and retains differing row scope', () => {
  const text = renderedText(mapFixture());
  assert.equal(text.split('Each circle').length - 1, 1);
  assert.ok(text.includes('Your account'));
  assert.ok(text.includes('This computer · Map fixture'));
  assert.ok(text.includes('Most settings here apply only to this computer. Items marked Your account apply across your account.'));
});

test('settings map help is the row link’s accessible description, and rows without help have none', () => {
  const html = mapFixture();
  const refs = [...html.matchAll(/<a [^>]*aria-describedby="([^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length > 0);
  for (const id of refs) assert.match(html, new RegExp('<p id="' + id + '">[^<]+</p>'));
  assert.ok((html.match(/<a [^>]*class="row/g) || []).length > refs.length, 'a row without help has no description');
});

afterEach(teardown);

test('browser permission resyncs on focus and visible return without requesting permission', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const notification = {permission:'denied', requestPermission:() => { throw new Error('must not request'); }};
  Object.defineProperty(globalThis, 'Notification', {configurable:true, value:notification});
  try {
    const view = await mount(h(Notifications));
    await flush();
    assert.match(view.text(), /Notifications are blocked/);
    notification.permission = 'granted';
    window.dispatchEvent(new window.Event('focus')); await flush();
    assert.match(view.text(), /This browser has permission/);
    notification.permission = 'denied';
    Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'});
    document.dispatchEvent(new window.Event('visibilitychange')); await flush();
    assert.match(view.text(), /This browser has permission/, 'hidden transitions do not resync');
    Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'});
    document.dispatchEvent(new window.Event('visibilitychange')); await flush();
    assert.match(view.text(), /Notifications are blocked/);
  } finally {
    teardown();
    if (old) Object.defineProperty(globalThis, 'Notification', old); else delete globalThis.Notification;
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else delete document.visibilityState;
  }
});

for (const fails of [false, true]) test('external permission change clears stale ' + (fails ? 'error' : 'notice'), async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const notification = {permission:'default', requestPermission:async () => {
    if (fails) throw new Error('fixture');
    return 'default';
  }};
  Object.defineProperty(globalThis, 'Notification', {configurable:true, value:notification});
  try {
    const view = await mount(h(Notifications)); await flush();
    await click(view.$('button'));
    assert.match(view.text(), fails ? /could not enable notifications/ : /permission was not changed/);
    notification.permission = 'granted';
    window.dispatchEvent(new window.Event('focus')); await flush();
    assert.match(view.text(), /This browser has permission/);
    assert.doesNotMatch(view.text(), /could not enable|was not changed/);
  } finally {
    teardown();
    if (old) Object.defineProperty(globalThis, 'Notification', old); else delete globalThis.Notification;
  }
});
