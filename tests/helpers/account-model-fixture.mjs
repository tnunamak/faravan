// Low-level broker tests seed an owner's explicit choice independently of the HTTP settings surface.
export async function enableFixtureModel(store, accountId, modelId) {
  await store.transaction(state => {
    const account = state.records[accountId];
    account.modelPreferences = {...account.modelPreferences, [modelId]: {enabled: true, effortIds: null}};
  });
}
