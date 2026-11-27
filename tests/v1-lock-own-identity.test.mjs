import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';

for(const platform of ['linux','darwin','win32']) {
  test(platform+' retries a transient own identity probe, then recovers after crash and PID reuse',async t=>{
    const root=fs.mkdtempSync(join(tmpdir(),'lock-identity-')),lock=join(root,'lock');
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const module=new URL('../lib/v1/lock.mjs',import.meta.url).href;
    const script=`import {acquireProcessLockSync} from ${JSON.stringify(module)};
      let reads=0;const probe=()=>{if(++reads===1)throw Error('temporary identity failure');
        return ${JSON.stringify(platform==='win32'?'/Date(100)/':{boot:'boot-1',start:'100'})};};
      acquireProcessLockSync(process.argv[1],{platform:${JSON.stringify(platform)},identityReader:probe,posixIdentityReader:probe});
      process.send({reads});setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',script,lock],{stdio:['ignore','ignore','ignore','ipc']});
    const exited=once(child,'exit');
    try {
      const [{reads}]=await Promise.race([once(child,'message'),exited.then(()=>{throw Error('identity child exited before acquiring');})]);
      const directory=lock+'.owners-v1',entry=fs.readdirSync(directory).find(name=>name.endsWith('.choosing'));
      const record=JSON.parse(platform==='win32'?fs.readFileSync(join(directory,entry),'utf8'):fs.readlinkSync(join(directory,entry)));
      child.kill('SIGKILL');await exited;
      let observedOld=false;
      const probe=pid=>{
        if(pid===child.pid)observedOld=true;
        return platform==='win32'?(pid===child.pid?'/Date(200)/':'/Date(300)/'):{boot:'boot-1',start:pid===child.pid?'200':'300'};
      };
      const release=acquireProcessLockSync(lock,{platform,identityReader:probe,posixIdentityReader:probe,processKill:()=>{}});
      release();assert.equal(observedOld,true,'recovery checks the reused live PID identity');
      assert.equal(reads,2);assert.equal(record.start,platform==='win32'?'/Date(100)/':'100');
      if(platform!=='win32')assert.equal(record.boot,'boot-1');
    }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
  });

  test(platform+' fails with no published owner after bounded identity probe failures',()=>{
    const root=fs.mkdtempSync(join(tmpdir(),'lock-identity-')),lock=join(root,'lock');let calls=0,release;
    const probe=()=>{calls++;throw Error('identity unavailable');};
    try {
      assert.throws(()=>{release=acquireProcessLockSync(lock,{platform,identityReader:probe,posixIdentityReader:probe});},
        error=>error.code==='lock_identity_unavailable'&&/could not verify.*identity/i.test(error.message));
      assert.equal(calls,3);
      assert.deepEqual(fs.existsSync(lock+'.owners-v1')?fs.readdirSync(lock+'.owners-v1'):[],[]);
    }finally{release?.();fs.rmSync(root,{recursive:true,force:true});}
  });
}

test('an existing unverifiable owner is preserved when its PID appears live',()=>{
  const root=fs.mkdtempSync(join(tmpdir(),'lock-identity-')),lock=join(root,'lock'),directory=lock+'.owners-v1';
  const token='11111111-1111-1111-1111-111111111111';
  let namespace=null;try{namespace=fs.readlinkSync('/proc/self/ns/pid');}catch{}
  const record={version:1,host:hostname(),namespace:process.platform==='win32'?null:namespace,pid:process.pid,boot:null,start:'100',token};
  fs.mkdirSync(directory);
  const write=(name,value)=>process.platform==='win32'?fs.writeFileSync(join(directory,name),JSON.stringify(value)):fs.symlinkSync(JSON.stringify(value),join(directory,name));
  write(token+'.choosing',record);write(token+'.ticket',{...record,ticket:'1'});
  try {
    assert.throws(()=>acquireProcessLockSync(lock,{processKill:()=>{},identityReader:()=>'/Date(300)/',posixIdentityReader:()=>({boot:'verified-boot',start:'300'})}),
      error=>error.reason==='lock_stale');
    assert.deepEqual(fs.readdirSync(directory).sort(),[token+'.choosing',token+'.ticket']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
