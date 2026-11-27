import assert from 'node:assert/strict';

// Charge each interval to the preceding sample. Open durable holds are not an
// eligibility input: callers judge physical quota and backend inventory alone.
export function createLiveness() {
  let previous = null, availableMs = 0, refusedMs = 0, streak = null;
  let longest = {durationMs:0,reasons:{},startStep:null};
  const finishStreak = () => {
    if (streak && streak.durationMs > longest.durationMs) longest = streak;
    streak = null;
  };
  return {
    sample(at,eligible,allowed,reason,step) {
      if (previous) {
        const dt = at-previous.at;
        assert.ok(dt >= 0,'liveness clock must not move backwards');
        if (previous.eligible) {
          availableMs += dt;
          if (!previous.allowed) {
            refusedMs += dt;
            streak ??= {durationMs:0,reasons:{},startStep:previous.step};
            streak.durationMs += dt;
            streak.reasons[previous.reason] = (streak.reasons[previous.reason] ?? 0)+dt;
          } else finishStreak();
        } else finishStreak();
      }
      previous = {at,eligible,allowed,reason,step};
    },
    report() {
      assert.ok(availableMs > 0,'liveness denominator must not be empty');
      const current = streak && streak.durationMs > longest.durationMs ? streak : longest;
      return {L:refusedMs/availableMs,availableMs,refusedMs,longest:structuredClone(current)};
    },
  };
}
