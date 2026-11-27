import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configHome } from '../lib/local-state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('stable home selection agrees between JavaScript and the Go tray', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'faravan-home-parity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  // The suite may put TMPDIR on a noexec filesystem such as /dev/shm.
  const binaryDir = fs.mkdtempSync(path.join(root, 'tray', '.home-parity-'));
  t.after(() => fs.rmSync(binaryDir, { recursive: true, force: true }));
  const binary = path.join(binaryDir, process.platform === 'win32' ? 'probe.exe' : 'probe');
  const build = spawnSync('go', ['test', '-c', '-o', binary, './internal/faravantray'], {
    cwd: path.join(root, 'tray'), encoding: 'utf8', env: process.env,
  });
  assert.equal(build.status, 0, `Go probe build failed: ${build.error || build.stderr || build.stdout}`);

  const variables = ['HOME', 'USERPROFILE', 'FARAVAN_HOME', 'FARAVAN_HOME', 'FARAVAN_DATA_HOME', 'XDG_DATA_HOME'];
  const saved = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of variables) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const state = (home, candidate, circles) => {
    const dir = path.join(home, candidate, 'v1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, circles }));
  };
  const destination = process.platform === 'darwin' ? 'Library/Application Support/Faravan' : process.platform === 'win32' ? 'AppData/Local/Faravan' : '.local/share/Faravan';
  const cases = [
    ['fresh home', () => {}, destination],
    ['moved profile', home => state(home, '.spare' + 'kin', ['circle']), destination],
    ['existing new profile', home => state(home, destination, ['circle']), destination],
    ['explicit home', () => {}, 'override', {FARAVAN_HOME:'override'}],
    ['explicit home wins over data home', () => {}, 'override', {FARAVAN_HOME:'override', FARAVAN_DATA_HOME:'absolute'}],
    ['explicit data home', () => {}, 'data', {FARAVAN_DATA_HOME:'absolute'}],
    ['invalid data home', () => {}, null, {FARAVAN_DATA_HOME:'relative'}],
  ];
  for (const [name, setup, expected, overrides = {}] of cases) {
    await t.test(name, t => {
      if (process.platform === 'win32' && (name === 'working ancestor link' || name === 'dangling ancestor')) {
        t.skip('creating directory symlinks may require Windows privileges');
        return;
      }
      const home = fs.mkdtempSync(path.join(temp, 'home-'));
      setup(home);
      if (name === 'unreadable state') {
        const file = path.join(home, '.faravan/v1/state.json');
        t.after(() => fs.chmodSync(file, 0o600));
        try { fs.readFileSync(file); t.skip('current user can read mode-000 files'); return; }
        catch (error) { if (error.code !== 'EACCES') throw error; }
      }
      for (const key of variables) delete process.env[key];
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      Object.assign(process.env, overrides);
      if (overrides.FARAVAN_DATA_HOME === 'absolute') process.env.FARAVAN_DATA_HOME = path.join(home, 'data');
      let js;
      try { js = { home: configHome(), error: false }; }
      catch { js = { home: '', error: true }; }
      const output = path.join(home, 'result.json');
      const go = spawnSync(binary, ['-test.run=^TestHomePathParityProbe$'], {
        encoding: 'utf8', env: { ...process.env, FARAVAN_HOME_PARITY_OUTPUT: output },
      });
      assert.equal(go.status, 0, `Go probe failed: ${go.error || go.stderr || go.stdout}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), js);
      if (expected === null) assert.equal(js.error, true);
      else if (overrides.FARAVAN_HOME || overrides.FARAVAN_HOME) assert.equal(js.home, expected);
      else assert.equal(js.home, path.join(home, expected));
    });
  }
});
