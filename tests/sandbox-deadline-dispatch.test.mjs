import './helpers/no-browser.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';import {transportPrelude,transportGlobals} from './helpers/sbx-transport-fixture.mjs';import {EventEmitter} from 'node:events';import {Readable,PassThrough} from 'node:stream';
const source=fs.readFileSync(new URL('../lib/docker-backend.mjs',import.meta.url),'utf8');
for(const mode of ['buffered','streaming','output'])for(const timing of ['before','daemon','environment','active'])test(timing==='active'?mode+' permits a protected dispatch':mode+' refuses lost enforcement '+timing,async()=>{
  let active=timing!=='before',spawns=0,checks=0;const context=new AsyncLocalStorage();
  const child=()=>{spawns++;const c=new EventEmitter();Object.assign(c,{stdout:Readable.from([Buffer.from('data')]),stderr:new PassThrough(),stdin:{on(){},end(){}},exitCode:0,kill(){}});setImmediate(()=>c.emit('close',0));return c;};
  const scope={...transportGlobals,daemonJobContext:context,needsSbxDaemon:()=>true,ensureSbxDaemon:async()=>{if(timing==='daemon')active=false;},sbxBin:()=>'/fake/sbx',sbxChildEnv:()=>{if(timing==='environment')active=false;return {};},recordDaemonLaunch:()=>{},policyError:(code,message)=>Object.assign(Error(message),{code}),SbxDaemonVerificationError:class extends Error{},spawn:child,
    execFile:()=>Object.assign(Promise.resolve({stdout:'',stderr:''}),{child:child()}),Buffer,setImmediate};
  vm.createContext(scope);vm.runInContext(transportPrelude(source)+source.slice(source.indexOf('async function runSbx('),source.indexOf('function outputOf(')),scope);const gate={binary:'/fake/sbx',beforeSpawn(){}},runtime=transportGlobals.createSbxRuntime({path:'/fake/sbx',fence(){}});
  const beforeExec=async launch=>{checks++;if(!active)throw Error('inactive deadline');return launch();};
  await context.run({beforeExec},async()=>{
    try{if(mode==='buffered')await scope.runSbx(['exec','wf-fixture','--','true'],gate);
    else if(mode==='streaming')await scope.runSbxStreaming(['exec','wf-fixture','--','true'],null,null,null,null,gate);
    else for await(const chunk of scope.streamSbxOutput({sandbox_id:'wf-fixture',_sbxRuntime:runtime},'/output',{beforeExec}))void chunk;}catch{}
  });
  assert.equal(spawns,timing==='active'?1:0);assert.ok(checks>0);
});
test('every raw sbx exec transport belongs to the gated transport census',()=>{
  const body=source.slice(source.indexOf('async function runSbx('),source.indexOf('function outputOf('));
  const sites=[...body.matchAll(/\bspawnSbxChild\(runtime,args/g)];
  assert.equal(sites.length,3,'a new raw transport needs an admission regression');
  for(const name of ['runSbx','runSbxStreaming','streamSbxOutput']){
    const start=source.indexOf('function'+(name==='streamSbxOutput'?'*':'')+' '+name+'(');
    const end=source.indexOf('\n}',start);assert.match(source.slice(start,end),/dispatchSbx\(/);
  }
});
for(const command of ['create','run'])test(command+' is also fenced after daemon preparation',async()=>{
 let spawns=0,active=true;const context=new AsyncLocalStorage();
 const scope={sbxBin:()=>'/fake/sbx',sbxChildEnv:()=>({}),daemonJobContext:context,needsSbxDaemon:()=>true,ensureSbxDaemon:async()=>{active=false;},policyError:(_code,message)=>Error(message)};vm.createContext(scope);
 const start=source.indexOf('async function dispatchSbx('),end=source.indexOf('\n}',start)+2;
 assert.ok(start>=0);vm.runInContext(source.slice(start,end),scope);
 await assert.rejects(context.run({beforeExec:async()=>{if(!active)throw Error('inactive');}},()=>scope.dispatchSbx([command],{},()=>{spawns++;})),/inactive/);
 assert.equal(spawns,0);
});
test('the final class check is synchronous with process dispatch',async()=>{
 const start=source.indexOf('  async _dispatchProtected(');assert.ok(start>=0);
 const end=source.indexOf('\n  async ',start+10);const scope={policyError:(code,message)=>Object.assign(Error(message),{code}),sandboxDeadlineRemaining:()=>1000};vm.createContext(scope);
 const method=vm.runInContext('({'+source.slice(start,end)+'})._dispatchProtected',scope);
 let spawned=false;const backend={assertActive:async()=>{},cleanupJournal:{authority:()=>({deadline_enforcer:{}})},sandboxDeadlines:{activeSync:()=>false},monotonic:()=>0,deadlineClock:()=>({})};
 await assert.rejects(method.call(backend,{},undefined,()=>{spawned=true;}));assert.equal(spawned,false);
});
