// `faravan open-link` opens the local app at #/circles?join=<invitation>. The app reads the invitation
// once, removes it from the address bar, and only shows it for review; it never joins by itself.
const PREFIX = '#/circles?join=';
const MAX_LINK = 16384;
let rejected = false;
// A one-shot non-secret signal keeps the existing string handoff contract intact.
export function takeJoinPrefillRejection() { const value = rejected; rejected = false; return value; }
export function takeJoinPrefill(location, history) {
  if (!location.hash.startsWith(PREFIX)) return '';
  rejected = false;
  let link = '';
  try { link = decodeURIComponent(location.hash.slice(PREFIX.length)); } catch { /* Report rejection without retaining the raw fragment. */ }
  history.replaceState(history.state, '', location.pathname + location.search + '#/circles');
  const accepted = link.length <= MAX_LINK && /^https?:\/\//.test(link);
  rejected = !accepted;
  return accepted ? link : '';
}
