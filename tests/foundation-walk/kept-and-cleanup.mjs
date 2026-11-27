// Synthetic W09/W10 fixture only; no product, filesystem, credential or process effects.
// The only integration port is runner.mjs's existing run/resume/cleanup seam.
export const KEPT_ACTIONS = Object.freeze([
  'second_circle', 'rename_circle', 'stewardship', 'transfer', 'cancel_transfer',
  'folder_source', 'files_source', 'zip_source', 'pinned_repo_source',
  'verified_review', 'apply_disposable',
]);
const fields = ['accountId', 'jobId', 'attemptId', 'readingAgeMs'];
export function createKeptAndCleanupDriver(fixture, { keptCheck } = {}) {
  if (typeof keptCheck !== 'string' || !/^W09_[A-Z_]+$/.test(keptCheck)) throw new Error('explicit_kept_check_required');
  const identity = Object.fromEntries(fields.map(k => [k, fixture[k]]));
  if (!fields.slice(0, 3).every(k => typeof identity[k] === 'string' && identity[k])
      || !Number.isFinite(identity.readingAgeMs) || identity.readingAgeMs < 0)
    throw new Error('invalid_fixture_binding');
  fixture.binding ??= { ...identity };
  if (!fields.every(k => fixture.binding[k] === identity[k]))
    throw new Error('fixture_binding_mismatch');
  fixture.actions ??= [];
  fixture.completed ??= [];
  fixture.owned ??= [];
  const bound = row => row?.schemaVersion === 1 && fields.every(k => row[k] === identity[k]);
  const result = (outcome, code) => ({
    outcome, observed: { schemaVersion: 1, ...identity, code, fixtureIntervention: true },
    evidencePaths: [],
  });
  // Log once BEFORE looking for a receipt. Missing receipt means reconcile only.
  const request = (kind, id) => {
    if (!fixture.actions.some(a => a.kind === kind && a.id === id))
      fixture.actions.push({ schemaVersion: 1, ...identity, kind, id });
  };
  const keptValid = (kind, row) => {
    if (!bound(row) || row.confirmed !== true || row.kind !== kind) return false;
    if (kind === 'pinned_repo_source') return typeof row.commit === 'string' && /^[a-f0-9]{40}$/.test(row.commit);
    if (kind === 'verified_review') return row.verified === true && typeof row.digest === 'string' && /^[a-f0-9]{64}$/.test(row.digest);
    if (kind === 'apply_disposable') {
      const review = fixture.kept?.verified_review;
      return row.disposable === true && row.digest === review?.digest && keptValid('verified_review', review)
        && fixture.owned.some(r => bound(r) && r.kind === 'target' && r.id === row.targetId);
    }
    return true;
  };
  async function execute({ check, signal }, recovering) {
    if (check !== keptCheck) return result('blocked', 'outside_fixture_scope');
    if (signal?.aborted) return result('blocked', 'cancelled');
    if (fixture.cleanupStarted) return result('blocked', 'cleanup_started');
    if (recovering && !fixture.pending) return result('blocked', 'no_pending_action');
    if (!recovering && fixture.pending) return result('blocked', 'reconciliation_required');
    for (const kind of KEPT_ACTIONS) {
      if (fixture.completed.includes(kind)) continue;
      if (fixture.pending && fixture.pending !== kind) return result('blocked', 'pending_action_mismatch');
      fixture.pending = kind;
      request(kind, kind);
      const row = fixture.kept?.[kind];
      if (!row) return result('blocked', 'observation_pending');
      if (!keptValid(kind, row)) return result('fail', 'fixture_receipt_mismatch');
      fixture.completed.push(kind);
      fixture.pending = null;
    }
    return result('pass', 'synthetic_kept_confirmed');
  }
  async function cleanup() {
    fixture.cleanupStarted = true; // Stop further creates even while receipts are pending.
    // Ownership is a closed, explicit synthetic ledger. Never inspect/delete PIDs
    // or containers discovered elsewhere. Read the ledger anew on every pass:
    // late allocation must not disappear behind a cached cleanup receipt.
    if (!Array.isArray(fixture.owned) || fixture.owned.some(r => !bound(r)
        || typeof r.id !== 'string' || !r.id || !['backend', 'membership', 'target', 'source'].includes(r.kind)))
      return result('blocked', 'invalid_owned_ledger');
    let pending = false;
    for (const resource of fixture.owned.filter(r => r.kind === 'backend')) {
      const id = resource.kind + ':' + resource.id;
      const proof = fixture.cleanupProofs?.[id];
      request('cancel_owned', id);
      // Cancel acknowledgement, idle and zero counters are not cessation.
      const stopped = bound(proof) && proof.resourceId === resource.id && proof.kind === resource.kind
        && (proof.cessation === 'confirmed' || (proof.cessation === 'never_started'
          && proof.authoritative === true && proof.allocationClosed === true));
      if (!stopped) pending = true;
    }
    // Do not remove even owned inputs/targets until all backends have ceased.
    if (pending) return result('blocked', 'cleanup_unconfirmed');
    for (const resource of fixture.owned) {
      const id = resource.kind + ':' + resource.id;
      const proof = fixture.cleanupProofs?.[id];
      request(resource.kind === 'membership' ? 'leave_owned' : 'remove_owned', id);
      if (!bound(proof) || proof.resourceId !== resource.id || proof.kind !== resource.kind
          || (resource.kind === 'membership' ? proof.rosterLeft !== true : proof.removed !== true))
        pending = true;
    }
    // An explicit sealed allocation ledger is required even with no owned resources.
    // This is a fake observation, never a newly invented product contract.
    const sealed = fixture.allocation;
    if (!bound(sealed) || sealed.closed !== true) pending = true;
    return pending ? result('blocked', 'cleanup_unconfirmed') : result('pass', 'synthetic_cleanup_confirmed');
  }
  return { run: args => execute(args, false), resume: args => execute(args, true), cleanup };
}
