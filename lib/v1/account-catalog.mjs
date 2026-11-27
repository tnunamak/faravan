/** The account's ordered lending catalog, derived from provider data and saved preferences. */
export function effectiveAccountModels(account, descriptor) {
  const models = new Map(descriptor.models.map(model => [model.id, model]));
  const order = new Set([...(account.modelOrder ?? []), ...models.keys()]);
  const effective = [];
  for (const id of order) {
    const model = models.get(id);
    const preference = Object.hasOwn(account.modelPreferences ?? {}, id) ? account.modelPreferences[id] : null;
    if (!model?.enabled || preference?.enabled !== true || (account.paretoOnly && model.pareto !== true)) continue;
    const allowed = preference.effortIds;
    const efforts = model.efforts.filter(effort => !Array.isArray(allowed) || allowed.includes(effort.id));
    if (model.efforts.length && !efforts.length) continue;
    const defaultEffort = efforts.some(effort => effort.id === model.defaultEffort)
      ? model.defaultEffort
      : Array.isArray(allowed) ? efforts[0]?.id ?? null : null;
    effective.push({id, enabled: true, efforts: efforts.map(effort => ({id: effort.id})),
      defaultEffort, ...(model.pareto === true ? {pareto: true} : {})});
  }
  return effective;
}

export function checkAccountSelection(account, descriptor, selection) {
  const model = effectiveAccountModels(account, descriptor).find(row => row.id === selection.modelId);
  if (!model) return { code: 'model_unavailable' };
  const effortId = selection.effortId ?? model.defaultEffort;
  if (effortId !== null && !model.efforts.some(effort => effort.id === effortId)) return { code: 'effort_unavailable' };
  return { effortId };
}
