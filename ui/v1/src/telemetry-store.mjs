// The telemetry view (GET /api/telemetry), shared by the Privacy card, the first-run card and the friction sender.
// One store per page; the view is replaced by whatever the server answers, never edited locally.
export function createTelemetryStore() {
  let view = null, revision = 0, readSequence = 0, writesPending = 0;
  const listeners = new Set(), changes = new Set(), completed = new Set();
  // Notifications cannot change the authoritative result or skip later observers.
  const notify = (callbacks, ...args) => {
    for (const listener of callbacks) { try { listener(...args); } catch {} }
  };
  const commit = next => { view = next ?? null; notify(listeners, view); };
  // A local replacement or newer user change invalidates older asynchronous answers.
  const set = next => { revision++; commit(next); };
  return {
    get: () => view, set,
    beforeChange(listener) { changes.add(listener); return () => changes.delete(listener); },
    afterChange(listener) { completed.add(listener); return () => completed.delete(listener); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Read the view. A failed read leaves the last view in place; callers treat a missing view as "not known". */
    async load(api) {
      const started = revision, read = ++readSequence, idle = writesPending === 0;
      try { const next = await api.get('telemetry'); if (idle && writesPending === 0 && started === revision && read === readSequence) commit(next); }
      catch { /* the card shows its own loading state */ }
      return view;
    },
    /** POST a change; the answer is the new view. */
    async post(api, path, body = {}) {
      const started = ++revision, change = {}; // identity survives overlapping identical path/body calls
      writesPending++;
      let saved=false;
      try {
        for (const listener of changes) listener(path, body, change);
        const next = await api.post(path, body); saved=true;
        if (started === revision) commit(next); return next;
      }
      finally { writesPending--; notify(completed, path, body, saved, change); }
    },
  };
}
export const telemetryStore = createTelemetryStore();
