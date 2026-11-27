import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranscriptRedactor} from '../lib/v1/transcript-redaction.mjs';

test('shared relay policy protects known values and explicit secret environment values',t=>{
  const key='FARAVAN_TEST_SESSION_KEY',before=process.env[key];process.env[key]='short-synthetic-value';
  t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});
  const text=createTranscriptRedactor({privateValues:['opaque-synthetic-value'],home:'/private/custom-home'});
  for(const value of ['opaque-synthetic-value','short-synthetic-value','sk-ant-api03-'+ 'a'.repeat(50)])
    assert.equal(text('Provider said '+value),'[private details withheld]');
  for(const value of ['person@example.test','/private/custom-home/project/a'])
    assert.equal(text(value).includes(value),false);
  assert.equal(text('Tests passed.'),'Tests passed.');
  assert.equal(createTranscriptRedactor({scanUnavailable:true})('Provider text'),'[private details withheld]');
});

test('control cleanup cannot reconstruct a secret, account identity or private path',()=>{
  const text=createTranscriptRedactor({privateValues:['opaque-synthetic-value'],home:'/private/custom-home'});
  for(const input of ['opaque-synthetic-\u0000value','session\u0000_id: synthetic-account','/private/custom\u0000-home/project'])
    assert.equal(text(input),'[private details withheld]');
});

test('oversized opaque values fail closed through the shared text redactor',()=>{
  const text=createTranscriptRedactor({privateValues:[],home:'/synthetic/home'});
  assert.equal(text('a'.repeat(60000)),'[private details withheld]');
});

test('author names and auth feature flags do not erase ordinary activity',t=>{
  const saved={GIT_AUTHOR_NAME:process.env.GIT_AUTHOR_NAME,AUTH_ENABLED:process.env.AUTH_ENABLED};
  Object.assign(process.env,{GIT_AUTHOR_NAME:'Tessa',AUTH_ENABLED:'1'});
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const text=createTranscriptRedactor();
  assert.equal(text('Timeout reached'),'Timeout reached');
  assert.equal(text('step 1 of 3'),'step 1 of 3');
});

test('a megabyte of adversarial output leaves the timer responsive',async()=>{
  const {spawnSync}=await import('node:child_process');
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {workspaceTranscript} from './lib/v1/workspace-transcript.mjs';
    import {createTranscriptRedactor} from './lib/v1/transcript-redaction.mjs';
    const redact=workspaceTranscript('/synthetic/workspace',{privateValues:[],home:'/synthetic/home'});
    const start=performance.now();
    const timer=new Promise(resolve=>setTimeout(resolve,10));
    const input=['A'.repeat(512*1024),'a+'.repeat(128*1024)+'@example.test','a@'.repeat(128*1024),'x'.repeat(2000)+'\\n'].join('\\n');
    redact.text(input);
    const scalar=createTranscriptRedactor({privateValues:[],home:'/synthetic/home'});
    for(const line of input.split('\\n'))scalar(line);
    scalar('a+'.repeat(32768)); await timer;
    if(performance.now()-start>=900)process.exitCode=1;
  `],{cwd:new URL('..',import.meta.url),timeout:1800,encoding:'utf8'});
  assert.equal(result.error,undefined,'redaction must finish before the subprocess deadline');
  assert.equal(result.status,0,result.stderr);
});

test('a megabyte of repeated secret assignments cannot exhaust the scan budget',async()=>{
  const {spawnSync}=await import('node:child_process');
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {workspaceTranscript} from './lib/v1/workspace-transcript.mjs';
    const w=workspaceTranscript('/synthetic/workspace',{privateValues:[],home:'/synthetic/home'});
    const input=('token='.repeat(680)+'\\n').repeat(257),start=performance.now();
    w.append('stdout',input);w.end('stdout');
    const json=Array.from({length:257},()=>JSON.stringify({type:'result',result:'token='.repeat(680)})+'\\n').join('');
    w.append('stderr',json);w.end('stderr');
    if(performance.now()-start>=900)process.exitCode=1;
  `],{cwd:new URL('..',import.meta.url),timeout:3000,encoding:'utf8'});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('ordinary code, git remotes and unrelated home paths survive identity redaction',()=>{
  const text=createTranscriptRedactor({privateValues:[],home:'/home/real-lender'});
  for(const input of ['session = requests.Session()','device = torch.device("cuda")','const user = getUser();','const account = 1;',
    'git@github.com:org/repo.git','Edit /home/x/project/file and /Users/Other/code','Read /root/example and ~/project'])
    assert.equal(text(input),input);
  assert.equal(text('session_id: private-session\nTests passed.'),'session_id: [private details withheld]\nTests passed.');
  assert.equal(text('Provider {"user_email":"bob@example.test","ok":true}'), 'Provider {"user_email":"[private details withheld]","ok":true}');
  assert.equal(text('Saved /home/real-lender/project/file'),'Saved [private details withheld]');
});

test('ordinary Python, typed signatures and SSH git remotes survive identity policy',()=>{
  const text=createTranscriptRedactor({privateValues:[],home:'/synthetic/home'});
  for(const input of ['device = torch.device','user = None','session = None','session = self._session','user = req.user',
    'account = accounts[0]','session = await getSession()','def f(user: User, account: Account):','  user: User;',
    'f(x, session=sess)','ssh://git@github.com/org/repo.git'])assert.equal(text(input),input);
});


test('short and low-entropy secret-named environment flags do not erase prose',t=>{
  const env={DISABLE_AUTH:'1',FEATURE_SECRET:'000000000000',OTHER_SESSION_KEY:'true',SYNTHETIC_TOKEN:'synthetic-diverse-secret'};
  const before=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value] of Object.entries(before))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const text=createTranscriptRedactor({privateValues:[],home:'/synthetic/home'});
  for(const line of ['ran 3 tests, 1 failed','count = 000000000000','true means enabled'])assert.equal(text(line),line);
  assert.equal(text('value synthetic-diverse-secret'),'[private details withheld]');
});
