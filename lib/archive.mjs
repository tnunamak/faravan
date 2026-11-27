// Untrusted tar input: validate the complete archive before touching the destination.
// Defaults are for results someone else produced: executable bits dropped,
// any .git path rejected, depth <= 64, case/NFC collisions rejected, at most
// 1 MiB of padding after the end marker. Job sources from the borrower pass
// { preserveExecutable: true, allowGit: true }. GNU long names and PAX path
// and size records are accepted and validated by the same path rules, since
// real repositories have paths longer than 100 bytes (spec section 9).
// The caller must exclusively control the destination during extraction: portable
// Node has no openat(2) API to defend against a concurrent directory-renaming actor.
import { gunzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, chmod } from 'node:fs/promises';
import { resolve, join, posix, win32 } from 'node:path';

export class ArchiveError extends Error {
  constructor(code, message) { super(message); this.name = 'ArchiveError'; this.code = code; }
}
const fail = (code, message) => { throw new ArchiveError(code, message); };
export const DEFAULT_ARCHIVE_POLICY = Object.freeze({
  maxEntries: 100000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxFileBytes: 1024 ** 3,
  maxPathLength: 4096,
  maxMetadataBytes: 1024 ** 2,
  maxDepth: 64,
  maxTrailingBytes: 1024 ** 2,
});
const decoder = new TextDecoder('utf-8', { fatal: true });
function text(bytes) {
  try { return decoder.decode(bytes); }
  catch { fail('malformed', 'Invalid UTF-8 in tar metadata'); }
}
function field(bytes) {
  const end = bytes.indexOf(0);
  if (end < 0) return text(bytes);
  if (bytes.subarray(end).some((b) => b !== 0)) fail('malformed', 'Embedded NUL in tar field');
  return text(bytes.subarray(0, end));
}
function number(bytes) {
  // GNU base-256 positive integers and POSIX octal fields.
  let value;
  if (bytes[0] & 0x80) {
    if (bytes[0] & 0x40) fail('malformed', 'Negative tar number');
    let n = BigInt(bytes[0] & 0x7f);
    for (const b of bytes.subarray(1)) n = (n << 8n) + BigInt(b);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('too_large', 'Tar number exceeds safe integer range');
    value = Number(n);
  } else {
    const s = bytes.toString('ascii').replace(/\0.*$/, '').trim();
    if (s && !/^[0-7]+$/.test(s)) fail('malformed', 'Invalid octal tar number');
    value = s ? parseInt(s, 8) : 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) fail('too_large', 'Invalid tar size');
  return value;
}
function policy(options) {
  const p = { ...DEFAULT_ARCHIVE_POLICY };
  for (const key of Object.keys(p)) {
    if (options[key] !== undefined) p[key] = options[key];
    if (!Number.isSafeInteger(p[key]) || p[key] < 0 || p[key] > DEFAULT_ARCHIVE_POLICY[key]) {
      fail('malformed', key + ' must be a nonnegative integer no greater than its default');
    }
  }
  return p;
}
// Names that render deceptively: bidirectional controls (U+202E makes
// "evil\u202Egpj.exe" display as "evilexe.jpg"), invisible and other Unicode
// format characters (Cf), and line/paragraph separators. ZWNJ and ZWJ are
// allowed because ordinary Persian, Indic and emoji names need them.
export const DECEPTIVE_NAME_CHARS = /(?![\u200c\u200d])[\p{Cf}\p{Zl}\p{Zp}]/u;
function memberPath(name, p) {
  if (DECEPTIVE_NAME_CHARS.test(name)) fail('path_traversal', 'Unsafe archive path: ' + JSON.stringify(name));
  if (!name || name.includes('\0') || name.includes('\\') ||
      posix.isAbsolute(name) || win32.isAbsolute(name) || /^[A-Za-z]:/.test(name) ||
      name.split('/').includes('..')) fail('path_traversal', 'Unsafe archive path: ' + JSON.stringify(name));
  if (Buffer.byteLength(name) > p.maxPathLength) fail('too_large', 'Archive path is too long');
  const normalized = posix.normalize(name).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) fail('path_traversal', 'Archive path escapes root');
  return normalized;
}
function pax(bytes) {
  const result = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) fail('malformed', 'Invalid pax record length');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail('malformed', 'Invalid pax length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 ||
        offset + length > bytes.length || bytes[offset + length - 1] !== 10) fail('malformed', 'Truncated pax record');
    const record = text(bytes.subarray(space + 1, offset + length - 1));
    const equal = record.indexOf('=');
    if (equal < 1 || record.includes('\0')) fail('malformed', 'Invalid pax key/value');
    const key = record.slice(0, equal);
    if (/sparse/i.test(key) || key === 'SCHILY.realsize' || key === 'SCHILY.filetype') {
      fail('bad_entry_type', 'Sparse and special pax files are not supported');
    }
    result[key] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}
