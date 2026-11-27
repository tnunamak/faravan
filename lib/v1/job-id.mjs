// Job IDs: full digests on the wire, 8 hex characters for people.
export const SHORT_ID_LENGTH = 8;
export const MIN_PREFIX_LENGTH = 6;
const full = /^sha256:[0-9a-f]{64}$/;
const prefix = /^(?:sha256:)?[0-9a-f]+$/;

export const shortId = digest => String(digest).replace(/^sha256:/, '').slice(0, SHORT_ID_LENGTH);
export const isFullDigest = value => full.test(value ?? '');

/** Classify user input: {kind:'full'} | {kind:'prefix', hex} | {kind:'invalid', reason}. */
export function classifyJobId(input) {
  if (typeof input !== 'string' || !prefix.test(input.toLowerCase().trim())) return {kind: 'invalid', reason: 'format'};
  const value = input.toLowerCase().trim();
  if (isFullDigest(value)) return {kind: 'full', digest: value};
  const hex = value.replace(/^sha256:/, '');
  if (hex.length < MIN_PREFIX_LENGTH) return {kind: 'invalid', reason: 'short'};
  if (hex.length >= 64) return {kind: 'invalid', reason: 'format'};
  return {kind: 'prefix', hex};
}

export const matchPrefix = (hex, digests) =>
  [...new Set(digests)].filter(d => d.startsWith('sha256:' + hex)).sort();
