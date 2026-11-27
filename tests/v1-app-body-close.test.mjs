import './helpers/no-browser.mjs';
import test from 'node:test';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// Evaluate the real body continuation: a request admitted before close must not accept Quit afterwards.
const source=await readFile(process.env.LIFECYCLE_APP_SOURCE??new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
test('a Quit body finishing during update close is refused before it can acquire an attempt',async()=>{
  const begin=source.indexOf('        let input=await body(req);');
  const end=source.indexOf('        // Telemetry consent:',begin);
  assert.ok(begin>=0&&end>begin);
  let release,accepted=false;
  const input=new Promise(done=>{release=done;});
  const c={closed:false,quitting:false,req:{},parts:['api','shutdown'],body:()=>input,
    fail:(code,status)=>{throw Object.assign(new Error(code),{code,status});},accept:()=>{accepted=true;}};
  const route=runInNewContext('(async()=>{'+source.slice(begin,end)+';accept();})',c);
  const owner=new AppLifetime();c.requestHandle=owner.register('HTTP admission','producer');
  const request=route();c.closed=true;owner.stop('update');release({});
  await assert.rejects(request,{code:'app_closing'});assert.equal(accepted,false);
});
