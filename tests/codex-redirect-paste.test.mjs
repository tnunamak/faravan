import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProviderGenerationAuth} from '../lib/provider-generation-auth.mjs';
import {createSignin} from '../lib/v1/signin.mjs';
import {CODEX_HARNESS,CLAUDE_CODE_HARNESS} from '../lib/harnesses.mjs';

import {freePort,fakeCodex,STATE,CODE} from './helpers/fake-codex-redirect.mjs';
async function setup(t,provider='codex',fakeOptions={}) {
  const home=await mkdtemp(join(tmpdir(),'codex-redirect-'));
  const oldHome=process.env.FARAVAN_SBX_HOME,oldRoot=process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SBX_HOME=home;process.env.FARAVAN_SCRATCH_ROOT=home;
  t.after(()=>{if(oldHome===undefined)delete process.env.FARAVAN_SBX_HOME;else process.env.FARAVAN_SBX_HOME=oldHome;if(oldRoot===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=oldRoot;});
  const {portOverride,...fakeFlags}=fakeOptions,port=portOverride??await freePort(),fake=await fakeCodex(home,port,{provider,...fakeFlags});
  const spec=provider==='codex'?CODEX_HARNESS:CLAUDE_CODE_HARNESS;
  const signin=createSignin({adapters:async()=>[{spec}],backend:()=>({}),onComplete:async()=>{},
    startProvider:(s,{onHandle,method})=>startProviderGenerationAuth(s,{home,providerBin:fake.bin,onHandle,method})});
  t.after(()=>signin.close());
  return {home,port,fake,signin};
}
const requests=async fake=>readFile(fake.log,'utf8').catch(()=>'');
const waitFor=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,25));}assert.fail('timed out');};
const redirected=(port,query,{host='localhost',scheme='http',path='/auth/callback'}={})=>`${scheme}://${host}:${port}${path}?${query}`;

test('a pasted redirect address finishes a Codex sign-in approved on another device',{skip:process.platform==='win32'},async t=>{
  const {port,signin}=await setup(t);
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  assert.equal(flow.status,'awaiting_browser');
  assert.equal(flow.redirectEntry,true);
  const after=await signin.post(['signin',flow.flowId,'code'],{code:redirected(port,`code=${CODE}&state=${STATE}`)});
  assert.ok(['awaiting_browser','complete'].includes(after.status));
  await waitFor(()=>signin.get(flow.flowId).status==='complete');
});

for(const [name,url] of [
  ['wrong state',port=>redirected(port,`code=${CODE}&state=other`)],
  ['wrong port',port=>redirected(port+1,`code=${CODE}&state=${STATE}`)],
  ['wrong host',port=>redirected(port,`code=${CODE}&state=${STATE}`,{host:'example.com'})],
  ['https',port=>redirected(port,`code=${CODE}&state=${STATE}`,{scheme:'https'})],
  ['wrong path',port=>redirected(port,`code=${CODE}&state=${STATE}`,{path:'/other'})],
  ['missing code',port=>redirected(port,`state=${STATE}`)],
  ['not a URL',()=>'not a url'],
  ['a repeated state',port=>redirected(port,`code=${CODE}&state=${STATE}&state=other`)],
  ['a repeated state, the wrong one first',port=>redirected(port,`code=${CODE}&state=other&state=${STATE}`)],
  ['a repeated code',port=>redirected(port,`code=${CODE}&code=other&state=${STATE}`)],
  ['an empty code',port=>redirected(port,`code=&state=${STATE}`)],
]) test('a pasted address with '+name+' is refused and nothing is sent',{skip:process.platform==='win32'},async t=>{
  const {port,fake,signin}=await setup(t);
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  await assert.rejects(signin.post(['signin',flow.flowId,'code'],{code:url(port)}),{code:'signin_redirect_mismatch',status:400});
  assert.equal(await requests(fake),'','the fake listener received no request');
  assert.equal(signin.get(flow.flowId).status,'awaiting_browser','the flow stays open for the right address');
});

