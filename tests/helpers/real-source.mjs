// The real pace50 source with a standing stop receipt that matches the executor the test expects. Stop evidence now belongs to the
// machine (stop-evidence.mjs), not to a reading, so a test that is about something else keeps a valid receipt through this wrapper.
// A test about stop evidence passes its own `stopEvidence` (or `stopEvidence: () => null`) and gets exactly that.
import {createRealPace50Source as create} from '../../lib/v1/lending-pace50-source.mjs';

export * from '../../lib/v1/lending-pace50-source.mjs';
const FAR = Date.UTC(2100, 0, 1);
const VERSIONS = ['A', 'test-sbx', '0.50.1', 'test/1', 'synthetic-version', '1.0.0', 'test', 'v1'];

export function standingStopEvidence(expectedExecutor, {stop = {delivered: true, fallback: null, latency_ms: 1, removed: true}, measured_at = FAR, version = null} = {}) {
  return async (provider, {signal} = {}) => {
    const expected = typeof expectedExecutor === 'function' ? await expectedExecutor(provider, {signal}) : expectedExecutor;
    if (!expected?.backend_id || typeof expected.accepts !== 'function') return null;
    const sbx_version = version ?? VERSIONS.find(v => expected.accepts(v)) ?? '';
    return {executor: {backend_id: expected.backend_id, sbx_version}, stop, measured_at};
  };
}

export function createRealPace50Source(options = {}) {
  return create({...options, stopEvidence: Object.hasOwn(options, 'stopEvidence') ? options.stopEvidence
    : standingStopEvidence(options.expectedExecutor ?? null)});
}
