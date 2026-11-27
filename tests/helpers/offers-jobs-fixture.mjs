import {appFixture as baseFixture, api} from './v1-app-fixture.mjs';
import {weeklyWindowIdentity} from '../../lib/v1/lending-pace50-source.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';
export * from './v1-app-fixture.mjs';

// These offer/job journeys test signed lifecycle behavior, not provider evidence.
// Day-one admission still needs complete evidence: supply only hermetic test facts.
// The general app fixture stays fail-closed, and explicit per-test overrides win.
export async function appFixture(t, options = {}) {
  const f = await baseFixture(t, options);
  const start = f.start, sources = new Map();
  f.start = async (name = 'owner', extra = {}) => {
    if (!sources.has(name)) {
      const source = createSyntheticPace50Source({
        start: extra.lendingNow?.() ?? extra.clock?.now?.() ?? Date.now(),
        override: ({base}) => {
          const identity = {...base.identity, account_id: `synthetic-${base.provider}-account`};
          return {...base, identity, ...weeklyWindowIdentity({resources: base.resources, identity})};
        },
      });
      const objective = source.objectiveInputFor;
      source.objectiveInputFor = evidence => {
        const input = objective(evidence);
        // An explicitly useful $4 synthetic job fits the new default owner cap.
        input.job.estimateUsdMicro = evidence.request.requested_usd_micro ?? 4_000_000;
        return input;
      };
      sources.set(name, source);
    }
    const device = await start(name, {
      lendingPace50: {source: sources.get(name), account_week_id: 'synthetic-week-1'},
      ...extra,
    });
    // Adapter.run is not the app setting. Choose a priced model that fits the
    // unchanged $4 default through the same local API the agent settings use.
    for (const agent of await api(device.app, '/api/agents')) {
      const model = {codex: 'gpt-6-luna', 'claude-code-subscription': 'claude-haiku-4-5'}[agent.id];
      if (model && agent.run?.model == null)
        await api(device.app, '/api/agents/' + agent.id + '/run', {method: 'POST', body: {model, effort: null}});
    }
    return device;
  };
  return f;
}
