// Pure decisions for the disk sweep. Nothing here reads a disk, runs a command or tells the time.
//
// An item may be removed only when all three hold: the app owns it (it is in
// `owned`, which comes from the ledger), nothing roots it, and no live lease
// covers it. Disk pressure never appears here: pressure decides WHEN to sweep
// (see watermarkStep), never WHAT is eligible.

const MINUTE = 60 * 1000;
const GiB = 1024 ** 3;

// Second guard behind the leases: an image newer than this is never removed.
export const SWEEP_MIN_AGE_MS = 30 * MINUTE;
// A stopped sandbox must be older than this before it counts as an orphan.
export const SANDBOX_MIN_AGE_MS = 2 * 60 * MINUTE;
// Collect when free space drops below the start mark; stop only at the stop mark.
export const WATERMARK_START_FREE_BYTES = 10 * GiB;
export const WATERMARK_STOP_FREE_BYTES = 20 * GiB;

// The one repository sbx assembles the app's agent images into. Exact match only: a repository
// that merely ends in this name, on another registry, is somebody else's.
export const ASSEMBLED_REPOSITORY = 'docker.io/library/sandbox-kit-assembled';

const DIGEST_REF = /@sha256:([0-9a-f]{64})$/;
const HEX = /^[0-9a-f]+$/;

export function digestHex(ref) {
  const match = typeof ref === 'string' ? DIGEST_REF.exec(ref) : null;
  return match ? match[1] : null;
}

// An sbx image id is the first 12 hex characters of the OCI index digest it was
// assembled from. true: matches one digest; false: matches none; null: the id is
// too short or malformed to tell, so the caller must keep the item.
export function imageMatchesDigests(imageId, digests) {
  if (typeof imageId !== 'string') return null;
  const id = imageId.replace(/^sha256:/, '').toLowerCase();
  if (id.length < 12 || id.length > 64 || !HEX.test(id)) return null;
  for (const digest of digests) if (typeof digest === 'string' && digest.startsWith(id)) return true;
  return false;
}

// The reason an unexpired lease covers this item, or null. A lease ends at its expiry.
// A running job holds one lease on its sandbox (item = the sandbox id) that also carries the
// image pin the sandbox was made from, so the same lease covers the image for the whole run.
export function leaseCovers(item, leases, now) {
  return coveringLease(item, leases, now)?.reason ?? null;
}

// The unexpired lease that covers an item, with the reason, or null. A create-in-flight lease wins.
function coveringLease(item, leases, now) {
  let named = null;
  for (const lease of leases) {
    if (!(Number(lease?.expiresAt) > now)) continue;
    if (lease.item === `${item.kind}:*`) return { reason: 'create_in_flight', lease };
    if (!named && (lease.item === item.id || (item.kind === 'image' && lease.pin && imageMatchesDigests(item.imageId, [lease.pin]) === true))) named = lease;
  }
  return named ? { reason: 'leased', lease: named } : null;
}

// Plain words for what keeps an item, shown in the doctor report.
const sandboxNameOf = id => String(id ?? '').replace(/^sandbox:/, '');
const nameList = names => {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
};

