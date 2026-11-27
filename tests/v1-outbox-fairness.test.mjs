import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDevice} from '../lib/v1/device.mjs';
import {createJobOperations} from '../lib/v1/cli.mjs';

test('outbox retry order survives restart and cannot starve a later circle',async()=>{
  const home=await mkdtemp(join(tmpdir(),'outbox-fairness-'));
  const device=await openDevice({home,ensureDefault:false,origin:null});
  const first=await device.createCircle('http://127.0.0.1:18787',{publish:false});
  const second=await device.createCircle('http://127.0.0.1:18788',{publish:false});
  for(const circle of [first,second])for(let i=0;i<16;i++)await device.intentStore(circle.id).set('cancel:'+i,{
    kind:'cancel',state:'pending',operationKey:circle.id+':'+i,payload:{circle:circle.id,author:device.keyId,job_digest:'sha256:'+i.toString(16).padStart(64,'0')}});
  const calls=[];
  device.client=async()=>({cancelJob:async(_digest,options)=>{calls.push(options.idempotencyKey);throw Object.assign(new Error('offline'),{status:503,code:'offline'});}});
  device.jobReadClient=device.client;
  await createJobOperations({home,device}).recoverPending();
  assert.equal(calls.length,16);
  await createJobOperations({home,device}).recoverPending();
  assert.equal(calls.length,32);
  assert.equal(new Set(calls).size,32);
});
