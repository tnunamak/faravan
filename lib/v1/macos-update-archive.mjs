import yauzl from 'yauzl';
import { TextDecoder } from 'node:util';

// Preflight only. Caller verifies signed manifest/hash before this call, keeps the
// same immutable bytes for extraction, and performs native codesign verification.
// No extraction, filesystem, network, process, publisher or trust-key operations.
export const MAC_ZIP_REASONS = Object.freeze([
  'OPTIONS', 'FORMAT', 'PATH', 'ROOT', 'COLLISION', 'TYPE', 'PRIVILEGE',
  'ENCRYPTION', 'METHOD', 'HEADER', 'SIZE', 'CRC', 'ENTRY_LIMIT',
  'BYTE_LIMIT', 'LINK_LIMIT', 'LINK_TARGET', 'LINK_ESCAPE', 'LINK_DANGLING',
  'LINK_CYCLE', 'LINK_PARENT', 'METADATA',
]);
export class MacAppZipError extends Error {
  constructor(code) { super(code); this.name = 'MacAppZipError'; this.code = code; }
}
const fail = code => { throw new MacAppZipError(code); };
const uint = n => Number.isSafeInteger(n) && n >= 0;
const fold = s => s.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crcUpdate(crc, chunk) {
  for (const b of chunk) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function nameParts(name) {
  if (typeof name !== 'string' || !name || /[\\\0]/u.test(name) ||
      name.startsWith('/') || /^[a-z]:/iu.test(name) ||
      yauzl.validateFileName(name) !== null) fail('PATH');
  if (Buffer.byteLength(name, 'utf8') > 4096) fail('PATH');
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = path.split('/');
  if (parts.length > 256) fail('PATH');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) fail('PATH');
  return parts;
}
function entryType(e) {
  const mode = e.externalFileAttributes >>> 16;
  if (mode & 0o6000) fail('PRIVILEGE');
  const type = mode & 0o170000;
  const trailing = e.fileName.endsWith('/');
  const dosDir = Boolean(e.externalFileAttributes & 0x10);
  // Reject volume labels and special Unix types, even with a misleading host ID.
  if (e.externalFileAttributes & 0x08) fail('TYPE');
  if (type && ![0o040000, 0o100000, 0o120000].includes(type)) fail('TYPE');
  if (type === 0o120000) {
    if (trailing || dosDir) fail('TYPE');
    return 'symlink';
  }
  if (type === 0o100000 && (trailing || dosDir)) fail('TYPE');
  if (type === 0o040000 && !trailing) fail('TYPE');
  if (dosDir && !trailing) fail('TYPE');
  return trailing ? 'directory' : 'file';
}
function extraList(raw) {
  const fields = yauzl.parseExtraFields(raw);
  const ids = new Set();
  for (const { id } of fields) {
    if (ids.has(id)) fail('HEADER');
    ids.add(id);
  }
  return fields;
}
function read64(data, offset) {
  if (offset + 8 > data.length) fail('HEADER');
  const n = data.readBigUInt64LE(offset);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('SIZE');
  return Number(n);
}
function localSizes(h, fields) {
  let u = h.uncompressedSize, c = h.compressedSize;
  const zip64 = fields.find(f => f.id === 1)?.data;
  let at = 0;
  if (u === 0xffffffff) { if (!zip64) fail('HEADER'); u = read64(zip64, at); at += 8; }
  if (c === 0xffffffff) { if (!zip64) fail('HEADER'); c = read64(zip64, at); }
  return { u, c };
}
function descriptorEnd(buffer, at, e, widths) {
  // This is a bounded consistency check, not a second ZIP directory decoder.
  // Accept both signed and unsigned descriptors; CRC may itself equal signature.
  for (const zip64 of widths) for (const signature of [false, true]) {
    const start = at + (signature ? 4 : 0);
    const size = zip64 ? 20 : 12;
    if (start + size > buffer.length) continue;
    if (signature && buffer.readUInt32LE(at) !== 0x08074b50) continue;
    if (buffer.readUInt32LE(start) !== e.crc32) continue;
    const c = zip64 ? buffer.readBigUInt64LE(start + 4) : BigInt(buffer.readUInt32LE(start + 4));
    const u = zip64 ? buffer.readBigUInt64LE(start + 12) : BigInt(buffer.readUInt32LE(start + 8));
    if (c === BigInt(e.compressedSize) && u === BigInt(e.uncompressedSize)) return start + size;
  }
  fail('HEADER');
}
async function checkHeader(zip, e, buffer) {
  const h = await zip.readLocalFileHeaderPromise(e, { minimal: false });
  const fields = extraList(h.extraField);
  if (h.generalPurposeBitFlag & 0x800) utf8.decode(h.fileName);
  if (e.generalPurposeBitFlag & 0x800) utf8.decode(e.fileNameRaw);
  for (const f of [...fields, ...e.extraFields]) {
    if (f.id === 0x7075 && f.data.length >= 5 && f.data[0] === 1) utf8.decode(f.data.subarray(5));
  }
  const local = yauzl.getFileNameLowLevel(h.generalPurposeBitFlag, h.fileName, fields, true);
  nameParts(local);
  if (!h.fileName.equals(e.fileNameRaw) || local !== e.fileName ||
      h.generalPurposeBitFlag !== e.generalPurposeBitFlag ||
      h.compressionMethod !== e.compressionMethod) fail('HEADER');
  // Validate the undecorated name too: Unicode extra fields cannot hide traversal.
  nameParts(yauzl.getFileNameLowLevel(h.generalPurposeBitFlag, h.fileName, [], true));
  nameParts(yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, e.fileNameRaw, [], true));
  const { u, c } = localSizes(h, fields);
  const descriptor = Boolean(e.generalPurposeBitFlag & 8);
  if (descriptor) {
    if ((u !== 0 && u !== e.uncompressedSize) ||
        (c !== 0 && c !== e.compressedSize) ||
        (h.crc32 !== 0 && h.crc32 !== e.crc32)) fail('HEADER');
  } else if (u !== e.uncompressedSize || c !== e.compressedSize || h.crc32 !== e.crc32) {
    fail('HEADER');
  }
  if (!uint(h.fileDataStart) || !uint(e.relativeOffsetOfLocalHeader) ||
      h.fileDataStart < e.relativeOffsetOfLocalHeader + 30 ||
      e.compressedSize > buffer.length - h.fileDataStart) fail('HEADER');
  let end = h.fileDataStart + e.compressedSize;
  if (descriptor) {
    const wide = h.uncompressedSize === 0xffffffff || h.compressedSize === 0xffffffff ||
      e.uncompressedSize > 0xffffffff || e.compressedSize > 0xffffffff ||
      fields.some(f => f.id === 1);
    end = descriptorEnd(buffer, end, e, wide ? [true] :
      h.versionNeededToExtract >= 45 ? [false, true] : [false]);
  }
  return [e.relativeOffsetOfLocalHeader, end];
}
function addNode(nodes, spellings, parts, kind, explicit, target) {
  const path = parts.join('/');
  const key = fold(path);
  const prior = spellings.get(key);
  if (prior !== undefined && prior !== path) fail('COLLISION');
  spellings.set(key, path);
  const old = nodes.get(path);
  if (old && (explicit && old.explicit || old.kind !== 'directory' || kind !== 'directory')) {
    fail(old?.kind === 'symlink' ? 'LINK_PARENT' : 'COLLISION');
  }
  if (!old && nodes.size >= 100000) fail('ENTRY_LIMIT');
  nodes.set(path, { kind, explicit: explicit || old?.explicit || false, target });
}
function resolveLinks(nodes, appName) {
  let steps = 0;
  // Explicit frames avoid call-stack growth. A marker removes a link from the
  // active expansion set before a subsequent independent traversal uses it.
  for (const [path, node] of nodes) {
    if (node.kind !== 'symlink') continue;
    const active = new Set([path]);
    const stack = [{ parts: node.target.split('/'), at: 0, link: path }];
    let current = path.split('/').slice(0, -1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.at === frame.parts.length) {
        active.delete(frame.link);
        stack.pop();
        continue;
      }
      if (++steps > 1000000) fail('LINK_LIMIT');
      const part = frame.parts[frame.at++];
      if (nodes.get(current.join('/'))?.kind !== 'directory') fail('LINK_DANGLING');
      if (!part || part === '.') continue;
      if (part === '..') {
        if (current.length <= 1) fail('LINK_ESCAPE');
        current.pop();
        continue;
      }
      // Every component before a further slash must be a directory, including
      // after following another symlink. Do not lexically normalize a/../ first.
      const parent = nodes.get(current.join('/'));
      if (!parent || parent.kind !== 'directory') fail('LINK_DANGLING');
      current.push(part);
      const p = current.join('/');
      const next = nodes.get(p);
      if (!next) fail('LINK_DANGLING');
      if (next.kind === 'symlink') {
        if (active.has(p)) fail('LINK_CYCLE');
        active.add(p);
        current.pop();
        stack.push({ parts: next.target.split('/'), at: 0, link: p });
      }
      if (current[0] !== appName) fail('LINK_ESCAPE');
    }
    const last = nodes.get(current.join('/'));
    if (!last || last.kind === 'symlink') fail('LINK_DANGLING');
    node.resolvedTarget = current.join('/');
  }
}

