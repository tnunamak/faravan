import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

export class ProtocolError extends Error {
  /** A stable protocol failure; messages never include input or secret material. */
  constructor(code) { super(code); this.name = 'ProtocolError'; this.code = code; }
}
export function fail(code = 'invalid_request') { throw new ProtocolError(code); }
export function guard(fn) {
  try { return fn(); } catch (error) {
    return { ok: false, code: error instanceof ProtocolError ? error.code : 'invalid_request' };
  }
}
export function need(value, code = 'invalid_request') { if (!value) fail(code); }
export function object(value, required, optional = []) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(required.every(k => Object.hasOwn(value, k)));
  need(Object.keys(value).every(k => required.includes(k) || optional.includes(k)));
}
function unicode(s) {
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = s.charCodeAt(++i); need(next >= 0xdc00 && next <= 0xdfff, 'invalid_unicode');
    } else need(n < 0xdc00 || n > 0xdfff, 'invalid_unicode');
  }
}
/** Return RFC 8785 canonical text; reject non-JSON types, cycles and invalid Unicode. */
export function canonicalize(value) {
  const seen = new Set();
  function encode(v, depth) {
    need(depth <= 16, 'depth_exceeded');
    if (v === null) return 'null';
    if (typeof v === 'string') { unicode(v); return JSON.stringify(v); }
    if (typeof v === 'number') { need(Number.isFinite(v), 'invalid_number'); return JSON.stringify(v); }
    if (typeof v === 'boolean') return String(v);
    need(v && typeof v === 'object', 'invalid_json');
    need(!seen.has(v), 'invalid_json'); seen.add(v);
    let result;
    if (Array.isArray(v)) {
      need(Object.keys(v).length === v.length, 'invalid_json');
      result = '[' + Array.from(v, x => encode(x, depth + 1)).join(',') + ']';
    } else {
      need(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'invalid_json');
      need(Reflect.ownKeys(v).every(k => typeof k === 'string'), 'invalid_json');
      result = '{' + Object.keys(v).sort().map(k => {
        unicode(k);
        const descriptor = Object.getOwnPropertyDescriptor(v, k);
        need(descriptor && Object.hasOwn(descriptor, 'value'), 'invalid_json');
        return JSON.stringify(k) + ':' + encode(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    seen.delete(v); return result;
  }
  return encode(value, 0);
}
/** Parse bounded UTF-8 JSON, rejecting duplicates, fractions, negative zero and unsafe integers and optionally noncanonical bytes. */
export function strictParse(input, { canonical = true } = {}) {
  let text;
  try {
    if (typeof input === 'string') { unicode(input); text = input; }
    else { need(input instanceof Uint8Array); text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
  } catch (e) { if (e instanceof ProtocolError) throw e; fail('invalid_utf8'); }
  need(Buffer.byteLength(text) <= 262144, 'payload_too_large');
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? '\u0000')) i++; };
  function string() {
    const start = i++; let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"' && !escaped) {
        let s; try { s = JSON.parse(text.slice(start, i)); } catch { fail('invalid_json'); }
        unicode(s); return s;
      }
      if (c === '\\' && !escaped) escaped = true; else escaped = false;
    }
    fail('invalid_json');
  }
  function value(depth) {
    need(depth <= 16, 'depth_exceeded'); ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; ws(); const out = {}; const keys = new Set();
      if (text[i] === '}') { i++; return out; }
      while (true) {
        need(text[i] === '"', 'invalid_json'); const key = string();
        need(!keys.has(key), 'duplicate_key'); keys.add(key); ws();
        need(text[i++] === ':', 'invalid_json');
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws(); const end = text[i++]; if (end === '}') return out;
        need(end === ',', 'invalid_json'); ws();
      }
    }
    if (text[i] === '[') {
      i++; ws(); const out = []; if (text[i] === ']') { i++; return out; }
      while (true) {
        out.push(value(depth + 1)); ws(); const end = text[i++]; if (end === ']') return out;
        need(end === ',', 'invalid_json'); ws();
      }
    }
    for (const [token, v] of [['null', null], ['true', true], ['false', false]]) {
      if (text.startsWith(token, i)) { i += token.length; return v; }
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    need(m, 'invalid_json'); i += m[0].length; const n = Number(m[0]);
    need(Number.isSafeInteger(n) && !Object.is(n, -0), 'invalid_number'); return n;
  }
  const result = value(0); ws(); need(i === text.length, 'invalid_json');
  if (canonical) need(canonicalize(result) === text, 'noncanonical_json');
  return result;
}
/** SHA-256 digest of exact bytes, in the protocol's prefixed lowercase form. */
export function digestBytes(bytes) { need(bytes instanceof Uint8Array); return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
/** SHA-256 digest of RFC8785 payload bytes, not an envelope. */
export function digest(value) { return digestBytes(Buffer.from(canonicalize(value))); }
/** Decode canonical unpadded base64url, optionally checking the exact byte length. */
export function decodeBase64url(value, length) {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'invalid_encoding');
  const out = Buffer.from(value, 'base64url');
  need(out.toString('base64url') === value && (length === undefined || out.length === length), 'invalid_encoding');
  return out;
}
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Import a raw 32-byte Ed25519 public key from canonical base64url. */
export function importPublicKey(value) {
  const raw = decodeBase64url(value, 32);
  validatePoint(raw);
  return createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
}
/** Export an Ed25519 public key as canonical raw-key base64url. */
export function exportPublicKey(key) {
  try {
    const publicKey = key.type === 'private' ? createPublicKey(key) : key;
    need(publicKey.asymmetricKeyType === 'ed25519', 'invalid_key');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    need(der.length === 44 && der.subarray(0, 12).equals(SPKI), 'invalid_key');
    validatePoint(der.subarray(12)); return der.subarray(12).toString('base64url');
  } catch (e) { if (e instanceof ProtocolError) throw e; fail('invalid_key'); }
}
/** Derive a private key from an explicitly supplied 32-byte seed; callers own secret handling. */
export function privateKeyFromSeed(seed) {
  const raw = typeof seed === 'string' ? decodeBase64url(seed, 32) : seed;
  need(raw instanceof Uint8Array && raw.length === 32, 'invalid_key');
  return createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
}
/** Generate a fresh Ed25519 device key pair in memory, with no persistence. */
export function generateDeviceKeyPair() { return generateKeyPairSync('ed25519'); }
/** Generate a fresh Ed25519 root key pair in memory, with no persistence. */
export function generateRootKeyPair() { return generateKeyPairSync('ed25519'); }
/** Fingerprint a canonical raw public key as SHA-256 of its 32 bytes. */
export function fingerprint(key) {
  const encoded = typeof key === 'string' ? key : exportPublicKey(key);
  importPublicKey(encoded); return digestBytes(decodeBase64url(encoded, 32));
}

