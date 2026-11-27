import {normalizeProblem} from '../../../lib/v1/problem.mjs';
// The app banner says that something could not load, never an HTTP status. Two cases are handled before it:
// - the circle host did not answer (a 409 with a network code): the pages already say which circle is
//   unreachable, so the banner leaves that error out;
// - cancelled reads are ignored; the remaining errors become typed problems with catalog recovery.
const HOST_OFFLINE = new Set(['network_error', 'unavailable', 'transport_error', 'circle_unreachable', 'host_unreachable']);

export function bannerErrors(errors = {}) {
  const shown = {};
  for (const [name, error] of Object.entries(errors)) {
    if (!error || error.name==='AbortError') continue;
    if (error.status === 409 && HOST_OFFLINE.has(error.code)) continue;
    shown[name] = normalizeProblem(error.problem ?? error);
  }
  return shown;
}
