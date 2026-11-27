import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {appFixture,api} from '../helpers/v1-app-fixture.mjs';
import {durableWrite} from '../../lib/durable-write.mjs';

for(const fault of ['none','begin','unknown','mark','retire'])test('real app LEAVE fences before effects and recovers only applied retirement: '+fault,async t=>{
  const f=await appFixture(t);let metadata,activeFault=null;
  const options={pollMs:250,savedReadStorage:{persist:(file,text)=>{
    if(file.endsWith('/authority.json')){
      metadata=file;const value=JSON.parse(text);
      const phase=value.pending.some(row=>row.phase==='applied')?'mark':value.pending.length?'begin':
        value.circles.some(row=>row.floor>0)?'retire':'initial';
      if(activeFault===phase)throw Object.assign(Error('owned save failure'),{code:'EIO'});
    }
    durableWrite(file,text);
  }}};
  const {lender,circle}=await f.realConnect({lenderOptions:options});
  // The real join and local device store are used. Wrap the native effect only
  // to assert ordering and inject a lost answer, never to manufacture a leave.
  let effects=0;
  const original=lender.app.device.leaveCircle.bind(lender.app.device);
  t.mock.method(lender.app.device,'leaveCircle',async(...args)=>{
    effects++;
    const pending=JSON.parse(readFileSync(metadata,'utf8')).pending;
    assert.ok(pending.some(row=>row.scope.kind==='circle'&&row.scope.circle===circle.id&&!row.phase));
    if(activeFault==='unknown')throw Error('owned ambiguous effect');
    return original(...args);
  });
  activeFault=fault==='none'?null:fault;
  const result=await api(lender.app,'/api/circles/'+circle.id+'/leave',{method:'POST',body:{},raw:true,status:null});
  const value=await result.json();
  if(fault==='begin'){assert.ok(result.status>=400);assert.equal(effects,0);return;}
  assert.equal(effects,1);
  if(fault==='unknown')assert.ok(result.status>=400);
  else {assert.equal(result.status,200);assert.equal(value.left,true);}
  const pending=()=>JSON.parse(readFileSync(metadata,'utf8')).pending;
  assert.equal(pending().length,fault==='none'?0:1);
  if(['mark','retire'].includes(fault))assert.equal(value.localRetirement.state,'unconfirmed');
  await lender.app.close();activeFault=null;
  await f.start('lender',options);
  assert.equal(pending().length,['none','retire'].includes(fault)?0:1);
  assert.equal(effects,1,'startup never repeats the remote leave');
});
