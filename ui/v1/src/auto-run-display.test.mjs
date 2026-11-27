import test from 'node:test';
import assert from 'node:assert/strict';
import {howItRanVM} from './view-models.mjs';

// "What ran": what the person asked for, what the lender passed to the agent, and what the provider reported are three
// separate facts. The effort passed to the agent is never shown as an effort the provider served.
const choice = {intent:'cheapest', model:'gpt-6-luna', effort:'low', rule_version:'auto-run-v1', reason:'lowest_list_price', capped:false, pricing_revision:'prices-sha256:' + 'a'.repeat(64)};
const receipt = over => ({harness:'codex', harness_version:'1.2.3', model:null, backend:'docker-sbx', duration_ms:60000, egress_applied:'provider-only', auto_run_v1:choice, ...over});
const texts = vm => [...vm.lines, ...(vm.details ?? [])].map(line => line.text);

test('an automatic job shows what was asked for and what was requested for this run, separately', () => {
  for (const compact of [false, true]) {
    const lines = texts(howItRanVM({receipt:receipt({model:'gpt-6-luna'})}, {role:'sent', compact}));
    assert.ok(lines.includes('Asked for: Cheapest that fits'), lines.join(' | '));
    assert.ok(lines.some(text => /^Requested for this run: `gpt-6-luna` \/ low effort$/.test(text)), lines.join(' | '));
    assert.ok(lines.includes('Provider reported: `gpt-6-luna`'), lines.join(' | '));
    assert.ok(lines.includes('Provider effort: not reported'));
  }
  assert.ok(texts(howItRanVM({receipt:receipt({auto_run_v1:{...choice, intent:'strongest', capped:true}})}, {role:'sent'})).includes('Asked for: Strongest offered'));
});

test('a provider model that differs, or none at all, is shown beside the request and never replaced by it', () => {
  const differs = texts(howItRanVM({receipt:receipt({model:'gpt-6-sol'})}, {role:'sent'}));
  assert.ok(differs.some(text => /Requested for this run: `gpt-6-luna`/.test(text)));
  assert.ok(differs.includes('Provider reported: `gpt-6-sol`'));
  const missing = texts(howItRanVM({receipt:receipt({model:null})}, {role:'sent'}));
  assert.ok(missing.includes('Provider reported: model not reported'), missing.join(' | '));
  assert.ok(!missing.some(text => /Ran (on|here) .*\(`gpt-6-luna`/.test(text)), 'the request is not printed as the model that ran');
  for (const lines of [differs, missing]) assert.ok(!lines.some(text => /low effort\)/.test(text)), 'the requested effort is not shown as served effort');
});

test('a capped strongest choice says so, and a job without a choice keeps its unknowns', () => {
  const capped = texts(howItRanVM({receipt:receipt({auto_run_v1:{...choice, intent:'strongest', model:'gpt-6-sol', effort:'medium', capped:true}})}, {role:'sent'}));
  assert.ok(capped.some(text => /Requested for this run: `gpt-6-sol` \/ medium effort/.test(text) && /lender’s effort limit/.test(text)), capped.join(' | '));
  const legacy = texts(howItRanVM({receipt:receipt({auto_run_v1:undefined})}, {role:'sent'}));
  assert.ok(!legacy.some(text => /Asked for|Requested for this run|Provider reported|Provider effort/.test(text)));
});

// The choice the person made belongs to the job, so it shows before any run exists. Only the saved selection fills "Requested for this run".
test('Asked for comes from the job at every stage; the run request waits for the saved choice', () => {
  for (const [stage, job] of [['queued', {state:'queued'}], ['running', {state:'running'}], ['failed with no result', {state:'failed'}], ['a result with no saved choice', {state:'result-accepted', receipt:receipt({auto_run_v1:undefined})}]]) {
    const lines = texts(howItRanVM({...job, requestedAutoRun:'strongest'}, {role:'sent', agent:'Codex'}));
    assert.ok(lines.includes('Asked for: Strongest offered'), stage + ': ' + lines.join(' | '));
    assert.ok(lines.includes('Requested for this run: not chosen yet'), stage + ': ' + lines.join(' | '));
    assert.ok(!lines.some(text => /Requested for this run: `/.test(text)), stage);
    assert.ok(!lines.some(text => /Provider reported: `/.test(text)), stage + ': no provider evidence yet');
  }
  const queued = texts(howItRanVM({state:'queued', requestedAutoRun:'cheapest'}, {role:'sent', agent:'Codex'}));
  assert.ok(queued.includes('Codex'), 'the agent line stays');
});

test('a saved selection fills the run request, and a job asked for nothing automatic shows nothing automatic', () => {
  const done = texts(howItRanVM({state:'result-accepted', requestedAutoRun:'cheapest', receipt:receipt({model:'gpt-6-luna'})}, {role:'sent'}));
  assert.ok(done.includes('Asked for: Cheapest that fits'));
  assert.ok(done.some(text => /^Requested for this run: `gpt-6-luna` \/ low effort$/.test(text)), done.join(' | '));
  assert.ok(done.includes('Provider reported: `gpt-6-luna`'));
  for (const job of [{state:'queued'}, {state:'failed'}, {state:'queued', requestedAutoRun:'best'}]) {
    const lines = texts(howItRanVM(job, {role:'sent', agent:'Codex'}));
    assert.ok(!lines.some(text => /Asked for|Requested for this run|Provider reported|Provider effort/.test(text)), JSON.stringify(job) + ': ' + lines.join(' | '));
  }
});
