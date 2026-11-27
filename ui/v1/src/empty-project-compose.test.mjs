import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposeBody} from './compose.jsx';
import {composeVM,requestVM} from './view-models.mjs';
import {sourceSummary} from './helpers.mjs';
import {draftBody,loadDraft,saveDraft,newDraftFromJob} from './compose-draft.mjs';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const draft={id:'report-draft-0001',sourceKind:'none',prompt:'Explain how rain gardens work',path:'/private/project',includeUncommitted:true,verifyCmd:'npm test'};
test('prompt-only drafts send explicit no-source, automatic message result and no local paths or test command',()=>{
 assert.deepEqual(draftBody(draft,'circle'),{circle:'circle',prompt:draft.prompt,draft_id:draft.id,noSource:true,result:{kind:'message'}});
});
test('source survives draft recovery without output-choice state',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 saveDraft(storage,'c',draft);const loaded=loadDraft(storage,'c');
 assert.equal(loaded.sourceKind,'none');assert.equal(Object.hasOwn(loaded,'resultKind'),false);
});
test('a question can send without a project, while the circle and prompt are still required',()=>{
 const args={prompt:draft.prompt,sourceKind:'none',circle:{id:'c',state:{networked:true}}};
 assert.equal(composeVM(args).send.disabled,false);
 assert.equal(composeVM({...args,prompt:''}).send.disabled,true);
 assert.equal(composeVM({...args,circle:{}}).send.disabled,true);
});
test('empty-folder composer hides folder and code checks, explains empty workspace without future sources',()=>{
 const html=renderFixture(ComposeBody,{draft,vm:composeVM({prompt:draft.prompt,sourceKind:'none',circle:{id:'c'}})}),text=renderedText(html);
 assert.match(text,/No project/);assert.match(text,/writing, analysis, questions, images, data/);
 assert.doesNotMatch(text,/Return as|coming soon|research only|for research|research job/i);for(const label of ['No project','Folder','Git URL','Files or ZIP'])assert.ok(text.includes(label),label);assert.match(withoutMaskMarkers(html),/<fieldset class="source-choices"/);assert.match(html,/type="radio"/);
 assert.doesNotMatch(html,/id="cmp-folder"|id="cmp-verify"/);
});

test('lender source copy names no project without invented files',()=>{
 assert.equal(sourceSummary({kind:'none'}),'No project · prompt only');
 assert.equal(requestVM({source:{kind:'none'}}).source,'No project · prompt only');
});

test('send again keeps no-project source and automatic result with a fresh identity and no stale folder',()=>{
 const next=newDraftFromJob({sourceKind:'none',local:{agent:'codex'}},{prompt:'Explain it',path:'/stale/project'});
 assert.equal(next.sourceKind,'none');assert.equal(next.path,'');assert.equal(Object.hasOwn(next,'resultKind'),false);assert.equal(next.prompt,'Explain it');
 assert.equal(draftBody(next,'c').repo,undefined);assert.deepEqual(draftBody(next,'c').result,{kind:'message'});
 const code=newDraftFromJob({},{path:'/code'});assert.equal(code.sourceKind,'folder');assert.equal(Object.hasOwn(code,'resultKind'),false);assert.equal(code.path,'/code');
});

test('valid no-project Send is active; a blocked send gives its reason even after a folder refusal',()=>{
 const vm=composeVM({prompt:draft.prompt,sourceKind:'none',repo:{status:'refused'},circle:{id:'c',state:{networked:true,host:{reachable:true}}}});
 const html=renderFixture(ComposeBody,{draft,vm});
 // Only the Send button itself: the disabled model and effort selects above it are not Send.
 assert.equal(vm.send.disabled,false);assert.doesNotMatch(html,/<button(?:(?!<\/button>)[^])*aria-disabled="true"(?:(?!<\/button>)[^])*Send<\/button>/);
 const blocked=renderFixture(ComposeBody,{draft,vm:{...vm,folderError:'stale folder error',send:{label:'Send',disabled:true,why:'Send is off until the host answers.'}}});
 assert.match(renderedText(blocked),/Send is off until the host answers/);
});
