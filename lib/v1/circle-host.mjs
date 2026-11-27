// What this computer knows about whether a circle's host answers, for the circle list and every default destination.
// reachable is false after the last read failed like a host that is down (a stopped host on this computer fails the
// same way), true after it answered, and null when nothing has been read since the app started.
// lastReachedAt is the newest proof the host was up: a read that answered, or the roster the host signed.
export function circleHostView({observed = null, rosterIssuedAt = null} = {}) {
  const reachable = typeof observed?.reachable === 'boolean' ? observed.reachable : null;
  const last = Math.max(Number.isFinite(observed?.lastReached) ? observed.lastReached : 0, Date.parse(rosterIssuedAt ?? '') || 0);
  return {reachable, lastReachedAt: last ? new Date(last).toISOString() : null};
}

/** Known not to answer. A host not read yet is not offline. */
export const hostOffline = circle => circle?.host?.reachable === false;
