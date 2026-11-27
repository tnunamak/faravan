import test from 'node:test';
import assert from 'node:assert/strict';
import { youVM, notificationVM, autostartVM } from './settings-model.mjs';
import { Settings } from './info.jsx';
import { renderFixture, renderedText } from './render.test-helper.mjs';

test('You menu exposes every destination and validates the section', () => {
  assert.deepEqual(youVM().sections.map(s => s.label), ['All settings','Profile and devices','Appearance','Notifications','Updates','Pairing','Your data','Account']);
  assert.equal(youVM({}, 'missing').selected, null);
  assert.equal(youVM({}, 'notifications').selected.id, 'notifications');
  const menu = renderFixture(Settings, {data:{}});
  assert.doesNotMatch(menu, /href="#\/activity"/);
  assert.doesNotMatch(menu, /Passed:|Needs attention:|Check again|inconclusive/);
  assert.match(renderedText(renderFixture(Settings, {data:{},route:{id:'data'}})), /Your data/);
});

test('Profile waits for this computer’s identity before offering an editable name', () => {
  const loading = renderFixture(Settings, {data:{}, route:{id:'profile'}, mutate(){}});
  assert.match(loading, /Loading profile/);
  assert.doesNotMatch(loading, /<input/);
  const loaded = renderFixture(Settings, {data:{devices:{ownerName:'Sam',name:'Sam’s laptop'}}, route:{id:'profile'}, mutate(){}});
  assert.match(loaded, /value="Sam"/);
  assert.match(loaded, /value="Sam’s laptop"/);
  assert.equal(loaded.split('>Your name</label>').length - 1, 1);
  assert.equal(loaded.split('>Computer name</label>').length - 1, 1);
  assert.match(loaded, /href="#\/devices"/);
});
test('notification permission copy offers an action only when the browser can ask', () => {
  assert.equal(notificationVM('default').action, 'Turn on notifications');
  for (const permission of ['granted','denied','unsupported']) assert.equal(notificationVM(permission).action, null);
  assert.match(notificationVM('denied').text, /site settings/);
});


test('login model distinguishes unsupported, unavailable, moved and unreadable settings',()=>{
  assert.equal(autostartVM({supported:false}),null);
  assert.equal(autostartVM({supported:true,available:false}).action,null);
  assert.match(autostartVM({supported:true,error:true}).text,/Could not check/);
  assert.equal(autostartVM({supported:true,available:false,enabled:true,reason:'move_to_applications'}).action,'Turn off launch at login');
  assert.equal(autostartVM({supported:true,available:true,needsRepair:true,enabled:true}).action,'Update login item');
});


test('a moved but disabled login item offers only explicit opt-in',()=>{
  assert.equal(autostartVM({supported:true,available:true,enabled:false,needsRepair:true}).action,'Turn on launch at login');
});

test('browser denied, unknown and granted states never imply OS delivery or change saved preferences', () => {
  const preferences = {requests:{history:true, desktop:true}};
  const before = JSON.stringify(preferences);
  assert.match(notificationVM('granted').text, /This browser has permission to request notifications/);
  assert.match(notificationVM('granted').text, /computer's notification settings may still block them/);
  assert.match(notificationVM('denied').text, /browser’s site settings/);
  assert.doesNotMatch(notificationVM('denied').text, /computer's notification settings are blocked/);
  assert.match(notificationVM('unknown').text, /permission is not known/);
  assert.equal(notificationVM('unknown').action, null);
  assert.equal(JSON.stringify(preferences), before);
});
