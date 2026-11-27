// The crash and start-failure marker: one inbox file written synchronously from a dying process. Frames are
// {file, line} against the shipped-file manifest of the catalog; the message, the stack text and every other path
// are dropped. It follows the edge-producer rule: no write when off (design §2.2, §2.3).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucket, canonicalJson, enumMembers, parseInboxFile, SCHEMA_VERSION, INBOX_FORMAT } from './catalog.mjs';
import { withEdgeLease } from './consent.mjs';
import { randomId } from './ids.mjs';

const MAX_INBOX_FILES = 200;
const CRASH_LOOP_MS = 5 * 60000;
const FRAME = /\(?((?:file:\/\/)?\/[^()\s]+?):(\d+):\d+\)?\s*$/;

/** The `{file, line}` frames of an error's stack that are shipped files, at most 16. */
export function framesOf(error, files = new Set(enumMembers('shipped_file'))) {
  const shipped = [...files];
  const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1) : [];
  const frames = [];
  for (const line of stack) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const path = match[1].replace(/^file:\/\//, '');
    const file = shipped.find(member => path === member || path.endsWith('/' + member));
    if (file) frames.push({file, line: Math.min(Number(match[2]), 1000000)});
    if (frames.length === 16) break;
  }
  return frames;
}

/**
 * Write the crash file for `error` (or just a kind, for a start failure). Never throws: a dying process must not
 * fail twice. Returns true when a file was written.
 */
export function writeCrashFile({dir, env = process.env, kind, error, uptimeMs = 0, now = Date.now, bytes}) {
  try {
    return withEdgeLease({dir,env,now},({gen,capture})=>{
      const inbox = join(dir, 'inbox');
      mkdirSync(inbox, {recursive: true, mode: 0o700});
      if (readdirSync(inbox).length >= MAX_INBOX_FILES) return false;
      const marker = join(dir, 'crash-last');
      let loop = false;
      try { loop = now() - Number(readFileSync(marker, 'utf8')) < CRASH_LOOP_MS; } catch { /* first crash */ }
      writeFileSync(marker, String(now()), {mode: 0o600});
      const errno = typeof error?.code === 'string' && enumMembers('errno').includes(error.code) ? error.code : 'none';
      const errorClass = enumMembers('js_error_class').includes(error?.constructor?.name) ? error.constructor.name : 'other';
      const hour = new Date(now()).toISOString().slice(0, 13);
      const file = {format: INBOX_FORMAT, schema_version: SCHEMA_VERSION, origin: 'crash', gen, capture,
        record: {name: 'app.crash', kind: 'event', hour, attrs: {'crash.kind': kind, 'js.error_class': errorClass, errno, frames: framesOf(error), uptime: bucket('duration_s', uptimeMs / 1000), crash_loop: loop}}};
      writeInboxText(inbox, canonicalJson(file), bytes);
      return true;
    })===true;
  } catch {
    return false;
  }
}

/** The schema version edge producers write: the lowest catalog version at which every member they use is live (the goldens pin it). */
export const EDGE_SCHEMA_VERSION = 1;

/**
 * One record from an outside producer (the coordinator, the installer). The caller names the origin and the record. The
 * generation and capture proof come from the shared remote lease, and the file is validated by the app's own parser
 * before it is written, so a producer cannot queue a file the app would drop. Never throws. Returns true when written.
 */
export function writeInboxRecord({dir, env = process.env, origin, record, schemaVersion = EDGE_SCHEMA_VERSION, bytes, now=Date.now}) {
  try {
    return withEdgeLease({dir,env,now},({gen,capture})=>{
      const inbox = join(dir, 'inbox');
      mkdirSync(inbox, {recursive: true, mode: 0o700});
      if (readdirSync(inbox).length >= MAX_INBOX_FILES) return false;
      const text = canonicalJson({format: INBOX_FORMAT, schema_version: schemaVersion, origin, gen, capture, record});
      parseInboxFile(text); // throws for anything the app would reject
      writeInboxText(inbox, text + '\n', bytes);
      return true;
    })===true;
  } catch {
    return false;
  }
}

/**
 * The install.run span of one installer run (docs/design/TELEMETRY.md §3.4): its method, its outcome and how long it took.
 * Any outcome other than ok is an error. A value the catalog does not list is rejected, not written.
 */
export function writeInstallRun({dir, env = process.env, method, outcome, durationMs,now=Date.now}) {
  return writeInboxRecord({dir, env, now,origin: 'installer', schemaVersion: lowestSchemaFor('install_outcome', outcome),
    record: {name: 'install.run', kind: 'span', hour: new Date(now()).toISOString().slice(0, 13),
      duration_ms: durationMs, status: outcome === 'ok' ? 'ok' : 'error', attrs: {method, outcome}}});
}

// The lowest catalog version at which an enum member is live. A record is valid at a version only if every member it uses
// is live there, so a member added later (deferred, in schema 2) must be written at the version that introduced it.
function lowestSchemaFor(enumName, value) {
  for (let version = EDGE_SCHEMA_VERSION; version < SCHEMA_VERSION; version++) {
    if (enumMembers(enumName, version).includes(value)) return version;
  }
  return SCHEMA_VERSION;
}

// Written under a temporary name, synced and renamed: the app never reads half a file, and ignores *.tmp.
function writeInboxText(inbox, text, bytes) {
  const target = join(inbox, randomId('c', bytes) + '.json'), temp = target + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, target);
}

/**
 * Register the monitor on this process. `uncaughtExceptionMonitor` observes without handling, so Node's default crash
 * (the stderr text and the exit code) is unchanged. The write is synchronous because the process is dying.
 */
export function installCrashMonitor({dir, env = process.env, proc = process}) {
  proc.on('uncaughtExceptionMonitor', (error, origin) => {
    writeCrashFile({dir, env, kind: origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception', error, uptimeMs: proc.uptime() * 1000});
  });
}
