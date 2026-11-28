import {mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, readdirSync, statSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {priceCatalogRevision, validPriceCatalog} from './lending-meter.mjs';

const pending = new Map();
export function pinPriceSnapshot(rev) {
  pending.set(rev, (pending.get(rev) ?? 0) + 1);
  return () => { const n = pending.get(rev) - 1; if (n) pending.set(rev, n); else pending.delete(rev); };
}
const validRev = rev => typeof rev === 'string' && /^prices-sha256:[0-9a-f]{64}$/.test(rev);
const fileFor = (directory, rev) => join(directory, 'prices', rev.replace(':', '-') + '.json');

export function readPriceSnapshot(directory, rev) {
  if (!validRev(rev)) throw new Error('price_snapshot_missing');
  try {
    const data = JSON.parse(readFileSync(fileFor(directory, rev), 'utf8'));
    if (priceCatalogRevision(data) !== rev || !validPriceCatalog(data)) throw new Error('bad snapshot');
    return {revision: rev, data};
  } catch { throw new Error('price_snapshot_missing'); }
}

export function savePriceSnapshot(directory, snapshot) {
  if (!validRev(snapshot.revision) || priceCatalogRevision(snapshot.data) !== snapshot.revision || !validPriceCatalog(snapshot.data)) throw new Error('invalid_price_snapshot');
  const target = fileFor(directory, snapshot.revision);
  mkdirSync(join(directory, 'prices'), {recursive: true, mode: 0o700});
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(snapshot.data), {flag: 'wx', mode: 0o600});
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const dirfd = openSync(join(directory, 'prices'), 'r');
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  } finally { try { unlinkSync(temp); } catch {} }
  return readPriceSnapshot(directory, snapshot.revision);
}

// Synchronous scan and deletion cannot race a new reservation in this process.
export function prunePriceSnapshots(directory, referenced, keep = 5) {
  const dir = join(directory, 'prices');
  let files;
  try { files = readdirSync(dir).filter(name => /^prices-sha256-[0-9a-f]{64}\.json$/.test(name))
    .map(name => ({name, time: statSync(join(dir, name)).mtimeMs})).sort((a, b) => b.time - a.time); }
  catch { return; }
  for (const {name} of files.slice(keep)) {
    const rev = name.replace('prices-sha256-', 'prices-sha256:').replace(/\.json$/, '');
    if (!referenced.has(rev) && !pending.has(rev)) try { unlinkSync(join(dir, name)); } catch {}
  }
}
