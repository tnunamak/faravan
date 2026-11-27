const COUNT_LABELS = [
  ['data_cleanup_pending', 'Data removal pending'],
  ['policy_cleanup_pending', 'Network rule removal pending'],
  ['policy_cleanup_blocked', 'Network rule removal blocked'],
  ['compute_cleanup_pending', 'Compute stop pending'],
  ['unknown', 'Cleanup status unknown'],
  ['create_watch', 'Names still needing checks'],
];
const knownCount = value => Number.isSafeInteger(value) && value >= 0;

// Counts describe independent work. An active watcher does not prove any of it is done.
// Build copy locally rather than displaying arbitrary backend diagnostics.
export function cleanupStatusVM(cleanup, {stale = false} = {}) {
  const shared = cleanup?.shared_watch;
  let watch;
  if (stale) {
    watch = {kind:'wait', line:'Workspace cleanup status could not be refreshed. Last known counts are shown.'};
  } else if (shared?.healthy === false) {
    watch = {kind:'bad', line:'Shared workspace watcher needs attention.'};
  } else if (shared?.healthy !== true) {
    watch = {kind:'wait', line:'Shared workspace watcher status is unavailable.'};
  } else if (!knownCount(shared.count)) {
    watch = {kind:'wait', line:'Shared workspace watcher count is unavailable.'};
  } else if (shared.listing_failed === true) {
    // Same sentence as listingUnreadableCopy in lib/sandbox-remediation.mjs; the browser bundle cannot import the lib.
    const names = `${shared.count} watched sandbox ${shared.count === 1 ? 'name' : 'names'}`;
    watch = {kind:'wait', line:`watching ${shared.count} names until listing works`, nothing_to_do:true,
      detail:`Waiting for Docker to list sandboxes, so ${names} cannot be confirmed gone yet. Faravan checks again on its own. Nothing to do.`};
  } else {
    watch = {kind:'on', line:shared.count === 0
      ? 'Shared workspace watcher is running. No names are being watched.'
      : `Watching ${shared.count} ${shared.count === 1 ? 'name' : 'names'}.`};
  }
  const positive = key => knownCount(cleanup?.[key]) && cleanup[key] > 0;
  const obligations = [
    positive('compute_cleanup_pending') && 'Waiting for jobs to stop.',
    positive('data_cleanup_pending') && 'Removing job data.',
    positive('policy_cleanup_pending') && 'Removing network rules.',
    positive('policy_cleanup_blocked') && 'Some network rules could not be removed.',
  ].filter(Boolean);
  // Unknown watcher metadata alone is not evidence of unfinished cleanup.
  // Unknown obligation counts and unreadable records are relevant uncertainty.
  const uncertain = cleanup != null && (
    positive('unknown') || positive('unreadable_records') ||
    COUNT_LABELS.slice(0,5).some(([key]) => !knownCount(cleanup[key]))
  );
  if (uncertain) obligations.push('Some cleanup could not be confirmed.');
  if (shared?.healthy === false) obligations.push('Workspace cleanup needs attention.');
  else if (positive('create_watch') || (knownCount(shared?.count) && shared.count > 0))
    obligations.push('Checking that workspaces are gone.');
  const summary = obligations.length === 0 ? null : {
    kind: stale ? 'wait' : positive('policy_cleanup_blocked') || shared?.healthy === false ? 'bad' : 'wait',
    line: stale ? 'Cleanup status could not be refreshed. Open Details for the last known information.' : obligations.join(' '),
  };
  return {
    summary,
    heading:'Workspace cleanup',
    watch,
    unreadable:knownCount(cleanup?.unreadable_records)&&cleanup.unreadable_records>0
      ?{count:cleanup.unreadable_records,line:cleanup.unreadable_records===1?'1 cleanup record could not be read':`${cleanup.unreadable_records} cleanup records could not be read`}:null,
    counts:COUNT_LABELS.map(([key, label]) => ({key, label, value:knownCount(cleanup?.[key]) ? cleanup[key] : 'Unknown'})),
  };
}
