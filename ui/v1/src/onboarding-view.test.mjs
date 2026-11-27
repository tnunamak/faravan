import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {OnboardingEntry, ProgressCard, FirstTasks, ExampleResult} from './onboarding.jsx';
import {onboardingVM, EXAMPLE_RESULT} from './onboarding.mjs';

const joined = {id: 'c2', origin: 'https://c.example', name: 'Ana’s circle', enrollment: {state: 'approved'}, rosterMembershipVerified:true};

test('entry card: one heading, borrower actions first, lending named optional', () => {
  const vm = onboardingVM({home: {lending: {enabled: false}}});
  const html = renderFixture(OnboardingEntry, {entry: vm.entry});
  const text = renderedText(html);
  assert.equal((html.match(/<h2/g) || []).length, 1);
  assert.ok(text.indexOf('Join with an invitation') < text.indexOf('Start a circle'));
  assert.match(text, /Lending is optional/);
  assert.match(html, /aria-expanded="false"[^>]*>See an example/);
});

test('example result is labelled as an example on every rendering and never looks like a live job link', () => {
  const html = renderFixture(ExampleResult, {});
  const text = renderedText(html);
  assert.match(text, /Example result · not a real job/);
  for (const part of [EXAMPLE_RESULT.request, EXAMPLE_RESULT.check, EXAMPLE_RESULT.branch]) assert.ok(text.includes(part), part);
  assert.doesNotMatch(html, /href="#\/job\//);
  assert.match(html, /aria-label="Example result · not a real job"/);
});

test('progress card: an ordered list with the current step marked and whose turn it is', () => {
  const vm = onboardingVM({home: {}, circles: [joined]});
  const html = renderFixture(ProgressCard, {progress: vm.progress});
  assert.match(html, /<ol/);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(renderedText(html), /2 of 4 done/);
  assert.match(renderedText(html), /Your turn: send a job/);
});

test('first-task suggestions are buttons that say what they do', () => {
  const vm = onboardingVM({home: {}, circles: [joined]});
  const html = renderFixture(FirstTasks, {tasks: vm.suggestions, onChoose() {}});
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.match(renderedText(html), /Explain this project/);
  assert.equal(renderFixture(FirstTasks, {tasks: [], onChoose() {}}), '');
});

test('progress renders the running stage without the acceptance-wait copy', () => {
  const vm = onboardingVM({home: {}, circles: [joined], jobs: [{role: 'sent', job_digest: 'sha256:' + 'a'.repeat(64), state: 'running', current_attempt: {attempt_id: 'a1', generation: 1, state: 'active', execution_started_at: '2026-01-01T00:00:00Z', execution_observed_at: '2026-01-01T00:00:00Z'}}]});
  const text = renderedText(renderFixture(ProgressCard, {progress: vm.progress}));
  assert.match(text, /Your job is running. Open it for progress or stop controls./);
  assert.doesNotMatch(text, /Waiting for a lender|Wait for the first result/);
});

test('example renders the strict departure-after-arrival request', () => {
  const text = renderedText(renderFixture(ExampleResult, {}));
  assert.ok(text.includes('Stop checkout unless the departure date is after the arrival date.'));
});
