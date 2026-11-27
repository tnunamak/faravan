// Joiner-side handling of invite links: short (<origin>/i/<code>#<seed>), long (<origin>/join#invite=<blob>),
// the bare blob, and faravan://join?link=<either> (faravan:// remains accepted). Short links resolve to the equivalent long link, so
// everything after this module (enrollment, pinning) is unchanged.
import * as p from '../protocol/index.mjs';
import { ClientError } from './client.mjs';

const MAX_INPUT = 65536, MAX_RESPONSE = 16384, TIMEOUT_MS = 10000;
const BLOB = /^(?:#?invite=)?([A-Za-z0-9_-]{64,})$/;

/** Look through the wrappers a person may paste. Returns {kind: 'short'|'long', link}; throws invalid_invite_link. */
export function classifyJoinInput(input) {
  const bad = () => new ClientError('invalid_invite_link');
  if (typeof input !== 'string') throw bad();
  let value = input.trim();
  if (!value || value.length > MAX_INPUT) throw bad();
  if (value.startsWith('faravan://') || value.startsWith('faravan://')) {
    let url; try { url = new URL(value); } catch { throw bad(); }
    const inner = url.hostname === 'join' ? url.searchParams.get('link') : null;
    if (!inner || url.searchParams.size !== 1) throw bad();
    value = inner;
  }
  const blob = BLOB.exec(value);
  if (blob) {
    let origin;
    try { origin = p.strictParse(p.decodeBase64url(blob[1])).invite.payload.coordinator; } catch { throw bad(); }
    value = origin + '/join#invite=' + blob[1];
  }
  let url; try { url = new URL(value); } catch { throw bad(); }
  if (!['http:', 'https:'].includes(url.protocol)) throw bad();
  if (url.pathname === '/join') return { kind: 'long', link: value };
  if (/^\/i\/[^/]+$/.test(url.pathname)) return { kind: 'short', link: value };
  throw bad();
}

async function boundedText(response, signal) {
  const chunks = []; let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return '';
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new ClientError('payload_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/**
 * Fetch the published invite for a short link and verify it with the link's own seed before anything in
 * it is trusted. Returns the long link for the same invite.
 */
export async function resolveShortLink(link, { fetch: transport = globalThis.fetch, signal } = {}) {
  const decoded = p.decodeShortLink(link);
  if (!decoded.ok) throw new ClientError('invalid_invite_link');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response, bytes;
  try {
    response = await transport(decoded.coordinator + '/v1/invites/' + decoded.code,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: combined });
    bytes = response.ok || response.status === 410 ? await boundedText(response, combined) : (await response.body?.cancel(), null);
  } catch (cause) {
    if (cause instanceof ClientError) throw cause;
    throw new ClientError('network_error', { cause, retryable: true });
  }
  if (response.status === 404) throw new ClientError('invite_not_found', { status: 404 });
  if (response.status === 410) {
    let code;try {code=p.strictParse(bytes).code;}catch {}
    throw new ClientError(code==='enrollment_rejected'?'enrollment_rejected':'enrollment_expired', { status: 410 });
  }
  if (!response.ok) throw new ClientError(response.status === 429 ? 'rate_limited' : 'network_error', { status: response.status, retryable: true });
  let publication;
  try { publication = p.strictParse(bytes); } catch { throw new ClientError('invalid_response'); }
  const resolved = p.inviteLinkFromPublication(publication, { coordinator: decoded.coordinator, seed: decoded.seed });
  // Whatever the cause (wrong seed, forged root, bad signature, wrong origin), the invitation is not used.
  if (!resolved.ok) throw new ClientError('invite_binding_invalid');
  return resolved.link;
}

/** Any accepted join input -> the long link for it (network only for short links). */
export async function resolveJoinLink(input, options = {}) {
  const { kind, link } = classifyJoinInput(input);
  return kind === 'short' ? resolveShortLink(link, options) : link;
}
