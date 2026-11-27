import {mount, click, flush, teardown, createFakeApi, act, installClock, advance, resetPage} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {App} from './main.jsx';
import test from 'node:test';
import assert from 'node:assert/strict';

// App-level proof for the circles producer in main.jsx: readResource('circles')
// bumps a read-start sequence and publishes circlesSnapshot {readId, rows} on a
// fulfilled array response, even when the rows are JSON-equal to the cached
// ones, and publishes nothing for a pending, failed, aborted or non-array
// read. circlesSnapshot is only observable through the Circles page's join
// outcome (joinOutcomeVM: a snapshot newer than the join's barrier, whose
// rows omit the joined circle, retires the outcome), so the outcome is the
// probe for every case below. No DOM node is compared with assert.equal;
// only ids, text and booleans are compared.

const circleA = {id: 'circle-a', name: 'Friends', origin: 'http://10.23.1.2:8787'};
const joined = {id: 'circle-b', name: 'Weekend', origin: 'http://10.23.1.2:8787',
  membershipProjection: {schemaVersion: 2, kind: 'membership', phase: 'approved',
    evidence: {enrollmentState: 'approved', origin: true}, invitationPolicy: 'automatic'}};

function fakeApi() {
  return createFakeApi({
    'circles/join-preview': {name: 'Weekend', origin: 'http://10.23.1.2:8787', lanMode: false},
    'circles/join': joined,
  });
}

async function mountCircles(api) {
  resetPage('#/circles');
  const view = await mount(h(App, {api}));
  await advance(1000);
  return view;
}

async function openCirclesRead(api) {
  // The app's own event refresh starts a circles read when none is open.
  for (const type of ['circles', 'readiness', 'update']) {
    if (api.openReads('circles').length) break;
    await api.emit(type, {circle: 'circle-a'});
    await advance(5000);
  }
  const call = api.openReads('circles')[0];
  assert.ok(call, 'expected an open circles read');
  return call;
}

// The join's own refresh waits for every resource read, so answer them all (the
// circles read with the cached rows) until the join Action has finished.
async function settleOpenReads(api, keep = null, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await advance(1000);
    const open = api.reads.filter(call => call.state === 'open' && call !== keep);
    if (!open.length) return;
    for (const call of open) {
      if (call.state !== 'open') continue;
      const value = call.path === 'circles' ? [circleA] : call.path === 'hosting' ? {} : call.path.split('?')[0] === 'home' ? {} : [];
      call.settle('ok', value);
    }
    await flush();
  }
}

async function joinCircle(view, api, keep = null) {
  await click(view.button('Join with an invitation'));
  const box = view.$('textarea');
  assert.ok(box, 'invitation field renders');
  await act(() => {
    box.value = 'https://example.invalid/invite';
    box.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await flush();
  await click(view.button('Review invitation'));
  await click(view.button('Join circle'));
  await settleOpenReads(api, keep);
}

const outcomeVisible = view => Boolean(view.$('.join-outcome')) && view.text().includes('View circle');

test('a post-join circles read clears a joined outcome, even when its rows are JSON-equal to the cached rows', async () => {
  const api = fakeApi();
  installClock();
  try {
    const view = await mountCircles(api);
    await api.answer('circles', [circleA]);
    await advance(1000);
    await joinCircle(view, api);
    assert.equal(outcomeVisible(view), true, 'joined outcome shows after the join');
    // Failed read: the outcome stays, and the error card offers a retry.
    await openCirclesRead(api);
    await api.fail('circles', new Error('read failed'));
    await advance(1000);
    assert.equal(outcomeVisible(view), true, 'a failed read leaves the joined outcome');
    assert.ok(view.button('Retry circles'), 'failed circles read offers Retry circles');
    // Retry starts a read after the join. While it is pending it must not
    // publish anything: the outcome stays until the read is answered.
    await click(view.button('Retry circles'));
    await advance(5000);
    await openCirclesRead(api);
    await advance(1000);
    assert.equal(outcomeVisible(view), true, 'a pending read leaves the joined outcome');
    // The rows below are JSON-equal to the cached circles ([circle-a]):
    // data.circles does not change, yet the snapshot must still publish with
    // the new read id, so the outcome retires.
    await api.answer('circles', [circleA]);
    await advance(1000);
    assert.equal(view.$('.join-outcome'), null, 'joined outcome retires after the newer read');
    assert.equal(view.text().includes('View circle'), false, 'View circle link is gone');
  } finally { await teardown(); }
});

test('a circles read that started before the join leaves a joined outcome', async () => {
  const api = fakeApi();
  installClock();
  try {
    const view = await mountCircles(api);
    await settleOpenReads(api);
    // Start a circles read before the join, through the app's own event
    // refresh, and leave it open across the join.
    const stale = await openCirclesRead(api);
    await joinCircle(view, api, stale);
    assert.equal(stale.state, 'open', 'the pre-join read is still open after the join');
    assert.equal(outcomeVisible(view), true, 'joined outcome shows after the join');
    // The stale read's id is at most the barrier captured at join time, so
    // its snapshot is not authoritative and the outcome survives, even
    // though its rows omit the joined circle.
    stale.settle('ok', [circleA]);
    await flush();
    await advance(1000);
    assert.equal(outcomeVisible(view), true, 'a pre-join read leaves the joined outcome');
  } finally { await teardown(); }
});

test('pending and non-array circles reads publish nothing', async () => {
  const api = fakeApi();
  installClock();
  try {
    const view = await mountCircles(api);
    await api.answer('circles', [circleA]);
    await advance(1000);
    await joinCircle(view, api);
    assert.equal(outcomeVisible(view), true, 'joined outcome shows after the join');
    // Pending: the auto-refresh read is open and has published nothing.
    await openCirclesRead(api);
    await advance(1000);
    assert.equal(outcomeVisible(view), true, 'a pending read leaves the joined outcome');
    // Non-array: a fulfilled non-array response publishes no snapshot, so
    // the outcome survives even though the list itself is replaced.
    await api.answer('circles', null);
    await advance(1000);
    assert.equal(outcomeVisible(view), true, 'a non-array read leaves the joined outcome');
  } finally { await teardown(); }
});
