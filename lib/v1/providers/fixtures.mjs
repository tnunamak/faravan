import { createHostAdapter } from './host-adapter.mjs';
import { createProviderRegistry } from './index.mjs';
import { ok, fault } from '../accounts.mjs';
import { createAccountBroker } from '../account-broker.mjs';

export function createFakeBroker({ store, clock = Date.now, effects = {}, authority, proxy }) {
  return createAccountBroker({ store, clock, providers: createFakeRegistry(effects),
    authority: authority ?? { verify: async () => ({ ok: false, error: { code: 'lease_invalid' } }),
      fence: async () => ok() },
    proxy: proxy ?? { dispatch: async () => ({ ok: false, error: { code: 'adapter_unsupported' } }),
      revokeStreams: async () => ({ aborted: [], unconfirmed: [] }) } });
}

// Synthetic conformance fixtures, never a claim about real refresh semantics.
export function createFakeRegistry(effects = {}) {
  return createProviderRegistry([
    ['claude', 'browser_oauth', 'rotating', 'remote'],
    ['codex', 'browser_oauth', 'rotating', 'remote'],
    ['pi', 'local_harness', 'none', 'job_local'],
    ['generic-api-key', 'api_key', 'none', 'remote'],
  ].map(([id, signInKind, refreshKind, usageKind]) => createHostAdapter({
    descriptor: { schemaVersion: 1, id, label: id, signInKind, refreshKind, usageKind,
      maxConcurrentJobs: null, models: [{ id: 'fixture-model', label: 'Fixture', efforts: [],
        defaultEffort: null, enabled: true, rank: 0, pareto: null }],
      nativeUnits: [{ id: 'tokens', scale: 1 }],
      destinations: [{ origin: 'https://synthetic.invalid', pathPrefixes: ['/v1/'], methods: ['POST', 'GET'] }] },
    effects: {
      beginSignIn: async ({ accountId }) => ok({ flowId: accountId, state: 'waiting', presentation: { kind: 'local' } }),
      finishSignIn: async ({ answer, flowId }) => ok({ subjectId: answer ?? flowId,
        secret: id === 'pi' ? null : { sentinel: 'SYNTHETIC-HOST-ONLY' }, expiresAtMs: null }),
      refresh: async ({ generation }) => ok({ secret: { sentinel: `SYNTHETIC-${generation + 1}` }, expiresAtMs: 9000000000000 }),
      authorizeRequest: async ({ auth, request }) => ok({ ...request,
        headers: { ...request.headers, authorization: auth.secret?.sentinel ?? 'SYNTHETIC-LOCAL' } }),
      makeRun: ({ jobKey, receipt, enforcement }) => ok({ schemaVersion: 1, command: 'synthetic',
        args: [], env: { JOB_KEY: jobKey }, proxy: {}, receipt, enforcement }),
      readUsage: async () => ({ kind: 'unavailable', code: 'synthetic' }),
      parseJobUsage: ({ accountId, attemptId, event }) => event?.schemaVersion === 1 &&
        event.accountId === accountId && event.attemptId === attemptId ? ok(structuredClone(event)) : fault('invalid_provider_response', accountId),
      ...effects,
    },
  })));
}
