import fs from 'node:fs';
import {durableJson} from '../durable-write.mjs';

/**
 * Remembers which limit windows each provider account has reported, so a reply that silently omits one cannot
 * pass as a complete roster. One local JSON file, replaced atomically (durableJson); holds no credential.
 *
 *   const memory = createWindowMemory({file, onRemoved});
 *   memory.check(provider, windows, now) -> {ok:true} | {refuse, missing?}
 *
 * - The first reply for a provider is trusted; its windows become the remembered set.
 * - A later reply that lacks a remembered window is unknown, not "absent": the check refuses.
 * - A remembered window is dropped only after replies have lacked it for at least that window's own duration,
 *   counted from the first reply that lacked it. Any reply that includes it resets that clock. A drop calls onRemoved.
 * - A new window is added to the set.
 * - Only ENOENT means "no memory yet". Any other read or parse failure refuses, and the file is left untouched.
 */
const UNREADABLE = 'lending_window_memory_unreadable';
const MISSING = 'lending_window_missing';
const validEntry = e => e && typeof e === 'object' && Number.isFinite(e.duration_ms) && e.duration_ms > 0 &&
  (e.absent_since === null || Number.isFinite(e.absent_since));

function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {schema_version: 1, accounts: {}}; throw error; }
  const data = JSON.parse(text);
  if (data?.schema_version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) throw new Error('bad window memory');
  for (const account of Object.values(data.accounts)) {
    if (!account?.windows || typeof account.windows !== 'object') throw new Error('bad window memory');
    for (const entry of Object.values(account.windows)) if (!validEntry(entry)) throw new Error('bad window memory');
  }
  return data;
}

export function createWindowMemory({file, onRemoved = () => {}} = {}) {
  return {
    check(provider, windows, now, {readOnly = false} = {}) {
      if (!Array.isArray(windows) || windows.length === 0 || !Number.isFinite(now)) return {ok: true}; // refused downstream
      if (windows.some(w => !Number.isFinite(w?.duration_ms) || w.duration_ms <= 0)) return {refuse: 'lending_window_invalid'};
      let data;
      try { data = load(file); } catch { return {refuse: UNREADABLE}; }
      const before = JSON.stringify(data);
      const known = data.accounts[provider] ??= {windows: {}};
      const remembered = known.windows;
      const seen = new Set(windows.map(w => w.id));
      const missing = [], removals = [];
      for (const w of windows) remembered[w.id] = {duration_ms: w.duration_ms, absent_since: null};
      for (const [id, entry] of Object.entries(remembered)) {
        if (seen.has(id)) continue;
        entry.absent_since ??= now;
        const absentFor = now - entry.absent_since;
        if (!readOnly && absentFor >= entry.duration_ms) { delete remembered[id]; removals.push({provider, window_id: id, absent_for_ms: absentFor}); }
        else missing.push(id);
      }
      if (!readOnly && JSON.stringify(data) !== before) {
        try { durableJson(file, data); } catch { return {refuse: UNREADABLE}; }
      }
      for (const removal of removals) onRemoved(removal);
      return missing.length ? {refuse: MISSING, missing} : {ok: true};
    },
  };
}
