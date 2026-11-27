// Linux preview profile transaction. The launcher holds its destination flock
// through this call and service startup. Profile locks exclude cooperating writers.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, createPrivateKey, randomUUID} from 'node:crypto';
import childProcess from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as protocol from './protocol/index.mjs';
import {acquireProcessLockSync, profileWriterLockPath} from './v1/lock.mjs';
import {ensureDurableDirectory, syncDirectory} from './durable-directory.mjs';

const markerName = '.migration-complete';
const type = 'faravan-channel-migration';
const fail = message => { throw new Error(message); };
const sameObject = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;

// null means absent; an exception means unknown. ENOTDIR is never absence.
function observe(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directory(file) {
  const st = observe(file);
  if (!st?.isDirectory()) fail(`Expected a real directory: ${file}`);
  return st;
}

function checkedPath(file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\x00-\x1f\x7f]/.test(file))
    fail(`Expected an absolute normalized path without control characters: ${JSON.stringify(file)}`);
  // Check every ancestor, including missing ancestors: a dangling symlink must
  // not make a missing child look like an absent profile.
  const parent = path.dirname(file);
  if (parent !== file) {
    const st = checkedPath(parent);
    if (st && !st.isDirectory()) fail(`Non-directory profile ancestor: ${parent}`);
  }
  const st = observe(file);
  if (st?.isSymbolicLink()) fail(`Symlinked profile path: ${file}`);
  return st;
}

