import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runV1Command } from '../lib/v1/cli.mjs';

const RECONNECT='If the page asks you to reconnect, run faravan app open-link.\n';
const APP={origin:'http://127.0.0.1:4100',handoffUrl:()=> 'http://127.0.0.1:4100/auth/handoff?code=one-use',close:async()=>{}};

async function runApp({isTTY,env={},opener=true,json=false,openResult}) {
  let out='';const opened=[];
  const stdout={isTTY,write:chunk=>{out+=chunk;}};
  const signal=AbortSignal.abort();
  const code=await runV1Command(['app',...(json?['--json']:[])],{stdout,stderr:stdout,env,signal,startApp:async()=>APP,openUrl:opener?url=>{opened.push(url);if(openResult==='throw')throw Error(url);return openResult;}:false});
  return {code,out,opened};
}

test('a desktop terminal that inherited INVOCATION_ID still gets the clean app URL and opens a handoff', async () => {
  const r=await runApp({isTTY:true,env:{INVOCATION_ID:'abc'}});
  assert.equal(r.code,0);
  assert.equal(r.out,'Open Faravan: '+APP.origin+'/\n'+RECONNECT);
  assert.equal(r.out.includes('secret'),false);
  assert.equal(r.out.includes('one-use'),false);
  assert.deepEqual(r.opened,[APP.handoffUrl()]);
});

test('under systemd (no terminal) the session token never reaches the journal', async () => {
  const r=await runApp({isTTY:false,env:{INVOCATION_ID:'abc'}});
  assert.equal(r.out.includes('secret'),false);
  assert.equal(r.out,'Open Faravan: '+APP.origin+'/\n'+RECONNECT);
  assert.equal(r.out.includes('one-use'),false);
});

test('FARAVAN_NO_BROWSER still suppresses the opener at a terminal, and the printed link is a handoff, not a ?token= link', async () => {
  const r=await runApp({isTTY:true,env:{FARAVAN_NO_BROWSER:'1'}});
  assert.deepEqual(r.opened,[]);
  assert.equal(r.out,'Open Faravan: '+APP.handoffUrl()+'\n'+RECONNECT);
  assert.equal(r.out.includes('?token='),false);
});

test('a terminal without an opener gets a one-use handoff link, JSON included, never a token URL',async()=>{
  for(const json of [false,true]) {
    const r=await runApp({isTTY:true,opener:false,json});
    assert.equal(r.code,0);assert.deepEqual(r.opened,[]);
    assert.equal(json?JSON.parse(r.out).url:r.out, json?APP.handoffUrl():'Open Faravan: '+APP.handoffUrl()+'\n'+RECONNECT);
    assert.equal(r.out.includes('?token='),false);
  }
});

test('a failed browser launch falls back only at a terminal without logging its code',async()=>{
  for(const isTTY of [true,false])for(const openResult of [false,'throw']) {
    const r=await runApp({isTTY,openResult});
    assert.equal(r.code,0);
    assert.equal(r.out,'Open Faravan: '+(isTTY?APP.handoffUrl():APP.origin+'/')+'\n'+RECONNECT);
    assert.equal(r.out.includes('one-use'),isTTY,'a handoff code is printed only to a terminal');
  }
});

test('non-terminal output never includes credentials even without INVOCATION_ID',async()=>{
  const r=await runApp({isTTY:false,opener:false,json:true});
  assert.equal(r.code,0);assert.equal(JSON.parse(r.out).url,APP.origin+'/');
  assert.deepEqual(r.opened,[]);
});
