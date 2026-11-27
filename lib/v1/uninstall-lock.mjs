// One cross-process lock for an uninstall of one data folder. Uninstall holds
// it from before the circles step until the data is removed. A sandbox create
// dispatch and a sandbox service restart refuse while anyone holds it, so no
// new sandbox or daemon appears after uninstall checked that none runs.
//
// The lock lives beside the data folder, not in it: uninstall removes that
// folder while it still holds the lock.
import path from 'node:path';
import {acquireProcessLockSync, processLockOwners} from './lock.mjs';

export function uninstallLockPath(home) {
  return path.resolve(home) + '.uninstall.lock';
}

/** Returns the release function; throws `lock_busy` while another uninstall holds it. */
export function acquireUninstallLock(home) {
  return acquireProcessLockSync(uninstallLockPath(home));
}

/** True while any process holds or is taking the lock. A lock that cannot be read counts as held. */
export function uninstallInProgress(home) {
  try { return processLockOwners(uninstallLockPath(home)).length > 0; }
  catch { return true; }
}
