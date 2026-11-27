import test from 'node:test';
import assert from 'node:assert/strict';
import {timelineVM} from './job-timeline.mjs';
import {JobTimeline, JobTimelineView} from './job-timeline.jsx';

test('decision history labels a declined approval as Declined',()=>{
  const view=timelineVM({stages:[{key:'approval',label:'Decision',outcome:'declined'}],complete:true},{timeZone:'UTC'});
  const text=renderedText(renderFixture(JobTimelineView,{view}));
  assert.match(text,/Declined/);
  assert.doesNotMatch(text,/skipped/i);
});
import {renderFixture, renderedText} from './render.test-helper.mjs';

const timeline = {
  job_digest: 'sha256:' + 'a'.repeat(64), complete: true, retention: {days: 90, durable: true},
  stages: [
    {key: 'sent', label: 'Sent', at: '2026-10-20T12:00:00.000Z', clock: 'sender', durationMs: null, noticed: false},
    {key: 'picked_up', label: 'Picked up', at: '2026-10-20T12:01:00.000Z', clock: 'coordinator', durationMs: null, noticed: false},
    {key: 'approval', label: 'Approval', at: '2026-10-20T12:01:05.000Z', clock: 'this-computer', durationMs: 20000, noticed: false, outcome: 'accepted', auto: null},
    {key: 'preparing', label: 'Preparing the sandbox', at: '2026-10-20T12:01:30.000Z', clock: 'reported', durationMs: 41000, noticed: false},
    {key: 'running', label: 'Agent working', at: null, clock: 'reported', durationMs: null, noticed: false},
    {key: 'finished', label: 'Failed', at: '2026-10-20T13:00:00.000Z', clock: 'this-computer', durationMs: null, noticed: true, outcome: 'failed'},
  ],
};

test('timeline rows show recorded times only, label noticed times, and never invent a duration', () => {
  const vm = timelineVM(timeline, {timeZone: 'UTC'});
  assert.equal(vm.state, 'rows');
  const by = Object.fromEntries(vm.rows.map(row => [row.key, row]));
  assert.equal(by.sent.time, '12:00 PM');
  assert.equal(by.approval.detail, 'Approved');
  assert.equal(by.approval.duration, 'took 20s');
  assert.equal(by.preparing.duration, 'took 41s');
  assert.equal(by.running.time, 'Time not recorded');
  assert.equal(by.running.missing, true);
  assert.equal(by.running.duration, '');
  assert.equal(by.finished.time, 'Recorded at 1:00 PM');
  assert.equal(by.sent.duration, '', 'no duration across two computers');
  assert.deepEqual(vm.notes, ['Stage times come from the computer that ran the job.']);
});

test('timeline states: loading renders nothing, failure is quiet, incomplete and non-durable say so', () => {
  assert.equal(timelineVM(null).state, 'loading');
  assert.equal(renderFixture(JobTimelineView, {view: timelineVM(null)}), '');
  assert.match(renderedText(renderFixture(JobTimelineView, {view: timelineVM(null, {error: new Error('x')})})), /The timeline is unavailable right now/);
  const open = timelineVM({stages: [timeline.stages[0]], complete: false, retention: {days: 90, durable: false}}, {timeZone: 'UTC'});
  assert.ok(open.notes.includes('More stages appear as they happen.'));
  assert.ok(open.notes.some(note => /couldn't save its history/.test(note)));
  assert.equal(timelineVM({stages: [], complete: false}).state, 'empty');
  const auto = timelineVM({stages: [{...timeline.stages[2], auto: 'own job'}], complete: false}, {timeZone: 'UTC'});
  assert.equal(auto.rows[0].detail, 'Approved automatically');
});

test('rendered timeline is an ordered list with stage, detail, time and duration', () => {
  const text = renderedText(renderFixture(JobTimelineView, {view: timelineVM(timeline, {timeZone: 'UTC'})}));
  assert.match(text, /^Timeline Sent 12:00 PM Picked up 12:01 PM Approval · Approved 12:01 PM · took 20s Preparing the sandbox 12:01 PM · took 41s Agent working Time not recorded Failed Recorded at 1:00 PM/);
  assert.match(renderFixture(JobTimelineView, {view: timelineVM(timeline, {timeZone: 'UTC'})}), /<ol class="list stack-2">/);
});

test('JobTimeline mounts with the parent contract and renders nothing before data arrives', () => {
  const calls = [];
  const api = {get: async path => { calls.push(path); return timeline; }};
  assert.equal(renderFixture(JobTimeline, {api, jobId: timeline.job_digest, circle: 'c 1', revision: 3}), '');
  assert.equal(renderFixture(JobTimeline, {api: null, jobId: null}), '');
});

test('finished lender timeline resolves an old waiting decision and omits Sent',()=>{
 const vm=timelineVM({...timeline,complete:false,stages:timeline.stages.map(s=>s.key==='approval'?{...s,outcome:'waiting'}:s)},{role:'ran',terminal:true,timeZone:'UTC'});
 assert.equal(vm.rows.some(row=>row.key==='sent'),false);
 assert.equal(vm.rows.find(row=>row.key==='approval').detail,'Approved');
 assert.ok(!vm.notes.includes('More stages appear as they happen.'));
});


test('app approval resolves a waiting timeline before any execution stage exists', () => {
  for (const role of ['sent','ran']) {
    const view = timelineVM({approval:'approved',complete:false,stages:[
      {key:'approval',label:'Approval',at:null,outcome:'waiting'}
    ]},{role});
    assert.equal(view.rows[0].detail,'Approved');
    assert.equal(view.rows[0].time,'Time not recorded');
  }
  for (const approval of ['pending',null,undefined]) {
    assert.equal(timelineVM({approval,stages:[{key:'approval',outcome:'waiting'}]}).rows[0].detail,'Waiting for a decision');
  }
});
