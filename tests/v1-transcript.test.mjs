import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptBuffer } from '../lib/v1/transcript.mjs';

const normal = Array.from({length:30}, (_, i) => JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`entry ${i}: `+'x'.repeat(2000)}]}})+'\n').join('');
const data = 'A'.repeat(212 * 1024);
const image = JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:[{type:'image',source:{type:'base64',media_type:'image/png',data}}]}]}})+'\n';
const entries = text => text.trimEnd().split('\n').map(line => JSON.parse(line));

test('30 normal lines survive a 212KB image tool result, even across chunks', () => {
  const transcript = createTranscriptBuffer();
  transcript.append(normal);
  for (let i=0; i<image.length; i+=7000) transcript.append(image.slice(i,i+7000));
  const view = transcript.snapshot(), rows = entries(view.text);
  assert.equal(rows.length,31);
  assert.equal(view.truncated,false);
  assert.equal(view.text.slice(0,normal.length),normal);
  assert.deepEqual(rows[30].message.content[0].content[0],{type:'image',omitted:true,media_type:'image/png',bytes:data.length});
});

test('base64 documents and Codex data URLs are omitted recursively', () => {
  const transcript = createTranscriptBuffer();
  transcript.append(JSON.stringify({content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data}},
    {type:'input_image',image_url:'data:image/jpeg;base64,'+data},
    {type:'input_file',file_data:'data:application/pdf;base64,'+data}]})+'\n');
  assert.deepEqual(entries(transcript.snapshot().text)[0].content,[
    {type:'document',omitted:true,media_type:'application/pdf',bytes:data.length},
    {type:'input_image',omitted:true,media_type:'image/jpeg',bytes:data.length},
    {type:'input_file',omitted:true,media_type:'application/pdf',bytes:data.length},
  ]);
});

for (const line of ['prefix '+'x'.repeat(100*1024),JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'head '+'😀\\"'.repeat(30000)}]}})]) {
  test('an oversized text line keeps its head and marker as JSON within 16KB', () => {
    const transcript = createTranscriptBuffer();
    transcript.append(line+'\n');
    const view = transcript.snapshot(), row = entries(view.text)[0];
    assert.ok(Buffer.byteLength(view.text)<=16*1024);
    assert.equal(row.truncated,true);
    assert.ok(row.message.content[0].text.startsWith(line.slice(0,20)));
    assert.match(row.message.content[0].text,/\[transcript line truncated\]$/);
    assert.equal(view.truncated,true);
  });
}

test('ordinary lines are byte-for-byte unchanged, including final unterminated output', () => {
  const transcript = createTranscriptBuffer();
  const text = ' { "type": "assistant", "text": "hello" }\r\nplain output\n{"done":true}';
  transcript.append(text);
  assert.deepEqual(transcript.snapshot(),{text,truncated:false});
});

test('stdout and stderr fragments cannot splice each other into invalid JSON', () => {
  const transcript = createTranscriptBuffer();
  transcript.append('{"out":','stdout');
  transcript.append('{"err":1}\n','stderr');
  transcript.append('2}\n','stdout');
  assert.deepEqual(entries(transcript.snapshot().text),[{err:1},{out:2}]);
});

test('the 256KB tail drops whole lines and stays within its byte limit', () => {
  const transcript = createTranscriptBuffer();
  for(let i=0;i<200;i++)transcript.append(JSON.stringify({i,text:'é'.repeat(2000)})+'\n');
  const view=transcript.snapshot(), rows=entries(view.text);
  assert.ok(Buffer.byteLength(view.text)<=256*1024);
  assert.ok(rows[0].i>0);
  assert.equal(rows.at(-1).i,199);
  assert.equal(view.truncated,true);
});
