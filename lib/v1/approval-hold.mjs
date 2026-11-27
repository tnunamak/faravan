// A job this computer sent to itself is held when its identity check fails before it can run (app.mjs approval).
// Both the sender's job view and the CLI send result read this one copy, so the reason and its clearing action match.
const OWN_JOB_HOLDS = Object.freeze({
  identity_changed: Object.freeze({
    reason: 'This computer’s details changed after the job was sent, so it is on hold.',
    action: 'Review the job again in Approvals before it runs.',
  }),
});

/** The hold to show for a failed own-job check, or null when that check does not hold the job. */
export function ownJobHold(code) {
  return Object.hasOwn(OWN_JOB_HOLDS, code) ? {code, ...OWN_JOB_HOLDS[code]} : null;
}
