import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {durableJson} from '../durable-write.mjs';

const fail = () => { throw new Error('invalid_account_secret_reference'); };
const binding = b => b && typeof b.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(b.id) &&
  typeof b.providerId === 'string' && b.providerId.length > 0 &&
  Number.isSafeInteger(b.generation) && b.generation >= 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail();
  fs.chmodSync(directory, 0o700);
}
// Host-only, Faravan-owned files. No native credential discovery, runtime or timers.
// Immutable objects precede metadata publication; ambiguous publish failures retain
// both old and new objects. No speculative orphan collection during recovery.
export function createAccountVault({directory}) {
  privateDirectory(directory);
  const file = (ref, account) => {
    if (!binding(account) || !ref || ref.schemaVersion !== 1 || !uuid.test(ref.id) ||
        ref.accountId !== account.id || ref.providerId !== account.providerId ||
        ref.generation !== account.generation) fail();
    return path.join(directory, ref.id + '.json');
  };
  return {
    put(account, value) {
      if (!binding(account)) fail();
      const ref = {schemaVersion:1,id:randomUUID(),accountId:account.id,
        providerId:account.providerId,generation:account.generation};
      const target = file(ref, account);
      durableJson(target, {schemaVersion:1,reference:ref,value});
      fs.chmodSync(target, 0o600);
      return ref;
    },
    get(ref, account) {
      const target = file(ref, account);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
          (stat.mode & 0o077) !== 0) fail();
      const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (stored.schemaVersion !== 1 || JSON.stringify(stored.reference) !== JSON.stringify(ref) ||
          !Object.hasOwn(stored, 'value')) fail();
      return stored.value;
    },
    remove(ref, account) {
      const target = file(ref, account);
      // Validate content and ownership before deleting a referenced object.
      try { this.get(ref, account); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      fs.unlinkSync(target);
    },
  };
}
