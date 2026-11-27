// Temporary directories for suites. Every directory made here is removed:
//  - at process exit (normal exit, failed assertion, uncaught error), and
//  - on SIGINT/SIGTERM: the handler removes them, then re-sends the signal so the process still terminates.
// `ownTempDir(t, prefix)` also registers removal with node:test, so it runs at the end of the test as well.
// The profile lock leaves two entries beside a home directory (`<home>.profile-write.lock` and `<home>.profile-write.lock.owners-v1`),
// so those exact paths go too. Nothing here can run after SIGKILL or a host crash; scripts/run-tests.mjs removes each file's
// scratch directory for those cases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileWriterLockPath } from '../../lib/v1/lock.mjs';

const owned = new Set();
let signalsArmed = false;

// Remove exactly the paths this helper can name: the directory, and the two lock entries the profile lock derives from it.
// Nothing is matched by prefix, so an unrelated entry that shares the prefix is never touched.
function removeOwned(dir) {
  rmSync(dir, { recursive: true, force: true });
  let lock = null;
  try { lock = profileWriterLockPath(dir); } catch { /* an unreadable path has no lock entries to name */ }
  if (lock) for (const entry of [lock, lock + '.owners-v1']) rmSync(entry, { recursive: true, force: true });
}

function drain() {
  for (const dir of owned) removeOwned(dir);
  owned.clear();
}

function armSignals() {
  if (signalsArmed) return;
  signalsArmed = true;
  process.on('exit', drain);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      drain();
      // Keep the signal's default effect: remove this listener, then send the signal again.
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/** A new directory under TMPDIR (or the default temp dir), removed at process exit or on SIGINT/SIGTERM. */
export function tempDir(prefix) {
  armSignals();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.add(dir);
  return dir;
}

/** As tempDir, and removed when the node:test `t` finishes, whatever the outcome. */
export function ownTempDir(t, prefix) {
  const dir = tempDir(prefix);
  t.after(() => { removeOwned(dir); owned.delete(dir); });
  return dir;
}
