import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm,rename,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareRunner,createNativeCallbacks,originalGone,readControl,serveHelper} from '../lib/v1/macos-update-helper.mjs';
const exchange=async(a,b)=>{const temp=a+'.test-exchange';await rename(a,temp);await rename(b,a);await rename(temp,b);};
const protocol='faravan-mac-update-helper-v1',nonce='a'.repeat(64),birth={boot:'darwin:boot',start:'123',state:'live'};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'mac-runner-')),capsule=join(root,'capsule'),home=join(root,'home'),appPath=join(root,'Faravan.app');
  await mkdir(capsule,{mode:0o700});await mkdir(join(home,'v1'),{recursive:true});
  const controlPath=join(capsule,'.handoff-control.json');
  const control=state=>writeFile(controlPath,JSON.stringify({protocol,nonce,state}),{mode:0o600});await control('prepared');
  const owners=['app','native','tray'].map((role,i)=>({role,pid:i+21,...birth}));
  const spec={appPath,home,journalPath:appPath+'.update-journal.json',version:'1.0.2',previousVersion:'1.0.1',channel:'faravan',bundleId:'com.example.app',oldOwners:owners,stopTimeoutMs:100,readyTimeoutMs:150};
  async function bundle(path,version) {await mkdir(path,{recursive:true});for(const name of ['launcher','runtime','tray'])await writeFile(join(path,name),version);}
  await bundle(appPath,'1.0.1');await bundle(appPath+'.next','1.0.2');
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,capsule,home,appPath,controlPath,control,owners,spec,message:{protocol,type:'prepare',nonce,controlPath,spec}};
}

test('identity errors refuse cessation while ESRCH and changed birth prove it',async()=>{
  const owner={pid:21,...birth};
  assert.equal(await originalGone(owner,{probe:()=>{throw Object.assign(Error(),{code:'ESRCH'});},identity:assert.fail}),true);
  assert.equal(await originalGone(owner,{probe:()=>{},identity:async()=>({...birth,start:'124'})}),true);
  await assert.rejects(originalGone(owner,{probe:()=>{},identity:async()=>{throw Error('ambiguous');}}),{code:'ownership_unknown'});
  await assert.rejects(originalGone(owner,{probe:()=>{throw Object.assign(Error(),{code:'EPERM'});},identity:assert.fail}),{code:'ownership_unknown'});
});

test('real bundle transaction only starts after all owned old processes cease',async t=>{
  const f=await fixture(t),events=[];let live=true;
  const factory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),
    quiescent:async()=>{events.push('quiet');return !live;},releaseLocks:()=>{},
    verifyBundle:async(path,v)=>(await readFile(join(path,'runtime'),'utf8'))===v,
    launch:async(path,info)=>{events.push('launch:'+info.version);return {};},
    waitReady:async(_handle,info)=>({...info,authenticated:true}),stopOwnedLaunch:async()=>true});
  const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange});
  setTimeout(()=>{live=false;},30);assert.equal(await runner.run(),'committed');
  assert.deepEqual(events.slice(0,2),['quiet','quiet']);
  assert.equal(await readFile(join(f.appPath,'launcher'),'utf8'),'1.0.2');
  assert.equal(await readFile(join(f.appPath+'.previous','runtime'),'utf8'),'1.0.1');
});

test('revocation after preparation refuses before bundle rename',async t=>{
  const f=await fixture(t);
  const callbacksFactory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),quiescent:async()=>true,releaseLocks:()=>{},
    verifyBundle:async()=>true,launch:assert.fail,waitReady:assert.fail,stopOwnedLaunch:assert.fail});
  const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory,exchange});await f.control('cancelled');
  await assert.rejects(runner.run(),{code:'revoked'});
  assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.1');
});

test('default callbacks preserve launcher argv and require authenticated exact readiness',async t=>{
  const f=await fixture(t),calls=[];
  await writeFile(join(f.home,'v1','app.json'),JSON.stringify({pid:50,port:1234,token:'secret'}));
  const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,
    exec:async(command,args)=>{calls.push({command,args});return {stdout:JSON.stringify(birth)};},
    spawnProcess:(command,args,options)=>{calls.push({command,args,options});return {pid:100};},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:options.method!=='POST',json:async()=>({currentVersion:'1.0.2',updateBoot:{version:'1.0.2',appPath:f.appPath,home:f.home,transactionId:'tx',pid:50}})};},probe:()=>{}});
  const handle=await callbacks.launch(f.appPath,{version:'1.0.2',transactionId:'11111111-1111-1111-1111-111111111111'});
  assert.equal(calls[0].command,join(f.appPath,'Contents/MacOS/faravan-launch'));assert.deepEqual(calls[0].args,['--background']);
  const result=await callbacks.waitReady(handle,{appPath:f.appPath,version:'1.0.2',transactionId:'tx'});
  assert.equal(result.authenticated,true);const request=calls.find(x=>x.url);assert.equal(request.options.headers['x-faravan-session-token'],'secret');
  assert.equal(request.options.redirect,'error');assert.ok(!request.url.includes('secret'));
  assert.equal(await callbacks.stopOwnedLaunch(handle),false);
});

