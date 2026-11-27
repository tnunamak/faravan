import {durableJson} from '../durable-write.mjs';
// Append-only audit for remote ChatGPT access. A remote caller can only append to its own bounded
// bucket; nothing remote ever evicts an entry. A full bucket stays full (sticky overflow counter)
// until the person clears it locally, and the caller refuses new actions it cannot record.
import {readFileSync} from 'node:fs';

export const AUDIT_ENTRIES = 200, AUDIT_RESERVE = 40, AUDIT_CLIENTS = 32, READ_KEYS = 128;
// Shared buckets: lifecycle of clients not yet approved, local owner actions, pre-migration entries.
export const UNAPPROVED = '_unapproved', LOCAL = '_local', LEGACY = '_legacy';
const SHARED = new Set([UNAPPROVED, LOCAL, LEGACY]);
// Reads are counted per op+outcome, never stored as entries, so read traffic can neither fill the
// action log nor evict history. Keys are validated so a caller cannot reach prototype properties.
const READ_OP = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, READ_OUTCOME = /^[a-z][a-z_]{0,31}$/;
const clean = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);

export function createChatgptAudit({file, now}) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!data || typeof data.buckets !== 'object' || !data.buckets) data = {version:1, buckets:{}, overflow:0};
  for (const b of Object.values(data.buckets)) { b.reads ??= {}; b.read_calls ??= 0; b.read_overflow ??= 0; }
  const save = () => {
    durableJson(file,data);
  };
  const clientBuckets = () => Object.keys(data.buckets).filter(key => !SHARED.has(key)).length;
  function bucket(key, info = {}) {
    let b = data.buckets[key];
    if (!b) {
      // Known-client buckets are capped; past the cap a new client's entries only count as overflow.
      if (!SHARED.has(key) && clientBuckets() >= AUDIT_CLIENTS) return null;
      b = data.buckets[key] = {entries:[], overflow:0, refreshes:0, last_refresh_at:null, reads:{}, read_calls:0, read_overflow:0};
    }
    for (const field of ['client', 'redirect_host']) if (info[field] !== undefined) b[field] = info[field];
    return b;
  }
  // reserve: completions of already-admitted calls and OAuth lifecycle events may use slots that
  // auditRoom never offers, so an admitted action can always record its outcome.
  function record(key, {client_id = key, actor, op, outcome, effect}, {reserve = false, info} = {}) {
    const b = bucket(key, info);
    if (!b) { data.overflow++; save(); return false; }
    if (b.entries.length >= AUDIT_ENTRIES + (reserve ? AUDIT_RESERVE : 0)) { b.overflow++; save(); return false; }
    b.entries.push({at:now(), actor, client_id, op:clean(op), outcome:clean(outcome), ...(effect == null ? {} : {effect:clean(effect)})});
    save(); return true;
  }
  // 'started' is ignored: a read's completion or failure says everything worth keeping.
  function read(key, {client_id = key, actor, op, outcome}, info) {
    if (outcome === 'started') return true;
    if (!READ_OP.test(op) || !READ_OUTCOME.test(outcome)) return false;
    const b = bucket(key, info);
    if (!b) { data.overflow++; save(); return false; }
    b.read_calls++;
    const id = op + ' ' + outcome, aggregate = Object.hasOwn(b.reads, id) ? b.reads[id] : null;
    if (aggregate) { aggregate.count++; aggregate.at = now(); }
    else if (Object.keys(b.reads).length >= READ_KEYS) { b.read_overflow++; save(); return false; }
    else b.reads[id] = {at:now(), first_at:now(), count:1, actor, client_id, op, outcome};
    save(); return true;
  }
  function room(key, slots = 1) {
    const b = data.buckets[key];
    if (!b) return slots <= AUDIT_ENTRIES && (SHARED.has(key) || clientBuckets() < AUDIT_CLIENTS);
    return b.entries.length + slots <= AUDIT_ENTRIES;
  }
  function countRefresh(key, info) {
    const b = bucket(key, info); if (!b) return;
    b.refreshes++; b.last_refresh_at = now(); save();
  }
  function migrateLegacy(entries) {
    if (data.legacy_migrated) return;
    data.legacy_migrated = true;
    if (Array.isArray(entries) && entries.length) bucket(LEGACY).entries = entries.slice(-(AUDIT_ENTRIES + AUDIT_RESERVE)).map(e => ({...e}));
    save();
  }
  function clear(key) {
    if (key === undefined) data = {version:1, buckets:{}, overflow:0, legacy_migrated:data.legacy_migrated};
    else delete data.buckets[key];
    save();
  }
  const entries = () => Object.values(data.buckets)
    .flatMap(b => [...b.entries, ...Object.values(b.reads)].map(e => ({...e, client:b.client ?? null, redirect_host:b.redirect_host ?? null})))
    .sort((a, b) => b.at - a.at);
  const buckets = () => Object.entries(data.buckets).map(([client_id, b]) => ({client_id, client:b.client ?? null, redirect_host:b.redirect_host ?? null,
    entries:b.entries.length, capacity:AUDIT_ENTRIES, overflow:b.overflow, full:b.overflow > 0 || b.entries.length >= AUDIT_ENTRIES,
    refreshes:b.refreshes, last_refresh_at:b.last_refresh_at, read_calls:b.read_calls, read_keys:Object.keys(b.reads).length, read_overflow:b.read_overflow}));
  return {record, read, room, countRefresh, migrateLegacy, clear, entries, buckets, overflow:() => data.overflow};
}
