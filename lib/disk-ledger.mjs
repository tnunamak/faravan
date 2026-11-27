import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableJson } from './durable-write.mjs';
import { withFileLockSync } from './store-lock.mjs';

// What the app remembers about the disk it causes sbx to use. The file is the truth, not
// this object: every call reads it again and every change is a locked read-modify-write, so
// the app, the doctor command and a second instance see each other's leases and records.
// The file lives in the sbx HOME it describes (lib/disk-store.mjs), so every process and every
// profile that uses that HOME reads and writes the same record.
//
//   leases      what a running job holds for its whole run: item = its sandbox id, `pin` = the
//               image digest the sandbox came from. A second lease, item = `cache:<directory>`,
//               holds the exact runtime directory the job will mount, taken before the directory
//               is obtained or reused. Leases are renewed while the job runs and released when it
//               ends; if the process dies they expire and the ordinary roots (the sandbox record)
//               take over.
//   owned       the images and caches the app may remove, each recorded as `created` with the
//               exact image id it was made as (lib/disk-ownership.mjs). Nothing is adopted.
//   sandboxes   the sandboxes the app made, with the image pin and runtime cache each uses and,
//               once the create is attributed, the sbx id. A record without an id roots its
//               image and cache but does not let the sweep remove the sandbox.
//   pins        the pins of this release and of the release before (rollback roots).
//   ops         removals the sweep has issued whose effect is not proved terminal. A removal is
//               written here before it is dispatched, with the exact identity it targets, and
//               cleared only when a fresh listing proves that identity absent, or when the
//               command itself refused. Nothing expires it by age (lib/disk-sweep.mjs).
//
// Version 3. A version 2 file (the first release of the sweep) is migrated under the lock: its
// leases, sandbox records, pins and last sweep are kept as roots, and what it recorded as owned
// or adopted is dropped, because that ownership was never proved (`migrateV2`).
//
// Every field is checked on every read (validateLedger). A file that fails the check, or
// cannot be read, is DAMAGED: it is never rewritten, reset or filled with defaults, and the
// sweep removes nothing while it is damaged (lib/disk-sweep.mjs).

export const LEDGER_VERSION = 3;
const VERSION = LEDGER_VERSION;
const EMPTY = () => ({
  version: VERSION, leases: {}, sandboxes: {}, pins: { current: [], previous: [] }, lastSweep: null,
  owned: { images: {}, caches: {} }, ops: {},
});

const DIGEST = /^[0-9a-f]{64}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => Number.isFinite(value);
const isNullableString = value => value === null || typeof value === 'string';
const isOptional = (value, check) => value === undefined || value === null || check(value);
const isCount = value => Number.isFinite(value) && value >= 0;
const isDate = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const isDigestList = value => Array.isArray(value) && value.every(item => typeof item === 'string');

// One use record of a sweep category: the readers show `count` and the sizes, and `partial` marks a
// lower bound. A figure that could not be read is null; one that an older version never wrote is absent.
function categoryProblem(name, record, { counted = false, required = false } = {}) {
  if (record === undefined || record === null) return required ? `last sweep category ${name} is missing` : null;
  if (!isObject(record)) return `last sweep category ${name} is not a record`;
  if (counted && required && !(record.count === null || isCount(record.count))) return `last sweep category ${name} has a bad count`;
  if (counted && !isOptional(record.count, isCount)) return `last sweep category ${name} has a bad count`;
  for (const key of ['bytes', 'listedBytes']) if (!isOptional(record[key], isCount)) return `last sweep category ${name} has a bad size`;
  if (!isOptional(record.partial, value => typeof value === 'boolean')) return `last sweep category ${name} has a bad partial flag`;
  return null;
}

