import {act, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {LimitsPage} from './limits.jsx';
import {NOW} from './lending-policy.fixture.mjs';

// Batch 9 (P2-7): after an uncertain save, a check that fails says so. The uncertain result and the draft stay; the
// check failure is not read as "not saved" and is not silently dropped.
const START = Date.UTC(2026, 9, 20, 15, 0, 0);
beforeEach(() => { resetPage('#/limits'); installClock(START); });
afterEach(teardown);

const lending = {mode: 'ask', circle: 'weekend', limits: {timeZone: 'UTC', dailyJobs: 3, dailyMinutes: 60,
  maxWallSeconds: 1200, lendingPolicy: {protectionPosition: 'balanced'}}};

test('a check of saved settings that cannot reach the host says it could not check, and keeps the draft and the uncertain save', async () => {
  const api = createFakeApi();
  api.get = async () => { throw Object.assign(new Error('unreachable'), {code: 'network'}); };
  const mutate = async () => { throw Object.assign(new Error('timed out'), {code: 'network'}); };
  const view = await mount(h(LimitsPage, {lending, circle: 'weekend', now: NOW, mutate, api, data: {home: {lending}}}));
  const keepMore = view.$('input[name="protectionPosition"][value="keep_more_for_me"]');
  keepMore.checked = true;
  await act(() => { keepMore.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await click(view.$('.limits-savebar .btn-primary'));
  await flush();
  assert.match(view.text(), /We could not confirm whether your changes were saved\./, 'the save is still reported as uncertain');
  assert.match(view.text(), /Could not check the saved settings\./, 'the failed check is said, not dropped');
  assert.equal(view.$('input[name="protectionPosition"][value="keep_more_for_me"]').checked, true, 'the draft is kept');
  await view.unmount();
});
