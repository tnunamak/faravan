import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const counts = {
  data_cleanup_pending: 2, policy_cleanup_pending: 3, policy_cleanup_blocked: 1,
  compute_cleanup_pending: 4, unknown: 5, create_watch: 6,
};
const state = (shared_watch, debt = counts) => ({...debt, shared_watch});
const model = async (cleanup, options) => (await import('./cleanup-status.mjs')).cleanupStatusVM(cleanup, options);
const copy = view => [view.heading, view.watch.line, ...view.counts.map(row => `${row.label}: ${row.value}`)].join(' ');

test('active listing failure uses the exact count-bearing line and keeps every cleanup count', async () => {
  const view = await model(state({healthy:true, count:7, listing_failed:true, message:'untrusted server wording'}));
  assert.equal(view.watch.kind, 'wait');
  assert.equal(view.watch.line, 'watching 7 names until listing works');
  assert.deepEqual(view.counts.map(row => [row.key, row.value]), Object.entries(counts));
});

test('zero watched names still reports an active listing failure', async () => {
  const view = await model(state({healthy:true, count:0, listing_failed:true}));
  assert.equal(view.watch.line, 'watching 0 names until listing works');
});

test('healthy watcher reports its watched count without clearing unrelated work', async () => {
  const view = await model(state({healthy:true, count:7, listing_failed:false}));
  assert.equal(view.watch.kind, 'on');
  assert.equal(view.watch.line, 'Watching 7 names.');
  assert.deepEqual(view.counts.map(row => row.value), [2,3,1,4,5,6]);
  assert.equal((await model(state({healthy:true, count:1, listing_failed:false}))).watch.line, 'Watching 1 name.');
  assert.equal((await model(state({healthy:true, count:0, listing_failed:false}))).watch.line, 'Shared workspace watcher is running. No names are being watched.');
});

test('unhealthy watcher never says it is actively watching, even after listing failed', async () => {
  for (const listing_failed of [false, true]) {
    const view = await model(state({healthy:false, count:7, listing_failed, message:'watching 7 names until listing works'}));
    assert.equal(view.watch.kind, 'bad');
    assert.equal(view.watch.line, 'Shared workspace watcher needs attention.');
    assert.deepEqual(view.counts.map(row => row.value), [2,3,1,4,5,6]);
  }
});

test('missing watcher and unknown health remain distinct from failure and active watching', async () => {
  for (const shared_watch of [undefined, null, {}, {count:7, listing_failed:true}]) {
    const view = await model(state(shared_watch));
    assert.equal(view.watch.kind, 'wait');
    assert.equal(view.watch.line, 'Shared workspace watcher status is unavailable.');
    assert.deepEqual(view.counts.map(row => row.value), [2,3,1,4,5,6]);
  }
});

test('stale reads preserve last known counts without presenting active watching', async () => {
  const view = await model(state({healthy:true, count:7, listing_failed:true}), {stale:true});
  assert.equal(view.watch.kind, 'wait');
  assert.equal(view.watch.line, 'Workspace cleanup status could not be refreshed. Last known counts are shown.');
  assert.deepEqual(view.counts.map(row => row.value), [2,3,1,4,5,6]);
});

test('missing and malformed counts are unknown, not zero or active watching', async () => {
  for (const count of [undefined, null, -1, 0.5, NaN, Infinity, '9', Number.MAX_SAFE_INTEGER + 1]) {
    const view = await model(state({healthy:true, count, listing_failed:true}, {data_cleanup_pending:count}));
    assert.equal(view.watch.line, 'Shared workspace watcher count is unavailable.');
    assert.ok(view.counts.every(row => row.value === 'Unknown'));
  }
  const view = await model(undefined);
  assert.equal(view.watch.line, 'Shared workspace watcher status is unavailable.');
  assert.ok(view.counts.every(row => row.value === 'Unknown'));
});

test('zero debt counts remain visible', async () => {
  const debt = Object.fromEntries(Object.keys(counts).map(key => [key,0]));
  const view = await model(state({healthy:true, count:0, listing_failed:false}, debt));
  assert.equal(view.counts.length, 6);
  assert.ok(view.counts.every(row => row.value === 0));
});

test('cleanup copy never echoes unsafe backend wording or prohibited terms', async () => {
  for (const healthy of [undefined, false, true]) for (const listing_failed of [false, true]) {
    const view = await model(state({healthy, count:7, listing_failed, message:'verdict receipt attempt settled lease <script>alert(1)</script>'}));
    assert.doesNotMatch(copy(view), /\b(verdict|receipt|attempt|settled|lease)\b|<script>/i);
  }
});

test('Lend uses one summary and retains counts in a closed disclosure', async () => {
  const source=await readFile(new URL('./lend.jsx',import.meta.url),'utf8');
  assert.match(source,/cleanupStatusVM\(home\.cleanup,\s*\{stale: offline \|\| Boolean\(errors\.home\)\}\)/);
  assert.match(source,/cleanup\.summary && <section/);
  assert.match(source,/<details class="tech">\s*<summary>Cleanup details<\/summary>/);
  assert.match(source,/cleanup\.counts\.map/);
});

test('unreadable records show exact singular and plural copy without backend text', async () => {
  for (const count of [1,2,12]) {
    const view=await model({unreadable_records:count,unreadable_message:'PRIVATE /raw/path verdict receipt attempt settled lease'});
    assert.equal(view.unreadable.count,count);
    assert.equal(view.unreadable.line,count===1?'1 cleanup record could not be read':count+' cleanup records could not be read');
    assert.doesNotMatch(view.unreadable.line,/PRIVATE|\/raw\/path|verdict|receipt|attempt|settled|lease/);
  }
  for (const count of [0,-1,null,undefined,0.5,NaN,Infinity,'2']) {
    assert.equal((await model({unreadable_records:count,unreadable_message:'PRIVATE'})).unreadable,null);
  }
});

test('unreadable records remain independent of watcher health in the summary', async () => {
  const zero=Object.fromEntries(Object.keys(counts).map(key=>[key,0]));
  const view=await model({...zero,unreadable_records:1,shared_watch:{healthy:true,count:0}});
  assert.match(view.summary.line,/Some cleanup could not be confirmed/);
  assert.equal((await model({...zero,shared_watch:{}})).summary,null);
});
