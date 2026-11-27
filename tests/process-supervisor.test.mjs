import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {superviseProcess} from '../lib/v1/process-supervisor.mjs';
import {residentQuit,setResidentQuit} from '../lib/v1/resident-intent.mjs';

test('G08 a resident child is replaced after SIGKILL; a durable Quit suppresses further starts',{timeout:10000},async t=>{
  const home=mkdtempSync(join(tmpdir(),'faravan-supervisor-'));
  let launches=0,ready;
  const next=()=>new Promise(resolve=>{ready=resolve;});
  let started=next();
  const supervisor=superviseProcess({delayMs:10,shouldRestart:()=>!residentQuit(home),launch(){
    launches++;
    const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>ready(child));return child;
  }});
  t.after(()=>supervisor.stop('SIGKILL'));
  const first=await started;started=next();first.kill('SIGKILL');
  const second=await started;assert.notEqual(second.pid,first.pid);assert.equal(launches,2);
  setResidentQuit(true,home);second.kill('SIGKILL');await supervisor.finished;
  assert.equal(launches,2);assert.equal(residentQuit(home),true);
  let unexpected=false;
  const restarted=superviseProcess({shouldRestart:()=>!residentQuit(home),launch(){unexpected=true;}});
  await restarted.finished;assert.equal(unexpected,false);
});
