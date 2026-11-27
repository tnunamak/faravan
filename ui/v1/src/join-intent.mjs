// "Join with an invitation" on Home lands on Circles with the join form already open. The intent is used once and expires.
let markedAt = null;
export const markJoinIntent = (now = Date.now()) => { markedAt = now; };
export function takeJoinIntent(now = Date.now()) {
  const fresh = markedAt !== null && now - markedAt < 30000;
  markedAt = null;
  return fresh;
}
