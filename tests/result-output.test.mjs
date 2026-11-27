import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resultOutputView,readOutputFile,finalMessage} from '../lib/v1/result-output.mjs';
async function archive(t,files){
 const dir=await mkdtemp(join(tmpdir(),'report-output-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [path,body] of Object.entries(files)){await mkdir(join(dir,path,'..'),{recursive:true});await writeFile(join(dir,path),body);}
 return execFileSync('tar',['-czf','-','.'],{cwd:dir});
}
test('report result returns Markdown, bounded file previews and URLs only from output directory',async t=>{
 const bytes=await archive(t,{'faravan-output/report.md':'# Rain gardens\n\nSources and limits.','faravan-output/data.csv':'a,b\n1,2'});
 const view=resultOutputView({bytes,output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'# Rain gardens\n\nSources and limits.'}),digest:'test',circle:'c'});
 assert.equal(view.format,'message');assert.equal(view.message.markdown,'# Rain gardens\n\nSources and limits.');
 assert.deepEqual(view.files.map(x=>x.path),['faravan-output/data.csv','faravan-output/report.md']);
 assert.equal(view.files[0].text,'a,b\n1,2');assert.match(view.files[0].url,/\/file\?/);
 assert.equal(readOutputFile(bytes,'scratch.txt'),null);assert.equal(readOutputFile(bytes,'../report.md'),null);
 assert.equal(readOutputFile(bytes,'faravan-output/data.csv').bytes.toString(),'a,b\n1,2');
});
test('an answer needs no report file or attachment; missing final text is explicit',async t=>{
 const bytes=await archive(t,{});
 const view=resultOutputView({bytes,output:{kind:'message'},transcript:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'# An answer'}})});
 assert.equal(view.message.markdown,'# An answer');assert.deepEqual(view.files,[]);assert.equal(view.warning,'');
 assert.match(resultOutputView({bytes,output:{kind:'message'}}).warning,/did not include a final message/);
});
test('message preview bounds do not change the full downloadable final text',async t=>{
 const bytes=await archive(t,{}),text='x'.repeat(300000),transcript=JSON.stringify({type:'result',result:text});
 const view=resultOutputView({bytes,output:{kind:'message'},transcript});
 assert.equal(view.message.truncated,true);assert.ok(view.message.markdown.length<=256*1024);assert.equal(finalMessage(transcript),text);
 assert.throws(()=>resultOutputView({bytes:Buffer.from('bad'),output:{kind:'message'}}));
});
test('final text excludes tool output and uses the last assistant result',()=>{
 assert.equal(finalMessage([JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Draft'}]}}),JSON.stringify({type:'user',message:{content:[{type:'tool_result',content:'secret tool output'}]}}),JSON.stringify({type:'result',result:'Final'})].join('\n')),'Final');
});

test('invalid UTF-8 is treated as a file, not expanded into text previews',async t=>{
 const bytes=await archive(t,{'faravan-output/data.bin':Buffer.alloc(100000,255)});
 const view=resultOutputView({bytes,output:{kind:'files'}});
 assert.equal(view.files[0].text,undefined);
});

test('failed result envelopes and interim Codex phases cannot replace a final assistant message',()=>{
 const transcript=[{type:'item.completed',item:{type:'agent_message',text:'Final answer',phase:'final_answer'}},{type:'item.completed',item:{type:'agent_message',text:'Interim notes',phase:'commentary'}},{type:'result',is_error:true,result:'Provider failed'}].map(JSON.stringify).join('\n');
 assert.equal(finalMessage(transcript),'Final answer');
});

test('a compressible file above the preview size cap cannot hide the final message',async t=>{
 const bytes=await archive(t,{'faravan-output/large.csv':Buffer.alloc(20*1024*1024,65)});
 const view=resultOutputView({bytes,output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'# Final answer'})});
 assert.equal(view.message.markdown,'# Final answer');assert.equal(view.files[0].download_only,true);assert.equal(view.files[0].text,undefined);
});
test('preview entry-count limits preserve the answer and offer the original files for download',async t=>{
 const files=Object.fromEntries(Array.from({length:2001},(_,i)=>['faravan-output/file-'+i+'.txt','a']));
 const bytes=await archive(t,files);
 const view=resultOutputView({bytes,output:{kind:'message'},transcript:JSON.stringify({type:'result',result:'Still here'})});
 assert.equal(view.message.markdown,'Still here');assert.equal(view.download_only,true);assert.match(view.warning,/preview|download/i);
});

test('typed whole-result downloads reject files outside the output folder',async t=>{
 const {prepareResultDownload}=await import('../lib/v1/result-download.mjs');
 const bytes=await archive(t,{'faravan-output/visible.txt':'ok','unexpected.js':'bad'});
 await assert.rejects(prepareResultDownload(bytes,{mediaType:'application/gzip',requiredRoot:'faravan-output'}),{code:'path_traversal'});
});
test('a typed result exceeding ZIP file-count limits downloads its validated original archive',async t=>{
 const {prepareResultDownload}=await import('../lib/v1/result-download.mjs');
 const bytes=await archive(t,{'faravan-output/a.txt':'a','faravan-output/b.txt':'b'});
 const download=await prepareResultDownload(bytes,{mediaType:'application/gzip',requiredRoot:'faravan-output',maxFiles:1});
 assert.equal(download.contentType,'application/gzip');assert.match(download.filename,/\.tar\.gz$/);assert.deepEqual(download.bytes,bytes);
});

test('typed output previews reject hidden root entries rather than hiding them',async t=>{
 const bytes=await archive(t,{'faravan-output/visible.txt':'ok','hidden.js':'bad'});
 assert.throws(()=>resultOutputView({bytes,output:{kind:'message'}}),{code:'path_traversal'});
});

test('a typed result never advertises or serves a raster beyond the decoded pixel budget',async t=>{
 const {pngOf}=await import('./helpers/raster-fixtures.mjs');
 const bytes=await archive(t,{'faravan-output/bomb.png':pngOf(12000,12000),'faravan-output/ok.png':pngOf(32,32)});
 const view=resultOutputView({bytes,output:{kind:'message'}});
 assert.equal(view.files.find(f=>f.path.endsWith('bomb.png')).preview,undefined);
 assert.equal(readOutputFile(bytes,'faravan-output/bomb.png').media_type,undefined);
 assert.deepEqual(view.files.find(f=>f.path.endsWith('ok.png')).preview.width,32);
});

test('new Faravan output folder is accepted as primary',async t=>{
 const bytes=await archive(t,{'faravan-output/summary.md':'# Faravan'});
 const view=resultOutputView({bytes,output:{kind:'files'}});
 assert.deepEqual(view.files.map(file=>file.path),['faravan-output/summary.md']);
 assert.equal(readOutputFile(bytes,'faravan-output/summary.md').bytes.toString(),'# Faravan');
});

const malformedFinalRecords = [null, false, 7, 'plain commentary', [], [null],
 {type:'assistant',message:{content:[null, false, 9, 'text', [], {type:'text',text:42}, {type:'tool_use',text:'tool'}]}},
 {type:'assistant',message:null}, {type:'assistant',message:{content:'not blocks'}}];
const jsonLines = records => records.map(record=>JSON.stringify(record)).join('\n');

test('finalMessage skips malformed records before and after every completed provider form',()=>{
 const completed=[
  {type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'Codex final'}},
  {type:'assistant',message:{content:[{type:'text',text:'Claude final'}]}},
  {type:'result',subtype:'success',is_error:false,result:'Result final'},
 ];
 for(const event of completed) {
  const expected=event.item?.text??event.message?.content[0].text??event.result;
  assert.equal(finalMessage(jsonLines([...malformedFinalRecords,event,...malformedFinalRecords])),expected);
 }
 assert.equal(finalMessage(jsonLines(malformedFinalRecords)),'');
});

