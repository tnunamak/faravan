import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

// A lock the kernel releases when the holding process dies, so a live holder is never
// displaced by age or by a guess about a process id, and a dead holder never blocks.
//
//   Linux   an abstract-namespace Unix socket named after the lock file. bind() fails while
//           any live process (or this one) holds the name; the kernel frees it at exit.
//           Node cannot bind synchronously, so one helper thread per process owns the
//           sockets. The abstract namespace belongs to one network namespace: processes that
//           must exclude each other have to share it.
//   macOS   a BSD exclusive flock taken at open (O_EXLOCK) on a stable lock file that is
//           never renamed or unlinked. Untested on macOS in this release.
//   other   unsupported: a lock call throws, and callers must not collect.
//
// Two ways to ask the helper, one handshake. A request is pending, then granted or cancelled.
//   tryLockAsync  the wait is a message with a deadline and an abort signal; nothing blocks.
//   tryLock       for the ledger's few-millisecond critical sections, whose callers are
//                 synchronous. The caller waits on a shared word for at most SYNC_WAIT_MS.
// A request that gave up (deadline, abort) is cancelled: if the helper grants it later, the
// grant closes itself, so no lock is held that nobody can release.
//
// When the helper thread stops, every lock it held is gone with it. The handles say so:
// `held()` turns false, and the next request starts a new helper. A caller that is about to
// do something destructive checks `held()` first and refuses when it is false.
//
// A lock call never waits for another holder. selfTest() proves the primitive on this host.

const O_EXLOCK_DARWIN = 0x20;
export const SYNC_WAIT_MS = 400;
export const ASYNC_WAIT_MS = 5000;
const WORKER_SOURCE = `
import net from 'node:net';
import { parentPort } from 'node:worker_threads';
const held = new Map();
const pending = new Set();
const cancelled = new Set();
parentPort.on('message', ({ op, id, name, slot, ms }) => {
  if (op === 'release') { held.get(id)?.close(); held.delete(id); return; }
  if (op === 'cancel') {
    const server = held.get(id);
    if (server) { server.close(); held.delete(id); } else if (pending.has(id)) cancelled.add(id);
    return;
  }
  if (op === 'stall') { const end = Date.now() + ms; while (Date.now() < end); return; }
  const word = slot && new Int32Array(slot);
  const answer = value => { if (word) { Atomics.store(word, 0, value); Atomics.notify(word, 0); } else parentPort.postMessage({ id, value }); };
  pending.add(id);
  const server = net.createServer();
  server.once('error', error => { pending.delete(id); if (cancelled.delete(id)) return; answer(error?.code === 'EADDRINUSE' ? 2 : 3); });
  server.listen(name, () => {
    pending.delete(id);
    if (cancelled.delete(id)) { server.close(); return; }
    held.set(id, server); answer(1);
  });
});
`;

const unavailable = message => Object.assign(new Error(message), { code: 'lock_unavailable' });
let helper = null;
let nextId = 1;
let generation = 0;
const waiting = new Map();

const lockName = file => {
  let dir = path.dirname(path.resolve(file));
  try { dir = fs.realpathSync(dir); } catch { /* the directory does not exist yet: the caller creates it */ }
  return '\0faravan-store-lock:' + createHash('sha256').update(path.join(dir, path.basename(file))).digest('hex').slice(0, 40);
};

function startHelper() {
  if (helper) return helper;
  const worker = new Worker(WORKER_SOURCE, { eval: true, type: 'module' });
  const mine = ++generation;
  const lose = () => {
    if (helper === worker) helper = null;
    for (const [id, entry] of waiting) if (entry.generation === mine) { waiting.delete(id); entry.settle(null, unavailable('The lock helper stopped.')); }
  };
  worker.on('error', lose);
  worker.on('exit', lose);
  worker.on('message', ({ id, value }) => {
    const entry = waiting.get(id);
    // A grant for a request that gave up: close it at once, so nothing holds a lock nobody can release.
    if (!entry) { if (value === 1) worker.postMessage({ op: 'release', id }); return; }
    waiting.delete(id);
    entry.settle(value);
  });
  // After the listeners: adding a message listener references the worker's port again.
  worker.unref();
  helper = worker;
  helper.generation = mine;
  return helper;
}