// Reject invalid/noncanonical curve points and non-prime-order Ed25519 keys.
const P = (1n << 255n) - 19n, L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = a => ((a % P) + P) % P;
function pow(a, n) { let r = 1n; for (; n; n >>= 1n, a = mod(a*a)) if (n & 1n) r = mod(r*a); return r; }
const D = mod(-121665n * pow(121666n, P-2n)), SQRTM1 = pow(2n, (P-1n)/4n);
function add(a,b) {
  const A=mod((a.y-a.x)*(b.y-b.x)), B=mod((a.y+a.x)*(b.y+b.x));
  const C=mod(2n*D*a.t*b.t), E=B-A, F=mod(2n*a.z*b.z-C), G=mod(2n*a.z*b.z+C), H=B+A;
  return {x:mod(E*F), y:mod(G*H), z:mod(F*G), t:mod(E*H)};
}
// A point's validity is a pure function of its 32 bytes, so only successes are remembered. A failure throws
// before it reaches the cache and is re-checked on every call.
const POINT_CACHE_LIMIT = 512;
const validPoints = new Map();
let pointRuns = 0;
export function pointCheckStats() { return { runs: pointRuns, cached: validPoints.size }; }
function validatePoint(raw) {
  const key = Buffer.from(raw).toString('hex');
  if (validPoints.has(key)) return;
  pointRuns++;
  checkPoint(raw);
  if (validPoints.size >= POINT_CACHE_LIMIT) validPoints.delete(validPoints.keys().next().value);
  validPoints.set(key, true);
}
function checkPoint(raw) {
  let n=0n; for (let i=31;i>=0;i--) n=(n<<8n)+BigInt(raw[i]);
  const signBit=n>>255n, y=n&((1n<<255n)-1n); need(y<P, 'invalid_key');
  const denominator=mod(D*y*y+1n);need(denominator!==0n, 'invalid_key');
  const x2=mod((y*y-1n)*pow(denominator, P-2n)); let x=pow(x2,(P+3n)/8n);
  if (mod(x*x)!==x2) x=mod(x*SQRTM1);
  need(mod(x*x)===x2 && !(x===0n && signBit===1n), 'invalid_key');
  if ((x&1n)!==signBit) x=P-x;
  need(!(x===0n && y===1n), 'invalid_key');
  let q={x,y,z:1n,t:mod(x*y)}, r={x:0n,y:1n,z:1n,t:0n}, nL=L;
  for (;nL;nL>>=1n,q=add(q,q)) if(nL&1n) r=add(r,q);
  need(r.x===0n && mod(r.y-r.z)===0n && r.z!==0n, 'invalid_key');
}
