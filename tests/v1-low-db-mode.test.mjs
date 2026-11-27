import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';

const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const roster = golden.objects.roster.envelope;
const keys = [...golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex'))),
  p.privateKeyFromSeed(Buffer.alloc(32, 5))];
const rootFingerprint = p.fingerprint(p.exportPublicKey(keys[2]));
const mode = async path => (await stat(path)).mode & 0o777;

test('L10: v1 store database, WAL and SHM files are owner-only, and an old 0644 file is tightened', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-low-db-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'coordinator.sqlite');
  await writeFile(path, '', {mode: 0o644}); await chmod(path, 0o644);
  const store = openV1Store({path, circle: golden.objects.job.envelope.payload.circle, origin: 'https://coordinator.example', rootFingerprint, initialRoster: roster, clock: () => Date.parse('2026-10-09T12:30:00Z') / 1000});
  try {
    for (const name of await readdir(dir)) assert.equal(await mode(join(dir, name)), 0o600, name);
  } finally { store.close(); }
});
