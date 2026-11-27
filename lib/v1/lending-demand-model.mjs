// Versioned seam for a resource's demand model. A model is a conditional scoring assumption; provenance and label
// travel with its result. Two shapes, dispatched on `kind`:
//  - 'continuous-gamma' (the default, paper 06): data only. Protection is the closed form in lending-continuous-model.mjs.
//  - 'discrete-atoms' (cross-check only, e.g. Model I): a posterior over integer atoms, evaluated by evaluateDemandModel.
//    Structural alternatives are pinned through this shape; no production default uses it.

const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const DEMAND_MODEL_KINDS = Object.freeze(['continuous-gamma', 'discrete-atoms']);

/** The shape a model declares, or null for anything unrecognized. */
export function demandModelKind(model) {
  return plainRecord(model) && DEMAND_MODEL_KINDS.includes(model.kind) ? model.kind : null;
}

/** Null when the model can evaluate; otherwise the named reason it cannot. */
export function demandModelProblem(model) {
  const kind = demandModelKind(model);
  if (kind === 'continuous-gamma') {
    const prior = model.prior;
    const named = [model.id, model.label, model.provenance].every(text => typeof text === 'string' && text.length > 0);
    const positive = value => Number.isFinite(value) && value > 0;
    return named && plainRecord(prior) && positive(prior.alpha0) && positive(prior.b0) ? null : 'demand_model_invalid';
  }
  if (kind !== 'discrete-atoms') return 'demand_model_unavailable';
  if (typeof model.id !== 'string' || !model.id ||
      typeof model.label !== 'string' || !model.label ||
      typeof model.provenance !== 'string' || !model.provenance ||
      typeof model.markBound !== 'function' || typeof model.prior !== 'function' ||
      typeof model.posterior !== 'function' || typeof model.ownerScenarios !== 'function' ||
      typeof model.harm !== 'function' || typeof model.riskBudget !== 'function') return 'demand_model_unavailable';
  return null;
}

export function evaluateDemandModel(model, {resourceId, capacityPoints, observations, exposureFraction,
  updateIndex = 1, priorState = null, resources = null, epsilon = null}) {
  const problem = demandModelProblem(model);
  if (problem || demandModelKind(model) !== 'discrete-atoms') throw new TypeError(problem ?? 'demand_model_unavailable');
  if (typeof resourceId !== 'string' || !resourceId || !Number.isFinite(capacityPoints) || capacityPoints < 0 ||
      !Number.isFinite(exposureFraction) || exposureFraction < 0 || exposureFraction > 1 ||
      !Number.isSafeInteger(updateIndex) || updateIndex < 1) throw new TypeError('invalid demand-model input');
  const markBound = model.markBound(resourceId);
  if (!Number.isFinite(markBound) || markBound <= 0) throw new TypeError('demand-model mark bound unavailable');
  const prior = priorState ?? model.prior({resourceId, capacityPoints, markBound});
  if (!plainRecord(prior)) throw new TypeError('demand-model prior must be serializable state');
  const posterior = model.posterior({prior, resourceId, observations, exposureFraction, updateIndex, markBound});
  if (!Array.isArray(posterior) || posterior.length === 0 || posterior.length > 10001)
    throw new TypeError('invalid demand-model posterior');
  const probability = posterior.reduce((sum, atom) => {
    if (!plainRecord(atom) || !Number.isFinite(atom.amount) || atom.amount < 0 ||
        !Number.isFinite(atom.probability) || atom.probability < 0) throw new TypeError('invalid posterior atom');
    return sum + atom.probability;
  }, 0);
  if (Math.abs(probability - 1) > 1e-12) throw new TypeError('posterior probabilities must sum to one');
  const ownerScenarios = model.ownerScenarios({posterior, resourceId, capacityPoints, markBound, prior, observations});
  if (!Array.isArray(ownerScenarios) || ownerScenarios.length === 0 || ownerScenarios.length > 128)
    throw new TypeError('invalid demand-model owner scenarios');
  const modelLabel = `${model.label} Provenance: ${model.provenance}`;
  const riskAlpha = model.riskBudget({resourceId, resources:resources ?? [{id:resourceId,capacityPoints}],
    updateIndex, epsilon});
  if (!Number.isFinite(riskAlpha) || riskAlpha <= 0 || riskAlpha >= 1)
    throw new TypeError('demand-model risk budget unavailable');
  return {modelId:model.id, modelLabel, provenance:model.provenance, prior, posterior, markBound,
    ownerScenarios, updateIndex, riskAlpha};
}
