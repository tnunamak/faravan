import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createNativeCallbacks} from '../lib/v1/macos-update-helper.mjs';
import {join} from 'node:path';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {writeMacUpdateBoot,readMacUpdateBoot,macUpdateBootReleased} from '../lib/v1/macos-update-boot.mjs';

const id='11111111-1111-1111-1111-111111111111';
async function setup(t,name='boot') {
  const f=await appFixture(t),home=await f.home(name),appPath=join(f.root,'Faravan.app'),journalPath=appPath+'.update-journal.json';
  await mkdir(join(home,'v1'),{recursive:true});
  const identity={appPath,version:'1.0.2',channel:'faravan',bundleId:'com.example.app'};
  const request={schema:1,transactionId:id,home,journalPath,...identity,expiresAt:Date.now()+300000};
  await writeMacUpdateBoot(request);
  return {f,home,identity,request,journalPath};
}
async function journal(f,phase,extra={}) {
  await writeFile(f.journalPath,JSON.stringify({schema:1,id,appPath:f.identity.appPath,home:f.home,channel:f.identity.channel,bundleId:f.identity.bundleId,version:'1.0.2',previousVersion:'1.0.1',phase,...extra}),{mode:0o600});
}

test('real app publishes authenticated boot proof and blocks On until matching commit', {timeout:30000},async t=>{
  const f=await setup(t);await journal(f,'starting');
  const {app,backend}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:'1.0.2',updateBootPollMs:20});
  const status=await api(app,'/api/updates');assert.deepEqual(status.updateBoot,{appPath:f.identity.appPath,home:f.home,version:'1.0.2',transactionId:id,pid:process.pid});assert.equal(status.updateHold,true);
  assert.equal((await api(app,'/api/lending/on',{method:'POST',body:{},status:409})).code,'update_in_progress');
  assert.equal((await api(app,'/api/lending/resume',{method:'POST',body:{},status:409})).code,'update_in_progress');
  assert.equal(backend.calls.some(c=>['admit','run'].includes(c[0])),false);
  await journal(f,'starting');assert.equal((await api(app,'/api/updates')).updateHold,true);
  await journal(f,'committed',{id:'22222222-2222-2222-2222-222222222222'});assert.equal(await macUpdateBootReleased(f.request),false);
  await journal(f,'committed');await waitFor(async()=>!(await api(app,'/api/updates')).updateHold,'boot hold release');
  assert.equal((await api(app,'/api/lending')).intent,'off');
});

test('invalid, expired or wrong install boot requests hold without proof',async t=>{
  const f=await setup(t);const data=await readFile(join(f.home,'v1','update-boot.json'),'utf8');
  for(const changed of [{transactionId:'wrong'},{version:'wrong'},{appPath:'/other/Faravan.app'},{expiresAt:Date.now()-1}]){
    await writeFile(join(f.home,'v1','update-boot.json'),JSON.stringify({...JSON.parse(data),...changed}),{mode:0o600});
    const result=await readMacUpdateBoot({home:f.home,identity:f.identity});assert.equal(result.held,true);assert.equal(result.proof,null);
  }
});

test('rollback releases only a request matching original version and exact transaction',async t=>{
  const f=await setup(t);const old={...f.request,version:'1.0.1'};await writeMacUpdateBoot(old);
  await journal(f,'restarting-old');assert.equal(await macUpdateBootReleased(old),false);
  await journal(f,'rolled-back');assert.equal(await macUpdateBootReleased(old),true);
  await journal(f,'rolled-back',{previousVersion:'1.0.0'});assert.equal(await macUpdateBootReleased(old),false);
});


test('helper writes request before native launch and reads real authenticated app proof', {timeout:30000},async t=>{
  const f=await setup(t);await rm(join(f.home,'v1','update-boot.json'));await journal(f,'starting');
  const capsule=join(f.f.root,'capsule');await mkdir(capsule,{mode:0o700});
  const nonce='a'.repeat(64),controlPath=join(capsule,'.handoff-control.json');
  await writeFile(controlPath,JSON.stringify({protocol:'faravan-mac-update-helper-v1',nonce,state:'prepared'}),{mode:0o600});
  const spec={...f.identity,home:f.home,journalPath:f.journalPath,oldOwners:[],readyTimeoutMs:1000};let observed;
  const callbacks=createNativeCallbacks(spec,{capsule,nonce,controlPath,
    exec:async()=>({stdout:JSON.stringify({boot:'darwin:fixture',start:'123',state:'live'})}),
    spawnProcess:()=>{observed=JSON.parse(readFileSync(join(f.home,'v1','update-boot.json'),'utf8'));return {pid:88};}});
  const handle=await callbacks.launch(f.identity.appPath,{version:f.identity.version,transactionId:id});
  assert.equal(observed.transactionId,id);assert.equal(observed.home,f.home);
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  const result=await callbacks.waitReady(handle,{appPath:f.identity.appPath,version:f.identity.version,transactionId:id});
  assert.equal(result.authenticated,true);assert.equal(handle.resident.pid,process.pid);
  assert.equal((await api(app,'/api/updates')).updateHold,true);
});

