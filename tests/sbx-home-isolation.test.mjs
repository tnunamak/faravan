import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {selectSbxHome,containerdSocketPathForSbxHome} from '../lib/docker-backend.mjs';

const LIMIT = 104;
const clean = () => { delete process.env.FARAVAN_SBX_HOME; delete process.env.FARAVAN_SBX_HOME; };
const withEnv = (values, run) => {
  const saved = Object.fromEntries(['HOME', 'FARAVAN_SBX_HOME', 'FARAVAN_SBX_HOME'].map(key => [key, process.env[key]]));
  try { clean(); Object.assign(process.env, values); return run(); }
  finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
};

// A long app data folder moves the sandbox home to a short folder named by a hash. The caller may name the account home
// that folder lives under, so a test never writes into the real account.
test('a caller-supplied account home receives the short sandbox home', () => {
  const temp = mkdtempSync('/tmp/h-');
  try {
    const dataHome = path.join(temp, 'a'.repeat(60), 'data');
    const {home} = withEnv({HOME: temp}, () => selectSbxHome({dataHome, userHome: temp}));
    assert.ok(home.startsWith(path.join(temp, '.fsbx') + path.sep), `got ${home}`);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

// The Mac app runs with HOME set to its long "Library/Application Support" folder. The short folder must stay under the real
// account home, which the process HOME does not name, or the containerd socket path is over the limit.
test('a long app HOME with the default account home still resolves to a short sandbox home that fits the socket limit', () => {
  const longHome = '/Users/someone/Library/Application Support/Faravan/runtime-home-with-a-long-name';
  const accountHome = os.userInfo().homedir;
  const {home} = withEnv({HOME: longHome}, () => selectSbxHome({home: longHome, dataHome: path.join(longHome, 'data'), channelEnv: {}}));
  assert.ok(home.startsWith(path.join(accountHome, '.fsbx') + path.sep), `got ${home}`);
  assert.ok(containerdSocketPathForSbxHome(home).length <= LIMIT, `socket path too long for ${home}`);
});