// -> [verdict, reason, heldBy]. heldBy says in plain words what keeps the item, or null when
// nothing but the rule itself does (too new, identity or age unknown).
function classify(item, { roots, leases, now, mappingVerified }) {
  const covering = coveringLease(item, leases, now);
  if (covering) {
    const { lease } = covering;
    const heldBy = covering.reason === 'create_in_flight' ? 'a create in progress'
      : lease.item === item.id ? `a job lease on ${sandboxNameOf(item.id)}`
        : `a job lease from ${lease.item?.startsWith('sandbox:') ? `sandbox ${sandboxNameOf(lease.item)}` : String(lease.item)}`;
    return ['keep', covering.reason, heldBy];
  }
  const age = Number.isFinite(item.createdAt) ? now - item.createdAt : null;
  if (item.kind === 'image') {
    if (imageMatchesDigests(item.imageId, roots.current) === null) return ['keep', 'identity_unknown'];
    // Image ids are read as the head of the index digest the image was assembled from. That is
    // observed, not documented. Unless at least one image in this listing matches a digest we
    // know is in use, the reading is unconfirmed for this sbx version and nothing is removed.
    if (!mappingVerified) return ['keep', 'mapping_unverified'];
    if (imageMatchesDigests(item.imageId, roots.current)) return ['keep', 'current_pin', 'it is the current image'];
    if (imageMatchesDigests(item.imageId, roots.previous)) return ['keep', 'previous_pin', 'it is the previous image, kept for rollback'];
    const unpinned = [...roots.sandboxes].filter(([, sandbox]) => !sandbox.pin).map(([name]) => name);
    if (unpinned.length) return ['keep', 'sandbox_of_unknown_image', `sandbox ${nameList(unpinned)} (it may use any image)`];
    const users = [...roots.sandboxes].filter(([, sandbox]) => imageMatchesDigests(item.imageId, [sandbox.pin])).map(([name]) => name);
    if (users.length) return ['keep', 'used_by_sandbox', `sandbox ${nameList(users)} uses it`];
    if (age === null) return ['keep', 'age_unknown'];
    if (age < SWEEP_MIN_AGE_MS) return ['keep', 'too_new'];
    return ['delete', 'unreachable'];
  }
  if (item.kind === 'sandbox') {
    if (item.status === 'running') return ['keep', 'running', 'it is running'];
    if (item.status !== 'stopped') return ['keep', 'status_unknown'];
    if (roots.referenced.has(item.ref)) return ['keep', 'referenced_by_job_or_journal', 'a job or the cleanup journal names it'];
    if (age === null) return ['keep', 'age_unknown'];
    if (age < SANDBOX_MIN_AGE_MS) return ['keep', 'too_new'];
    return ['delete', 'stopped_orphan_sandbox'];
  }
  if (item.kind === 'cache') {
    if (roots.cacheKeep.has(item.ref)) return ['keep', 'current_cache', 'it is the current runtime cache'];
    // A sandbox that survives an app restart may still run on an older runtime, and nothing in this
    // process says which. While any sandbox is live or unresolved, no cache is collected.
    if (roots.cacheHold?.length) return ['keep', 'live_sandbox', `sandbox ${nameList(roots.cacheHold)} may run on it`];
    if (age === null) return ['keep', 'age_unknown'];
    if (age < SWEEP_MIN_AGE_MS) return ['keep', 'too_new'];
    return ['delete', 'superseded_cache'];
  }
  return ['keep', 'unknown_kind'];
}

// planSweep({ owned, roots, leases, now }) -> { delete, keep, reasons }
//   owned   ledger items: { id, kind: image|sandbox|cache, ref, imageId?, status?, createdAt, bytes }
//   roots   { current, previous: Set<digest hex>, sandboxes: Map<name,{pin,status}>,
//             referenced: Set<sandbox name>, cacheKeep: Set<ref>, cacheHold?: names of live or unresolved sandboxes }
//   leases  [{ id, item, expiresAt }]   item is an item id or `<kind>:*`
//   observed every image that was listed, ours or not: it only proves that the image-id reading matches
//            the recorded digests; it is never removed
export function planSweep({ owned, roots, leases = [], now, observed = [] }) {
  const plan = { delete: [], keep: [], reasons: {} };
  const known = [...roots.current, ...roots.previous, ...[...roots.sandboxes.values()].map(sandbox => sandbox.pin).filter(Boolean)];
  const mappingVerified = [...owned, ...observed].some(item => item.kind === 'image' && imageMatchesDigests(item.imageId, known) === true);
  for (const item of owned) {
    const [verdict, reason, heldBy = null] = classify(item, { roots, leases, now, mappingVerified });
    plan[verdict].push({ ...item, reason, heldBy });
    plan.reasons[reason] = (plan.reasons[reason] ?? 0) + 1;
  }
  plan.delete.sort(byAgeThenSize);
  return plan;
}

