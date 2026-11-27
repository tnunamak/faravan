import {durableJsonAsync} from '../durable-write.mjs';
// Viewer-local petnames: a private label this person chose for one exact member key in one exact
// circle. Stored in its own file under the app state directory; never sent to a coordinator, never
// placed in a signed object, never inferred from a remote name. A different key, circle or root is a
// different record, so a label is never inherited.
import {readFile, rename} from 'node:fs/promises';


const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PETNAME = 64, MAX_PETNAMES = 4096;
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };

/** NFC, trimmed, 1..64 characters, no control, format (bidi, zero-width) or line/paragraph separators. */
export function normalizePetname(value) {
  if (typeof value !== 'string') fail('invalid_petname');
  const label = value.normalize('NFC').trim();
  if (!label || [...label].length > MAX_PETNAME || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) fail('invalid_petname');
  return label;
}
/** Comparison key for collisions only; never stored as the label and never an identity. */
export const petnameFold = label => label.toUpperCase().toLowerCase().normalize('NFC');
function scope(input) {
  if (!DIGEST.test(input?.root ?? '') || !UUID.test(input?.circle ?? '')) fail('invalid_request');
  return { root: input.root, circle: input.circle };
}
function exact(input) {
  const s = scope(input);
  if (!DIGEST.test(input.key ?? '')) fail('invalid_request');
  return { ...s, key: input.key };
}
const same = (a, b) => a.root === b.root && a.circle === b.circle && a.key === b.key;
const record = r => ({ key: r.key, label: r.label, revision: r.revision, createdAt: r.createdAt, updatedAt: r.updatedAt });
const valid = r => r && typeof r === 'object' && DIGEST.test(r.root) && UUID.test(r.circle) && DIGEST.test(r.key) &&
  typeof r.label === 'string' && Number.isSafeInteger(r.revision) && typeof r.createdAt === 'string' && typeof r.updatedAt === 'string';

async function write(file, value) {
  await durableJsonAsync(file,value);
}

/** `file` is the petname JSON file; `now` returns epoch milliseconds. Writes run one at a time. */
export function createPetnameStore(file, { now = Date.now } = {}) {
  let chain = Promise.resolve();
  // A missing, unreadable or malformed file reads as empty; `corrupt` lets a save keep the bad bytes aside.
  async function load() {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { return { records: [], corrupt: error.code !== 'ENOENT' }; }
    try {
      const value = JSON.parse(text);
      if (value?.version !== 1 || !Array.isArray(value.records)) return { records: [], corrupt: true };
      return { records: value.records.filter(valid), corrupt: false };
    } catch { return { records: [], corrupt: true }; }
  }
  const mutate = change => {
    const next = chain.then(async () => {
      const state = await load(), result = change(state.records);
      if (state.corrupt) await rename(file, file + '.corrupt-' + now()).catch(() => {});
      await write(file, { version: 1, records: state.records });
      return result;
    });
    chain = next.catch(() => {});
    return next;
  };
  return {
    async get(input) {
      await chain;
      const key = exact(input), found = (await load()).records.find(r => same(r, key));
      return found ? record(found) : null;
    },
    /** Records for one pinned root and circle only. */
    async list(input) {
      const s = scope(input);
      return (await load()).records.filter(r => r.root === s.root && r.circle === s.circle).map(record);
    },
    /** Explicit save. A changed label bumps the revision; the same label is a no-op. */
    async save(input, label) {
      const key = exact(input), clean = normalizePetname(label), folded = petnameFold(clean);
      return mutate(records => {
        if (records.some(r => r.root === key.root && r.circle === key.circle && r.key !== key.key && petnameFold(r.label) === folded))
          fail('petname_label_taken', 409);
        const at = new Date(now()).toISOString(), found = records.find(r => same(r, key));
        if (!found && records.length >= MAX_PETNAMES) fail('petname_store_full', 409);
        if (!found) { const created = { ...key, label: clean, revision: 1, createdAt: at, updatedAt: at }; records.push(created); return record(created); }
        if (found.label !== clean) Object.assign(found, { label: clean, revision: found.revision + 1, updatedAt: at });
        return record(found);
      });
    },
    async delete(input) {
      const key = exact(input);
      return mutate(records => { const i = records.findIndex(r => same(r, key)); if (i >= 0) records.splice(i, 1); return i >= 0; });
    },
  };
}
