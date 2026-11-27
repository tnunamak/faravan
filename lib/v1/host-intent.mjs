// An owner's "host this circle" is durable: hostV1 records host_wanted in host.json once the circle is ready, and only
// the owner's stop clears it. At its next start the app brings that host back, from the same coordinator home.
// The restart is planned here but runs later, in its own process. It carries the stop generation seen here, and
// `faravan host --resume` refuses under the host lock if the owner stopped hosting in between (assertResumable).
import fs from 'node:fs';
import { hostPaths, readCoordinatorStatus } from '../host.mjs';
import { hostProcessExists } from './host.mjs';

/**
 * Starts the wanted host when it is not running. Returns {resumed, reason}. A process it cannot identify is left alone.
 * start(['--resume', generation]) receives the arguments for `faravan host`.
 */
export async function resumeWantedHost({coordinatorHome, start, processExists = hostProcessExists}) {
  const paths = hostPaths(coordinatorHome);
  let config;
  try { config = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch { return {resumed:false, reason:'not_configured'}; }
  if (config?.protocol_version !== 1 || config.host_wanted !== true || !config.circle_id || !config.reachability)
    return {resumed:false, reason:'not_wanted'};
  let status = null;
  try { status = readCoordinatorStatus(config); } catch { /* a status file mid-write reads as not running */ }
  try { if (processExists(status, {configPath:paths.config})) return {resumed:false, reason:'running'}; }
  catch { return {resumed:false, reason:'unknown'}; }
  try { await start(resumeArgs(config)); }
  catch (error) { if (error?.code === 'host_not_wanted') return {resumed:false, reason:'not_wanted'}; throw error; }
  return {resumed:true, reason:'started'};
}

/** The `faravan host` arguments for an automatic restart of the host saved in config. */
export const resumeArgs = config => ['--resume', config?.stop_generation ?? 'initial'];

// Named permanent failures and uncertain ownership require the owner's intervention.
// A generic failed launch may retry within the caller's bound after verified cleanup.
export function retryableHostStart(error) {
  return error?.reason!=='lock_stale'&&error?.cleanup_verified!==false&&[
    'lock_busy','device_busy','coordinator_starting','host_failed','timeout','network_error',
    'EIO','EAGAIN','EBUSY','EMFILE','ENFILE','ETIMEDOUT','ECONNRESET','ECONNREFUSED',
    'EHOSTUNREACH','ENETUNREACH','ENETDOWN','EAI_AGAIN','ENOTFOUND',
  ].includes(error?.code);
}
