import {advance, click, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';

// P0 group 2: the real App (real read queues, real watchUpdates, real revision policy) mounted on the
// Circles page, whose own `hosting` read is keyed on the app-wide revision. `hosting` re-reads exactly when
// the App bumps that revision, so its read count is the observable revision policy.
const GLOBAL = ['readiness', 'home', 'circles', 'agents', 'devices', 'approvals', 'activity', 'jobs', 'updates'];
const isGlobal = path => GLOBAL.includes(path);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true};
const tableFor = () => ({
  readiness: {ok: true},
  // Home carries an observation timestamp even when nothing changed: a clock-only difference.
  home: () => ({observedAt: new Date(Date.now()).toISOString(), lending: {enabled: false}, today: null}),
  circles: [circle], agents: [], devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
  approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  updates: {state: 'current', currentVersion: '1.0.0'},
  // The App-level first-run telemetry card reads this once; a decided level keeps the card hidden.
  telemetry: {level: 'off'},
  // The sidebar's Lending dot reads the lending checks once readiness and agents are in.
  'lending/readiness': {agents: []},
});
beforeEach(() => { resetPage('#/circles'); installClock(); });
afterEach(teardown);

async function boot(table = tableFor()) {
  const api = createFakeApi(table);
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  assert.equal(api.count('hosting'), 1);
  for (const name of GLOBAL) assert.equal(api.count(name), 1, name);
  return {api, view};
}

test('App mounted: changing the API retires circle names and live Activity from the previous client', async () => {
  resetPage('#/circle/c1');
  const activity=actor=>[{type:'member-left',at:'2026-10-20T14:59:00Z',data:{circle:circle.id,deviceName:actor}}];
  const old=createFakeApi({...tableFor(),circles:[{...circle,name:'Old circle'}],activity:activity('Old actor')});
  const current=createFakeApi({...tableFor(),circles:[{...circle,name:'Current circle'}],activity:activity('Current actor')});
  const page=api=>h(App,{api,takeJoinLink:()=>''});
  const view=await mount(page(old));
  await old.release();
  await click(view.button('Activity'));
  assert.match(view.text(),/Old circle/);
  assert.match(view.text(),/Old actor/);
  await old.emit('phone',{paired:1});
  await advance(6000);
  const oldRead=old.openReads('activity')[0];
  assert.ok(oldRead);
  oldRead.ignoreAbort=true;
  try {
    await view.rerender(page(current));
    assert.doesNotMatch(view.text(),/Old actor|Old circle/);
    assert.equal(oldRead.signal.aborted,true);
    oldRead.settle('ok',activity('Late old actor'));
    await flush();
    assert.doesNotMatch(view.text(),/Late old actor/);
    await current.release(path=>path!=='activity');
    await click(view.button('Activity'));
    const history='activity/history?circle='+circle.id;
    await current.fail(history,new Error('saved history unavailable'));
    assert.doesNotMatch(view.text(),/Old actor|Late old actor/);
    await current.answer('activity');
    assert.match(view.text(),/Current actor/);
    assert.match(view.text(),/Current circle/);
  } finally {oldRead.settle('ok',[]);await flush();}
});

test('App mounted: the shared initial update read shows availability and opens the existing Updates page', async () => {
  const {api, view} = await boot({...tableFor(), updates: {state:'available', currentVersion:'1.0.0', candidate:'1.1.0'}});
  assert.match(view.text(), /A new version of Faravan is available/);
  assert.ok(view.button('View updates'));
  assert.equal(api.count('updates'), 1, 'the startup toast uses the shared shell read');
  await click(view.button('View updates'));
  assert.equal(location.hash, '#/settings/updates');
  assert.doesNotMatch(view.text(), /A new version of Faravan is available\. View updates/);
});
// Answer the open shell reads one at a time, six seconds apart, so a revision bump from any one answer
// lands while the page reader can already start (its own five-second spacing has passed).
async function settleStaggered(api, rounds = 14) {
  for (let n = 0; n < rounds; n++) {
    await advance(6000);
    const open = api.openReads(isGlobal)[0];
    if (open) await api.answer(open.path);
  }
  await advance(6000);
}
const reads = api => Object.fromEntries([...GLOBAL, 'hosting'].map(name => [name, api.count(name)]));
const counts = (api, names, n) => Object.fromEntries(names.map(name => [name, n]));

test('App mounted: clock-only updates (Home observedAt) refetch no page resource and no extra shell resource', async () => {
  const {api} = await boot();
  await api.emit('phone', {paired: 1}); // changes shell state, does not revise pages; refreshes every shell read
  await settleStaggered(api);
  assert.deepEqual(reads(api), {...counts(api, GLOBAL, 2), hosting: 1}, 'every shell read ran once more; the page read did not');
  const homes = api.readsOf('home');
  const [first, second] = await Promise.all(homes.map(call => call.promise));
  assert.notEqual(first.observedAt, second.observedAt, 'the two Home answers differ only by the clock');
  assert.deepEqual({...first, observedAt: 0}, {...second, observedAt: 0});
  await advance(120000);
  assert.deepEqual(reads(api), {...counts(api, GLOBAL, 2), hosting: 1}, 'and then nothing else reads');
});

test('App mounted: one changed resource revises pages once and does not refetch everything', async () => {
  const {api} = await boot();
  api.table.activity = [{id: 9, type: 'approval', data: {state: 'accepted'}}];
  await api.emit('phone', {paired: 2});
  await settleStaggered(api);
  assert.deepEqual(reads(api), {...counts(api, GLOBAL, 2), hosting: 2}, 'one change: one extra page read, one extra read per shell resource');
  assert.equal(api.peak('hosting'), 1);
  await advance(120000);
  assert.deepEqual(reads(api), {...counts(api, GLOBAL, 2), hosting: 2}, 'quiet afterwards');
});

test('App mounted: an unchanged event does not invalidate; a changed one does, once', async () => {
  const {api} = await boot();
  await api.emit('approval', {state: 'pending', id: 'r1'});
  await settleStaggered(api);
  await api.release();
  assert.deepEqual(reads(api), counts(api, [...GLOBAL, 'hosting'], 2), 'a new event refreshed the shell once and revised the page once');
  assert.equal(api.openReads(() => true).length, 0, 'nothing is left open or queued behind a pending read');
  await api.emit('approval', {state: 'pending', id: 'r1'}); // the daemon re-broadcasts the same state
  await settleStaggered(api);
  await advance(60000); await api.release();
  assert.deepEqual(reads(api), counts(api, [...GLOBAL, 'hosting'], 2), 'an identical event neither revises pages nor refreshes the shell, even after the read spacing');
  // A streamed chunk neither revises every open page nor re-reads the shell (judge r8 O13, I30: during a running
  // job these refreshes were most of the page's read budget).
  await api.emit('job', {status: 'transcript', line: 'streamed chunk'});
  await settleStaggered(api);
  await advance(60000); await api.release();
  assert.equal(api.count('hosting'), 2, 'a transcript chunk never revises the page');
  assert.deepEqual(reads(api), counts(api, [...GLOBAL, 'hosting'], 2), 'a transcript chunk does not re-read the shell');
  await api.emit('approval', {state: 'accepted', id: 'r1'});
  await settleStaggered(api);
  await advance(60000); await api.release();
  assert.equal(api.count('hosting'), 3, 'a changed event revises once more');
});
