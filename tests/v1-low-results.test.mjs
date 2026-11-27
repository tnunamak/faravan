import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, utimes, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { pruneResults, resultsDirectory, RESULT_KEEP } from '../lib/v1/cli.mjs';

test('L2: open-folder refuses any destination outside the app results folder', {timeout: 20000}, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const path = '/api/jobs/sha256:' + 'a'.repeat(64) + '/open-folder';
  const outside = join(await mkdtemp(join(tmpdir(), 'faravan-low-out-')), 'x');
  t.after(() => rm(join(outside, '..'), {recursive: true, force: true}));
  for (const out of [outside, '/etc/faravan-x', '../escape', 'a/../../escape', '', 5, 'x\0y'])
    await api(owner.app, path, {method: 'POST', status: 400, body: {circle: circle.id, out}});
  await assert.rejects(access(outside));
});

test('L2: pruneResults drops old extractions and keeps only the newest few', async t => {
  const home = await mkdtemp(join(tmpdir(), 'faravan-low-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const dir = resultsDirectory(home), now = Date.now();
  await mkdir(dir, {recursive: true});
  const make = async (name, ageMs) => {
    await mkdir(join(dir, name)); const d = new Date(now - ageMs); await utimes(join(dir, name), d, d);
  };
  await make('ancient', 30 * 24 * 3600 * 1000);
  for (let i = 0; i < RESULT_KEEP + 5; i++) await make('r' + String(i).padStart(2, '0'), (i + 1) * 60 * 1000);
  await pruneResults(dir, {now});
  const left = await readdir(dir);
  assert.equal(left.length, RESULT_KEEP);
  assert.ok(!left.includes('ancient'));
  assert.ok(left.includes('r00') && !left.includes('r' + String(RESULT_KEEP + 4).padStart(2, '0')));
  await pruneResults(join(home, 'missing'), {now});
});
