import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';

// The deleted volume limits are migrated from their exact old shape only. Any other content is left byte for byte and reads as
// unreadable, so the $4 default never applies to a file this build cannot trust. Synthetic files only; no provider calls.
const NOW = 1793000000000;
const AUDIT = [{at: NOW - 1, by: 'owner', reason: 'earlier cap', changed: {maxJobUsd: {from: null, to: 1.5}}}];

function fixture(t, contents) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'owner-legacy-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(join(dir, 'owner-settings.json'), contents);
  return dir;
}

const NOT_MIGRATED = [
  ['an unknown key beside the deleted volume limit', {version: 1, values: {weeklyOverrunPoints: 5, bad: 2}, audit: []}],
  ['an unknown key beside the cap and both deleted limits', {version: 1,
    values: {maxJobUsd: 1.5, weeklyOverrunPoints: 0.2, shortOverrunPoints: 0.1, bad: 2}, audit: AUDIT}],
  ['a deleted limit outside its range', {version: 1, values: {weeklyOverrunPoints: 2}, audit: []}],
  ['a deleted limit that is not a number', {version: 1, values: {shortOverrunPoints: 'x'}, audit: []}],
  ['a cap that is not a positive number', {version: 1, values: {maxJobUsd: -1, weeklyOverrunPoints: 0.2}, audit: []}],
  ['a top-level key this build does not know', {version: 1, values: {weeklyOverrunPoints: 0.2}, audit: [], bad: true}],
  ['an audit entry that is not a change record', {version: 1, values: {weeklyOverrunPoints: 0.2}, audit: ['x']}],
];

for (const [name, value] of NOT_MIGRATED) {
  test(`a legacy file with ${name} is not migrated: it reads as unreadable, and its bytes stay as they were`, t => {
    const before = Buffer.from(JSON.stringify(value), 'utf8');
    const dir = fixture(t, before);
    assert.deepEqual(createOwnerSettings({directory: dir}).limit(), {state: 'unreadable', maxJobUsd: null});
    const after = fs.readFileSync(join(dir, 'owner-settings.json'));
    assert.ok(after.equals(before), 'the original bytes are unchanged');
    assert.deepEqual(fs.readdirSync(dir), ['owner-settings.json'], 'nothing else is written');
  });
}

test('the exact old shape migrates: the deleted limits go, the cap and the audit stay, and the new trail records the migration', t => {
  const dir = fixture(t, JSON.stringify({version: 1, values: {maxJobUsd: 1.5, weeklyOverrunPoints: 0.2, shortOverrunPoints: null},
    audit: AUDIT}));
  const store = createOwnerSettings({directory: dir, now: () => NOW});
  assert.deepEqual(store.limit(), {state: 'set', maxJobUsd: 1.5});
  const onDisk = JSON.parse(fs.readFileSync(join(dir, 'owner-settings.json'), 'utf8'));
  assert.deepEqual(onDisk.values, {maxJobUsd: 1.5}, 'only the cap is kept as a value');
  assert.equal(onDisk.audit.length, AUDIT.length + 1, 'the earlier audit is kept and the migration is appended');
  assert.equal(onDisk.audit.at(-1).by, 'faravan-migration');
  assert.deepEqual(onDisk.audit.at(-1).changed, {weeklyOverrunPoints: {from: 0.2, to: null}, shortOverrunPoints: {from: null, to: null}});
});
