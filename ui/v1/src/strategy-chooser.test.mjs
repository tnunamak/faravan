import {click, createFakeApi, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act} from 'preact/test-utils';
import {LimitsPage} from './limits.jsx';
import {chooseStrategy, validatePolicy, withFixedShare, policyDraft} from './lending-policy-view.mjs';
import {NOW} from './lending-policy.fixture.mjs';

// The Limits page lets the owner choose Automatic (recommended) or Fixed share. Fixed share takes one share number, saved as
// strategyParams.fixedSharePct through the same policy save as the protection position. Synthetic data only.
const START = Date.UTC(2026, 9, 20, 15, 0, 0);
const lending = {mode: 'ask', circle: 'weekend', configVersion: 3, limits: {timeZone: 'UTC', dailyJobs: 3, dailyMinutes: 60,
  maxWallSeconds: 1200, lendingPolicy: {protectionPosition: 'balanced'}}};
const SHARE_LABEL = 'Share of each week friends can use, percent';

beforeEach(() => { resetPage('#/'); installClock(START); });
afterEach(teardown);

const mountPage = (calls) => mount(h(LimitsPage, {lending, circle: 'weekend', now: NOW,
  mutate: async (path, body) => { calls.push([path, body]); return {}; }, api: createFakeApi(), data: {home: {lending}}}));

async function choose(view, value) {
  const radio = view.$(`input[name="lendingStrategy"][value="${value}"]`);
  radio.checked = true;
  await act(() => { radio.dispatchEvent(new window.Event('change', {bubbles: true})); });
}

async function typeShare(view, text) {
  const input = view.$(`input[aria-label="${SHARE_LABEL}"]`);
  input.value = text;
  await act(() => { input.dispatchEvent(new window.Event('input', {bubbles: true})); });
}

test('the strategy chooser offers Automatic (recommended) and Fixed share, with Automatic selected by default', async () => {
  const calls = [];
  const view = await mountPage(calls);
  const radios = [...view.$$('input[name="lendingStrategy"]')];
  assert.deepEqual(radios.map(radio => radio.value), ['automatic', 'fixed_share'], 'custom and manual approval are not offered');
  assert.equal(view.$('input[name="lendingStrategy"][value="automatic"]').checked, true, 'Automatic is selected by default');
  assert.equal(view.$('input[name="lendingStrategy"][value="fixed_share"]').checked, false);
  const automatic = view.$('input[value="automatic"]').closest('label');
  assert.equal(automatic.querySelector('.protection-tag').textContent, 'Recommended');
  assert.equal(automatic.querySelector('b').textContent, 'Automatic');
  assert.equal(view.$('input[value="fixed_share"]').closest('label').querySelector('b').textContent, 'Fixed share');
  assert.equal(view.$(`input[aria-label="${SHARE_LABEL}"]`), null, 'the share number appears only with Fixed share');
  assert.deepEqual(calls, []);
});

test('choosing Fixed share and entering 10 saves strategy fixed_share with fixedSharePct 10', async () => {
  const calls = [];
  const view = await mountPage(calls);
  await choose(view, 'fixed_share');
  const input = view.$(`input[aria-label="${SHARE_LABEL}"]`);
  assert.ok(input, 'the share number appears');
  assert.equal(input.value, '20', 'the engine default share is shown until the owner changes it');
  await typeShare(view, '10');
  await click(view.$('.limits-savebar .btn-primary'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'lending/limits');
  const policy = calls[0][1].lendingPolicy;
  assert.equal(policy.strategy, 'fixed_share');
  assert.equal(policy.strategyParams.fixedSharePct, 10);
  assert.equal(policy.strategyParams.keepPct, 30, 'keep-back stays at its default');
  assert.equal(policy.protectionPosition, 'balanced', 'the protection position saves with it');
});

test('an out-of-range share shows the range error and does not save', async () => {
  const calls = [];
  const view = await mountPage(calls);
  await choose(view, 'fixed_share');
  await typeShare(view, '150');
  const alert = view.$(`.line [role="alert"]`);
  assert.equal(alert?.textContent, 'Use a number from 0 to 100.');
  assert.equal(view.$('.limits-savebar .btn-primary').getAttribute('aria-disabled'), 'true');
  await click(view.$('.limits-savebar .btn-primary'));
  assert.deepEqual(calls, [], 'nothing is saved while the share is out of range');
});

test('an empty share is refused rather than replaced by the default', async () => {
  const calls = [];
  const view = await mountPage(calls);
  await choose(view, 'fixed_share');
  await typeShare(view, '');
  assert.equal(view.$(`.line [role="alert"]`)?.textContent, 'Use a number from 0 to 100.');
  await click(view.$('.limits-savebar .btn-primary'));
  assert.deepEqual(calls, []);
});

test('the draft helpers select Fixed share with its default share and refuse text that is not a number', () => {
  const chosen = chooseStrategy(policyDraft(), 'fixed_share');
  assert.equal(chosen.strategy, 'fixed_share');
  assert.equal(chosen.strategyParams.fixedSharePct, 20);
  assert.equal(validatePolicy(chosen).ok, true);
  assert.equal(validatePolicy(withFixedShare(chosen, '100')).ok, true, '100 is the top of the range');
  const low = validatePolicy(withFixedShare(chosen, '-1'));
  assert.equal(low.ok, false);
  assert.deepEqual(low.errors, {'strategyParams.fixedSharePct': 'Use a number from 0 to 100.'});
  assert.equal(validatePolicy(withFixedShare(chosen, '')).errors['strategyParams.fixedSharePct'], 'Use a number from 0 to 100.');
  assert.equal(validatePolicy(chooseStrategy(policyDraft(), 'automatic')).ok, true);
});

test('the ten percent per-job cap can be changed and saved with the lending policy', async () => {
  const calls=[];
  const view=await mountPage(calls);
  const input=view.$('input[aria-label="Per-job cap, percent of weekly allowance"]');
  assert.equal(input.value,'10');
  assert.match(input.closest('.line').textContent,/Faravan stops a job when its measured use reaches the cap/);
  input.value='25';
  await act(()=>{input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  await click(view.$('.limits-savebar .btn-primary'));
  assert.equal(calls[0][1].lendingPolicy.strategyParams.perJobPct,25);
});
