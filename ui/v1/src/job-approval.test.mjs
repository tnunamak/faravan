import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {JobStatusCard} from './job-view.jsx';
import {jobStatusVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

const now = Date.parse('2026-10-19T19:00:00Z');
const render = attempt => {
  const approval = attempt.approved_at || attempt.execution_started_at ? 'approved' : 'pending';
  const vm = jobStatusVM({state:'claimed',approval,current_attempt:attempt},{now,lender:'Ana'});
  return {vm,html:renderFixture(JobStatusCard,{vm,person:'Ana',waiting:h('div',null,'Generic waiting block')})};
};

test('waiting for approval renders its own detail and leaves Approved ahead', () => {
  const {vm,html} = render({claimed_at:'2026-10-19T18:50:00Z'});
  assert.deepEqual([vm.key,vm.kind,vm.headline,vm.canStop,vm.stopLabel],
    ['waiting_approval','status','Waiting for Ana to say yes',true,'Cancel job']);
  assert.match(renderedText(html),/Waiting for Ana to say yes/);
  assert.doesNotMatch(withoutMaskMarkers(html),/Generic waiting block|class="done">Approved/);
  assert.match(html,/<li class="now">Asked<\/li>/);
  assert.match(html,/<li class(?:="")?>Approved<\/li>/);
});

test('approval and execution advance the detail stepper in order', () => {
  const approved = render({approved_at:'2026-10-19T18:53:00Z'});
  assert.deepEqual([approved.vm.key,approved.vm.headline,approved.vm.step],['approved','Ana said yes',1]);
  assert.match(renderedText(approved.html),/Ana said yes/);
  assert.match(approved.html,/<li class="done">Asked<\/li>/);
  assert.match(approved.html,/<li class="now">Approved<\/li>/);
  assert.doesNotMatch(approved.html,/Generic waiting block|We can’t tell what happened/);

  const running = render({approved_at:'2026-10-19T18:53:00Z',execution_started_at:'2026-10-19T18:54:00Z'});
  assert.deepEqual([running.vm.key,running.vm.step],['working',2]);
  assert.match(running.html,/<li class="done">Approved<\/li>/);
  assert.match(running.html,/<li class="now">Working<\/li>/);
});
