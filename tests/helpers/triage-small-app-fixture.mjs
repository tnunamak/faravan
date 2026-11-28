import {appFixture as baseFixture, waitFor as baseWaitFor, api} from './v1-app-fixture.mjs';
export * from './v1-app-fixture.mjs';
const activeApps = new Set();
export async function waitFor(check,label,timeout=30000) {
  try { return await baseWaitFor(check,label,timeout); }
  catch (error) {
    const states = await Promise.all([...activeApps].map(async app => {
      try { const view = await api(app, '/api/lending');
        return {status: view.status, reason: view.reason, providers: view.objective?.accounts?.map(row =>
          ({provider: row.id, reason: row.decision?.reason}))};
      } catch { return {status: 'unavailable'}; }
    }));
    throw new Error(error.message + ': synthetic lending state ' + JSON.stringify(states), {cause: error});
  }
}

// Successful product journeys need explicit trusted synthetic lending evidence.
// Negative identity/evidence tests keep importing the unconfigured base fixture.
export async function appFixture(t, options = {}) {
  const f = await baseFixture(t, options);
  const start = f.start;
  f.start = async (name = 'owner', extra = {}) => {
    const result = await start(name, {syntheticAccounts:true,codexRun:{model:'gpt-6-luna'},...extra});
    // startApp replaces adapter run hints with saved settings; configure through the real owner API.
    const agents = await api(result.app, '/api/agents');
    if (agents.find(row => row.id === 'codex')?.run?.model == null)
      await api(result.app, '/api/agents/codex/run', {method: 'POST',
      body: {model: extra.codexRun?.model ?? 'gpt-6-luna', effort: null}});
    activeApps.add(result.app);
    t.after(() => activeApps.delete(result.app));
    return result;
  };
  return f;
}
