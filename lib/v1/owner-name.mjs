// The person's name for invitations ("Tessa invited you to Weekend projects").
// Default: the OS account's full name (GECOS on Linux, `id -F` on macOS); the host name only if there is none.
import os from 'node:os';
import {execFileSync} from 'node:child_process';

const quiet = {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000};

// Successful nonempty lookups are memoized per runner, platform and user. A transient failure or an empty
// answer is retried; a test's own runner never sees another runner's answer.
const memo = new WeakMap();
export function osFullName({platform = process.platform, userInfo = os.userInfo, run = execFileSync} = {}) {
  let user;
  try { user = userInfo().username; } catch { return ''; }
  const key = platform + '\0' + user;
  if (!memo.has(run)) memo.set(run, new Map());
  const names = memo.get(run);
  if (names.has(key)) return names.get(key);
  let name = '';
  try {
    if (platform === 'darwin') name = run('id', ['-F', user], quiet).trim();
    else if (platform === 'linux') name = (run('getent', ['passwd', user], quiet).split('\n')[0].split(':')[4] ?? '').split(',')[0].trim();
  } catch { /* no directory entry: fall through */ }
  if (name) names.set(key, name);
  return name;
}

export function defaultOwnerName(options = {}) {
  return osFullName(options) || (options.hostname ?? os.hostname)();
}
