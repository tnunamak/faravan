import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/faravan', import.meta.url));

test('faravan --readiness starts the app core in a throwaway home and writes nothing under the real one', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spk-ready-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const env = {...process.env, HOME: home, FARAVAN_HOME: join(home, '.faravan')};
  const {stdout} = await run(process.execPath, [cli, '--readiness'], {env, timeout: 60000});
  assert.match(stdout, /Faravan is ready/);
  assert.deepEqual(await readdir(home), [], 'the check uses its own temporary home, never this one');
});
