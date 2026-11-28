// Local, read-only support collection. Never open a device/client, walk a directory,
// invoke a subprocess, or serialize an exception here.
import {constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {lstat, open, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {release} from 'node:os';
import {gzipSync} from 'node:zlib';
import {check} from './ops/schema.mjs';
import {SUPPORT_SCHEMA, SUPPORT_READINESS_SCHEMA, SUPPORT_LIMITS} from './diagnostics-schema.mjs';

export {SUPPORT_SCHEMA, SUPPORT_LIMITS};
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SUPPORT_FILENAME = 'faravan-support.tar.gz';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Copy declared properties only; invalid scalar values become null. Schema changes need privacy review. */
function project(schema, value) {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([key, field]) =>
    [key, project(field, plain(value) && Object.hasOwn(value, key) ? value[key] : undefined)]));
  if (schema.type === 'array') return (Array.isArray(value) ? value : []).slice(-schema.maxItems).map(item => project(schema.items, item));
  return value !== undefined && check(schema, value) === null ? value : null;
}

/** The cache has the same allowlist on write and on export; raw probe output never reaches it. */
export function supportReadiness(report, sbxVersion) {
  return project(SUPPORT_READINESS_SCHEMA, {observed_at:report?.observed_at, ready:report?.ready,
    backend_id:report?.protection?.backend_id, sbx_version:sbxVersion,
    version_compatible:report?.protection?.version_gate?.ok, checks:report?.checks});
}

/** Record in memory only. Disk I/O belongs to explicit preview or shutdown, never readiness. */
export function createSupportReadinessCache(write) {
  let pending = null, work = null;
  function start() {
    if (work) return;
    work = Promise.resolve().then(async () => {
      while (pending) {
        const value = pending; pending = null;
        try {await write(value);} catch {/* A support cache cannot block lending. */}
      }
    }).finally(() => {work = null;});
  }
  return {
    record(report, version) {pending = supportReadiness(report, version);},
    async flush() {while (pending || work) {if (!work) start(); await work;}},
  };
}

// Fixed paths, bounded reads, no symlinks or non-regular files. O_NONBLOCK also
// prevents a file replaced by a FIFO between lstat and open from hanging export.
async function readBounded(root, parts, {tail = false, maxBytes = SUPPORT_LIMITS.storeBytes} = {}) {
  let handle;
  try {
    let path = resolve(root);
    const base = await lstat(path);
    if (!base.isDirectory() || base.isSymbolicLink()) return {status:'unsafe_path'};
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return {status:'unsafe_path'};
    }
    path = join(path, parts.at(-1));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return {status:'unsafe_path'};
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return {status:'unsafe_path'};
    if (!tail && opened.size > maxBytes) return {status:'too_large'};
    const start = tail ? Math.max(0, opened.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return {status:start ? 'partial' : 'ok', text};
  } catch (error) {
    return {status:error?.code === 'ENOENT' ? 'missing' : ['ELOOP','ENOTDIR'].includes(error?.code) ? 'unsafe_path' : 'unreadable'};
  } finally {await handle?.close();}
}

