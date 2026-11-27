import path from 'node:path';
import { createDiskLedger } from './disk-ledger.mjs';
import { createStoreCoordinator } from './store-lock.mjs';

// THE STORE PROTOCOL. The sbx HOME belongs to this app. Everything the app records about the
// disk it causes sbx to use, and every lock that orders its writers, lives in that directory and
// is keyed by it:
//
//   disk-ledger.json   what the app owns and what protects it (lib/disk-ledger.mjs)
//   disk-dispatch.lock the gate: every create, reuse, renewal and removal holds it
//   disk-sweep.lock    one sweep per store
//
// Every writer is this app: the app, its CLI, a second app process, or another profile that maps
// to the same sbx HOME. They all open the store here, so they all read the same ledger and queue
// on the same gate. A foreign tool writing into the app's private sbx HOME is out of scope; what
// it makes is never owned, so it is never removed.

export const DISK_LEDGER_FILE = 'disk-ledger.json';
export const diskLedgerFile = sbxHome => path.join(sbxHome, DISK_LEDGER_FILE);

const open = new Map();

// The one store of `home`. `legacyLedgerFile` is where an earlier release kept the record, in the
// profile directory; it is read once to keep its roots (see upgradeLedger) and never changed.
export function openDiskStore({ home, legacyLedgerFile = null, now = Date.now } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('The disk store needs the absolute sbx HOME.');
  const key = path.resolve(home);
  let store = open.get(key);
  if (!store) {
    store = { home: key, ledger: createDiskLedger({ file: diskLedgerFile(key), legacyFile: legacyLedgerFile, now }), coordinator: createStoreCoordinator({ dir: key }) };
    open.set(key, store);
  }
  return store;
}
