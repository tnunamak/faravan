// A join check's own answer ("approved") is authoritative for that enrollment. It is applied at once, so the
// circle stops saying "Waiting for … to approve" while the slower shell reads run, and an older circles read
// that started before the approval cannot bring the pending text back. Only pending -> approved is applied:
// a later rejection, expiry or a new enrollment always shows as the server reports it.
export function joinReceipt(path, result, circles = []) {
  const match = /^circles\/([^/?]+)\/check$/.exec(path);
  if (!match || result?.state !== 'approved') return null;
  const id = decodeURIComponent(match[1]);
  const circle = (Array.isArray(circles) ? circles : []).find(c => c.id === id);
  return {circle: id, enrollment: circle?.enrollment?.enrollment_id ?? null};
}
export function applyJoinReceipts(circles, receipts = {}) {
  if (!Array.isArray(circles)) return circles;
  let changed = false;
  const next = circles.map(c => {
    const receipt = receipts[c.id];
    if (!receipt || c.enrollment?.state !== 'pending' || (receipt.enrollment !== null && receipt.enrollment !== c.enrollment.enrollment_id)) return c;
    changed = true;
    return {...c, enrollment: {...c.enrollment, state: 'approved'}};
  });
  return changed ? next : circles;
}
