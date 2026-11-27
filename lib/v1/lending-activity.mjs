import {durableJson} from '../durable-write.mjs';
/**
 * Owner activity history for the five-hour session guard (LENDING-POLICY-DESIGN.md D4: "While you are away and no
 * block is open ... allowed only if fewer than 10% of past weeks show your activity in the next 5 h at this hour of
 * the week ... Without 2 weeks of activity history, it is not allowed").
 *
 *   const activity = createLendingActivity({ file, now });
 *   activity.observe(true | false | null)   desktop input: active, away, or unknown (ignored)
 *   activity.forecast(windowMinutes = 300) -> { weeks, futureActiveFraction, eligible }
 *
 * Stores only 5-minute bin indices with an active/away bit, under the app home. It reads no session log, no
 * credential and nothing else on the host. A bin is active if any observation in it was active. A bin with no
 * observation is unknown, never "away".
 */
import fs from 'node:fs';
import path from 'node:path';

export const ACTIVITY_BIN_MS = 5 * 60000;
const WEEK = 7 * 24 * 3600000, WEEKS = 8, MAX_BINS = WEEKS * WEEK / ACTIVITY_BIN_MS;
const MIN_COVERAGE = 0.9, MIN_WEEKS = 2;
const UNKNOWN = Object.freeze({ weeks: 0, futureActiveFraction: 1, eligible: false });

export function createLendingActivity({ file, now = Date.now } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('createLendingActivity needs an absolute file');
  let writes = 0;
  // bin index -> 0 (away) | 1 (active). Loaded once; this process is the only writer.
  const bins = load();

  function load() {
    const map = new Map();
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return map; }   // missing or corrupt: no history
    if (data?.schema_version !== 1 || !Array.isArray(data.bins)) return map;
    for (const row of data.bins.slice(-MAX_BINS)) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] < 0 || (row[1] !== 0 && row[1] !== 1)) return new Map();
      map.set(row[0], row[1]);
    }
    return map;
  }
  function save(current) {
    // Retain 8 weeks; drop bins from a clock that has since moved backwards.
    for (const key of bins.keys()) if (key <= current - MAX_BINS || key > current) bins.delete(key);
    const rows = [...bins.entries()].sort((a, b) => a[0] - b[0]);
    durableJson(file,{schema_version:1,bins:rows});
    writes++;
  }

  return {
    file,
    /** One desktop input reading. Writes at most once per bin, plus once when a bin turns active. */
    observe(active) {
      if (active !== true && active !== false) return false;
      const t = now();
      if (!Number.isFinite(t) || t < 0) return false;
      const bin = Math.floor(t / ACTIVITY_BIN_MS), before = bins.get(bin);
      const next = active || before === 1 ? 1 : 0;
      if (before === next) return false;
      bins.set(bin, next);
      try { save(bin); } catch { return false; }
      return true;
    },
    /**
     * For each of the last 8 weeks, the same `windowMinutes` period that starts at this moment of the week.
     * A week counts only with at least 90% of its bins observed; it is active if any observed bin was active.
     * Fewer than 2 counted weeks is not eligible (and reports futureActiveFraction 1).
     */
    forecast(windowMinutes = 300) {
      const t = now();
      if (!Number.isFinite(t) || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > 24 * 60) return { ...UNKNOWN };
      const current = Math.floor(t / ACTIVITY_BIN_MS), length = Math.ceil(windowMinutes * 60000 / ACTIVITY_BIN_MS);
      let weeks = 0, active = 0;
      for (let k = 1; k <= WEEKS; k++) {
        const start = Math.floor((t - k * WEEK) / ACTIVITY_BIN_MS);
        let known = 0, any = false;
        for (let b = start; b < start + length; b++) {
          // Evidence from after "now" (a clock that moved backwards) never counts.
          const v = b <= current ? bins.get(b) : undefined;
          if (v === undefined) continue;
          known++; if (v === 1) any = true;
        }
        if (known >= MIN_COVERAGE * length) { weeks++; if (any) active++; }
      }
      if (weeks < MIN_WEEKS) return { weeks, futureActiveFraction: 1, eligible: false };
      const futureActiveFraction = active / weeks;
      return { weeks, futureActiveFraction, eligible: futureActiveFraction < 0.1 };
    },
    writes: () => writes,
  };
}
