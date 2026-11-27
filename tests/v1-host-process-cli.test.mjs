import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {openDevice} from '../lib/v1/device.mjs';
import {ensureV1HostState,provisionLocalCircle} from '../lib/v1/host.mjs';

async function waitFor(read){
  const until=Date.now()+15000;
  while(Date.now()<until){try{const value=await read();if(value)return value;}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('disposable coordinator did not become ready');
}
async function stop(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');
  await waitFor(()=>child.exitCode!==null||child.signalCode!==null);
}

test('the actual CLI restarts its own legacy-marked host for a second circle', {timeout:45000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-host-process-cli-'));
  const home=join(root,'host'),ownerHome=join(root,'owner');
  let oldHost,command;
  t.after(async()=>{await stop(command);await stop(oldHost);await rm(root,{recursive:true,force:true});});
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const device=await openDevice({home:ownerHome,ensureDefault:false});
  const first=await device.createCircle(origin,{name:'Original',publish:false});
  const signed=(await device.rosterCache(first.id).get()).current;
  await provisionLocalCircle({home,circle:first});
  const {config,paths}=ensureV1HostState({home,port,name:first.name});
  await writeFile(paths.config,JSON.stringify({...config,keep_awake:false,circle_id:first.id,
    root_fingerprint:first.pinnedRootFingerprint,v1_origin:origin,provisioning_path:first.provisioningPath,
    reachability:{kind:'url',publicUrl:origin}}));
  oldHost=spawn(process.execPath,[fileURLToPath(new URL('../bin/faravan-coordinator',import.meta.url)),
    '--host-config',paths.config],{stdio:'ignore'});
  // The first listening record precedes the keep-awake initialization write.
  // Wait for that write before editing the legacy marker so startup cannot overwrite it.
  const status=await waitFor(async()=>{const s=JSON.parse(await readFile(config.status_path,'utf8'));return s.status==='listening'&&s.keep_awake?s:null;});
  // Exercise the upgrade callback with a real owned process. Legacy-handler data preservation is tested separately.
  await writeFile(config.status_path,JSON.stringify({...status,circles_router:false}));
  command=spawn(process.execPath,[fileURLToPath(new URL('../bin/faravan',import.meta.url)),
    'host','--new-circle','--name','Second','--json'],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,FARAVAN_HOME:ownerHome,FARAVAN_COORDINATOR_HOME:home,FARAVAN_NO_BROWSER:'1'}});
  let output='',diagnostic='',result,stdoutClosed=false;
  command.stderr.on('data',data=>{diagnostic+=data;});
  command.stdout.on('close',()=>{stdoutClosed=true;});
  command.stdout.on('data',data=>{output+=data;for(const line of output.split('\n')){
    try{const value=JSON.parse(line);if(value.type==='host_ready')result=value;}catch{}
  }});
  // The CLI prints host_ready and then exits, and its exit can arrive before its last stdout chunk.
  await waitFor(()=>{if(result)return result;
    if(stdoutClosed&&(command.exitCode!==null||command.signalCode!==null))throw Error('host CLI exited before ready (exit='+command.exitCode+', signal='+command.signalCode+'): '+diagnostic);});
  assert.notEqual(result.circle_id,first.id);
  await waitFor(()=>oldHost.exitCode!==null||oldHost.signalCode!==null);
  const restarted=JSON.parse(await readFile(config.status_path,'utf8'));
  assert.notEqual(restarted.pid,oldHost.pid);assert.equal(restarted.circles_router,true);
  assert.deepEqual(await (await device.client(first.id)).refreshRoster(),signed);
  assert.equal((await (await device.client(result.circle_id)).refreshRoster()).payload.circle,result.circle_id);
});

// Bug 4 (server path): "Start another circle" while the earlier hosted circle is stopped. The new circle starts hosting
// again at the same address, and the earlier circle comes back with it.
test('the actual CLI starts a second circle while the hosted circle is stopped, and serves both', {timeout:45000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-host-stopped-cli-'));
  const home=join(root,'host'),ownerHome=join(root,'owner');
  let command;
  t.after(async()=>{await stop(command);await rm(root,{recursive:true,force:true});});
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const device=await openDevice({home:ownerHome,ensureDefault:false});
  const first=await device.createCircle(origin,{name:'Faravan demo',publish:false});
  const signed=(await device.rosterCache(first.id).get()).current;
  await provisionLocalCircle({home,circle:first});
  const {config,paths}=ensureV1HostState({home,port,name:first.name});
  await writeFile(paths.config,JSON.stringify({...config,keep_awake:false,circle_id:first.id,circle_ids:[first.id],
    root_fingerprint:first.pinnedRootFingerprint,v1_origin:origin,provisioning_path:first.provisioningPath,
    reachability:{kind:'url',publicUrl:origin}}));
  command=spawn(process.execPath,[fileURLToPath(new URL('../bin/faravan',import.meta.url)),
    'host','--new-circle','--name','Weekend','--json'],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,FARAVAN_HOME:ownerHome,FARAVAN_COORDINATOR_HOME:home,FARAVAN_NO_BROWSER:'1'}});
  let output='',diagnostic='',result;
  command.stderr.on('data',data=>{diagnostic+=data;});
  command.stdout.on('data',data=>{output+=data;for(const line of output.split('\n')){
    try{const value=JSON.parse(line);if(value.type==='host_ready')result=value;}catch{}
  }});
  await waitFor(()=>{if(result)return result;if(command.exitCode!==null)throw Error('host CLI exited before ready: '+diagnostic+output);});
  assert.notEqual(result.circle_id,first.id);
  const saved=JSON.parse(await readFile(paths.config,'utf8'));
  assert.deepEqual(new Set(saved.circle_ids),new Set([first.id,result.circle_id]));
  assert.equal(saved.circle_id,first.id,'the earlier circle stays the primary one');
  assert.equal(saved.host_wanted,true);
  assert.deepEqual(await (await device.client(first.id)).refreshRoster(),signed);
  assert.equal((await (await device.client(result.circle_id)).refreshRoster()).payload.circle,result.circle_id);
});
