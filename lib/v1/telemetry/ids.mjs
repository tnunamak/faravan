// Random IDs of the catalog's fixed pattern: a one-letter kind, a dash and 20 base32 characters (100 random bits).
import { randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** randomId('r') -> "r-…". `bytes(n)` is injectable so tests are deterministic. */
export function randomId(kind, bytes = randomBytes) {
  const raw = bytes(20);
  let id = kind + '-';
  for (let i = 0; i < 20; i++) id += BASE32[raw[i] & 31];
  return id;
}

/** Random UUID with an injectable byte source; never based on machine or account information. */
export function installUuid(bytes = randomBytes) {
  const raw=Buffer.from(bytes(16));
  if(raw.length!==16)throw new Error('invalid_random_source');
  raw[6]=(raw[6]&15)|64;raw[8]=(raw[8]&63)|128;
  const hex=raw.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
