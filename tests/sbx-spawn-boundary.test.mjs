import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {spawnSbxChild} from '../lib/docker-backend.mjs';
import {createSbxRuntime,hostDefaultSbxRuntime,withSbxRuntime,describeSbxRuntime} from '../lib/sbx-runtime.mjs';
for(const mode of ['buffered','spawn','sync','callback','execve'])for(const valid of [true,false])test(`${mode} requires a qualified runtime immediately before the process primitive (${valid?'accepted':'refused'})`,t=>{
 const configured=process.env.FARAVAN_SBX_BIN;process.env.FARAVAN_SBX_BIN='/configured/sbx';
 t.after(()=>{if(configured===undefined)delete process.env.FARAVAN_SBX_BIN;else process.env.FARAVAN_SBX_BIN=configured;});
 const events=[];let allowed=valid;
 const runtime=createSbxRuntime({path:'/qualified/sbx',fence:()=>{events.push('fence');if(!allowed)throw Object.assign(new Error('Unavailable'),{code:'claude_account_unavailable'});}});
 const launch=(...args)=>{events.push('spawn');assert.equal(args[0],'/qualified/sbx');return 'child';};
 const primitives={execFile:launch,spawn:launch,spawnSync:launch,execFileCb:launch,execve:launch};
 const options={mode,command:'systemd-run',delegatedArgs:['--'],callback(){}};
 const run=()=>spawnSbxChild(runtime,['version'],options,primitives);
 if(valid){assert.equal(run(),'child');assert.deepEqual(events,['fence','spawn']);}
 else {assert.throws(run);assert.deepEqual(events,['fence']);}
 assert.throws(()=>spawnSbxChild(null,['version'],options,primitives));
 assert.throws(()=>spawnSbxChild({path:'/unqualified/sbx'},['version'],options,primitives));
});
test('an account context cannot be downgraded to an explicit host-default runtime',()=>{
 const account=createSbxRuntime({path:'/qualified/sbx',fence(){}});
 const host=hostDefaultSbxRuntime({binary:process.execPath});
 withSbxRuntime(account,()=>assert.throws(()=>spawnSbxChild(host,['version'],{}, {execFile(){assert.fail('downgrade spawned');}})));
});
test('the choke point contains no await and always validates before dispatch',()=>{
 const source=readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 const fn=ast.body.map(n=>n.declaration??n).find(n=>n.id?.name==='spawnSbxChild');
 const first=fn.body.body[0];assert.equal(first.expression?.callee.name,'assertSbxRuntime');
 function check(node){if(!node||typeof node!=='object')return;assert.notEqual(node.type,'AwaitExpression');for(const child of Object.values(node))if(Array.isArray(child))child.forEach(check);else if(child?.type)check(child);}
 check(fn.body);
});

for(const valid of [true,false])test(`delegated launch ${valid?'pins a serializable runtime':'refuses before systemd-run'}`,()=>{
 const descriptor=describeSbxRuntime(hostDefaultSbxRuntime({binary:process.execPath})),events=[];
 const runtime=createSbxRuntime({path:descriptor.binary.path,kind:descriptor.kind,descriptor,fence:()=>{events.push('fence');if(!valid)throw new Error('Refused');}});
 const launch=()=>spawnSbxChild(runtime,['daemon','start'],{mode:'delegated',command:'systemd-run',delegatedArgs:['--user','--']},{execFile:(command,args)=>{
  events.push('spawn');assert.equal(command,'systemd-run');assert.equal(args[2],process.execPath);
  assert.match(args[3],/lib\/sbx-exec-launch\.mjs$/);
  assert.deepEqual(JSON.parse(Buffer.from(args[4],'base64url').toString('utf8')),descriptor);
  assert.deepEqual(args.slice(5),['daemon','start']);return 'child';
 }});
 if(valid){assert.equal(launch(),'child');assert.deepEqual(events,['fence','spawn']);}
 else {assert.throws(launch);assert.deepEqual(events,['fence']);}
});
