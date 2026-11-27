const STATES = new Set(['approved', 'pending', 'expired', 'rejected']);
const POLICIES = new Set(['each', 'automatic', 'unknown']);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unknownMembership = () => ({
  schemaVersion: 3,
  kind: 'membership',
  phase: 'unknown',
  evidence: {enrollmentState: null, origin: null, rosterMembershipVerified: false},
  invitationPolicy: 'unknown',
});

function validated(value, {legacy = false} = {}) {
  if (!record(value) || ![2,3].includes(value.schemaVersion) || value.schemaVersion === 2 && !legacy ||
      value.kind !== 'membership' ||
      !['approved', 'pending', 'expired', 'rejected', 'unknown'].includes(value.phase) ||
      !record(value.evidence)) return null;

  const {enrollmentState, origin} = value.evidence;
  const invitationPolicy = value.invitationPolicy;
  const rosterMembershipVerified = value.schemaVersion === 3
    ? value.evidence.rosterMembershipVerified
    : enrollmentState === 'approved';
  if (!(enrollmentState === null || STATES.has(enrollmentState)) ||
      !(origin === null || typeof origin === 'boolean') ||
      !POLICIES.has(invitationPolicy) || typeof rosterMembershipVerified !== 'boolean') return null;

  const phaseMatchesEnrollment = STATES.has(enrollmentState) && value.phase === enrollmentState;
  const verifiedLocalMember = enrollmentState === null && origin === true && rosterMembershipVerified && value.phase === 'approved';
  const approvalNeedsRoster = value.phase === 'unknown' && enrollmentState === 'approved' && !rosterMembershipVerified;
  const noMembershipEvidence = value.phase === 'unknown' && enrollmentState === null && !rosterMembershipVerified;
  if ((!phaseMatchesEnrollment && !verifiedLocalMember && !approvalNeedsRoster && !noMembershipEvidence) ||
      value.phase === 'approved' && (!rosterMembershipVerified || origin !== true) ||
      value.phase !== 'approved' && rosterMembershipVerified) return null;

  return {
    schemaVersion: 3,
    kind: 'membership',
    phase: value.phase,
    evidence: {enrollmentState, origin, rosterMembershipVerified},
    invitationPolicy,
  };
}

/** Validate the versioned membership contract. Invalid or contradictory input is unknown. */
export function createMembershipProjection(value) {
  return validated(value, {legacy:true}) ?? unknownMembership();
}

/** Project current membership. An origin names a host; it does not prove that the host accepted this device. */
export function projectMembership(circle) {
  if (!record(circle)) return unknownMembership();
  const hasEnrollment = circle.enrollment != null;
  const enrollmentState = hasEnrollment && record(circle.enrollment) && STATES.has(circle.enrollment.state)
    ? circle.enrollment.state
    : null;
  let origin = null;
  if (typeof circle.origin === 'string') origin = circle.origin.length > 0;
  else if (typeof circle.origin === 'boolean') origin = circle.origin;
  else if (circle.origin != null) return unknownMembership();

  // Joined membership is approved only when a verified host roster lists this device. The host's enrollment answer is
  // not enough: a removed device can still hold an old "approved" answer. An owner's signed local roster is the
  // equivalent proof for the device that created and hosts its own circle; origin alone is never evidence.
  const rosterMembershipVerified = enrollmentState === 'approved'
    ? origin === true && circle.rosterMembershipVerified === true
    : !hasEnrollment && origin === true && (circle.rosterMembershipVerified === true ||
      circle.owned === true || circle.steward === true || circle.admin === true);
  const phase = enrollmentState === 'approved' && !rosterMembershipVerified
    ? 'unknown'
    : enrollmentState ?? (rosterMembershipVerified ? 'approved' : 'unknown');
  const policy = circle.joinInfo?.approval;
  const invitationPolicy = policy === 'each' || policy === 'automatic' ? policy : 'unknown';
  return validated({
    schemaVersion: 3,
    kind: 'membership',
    phase,
    evidence: {enrollmentState, origin, rosterMembershipVerified},
    invitationPolicy,
  }) ?? unknownMembership();
}

/** A present server projection is authoritative, including when invalid. Raw adaptation is for older responses only. */
export function membershipProjectionOf(circle) {
  if (record(circle) && Object.hasOwn(circle, 'membershipProjection')) return createMembershipProjection(circle.membershipProjection);
  return projectMembership(circle);
}
