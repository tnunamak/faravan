// Synthetic sentinels only. Run once on the release base before changing gates.
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {evaluateLending} from '../../lib/v1/lending-policy.mjs';
import {windows, job, calibration, GATES, NOW, RESET, MICRO} from '../helpers/lending-objective-fixtures.mjs';

// Expected historical metadata only, NOT evidence of the executing source.
export const expectedBaselineMetadata = Object.freeze({schemaVersion: 1,
  sourceSha: 'f0cea2f609aa601098dba3cb437132b76d9a280f',
  coldFloorPointsPerHour: 20, now: NOW, reset: RESET});
// Replay is NOT historical capture: evaluate stored inputs, never regenerate them.
// Clone before evaluation so a mutating evaluator cannot alter baseline records.
export function replayPolicy(baseline, evaluate = evaluateLending) {
  if (baseline?.schemaVersion !== 1 || typeof baseline.sourceSha !== 'string' ||
      !Array.isArray(baseline.cases)) throw new Error('invalid_policy_baseline');
  const cases = structuredClone(baseline.cases);
  for (const c of cases) {
    c.rawOutput = evaluate(structuredClone(c.rawInput));
    c.normalizedOutput = evaluate(structuredClone(c.normalizedInput));
  }
  return {kind: 'current-evaluator-replay', baselineSourceSha: baseline.sourceSha,
    cases: structuredClone(cases)};
}

export function capturePolicy() {
  const cases = [];
  for (const state of ['none', 'aged', 'observed']) for (const rate of [null, 20])
    for (const history of [false, true]) for (const strategy of ['automatic', 'fixed_share', 'custom', 'manual_approval']) {
      const age = state === 'aged' ? 25 * 60000 : 0;
      const policy = {strategy: strategy === 'manual_approval' ? 'automatic' : strategy};
      const rawInput = {policy, objectiveInput: {now: NOW, observedAt: state === 'none' ? null : NOW - age,
        windows: windows({weeklyUsedMicro:0, shortUsedMicro:0, known:state !== 'none'}),
        gates:GATES, laterBurnCapacityMicro:0, job:job({worstCallUsdMicro:MICRO}),
        automatic:strategy !== 'manual_approval', band:calibration({weeks:history ? 19 : 0})}};
      for (const w of Object.values(rawInput.objectiveInput.windows)) w.lentMicro = 0;
      const normalizedInput = structuredClone(rawInput);
      const o = normalizedInput.objectiveInput;
      o.observedAt = NOW - age;
      for (const w of Object.values(o.windows)) {
        w.known = true;
        w.uncertaintyMicro = Math.ceil(age * (rate ?? 20) * MICRO / 3600000);
        if (rate === null) {w.conversion='native_window'; w.pointsPerUsdMicro=null;}
      }
      cases.push({state, rate, history, strategy, rawInput, rawOutput:evaluateLending(rawInput),
        normalizedInput, normalizedOutput:evaluateLending(normalizedInput)});
    }
  return {schemaVersion:1, sourceSha:'f0cea2f609aa601098dba3cb437132b76d9a280f',
    coldFloorPointsPerHour:20, now:NOW, reset:RESET, cases};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./fixtures/policy-f0cea2f60.json', import.meta.url), JSON.stringify(capturePolicy(), null, 2)+'\n');
}
