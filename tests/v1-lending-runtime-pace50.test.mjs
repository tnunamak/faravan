import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {ACCOUNT, NOW, WEEK, ordinaryInput} from './helpers/pace50-fixtures.mjs';

const candidate = () => ({
  account: ACCOUNT,
  account_week_id: WEEK,
  buildInput: async ({now}) => ordinaryInput({now}),
  effects: {
    arm_cessation_deadline: async () => () => {},
    launch_chunk: async () => {},
    open_short_window: async () => {},
    cancel_pending_attempt: async () => {},
    request_cessation: async () => {},
    request_fresh_complete_reconciliation: async () => {},
  },
});

function runtimeAt(directory, extra = {}) {
  const settings = {intent: 'off', limits: {lendingPolicy: normalizeLendingPolicy()}};
  return createLendingRuntime({directory, settings: () => settings, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => NOW, ...extra});
}

function scratch(t, prefix) {
  const directory = fs.mkdtempSync(join(tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('the default runtime exposes no candidate store and writes none of its files', async (t) => {
  const directory = scratch(t, 'runtime-pace50-off-');
  const runtime = runtimeAt(directory);
  assert.equal(runtime.pace50, null);
  await runtime.close();
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('lending-pace50')), false);
});

test('an opted-in runtime opens its candidate store, refuses a second owner, and releases the lock on close', async (t) => {
  const directory = scratch(t, 'runtime-pace50-on-');
  const options = candidate();
  const runtime = runtimeAt(directory, {pace50: options});
  assert.equal(runtime.pace50.state().revision, 0);
  assert.throws(() => createPace50Adapter({directory, ...options, now: () => NOW}), {code: 'lock_busy'});
  await runtime.close();
  const reopened = createPace50Adapter({directory, ...options, now: () => NOW});
  assert.equal(reopened.state().revision, 0);
  await reopened.close();
});
