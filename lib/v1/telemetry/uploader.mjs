// The only network effect of telemetry. One stream per batch; a quota week alone. It reads the HTTP status and
// Retry-After of its own POST and nothing else, and cancels the body unread, so nothing the server says can steer
// the app (design §2.2, §5.9). Consent is checked before every batch; an off decision aborts the request in flight.
import { gzipSync } from 'node:zlib';
import {catalogToPosthog} from './posthog.mjs';
import {POSTHOG_HOST,POSTHOG_TOKEN} from './contract.mjs';

export const UPLOAD = Object.freeze({timeoutMs: 5000, minBackoffMs: 60000, maxBackoffMs: 6 * 3600000, maxRecords: 50, maxBytes: 64 * 1024, userAgent: 'telemetry/1'});
const STREAMS = ['counts', 'quota', 'diagnostics'];
const REJECTED = new Set([400, 413, 415, 422]);

/**
 * `transport(url, init)` is fetch-shaped. `onSelf(reason, entry)` reports
 * rejected and upload_failed batches and tripwire hits. Time and randomness are injected.
 */
export function createUploader({consent, outbox, transport = fetch, version, tripwire, onSelf = () => {}, now = Date.now, random = Math.random, allowed = () => false}) {
  let abort = null, running = null, failures = 0, nextAt = 0, halted = false;
  let last = {status: null, error: null, at: null};
  const jitter = () => 0.75 + random() * 0.5;

  const retryAfterMs = value => {
    if (value == null) return null;
    const seconds = /^\d+$/.test(String(value).trim()) ? Number(value) : (Date.parse(value) - now()) / 1000;
    return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0) * 1000, UPLOAD.maxBackoffMs) : null;
  };
  function backoff(retryAfter) {
    failures++;
    const wait = retryAfterMs(retryAfter) ?? Math.min(UPLOAD.maxBackoffMs, Math.max(UPLOAD.minBackoffMs, UPLOAD.minBackoffMs * 2 ** (failures - 1) * jitter()));
    nextAt = now() + wait;
  }

  /** Send the next batch of `stream`. Resolves 'sent', 'idle' (nothing due), 'blocked' (consent or backoff) or 'failed'. */
  async function sendOne(stream) {
    const acquired = consent.tryWithAuthority(() => {
      const state = consent.current();
      if (halted || !allowed() || !state.streams.includes(stream) || outbox.halted() === version) return {result: 'blocked'};
      const batch = outbox.nextBatch({stream, gen: state.generation, at: now(), maxRecords: stream === 'quota' ? 1 : UPLOAD.maxRecords, maxBytes: 40 * 1024});
      return batch ? {batch, installId:consent.installId()} : {result: 'idle'};
    });
    if(!acquired)return 'blocked';
    const prepared=acquired.value;
    if (prepared.result) return prepared.result;
    const {batch,installId} = prepared;
    // Cancellation exists before the first await, and consent is rechecked after each one: a change in between sends nothing.
    // The last check runs under the consent authority, in consent.dispatch, so Off in another process cannot slip past it.
    abort = new AbortController();
    const controller = abort;
    const current = () => allowed() && !controller.signal.aborted && consent.current().generation === batch.gen && consent.current().streams.includes(stream);

    // Outbox writes are fenced like the dispatch: none lands after another process completed Off.
    const settle = options => consent.tryWithAuthority(() => { if (current()) outbox.settle(batch, options); });
    let body;
    try {
      body = JSON.stringify({api_key:POSTHOG_TOKEN,batch:batch.records.map(json=>catalogToPosthog(JSON.parse(json),{installId,version}))});
    } catch {
      settle({body: batch.records.join('\n'), outcome: 'rejected', status: 'invalid', at: now()});
      onSelf('internal_error', 'none');
      return 'failed';
    }
    const hit = await tripwire(body);
    if (!current()) { abort = null; return 'blocked'; }
    if (hit) {
      settle({body, outcome: 'rejected', status: 'tripwire', at: now()});
      onSelf('tripwire', JSON.parse(batch.records[0]).name);
      return 'failed';
    }
    const zipped = gzipSync(body);
    if (Buffer.byteLength(body) > UPLOAD.maxBytes) {
      settle({body, outcome: 'rejected', status: 'too_large', at: now()});
      onSelf('dropped_bytes', 'none');
      return 'failed';
    }

    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(UPLOAD.timeoutMs)]);
    let response;
    try {
      const dispatched = consent.dispatch(batch.gen, stream, () => transport(POSTHOG_HOST+'/batch/', {method: 'POST', body: zipped, signal, redirect: 'error', credentials: 'omit',
        headers: {'content-type': 'application/json', 'content-encoding': 'gzip', 'user-agent': UPLOAD.userAgent}}), () => current() && now() <= batch.expiresAt);
      if (!dispatched) { abort = null; return 'blocked'; }
      response = await dispatched.response;
    } catch {
      abort = null;
      if (controller.signal.aborted || !current()) return 'blocked';
      last = {status: null, error: 'network', at: now()};
      backoff(null);
      onSelf('upload_failed', 'none');
      return 'failed';
    }
    // Only these two things are read from the response. The body is cancelled unread.
    const status = response.status, retryAfter = response.headers?.get?.('retry-after') ?? null;
    try { await response.body?.cancel?.(); } catch { /* nothing to read */ }
    // Consent is checked again after the last await, and the answer to a request that consent overtook is not recorded:
    // the queue was purged or re-stamped meanwhile (and the outbox refuses to settle a batch that is no longer in flight).
    const stillCurrent = current();
    abort = null;
    last = {status, error: null, at: now()};
    if (!stillCurrent) return 'blocked';
    if (status >= 200 && status < 300) { failures = 0; nextAt = 0; settle({body, outcome: 'sent', status, at: now()}); return 'sent'; }
    if (REJECTED.has(status)) { settle({body, outcome: 'rejected', status, at: now()}); onSelf('rejected', JSON.parse(batch.records[0]).name); return 'failed'; }
    if (status === 401 || status === 403) { halted=true;consent.tryWithAuthority(() => { if (current()) outbox.halt(version); }); return 'blocked'; }
    backoff(retryAfter);
    onSelf('upload_failed', 'none');
    return 'failed';
  }

  /** One pass over the streams until nothing more is due. Calls overlap safely: a second call joins the first. */
  function flushNow() {
    if (running) return running;
    running = (async () => {
      if (now() < nextAt) return;
      for (const stream of STREAMS) {
        for (;;) {
          const result = await sendOne(stream).catch(() => { onSelf('internal_error', 'none'); return 'failed'; });
          if (result !== 'sent') break;
        }
        if (now() < nextAt) break;
      }
    })().finally(() => { running = null; });
    return running;
  }

  return {
    flushNow,
    /** Called when consent turns off or the identity resets: the request in flight is cancelled. */
    abort() { abort?.abort(); failures=0; nextAt=0; },
    async stop({timeoutMs = 2000} = {}) {
      abort?.abort();
      if (running) await Promise.race([running.catch(() => {}), new Promise(resolve => setTimeout(resolve, timeoutMs).unref())]);
    },
    status: () => ({halted: halted || outbox.halted() === version, backoffUntil: nextAt > now() ? nextAt : null, failures, last}),
  };
}
