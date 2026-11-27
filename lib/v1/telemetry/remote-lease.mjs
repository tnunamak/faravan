// Local evidence authorizing edge capture. It is never included in Cloud properties.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export const REMOTE_LEASE_MS=15*60000;
export const REMOTE_LEASE_FILE='remote-lease.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Missing, corrupt, stale, future or other-generation evidence always means no capture. */
export function readRemoteLease({dir,generation,at=Date.now()}) {
 try {
  const lease=JSON.parse(readFileSync(join(dir,REMOTE_LEASE_FILE),'utf8'));
  if(!lease || lease.version!==1 || lease.enabled!==true || lease.generation!==generation || typeof lease.id!=='string' || !UUID.test(lease.id) ||
    !Number.isSafeInteger(lease.startedAt) || !Number.isSafeInteger(lease.checkedAt) || lease.startedAt<0 || lease.checkedAt<lease.startedAt ||
    !Number.isSafeInteger(at) || at<lease.checkedAt || at-lease.checkedAt>=REMOTE_LEASE_MS)return null;
  return lease;
 }catch{return null;}
}
/** A record must have been captured inside the currently uninterrupted positive lease. */
export function captureWithinLease(capture,lease,at) {
 return Boolean(lease && capture && capture.lease_id===lease.id && Number.isSafeInteger(capture.captured_at) &&
  capture.captured_at>=lease.startedAt && capture.captured_at<=at && capture.captured_at<lease.checkedAt+REMOTE_LEASE_MS);
}
