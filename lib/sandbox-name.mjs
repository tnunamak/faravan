import {createHash,randomBytes} from 'node:crypto';
import {readSbxOwner} from './sbx-daemon-owner.mjs';

// Every create dispatch gets its own physical name. A name is never derived
// from a job, so recovery can only act on names the cleanup journal recorded.
export function freshSandboxName() {
  return 'wf-' + randomBytes(8).toString('hex');
}

export function sandboxOwnerScope() {
  const owner = readSbxOwner();
  if (!owner) throw Object.assign(new Error('Sandbox ownership is missing or unreadable. Start the sandbox service or repair its ownership before requesting a name.'), {code:'daemon_owner_repair_required'});
  return owner.id;
}

// This is for read-only checks of durable records written before owner scopes.
export function legacySandboxNameFor(jobId) {
  return 'wf-' + createHash('sha256').update(jobId).digest('hex').slice(0,16);
}