async function readJson(home, parts) {
  const result = await readBounded(home, ['v1', ...parts]);
  if (result.status !== 'ok') return result;
  try {
    const value = JSON.parse(result.text);
    return plain(value) ? {status:'ok', value} : {status:'unreadable'};
  } catch {return {status:'unreadable'};}
}
async function readLines(home, parts) {
  const result = await readBounded(home, ['v1', ...parts], {tail:true, maxBytes:SUPPORT_LIMITS.tailBytes});
  const rows = [];
  for (const line of (result.text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {const row = JSON.parse(line); if (plain(row)) rows.push(row); else result.status = 'partial';}
    catch {result.status = 'partial';}
  }
  return {status:result.status, rows};
}

const STATES = {Waiting:'queued', 'Waiting for an answer':'waiting', Approved:'accepted', Starting:'starting', Working:'running',
  Stopping:'stopping', Stopped:'stopped', Finished:'completed', Failed:'failed', Cancelled:'cancelled', Expired:'expired'};
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export async function collectSupportFacts({home, installRoot = ROOT} = {}) {
  const [settings, readiness, history, errors, appVersion, installKind] = await Promise.all([
    readJson(home, ['app-settings.json']),
    readJson(home, ['support-readiness.json']),
    readLines(home, ['history','events.jsonl']), readLines(home, ['lending-errors.jsonl']),
    readBounded(installRoot, ['VERSION'], {maxBytes:256}), readBounded(installRoot, ['.installed-via'], {maxBytes:64}),
  ]);
  // Only the in-memory map sees stable IDs. Every collection starts a fresh namespace.
  const aliases = new Map();
  function jobAlias(digest) {
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
    if (!aliases.has(digest)) aliases.set(digest, 'job:' + randomBytes(16).toString('hex'));
    return aliases.get(digest);
  }
  const events = history.rows.map(row => ({at:iso(row.at), type:row.type, job:jobAlias(row.job ?? row.data?.job_digest),
    state:row.data?.state ?? (Object.hasOwn(STATES, row.data?.status ?? '') ? STATES[row.data.status] : row.data?.status) ?? row.data?.action,
    code:row.data?.code ?? row.data?.reason}));
  const safeEvents = project(SUPPORT_SCHEMA.properties.events, events.filter(row => row.at &&
    SUPPORT_SCHEMA.properties.events.items.properties.type.enum.includes(row.type)));
  const jobs = new Map();
  for (const row of [...events].reverse()) {
    if (row.type !== 'job' || !row.job || jobs.has(row.job)) continue;
    jobs.set(row.job, {id:row.job, state:row.state, observed_at:row.at});
    if (jobs.size === SUPPORT_LIMITS.jobs) break;
  }
  const lastLending = [...events].reverse().find(row => row.type === 'lending');
  const version = appVersion.text?.trim();
  const facts = project(SUPPORT_SCHEMA, {
    schema_version:1,
    runtime:{app:version, node:process.versions.node, tray:null, os:process.platform, arch:process.arch,
      os_release:/^[0-9]+(?:\.[0-9]+){1,3}/.exec(release())?.[0]},
    install:{kind:installKind.text?.trim(),
      channel:check(SUPPORT_SCHEMA.properties.runtime.properties.app, version) === null && version ? version.includes('-preview.') ? 'preview' : 'stable' : null},
    settings:settings.value,
    lending:{state:lastLending?.state, observed_at:lastLending?.at}, readiness:readiness.value,
    events:safeEvents, errors:errors.rows.map(row => ({at:iso(row.at), job:jobAlias(row.job), code:row.code, phase:row.phase})),
    jobs:[...jobs.values()],
    sources:{settings:settings.status, readiness:readiness.status,
      events:history.status, errors:errors.status, app_version:appVersion.status, install_kind:installKind.status},
  });
  return facts;
}

// One regular tar member, fixed name/permissions/owners/time, no source paths or gzip filename.
function archiveOf(body) {
  const data = Buffer.from(body), header = Buffer.alloc(512);
  const octal = (value, size) => value.toString(8).padStart(size - 1, '0') + '\0';
  header.write('support.json'); header.write(octal(0o600, 8), 100);
  header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
  header.write(octal(data.length, 12), 124); header.write(octal(0, 12), 136);
  header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]));
}

export async function supportPreview(options) {
  const facts = await collectSupportFacts(options);
  const body = JSON.stringify(facts, null, 2) + '\n';
  if (Buffer.byteLength(body) > SUPPORT_LIMITS.jsonBytes) throw new Error('support_export_too_large');
  const archive = archiveOf(body);
  if (archive.length > SUPPORT_LIMITS.archiveBytes) throw new Error('support_export_too_large');
  return {filename:SUPPORT_FILENAME, entries:[{name:'support.json', body}], bytes:archive.length, archiveBase64:archive.toString('base64')};
}

/** Exclusive, private local save. Never overwrite an existing file (including a symlink). */
export async function saveSupportArchive(preview, output) {
  const archive = Buffer.from(preview.archiveBase64, 'base64');
  if (archive.length > SUPPORT_LIMITS.archiveBytes) throw new Error('support_export_too_large');
  await writeFile(output, archive, {flag:'wx', mode:0o600});
}
