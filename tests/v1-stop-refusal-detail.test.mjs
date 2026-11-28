import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createMeasurementHistory} from '../lib/v1/event-history.mjs';

// Fixture values are hashes and readings, the only forms that reach admission. None is an account identifier.

// The durable decision row, read back from the file the partition writes; a reopened partition must keep it too.

test('a stop fact from another run is kept as its own sub-reason in a saved gate row', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stop-detail-unobserved-'));
  try {
    const history = createMeasurementHistory({directory: join(directory, 'history')});
    history.record('admission_gate_refused', {outcome: 'held', provider: 'codex', reason: 'stop_bound_unknown',
      policy_reason: 'stop_bound_unknown', refusal_detail: {stopReason: 'stop_unobserved'}});
    await history.flush();
    history.close();
    const file = join(directory, 'history', 'measurements', 'measurements.jsonl');
    const [row] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.type === 'admission_gate_refused');
    assert.equal(row.data.refusal_detail?.stop_reason, 'stop_unobserved');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
