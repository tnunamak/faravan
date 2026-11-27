// Imported first by no-browser.mjs, so it runs before any test module loads.
// The lending importer reads ~/.claude and ~/.codex by default and runs at startup
// and on a timer, so a test must never see the account's real home. Each test
// process gets an empty synthetic HOME and removes it on exit. Children inherit
// HOME and FARAVAN_TEST_HOME, so they share the parent's directory.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeFixtureHome, removeFixtureHome, trustedInheritedHome, trustedShortBase } from './test-home-directory.mjs';
export { initializeFixtureHome } from './test-home-directory.mjs';

const inheritedBase = process.env.FARAVAN_SBX_SHORT_HOME_BASE;
const shortBase = trustedShortBase(inheritedBase) ? inheritedBase : null;
if (!shortBase) delete process.env.FARAVAN_SBX_SHORT_HOME_BASE;
if (!trustedInheritedHome(process.env.FARAVAN_TEST_HOME)) delete process.env.FARAVAN_TEST_HOME;

if (!process.env.FARAVAN_TEST_HOME) {
  // sbx puts its socket under HOME/.wfsbx and needs HOME to be at most 22 characters
  // (selectSbxHome in lib/docker-backend.mjs); a long TMPDIR would fail every sbx check.
  const base = join(tmpdir(), 'fh-XXXXXX').length <= 22 ? tmpdir() : '/tmp';
  const home = mkdtempSync(shortBase ? join(shortBase, 'h') : join(base, 'fh-'));
  // Playwright finds its browsers under the real HOME. Its workers inherit the
  // synthetic HOME below, so pin the real cache first (Playwright's own defaults).
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.HOME) {
    const real = process.env.HOME;
    process.env.PLAYWRIGHT_BROWSERS_PATH = process.platform === 'darwin' ? join(real, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(real, 'AppData', 'Local'), 'ms-playwright')
      : join(process.env.XDG_CACHE_HOME ?? join(real, '.cache'), 'ms-playwright');
  }
  // Several tests build fixtures under homedir()/.tmp without creating it.
  initializeFixtureHome(home);
  process.env.FARAVAN_TEST_HOME = home;
  process.env.HOME = home;
  process.on('exit', () => removeFixtureHome(home));
}

// An sbx home override exported in the shell would point a test's sandbox daemon outside the test root. Tests that need
// one set it themselves. A child of a test process also takes the parent's home, whatever HOME it was started with.
delete process.env.FARAVAN_SBX_HOME;
delete process.env.FARAVAN_SBX_HOME;
process.env.HOME = process.env.FARAVAN_TEST_HOME;

// The fallback for a long profile belongs to the test too. A runner-owned base also outlives nested fixture homes.
if (!shortBase) {
  const home = process.env.FARAVAN_TEST_HOME;
  if (trustedShortBase(home)) process.env.FARAVAN_SBX_SHORT_HOME_BASE = home;
  else {
    const base = mkdtempSync('/tmp/fh-');
    initializeFixtureHome(base);
    process.env.FARAVAN_SBX_SHORT_HOME_BASE = base;
    process.on('exit', () => removeFixtureHome(base));
  }
}

// No test may start a real sbx daemon service or wait on a real daemon: the gate in lib/docker-backend.mjs stands down on
// this. Children inherit it. The tests of the gate itself delete it.
process.env.FARAVAN_SBX_DAEMON_GATE ??= 'off';