test('a Claude flow given a URL keeps the existing code behavior and sends nothing',{skip:process.platform==='win32'},async t=>{
  const {port,fake,signin}=await setup(t,'claude');
  const flow=await signin.start(CLAUDE_CODE_HARNESS.harness_id);
  assert.equal(flow.redirectEntry,undefined);
  await assert.rejects(signin.post(['signin',flow.flowId,'code'],{code:redirected(port,`code=${CODE}&state=${STATE}`)}),e=>e.code!=='signin_redirect_mismatch');
  assert.equal(await requests(fake),'');
});

// A listener that is not the CLI: it answers an upgrade, or accepts and never answers.
for(const [name,reply] of [['an upgrade reply',socket=>socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n')],
  ['no reply at all',()=>{}]]) test('a listener giving '+name+' ends the paste with a fixed error inside the deadline',{skip:process.platform==='win32'},async t=>{
  const sockets=new Set(),listener=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('data',()=>reply(socket));});
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();listener.close();});
  const {signin}=await setup(t,'codex',{listen:false,portOverride:listener.address().port});
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  assert.equal(flow.redirectEntry,true);
  const started=Date.now();
  const error=await signin.post(['signin',flow.flowId,'code'],{code:redirected(listener.address().port,`code=${CODE}&state=${STATE}`)}).then(()=>null,e=>e);
  assert.ok(error,'the paste is refused');
  assert.equal(error.code,'signin_code_invalid');assert.equal(error.status,400);
  assert.ok(Date.now()-started<7000,'inside the 5 second deadline');
  assert.doesNotMatch(String(error.message)+JSON.stringify(error),new RegExp(CODE+'|'+STATE));
});

test('a paste with extra parameters reaches the listener as exactly code and state',{skip:process.platform==='win32'},async t=>{
  const {port,fake,signin}=await setup(t);
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  await signin.post(['signin',flow.flowId,'code'],{code:redirected(port,`extra=1&code=${CODE}&state=${STATE}&scope=x`)});
  await waitFor(()=>signin.get(flow.flowId).status==='complete');
  assert.equal((await requests(fake)).trim(),'/auth/callback?'+new URLSearchParams({code:CODE,state:STATE}));
});

// A listener that answers every request with one status, and counts what it is asked for.
const answering=async(t,status,headers={})=>{
  const {createServer:httpServer}=await import('node:http');
  const seen=[],server=httpServer((req,res)=>{seen.push(req.url);res.writeHead(status,headers);res.end('x');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  return {seen,port:server.address().port};
};
for(const status of [400,500]) test('a listener answering '+status+' is an error and the flow stays open for another try',{skip:process.platform==='win32'},async t=>{
  const listener=await answering(t,status);
  const {signin}=await setup(t,'codex',{listen:false,portOverride:listener.port});
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  await assert.rejects(signin.post(['signin',flow.flowId,'code'],{code:redirected(listener.port,`code=${CODE}&state=${STATE}`)}),{code:'signin_code_invalid',status:400});
  assert.equal(listener.seen.length,1);
  assert.equal(signin.get(flow.flowId).status,'awaiting_browser');
});
test('a listener answering 302 is a success and its Location is not fetched',{skip:process.platform==='win32'},async t=>{
  const elsewhere=await answering(t,200);
  const listener=await answering(t,302,{Location:'http://127.0.0.1:'+elsewhere.port+'/success'});
  const {signin}=await setup(t,'codex',{listen:false,portOverride:listener.port});
  const flow=await signin.start(CODEX_HARNESS.harness_id,'browser');
  const after=await signin.post(['signin',flow.flowId,'code'],{code:redirected(listener.port,`code=${CODE}&state=${STATE}`)});
  assert.equal(after.status,'awaiting_browser');
  assert.equal(listener.seen.length,1);
  assert.deepEqual(elsewhere.seen,[]);
});
