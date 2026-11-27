// Only call after createClient.fetchResult has verified the signed candidate and bytes.
import { constants } from 'node:fs';
import { mkdtemp, lstat, readdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractArchive, validateArchive, DECEPTIVE_NAME_CHARS } from '../archive.mjs';

export class ResultDownloadError extends Error {
  constructor(code) { super(code); this.name = 'ResultDownloadError'; this.code = code; }
}
const need = (condition, code) => { if (!condition) throw new ResultDownloadError(code); };
const MAX_BYTES = 64 * 1024 ** 2;
const MAX_INPUT_BYTES = 16 * 1024 ** 2;
const MAX_FILES = 2000;
const MAX_PATH_BYTES = 4096;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name) {
  // ZIP is commonly opened on Windows too. Refuse ADS/device names and aliases.
  need(Buffer.byteLength(name) <= MAX_PATH_BYTES &&
    name.split('/').every(part => part && part !== '.' && part !== '..' &&
      !/[\\\\:\x00-\x1f\x7f]/.test(part) && !DECEPTIVE_NAME_CHARS.test(part) && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  'unsafe_result_path');
}
export async function zipDirectory(root, { maxBytes = MAX_BYTES, maxFiles = MAX_FILES, paths } = {}) {
  const localParts = [], centralParts = [], names = new Map();
  let count = 0, total = 0, offset = 0, centralSize = 0;
  const outputLimit = maxBytes + maxFiles * (MAX_PATH_BYTES * 2 + 128) + 22;
  async function visit(directory, prefix = '') {
    const children = await readdir(directory);
    children.sort();
    for (const child of children) {
      const name = prefix + child;
      if (paths && !paths.some(path => path === name || path.startsWith(name + '/'))) continue;
      need(++count <= maxFiles, 'result_too_large');
      safeName(name);
      const folded=name.normalize('NFC').toLowerCase();
      need(!names.has(folded)||names.get(folded)===name,'unsafe_result_path');
      names.set(folded,name);
      const path = join(directory, child), info = await lstat(path);
      need(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()), 'unsafe_result_entry');
      const isDirectory = info.isDirectory();
      let data = Buffer.alloc(0), mode = 0o40755;
      if (!isDirectory) {
        need(info.size <= maxBytes - total, 'result_too_large');
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const opened = await handle.stat();
          need(opened.isFile() && opened.size === info.size && opened.ino === info.ino &&
            opened.dev === info.dev, 'unsafe_result_entry');
          data = await handle.readFile();
          need(data.length === opened.size && data.length <= maxBytes - total, 'result_too_large');
          total += data.length;
          mode = 0o100000 | (opened.mode & 0o111 ? 0o755 : 0o644);
        } finally { await handle.close(); }
      }
      const nameBytes = Buffer.from(name + (isDirectory ? '/' : ''));
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6); // UTF-8, store method, no data descriptor.
      local.writeUInt16LE(33, 12); // 1980-01-01, deterministic timestamp.
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x0314, 4); // Unix host, version 2.0.
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x800, 8);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(((mode << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38);
      central.writeUInt32LE(offset, 42);
      offset += local.length + nameBytes.length + data.length;
      centralSize += central.length + nameBytes.length;
      need(offset + centralSize + 22 <= outputLimit, 'result_too_large');
      localParts.push(local, nameBytes, data);
      centralParts.push(central, nameBytes);
      if (isDirectory) await visit(path, name + '/');
    }
  }
  await visit(root);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end], offset + centralSize + 22);
}

/**
 * Convert a verified gzip tar candidate into a portable bounded ZIP. Patch bytes
 * pass through unchanged. Never extract into the user's source or result folder.
 * ZIP-conversion limits may only be reduced. A typed result can fall back to its
 * safety-validated original archive. Scratch is private and removed even on rejection.
 */
export async function prepareResultDownload(input, {
  mediaType, jobId = 'result', maxBytes = MAX_BYTES,
  maxInputBytes = MAX_INPUT_BYTES, maxFiles = MAX_FILES, requiredRoot,
} = {}) {
  for (const [value, cap] of [[maxBytes, MAX_BYTES], [maxInputBytes, MAX_INPUT_BYTES], [maxFiles, MAX_FILES]]) {
    need(Number.isSafeInteger(value) && value >= 0 && value <= cap, 'invalid_result_limit');
  }
  need(input instanceof Uint8Array, 'invalid_result_bytes');
  need(input.byteLength <= maxInputBytes, 'result_too_large');
  const bytes = Buffer.from(input);
  // Only fixed safe ASCII reaches Content-Disposition; no caller path or CRLF.
  const stem = 'faravan-' + String(jobId).replace(/^sha256:/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (mediaType === 'text/x-diff') {
    need(bytes.length <= maxBytes, 'result_too_large');
    return { bytes, contentType: 'text/x-diff', filename: stem + '.patch' };
  }
  need(mediaType === 'application/gzip', 'unsupported_result_format');
  // Typed results must never download hidden files outside their promised folder.
  if(requiredRoot)validateArchive(bytes,{gzip:true,requiredRoot});
  const scratch = await mkdtemp(join(tmpdir(), 'faravan-result-'));
  try {
    await extractArchive(bytes, scratch, {
      gzip: true, requiredRoot, maxEntries: maxFiles, maxTotalBytes: maxBytes, maxFileBytes: maxBytes,
      maxPathLength: MAX_PATH_BYTES, maxMetadataBytes: Math.min(maxBytes, 64 * 1024),
    });
    return {
      bytes: await zipDirectory(scratch, { maxBytes, maxFiles }),
      contentType: 'application/zip', filename: stem + '.zip',
    };
  } catch(error) {
    // ZIP conversion is a convenience with smaller limits. The original signed archive
    // remains downloadable after the full namespace/safety validation above.
    if(requiredRoot && ['too_large','result_too_large'].includes(error.code))
      return {bytes,contentType:'application/gzip',filename:stem+'.tar.gz'};
    throw error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
