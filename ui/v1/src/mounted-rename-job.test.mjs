import {act, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job} from './jobs.jsx';
import {errorMessage} from './helpers.mjs';

// Batch 9 (C4): renaming a job is one form operation. Save is pending and locked until the title is answered; a
// rejected save keeps the typed title and says why; a second submit while one is in flight is not sent.
const DIGEST = 'sha256:' + '4a'.repeat(32);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const record = {job_digest: DIGEST, circle: {id: 'c1'}, state: 'running', status: 'running', local: {title: 'Fix the login loop', prompt: 'Fix it', agent: 'codex', submittedAt: new Date().toISOString()},
  current_attempt: {holder: 'fp-2', attempt_id: 'a1', generation: 1, execution_started_at: new Date().toISOString()}};

beforeEach(() => { resetPage('#/job/x'); installClock(); });
afterEach(teardown);

function page(writes) {
  const api = createFakeApi();
  api.get = async path => path.startsWith('jobs/' + encodeURIComponent(DIGEST)) && !path.includes('/', ('jobs/' + encodeURIComponent(DIGEST)).length + 1) ? record
    : path.includes('/transcript') ? {text: '', live: false, at: new Date().toISOString()} : {};
  const mutate = (path, body) => new Promise((resolve, reject) => writes.push({path, body, resolve, reject}));
  return mount(h(Job, {id: DIGEST, requestedCircle: 'c1', api, circle: 'c1', circles: [circle], revision: 0, mutate,
    setDialog() {}, members: [], headingRef: {current: null}, refresh: async () => {}, draft: {submission: null},
    data: {jobs: [], devices: {fingerprint: 'fp-1', name: 'MacBook', circles: []}}}));
}
const form = () => document.querySelector('form:has(input[maxlength="160"])') ?? [...document.querySelectorAll('form')].find(f => f.querySelector('input[maxlength="160"]'));
const button = label => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const submit = async () => { await act(() => { form().dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); }); await flush(); };
const type = async value => { await act(() => { const input = form().querySelector('input'); input.value = value; input.dispatchEvent(new window.Event('input', {bubbles: true})); }); await flush(); };

test('renaming a job: one save is sent, a second submit waits, a rejected save keeps the title with its reason', async () => {
  const writes = [];
  const view = await page(writes);
  await click(button('Rename job'));
  await type('Fix the login loop for Safari');
  await submit();
  assert.deepEqual(writes.map(w => [w.path, w.body]), [['jobs/' + encodeURIComponent(DIGEST) + '/title', {title: 'Fix the login loop for Safari'}]]);
  assert.equal(button('Save title').getAttribute('aria-busy'), 'true', 'Save shows it is working');
  assert.equal(form().querySelector('input').disabled, true, 'the title cannot change while the save is in flight');
  await submit();
  assert.equal(writes.length, 1, 'a second submit is not sent');
  const refusal = Object.assign(new Error('refused'), {code: 'unavailable'});
  await act(() => { writes[0].reject(refusal); });
  await flush();
  assert.equal(form().querySelector('input').value, 'Fix the login loop for Safari', 'the typed title is kept');
  assert.equal(form().querySelector('[role="alert"]')?.textContent.trim(), errorMessage(refusal), 'the failure is shown in the form');
  assert.equal(button('Save title').getAttribute('aria-busy'), null, 'Save is available again');
  await submit();
  assert.equal(writes.length, 2, 'a retry is sent after the failure');
  await act(() => { writes[1].resolve({}); });
  await flush();
  assert.equal(form(), undefined, 'the form closes once the title is saved');
  await view.unmount();
});
