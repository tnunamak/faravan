import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposeBody} from './compose.jsx';
import {composeVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// Send's disabled hint points at where the reason is printed. The reason sits above the buttons (#cmp-why) unless a
// folder refusal already has its own message above, so "See the reason above Send." must not appear without a folder message.
const circle = {id: 'c', state: {networked: true, host: {reachable: true}}};
const base = {id: 'send-pointer-draft-0001', prompt: 'Explain how rain gardens work', verifyCmd: 'npm test'};

test('a blocked Send names its reason once, with no pointer to a reason that is not above it', () => {
  const draft = {...base, sourceKind: 'none', path: ''};
  const vm = {...composeVM({prompt: draft.prompt, sourceKind: 'none', circle}), send: {label: 'Send', disabled: true, why: 'Send is off until the host answers.'}};
  const html = renderFixture(ComposeBody, {draft, vm});
  const text = renderedText(html);
  assert.equal(text.split('Send is off until the host answers.').length - 1, 1);
  assert.doesNotMatch(text, /See the reason above Send\./);
  assert.doesNotMatch(text, /This control is unavailable right now\./);
});

test('a blocked Send points at the folder message only when that message is above it', () => {
  const draft = {...base, sourceKind: 'folder', path: '/private/project'};
  const vm = {...composeVM({prompt: draft.prompt, sourceKind: 'folder', circle}), folderError: 'stale folder error',
    send: {label: 'Send', disabled: true, why: 'Send is off until the host answers.'}};
  const text = renderedText(renderFixture(ComposeBody, {draft, vm}));
  assert.match(text, /See the folder message above\./);
  assert.doesNotMatch(text, /See the reason above Send\./);
});
