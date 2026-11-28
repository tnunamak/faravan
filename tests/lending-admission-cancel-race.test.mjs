import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {admissionRefreshClass} from "../lib/v1/lending-probe.mjs";

// Real candidate/source/readings/probe/ledger; provider transport, host proofs,
// calibration and owner-demand inputs are fixtures. No sandbox or agent runs.

test('unknown attempt reasons fail closed; cancellation cannot clear invalidation', () => {
  assert.equal(admissionRefreshClass({outcome:'failed', reason:'future_provider_reason'}), 'invalidating');
  assert.equal(admissionRefreshClass({outcome:'good', reason:'identity_failed'}), 'invalidating');
});
