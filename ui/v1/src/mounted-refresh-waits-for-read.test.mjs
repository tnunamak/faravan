import {advance, click, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Invitations} from './invitations.jsx';

// Batch 9 (P2-6): a user's Refresh is done when its read is done. The control stays busy until the list it asked
// for has been read, so a second press cannot look like a no-op and an answer cannot arrive after "Refresh" is back.
beforeEach(() => { resetPage('#/circle/c1'); installClock(); });
afterEach(teardown);

test('Refresh invitations stays busy until the invitation read it asked for has answered', async () => {
  const api = createFakeApi({'circles/c1/invitations': []});
  const view = await mount(h(Invitations, {circleId: 'c1', api, revision: 0, mutate: async () => ({}), setDialog() {}}));
  await api.release();
  await advance(1000);
  // The Action keeps this element while it is busy (its label becomes "Working…"), so the element is read, not the label.
  const refresh = view.button('Refresh invitations');
  await click(refresh);
  await advance(1000);
  assert.equal(refresh.getAttribute('aria-busy'), 'true', 'Refresh is still working while its read is open');
  assert.equal(api.openReads('circles/c1/invitations').length, 1, 'the read it asked for is open');
  await api.release();
  await flush();
  assert.equal(refresh.getAttribute('aria-busy'), null, 'Refresh is done once that read has answered');
  await view.unmount();
});