test('saved On waits for committed journal then resumes without changing intent', {timeout:30000},async t=>{
  const f=await appFixture(t),{owner,lender,circle}=await f.connect();
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  await lender.app.close();
  const identity={appPath:join(f.root,'Faravan.app'),version:'1.0.2',channel:'faravan',bundleId:'com.example.app'};
  const request={schema:1,transactionId:id,home:lender.home,journalPath:identity.appPath+'.update-journal.json',...identity,expiresAt:Date.now()+300000};
  await writeMacUpdateBoot(request);
  const writeJournal=phase=>writeFile(request.journalPath,JSON.stringify({schema:1,id,appPath:identity.appPath,home:lender.home,channel:identity.channel,bundleId:identity.bundleId,version:identity.version,previousVersion:'1.0.1',phase}),{mode:0o600});
  await writeJournal('starting');
  const restarted=await f.start('lender',{updateBootIdentity:identity,faravanVersion:identity.version,updateBootPollMs:20});
  assert.equal((await api(restarted.app,'/api/lending')).intent,'on');
  assert.equal((await api(restarted.app,'/api/lending/resume',{method:'POST',body:{circle:circle.id},status:409})).code,'update_in_progress');
  assert.equal(restarted.backend.calls.some(c=>['admit','run'].includes(c[0])),false);
  const before=f.networkTrace.filter(x=>x.device==='lender'&&x.route?.includes('claim-next')).length;
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),prompt:'Synthetic task.',harness:'codex'}});
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(f.networkTrace.filter(x=>x.device==='lender'&&x.route?.includes('claim-next')).length,before);
  await writeJournal('committed');
  await waitFor(async()=>{const state=await api(restarted.app,'/api/lending');return state.intent==='on'&&state.enabled;},'saved lending resumes',10000);
});


test('conflicting requests cannot replace the active transaction and symlink records hold',async t=>{
  const f=await setup(t);
  await assert.rejects(writeMacUpdateBoot({...f.request,transactionId:'22222222-2222-2222-2222-222222222222'}),/Conflicting/);
  const file=join(f.home,'v1','update-boot.json'),target=join(f.f.root,'target');
  await writeFile(target,JSON.stringify(f.request),{mode:0o600});await rm(file);await symlink(target,file);
  const result=await readMacUpdateBoot({home:f.home,identity:f.identity});assert.equal(result.held,true);assert.equal(result.proof,null);
});

test('missing boot request with an installed journal holds real app admission', {timeout:30000},async t=>{
  const f=await setup(t);await journal(f,'exchanging');await rm(join(f.home,'v1','update-boot.json'));
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  const status=await api(app,'/api/updates');assert.equal(status.updateHold,true);assert.equal(status.updateBoot,undefined);
  assert.equal((await api(app,'/api/lending/on',{method:'POST',body:{},status:409})).code,'update_in_progress');
});

test('expired matching request supplies no boot proof but terminal journal can release hold', {timeout:30000},async t=>{
  const f=await setup(t);await writeFile(join(f.home,'v1','update-boot.json'),JSON.stringify({...f.request,expiresAt:Date.now()-1}),{mode:0o600});
  await journal(f,'starting');const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  let status=await api(app,'/api/updates');assert.equal(status.updateHold,true);assert.equal(status.updateBoot,undefined);
  await journal(f,'committed');await waitFor(async()=>!(await api(app,'/api/updates')).updateHold,'terminal expired request release');
  status=await api(app,'/api/updates');assert.equal(status.updateBoot,undefined);
});

test('a matching terminal journal without a request does not strand a normal restart',async t=>{
  const f=await setup(t);await journal(f,'committed');await rm(join(f.home,'v1','update-boot.json'));
  const result=await readMacUpdateBoot({home:f.home,identity:f.identity});assert.equal(result.held,false);
  const other=await readMacUpdateBoot({home:f.home,identity:{...f.identity,bundleId:'com.other.app'}});assert.equal(other.held,true);
});

