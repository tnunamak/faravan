import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('R3 repeated service signals cannot interrupt accepted app cleanup',{timeout:10000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'r3-cli-shutdown-')),closed=join(home,'cleanup-finished');
  const module=new URL('../lib/v1/cli.mjs',import.meta.url).href;
  const code=`import {writeFile} from 'node:fs/promises';
    const {runV1Command}=await import(${JSON.stringify(module)});
    setInterval(()=>{},1000);
    process.exitCode=await runV1Command(['app'],{home:${JSON.stringify(home)},env:{FARAVAN_NO_BROWSER:'1'},
      startApp:async()=>({origin:'http://127.0.0.1:1',close:async()=>{
        process.send('closing');await new Promise(resolve=>setTimeout(resolve,200));
        await writeFile(${JSON.stringify(closed)},'all resources reaped');}}),onApp:()=>process.send('ready')});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,FARAVAN_HOME:home},stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',chunk=>t.diagnostic(String(chunk)));
  const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  assert.equal((await once(child,'message'))[0],'ready');
  const closing=once(child,'message');child.kill('SIGTERM');assert.equal((await closing)[0],'closing');
  child.kill('SIGTERM');
  assert.deepEqual(await ended,[0,null]);
  assert.equal(await readFile(closed,'utf8'),'all resources reaped');
});
