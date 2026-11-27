import test from 'node:test';
import assert from 'node:assert/strict';
import {homePageVM, machineVM} from './view-models.mjs';
import {Shell} from './shell.jsx';
import {h} from 'preact';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// UI-log L258: after a restart every read is refused, yet Home said "Loading…" for ever.
const lost = {status: 401, code: 'unauthorized'};

test('Home subtitle stops saying Loading once the status read has failed', () => {
  assert.equal(homePageVM({}).subtitle, 'Loading requests and results…');
  const session = homePageVM({unavailable: lost}).subtitle;
  assert.doesNotMatch(session, /Loading/);
  assert.equal(session, 'Not connected. Open Faravan again to see what needs you.');
  const failed = homePageVM({unavailable: {status: 500, code: 'internal'}}).subtitle;
  assert.equal(failed, 'This computer’s status couldn’t be loaded.');
});

test('the sidebar computer chip says it is not connected, never Checking, when the session is lost', () => {
  const chip = machineVM(undefined, {name: 'sandpiper'}, {unavailable: lost});
  assert.equal(chip.line, 'Not connected');
  assert.equal(chip.kind, 'off');
  assert.equal(machineVM(undefined, {name: 'sandpiper'}, {unavailable: {status: 502}}).line, 'Status unavailable');
  assert.equal(machineVM(undefined, {name: 'sandpiper'}).line, 'Checking this computer…');
});

test('the rendered shell in the session-lost state shows no loading copy', () => {
  const out = renderedText(renderFixture(Shell, {route: {page: 'home'}, devices: {name: 'sandpiper'}, circles: [], agents: [],
    title: 'Home', subtitle: homePageVM({unavailable: lost}).subtitle, unavailable: lost, children: h('main', null)}));
  assert.doesNotMatch(out, /Loading|Checking/);
  assert.match(out, /Not connected/);
});
