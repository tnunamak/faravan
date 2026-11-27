// The circle host this computer runs, as the tarball updater uses it. One coordinator home is one host.
import fs from 'node:fs';
import {hostPaths} from '../host.mjs';
import {hostedCoordinatorRecord, stopV1Host} from './host.mjs';
import {startHostFromInstall} from './host-command.mjs';
import {resumeArgs,retryableHostStart} from './host-intent.mjs';
import {runtimeFor} from './self-update.mjs';

const savedConfig = home => { try { return JSON.parse(fs.readFileSync(hostPaths(home).config, 'utf8')); } catch { return null; } };

export function createHostedCoordinators({home, coordinatorHome, installDir}) {
  // The stop generation this update's own stop left. Its restart runs only while that is still current: an owner's
  // stop during the update saves a new one, and the restart then refuses (assertResumable) instead of undoing it.
  let planned = null;
  return {
    /** The verified coordinator this home runs, as {pid, owner}, or null when none runs. Throws when one cannot be verified. */
    record: async () => hostedCoordinatorRecord(coordinatorHome),
    /** Warning-only snapshot of our saved record. Unlike record(), this never probes a process. */
    censusRecords: async () => {
      try {
        const config = JSON.parse(await fs.promises.readFile(hostPaths(coordinatorHome).config, 'utf8'));
        if (!config?.status_path) return [];
        const record = JSON.parse(await fs.promises.readFile(config.status_path, 'utf8'));
        return Number.isSafeInteger(record?.pid) && record.pid > 0 ? [{pid: record.pid, owner: record.owner}] : [];
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error; // unreadable records are unknown, never evidence of an unmanaged process
      }
    },
    /** Stops exactly the recorded coordinator. Refuses, before anything changes, if its identity no longer matches. */
    stop: async record => {
      try { return await stopV1Host({home: coordinatorHome, expectedOwner: record.owner}); }
      finally { planned = savedConfig(coordinatorHome); }
    },
    /**
     * Starts the circle host from the install now at installDir. Resolves once it reports host_ready, or with
     * {status:'not_wanted'} when the owner stopped hosting during the update, so the host stays stopped.
     */
    start: async () => {
      try {
        return await startHostFromInstall({installDir, runtime: await runtimeFor(installDir), home, coordinatorHome,
          args: resumeArgs(planned ?? savedConfig(coordinatorHome))});
      } catch (error) {
        if (error?.code === 'host_not_wanted') return {status: 'not_wanted'};
        throw error;
      }
    },
  };
}

// A prepared Mac helper waits for its parent to exit. Stop hosting while the
// old installation can still verify its coordinator. Cancellation resumes only
// through the saved owner intent and stop generation, just like tarball updates.
export async function prepareWithHostedCoordinator(hosts, prepare) {
  if(!hosts)return prepare();
  const record=await hosts.record();
  if(!record)return prepare();
  let ticket;
  try {
    await hosts.stop(record);
    ticket=await prepare();
    if(!ticket?.ready||typeof ticket.cancel!=='function') {
      await ticket?.cancel?.();
      throw Error('The update helper is unavailable');
    }
  } catch(error) {
    if(error.code!=='ownership_unknown')try {await hosts.start();}catch { /* wanted hosting is also retried by the app */ }
    throw error;
  }
  let cancellation=null,helperStopped=false;
  const cancel=()=>{
    if(!cancellation) {
      cancellation=Promise.resolve().then(async()=>{
        if(!helperStopped){await ticket.cancel();helperStopped=true;}
        await hosts.start();
      });
      // Once helper cessation is known, a transient restoration failure can be
      // retried without cancelling the helper again. Concurrent callers share
      // the same pending work and the same result.
      cancellation.catch(error=>{if(helperStopped&&retryableHostStart(error))cancellation=null;});
    }
    return cancellation;
  };
  return {...ticket,get ready(){return ticket.ready;},cancel};
}
