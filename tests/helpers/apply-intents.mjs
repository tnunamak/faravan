// The Apply tests use an in-memory device; production uses the fsynced device store.
export function memoryIntentStore() {
  const values = new Map();
  return () => ({
    get: async key => values.get(key) ?? null,
    list: async () => [...values.values()],
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => { values.delete(key); },
  });
}
