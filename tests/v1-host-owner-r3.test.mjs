import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hostV1,hostProcessExists,ensureV1HostState,stopV1Host,stopOwnedCoordinatorProcess,assertOwnedCoordinatorProcess} from '../lib/v1/host.mjs';

test('R3 host stop refuses a stale status PID naming an unrelated real process',async t=>{
  const home=await mkdtemp(join(tmpdir(),'r3-host-owner-'));
  const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
  const ended=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await ended;});
  await once(child,'message');
  await writeFile(join(home,'host.json'),JSON.stringify({protocol_version:1,status_path:join(home,'status.json')}));
  await writeFile(join(home,'status.json'),JSON.stringify({protocol_version:1,pid:child.pid}));
  await assert.rejects(stopV1Host({home}),/cannot verify/);
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
  process.kill(child.pid,0);
});

for(const platform of ['linux','win32'])test('R3 '+platform+' unknown host identity refuses the stopServer effect',async()=>{
  const home=await mkdtemp(join(tmpdir(),'r3-host-unknown-'));let stops=0;
  await writeFile(join(home,'host.json'),JSON.stringify({protocol_version:1,status_path:join(home,'status.json')}));
  await writeFile(join(home,'status.json'),JSON.stringify({protocol_version:1,pid:12345}));
  await assert.rejects(stopV1Host({home},{processExists:()=>true,stopServer:async()=>{stops++;},sleep:async()=>{},
    identityOptions:{platform,readFile(){throw Error('unreadable');},execFile(){throw Error('policy disabled');}}}),/cannot verify/);
  assert.equal(stops,0);
});

test('R3 Windows coordinator stop verifies executable, exact config and stable creation identity',()=>{
  const executable=new URL('../bin/faravan-coordinator',import.meta.url).pathname,config='/disposable/host.json';
  const command='"'+process.execPath+'" "'+executable+'" --host-config "'+config+'"';
  for(const bad of [false,true]){
    const signals=[];
    const options={platform:'win32',execFile:()=>JSON.stringify({ExecutablePath:process.execPath,CommandLine:bad?command.replace('host.json','other.json'):command,CreationDate:'638972640000000001',Boot:'638970000000000000'}),signal:(...args)=>signals.push(args)};
    if(bad)assert.throws(()=>stopOwnedCoordinatorProcess(12345,config,options),/cannot verify/);
    else stopOwnedCoordinatorProcess(12345,config,options);
    assert.deepEqual(signals,bad?[]:[[12345,'SIGTERM']]);
  }
});

test('R3 hosting refuses phantom-ready reuse of a live unrelated PID and an occupied port',async t=>{
  const home=await mkdtemp(join(tmpdir(),'r3-host-reuse-')),origin='http://127.0.0.1:8787';
  const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
  const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await ended;});
  await once(child,'message');
  const circle={id:'test-circle',origin,pinnedRootFingerprint:'test-root',name:'Reuse'};
  const {paths,config}=ensureV1HostState({home,name:'Reuse'});
  await writeFile(paths.config,JSON.stringify({...config,circle_id:circle.id,root_fingerprint:circle.pinnedRootFingerprint,v1_origin:origin,reachability:{kind:'url',publicUrl:origin}}));
  await writeFile(paths.status,JSON.stringify({protocol_version:1,pid:child.pid,port:8787,status:'listening',public_url:origin,circles_router:true}));
  let publications=0;
  await assert.rejects(hostV1({home},{openDevice:async()=>({selectCircle:()=>circle,publishRoster:async()=>{publications++;},createInviteLinks:async()=>({long:'unused'})}),
    portInUse:async()=>true,provision:async()=>{}}),/cannot verify/);
  assert.equal(publications,0);
});

test('R3 macOS coordinator ownership distinguishes births one microsecond apart',()=>{
  let births=0;
  const config='/disposable/host.json',command=process.execPath+' '+new URL('../bin/faravan-coordinator',import.meta.url).pathname+' --host-config '+config;
  assert.throws(()=>stopOwnedCoordinatorProcess(12345,config,{platform:'darwin',signal(){assert.fail('must not signal a replacement');},execFile:(file,args)=>
    file.endsWith('faravan-process-identity')?JSON.stringify({boot:'darwin:test',start:String(1000000+births++),state:'live'}):args.includes('lstart=')?'Wed Oct 28 12:00:00 2026 '+command:command}),/cannot verify/);
  assert.equal(births,2);
});

test('R3 reuse and stop postconditions compare the recorded Windows incarnation and preserve unknowns',()=>{
  const config='/disposable/host.json',entry=new URL('../bin/faravan-coordinator',import.meta.url).pathname;
  let start='638972640000000001',unknown=false;
  const io={platform:'win32',probe(){},execFile(){if(unknown)throw Error('policy disabled');return JSON.stringify({Boot:'638970000000000000',CreationDate:start,ExecutablePath:process.execPath,CommandLine:'"'+process.execPath+'" "'+entry+'" --host-config "'+config+'"'});}};
  const owner=assertOwnedCoordinatorProcess(12345,config,io),status={protocol_version:1,status:'listening',pid:12345,owner};
  assert.equal(hostProcessExists(status,{configPath:config,...io}),true);
  start='638972640000000002';assert.equal(hostProcessExists(status,{configPath:config,...io}),false);
  unknown=true;assert.throws(()=>hostProcessExists(status,{configPath:config,...io}),/cannot verify/);
});

test('R3 foreign or legacy ownership never becomes absence from a local PID probe',()=>{
  const config='/disposable/host.json';
  const io={configPath:config,platform:'win32',probe(){throw Object.assign(Error('not found'),{code:'ESRCH'});}};
  for(const owner of [undefined,{version:1,platform:'win32',host:'another-machine',pid:12345,boot:'1',namespace:null,start:'1',config}])
    assert.throws(()=>hostProcessExists({protocol_version:1,status:'listening',pid:12345,owner},io),/cannot verify/);
});

test('R3 prior local boot is stale while unavailable boot identity stays unknown',()=>{
  const config='/disposable/host.json',entry=new URL('../bin/faravan-coordinator',import.meta.url).pathname;
  let boot='638970000000000000',unavailable=false,probes=0;
  const io={platform:'win32',execFile(){if(unavailable)throw Error('CIM unavailable');return JSON.stringify({Boot:boot,CreationDate:'638972640000000001',ExecutablePath:process.execPath,
    CommandLine:'"'+process.execPath+'" "'+entry+'" --host-config "'+config+'"'});},probe(){probes++;throw Object.assign(Error('not found'),{code:'ESRCH'});}};
  const owner=assertOwnedCoordinatorProcess(12345,config,io),status={protocol_version:1,status:'listening',pid:12345,owner};
  boot='638970000000000001';
  assert.equal(hostProcessExists(status,{configPath:config,...io}),false);
  unavailable=true;
  assert.throws(()=>hostProcessExists(status,{configPath:config,...io}),/cannot verify/);
  assert.equal(probes,0,'neither a prior boot nor an unreadable domain authorizes probing its PID');
});
