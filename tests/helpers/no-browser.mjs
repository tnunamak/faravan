// Import this first in every tests/*.test.mjs (no-browser-guard.test.mjs
// enforces it). It first points HOME at an empty synthetic directory (see
// home-isolation.mjs), then makes the suite unable to open a real browser tab:
// - FARAVAN_NO_BROWSER=1 makes openUrl skip the launch;
// - BROWSER=true covers CLIs that honor $BROWSER (sbx login, gh, npm);
// - a no-op shim for xdg-open/open/gio/... is put first on PATH, so even a
//   child that bypasses both still cannot reach a real browser.
// Every shim call is recorded; if any test tried to open a browser, the test
// process fails on exit, so a regression is caught instead of silently stubbed.
import './home-isolation.mjs';
import './deadline-process-isolation.mjs';
import {seedSandboxOwner} from './sandbox-owner.mjs';
seedSandboxOwner();
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isolateTestGitEnv } from './git-env.mjs';
import { join, delimiter } from 'node:path';

// Every test imports this prelude, so Git and all children inherit only synthetic identity/config.
isolateTestGitEnv(process.env);

export const BROWSER_COMMANDS = ['xdg-open', 'open', 'gio', 'sensible-browser', 'x-www-browser', 'www-browser', 'firefox', 'google-chrome', 'chromium', 'chromium-browser'];

export function installBrowserShims(directory, logPath) {
  for (const name of BROWSER_COMMANDS) {
    writeFileSync(join(directory, name), `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> '${logPath}'\nexit 0\n`, { mode: 0o755 });
  }
}

if (!process.env.FARAVAN_TEST_BROWSER_SHIM_DIR) {
  const directory = mkdtempSync(join(tmpdir(), 'wf-fed-no-browser-'));
  const logPath = join(directory, 'attempts.log');
  installBrowserShims(directory, logPath);
  process.env.FARAVAN_TEST_BROWSER_SHIM_DIR = directory;
  process.env.FARAVAN_TEST_BROWSER_LOG = logPath;
  process.env.PATH = `${directory}${delimiter}${process.env.PATH || ''}`;
  process.on('exit', () => {
    const attempts = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '';
    rmSync(directory, { recursive: true, force: true });
    if (attempts) {
      process.stderr.write(`\nA test tried to open a browser (blocked by the test shim):\n${attempts}\n`);
      process.exitCode = 1;
    }
  });
}
process.env.FARAVAN_NO_BROWSER = '1';
process.env.FARAVAN_NO_BROWSER = '1';
process.env.BROWSER = 'true';
