import test from 'node:test';
import assert from 'node:assert/strict';
import {draftBody,loadDraft,saveDraft} from './compose-draft.mjs';
import {sourceReady,sourceSummary,validateUploadSelection} from './source-choice.mjs';
import {SourceChoice,SourceManifest} from './source-choice.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const draft={id:'draft-source-123',prompt:'Research this',path:'/work',sourceKind:'none'};
test('no-project sends explicit noSource; other sources send only the selected input',()=>{
 assert.deepEqual(draftBody(draft,'circle'),{circle:'circle',prompt:'Research this',draft_id:draft.id,noSource:true,result:{kind:'message'}});
 assert.deepEqual(draftBody({...draft,sourceKind:'git',gitUrl:'https://example.test/a',gitCommit:'a'.repeat(40)},'circle').git,{url:'https://example.test/a',commit:'a'.repeat(40)});
 assert.equal(draftBody({...draft,sourceKind:'files',files:[{path:'note.txt',base64:'eA=='}]},'circle').repo,undefined);
 assert.equal(draftBody({...draft,sourceKind:'files',zip:{name:'source.zip',base64:'eA=='}},'circle').zip.name,'source.zip');
});
test('source readiness never trusts an unresolved repository or unselected upload',()=>{
 assert.equal(sourceReady(draft,{status:'idle'}),true);
 assert.equal(sourceReady({...draft,sourceKind:'git',gitUrl:'x'}, {status:'idle'}),false);
 assert.equal(sourceReady({...draft,sourceKind:'files',files:[]},{status:'ok'}),false);
 assert.equal(sourceReady({...draft,sourceKind:'git',gitUrl:'https://example.test/a',gitCommit:'a'.repeat(40)},{status:'ok'}),true);
});
test('upload selection checks total bytes and entry count before reading files',()=>{
 assert.throws(()=>validateUploadSelection([{name:'a',size:21*1024*1024}]),/20 MB/);
 assert.throws(()=>validateUploadSelection(Array.from({length:1001},()=>({name:'a',size:0}))),/1,000/);
 assert.throws(()=>validateUploadSelection([{name:'a.zip',size:1},{name:'a.txt',size:1}]),/ZIP/);
});
test('all four sources are labelled controls and receipt says what was actually checked',()=>{
 const text=renderedText(renderFixture(SourceChoice,{draft,locked:false,onKind(){}}));
 for(const label of ['No project','Folder','Git URL','Files or ZIP'])assert.ok(text.includes(label),label);
 const manifest={file_count:2,total_bytes:12,packed_bytes:100,archive_digest:'sha256:'+'a'.repeat(64),not_sent:[{path:'.env',reason:'credentials'}],not_sent_count:1,check:'filename-rules-only'};
 const out=renderedText(renderFixture(SourceManifest,{manifest}));
 assert.match(out,/2 files/);assert.match(out,/1 file not sent/);assert.match(out,/filename rules/i);assert.doesNotMatch(out,/safe to send/i);
});
test('selected source and pinned commit survive a draft reload',()=>{
 const map=new Map(),s={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};
 saveDraft(s,'c',{...draft,sourceKind:'git',gitUrl:'https://example.test/a',gitCommit:'a'.repeat(40),gitBranch:'main',workingDirectory:'packages/app'});
 const loaded=loadDraft(s,'c');assert.equal(loaded.sourceKind,'git');assert.equal(loaded.gitCommit,'a'.repeat(40));assert.equal(loaded.workingDirectory,'packages/app');
 assert.equal(sourceSummary(draft),'No project files. Only your request is sent.');
});

test('privacy N1: shared omission counts render alongside legacy local path receipts',()=>{
 const manifest={file_count:1,total_bytes:12,not_sent_count:3,not_sent:[{reason:'credentials',count:2},{reason:'not_source',count:1,kind:'directory'}]};
 const out=renderedText(renderFixture(SourceManifest,{manifest}));
 assert.match(out,/3 items not sent/);assert.match(out,/2 files — looked like credentials/);
 assert.match(out,/1 folder — not source/);assert.doesNotMatch(out,/undefined|Showing 2 of 3/);
 const legacy=renderedText(renderFixture(SourceManifest,{manifest:{...manifest,not_sent_count:1,not_sent:[{path:'.env',reason:'credentials'}]}}));
 assert.match(legacy,/\.env/);assert.match(legacy,/looked like credentials/);
});

test('working directory is explicit, persisted and omitted for projectless jobs',()=>{
 const d={...draft,sourceKind:'folder',workingDirectory:' packages/app '};assert.equal(draftBody(d,'c').working_directory,'packages/app');
 assert.equal(draftBody({...d,sourceKind:'none'},'c').working_directory,undefined);
});

test('large attachment bytes never consume the small localStorage draft quota',()=>{
 const map=new Map(),s={getItem:k=>map.get(k),setItem:(k,v)=>{assert.ok(v.length<4096);map.set(k,v);}};
 saveDraft(s,'c',{...draft,sourceKind:'files',attachmentId:'upload-123',files:[{path:'large.txt',base64:'a'.repeat(1024*1024)}]});
 const back=loadDraft(s,'c');assert.equal(back.attachmentId,'upload-123');assert.deepEqual(back.files,[]);assert.equal(back.prompt,'Research this');
});
