// A search result or a Settings map row can open a page at one field. The opener records the field here and
// changes the hash; the app's route-focus effect takes it and focuses that field instead of the page heading.
// One pending target at a time, and it is used once: a later plain navigation lands on the heading as usual.
let pending = null;

export function requestFieldFocus(selector) {
  pending = typeof selector === 'string' && selector ? selector : null;
}

export function takeFieldFocus() {
  const selector = pending;
  pending = null;
  return selector;
}

// The field, or null when it is not on the page (yet). A selector that does not parse is treated as absent.
export function findField(selector, root = globalThis.document) {
  if (!selector || !root) return null;
  try { return root.querySelector(selector); } catch { return null; }
}
