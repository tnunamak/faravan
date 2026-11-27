import './helpers/no-browser.mjs';
import {superviseBound} from './helpers/supervise-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {sandboxDeadlineClock,sandboxDeadlineReservation,sandboxDeadlineRemaining,createSandboxDeadlineManager} from '../lib/sandbox-deadline.mjs';
import {superviseSandboxDeadline} from '../lib/sandbox-deadline-supervisor.mjs';

const session='12345678-1234-4234-8234-123456789abc';
function source() {
  let wall=10000,boot=4000n*1000000n,uuid=session,reads=0;
  const clock=()=>sandboxDeadlineClock({platform:'darwin',now:()=>wall,hrtime:()=>boot,
    bootSession:()=>{reads++;return uuid;}});
  return {clock,setWall:value=>wall=value,setBoot:value=>boot=BigInt(value)*1000000n,setSession:value=>uuid=value,reads:()=>reads};
}

test('Darwin reservation and guard ignore wall jumps until real boot expiry',async()=>{
  const s=source(),reserved=sandboxDeadlineReservation(60000,s.clock());
  assert.equal(reserved.deadline_clock.boot_id,'darwin:'+session);
  assert.equal(reserved.deadline_clock.boot_at,184000);
  s.setWall(3610000);
  assert.equal(sandboxDeadlineRemaining(reserved,s.clock()),180000);
  let pauses=0;const commands=[];
  await superviseBound(superviseSandboxDeadline,{...reserved,sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake',binary:'/fake/sbx'},
    {clock:s.clock,readRecord:()=>({create_settled:true}),pause:async()=>{assert.equal(commands.length,0);pauses++;s.setBoot(184000);},
      run:async args=>{commands.push(args[0]);return {code:0,stdout:'[]'};}});
  assert.equal(pauses,1);assert.deepEqual(commands,['ls','rm','ls']);
});

test('Darwin changed boot session expires the reservation immediately',()=>{
  const s=source(),reserved=sandboxDeadlineReservation(60000,s.clock());
  s.setSession('abcdefab-1234-4234-8234-123456789abc');
  assert.equal(sandboxDeadlineRemaining(reserved,s.clock()),0);
});

for(const bad of ['missing session','invalid time','throwing source'])test('Darwin '+bad+' refuses launch authority',async()=>{
  const clock=()=>sandboxDeadlineClock({platform:'darwin',now:()=>10000,
    hrtime:()=>bad==='invalid time'?-1n:4000000000n,
    bootSession:()=>{if(bad==='throwing source')throw Error('unreadable');return bad==='missing session'?'':session;}});
  assert.throws(clock);
  const m=createSandboxDeadlineManager({platform:'darwin',clock,binary:'/fake/sbx',spawnGuard:()=>assert.fail('must not launch')});
  await assert.rejects(m.register({sandbox_id:'dl-0123456789abcdef',sbx_home:'/fake',deadline_at:190000,
    deadline_clock:{version:1,boot_id:'darwin:'+session,boot_at:184000}}));
});

for(const fails of [false,true])test('Darwin sysctl is bounded and cached, failure='+fails,async t=>{
  let calls=0;
  t.mock.method(childProcess,'execFileSync',(binary,args,options)=>{
    calls++;assert.equal(binary,'/usr/sbin/sysctl');assert.deepEqual(args,['-n','kern.bootsessionuuid']);
    assert.equal(options.timeout,1000);assert.equal(options.maxBuffer,1024);
    if(fails)throw Error('unreadable');return session+'\n';
  });
  syncBuiltinESMExports();
  try {
    const {sandboxDeadlineClock:read}=await import('../lib/sandbox-deadline.mjs?sysctl='+fails);
    for(let i=0;i<10;i++) {
      const clock=()=>read({platform:'darwin',now:()=>10000,hrtime:()=>4000000000n});
      if(fails)assert.throws(clock,/unavailable/);else assert.equal(clock().boot_id,'darwin:'+session);
    }
    assert.equal(calls,1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
