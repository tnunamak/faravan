import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewFiles, reviewKey, reviewCoverage, reviewNotePrompt} from './result-review.mjs';
const data={diff:'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n',files:[{path:'src/a.js',hash:'a',status:'modified',insertions:1,deletions:1},{path:'package-lock.json',hash:'b',status:'modified'}],bytes:150,shown_bytes:100,total_lines:10};
test('files group by directory and noisy files are collapsed, never viewed automatically',()=>{
 const files=reviewFiles(data); assert.equal(files[0].directory,'src');assert.equal(files[1].generated,true);assert.equal(files[0].rows.at(-1).next,1);
});
test('review identity binds circle, result and file bytes',()=>{
 assert.notEqual(reviewKey('a','r',data.files[0]),reviewKey('b','r',data.files[0]));assert.notEqual(reviewKey('a','r',data.files[0]),reviewKey('a','s',data.files[0]));assert.notEqual(reviewKey('a','r',data.files[0]),reviewKey('a','r',{...data.files[0],hash:'changed'}));
});
test('coverage names the exact rendered lines and available bytes',()=>{
 assert.match(reviewCoverage(data),/6 of 10 diff lines/);assert.match(reviewCoverage(data),/100 of 150 bytes/);
});
test('line notes become bounded anchored follow-up context',()=>{
 assert.equal(reviewNotePrompt([{path:'src/a.js',side:'new',line:1,text:'Please handle null.'}]),'Please make these changes:\n\n- src/a.js (new line 1): Please handle null.');
});

test('unavailable review storage is reported and malformed notes are ignored',async()=>{
 const {readReview,writeReview}=await import('./result-review.mjs');
 assert.equal(writeReview(null,'key',{}),false);
 assert.deepEqual(readReview({getItem:()=>JSON.stringify({notes:[null,{line:2,text:'ok',side:'new'},{line:2,text:'bad',side:'other'}]})},'key').notes,[{line:2,text:'ok',side:'new'}]);
});

test('split view pairs a removed block with its replacement and preserves context line numbers',async()=>{
 const {splitRows}=await import('./result-review.mjs');
 const old={kind:'del',old:1,next:'',text:'-old'},a={kind:'add',old:'',next:1,text:'+new'},b={kind:'add',old:'',next:2,text:'+extra'},context={kind:'ctx',old:2,next:3,text:' ok'};
 assert.deepEqual(splitRows([old,a,b,context]),[{old,new:a},{old:null,new:b},{old:context,new:context}]);
});

test('syntax tokens remain plain text and unknown file types stay unstyled',async()=>{
 const {syntaxParts}=await import('./result-review.mjs');
 const line='+const greeting = "<script>"; // greet';const parts=syntaxParts(line,'src/greeting.js');
 assert.equal(parts.map(p=>p.text).join(''),line);assert.ok(parts.some(p=>p.kind==='keyword'));assert.ok(parts.some(p=>p.kind==='string'));
 assert.deepEqual(syntaxParts(line,'README.md'),[{text:line}]);
});

test('a legacy truncated preview never claims its loaded lines are the complete total',()=>{
 const line=reviewCoverage({diff:'partial\n',truncated:true});
 assert.match(line,/total not recorded/);assert.doesNotMatch(line,/1 of 1/);
});
test('follow-up includes notes across all files without silently dropping the fifty-first',()=>{
 const notes=Array.from({length:51},(_,index)=>({path:`src/file-${index}.js`,side:'new',line:1,text:`Change ${index}`}));
 const prompt=reviewNotePrompt(notes);assert.match(prompt,/file-50\.js \(new line 1\): Change 50/);
});