// Age and size never decide WHETHER an item goes: classify() has already kept every rooted,
// leased or too-new item. They only order what is left, so a run that stops early (the work
// bound, or the low-water mark) has taken the oldest first and, among equals, the biggest.
function byAgeThenSize(a, b) {
  const ageA = Number.isFinite(a.createdAt) ? a.createdAt : Infinity;
  const ageB = Number.isFinite(b.createdAt) ? b.createdAt : Infinity;
  if (ageA !== ageB) return ageA - ageB;
  return (Number.isFinite(b.bytes) ? b.bytes : 0) - (Number.isFinite(a.bytes) ? a.bytes : 0);
}

// Hysteresis: start below the start mark, keep going until the stop mark.
export function watermarkStep({ freeBytes, collecting }) {
  if (!Number.isFinite(freeBytes)) return collecting;
  return collecting ? freeBytes < WATERMARK_STOP_FREE_BYTES : freeBytes < WATERMARK_START_FREE_BYTES;
}

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

function bytesOf(value) {
  if (Number.isFinite(value) && value >= 0) return value;
  const match = typeof value === 'string' ? /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(value) : null;
  if (!match) return null;
  const unit = UNITS[(match[2] || 'b').toLowerCase()];
  const n = Number(match[1]);
  return unit && Number.isFinite(n) ? n * unit : null;
}

function timeOf(value) {
  if (Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

export function isAssembledImage(row) {
  const repository = typeof row?.ref === 'string' ? row.ref.replace(/:[^:/]+$/, '') : '';
  return repository === ASSEMBLED_REPOSITORY;
}

// Reads `sbx template ls --json`. A live store returns a bare array of
// { id, repository, tag, flavor, created_at (ISO), size (bytes) }. The parser also accepts
// { templates | images: [] }, and returns null (fail closed: the sweep removes nothing)
// for anything else.
export function parseTemplateListing(result) {
  if (!result || result.code !== 0) return null;
  let data;
  try { data = JSON.parse(result.stdout); } catch { return null; }
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.templates) ? data.templates : (Array.isArray(data?.images) ? data.images : null));
  if (!rows || (!Array.isArray(data) && (data.partial === true || data.truncated === true || data.complete === false || data.next_cursor))) return null;
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.repository !== 'string' || !row.repository.trim() || typeof row.tag !== 'string') return null;
    const tag = typeof row.tag === 'string' ? row.tag : null;
    const ref = typeof row.repository === 'string' && tag && tag !== '<none>' ? `${row.repository}:${tag}` : null;
    if (!ref) continue;
    const rawId = String(row.image_id ?? row.imageId ?? row.id ?? '').replace(/^sha256:/, '').toLowerCase();
    items.push({
      id: `image:${ref}`,
      kind: 'image',
      ref,
      imageId: rawId.length >= 12 && HEX.test(rawId) ? rawId : null,
      createdAt: timeOf(row.created ?? row.created_at),
      bytes: bytesOf(row.size),
    });
  }
  return items;
}


const KIT_RECENT_IMAGES = 2;

// The cap requires a complete inventory whose identities never use prefixes.
export function parseFullImageListing(result) {
  try {
    const raw = JSON.parse(result.stdout);
    if (!Array.isArray(raw)) return null;
    // An untagged runtime row still participates in alias and identity checks.
    const normalized = raw.map(row => row?.tag === '' || row?.tag === '<none>'
      ? {...row,repository:'unrecorded-digest-alias',tag:'unknown'} : row);
    const rows = parseTemplateListing({...result,stdout:JSON.stringify(normalized)});
    return rows?.length === raw.length &&
      rows.every(row => /^[0-9a-f]{64}$/.test(row.imageId ?? '')) ? rows : null;
  } catch { return null; }
}

