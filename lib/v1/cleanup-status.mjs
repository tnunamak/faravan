import {listingUnreadableCopy,sandboxRemediationLines} from '../sandbox-remediation.mjs';
// The home response exposes counts and generated copy, never journal paths,
// command output, process identities or unvalidated text from a status file.
const counts=['data_cleanup_pending','policy_cleanup_pending','policy_cleanup_blocked','compute_cleanup_pending','unknown','create_watch','unreadable_records'];
const count=value=>Number.isSafeInteger(value)&&value>=0;
export function cleanupStatusSummary(status) {
  const summary={};
  if(Array.isArray(status?.items)) {
    // Keep the journal's debt order; cap projection work, never the journal's exact counts.
    summary.total_items=status.items.length;
    summary.truncated=summary.total_items>50;
    summary.items=status.items.slice(0,50).map(item=>({...item,message:sandboxRemediationLines([item]).join(' '),action:'Clean up now'}));
  }
  for(const key of counts)if(count(status?.[key]))summary[key]=status[key];
  if(summary.unreadable_records>0)summary.unreadable_message=summary.unreadable_records===1
    ?'1 cleanup record could not be read':`${summary.unreadable_records} cleanup records could not be read`;
  if(status?.shared_watch&&typeof status.shared_watch==='object') {
    const watch=status.shared_watch,healthy=watch.healthy===true,n=count(watch.count)?watch.count:null;
    const listing_failed=watch.listing_failed===true;
    summary.shared_watch={healthy:healthy&&n!==null,count:n,listing_failed,
      message:!healthy||n===null?'Shared workspace watcher needs attention.':listing_failed?`watching ${n} names until listing works`:`watching ${n} names`};
    // Says what the watched names wait on and that the person has nothing to do while the list cannot be read.
    if(healthy&&n!==null&&listing_failed)Object.assign(summary.shared_watch,{detail:listingUnreadableCopy(n).text,nothing_to_do:true});
  }
  return summary;
}
