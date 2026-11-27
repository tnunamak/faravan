import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {EventEmitter} from 'node:events';
import {superviseProcess} from '../lib/v1/process-supervisor.mjs';

test('R2 stopping a child that ignores SIGTERM escalates and waits for its actual exit',{timeout:10000},async t=>{
  let launches=0;
  const supervisor=superviseProcess({stopGraceMs:50,delayMs:1,launch(){
    launches++;
    return spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
  }});
  const child=supervisor.child,ended=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  await once(child,'message');
  let timer;
  try {
    const stopped=supervisor.stop();
    assert.equal(supervisor.stop(),stopped,'repeated stops retain the original deadline');
    const closed=await Promise.race([stopped.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
    assert.equal(closed,true,'the owned child must exit within the configured grace');
    assert.equal(child.signalCode,'SIGKILL');
    assert.equal(launches,1,'an explicit stop never starts a replacement');
  }finally{clearTimeout(timer);}
});

test('R2 a long-lived child resets backoff to the full initial delay',t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
  let launches=0;
  const supervisor=superviseProcess({delayMs:100,launch(){
    launches++;
    const child=new EventEmitter();
    Object.assign(child,{pid:12345,exitCode:null,signalCode:null,kill(signal){this.signalCode=signal;this.emit('close',null);}});
    return child;
  }});
  t.after(()=>supervisor.stop('SIGKILL'));
  t.mock.timers.tick(30001);
  const first=supervisor.child;first.exitCode=1;first.emit('close',1);
  t.mock.timers.tick(50);
  assert.equal(launches,1,'a stable run must not halve the configured initial delay');
  t.mock.timers.tick(50);assert.equal(launches,2);
});
