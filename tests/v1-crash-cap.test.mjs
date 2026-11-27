import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

for(const scenario of ['first','precreated','lower','migration'])test('G01 crash-consistency model retains acknowledged cap: '+scenario,async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-cap-model-'));
  await crashProcess(t,fileURLToPath(new URL('./helpers/recovery-cap-model-child.mjs',import.meta.url)),
    [root,scenario,...(process.env.FARAVAN_BASELINE_CAP_MODULE?[process.env.FARAVAN_BASELINE_CAP_MODULE]:[])],'cap-ack');
  const reboot=join(root,'reboot');
  for(const [name,bytes] of Object.entries(JSON.parse(readFileSync(join(root,'stable.json'),'utf8')))) {
    const path=join(reboot,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(bytes,'base64'));
  }
  const {createOwnerSettings}=await import('../lib/v1/owner-settings.mjs');
  const state=createOwnerSettings({directory:join(reboot,'settings')}).limit();
  assert.equal(state.state,'set');assert.equal(state.maxJobUsd,1);
});
test('G01 acknowledged cap has file and directory barriers before SIGKILL',async t=>{
  const root=mkdtempSync(join(tmpdir(),'faravan-cap-crash-')),directory=join(root,'new','settings');
  // The immediate parent exists so the child can leave its trace outside settings.
  const {mkdirSync}=await import('node:fs');mkdirSync(join(root,'new'));
  await crashProcess(t,fileURLToPath(new URL('./helpers/recovery-cap-child.mjs',import.meta.url)),[directory],'cap-ack');
  const events=JSON.parse(readFileSync(join(root,'new','cap-events.json'),'utf8'));
  const rename=events.findIndex(e=>e[0]==='rename'&&e[2]===join(directory,'owner-settings.json'));
  assert.ok(rename>=0);
  assert.ok(events.slice(0,rename).some(e=>e[0]==='sync'&&e[1]===events[rename][1]),'sync complete temporary bytes before rename');
  assert.ok(events.slice(rename+1).some(e=>e[0]==='sync'&&e[1]===directory),'sync directory before acknowledge');
  const {createOwnerSettings}=await import('../lib/v1/owner-settings.mjs');
  assert.equal(createOwnerSettings({directory}).limit().maxJobUsd,1);
});
