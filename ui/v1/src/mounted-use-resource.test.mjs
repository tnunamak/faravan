import {act, advance, click, createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {useResource} from './shared.jsx';

// P0 group 1: the real useResource hook mounted in a real DOM, with the real resource-read queue and a
// fake clock. The API object is one stable fake whose reads are deferred promises.
beforeEach(() => { resetPage(); installClock(); });
afterEach(teardown);

const renders = {count: 0};
// Rerenders on a one-second clock, like the job page's decision clock, and passes a FRESH options object
// on every render, exactly as jobs.jsx does.
function Probe({api, path, revision = 0, poll = 0, ticking = true}) {
  renders.count++;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const state = useResource(api, path, revision, {poll, minInterval: 5000});
  return h('output', null, JSON.stringify(state.data) + '|' + (state.error ? 'error' : 'ok') + '|' + (state.stale ? 'stale' : 'fresh'));
}
let generationState;
function GenerationProbe({api}) {
  generationState=useResource(api,'jobs/generation',0);
  return h('output',null,JSON.stringify([generationState.readGeneration,generationState.resourceGeneration]));
}
const props = (api, over = {}) => ({api, path: 'jobs/a', ...over});

test('useResource mounted: ordinary rerenders and clock ticks neither fetch nor abort', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api)));
  const first = api.reads[0];
  assert.equal(api.count('jobs/a'), 1);
  for (let n = 0; n < 3; n++) await view.rerender(h(Probe, props(api, {extra: n})));
  const before = renders.count;
  await advance(10000);
  assert.ok(renders.count - before >= 10, 'the one-second clock really rerendered the component');
  assert.equal(api.count('jobs/a'), 1, 'no second read');
  assert.ok(!first.aborted, 'the in-flight read was not aborted');
  assert.equal(first.state, 'open');
  await api.answer('jobs/a', {n: 1});
  assert.equal(view.text(), '{"n":1}|ok|fresh');
  await advance(60000);
  assert.equal(api.count('jobs/a'), 1, 'without a poll or revision change nothing reads again');
});

test('useResource mounted: reload exposes a barrier newer than an in-flight response', async () => {
  const api=createFakeApi();
  const view=await mount(h(GenerationProbe,{api}));
  await api.answer('jobs/generation',{phase:'running'});
  let readBeforeReload,barrier;
  await act(()=>{readBeforeReload=generationState.reload();barrier=generationState.reload();});
  assert.ok(barrier>readBeforeReload);
  assert.equal(generationState.resourceGeneration,barrier);
  await api.answer('jobs/generation',{phase:'running'});
  assert.equal(generationState.readGeneration,readBeforeReload,'the in-flight result is still identified by its start generation');
  assert.equal(generationState.resourceGeneration,barrier,'the hook retains the reload barrier');
  await api.answer('jobs/generation',{phase:'stopped'});
  assert.equal(generationState.readGeneration,barrier,'the follow-up read started at the barrier');
  assert.equal(generationState.resourceGeneration,barrier);
  assert.equal(view.text(),JSON.stringify([barrier,barrier]));
});

test('useResource mounted: one meaningful revision refreshes once, repeated and bursty revisions coalesce', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api)));
  await api.answer('jobs/a', {n: 1});
  for (let n = 0; n < 3; n++) await view.rerender(h(Probe, props(api, {revision: 0})));
  await advance(3000);
  assert.equal(api.count('jobs/a'), 1, 'the same revision never refreshes');
  await view.rerender(h(Probe, props(api, {revision: 1})));
  assert.equal(view.text(), '{"n":1}|ok|fresh', 'I06: a revision asks for a read; the last answer stays current, never "Last known"');
  await advance(1999);
  assert.equal(api.count('jobs/a'), 1, 'reads start at least five seconds apart');
  await advance(1);
  assert.equal(api.count('jobs/a'), 2, 'exactly one refresh for one revision');
  await api.answer('jobs/a', {n: 2});
  assert.equal(view.text(), '{"n":2}|ok|fresh');
  for (const revision of [2, 3, 4, 4, 4]) await view.rerender(h(Probe, props(api, {revision})));
  await advance(60000);
  assert.equal(api.count('jobs/a'), 3, 'a burst of revisions is one more read');
  assert.equal(api.peak('jobs/a'), 1);
});

test('useResource mounted: a stale result for an old path cannot overwrite the new path', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api, {path: 'jobs/a'})));
  const late = api.reads[0];
  late.ignoreAbort = true; // a transport that ignores cancellation and answers anyway
  await view.rerender(h(Probe, props(api, {path: 'jobs/b'})));
  assert.ok(late.aborted, 'leaving the path aborts its read');
  assert.equal(api.count('jobs/b'), 1);
  await api.answer('jobs/b', {from: 'b'});
  assert.equal(view.text(), '{"from":"b"}|ok|fresh');
  late.settle('ok', {from: 'a'});
  await flush();
  await advance(10000);
  assert.equal(view.text(), '{"from":"b"}|ok|fresh', 'the late answer for /a is dropped');
  // And while /b is still loading the old path's late answer must not stand in for it.
  const second = await mount(h(Probe, props(api, {path: 'jobs/c'})), {id: 'second'});
  const slowC = api.openReads('jobs/c')[0];
  slowC.ignoreAbort = true;
  await second.rerender(h(Probe, props(api, {path: 'jobs/d'})));
  slowC.settle('ok', {from: 'c'});
  await flush();
  assert.equal(second.text(), 'null|ok|fresh', 'still loading /d, not showing /c');
});

test('useResource mounted: unmount aborts the in-flight read and a late result is inert', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api)));
  const call = api.reads[0];
  call.ignoreAbort = true;
  await view.unmount();
  assert.ok(call.aborted, 'unmounting aborts the read');
  call.settle('ok', {n: 1});
  await advance(60000);
  assert.equal(api.count('jobs/a'), 1, 'nothing reads after unmount');
});

test('useResource mounted: a slow read survives clock ticks, never overlaps, and spaces the next read from its start', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api, {poll: 1000})));
  const slow = api.reads[0];
  await advance(7000);
  await view.rerender(h(Probe, props(api, {poll: 1000, revision: 1})));
  await advance(13000);
  assert.equal(api.count('jobs/a'), 1, 'twenty seconds of ticks, a revision and a poll did not start a second read');
  assert.ok(!slow.aborted);
  assert.equal(api.peak('jobs/a'), 1);
  await api.answer('jobs/a', {n: 1});
  assert.equal(view.text(), '{"n":1}|ok|fresh', 'I06: a revision mid-read schedules another read; the successful answer is current');
  await advance(9000);
  assert.equal(api.count('jobs/a'), 1, 'the next read starts thirty seconds after the slow one started');
  await advance(1000);
  assert.equal(api.count('jobs/a'), 2);
  assert.equal(api.peak('jobs/a'), 1);
});

// I30: a section the page stops needing on the same route (its path becomes null, as progress does when a job
// finishes) lets its read finish unseen; cancelling it mid-flight is what the invariant counts as an aborted read.
test('useResource mounted: a path that becomes null lets its read finish instead of cancelling it', async () => {
  const api = createFakeApi();
  const view = await mount(h(Probe, props(api, {path: 'jobs/a/progress'})));
  const call = api.reads[0];
  await view.rerender(h(Probe, props(api, {path: null})));
  assert.ok(!call.aborted, 'not cancelled');
  call.settle('ok', {entries: []});
  await flush();
  assert.equal(view.text(), 'null|ok|fresh', 'the late answer is not shown for a section that is gone');
});
