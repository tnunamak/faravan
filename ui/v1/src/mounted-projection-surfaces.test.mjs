import {act, advance, click, createFakeApi, flush, installClock, mount, navigate, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// Dot UI review of the state projection: every surface reads lending from the one projection.
// - Setup must not hide a job that is still running after lending was turned off.
// - Join and onboarding copy must not call lending "already on" from older fields while the projection says
//   paused, off or unknown.
beforeEach(() => { resetPage('#/home'); installClock(); });
afterEach(teardown);

const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true};
function table(home) {
  return {
    readiness: {ready: true, checks: []}, home: () => home, circles: [circle], agents: [],
    devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []}, approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  };
}
async function boot(home) {
  const api = createFakeApi(table(home));
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  return {api, view};
}
async function visit({api, view}, hash) {
  await navigate(hash); await act(() => { window.dispatchEvent(new window.Event('hashchange')); }); await advance(50, 10); await api.release(); await flush(); await api.release();
  assert.ok(location.hash === hash, 'navigated to ' + hash);
  return view.text();
}

test('an authoritative off + running tuple reads the same on Home, Lending and Setup, also after a refresh', async () => {
  const home = withLendingProjection({intent: {on: false, state: 'off'}, lending: {enabled: false, circle: 'c1'}},
    {intent: 'off', intentState: 'off', admission: 'blocked', admissionReason: 'off', execution: 'running', executionJob: 'attempt-1'});
  const page = await boot(home);
  for (const hash of ['#/home', '#/lend', '#/setup', '#/home', '#/setup']) {
    const text = await visit(page, hash);
    assert.match(text, /Running /, hash + ' names the running job');
    if (hash === '#/setup') assert.match(text, /The job already running can finish/, 'Setup qualifies the no-new-jobs line');
    assert.doesNotMatch(text, /No friends’ jobs run until you turn lending on/, hash + ' never denies the job already running');
  }
});

for (const [label, projection] of [
  ['paused', {intent: 'paused', intentState: 'paused', admission: 'blocked', admissionReason: 'paused'}],
  ['off', {intent: 'off', intentState: 'off', admission: 'blocked', admissionReason: 'off'}],
  ['unknown', {intent: 'unknown', intentState: null, admission: 'unknown', admissionReason: null}],
]) test('join copy never says lending is already on when the projection is ' + label + ', despite older fields', async () => {
  // Older fields say on; the authoritative projection does not.
  const home = withLendingProjection({intent: {on: true, state: 'ready'}, lending: {enabled: true, circle: 'c1'}}, projection);
  const page = await boot(home);
  await visit(page, '#/circles');
  await click(page.view.button('Join with an invitation'));
  const text = page.view.text();
  assert.doesNotMatch(text, /Lending is already on|Lending is set to on/);
  if (label === 'paused') assert.match(text, /Lending is paused\. Joining does not resume it\./);
});
