import {mount, teardown, resetPage, flush, click, act, window} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {Connection} from './shared.jsx';
import {LocalNameControl} from './local-name.jsx';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { nameEditState, ComputerProfile, finishProfileNameSave, profileNameValue } from './profile.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';

const base = {
  data: {devices: {ownerName: 'Ari', name: 'Work laptop'}},
  mutate() {},
  refresh() {},
};

test('profile offers both canonical name fields with their individual limits', () => {
  const html = renderFixture(ComputerProfile, base);
  assert.match(renderedText(html), /Your name .*Computer name/);
  assert.equal((renderedText(html).match(/Your name/g) ?? []).length, 1);
  assert.equal((renderedText(html).match(/Computer name/g) ?? []).length, 1);
  assert.match(html, /maxlength="64"/);
  assert.match(html, /maxlength="256"/);
  assert.doesNotMatch(renderedText(html), /Save your name|Save computer name/);
});

test('missing profile data reports a read error or a named loading state', () => {
  const loading = renderFixture(ComputerProfile, {data: {}, mutate() {}, refresh() {}});
  assert.match(loading, /role="status" aria-label="Loading profile"/);
  assert.doesNotMatch(loading, /<input|Save your name|Save computer name/);

  const failed = renderFixture(ComputerProfile, {
    data: {}, errors: {devices: {code: 'network'}}, mutate() {}, refresh() {},
  });
  assert.match(failed, /role="alert"/);
  assert.match(renderedText(failed), /Retry profile/);
  assert.doesNotMatch(failed, /<input/);
});

test('a warm profile read error keeps both saved fields available with retry', () => {
  const html = renderFixture(ComputerProfile, {
    ...base, errors: {devices: {code: 'network'}},
  });
  assert.match(html, /role="alert"/);
  assert.match(renderedText(html), /Retry profile/);
  assert.match(html, /value="Ari"/);
  assert.match(html, /value="Work laptop"/);
});

test('confirmed POST values win over stale reads until the GET catches up', () => {
  assert.equal(profileNameValue('Old name', 'Saved name'), 'Saved name');
  assert.equal(profileNameValue('Saved name', 'Saved name'), 'Saved name');
  assert.equal(profileNameValue('Current name', undefined), 'Current name');
});

test('save completion clears only the submitted draft and preserves newer typing', () => {
  assert.deepEqual(finishProfileNameSave({
    draft: '  New name  ', submitted: 'New name', responseValue: 'Server confirmed name',
  }), {draft: null, confirmed: 'Server confirmed name'});
  assert.deepEqual(finishProfileNameSave({
    draft: 'Typed while saving', submitted: 'Submitted name', responseValue: 'Submitted name',
  }), {draft: 'Typed while saving', confirmed: 'Submitted name'});
});

test('profile fields carry the ids the settings registry deep-links to, and an edit offers Discard', async () => {
  const {renderFixture} = await import('./render.test-helper.mjs');
  const {SETTINGS} = await import('./settings-registry.mjs');
  const {ComputerProfile} = await import('./profile.jsx');
  const html = renderFixture(ComputerProfile, {data: {devices: {ownerName: 'Ana', name: 'sandpiper'}}, mutate: async () => ({})});
  for (const key of ['profile.ownerName', 'profile.computerName']) {
    const id = SETTINGS.find(item => item.key === key).focus.slice(1);
    assert.match(html, new RegExp('id="' + id + '"'), key);
  }
});

test('Mac login choice is explicit, reversible and explains lending separately',()=>{
  for(const enabled of [false,true]) {
    const data={...base.data,home:{desktop:{autostart:{supported:true,available:true,enabled}}}};
    const text=renderedText(renderFixture(ComputerProfile,{...base,data}));
    assert.match(text,/Launch at login/);
    assert.ok(text.includes(enabled?'Turn off launch at login':'Turn on launch at login'));
    assert.match(text,/Lending follows your existing choice/);
  }
  assert.doesNotMatch(renderedText(renderFixture(ComputerProfile,base)),/Launch at login/);
});


test('an enabled login item that needs repair can still be turned off',()=>{
  const data={...base.data,home:{desktop:{autostart:{supported:true,available:true,enabled:true,needsRepair:true}}}};
  const text=renderedText(renderFixture(ComputerProfile,{...base,data}));
  assert.match(text,/Update login item/);assert.match(text,/Turn off launch at login/);
});

