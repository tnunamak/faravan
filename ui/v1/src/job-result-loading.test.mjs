import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job} from './jobs.jsx';
import {CheckLines,HowItRan} from './job-view.jsx';
import {howItRanVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

const job = {job_digest:'sha256:finished', circle:{id:'circle'}, state:'result-accepted', role:'sent', local:{title:'Fix the date test', prompt:'Fix the date test'}, result_digest:'sha256:result'};
function firstPaint(projection) {
  return renderFixture(Job, {id:job.job_digest, requestedCircle:'circle', api:{}, circle:'circle', circles:[{id:'circle',name:'Friends'}], data:{jobs:[{...job,...projection}], devices:{fingerprint:'owner'}}, draft:{}, members:[], mutate() {}, setDialog() {}});
}
function firstPaintWithCreatedJob(navigationType) {
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'history', {configurable:true,value:{state:{createdJob:{
    job_digest:job.job_digest,circle:{id:'circle',name:'Friends'},title:'Fix the date test',prompt:'Fix the date test',submittedByMe:true,state:'queued',status:'Waiting',
  }}}});
  Object.defineProperty(globalThis, 'performance', {configurable:true,value:{getEntriesByType:() => [{type:navigationType}]}});
  try {
    return renderFixture(Job, {id:job.job_digest, requestedCircle:'circle', api:{}, circle:'circle', circles:[{id:'circle',name:'Friends'}], data:{jobs:[], devices:{fingerprint:'owner'}}, draft:{}, members:[], mutate() {}, setDialog() {}});
  } finally {
    if (previousHistory) Object.defineProperty(globalThis, 'history', previousHistory);
    else delete globalThis.history;
    if (previousPerformance) Object.defineProperty(globalThis, 'performance', previousPerformance);
    else delete globalThis.performance;
  }
}
function CheckSurfaces({lines,checks}) {
  return h('div',null,
    h('section',null,h('h2',null,'Faravan’s checks'),h(CheckLines,{checks})),
    h(HowItRan,{lines,checks}));
}

test('a queued jobs-list projection cannot paint Waiting or Cancel before the job read', () => {
  const out = firstPaint({state:'queued', status:'Waiting'});
  assert.match(out, /role="status" aria-label="Loading job"/);
  assert.doesNotMatch(renderedText(out), /Waiting for a computer|Cancel job/);
});

test('even a terminal list projection waits for the job record before painting its result', () => {
  const out = firstPaint({receipt:{candidate_format:'diff',diffstat:{files:0}}});
  assert.match(out, /role="status" aria-label="Loading job"/);
  assert.doesNotMatch(renderedText(out), /No changes|Ready to review|Download the patch|Use these changes/);
});

for (const [label,navigationType] of [['reload','reload'],['back','back_forward']]) {
  test(`${label}: persisted history.state.createdJob cannot paint Waiting or Cancel before the job read`, () => {
    const out = firstPaintWithCreatedJob(navigationType);
    assert.match(out, /role="status" aria-label="Loading job"/);
    assert.doesNotMatch(renderedText(out), /Waiting for a computer|Cancel job/);
  });
}

for (const [name,check] of [['pass',{exit:0,summary:'49 passed'}],['fail',{exit:1,summary:'3 failed'}],['timeout',{timed_out:true}],['legacy',{exit:0}]]) {
  test(`${name}: both check surfaces keep the source and scope caption`, () => {
    const note="The agent could change the project's test files and tools.";
    const context=name==='legacy'?{}:{check_context:{note:"Faravan ran npm test after the agent; "+note[0].toLowerCase()+note.slice(1)}};
    const result=howItRanVM({checks:[{cmd:'npm test',observed_by:'sandbox',...check,...context}]});
    const out=renderFixture(CheckSurfaces,{lines:result.lines,checks:result.checks});
    const section=out.indexOf('Faravan’s checks'), aside=out.indexOf('How it ran');
    assert.ok(section>=0 && aside>section);
    assert.ok(out.slice(section,aside).includes(note));
    assert.ok(out.slice(aside).includes(note));
  });
}