test('same profile discovery and live old identities refuse quiescence',async t=>{
  const f=await fixture(t);let gone=false;
  const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,
    exec:async()=>({stdout:JSON.stringify(birth)}),probe:()=>{if(gone)throw Object.assign(Error(),{code:'ESRCH'});},acquire:async()=>()=>{}});
  assert.equal(await callbacks.quiescent(),false);gone=true;
  await writeFile(join(f.home,'v1','app.json'),'{}');assert.equal(await callbacks.quiescent(),false);
  assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.1');
});

test('IPC sends ready only after preparation and cancellation does not run transaction',async()=>{
  const channel=new EventEmitter(),events=[];channel.send=(m,cb)=>{events.push(m.type);cb?.();};channel.disconnect=()=>channel.emit('disconnect');
  let complete;const pending=new Promise(r=>{complete=r;});
  await serveHelper({channel,capsule:'/fixture',prepare:async()=>{await pending;return {run:async()=>events.push('run')};}});
  channel.emit('message',{protocol,type:'prepare',nonce});assert.deepEqual(events,[]);complete();await new Promise(r=>setImmediate(r));
  assert.deepEqual(events,['ready']);channel.emit('message',{protocol,type:'cancel',nonce});await new Promise(r=>setImmediate(r));
  assert.deepEqual(events,['ready','cancelled']);
});

test('failed candidate readiness stops owned candidate and restores the whole old bundle',async t=>{
  const f=await fixture(t),events=[];
  const factory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),quiescent:async()=>true,releaseLocks:()=>{},
    verifyBundle:async(path,v)=>(await readFile(join(path,'runtime'),'utf8'))===v,
    launch:async(_path,info)=>{events.push('launch:'+info.version);return {version:info.version};},
    waitReady:async(_handle,info)=>info.rollback?{...info,authenticated:true}:null,
    stopOwnedLaunch:async handle=>{events.push('stop:'+handle.version);return true;}});
  const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange});
  await assert.rejects(runner.run(),{code:'not_ready'});
  for(const part of ['launcher','runtime','tray'])assert.equal(await readFile(join(f.appPath,part),'utf8'),'1.0.1');
  assert.deepEqual(events,['launch:1.0.2','stop:1.0.2','launch:1.0.1']);
});

test('wrong authenticated boot proof and unauthorized response do not pass readiness',async t=>{
  const f=await fixture(t);await writeFile(join(f.home,'v1','app.json'),JSON.stringify({pid:50,port:1234,token:'secret'}));
  for(const kind of ['nonce','version','profile','install','auth']) {
    let clock=0;const proof={version:'1.0.2',appPath:f.appPath,home:f.home,transactionId:'tx',pid:50};
    if(kind==='nonce')proof.transactionId='wrong';if(kind==='profile')proof.home='/wrong';if(kind==='install')proof.appPath='/wrong';
    const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,now:()=>clock,sleep:async()=>{clock+=100;},
      exec:async()=>({stdout:JSON.stringify(birth)}),probe:()=>{},
      fetch:async()=>({ok:kind!=='auth',json:async()=>({currentVersion:kind==='version'?'1.0.1':'1.0.2',updateBoot:proof})})});
    assert.equal(await callbacks.waitReady({}, {appPath:f.appPath,version:'1.0.2',transactionId:'tx'}),null);
  }
});


test('production callbacks refuse preparation outside the native platform',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepareRunner(f.message,{capsule:f.capsule}),{code:'runner_unavailable'});
});

