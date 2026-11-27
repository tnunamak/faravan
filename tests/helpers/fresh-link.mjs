import {requestHandoffLink} from '../../lib/v1/handoff-link.mjs';

// A handoff code works once and lasts 60 seconds, so every navigation asks the app for its own link.
// Harnesses hand out the origin and session token; only this helper turns them into a browser link.
export function freshLink(origin, token) {
  return requestHandoffLink({origin, token});
}