/**
 * Requires Node >=18 and exactly yauzl 3.4.0 (owner pins dependency/lock).
 * entries contains explicit archive records only, with original names preserved.
 * Directory nodes can be implicit. This checks container paths/types/bytes, not
 * bundle completeness, executable identity, signatures or native extraction.
 * Names containing ':' are refused for cross-tool macOS path ambiguity.
 * Names are at most 4096 UTF-8 bytes/256 components; implicit plus explicit
 * namespace nodes are capped at 100000 to bound adversarial directory expansion.
 * Link resolution has a cumulative one-million-component work ceiling.
 * Case collision key deliberately folds uppercase then lowercase conservatively.
 */
export async function validateMacAppZip(buffer, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('OPTIONS');
  const {
  appName = 'Faravan.app', maxEntries = 20000,
  maxUncompressedBytes = 1073741824, maxSymlinkBytes = 4096,
  } = options;
  if (!Buffer.isBuffer(buffer) || !uint(maxEntries) || maxEntries < 1 ||
      !uint(maxUncompressedBytes) || !uint(maxSymlinkBytes) || maxSymlinkBytes < 1 ||
      typeof appName !== 'string' || !appName.endsWith('.app')) fail('OPTIONS');
  try { if (nameParts(appName).length !== 1 || appName.endsWith('/')) fail('OPTIONS'); }
  catch { fail('OPTIONS'); }
  let zip, stream;
  try {
    zip = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true,
    });
    if (!uint(zip.entryCount) || zip.entryCount > maxEntries) fail('ENTRY_LIMIT');
    const entries = [], nodes = new Map(), spellings = new Map(), ranges = [];
    let declaredTotal = 0, actualTotal = 0, appRecords = 0;
    for await (const e of zip.eachEntry()) {
      if (entries.length >= maxEntries) fail('ENTRY_LIMIT');
      // Reject invalid encodings before the library's replacement-decoded name
      // can classify a malformed Unicode override as a different app root.
      if (e.generalPurposeBitFlag & 0x800) utf8.decode(e.fileNameRaw);
      for (const f of e.extraFields) {
        if (f.id === 0x7075 && f.data.length >= 5 && f.data[0] === 1) utf8.decode(f.data.subarray(5));
      }
      const parts = nameParts(e.fileName), path = parts.join('/');
      const kind = entryType(e);
      if (e.generalPurposeBitFlag & (1 | 0x40 | 0x2000)) fail('ENCRYPTION');
      // Only deflate option bits, descriptor and UTF-8 are meaningful here.
      if (e.generalPurposeBitFlag & ~(2 | 4 | 8 | 0x800)) fail('FORMAT');
      if (![0, 8].includes(e.compressionMethod)) fail('METHOD');
      if (!uint(e.uncompressedSize) || !uint(e.compressedSize)) fail('SIZE');
      if (e.uncompressedSize > maxUncompressedBytes - declaredTotal) fail('BYTE_LIMIT');
      declaredTotal += e.uncompressedSize;
      if (kind === 'symlink' && e.uncompressedSize > maxSymlinkBytes) fail('LINK_LIMIT');
      if (kind === 'directory' && e.uncompressedSize !== 0) fail('SIZE');
      const meta = parts[0] === '__MACOSX';
      if (!meta && parts[0] !== appName) fail('ROOT');
      if (!meta) {
        appRecords++;
        if (parts.length === 1 && kind !== 'directory') fail('ROOT');
      } else {
        if (kind === 'symlink') fail('METADATA');
        const rootSidecar = parts.length === 2 && parts[1] === '._' + appName && kind === 'file';
        const metaDir = kind === 'directory' && (parts.length === 1 || parts[1] === appName);
        const sidecar = kind === 'file' && parts[1] === appName && parts.length >= 3 &&
          parts.at(-1).startsWith('._') && parts.at(-1).length > 2;
        if (!rootSidecar && !metaDir && !sidecar) fail('METADATA');
      }
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i), existing = nodes.get(parent.join('/'));
        if (existing && existing.kind !== 'directory') fail(existing.kind === 'symlink' ? 'LINK_PARENT' : 'TYPE');
        if (!existing) addNode(nodes, spellings, parent, 'directory', false);
        else if (spellings.get(fold(parent.join('/'))) !== parent.join('/')) fail('COLLISION');
      }
      // Both raw and Unicode-effective central extra fields must be well formed.
      const ids = new Set();
      for (const f of e.extraFields) { if (ids.has(f.id)) fail('HEADER'); ids.add(f.id); }
      ranges.push(await checkHeader(zip, e, buffer));
      stream = await zip.openReadStreamPromise(e);
      let size = 0, crc = 0xffffffff;
      const chunks = kind === 'symlink' ? [] : null;
      try {
        for await (const chunk of stream) {
          if (chunk.length > e.uncompressedSize - size) fail('SIZE');
          if (chunk.length > maxUncompressedBytes - actualTotal) fail('BYTE_LIMIT');
          if (chunks && chunk.length > maxSymlinkBytes - size) fail('LINK_LIMIT');
          size += chunk.length; actualTotal += chunk.length;
          crc = crcUpdate(crc, chunk);
          if (chunks) chunks.push(chunk);
        }
      } finally { stream.destroy(); stream = null; }
      if (size !== e.uncompressedSize) fail('SIZE');
      if (((crc ^ 0xffffffff) >>> 0) !== e.crc32) fail('CRC');
      let target;
      if (chunks) {
        try { target = utf8.decode(Buffer.concat(chunks, size)); } catch { fail('LINK_TARGET'); }
        if (!target || /[\\\0:]/u.test(target) || target.startsWith('/')) fail('LINK_TARGET');
      }
      addNode(nodes, spellings, parts, kind, true, target);
      entries.push({ name: e.fileName, type: kind, uncompressedSize: size, ...(target === undefined ? {} : { target }) });
    }
    if (!appRecords || nodes.get(appName)?.kind !== 'directory') fail('ROOT');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('HEADER');
    for (const e of entries) {
      if (!e.name.startsWith('__MACOSX/')) continue;
      const parts = nameParts(e.name).slice(1);
      if (!parts.length) continue;
      if (e.type === 'file') parts[parts.length - 1] = parts.at(-1).slice(2);
      const match = nodes.get(parts.join('/'));
      if (!match || (e.type === 'directory' && match.kind !== 'directory')) fail('METADATA');
    }
    resolveLinks(nodes, appName);
    return { root: appName, entries };
  } catch (error) {
    if (error instanceof MacAppZipError) throw error;
    // Do not echo archive-controlled paths or arbitrary library error messages.
    fail('FORMAT');
  } finally {
    stream?.destroy();
    zip?.close();
  }
}
