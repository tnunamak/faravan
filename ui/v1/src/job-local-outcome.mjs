// What a job page knows from the person's own action before the next read confirms it: a delete they just
// confirmed, a branch they just added. Kept in memory per api object, so nothing outlives the page or crosses to another sign-in.
const deletedJobs = new WeakMap();
export const markJobDeleted = (api, digest) => { if (!deletedJobs.has(api)) deletedJobs.set(api, new Set()); deletedJobs.get(api).add(digest); };
export const isJobDeleted = (api, digest) => deletedJobs.get(api)?.has(digest) === true;

// The apply response is the page's proof the branch exists: keep what it says, including the commit and time.
export function appliedFrom(out) {
  if (!out || typeof out.branch !== 'string' || !out.branch || !out.repo) return null;
  const extra = Object.fromEntries(['commit', 'head', 'at', 'applied_at'].filter(key => out[key] !== undefined).map(key => [key, out[key]]));
  return {branch: out.branch, repo: out.repo, ...extra};
}
