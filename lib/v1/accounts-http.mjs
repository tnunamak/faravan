import { createHash } from 'node:crypto';
import { fault, ok } from './accounts.mjs';
import { effectiveAccountModels } from './account-catalog.mjs';

// The local authenticated account surface: GET /api/accounts, flows, enroll, complete, cancel, remove, settings.
// It is a thin adapter over the account broker and store. It never reads a native CLI store, never falls back to a
// provider's "current" account, and never returns a host-private field: accounts come from broker.list() (public view)
// and providers from descriptors only. The caller (the app server) has already authenticated the local session.
const SETTINGS = Object.freeze(['enabled', 'modelOrder', 'accountOrder', 'modelPreference', 'paretoOnly']);
const MUTATIONS = Object.freeze(['enroll', 'complete', 'cancel', 'remove', 'settings']);
const MAX_OPERATIONS = 256;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const strings = value => Array.isArray(value) && value.every(id) && new Set(value).size === value.length;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const status = code => ({
  provider_not_found: 404, account_not_found: 404, signin_expired: 410, operation_conflict: 409, settings_conflict: 409,
  account_exists: 409, account_removal_pending: 409, signin_cancel_pending: 409, invalid_request: 400,
}[code] ?? 502);
const view = result => ({ status: result.ok ? 200 : status(result.error.code), body: result });
const publicProvider = descriptor => ({ id: descriptor.id, label: descriptor.label, signInKind: descriptor.signInKind,
  models: structuredClone(descriptor.models) });

