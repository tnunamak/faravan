import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('a live interrupted owner blocks boot; its process exit permits recovery and normal boot',async t=>{
  const f=await appFixture(t),home=await f.home('lender');
  const child=fork(fileURLToPath(new URL('./helpers/lifetime-lock-child.mjs',import.meta.url)),[home],{stdio:['ignore','ignore','inherit','ipc']});
  const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}});
  const [result]=await once(child,'message');
  assert.equal(result.state,'interrupted');
  await assert.rejects(f.start('lender'),{code:'app_already_running'});
  child.send('exit');assert.equal((await exited)[0],0);
  const restarted=await f.start('lender');
  assert.ok(await api(restarted.app,'/api/status'));
  const closed=await restarted.app.close();
  assert.equal(closed.state,'closed');
});
