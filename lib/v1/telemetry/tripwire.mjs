// A last check on the exact bytes of a batch before they leave: the existing credential scanner, the known secret
// values of this computer, home-directory paths and e-mail addresses. A record is made only of catalog values, so a hit
// is a catalog bug: the caller drops the batch and counts it (design §2.2, §4.2).
import {POSTHOG_TOKEN} from './contract.mjs';
import { scanCredentialText, lenderCredentialValues } from '../continuation.mjs';

// A home directory on Unix, or on Windows as it looks in JSON text (backslashes doubled) or raw.
const HOME_PATH = /(?:^|[^A-Za-z0-9_])\/(?:home|Users|root)\/[A-Za-z0-9._-]+|[A-Za-z]:(?:\\\\|\\|\/)(?:Users|Documents and Settings)(?:\\\\|\\|\/)/i;
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/;
const GIT_REMOTE = /\bgit@[A-Za-z0-9.-]+:/;
const CACHE_MS = 10 * 60 * 1000;

/**
 * `privateValues()` returns the secret values to look for (default: this computer's lender credential values,
 * read from the lender's own sources, cached for 10 minutes). Returns an async `check(body)` -> null or a reason.
 */
export function createTripwire({privateValues = () => lenderCredentialValues(), now = Date.now} = {}) {
  let cached = null, cachedAt = -Infinity;
  const known = async () => {
    if (now() - cachedAt > CACHE_MS) {
      try { cached = await privateValues(); } catch { cached = cached ?? []; }
      cachedAt = now();
    }
    return cached;
  };
  return async function check(body) {
    // The fixed capture token is public. Exempt only its exact top-level field, never tokens in event properties.
    let scanned=body;
    try {const envelope=JSON.parse(body);if(envelope?.api_key===POSTHOG_TOKEN){delete envelope.api_key;scanned=JSON.stringify(envelope);}}catch {}
    if (!scanCredentialText(scanned, {knownValues: await known()}).ok) return 'credential';
    if (HOME_PATH.test(body)) return 'home_path';
    if (EMAIL.test(body) || GIT_REMOTE.test(body)) return 'address';
    return null;
  };
}