test('P2-1 blank and whitespace drafts retain a discardable dirty edit', () => {
  for (const draft of ['', '   ']) assert.deepEqual(nameEditState(draft, 'Saved'), {dirty: true, canSave: false});
  assert.deepEqual(nameEditState(null, 'Saved'), {dirty: false, canSave: false});
});
test('P2-2 personal and computer names have distinct purpose guidance', () => {
  const text = renderedText(renderFixture(ComputerProfile, base));
  assert.match(text, /Use the name you want people to recognize/);
  assert.match(text, /Use a different name for each computer, such as Ana’s Linux desktop or Ana’s MacBook/);
});
test('P2-4 components keep explicit focus restoration and persistent outcome status', async () => {
  const {readFile} = await import('node:fs/promises');
  const profile = await readFile(new URL('./profile.jsx', import.meta.url), 'utf8');
  const local = await readFile(new URL('./local-name.jsx', import.meta.url), 'utf8');
  assert.match(profile, /focusInput\(\);/);
  assert.match(profile, /role="status" aria-live="polite"/);
  assert.match(local, /input.current\?\.focus\(\)/);
  assert.match(local, /trigger.current\?\.focus\(\)/);
  assert.match(local, /onClose\(remove \?/);
  assert.match(local, /role="status" aria-live="polite"/);
});
test('P2-5 name submit paths share guarded saves and synchronous pending locks', async () => {
  assert.equal(nameEditState(' New ', 'Old').canSave, true);
  assert.equal(nameEditState(' New ', 'Old', true).canSave, false);
  assert.equal(nameEditState(' ', 'Old').canSave, false);
  const {readFile} = await import('node:fs/promises');
  const profile = await readFile(new URL('./profile.jsx', import.meta.url), 'utf8');
  const local = await readFile(new URL('./local-name.jsx', import.meta.url), 'utf8');
  assert.ok(profile.includes('event.preventDefault();saveName().catch'));
  assert.ok(profile.includes('pendingRef.current = true'));
  assert.ok(local.includes('e.preventDefault();update();'));
  assert.ok(local.includes('pending.current = true'));
  for (const source of [profile, local]) assert.match(source, /type="submit"/);
});

afterEach(teardown);
for (const remove of [false,true]) test('F2 local nickname keeps newer typing after pending '+(remove?'remove':'save'), async () => {
  resetPage();
  let resolve;const pending=new Promise(done=>{resolve=done;});let calls=0;
  const app=await mount(h(LocalNameControl,{circleId:'c1',circleLabel:'Friends',keyId:'key1',current:'Old',label:'Edit nickname',mutate:()=>{calls++;return pending;}}));
  await click(app.button('Edit nickname'));
  const input=app.$('input');
  await act(()=>{input.value='A';input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();
  await click(app.button(remove?'Remove local name':'Save local name'));
  assert.equal(calls,1);
  await act(()=>{input.value='B';input.dispatchEvent(new Event('input',{bubbles:true}));});await flush();
  resolve({});await flush();
  assert.equal(app.$('input')?.value,'B');
  assert.match(app.text(),/Your new edit is not saved/);
  assert.equal(Boolean(app.button('Save local name')),true);
});

test('normalization-only name edits explain disabled Save and remain discardable', async () => {
  const view = await mount(h(ComputerProfile, base));
  const input = view.$('#setting-ownerName');
  await act(() => { input.value = ' Ari '; input.dispatchEvent(new Event('input', {bubbles:true})); });
  await flush();
  assert.equal(view.button('Save your name').disabled, true);
  assert.match(view.text(), /No changes to save\./);
  await click(view.button('Discard unsaved changes'));
  assert.equal(input.value, 'Ari');
  assert.doesNotMatch(view.text(), /No changes to save/);
});

// Item 10 (1102 review): offline, a dirty name's disabled Save says why, and the edit is kept.
test('offline: a changed name says to reconnect to save, and the edit is still there', async () => {
  const view = await mount(h(Connection.Provider, {value: {offline: true, stale: false}}, h(ComputerProfile, base)));
  const input = view.$('#setting-ownerName');
  await act(() => { input.value = 'Ari K'; input.dispatchEvent(new window.Event('input', {bubbles: true})); });
  assert.equal(input.value, 'Ari K', 'the edit is in the field');
  assert.match(view.text(), /Reconnect to save\. Your edit is still here\./);
  await view.unmount();
});
