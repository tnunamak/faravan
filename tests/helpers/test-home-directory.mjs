import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

// Go's module cache is read-only, and rmSync cannot delete entries of a read-only
// directory, so open each directory before removing the home.
function makeWritable(dir) {
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) makeWritable(path);
  }
}

// An inherited FARAVAN_TEST_HOME is trusted only when it is a directory inside the OS temp directory, /tmp or ~/.tmp,
// is not itself a symlink, is neither the account home nor an ancestor of it, and holds the marker this helper writes
// (a regular file) into each home it creates. Location alone does not prove the harness made the directory, and a child must never adopt (and its tests
// then write into) an unrelated directory. userInfo() reads the account database, not HOME, so it still
// names the real home when HOME was already redirected. Anything else gets a fresh isolated home below.
const MARKER = '.faravan-test-home';
const inside = (root, dir) => { const rel = relative(root, dir); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
function isolatedHomePath(candidate) {
  if (!candidate) return false;
  try {
    // The home itself must be a real directory, not a link: a link could be retargeted after this check and send the
    // tests' writes elsewhere. Its parents may be links (macOS keeps the temp directory under one), so resolve them.
    if (!lstatSync(candidate).isDirectory()) return false;
    const dir = realpathSync(candidate), account = realpathSync(userInfo().homedir);
    if (dir === account || inside(dir, account)) return false;
    // A long TMPDIR makes this helper create the home under /tmp (below), so a child must trust that place too.
    return inside(realpathSync(tmpdir()), dir) || inside(realpathSync('/tmp'), dir) || inside(join(account, '.tmp'), dir);
  } catch { return false; }
}
export function trustedInheritedHome(candidate) {
  if (!isolatedHomePath(candidate)) return false;
  try { return lstatSync(join(candidate, MARKER)).isFile(); }
  catch { return false; }
}

// A fresh home below the base adds eight characters (slash, h, six random characters).
// HOME must still be at most 22 characters for the default sandbox socket.
export function trustedShortBase(candidate) {
  return candidate?.length <= 14 && trustedInheritedHome(candidate);
}

// A fixture that starts independent computers owns their temporary homes and
// teardown. Mark each before launch so the child can keep its own HOME.
export function initializeFixtureHome(home) {
  if (!isolatedHomePath(home)) throw new Error('Fixture HOME must be an isolated temporary directory');
  mkdirSync(join(home, '.tmp'), {mode: 0o700});
  writeFileSync(join(home, MARKER), 'created by tests/helpers/home-isolation.mjs\n', {flag:'wx',mode:0o600});
}
export function removeFixtureHome(home) {
  if (lstatSync(home, {throwIfNoEntry: false})?.isDirectory()) makeWritable(home);
  rmSync(home, {recursive: true, force: true});
}