function parseArchive(input, options = {}) {
  const p = policy(options);
  const requiredRoots = options.requiredRoot === undefined ? null : Array.isArray(options.requiredRoot) ? options.requiredRoot : [options.requiredRoot];
  if (requiredRoots && (!requiredRoots.length || !requiredRoots.every(root => typeof root === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(root))))
    fail('malformed','Invalid required output folder');
  if (!(input instanceof Uint8Array)) fail('malformed', 'Archive must be bytes');
  // Own the bytes so a caller cannot mutate the validated input during async IO.
  let bytes = Buffer.from(input);
  const streamLimit = p.maxTotalBytes + p.maxEntries * 1024 + 10240;
  const gzip = options.gzip ?? (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (gzip) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: streamLimit }); }
    catch (error) {
      fail(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'malformed', 'Cannot expand gzip archive: ' + error.message);
    }
  }
  if (bytes.length > streamLimit) fail('too_large', 'Expanded tar stream exceeds policy');
  const entries = [], names = new Map(), folded = new Map();
  let offset = 0, headers = 0, total = 0, expanded = 0;
  let globals = Object.create(null), local = Object.create(null), longName = null, pending = false, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) {
      if (offset + 512 > bytes.length || bytes.subarray(offset).some((b) => b !== 0)) fail('malformed', 'Invalid tar end marker');
      // Real tars pad to a 10 KiB record; megabytes of zeros are a bomb, not padding.
      if (bytes.length - offset > p.maxTrailingBytes) fail('too_large', 'Too much padding after the tar end marker');
      ended = true;
      break;
    }
    if (++headers > p.maxEntries) fail('too_large', 'Archive contains too many entries');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (number(header.subarray(148, 156)) !== checksum) fail('malformed', 'Tar header checksum mismatch');
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ' && !header.subarray(257, 263).every((b) => b === 0)) {
      fail('malformed', 'Unsupported tar header format');
    }
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === '1' || type === '2') fail('link_rejected', 'Archive links are not allowed');
    if (!['0', '5', 'L', 'x', 'g'].includes(type)) fail('bad_entry_type', 'Unsupported tar entry type: ' + type);
    const metadata = ['L', 'x', 'g'].includes(type);
    let size = number(header.subarray(124, 136));
    const attributes = { ...globals };
    for (const [key, value] of Object.entries(local)) {
      if (value === '') delete attributes[key]; else attributes[key] = value;
    }
    if (!metadata && attributes.size !== undefined) {
      if (!/^[0-9]+$/.test(attributes.size)) fail('malformed', 'Invalid pax size');
      size = Number(attributes.size);
      if (!Number.isSafeInteger(size)) fail('too_large', 'Pax size exceeds safe integer range');
    }
    if (size > (metadata ? p.maxMetadataBytes : p.maxFileBytes) || expanded + size > p.maxTotalBytes) {
      fail('too_large', 'Archive expanded size exceeds policy');
    }
    if (type === '5' && size !== 0) fail('malformed', 'Directory has file data');
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > bytes.length) fail('malformed', 'Truncated tar entry');
    const data = bytes.subarray(offset, offset + size);
    expanded += data.length;
    offset += padded;
    if (metadata) {
      if (type === 'L') {
        longName = field(data);
        pending = true;
      } else if (type === 'g') {
        const next = pax(data);
        for (const [key, value] of Object.entries(next)) {
          if (value === '') delete globals[key]; else globals[key] = value;
        }
      } else {
        Object.assign(local, pax(data));
        pending = true;
      }
      continue;
    }
    let name = field(header.subarray(0, 100));
    if (magic === 'ustar\0') {
      const prefix = field(header.subarray(345, 500));
      if (prefix) name = prefix + '/' + name;
    }
    name = memberPath(attributes.path ?? longName ?? name, p);
    local = Object.create(null); longName = null; pending = false;
    if (requiredRoots && !(name === '.' && type === '5') &&
        !requiredRoots.some(root => (name === root && type === '5') || name.startsWith(root + '/')))
      fail('path_traversal', 'Archive entry is outside the required output folder: ' + name);
    if (name === '.' && type !== '5') fail('path_traversal', 'Archive root must be a directory');
    if (names.has(name) && !(names.get(name) === '5' && type === '5')) {
      fail('duplicate_entry', 'Duplicate or conflicting archive path: ' + name);
    }
    const parts = name.split('/');
    if (parts.length > p.maxDepth) fail('too_large', 'Archive path is nested too deeply: ' + name);
    // A .git directory from someone else can run code when you later use git
    // in that folder (core.fsmonitor, hooks). Results never need one.
    if (!options.allowGit && parts.some((part) => part.toLowerCase() === '.git')) fail('git_rejected', 'Archive contains a .git path: ' + name);
    // Two names that differ only by case or Unicode form collide on macOS and
    // Windows and can overwrite each other there.
    const fold = name.normalize('NFC').toLowerCase();
    const prior = folded.get(fold);
    if (prior !== undefined && prior !== name) fail('duplicate_entry', 'Archive paths collide by case or Unicode form: ' + prior + ' and ' + name);
    folded.set(fold, name);
    names.set(name, type);
    total += data.length;
    if (total > p.maxTotalBytes) fail('too_large', 'Actual expanded bytes exceed policy');
    // Executable bits are dropped unless the caller opts in (sources keep
    // theirs; results are reviewed before anything in them is run).
    const executable = options.preserveExecutable && (number(header.subarray(100, 108)) & 0o111);
    entries.push({ name, type, data, mode: type === '5' ? 0o755 : (executable ? 0o755 : 0o644) });
  }
  if (!ended || pending) fail('malformed', 'Missing tar end marker or dangling metadata');
  for (const entry of entries) {
    let parent = posix.dirname(entry.name);
    while (parent !== '.') {
      if (names.has(parent) && names.get(parent) !== '5') fail('duplicate_entry', 'File used as archive directory: ' + parent);
      parent = posix.dirname(parent);
    }
  }
  return { entries, summary: { entries: entries.length, bytes: total } };
}
/** Validated entries own their bytes; links and special files are refused before callers see data. */
export function readArchiveEntries(input, options = {}) {
  return parseArchive(input, options).entries;
}
export function validateArchive(input, options = {}) {
  return parseArchive(input, options).summary;
}
async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Regular files in an archive, for a preview before anything is extracted. Pass a smaller policy to bound the inflated size.
// Validated regular-file bytes, without extracting an untrusted result to disk.
export function readArchiveFiles(input, options = {}) {
  return parseArchive(input, options).entries.filter(entry => entry.type === '0')
    .map(({name, data}) => ({path:name, bytes:data}));
}
export function archiveFileCount(input, options = {}) {
  return parseArchive(input, options).entries.filter((entry) => entry.type === '0').length;
}
export async function extractArchive(input, destination, options = {}) {
  const archive = parseArchive(input, options);
  try {
    const requested = resolve(destination);
    const rootInfo = await existing(requested);
    if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) fail('destination_conflict', 'Destination must be a real directory');
    await mkdir(requested, { recursive: true, mode: 0o755 });
    const root = await realpath(requested);
    const directories = new Set();
    for (const entry of archive.entries) {
      let directory = entry.type === '5' ? entry.name : posix.dirname(entry.name);
      while (directory !== '.') { directories.add(directory); directory = posix.dirname(directory); }
    }
    const ordered = [...directories].sort((a, b) => a.split('/').length - b.split('/').length);
    // Preflight existing entries before any member writes, never follow links.
    for (const name of ordered) {
      const info = await existing(join(root, name));
      if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('destination_conflict', 'Unsafe existing directory: ' + name);
    }
    for (const entry of archive.entries) {
      if (entry.type === '0' && await existing(join(root, entry.name))) fail('destination_conflict', 'Destination entry already exists: ' + entry.name);
    }
    for (const name of ordered) {
      const target = join(root, name);
      try { await mkdir(target, { mode: 0o755 }); await chmod(target, 0o755); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) fail('destination_conflict', 'Unsafe directory: ' + name);
      }
    }
    let written = 0;
    for (const entry of archive.entries) {
      if (entry.type !== '0') continue;
      const handle = await open(join(root, entry.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), entry.mode);
      try { await handle.writeFile(entry.data); await handle.chmod(entry.mode); }
      finally { await handle.close(); }
      written += entry.data.length;
    }
    if (written !== archive.summary.bytes) fail('malformed', 'Extracted byte count mismatch');
    return archive.summary;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(error.code === 'EEXIST' || error.code === 'ELOOP' ? 'destination_conflict' : 'io_error', 'Archive extraction failed: ' + error.message);
  }
}