test('managed supervisor prepares recovery after its tray exists and closes only after helper ready', {timeout:30000},async t=>{
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
  const {superviseMacLaunch,managedProcessSnapshot}=await import('../lib/v1/macos-launch.mjs');
  const f=await setup(t);await journal(f,'exchanging');
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  const events=[];let releaseHeld,owners;
  const tray=new EventEmitter();tray.pid=333;tray.exitCode=null;tray.signalCode=null;tray.stdin=new PassThrough();
  const birth={boot:'darwin:fixture',start:'123',state:'live'};
  const done=superviseMacLaunch({home:f.home,trayPath:join(f.identity.appPath,'Contents/MacOS/faravan-tray'),background:true,
    ownerGone:new Promise(()=>{}),acquireLock:async()=>()=>{},discover:async()=>null,startApp:async()=>app,
    requestHandoff:async()=>'',openUrl:()=>{},spawnTray:()=>{events.push('tray');return tray;},
    onOwnedReady:async({app:owned,tray:child,signal,markHandoff})=>{
      const snapshot=()=>managedProcessSnapshot({appPath:f.identity.appPath,tray:child,pid:111,parentPid:222,pipeOwned:async()=>true,
        readParentExecutable:async()=>join(f.identity.appPath,'Contents/MacOS/faravan-launch'),readBirth:async()=>birth});
      await owned.recoverManagedUpdate({snapshot,signal,onHandoff:markHandoff,prepare:async options=>{
        events.push('prepare');owners=options.spec.oldOwners;releaseHeld=await options.exclusive();
        assert.equal(options.spec.mode,'recover');assert.equal(options.spec.journalPath,f.journalPath);
        assert.equal((await api(app,'/api/updates')).updateHold,true);
        events.push('ready');return {ready:true,cancel:async()=>releaseHeld()};
      }});events.push('closed');
    }});
  const result=await done;await waitFor(()=>events.includes('closed'),'managed close');
  assert.equal(result.reason,'app');assert.deepEqual(events,['tray','prepare','ready','closed']);
  assert.deepEqual(owners.map(o=>[o.role,o.pid]),[['app',111],['native',222],['tray',333]]);
  assert.equal(tray.stdin.writableEnded,true);await releaseHeld();
});

test('provisional Quit during managed recovery cancels and drains its ready ticket without handoff or close', {timeout:30000},async t=>{
  const f=await setup(t);await journal(f,'starting');
  const {app,backend}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,shutdownProofMs:1500});
  const preparing=Promise.withResolvers(),ready=Promise.withResolvers(),proving=Promise.withResolvers(),proof=Promise.withResolvers(),cancelling=Promise.withResolvers(),cancelled=Promise.withResolvers();
  let handoffs=0,cancelCalls=0,finished=false;
  t.after(()=>{ready.resolve();proof.resolve();cancelled.resolve();});
  const recovery=app.recoverManagedUpdate({snapshot:async()=>[],onHandoff:()=>{handoffs++;return true;},prepare:async options=>{
    const release=await options.exclusive();preparing.resolve();await ready.promise;
    return {ready:true,cancel:async()=>{cancelCalls++;cancelling.resolve();await cancelled.promise;await release();}};
  }}).then(value=>{finished=true;return {value};},error=>{finished=true;return {error};});
  await preparing.promise;
  backend.reconcilePending=async record=>{proving.resolve();await proof.promise;return {removed:false,attemptId:record.attemptId};};
  await writeFile(join(f.home,'v1','app-counters.json'),JSON.stringify({pending:{attemptId:'synthetic-attempt',...backend.sandboxOwnership(),attempt:{attempt_id:'synthetic-attempt',job_digest:'sha256:'+'a'.repeat(64),generation:1}}}));
  const quit=api(app,'/api/shutdown',{method:'POST',body:{},status:409}).then(value=>({value}),error=>({error}));
  await proving.promise;ready.resolve();
  await Promise.race([cancelling.promise,recovery]);
  assert.equal(handoffs,0,'a ready recovery ticket must honour the provisional Quit hold');
  assert.equal(cancelCalls,1);assert.equal(finished,false,'ticket cancellation must drain before recovery returns');
  cancelled.resolve();assert.equal((await recovery).error?.code,'EAGAIN','the native supervisor can retry once Quit releases its hold');
  assert.ok(await api(app,'/api/status'),'recovery refusal leaves the app open');
  proof.resolve();const refused=await quit;assert.equal(refused.error,undefined);assert.equal(refused.value.code,'cessation_unverified');
});

