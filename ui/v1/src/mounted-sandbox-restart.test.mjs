import {mount,click,teardown,resetPage} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test from 'node:test';
import assert from 'node:assert/strict';
import {RestartSandbox} from './blockers.jsx';

test('shared restart sends no request until confirmation; cancel leaves the daemon alone',async t=>{
  t.after(teardown);resetPage();const calls=[];let refreshed=0;
  await mount(h(RestartSandbox,{api:{post:async(...args)=>{calls.push(args);return {}; }},refresh:async()=>{refreshed++;}}));
  const restart=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Restart Docker Sandboxes');
  await click(restart());
  assert.equal(calls.length,0);
  assert.match(document.querySelector('dialog').textContent,/other apps/);
  await click([...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Cancel'));
  assert.equal(calls.length,0);
  assert.equal(document.querySelector('dialog'),null);
  await click(restart());
  await click([...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Restart Docker Sandboxes'));
  assert.deepEqual(calls,[['setup/restart-sandbox',{confirmed:true}]]);
  assert.equal(refreshed,1);
  assert.equal(document.querySelector('dialog'),null);
});

test('policy reset explains removal and sends only the confirmed policy request',async t=>{
  t.after(teardown);resetPage();const calls=[];
  await mount(h(RestartSandbox,{policy:true,api:{post:async(...args)=>{calls.push(args);}},refresh:async()=>{}}));
  await click(document.querySelector('button'));
  assert.equal(calls.length,0);
  assert.match(document.querySelector('dialog').textContent,/removes all custom sandbox network rules/);
  await click([...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Reset sandbox network rules'));
  assert.deepEqual(calls,[['setup/repair-policy',{confirmed:true}]]);
});

test('plain initialization confirmation does not claim to remove custom rules',async t=>{
  t.after(teardown);resetPage();const calls=[];
  await mount(h(RestartSandbox,{policy:'init',api:{post:async(...args)=>{calls.push(args);}},refresh:async()=>{}}));
  await click(document.querySelector('button'));
  const dialog=document.querySelector('dialog');
  assert.match(dialog.textContent,/initializes the missing sandbox network policy as deny-all/);
  assert.doesNotMatch(dialog.textContent,/removes|custom rules|Reset/);
  await click([...dialog.querySelectorAll('button')].find(b=>b.textContent==='Initialize sandbox network rules'));
  assert.deepEqual(calls,[['setup/initialize-policy',{confirmed:true}]]);
});
