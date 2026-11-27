import {act, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {LimitsPage} from './limits.jsx';
import {NOW} from './lending-policy.fixture.mjs';

// Item 2 (1102 review): the page has three save boundaries (the grouped form, the per-job limit, standing rules). The grouped
// footer must say which settings it covers and which save on their own, not claim "all of these".
const START = Date.UTC(2026, 9, 20, 15, 0, 0);
beforeEach(() => { resetPage('#/limits'); installClock(START); });
afterEach(teardown);

const lending = {mode: 'ask', circle: 'weekend', limits: {timeZone: 'UTC', dailyJobs: 3, dailyMinutes: 60,
  maxWallSeconds: 1200, lendingPolicy: {protectionPosition: 'balanced'}}};

test('the grouped save bar names the settings it saves together and says the per-job limit and standing rules save on their own', async () => {
  const api = createFakeApi();
  const view = await mount(h(LimitsPage, {lending, circle: 'weekend', now: NOW, mutate: async () => ({}), api, data: {home: {lending}}}));
  const keepMore = view.$('input[name="protectionPosition"][value="keep_more_for_me"]');
  keepMore.checked = true;
  await act(() => { keepMore.dispatchEvent(new window.Event('change', {bubbles: true})); });
  const bar = view.$('.limits-savebar').textContent;
  assert.ok(bar.includes('Save applies the lending setting, strategy, effort, consent, daily limits, concurrency and hours together, or none of them.'), 'the grouped scope is named');
  assert.ok(bar.includes('The per-job limit and standing rules save on their own.'), 'the independent saves are named');
  assert.ok(!bar.includes('Save applies all of these together'), 'the vague claim is gone');
  await view.unmount();
});