test('an existing transaction lock prevents a second helper and leaves app running', {timeout:30000},async t=>{
  const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
  const f=await setup(t);await journal(f,'starting');const release=await acquireProcessLock(f.identity.appPath+'.update.lock',{timeoutMs:0});
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});let spawned=false;
  await assert.rejects(app.recoverManagedUpdate({snapshot:async()=>[],prepare:async()=>{spawned=true;}}),{code:'lock_busy'});
  assert.equal(spawned,false);assert.equal((await api(app,'/api/updates')).updateHold,true);release();
});

test('owner shutdown cancels pending recovery instead of closing for handoff', {timeout:30000},async t=>{
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
  const {superviseMacLaunch}=await import('../lib/v1/macos-launch.mjs');
  const f=await setup(t);await journal(f,'starting');const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});
  let ownerGone,allowReady,entered,cancelled=0;const owner=new Promise(r=>{ownerGone=r;}),wait=new Promise(r=>{allowReady=r;}),started=new Promise(r=>{entered=r;});
  const tray=new EventEmitter();tray.pid=333;tray.exitCode=null;tray.signalCode=null;tray.stdin=new PassThrough();
  let recovery;
  const run=superviseMacLaunch({home:f.home,trayPath:'/fake/tray',background:true,ownerGone:owner,acquireLock:async()=>()=>{},discover:async()=>null,
    startApp:async()=>app,requestHandoff:async()=>'',openUrl:()=>{},spawnTray:()=>tray,
    onOwnedReady:({app:owned,signal,markHandoff})=>recovery=owned.recoverManagedUpdate({signal,onHandoff:markHandoff,
      snapshot:async()=>[],prepare:async options=>{const release=await options.exclusive();entered();
        await Promise.race([wait,new Promise(resolve=>{options.signal.addEventListener('abort',resolve,{once:true});if(options.signal.aborted)resolve();})]);
        return {ready:true,cancel:async()=>{cancelled++;await release();}};}})});
  await started;ownerGone();const result=await run;assert.equal(result.reason,'owner');allowReady();await recovery;assert.equal(cancelled,1);
});

test('invalid journal cannot invoke the helper', {timeout:30000},async t=>{
  const f=await setup(t);await writeFile(f.journalPath,'not json',{mode:0o600});
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});let called=false;
  await assert.rejects(app.recoverManagedUpdate({snapshot:async()=>[],prepare:async()=>{called=true;}}));
  assert.equal(called,false);assert.equal((await api(app,'/api/updates')).updateHold,true);
});

test('real bridge child acknowledges managed app recovery before orderly app close', {timeout:30000},async t=>{
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
  const {superviseMacLaunch}=await import('../lib/v1/macos-launch.mjs');
  const {prepareMacUpdateHelper}=await import('../lib/v1/macos-update-helper-bridge.mjs');
  const {recoveryFiles}=await import('../lib/v1/macos-update-recovery.mjs');
  const {dirname}=await import('node:path');
  const f=await setup(t);await journal(f,'starting');await mkdir(f.identity.appPath);
  for(const file of recoveryFiles){const target=join(f.identity.appPath,file.source);await mkdir(dirname(target),{recursive:true});
    const content=file.destination==='runtime/bin/node'?`#!/bin/sh\nexec '${process.execPath}' "$@"\n`:
      file.destination==='lib/v1/macos-update-helper.mjs'?`process.on('message',m=>{if(m.type==='prepare')process.send({protocol:m.protocol,type:'ready',nonce:m.nonce});if(m.type==='cancel')process.exit(0)});process.on('disconnect',()=>process.exit(0));`:'fixture';
    await writeFile(target,content,{mode:file.executable?0o700:0o600});}
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});
  const tray=new EventEmitter();tray.pid=333;tray.exitCode=null;tray.signalCode=null;tray.stdin=new PassThrough();
  const birth={boot:'darwin:fixture',start:'42',state:'live'},owners=['app','native','tray'].map((role,i)=>({role,pid:111+i,...birth}));
  let ticket,finished;const completed=new Promise(r=>{finished=r;});
  const run=superviseMacLaunch({home:f.home,trayPath:'/fake/tray',background:true,ownerGone:new Promise(()=>{}),acquireLock:async()=>()=>{},discover:async()=>null,
    startApp:async()=>app,requestHandoff:async()=>'',openUrl:()=>{},spawnTray:()=>tray,
    onOwnedReady:async({app:owned,signal,markHandoff})=>{
      try {await owned.recoverManagedUpdate({signal,onHandoff:markHandoff,snapshot:async()=>owners,
        prepare:async options=>{assert.equal(options.spec.mode,'recover');ticket=await prepareMacUpdateHelper(options);return ticket;}});}
      finally{finished();}
    }});
  assert.equal((await run).reason,'app');await completed;assert.ok(ticket?.ready);await ticket.cancel();
});

