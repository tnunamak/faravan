import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {durableWrite} from '../durable-write.mjs';

const VERSION = 1;
const MAX_BYTES = 4096;

function storageError() {
  // Do not put paths, account details or raw filesystem errors in public state.
  return Object.freeze(Object.assign(new Error('Docker sign-in state could not be saved or read.'),
    {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'}));
}

/**
 * A small, synchronous refusal store for the single-instance app.
 *
 * read(): null, or a frozen {epoch} refusal. Storage errors return a frozen
 * {epoch, error} blocker, latched until an explicit refuse() saves successfully.
 * refuse(): saves a fresh epoch and returns {epoch}; on failure it throws the
 * sanitized error and leaves read() blocked in this instance.
 * clear(epoch): returns the current refusal on a stale token, otherwise saves
 * a clear record and returns null. A storage error throws and remains blocked.
 *
 * The caller captures the epoch before dispatching a create. A successful
 * create may clear only that exact epoch, never a newer refusal. Re-reading
 * disk fences other stores used sequentially in the same process and restarts.
 * This is not an interprocess CAS: simultaneous app processes must be excluded
 * by the app's single-instance guard. sbxHome identity is lexical path.resolve,
 * not realpath, so this helper never reads sbx credentials or follows sbxHome.
 *
 * Durable-write failures are never acknowledged as success. No store can
 * promise persistence across restart when storage itself rejects writes; the
 * caller must surface the error rather than claim durable refusal/recovery.
 */
export function createDockerSignInState({home, sbxHome} = {}) {
  if (typeof home !== 'string' || !home || typeof sbxHome !== 'string' || !sbxHome) {
    throw new TypeError('App home and sbx home are required');
  }
  const identity = createHash('sha256').update(path.resolve(sbxHome)).digest('hex');
  const directory = path.join(path.resolve(home), 'v1');
  const file = path.join(directory, `docker-signin-${identity}.json`);
  let fault = null;

  const failClosed = epoch => {
    fault ??= Object.freeze({epoch: epoch ?? randomUUID(), error: storageError()});
    return fault;
  };
  const checkDirectory = () => {
    try {
      if (!fs.lstatSync(directory).isDirectory()) throw storageError();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  const checkFile = () => {
    checkDirectory();
    try {
      if (!fs.lstatSync(file).isFile()) throw storageError();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  const write = epoch => {
    checkFile();
    durableWrite(file, JSON.stringify({version: VERSION, sbxHome: identity, epoch}));
  };

  function read() {
    if (fault) return fault;
    let fd, result;
    try {
      checkFile();
      try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw storageError();
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!state || Array.isArray(state) || typeof state !== 'object'
        || Object.keys(state).sort().join(',') !== 'epoch,sbxHome,version'
        || state.version !== VERSION || state.sbxHome !== identity
        || (state.epoch !== null && (typeof state.epoch !== 'string' || !state.epoch))) {
        throw storageError();
      }
      result = state.epoch === null ? null : Object.freeze({epoch: state.epoch});
    } catch {
      return failClosed();
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); }
        catch { failClosed(); }
      }
    }
    return fault ?? result;
  }

  function refuse() {
    const epoch = randomUUID();
    try { write(epoch); }
    catch { throw failClosed(epoch).error; }
    fault = null;
    return Object.freeze({epoch});
  }

  function clear(expectedEpoch) {
    const current = read();
    if (!current || current.epoch !== expectedEpoch) return current;
    if (current.error) throw current.error;
    try { write(null); }
    catch {
      // A barrier can fail after rename. Best-effort restoration keeps the
      // old refusal on disk when possible; the failure stays latched either way.
      try { write(current.epoch); } catch {}
      throw failClosed(current.epoch).error;
    }
    return null;
  }

  return Object.freeze({read, refuse, clear});
}
