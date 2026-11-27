import {durableJsonAsync} from '../durable-write.mjs';
// Durable browser sessions: one store, two kinds, never interchangeable.
// - local: a browser on this computer, signed in through the tray/CLI handoff. Owner authority.
// - phone: a paired phone. Only the scopes it was paired with, and only on the phone listener.
// The file holds SHA-256 hashes of the cookie secrets, so reading it signs nobody in.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {readFile} from 'node:fs/promises';

export const SESSION_IDLE_MS = 30 * 86400000;
// app:full: the whole local app, through the phone listener only (lib/v1/phone-access.mjs decides the transport).
export const PHONE_SCOPES = Object.freeze(['inbox:read', 'requests:answer', 'app:full']);
const KINDS = new Set(['local', 'phone']);
const DEFAULT_LIMITS = {local: 20, phone: 10};
// Last-use times are saved lazily: at most this often per session, and on close.
const TOUCH_SAVE_MS = 10 * 60000;
const MAX_SECRET_LENGTH = 256;

const hash = secret => createHash('sha256').update(secret).digest('hex');
const problem = code => Object.assign(new Error(code), {code});
const publicView = ({hash: _hash, ...record}) => record;

async function writePrivate(file, value) {
  await durableJsonAsync(file,value);
}

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version === 1 && typeof value.instance === 'string' && Array.isArray(value.sessions)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  // Missing or damaged: every browser signs in again through the handoff; the app still starts.
  return null;
}

/** Opens (or creates) the session file. All writes are serialized; verify() is synchronous for the request path. */
export async function openSessionStore(file, {now = Date.now, limits = {}} = {}) {
  const cap = {...DEFAULT_LIMITS, ...limits};
  const saved = await readState(file);
  const instance = saved?.instance ?? randomBytes(6).toString('hex');
  const sessions = new Map();
  for (const record of saved?.sessions ?? []) {
    if (record?.pending !== true && KINDS.has(record?.kind) && typeof record.hash === 'string' && Number.isFinite(record.last_used_at) &&
      now() - record.last_used_at < SESSION_IDLE_MS) sessions.set(record.hash, record);
  }
  const savedUse = new Map([...sessions.values()].map(record => [record.id, record.last_used_at]));
  let writing = Promise.resolve(), closed = false;
  const persist = () => {
    const snapshot = {version: 1, instance, sessions: [...sessions.values()].filter(record => !record.pending)};
    for (const record of snapshot.sessions) savedUse.set(record.id, record.last_used_at);
    writing = writing.catch(() => {}).then(() => writePrivate(file, snapshot));
    return writing;
  };
  const ofKind = kind => [...sessions.values()].filter(record => record.kind === kind);
  const dropExpired = () => {
    for (const [key, record] of sessions) if (now() - record.last_used_at >= SESSION_IDLE_MS) sessions.delete(key);
  };
  if (!saved || sessions.size !== (saved.sessions?.length ?? 0)) await persist();

  return {
    instance,
    async create({kind, label, scopes, pending = false}) {
      if (!KINDS.has(kind) || typeof label !== 'string' || (pending && kind !== 'phone')) throw problem('invalid_request');
      const granted = kind === 'local' ? ['owner'] : scopes;
      if (kind === 'phone' && (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !PHONE_SCOPES.includes(scope))))
        throw problem('invalid_request');
      dropExpired();
      const existing = ofKind(kind);
      if (existing.length >= cap[kind]) {
        // A phone is a deliberate pairing: never forget one silently. A local browser is re-openable from the tray.
        if (kind === 'phone') throw problem('too_many_phones');
        const oldest = existing.sort((a, b) => a.last_used_at - b.last_used_at)[0];
        sessions.delete(oldest.hash);
      }
      const secret = randomBytes(32).toString('base64url'), at = now();
      const record = {id: randomUUID(), hash: hash(secret), kind, label: label.slice(0, 80), scopes: [...new Set(granted)],
        created_at: at, last_used_at: at, ...(pending ? {pending: true} : {})};
      sessions.set(record.hash, record);
      // A phone still being collected reserves room, but cannot authenticate or survive a restart.
      if (!pending) await persist();
      return {id: record.id, secret};
    },
    /** Called only after the pairing is consumed. Activation starts synchronously; await durability before issuing a cookie. */
    async commit(id) {
      const record = [...sessions.values()].find(record => record.id === id && record.pending);
      if (!record) throw problem('session_not_pending');
      const {pending: _pending, ...active} = record;
      sessions.set(active.hash, active);
      try { await persist(); }
      catch (error) {
        if (sessions.get(active.hash) === active) sessions.delete(active.hash);
        throw error;
      }
    },
    /** The session record for a cookie secret of this kind, or null. Use slides the idle window. */
    verify(secret, kind) {
      if (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET_LENGTH) return null;
      const record = sessions.get(hash(secret));
      if (!record || record.pending || record.kind !== kind) return null;
      if (now() - record.last_used_at >= SESSION_IDLE_MS) { sessions.delete(record.hash); return null; }
      record.last_used_at = now();
      if (!closed && record.last_used_at - (savedUse.get(record.id) ?? 0) >= TOUCH_SAVE_MS) persist().catch(() => {});
      return publicView(record);
    },
    /** How many more sessions of this kind fit before create() refuses (phones) or forgets the oldest (local). */
    room(kind) {
      dropExpired();
      return Math.max(0, cap[kind] - ofKind(kind).length);
    },
    list(kind) {
      dropExpired();
      return ofKind(kind).filter(record => !record.pending).sort((a, b) => a.created_at - b.created_at).map(publicView);
    },
    async revoke(id) {
      for (const [key, record] of sessions) {
        if (record.id === id) { sessions.delete(key); await persist(); return true; }
      }
      return false;
    },
    async close() {
      if (closed) return;
      closed = true;
      await persist();
    },
  };
}