test('wrong profile or symlink journal cannot prepare recovery', {timeout:30000},async t=>{
  const f=await setup(t);await journal(f,'starting',{home:'/another/profile'});
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});let spawned=false;
  await assert.rejects(app.recoverManagedUpdate({snapshot:async()=>[],prepare:async()=>{spawned=true;}}),/identity mismatch/);
  await rm(f.journalPath);const target=join(f.f.root,'journal-target');await writeFile(target,'{}',{mode:0o600});await symlink(target,f.journalPath);
  await assert.rejects(app.recoverManagedUpdate({snapshot:async()=>[],prepare:async()=>{spawned=true;}}),/Untrusted/);
  assert.equal(spawned,false);assert.equal((await api(app,'/api/updates')).updateHold,true);
});

test('no pending update does not prepare recovery', {timeout:30000},async t=>{
  const f=await appFixture(t),{app}=await f.start('ordinary');let called=false;
  assert.equal(await app.recoverManagedUpdate({snapshot:async()=>{called=true;},prepare:async()=>{called=true;}}),false);
  assert.equal(called,false);
});

test('held app notices a terminal journal even when no boot request exists', {timeout:30000},async t=>{
  const f=await setup(t);await journal(f,'starting');await rm(join(f.home,'v1','update-boot.json'));
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  assert.equal((await api(app,'/api/updates')).updateHold,true);await journal(f,'committed');
  await waitFor(async()=>!(await api(app,'/api/updates')).updateHold,'terminal journal release without request');
});

for(const phase of ['committed','rolled-back'])test(`stale ${phase} journal does not hold lending after manual replacement`,async t=>{
  const f=await setup(t);await rm(join(f.home,'v1','update-boot.json'));
  await journal(f,phase,{version:'0.9.2',previousVersion:'0.9.1'});
  assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,false);
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version});
  assert.notEqual((await api(app,'/api/updates')).updateHold,true);
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/on',{method:'POST',body:{}});
  assert.equal((await api(app,'/api/lending')).intent,'on');
  assert.equal(JSON.parse(await readFile(f.journalPath,'utf8')).phase,phase);
});

for(const change of ['terminal','removed'])test(`journal-only hold releases when journal is ${change}`,async t=>{
  const f=await setup(t);await rm(join(f.home,'v1','update-boot.json'));await journal(f,'starting');
  const {app}=await f.f.start('boot',{updateBootIdentity:f.identity,faravanVersion:f.identity.version,updateBootPollMs:20});
  assert.equal((await api(app,'/api/updates')).updateHold,true);
  if(change==='terminal')await journal(f,'committed',{version:'0.9.2',previousVersion:'0.9.1'});
  else await rm(f.journalPath);
  await waitFor(async()=>!(await api(app,'/api/updates')).updateHold,'journal-only hold release');
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(app,'/api/lending/on',{method:'POST',body:{}});
});

test('journal-only terminal records still require trusted identity and no active writer',async t=>{
  const {acquireProcessLock}=await import('../lib/v1/lock.mjs');
  const f=await setup(t);await rm(join(f.home,'v1','update-boot.json'));
  for(const extra of [{home:'/another/profile'},{bundleId:'com.other.app'},{schema:2},{id:'invalid'},{version:null},{previousVersion:'garbage'}]) {
    await journal(f,'committed',extra);
    assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,true);
  }
  await writeFile(f.journalPath,'invalid json',{mode:0o600});
  assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,true);
  await journal(f,'rolled-back');
  assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,false);
  const release=await acquireProcessLock(f.identity.appPath+'.update.lock',{timeoutMs:0});
  try {assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,true);}
  finally {release();}
  const target=join(f.f.root,'terminal-journal');
  await writeFile(target,await readFile(f.journalPath),{mode:0o600});
  await rm(f.journalPath);await symlink(target,f.journalPath);
  assert.equal((await readMacUpdateBoot({home:f.home,identity:f.identity})).held,true);
});
