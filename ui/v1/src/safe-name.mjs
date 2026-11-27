// Unknown values become '' so callers omit them; pass a fallback only when a label must show.
export function safeName(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim() || /^(sha256:|[a-f0-9]{40,}$)/i.test(value)) return fallback;
  return value.slice(0,256);
}
