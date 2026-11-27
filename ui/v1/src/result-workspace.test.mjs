import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ResultWorkspace} from './result-workspace.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
const data={format:'diff',diff:'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',files:[{path:'src/a.js',status:'modified'},{path:'package-lock.json',status:'modified'}],diffstat:{files:2,insertions:1,deletions:1},total_lines:12,shown_bytes:92,bytes:240,truncated:true};
test('review tree groups paths and lockfiles start collapsed with explicit counts',()=>{
 const html=renderFixture(ResultWorkspace,{data});const text=renderedText(html);
 assert.match(html,/nav[^>]+aria-label="Changed files"/);assert.match(text,/Project root/);assert.match(html,/aria-label="Expand package-lock.json"[^>]+aria-expanded="false"/);assert.match(html,/id="diff-content-1" hidden/);
 assert.match(text,/0 of 2 viewed/);assert.match(text,/6 of 12 diff lines/);assert.match(text,/92 of 240 bytes/);
});
test('borrower line notes are available only when follow-up is supported',()=>{
 const staticHtml=renderFixture(ResultWorkspace,{data});
 assert.doesNotMatch(staticHtml,/Add note on/);
 assert.match(withoutMaskMarkers(staticHtml),/class="line-number"><span class="sr">Old line <\/span>1<\/span>/);
 assert.match(withoutMaskMarkers(staticHtml),/class="line-number"><span class="sr">New line <\/span>1<\/span>/);
 assert.doesNotMatch(withoutMaskMarkers(staticHtml),/class="line-number" aria-label=/);
 const html=renderFixture(ResultWorkspace,{data,onAskChanges:()=>{}});assert.match(html,/Add note on src\/a.js new line 1/);assert.match(html,/Add note on src\/a.js old line 1/);
});

test('file controls share one header and every file has a collapse control',()=>{
 const html=renderFixture(ResultWorkspace,{data,onAskChanges:()=>{}});
 assert.equal((html.match(/class="job-file-head"/g)||[]).length,2);
 assert.doesNotMatch(html,/review-file-tools/);
 for(const path of ['src/a.js','package-lock.json']) {
  assert.ok(html.includes('Copy path for '+path));
  assert.ok(html.includes('aria-controls="diff-content-'+(path==='src/a.js'?0:1)+'"'));
 }
 const heads=[...html.matchAll(/<div class="job-file-head">([\s\S]*?)<\/div>/g)].map(match=>match[1]);
 assert.equal(heads.length,2);
 for(const head of heads){assert.match(head,/review-collapse/);assert.match(head,/review-copy/);assert.match(head,/review-viewed/);}
 for(const side of ['old','new']) {
  const button=html.match(new RegExp('<button[^>]*aria-label="Add note on src/a\\.js '+side+' line 1"[^>]*>'))?.[0];
  assert.ok(button,'parser-derived '+side+' line note target remains available');
  assert.match(button,/tabindex="-1"/i);
  assert.ok(button.includes('data-note-side="'+side+'"'));
 }
});

test('blocked changes retain the refusal without claiming the agent made no changes',()=>{
 const html=renderFixture(ResultWorkspace,{data:{files:[],diff:'',diffstat:{files:0},blocked:['../outside']}});
 assert.match(renderedText(html),/write outside the project or create links/);
 assert.doesNotMatch(renderedText(html),/The agent made no changes/);
});
test('unified old and new note gutters share one sticky wrapper',async()=>{
 const html=renderFixture(ResultWorkspace,{data:{...data,diff:data.diff.replace('-a\n+b\n',' a\n')},onAskChanges:()=>{}});
 assert.match(html, /class="review-line-gutters"><button[^>]*data-note-side="old"[\s\S]*?<button[^>]*data-note-side="new"[\s\S]*?<\/span><code>/);
 const {readFile}=await import('node:fs/promises');
 const css=await readFile(new URL('./result-workspace.css',import.meta.url),'utf8');
 assert.match(css,/\.review-line-gutters\{[^}]*position:sticky;left:0/);
 assert.match(css,/\.review-diffs \.review-line-gutters>\.line-number\{position:static/);
});