test('owned resident stops through authenticated idle Quit without signalling the launcher',async t=>{
  const f=await fixture(t),calls=[];let gone=false;
  const record={pid:50,port:1234,token:'fixture-session'};
  await writeFile(join(f.home,'v1','app.json'),JSON.stringify(record));
  const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,
    exec:async()=>({stdout:JSON.stringify(birth)}),probe:(_pid,signal)=>{assert.equal(signal,0);if(gone)throw Object.assign(Error(),{code:'ESRCH'});},
    fetch:async(url,options)=>{calls.push({url,options});if(options.method==='POST'){gone=true;return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};}
      return {ok:true,json:async()=>({currentVersion:f.spec.version,updateBoot:{version:'1.0.2',appPath:f.appPath,home:f.home,transactionId:'tx',pid:50}})};}});
  const handle={};assert.equal((await callbacks.waitReady(handle,{appPath:f.appPath,version:f.spec.version,transactionId:'tx'})).authenticated,true);
  assert.equal(await callbacks.stopOwnedLaunch(handle),true);
  const quit=calls.find(c=>c.options.method==='POST');assert.equal(quit.url,'http://127.0.0.1:1234/api/shutdown');
  assert.equal(quit.options.body,'{}');assert.equal(quit.options.headers['x-faravan-session-token'],record.token);
  assert.equal(quit.options.redirect,'error');assert.ok(!quit.url.includes(record.token));
});

test('changed resident identity or rejected Quit cannot authorize a forced stop',async t=>{
  for(const changed of ['discovery','proof','busy']) {
    const f=await fixture(t);let quit=0;
    const record={pid:50,port:1234,token:'fixture-session'};await writeFile(join(f.home,'v1','app.json'),JSON.stringify(record));
    const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,
      exec:async()=>({stdout:JSON.stringify(birth)}),probe:()=>{},fetch:async(_url,options)=>{
        if(options.method==='POST'){quit++;return {ok:false};}
        return {ok:true,json:async()=>({updateBoot:{version:'1.0.2',appPath:f.appPath,home:f.home,transactionId:changed==='proof'?'wrong':'tx',pid:50}})};
      }});
    const handle={resident:{...record,birth,appPath:f.appPath,transactionId:'tx'}};
    if(changed==='discovery')await writeFile(join(f.home,'v1','app.json'),JSON.stringify({...record,token:'replacement-session'}));
    assert.equal(await callbacks.stopOwnedLaunch(handle),false);assert.equal(quit,changed==='busy'?1:0);
  }
});

test('recovery mode uses the matching journal and restores the reachable old bundle',async t=>{
  const f=await fixture(t), events=[];
  const factory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),quiescent:async()=>true,releaseLocks:()=>{},
    verifyBundle:async(path,v)=>{try{return (await readFile(join(path,'runtime'),'utf8'))===v;}catch{return false;}},
    launch:async(_path,info)=>{events.push(info.version);return {};},waitReady:async(_h,info)=>({...info,authenticated:true}),stopOwnedLaunch:async()=>true});
  const apply=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange:async(a,b)=>{await exchange(a,b);throw Object.assign(Error('crash'),{simulatedCrash:true});}});
  await assert.rejects(apply.run(),/crash/);
  assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.2');
  const recovery=await prepareRunner({...f.message,spec:{...f.spec,mode:'recover'}},{capsule:f.capsule,callbacksFactory:factory,exchange});
  assert.equal(await recovery.run(),'rolled-back');assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.1');assert.deepEqual(events,['1.0.1']);
});

test('helper holds install lock while waiting for old processes',async t=>{
  const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
  const f=await fixture(t);let releaseWait,entered;const wait=new Promise(r=>{releaseWait=r;}),started=new Promise(r=>{entered=r;});
  const factory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),quiescent:async()=>{entered();await wait;return true;},releaseLocks:()=>{},
    verifyBundle:async(path,v)=>(await readFile(join(path,'runtime'),'utf8'))===v,
    launch:async()=>({}),waitReady:async(_h,info)=>({...info,authenticated:true}),stopOwnedLaunch:async()=>true});
  const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange});
  const task=runner.run();await started;
  await assert.rejects(acquireProcessLock(f.appPath+'.update.lock',{timeoutMs:0}),{code:'lock_busy'});
  releaseWait();assert.equal(await task,'committed');
});

// A person who clicks Update must never be left with a stopped app and no message.
const journalFor=(f,extra)=>({schema:1,id:'11111111-1111-4111-8111-111111111111',appPath:f.appPath,version:'1.0.1',previousVersion:'1.0.0',phase:'committed',...extra});
const writeJournal=(f,journal)=>writeFile(f.spec.journalPath,JSON.stringify(journal),{mode:0o600});
function guarded(f,{restarts=[],quiescent=async()=>true,verifyBundle}={}){
  const events=[];
  const factory=()=>({safeRollback:true,identity:async()=>birth,authority:()=>readControl(f.capsule,f.controlPath,nonce),releaseLocks:()=>{},
    quiescent:async()=>{events.push('quiescent');return quiescent();},
    verifyBundle:verifyBundle??(async(path,v)=>{try{return (await readFile(join(path,'runtime'),'utf8'))===v;}catch{return false;}}),
    launch:async()=>{events.push('launch');return {};},waitReady:async(_h,info)=>({...info,authenticated:true}),stopOwnedLaunch:async()=>true,
    restart:async path=>{restarts.push(path);}});
  return {factory,events};
}