// What the status and doctor readers use from the last sweep. A summary an older version wrote may
// lack the newer fields (`removes`, `expectedBytes`, `retained`, partial flags); those stay valid when
// absent. A field that is present must have the type its reader needs.
export function sweepProblem(sweep) {
  if (sweep === null) return null;
  if (!isObject(sweep)) return 'lastSweep is not a record';
  if (!isDate(sweep.at)) return 'lastSweep has no valid time';
  if (!isOptional(sweep.trigger, value => typeof value === 'string')) return 'lastSweep trigger is not text';
  for (const key of ['eligible', 'removed', 'retainedTotal', 'logsRotated']) if (!isOptional(sweep[key], isCount)) return `lastSweep ${key} is not a number`;
  for (const key of ['expectedBytes', 'listedBytes', 'reclaimedBytes', 'storeFreeBytes']) if (!isOptional(sweep[key], Number.isFinite)) return `lastSweep ${key} is not a number`;
  for (const key of ['removes', 'expectedPartial', 'listingsComplete']) if (!isOptional(sweep[key], value => typeof value === 'boolean')) return `lastSweep ${key} is not a flag`;
  if (!isOptional(sweep.kept, value => isObject(value) && Object.values(value).every(isCount))) return 'lastSweep kept is not a map of counts';
  if (!isOptional(sweep.retained, value => Array.isArray(value) && value.every(item => isObject(item) && typeof item.kind === 'string' && typeof item.ref === 'string'
    && typeof item.reason === 'string' && isNullableString(item.heldBy ?? null)))) return 'lastSweep retained is malformed';
  if (!isOptional(sweep.errors, value => Array.isArray(value) && value.every(item => isObject(item) && typeof item.item === 'string' && typeof item.message === 'string'))) return 'lastSweep errors is malformed';
  if (sweep.kitImages !== undefined) {
    const kit = sweep.kitImages;
    if (!isObject(kit) || kit.reportOnly !== true || typeof kit.mappingKnown !== 'boolean' || typeof kit.complete !== 'boolean'
      || !isCount(kit.eligible) || !(kit.listedBytes === null || isCount(kit.listedBytes)) || !Array.isArray(kit.images)
      || !kit.images.every(row => isObject(row) && typeof row.ref === 'string' && isNullableString(row.imageId)
        && (row.bytes === null || isCount(row.bytes)) && typeof row.eligible === 'boolean' && typeof row.reason === 'string'))
      return 'lastSweep kit images are malformed';
  }
  const touch = sweep.notTouched;
  if (touch !== undefined && touch !== null) {
    if (!isObject(touch)) return 'lastSweep notTouched is not a record';
    for (const [kind, row] of Object.entries(touch)) {
      if (!isObject(row) || !isOptional(row.count, isCount) || !isOptional(row.bytes, isCount)) return `lastSweep notTouched ${kind} is malformed`;
    }
  }
  const { categories } = sweep;
  if (categories !== undefined && categories !== null) {
    if (!isObject(categories)) return 'lastSweep categories is not a record';
    return categoryProblem('images', categories.images, { counted: true, required: true })
      ?? categoryProblem('sandboxes', categories.sandboxes, { counted: true, required: true })
      ?? categoryProblem('workspaces', categories.workspaces, { counted: true })
      ?? categoryProblem('logs', categories.logs)
      ?? categoryProblem('caches', categories.caches);
  }
  return null;
}

const isPin = value => typeof value === 'string' && DIGEST.test(value);
const pinList = value => Array.isArray(value) && value.every(isPin);
const mapOf = (value, ok) => isObject(value) && Object.entries(value).every(([key, row]) => ok(key, row));

const pinKey = values => JSON.stringify([...new Set(values)].sort());
function rotatePins(state, digests) {
  const next = [...new Set(digests)].sort();
  if (!next.length) return;
  if (pinKey(next) === pinKey(state.pins.current)) {
    state.kitGenerations ??= { current: null, previous: null };
    state.kitGenerations.current ??= { digests: next, images: [] };
    return;
  }
  state.kitGenerations = { current: { digests: next, images: [] }, previous: state.kitGenerations?.current ?? null };
  state.pins = { current: next, previous: state.pins.current };
}
function unknownKitGenerations(state) {
  for (const generation of Object.values(state.kitGenerations ?? {})) if (generation) generation.unknown = true;
}

