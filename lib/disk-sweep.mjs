import fs from 'node:fs';
import path from 'node:path';
import { kitImageReport, planSweep, parseTemplateListing, parseFullImageListing, isAssembledImage, imageMatchesDigests, WATERMARK_STOP_FREE_BYTES } from './disk-sweep-plan.mjs';
import { createStoreCoordinator } from './store-lock.mjs';
import { selfTest } from './os-lock.mjs';
import { ownsImage, isCacheDir } from './disk-ownership.mjs';
import { removalEnabled } from './disk-sweep-setting.mjs';

// The effectful half of the disk sweep. It lists what exists, asks planSweep what is
// eligible, and removes exactly those items by exact identity. It never issues a broad command
// (no `sbx reset`, no `sbx prune`, no docker system prune).
//
// Ownership (see lib/disk-ownership.mjs for the rule): an item is removable only if the store's
// create path recorded it. Caches: recorded in the ledger when this app newly created the
// directory, in the app's namespace. Sandboxes: a `wf-<16 hex>` name in the cleanup journal whose
// ledger record carries the sbx id that `sbx ls` still reports. Anything else is UNKNOWN, NOT
// TOUCHED: it is counted and shown, never removed, and it never makes a removal pass fail.
//
// What a sweep can remove is exactly two classes: stopped sandboxes and cache directories that this
// app created. Images are listed, measured and planned but never removed (a removed image can be
// made again with the same identity while a slow removal command is still pending, which a sweep
// cannot rule out). Log files are measured and never changed.
//
// ONE plan serves both modes. The plan covers only owned items, qualified by the same rules the
// removal uses, so a report never names an item a removal would refuse. A sweep removes only when
// the removal setting is on (lib/disk-sweep-setting.mjs); with it off it lists, plans and
// measures, and removes nothing.
//
// Safety, in the order a removal meets it:
//   - a damaged ledger, an unreadable source of roots (retained jobs, cache state, a listing)
//     or an effect that is not proved terminal removes nothing (measuring continues). A source
//     that cannot be read is unknown, never empty;
//   - one sweep per store, across instances and processes (the sweep lock, held by the
//     kernel for as long as the process lives);
//   - every removal is decided and issued under the gate, after the whole world is read again,
//     so a create that finished since the plan cannot lose its image;
//   - a removal is written to the ledger, with the exact identity it targets, before it is
//     dispatched. The record ends when the command exited (it removed the item and a fresh listing
//     shows it gone, or it refused). A timeout, an abort or a transport error leaves the outcome
//     unknown: the record stays open for good, that command is never sent again, the identity is
//     reported as unconfirmed and never touched, and a new job never reuses its name. An unknown
//     outcome fences only its own identity. A cache directory is removed by a call inside this
//     process, so after a crash its record is closed by the next sweep, which holds the sweep lock;
//   - the gate is held until the command has ended, however the sweep is cancelled. Quit aborts
//     the run: no listing, ledger write or removal starts after the abort.

export const MAX_REMOVALS_PER_RUN = 20;
// The doctor report names at most this many kept items, each with what keeps it.
export const MAX_RETAINED_LISTED = 20;
export const REMOVE_TIMEOUT_MS = 120_000;
// Measuring a tree stops at either limit and the figure is reported as partial.
export const ACCOUNTING_MAX_ENTRIES = 20_000;
export const ACCOUNTING_MAX_MS = 1500;
const SANDBOX_NAME = /^wf-[0-9a-f]{16}$/;
const JOB_WORKSPACE = /^wf-job-wf-[0-9a-f]{16}-/;
const YIELD_EVERY = 100;

// An error that says no removal command is running: it was refused before dispatch, or it exited with a failure.
const terminal = message => Object.assign(new Error(message), { terminal: true });
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const abortError = () => Object.assign(new Error('The disk sweep was cancelled.'), { name: 'AbortError', code: 'aborted' });
const isAbort = error => error?.code === 'aborted' || error?.name === 'AbortError';

// A measuring budget: bounded entries and time, cancellable, yielding to the event loop. `failed`
// counts reads that failed for a reason other than the entry being gone; `read` counts reads that worked.
function meter({ maxEntries, maxMs, signal }) {
  const startedAt = Date.now();
  const m = { entries: 0, partial: false, failed: 0, read: 0 };
  m.step = async () => {
    signal.throwIfAborted();
    m.entries++;
    if (m.entries % YIELD_EVERY === 0) await yieldToLoop();
    if (m.entries >= maxEntries || Date.now() - startedAt > maxMs) { m.partial = true; return false; }
    return true;
  };
  return m;
}

