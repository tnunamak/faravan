import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {createLendingReadings} from "../lib/v1/lending-probe.mjs";

const T = Date.parse('2026-11-02T12:00:00Z');

test('cached reads report age without writing a plan or invoking the refresher', () => {
  let reads = 0;
  const readings = createLendingReadings({now:() => T + 30 * 60_000,
    ledger:{snapshotReadOnly:() => {reads++; return {read_at:T, windows:[]};},
      snapshot:() => assert.fail('admission cannot use the mutating snapshot')},
    probe:{due:() => assert.fail('cache reads do not schedule probes')}});
  assert.equal(readings.cached('claude').age_ms, 30 * 60_000);
  assert.equal(reads, 1);
});
