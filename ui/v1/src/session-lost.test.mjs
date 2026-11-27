import {problemView} from './problem-catalog.mjs';
const SESSION_LOST_TEXT=problemView({code:'unauthorized'},{surface:'desktop',capabilities:{localApp:true}}).detail;
import test from 'node:test';
import assert from 'node:assert/strict';
import {isSessionLost, isTransportFailure} from './helpers.mjs';
import {composeVM, connectionVM} from './view-models.mjs';

const circle = {id: 'c', name: 'Weekend projects', state: {networked: true}};
const folderMessage = state => composeVM({prompt: 'x', repo: {status: 'refused', refusal: {state}}, circle}).folderError;

test('a 401 from the folder check is a lost session, never a missing folder', () => {
  const unauthorized = {code: 'unauthorized', status: 401};
  assert.equal(isSessionLost(unauthorized), true);
  assert.equal(isTransportFailure(unauthorized), true);
  assert.match(folderMessage('compose.session-lost'), /^This page is no longer connected to Faravan\./);
  assert.doesNotMatch(folderMessage('compose.session-lost'), /isn.t on this computer|Not found/);
});

test('a network or server failure is "couldn\'t check", never a missing folder', () => {
  for (const error of [{code: 'network'}, {code: 'offline'}, {status: 500, code: 'internal'}, {}]) {
    assert.equal(isTransportFailure(error), true, JSON.stringify(error));
  }
  assert.match(folderMessage('compose.check-failed'), /couldn.t check this folder/);
});

test('only a definite refusal from the folder check says the folder is missing', () => {
  assert.equal(isTransportFailure({status: 404, code: 'not_found'}), false);
  assert.equal(isTransportFailure({status: 400, repoRefusal: {state: 'compose.repo-missing'}}), false);
  assert.match(folderMessage('compose.repo-missing'), /Choose an existing project folder/);

});

test('after a restart the banner says so once: no resource list, no error code, one action', () => {
  const lost = {status: 401, code: 'unauthorized'};
  const errors = Object.fromEntries(['home', 'readiness', 'agents', 'circles', 'approvals', 'devices', 'activity', 'jobs'].map(name => [name, lost]));
  const vm = connectionVM({errors, freshness: {home: '2026-10-20T10:54:00Z'}, zone: 'America/Chicago',capabilities:{localApp:true}});
  assert.equal(vm.kind, 'session');
  assert.equal(vm.text, SESSION_LOST_TEXT);
  assert.doesNotMatch(vm.text, /401|setup checks|agents|circles|Showing what we had/);
  assert.equal(vm.action, null);
  assert.equal(vm.copy, undefined);
  assert.equal(vm.details, undefined);
});

test('a non-auth failure keeps the honest error banner', () => {
  const vm = connectionVM({errors: {home: {status: 500, code: 'internal'}}, freshness: {}});
  assert.equal(vm.kind, 'error');
});

// Durable sessions survive a restart (shell-access-integration.md §1), so a real 401 means the session ended: it
// expired, was revoked, or this page never had one. The copy must not claim a cause it cannot know; a normal update
// restart has its own automatic banner.
test('session-lost copy is cause-neutral and the same on every surface', () => {
  assert.equal(SESSION_LOST_TEXT, 'This page is no longer connected to Faravan. Open it again from Faravan on this computer.');
  const banner = connectionVM({errors: {home: {status: 401, code: 'unauthorized'}},capabilities:{localApp:true}});
  assert.equal(banner.kind, 'session');
  assert.equal(banner.text, SESSION_LOST_TEXT);
  for (const text of [SESSION_LOST_TEXT, banner.text, folderMessage('compose.session-lost')]) assert.doesNotMatch(text, /restart/i);
});

test("warm session recovery gives phones pairing instructions and desktops reopen instructions",()=>{
 const errors={home:{status:401,code:"unauthorized"}};
 const phone=connectionVM({errors,phone:true});
 assert.match(phone.text,/Settings → Pairing.*pair this device again/);
 assert.doesNotMatch(phone.text,/tray|run (?:faravan|faravan)|terminal|401/);assert.equal(phone.action,null);
 const desktop=connectionVM({errors,phone:false,capabilities:{localApp:true}});
 assert.match(desktop.text,/Open it again from Faravan/);assert.equal(desktop.action,null);
});
