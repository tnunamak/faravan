import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JobHead, JobStatusCard, HowItRan, CheckLines, AskedCard} from './job-view.jsx';
import {Facts} from './ds/index.mjs';
import {jobStatusVM, howItRanVM} from './view-models.mjs';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';

// U6 and U17: the job page's parts, rendered from view models. No browser, no effects.
const now = Date.parse('2026-10-19T19:00:00Z');
const running = jobStatusVM({state: 'claimed', current_attempt: {holder: 'k', execution_started_at: '2026-10-19T18:54:00Z'}},
  {now, lender: 'Ana', agent: 'Codex', device: 'Ana’s MacBook', progress: [{seq: 1, at: 'x', stage: 'agent', elapsed_s: 40}, {seq: 2, at: 'x', step: 'Editing src/save.ts', kind: 'step'}]});

test('the head is back link, one status word, the title as the page heading, then one line of context', () => {
  const out = renderFixture(JobHead, {vm: running, title: 'Make the form send an email', sub: ['Weekend projects', 'sent 26 min ago']});
  assertDomOrder(out, ['href="#/jobs"', 'Working', '<h1', 'Make the form send an email', 'Weekend projects']);
  assert.equal((out.match(/<h1/g) || []).length, 1);
  assert.match(out, /<h1[^>]*tabindex="-1"/, 'the heading can take focus on arrival');
});

test('working: four steps with Working lit, who is working, then the steps from their computer', () => {
  const out = renderFixture(JobStatusCard, {vm: running, person: 'Ana'});
  assert.match(out, /href="#user"/, 'a display label alone cannot supply avatar initials');
  assert.match(renderFixture(JobStatusCard, {vm: running, person: 'Ana', personName:'Ana Ruiz'}), />AR<\/span>/);
  assertDomOrder(out, ['aria-label="Progress: Working"', 'Ana’s Codex is working on it', 'On Ana’s MacBook', 'Prepared the sandbox · 0:40', 'Agent working · 6 min · editing src/save.ts', 'Progress reported by Ana’s computer.']);
  assert.match(out, /<li class="done">Asked/);
  assert.match(out, /<li class="now">Working/);
  assertNoBannedWords(out);
});

test('stopped and failed light the step that failed; cancelled and expired light none', () => {
  const stopped = renderFixture(JobStatusCard, {vm: jobStatusVM({state: 'cancelled', compute_stopped: true, current_attempt: {execution_started_at: '2026-10-19T18:56:00Z', stopped_at:'2026-10-19T19:00:00Z', compute_stopped: true}}, {now, lender: 'Ana'})});
  assert.match(stopped, /aria-label="Progress: Working \(did not finish\)"/);
  assert.match(renderedText(stopped), /Stopped after 4 minutes Ana’s computer confirmed that the sandbox stopped\. The agent’s changes up to the stop weren’t kept\. Ana’s computer may still hold a copy of your code until it cleans up\./);
  const expired = renderFixture(JobStatusCard, {vm: jobStatusVM({state: 'expired'}, {now})});
  assert.doesNotMatch(withoutMaskMarkers(expired), /class="steps"/);
  assert.match(renderedText(expired), /Nobody took it in time No agent started on it\./);
});

test('the waiting card hands its body to the waiting block, and "ready" has no status card of its own text', () => {
  const waiting = renderFixture(JobStatusCard, {vm: jobStatusVM({state: 'queued'}, {now}), waiting: 'WAITING-BODY'});
  assertDomOrder(waiting, ['aria-label="Progress: Asked"', 'WAITING-BODY']);
  const ready = renderFixture(JobStatusCard, {vm: jobStatusVM({state: 'result-accepted'}, {now})});
  assert.equal(renderedText(ready), 'Asked Approved Working Ready', 'only the four steps: the changes are the page');
});

test('How it ran: every fact line names its observer, the note follows, and the page names what it lacks', () => {
  const ran = howItRanVM({receipt: {harness: 'codex', duration_ms: 540000, egress_applied: 'provider-only', egress_evidence: {'chatgpt.com:443': 'allowed', 'github.com:443': 'allowed'}}}, {lender: 'Ana', device: 'MacBook', agent: 'Codex'});
  const out = renderFixture(HowItRan, {lines: ran.lines, usage: ran.usage, note: ran.note});
  assertDomOrder(out, ['<h2 class="t-title2">How it ran', 'Ran on Ana’s MacBook with Codex', 'Ran 9 min in a new sandbox on Ana’s MacBook.', 'reported by Ana’s computer', '<code class="id">chatgpt.com:443</code>', 'GitHub: ', 'Each line says who observed it.']);
  assert.match(out, /role="list"/);
  const missing = renderFixture(HowItRan, {lines: [], missing: 'Run details weren’t included with this result.'});
  assert.match(renderedText(missing), /How it ran Run details weren’t included with this result\./);
  assert.doesNotMatch(withoutMaskMarkers(missing), /class="facts"/);
  assertNoBannedWords(out + missing);
});

test('Facts: a backtick pair is code and nothing else in a sentence is markup', () => {
  const out = renderFixture(Facts, {items: [{tone: 'warn', icon: 'shield', text: 'Blocked: `a<b>.test:443`. <script>x</script>', by: 'log'}]});
  assert.match(out, /<code>a&lt;b>\.test:443<\/code>/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /class="fact warn"/);
});

test('How it ran renders signed protocol checks as Faravan observations with changed tests', () => {
  const ran = howItRanVM({receipt:{harness:'claude-code-subscription',duration_ms:40000},
    checks:[{cmd:'npm test',exit:0,timed_out:false,summary:'2 passed, 0 failed',observed_by:'sandbox',
      changed_test_files:['sum.test.mjs']}]}, {lender:'Tessa'});
  const text = renderedText(renderFixture(CheckLines, {checks:ran.checks}));
  assert.match(renderedText(renderFixture(HowItRan, {lines:ran.lines,checks:ran.checks})), /Faravan ran npm test/, 'How it ran uses the shared check component too');
  assert.match(text, /Faravan ran npm test after the agent finished: exit 0 · 2 passed, 0 failed/);
  assert.match(text, /The agent changed test files: sum.test.mjs/);
  assert.doesNotMatch(text, /The agent says it ran/);
});

test('What you asked: the sender sees their text; others get an availability statement', () => {
  assert.match(renderedText(renderFixture(AskedCard, {prompt: 'Fix the login', own: true})), /What you asked Fix the login/);
  assert.match(renderedText(renderFixture(AskedCard, {prompt: null, own: false})), /What was asked The request couldn’t be loaded\. Refresh to try again\./);
});

test('copy audit B describes absent prompt and additional run details without promising recovery',()=>{
 assert.match(renderedText(renderFixture(AskedCard,{own:true,prompt:null})),/No prompt was recorded for this job\./);
 const out=renderFixture(HowItRan,{lines:[],details:[{text:'Not provided',tone:'warn'}]});
 assert.match(out,/aria-label="Other run details"/);
 assert.doesNotMatch(out,/Unrecorded run details/);
});
