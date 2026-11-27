// Reconciles a saved host with a coordinator that is still running after the app that started it was quit and restarted.
// The old launcher's handle and token are gone, so launcher ownership proves nothing here. The coordinator's own durable
// config and a verified process identity do. An old PID alone never authorizes a stop, and an unverified owner is never
// signalled.
//
// io.read()    -> {config, status}: the saved host config and the last status the coordinator wrote.
// io.verify(c) -> the verified current owner of that process, or throws when its identity does not match.
// io.lock(fn)  -> runs fn under the host lock.
// io.stop(o)   -> stops the verified owner o and answers {portQuiet}.
export async function reconcileHostControl({expectedGeneration, read, verify, lock, stop, action = 'adopt'}) {
  return lock(async () => {
    const {config, status} = await read();
    // A supplied generation names the host the caller meant. A newer one is never signalled, whatever the action or intent.
    if (expectedGeneration !== undefined && config?.stop_generation !== expectedGeneration) return {status: 'not_wanted', reason: 'generation'};
    if (config?.host_wanted !== true && action !== 'stop') return {status: 'not_wanted'};
    const candidate = ['listening', 'public_listening'].includes(status?.status) ? status.owner ?? null : null;
    if (!candidate || !Number.isSafeInteger(status.pid) || candidate.pid !== status.pid) return {status: 'unverified', reason: 'no_owner'};
    let owner;
    try { owner = await verify(candidate); } catch { return {status: 'unverified', reason: 'identity'}; }
    if (action !== 'stop') return {status: 'adopted', owner};
    // Verify again immediately before the signal: the process may have exited and its PID been reused since the first check.
    try { owner = await verify(owner); } catch { return {status: 'unverified', reason: 'identity'}; }
    const stopped = await stop(owner);
    return stopped?.portQuiet === true ? {status: 'stopped', portQuiet: true} : {status: 'unverified', reason: 'port_not_quiet', portQuiet: false};
  });
}
