import {membershipProjectionOf} from './membership-projection.mjs';

// Whether this computer can send a job. Borrowing needs one joined circle and nothing else: Docker Sandboxes, an agent
// sign-in and the lending switch belong to lending, and each job is checked for isolation on the lender's computer.
// One function feeds the operation (HTTP, CLI, MCP) and the app, so no surface can answer differently.
const WAITING = {pending:'Waiting to be let in to the circle.', unknown:'This computer’s membership is not confirmed yet.',
  expired:'The invitation expired. Ask the person who invited you for a new one.',
  rejected:'This computer was not added to the circle. Ask the person who invited you for a new invitation.'};

export function borrowingReadiness({circles = []} = {}) {
  const rows = (Array.isArray(circles) ? circles : []).map(circle => {
    const phase = membershipProjectionOf(circle).phase;
    return {id: circle.id, name: circle.name ?? null, ready: Boolean(circle.origin) && phase === 'approved', phase};
  });
  const canBorrow = rows.some(row => row.ready);
  // A local placeholder with no host and no membership evidence was never joined, so it is not a circle to check.
  const joined = rows.filter((row, i) => circles[i]?.origin || row.phase !== 'unknown');
  const blockers = [];
  if (!canBorrow && !joined.length)
    blockers.push({kind: 'no_circle', message: 'Join a circle with an invitation, or start one.', fix: {op: 'circles.join', input: {}}});
  if (!canBorrow) for (const row of joined) {
    const waiting = row.phase !== 'approved';
    blockers.push({kind: waiting ? 'membership_' + row.phase : 'circle_not_connected', circle: row.id,
      message: waiting ? WAITING[row.phase] : 'This circle has no host address, so jobs cannot be sent to it.',
      fix: waiting && ['pending', 'unknown'].includes(row.phase) ? {op: 'circles.check', input: {circle: row.id}} : null});
  }
  return {can_borrow: canBorrow, blockers, circles: rows,
    next_steps: blockers.map(b => b.kind + (b.circle ? ' (' + b.circle + ')' : '') + ': ' + (b.fix?.op ? 'run ' + b.fix.op + '. ' : '') + b.message)};
}
