import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceTranscript} from '../lib/v1/workspace-transcript.mjs';
import {jobOutputWarningVM} from '../ui/v1/src/view-models.mjs';
const scratch='/home/private/lender-scratch/abc';
const raw=JSON.stringify({type:'assistant',message:'Saved '+scratch+'/repo/faravan-output/chart.png'});
test('every streaming split and final transcript uses the same logical workspace',()=>{
  for(let at=0;at<=raw.length;at++){
    const redactor=workspaceTranscript(scratch);
    const streamed=redactor.append('stdout',raw.slice(0,at))+redactor.append('stdout',raw.slice(at))+redactor.end('stdout');
    assert.equal(streamed,redactor.text(raw));assert.equal(streamed.includes(scratch),false);
    assert.equal(jobOutputWarningVM(JSON.parse(streamed).message,redactor.text(scratch+'/repo')),'');
  }
});
test('stdout and stderr fragments never assemble into each other',()=>{
  const redactor=workspaceTranscript(scratch);
  assert.equal(redactor.append('stdout',scratch.slice(0,10)),'');
  assert.equal(redactor.append('stderr','normal log\n'),'normal log\n');
  assert.equal(redactor.append('stdout',scratch.slice(10)),'');
  assert.equal(redactor.end('stdout'),'/workspace');
});

test('every split redacts lender emails, credentials and known values before streaming or upload',()=>{
  const secrets=['lender@example.test','sk-ant-api03-'+ 'a'.repeat(50),'opaque-known-lender-value'];
  const input=JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Contact '+secrets[0]},{type:'tool_result',content:secrets[1]+' '+secrets[2]}]}})+'\n';
  for(let at=0;at<=input.length;at++){
    const redactor=workspaceTranscript(scratch,{privateValues:[secrets[2]]});
    const chunks=[redactor.append('stdout',input.slice(0,at)),redactor.append('stdout',input.slice(at)),redactor.end('stdout')];
    for(const secret of secrets)assert.equal(chunks.some(chunk=>chunk.includes(secret)),false,'no output chunk discloses private data');
    const uploaded=redactor.text(input);
    for(const secret of secrets)assert.equal(uploaded.includes(secret),false);
    assert.deepEqual(JSON.parse(chunks.join('')),JSON.parse(uploaded));
  }
});

test('oversized media remains a valid omitted-image provider record',()=>{
  const data='A'.repeat(212*1024),input=JSON.stringify({type:'user',message:{content:[{type:'image',source:{type:'base64',media_type:'image/png',data}}]}})+'\n';
  const redactor=workspaceTranscript(scratch,{privateValues:[]});let streamed='';
  for(let i=0;i<input.length;i+=7000)streamed+=redactor.append('stdout',input.slice(i,i+7000));
  streamed+=redactor.end('stdout');
  const row=JSON.parse(streamed);
  assert.deepEqual(row.message.content[0],{type:'image',omitted:true,media_type:'image/png',bytes:data.length});
  assert.equal(streamed,redactor.text(input));
});

test('multi-kilobyte safe prose and code listings preserve their native records',()=>{
  const w=workspaceTranscript(scratch,{privateValues:[],home:'/synthetic/home'});
  for(const text of ['Ordinary progress. '.repeat(330),Array.from({length:250},(_,i)=>`const line${i} = ${i};`).join('\n')]){
    const input=JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}})+'\n';
    assert.equal(w.text(input),input);assert.equal(w.append('stdout',input)+w.end('stdout'),input);
  }
});


test('unparsed and prefixed lines cannot bypass redaction with encoded private text',()=>{
  const redactor=workspaceTranscript(scratch,{privateValues:['opaque-private-value'],home:'/synthetic/home'});
  for(const input of ['bob@example.com','prefix: bob%40example.com','prefix: bob&#64;example.com','prefix: bob&#x40;example.com',
    'prefix: bob\\u0040example.com','prefix: opaque%2dprivate-value','prefix: bob%2540example.com']) {
    const output=redactor.text(input);
    assert.equal(output.includes('bob'),false,input);
    assert.equal(output.includes('opaque'),false,input);
    for(let at=0;at<=input.length;at++){
      const stream=workspaceTranscript(scratch,{privateValues:['opaque-private-value'],home:'/synthetic/home'});
      assert.equal(stream.append('stdout',input.slice(0,at))+stream.append('stdout',input.slice(at))+stream.end('stdout'),output);
    }
  }
  assert.equal(redactor.text('Tests passed at 100%.'),'Tests passed at 100%.');
});

test('parsed strings and UTF-8 percent forms use the same private-text decoder',()=>{
  const w=workspaceTranscript(scratch,{privateValues:['opaque-κ-private'],home:'/synthetic/home'});
  for(const input of ['prefix: opaque-%CE%BA-private',JSON.stringify({type:'result',result:'bob%40example.com'}),JSON.stringify({type:'result',result:'opaque-%CE%BA-private'})])
    assert.doesNotMatch(w.text(input),/bob|opaque|%CE/i);
});

test('signed records project safe fields and redact numeric or boolean private values',()=>{
  const redactor=workspaceTranscript(scratch,{privateValues:['42817','true'],home:'/synthetic/home'});
  for(const input of ['42817','true',JSON.stringify({type:'result',result:42817,is_error:true}),JSON.stringify({type:'assistant',session_id:'raw-correlation',debug:42817,message:{content:[{type:'text',text:'Safe progress'},{type:'tool_result',tool_use_id:'raw-correlation',content:'raw tool output'}]}})]) {
    const output=redactor.text(input);
    assert.doesNotMatch(output,/42817|raw-correlation|raw tool output|"is_error":true/);
    assert.doesNotThrow(()=>JSON.parse(output));
  }
  assert.equal(JSON.parse(redactor.text(JSON.stringify({type:'result',result:'Safe progress',private_metadata:'arbitrary field'}))).private_metadata,undefined);
});

test('unavailable scanning withholds entire outbound records including metadata and scalars',()=>{
  const redactor=workspaceTranscript(scratch,{privateValues:['42817'],scanUnavailable:true});
  for(const input of ['42817','true','null',JSON.stringify({type:'result',result:'safe',is_error:false,usage:42817})]) {
    const output=redactor.text(input),record=JSON.parse(output);
    assert.doesNotMatch(output,/42817|"is_error"|"usage"/);
    assert.equal(record.type,'transcript.withheld');assert.equal(record.omitted,true);assert.equal(record.message,undefined);
  }
});
