import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {closeOwnedApp} from '../packaging/journey/local-lend-process.mjs';
test('an unresponsive owned app is terminated and reaped without blocking the next app',async()=>{
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
  const app={child,exited:false,control:()=>new Promise(()=>{})};
  app.exit=new Promise(resolve=>child.once('exit',code=>{app.exited=true;app.exitCode=code;resolve();}));
  try {
    await once(child.stdout,'data');
    const answer=await closeOwnedApp(app,{shutdownMs:20,exitMs:20,termMs:20});
    assert.equal(answer.forcedTermination,true);assert.equal(answer.stopped,true);
    const alreadyClosed={exited:true,exitCode:0};
    assert.equal((await closeOwnedApp(alreadyClosed)).forcedTermination,false);
  } finally {if(!app.exited){child.kill('SIGKILL');await app.exit;}}
});
