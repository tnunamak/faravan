import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
const from = source.indexOf('onDiagnostic:entry=>{');
const to = source.indexOf('},onEvent:', from);

test('a lender diagnostic keeps its message on this computer and reaches telemetry without it', () => {
  assert.ok(from > 0 && to > from, 'onDiagnostic wiring not found in lib/v1/app.mjs');
  const local = [], observed = [];
  const handler = runInNewContext('({' + source.slice(from, to + 1) + '}).onDiagnostic', {
    recordDiagnostic: async entry => { local.push(entry); },
    telemetry: {observe: (name, entry) => observed.push([name, entry])},
  });
  const entry = {at: '2026-10-28T00:00:00.000Z', job: 'sha256:' + 'd'.repeat(64), ref: 'AAAAAA', code: 'sandbox_start_failed', phase: 'prepare', message: 'sbx failed in /home/alice/private-repo'};
  handler(entry);
  assert.equal(local[0].message, entry.message);
  assert.equal(observed.length, 1);
  assert.equal(observed[0][0], 'lender-failure');
  assert.ok(!('message' in observed[0][1]));
  assert.deepEqual({...observed[0][1]}, {at: entry.at, job: entry.job, ref: entry.ref, code: entry.code, phase: entry.phase});
});
