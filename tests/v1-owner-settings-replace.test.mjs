import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {opById} from '../lib/v1/ops/registry.mjs';
import {validate} from '../lib/v1/ops/schema.mjs';
import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// An unreadable saved limit is replaced only when the owner asks for it. The damaged file is kept beside the new one, the audit
// records the replacement, and the held admission clears on its next read. Synthetic data only; no provider calls.
const HAIKU = 'claude-haiku-5-5';
const DAMAGED = '{"version":1,"values":{"maxJobUsd":0.25},"audit":"damaged"}';
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};

function dirWith(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'owner-replace-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// The builder records each request it is asked to build, and refuses, so nothing is admitted.
function candidateFor(t, dir) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'owner-replace-pace-'));
  const requests = [];
  const opened = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK,
    source: createSyntheticPace50Source({start: NOW}), ownerSettings: createOwnerSettings({directory: dir}),
    buildInput: async ({request}) => { requests.push(request); return {refuse: 'owner_scenarios_unknown'}; }});
  t.after(async () => {
    await opened.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {...opened, requests};
}

test('a save refuses an unreadable file unless replaceUnreadable is true, and the file is left as it was', t => {
  const dir = dirWith(t);
  const store = createOwnerSettings({directory: dir});
  store.set({by: 'owner', reason: 'first', now: NOW, maxJobUsd: 0.25});
  fs.writeFileSync(join(dir, 'owner-settings.json'), DAMAGED);
  assert.throws(() => store.set({by: 'owner', reason: 'second', now: NOW + 1, maxJobUsd: 0.5}), /unreadable_owner_settings/);
  assert.equal(fs.readFileSync(join(dir, 'owner-settings.json'), 'utf8'), DAMAGED);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('unreadable')), [], 'no copy is made for a refused save');
});

test('a replacement keeps the damaged file, audits the replacement, and reads back as set', t => {
  const dir = dirWith(t);
  const store = createOwnerSettings({directory: dir});
  store.set({by: 'owner', reason: 'first', now: NOW, maxJobUsd: 0.25});
  fs.writeFileSync(join(dir, 'owner-settings.json'), DAMAGED);
  assert.deepEqual(store.set({by: 'owner', reason: 'set again', now: NOW + 2, maxJobUsd: 0.5, replaceUnreadable: true}), {maxJobUsd: 0.5});
  assert.deepEqual(store.limit(), {state: 'set', maxJobUsd: 0.5});
  const audit = store.audit();
  assert.equal(audit.length, 1, 'the new trail starts at the replacement');
  assert.equal(audit[0].reason, 'replaced unreadable settings');
  assert.equal(audit[0].note, 'set again', 'the owner\'s reason is kept beside it');
  assert.deepEqual(audit[0].changed, {maxJobUsd: {from: null, to: 0.5}});
  assert.equal(fs.readFileSync(join(dir, audit[0].kept), 'utf8'), DAMAGED, 'the damaged file is kept byte for byte');
});

test('the held admission clears on the next read after the replacement, and the new limit is the one admitted against', {timeout: 30000}, async t => {
  const dir = dirWith(t);
  createOwnerSettings({directory: dir}).set({by: 'owner', reason: 'first', now: NOW, maxJobUsd: 0.25});
  fs.writeFileSync(join(dir, 'owner-settings.json'), DAMAGED);
  const pace = candidateFor(t, dir);
  const held = await pace.candidate.preview({jobId: 'job-1', job, provider: 'claude', model: HAIKU});
  assert.equal(held.reason, 'owner_settings_unreadable');
  assert.deepEqual(pace.requests, [], 'nothing is built while the file is unreadable');
  createOwnerSettings({directory: dir}).set({by: 'owner', reason: 'set again', now: NOW + 2, maxJobUsd: 2, replaceUnreadable: true});
  await pace.candidate.preview({jobId: 'job-1', job, provider: 'claude', model: HAIKU});
  assert.equal(pace.requests.length, 1, 'the builder runs once the limit reads again');
  assert.equal(pace.requests[0].owner_max_job_usd_micro, 2_000_000);
});

test('the save operation takes the flag, and its confirmation says what a replacement does', () => {
  const op = opById('lending.set_owner_settings');
  assert.doesNotThrow(() => validate(op.input, {maxJobUsd: 0.5, reason: 'set again', replaceUnreadable: true}));
  assert.equal(op.confirm({maxJobUsd: 0.5}), 'Save $0.5 as the most one lent job may spend.');
  assert.equal(op.confirm({maxJobUsd: 0.5, replaceUnreadable: true}),
    'Save $0.5 as the most one lent job may spend, replacing the saved file if it cannot be read.');
});

test('the held status says to save the limit again, names the operation that does it, and never suggests deleting the file', () => {
  const status = lendingStatus({admitted: false, reason: 'owner_settings_unreadable'});
  assert.equal(status.id, 'owner_settings');
  assert.match(status.line, /save the per-job limit again/);
  assert.match(status.line, /replaces the unreadable file after you confirm/);
  assert.doesNotMatch(status.line, /delet|remov/i);
  assert.deepEqual(status.recovery, {who: 'owner', action: 'save the per-job limit again', op: 'lending.set_owner_settings',
    input: {replaceUnreadable: true}});
});

test('over the API, a save is refused for an unreadable file and replaces it only with replaceUnreadable', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  const file = join(await f.home('lender'), 'v1', 'owner-settings', 'owner-settings.json');
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {maxJobUsd: 0.25, reason: 'first'}});
  fs.writeFileSync(file, DAMAGED);
  const refused = await api(lender.app, '/api/lending/owner-settings', {method: 'POST', status: 409,
    body: {maxJobUsd: 0.5, reason: 'set again'}});
  assert.equal(refused.code, 'unreadable_owner_settings');
  assert.equal(fs.readFileSync(file, 'utf8'), DAMAGED, 'the refused save changes nothing');
  const replaced = await api(lender.app, '/api/lending/owner-settings', {method: 'POST',
    body: {maxJobUsd: 0.5, reason: 'set again', replaceUnreadable: true}});
  assert.equal(replaced.values.maxJobUsd, 0.5);
  assert.equal(replaced.audit[0].reason, 'replaced unreadable settings');
  const read = await api(lender.app, '/api/lending/owner-settings');
  assert.equal(read.values.maxJobUsd, 0.5, 'the saved limit reads back after the replacement');
});

test('saving $2 returns the supported models and Sonnet minimum through the shared operation', async t => {
  const f = await appFixture(t), lender = await f.start('lender');
  const result = await api(lender.app, '/api/lending/owner-settings', {method:'POST',body:{maxJobUsd:2,reason:'Haiku jobs only'}});
  assert.equal(result.values.maxJobUsd,2);
  assert.equal(result.modelLimitSummary,'At $2.00 Claude Haiku 4.5, Claude Haiku 5.5 jobs fit. Claude Sonnet 5.5 jobs need at least $5.29.');
  for (const id of ['lending.owner_settings','lending.set_owner_settings']) {
    assert.ok(opById(id).output.properties.modelLimitSummary);
  }
});
