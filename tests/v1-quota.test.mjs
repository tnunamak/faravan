import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createQuotaReader } from '../lib/v1/quota.mjs';

const fixture=JSON.parse(await readFile(new URL('./fixtures/clawmeter-status.json',import.meta.url),'utf8'));
const expected={provider:'claude',remaining:71,observedAt:Date.parse(fixture.providers.claude.usage.fetched_at),
  resetsAt:Date.parse(fixture.providers.claude.usage.windows[1].resets_at)};
function fakeSpawn({text=JSON.stringify(fixture),code=0,signal=null,error,hang=false,streamError=false}={}) {
  const calls=[];
  const spawn=(...args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.killed=[];
    child.kill=signal=>{child.killed.push(signal);return true;};
    calls.push({args,child});
    queueMicrotask(()=>{
      if(error){child.emit('error',Object.assign(new Error('private diagnostic'),{code:error}));return;}
      if(streamError){child.stdout.emit('error',new Error('private diagnostic'));return;}
      if(hang)return;
      child.stdout.write(text);child.stdout.end();child.emit('close',code,signal);
    });
    return child;
  };
  return {spawn,calls};
}
const reader=(fake,options={})=>createQuotaReader({spawn:fake.spawn,env:{},isExecutable:()=>false,...options});

test('maps only 7d All and usage fetched_at, with safe bounded subprocess arguments',async()=>{
  const fake=fakeSpawn();
  assert.deepEqual(await reader(fake)(),expected);
  assert.deepEqual(fake.calls[0].args,['clawmeter',['status','--json','--provider','claude'],
    {shell:false,stdio:['ignore','pipe','ignore'],timeout:10000,killSignal:'SIGKILL'}]);
});
test('binary lookup prefers override, package-relative brew link, then PATH',async()=>{
  for(const [env,exists,binary] of [
    [{FARAVAN_CLAWMETER:'/synthetic/custom meter'},true,'/synthetic/custom meter'],
    [{},true,fileURLToPath(new URL('../clawmeter',import.meta.url))],
    [{},false,'clawmeter']]) {
    const fake=fakeSpawn();await reader(fake,{env,isExecutable:()=>exists})();
    assert.equal(fake.calls[0].args[0],binary);
  }
});
for(const [name,options] of [
  ['missing binary',{error:'ENOENT'}],['nonzero exit',{code:1}],
  ['signal termination',{signal:'SIGTERM'}],['bad JSON',{text:'private diagnostic'}],
  ['stdout error',{streamError:true}],['missing window',{text:'{"providers":{"claude":{"usage":{"windows":[]}}}}'}],
  ['malformed windows',{text:'{"providers":{"claude":{"usage":{"windows":{}}}}}'}],
]) test(name+' returns null without throwing or logging',async t=>{
  const logs=[];
  for(const method of ['log','error','warn','info','debug'])t.mock.method(console,method,(...args)=>logs.push(args));
  assert.equal(await reader(fakeSpawn(options))(),null);assert.deepEqual(logs,[]);
});
test('synchronous spawn and lookup failures return null',async()=>{
  assert.equal(await createQuotaReader({spawn(){throw new Error('synthetic');},env:{FARAVAN_CLAWMETER:'fake'}})(),null);
  assert.equal(await createQuotaReader({env:{},isExecutable(){throw new Error('synthetic');}})(),null);
});
test('10 second timeout settles even when killed child never closes',async()=>{
  const fake=fakeSpawn({hang:true});let fire,cleared;
  const quota=reader(fake,{schedule:(fn,ms)=>{assert.equal(ms,10000);fire=fn;return 7;},unschedule:id=>{cleared=id;}});
  const pending=quota();fire();
  assert.equal(await pending,null);assert.deepEqual(fake.calls[0].child.killed,['SIGKILL']);assert.equal(cleared,7);
  fake.calls[0].child.emit('close',0); // late completion cannot replace the failure
  assert.equal(await quota(),null);
});
test('stdout is capped at 1 MiB, counting bytes rather than characters',async()=>{
  const fake=fakeSpawn({text:'é'.repeat(524289)});
  assert.equal(await reader(fake)(),null);assert.deepEqual(fake.calls[0].child.killed,['SIGKILL']);
  const json=JSON.stringify(fixture),atLimit=fakeSpawn({text:json+' '.repeat(1048576-Buffer.byteLength(json))});
  assert.deepEqual(await reader(atLimit)(),expected);
});
test('successful and failed results cache for 60 seconds and concurrent reads share one process',async()=>{
  for(const failing of [false,true]) {
    let time=1000;const fake=fakeSpawn(failing?{code:2}:{});
    const quota=reader(fake,{now:()=>time});
    const values=await Promise.all([quota(),quota()]);
    assert.deepEqual(values,[failing?null:expected,failing?null:expected]);assert.equal(fake.calls.length,1);
    time+=59999;assert.deepEqual(await quota(),failing?null:expected);assert.equal(fake.calls.length,1);
    time++;assert.deepEqual(await quota(),failing?null:expected);assert.equal(fake.calls.length,2);
  }
});
test('expired success is cleared when a refresh fails',async()=>{
  let time=0;const success=fakeSpawn(),failure=fakeSpawn({code:1});
  const quota=createQuotaReader({env:{},isExecutable:()=>false,now:()=>time,
    spawn:(...args)=>(time?failure:success).spawn(...args)});
  assert.deepEqual(await quota(),expected);time=60000;assert.equal(await quota(),null);
});
test('remaining is clamped and invalid utilization or timestamps fail closed',async()=>{
  for(const [utilization,remaining] of [[-10,100],[150,0],[0,100],[100,0],[29.5,70.5]]) {
    const input=structuredClone(fixture);input.providers.claude.usage.windows[1].utilization=utilization;
    assert.equal((await reader(fakeSpawn({text:JSON.stringify(input)}))()).remaining,remaining);
  }
  for(const mutate of [
    usage=>{usage.windows[1].utilization=null;},usage=>{usage.windows[1].utilization='29';},
    usage=>{usage.fetched_at='invalid';},usage=>{usage.windows[1].resets_at='invalid';}
  ]) {
    const input=structuredClone(fixture);mutate(input.providers.claude.usage);
    assert.equal(await reader(fakeSpawn({text:JSON.stringify(input)}))(),null);
  }
});
