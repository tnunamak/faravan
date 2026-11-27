import test from 'node:test';
import assert from 'node:assert/strict';
import {InvitationProblem, invitationProblemText} from './circles.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {problemView} from './problem-catalog.mjs';

// r8 O10: with a slow disk the invitation call timed out and the page read "Error mutation_uncertain" and stayed blocked.
test('an invitation whose answer never came says so in plain words, with no raw code on the page', () => {
  for (const problem of [{code:'timeout',status:504}, {code:'mutation_uncertain', problem:{code:'mutation_uncertain'}}, {code:'network'}, new Error('Failed to fetch')]) {
    const text = renderedText(renderFixture(InvitationProblem, {problem}));
    assert.match(text, /did not hear back/);
    assert.match(text, /create another one/);
    assert.doesNotMatch(text, /mutation_uncertain|Error timeout|The job is still pending|blocked here/i);
  }
});
test('a definite refusal keeps its own catalog copy', () => {
  const problem = {code:'device_removed', status:409};
  assert.equal(invitationProblemText(problem), problemView(problem).detail);
});
test('an uncertain join says the saved request will retry, not that an invitation was made',()=>{
  const problem={code:'network_error',outcome:'unknown',status:409};
  const text=renderedText(renderFixture(InvitationProblem,{problem,kind:'join'}));
  assert.match(text,/Couldn’t reach the host/);
  assert.match(text,/saved and will retry with the same invitation/);
  assert.doesNotMatch(text,/invitation was made|create another one/);
});
test('a host outage during Join gives the joiner a retry path, not invitation-creation advice',()=>{
  const problem={code:'invite_unreachable',status:502};
  const text=renderedText(renderFixture(InvitationProblem,{problem,kind:'join'}));
  assert.match(text,/The circle server isn’t answering/);
  assert.match(text,/You haven’t joined yet/);
  assert.match(text,/Review invitation again when the host is back, then try Join circle/);
  assert.doesNotMatch(text,/invitation was made|create another one|Invitations tab/);
});
test('the timeout code is a known connection problem, not "unknown"', () => {
  assert.equal(problemView({code:'timeout'}).title, 'Faravan did not hear back in time');
});
