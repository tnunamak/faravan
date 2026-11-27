import {parseGuardLine} from '../../lib/faravan-guard-host.mjs';
import {syntheticBackend} from './v1-app-fixture.mjs';

// The fake sandbox for metered acceptance. It reports usage the way the guard does: one `faravan.meter` record,
// parsed by the same host parser the Docker backend uses, delivered through `onMeter`, and returned as the run's meter.
// Only a run with a lending budget is metered, as with the real backend. The provider counter moves with the usage, so
// the next reading shows the spend. The counter is test fixture state, not adapter state.
export function meteringSandbox(root, {source, tokens, cost_usd, model = 'claude-sonnet-5-5', harness = 'claude-stream'}) {
  const backend = syntheticBackend(root, {});
  // The real lender advertises budget_v1 only when the backend can enforce a graceful stop.
  backend.requestStop = async handle => {
    handle?._release?.();
    return {delivered:true, fallback:null, reason:'owner'};
  };
  const start = backend.start.bind(backend);
  backend.start = async (handle, opts = {}) => {
    await start(handle, opts);
    if (!opts.lendingBudget) return undefined;
    // The guard stops the agent at its budget, so no burn can exceed the limit the lender granted.
    const costUsd = Math.min(cost_usd, opts.lendingBudget.budget.limit);
    const line = JSON.stringify({type: 'faravan.meter', v: 1, seq: 1, at: new Date().toISOString(), source: harness,
      model, tokens, windows: [], cost_usd: costUsd, final: true});
    const reading = parseGuardLine(line);
    if (!reading) throw new Error('the fake sandbox wrote a meter line the host would reject');
    opts.onMeter?.(reading);
    const {resources} = await source.observe({provider: 'claude', now: Date.now()});
    const amounts = source.convertUsage({units_micro: Math.round(costUsd * 1000000), resources});
    for (const {id, amount_micro} of amounts) {
      if (id === 'seven_day' || id === 'codex:10080') source.state.used.weekly += amount_micro;
      if (id === 'five_hour' || id === 'codex:300') source.state.used.short += amount_micro;
    }
    backend.meters.push(reading);
    return {stop: null, meter: reading};
  };
  backend.meters = [];
  return backend;
}
