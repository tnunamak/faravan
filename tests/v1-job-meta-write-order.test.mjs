import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJobMetaStore} from '../lib/v1/job-meta.mjs';
import {withProfileWriter} from '../lib/v1/lock.mjs';

test('same-process metadata writers wait for a slow durable write without racing the process lock',async t=>{
  const directory=await fs.promises.mkdtemp(join(tmpdir(),'job-meta-order-'));
  const store=createJobMetaStore(directory),original=fs.promises.open;
  let enter,release,blocked=false;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  fs.promises.open=async(file,...args)=>{
    if(!blocked&&String(file).startsWith(join(directory,'job-meta.json.'))) {blocked=true;enter();await gate;}
    return original(file,...args);
  };
  t.after(()=>{release();fs.promises.open=original;});
  const first=store.record('sha256:'+'a'.repeat(64),{title:'first'});
  await entered;
  const second=createJobMetaStore(directory).record('sha256:'+'b'.repeat(64),{title:'second'}).then(()=>null,error=>error);
  await new Promise(resolve=>setTimeout(resolve,350));release();
  await first;assert.equal(await second,null);
  assert.equal((await store.get('sha256:'+'a'.repeat(64))).title,'first');
  assert.equal((await store.get('sha256:'+'b'.repeat(64))).title,'second');
});

test('a queued metadata writer cannot block a nested write by the current profile owner',async()=>{
  const home=await fs.promises.mkdtemp(join(tmpdir(),'job-meta-nested-order-'));
  const store=createJobMetaStore(join(home,'v1'));
  let enter,resume;
  const entered=new Promise(resolve=>{enter=resolve;}),ready=new Promise(resolve=>{resume=resolve;});
  const owner=withProfileWriter(home,async()=>{
    enter();await ready;
    await store.record('sha256:'+'c'.repeat(64),{title:'nested'});
  });
  await entered;
  const waiting=store.record('sha256:'+'d'.repeat(64),{title:'waiting'}).then(()=>null,error=>error);
  resume();await owner;
  assert.equal(await waiting,null,'the queued writer must wait outside the current owner’s metadata queue');
  assert.equal((await store.get('sha256:'+'c'.repeat(64))).title,'nested');
  assert.equal((await store.get('sha256:'+'d'.repeat(64))).title,'waiting');
});