test('finalMessage preserves text mixed with malformed and nontext Claude blocks',()=>{
 const event={type:'assistant',message:{content:[null,{},[],false,'bad',
  {type:'text',text:'First'}, {type:'tool_use',text:'not an answer'},
  {type:'text',text:null}, {type:'text',text:'Second'}, null]}};
 assert.equal(finalMessage(jsonLines([event])),'First\nSecond');
});

test('last valid final survives malformed records, tools, users, commentary and failed results',()=>{
 const first={type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'Earlier'}};
 const last={type:'result',subtype:'success',result:'Last completed'};
 const excluded=[
  {type:'item.completed',item:{type:'agent_message',phase:'commentary',text:'Interim'}},
  {type:'item.completed',item:{type:'tool_result',text:'Tool'}},
  {type:'user',message:{content:[{type:'text',text:'User'}]}},
  {type:'result',is_error:true,result:'Error'},
  {type:'result',subtype:'error_during_execution',result:'Failure'},
 ];
 assert.equal(finalMessage(jsonLines([first,...malformedFinalRecords,last,...excluded,...malformedFinalRecords])),'Last completed');
 assert.equal(finalMessage(jsonLines(excluded)),'');
});

for(const root of ['faravan-output','faravan-output']) {
 test('mixed transcript preserves typed preview and download boundaries for '+root,async t=>{
  const path=root+'/answer.md',bytes=await archive(t,{[path]:'# File answer'});
  const transcript=jsonLines([...malformedFinalRecords,
   {type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'# Final answer'}},
   ...malformedFinalRecords]);
  const view=resultOutputView({bytes,output:{kind:'message'},transcript,digest:'synthetic',circle:'test'});
  assert.equal(view.format,'message');assert.equal(view.message.markdown,'# Final answer');
  assert.equal(view.warning,'');assert.equal(view.download_only,false);
  assert.deepEqual(view.files.map(file=>file.path),[path]);
  assert.equal(view.files[0].text,'# File answer');
  assert.equal(readOutputFile(bytes,path).bytes.toString(),'# File answer');
  assert.equal(readOutputFile(bytes,'../answer.md'),null);
  assert.throws(()=>resultOutputView({bytes:Buffer.from('not an archive'),output:{kind:'message'},transcript}));
 });
}