function handleFor(worker, id) {
  let released = false;
  return {
    held: () => !released && helper === worker,
    release() { if (released) return; released = true; if (helper === worker) worker.postMessage({ op: 'release', id }); },
  };
}

function answerToHandle(worker, id, value) {
  if (value === 2) return null;
  if (value !== 1) throw unavailable('The lock could not be taken.');
  return handleFor(worker, id);
}

function linuxTry(file) {
  const worker = startHelper();
  const slot = new SharedArrayBuffer(4);
  const word = new Int32Array(slot);
  const id = nextId++;
  worker.postMessage({ op: 'acquire', id, name: lockName(file), slot });
  const waited = Atomics.wait(word, 0, 0, SYNC_WAIT_MS);
  if (waited === 'timed-out') {
    worker.postMessage({ op: 'cancel', id });
    throw unavailable('The lock helper did not answer.');
  }
  return answerToHandle(worker, id, Atomics.load(word, 0));
}

function linuxTryAsync(file, { signal, timeoutMs }) {
  const worker = startHelper();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => { give(); reject(signal.reason ?? Object.assign(new Error('The lock request was cancelled.'), { name: 'AbortError', code: 'aborted' })); };
    const give = () => { waiting.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.postMessage({ op: 'cancel', id }); };
    const settle = (value, error) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) return reject(error);
      try { resolve(answerToHandle(worker, id, value)); } catch (failure) { reject(failure); }
    };
    waiting.set(id, { settle, generation: worker.generation });
    timer = setTimeout(() => { give(); reject(unavailable('The lock helper did not answer.')); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ op: 'acquire', id, name: lockName(file) });
  });
}

function darwinTry(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | O_EXLOCK_DARWIN, 0o600); } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return null;
    throw unavailable(`The lock could not be taken (${error?.code}).`);
  }
  let released = false;
  return { held: () => !released, release() { if (released) return; released = true; try { fs.closeSync(fd); } catch { /* closed with the process */ } } };
}

export const lockSupported = () => process.platform === 'linux' || process.platform === 'darwin';

// One attempt, synchronous, for the ledger's short sections. A handle: held now. null: another
// holder is alive. Throws when locking is unavailable or the helper does not answer in time.
export function tryLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'linux') return linuxTry(file);
  if (process.platform === 'darwin') return darwinTry(file);
  throw Object.assign(new Error(`File locking is not supported on ${process.platform}.`), { code: 'lock_unsupported' });
}

// One attempt that never blocks the event loop. An aborted signal is refused before anything is asked.
export async function tryLockAsync(file, { signal, timeoutMs = ASYNC_WAIT_MS } = {}) {
  signal?.throwIfAborted?.();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'linux') return linuxTryAsync(file, { signal, timeoutMs });
  if (process.platform === 'darwin') return darwinTry(file);
  throw Object.assign(new Error(`File locking is not supported on ${process.platform}.`), { code: 'lock_unsupported' });
}

// Keeps the helper thread busy for `ms`. A test aid: it stands in for a stalled helper.
export function stallHelper(ms) { if (process.platform === 'linux') startHelper().postMessage({ op: 'stall', ms }); }
// Stops the helper thread. A test aid: it stands in for a helper that died.
export function killHelper() { const worker = helper; if (worker) { helper = null; worker.terminate(); } }

// Proves on this host that two attempts on one name exclude each other and that release frees it.
// It is a local probe of one process's own exclusion; it says nothing about another process or platform.
export function selfTest(dir) {
  try {
    const file = path.join(dir, `lock-selftest-${process.pid}-${nextId}`);
    const first = tryLock(file);
    if (!first) return { ok: false, reason: 'the first lock attempt was refused' };
    const second = tryLock(file);
    if (second) { second.release(); first.release(); return { ok: false, reason: 'two locks on one name were both granted' }; }
    first.release();
    let again = null;
    for (let i = 0; i < 100 && !again; i++) { again = tryLock(file); if (!again) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
    if (!again) return { ok: false, reason: 'a released lock was not free again' };
    again.release();
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
}