// A directory that is not there holds nothing; one that cannot be read holds an unknown amount.
const isGone = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

async function treeBytes(directory, m) {
  let total = 0;
  let handle;
  try { handle = await fs.promises.opendir(directory); } catch (error) {
    if (isAbort(error)) throw error;
    if (!isGone(error)) m.failed++; else m.read++;
    return 0;
  }
  m.read++;
  try {
    for await (const entry of handle) {
      if (!await m.step()) return total;
      const full = path.join(directory, entry.name);
      try {
        if (entry.isDirectory()) total += await treeBytes(full, m);
        else { total += (await fs.promises.lstat(full)).size; m.read++; }
      } catch (error) { if (isAbort(error)) throw error; if (!isGone(error)) m.failed++; /* a vanished entry is not counted */ }
      if (m.partial) return total;
    }
  } catch (error) { if (isAbort(error)) throw error; m.failed++; } finally { await handle.close?.().catch(() => {}); }
  return total;
}

// bytes is null when nothing could be read, and a lower bound (partial) when some of it could not be.
async function measured(directory, options) {
  const m = meter(options);
  const bytes = await treeBytes(directory, m);
  const unreadable = m.failed > 0;
  return { bytes: unreadable && bytes === 0 ? null : bytes, partial: m.partial || unreadable };
}

// Job workspaces are measured, not removed: job retention already owns their lifetime.
async function workspaceUse(scratchRoot, options) {
  let names;
  try { names = await fs.promises.readdir(scratchRoot); } catch (error) {
    if (isAbort(error)) throw error;
    return isGone(error) ? { count: 0, bytes: 0, partial: false } : { count: null, bytes: null, partial: true };
  }
  const m = meter(options);
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!JOB_WORKSPACE.test(name)) continue;
    count++;
    if (!m.partial) bytes += await treeBytes(path.join(scratchRoot, name), m);
  }
  const unreadable = m.failed > 0;
  return { count, bytes: unreadable && bytes === 0 && count > 0 ? null : bytes, partial: m.partial || unreadable };
}

// Every child of `root`, with whether it is a plain directory. A missing root has none; any other
// read failure, or a directory larger than the entry bound, makes the answer unknown (null) rather
// than empty.
async function cacheEntries(root, { maxEntries, signal }) {
  let handle;
  try { handle = await fs.promises.opendir(root); } catch (error) { return isGone(error) ? [] : null; }
  const found = [];
  let seen = 0;
  try {
    for await (const entry of handle) {
      signal.throwIfAborted();
      if (++seen > maxEntries) return null;
      if (seen % YIELD_EVERY === 0) await yieldToLoop();
      found.push({ path: path.join(root, entry.name), name: entry.name, directory: entry.isDirectory() });
    }
  } catch (error) { if (isAbort(error) || error?.name === 'AbortError') throw error; return null; } finally { await handle.close?.().catch(() => {}); }
  return found;
}

function sandboxRows(result) {
  if (result?.code !== 0) return null;
  let rows;
  try { rows = JSON.parse(String(result.stdout || '')); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const out = [];
  const names = new Set();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name.trim() || names.has(row.name)) return null;
    names.add(row.name);
    out.push({ name: row.name, id: typeof row.id === 'string' && row.id ? row.id : null, status: typeof row.status === 'string' ? row.status : null });
  }
  return out;
}

// Present, gone, or unknown. Only a missing path (ENOENT, ENOTDIR) is gone: a path that cannot be
// read (EACCES, EIO) may still exist.
async function pathState(target) {
  try { await fs.promises.lstat(target); return 'present'; } catch (error) { return isGone(error) ? 'gone' : 'unknown'; }
}

// Is this plan item the very thing an open removal targeted?
const sameTarget = (op, item) => item.kind === op.kind && (op.kind === 'image' ? Boolean(op.imageId) && item.imageId === op.imageId
  : op.kind === 'sandbox' ? item.ref === op.ref && (!op.sandboxId || item.sandboxId === op.sandboxId)
    : item.ref === op.ref);