// The complete persisted schema. Returns the first problem, or null when every field is well formed.
export function validateLedger(state) {
  if (!isObject(state)) return 'the ledger is not an object';
  if (state.version !== VERSION) return `unsupported ledger version ${state.version}`;
  if (!mapOf(state.leases, (key, row) => isObject(row) && row.id === key && typeof row.item === 'string' && isTime(row.startedAt) && isTime(row.expiresAt)
    && (row.agent === null || typeof row.agent === 'string') && (row.pin === null || isPin(row.pin)))) return 'leases are malformed';
  if (!mapOf(state.sandboxes, (key, row) => isObject(row) && (row.pin === null || isPin(row.pin)) && isTime(row.createdAt)
    && (row.id === undefined || row.id === null || typeof row.id === 'string')
    && (row.cache === null || row.cache === undefined || typeof row.cache === 'string'))) return 'sandbox records are malformed';
  if (!isObject(state.pins) || !pinList(state.pins.current) || !pinList(state.pins.previous)) return 'pins are malformed';
  if (state.kitGenerations !== undefined) {
    const valid = row => row === null || (isObject(row) && pinList(row.digests) && Array.isArray(row.images)
      && (row.unknown === undefined || typeof row.unknown === 'boolean') && row.images.every(image => isObject(image) && typeof image.ref === 'string' && typeof image.imageId === 'string'
        && image.imageId.length > 0 && isPin(image.inputDigest) && row.digests.includes(image.inputDigest) && isTime(image.at)));
    if (!isObject(state.kitGenerations) || !valid(state.kitGenerations.current) || !valid(state.kitGenerations.previous))
      return 'kit image records are malformed';

  }
  { const issue = sweepProblem(state.lastSweep); if (issue) return issue; }
  if (!isObject(state.owned)) return 'owned is malformed';
  if (!mapOf(state.owned.images, (key, row) => isObject(row) && (row.imageId === null || typeof row.imageId === 'string') && typeof row.reason === 'string' && isTime(row.at))) return 'owned images are malformed';
  if (!mapOf(state.owned.caches, (key, row) => isObject(row) && typeof row.reason === 'string' && isTime(row.at))) return 'owned caches are malformed';
  if (!mapOf(state.ops, (key, row) => isObject(row) && row.id === key && ['image', 'sandbox', 'cache'].includes(row.kind) && typeof row.ref === 'string' && isTime(row.startedAt)
    && (row.imageId === null || row.imageId === undefined || typeof row.imageId === 'string')
    && (row.sandboxId === null || row.sandboxId === undefined || typeof row.sandboxId === 'string'))) return 'operation records are malformed';
  return null;
}

// The report readers (status, doctor) apply the same test under its earlier name.
export const ledgerProblem = validateLedger;

// A parsed file as a version-3 state, or the first problem. A version 2 file is read as the
// state a migration would write: its roots are kept, what it recorded as owned or adopted is not
// (that ownership was never proved), and the sandbox records carry no id, so they root their
// image and cache without making the sandbox removable.
export function upgradeLedger(parsed) {
  if (isObject(parsed) && parsed.version === 2) {
    const sandboxes = isObject(parsed.sandboxes)
      ? Object.fromEntries(Object.entries(parsed.sandboxes).map(([name, row]) => [name, isObject(row) ? { ...row, id: null } : row]))
      : parsed.sandboxes;
    const leases = isObject(parsed.leases)
      ? Object.fromEntries(Object.entries(parsed.leases).map(([id, row]) => { if (isObject(row)) { const { before, ...rest } = row; return [id, rest]; } return [id, row]; }))
      : parsed.leases;
    const state = { version: VERSION, leases, sandboxes, pins: parsed.pins, lastSweep: parsed.lastSweep ?? null, owned: { images: {}, caches: {} }, ops: isObject(parsed.ops) ? parsed.ops : {} };
    const problem = validateLedger(state);
    return problem ? { problem } : { state, migrated: true };
  }
  const problem = validateLedger(parsed);
  if (problem) return { problem };
  // An older app rotates pins but preserves unknown fields. Stale optional
  // reporting history must not poison ownership, leases or sandbox records.
  if (parsed.kitGenerations) {
    const generations = { ...parsed.kitGenerations };
    for (const which of ['current', 'previous']) {
      const row = generations[which];
      if (row && pinKey(row.digests) !== pinKey(parsed.pins[which])) generations[which] = null;
    }
    return { state: { ...parsed, kitGenerations: generations }, migrated: false };
  }
  return { state: parsed, migrated: false };
}

