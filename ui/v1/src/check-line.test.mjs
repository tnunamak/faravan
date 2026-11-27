import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLineVM, howItRanVM} from './view-models.mjs';
import {CheckLine, CheckLines, HowItRan} from './job-view.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';

const note = "The agent could change the project's test files and tools.";
const base = {cmd:'npm test', observed_by:'sandbox', check_context:{agent_mutable_workspace:true, independent:false, note}};
const cases = [
  ['pass', {...base, exit:0, summary:'49 passed'}, 'exit 0 · 49 passed'],
  ['fail', {...base, exit:1, summary:'3 failed'}, 'exit 1 · 3 failed'],
  ['timeout', {...base, timed_out:true, exit:null}, 'timed out'],
  ['legacy', {cmd:'npm test', observedBy:'sandbox', exit:0, outputSays:'49 passed'}, 'exit 0 · 49 passed'],
];
for (const [name, check, outcome] of cases) test(`${name}: every check surface shows the outcome and conservative caption`, () => {
  const vm = checkLineVM(check);
  assert.equal(vm.text, 'Faravan ran `npm test` after the agent finished: ' + outcome);
  for (const html of [renderFixture(CheckLine, {vm}), renderFixture(CheckLines, {checks:[vm]}),
    renderFixture(HowItRan, {lines:[], checks:howItRanVM({receipt:{checks:[check]}}, {role:'ran'}).checks})]) {
    assert.match(renderedText(html), new RegExp(outcome));
    assert.ok(renderedText(html).includes(note));
    assert.match(html, /<code>npm test<\/code>/);
    assert.match(html, /<p class="t-xs t-2">The agent could change/);
    assert.doesNotMatch(renderedText(html), /\b(?:verified|independent|proof|proves)\b/i);
  }
});

test('timeout never borrows a duration from the job budget or the whole receipt', () => {
  const vm = howItRanVM({maxMinutes:10, receipt:{duration_ms:600000, checks:[{...base,timed_out:true}]}}).checks[0];
  assert.equal(vm.suffix, ' after the agent finished: timed out');
  assert.doesNotMatch(vm.text, /10|min/);
});

test('check copy guard rejects assurance words in supplied summaries and captions', () => {
  for (const word of ['verified','independent','proof','proves']) {
    const html = renderFixture(CheckLine, {vm:checkLineVM({...base, exit:0, cmd:'npm run '+word, summary:word, changed_test_files:[word+'.test.mjs'], check_context:{note:word}})});
    assert.doesNotMatch(renderedText(html), new RegExp('\\b'+word+'\\b','i'));
    assert.match(renderedText(html), /The agent could change the project/);
  }
});

test('unknown observers remain agent reports, commands are escaped, and check source precedence is retained', () => {
  const html = renderFixture(CheckLine, {vm:checkLineVM({cmd:'echo <script>x</script>',summary:'2 passed'})});
  assert.match(renderedText(html), /The agent says it ran/);
  assert.doesNotMatch(html, /<script>/);
  assert.deepEqual(howItRanVM({checks:[],receipt:{checks:[base]}}).checks, []);
  assert.equal(howItRanVM({result:{checks:[base]}}).checks.length, 1);
});


test('API envelope context belongs to its selected checks, with per-check context preferred', () => {
  const apiNote = "The project's test files and tools could have changed during the agent's work.";
  const check = {...base, check_context:undefined, exit:1};
  for (const source of [{checks:[check],check_context:{note:apiNote}},
    {result:{checks:[check],check_context:{note:apiNote}}}, {receipt:{checks:[check],check_context:{note:apiNote}}}]) {
    assert.equal(howItRanVM(source).checks[0].note, apiNote);
  }
  assert.equal(howItRanVM({checks:[base],check_context:{note:apiNote}}).checks[0].note, note);
  assert.equal(howItRanVM({check_context:{note:apiNote},receipt:{checks:[check]}}).checks[0].note, note,
    'an unrelated envelope cannot supply the selected receipt’s context');
});

test('check timing uses observed duration and enforced timeout fields without inferring a cap',()=>{
 const base={cmd:'npm test',exit:null,timed_out:true,observed_by:'sandbox'};
 assert.match(checkLineVM({...base,timeout_ms:300000,duration_ms:300012}).text,/timed out after 5 min/);
 assert.match(checkLineVM({...base,timeout_ms:300000,duration_ms:300012}).text,/5 min 0\.012 s/);
 assert.doesNotMatch(checkLineVM(base).text,/after \d/);
 assert.match(checkLineVM({...base,timed_out:false,exit:0,duration_ms:0}).text,/0 s/);
 assert.doesNotMatch(checkLineVM({...base,timeout_ms:-1,duration_ms:NaN}).text,/NaN|-1/);
});

test('a skipped verification reports that it did not run, with its requested command separate',()=>{
 const vm=checkLineVM({cmd:'npm test',exit:null,timed_out:false,observed_by:'sandbox',skipped:'The fresh check sandbox could not start.'});
 assert.equal(vm.text,"Didn't run: The fresh check sandbox could not start.");
 const html=renderFixture(CheckLine,{vm});assert.match(renderedText(html),/Didn't run: The fresh check sandbox could not start/);assert.match(html,/<code>npm test<\/code>/);
 assert.doesNotMatch(renderedText(html),/Faravan ran|ended without an exit code/);
});

test('skipped checks override a stale ran caption from the API',()=>{
 const vm=checkLineVM({cmd:'npm test',observed_by:'sandbox',skipped:'The check workspace could not start.',check_context:{note:'Faravan ran npm test after the agent.'}});
 assert.equal(vm.note,"The check didn't run, so nothing was verified.");
 assert.doesNotMatch(renderedText(renderFixture(CheckLine,{vm})),/Faravan ran/);
});

test('F1 sanitized skipped reasons still dominate successful exit and summary',()=>{
 for(const skipped of ['Could not be verified','independent proof proves it']) {
  const vm=checkLineVM({...base,exit:0,summary:'all passed',skipped});
  assert.equal(vm.skipped,true);assert.equal(vm.skippedReason,'The check could not run.');
  assert.doesNotMatch(renderedText(renderFixture(CheckLine,{vm})),/Faravan ran|exit 0|all passed/);
 }
});
