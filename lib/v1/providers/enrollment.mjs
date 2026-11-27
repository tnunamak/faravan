import { fault } from '../accounts.mjs';

// Internal lifecycle helper, not a provider/identity contract. Authentication,
// subject extraction and atomic duplicate detection remain enrollmentFromFlow's
// responsibility. Incomplete or rejected waits never become signed_out here.
export function createEnrollmentEffects({ start, enrollmentFromFlow }) {
  const entries = new Map();
  const expired = () => fault('signin_expired');
  const detach = entry => entry.signal?.removeEventListener('abort', entry.onAbort);
  const forget = entry => {
    if (entries.get(entry.accountId) === entry) entries.delete(entry.accountId);
    detach(entry);
  };
  function cleanup(entry) {
    return entry.cleanup ??= Promise.resolve().then(() => entry.flow?.cleanup?.());
  }
  function stop(entry) {
    entry.cancelled = true;
    detach(entry);
    return entry.stopping ??= (async () => {
      try { await entry.starting; } catch { /* startup failed */ }
      try { await entry.flow?.cancel?.(); }
      finally { try { await cleanup(entry); } finally { forget(entry); } }
    })();
  }
  async function beginSignIn({ accountId, signal }) {
    const current = entries.get(accountId);
    if (current) return current.begin;
    if (signal?.aborted) return expired();
    const entry = { accountId, signal, cancelled: false };
    entries.set(accountId, entry); // Reserve before asynchronous startup.
    entry.onAbort = () => { void stop(entry).catch(() => {}); };
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    entry.starting = Promise.resolve().then(() => start({
      isActive: () => !entry.cancelled && !signal?.aborted,
    })).then(flow => { entry.flow = flow; return flow; });
    entry.begin = entry.starting.then(async flow => {
      if (entry.cancelled || signal?.aborted) { await stop(entry); return expired(); }
      return { ok: true, value: { flowId: accountId, state: 'waiting',
        presentation: { kind: 'browser', url: flow.url } } };
    }, error => { forget(entry); throw error; });
    return entry.begin;
  }
  async function finishSignIn({ flowId, answer }) {
    const entry = entries.get(flowId);
    if (!entry || entry.cancelled) return expired();
    if (entry.finishing) return entry.finishing;
    entry.finishing = (async () => {
      const flow = await entry.starting;
      if (entry.cancelled) return expired();
      if (answer) {
        if (flow.acceptsRedirect === true) await flow.submitRedirect(answer);
        else if (flow.acceptsCode === true) await flow.submitCode(answer);
        else throw new Error('Sign-in is not accepting an answer.');
      }
      const result = flow.status === 'complete' ? flow : await flow.waitForCompletion();
      if (entry.cancelled) return expired();
      // A slow or transient completion stays retriable on the SAME flow.
      // Do not extract identity from a URL, code, email or unfinished result.
      if (result?.status !== 'complete') throw new Error('Sign-in is not complete.');
      try {
        // Callback may commit before throwing: retire before invoking it so an
        // uncertain enrollment is never retried automatically.
        forget(entry);
        const enrollment = await enrollmentFromFlow(flow);
        return enrollment;
      } finally { await cleanup(entry); }
    })();
    try { return await entry.finishing; }
    finally { entry.finishing = null; }
  }
  async function cancelSignIn(flowId) {
    const entry = entries.get(flowId);
    if (entry) await stop(entry);
  }
  return { beginSignIn, finishSignIn, cancelSignIn };
}
