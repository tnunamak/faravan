import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {connectionVM} from './view-models.mjs';
import {Action, Connection, Confirm} from './shared.jsx';
import {LendSwitch} from './lend.jsx';
import {renderFixture} from './render.test-helper.mjs';

// DEFECT-2: while the app cannot reach Faravan, an action that asks it for something is held, with the reason.
const inside = (offline, child) => renderFixture(() => h(Connection.Provider, {value: {offline}}, child));

test('an Action is held while offline, and says why', () => {
  const online = inside(false, h(Action, {run() {}}, 'Save'));
  assert.doesNotMatch(online, /disabled/);
  const held = inside(true, h(Action, {run() {}}, 'Save'));
  assert.match(held, /<button[^>]*disabled/);
  assert.match(held, /title="Waits until you’re back online"/);
});

test('a local action (a copy, the retry) is never held', () => {
  assert.doesNotMatch(inside(true, h(Action, {run() {}, allowOffline: true}, 'Copy')), /disabled/);
});

test('the Lending switch is held while offline', () => {
  const vm = {switch: {on: true, shown: true}};
  assert.doesNotMatch(inside(false, h(LendSwitch, {vm, run() {}})), /disabled/);
  assert.match(inside(true, h(LendSwitch, {vm, run() {}})), /role="switch"[^>]*disabled|disabled[^>]*role="switch"/);
});

test('an open confirmation says why it waits and cannot confirm while the page shows old data (review 3 P2)', () => {
  globalThis.document ??= {activeElement: null}; // Confirm reads the focused element when it opens
  const dialog = offline => inside(offline, h(Confirm, {title:'Remove Mo?', confirmLabel:'Remove', onConfirm() {}, onClose() {}}, h('p', null, 'This removes Mo.')));
  assert.doesNotMatch(dialog(false), /Waits until/);
  const held = dialog(true);
  assert.match(held, /Waits until you’re back online\. Nothing is changed until then\./);
  assert.match(held, /<button[^>]*disabled[^>]*>Remove<\/button>/);
});

test('offline does not present one resource timestamp as the page age', () => {
  const vm = connectionVM({online:false, freshness:{home:'2026-11-01T12:00:00Z'}, zone:'UTC'});
  assert.equal(vm.kind, 'offline');
  assert.equal(vm.asOf, undefined);
});

test('error age belongs to the resource that supplies its explanation', () => {
  const freshness = {home:'2026-11-01T12:00:00Z', jobs:'2026-11-01T10:00:00Z'};
  for (const code of ['service_unavailable', 'network']) {
    const home = {code}, jobs = {code:'read_timeout'};
    const single = connectionVM({errors:{home}, freshness, zone:'UTC'});
    const mixed = connectionVM({errors:{home,jobs}, freshness, zone:'UTC'});
    assert.ok(single.asOf);
    assert.equal(mixed.asOf, single.asOf);
    assert.equal(mixed.headline, single.headline);
    assert.deepEqual(mixed.stale, ['home','jobs']);
    assert.equal(connectionVM({errors:{home,jobs}, freshness:{jobs:freshness.jobs}, zone:'UTC'}).asOf, undefined);
  }
});

test('stale and failed reads also explain that live updates are paused', () => {
  for (const code of ['network', 'service_unavailable']) {
    const input = {errors:{home:{code}}};
    assert.match(connectionVM({...input, connected:false}).text, /Live updates are paused[.]/);
    assert.doesNotMatch(connectionVM({...input, connected:true}).text, /Live updates are paused/);
  }
});

test('paused connection labels its generic refresh action honestly', () => {
  assert.equal(connectionVM({connected:false}).action, 'Refresh');
});
