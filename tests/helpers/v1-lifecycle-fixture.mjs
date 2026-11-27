// Lifecycle success journeys supply invented day-one admission evidence, never provider data.
// Negative identity and lifecycle tests retain their explicit per-start overrides.
import {appFixture as baseFixture, api} from './v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';
export * from './v1-app-fixture.mjs';
export async function appFixture(t, options = {}) {
  const f = await baseFixture(t, options), start = f.start, sources = new Map();
  f.start = async (name = 'owner', extra = {}) => {
    const firstStart = !sources.has(name);
    if (firstStart) sources.set(name, createSyntheticPace50Source({start: Date.now()}));
    const actor = await start(name, {
      lendingPace50: {source: sources.get(name), account_week_id: 'synthetic-week-1'},
      idleReader: async () => false,
      ...extra,
    });
    // Persist the model through the public setting: app refresh replaces adapter.run.
    if (firstStart && !Object.hasOwn(extra, 'adapters') && !Object.hasOwn(extra, 'codexRun'))
      await api(actor.app, '/api/agents/codex/run', {method: 'POST', body: {model: 'gpt-6-luna', effort: null}});
    return actor;
  };
  return f;
}
