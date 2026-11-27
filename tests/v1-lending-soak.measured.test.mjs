import './helpers/no-browser.mjs';
import {settlePaceAtBound} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rig} from './helpers/lending-soak.mjs';

test('soak harness drives reserve, start, finish and durable reopen offline', async t => {
  const f = rig(t), args = f.args();
  assert.equal((await f.reserve(args)).ok, true);
  assert.equal((await f.pace.candidate.admitStart(args.attemptId)).ok, true);
  await f.pace.candidate.started(args.attemptId, {ok:true});
  await f.pace.candidate.recordCleanup(args.attemptId, {removed:true});
  await f.pace.candidate.finish({...args, execution:{stdout:'', lending_meter:{final:true, cost_usd:0,
    model:args.model, tokens:{input:0, output:0, cached_input:0, cache_write:0, reasoning_output:0}}}});
  await f.restart();
  assert.equal(f.pace.adapter.state().attempts[0].hold_closed,false,'zero output without a stamp retains protection');
  await settlePaceAtBound(f.pace,at=>{f.clock.at=at;});
  assert.equal(f.pace.adapter.state().attempts[0].hold_closed,true);
});

import fs from 'node:fs';
import {join} from 'node:path';
import {holdOpen, invariant, HOUR, MINUTE} from './helpers/lending-soak.mjs';
import {minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingProbe, createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {NOW, ordinaryInput, request} from './helpers/pace50-fixtures.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50} from '../lib/v1/lending-policy.mjs';