// Classify exact assembly provenance without producing removal commands.
// The storage cap also requires a complete full-ID listing, age and usage checks.
export function kitImageReport({ images = [], owned = {}, generations = null,
  complete = false, sandboxes = new Map(), leases = [], unresolved = false, now = 0 }) {
  const known = row => row && !row.unknown && row.digests.length > 0 && row.digests.every(digest =>
    row.images.some(image => image.inputDigest === digest));
  const mappingKnown = Boolean(known(generations?.current) && known(generations?.previous));
  const active = leases.filter(lease => lease.expiresAt > now);
  const creating = active.some(lease => lease.item === 'image:*' || lease.item === 'sandbox:*');
  const rows = images.map(image => {
    let reason;
    const record = owned[image.ref];
    if (!isAssembledImage(image) || !record?.imageId || record.imageId !== image.imageId) reason = 'not_owned';
    else if (typeof record.kitInputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.kitInputDigest)) reason = 'origin_unknown';
    else if (!complete) reason = 'inventory_incomplete';
    else if (creating) reason = 'create_in_flight';
    else if (unresolved) reason = 'work_unconfirmed';
    else if (!mappingKnown) reason = 'mapping_unknown';
    else if (generations.current.images.some(row => row.imageId === image.imageId)) reason = 'current_kit';
    else if (generations.previous.images.some(row => row.imageId === image.imageId)) reason = 'previous_kit';
    else if (sandboxes.size) reason = 'sandbox_present';
    else if (active.length) reason = 'work_in_progress';
    else reason = 'eligible';
    return { ref: image.ref, imageId: image.imageId, bytes: Number.isFinite(image.bytes) && image.bytes >= 0 ? image.bytes : null,
      eligible: reason === 'eligible', reason };
  });
  // Rank distinct, proven identities only; do not rank aliases independently.
  const byId = new Map();
  for (const [index, row] of rows.entries()) {
    const group = byId.get(row.imageId) ?? [];
    group.push({ row, createdAt: images[index].createdAt });
    byId.set(row.imageId, group);
  }
  const keep = (group, reason) => {
    for (const { row } of group) if (row.eligible) {
      row.eligible = false;
      row.reason = reason;
    }
  };
  const ranked = [];
  for (const group of byId.values()) {
    if (!group.some(({ row }) => row.eligible)) continue;
    const createdAt = group[0].createdAt;
    if (group.some(({ row }) => !row.eligible)) keep(group, 'alias_unproven');
    else if (!Number.isFinite(createdAt) || createdAt > now ||
      group.some(alias => alias.createdAt !== createdAt)) keep(group, 'age_unknown');
    else ranked.push({ group, createdAt });
  }
  ranked.sort((a, b) => b.createdAt - a.createdAt);
  const cutoff = ranked[KIT_RECENT_IMAGES - 1]?.createdAt ?? -Infinity;
  for (const { group, createdAt } of ranked) {
    if (createdAt >= cutoff) keep(group, 'retained_recent');
    else if (now - createdAt < SWEEP_MIN_AGE_MS) keep(group, 'too_new');
  }
  const eligible = rows.filter(row => row.eligible);
  // Count an image ID once even when sbx lists several references to it. Shared
  // layers can still make this estimate larger than actual disk space recovered.
  const sizes = new Map();
  for (const row of eligible) sizes.set(row.imageId, row.bytes === null || sizes.get(row.imageId) === null ? null : Math.max(sizes.get(row.imageId) ?? 0, row.bytes));
  const values = [...sizes.values()];
  return { reportOnly: true, mappingKnown, complete, images: rows, eligible: eligible.length,
    listedBytes: values.every(Number.isFinite) ? values.reduce((sum, bytes) => sum + bytes, 0) : null };
}
