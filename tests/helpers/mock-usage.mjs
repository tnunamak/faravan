// Scripted account readings are test startup dependencies, never product settings.
export function createMockUsage(entries = []) {
  const scripts = new Map(entries.map(([key, readings]) => [key, [...readings]]));
  const calls = [];
  const readOverride = async (accountKey, options = {}) => {
    calls.push({accountKey, options});
    const script = scripts.get(accountKey);
    if (!script?.length) return null;
    const next = script.length > 1 ? script.shift() : script[0];
    return structuredClone(typeof next === 'function' ? await next(options) : next);
  };
  return {
    calls,
    readOverride,
    source: {
      kind: 'synthetic',
      observe: ({accountKey, provider, ...options}) => readOverride(accountKey ?? provider, options),
    },
  };
}
