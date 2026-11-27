import './helpers/no-browser.mjs';
import test from 'node:test';
import {sessionRecovery} from '../ui/v1/src/session-recovery.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('a cold 401 renders the branded, device-aware recovery screen under the blob-only style policy',async()=>{
  const source=await readFile(new URL('../ui/v1/src/bootstrap.mjs',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/v1/index.html',import.meta.url),'utf8');
  const script=source.replace('export async function','async function')+'\nbootstrap(()=>\'\', recoveryStyles, sessionRecovery)';
  const blobs=[],target={innerHTML:'',textContent:'',removeAttribute(name){this.removed=name;}};
  const head={append(link){this.link=link;}};
  const document={getElementById:()=>target,createElement:()=>({}),head};
  const URLApi={createObjectURL(blob){blobs.push(blob);return 'blob:recovery';},revokeObjectURL(){}};
  await runInNewContext(script,{
    location:{href:'http://127.0.0.1:4100/'},history:{replaceState(){}},
    sessionStorage:{getItem(){return 'expired';},removeItem(){this.removed=true;}},
    document,URL:URLApi,Blob,sessionRecovery,matchMedia:()=>({matches:true}),localStorage:{getItem(){return 'dark';}},
    fetch:async()=>({ok:false,status:401}),recoveryStyles:
      "@font-face{font-family:'Source Sans 3';src:url(data:font/woff2;base64,AA==)}:root{--recovery-bg:#111216}",
  });
  assert.match(target.innerHTML,/Reconnect to Faravan/);
  assert.doesNotMatch(target.innerHTML,/tray|terminal/i);
  assert.match(target.innerHTML,/Settings → Pairing/);
  assert.match(target.innerHTML,/pair this device again/i);
  assert.equal(target.removed,'role');
  assert.equal(head.link.href,'blob:recovery');
  assert.match(await blobs[0].text(),/Source Sans 3/);
  assert.match(html,/style-src blob:/);
  assert.match(html,/font-src data:/);
  assert.match(html,/Source Sans 3/);
  assert.match(html,/--text-title1/);
  assert.match(html,/run faravan in a terminal/i);
  assert.match(html,/M16 32a16 16 0 0 1 32 0/,'the recovery screen shows the open-horizon mark');
  assert.match(html,/Settings &gt; Pairing/);
  assert.doesNotMatch(html,/Faravan restarted|SESSION ENDED/);
  assert.doesNotMatch(html,/unsafe-inline|unsafe-eval/);
});

test('a non-auth bootstrap failure keeps a plain retry message without claiming a restart',async()=>{
  const source=await readFile(new URL('../ui/v1/src/bootstrap.mjs',import.meta.url),'utf8');
  const target={innerHTML:'',textContent:''};
  const script=source.replace('export async function','async function')+'\nbootstrap(()=>\'\', \'\', sessionRecovery)';
  await runInNewContext(script,{
    location:{href:'http://127.0.0.1:4100/'},history:{replaceState(){}},sessionStorage:{getItem(){return null;}},
    document:{getElementById:()=>target},URL,sessionRecovery,matchMedia:()=>({matches:false}),fetch:async()=>({ok:false,status:503}),
  });
  assert.equal(target.textContent,'Faravan could not open. Check the connection, then reload the page.');
  assert.equal(target.innerHTML,'');
});
