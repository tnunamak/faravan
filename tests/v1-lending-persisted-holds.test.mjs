import './helpers/no-browser.mjs';
import { ownTempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import rows from './fixtures/lending/cleanup-open-holds.json' with {type:'json'};
import {createEstimatedPace50State, transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
const NOW = Date.parse('2026-11-02T15:00:00Z');

// Shapes and amounts from the supplied read-only copy of the older ledger; identities are synthetic.
for (const [index, provider] of ['codex','claude'].entries()) for (const mode of ['covered','multiple','reset','no_cleanup','stale','scope_changed','regressed'])
  test(`${provider} persisted cleanup-proven hold: ${mode}`, async t => {
  const directory = ownTempDir(t, 'persisted-hold-');
  let at = NOW;
  const shouldClose = mode === 'reset';
  const row = {...structuredClone(rows[index]), late_ack_events:[]};
  if (mode === 'reset') at = Math.max(...row.resources.map(r => r.resets_at)) + 1;
  if (row.owner_stop === null) delete row.owner_stop;
  if (mode === 'no_cleanup') Object.assign(row, {process_state:'unknown', cessation_proven:false,
    cleanup_proven:false, cleanup_proof_persisted_at:null});
  const state = createEstimatedPace50State({account:'synthetic-account', account_week_id:row.account_week_id});
  const recoveredRows = mode === 'multiple' ? [row, ...[1,2].map(i =>
    JSON.parse(JSON.stringify(row).replaceAll(row.id, `${row.id}-copy-${i}`)))] : [row];
  const allEvents = recoveredRows.flatMap(r => [`${r.id}:cleanup-proven:1`, ...(r.owner_stop ? [r.owner_stop.event_id] : [])]);
  Object.assign(state, {revision:allEvents.length, event_ids:allEvents,
    updated_at:Math.max(row.owner_stop?.requested_at ?? 0, row.created_at, row.cleanup_proof_persisted_at ?? 0, ...row.resources.flatMap(r => r.burns.map(b => b.at))), attempts:recoveredRows});
  if (provider === 'codex' && ['covered','no_cleanup'].includes(mode)) {
    const refused = transitionEstimatedPace50State(state, {type:'usage', event_id:'partial-maximum',
      at, attempt_id:row.id, burn_id:'partial-maximum', maximum_after_cleanup:true,
      resources:row.resources.map(r => ({id:r.id, instance:r.instance, amount_micro:r.held_micro - 1}))});
    assert.equal(refused.applied, false, 'a cleanup maximum cannot be partial or lack cleanup proof');
  }
  fs.writeFileSync(join(directory, 'lending-pace50-state.json'), JSON.stringify(state));
  const source = createSyntheticPace50Source({start:NOW, override:({base, now}) => ({...base,
    epoch:row.epoch, account_week_id:row.account_week_id,
    observed_at:mode === 'stale' ? now - 120_000 : mode === 'multiple' ? now - 1000 : now,
    resources:row.resources.map(r => r.resets_at <= now ? {...r, state:'open', ...(r.kind === 'short' ? {cold_open:true, origin:'cold'} : {}),
      instance:`next-${r.id}`, anchor_at:now, resets_at:now + r.duration_ms, used_micro:0, observed_at:now} : ({...r, state:'open',
      used_micro:mode === 'regressed' ? 0 : provider === 'codex' ? 87_000_000 : 14_000_000,
      instance:mode === 'scope_changed' ? 'different-window' : r.instance,
      observed_at:mode === 'stale' ? now - 120_000 : mode === 'multiple' ? now - 1000 : now,
      uncertainty_micro:1_000_000})),
  })});
  let pace = createPace50Candidate({directory, source, now:() => at, account:'synthetic-account', account_week_id:row.account_week_id});
  const before = pace.adapter.state().attempts.map(attempt=>attempt.resources.map(r=>({
    exposure:r.held_micro+r.unrepresented_micro,released:r.released_micro})));
  await pace.candidate.probeHeld();
  const recovered = pace.adapter.state().attempts[0];
  assert.equal(recovered.hold_closed, shouldClose);
  if (shouldClose) assert.ok(pace.adapter.state().attempts.every(r => r.hold_closed), 'all old holds close in the same refresh');
  if (!shouldClose) {
    for (const [attemptIndex,attempt] of pace.adapter.state().attempts.entries()) {
      assert.equal(attempt.hold_closed,false);
      for(const [resourceIndex,r] of attempt.resources.entries()) {
        assert.ok(r.held_micro+r.unrepresented_micro>=before[attemptIndex][resourceIndex].exposure,
          'a new reading does not reduce the old liability');
        assert.ok(r.released_micro<=before[attemptIndex][resourceIndex].released,
          'a new reading does not add a release');
      }
    }
    await pace.adapter.close();
    fs.rmSync(directory, {recursive:true, force:true});
    return;
  }
  assert.ok(recovered.resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0));
  assert.ok(recovered.resources.every((r,i) => r.spent_micro >= row.resources[i].spent_micro + row.resources[i].held_micro), 'unknown use is charged in full');
  const quote = await pace.candidate.preview({jobId:'next-job', provider,
    model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol', automatic:false, ownerAbsent:true,
    job:{budget_v1:{max_list_usd:2}, requirements:{limits:{wall_seconds:300}}, expires_at:new Date(at + 3600e3).toISOString()}});
  assert.equal(quote.admitted, true, quote.reason);
  const revision = pace.adapter.state().revision;
  await pace.candidate.probeHeld();
  assert.equal(pace.adapter.state().revision, revision);
  await pace.adapter.close();
  pace = createPace50Candidate({directory, source, now:() => at, account:'synthetic-account', account_week_id:row.account_week_id});
  assert.equal(pace.adapter.state().attempts[0].hold_closed, true, 'closure survives another load');
  await pace.adapter.close();
  fs.rmSync(directory, {recursive:true, force:true});
});
