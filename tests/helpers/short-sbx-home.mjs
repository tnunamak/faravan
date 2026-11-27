// For a test whose own temp folder names make the derived sandbox home longer than the socket limit. Without an explicit
// sandbox home, lib/docker-backend.mjs would make a short folder under the real account (~/.fsbx) for it. This gives the
// process a short sandbox home of its own through the normal override, and removes it on exit.
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {removeFixtureHome, trustedShortBase} from './test-home-directory.mjs';

if (!process.env.FARAVAN_SBX_HOME && !process.env.FARAVAN_SBX_HOME) {
  const base = process.env.FARAVAN_SBX_SHORT_HOME_BASE;
  const home = mkdtempSync(trustedShortBase(base) ? join(base, 's') : '/tmp/sx-');
  process.env.FARAVAN_SBX_HOME = home;
  process.on('exit', () => removeFixtureHome(home));
}