// Images are counted from the listing, which carries each image's size. An image with no size makes
// the total partial; when no image has a size the total is unknown (null), not zero.
function imageUse(items, listed = true) {
  if (!listed) return { count: null, listedBytes: null, partial: true };
  const sized = items.filter(item => Number.isFinite(item.bytes));
  return { count: items.length, listedBytes: items.length === 0 ? 0 : sized.length === 0 ? null : sized.reduce((sum, item) => sum + item.bytes, 0), partial: sized.length < items.length };
}

export function createDiskSweeper({ ledger, coordinator, runSbx, journal, pins, referenced, retained = () => new Set(), caches = null, usage = null,
  accounting = {}, measureFree, hostFree = measureFree, stopFreeBytes = WATERMARK_STOP_FREE_BYTES, now = Date.now, maxRemovals = MAX_REMOVALS_PER_RUN, retentionLimitBytes = null, removeEligible = removalEnabled, lockCheck = selfTest }) {
  coordinator ??= createStoreCoordinator({ dir: ledger.dir });
  // The ledger and the gate are one store: both keyed by the same sbx HOME. A sweeper built from two
  // different stores would decide under one and write under another.
  if (path.resolve(coordinator.dir) !== path.resolve(ledger.dir)) throw new Error('The disk ledger and the store gate must belong to the same sbx HOME.');
  const limits = { maxEntries: accounting.maxEntries ?? ACCOUNTING_MAX_ENTRIES, maxMs: accounting.maxMs ?? ACCOUNTING_MAX_MS };
  let running = false;
  let closed = false;
  let controller = null;
  // A removal whose command had not ended when the run was cancelled. While it is open the
  // store stays fenced (the dispatch lock is held by the removal itself), and this says so.
  let unresolved = 0;
  let lockProof = null;

  async function sweep(trigger, signal) {
    const startedAt = now();
    // Read once per run, so one sweep is either wholly a report or wholly allowed to remove.
    const wanted = typeof removeEligible === 'function' ? Boolean(removeEligible()) : Boolean(removeEligible);
    const errors = [];
    const fail = (item, message) => errors.push({ item, message: String(message) });
    // Removal needs a lock that provably excludes on this host. The proof is taken once per sweeper.
    lockProof ??= lockCheck(ledger.dir);
    const capEnabled = Number.isSafeInteger(retentionLimitBytes) && retentionLimitBytes > 0;
    const removes = (wanted || capEnabled) && lockProof.ok;
    if ((wanted || capEnabled) && !lockProof.ok)
      fail('lock', `The store lock does not work on this computer (${lockProof.reason}); nothing is removed.`);
    const guard = () => signal.throwIfAborted();
    // A read may be given up on at once when the run is cancelled. A removal is never given up
    // on: its promise is awaited to the end, so the lock around it outlives any cancellation.
    const sbx = (args, options = {}, { effect = false } = {}) => {
      guard();
      if (effect) return Promise.resolve(runSbx(args, { signal, ...options }));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(runSbx(args, { signal, ...options })).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    };
    const list = async () => parseTemplateListing(await sbx(['template', 'ls', '--json']).catch(error => { if (isAbort(error)) throw error; return { code: 1, stdout: '', stderr: String(error?.message ?? error) }; }));
    const fullImageListing = async () => {
      try {
        const result = await sbx(['template', 'ls', '--all', '--digests', '--no-trunc', '--json']);
        return parseFullImageListing(result);
      } catch (error) { if (isAbort(error)) throw error; return null; }
    };
    const imagesOverCap = async () => {
      try {
        const result = await sbx(['df', '--json']);
        if (result.code !== 0) return false;
        const images = JSON.parse(result.stdout).summaries.filter(row => row.type === 'Images');
        return images.length === 1 && Number.isSafeInteger(images[0].size) &&
          images[0].size > retentionLimitBytes;
      } catch (error) { if (isAbort(error)) throw error; return false; }
    };
    const sandboxListing = async () => sandboxRows(await sbx(['ls', '--json']).catch(error => { if (isAbort(error)) throw error; return null; }));
    // Read a source of roots. A source that throws is unknown: the caller removes nothing.
    const readSource = (name, problems, read, fallback) => {
      try { return read(); } catch (error) { if (isAbort(error)) throw error; problems.push([name, `${name} could not be read (${error?.code ?? error?.message ?? error}); nothing is removed this run`]); return fallback; }
    };

    // Everything a decision rests on, read now. Used for the plan and again before each removal.
    async function snapshot() {
      guard();
      const damaged = ledger.damaged;
      const problems = [];
      if (damaged) problems.push(['ledger', `The disk ledger is unreadable (${ledger.damage}); nothing is removed until it is repaired or deleted.`]);
      // An update may have committed a new pin generation since the last decision: roots come from the pins as they are now.
      if (!damaged) { try { ledger.notePins(pins()); } catch (error) { if (isAbort(error)) throw error; problems.push(['pins', 'The image pins could not be published; nothing is removed this run.']); } }
      const templates = await list();
      guard();
      if (!templates) problems.push(['template-listing', 'sbx template ls did not return a listing this version understands']);
      const rows = await sandboxListing();
      if (!rows) problems.push(['sandbox-listing', 'sbx ls did not return a listing (or named one sandbox twice)']);
      guard();

      const images = (templates ?? []).filter(isAssembledImage);
      const notOurs = (templates ?? []).length - images.length;
      const recordedImages = damaged ? {} : ledger.ownedImages();
      // One plan for both modes: only an image the store recorded as created is ever a candidate.
      // Every other assembled image is unknown, not touched.
      const ownedImages = images.filter(image => ownsImage(recordedImages[image.ref], image));
      const unownedImages = images.filter(image => !ownsImage(recordedImages[image.ref], image));

      const known = damaged ? {} : ledger.sandboxes();
      const live = new Set(readSource('live-jobs', problems, () => [...(referenced() ?? [])], []));
      const kept = new Set(readSource('retained-jobs', problems, () => [...(retained() ?? [])], []));
      const roots = new Set([...live, ...kept]);
      const present = new Map();
      const sandboxes = [];
      const unownedSandboxes = [];
      // Every listed sandbox that is not provably ours is unknown, whatever its name.
      let unknownSandboxes = 0;
      for (const { name, id, status } of rows ?? []) {
        present.set(name, { pin: null, status });
        if (!SANDBOX_NAME.test(name) || !journal.recorded(name)) { unknownSandboxes++; continue; }
        const record = known[name];
        present.set(name, { pin: record?.pin ?? null, status, cache: record?.cache ?? null });
        // Ours only when the store recorded this very sandbox: the id sbx lists now is the id recorded at create.
        if (record?.id && id && record.id === id) sandboxes.push({ id: `sandbox:${name}`, kind: 'sandbox', ref: name, sandboxId: id, status, createdAt: record.createdAt ?? null, bytes: null });
        else { unownedSandboxes.push(name); unknownSandboxes++; }
      }
      // A job that is live or retained roots its image even when its sandbox is gone from the listing.
      // Without a record of the pin, it may use any image.
      for (const name of roots) if (!present.has(name)) present.set(name, { pin: known[name]?.pin ?? null, status: 'absent', cache: known[name]?.cache ?? null });

      // Runtime caches. The provider is read again on every snapshot. A cache is offered only when
      // every sandbox that could mount one is known to use a different one: use that is not
      // recorded (a second process, a restart, a retained job) keeps them all.
      const cacheRoots = readSource('cache-state', problems, () => (typeof caches === 'function' ? caches() : caches), null);
      const cacheItems = [];
      // Everything in the cache directory that is not a recorded plain directory of ours is unknown:
      // an unrecorded directory, a file, a link, a name of another shape, an entry that cannot be read.
      let unknownCaches = 0;
      let cachesCounted = true;
      const cacheKeep = new Set();
      let cachesKnown = true;
      if (cacheRoots?.root) {
        const recordedCaches = damaged ? {} : ledger.ownedCaches();
        const entries = await cacheEntries(cacheRoots.root, { maxEntries: limits.maxEntries, signal });
        guard();
        if (entries === null) { cachesKnown = false; cachesCounted = false; problems.push(['cache-listing', 'The runtime cache directory could not be listed in full; no cache is removed this run.']); }
        for (const entry of entries ?? []) {
          const dir = entry.path;
          if (!isCacheDir(cacheRoots.root, dir) || !recordedCaches[dir] || !entry.directory) { unknownCaches++; continue; }
          try {
            const info = await fs.promises.lstat(dir);
            guard();
            if (!info.isDirectory()) { unknownCaches++; continue; }
            cacheItems.push({ id: `cache:${dir}`, kind: 'cache', ref: dir, root: cacheRoots.root, createdAt: info.mtimeMs, bytes: null });
          } catch (error) {
            if (isAbort(error)) throw error;
            if (!isGone(error)) { unknownCaches++; problems.push(['cache-listing', `the cache directory ${dir} could not be read (${error?.code ?? 'unknown error'})`]); }
          }
        }
        if (cacheRoots.current) cacheKeep.add(path.join(cacheRoots.root, cacheRoots.current));
        for (const sandbox of present.values()) {
          if (sandbox.cache) cacheKeep.add(sandbox.cache);
          else cachesKnown = false;
        }
      }
      const offered = cacheRoots?.offer === false || !cachesKnown ? [] : cacheItems;

      // A sandbox that is live or unresolved (in the listing, named by a job or the cleanup journal, or
      // not knowable because the listing failed) may still run on an older runtime, including after an
      // app restart that emptied this process's own memory of what it is preparing. It holds all caches.
      const cacheHold = [...new Set([...sandboxes.map(sandbox => sandbox.ref), ...unownedSandboxes, ...roots])];
      if (!rows) cacheHold.push('(the sandbox listing could not be read)');
      const owned = rows ? [...ownedImages] : [];
      owned.push(...sandboxes, ...offered);
      const pinRoots = damaged ? { current: new Set(), previous: new Set() } : ledger.pinRoots();
      const plan = planSweep({
        owned,
        observed: images,
        roots: { current: pinRoots.current, previous: pinRoots.previous, sandboxes: present, referenced: roots, cacheKeep, cacheHold },
        leases: damaged ? [] : ledger.activeLeases(),
        now: now(),
      });

      // Images are never removed by a sweep: what the plan would delete of them is kept, with the reason.
      const imageRows = plan.delete.filter(item => item.kind === 'image');
      plan.delete = plan.delete.filter(item => item.kind !== 'image');
      for (const item of imageRows) plan.keep.push({ ...item, reason: 'image_cleanup_unavailable', heldBy: 'automatic image cleanup is not part of this release' });

      // Earlier removals whose outcome is unknown. A cache removal is a call inside the process that
      // holds the sweep lock, so one left open by a process that died is over: its record is closed and
      // the directory is planned again from what it is now. Any other removal (a command to the sandbox
      // service) may still land: its record stays open for good, that command is never sent again, and the
      // identity is never touched. It fences only itself.
      const unconfirmed = [];
      if (!damaged) {
        for (const op of ledger.openOps()) {
          if (op.kind === 'cache') ledger.endOp(op.id);
          else unconfirmed.push(op);
        }
      }
      for (const op of unconfirmed) {
        const index = plan.delete.findIndex(candidate => sameTarget(op, candidate));
        if (index >= 0) {
          const [item] = plan.delete.splice(index, 1);
          plan.keep.push({ ...item, reason: 'removal_unconfirmed', heldBy: 'an earlier removal of it never reported that it finished' });
        }
      }

      const complete = problems.length === 0;
      const kitImages = kitImageReport({
        images: templates ?? [], owned: recordedImages,
        generations: damaged ? null : ledger.kitGenerations(),
        complete, sandboxes: present, leases: damaged ? [] : ledger.activeLeases(),
        unresolved: damaged || unconfirmed.length > 0, now: now(),
      });
      // Remove an image handle through the runtime. Its garbage collector owns the
      // snapshot/blob graph, including shared layers and references outside Faravan.
      if (capEnabled && complete && !damaged && present.size === 0 &&
          !unconfirmed.length && await imagesOverCap()) {
        const full = await fullImageListing();
        if (full) {
          const inventory = kitImageReport({images:full,owned:recordedImages,
            generations:ledger.kitGenerations(),complete:true,sandboxes:present,
            leases:ledger.activeLeases(),now:now()});
          const eligible = new Set(inventory.images.filter(row => row.eligible).map(row => row.imageId));
          const visited = new Set();
          for (const image of full.sort((a, b) => a.createdAt - b.createdAt)) {
            if (!eligible.has(image.imageId) || visited.has(image.imageId) ||
                now() - image.createdAt < 7 * 24 * 60 * 60 * 1000) continue;
            visited.add(image.imageId);
            plan.delete.push({...image,id:`image:${image.imageId}`});
          }
        }
      }
      // What the plan would remove if every source had been read in full: the report states it as a lower bound.
      const wouldDelete = plan.delete;
      // Nothing is removed on a snapshot with an unknown part.
      if (!complete) plan.delete = [];
      const unknown = {
        images: { count: unownedImages.length, partial: !templates, bytes: unownedImages.length === 0 ? 0 : (unownedImages.every(image => Number.isFinite(image.bytes)) ? unownedImages.reduce((sum, image) => sum + image.bytes, 0) : null) },
        sandboxes: { count: unknownSandboxes, partial: !rows },
        caches: { count: unknownCaches, partial: !cachesCounted },
        removals: { count: unconfirmed.length },
      };
      return { kitImages, damaged, complete, problems, templates, rows, images, notOurs, ownedImages, sandboxes, cacheItems, present, live: roots, plan, wouldDelete, unknown, unconfirmed };
    }

    // Issues one removal. It throws a `terminal` error only when no effect can still land: the command
    // ran to an exit code that refused, or the item was refused before dispatch. Anything else (a timeout,
    // an abort, a transport error, a command that exited 0 but left the item listed, a listing that
    // cannot be read) throws a plain error: the effect is unknown and its record stays open.
    // The last checks run here, under the gate, with no await between them and the command.
    async function remove(item, rows) {
      guard();
      // A lease written since the plan was read protects the item, whoever wrote it.
      if (ledger.activeLeases().some(lease => lease.item === item.id || lease.item === `${item.kind}:*`)) throw terminal('refusing to remove an item that a job holds');
      if (item.kind === 'sandbox') {
        if (!SANDBOX_NAME.test(item.ref)) throw terminal('refusing to remove a sandbox outside the app naming');
        // `sbx rm` takes a name only. The id is checked against the listing read under this same gate,
        // and the app never creates a name twice, so the name still means the sandbox it was recorded for.
        const recorded = ledger.sandbox(item.ref);
        const listed = rows?.find(row => row.name === item.ref);
        if (!recorded?.id || !listed || listed.id !== recorded.id || listed.status !== 'stopped') throw terminal('refusing to remove a sandbox whose recorded id is not the one listed now');
        refused(await sbx(['rm', '--force', item.ref], { timeout: REMOVE_TIMEOUT_MS }, { effect: true }));
      } else if (item.kind === 'image') {
        refused(await sbx(['template', 'rm', '--force', `sha256:${item.imageId}`],
          {timeout:REMOVE_TIMEOUT_MS}, {effect:true}));
      } else if (item.kind === 'cache') {
        if (!isCacheDir(item.root, item.ref) || !ledger.ownedCaches()[item.ref]) throw terminal('refusing to remove a path that is not a recorded cache');
        // A directory removal is synchronous in effect: it has ended when this call returns or throws.
        try { await fs.promises.rm(item.ref, { recursive: true, force: true }); } catch (error) { throw terminal(`The directory could not be removed (${error?.code ?? error?.message})`); }
      } else throw terminal('refusing to remove an item of a kind the sweep does not remove');
    }
    // A command that exited with a failure code refused: nothing is pending. A result with no exit code
    // (a timeout, a kill, a transport error) says nothing about what the daemon will still do.
    function refused(result) {
      if (result.code === 0) return;
      const message = String(result.stderr || `exit ${result.code}`).trim().slice(0, 300);
      if (result.exited === true) throw terminal(message);
      throw new Error(`The removal command did not finish cleanly (${message}); the sweep keeps the store fenced until the item is seen gone.`);
    }

    // A removal counts only when its exact identity is seen to be gone: a command that exits 0 proves nothing.
    async function verifyGone(item) {
      if (item.kind === 'sandbox') {
        const rows = await sandboxListing();
        if (!rows) throw new Error('The removal could not be verified: the sandbox listing was unreadable.');
        if (rows.some(row => row.name === item.ref && (!item.sandboxId || row.id === item.sandboxId))) throw new Error('The sandbox is still listed after the removal command succeeded.');
      } else if (item.kind === 'image') {
        const images = await fullImageListing();
        if (!images || images.some(image => image.imageId === item.imageId))
          throw new Error('The image removal could not be verified.');
      } else if (item.kind === 'cache') {
        const state = await pathState(item.ref);
        if (state === 'present') throw terminal('The directory is still there after it was removed.');
        if (state === 'unknown') throw new Error('The removal could not be verified: the directory could not be read.');
      }
    }

    // ---- before planning: records only, nothing is removed
    let damagedLedger = ledger.damaged;
    if (damagedLedger) fail('ledger', `The disk records are damaged (${ledger.damage}); they are kept as they are, and nothing is removed until they are repaired or deleted.`);
    const freeBefore = await measureFree().catch(() => null);
    guard();
    if (!damagedLedger) {
      try {
        ledger.notePins(pins());
        const templates = await list();
        if (templates) {
          guard();
          // A lease whose owner stopped renewing it is dropped: the sandbox record is the root that remains.
          // Nothing is ever attributed to an expired lease.
          const expired = ledger.expiredLeases();
          if (expired.length) ledger.dropLeases(expired.map(lease => lease.id));
          ledger.disownMissing({ images: new Set(templates.map(image => image.ref)) });
        }
      } catch (error) { if (isAbort(error)) throw error; fail('ledger', error?.message ?? error); damagedLedger = ledger.damaged; }
    }

    // ---- plan
    const first = await snapshot();
    for (const [item, message] of first.problems) if (item !== 'ledger') fail(item, message);
    guard();
    // A record is forgotten only when every source of roots was read in full.
    if (first.complete && first.rows) {
      try { ledger.forgetSandboxesExcept(new Set([...first.rows.map(row => row.name), ...first.live])); } catch (error) { if (isAbort(error)) throw error; fail('ledger', error?.message ?? error); }
    }
    const kept = {};
    for (const item of first.plan.keep) kept[item.reason] = (kept[item.reason] ?? 0) + 1;
    const candidates = first.damaged || damagedLedger ? [] : removes ? (first.complete ? first.plan.delete : []) : first.wouldDelete;

    // ---- removal: each one decided and issued alone, under the dispatch lock
    // A pressure sweep is the low half of the hysteresis: it started because free space fell
    // below the start mark, and it ends as soon as free space is back at the stop mark. It
    // reads the same measure the scheduler used to start it; a reading that fails stops it.
    // Other triggers remove every eligible item (within the work bound), because nothing is
    // short of space. Pressure never changes what is eligible.
    const toLowWater = trigger === 'pressure';
    const lowWaterFree = async () => { const free = await Promise.resolve().then(() => hostFree()).catch(() => null); return Number.isFinite(free) ? free : null; };
    const reachedStop = async () => { const free = await lowWaterFree(); return free === null || free >= stopFreeBytes; };
    let atLowWater = toLowWater && await reachedStop();
    let removed = 0;
    let attempts = 0;
    const removedItems = [];
    const gone = new Set();
    for (const item of removes ? candidates.filter(item => wanted || item.kind === 'image') : []) {
      // Bounded work: what is left waits for the next run.
      if (atLowWater && item.kind !== 'image') { kept.stopped_at_low_water = (kept.stopped_at_low_water ?? 0) + 1; continue; }
      if (attempts >= maxRemovals) { kept.deferred_bounded_work = (kept.deferred_bounded_work ?? 0) + 1; continue; }
      attempts++;
      try {
        const outcome = await coordinator.exclusive(async ({ held }) => {
          const again = await snapshot();
          const still = again.complete && !again.damaged && again.plan.delete.find(candidate => candidate.id === item.id);
          if (!still) return 'changed';
          guard();
          // If the lock helper stopped, the lock is gone with it: nothing is dispatched.
          if (!held()) throw new Error('The store lock was lost; nothing is removed.');
          // Written before the command is dispatched, with the exact identity it targets. It is closed
          // only when the command ended: it removed the item and a fresh listing shows it gone, or it
          // refused. Anything else leaves it open for good, and that identity is never sent again.
          const op = ledger.beginOp({ kind: still.kind, ref: still.ref, imageId: still.imageId ?? null, sandboxId: still.sandboxId ?? null });
          unresolved++;
          try {
            await remove(still, again.rows);
            await verifyGone(still);
            ledger.endOp(op);
          } catch (error) {
            // A refusal means no effect is pending. Anything else (a timeout, a thrown error, an abort, a
            // command that exited 0 but left the item listed, an unreadable listing) leaves the record open.
            if (error?.terminal) { try { ledger.endOp(op); } catch { /* it stays open */ } }
            throw error;
          } finally { unresolved--; }
          return 'removed';
        }, { signal });
        guard();
        if (outcome === 'removed') {
          gone.add(item.id); removed++; removedItems.push(item);
          // Every sweep reads free space again after a removal; only a pressure sweep stops on it.
          if (toLowWater) atLowWater = await reachedStop(); else await lowWaterFree();
        } else { attempts--; kept.changed_before_removal = (kept.changed_before_removal ?? 0) + 1; }
      } catch (error) {
        if (isAbort(error)) throw error;
        fail(item.ref, error?.code === 'store_busy' ? 'The sandbox store was busy; the next sweep tries again.' : (error?.message ?? error));
      }
    }

    guard();
    // The change in free space on the store's drive, read again after every effect (removals), not taken from the sizes the plan listed: removing an image reference may free
    // nothing (shared layers, a guest disk that does not shrink), and other writers on the drive
    // move the figure too, so it is a net change, not what the sweep alone freed. It stays null
    // when either reading failed: unknown is not zero.
    const freeAfter = removed > 0 ? await measureFree().catch(() => null) : freeBefore;
    // A report removed nothing, so there is nothing to measure: the figure is absent, not zero.
    const reclaimedBytes = removes && Number.isFinite(freeBefore) && Number.isFinite(freeAfter) ? freeAfter - freeBefore : null;
    // What the plan expects to free. Removing: the sizes of what was removed. Reporting: every item
    // the plan names. An item without a size makes the figure partial; no item with a size makes it unknown.
    const counted = removes ? removedItems : candidates;
    const sized = counted.filter(item => Number.isFinite(item.bytes));
    // A listing that failed names nothing, which is not the same as nothing to free: the figure is then a
    // lower bound (partial), or unknown when there is nothing to count.
    const listingsComplete = first.complete;
    const expectedPartial = sized.length < counted.length || !listingsComplete;
    const expectedBytes = counted.length === 0 ? (listingsComplete ? 0 : null)
      : sized.length > 0 ? sized.reduce((sum, item) => sum + item.bytes, 0) : null;
    const left = items => items.filter(item => !gone.has(item.id));
    // What keeps each kept item, so the doctor report can name it. Items held by a root or lease come first.
    const keptItems = first.plan.keep.map(item => ({ kind: item.kind, ref: item.ref, reason: item.reason, heldBy: item.heldBy ?? null }));
    const keptList = [...keptItems.filter(item => item.heldBy), ...keptItems.filter(item => !item.heldBy)].slice(0, MAX_RETAINED_LISTED);
    const budget = { ...limits, signal };
    const categories = {
      images: imageUse(left(first.images), Boolean(first.templates)),
      sandboxes: { count: first.rows ? left(first.sandboxes).length : null },
      workspaces: usage?.scratchRoot ? await workspaceUse(usage.scratchRoot, budget) : null,
      logs: usage?.logsDir ? await measured(usage.logsDir, budget) : null,
      caches: usage?.cacheRoot ? await measured(usage.cacheRoot, budget) : null,
    };
    guard();
    const summary = {
      at: startedAt,
      trigger,
      durationMs: Math.max(0, now() - startedAt),
      scanned: { images: first.images.length, sandboxes: first.sandboxes.length, caches: first.cacheItems.length, notOurs: first.notOurs },
      eligible: candidates.length,
      removed,
      removes,
      expectedBytes,
      expectedPartial,
      listingsComplete,
      storeFreeBytes: Number.isFinite(freeBefore) ? freeBefore : null,
      reclaimedBytes,
      kept,
      retained: keptList,
      retainedTotal: keptItems.length,
      // Entries the store protocol did not create, or cannot prove it created. Counted, never removed.
      notTouched: { images: first.unknown.images, sandboxes: first.unknown.sandboxes, caches: first.unknown.caches, removals: first.unknown.removals },
      categories,
      kitImages: first.kitImages,
      errors,
    };
    try { ledger.recordSweep(summary); } catch (error) { if (!damagedLedger) fail('ledger', error?.message ?? error); }
    return summary;
  }

  return {
    get running() { return running; },
    get closed() { return closed; },
    // `unresolved`: removals issued by a cancelled run whose command had not ended yet.
    get unresolved() { return unresolved; },
    status() { return { running, unresolved, last: ledger.lastSweep() }; },
    // Cancels the run in flight and refuses new ones. Used by Quit. A removal already issued is
    // not cut short: the store stays fenced until it ends (see `unresolved`).
    abort() {
      closed = true;
      controller?.abort(abortError());
    },
    async run({ trigger }) {
      if (closed) return { skipped: 'closed' };
      if (running) return { skipped: 'busy' };
      running = true;
      controller = new AbortController();
      const { signal } = controller;
      try {
        const outcome = await coordinator.sweep(() => sweep(trigger, signal));
        return outcome;
      } catch (error) {
        if (isAbort(error)) return { aborted: true, unresolved };
        throw error;
      } finally { running = false; controller = null; }
    },
  };
}