export function createAccountsApi({ broker, store, providers }) {
  const operations = new Map(); // operationId -> {fingerprint, result}: replay within this process only.
  const flows = new Map(); // flowId -> last SignInFlow the broker returned, for the UI to re-read.
  const remember = (operationId, fingerprint, result) => {
    if (operations.size >= MAX_OPERATIONS) operations.delete(operations.keys().next().value);
    operations.set(operationId, { fingerprint, result });
  };
  const replayed = (operationId, fingerprint) => {
    const entry = operations.get(operationId);
    if (!entry) return null;
    return entry.fingerprint === fingerprint ? view(entry.result) : view(fault('operation_conflict'));
  };
  const snapshot = async () => {
    const accounts = await broker.list();
    const state = store.read();
    const descriptors = providers.listProviders();
    return { schemaVersion: 1, revision: state.settingsRevision ?? 0, accounts,
      providers: descriptors.map(publicProvider),
      accountOrder: (state.accountOrder ?? []).filter(accountId => state.records[accountId]),
      capabilities: { mutations: descriptors.length ? [...MUTATIONS] : [], settings: descriptors.length ? [...SETTINGS] : [] } };
  };
  async function settings(accountId, input) {
    const keys = Object.keys(input).filter(key => key !== 'expectedRevision');
    const preference = input.modelPreference;
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !keys.length ||
        keys.some(key => !SETTINGS.includes(key)) ||
        ['enabled', 'paretoOnly'].some(key => key in input && typeof input[key] !== 'boolean') ||
        ['modelOrder', 'accountOrder'].some(key => key in input && !strings(input[key])) ||
        ('modelPreference' in input && (!preference || typeof preference !== 'object' ||
          Object.keys(preference).length !== 3 || !id(preference.modelId) ||
          typeof preference.enabled !== 'boolean' ||
          (preference.effortIds !== null && !strings(preference.effortIds)))))
      return view(fault('invalid_request', accountId));
    return view(await store.transaction(state => {
      if ((state.settingsRevision ?? 0) !== input.expectedRevision) return fault('settings_conflict', accountId);
      const record = Object.hasOwn(state.records, accountId) ? state.records[accountId] : null;
      if (!record) return fault('account_not_found', accountId);
      const found = providers.getProvider(record.providerId);
      if (!found.ok) return found;
      const models = new Map(found.value.descriptor.models.map(model => [model.id, model]));
      if ('modelOrder' in input && !input.modelOrder.every(model => models.has(model)))
        return fault('invalid_request', accountId);
      if ('accountOrder' in input && JSON.stringify([...input.accountOrder].sort()) !== JSON.stringify(Object.keys(state.records).sort()))
        return fault('invalid_request', accountId);
      if (preference) {
        const model = models.get(preference.modelId);
        if (!model || preference.effortIds?.some(id => !model.efforts.some(effort => effort.id === id)))
          return fault('invalid_request', accountId);
        record.modelPreferences = { ...record.modelPreferences,
          [preference.modelId]: { enabled: preference.enabled, effortIds: preference.effortIds } };
      }
      if ('modelOrder' in input) record.modelOrder = [...input.modelOrder];
      if ('accountOrder' in input) state.accountOrder = [...input.accountOrder];
      if ('enabled' in input) record.enabled = input.enabled && !record.removalIntent;
      if ('paretoOnly' in input) record.paretoOnly = input.paretoOnly;
      state.settingsRevision = (state.settingsRevision ?? 0) + 1;
      return ok({ revision: state.settingsRevision });
    }));
  }
  /** Returns {status, body} for an /api/accounts request, or null when the path is not an accounts route. */
  async function handle({ method, parts, input = {}, signal }) {
    if (parts[0] !== 'api' || parts[1] !== 'accounts') return null;
    const rest = parts.slice(2);
    if (method === 'GET' && rest.length === 0) return { status: 200, body: await snapshot() };
    if (method === 'POST' && rest.length === 0) {
      if (!id(input.providerId) || !id(input.label) || !id(input.operationId)) return view(fault('invalid_request'));
      const fingerprint = digest([input.providerId, input.label]);
      const replay = replayed(input.operationId, fingerprint);
      if (replay) return replay;
      const result = await broker.enroll({ providerId: input.providerId, label: input.label, signal });
      if (result.ok) flows.set(result.value.flowId, result.value);
      // A failed enrollment is not remembered: the person may retry with the same operation after fixing the cause.
      if (result.ok) remember(input.operationId, fingerprint, result);
      return view(result);
    }
    if (rest[0] === 'flows' && id(rest[1])) {
      const flowId = rest[1];
      if (method === 'GET' && rest.length === 2) {
        const flow = flows.get(flowId);
        return flow ? view(ok(flow)) : view(fault('signin_expired'));
      }
      if (method === 'POST' && rest[2] === 'complete' && rest.length === 3) {
        if ('answer' in input && typeof input.answer !== 'string') return view(fault('invalid_request'));
        const result = await broker.complete({ flowId, answer: input.answer, signal });
        if (result.ok || result.error.code !== 'signin_cancel_pending') flows.delete(flowId);
        return view(result);
      }
      if (method === 'POST' && rest[2] === 'cancel' && rest.length === 3) {
        const result = await broker.cancelSignIn(flowId);
        if (result.ok) flows.delete(flowId);
        return view(result);
      }
      return null;
    }
    if (id(rest[0]) && method === 'POST' && rest[1] === 'remove' && rest.length === 2) {
      if (!id(input.operationId)) return view(fault('invalid_request', rest[0]));
      const fingerprint = digest(['remove', rest[0]]);
      const replay = replayed(input.operationId, fingerprint);
      if (replay) return replay;
      const result = await broker.remove(rest[0]);
      if (result.ok) remember(input.operationId, fingerprint, result);
      return view(result);
    }
    if (id(rest[0]) && method === 'POST' && rest[1] === 'settings' && rest.length === 2) return settings(rest[0], input);
    return null;
  }
  /**
   * What this lender offers the circle for a signed run request: signed-in, enabled accounts in saved account order, each with its
   * descriptor models in saved model order. Ids and descriptor data only; no label, subject or secret leaves this process.
   */
  const advertise = () => {
    const state = store.read();
    const order = [...new Set([...(state.accountOrder ?? []), ...Object.keys(state.records)])];
    const out = [];
    for (const accountId of order) {
      const record = state.records[accountId];
      if (!record || !record.enabled || record.removalIntent || record.authState !== 'signed_in') continue;
      const found = providers.getProvider(record.providerId);
      if (!found.ok) continue;
      const models = effectiveAccountModels(record, found.value.descriptor);
      if (models.length) out.push({accountId, providerId: record.providerId, models});
    }
    return out;
  };
  return { handle, snapshot, advertise };
}
