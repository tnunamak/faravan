import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationCategories, notificationSettingsVM, notificationSettingsPatch, createNotificationSettingsEditor, UNKNOWN_SAVE, UNKNOWN_READ } from './notification-settings-model.mjs';
import { NotificationSettings } from './notification-settings.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';

const defaults = Object.fromEntries(['requests','job_ready','needs_attention','security','lending_attention','circle_activity'].map(key => [key, {history:true, desktop:key !== 'circle_activity'}]));

test('all six categories expose saved values, actionable lending copy and quiet routine updates', () => {
  assert.equal(notificationCategories.length, 6);
  const vm = notificationSettingsVM(defaults);
  assert.equal(vm.length, 6);
  assert.deepEqual(vm.find(row => row.key === 'circle_activity').value, {history:true, desktop:false});
  assert.match(vm.find(row => row.key === 'lending_attention').description, /allowance warning/);
  assert.match(vm.find(row => row.key === 'circle_activity').description, /when your job starts/i);
  assert.doesNotMatch(vm.find(row => row.key === 'circle_activity').description, /digest/i);
  assert.doesNotMatch(vm.find(row => row.key === 'job_ready').description, /starts/i);
});

test('save sends only changed category channels and never invents unsaved defaults', () => {
  const edited = {...defaults, requests:{history:false, desktop:true}, circle_activity:{history:true, desktop:true}};
  assert.deepEqual(notificationSettingsPatch(defaults, edited), {requests:{history:false}, circle_activity:{desktop:true}});
  assert.deepEqual(notificationSettingsPatch(defaults, defaults), {});
  assert.throws(() => notificationSettingsVM({requests:{history:true, desktop:true}}), /settings/i);
});

test('settings render twelve named controls in a compact notification table', () => {
  const html = renderFixture(NotificationSettings, {initialSettings:defaults});
  assert.match(renderedText(html), /Notifications on this computer/);
  assert.equal((html.match(/role="switch"/g) || []).length, 12);
  assert.match(html, /<table class="notification-table">/);
  assert.match(renderedText(html), /History\s+Desktop/);
  for (const row of notificationCategories) {
    assert.match(html, new RegExp('aria-label="' + row.label + ': history"'));
    assert.match(html, new RegExp('aria-label="' + row.label + ': desktop notifications"'));
  }
  assert.match(html, /aria-checked="false"[^>]*aria-label="Circle activity: desktop notifications"/);
  assert.match(renderedText(html), /Do Not Disturb settings still apply/);
  assert.doesNotMatch(renderedText(html), /Turn on notifications|Save notification settings/);
});

test('a settings read has a named loading state without editable defaults', () => {
  const html = renderFixture(NotificationSettings);
  assert.match(html, /role="status"/);
  assert.match(renderedText(html), /Loading notification settings/);
  assert.doesNotMatch(html, /role="switch"/);
});

test('unknown save: committed lost reply is read back before retry or discard', async () => {
  const states = [], editor = createNotificationSettingsEditor(defaults, state => states.push(state));
  editor.edit('requests', 'desktop', false);
  const committed = {...defaults, requests:{history:true, desktop:false}};
  let posts = 0, reads = 0;
  await editor.save({post:async () => {posts++; throw new Error('Lost reply');}, get:async () => {reads++; return committed;}});
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.ok(states.some(state => state.error === UNKNOWN_SAVE));
  assert.equal(editor.state.saved.requests.desktop, false);
  assert.equal(editor.dirty, false);
  editor.edit('requests', 'desktop', true);
  assert.equal(editor.dirty, true, 'reverting to the old value must now be a real edit');
  editor.discard();
  assert.equal(editor.state.saved.requests.desktop, false);
});

test('unknown save: malformed success reply requires authoritative read-back', async () => {
  const editor = createNotificationSettingsEditor(defaults);
  editor.edit('requests', 'desktop', false);
  let reads = 0;
  await editor.save({post:async () => ({}), get:async () => {reads++; return defaults;}});
  assert.equal(reads, 1);
  assert.equal(editor.state.status, 'idle');
  assert.equal(editor.state.draft.requests.desktop, false);
  assert.equal(editor.dirty, true);
});

test('unknown save: failed reconciliation keeps intent and locks destructive actions until successful read-back', async () => {
  const editor = createNotificationSettingsEditor(defaults);
  editor.edit('requests', 'desktop', false);
  let posts = 0;
  const api = {post:async () => {posts++; throw new Error('timeout');}, get:async () => {throw new Error('offline');}};
  await editor.save(api);
  assert.equal(editor.state.error, UNKNOWN_READ);
  assert.equal(editor.state.status, 'unknown');
  editor.discard(); editor.edit('requests', 'desktop', true); await editor.save(api);
  assert.equal(posts, 1);
  assert.equal(editor.state.draft.requests.desktop, false);
  const external = {...defaults, job_ready:{history:false, desktop:true}};
  await editor.reconcile({get:async () => external});
  assert.equal(editor.state.status, 'idle');
  assert.equal(editor.state.saved.job_ready.history, false);
  assert.equal(editor.state.draft.job_ready.history, false, 'unrelated server edits are not overwritten');
  assert.deepEqual(notificationSettingsPatch(editor.state.saved, editor.state.draft), {requests:{desktop:false}});
});

test('unknown save: no duplicate POST or read during reconciliation', async () => {
  let resolveRead, posts = 0, reads = 0;
  const waiting = new Promise(resolve => {resolveRead = resolve;});
  const editor = createNotificationSettingsEditor(defaults);
  editor.edit('requests', 'history', false);
  const api = {post:async () => {posts++; throw new Error('lost');}, get:() => {reads++; return waiting;}};
  const save = editor.save(api);
  await Promise.resolve();
  assert.equal(editor.state.status, 'checking');
  await editor.save(api); await editor.reconcile(api); editor.discard();
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(editor.state.draft.requests.history, false);
  resolveRead(defaults); await save;
  assert.equal(editor.state.status, 'idle');
});

test('known request rejection preserves editable draft without claiming a commit', async () => {
  const editor = createNotificationSettingsEditor(defaults);
  editor.edit('requests', 'history', false);
  let reads = 0;
  await editor.save({post:async () => {throw Object.assign(new Error('Rejected'), {status:422});}, get:async () => {reads++; return defaults;}});
  assert.equal(reads, 0); assert.equal(editor.state.status, 'idle');
  assert.equal(editor.state.error, 'Notification settings were not saved.'); assert.equal(editor.dirty, true);
});

test('notification preferences never claim effective desktop delivery', () => {
  const before = JSON.stringify(defaults);
  const text = renderedText(renderFixture(NotificationSettings, {initialSettings:defaults}));
  assert.match(text, /request as desktop notifications/);
  assert.match(text, /Desktop delivery also depends on Faravan running/);
  assert.match(text, /notification permissions and Do Not Disturb settings/);
  assert.equal(JSON.stringify(defaults), before);
});

test('notification introduction mentions Do Not Disturb only once',()=>{
  const text=renderedText(renderFixture(NotificationSettings,{initialSettings:defaults}));
  assert.equal((text.match(/Do Not Disturb/g)||[]).length,1);
});
