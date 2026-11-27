import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { importOwnerLendingHistory } from '../lib/v1/lending-history-import.mjs';
import { socketPathLengthCheck } from '../lib/docker-backend.mjs';

// userInfo() reads the account database, not HOME, so it still names the real home.
const accountHome = userInfo().homedir;

test('test processes see a synthetic HOME, not the account home', () => {
  assert.notEqual(homedir(), accountHome);
  assert.equal(homedir(), process.env.HOME);
});

test('the synthetic HOME is short enough for the default sbx socket path', () => {
  assert.ok(socketPathLengthCheck(join(homedir(), '.wfsbx')).ok, homedir());
});

test('the default lending-history import reads session logs from the synthetic home', async () => {
  assert.notEqual(homedir(), accountHome, 'a regression here would read the real ~/.claude and ~/.codex logs');
  const homeDir = mkdtempSync(join(tmpdir(), 'home-isolation-'));
  try {
    let seen;
    await importOwnerLendingHistory({consent: true, homeDir, historyAdapter: async args => {
      seen = args;
      return {meterPeriods: [], existingScores: [], writeImportedScores() {}};
    }});
    assert.equal(seen.sessionHomeDir, homedir());
  } finally {
    rmSync(homeDir, {recursive: true, force: true});
  }
});

// Each case runs the helper in a child with an sbx home override exported, as a developer's shell might.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('./helpers/home-isolation.mjs', import.meta.url));
const probe = `await import(${JSON.stringify(helper)});console.log(JSON.stringify({home:process.env.HOME,test:process.env.FARAVAN_TEST_HOME,faravan:process.env.FARAVAN_SBX_HOME??null,faravan:process.env.FARAVAN_SBX_HOME??null}));`;
const run = env => {
  const clean = {...process.env}; delete clean.FARAVAN_TEST_HOME;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {env: {...clean, ...env}, encoding: 'utf8'});
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').pop());
};
for (const name of ['FARAVAN_SBX_HOME', 'FARAVAN_SBX_HOME']) {
  test(`a fresh test home clears an exported ${name}, and nothing points outside it`, () => {
    const outside = mkdtempSync(join(tmpdir(), 'sbx-outside-'));
    try {
      const seen = run({[name]: outside});
      assert.equal(seen.faravan, null);
      assert.equal(seen.faravan, null);
      assert.equal(seen.home, seen.test, 'HOME is the test home');
      assert.notEqual(seen.home, accountHome);
      assert.ok(!seen.home.startsWith(outside) && !outside.startsWith(seen.home));
    } finally { rmSync(outside, {recursive: true, force: true}); }
  });
  test(`a parent-owned test home wins over HOME and an exported ${name}`, () => {
    const parent = mkdtempSync(join(tmpdir(), 'parent-home-')), outside = mkdtempSync(join(tmpdir(), 'sbx-outside-'));
    try {
      writeFileSync(join(parent, '.faravan-test-home'), 'test fixture');
      const seen = run({FARAVAN_TEST_HOME: parent, HOME: outside, [name]: outside});
      assert.equal(seen.home, parent);
      assert.equal(seen.test, parent);
      assert.equal(seen.faravan, null);
      assert.equal(seen.faravan, null);
      assert.ok(existsSync(parent), 'the child does not remove a home it does not own');
    } finally { rmSync(parent, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); }
  });
}

