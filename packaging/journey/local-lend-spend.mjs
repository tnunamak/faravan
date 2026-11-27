import {pointsFor, cumulativeProviderGate, sumPointsAsUsdMicro} from './evidence.mjs';

// Active readings must stay fresh and monotonic. Final charges are immutable totals,
// so a later job cannot age an already verified terminal reading out of the run.
export function createSpendMonitor() {
  const snapshots = new Map(), finalized = new Map(), conversions = new Map();
  return function observe({digest, read, executionStarted = false, terminal = false, now = Date.now()}) {
    const previous = snapshots.get(digest);
    const waiting = !executionStarted && !terminal && !previous && read.attempts.length === 0 &&
      read.missing.every(field => field === `lending-pace50-state.json attempts[job_id=${digest}]`);
    if (waiting) return;
    if (read.missing.length || !read.attempts.length) throw Error('Missing spend counters');
    const parsed = read.attempts.map(a => ({a, ...pointsFor(a, 1500000)}));
    if (parsed.some(p => p.missing.length)) throw Error('Missing spend counters');
    const rows = parsed.flatMap(p => p.rows.map(row => ({...row, attemptId: p.a.id})));
    const identities = new Map(rows.map(row => [JSON.stringify([row.attemptId, row.id]), row]));
    if (identities.size !== rows.length) throw Error('Duplicate spend resource');
    for (const [id, old] of previous ?? []) {
      const row = identities.get(id);
      if (!row || row.instance !== old.instance || row.kappaMicro !== old.kappaMicro ||
          row.spentMicro < old.spentMicro || row.meterDeltaMicro < old.meterDeltaMicro || row.observedAt < old.observedAt)
        throw Error('Spend resource changed or regressed');
    }
    for (const row of rows) {
      const key = JSON.stringify([row.id, row.instance]);
      if (conversions.has(key) && conversions.get(key) !== row.kappaMicro) throw Error('Spend conversion changed');
    }
    const provider = cumulativeProviderGate([{label: digest, rows}], 1500000, now);
    const app = sumPointsAsUsdMicro(rows, 'spentMicro');
    if (!provider.pass || app.missing.length || app.usdMicro > 1500000) throw Error('Spend cap failed');
    const charge = {provider: provider.totalUsdMicro, app: app.usdMicro};
    const totals = [...finalized].filter(([id]) => id !== digest).map(([, value]) => value);
    if (totals.reduce((sum, value) => sum + value.provider, charge.provider) > 4000000 ||
        totals.reduce((sum, value) => sum + value.app, charge.app) > 4000000) throw Error('Run spend cap failed');
    snapshots.set(digest, identities);
    for (const row of rows) conversions.set(JSON.stringify([row.id, row.instance]), row.kappaMicro);
    if (terminal) finalized.set(digest, charge);
    return {rows, processCeased: parsed.every(p => p.a.process_state === 'ceased' && p.a.cessation_proven === true && p.a.cleanup_proven === true),
      guardModels: parsed.map(p => p.a.served_model), launchStarted: parsed.every(p => p.a.launch_state === 'started')};
  };
}