function readRegular(file, read) {
  const before = observe(file);
  if (!before?.isFile() || before.nlink !== 1) fail(`Not an independent regular file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!sameObject(before, opened) || !opened.isFile() || opened.nlink !== 1) fail(`Changed file: ${file}`);
    const result = read(fd, opened);
    const after = fs.fstatSync(fd);
    if (!sameObject(after, observe(file)) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      fail(`File changed while reading: ${file}`);
    return result;
  } finally { fs.closeSync(fd); }
}

function text(file) {
  return readRegular(file, (fd, st) => {
    if (st.size > 4 * 1024 * 1024) fail(`Profile record too large: ${file}`);
    return fs.readFileSync(fd, 'utf8');
  });
}

function inventory(home, {allowMarker = false, sync = false, heldLocks = new Set()} = {}) {
  const result = [];
  function visit(relative) {
    const file = path.join(home, relative), st = observe(file);
    if (st?.isDirectory()) {
      // This process owns these locks. Their registrations are transient lock
      // metadata, never profile data; contenders cannot enter while we hold them.
      const names = heldLocks.has(file) ? [] : fs.readdirSync(file).sort();
      if (relative.endsWith('.owners-v1') && names.length) fail(`Profile writer ownership is unknown: ${path.join(file,names[0])}; refusing automatic takeover`);
      result.push([relative, 'directory']);
      for (const name of names) {
        if (!relative && name === markerName) {
          if (!allowMarker) fail(`Reserved migration marker in profile: ${file}`);
          continue;
        }
        visit(path.join(relative, name));
      }
      if (!sameObject(st, observe(file))) fail(`Directory changed while reading: ${file}`);
      if (sync) syncDirectory(file);
    } else {
      const digest = readRegular(file, fd => {
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
        if (sync) fs.fsyncSync(fd);
        return hash.digest('hex');
      });
      result.push([relative, 'file', digest]);
    }
  }
  visit('');
  return result;
}

function validateProfile(home) {
  directory(path.join(home, 'v1'));
  const state = JSON.parse(text(path.join(home, 'v1/state.json')));
  if (state?.version !== 1 || !Array.isArray(state.circles) ||
      state.circles.some(circle => !circle || typeof circle.id !== 'string') ||
      state.activeCircle != null && !state.circles.some(circle => circle.id === state.activeCircle))
    fail(`Invalid committed device state: ${home}`);
  const key = createPrivateKey(text(path.join(home, 'v1/device.pem')));
  if (key.asymmetricKeyType !== 'ed25519') fail(`Invalid device key: ${home}`);
  const keyId = protocol.fingerprint(key), ids = new Set();
  for (const circle of state.circles) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(circle.id) || ids.has(circle.id))
      fail(`Invalid or duplicate circle identity: ${home}`);
    ids.add(circle.id);
    // Committed membership requires its signed cache. Pending enrollments with
    // no cache must be completed/reconciled before migration, never certified.
    const cache = JSON.parse(text(path.join(home, 'v1/circles', circle.id, 'roster.json')));
    if (!cache.current || !Array.isArray(cache.history)) fail(`Incomplete roster cache: ${circle.id}`);
    for (const envelope of [...cache.history, cache.current]) {
      const checked = protocol.verifyRoster(envelope, {circle:circle.id, rootFingerprint:circle.pinnedRootFingerprint,
        now:() => Date.parse(envelope?.payload?.issued_at) / 1000});
      if (!checked.ok) fail(`Invalid roster for ${circle.id}: ${checked.code}`);
    }
    const roster = cache.current.payload;
    if (cache.highestAcceptedEpoch !== roster.epoch || cache.highestAcceptedDigest !== protocol.digest(roster) ||
        (roster.coordinator ?? null) !== circle.origin || (roster.lan_mode === true) !== (circle.lanMode === true))
      fail(`Inconsistent circle cache: ${circle.id}`);
    if ((circle.owned || circle.steward || circle.admin || circle.rosterMembershipVerified) && !roster.members.some(member => member.key_id === keyId))
      fail(`Device key does not match circle membership: ${circle.id}`);
    if (circle.owned && !roster.authority_chain) {
      const root = createPrivateKey(text(path.join(home, 'v1/roots', circle.id + '.pem')));
      if (protocol.fingerprint(root) !== circle.pinnedRootFingerprint) fail(`Wrong circle root key: ${circle.id}`);
    }
    if (roster.authority_chain) {
      const {ok, authority} = protocol.chainVerify(roster.authority_chain, {circle:circle.id,
        rootFingerprint:circle.pinnedRootFingerprint, coordinator:circle.origin});
      if (!ok || !!circle.owned !== (authority.owner.key_id === keyId) ||
          !!circle.steward !== (authority.steward?.key_id === keyId) ||
          !!circle.admin !== authority.admins.some(admin => admin.key_id === keyId))
        fail(`Inconsistent circle authority: ${circle.id}`);
    }
  }
  const settings = path.join(home, 'v1/app-settings.json');
  if (observe(settings)) {
    const value = JSON.parse(text(settings));
    if (!value || value.version !== 1 || Array.isArray(value)) fail(`Invalid app settings: ${home}`);
  }
}

// Private temp -> file sync -> exact file rename -> parent sync, as in v1's
// atomic writers. Failed temps are retained for diagnosis, never used as proof.
function writeRecord(file, value) {
  // Keep failed marker temporaries outside the profile being published.
  const scratch = path.basename(file) === markerName ? path.dirname(path.dirname(file)) : path.dirname(file);
  const temporary = path.join(scratch, `.faravan-preview-record.${randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const current = observe(file);
  if (current && (!current.isFile() || current.nlink !== 1)) fail(`Invalid transaction record target: ${file}`);
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

function validMarker(marker, destination) {
  return marker?.type === type && marker.version === 2 && marker.destination === destination &&
    /^[0-9a-f-]{36}$/.test(marker.transaction ?? '') && ['copy', 'fresh'].includes(marker.mode);
}

function readMarker(home, destination) {
  const marker = JSON.parse(text(path.join(home, markerName)));
  if (!validMarker(marker, destination)) fail(`Invalid migration marker: ${home}`);
  return marker;
}

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function activate(stage, destination, identity) {
  if (observe(destination)) fail(`Destination appeared before activation: ${destination}`);
  // GNU mv -T cannot nest, -n cannot replace. A skipped -n move also exits 0:
  // require the exact staged inode at destination and absence of the old name.
  // --no-copy forbids a cross-device copy/delete fallback.
  const moved = childProcess.spawnSync('/usr/bin/mv', ['--no-copy', '--no-clobber', '--no-target-directory', '--', stage, destination], {encoding:'utf8'});
  if (moved.error) throw moved.error;
  if (moved.status !== 0 || observe(stage) || !sameObject(identity, observe(destination)))
    fail(`Exact activation failed: ${moved.stderr || destination}`);
}

export function requireExactMove() {
  const version = childProcess.spawnSync('/usr/bin/mv', ['--version'], {encoding:'utf8'});
  if (version.error || version.status !== 0 || !version.stdout.includes('GNU coreutils'))
    fail('The system mv is not GNU coreutils; GNU coreutils 9.2 or newer with --no-copy is required.');
  const result = childProcess.spawnSync('/usr/bin/mv', ['--no-copy', '--no-clobber', '--no-target-directory', '--version'], {encoding:'utf8'});
  if (result.error || result.status !== 0 || !result.stdout.includes('GNU coreutils'))
    fail('The system mv must be GNU coreutils 9.2 or newer with --no-copy (Ubuntu 24.04 and Debian 13 include it; Ubuntu 22.04 and Debian 12 do not).');
}

// Fail-closed diagnostic projection: never persist arbitrary app text, URLs,
// tokens, paths, or fragments. Only fixed, recognized errno labels survive.
// This deliberately sacrifices message detail rather than guessing link syntax.
export function createPreviewDiagnostics(home) {
  checkedPath(home);
  directory(home);
  // Startup may fail before v1 exists. Keep diagnostics outside the profile so
  // its committed fresh marker still authorizes a retry without weakening validation.
  const diagnosticsHome = path.join(path.dirname(home), '.' + path.basename(home) + '.diagnostics');
  if (!checkedPath(diagnosticsHome)) fs.mkdirSync(diagnosticsHome, {mode:0o700});
  const diagnosticsStat = directory(diagnosticsHome);
  if (diagnosticsStat.uid !== process.getuid() || (diagnosticsStat.mode & 0o077))
    fail('Unsafe preview diagnostic directory');
  const file = path.join(diagnosticsHome, 'preview-app-stderr.log');
  const before = observe(file);
  if (before && (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()))
    fail('Unsafe preview diagnostic file');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid() ||
        (before && !sameObject(before, opened)) || !sameObject(opened, observe(file)))
      fail('Changed preview diagnostic file');
    fs.fchmodSync(fd, 0o600);
    fs.ftruncateSync(fd, 0);
  } catch (error) { fs.closeSync(fd); throw error; }
  const limit = 64 * 1024;
  let written = 0, line = '', oversized = false, closed = false;
  const flush = () => {
    if (!line && !oversized) return;
    const code = !oversized && line.match(/\b(EACCES|EPERM|ENOENT|ENOSPC|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|ENOMEM|EMFILE|EIO)\b/)?.[1];
    const safe = Buffer.from(code ? 'app stderr: ' + code + ' (detail withheld)\n' : 'app stderr: detail withheld (may contain sign-in information)\n');
    if (written + safe.length <= limit) {
      fs.writeFileSync(fd, safe);
      written += safe.length;
    }
    line = ''; oversized = false;
  };
  return {
    file,
    write(chunk) {
      if (closed) return;
      for (const byte of chunk) {
        if (byte === 10) flush();
        else if (!oversized) {
          if (line.length >= 4096) { line = ''; oversized = true; }
          else line += String.fromCharCode(byte);
        }
      }
    },
    close() {
      if (closed) return;
      try { flush(); } finally { closed = true; fs.closeSync(fd); }
    },
  };
}

export async function runPreviewApp(home, executable, args = ['app', '--json']) {
  const diagnostics = createPreviewDiagnostics(home);
  return await new Promise(resolve => {
    let child, failed = false;
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const handlers = signals.map(signal => () => child?.kill(signal));
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    try { child = childProcess.spawn(executable, args, {stdio:['ignore', 'ignore', 'pipe']}); }
    catch { diagnostics.close(); resolve(1); return; }
    signals.forEach((signal, i) => process.on(signal, handlers[i]));
    child.stderr.on('data', chunk => {
      try { diagnostics.write(chunk); }
      catch { failed = true; child.kill('SIGTERM'); }
    });
    child.on('error', () => { failed = true; });
    child.on('close', (code, signal) => {
      cleanup();
      try { diagnostics.close(); } catch { failed = true; }
      resolve(failed ? 1 : signal ? ({SIGTERM:143, SIGINT:130, SIGHUP:129}[signal] ?? 1) : code ?? 1);
    });
  });
}

/** Refuse uncertainty; retain source, stage and journal on every failure.
 * Caller must serialize all launchers for this canonical destination.
 */
export function migratePreviewProfile({source, destination, base, onPrepare = () => {}}) {
  const target = checkedPath(destination);
  if (target && !target.isDirectory()) fail(`Invalid destination: ${destination}`);
  ensureDurableDirectory(path.dirname(destination), {base});
  if (source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/'))
    fail('Source and destination alias or contain each other');
  const journal = path.join(path.dirname(destination), `.faravan-preview-transaction.${createHash('sha256').update(destination).digest('hex')}.json`);
  let stage;
  const releases = [], heldLocks = new Set();
  const scan = (home, options) => inventory(home, {...options, heldLocks});
  const excludeWriters = (home, {app = true} = {}) => {
    const v1 = path.join(home, 'v1');
    const st = checkedPath(v1);
    if (!st) return; // A fresh, marker-only destination has no device state yet.
    directory(v1);
    for (const name of [...(app ? ['app.lock'] : []), 'state.lock']) {
      const lock = path.join(v1, name);
      releases.push(acquireProcessLockSync(lock));
      heldLocks.add(lock + '.owners-v1');
    }
  };
  try {
    const markerStat = target ? observe(path.join(destination, markerName)) : null;
    const journalStat = observe(journal);
    const previous = journalStat ? JSON.parse(text(journal)) : null;
    if (journalStat && (!previous || typeof previous !== 'object' || Array.isArray(previous)))
      fail('Invalid migration transaction record');
    if (target && !journalStat)
      fail(`Unproven destination requires explicit reconciliation: ${destination}`);
    if (previous?.marker?.mode === 'adopt')
      fail(`Unproven adoption requires explicit reconciliation: ${destination}`);
    let legacy;
    if (previous?.phase === 'committed') {
      // Publication is finished. Verify its receipt and device state under the
      // writer/state locks without contending with the running app's lifetime lock.
      releases.push(acquireProcessLockSync(profileWriterLockPath(destination)));
      if (target) excludeWriters(destination, {app:false});
    } else {
      onPrepare();
      checkedPath(source);
      releases.push(acquireProcessLockSync(profileWriterLockPath(source)));
      releases.push(acquireProcessLockSync(profileWriterLockPath(destination)));
      legacy = checkedPath(source);
      if (legacy && (!legacy.isDirectory() || sameObject(legacy, target))) fail(`Invalid or aliased source: ${source}`);
      if (legacy) excludeWriters(source);
      if (target) excludeWriters(destination);
    }
    if (previous) {
      const record = previous;
      const marker = record.marker;
      stage = record.stage;
      if (!validMarker(marker, destination) || !['prepared', 'committed'].includes(record.phase) ||
          !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino) ||
          !Array.isArray(record.inventory) || typeof stage !== 'string' ||
          path.dirname(stage) !== path.dirname(destination) || !path.basename(stage).startsWith('.faravan-preview-copying.'))
        fail('Invalid migration transaction record');
      if (!sameObject(record, target) || !markerStat || !equal(readMarker(destination, destination), marker))
        fail('Unfinished migration: destination does not match the prepared transaction');
      if (observe(stage)) fail('Both stage and destination exist; refusing ambiguous recovery');
      if (record.phase === 'prepared') {
        // Process death after rename: only the recorded inode and full durable
        // inventory can finish this commit. Never activate a leftover old stage.
        if (!equal(scan(destination, {allowMarker:true, sync:true}), record.inventory))
          fail('Prepared profile changed; refusing recovery');
        syncDirectory(path.dirname(destination));
        writeRecord(journal, {...record, phase:'committed'});
      }
      // A fresh transaction authorizes only an empty home to initialize. Its
      // historical mode cannot waive validation of later application state.
      const awaitingInitialization = marker.mode === 'fresh' && fs.readdirSync(destination).every(name => name === markerName);
      if (!awaitingInitialization) validateProfile(destination);
      // A previous call may have renamed the committed journal but failed its
      // parent sync. Seeing that record in cache does not settle durability.
      syncDirectory(path.dirname(destination));
      return {status:'committed', mode:marker.mode};
    }
    let mode, before;
    if (legacy) {
      before = scan(source);
      validateProfile(source);
      mode = 'copy';
    } else {
      mode = 'fresh';
    }
    requireExactMove();
    stage = fs.mkdtempSync(path.join(path.dirname(destination), '.faravan-preview-copying.'));
    if (mode === 'copy') {
      for (const [relative, kind] of before) {
        if (!relative) continue;
        const to = path.join(stage, relative);
        if (kind === 'directory') fs.mkdirSync(to, {mode:0o700});
        else {
          fs.copyFileSync(path.join(source, relative), to, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(to, 0o600);
        }
      }
      validateProfile(stage);
      if (!equal(before, scan(stage)) || !equal(before, scan(source))) fail('Source changed during staging');
    }

    const contents = scan(stage, {sync:true});
    if (before && !equal(before, contents)) fail('Profile changed before preparation');
    const marker = {type, version:2, transaction:randomUUID(), mode, destination};
    // Publish the marker only after the entire profile is flushed. A marker
    // alone never authorizes startup: the sibling journal must also commit.
    writeRecord(path.join(stage, markerName), marker);
    const identity = directory(stage);
    const record = {phase:'prepared', marker, source, stage, dev:identity.dev, ino:identity.ino, inventory:contents};
    writeRecord(journal, record);
    activate(stage, destination, identity);
    syncDirectory(path.dirname(destination));
    writeRecord(journal, {...record, phase:'committed'});
    return {status:'committed', mode};
  } catch (error) {
    error.message += `; refusing startup. Retained source=${source}, destination=${destination}, stage=${stage ?? 'not allocated'}, journal=${journal}`;
    throw error;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--check-mv') requireExactMove();
    else if (process.argv[2] === '--app') process.exitCode = await runPreviewApp(process.argv[3], process.argv[4], process.argv.length > 5 ? process.argv.slice(5) : undefined);
    else if (process.argv[2] === '--mkdir') ensureDurableDirectory(process.argv[3], {base:process.argv[4]});
    else migratePreviewProfile({source:process.argv[2], destination:process.argv[3], base:process.argv[4], onPrepare:() => {
      console.error(`Before migration or recovery, stop all versions of Faravan, including trays, apps and CLI commands, and back up both profiles. Older binaries do not take the writer gate.\nSource: ${process.argv[2]}\nDestination: ${process.argv[3]}\nIf ownership is unknown, leave the named lock entry intact and follow MIGRATION.md in the preview bundle.`);
    }});
  }
  catch (error) { console.error(process.argv[2] === '--app' ? 'Preview app diagnostic startup failed' : error.message); process.exitCode = 1; }
}