// An inherited FARAVAN_TEST_HOME is trusted only inside the OS temp directory or ~/.tmp, and never when it is the
// account home or one of its ancestors. These cases never write to a real home: the stand-ins are throwaway directories
// that carry a marker file, and the real home is only named, never opened for writing.
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const refused = (dir, label) => {
  const seen = run({FARAVAN_TEST_HOME: dir});
  assert.notEqual(seen.test, dir, `${label}: the inherited home is not trusted`);
  assert.notEqual(seen.home, dir);
  assert.equal(seen.home, seen.test, 'a fresh isolated home is used');
  assert.notEqual(seen.home, accountHome);
  return seen;
};
test('an inherited test home outside the temp directory and ~/.tmp is refused and left untouched', t => {
  if (!existsSync('/var/tmp')) return t.skip('no directory outside the temp root on this system');
  const standIn = mkdtempSync('/var/tmp/home-standin-');
  try {
    writeFileSync(join(standIn, 'MARKER'), 'real-home stand-in');
    refused(standIn, 'outside the temp root');
    assert.deepEqual(readdirSync(standIn), ['MARKER'], 'nothing was created in the stand-in');
  } finally { rmSync(standIn, {recursive: true, force: true}); }
});
test('the account home, its parent, and a temp symlink to the account home are refused', () => {
  refused(accountHome, 'the account home');
  refused(dirname(accountHome), 'an ancestor of the account home');
  const link = join(mkdtempSync(join(tmpdir(), 'home-link-')), 'home');
  try {
    symlinkSync(accountHome, link);
    refused(link, 'a symlink into the account home');
  } finally { rmSync(dirname(link), {recursive: true, force: true}); }
});
test('a missing or non-directory inherited home is refused; a directory inside the temp root is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parent-home-'));
  try {
    refused(join(dir, 'missing'), 'a missing path');
    writeFileSync(join(dir, 'file'), 'x');
    refused(join(dir, 'file'), 'a regular file');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.faravan-test-home'), 'test fixture');
    assert.equal(run({FARAVAN_TEST_HOME: join(dir, 'sub')}).test, join(dir, 'sub'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('an unmarked inherited temp directory is refused without modifying it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmarked-home-'));
  try {
    refused(dir, 'an unmarked temp directory');
    assert.deepEqual(readdirSync(dir), [], 'the child leaves the unmarked directory untouched');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a marked inherited temp directory is reused and retained', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marked-home-'));
  try {
    writeFileSync(join(dir, '.faravan-test-home'), 'test fixture');
    const seen = run({FARAVAN_TEST_HOME: dir});
    assert.equal(seen.home, dir);
    assert.equal(seen.test, dir);
    assert.ok(existsSync(dir), 'the child does not remove the parent home');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a temp symlink to a marked home is refused, and so is a marker that is not a regular file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-kinds-'));
  try {
    const marked = join(dir, 'marked');
    mkdirSync(marked);
    writeFileSync(join(marked, '.faravan-test-home'), 'test fixture');
    symlinkSync(marked, join(dir, 'link'));
    refused(join(dir, 'link'), 'a symlink to a marked temp directory');
    const dirMarker = join(dir, 'dir-marker');
    mkdirSync(join(dirMarker, '.faravan-test-home'), {recursive: true});
    refused(dirMarker, 'a directory standing in for the marker');
    const linkMarker = join(dir, 'link-marker');
    mkdirSync(linkMarker);
    symlinkSync(join(marked, '.faravan-test-home'), join(linkMarker, '.faravan-test-home'));
    refused(linkMarker, 'a symlink standing in for the marker');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('two fresh app processes keep their own homes despite the parent test home', {skip:process.platform!=='linux'}, async t => {
  const {twoFreshInstalls} = await import('./helpers/v1-app-fixture.mjs');
  const root = mkdtempSync(join(tmpdir(), 'paired-app-homes-'));
  let actors, preserveRoot = false;
  t.after(async () => {
    await actors?.stop();
    if (!preserveRoot) rmSync(root, {recursive:true, force:true});
  });
  const parentHome = process.env.FARAVAN_TEST_HOME;
  assert.equal(process.env.HOME,parentHome);
  try { actors=await twoFreshInstalls({root,hostHome:parentHome}); }
  catch (error) { preserveRoot=error.preserveFixtureRoot===true; throw error; }
  assert.equal(process.env.HOME,parentHome,'the parent keeps its own test home');
  for(const [name, actor] of [['host',actors.host],['friend',actors.friend]]) {
    assert.equal(actor.reportedPaths.HOME,join(root,name,'home'));
    assert.notEqual(actor.reportedPaths.HOME,parentHome);
  }
  assert.notEqual(actors.host.reportedPaths.HOME,actors.friend.reportedPaths.HOME);
});
