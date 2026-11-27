import { fault, ok } from '../accounts.mjs';

const methods = ['beginSignIn', 'finishSignIn', 'cancelSignIn', 'refresh', 'readUsage',
  'authorizeRequest', 'makeRun', 'classifyReplay', 'parseJobUsage'];
export function createProviderRegistry(adapters = []) {
  const registry = new Map();
  for (const adapter of adapters) {
    const d = adapter.descriptor;
    if (!d?.id || d.schemaVersion !== 1 || registry.has(d.id) ||
        methods.some(method => typeof adapter[method] !== 'function')) throw new Error('invalid_provider_adapter');
    registry.set(d.id, adapter);
  }
  return {
    providerIdForHarness: harnessId => {
      const matching=[...registry.values()].filter(adapter=>(adapter.harnessId??adapter.descriptor.id)===harnessId);
      return matching.length===1?matching[0].descriptor.id:null;
    },
    getProvider: id => registry.has(id) ? ok(registry.get(id)) : fault('provider_not_found'),
    listProviders: () => [...registry.values()].map(a => structuredClone(a.descriptor)),
  };
}
const empty = createProviderRegistry();
export const getProvider = empty.getProvider;
export const listProviders = empty.listProviders;

export function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const deadline = /^\d+(\.\d+)?$/.test(text) ? nowMs + Number(text) * 1000 : Date.parse(text);
  return Number.isSafeInteger(deadline) && deadline >= nowMs ? deadline : null;
}
