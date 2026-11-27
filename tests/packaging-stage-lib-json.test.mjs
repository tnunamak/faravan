import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));

async function modules(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await modules(path));
    else if (/\.(mjs|cjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('the staged app contains every JSON file that a lib module imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-stage-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Staging ends with an offline npm install of production dependencies; this test checks Faravan's own files only.
  const fakeBin = join(root, 'bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n');
  await chmod(join(fakeBin, 'npm'), 0o755);
  const dest = join(root, 'stage');
  await run('bash', [join(repo, 'packaging/stage-app.sh'), dest, '0.0.0-test'],
    { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FARAVAN_REFRESH_PRICES: '0' } });

  const imports = [];
  for (const file of await modules(join(repo, 'lib'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+\.json)['"]/g)) {
      imports.push(relative(repo, resolve(dirname(file), match[1])));
    }
  }
  assert.ok(imports.includes('lib/v1/telemetry/public-models.json'), 'the scan finds the public model list import');
  const missing = [];
  for (const path of imports) {
    try { await access(join(dest, path)); } catch { missing.push(path); }
  }
  assert.deepEqual(missing, []);
});
