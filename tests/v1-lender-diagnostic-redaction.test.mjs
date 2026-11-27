import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDiagnosticLog,diagnosticSource} from '../lib/v1/diagnostic-log.mjs';

const withheld='[private details withheld]';
const alphabet='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const values=[
  ['GitHub classic','gh'+'p_'+alphabet.slice(0,36)],
  ['GitHub fine-grained','github'+'_pat_'+alphabet.repeat(3).slice(0,82)],
  ['Anthropic','sk'+'-ant-api03-'+alphabet.repeat(3).slice(0,95)],
  ['OpenAI','sk'+'-'+alphabet.repeat(2).slice(0,48)],
  ['Docker','dckr'+'_pat_'+alphabet.slice(0,27)],
  ['bearer','Authorization'+': Bearer '+alphabet+'._-synthetic'],
];
// Explicit offline wiring mode, not a substitute for the shared scanner's tests.
const deterministic=process.env.FARAVAN_TEST_DIAGNOSTIC_REDACTOR==='deterministic';
let redactor;
if(deterministic) {
  redactor=({maxTextLength})=>value=>values.some(([,token])=>value.includes(token))
    ? withheld : value.slice(0,maxTextLength);
} else {
  const {createTranscriptRedactor,redactTranscriptText}=await import('../lib/v1/transcript-redaction.mjs');
  redactor=options=>{
    const redact=createTranscriptRedactor(options);
    return value=>redactTranscriptText(value,redact);
  };
}
async function fixture(t,factory=redactor) {
  if(deterministic)t.diagnostic('Injected deterministic redactor: persistence/wiring coverage only.');
  const dir=await mkdtemp(join(tmpdir(),'diagnostic-redaction-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const writes=[],file=join(dir,'lending-errors.jsonl');
  const record=createDiagnosticLog({file,redactor:factory,fs:{
    readFile,rename,writeFile:async(path,bytes,options)=>{
      writes.push(String(bytes));
      return writeFile(path,bytes,options);
    },
  }});
  return {dir,record,writes,file};
}
const entry=message=>({at:'2026-11-07T00:00:00Z',code:'sandbox_start_failed',phase:'prepare',message});
async function absent(f,token) {
  const bytes=await readFile(f.file,'utf8');
  for(const written of [...f.writes,bytes]) {
    assert.equal(written.includes(token),false,'full synthetic value must not reach disk');
    assert.equal(written.includes(token.slice(0,10)),false,'synthetic value prefix must not reach disk');
  }
  return bytes.trim().split('\n').map(line=>JSON.parse(line));
}
for(const [name,token] of values)test('diagnostic writer redacts '+name,async t=>{
  const f=await fixture(t);
  await f.record(entry('Child failed: '+token));
  const rows=await absent(f,token);
  assert.equal(rows[0].code,'sandbox_start_failed');
  assert.equal(rows[0].phase,'prepare');
  assert.equal(rows[0].message,withheld);
});
test('scan precedes the old 2000-character cut',async t=>{
  const f=await fixture(t),token=values[0][1];
  await f.record(entry('x'.repeat(1990)+token));
  const rows=await absent(f,token);
  assert.equal(rows[0].message,withheld);
  await f.record(entry('safe '.repeat(600)));
  assert.equal(JSON.parse((await readFile(f.file,'utf8')).trim().split('\n').at(-1)).message.length,2000);
});
test('retained historical rows are reprojected, unknown nested details disappear',async t=>{
  const f=await fixture(t),token=values[1][1];
  await writeFile(f.file,JSON.stringify({...entry('old '+token),details:{unknown:{raw:token}},extra:token})+'\n');
  await f.record({...entry('new safe message'),details:{stage:'prepare',attemptId:'synthetic-attempt',unknown:{raw:token}},
    elapsed_ms:Infinity,absent_ms:-1,unknown:{raw:token}});
  const rows=await absent(f,token);
  assert.equal(rows.length,2);
  assert.equal(rows[0].message,withheld);
  assert.equal(rows[0].extra,undefined);
  assert.equal(rows[0].details?.unknown,undefined);
  assert.deepEqual(rows[1].details,{stage:'prepare',attemptId:'synthetic-attempt'});
  assert.equal(rows[1].elapsed_ms,undefined);
  assert.equal(rows[1].absent_ms,undefined);
  assert.equal(rows[1].unknown,undefined);
});
test('safe copy, metadata, 50-row cap and private mode survive',async t=>{
  const f=await fixture(t);
  for(let i=0;i<52;i++)await f.record({...entry('Safe child failure '+i),attemptId:'synthetic-attempt',elapsed_ms:12,absent_ms:0});
  await f.record.flush();
  const rows=(await readFile(f.file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.length,50);
  assert.equal(rows[0].message,'Safe child failure 2');
  assert.equal(rows.at(-1).message,'Safe child failure 51');
  assert.equal(rows.at(-1).attemptId,'synthetic-attempt');
  assert.equal(rows.at(-1).elapsed_ms,12);
  assert.equal(rows.at(-1).absent_ms,0);
  assert.equal((await stat(f.file)).mode&0o777,0o600);
});
test('redactor initialization or execution failure withholds message',async t=>{
  for(const factory of [()=>{throw new Error('unavailable');},()=>()=>{throw new Error('unavailable');},()=>()=>undefined]) {
    const f=await fixture(t,factory);
    await f.record(entry('Do not retain this text'));
    assert.equal(JSON.parse((await readFile(f.file,'utf8')).trim()).message,withheld);
    assert.ok(f.writes.every(bytes=>!bytes.includes('Do not retain this text')));
  }
});
// Docker PATs, Bearer header values and tokens glued to word characters, before and after the 2000-character cut.
const bodyCases=[
  ['Docker PAT','dckr'+'_pat_','AbCdEfGhIjKlMnOpQrStUvWxYz0'],
  ['Bearer value','Authorization'+': Bearer ','ordinary'+alphabet],
  ['glued GitHub token','gh'+'p_',alphabet],
  ['glued OpenAI project key','sk'+'-proj-',alphabet.repeat(2)],
  ['glued Anthropic api03 key','sk'+'-ant-api03-',alphabet.repeat(2)],
  ['glued Anthropic oat01 token','sk'+'-ant-oat01-',alphabet.repeat(2)],
];
for(const [name,lead,body] of bodyCases)for(const pad of [0,1790,1990])
  test('no part of a '+name+' survives, glued after '+pad+' characters',{skip:deterministic},async t=>{
    const token=lead+body,message='x'.repeat(pad)+token;
    const f=await fixture(t);
    await f.record(entry(message));
    const {createTranscriptRedactor,redactTranscriptText}=await import('../lib/v1/transcript-redaction.mjs');
    const outputs=[redactTranscriptText(message,createTranscriptRedactor({maxTextLength:2000})),
      ...f.writes,await readFile(f.file,'utf8')];
    for(const out of outputs) {
      assert.equal(out.includes(token),false);
      for(let i=0;i+8<=body.length;i++)assert.equal(out.includes(body.slice(i,i+8)),false,'body fragment leaked');
    }
    assert.equal(JSON.parse(outputs.at(-1).trim().split('\n').at(-1)).message,withheld);
  });

test('diagnostic source excludes messages, external paths and malformed locations',async t=>{
  const file=new URL('../lib/v1/client.mjs',import.meta.url);
  assert.equal(diagnosticSource({stack:'Error: private ('+file.href+':1:2)'}),null);
  assert.equal(diagnosticSource({stack:'Error: private\n    at private (/home/ana/lib/private.mjs:1:2)'}),null);
  assert.equal(diagnosticSource({stack:'Error: private\n    at read ('+file.pathname+':12:34)'}),'lib/v1/client.mjs:12');
  assert.equal(diagnosticSource({stack:'Error: private\n    at read ('+file.href+':12:34)'}),'lib/v1/client.mjs:12');
  const f=await fixture(t);
  for(const source of ['lib/v1/client.mjs:12','/home/ana/lib/client.mjs:12','lib/../secret.mjs:12','lib/v1/client.mjs:12 private message'])
    await f.record({...entry('Safe'),source});
  const rows=(await readFile(f.file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].source,'lib/v1/client.mjs:12');
  assert.ok(rows.slice(1).every(row=>!Object.hasOwn(row,'source')));
  assert.doesNotMatch(JSON.stringify(rows),/\/home\/|private message/);
});