// `legacyFile` is where an earlier release kept the same record, in the profile directory. It is
// read, never changed, and used only while `file` does not exist yet: the first change then writes
// the migrated record to `file`, under the lock.
export function createDiskLedger({ file, legacyFile = null, now = Date.now } = {}) {
  let damaged = false;
  let damage = null;

  function legacyState() {
    if (!legacyFile || legacyFile === file) return EMPTY();
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { return EMPTY(); }
    // An unreadable earlier record has no roots to keep, and it never granted ownership.
    return upgradeLedger(parsed).state ?? EMPTY();
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { state, problem } = upgradeLedger(parsed);
      if (problem) throw new Error(problem);
      damaged = false; damage = null;
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') { damaged = false; damage = null; return legacyState(); }
      damaged = true; damage = String(error?.message ?? error);
      return null;
    }
  }

  // Locked read-modify-write. A damaged ledger is not written.
  function update(fn) {
    return withFileLockSync(`${file}.lock`, () => {
      const state = load();
      if (!state) throw Object.assign(new Error(`The disk ledger is damaged (${damage}).`), { code: 'ledger_damaged' });
      const result = fn(state);
      durableJson(file, state);
      return result;
    });
  }
  // A damaged ledger has no readable content: reading it is an error, never an empty answer.
  const read = () => load() ?? (() => { throw Object.assign(new Error(`The disk ledger is damaged (${damage}).`), { code: 'ledger_damaged' }); })();
  const sandboxRow = row => ({ pin: row.pin, createdAt: row.createdAt, cache: row.cache ?? null, id: row.id ?? null });

  function recordKitImages(state, digests, inputDigest, images) {
    if (!pinList(digests) || !digests.length) { unknownKitGenerations(state); return; }
        const key = values => JSON.stringify([...new Set(values)].sort());
        // A concurrent release may have rotated the roots. Never attach to the wrong one.
        const generation = [state.kitGenerations?.current, state.kitGenerations?.previous]
          .find(row => row && key(row.digests) === key(digests));
        if (!generation) { unknownKitGenerations(state); return; }
        if (!isPin(inputDigest) || !digests.includes(inputDigest) || images.length === 0) { generation.unknown = true; return; }
        for (const { ref, imageId } of images) {
          const owned = state.owned.images[ref];
          if (!owned || owned.imageId !== imageId) continue;
          if (!generation.images.some(row => row.ref === ref && row.imageId === imageId && row.inputDigest === inputDigest))
            generation.images.push({ ref, imageId, inputDigest, at: now() });
        }
  }

  return {
    file,
    get dir() { return path.dirname(file); },
    // Reads the file now, so the answer is current for every process.
    get damaged() { load(); return damaged; },
    get damage() { load(); return damage; },

    // A lease names what a running job holds. Renew it while the job runs; release it when the job ends.
    acquireLease({ item, ttlMs, agent = null, pin = null }) {
      const id = randomUUID();
      const t = now();
      update(state => { state.leases[id] = { id, item, startedAt: t, expiresAt: t + ttlMs, agent, pin }; });
      return id;
    },
    renewLease(id, ttlMs) {
      return update(state => {
        // A lease that has run out is not revived: its holder must be admitted again under the gate.
        if (!(state.leases[id]?.expiresAt > now())) return false;
        state.leases[id].expiresAt = now() + ttlMs;
        return true;
      });
    },
    releaseLease(id) {
      update(state => { delete state.leases[id]; });
    },
    activeLeases() {
      const t = now();
      return Object.values(read().leases).filter(lease => lease.expiresAt > t);
    },
    // Leases whose owner stopped renewing them. The sweep drops them; the sandbox record is the root that remains.
    expiredLeases() {
      const t = now();
      return Object.values(read().leases).filter(lease => !(lease.expiresAt > t));
    },
    dropLeases(ids) {
      update(state => { for (const id of ids) delete state.leases[id]; });
    },

    // `id` is the sbx id read from the listing while the create was held; without it the record
    // still roots the image and the cache, but the sweep will not remove the sandbox.
    recordSandbox(name, { pin, cache = null, id = null }) {
      update(state => { state.sandboxes[name] = { pin: pin ?? null, createdAt: now(), cache, id }; });
    },
    sandbox(name) {
      const row = read().sandboxes[name];
      return row ? sandboxRow(row) : null;
    },
    sandboxes() {
      return Object.fromEntries(Object.entries(read().sandboxes).map(([name, row]) => [name, sandboxRow(row)]));
    },
    // Records stay while the sandbox exists or any live or retained job still refers to it.
    forgetSandboxesExcept(keep) {
      update(state => { for (const name of Object.keys(state.sandboxes)) if (!keep.has(name)) delete state.sandboxes[name]; });
    },

    // Pins shipped by this release are `current`; those of the release before are
    // `previous` and stay as rollback roots. A third release drops the oldest.
    notePins(digests) {
      if (!pinList(digests) || !digests.length) return;
      update(state => rotatePins(state, digests));
    },
    pinRoots() {
      const { pins } = read();
      return { current: new Set(pins.current), previous: new Set(pins.previous) };
    },

    // Missing records in older ledgers are unknown, never an empty verified mapping.
    kitGenerations() { return read().kitGenerations ?? null; },
    recordKitImages(digests, inputDigest, images) {
      update(state => recordKitImages(state, digests, inputDigest, images));
    },
    ownedImages() { return read().owned.images; },
    ownedCaches() { return read().owned.caches; },
    ownImages(entries, reason, generation = null) {
      if (entries.length === 0) return;
      const at = now();
      update(state => {
        // Only fresh rows from a validated combined attribution receive provenance.
        // Never stamp an old writer's row merely because a later caller sees it.
        const inputDigest = generation && pinList(generation.digests) && isPin(generation.inputDigest)
          && generation.digests.includes(generation.inputDigest) ? generation.inputDigest : null;
        for (const { ref, imageId = null } of entries) state.owned.images[ref] ??= {
          imageId, reason, at, ...(inputDigest ? { kitInputDigest: inputDigest } : {}),
        };
        // Ownership and generation attribution commit in the same durable write.
        if (generation && pinList(generation.digests) && generation.digests.length) {
          rotatePins(state, generation.digests);
          recordKitImages(state, generation.digests, generation.inputDigest, entries);
        } else unknownKitGenerations(state);
      });
    },
    ownCache(dir, reason) {
      const at = now();
      update(state => { state.owned.caches[dir] ??= { reason, at }; });
    },
    // A record for something that no longer exists is dropped; only a complete listing may call this.
    disownMissing({ images, caches }) {
      update(state => {
        if (images) for (const ref of Object.keys(state.owned.images)) if (!images.has(ref)) delete state.owned.images[ref];
        if (caches) for (const dir of Object.keys(state.owned.caches)) if (!caches.has(dir)) delete state.owned.caches[dir];
      });
    },
    // Removals whose effect is not proved terminal. beginOp is written before the removal is
    // dispatched, with the exact identity it targets (an image id, a sandbox id, a cache path);
    // endOp when a fresh listing proves that identity absent or the command itself refused.
    beginOp({ kind, ref, imageId = null, sandboxId = null }) {
      const id = randomUUID();
      update(state => { state.ops[id] = { id, kind, ref, imageId, sandboxId, startedAt: now() }; });
      return id;
    },
    endOp(id) { update(state => { delete state.ops[id]; }); },
    openOps() { return Object.values(read().ops); },

    recordSweep(summary) {
      update(state => {
        // A summary the readers could not use is refused, so the ledger never damages itself.
        const problem = sweepProblem(summary);
        if (problem) throw new Error(`The sweep summary is malformed (${problem}).`);
        state.lastSweep = summary;
      });
    },
    lastSweep() { return load()?.lastSweep ?? null; },
    sweepSnapshot() {
      const state = load();
      return { lastSweep: state?.lastSweep ?? null, damage };
    },
  };
}
