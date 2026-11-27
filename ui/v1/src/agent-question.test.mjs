import {mount,flush,teardown} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {afterEach} from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {agentQuestion,agentQuestionVM} from './agent-question.mjs';
import {AgentQuestion} from './agent-question.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
test('only explicit QUESTION lines in the final agent message declare a question',()=>{
 assert.equal(agentQuestion('Should I change this?'),'');assert.equal(agentQuestion('An example: QUESTION: change it?'),'');assert.equal(agentQuestion('QUESTION: Which timezone should I use?'),'Which timezone should I use?');
 assert.equal(agentQuestion('Done.\nQUESTION: Use UTC?\nSome context.'),'Use UTC?');
 assert.equal(agentQuestion('```\nQUESTION: sample\n```'),'');
});
test('question ends a run, and the answer explicitly prepares a fresh accepted job',()=>{
 const html=renderFixture(AgentQuestion,{question:'Use UTC?',onAnswer:()=>{}});assert.match(renderedText(html),/The agent has a question/);assert.match(html,/<textarea/);assert.match(renderedText(html),/new job/);assert.match(renderedText(html),/Prepare follow-up/);
});
test('agent question Markdown stays safe and formats code and headings',()=>{
 const html=renderFixture(AgentQuestion,{question:'## Choice\n\nUse **UTC** and `Intl`. [bad](javascript:alert(1)) ![pixel](https://tracker.test/p.png)'});
 assert.match(html,/<h3>Choice<\/h3>/);assert.match(html,/<strong>UTC<\/strong>/);
 assert.doesNotMatch(html,/<img|href="javascript:/);
});
test('question presentation separates the protocol marker from the final summary',async()=>{
 const {agentQuestionVM}=await import('./agent-question.mjs');
 assert.deepEqual(agentQuestionVM('Fixed the parser.\nQUESTION: Use **UTC**?'),{question:'Use **UTC**?',body:'Fixed the parser.'});
 assert.deepEqual(agentQuestionVM('QUESTION: Use UTC?'),{question:'Use UTC?',body:''});
 assert.deepEqual(agentQuestionVM('```text\nQUESTION: sample\n```'),{question:'',body:'```text\nQUESTION: sample\n```'});
});
test('question markers inside mismatched or short fences remain literal',()=>{
 for(const summary of ['~~~~\n```\nQUESTION: literal\n~~~~','````\n```\nQUESTION: literal\n````','~~~\n~~~ trailing\nQUESTION: literal\n~~~'])assert.deepEqual(agentQuestionVM(summary),{question:'',body:summary});
});
test('matching long bare closers end a question fence',()=>{
 for(const [open,close] of [['~~~~','~~~~~'],['````js','````'],['~~~','  ~~~  ']]){
  const literal=open+'\nQUESTION: literal\n'+close;
  assert.deepEqual(agentQuestionVM(literal+'\nQUESTION: Real?'),{question:'Real?',body:literal.trim()});
 }
});
test('four-space and tab-indented code is not a question or a fence',()=>{
 assert.equal(agentQuestion('    QUESTION: literal\n\tQUESTION: literal'),'');
 assert.deepEqual(agentQuestionVM('    ```\nQUESTION: Real?'),{question:'Real?',body:'```'});
});
test('selecting the first marker preserves later question lines',()=>{
 assert.deepEqual(agentQuestionVM('QUESTION: Use UTC?\nQUESTION: Keep backups?'),{question:'Use UTC?',body:'QUESTION: Keep backups?'});
});
test('a shortened question keeps its full text in the body without the protocol marker',()=>{
 const question='x'.repeat(2001),line='QUESTION: '+question;
 assert.deepEqual(agentQuestionVM(line+'\nQUESTION: Next?'),{question:question.slice(0,2000)+'… (question shortened; full text in the result)',body:question+'\nQUESTION: Next?'});
});

test('F7 question without a handler explains ended lifecycle without a fake action',()=>{
 const html=renderFixture(AgentQuestion,{question:'Use UTC?'});
 assert.match(renderedText(html),/This run has ended. A follow-up is not available for this result./);
 assert.doesNotMatch(html,/<button|<textarea|<a\s/);
 const available=renderedText(renderFixture(AgentQuestion,{question:'Use UTC?',onAnswer:()=>{}}));
 assert.match(available,/prepares a new job/);assert.match(available,/Prepare follow-up/);
});

afterEach(teardown);
const typeAnswer=async(view,value)=>{view.$('textarea').value=value;view.$('textarea').dispatchEvent(new Event('input',{bubbles:true}));await flush();};
const submitQuestion=view=>view.$('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
test('R2 mounted question replacement never submits the old answer to a new question',async()=>{
 const calls=[],view=await mount(h(AgentQuestion,{questionId:'result-a',question:'Use UTC?',onAnswer:value=>calls.push(['a',value])}));
 await typeAnswer(view,'Answer for A');
 await view.rerender(h(AgentQuestion,{questionId:'result-b',question:'Use local time?',onAnswer:value=>calls.push(['b',value])}));
 assert.equal(view.$('textarea').value,'');submitQuestion(view);await flush();assert.deepEqual(calls,[]);
 await typeAnswer(view,'Answer for B');submitQuestion(view);await flush();
 assert.deepEqual(calls,[['b','Answer to the agent’s question: Use local time?\n\nAnswer for B']]);
});
test('R2 identical question text on a different result resets its draft',async()=>{
 const view=await mount(h(AgentQuestion,{questionId:'a',question:'Use UTC?',onAnswer:()=>{}}));
 await typeAnswer(view,'Old answer');await view.rerender(h(AgentQuestion,{questionId:'b',question:'Use UTC?',onAnswer:()=>{}}));
 assert.equal(view.$('textarea').value,'');
});
test('R3 same-render and post-success submissions prepare only once per identity',async()=>{
 let resolve,count=0;const pending=new Promise(done=>{resolve=done;});
 const view=await mount(h(AgentQuestion,{questionId:'a',question:'Use UTC?',onAnswer:()=>{count++;return pending;}}));
 await typeAnswer(view,'Yes');submitQuestion(view);submitQuestion(view);await flush();assert.equal(count,1);
 resolve();await flush();submitQuestion(view);await flush();assert.equal(count,1);
 assert.equal(view.button('Follow-up prepared').getAttribute('aria-disabled'),'true');
});

test('answerable questions explain preparation without the ended-only opening',()=>{
 const text=renderedText(renderFixture(AgentQuestion,{question:'Use UTC?',onAnswer:()=>{}}));
 assert.doesNotMatch(text,/This run has ended/);assert.match(text,/prepares a new job/);
});
test('answer count and prepared confirmation track the mounted form',async()=>{
 const view=await mount(h(AgentQuestion,{question:'Use UTC?',onAnswer:async()=>{}}));
 assert.match(view.$('form').textContent,/0 \/ 8000 characters/);
 await typeAnswer(view,'Yes');assert.match(view.$('form').textContent,/3 \/ 8000 characters/);
 submitQuestion(view);await flush();
 assert.match(view.$('form').textContent,/Your answer prepared a follow-up job/);
 assert.doesNotMatch(view.$('form').textContent,/Your answer prepares/);
});