test('a layout or journal the transaction would refuse is refused before the helper is ready, so nothing is stopped',async t=>{
  const cases={
    'previous bundle with no journal':{code:'invalid_layout',setup:async f=>{await mkdir(f.appPath+'.previous');}},
    'unfinished transaction':{code:'recovery_required',setup:async f=>writeJournal(f,journalFor(f,{phase:'starting'}))},
    'candidate already failed':{code:'failed_version',setup:async f=>writeJournal(f,journalFor(f,{version:'1.0.2',previousVersion:'1.0.1',phase:'rolled-back'}))},
    'unreadable journal':{code:'invalid_journal',setup:async f=>writeFile(f.spec.journalPath,'{',{mode:0o600})},
    'journal for another version':{code:'invalid_version',setup:async f=>writeJournal(f,journalFor(f,{version:'1.0.9',previousVersion:'1.0.8'}))},
  };
  for(const [name,{code,setup}] of Object.entries(cases)) {
    const f=await fixture(t),restarts=[],{factory,events}=guarded(f,{restarts});await setup(f);
    await assert.rejects(prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange}),{code},name);
    assert.deepEqual(events,[],name+': no process was waited for or stopped');assert.deepEqual(restarts,[],name);
    assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.1',name);
  }
});

test('the helper still prepares a layout the transaction accepts: none, or a finished transaction with a retired previous bundle',async t=>{
  const f=await fixture(t),{factory}=guarded(f);
  assert.ok(await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:factory,exchange}));
  const g=await fixture(t);await mkdir(g.appPath+'.previous');await writeJournal(g,journalFor(g));
  assert.ok(await prepareRunner(g.message,{capsule:g.capsule,callbacksFactory:guarded(g).factory,exchange}));
});

test('a refusal after the old app has stopped starts the installed app again and leaves a note',async t=>{
  const refusals={
    'old app never ceased':{code:'not_quiescent',factory:f=>guarded(f,{quiescent:async()=>false})},
    'retired previous bundle fails verification':{code:'invalid_bundle',setup:async f=>{await mkdir(f.appPath+'.previous');await writeJournal(f,journalFor(f));},factory:f=>guarded(f)},
  };
  for(const [name,{code,setup,factory}] of Object.entries(refusals)) {
    const f=await fixture(t);await setup?.(f);const restarts=[],g=factory(f);
    const callbacks=()=>({...g.factory(),restart:async path=>{restarts.push(path);}});
    const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:callbacks,exchange});
    await assert.rejects(runner.run(),{code},name);
    assert.deepEqual(restarts,[f.appPath],name);assert.ok(!g.events.includes('launch'),name+': the candidate never started');
    const note=JSON.parse(await readFile(join(f.home,'v1','macos-update-refusal.json'),'utf8'));
    assert.deepEqual({version:note.version,previousVersion:note.previousVersion,code:note.code},{version:'1.0.2',previousVersion:'1.0.1',code},name);
    assert.equal(await readFile(join(f.appPath,'runtime'),'utf8'),'1.0.1',name);
  }
});

test('a failure after the swap began is left to rollback: no extra restart, no note',async t=>{
  const f=await fixture(t),restarts=[],g=guarded(f,{restarts});
  const callbacks=()=>({...g.factory(),waitReady:async(_h,info)=>info.rollback?{...info,authenticated:true}:null});
  const runner=await prepareRunner(f.message,{capsule:f.capsule,callbacksFactory:callbacks,exchange});
  await assert.rejects(runner.run(),{code:'not_ready'});
  assert.deepEqual(restarts,[]);await assert.rejects(readFile(join(f.home,'v1','macos-update-refusal.json')),{code:'ENOENT'});
});

test('default restart starts the installed launcher with no boot request',async t=>{
  const f=await fixture(t),calls=[];
  const callbacks=createNativeCallbacks(f.spec,{capsule:f.capsule,nonce,controlPath:f.controlPath,exec:async()=>({stdout:JSON.stringify(birth)}),
    spawnProcess:(command,args,options)=>{calls.push({command,args,options});return {pid:100,unref(){}};}});
  await callbacks.restart(f.appPath);
  assert.equal(calls[0].command,join(f.appPath,'Contents/MacOS/faravan-launch'));assert.deepEqual(calls[0].args,['--background']);
  await assert.rejects(readFile(join(f.home,'v1','update-boot.json')),{code:'ENOENT'});
});
