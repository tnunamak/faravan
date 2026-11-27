import './helpers/no-browser.mjs';
// A segment can lose its tail while a batch that points into it is still in flight (the batch's bytes were fsynced when
// they were appended, but the tail did not survive). The next append must not land inside the bytes the batch will move the
// cursor past, or settling the batch hides a record that was acknowledged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutbox } from '../lib/v1/telemetry/outbox.mjs';
import { seededBytes } from './helpers/telemetry-harness.mjs';

const GEN = 1;
const NOW = Date.UTC(2026, 9, 21, 19, 30, 0);
const COUNT = JSON.parse(readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url), 'utf8'));
const countRecord = value => ({...COUNT, value});
const queuedValues = outbox => outbox.inspect({gen: GEN, at: NOW}).filter(item => item.state === 'queued').map(item => JSON.parse(item.body).value);

test('a record appended after a segment lost its tail under a live batch is still queued once the batch settles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-shortened-batch-'));
  try {
    const first = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(1)});
    first.append([1, 2, 3].map(value => ({record: countRecord(value), gen: GEN, notBefore: 0, at: NOW})));
    const batch = first.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 50});
    assert.equal(batch.records.length, 3, 'the batch takes the whole segment');

    // The batch's bytes are on disk, but the last line has lost its newline and its tail.
    const outboxDir = join(dir, 'outbox');
    const segment = join(outboxDir, readdirSync(outboxDir).find(name => /^counts\..*\.jsonl$/.test(name)));
    truncateSync(segment, statSync(segment).size - 10);

    // A restart appends a record, then the batch that was in flight is sent and settled.
    const restarted = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(2)});
    restarted.append([{record: countRecord(4), gen: GEN, notBefore: 0, at: NOW}]);
    assert.ok(queuedValues(restarted).includes(4), 'the record is queued before the batch settles');
    const resumed = restarted.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 50});
    assert.equal(resumed.id, batch.id, 'the batch that was taken before the restart is the one in flight');
    assert.equal(restarted.settle(resumed, {body: resumed.records.join('\n'), outcome: 'sent', status: 200, at: NOW}), true);

    assert.ok(queuedValues(restarted).includes(4), 'settling the batch does not hide the record appended after the loss');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
