// A borrower's model and effort request, and how a lender resolves it against the accounts it advertises.
// Foundation SPEC section 2.1: the signed job carries `runRequest`; the lender advertisement carries `accounts`; the lender resolves one
// {providerId,accountId,modelId,effortId} in saved account order, then saved model order, and never silently downgrades an explicit effort.
import { RUN_REQUEST_CAPABILITY } from './versions.mjs';

const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export const MAX_REQUESTED_MODELS = 64;

/** The request exactly as signed, or the reason it is refused. Nothing is normalised: a signature covers these bytes. */
export function validateRunRequest(value) {
  if (!own(value, ['schemaVersion', 'models', 'effortId']) || value.schemaVersion !== 1) return {ok: false, code: 'invalid_run_request'};
  if (value.effortId !== null && !id(value.effortId)) return {ok: false, code: 'invalid_run_request'};
  if (value.models !== 'any') {
    if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_REQUESTED_MODELS)
      return {ok: false, code: 'invalid_run_request'};
    const seen = new Set();
    for (const model of value.models) {
      if (!own(model, ['providerId', 'modelId']) || !id(model.providerId) || !id(model.modelId)) return {ok: false, code: 'invalid_run_request'};
      const key = JSON.stringify([model.providerId, model.modelId]);
      if (seen.has(key)) return {ok: false, code: 'invalid_run_request'};
      seen.add(key);
    }
  }
  return {ok: true, value};
}

/** The advertisement a lender may publish: stable ids and descriptor model data, never an upstream subject or a secret. */
export function validateAccountAdvertisement(accounts) {
  if (!Array.isArray(accounts) || accounts.length > 32) return false;
  const seen = new Set();
  return accounts.every(account => {
    if (!own(account, ['accountId', 'providerId', 'models']) || !id(account.accountId) || !id(account.providerId) ||
        seen.has(account.accountId) || !Array.isArray(account.models) || account.models.length > 64) return false;
    seen.add(account.accountId);
    return account.models.every(model => model !== null && typeof model === 'object' && id(model.id) &&
      typeof model.enabled === 'boolean' && Array.isArray(model.efforts) && model.efforts.length <= 16 &&
      model.efforts.every(effort => effort !== null && typeof effort === 'object' && id(effort.id)) &&
      (model.defaultEffort === null || model.efforts.some(effort => effort.id === model.defaultEffort)));
  });
}

/**
 * First compatible account, model and effort. `accounts` is already in saved account order and each account's models in saved model
 * order. A null effort resolves to the model's default; an explicit effort must be offered by the model, and is never replaced.
 * `busy(accountId)` is the lender's own capacity answer. `paretoOnly` is the owner's explicit filter: a model with no Pareto data is
 * excluded only then.
 */
export function resolveSelection({runRequest, accounts, busy = () => false, paretoOnly = false}) {
  const request = validateRunRequest(runRequest);
  if (!request.ok || !validateAccountAdvertisement(accounts)) return {ok: false, code: 'adapter_unsupported'};
  const wanted = request.value.models === 'any' ? null : new Set(request.value.models.map(model => JSON.stringify([model.providerId, model.modelId])));
  let sawModel = false, sawEffortFit = false;
  for (const account of accounts) {
    for (const model of account.models) {
      if (!model.enabled || (paretoOnly && model.pareto !== true)) continue;
      if (wanted && !wanted.has(JSON.stringify([account.providerId, model.id]))) continue;
      sawModel = true;
      let effortId;
      if (request.value.effortId === null) effortId = model.defaultEffort;
      else if (model.efforts.some(effort => effort.id === request.value.effortId)) effortId = request.value.effortId;
      else continue;
      sawEffortFit = true;
      if (busy(account.accountId)) continue;
      return {ok: true, value: {providerId: account.providerId, accountId: account.accountId, modelId: model.id, effortId}};
    }
  }
  return {ok: false, code: sawEffortFit ? 'account_busy' : sawModel ? 'effort_unavailable' : 'model_unavailable'};
}

/** Compare only the anonymous offers from a fresh heartbeat, using the signed model and effort constraints. */
export function offersRunRequest(device, request) {
  return device.source === 'heartbeat' && Array.isArray(device.capabilities) &&
    device.capabilities.includes(RUN_REQUEST_CAPABILITY) &&
    Array.isArray(device.account_offers) && device.account_offers.some(offer =>
    id(offer?.providerId) && id(offer.modelId) && Array.isArray(offer.effortIds) &&
    (request.models === 'any' || request.models.some(model =>
      model.providerId === offer.providerId && model.modelId === offer.modelId)) &&
    (request.effortId === null || offer.effortIds.includes(request.effortId)));
}

/** The borrower's check on a receipt: the effective selection must be something the signed request allowed. */
export function selectionSatisfies(runRequest, selection) {
  const request = validateRunRequest(runRequest);
  if (!request.ok || !own(selection, ['providerId', 'accountId', 'modelId', 'effortId']) ||
      !id(selection.providerId) || !id(selection.accountId) || !id(selection.modelId) ||
      (selection.effortId !== null && !id(selection.effortId))) return false;
  if (request.value.models !== 'any' &&
      !request.value.models.some(model => model.providerId === selection.providerId && model.modelId === selection.modelId)) return false;
  return request.value.effortId === null || request.value.effortId === selection.effortId;
}
