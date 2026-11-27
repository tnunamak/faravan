import { randomUUID } from 'node:crypto';
import { MEMBER_CAPABILITIES, DESIGNATED_MEMBER_CAPABILITY } from './versions.mjs';
// P1b: a signed-in lender reports its state every 30 s, whether or not it is claiming work, so a
// blocked, paused, resting or busy computer stays visible with its reason. The timer is
// independent of claimNext. A failed send is never fatal; the next tick tries again.
export const HEARTBEAT_INTERVAL_MS = 30000;
// One id per lender process. `seq` restarts at 0 with each process, so the coordinator compares it only within a boot.
const newBoot = () => randomUUID().replaceAll('-', '').slice(0, 24);
// What this build can do, for routing and for the screens that must not promise more (EXPERIENCE 1.3).
export const LENDER_CAPABILITIES = Object.freeze([...new Set(['progress_v1','transcript_relay_v1','offers_v1','budget_v1','working_directory_v1','source_manifest_v1','source_project_name_v1','filtered_git_v1',DESIGNATED_MEMBER_CAPABILITY,...MEMBER_CAPABILITIES])]);

// One deadline covers the snapshot and the send. Both get the same signal, so a hung local read or a hung host call
// cannot pin the beat: when the deadline passes, every waiting caller settles and the next beat starts fresh.
export const HEARTBEAT_DEADLINE_MS = 25000;
export function createHeartbeat({send, snapshot, intervalMs = HEARTBEAT_INTERVAL_MS, deadlineMs = HEARTBEAT_DEADLINE_MS, setTimer = setTimeout, clearTimer = clearTimeout, boot = newBoot()} = {}) {
  let seq = 0, timer = null, stopped = true, inFlight = null, current = null;
  function beat() {
    if (inFlight) return inFlight;
    const controller = new AbortController(), {signal} = controller;
    let deadlineTimer = null;
    const work = (async () => {
      try {
        const body = await snapshot({signal});
        if (signal.aborted) return; // invalidated: no new local send after the deadline or stop
        await send({boot, seq: seq++, ...body}, {signal});
      } catch { /* retried at the next tick */ }
    })();
    const deadline = new Promise(resolve => {
      deadlineTimer = setTimer(() => { controller.abort(new DOMException('The heartbeat ran out of time.', 'TimeoutError')); resolve(); }, deadlineMs);
      deadlineTimer?.unref?.();
    });
    const mine = inFlight = Promise.race([work, deadline]).finally(() => {
      clearTimer(deadlineTimer);
      if (inFlight === mine) { inFlight = null; current = null; }
    });
    current = controller;
    return mine;
  }
  const schedule = () => {
    if (stopped) return;
    timer = setTimer(async () => { await beat(); schedule(); }, intervalMs);
    timer?.unref?.();
  };
  return {
    beat,
    start() { if (!stopped) return; stopped = false; beat().finally(schedule); },
    stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; current?.abort(new DOMException('The heartbeat stopped.', 'AbortError')); },
  };
}
