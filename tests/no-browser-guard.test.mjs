import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openUrl } from '../lib/v1/open-url.mjs';
import { installBrowserShims } from './helpers/no-browser.mjs';

const execFileAsync = promisify(execFile);
const TESTS = dirname(fileURLToPath(import.meta.url));

test('every Node test file imports the no-browser guard first', async () => {
  const files = (await readdir(TESTS)).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.length > 10);
  for (const name of files) {
    const firstLine = (await readFile(join(TESTS, name), 'utf8')).split('\n', 1)[0];
    assert.equal(firstLine, "import './helpers/no-browser.mjs';", `${name} must import ./helpers/no-browser.mjs on its first line`);
  }
});

test('the guard disables browser launch for this process and its children', () => {
  assert.equal(process.env.FARAVAN_NO_BROWSER, '1');
  assert.equal(process.env.BROWSER, 'true');
  const calls = [];
  openUrl('http://127.0.0.1:9/', {spawn: (...args) => calls.push(args)});
  assert.deepEqual(calls, []);
});

test('a child process that calls xdg-open reaches the recording shim, not a real browser', async () => {
  // Use a private shim dir and log so this deliberate call does not trip the
  // suite-wide exit check.
  const directory = await mkdtemp(join(tmpdir(), 'wf-fed-no-browser-probe-'));
  const logPath = join(directory, 'probe.log');
  try {
    installBrowserShims(directory, logPath);
    await execFileAsync('xdg-open', ['http://127.0.0.1:9/?token=probe'], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
    assert.match(await readFile(logPath, 'utf8'), /^xdg-open http:\/\/127\.0\.0\.1:9\/\?token=probe$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
