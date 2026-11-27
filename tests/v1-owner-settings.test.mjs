import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as settingsModule from '../lib/v1/owner-settings.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'owner-settings-'));
const NOW = Date.parse('2026-10-23T07:00:00Z');

test('an owner setting is saved, read back, and survives a restart, with no value until the owner sets one', () => {
  const dir = fresh();
  try {
    const store = settingsModule.createOwnerSettings({directory: dir});
    assert.equal(store.values(), null, 'unset reads as nothing, not a default');
    store.set({maxJobUsd: 0.30, by: 'owner', reason: 'owner per-job cap', now: NOW});
    assert.deepEqual(store.values(), {maxJobUsd: 0.30});
    // A new process reads the same saved values.
    assert.deepEqual(settingsModule.createOwnerSettings({directory: dir}).values(),
      {maxJobUsd: 0.30});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('every change is audited: who, when, why, and the value it replaced', () => {
  const dir = fresh();
  try {
    const store = settingsModule.createOwnerSettings({directory: dir});
    store.set({maxJobUsd: 0.30, by: 'owner', reason: 'first', now: NOW});
    store.set({maxJobUsd: 0.45, by: 'owner', reason: 'raise', now: NOW + 1000});
    const audit = store.audit();
    assert.equal(audit.length, 2);
    assert.deepEqual(audit[1], {at: NOW + 1000, by: 'owner', reason: 'raise', changed: {maxJobUsd: {from: 0.30, to: 0.45}}});
    store.set({maxJobUsd: 0.45, by: 'owner', reason: 'same cap', now: NOW + 2000});
    assert.equal(store.values().maxJobUsd, 0.45);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('only the total-spend per-job cap remains configurable', () => {
  const dir = fresh();
  try {
    const store = settingsModule.createOwnerSettings({directory: dir});
    for (const bad of [{maxJobUsd: 0}, {maxJobUsd: -1}, {maxJobUsd: Number.NaN},
      {weeklyOverrunPoints: 0.1}, {shortOverrunPoints: 0.1}]) {
      assert.throws(() => store.set({...bad, by: 'owner', reason: 'x', now: NOW}), /invalid_owner_setting/, JSON.stringify(bad));
    }
    assert.equal(store.values(), null, 'a refused change changes nothing');
    assert.equal(store.audit().length, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an unreadable settings file reads as nothing, so every dependent fact is unknown rather than defaulted', () => {
  const dir = fresh();
  try {
    writeFileSync(join(dir, 'owner-settings.json'), '{"values": {"maxJobUsd": ', 'utf8');
    assert.equal(settingsModule.createOwnerSettings({directory: dir}).values(), null);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a change without an owner or a reason is refused, so no setting is anonymous', () => {
  const dir = fresh();
  try {
    const store = settingsModule.createOwnerSettings({directory: dir});
    assert.throws(() => store.set({maxJobUsd: 0.30, now: NOW}), /invalid_owner_setting/);
    assert.throws(() => store.set({maxJobUsd: 0.30, by: 'owner', now: NOW}), /invalid_owner_setting/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
