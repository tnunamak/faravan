import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRowVM} from './view-models.mjs';

const off = {status: 'off', detail: 'Not lent.'};

test('an agent that is not lent says whether it is ready or signed out', () => {
  const claude = agentRowVM({id: 'claude', installed: true, signedIn: true, useForLending: false}, off);
  assert.deepEqual([claude.word, claude.state, claude.warn, claude.canEnable], ['Ready · not lent yet', 'off', false, true]);
  const codex = agentRowVM({id: 'codex', installed: true, signedIn: false, signInSupported: true, useForLending: false}, off);
  assert.deepEqual([codex.word, codex.state, codex.warn, codex.canSignIn], ['Signed out', 'signin', false, true]);
  assert.equal(agentRowVM({id: 'codex', installed: false, useForLending: false}, off).word, 'Not installed');
  assert.equal(agentRowVM({id: 'codex', installed: true, useForLending: false}, off).word, 'Not lent');
});

test('an unknown requester is "A circle member", lowercase inside a sentence', async () => {
  const {requestReviewVM} = await import('./request-model.mjs');
  const {reviewCard, approvalNotificationTitle} = await import('./helpers.mjs');
  const vm = requestReviewVM({requester: 'k'}, {requesterKey: 'k', requesterName: 'Unnamed device'}, {}, {windows: {30: {rows: []}}});
  assert.equal(vm.heading, 'A circle member asked for help');
  assert.equal(vm.history, 'You haven’t run any of a circle member’s jobs in the past 30 days.');
  assert.equal(approvalNotificationTitle({}), 'A circle member asked for your help');
  assert.equal(reviewCard({id: 'a', requester: 'k', job: {}}).requester, 'A circle member');
});

test('a request this computer sent reads as your own job, never as a stranger asking', async () => {
  const {reviewCard, approvalNotificationTitle, OWN_REQUEST_TITLE} = await import('./helpers.mjs');
  const self = 'sha256:6a5a', own = {id: 'a', requester: self, requesterName: null, job: {}};
  assert.equal(OWN_REQUEST_TITLE, 'Your job is ready to run on your computer');
  assert.deepEqual([reviewCard(own, [], [], self).own, reviewCard(own, [], [], self).title], [true, OWN_REQUEST_TITLE]);
  assert.equal(approvalNotificationTitle(own, self), OWN_REQUEST_TITLE);
  const other = {id: 'b', requester: 'sha256:75c5', requesterName: null, job: {}};
  assert.equal(reviewCard(other, [], [], self).title, 'A circle member asked for help');
  assert.equal(reviewCard({...other, identity: {}, requesterName: 'Sam laptop'}, [], [], self).title, 'Sam laptop asked for help');
  assert.equal(approvalNotificationTitle(other, self), 'A circle member asked for your help');
  assert.equal(reviewCard(own, [], []).own, false, 'without a known self, nothing is own');
});

test('agent rows use a neutral agent glyph, never a single letter', () => {
  for (const id of ['claude', 'codex', 'gemini']) assert.equal(agentRowVM({id, installed: true, signedIn: true}).icon, 'terminal');
  assert.equal('logo' in agentRowVM({id: 'claude'}), false);
});
