import test from 'node:test';
import assert from 'node:assert/strict';
import {jobVM} from './view-models.mjs';
import {ResultReader,Markdown} from './result-reader.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
test('report reader renders headings, lists, code, tables, sources and copy/download',()=>{
 const data={format:'message',message:{markdown:'# Findings\n\nA **clear** result.\n\n- One\n- Two\n\n```js\nconst a = 1;\n```\n\n| Topic | Choice |\n| --- | --- |\n| Water | Rain |\n\n[Source](https://example.com)'},files:[{path:'faravan-output/report.md',bytes:32,url:'/api/jobs/x/file?path=faravan-output%2Freport.md',text:'# Findings'}]};
 const html=renderFixture(ResultReader,{data,api:{}});
 assert.match(html,/<h3>Findings<\/h3>/);assert.match(html,/<strong>clear<\/strong>/);assert.match(html,/<li><p>One<\/p><\/li>/);
 assert.match(html,/<table/);assert.match(html,/<code>const a = 1;/);assert.match(html,/href="https:\/\/example.com"/);
 assert.match(renderedText(html),/Copy message/);assert.match(renderedText(html),/Download Markdown/);assert.match(renderedText(html),/Files/);
});
test('untrusted Markdown remains inert; scripts, active links, remote images and raw HTML never execute',()=>{
 const markdown='<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[evil](javascript:alert%281%29) ![track](https://tracker.test/pixel)';
 const html=renderFixture(ResultReader,{data:{format:'message',message:{markdown},files:[]}});
 assert.doesNotMatch(html,/<script|<img|href="javascript:/);
 assert.match(html,/&lt;script>/);
});
test('files result shows inert text preview and missing report explains what returned',()=>{
 const html=renderFixture(ResultReader,{data:{format:'files',files:[{path:'faravan-output/data.csv',bytes:7,text:'a,b\n1,2',url:'/file'}]}});
 assert.match(renderedText(html),/data.csv/);assert.match(html,/<pre/);
});

test('Markdown tables keep words intact inside a focused scroll surface and code keeps whitespace',()=>{
 const html=renderFixture(ResultReader,{data:{message:{markdown:'| Word | Value |\n| --- | --- |\n| streaming | 120 kB |\n\n```text\n  +---+\n  | x |\n  +---+\n```'},files:[]}});
 assert.match(html,/<div class="result-table" tabindex="0"[^>]*><table>/);
 assert.match(html,/<pre tabindex="0"><code>  \+---\+/);
});

test('a delivered report is ready even without a diffstat, including an empty output set',()=>{
 for(const kind of ['message','files']){
  const vm=jobVM({state:'result-accepted',format:kind,files:[]},'sent');
  assert.equal(vm.resultPending,false);assert.equal(vm.noChanges,false);assert.equal(vm.word,'Ready to review');
 }
});

test('returned-output run details show facts and one quiet missing line with specifics collapsed',async()=>{
 const {howItRanVM}=await import('./view-models.mjs');
 const {HowItRan}=await import('./job-view.jsx');
 const ran=howItRanVM({receipt:{harness:'claude-code-subscription'}},{compact:true});
 assert.equal(ran.lines.length,1);assert.match(ran.lines[0].text,/Claude Code/);
 assert.equal(ran.missing,"Some run details weren't recorded.");assert.ok(ran.details.length>=3);
 const html=renderFixture(HowItRan,{...ran});
 assert.match(html,/<details/);assert.match(html,/<summary>Details<\/summary>/);
 assert.match(html,/Some run details weren&#39;t recorded|Some run details weren't recorded/);
});

test('compact run facts retain known network rules when the network observation is missing',async()=>{
 const {howItRanVM}=await import('./view-models.mjs');
 const ran=howItRanVM({receipt:{harness:'claude-code-subscription',egress_applied:'internet'}},{compact:true});
 assert.ok(ran.lines.some(line=>line.text==='The rules allowed: public websites.'));
 assert.ok(ran.details.some(line=>line.text.includes('network log couldn’t be read')));
});

test('download-only attachments cannot hide a message or claim no files were returned',()=>{
 const html=renderFixture(ResultReader,{data:{format:'message',message:{markdown:'# Answer'},files:[],download_only:true,warning:'Files exceed the preview limits.'},api:{}});
 assert.match(renderedText(html),/Answer/);assert.match(renderedText(html),/Files are available in the download/);
 assert.doesNotMatch(renderedText(html),/No output files came back/);
});
test('the embedded reader leaves Copy message to the page primary',()=>{
 const out=renderFixture(ResultReader,{data:{message:{markdown:'# Answer',url:'/message'},files:[]},api:{},showCopy:false});
 assert.doesNotMatch(renderedText(out),/Copy message/);assert.match(renderedText(out),/Download Markdown/);
});

test('agent poems preserve soft line breaks and omit empty Files sections',()=>{
 const out=renderFixture(ResultReader,{data:{message:{markdown:'On the pier,\nA gull waits.\nNo chips today.'},files:[]}});
 assert.match(out,/On the pier,<br\s*\/>A gull waits\.<br\s*\/>No chips today\./);
 assert.doesNotMatch(renderedText(out),/Files|No output files/);
});
test('output attachment labels omit the transport folder and use human sizes',()=>{
 const out=renderFixture(ResultReader,{data:{files:[{path:'faravan-output/mandelbrot.png',bytes:27144,preview:{url:'/image'}}]},api:{}});
 assert.match(renderedText(out),/mandelbrot.png/);assert.match(renderedText(out),/27 KB/);
 assert.doesNotMatch(renderedText(out),/faravan-output|27,144|Show image preview/);
 assert.match(out,/Loading image preview/);
});

test('the result page can collect all message actions in its rail',()=>{
 const out=renderFixture(ResultReader,{data:{message:{markdown:'# Answer',url:'/message'},files:[]},api:{},showActions:false});
 assert.doesNotMatch(renderedText(out),/Copy message|Download Markdown/);
 assert.match(renderedText(out),/Answer/);
});

test('unlisted files do not promise a download when the result rail cannot offer one',()=>{
 for(const files of [[],[{path:'one.txt',bytes:1,url:'/one'}]]) {
  const out=renderFixture(ResultReader,{data:{format:'files',files,more_files:3,download_only:false},api:{}});
  assert.match(renderedText(out),/3 additional files are not available to download here/);
  assert.doesNotMatch(renderedText(out),/more files are included in the download/);
 }
 const out=renderFixture(ResultReader,{data:{format:'files',files:[],more_files:3,download_only:true},api:{}});
 assert.match(renderedText(out),/3 more files are included in the download/);
});

test('task lists retain noninteractive completion indicators and inert content',()=>{
 const html=renderFixture(ResultReader,{data:{message:{markdown:'- [x] **Tests passed**\n- [ ] Deploy ![remote](https://tracker.test/pixel)\n- Ordinary'}}});
 assert.match(html, /role="img" aria-label="Completed task">☑/);
 assert.match(html, /role="img" aria-label="Incomplete task">☐/);
 assert.equal((html.match(/role="img"/g)||[]).length,2);
 assert.match(html, /<strong>Tests passed<\/strong>/);
 assert.match(html, /<li><p>Ordinary<\/p><\/li>/);
 assert.doesNotMatch(html, /<input|<img|src="https:/);
});

test('agent Markdown stays below page and section headings without losing heading text',()=>{
 const html=renderFixture(Markdown,{text:'# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six'});
 for(const text of ['One','Two','Three']) assert.match(html,new RegExp('<h3>'+text+'<\\/h3>'));
 for(const text of ['Four','Six']) assert.match(html,new RegExp('<h4>'+text+'<\\/h4>'));
 assert.doesNotMatch(html,/<h[1256](?:>| )/);
});
test('delivered file labels break after slashes and retain escaped path text',()=>{
 const html=renderFixture(ResultReader,{data:{files:[{path:'faravan-output/long/path/report<&>.txt',bytes:2}]}});
 assert.match(html,/<code>long\/<wbr\s*\/>path\/<wbr\s*\/>report&lt;&amp;>\.txt<wbr\s*\/><\/code>/);
 assert.doesNotMatch(html,/faravan-output\//);
});
